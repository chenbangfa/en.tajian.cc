const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const sharp = require('sharp');
const { query } = require('../config/database');

const SERVER_ROOT = path.join(__dirname, '../..');
const FONT_PATH = path.join(SERVER_ROOT, 'assets/fonts/NotoSansSC-Regular.ttf');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/marketing/videos');

// 自动检测可用的 H.264 编码器（libx264 > libopenh264）
let H264_ENCODER = 'libx264'; // 默认
const { execFileSync } = require('child_process');
try {
    const encoders = execFileSync('ffmpeg', ['-encoders'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (encoders.includes('libx264')) {
        H264_ENCODER = 'libx264';
    } else if (encoders.includes('libopenh264')) {
        H264_ENCODER = 'libopenh264';
    }
    console.log(`[Video] 使用 H.264 编码器: ${H264_ENCODER}`);
} catch (e) {
    console.warn('[Video] FFmpeg 编码器检测失败，将使用默认 libx264');
}

// 并发控制：同时只跑 1 个 FFmpeg
let isProcessing = false;

class VideoService {

    constructor() {
        // 确保输出目录存在
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // ========== 公共方法 ==========

    /**
     * 生成"每日一词"视频
     * @param {number} wordId - 单词 ID
     * @param {number} jobId - 任务 ID
     */
    async generateDailyWord(wordId, jobId) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
        const tempFiles = [];

        try {
            await this._updateJob(jobId, { status: 'processing', progress: 0 });

            // 1. 查询单词数据
            const [word] = await query('SELECT * FROM words WHERE id = ?', [wordId]);
            if (!word) throw new Error(`单词 ID ${wordId} 不存在`);

            // 2. 解析素材到本地
            const assets = await this._resolveWordAssets(word, tempDir, tempFiles);
            await this._updateJob(jobId, { progress: 10 });

            // 3. 生成背景图
            const bgPath = path.join(tempDir, 'bg.png');
            const endCardPath = path.join(tempDir, 'end_card.png');
            await this._generateBackground(bgPath, '#1a1a2e', '#16213e');
            await this._generateEndCard(endCardPath);
            await this._updateJob(jobId, { progress: 15 });

            // 4. 准备单词图片（缩放到合适尺寸，居中放在背景上）
            const wordImageOnBg = path.join(tempDir, 'word_bg.png');
            await this._composeWordImage(bgPath, assets.image, wordImageOnBg);
            await this._updateJob(jobId, { progress: 20 });

            // 5. 分段生成视频
            const segments = [];
            const segmentDir = path.join(tempDir, 'segments');
            fs.mkdirSync(segmentDir);

            // Seg 1: 标题卡 (3s)
            const seg1 = path.join(segmentDir, 'seg1.mp4');
            await this._genSegTitle(bgPath, word.word, seg1);
            segments.push(seg1);
            await this._updateJob(jobId, { progress: 30 });

            // Seg 2: 单词图+发音 (女声×2)
            const seg2 = path.join(segmentDir, 'seg2.mp4');
            await this._genSegWordFemale(wordImageOnBg, word, assets.audioFemale, seg2);
            segments.push(seg2);
            await this._updateJob(jobId, { progress: 45 });

            // Seg 3: 单词图+翻译+男声
            const seg3 = path.join(segmentDir, 'seg3.mp4');
            await this._genSegWordMale(wordImageOnBg, word, assets.audioMale, seg3);
            segments.push(seg3);
            await this._updateJob(jobId, { progress: 55 });

            // Seg 4: 例句 (如果有例句音频)
            if (assets.exampleAudio) {
                const seg4 = path.join(segmentDir, 'seg4.mp4');
                await this._genSegExample(bgPath, word, assets.exampleAudio, seg4);
                segments.push(seg4);
            }
            await this._updateJob(jobId, { progress: 70 });

            // Seg 5: Follow me! (5s)
            const seg5 = path.join(segmentDir, 'seg5.mp4');
            await this._genSegFollowMe(bgPath, seg5);
            segments.push(seg5);
            await this._updateJob(jobId, { progress: 80 });

            // Seg 6: 结尾卡 (3s)
            const seg6 = path.join(segmentDir, 'seg6.mp4');
            await this._genSegEndCard(endCardPath, seg6);
            segments.push(seg6);
            await this._updateJob(jobId, { progress: 85 });

            // 6. Concat 合并所有段
            const outputFilename = `daily_word_${word.word.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.mp4`;
            const outputPath = path.join(OUTPUT_DIR, outputFilename);
            await this._concatSegments(segments, outputPath, tempDir);
            await this._updateJob(jobId, { progress: 95 });

            // 7. 完成
            const videoUrl = `/uploads/marketing/videos/${outputFilename}`;
            await this._updateJob(jobId, {
                status: 'done',
                progress: 100,
                video_url: videoUrl
            });

            console.log(`[Video] 生成完成: ${outputFilename}`);
            return videoUrl;

        } catch (err) {
            console.error(`[Video] 生成失败 (job ${jobId}):`, err);
            await this._updateJob(jobId, {
                status: 'failed',
                error_message: err.message
            });
            throw err;
        } finally {
            // 清理临时目录
            this._cleanup(tempDir);
        }
    }

    /**
     * 处理队列中下一个 pending 任务
     */
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
        } catch (e) {
            // 错误已在 generateDailyWord 中记录
        } finally {
            isProcessing = false;
            // 递归处理下一个
            setImmediate(() => this.processNextJob());
        }
    }

    // ========== 分段生成方法 ==========

    /** Seg 1: 标题卡 — 大字单词 + "Can you say this?" */
    async _genSegTitle(bgPath, wordText, outputPath) {
        const word = this._esc(wordText);
        await this._runFFmpeg([
            '-loop', '1', '-i', bgPath,
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
            '-t', '3',
            '-vf', [
                `drawtext=fontfile='${FONT_PATH}':text='${word}':fontsize=130:fontcolor=white:x=(w-tw)/2:y=(h-th)/2-60`,
                `drawtext=fontfile='${FONT_PATH}':text='Can you say this?':fontsize=48:fontcolor=#FFD700:x=(w-tw)/2:y=(h-th)/2+100`
            ].join(','),
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k',
            '-y', outputPath
        ]);
    }

    /** Seg 2: 单词图 + 发音信息 + 女声×2 */
    async _genSegWordFemale(bgWithImage, word, audioPath, outputPath) {
        if (!audioPath) {
            // 没有女声音频，生成静音段
            return this._genSilentImageSeg(bgWithImage, word, 5, outputPath);
        }
        // 拼接两次女声音频
        const tempDoubleAudio = outputPath.replace('.mp4', '_double.wav');
        await this._runFFmpeg([
            '-i', audioPath, '-i', audioPath,
            '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a]',
            '-map', '[a]', '-y', tempDoubleAudio
        ]);

        const wordEsc = this._esc(word.word);
        const phoneticEsc = this._esc(word.phonetic || '');

        await this._runFFmpeg([
            '-loop', '1', '-i', bgWithImage,
            '-i', tempDoubleAudio,
            '-vf', [
                `drawtext=fontfile='${FONT_PATH}':text='${wordEsc}':fontsize=96:fontcolor=white:x=(w-tw)/2:y=1380`,
                phoneticEsc ? `drawtext=fontfile='${FONT_PATH}':text='${phoneticEsc}':fontsize=44:fontcolor=#BBBBBB:x=(w-tw)/2:y=1490` : null
            ].filter(Boolean).join(','),
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k',
            '-shortest', '-t', '5',
            '-y', outputPath
        ]);

        // 清理临时音频
        fs.unlink(tempDoubleAudio, () => {});
    }

    /** Seg 3: 单词图 + 翻译 + 男声 */
    async _genSegWordMale(bgWithImage, word, audioPath, outputPath) {
        const wordEsc = this._esc(word.word);
        const phoneticEsc = this._esc(word.phonetic || '');
        const translationEsc = this._esc(word.translation || '');

        const inputArgs = ['-loop', '1', '-i', bgWithImage];
        if (audioPath) {
            inputArgs.push('-i', audioPath);
        } else {
            inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
        }

        await this._runFFmpeg([
            ...inputArgs,
            '-vf', [
                `drawtext=fontfile='${FONT_PATH}':text='${wordEsc}':fontsize=96:fontcolor=white:x=(w-tw)/2:y=1380`,
                phoneticEsc ? `drawtext=fontfile='${FONT_PATH}':text='${phoneticEsc}':fontsize=44:fontcolor=#BBBBBB:x=(w-tw)/2:y=1490` : null,
                `drawtext=fontfile='${FONT_PATH}':text='${translationEsc}':fontsize=64:fontcolor=#FFD700:x=(w-tw)/2:y=1570`
            ].filter(Boolean).join(','),
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k',
            '-shortest', '-t', '5',
            '-y', outputPath
        ]);
    }

    /** Seg 4: 例句展示 */
    async _genSegExample(bgPath, word, exampleAudioPath, outputPath) {
        const sentence = this._esc(word.example_sentence || '');
        const translation = this._esc(word.example_translation || '');

        if (!sentence) return;

        const inputArgs = ['-loop', '1', '-i', bgPath];
        if (exampleAudioPath) {
            inputArgs.push('-i', exampleAudioPath);
        } else {
            inputArgs.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo');
        }

        // 长句子自动换行（约 25 个英文字符换行）
        const wrappedSentence = this._wrapText(sentence, 28);
        const wrappedTranslation = this._wrapText(translation, 16);

        await this._runFFmpeg([
            ...inputArgs,
            '-vf', [
                `drawtext=fontfile='${FONT_PATH}':text='📖':fontsize=80:fontcolor=white:x=(w-tw)/2:y=700`,
                `drawtext=fontfile='${FONT_PATH}':text='${wrappedSentence}':fontsize=52:fontcolor=white:x=(w-tw)/2:y=850:line_spacing=20`,
                `drawtext=fontfile='${FONT_PATH}':text='${wrappedTranslation}':fontsize=40:fontcolor=#BBBBBB:x=(w-tw)/2:y=1050:line_spacing=16`
            ].join(','),
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k',
            '-shortest', '-t', '7',
            '-y', outputPath
        ]);
    }

    /** Seg 5: Follow me! 跟读环节 */
    async _genSegFollowMe(bgPath, outputPath) {
        await this._runFFmpeg([
            '-loop', '1', '-i', bgPath,
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
            '-t', '5',
            '-vf', [
                `drawtext=fontfile='${FONT_PATH}':text='🎤':fontsize=120:fontcolor=white:x=(w-tw)/2:y=(h-th)/2-150`,
                `drawtext=fontfile='${FONT_PATH}':text='Your turn!':fontsize=80:fontcolor=#FFD700:x=(w-tw)/2:y=(h-th)/2+30`,
                `drawtext=fontfile='${FONT_PATH}':text='Follow me and say it':fontsize=40:fontcolor=#BBBBBB:x=(w-tw)/2:y=(h-th)/2+140`
            ].join(','),
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k',
            '-y', outputPath
        ]);
    }

    /** Seg 6: 结尾品牌卡 */
    async _genSegEndCard(endCardPath, outputPath) {
        await this._runFFmpeg([
            '-loop', '1', '-i', endCardPath,
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
            '-t', '3',
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k',
            '-y', outputPath
        ]);
    }

    // ========== 素材处理 ==========

    /** 解析单词的所有素材到本地路径 */
    async _resolveWordAssets(word, tempDir, tempFiles) {
        const resolve = async (url, name) => {
            if (!url) return null;
            try {
                return await this._resolveToLocalPath(url, tempDir, name, tempFiles);
            } catch (e) {
                console.warn(`[Video] 解析素材失败 (${name}): ${e.message}`);
                return null;
            }
        };

        return {
            image: await resolve(word.image_url, 'image'),
            audioFemale: await resolve(word.audio_url_female || word.audio_url, 'audio_female'),
            audioMale: await resolve(word.audio_url_male, 'audio_male'),
            exampleAudio: await resolve(word.example_audio_female || word.example_audio_male, 'example_audio')
        };
    }

    /** 将 URL 解析为本地文件路径 */
    async _resolveToLocalPath(url, tempDir, name, tempFiles) {
        if (!url) return null;

        // 本地路径
        if (url.startsWith('/uploads/')) {
            const localPath = path.join(SERVER_ROOT, url);
            if (fs.existsSync(localPath)) return localPath;
            throw new Error(`本地文件不存在: ${localPath}`);
        }

        // 远程 URL — 下载到临时目录
        if (url.startsWith('http')) {
            const ext = path.extname(new URL(url).pathname) || '.tmp';
            const localPath = path.join(tempDir, `${name}${ext}`);
            const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
            fs.writeFileSync(localPath, resp.data);
            tempFiles.push(localPath);
            return localPath;
        }

        throw new Error(`无法解析 URL: ${url}`);
    }

    // ========== 图片生成 ==========

    /** 生成渐变背景图 1080x1920 */
    async _generateBackground(outputPath, colorTop = '#1a1a2e', colorBottom = '#16213e') {
        // 用 sharp 创建渐变背景
        const width = 1080;
        const height = 1920;
        const svg = `<svg width="${width}" height="${height}">
            <defs>
                <linearGradient id="g" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style="stop-color:${colorTop}"/>
                    <stop offset="100%" style="stop-color:${colorBottom}"/>
                </linearGradient>
            </defs>
            <rect width="${width}" height="${height}" fill="url(#g)"/>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outputPath);
    }

    /** 生成结尾品牌卡 */
    async _generateEndCard(outputPath) {
        const width = 1080;
        const height = 1920;
        const svg = `<svg width="${width}" height="${height}">
            <defs>
                <linearGradient id="g" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" style="stop-color:#0f3460"/>
                    <stop offset="100%" style="stop-color:#16213e"/>
                </linearGradient>
            </defs>
            <rect width="${width}" height="${height}" fill="url(#g)"/>
            <text x="540" y="860" font-family="sans-serif" font-size="60" fill="white" text-anchor="middle">Learn English with Fun!</text>
            <text x="540" y="960" font-family="sans-serif" font-size="40" fill="#FFD700" text-anchor="middle">Follow for more</text>
            <circle cx="540" cy="1150" r="80" fill="#FFD700" opacity="0.2"/>
            <text x="540" y="1170" font-family="sans-serif" font-size="60" fill="#FFD700" text-anchor="middle">⭐</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outputPath);
    }

    /** 把单词图片居中合成到背景上 */
    async _composeWordImage(bgPath, imagePath, outputPath) {
        if (!imagePath) {
            // 没有图片，直接复制背景
            fs.copyFileSync(bgPath, outputPath);
            return;
        }

        // 缩放单词图片到合适大小（最大 800x800，居中偏上）
        const resized = await sharp(imagePath)
            .resize(800, 800, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer();

        const resizedMeta = await sharp(resized).metadata();
        const left = Math.round((1080 - resizedMeta.width) / 2);
        const top = Math.round((1920 - resizedMeta.height) / 2 - 200); // 偏上

        await sharp(bgPath)
            .composite([{ input: resized, left, top }])
            .png()
            .toFile(outputPath);
    }

    // ========== FFmpeg 工具方法 ==========

    /** 合并视频段 */
    async _concatSegments(segmentPaths, outputPath, tempDir) {
        const listFile = path.join(tempDir, 'concat_list.txt');
        const content = segmentPaths.map(p => `file '${p}'`).join('\n');
        fs.writeFileSync(listFile, content);

        await this._runFFmpeg([
            '-f', 'concat', '-safe', '0', '-i', listFile,
            '-c', 'copy',
            '-y', outputPath
        ]);
    }

    /** 执行 FFmpeg 命令 */
    _runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';

            proc.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve();
                } else {
                    const lastLines = stderr.split('\n').slice(-10).join('\n');
                    reject(new Error(`FFmpeg 退出码 ${code}: ${lastLines}`));
                }
            });

            proc.on('error', (err) => {
                reject(new Error(`FFmpeg 启动失败: ${err.message}. 请确认已安装 FFmpeg`));
            });
        });
    }

    /** 生成静音图片视频段（音频缺失时的降级方案） */
    async _genSilentImageSeg(bgWithImage, word, duration, outputPath) {
        const wordEsc = this._esc(word.word);
        const phoneticEsc = this._esc(word.phonetic || '');

        await this._runFFmpeg([
            '-loop', '1', '-i', bgWithImage,
            '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
            '-t', String(duration),
            '-vf', [
                `drawtext=fontfile='${FONT_PATH}':text='${wordEsc}':fontsize=96:fontcolor=white:x=(w-tw)/2:y=1380`,
                phoneticEsc ? `drawtext=fontfile='${FONT_PATH}':text='${phoneticEsc}':fontsize=44:fontcolor=#BBBBBB:x=(w-tw)/2:y=1490` : null
            ].filter(Boolean).join(','),
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', '30',
            '-c:a', 'aac', '-b:a', '128k',
            '-y', outputPath
        ]);
    }

    // ========== 工具函数 ==========

    /** FFmpeg drawtext 文字转义 */
    _esc(text) {
        if (!text) return '';
        return text
            .replace(/\\/g, '\\\\\\\\')
            .replace(/'/g, "'\\\\\\''")
            .replace(/:/g, '\\\\:')
            .replace(/\[/g, '\\\\[')
            .replace(/\]/g, '\\\\]')
            .replace(/;/g, '\\\\;')
            .replace(/%/g, '%%');
    }

    /** 长文本换行 */
    _wrapText(text, maxChars) {
        if (!text || text.length <= maxChars) return this._esc(text);
        const words = text.split(' ');
        let lines = [];
        let current = '';
        for (const w of words) {
            if (current.length + w.length + 1 > maxChars && current) {
                lines.push(current);
                current = w;
            } else {
                current = current ? current + ' ' + w : w;
            }
        }
        if (current) lines.push(current);
        // 对中文直接按字符数切分
        if (lines.length === 1 && text.length > maxChars) {
            lines = [];
            for (let i = 0; i < text.length; i += maxChars) {
                lines.push(text.substring(i, i + maxChars));
            }
        }
        return lines.map(l => this._esc(l)).join('\\n');
    }

    /** 更新任务状态 */
    async _updateJob(jobId, fields) {
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            sets.push(`${k} = ?`);
            vals.push(v);
        }
        if (sets.length === 0) return;
        vals.push(jobId);
        await query(`UPDATE marketing_video_jobs SET ${sets.join(', ')} WHERE id = ?`, vals);
    }

    /** 清理临时目录 */
    _cleanup(dir) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch (e) {
            console.warn(`[Video] 清理临时文件失败: ${e.message}`);
        }
    }
}

module.exports = new VideoService();
