const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const sharp = require('sharp');
const { query } = require('../config/database');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/marketing/videos');

const W = 1080;
const H = 1920;
const GAP = 1.5; // 段间静音间隔（秒）

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

            // 2. 获取各音频时长
            const durFemale = a.audioFemale ? await this._getAudioDuration(a.audioFemale) : 0;
            const durMale = a.audioMale ? await this._getAudioDuration(a.audioMale) : 0;
            const durExFemale = a.exampleAudioFemale ? await this._getAudioDuration(a.exampleAudioFemale) : 0;
            const durExMale = a.exampleAudioMale ? await this._getAudioDuration(a.exampleAudioMale) : 0;
            await this._updateJob(jobId, { progress: 15 });

            // 3. 渲染所有帧图片
            const frames = {};

            // 开场帧：物体图片 + 提问
            frames.intro = path.join(tempDir, 'f_intro.png');
            await this._renderIntroFrame(frames.intro, a.image);

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

            // Your turn 帧
            frames.yourTurn = path.join(tempDir, 'f_yourturn.png');
            await this._renderYourTurnFrame(frames.yourTurn, a.image);

            await this._updateJob(jobId, { progress: 30 });

            // 4. 生成视频段（时长由音频驱动）
            const segDir = path.join(tempDir, 'seg');
            fs.mkdirSync(segDir);
            const segments = [];
            let segIdx = 0;

            const addSeg = async (framePath, audioPath, dur, progress) => {
                const out = path.join(segDir, `s${segIdx++}.mp4`);
                await this._imgToVideo(framePath, audioPath, dur, out);
                segments.push(out);
                await this._updateJob(jobId, { progress });
            };

            // Seg: 开场 — 图片 + "Do you know..." (2.5s)
            await addSeg(frames.intro, null, 2.5, 35);

            // Seg: 单词 + 女声发音
            if (a.audioFemale) {
                await addSeg(frames.word, a.audioFemale, durFemale + GAP, 45);
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

            // Seg: Your turn! (2s)
            await addSeg(frames.yourTurn, null, 2, 85);

            // 5. Concat
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

    /** 开场帧：物体图片 + 提问文字 */
    async _renderIntroFrame(outputPath, imagePath) {
        const e = this._svgEsc;
        const base = await this._composeBgWithImage(imagePath);
        const text = `
            <text x="${W / 2}" y="1400" text-anchor="middle" font-size="46" fill="#FFD700" font-family="sans-serif">Do you know how to say</text>
            <text x="${W / 2}" y="1470" text-anchor="middle" font-size="46" fill="#FFD700" font-family="sans-serif">this in English?</text>
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

    /** Your turn 帧 */
    async _renderYourTurnFrame(outputPath, imagePath) {
        const base = await this._composeBgWithImage(imagePath);
        const text = `
            <text x="${W / 2}" y="1400" text-anchor="middle" font-size="76" font-weight="bold" fill="#FFD700" font-family="sans-serif">Your turn!</text>
            <text x="${W / 2}" y="1480" text-anchor="middle" font-size="38" fill="#BBBBBB" font-family="sans-serif">Try to say it yourself</text>
        `;
        const result = await this._composeTextOnBase(base, text);
        await sharp(result).toFile(outputPath);
    }

    // ==================== FFmpeg ====================

    /** 静态图片 + 可选音频 → mp4，统一 44100Hz stereo */
    async _imgToVideo(imagePath, audioPath, duration, outputPath) {
        const hasAudio = audioPath && fs.existsSync(audioPath);

        if (hasAudio) {
            await this._runFFmpeg([
                '-loop', '1', '-i', imagePath,
                '-i', audioPath,
                '-filter_complex',
                `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${duration}[a]`,
                '-map', '0:v', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration),
                '-y', outputPath
            ]);
        } else {
            await this._runFFmpeg([
                '-loop', '1', '-i', imagePath,
                '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
                '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
                '-t', String(duration),
                '-y', outputPath
            ]);
        }
    }

    /** 合并视频段 */
    async _concatVideos(segPaths, outputPath, tempDir) {
        const listFile = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));
        await this._runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outputPath]);
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
