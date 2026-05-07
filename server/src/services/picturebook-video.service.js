/**
 * 绘本视频生成服务
 *
 * 将 picture_books + picture_book_pages 转为 1080×1920 竖版短视频。
 * 时间轴（目标 ≤60s for Shorts）：
 *   0.8s  封面首帧（分享缩略图）
 *   2.0s  标题页（封面）
 *   N*~5s 10 页内容（音频驱动 + 逐词高亮字幕）
 *   1.5s  The End
 *
 * 关键技术：
 * - 图片层：zoompan 到 1080×1440（上 75%）
 * - 字幕层：分帧 PNG concat → overlay 到下 25%（逐词高亮）
 * - 字符加权估算词时长（MVP）
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const sharp = require('sharp');
const { query } = require('../config/database');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/picturebook-videos');
const BGM_PATH = path.join(SERVER_ROOT, 'assets/audio/bgm_fairy_dance.mp3');

const W = 1080;
const H = 1920;
// 图层全屏（blur-fill），字幕完全透明悬浮在画面上（文字带黑色描边保障可读性）
const SUB_H = 620;          // 字幕覆盖区（完全透明，文字底对齐，可承载最多 5 行英文 + 2 行中文）
const FADE = 0.25;
const GAP = Math.min(1.2, Math.max(0.3, Number(process.env.PB_VIDEO_PAGE_GAP || 0.65))); // 段间静音，孩子需要一点看图反应时间
const MIN_PAGE_DUR = Math.min(4.0, Math.max(2.0, Number(process.env.PB_VIDEO_MIN_PAGE_DUR || 2.8)));
const NARRATION_ATEMPO = Math.min(1.0, Math.max(0.75, Number(process.env.PB_VIDEO_NARRATION_ATEMPO || 0.92))); // 绘本朗读默认慢一点，孩子更容易跟读
const MAX_ATEMPO = Math.min(1.15, Math.max(1.0, Number(process.env.PB_VIDEO_MAX_ATEMPO || 1.0))); // 默认不再强制加速；需要卡 60s 可用 env 打开
const COVER_STILL_DUR = Math.min(2.0, Math.max(0.8, Number(process.env.PB_VIDEO_COVER_STILL_DUR || 1.0)));
const TITLE_DUR = Math.min(4.0, Math.max(2.0, Number(process.env.PB_VIDEO_TITLE_DUR || 2.8)));
const END_DUR = Math.min(3.0, Math.max(1.5, Number(process.env.PB_VIDEO_END_DUR || 1.8)));
const BGM_VOL = 0.08;       // 绘本旁白更强调语音清晰度，BGM 比 daily_word 更低
const SPEECH_VOL = Math.min(
    3,
    Math.max(1, Number(process.env.PB_VIDEO_SPEECH_VOL || 1.8))
);                          // 只增强绘本视频里的朗读音量，不改原始 TTS 文件

// H.264 编码器检测
let H264_ENCODER = 'libx264';
try {
    const enc = execFileSync('ffmpeg', ['-encoders'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (enc.includes('libx264')) H264_ENCODER = 'libx264';
    else if (enc.includes('libopenh264')) H264_ENCODER = 'libopenh264';
} catch (e) { /* ignore */ }

let isProcessing = false;

class PictureBookVideoService {

