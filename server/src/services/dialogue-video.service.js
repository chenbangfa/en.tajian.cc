/**
 * 对话场景视频生成服务
 *
 * 将 dialogue_scenes + dialogue_lines 转为 1080×1920 竖版短视频。
 * 采用"聊天记录风"——微信聊天气泡样式呈现对话。
 *
 * 时间轴：
 *   0.8s  封面首帧（分享缩略图）
 *   2.5s  标题页（角色介绍）
 *   N*~3s 对话台词（逐句气泡出现 + 逐词高亮）
 *   3.0s  复习页（全部对话一览）
 *   1.5s  结尾帧 "Practice Now!"
 *
 * 关键技术：
 * - 上 40%：封面图模糊背景 + Ken Burns
 * - 中 50%：聊天气泡区（Sharp SVG 渲染，逐词高亮）
 * - 下 10%：场景信息栏
 * - 字符加权估算词时长（复用绘本算法）
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const sharp = require('sharp');
const { query } = require('../config/database');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/dialogue-videos');
const BGM_PATH = path.join(SERVER_ROOT, 'assets/audio/bgm_fairy_dance.mp3');

const W = 1080;
const H = 1920;
const TOP_H = 768;      // 上方 40%：封面模糊背景
const CHAT_H = 960;     // 中间 50%：聊天气泡区
const BOT_H = 192;      // 底部 10%：场景信息栏
const FADE = 0.25;
const GAP = 0.25;       // 段间静音
const BGM_VOL = 0.06;   // 对话视频 BGM 更低（对话语音更密集）

// 气泡布局常量
const BUBBLE_PAD_X = 60;       // 气泡区水平内边距
const BUBBLE_PAD = 20;         // 气泡内部 padding
const BUBBLE_GAP = 16;         // 气泡间垂直间距
const BUBBLE_RADIUS = 16;      // 气泡圆角
const MAX_BUBBLE_W = 680;      // 气泡最大宽度
const ROLE_LABEL_H = 32;       // 角色标签高度
const EN_FONT = 34;            // 气泡内英文字号
const CN_FONT = 26;            // 气泡内中文字号
const GUIDE_COLOR = '#3B82F6'; // guide 气泡蓝色
const USER_COLOR = '#22C55E';  // user 气泡绿色
const HIGHLIGHT_COLOR = '#FFD84A'; // 逐词高亮黄色

// H.264 编码器检测
let H264_ENCODER = 'libx264';
try {
    const enc = execFileSync('ffmpeg', ['-encoders'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (enc.includes('libx264')) H264_ENCODER = 'libx264';
    else if (enc.includes('libopenh264')) H264_ENCODER = 'libopenh264';
} catch (e) { /* ignore */ }

let isProcessing = false;

class DialogueVideoService {

    constructor() {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // ==================== 主流程 ====================

    async generateSceneVideo(sceneId, jobId, config = {}) {
        const { subtitle_mode = 'bilingual' } = config;

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `dlgv-${jobId}-`));

