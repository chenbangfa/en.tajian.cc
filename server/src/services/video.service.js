const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const sharp = require('sharp');
const { query } = require('../config/database');
const voiceService = require('./voice.service');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/marketing/videos');
const INTRO_AUDIO_PATH = path.join(SERVER_ROOT, 'uploads/audio/video_intro_question.mp3');
const BGM_PATH = path.join(SERVER_ROOT, 'assets/audio/bgm_fairy_dance.mp3');
const SFX_DING_PATH = path.join(SERVER_ROOT, 'assets/audio/sfx_ding.wav');
const LOGO_PATH = path.join(SERVER_ROOT, 'assets/images/logo.png');

const W = 1080;
const H = 1920;
const GAP = 1.5;   // 段间静音间隔（秒）
const FADE = 0.3;  // 淡入淡出时长（秒）
const BGM_VOL = 0.12; // 背景音乐音量（0-1）

// 检测 H.264 编码器
let H264_ENCODER = 'libx264';
try {
    const enc = execFileSync('ffmpeg', ['-encoders'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (enc.includes('libx264')) H264_ENCODER = 'libx264';
    else if (enc.includes('libopenh264')) H264_ENCODER = 'libopenh264';
    console.log(`[Video] H.264 编码器: ${H264_ENCODER}`);
} catch (e) {
    console.warn('[Video] FFmpeg 编码器检测失败');
}

let isProcessing = false;

class VideoService {

    constructor() {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // ==================== 主流程 ====================

    async generateDailyWord(wordId, jobId) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));

        try {
            await this._updateJob(jobId, { status: 'processing', progress: 0 });

            const [word] = await query('SELECT * FROM words WHERE id = ?', [wordId]);
            if (!word) throw new Error(`单词 ID ${wordId} 不存在`);

            // 1. 解析素材
            const a = await this._resolveWordAssets(word, tempDir);
            await this._updateJob(jobId, { progress: 10 });

            // 2. 获取开场语音 + 各音频时长
            const introAudio = await this._getIntroAudio();
            const durIntro = introAudio ? await this._getAudioDuration(introAudio) : 0;
            const durFemale = a.audioFemale ? await this._getAudioDuration(a.audioFemale) : 0;
            const durMale = a.audioMale ? await this._getAudioDuration(a.audioMale) : 0;
            const durExFemale = a.exampleAudioFemale ? await this._getAudioDuration(a.exampleAudioFemale) : 0;
            const durExMale = a.exampleAudioMale ? await this._getAudioDuration(a.exampleAudioMale) : 0;
            await this._updateJob(jobId, { progress: 15 });

            // 3. 渲染所有帧图片
            const frames = {};

            // 开场帧：物体图片 + 提问 + 中文翻译（清晰展示，让用户看清楚）
            frames.intro = path.join(tempDir, 'f_intro.png');
            await this._renderIntroFrame(frames.intro, a.image, word);

            // 单词帧：物体图片 + 单词 + 音标
            frames.word = path.join(tempDir, 'f_word.png');
            await this._renderWordFrame(frames.word, a.image, word);

            // 单词+翻译帧：物体图片 + 单词 + 音标 + 中文
            frames.wordTrans = path.join(tempDir, 'f_word_trans.png');
            await this._renderWordFrame(frames.wordTrans, a.image, word, true);

            // 例句帧：例句图片(或物体图片) + 例句
            frames.example = path.join(tempDir, 'f_example.png');
            const exImage = a.exampleImage || a.image;
            await this._renderExampleFrame(frames.example, exImage, word);

            // 倒计时帧：3 / 2 / 1
            frames.cd3 = path.join(tempDir, 'f_cd3.png');
            frames.cd2 = path.join(tempDir, 'f_cd2.png');
            frames.cd1 = path.join(tempDir, 'f_cd1.png');
            await this._renderCountdownFrame(frames.cd3, a.image, 3);
            await this._renderCountdownFrame(frames.cd2, a.image, 2);
            await this._renderCountdownFrame(frames.cd1, a.image, 1);

            // 结尾品牌卡
            frames.brand = path.join(tempDir, 'f_brand.png');
            await this._renderBrandFrame(frames.brand);

            await this._updateJob(jobId, { progress: 30 });

            // 4. 生成视频段（时长由音频驱动）
            const segDir = path.join(tempDir, 'seg');
            fs.mkdirSync(segDir);
            const segments = [];
            let segIdx = 0;

            const dingSfx = fs.existsSync(SFX_DING_PATH) ? SFX_DING_PATH : null;

            const addSeg = async (framePath, audioPath, dur, progress, opts = {}) => {
                const out = path.join(segDir, `s${segIdx++}.mp4`);
                await this._imgToVideo(framePath, audioPath, dur, out, opts);
                segments.push(out);
                await this._updateJob(jobId, { progress });
            };

            // Seg: 开场 — 清晰图片 + 提问语音（让用户看清楚，思考答案）
            const introDur = introAudio ? durIntro + GAP : 2.5;
            await addSeg(frames.intro, introAudio, introDur, 35);

            // Seg: 单词+翻译 + 女声发音 + 叮咚揭晓音效
            if (a.audioFemale) {
                await addSeg(frames.wordTrans, a.audioFemale, durFemale + GAP, 45, { sfx: dingSfx });
            }

            // Seg: 单词+翻译 + 男声发音
            if (a.audioMale) {
                await addSeg(frames.wordTrans, a.audioMale, durMale + GAP, 55);
            }

            // Seg: 例句 + 女声
            if (word.example_sentence && a.exampleAudioFemale) {
                await addSeg(frames.example, a.exampleAudioFemale, durExFemale + GAP, 65);
            }

            // Seg: 例句 + 男声
            if (word.example_sentence && a.exampleAudioMale) {
                await addSeg(frames.example, a.exampleAudioMale, durExMale + GAP, 75);
            } else if (word.example_sentence && !a.exampleAudioFemale && !a.exampleAudioMale) {
                // 没有例句音频，静音展示 3 秒
                await addSeg(frames.example, null, 3, 75);
            }

            // Seg: Your turn 倒计时 3-2-1（单段 3s，图片不动，只数字变）
            const cdOut = path.join(segDir, `s${segIdx++}.mp4`);
            await this._countdownVideo(frames.cd3, frames.cd2, frames.cd1, cdOut);
            segments.push(cdOut);
            await this._updateJob(jobId, { progress: 86 });

            // Seg: 结尾品牌卡 (2s)
            await addSeg(frames.brand, null, 2, 90);

            // 5. 生成封面图（先生成，再作为视频首帧插入）
            const baseName = `daily_word_${word.word.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
            const outputName = `${baseName}.mp4`;
            const coverName = `${baseName}.jpg`;
            const outputPath = path.join(OUTPUT_DIR, outputName);
            const coverPath = path.join(OUTPUT_DIR, coverName);
            await this._renderCoverImage(coverPath, a.image, word);

            // Seg 0: 封面首帧（0.8s，无缩放、无淡入，分享缩略图即是封面）
            const coverSeg = path.join(segDir, 's00_cover.mp4');
            await this._imgToVideo(coverPath, null, 0.8, coverSeg, { noZoom: true, noFadeIn: true });
            segments.unshift(coverSeg);

            // 6. Concat
            await this._concatVideos(segments, outputPath, tempDir);
            await this._updateJob(jobId, { progress: 96 });

            const videoUrl = `/uploads/marketing/videos/${outputName}`;
            const coverUrl = `/uploads/marketing/videos/${coverName}`;
            await this._updateJob(jobId, { status: 'done', progress: 100, video_url: videoUrl, cover_url: coverUrl });
            console.log(`[Video] 完成: ${outputName} + 封面 ${coverName}`);
            return videoUrl;

        } catch (err) {
            console.error(`[Video] 失败 (job ${jobId}):`, err);
            await this._updateJob(jobId, { status: 'failed', error_message: err.message });
            throw err;
        } finally {
            this._cleanup(tempDir);
        }
    }

    async processNextJob() {
        if (isProcessing) return;
        const [job] = await query(
            'SELECT * FROM marketing_video_jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1',
            ['pending']
        );
        if (!job) return;
        isProcessing = true;
        try { await this.generateDailyWord(job.word_id, job.id); } catch (e) { /* logged */ }
        finally { isProcessing = false; setImmediate(() => this.processNextJob()); }
    }

    // ==================== 帧渲染 ====================

    /** 渐变背景 SVG */
    _bgSvg(topColor = '#1a1a2e', bottomColor = '#16213e') {
        return `<defs><linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="${topColor}"/>
            <stop offset="100%" stop-color="${bottomColor}"/>
        </linearGradient></defs>
        <rect width="${W}" height="${H}" fill="url(#bg)"/>`;
    }

    /** 把图片合成到背景上（居中偏上） */
    async _composeBgWithImage(imagePath, maxSize = 700, topOffset = -200) {
        const bgSvg = `<svg width="${W}" height="${H}">${this._bgSvg()}</svg>`;
        let base = await sharp(Buffer.from(bgSvg)).png().toBuffer();

        if (imagePath && fs.existsSync(imagePath)) {
            const img = await sharp(imagePath)
                .resize(maxSize, maxSize, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png().toBuffer();
            const meta = await sharp(img).metadata();
            base = await sharp(base)
                .composite([{
                    input: img,
                    left: Math.round((W - meta.width) / 2),
                    top: Math.round(H / 2 - meta.height / 2 + topOffset)
                }])
                .png().toBuffer();
        }
        return base;
    }

    /** 生成带文字层的帧 */
    async _composeTextOnBase(base, textSvgContent) {
        const textSvg = `<svg width="${W}" height="${H}">${textSvgContent}</svg>`;
        const textLayer = await sharp(Buffer.from(textSvg)).png().toBuffer();
        return sharp(base).composite([{ input: textLayer, left: 0, top: 0 }]).png().toBuffer();
    }

    /** 开场帧：物体图片 + 提问文字 + 中文翻译 */
    async _renderIntroFrame(outputPath, imagePath, word) {
        const e = this._svgEsc;
        const base = await this._composeBgWithImage(imagePath);
        const text = `
            <text x="${W / 2}" y="1380" text-anchor="middle" font-size="46" fill="#FFD700" font-family="sans-serif">Do you know how to say</text>
            <text x="${W / 2}" y="1450" text-anchor="middle" font-size="46" fill="#FFD700" font-family="sans-serif">this in English?</text>
            <text x="${W / 2}" y="1540" text-anchor="middle" font-size="40" fill="#BBBBBB" font-family="sans-serif">${e('你知道这个用英语怎么说吗？')}</text>
        `;
        const result = await this._composeTextOnBase(base, text);
        await sharp(result).toFile(outputPath);
    }

    /** 单词帧：物体图片 + 单词 + 音标 (+ 可选翻译) */
    async _renderWordFrame(outputPath, imagePath, word, showTranslation = false) {
        const e = this._svgEsc;
        const base = await this._composeBgWithImage(imagePath);
        const parts = [];
        parts.push(`<text x="${W / 2}" y="1380" text-anchor="middle" font-size="88" font-weight="bold" fill="white" font-family="sans-serif">${e(word.word)}</text>`);
        if (word.phonetic) {
            parts.push(`<text x="${W / 2}" y="1460" text-anchor="middle" font-size="42" fill="#BBBBBB" font-family="sans-serif">${e(word.phonetic)}</text>`);
        }
        if (showTranslation && word.translation) {
            parts.push(`<text x="${W / 2}" y="1550" text-anchor="middle" font-size="58" fill="#FFD700" font-family="sans-serif">${e(word.translation)}</text>`);
        }
        const result = await this._composeTextOnBase(base, parts.join(''));
        await sharp(result).toFile(outputPath);
    }

    /** 例句帧：例句图片 + 例句文本 */
    async _renderExampleFrame(outputPath, imagePath, word) {
        const e = this._svgEsc;
        const base = await this._composeBgWithImage(imagePath);

        const sentence = word.example_sentence || '';
        const translation = word.example_translation || '';
        const sentenceLines = this._wrapLines(sentence, 28);
        const transLines = this._wrapLines(translation, 16);

        let svgParts = '';
        let y = 1360;
        sentenceLines.forEach(line => {
            svgParts += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="46" fill="white" font-family="sans-serif">${e(line)}</text>`;
            y += 64;
        });
        y += 10;
        transLines.forEach(line => {
            svgParts += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="38" fill="#BBBBBB" font-family="sans-serif">${e(line)}</text>`;
            y += 54;
        });

        const result = await this._composeTextOnBase(base, svgParts);
        await sharp(result).toFile(outputPath);
    }

    /** 倒计时帧：Your turn! + 大数字 + 圆形进度 */
    async _renderCountdownFrame(outputPath, imagePath, number) {
        const base = await this._composeBgWithImage(imagePath);
        // 圆形进度：3→完整圆，2→2/3，1→1/3
        const cx = W / 2, cy = 1620, r = 110;
        const circumference = 2 * Math.PI * r;
        const progress = number / 3;
        const dashArray = `${circumference * progress} ${circumference}`;

        const text = `
            <text x="${W / 2}" y="1220" text-anchor="middle" font-size="90" font-weight="bold" fill="#FFD700" font-family="sans-serif">Your turn!</text>
            <text x="${W / 2}" y="1300" text-anchor="middle" font-size="38" fill="#BBBBBB" font-family="sans-serif">Try to say it yourself</text>
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#333" stroke-width="10"/>
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#FFD700" stroke-width="10"
                stroke-dasharray="${dashArray}" stroke-linecap="round"
                transform="rotate(-90 ${cx} ${cy})"/>
            <text x="${cx}" y="${cy + 48}" text-anchor="middle" font-size="140" font-weight="bold" fill="#FFD700" font-family="sans-serif">${number}</text>
        `;
        const result = await this._composeTextOnBase(base, text);
        await sharp(result).toFile(outputPath);
    }

    /** 封面图：吸引点击，单词 + 图片 + 品牌 */
    async _renderCoverImage(outputPath, imagePath, word) {
        const e = this._svgEsc;

        // 鲜艳的紫蓝渐变背景（与正片区分，更吸引眼球）
        const bgSvg = `<svg width="${W}" height="${H}">
            <defs>
                <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stop-color="#667EEA"/>
                    <stop offset="100%" stop-color="#764BA2"/>
                </linearGradient>
                <radialGradient id="spot" cx="50%" cy="40%" r="60%">
                    <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.3"/>
                    <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/>
                </radialGradient>
            </defs>
            <rect width="${W}" height="${H}" fill="url(#bg)"/>
            <rect width="${W}" height="${H}" fill="url(#spot)"/>
        </svg>`;
        let base = await sharp(Buffer.from(bgSvg)).png().toBuffer();

        // 顶部品牌条 + logo
        if (fs.existsSync(LOGO_PATH)) {
            const logoSize = 100;
            const logo = await sharp(LOGO_PATH)
                .resize(logoSize, logoSize, { fit: 'inside' })
                .png().toBuffer();
            base = await sharp(base).composite([{
                input: logo, left: 60, top: 60
            }]).png().toBuffer();
        }

        // 主图片：圆形裁剪 + 圆形高光背景（图圆一致）
        if (imagePath && fs.existsSync(imagePath)) {
            const imgSize = 720;
            // 先 cover 裁成正方形，再用圆形 mask 裁成圆形
            const squareImg = await sharp(imagePath)
                .resize(imgSize, imgSize, { fit: 'cover' })
                .png().toBuffer();
            const circleMask = Buffer.from(
                `<svg width="${imgSize}" height="${imgSize}"><circle cx="${imgSize / 2}" cy="${imgSize / 2}" r="${imgSize / 2}" fill="white"/></svg>`
            );
            const circleImg = await sharp(squareImg)
                .composite([{ input: circleMask, blend: 'dest-in' }])
                .png().toBuffer();

            // 白色圆形高光光晕（略大于图片直径）
            const glowSvg = `<svg width="${W}" height="${H}">
                <circle cx="${W / 2}" cy="740" r="420" fill="white" opacity="0.15"/>
                <circle cx="${W / 2}" cy="740" r="380" fill="white" opacity="0.22"/>
            </svg>`;
            const glow = await sharp(Buffer.from(glowSvg)).png().toBuffer();
            base = await sharp(base).composite([
                { input: glow, left: 0, top: 0 },
                { input: circleImg, left: Math.round((W - imgSize) / 2), top: Math.round(740 - imgSize / 2) }
            ]).png().toBuffer();
        }

        // 顶部品牌文字（logo 右边，与 logo 垂直居中对齐）
        // logo: top=60, size=100, 中心 y=110
        // 两行文字：line1 baseline=112（字号40，top≈72），line2 baseline=152（字号28，bottom≈158）
        // 文字块中心 ≈ 115，与 logo 中心对齐
        const brandText = `
            <text x="180" y="112" font-size="40" font-weight="bold" fill="white" font-family="sans-serif">她简看图学英语</text>
            <text x="180" y="152" font-size="26" fill="white" opacity="0.85" font-family="sans-serif">每日一词 · Daily Word</text>
        `;

        // 底部文字：大单词 + 翻译 + 音标
        let bottomParts = '';
        bottomParts += `<text x="${W / 2}" y="1380" text-anchor="middle" font-size="180" font-weight="bold" fill="white" stroke="#764BA2" stroke-width="6" font-family="sans-serif">${e(word.word)}</text>`;
        if (word.phonetic) {
            bottomParts += `<text x="${W / 2}" y="1450" text-anchor="middle" font-size="44" fill="white" opacity="0.85" font-family="sans-serif">${e(word.phonetic)}</text>`;
        }
        if (word.translation) {
            bottomParts += `<text x="${W / 2}" y="1540" text-anchor="middle" font-size="68" fill="#FFD700" font-weight="bold" font-family="sans-serif">${e(word.translation)}</text>`;
        }
        // 底部点击提示
        bottomParts += `<rect x="340" y="1640" width="400" height="90" rx="45" fill="#FFD700"/>`;
        bottomParts += `<text x="${W / 2}" y="1702" text-anchor="middle" font-size="40" fill="#764BA2" font-weight="bold" font-family="sans-serif">▶ 点击学发音</text>`;

        const result = await this._composeTextOnBase(base, brandText + bottomParts);
        await sharp(result).jpeg({ quality: 88 }).toFile(outputPath);
    }

    /** 结尾品牌卡帧：logo + 标语 + Follow */
    async _renderBrandFrame(outputPath) {
        // 浅色温暖背景，让多彩 logo 更突出
        const bgSvg = `<svg width="${W}" height="${H}">
            <defs><linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#FFF4E6"/>
                <stop offset="100%" stop-color="#FFD8A8"/>
            </linearGradient></defs>
            <rect width="${W}" height="${H}" fill="url(#bg)"/>
        </svg>`;
        let base = await sharp(Buffer.from(bgSvg)).png().toBuffer();

        // 叠加 logo（居中偏上）
        if (fs.existsSync(LOGO_PATH)) {
            const logoSize = 820;
            const logo = await sharp(LOGO_PATH)
                .resize(logoSize, logoSize, { fit: 'inside' })
                .png()
                .toBuffer();
            const meta = await sharp(logo).metadata();
            base = await sharp(base).composite([{
                input: logo,
                left: Math.round((W - meta.width) / 2),
                top: 420
            }]).png().toBuffer();
        }

        const text = `
            <text x="${W / 2}" y="1420" text-anchor="middle" font-size="46" fill="#8B4513" opacity="0.85" font-family="sans-serif">Daily English for Kids</text>
            <rect x="240" y="1500" width="600" height="110" rx="55" fill="#FF6B6B"/>
            <text x="${W / 2}" y="1572" text-anchor="middle" font-size="48" fill="white" font-weight="bold" font-family="sans-serif">Follow for more!</text>
        `;
        const result = await this._composeTextOnBase(base, text);
        await sharp(result).toFile(outputPath);
    }

    // ==================== FFmpeg ====================

    /** 构建 zoompan 滤镜（Ken Burns 慢缩放） */
    _buildZoompan(duration, zoomSpeed = 0.0005, maxZoom = 1.15) {
        const frames = Math.ceil(duration * 30);
        return `zoompan=z='min(zoom+${zoomSpeed},${maxZoom})':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=30`;
    }

    /** 静态图片 + 可选音频 → mp4，Ken Burns 缩放 + 淡入淡出，统一 44100Hz stereo */
    async _imgToVideo(imagePath, audioPath, duration, outputPath, { sfx = null, noZoom = false, noFadeIn = false } = {}) {
        const hasAudio = audioPath && fs.existsSync(audioPath);
        const hasSfx = sfx && fs.existsSync(sfx);
        const fadeOut = Math.max(0, duration - FADE);

        const baseFilter = noZoom
            ? `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`
            : this._buildZoompan(duration);
        const fadeIn = noFadeIn ? '' : `fade=t=in:st=0:d=${FADE},`;
        const vf = `${baseFilter},${fadeIn}fade=t=out:st=${fadeOut}:d=${FADE}`;

        if (hasAudio) {
            let audioFilter;
            const inputs = ['-i', imagePath, '-i', audioPath];
            if (hasSfx) {
                inputs.push('-i', sfx);
                audioFilter = `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${duration}[main];` +
                    `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.7[ding];` +
                    `[main][ding]amix=inputs=2:duration=first,afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOut}:d=${FADE}[a]`;
            } else {
                audioFilter = `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${duration},` +
                    `afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOut}:d=${FADE}[a]`;
            }
            await this._runFFmpeg([
                ...inputs,
                '-filter_complex', `${audioFilter};[0:v]${vf}[v]`,
                '-map', '[v]', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration),
                '-y', outputPath
            ]);
        } else if (hasSfx) {
            await this._runFFmpeg([
                '-i', imagePath,
                '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                '-i', sfx,
                '-filter_complex',
                `[2:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.7[ding];` +
                `[1:a][ding]amix=inputs=2:duration=first,afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOut}:d=${FADE}[a];` +
                `[0:v]${vf}[v]`,
                '-map', '[v]', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration),
                '-y', outputPath
            ]);
        } else {
            await this._runFFmpeg([
                '-i', imagePath,
                '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                '-filter_complex',
                `[1:a]afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOut}:d=${FADE}[a];[0:v]${vf}[v]`,
                '-map', '[v]', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration),
                '-y', outputPath
            ]);
        }
    }

    /** 倒计时视频：3 张图按顺序拼接成 3s，只有数字变，图片不动（无段内 fade） */
    async _countdownVideo(cd3, cd2, cd1, outputPath) {
        const dur = 3;
        const fadeOut = Math.max(0, dur - FADE);
        await this._runFFmpeg([
            '-loop', '1', '-t', '1', '-i', cd3,
            '-loop', '1', '-t', '1', '-i', cd2,
            '-loop', '1', '-t', '1', '-i', cd1,
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
            '-filter_complex',
            `[0:v][1:v][2:v]concat=n=3:v=1[cat];` +
            `[cat]fade=t=in:st=0:d=${FADE},fade=t=out:st=${fadeOut}:d=${FADE}[v];` +
            `[3:a]afade=t=in:st=0:d=${FADE},afade=t=out:st=${fadeOut}:d=${FADE}[a]`,
            '-map', '[v]', '-map', '[a]',
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
            '-t', String(dur),
            '-y', outputPath
        ]);
    }

    /** 合并视频段，然后混入背景音乐 */
    async _concatVideos(segPaths, outputPath, tempDir) {
        const listFile = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));

        const hasBGM = fs.existsSync(BGM_PATH);
        if (hasBGM) {
            // 先 concat，再混入 BGM
            const rawConcat = path.join(tempDir, 'raw_concat.mp4');
            await this._runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', rawConcat]);

            // 混合：原声 + BGM（低音量循环），BGM 淡入淡出
            await this._runFFmpeg([
                '-i', rawConcat,
                '-stream_loop', '-1', '-i', BGM_PATH,
                '-filter_complex',
                `[1:a]volume=${BGM_VOL},afade=t=in:st=0:d=1,afade=t=out:st=999:d=1[bgm];` +
                `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[a]`,
                '-map', '0:v', '-map', '[a]',
                '-c:v', 'copy',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-y', outputPath
            ]);
        } else {
            await this._runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outputPath]);
        }
    }

    /** 获取音频文件时长（秒） */
    async _getAudioDuration(filePath) {
        try {
            const out = execFileSync('ffprobe', [
                '-v', 'error', '-show_entries', 'format=duration',
                '-of', 'csv=p=0', filePath
            ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            return parseFloat(out.trim()) || 2;
        } catch (e) {
            return 2; // 默认 2 秒
        }
    }

    /** 执行 FFmpeg */
    _runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';
            proc.stderr.on('data', c => { stderr += c.toString(); });
            proc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg 退出码 ${code}: ${stderr.split('\n').slice(-10).join('\n')}`));
            });
            proc.on('error', err => reject(new Error(`FFmpeg 启动失败: ${err.message}`)));
        });
    }

    // ==================== 素材解析 ====================

    async _resolveWordAssets(word, tempDir) {
        const r = async (url, name) => {
            if (!url) return null;
            try { return await this._resolveUrl(url, tempDir, name); }
            catch (e) { console.warn(`[Video] 素材 (${name}): ${e.message}`); return null; }
        };
        return {
            image: await r(word.image_url, 'image'),
            exampleImage: await r(word.example_image_url, 'example_image'),
            audioFemale: await r(word.audio_url_female || word.audio_url, 'audio_female'),
            audioMale: await r(word.audio_url_male, 'audio_male'),
            exampleAudioFemale: await r(word.example_audio_female, 'ex_audio_f'),
            exampleAudioMale: await r(word.example_audio_male, 'ex_audio_m'),
        };
    }

    async _resolveUrl(url, tempDir, name) {
        if (!url) return null;
        if (url.startsWith('/uploads/')) {
            const p = path.join(SERVER_ROOT, url);
            if (fs.existsSync(p)) return p;
            throw new Error(`文件不存在: ${p}`);
        }
        if (url.startsWith('http')) {
            const ext = path.extname(new URL(url).pathname) || '.tmp';
            const local = path.join(tempDir, `${name}${ext}`);
            const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
            fs.writeFileSync(local, resp.data);
            return local;
        }
        throw new Error(`无法解析: ${url}`);
    }

    // ==================== 开场语音 ====================

    /** 获取开场提问语音（缓存复用） */
    async _getIntroAudio() {
        if (fs.existsSync(INTRO_AUDIO_PATH)) {
            return INTRO_AUDIO_PATH;
        }
        try {
            const result = await voiceService.googleTextToSpeech(
                'Do you know how to say this in English?', 'female', 1.0
            );
            if (result.success && result.audioUrl) {
                const srcPath = path.join(SERVER_ROOT, result.audioUrl);
                if (fs.existsSync(srcPath)) {
                    fs.copyFileSync(srcPath, INTRO_AUDIO_PATH);
                    console.log(`[Video] 开场语音已缓存: ${INTRO_AUDIO_PATH}`);
                    return INTRO_AUDIO_PATH;
                }
            }
            console.warn('[Video] 开场语音生成失败:', result.error || '未返回音频');
            return null;
        } catch (e) {
            console.warn('[Video] 开场语音生成异常:', e.message);
            return null;
        }
    }

    // ==================== 工具 ====================

    _svgEsc(text) {
        if (!text) return '';
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    _wrapLines(text, max) {
        if (!text) return [];
        if (text.length <= max) return [text];
        const words = text.split(' ');
        if (words.length > 1) {
            const lines = []; let cur = '';
            for (const w of words) {
                if (cur.length + w.length + 1 > max && cur) { lines.push(cur); cur = w; }
                else { cur = cur ? cur + ' ' + w : w; }
            }
            if (cur) lines.push(cur);
            return lines;
        }
        const lines = [];
        for (let i = 0; i < text.length; i += max) lines.push(text.substring(i, i + max));
        return lines;
    }

    async _updateJob(jobId, fields) {
        const sets = [], vals = [];
        for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
        if (!sets.length) return;
        vals.push(jobId);
        await query(`UPDATE marketing_video_jobs SET ${sets.join(', ')} WHERE id = ?`, vals);
    }

    _cleanup(dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { }
    }
}

module.exports = new VideoService();