    constructor() {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // ==================== 主流程 ====================

    async generateBookVideo(bookId, jobId, config = {}) {
        const {
            subtitle_mode = 'bilingual',   // bilingual | english_only
            duration_mode = 'shorts_60',   // shorts_60 | full_75
            voice = 'female'
        } = config;

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pbv-${jobId}-`));

        try {
            // 1. 拉取绘本 + 页面
            const [book] = await query(
                `SELECT id, title, title_en, cover_url FROM picture_books WHERE id = ?`, [bookId]
            );
            if (!book) throw new Error('绘本不存在');

            const pages = await query(
                `SELECT id, page_number, image_url, text_en, text_cn, audio_url, audio_url_male
                 FROM picture_book_pages WHERE book_id = ? ORDER BY page_number ASC`,
                [bookId]
            );
            if (!pages.length) throw new Error('绘本无页面');

            await this._updateJob(jobId, { progress: 5 });

            // 2. 解析素材（本地化）
            const coverLocal = await this._resolveUrl(book.cover_url, tempDir, 'cover.jpg');
            const pageAssets = [];
            for (const p of pages) {
                const imgLocal = p.image_url ? await this._resolveUrl(p.image_url, tempDir, `p${p.page_number}.jpg`) : null;
                const audioUrl = voice === 'male' ? (p.audio_url_male || p.audio_url) : p.audio_url;
                const audioLocal = audioUrl ? await this._resolveUrl(audioUrl, tempDir, `p${p.page_number}.mp3`) : null;
                pageAssets.push({
                    ...p,
                    imgLocal,
                    audioLocal,
                    audioDur: audioLocal ? await this._getAudioDuration(audioLocal) : 3
                });
            }
            await this._updateJob(jobId, { progress: 15 });

            // 3. 时长预算：检查总时长是否超出目标，需要则计算加速系数
            const targetTotal = duration_mode === 'shorts_60' ? 60 : 75;
            const reservedHeadTail = COVER_STILL_DUR + TITLE_DUR + END_DUR; // cover + title + end
            const reservedPage = targetTotal - reservedHeadTail;
            const rawSpeechTotal = pageAssets.reduce((s, p) => s + p.audioDur, 0);
            const rawGapTotal = pageAssets.length * GAP;
            const rawPageTotal = rawSpeechTotal / NARRATION_ATEMPO + rawGapTotal;
            let atempo = NARRATION_ATEMPO;
            if (rawPageTotal > reservedPage) {
                const requiredAtempo = rawSpeechTotal / Math.max(1, reservedPage - rawGapTotal);
                atempo = Math.min(MAX_ATEMPO, Math.max(NARRATION_ATEMPO, requiredAtempo));
                console.log(`[PBVideo] 页面总时长 ${rawPageTotal.toFixed(1)}s 超出预算 ${reservedPage.toFixed(1)}s，atempo=${atempo.toFixed(2)}`);
            }

            // 4. 生成封面图（分享缩略图）+ 水印 PNG（页面段用 FFmpeg overlay）
            const baseName = `book_${bookId}_${(book.title_en || book.title).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().slice(0, 40)}_${duration_mode}_${Date.now()}`;
            const coverOut = path.join(OUTPUT_DIR, `${baseName}.jpg`);
            await this._renderCoverImage(coverOut, coverLocal, book);

            const watermarkPng = path.join(tempDir, 'watermark.png');
            await this._renderWatermark(watermarkPng);

            // 5. 段构造
            const segDir = path.join(tempDir, 'seg');
            fs.mkdirSync(segDir, { recursive: true });
            const segments = [];
            let segIdx = 0;
            const addSeg = async (imgPath, audioPath, dur, opts = {}) => {
                const out = path.join(segDir, `s${String(segIdx++).padStart(3, '0')}.mp4`);
                await this._imgToVideo(imgPath, audioPath, dur, out, opts);
                segments.push(out);
            };

            // 5a. 封面首帧（0.8s，无 fade，作分享缩略图使用）
            segments.push(await (async () => {
                const out = path.join(segDir, `s${String(segIdx++).padStart(3, '0')}_cover.mp4`);
                await this._imgToVideo(coverOut, null, COVER_STILL_DUR, out, { noZoom: true });
                return out;
            })());

            // 5b. 标题页 - 复用封面 + zoompan，与封面首帧同画面，无过渡感；与下一段硬切不闪
            await addSeg(coverOut, null, TITLE_DUR);
            await this._updateJob(jobId, { progress: 25 });

            // 5c. 每页内容段
            const progPerPage = 55 / pageAssets.length;
            for (let i = 0; i < pageAssets.length; i++) {
                const page = pageAssets[i];
                const pageSeg = path.join(segDir, `page_${String(i).padStart(3, '0')}.mp4`);
                await this._buildPageSegment(page, subtitle_mode, atempo, pageSeg, tempDir, i, watermarkPng);
                segments.push(pageSeg);
                await this._updateJob(jobId, { progress: Math.round(25 + (i + 1) * progPerPage) });
            }

            // 5d. The End (1.5s) — 视频最后一段：加 fade-out 做整体收尾
            const endFrame = path.join(tempDir, 'end.png');
            await this._renderEndFrame(endFrame, pageAssets[pageAssets.length - 1].imgLocal);
            await addSeg(endFrame, null, END_DUR, { fadeOut: true });

            // 6. Concat + BGM
            const videoOut = path.join(OUTPUT_DIR, `${baseName}.mp4`);
            await this._concatWithBgm(segments, videoOut, tempDir);
            await this._updateJob(jobId, { progress: 95 });

            // 7. 完成
            const videoUrl = `/uploads/picturebook-videos/${baseName}.mp4`;
            const coverUrl = `/uploads/picturebook-videos/${baseName}.jpg`;
            const finalDur = await this._getAudioDuration(videoOut);
            await this._updateJob(jobId, {
                status: 'done',
                progress: 100,
                video_url: videoUrl,
                cover_url: coverUrl,
                duration_seconds: Math.round(finalDur)
            });
            await this._cleanupOldSuccessfulJobs(bookId, jobId);
            console.log(`[PBVideo] 完成: ${baseName}.mp4 (${finalDur.toFixed(1)}s)`);
            return videoUrl;

        } catch (err) {
            console.error(`[PBVideo] 失败 (job ${jobId}):`, err);
            await this._updateJob(jobId, { status: 'failed', error_message: err.message });
            throw err;
        } finally {
            this._cleanup(tempDir);
        }
    }

    async processNextJob() {
        if (isProcessing) return;
        const [job] = await query(
            `SELECT * FROM picture_book_video_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
        );
        if (!job) return;
        isProcessing = true;
        try {
            let config = {};
            try { config = JSON.parse(job.config_json || '{}'); } catch (e) { /* ignore */ }
            await this.generateBookVideo(job.book_id, job.id, config);
        } catch (e) { /* logged */ }
        finally {
            isProcessing = false;
            setImmediate(() => this.processNextJob());
        }
    }

