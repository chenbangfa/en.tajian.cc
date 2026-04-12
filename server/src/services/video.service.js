const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const sharp = require('sharp');
const { query } = require('../config/database');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/marketing/videos');

// 视频尺寸
const W = 1080;
const H = 1920;

// 自动检测可用的 H.264 编码器
let H264_ENCODER = 'libx264';
const { execFileSync } = require('child_process');
try {
    const encoders = execFileSync('ffmpeg', ['-encoders'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (encoders.includes('libx264')) H264_ENCODER = 'libx264';
    else if (encoders.includes('libopenh264')) H264_ENCODER = 'libopenh264';
    console.log(`[Video] H.264 编码器: ${H264_ENCODER}`);
} catch (e) {
    console.warn('[Video] FFmpeg 编码器检测失败');
}

let isProcessing = false;

class VideoService {

    constructor() {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // ==================== 公共方法 ====================

    async generateDailyWord(wordId, jobId) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));

        try {
            await this._updateJob(jobId, { status: 'processing', progress: 0 });

            const [word] = await query('SELECT * FROM words WHERE id = ?', [wordId]);
            if (!word) throw new Error(`单词 ID ${wordId} 不存在`);

            // 解析素材
            const assets = await this._resolveWordAssets(word, tempDir);
            await this._updateJob(jobId, { progress: 10 });

            // 用 sharp 生成每一帧的静态图片（所有文字都在图片上）
            const frames = {};

            frames.title = path.join(tempDir, 'frame_title.png');
            await this._renderTitleFrame(frames.title, word.word);
            await this._updateJob(jobId, { progress: 20 });

            frames.wordFemale = path.join(tempDir, 'frame_word_female.png');
            await this._renderWordFrame(frames.wordFemale, assets.image, word, false);
            await this._updateJob(jobId, { progress: 30 });

            frames.wordMale = path.join(tempDir, 'frame_word_male.png');
            await this._renderWordFrame(frames.wordMale, assets.image, word, true);
            await this._updateJob(jobId, { progress: 40 });

            frames.example = path.join(tempDir, 'frame_example.png');
            await this._renderExampleFrame(frames.example, word);
            await this._updateJob(jobId, { progress: 45 });

            frames.followMe = path.join(tempDir, 'frame_follow.png');
            await this._renderFollowMeFrame(frames.followMe);
            await this._updateJob(jobId, { progress: 50 });

            frames.endCard = path.join(tempDir, 'frame_end.png');
            await this._renderEndCardFrame(frames.endCard);
            await this._updateJob(jobId, { progress: 55 });

            // 生成视频段（FFmpeg 只做 图片+音频→mp4，无需任何滤镜）
            const segDir = path.join(tempDir, 'seg');
            fs.mkdirSync(segDir);
            const segments = [];

            // Seg1: 标题 3s 静音
            const seg1 = path.join(segDir, 's1.mp4');
            await this._imgToVideo(frames.title, null, 3, seg1);
            segments.push(seg1);
            await this._updateJob(jobId, { progress: 60 });

            // Seg2: 单词+女声×2  5s
            const seg2 = path.join(segDir, 's2.mp4');
            let femaleAudio = assets.audioFemale;
            if (femaleAudio) {
                const doubled = path.join(tempDir, 'female_x2.wav');
                await this._concatAudio([femaleAudio, femaleAudio], doubled);
                femaleAudio = doubled;
            }
            await this._imgToVideo(frames.wordFemale, femaleAudio, 5, seg2);
            segments.push(seg2);
            await this._updateJob(jobId, { progress: 70 });

            // Seg3: 单词+翻译+男声 5s
            const seg3 = path.join(segDir, 's3.mp4');
            await this._imgToVideo(frames.wordMale, assets.audioMale, 5, seg3);
            segments.push(seg3);
            await this._updateJob(jobId, { progress: 75 });

            // Seg4: 例句 7s（如果有例句）
            if (word.example_sentence) {
                const seg4 = path.join(segDir, 's4.mp4');
                await this._imgToVideo(frames.example, assets.exampleAudio, 7, seg4);
                segments.push(seg4);
            }
            await this._updateJob(jobId, { progress: 80 });

            // Seg5: Follow me 5s
            const seg5 = path.join(segDir, 's5.mp4');
            await this._imgToVideo(frames.followMe, null, 5, seg5);
            segments.push(seg5);
            await this._updateJob(jobId, { progress: 85 });

            // Seg6: 结尾 3s
            const seg6 = path.join(segDir, 's6.mp4');
            await this._imgToVideo(frames.endCard, null, 3, seg6);
            segments.push(seg6);
            await this._updateJob(jobId, { progress: 90 });

            // Concat
            const outputName = `daily_word_${word.word.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.mp4`;
            const outputPath = path.join(OUTPUT_DIR, outputName);
            await this._concatVideos(segments, outputPath, tempDir);
            await this._updateJob(jobId, { progress: 95 });

            const videoUrl = `/uploads/marketing/videos/${outputName}`;
            await this._updateJob(jobId, { status: 'done', progress: 100, video_url: videoUrl });
            console.log(`[Video] 完成: ${outputName}`);
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
        try {
            await this.generateDailyWord(job.word_id, job.id);
        } catch (e) { /* logged */ }
        finally {
            isProcessing = false;
            setImmediate(() => this.processNextJob());
        }
    }

    // ==================== 帧渲染（sharp SVG，所有文字在这里） ====================

    /** 标题帧：大字单词 + "Can you say this?" */
    async _renderTitleFrame(outputPath, wordText) {
        const esc = this._svgEsc;
        const svg = `<svg width="${W}" height="${H}">
            <defs><linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#1a1a2e"/>
                <stop offset="100%" stop-color="#16213e"/>
            </linearGradient></defs>
            <rect width="${W}" height="${H}" fill="url(#bg)"/>
            <text x="${W / 2}" y="${H / 2 - 40}" text-anchor="middle" font-size="120" font-weight="bold" fill="white" font-family="sans-serif">${esc(wordText)}</text>
            <text x="${W / 2}" y="${H / 2 + 80}" text-anchor="middle" font-size="48" fill="#FFD700" font-family="sans-serif">Can you say this?</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outputPath);
    }

    /** 单词帧：背景+图片+单词+音标（+可选翻译） */
    async _renderWordFrame(outputPath, imagePath, word, showTranslation) {
        const esc = this._svgEsc;
        // 先生成渐变背景
        const bgSvg = `<svg width="${W}" height="${H}">
            <defs><linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#1a1a2e"/>
                <stop offset="100%" stop-color="#16213e"/>
            </linearGradient></defs>
            <rect width="${W}" height="${H}" fill="url(#bg)"/>
        </svg>`;
        let base = await sharp(Buffer.from(bgSvg)).png().toBuffer();

        // 合成单词图片
        if (imagePath && fs.existsSync(imagePath)) {
            const img = await sharp(imagePath)
                .resize(700, 700, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png().toBuffer();
            const meta = await sharp(img).metadata();
            base = await sharp(base)
                .composite([{ input: img, left: Math.round((W - meta.width) / 2), top: Math.round(H / 2 - meta.height / 2 - 250) }])
                .png().toBuffer();
        }

        // 文字层
        const textParts = [];
        textParts.push(`<text x="${W / 2}" y="1380" text-anchor="middle" font-size="90" font-weight="bold" fill="white" font-family="sans-serif">${esc(word.word)}</text>`);
        if (word.phonetic) {
            textParts.push(`<text x="${W / 2}" y="1470" text-anchor="middle" font-size="42" fill="#BBBBBB" font-family="sans-serif">${esc(word.phonetic)}</text>`);
        }
        if (showTranslation && word.translation) {
            textParts.push(`<text x="${W / 2}" y="1560" text-anchor="middle" font-size="60" fill="#FFD700" font-family="sans-serif">${esc(word.translation)}</text>`);
        }

        const textSvg = `<svg width="${W}" height="${H}">${textParts.join('')}</svg>`;
        const textLayer = await sharp(Buffer.from(textSvg)).png().toBuffer();

        await sharp(base)
            .composite([{ input: textLayer, left: 0, top: 0 }])
            .png().toFile(outputPath);
    }

    /** 例句帧 */
    async _renderExampleFrame(outputPath, word) {
        const esc = this._svgEsc;
        const sentence = word.example_sentence || '';
        const translation = word.example_translation || '';

        // 自动换行
        const sentenceLines = this._wrapLines(sentence, 30);
        const transLines = this._wrapLines(translation, 18);

        let sentenceSvg = '';
        sentenceLines.forEach((line, i) => {
            sentenceSvg += `<text x="${W / 2}" y="${820 + i * 70}" text-anchor="middle" font-size="50" fill="white" font-family="sans-serif">${esc(line)}</text>`;
        });

        let transSvg = '';
        const transStartY = 820 + sentenceLines.length * 70 + 40;
        transLines.forEach((line, i) => {
            transSvg += `<text x="${W / 2}" y="${transStartY + i * 60}" text-anchor="middle" font-size="40" fill="#BBBBBB" font-family="sans-serif">${esc(line)}</text>`;
        });

        const svg = `<svg width="${W}" height="${H}">
            <defs><linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#1a1a2e"/>
                <stop offset="100%" stop-color="#16213e"/>
            </linearGradient></defs>
            <rect width="${W}" height="${H}" fill="url(#bg)"/>
            <text x="${W / 2}" y="720" text-anchor="middle" font-size="44" fill="#FFD700" font-family="sans-serif">Example</text>
            ${sentenceSvg}
            ${transSvg}
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outputPath);
    }

    /** Follow Me 帧 */
    async _renderFollowMeFrame(outputPath) {
        const svg = `<svg width="${W}" height="${H}">
            <defs><linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#1a1a2e"/>
                <stop offset="100%" stop-color="#16213e"/>
            </linearGradient></defs>
            <rect width="${W}" height="${H}" fill="url(#bg)"/>
            <text x="${W / 2}" y="${H / 2 - 60}" text-anchor="middle" font-size="80" font-weight="bold" fill="#FFD700" font-family="sans-serif">Your turn!</text>
            <text x="${W / 2}" y="${H / 2 + 40}" text-anchor="middle" font-size="40" fill="#BBBBBB" font-family="sans-serif">Follow me and say it</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outputPath);
    }

    /** 结尾品牌帧 */
    async _renderEndCardFrame(outputPath) {
        const svg = `<svg width="${W}" height="${H}">
            <defs><linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#0f3460"/>
                <stop offset="100%" stop-color="#16213e"/>
            </linearGradient></defs>
            <rect width="${W}" height="${H}" fill="url(#bg)"/>
            <text x="${W / 2}" y="${H / 2 - 40}" text-anchor="middle" font-size="56" fill="white" font-family="sans-serif">Learn English with Fun!</text>
            <text x="${W / 2}" y="${H / 2 + 40}" text-anchor="middle" font-size="40" fill="#FFD700" font-family="sans-serif">Follow for more</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outputPath);
    }

    // ==================== FFmpeg（极简，不用任何滤镜） ====================

    /** 静态图片 + 可选音频 → mp4 视频段
     *  所有段统一输出: 44100Hz stereo AAC，确保 concat 兼容 */
    async _imgToVideo(imagePath, audioPath, duration, outputPath) {
        const hasRealAudio = audioPath && fs.existsSync(audioPath);

        if (hasRealAudio) {
            // 有真实音频：重采样到 44100Hz stereo + apad 填充静音到指定时长
            const args = [
                '-loop', '1', '-i', imagePath,
                '-i', audioPath,
                '-filter_complex',
                `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${duration}[a]`,
                '-map', '0:v', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration),
                '-y', outputPath
            ];
            await this._runFFmpeg(args);
        } else {
            // 无音频：44100Hz stereo 静音
            const args = [
                '-loop', '1', '-i', imagePath,
                '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration),
                '-y', outputPath
            ];
            await this._runFFmpeg(args);
        }
    }

    /** 拼接多段音频，统一输出 44100Hz stereo */
    async _concatAudio(audioPaths, outputPath) {
        const inputs = [];
        audioPaths.forEach(p => { inputs.push('-i', p); });

        // 先把每段重采样到统一格式，再 concat
        const resampled = audioPaths.map((_, i) => `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[r${i}]`).join(';');
        const concatInputs = audioPaths.map((_, i) => `[r${i}]`).join('');
        await this._runFFmpeg([
            ...inputs,
            '-filter_complex', `${resampled};${concatInputs}concat=n=${audioPaths.length}:v=0:a=1[a]`,
            '-map', '[a]', '-ar', '44100', '-ac', '2', '-y', outputPath
        ]);
    }

    /** 合并视频段 */
    async _concatVideos(segPaths, outputPath, tempDir) {
        const listFile = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));
        await this._runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outputPath]);
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
        const resolve = async (url, name) => {
            if (!url) return null;
            try { return await this._resolveUrl(url, tempDir, name); }
            catch (e) { console.warn(`[Video] 素材解析失败 (${name}): ${e.message}`); return null; }
        };
        return {
            image: await resolve(word.image_url, 'image'),
            audioFemale: await resolve(word.audio_url_female || word.audio_url, 'audio_female'),
            audioMale: await resolve(word.audio_url_male, 'audio_male'),
            exampleAudio: await resolve(word.example_audio_female || word.example_audio_male, 'example_audio')
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

    // ==================== 工具 ====================

    /** SVG 文字转义 */
    _svgEsc(text) {
        if (!text) return '';
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    /** 文本按字数换行 */
    _wrapLines(text, max) {
        if (!text) return [];
        if (text.length <= max) return [text];
        // 英文按空格分词
        const words = text.split(' ');
        if (words.length > 1) {
            const lines = [];
            let cur = '';
            for (const w of words) {
                if (cur.length + w.length + 1 > max && cur) { lines.push(cur); cur = w; }
                else { cur = cur ? cur + ' ' + w : w; }
            }
            if (cur) lines.push(cur);
            return lines;
        }
        // 中文按字符切
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