        try {
            // 1. 拉取场景 + 台词
            const [scene] = await query(
                `SELECT id, title, title_en, description, description_en,
                        cover_image, category_id, difficulty,
                        guide_role, user_role
                 FROM dialogue_scenes WHERE id = ?`, [sceneId]
            );
            if (!scene) throw new Error('场景不存在');

            const lines = await query(
                `SELECT id, scene_id, role, line_en, line_cn, audio_url, sort_order
                 FROM dialogue_lines WHERE scene_id = ? ORDER BY sort_order ASC`,
                [sceneId]
            );
            if (!lines.length) throw new Error('场景无台词');

            await this._updateJob(jobId, { progress: 5 });

            // 2. 解析素材（本地化）
            let coverLocal = null;
            if (scene.cover_image) {
                try {
                    coverLocal = await this._resolveUrl(scene.cover_image, tempDir, 'cover.jpg');
                } catch (e) {
                    console.log(`[DlgVideo] 封面图解析失败，使用渐变: ${e.message}`);
                }
            }

            const lineAssets = [];
            for (const line of lines) {
                let audioLocal = null;
                let audioDur = 2;
                if (line.audio_url) {
                    try {
                        audioLocal = await this._resolveUrl(line.audio_url, tempDir, `line_${line.id}.mp3`);
                        audioDur = await this._getAudioDuration(audioLocal);
                    } catch (e) {
                        console.log(`[DlgVideo] 音频解析失败 line ${line.id}: ${e.message}`);
                    }
                }
                lineAssets.push({ ...line, audioLocal, audioDur });
            }
            await this._updateJob(jobId, { progress: 15 });

            // 3. 渲染基底帧（1080×1920 PNG）
            const baseFrame = path.join(tempDir, 'base.png');
            await this._renderBaseFrame(baseFrame, coverLocal, scene);
            await this._updateJob(jobId, { progress: 20 });

            const baseName = `dlg_${sceneId}_${(scene.title_en || scene.title).replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().slice(0, 40)}_${Date.now()}`;

            // 4. 标题页（同时作为视频首帧封面图来源）
            const titleFrame = path.join(tempDir, 'title.png');
            await this._renderTitleFrame(titleFrame, scene, coverLocal);

            // 5. 生成封面图（分享缩略图/视频首帧）
            const coverOut = path.join(OUTPUT_DIR, `${baseName}.jpg`);
            await this._renderCoverImage(coverOut, titleFrame);

            // 6. 段构造
            const segDir = path.join(tempDir, 'seg');
            fs.mkdirSync(segDir, { recursive: true });
            const segments = [];
            let segIdx = 0;

            // 6a. 封面首帧（0.8s，静态）
            const coverSeg = path.join(segDir, `s${String(segIdx++).padStart(3, '0')}_cover.mp4`);
            await this._imgToVideo(coverOut, null, 0.8, coverSeg, { noZoom: true });
            segments.push(coverSeg);

            // 6b. 标题页（2.5s）
            const titleSeg = path.join(segDir, `s${String(segIdx++).padStart(3, '0')}_title.mp4`);
            await this._imgToVideo(titleFrame, null, 2.5, titleSeg);
            segments.push(titleSeg);
            await this._updateJob(jobId, { progress: 25 });

            // 6c. 每句对话段
            const progPerLine = 55 / lineAssets.length;
            for (let i = 0; i < lineAssets.length; i++) {
                const lineSeg = path.join(segDir, `line_${String(i).padStart(3, '0')}.mp4`);
                await this._buildLineSegment(i, lineAssets, scene, subtitle_mode, baseFrame, lineSeg, tempDir);
                segments.push(lineSeg);
                await this._updateJob(jobId, { progress: Math.round(25 + (i + 1) * progPerLine) });
            }

            // 6d. 结尾帧（1.5s）
            const endFrame = path.join(tempDir, 'end.png');
            await this._renderEndFrame(endFrame, coverLocal);
            const endSeg = path.join(segDir, `s${String(segIdx++).padStart(3, '0')}_end.mp4`);
            await this._imgToVideo(endFrame, null, 1.5, endSeg, { fadeOut: true });
            segments.push(endSeg);

            // 6. Concat + BGM
            const videoOut = path.join(OUTPUT_DIR, `${baseName}.mp4`);
            await this._concatWithBgm(segments, videoOut, tempDir);
            await this._updateJob(jobId, { progress: 95 });

            // 7. 完成
            const videoUrl = `/uploads/dialogue-videos/${baseName}.mp4`;
            const coverUrl = `/uploads/dialogue-videos/${baseName}.jpg`;
            const finalDur = await this._getAudioDuration(videoOut);
            await this._updateJob(jobId, {
                status: 'done',
                progress: 100,
                video_url: videoUrl,
                cover_url: coverUrl,
                duration_seconds: Math.round(finalDur)
            });
            console.log(`[DlgVideo] 完成: ${baseName}.mp4 (${finalDur.toFixed(1)}s)`);
            return videoUrl;

        } catch (err) {
            console.error(`[DlgVideo] 失败 (job ${jobId}):`, err);
            await this._updateJob(jobId, { status: 'failed', error_message: err.message });
            throw err;
        } finally {
            this._cleanup(tempDir);
        }
    }

    async processNextJob() {
        if (isProcessing) return;
        const [job] = await query(
            `SELECT * FROM dialogue_video_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
        );
        if (!job) return;
        isProcessing = true;
        try {
            let config = {};
            try { config = JSON.parse(job.config_json || '{}'); } catch (e) { /* ignore */ }
            await this.generateSceneVideo(job.scene_id, job.id, config);
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
        await query(`UPDATE dialogue_video_jobs SET ${setClause}, updated_at = NOW() WHERE id = ?`, values);
    }

    // ==================== 对话段生成（核心） ====================

    /**
     * 构建第 lineIdx 句对话的视频段：
     * 基底帧（zoompan） + 聊天气泡覆盖层（透明 MOV） + 该句音频
     */
    async _buildLineSegment(lineIdx, lineAssets, scene, subtitle_mode, baseFrame, outPath, tempDir) {
        const line = lineAssets[lineIdx];
        const dur = Math.max(2.0, line.audioDur + GAP);
        const showCn = subtitle_mode === 'bilingual';

        // 1. 分词 + 计算每词时长
        const tokens = this._tokenize(line.line_en || '');
        if (!tokens.length) tokens.push(line.line_en || '...');

        const weights = tokens.map(t => Math.max(1, t.length));
        const totalW = weights.reduce((s, w) => s + w, 0);
        const speechDur = line.audioDur;
        const wordDurs = weights.map(w => speechDur * w / totalW);
        wordDurs[wordDurs.length - 1] += (dur - speechDur);

        // 2. 为每个词生成一帧聊天区 PNG
        const chatFrames = [];
        for (let i = 0; i < tokens.length; i++) {
            const fp = path.join(tempDir, `chat_${lineIdx}_${i}.png`);
            await this._renderChatFrame(fp, lineAssets, lineIdx, i, scene, showCn);
            chatFrames.push({ path: fp, dur: wordDurs[i] });
        }

        // 3. 聊天帧 → 透明视频（MOV + qtrle）
        const chatVideo = path.join(tempDir, `chat_${lineIdx}.mov`);
        await this._chatFramesToVideo(chatFrames, chatVideo);

        // 4. 基底帧 → zoompan 视频（仅上方封面区有动效）
        const bgVideo = path.join(tempDir, `bg_${lineIdx}.mp4`);
        await this._baseFrameToVideo(baseFrame, dur, bgVideo);

        // 5. 合成：bg + chat overlay + audio
        const SNAP = 0.08;
        const hasAudio = line.audioLocal && fs.existsSync(line.audioLocal);
        const inputs = ['-i', bgVideo, '-i', chatVideo];
        if (hasAudio) inputs.push('-i', line.audioLocal);
        else inputs.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');

        const audioFilter = `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${dur},afade=t=in:st=0:d=${SNAP},afade=t=out:st=${(dur - SNAP).toFixed(3)}:d=${SNAP}[a]`;
        const vf = `[0:v][1:v]overlay=0:${TOP_H}:format=auto[v]`;

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

    /** 基底帧 → 带微弱 zoompan 的视频（上方封面区有推进效果） */
    async _baseFrameToVideo(baseFrame, duration, outPath) {
        const frames = Math.ceil(duration * 30);
        const zp = `zoompan=z='min(zoom+0.0002,1.05)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=30`;
        const filter = `[0:v]scale=${W}:${H},setsar=1,fps=30,${zp}[v]`;

        await this._runFFmpeg([
            '-loop', '1', '-i', baseFrame,
            '-filter_complex', filter,
            '-map', '[v]',
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p',
            '-t', String(duration),
            '-y', outPath
        ]);
    }

    /** 聊天帧序列 → 带 alpha 通道的视频 */
    async _chatFramesToVideo(frames, outPath) {
        const tempList = outPath + '.txt';
        const listLines = [];
        for (const f of frames) {
            listLines.push(`file '${f.path}'`);
            listLines.push(`duration ${f.dur.toFixed(3)}`);
        }
        listLines.push(`file '${frames[frames.length - 1].path}'`);
        fs.writeFileSync(tempList, listLines.join('\n'));

        await this._runFFmpeg([
            '-f', 'concat', '-safe', '0', '-i', tempList,
            '-vf', `fps=30,scale=${W}:${CHAT_H}:flags=bicubic,setsar=1,format=rgba`,
            '-c:v', 'qtrle',
            '-y', outPath
        ]);
    }

    // ==================== 聊天气泡渲染 ====================

    /**
     * 渲染一帧聊天区 PNG（1080×960 透明背景）
     * 显示 line 0..activeLineIdx 的所有气泡，当前句逐词高亮到 highlightWordIdx
     */
    async _renderChatFrame(outPath, allLines, activeLineIdx, highlightWordIdx, scene, showCn) {
        const e = this._svgEsc;

        // 1. 计算所有气泡的布局
        const bubbles = [];
        for (let i = 0; i <= activeLineIdx; i++) {
            const line = allLines[i];
            const isActive = (i === activeLineIdx);
            const bubble = this._calcBubble(line, i, allLines, scene, showCn, isActive, highlightWordIdx);
            bubbles.push(bubble);
        }

        // 2. 计算总高度，确定滚动偏移
        let totalH = 20; // 顶部 padding
        for (const b of bubbles) {
            totalH += (b.showLabel ? ROLE_LABEL_H : 0) + b.height + BUBBLE_GAP;
        }
        const scrollOffset = Math.max(0, totalH - CHAT_H + 40);

        // 3. 构建 SVG
        let y = 20 - scrollOffset;
        let svgContent = '';

        for (let i = 0; i < bubbles.length; i++) {
            const b = bubbles[i];
            const isActive = (i === activeLineIdx);
            const opacity = isActive ? 1.0 : 0.6;

            // 跳过不可见的气泡
            if (y + (b.showLabel ? ROLE_LABEL_H : 0) + b.height < -50) {
                y += (b.showLabel ? ROLE_LABEL_H : 0) + b.height + BUBBLE_GAP;
                continue;
            }
            if (y > CHAT_H + 50) break;

            svgContent += `<g opacity="${opacity}">`;

            // 气泡背景
            const bubbleColor = b.isGuide ? GUIDE_COLOR : USER_COLOR;
            const bx = b.isGuide ? BUBBLE_PAD_X : (W - BUBBLE_PAD_X - b.width);
            svgContent += `<rect x="${bx}" y="${Math.round(y)}" width="${b.width}" height="${b.height}" rx="${BUBBLE_RADIUS}" ry="${BUBBLE_RADIUS}" fill="${bubbleColor}"/>`;

            // 气泡小尾巴
            if (b.isGuide) {
                const tx = bx;
                const ty = Math.round(y + b.height - 20);
                svgContent += `<polygon points="${tx},${ty} ${tx - 10},${ty + 8} ${tx},${ty + 16}" fill="${bubbleColor}"/>`;
            } else {
                const tx = bx + b.width;
                const ty = Math.round(y + b.height - 20);
                svgContent += `<polygon points="${tx},${ty} ${tx + 10},${ty + 8} ${tx},${ty + 16}" fill="${bubbleColor}"/>`;
            }

            // 英文文本
            let textY = Math.round(y + BUBBLE_PAD + EN_FONT * 0.88);
            const textX = bx + BUBBLE_PAD;
            const enLineGap = Math.round(EN_FONT * 1.2);

            if (isActive) {
                // 逐词高亮
                const tokens = this._tokenize(allLines[activeLineIdx].line_en || '');
                const maxContentW = MAX_BUBBLE_W - BUBBLE_PAD * 2;
                const enCharsPerLine = Math.max(10, Math.floor(maxContentW / (EN_FONT * 0.55)));
                const wrappedLines = this._wrapTokens(tokens, enCharsPerLine);
                let globalIdx = 0;
                for (const wl of wrappedLines) {
                    const tspans = wl.map((word, wi) => {
                        const fill = globalIdx <= highlightWordIdx ? HIGHLIGHT_COLOR : '#FFFFFF';
                        const weight = globalIdx <= highlightWordIdx ? '800' : '600';
                        const dx = wi === 0 ? '0' : Math.round(EN_FONT * 0.22);
                        globalIdx++;
                        return `<tspan fill="${fill}" font-weight="${weight}" dx="${dx}">${e(word)}</tspan>`;
                    }).join('');
                    svgContent += `<text x="${textX}" y="${textY}" font-size="${EN_FONT}" font-family="sans-serif">${tspans}</text>`;
                    textY += enLineGap;
                }
            } else {
                // 静态白色文本
                for (const wl of b.enLines) {
                    svgContent += `<text x="${textX}" y="${textY}" font-size="${EN_FONT}" fill="#FFFFFF" font-weight="600" font-family="sans-serif">${e(wl.join(' '))}</text>`;
                    textY += enLineGap;
                }
            }

            // 中文文本
            if (showCn && b.cnLines.length > 0) {
                textY += 4; // 英中间距
                const cnLineGap = Math.round(CN_FONT * 1.2);
                for (const cl of b.cnLines) {
                    svgContent += `<text x="${textX}" y="${textY}" font-size="${CN_FONT}" fill="rgba(255,255,255,0.7)" font-weight="400" font-family="sans-serif">${e(cl)}</text>`;
                    textY += cnLineGap;
                }
            }

            svgContent += '</g>';
            y += b.height + BUBBLE_GAP;
        }

        const svg = `<svg width="${W}" height="${CHAT_H}" xmlns="http://www.w3.org/2000/svg">${svgContent}</svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outPath);
    }

    /** 计算单个气泡的尺寸和布局信息 */
    _calcBubble(line, lineIdx, allLines, scene, showCn, isActive, highlightWordIdx) {
        const isGuide = line.role === 'guide';
        const showLabel = false;
        const maxContentW = MAX_BUBBLE_W - BUBBLE_PAD * 2;

        // 英文换行
        const tokens = this._tokenize(line.line_en || '');
        const enCharsPerLine = Math.max(10, Math.floor(maxContentW / (EN_FONT * 0.55)));
        const enLines = this._wrapTokens(tokens.length ? tokens : ['...'], enCharsPerLine);
        const enBlockH = enLines.length * Math.round(EN_FONT * 1.2);

        // 中文换行
        let cnLines = [];
        if (showCn && line.line_cn) {
            const cnCharsPerLine = Math.max(8, Math.floor(maxContentW / (CN_FONT * 1.02)));
            cnLines = this._wrapChinese(String(line.line_cn).trim(), cnCharsPerLine, 2);
        }
        const cnBlockH = cnLines.length * Math.round(CN_FONT * 1.2);

        // 气泡高度
        const contentH = enBlockH + (cnBlockH > 0 ? 4 + cnBlockH : 0);
        const height = contentH + BUBBLE_PAD * 2;

        // 气泡宽度：取最宽行
        let maxLineW = 0;
        for (const wl of enLines) {
            const lw = wl.join(' ').length * EN_FONT * 0.55;
            if (lw > maxLineW) maxLineW = lw;
        }
        for (const cl of cnLines) {
            const lw = cl.length * CN_FONT * 1.02;
            if (lw > maxLineW) maxLineW = lw;
        }
        const width = Math.min(MAX_BUBBLE_W, Math.max(120, Math.round(maxLineW) + BUBBLE_PAD * 2));

        return { isGuide, showLabel, enLines, cnLines, height, width };
    }

    // ==================== 帧渲染 ====================

    /** 渲染基底帧：上方封面模糊 + 中间深色聊天区 + 底部信息栏 */
    async _renderBaseFrame(outPath, coverLocal, scene) {
        // 上方：封面模糊 or 渐变
        let topBuffer;
        if (coverLocal) {
            const blurredBg = await sharp(coverLocal)
                .resize(W, TOP_H, { fit: 'cover' })
                .blur(8)
                .toBuffer();
            const topCard = await this._renderContainedCoverCard(coverLocal, W, TOP_H, {
                insetX: 48,
                insetY: 48,
                overlayOpacity: 0.28
            });
            topBuffer = await sharp(blurredBg)
                .composite([{ input: topCard, left: 0, top: 0 }])
                .toBuffer();
        } else {
            // 渐变背景
            const gradSvg = `<svg width="${W}" height="${TOP_H}" xmlns="http://www.w3.org/2000/svg">
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#1E3A5F"/>
                    <stop offset="100%" stop-color="#0F1B2D"/>
                </linearGradient></defs>
                <rect width="${W}" height="${TOP_H}" fill="url(#g)"/>
            </svg>`;
            topBuffer = await sharp(Buffer.from(gradSvg)).png().toBuffer();
        }

        // 中间：深色聊天区
        const midSvg = `<svg width="${W}" height="${CHAT_H}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${W}" height="${CHAT_H}" fill="#1A1A2E"/>
        </svg>`;
        const midBuffer = await sharp(Buffer.from(midSvg)).png().toBuffer();

        // 底部：信息栏
        const e = this._svgEsc;
        const stars = '★'.repeat(scene.difficulty || 1) + '☆'.repeat(3 - (scene.difficulty || 1));
        const botSvg = `<svg width="${W}" height="${BOT_H}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${W}" height="${BOT_H}" fill="#111827"/>
            <text x="540" y="80" text-anchor="middle" font-size="36" fill="#FFFFFF" font-weight="700" font-family="sans-serif">${e(scene.title_en || scene.title || '')}</text>
            <text x="540" y="130" text-anchor="middle" font-size="28" fill="#9CA3AF" font-family="sans-serif">${e(scene.title || '')} ${stars}</text>
            <text x="540" y="170" text-anchor="middle" font-size="24" fill="#6B7280" font-weight="500" font-family="sans-serif">BookMelo</text>
        </svg>`;
        const botBuffer = await sharp(Buffer.from(botSvg)).png().toBuffer();

        // 拼合
        await sharp({
            create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
        })
            .composite([
                { input: topBuffer, left: 0, top: 0 },
                { input: midBuffer, left: 0, top: TOP_H },
                { input: botBuffer, left: 0, top: TOP_H + CHAT_H }
            ])
            .png().toFile(outPath);
    }

    /** 标题页：场景标题 + 角色介绍 */
    async _renderTitleFrame(outPath, scene, coverLocal) {
        // 先渲染一个基底
        let base;
        if (coverLocal) {
            base = await sharp(coverLocal)
                .resize(W, H, { fit: 'cover' })
                .blur(6)
                .toBuffer();
        } else {
            const bgSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
                <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#1E3A5F"/>
                    <stop offset="100%" stop-color="#0F1B2D"/>
                </linearGradient></defs>
                <rect width="${W}" height="${H}" fill="url(#g)"/>
            </svg>`;
            base = await sharp(Buffer.from(bgSvg)).png().toBuffer();
        }

        const e = this._svgEsc;
        const stars = '★'.repeat(scene.difficulty || 1) + '☆'.repeat(3 - (scene.difficulty || 1));
        const titleEnLines = this._wrapText(String(scene.title_en || '').trim(), 20, 3);
        const titleCnLines = this._wrapChinese(String(scene.title || '').trim(), 12, 2);
        const titleEnLineH = 84;
        const titleCnLineH = 54;
        const titleGap = titleCnLines.length ? 26 : 0;
        const titleBlockH = (titleEnLines.length * titleEnLineH) + (titleCnLines.length * titleCnLineH) + titleGap;
        let titleY = 700 - Math.round(titleBlockH / 2);
        let titleSvg = '';
        for (const line of titleEnLines) {
            titleSvg += `<text x="540" y="${titleY}" text-anchor="middle" font-size="72" fill="#FFFFFF" font-weight="800" font-family="sans-serif">${e(line)}</text>`;
            titleY += titleEnLineH;
        }
        if (titleCnLines.length) {
            titleY += titleGap;
            for (const line of titleCnLines) {
                titleSvg += `<text x="540" y="${titleY}" text-anchor="middle" font-size="44" fill="#E0E0E0" font-weight="500" font-family="sans-serif">${e(line)}</text>`;
                titleY += titleCnLineH;
            }
        }
        const starsY = titleY + 36;
        const overlaySvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${W}" height="${H}" fill="#000" fill-opacity="0.55"/>
            ${titleSvg}
            <text x="540" y="${starsY}" text-anchor="middle" font-size="36" fill="#FFD84A" font-family="sans-serif">${stars}</text>
            <line x1="400" y1="${starsY + 50}" x2="680" y2="${starsY + 50}" stroke="#4B5563" stroke-width="2"/>
            <text x="540" y="1200" text-anchor="middle" font-size="28" fill="#6B7280" font-family="sans-serif">BookMelo</text>
        </svg>`;
        const overlay = await sharp(Buffer.from(overlaySvg)).png().toBuffer();
        await sharp(base)
            .composite([{ input: overlay, left: 0, top: 0 }])
            .png().toFile(outPath);
    }

    /** 复习页：所有对话紧凑排列 */
    async _renderReviewFrame(outPath, lineAssets, scene, coverLocal) {
        let base;
        if (coverLocal) {
            base = await sharp(coverLocal)
                .resize(W, H, { fit: 'cover' })
                .blur(10)
                .toBuffer();
        } else {
            base = await sharp({
                create: { width: W, height: H, channels: 3, background: { r: 15, g: 20, b: 35 } }
            }).png().toBuffer();
        }

        const e = this._svgEsc;
        // 根据行数调整字号
        const lineCount = lineAssets.length;
        const fontSize = lineCount > 12 ? 24 : lineCount > 8 ? 28 : 32;
        const lineH = Math.round(fontSize * 1.6);
        const startY = 220;

        let textSvg = '';
        for (let i = 0; i < lineAssets.length; i++) {
            const line = lineAssets[i];
            const y = startY + i * lineH;
            if (y > H - 200) break;

            const isGuide = line.role === 'guide';
            const color = isGuide ? '#93C5FD' : '#86EFAC';
            const text = `${line.line_en || ''}`;
            textSvg += `<text x="80" y="${y}" font-size="${fontSize}" fill="${color}" font-weight="500" font-family="sans-serif">${e(text.length > 48 ? text.slice(0, 46) + '...' : text)}</text>`;
        }

        const overlaySvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${W}" height="${H}" fill="#000" fill-opacity="0.65"/>
            ${textSvg}
            <text x="540" y="${H - 100}" text-anchor="middle" font-size="24" fill="#6B7280" font-family="sans-serif">BookMelo</text>
        </svg>`;
        const overlay = await sharp(Buffer.from(overlaySvg)).png().toBuffer();
        await sharp(base)
            .composite([{ input: overlay, left: 0, top: 0 }])
            .png().toFile(outPath);
    }

    /** 结尾帧 */
    async _renderEndFrame(outPath, coverLocal) {
        let base;
        if (coverLocal) {
            base = await sharp(coverLocal)
                .resize(W, H, { fit: 'cover' })
                .blur(8)
                .toBuffer();
        } else {
            base = await sharp({
                create: { width: W, height: H, channels: 3, background: { r: 15, g: 20, b: 35 } }
            }).png().toBuffer();
        }

        const overlaySvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${W}" height="${H}" fill="#000" fill-opacity="0.6"/>
            <text x="540" y="880" text-anchor="middle" font-size="120" fill="#FFFFFF" font-weight="800" font-family="serif">Practice</text>
            <text x="540" y="1020" text-anchor="middle" font-size="120" fill="#FFD84A" font-weight="800" font-family="serif">Now!</text>
            <text x="540" y="1200" text-anchor="middle" font-size="36" fill="#9CA3AF" font-family="sans-serif">BookMelo</text>
        </svg>`;
        const overlay = await sharp(Buffer.from(overlaySvg)).png().toBuffer();
        await sharp(base)
            .composite([{ input: overlay, left: 0, top: 0 }])
            .png().toFile(outPath);
    }

    /** 分享封面图 */
    async _renderCoverImage(outPath, sourceFramePath) {
        await sharp(sourceFramePath)
            .jpeg({ quality: 88 })
            .toFile(outPath);
    }

    // ==================== FFmpeg 通用 ====================

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
        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (!cleaned) return [];
        return cleaned.split(' ').filter(t => t.length > 0);
    }

    _svgEsc(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

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

    _wrapText(text, maxCharsPerLine, maxLines = 3) {
        const tokens = this._tokenize(text);
        if (!tokens.length) return [];
        const lines = this._wrapTokens(tokens, maxCharsPerLine).map(line => line.join(' '));
        if (lines.length <= maxLines) return lines;
        const truncated = lines.slice(0, maxLines);
        truncated[maxLines - 1] = this._trimWithEllipsis(truncated[maxLines - 1], maxCharsPerLine);
        return truncated;
    }

    _trimWithEllipsis(text, maxChars) {
        if (!text || text.length <= maxChars) return text;
        if (maxChars <= 1) return '…';
        return text.slice(0, maxChars - 1).trimEnd() + '…';
    }

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

    async _renderContainedCoverCard(coverLocal, targetW, targetH, { insetX = 48, insetY = 48, overlayOpacity = 0.28 } = {}) {
        const cardW = targetW - insetX * 2;
        const cardH = targetH - insetY * 2;
        const darkOverlay = `<svg width="${targetW}" height="${targetH}" xmlns="http://www.w3.org/2000/svg">
            <rect width="${targetW}" height="${targetH}" fill="#000" fill-opacity="${overlayOpacity}"/>
            <rect x="${insetX - 2}" y="${insetY - 2}" width="${cardW + 4}" height="${cardH + 4}" rx="34" ry="34" fill="#FFFFFF" fill-opacity="0.08"/>
        </svg>`;
        const contained = await sharp(coverLocal)
            .resize(cardW, cardH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer({ resolveWithObject: true });
        const left = Math.round((targetW - contained.info.width) / 2);
        const top = Math.round((targetH - contained.info.height) / 2);

        return sharp({
            create: { width: targetW, height: targetH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
        })
            .composite([
                { input: Buffer.from(darkOverlay), left: 0, top: 0 },
                { input: contained.data, left, top }
            ])
            .png()
            .toBuffer();
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

module.exports = new DialogueVideoService();