    async _updateJob(jobId, fields) {
        const keys = Object.keys(fields);
        if (!keys.length) return;
        const setClause = keys.map(k => `${k} = ?`).join(', ');
        const values = keys.map(k => fields[k]);
        values.push(jobId);
        await query(`UPDATE picture_book_video_jobs SET ${setClause}, updated_at = NOW() WHERE id = ?`, values);
    }

    async _cleanupOldSuccessfulJobs(bookId, keepJobId) {
        const oldJobs = await query(
            `SELECT id, video_url, cover_url
             FROM picture_book_video_jobs
             WHERE book_id = ?
               AND id != ?
               AND status = 'done'
             ORDER BY created_at ASC, id ASC`,
            [bookId, keepJobId]
        );
        if (!oldJobs.length) return;

        let deletedFiles = 0;
        for (const job of oldJobs) {
            for (const url of [job.video_url, job.cover_url]) {
                const deleted = this._deleteUploadFile(url);
                if (deleted) deletedFiles++;
            }
            await query('DELETE FROM picture_book_video_jobs WHERE id = ?', [job.id]);
        }
        console.log(`[PBVideo] 已清理旧视频: book=${bookId}, keepJob=${keepJobId}, jobs=${oldJobs.length}, files=${deletedFiles}`);
    }

    _deleteUploadFile(url) {
        const cleanUrl = String(url || '').trim();
        if (!cleanUrl.startsWith('/uploads/')) return false;

        const resolved = path.resolve(SERVER_ROOT, `.${cleanUrl}`);
        const uploadsRoot = path.resolve(SERVER_ROOT, 'uploads');
        if (!resolved.startsWith(`${uploadsRoot}${path.sep}`)) {
            console.warn(`[PBVideo] 跳过异常上传路径: ${cleanUrl}`);
            return false;
        }

        if (!fs.existsSync(resolved)) return false;
        try {
            fs.unlinkSync(resolved);
            return true;
        } catch (error) {
            console.warn(`[PBVideo] 删除旧视频文件失败: ${cleanUrl} ${error.message}`);
            return false;
        }
    }

    // ==================== 页面段生成（核心） ====================

    /**
     * 组合一页：图片 zoompan(上 75%) + 字幕逐词高亮(下 25%) + 页面音频
     */
    async _buildPageSegment(page, subtitle_mode, atempo, outPath, tempDir, pageIdx, watermarkPath) {
        const dur = Math.max(MIN_PAGE_DUR, page.audioDur / atempo + GAP);

        // 1. 分词
        const tokens = this._tokenize(page.text_en || '');
        const showCn = subtitle_mode === 'bilingual' && page.text_cn;

        // 2. 计算每词起始时刻（字符加权）
        const weights = tokens.map(t => Math.max(1, t.length));
        const totalW = weights.reduce((s, w) => s + w, 0);
        const speechDur = page.audioDur / atempo;
        const wordDurs = weights.map(w => speechDur * w / totalW);
        // 字幕总 concat 时长必须严格等于 dur，最后一词吸收 gap
        wordDurs[wordDurs.length - 1] += (dur - speechDur);

        // 3. 生成 N 张字幕帧（每词一张）
        const subFrames = [];
        for (let i = 0; i < tokens.length; i++) {
            const fp = path.join(tempDir, `sub_${pageIdx}_${i}.png`);
            await this._renderSubtitleFrame(fp, tokens, page.text_cn, i, showCn);
            subFrames.push({ path: fp, dur: wordDurs[i] });
        }

        // 4. 生成字幕条视频（透明 alpha，使用 MOV + qtrle 保留通道）
        const subVideo = path.join(tempDir, `sub_${pageIdx}.mov`);
        await this._subFramesToVideo(subFrames, subVideo);

        // 5. 图片 zoompan 视频（上 75%，1080×1440）
        const imgVideo = path.join(tempDir, `img_${pageIdx}.mp4`);
        await this._pageImageToVideo(page.imgLocal, dur, imgVideo);

        // 6. 合成：黑底 1080×1920 + 图片层 + 字幕层 + 音频
        // 音频只做短淡入/淡出抑制边界爆音，避免叠加"段间黑闪"
        const SNAP = 0.08;  // 音频边界抑噪
        const speechVolFilter = `volume=${SPEECH_VOL.toFixed(2)},alimiter=limit=0.95`;
        const audioFilter = atempo !== 1.0
            ? `[2:a]atempo=${atempo.toFixed(3)},${speechVolFilter},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${dur},afade=t=in:st=0:d=${SNAP},afade=t=out:st=${(dur - SNAP).toFixed(3)}:d=${SNAP}[a]`
            : `[2:a]${speechVolFilter},aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${dur},afade=t=in:st=0:d=${SNAP},afade=t=out:st=${(dur - SNAP).toFixed(3)}:d=${SNAP}[a]`;

        const hasAudio = page.audioLocal && fs.existsSync(page.audioLocal);
        const hasWm = watermarkPath && fs.existsSync(watermarkPath);
        const inputs = ['-i', imgVideo, '-i', subVideo];
        if (hasAudio) inputs.push('-i', page.audioLocal);
        else inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
        if (hasWm) inputs.push('-i', watermarkPath);

        // 视频合成：
        //   [0]imgVideo: 1080×1920 全屏（cover-crop + zoompan）
        //   [1]subVideo: 1080×SUB_H 透明字幕（RGBA）
        //   [3]watermark: 左上角水印 PNG（若存在）
        //   overlay 到底部；视频层不再 fade（由 concat 硬切保证无黑闪）
        const wmIdx = 3; // audio 固定在 index 2（音频或 anullsrc），水印在 3
        const subOverlay = `[0:v][1:v]overlay=0:${H - SUB_H}:format=auto`;
        const vf = hasWm
            ? `${subOverlay}[vs];[vs][${wmIdx}:v]overlay=48:48[v]`
            : `${subOverlay}[v]`;

        await this._runFFmpeg([
            ...inputs,
            '-filter_complex', `${vf};${audioFilter}`,
            '-map', '[v]', '-map', '[a]',
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-t', String(dur),
            '-y', outPath
        ]);
    }

    /** 图片→1080×1920 全屏视频：cover-crop 填满整个画面（无 blur-fill 背景）+ 轻微 zoompan */
    async _pageImageToVideo(imagePath, duration, outPath) {
        const frames = Math.ceil(duration * 30);
        // cover-crop：scale=W:H:increase 按较大比例缩放确保覆盖，再 crop=W:H 裁中心
        // 之后 zoompan 在已是 1080×1920 的画面上轻微推进，杜绝任何 blur-fill 或黑边
        const zp = `zoompan=z='min(zoom+0.0003,1.08)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=30`;
        const filter = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,fps=30,${zp}[v]`;

        await this._runFFmpeg([
            '-loop', '1', '-i', imagePath,
            '-filter_complex', filter,
            '-map', '[v]',
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p',
            '-t', String(duration),
            '-y', outPath
        ]);
    }

    /** 字幕帧序列 → 带 alpha 通道的视频（使用 qtrle / png 保留透明度） */
    async _subFramesToVideo(frames, outPath) {
        // 使用 concat demuxer 拼接不同时长的图片
        const tempList = outPath + '.txt';
        const lines = [];
        for (const f of frames) {
            lines.push(`file '${f.path}'`);
            lines.push(`duration ${f.dur.toFixed(3)}`);
        }
        // concat demuxer 要求最后一帧再写一次（不带 duration）
        lines.push(`file '${frames[frames.length - 1].path}'`);
        fs.writeFileSync(tempList, lines.join('\n'));

        // 输出必须是 .mov 容器 + qtrle 编码（或 libvpx-vp9 webm），才能保留 alpha
        // 这里改用 MOV + qtrle（无损，文件会大但临时文件，最终合成后删除）
        await this._runFFmpeg([
            '-f', 'concat', '-safe', '0', '-i', tempList,
            '-vf', `fps=30,scale=${W}:${SUB_H}:flags=bicubic,setsar=1,format=rgba`,
            '-c:v', 'qtrle',
            '-y', outPath
        ]);
    }

    // ==================== 帧渲染 ====================

    /**
     * 字幕帧 1080×SUB_H（620）：完全透明，文字带黑色描边直接悬浮在画面上
     * 英文最多 5 行（font 60→34 自适应），中文最多 2 行（char-boundary）
     * 文字块底对齐：短句贴底，长句向上扩展
     */
    async _renderSubtitleFrame(outPath, tokens, text_cn, highlightIdx, showCn) {
        const e = this._svgEsc;
        const PAD_X = 40;
        const BOTTOM_PAD = 48;
        const avail = W - PAD_X * 2;   // 1000
        const MAX_ENG_LINES = 5;

        // 1. 英文换行：font 从 60 起，若行数 > 5 则递减字号（最低 34）
        let fontSize = 60;
        let lines;
        while (true) {
            const maxChars = Math.max(12, Math.floor(avail / (fontSize * 0.55)));
            lines = this._wrapTokens(tokens, maxChars);
            if (lines.length <= MAX_ENG_LINES || fontSize <= 34) break;
            fontSize -= 4;
        }
        if (lines.length > MAX_ENG_LINES) lines = lines.slice(0, MAX_ENG_LINES);
        const lineGap = Math.round(fontSize * 1.18);
        const engBlockH = lines.length * lineGap;

        // 2. 中文换行（最多 2 行，超出加省略号）
        const cnSize = 38;
        let cnLines = [];
        if (showCn && text_cn) {
            const cnMax = Math.max(10, Math.floor(avail / (cnSize * 1.02)));   // 中文近似全角
            cnLines = this._wrapChinese(String(text_cn).trim(), cnMax, 2);
        }
        const cnGap = Math.round(cnSize * 1.25);
        const cnBlockH = cnLines.length * cnGap;

        // 3. 底对齐布局：整体块贴底 BOTTOM_PAD，英文在上，中文在下
        const EN_CN_GAP = 16;
        const totalH = engBlockH + (cnBlockH > 0 ? EN_CN_GAP + cnBlockH : 0);
        const blockBottomY = SUB_H - BOTTOM_PAD;
        const blockTopY = blockBottomY - totalH;

        // 英文首行基线
        const engBaseline0 = blockTopY + fontSize * 0.88;
        const engSvg = lines.map((lineTokens, li) => {
            let gStart = 0;
            for (let k = 0; k < li; k++) gStart += lines[k].length;
            const tspans = lineTokens.map((t, i) => {
                const gIdx = gStart + i;
                const fill = gIdx === highlightIdx ? '#FFD84A' : '#FFFFFF';
                const weight = gIdx === highlightIdx ? '800' : '700';
                const dx = i === 0 ? '0' : Math.round(fontSize * 0.22);
                return `<tspan fill="${fill}" font-weight="${weight}" dx="${dx}">${e(t)}</tspan>`;
            }).join('');
            const y = Math.round(engBaseline0 + li * lineGap);
            return `<text x="540" y="${y}" text-anchor="middle" font-size="${fontSize}" font-family="sans-serif" paint-order="stroke" stroke="#000" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">${tspans}</text>`;
        }).join('');

        // 中文首行基线 = 英文块底 + 间距 + cnSize*0.88
        const cnBaseline0 = engBaseline0 + (lines.length - 1) * lineGap + (fontSize - fontSize * 0.88) + EN_CN_GAP + cnSize * 0.88;
        // 中文用细描边 + 柔和投影（避免密集笔画被粗描边糊成黑块，外观更轻盈）
        const cnSvg = cnLines.map((line, li) => {
            const y = Math.round(cnBaseline0 + li * cnGap);
            return `<text x="540" y="${y}" text-anchor="middle" font-size="${cnSize}" fill="#FFE082" font-weight="500" font-family="sans-serif" filter="url(#cnShadow)" paint-order="stroke" stroke="#000" stroke-width="2" stroke-linejoin="round" stroke-linecap="round">${e(line)}</text>`;
        }).join('');

        // 4. 完全透明 SVG，文字仅靠描边/投影提升对比度，背景图片完全可见
        const svg = `<svg width="${W}" height="${SUB_H}" xmlns="http://www.w3.org/2000/svg">
            <defs>
                <filter id="cnShadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur in="SourceAlpha" stdDeviation="2"/>
                    <feOffset dx="0" dy="1" result="off"/>
                    <feComponentTransfer><feFuncA type="linear" slope="0.85"/></feComponentTransfer>
                    <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
                </filter>
            </defs>
            ${engSvg}
            ${cnSvg}
        </svg>`;

        await sharp(Buffer.from(svg)).png().toFile(outPath);
    }

    /** 按最大字符数在单词边界换行（不打断单词） */
    _wrapTokens(tokens, maxChars) {
        const lines = [[]];
        let curLen = 0;
        for (const t of tokens) {
            const needed = t.length + (curLen > 0 ? 1 : 0);
            if (curLen + needed > maxChars && lines[lines.length - 1].length > 0) {
                lines.push([t]);
                curLen = t.length;
            } else {
                lines[lines.length - 1].push(t);
                curLen += needed;
            }
        }
        return lines;
    }

    /** 中文按字符数换行（无单词边界），超出 maxLines 的尾部加 … */
    _wrapChinese(text, maxCharsPerLine, maxLines = 2) {
        if (!text) return [];
        const lines = [];
        let idx = 0;
        while (idx < text.length && lines.length < maxLines) {
            lines.push(text.slice(idx, idx + maxCharsPerLine));
            idx += maxCharsPerLine;
        }
        if (idx < text.length && lines.length) {
            const last = lines[lines.length - 1];
            lines[lines.length - 1] = (last.length > 1 ? last.slice(0, -1) : last) + '…';
        }
        return lines;
    }

    /** 左上角水印 SVG 片段（"BookMelo"，白字+半透明黑描边） */
    _watermarkSvgFragment() {
        return `<text x="48" y="96" font-size="44" fill="white" fill-opacity="0.78" font-weight="700" font-family="sans-serif" paint-order="stroke" stroke="#000" stroke-opacity="0.5" stroke-width="3" stroke-linejoin="round">BookMelo</text>`;
    }

    /** 生成独立水印 PNG（供页面段 FFmpeg overlay 使用） */
    async _renderWatermark(outPath) {
        const svg = `<svg width="360" height="120" xmlns="http://www.w3.org/2000/svg">
            <text x="0" y="72" font-size="44" fill="white" fill-opacity="0.78" font-weight="700" font-family="sans-serif" paint-order="stroke" stroke="#000" stroke-opacity="0.5" stroke-width="3" stroke-linejoin="round">BookMelo</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outPath);
    }

    /** "The End" 结束页 */
    async _renderEndFrame(outPath, lastImg) {
        const base = lastImg
            ? await sharp(lastImg).resize(W, H, { fit: 'cover' }).blur(8).jpeg().toBuffer()
            : await sharp({ create: { width: W, height: H, channels: 3, background: { r: 30, g: 30, b: 60 } } }).png().toBuffer();

        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${W}" height="${H}" fill="#000" fill-opacity="0.55"/>
            <text x="540" y="960" text-anchor="middle" font-size="180" fill="white" font-weight="800" font-family="serif">The End</text>
            ${this._watermarkSvgFragment()}
        </svg>`;
        const overlay = await sharp(Buffer.from(svg)).png().toBuffer();
        await sharp(base).composite([{ input: overlay, left: 0, top: 0 }]).png().toFile(outPath);
    }

    _wrapTitleText(text, {
        maxWidth = 900,
        startSize = 118,
        minSize = 52,
        maxLines = 2,
        lang = 'en'
    } = {}) {
        const clean = String(text || '').replace(/\s+/g, ' ').trim();
        if (!clean) return { lines: [], fontSize: startSize, lineGap: Math.round(startSize * 1.16) };

        const isZh = lang === 'zh';
        const estimateWidth = (line, fontSize) => {
            let units = 0;
            for (const ch of String(line || '')) {
                if (/[\u3400-\u9fff]/.test(ch)) units += 1.02;
                else if (/[A-Z]/.test(ch)) units += 0.68;
                else if (/[a-z0-9]/.test(ch)) units += 0.56;
                else if (/\s/.test(ch)) units += 0.28;
                else units += 0.42;
            }
            return units * fontSize;
        };

        const trimToWidth = (line, fontSize) => {
            let out = String(line || '').trim();
            while (out.length > 1 && estimateWidth(`${out}...`, fontSize) > maxWidth) {
                out = out.slice(0, -1).trim();
            }
            return `${out}...`;
        };

        const wrap = (fontSize) => {
            if (isZh) {
                const lines = [];
                let cur = '';
                for (const ch of clean) {
                    const next = cur + ch;
                    if (cur && estimateWidth(next, fontSize) > maxWidth) {
                        lines.push(cur);
                        cur = ch;
                    } else {
                        cur = next;
                    }
                }
                if (cur) lines.push(cur);
                return lines;
            }

            const words = clean.split(/\s+/).filter(Boolean);
            const lines = [];
            let cur = '';
            for (const word of words) {
                const next = cur ? `${cur} ${word}` : word;
                if (cur && estimateWidth(next, fontSize) > maxWidth) {
                    lines.push(cur);
                    cur = word;
                } else {
                    cur = next;
                }
            }
            if (cur) lines.push(cur);
            return lines;
        };

        let fontSize = startSize;
        let lines = wrap(fontSize);
        while ((lines.length > maxLines || lines.some(line => estimateWidth(line, fontSize) > maxWidth)) && fontSize > minSize) {
            fontSize -= 4;
            lines = wrap(fontSize);
        }

        if (lines.length > maxLines) {
            lines = lines.slice(0, maxLines);
            lines[maxLines - 1] = trimToWidth(lines[maxLines - 1], fontSize);
        }

        return {
            lines,
            fontSize,
            lineGap: Math.round(fontSize * (isZh ? 1.18 : 1.12))
        };
    }

    _titleTextSvg(lines, { x, y, fontSize, lineGap, fill, stroke, strokeWidth, family, weight = 900, anchor = 'start' }) {
        const e = this._svgEsc;
        return lines.map((line, i) => {
            const baseline = Math.round(y + i * lineGap);
            return `<text x="${x}" y="${baseline}" text-anchor="${anchor}" font-size="${fontSize}" fill="${fill}" font-weight="${weight}" font-family="${family}" paint-order="stroke" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round">${e(line)}</text>`;
        }).join('');
    }

    /** 分享首帧封面图（JPG）：绘本封面 + 中英书名 + 左上角 BookMelo 水印 */
    async _renderCoverImage(outPath, coverPath, book) {
        const base = await sharp(coverPath).resize(W, H, { fit: 'cover' }).toBuffer();
        const titleCn = String(book?.title || '').trim();
        const titleEn = String(book?.title_en || '').trim();
        const titleX = W / 2;
        const titleTop = 380;
        const maxTitleWidth = W - 150;
        const cnLayout = this._wrapTitleText(titleCn, {
            maxWidth: maxTitleWidth,
            startSize: titleCn.length <= 4 ? 176 : 142,
            minSize: 62,
            maxLines: 2,
            lang: 'zh'
        });
        const enLayout = this._wrapTitleText(titleEn, {
            maxWidth: maxTitleWidth,
            startSize: titleEn.length <= 24 ? 78 : 66,
            minSize: 38,
            maxLines: 3,
            lang: 'en'
        });
        const cnBlockH = cnLayout.lines.length ? (cnLayout.lines.length - 1) * cnLayout.lineGap + cnLayout.fontSize : 0;
        const titleGap = titleCn && titleEn ? 58 : 0;
        const enTop = titleTop + cnBlockH + titleGap;
        const titleBlockH = cnBlockH + (titleEn ? titleGap + ((enLayout.lines.length - 1) * enLayout.lineGap + enLayout.fontSize) : 0);
        const topPanelH = Math.min(820, Math.max(560, titleTop + titleBlockH - 40));

        // 标题位置参考语文课本封面：上方留出呼吸感，小字标识、居中大书名、英文名分层排列。
        const titleSvg = `
            <defs>
                <linearGradient id="titleShade" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="#000000" stop-opacity="0.34"/>
                    <stop offset="0.66" stop-color="#000000" stop-opacity="0.16"/>
                    <stop offset="1" stop-color="#000000" stop-opacity="0"/>
                </linearGradient>
                <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#111827" flood-opacity="0.46"/>
                </filter>
            </defs>
            <rect x="0" y="0" width="${W}" height="${topPanelH}" fill="url(#titleShade)"/>
            <g filter="url(#softShadow)">
                ${this._titleTextSvg(cnLayout.lines, {
                    x: Math.round(titleX),
                    y: titleTop,
                    fontSize: cnLayout.fontSize,
                    lineGap: cnLayout.lineGap,
                    fill: '#ffffff',
                    stroke: '#173323',
                    strokeWidth: 6,
                    family: 'Noto Sans CJK SC, Source Han Sans SC, PingFang SC, Microsoft YaHei, sans-serif',
                    weight: 900,
                    anchor: 'middle'
                })}
                ${this._titleTextSvg(enLayout.lines, {
                    x: Math.round(titleX),
                    y: enTop,
                    fontSize: enLayout.fontSize,
                    lineGap: enLayout.lineGap,
                    fill: '#ffffff',
                    stroke: '#173323',
                    strokeWidth: 4,
                    family: 'Avenir Next, Montserrat, Arial, sans-serif',
                    weight: 900,
                    anchor: 'middle'
                })}
            </g>
            <text x="540" y="1816" text-anchor="middle" font-size="44" fill="white" fill-opacity="0.78" font-weight="700" font-family="Avenir Next, Montserrat, Arial, sans-serif" paint-order="stroke" stroke="#000" stroke-opacity="0.44" stroke-width="3" stroke-linejoin="round">BookMelo</text>
        `;

        const wmSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${titleSvg}</svg>`;
        const overlay = await sharp(Buffer.from(wmSvg)).png().toBuffer();
        await sharp(base).composite([{ input: overlay, left: 0, top: 0 }]).jpeg({ quality: 88 }).toFile(outPath);
    }

    // ==================== FFmpeg 通用 ====================

    /** 静态图片 + 可选音频 → mp4（用于封面首帧、标题、结尾）
     *  fade 默认关闭：外层 concat 依赖"无黑闪"切换；仅在 opts 明确开启时加淡入/淡出
     */
    async _imgToVideo(imagePath, audioPath, duration, outPath,
        { noZoom = false, fadeIn = false, fadeOut = false } = {}) {
        const hasAudio = audioPath && fs.existsSync(audioPath);
        const foStart = Math.max(0, duration - FADE);

        const baseFilter = noZoom
            ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`
            : `zoompan=z='min(zoom+0.0005,1.12)':d=${Math.ceil(duration * 30)}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=30`;
        const fiV = fadeIn ? `,fade=t=in:st=0:d=${FADE}` : '';
        const foV = fadeOut ? `,fade=t=out:st=${foStart}:d=${FADE}` : '';
        const vf = `${baseFilter}${fiV}${foV}`;
        const fiA = fadeIn ? `,afade=t=in:st=0:d=${FADE}` : '';
        const foA = fadeOut ? `,afade=t=out:st=${foStart}:d=${FADE}` : '';

        if (hasAudio) {
            await this._runFFmpeg([
                '-i', imagePath, '-i', audioPath,
                '-filter_complex',
                `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${duration}${fiA}${foA}[a];[0:v]${vf}[v]`,
                '-map', '[v]', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration), '-y', outPath
            ]);
        } else {
            await this._runFFmpeg([
                '-i', imagePath,
                '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                '-filter_complex',
                `[1:a]anull${fiA}${foA}[a];[0:v]${vf}[v]`,
                '-map', '[v]', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration), '-y', outPath
            ]);
        }
    }

    /** concat 所有段 + 混入 BGM */
    async _concatWithBgm(segPaths, outPath, tempDir) {
        const listFile = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));

        const hasBGM = fs.existsSync(BGM_PATH);
        if (hasBGM) {
            const rawConcat = path.join(tempDir, 'raw_concat.mp4');
            await this._runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', rawConcat]);

            await this._runFFmpeg([
                '-i', rawConcat,
                '-stream_loop', '-1', '-i', BGM_PATH,
                '-filter_complex',
                `[1:a]volume=${BGM_VOL},afade=t=in:st=0:d=1,afade=t=out:st=999:d=1[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]`,
                '-map', '0:v', '-map', '[a]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-y', outPath
            ]);
        } else {
            await this._runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outPath]);
        }
    }

    _runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';
            proc.stderr.on('data', c => { stderr += c.toString(); });
            proc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg 退出码 ${code}: ${stderr.split('\n').slice(-12).join('\n')}`));
            });
            proc.on('error', err => reject(new Error(`FFmpeg 启动失败: ${err.message}`)));
        });
    }

    async _getAudioDuration(filePath) {
        try {
            const out = execFileSync('ffprobe', [
                '-v', 'error', '-show_entries', 'format=duration',
                '-of', 'csv=p=0', filePath
            ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            return parseFloat(out.trim()) || 2;
        } catch (e) { return 2; }
    }

    // ==================== 工具 ====================

    _tokenize(text) {
        // 简单分词：按空格 + 保留标点附着在前一词
        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (!cleaned) return [];
        return cleaned.split(' ').filter(t => t.length > 0);
    }

    _svgEsc(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    async _resolveUrl(url, tempDir, name) {
        if (!url) return null;
        if (url.startsWith('/uploads/')) {
            const p = path.join(SERVER_ROOT, url);
            if (fs.existsSync(p)) return p;
            throw new Error(`文件不存在: ${p}`);
        }
        if (url.startsWith('http')) {
            const local = path.join(tempDir, name);
            const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
            fs.writeFileSync(local, resp.data);
            return local;
        }
        throw new Error(`无法解析 URL: ${url}`);
    }

    _cleanup(tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
}

module.exports = new PictureBookVideoService();
