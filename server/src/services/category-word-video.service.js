const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { query } = require('../config/database');
const videoService = require('./video.service');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/marketing/category-videos');
const W = 1080;
const H = 1920;
const SEGMENT_GAP = 1.0;
const CATEGORY_AUDIO_VOLUME = 1.55;

let isProcessingCategoryVideo = false;

class CategoryWordVideoService {
    constructor() {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    _fixMaybeMojibake(value) {
        const stripInvalidChars = (input) => String(input || '')
            .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
            .trim();

        const text = stripInvalidChars(value);
        if (!text) return '';

        // 已经是正常中文，直接返回
        if (/[\u4E00-\u9FFF]/.test(text)) {
            return text;
        }

        // 常见 UTF-8 被按 latin1 解码后的乱码形态，例如 å¸¸è§è¬è
        if (!/[ÃÂÅÄÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/.test(text)) {
            return text;
        }

        try {
            const repaired = stripInvalidChars(Buffer.from(text, 'latin1').toString('utf8'));
            if (repaired && /[\u4E00-\u9FFF]/.test(repaired)) {
                return repaired;
            }
            return text;
        } catch (error) {
            return text;
        }
    }

    async processNextJob() {
        if (isProcessingCategoryVideo) return;

        const [job] = await query(
            'SELECT * FROM marketing_category_video_jobs WHERE status = ? ORDER BY created_at ASC LIMIT 1',
            ['pending']
        );
        if (!job) return;

        isProcessingCategoryVideo = true;
        try {
            await this.generateCategoryVideo(job.id);
        } catch (error) {
            console.error('[CategoryVideo] 队列任务失败:', error.message);
        } finally {
            isProcessingCategoryVideo = false;
            setImmediate(() => this.processNextJob());
        }
    }

    async generateCategoryVideo(jobId) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'category-video-'));

        try {
            await this._updateJob(jobId, { status: 'processing', progress: 0, error_message: '' });

            const [job] = await query('SELECT * FROM marketing_category_video_jobs WHERE id = ?', [jobId]);
            if (!job) throw new Error(`任务 ${jobId} 不存在`);

            const config = this._parseConfig(job.config_json);
            const selectedWordIds = Array.isArray(config.selected_word_ids)
                ? config.selected_word_ids.map(id => parseInt(id, 10)).filter(Boolean)
                : [];

            if (selectedWordIds.length < 4) {
                throw new Error('分类视频至少需要 4 个单词');
            }

            const placeholders = selectedWordIds.map(() => '?').join(',');
            const rows = await query(`SELECT * FROM words WHERE id IN (${placeholders})`, selectedWordIds);
            const wordMap = new Map(rows.map(row => [row.id, row]));
            const orderedWords = selectedWordIds.map(id => wordMap.get(id)).filter(Boolean);

            if (orderedWords.length < 4) {
                throw new Error('可用单词不足，无法生成分类视频');
            }

            const hydratedWords = [];
            for (let index = 0; index < orderedWords.length; index++) {
                const hydrated = await videoService._ensureWordLessonAudio(orderedWords[index]);
                hydratedWords.push(hydrated);
                await this._updateJob(jobId, {
                    progress: Math.min(18, Math.round(((index + 1) / orderedWords.length) * 18))
                });
            }

            const firstAssets = await videoService._resolveWordAssets(hydratedWords[0], tempDir);
            let preferredCoverImage = null;
            const preferredCoverUrl = String(config.custom_cover_url || config.default_cover_url || '').trim();
            if (preferredCoverUrl) {
                try {
                    preferredCoverImage = await videoService._resolveUrl(preferredCoverUrl, tempDir, 'category_cover');
                } catch (error) {
                    console.warn(`[CategoryVideo] 默认/自定义封面解析失败: ${error.message}`);
                }
            }
            const slug = this._slugify(job.category_name_en || job.category_name, `category_${job.category_id}`);
            const baseName = `category_words_${slug}_${Date.now()}`;
            const coverPath = path.join(OUTPUT_DIR, `${baseName}.jpg`);
            const outputPath = path.join(OUTPUT_DIR, `${baseName}.mp4`);
            const coverUrl = `/uploads/marketing/category-videos/${baseName}.jpg`;
            const videoUrl = `/uploads/marketing/category-videos/${baseName}.mp4`;

            await this._renderCoverImage(coverPath, {
                imagePath: preferredCoverImage || firstAssets.image,
                title: job.category_name_en || job.category_name || 'Category Words',
                subtitle: job.parent_category_name ? `${job.parent_category_name} · ${job.category_name}` : (job.category_name || '')
            });

            const endFrame = path.join(tempDir, 'frame_end.png');

            const segDir = path.join(tempDir, 'segments');
            fs.mkdirSync(segDir, { recursive: true });
            const segments = [];

            const coverSegment = path.join(segDir, 'segment_000_cover.mp4');
            await videoService._imgToVideo(coverPath, null, 2.2, coverSegment, { noZoom: true, noFadeIn: true, noFadeOut: true });
            segments.push(coverSegment);
            await this._updateJob(jobId, { progress: 20 });

            let segmentIndex = 1;
            let lastBackgroundImage = preferredCoverImage || firstAssets.image;
            for (let index = 0; index < hydratedWords.length; index++) {
                const word = hydratedWords[index];
                const assets = await videoService._resolveWordAssets(word, tempDir);
                lastBackgroundImage = assets.image || lastBackgroundImage || firstAssets.image;
                const frameBase = path.join(tempDir, `word_frame_${String(index + 1).padStart(2, '0')}`);
                const framePaths = {
                    base: `${frameBase}_base.png`,
                    translation: `${frameBase}_translation.png`,
                    word: `${frameBase}_word.png`,
                    exampleTranslation: `${frameBase}_example_translation.png`,
                    exampleSentence: `${frameBase}_example_sentence.png`
                };
                const renderFrame = async (target, outputPath) => {
                    await this._renderWordFrame(outputPath, {
                        imagePath: assets.image || firstAssets.image,
                        categoryName: job.category_name,
                        categoryNameEn: job.category_name_en,
                        parentCategoryName: job.parent_category_name,
                        word,
                        index: index + 1,
                        total: hydratedWords.length,
                        highlightTarget: target
                    });
                };
                await renderFrame(null, framePaths.base);
                await renderFrame('translation', framePaths.translation);
                await renderFrame('word', framePaths.word);
                await renderFrame('example_translation', framePaths.exampleTranslation);
                await renderFrame('example_sentence', framePaths.exampleSentence);

                const durations = {
                    translation: assets.translationAudio ? await videoService._getAudioDuration(assets.translationAudio) : 0,
                    female: assets.audioFemale ? await videoService._getAudioDuration(assets.audioFemale) : 0,
                    male: assets.audioMale ? await videoService._getAudioDuration(assets.audioMale) : 0,
                    exampleTranslation: assets.exampleTranslationAudio ? await videoService._getAudioDuration(assets.exampleTranslationAudio) : 0,
                    exampleFemale: assets.exampleAudioFemale ? await videoService._getAudioDuration(assets.exampleAudioFemale) : 0,
                    exampleMale: assets.exampleAudioMale ? await videoService._getAudioDuration(assets.exampleAudioMale) : 0
                };

                const addWordSegment = async (framePath, audioPath, duration, key) => {
                    if (!audioPath || !duration) return;
                    const out = path.join(segDir, `segment_${String(segmentIndex++).padStart(3, '0')}_${key}.mp4`);
                    await videoService._imgToVideo(framePath, audioPath, duration + SEGMENT_GAP, out, {
                        noZoom: true,
                        noFadeIn: true,
                        noFadeOut: true,
                        audioVolume: CATEGORY_AUDIO_VOLUME
                    });
                    segments.push(out);
                };

                await addWordSegment(framePaths.translation, assets.translationAudio, durations.translation, 'translation');
                await addWordSegment(framePaths.word, assets.audioFemale, durations.female, 'word_female');
                await addWordSegment(framePaths.word, assets.audioMale, durations.male, 'word_male');
                await addWordSegment(framePaths.exampleTranslation, assets.exampleTranslationAudio, durations.exampleTranslation, 'example_translation');
                await addWordSegment(framePaths.exampleSentence, assets.exampleAudioFemale, durations.exampleFemale, 'example_female');
                await addWordSegment(framePaths.exampleSentence, assets.exampleAudioMale, durations.exampleMale, 'example_male');

                if (
                    word.example_sentence &&
                    !assets.exampleTranslationAudio &&
                    !assets.exampleAudioFemale &&
                    !assets.exampleAudioMale
                ) {
                    const fallbackOut = path.join(segDir, `segment_${String(segmentIndex++).padStart(3, '0')}_fallback.mp4`);
                    await videoService._imgToVideo(framePaths.base, null, 3, fallbackOut, {
                        noZoom: true,
                        noFadeIn: true,
                        noFadeOut: true
                    });
                    segments.push(fallbackOut);
                }

                const progress = 20 + Math.round(((index + 1) / hydratedWords.length) * 68);
                await this._updateJob(jobId, { progress: Math.min(progress, 88) });
            }

            await this._renderOutroFrame(endFrame, { imagePath: lastBackgroundImage });

            const endSegment = path.join(segDir, `segment_${String(segmentIndex++).padStart(3, '0')}_end.mp4`);
            await videoService._imgToVideo(endFrame, null, 1.8, endSegment, { noZoom: true, noFadeIn: true });
            segments.push(endSegment);

            await videoService._concatVideos(segments, outputPath, tempDir);
            await this._updateJob(jobId, {
                status: 'done',
                progress: 100,
                video_url: videoUrl,
                cover_url: coverUrl,
                word_count: hydratedWords.length,
                error_message: ''
            });

            return videoUrl;
        } catch (error) {
            console.error(`[CategoryVideo] 任务 ${jobId} 失败:`, error);
            await this._updateJob(jobId, {
                status: 'failed',
                error_message: error.message || '生成失败'
            });
            throw error;
        } finally {
            videoService._cleanup(tempDir);
        }
    }

    _parseConfig(rawConfig) {
        if (!rawConfig) return {};
        if (typeof rawConfig === 'object') return rawConfig;
        try {
            return JSON.parse(rawConfig);
        } catch (error) {
            console.warn('[CategoryVideo] config_json 解析失败:', error.message);
            return {};
        }
    }

    _slugify(input, fallback = 'category_words') {
        const value = String(input || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
        return value || fallback;
    }

    async _buildBackground(imagePath) {
        if (!imagePath || !fs.existsSync(imagePath)) {
            const svg = `<svg width="${W}" height="${H}">
                <defs>
                    <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stop-color="#1D2B64"/>
                        <stop offset="100%" stop-color="#0F172A"/>
                    </linearGradient>
                </defs>
                <rect width="${W}" height="${H}" fill="url(#bg)"/>
            </svg>`;
            return sharp(Buffer.from(svg)).png().toBuffer();
        }

        const blurred = await sharp(imagePath)
            .resize(W, H, { fit: 'cover' })
            .blur(18)
            .modulate({ brightness: 0.6, saturation: 1.05 })
            .png()
            .toBuffer();

        const overlaySvg = `<svg width="${W}" height="${H}">
            <defs>
                <linearGradient id="overlay" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stop-color="rgba(8,15,30,0.22)"/>
                    <stop offset="100%" stop-color="rgba(8,15,30,0.82)"/>
                </linearGradient>
            </defs>
            <rect width="${W}" height="${H}" fill="url(#overlay)"/>
        </svg>`;
        const overlay = await sharp(Buffer.from(overlaySvg)).png().toBuffer();
        return sharp(blurred).composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer();
    }

    async _buildFramedImage(imagePath, width = 700, height = 700) {
        if (!imagePath || !fs.existsSync(imagePath)) return null;

        const resized = await sharp(imagePath)
            .resize(width, height, { fit: 'cover' })
            .png()
            .toBuffer();
        const radius = 48;
        const mask = Buffer.from(`
            <svg width="${width}" height="${height}">
                <rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="white"/>
            </svg>
        `);
        const framed = await sharp(resized)
            .composite([{ input: mask, blend: 'dest-in' }])
            .png()
            .toBuffer();

        const cardSvg = `<svg width="${width + 32}" height="${height + 32}">
            <rect x="6" y="10" width="${width + 20}" height="${height + 20}" rx="${radius + 8}" fill="rgba(15,23,42,0.28)"/>
            <rect x="0" y="0" width="${width + 24}" height="${height + 24}" rx="${radius + 10}" fill="rgba(255,255,255,0.14)"/>
        </svg>`;
        const card = await sharp(Buffer.from(cardSvg)).png().toBuffer();
        return sharp(card).composite([{ input: framed, left: 12, top: 12 }]).png().toBuffer();
    }

    async _renderCoverImage(outputPath, { imagePath, title, subtitle }) {
        const normalizedTitle = this._fixMaybeMojibake(title || 'Category Words');
        const normalizedSubtitle = this._fixMaybeMojibake(subtitle || '');
        const background = await this._buildBackground(imagePath);
        const framedImage = await this._buildFramedImage(imagePath, 760, 760);
        const composites = [];

        if (framedImage) {
            const meta = await sharp(framedImage).metadata();
            composites.push({
                input: framedImage,
                left: Math.round((W - meta.width) / 2),
                top: 180
            });
        }

        let base = background;
        if (composites.length) {
            base = await sharp(background).composite(composites).png().toBuffer();
        }

        const titleLines = videoService._wrapLines(normalizedTitle, 18);
        const subtitleLines = videoService._wrapLines(normalizedSubtitle, 22);
        const e = videoService._svgEsc.bind(videoService);

        let textSvg = `<svg width="${W}" height="${H}">`;
        let titleY = 1225;
        titleLines.forEach(line => {
            textSvg += `<text x="${W / 2}" y="${titleY}" text-anchor="middle" font-size="82" font-weight="bold" fill="white" font-family="sans-serif">${e(line)}</text>`;
            titleY += 94;
        });
        let subtitleY = titleY + 28;
        subtitleLines.forEach(line => {
            textSvg += `<text x="${W / 2}" y="${subtitleY}" text-anchor="middle" font-size="42" fill="#E2E8F0" font-family="sans-serif">${e(line)}</text>`;
            subtitleY += 58;
        });
        textSvg += `<text x="${W / 2}" y="1810" text-anchor="middle" font-size="34" fill="rgba(255,255,255,0.68)" font-family="sans-serif">BookMelo</text>`;
        textSvg += `</svg>`;

        const textLayer = await sharp(Buffer.from(textSvg)).png().toBuffer();
        await sharp(base).composite([{ input: textLayer, left: 0, top: 0 }]).jpeg({ quality: 88 }).toFile(outputPath);
    }

    async _renderWordFrame(outputPath, { imagePath, categoryName, categoryNameEn, parentCategoryName, word, index, total, highlightTarget = null }) {
        const background = await this._buildBackground(imagePath);
        const framedImage = await this._buildFramedImage(imagePath, 680, 680);
        const composites = [];

        if (framedImage) {
            const meta = await sharp(framedImage).metadata();
            composites.push({
                input: framedImage,
                left: Math.round((W - meta.width) / 2),
                top: 160
            });
        }

        let base = background;
        if (composites.length) {
            base = await sharp(background).composite(composites).png().toBuffer();
        }

        const wordLines = videoService._wrapLines(word.word || '', 14);
        const phonetic = word.phonetic || '';
        const translation = word.translation || '';
        const exampleLines = videoService._wrapLines(word.example_sentence || '', 30).slice(0, 2);
        const exampleTranslationLines = videoService._wrapLines(word.example_translation || '', 20).slice(0, 2);
        const e = videoService._svgEsc.bind(videoService);

        const isWordHighlight = highlightTarget === 'word';
        const isTranslationHighlight = highlightTarget === 'translation';
        const isExampleSentenceHighlight = highlightTarget === 'example_sentence';
        const isExampleTranslationHighlight = highlightTarget === 'example_translation';

        let y = 1010;
        let textSvg = `<svg width="${W}" height="${H}">
            <text x="56" y="86" font-size="28" fill="rgba(255,255,255,0.82)" font-family="sans-serif">BookMelo</text>
        `;

        wordLines.forEach(line => {
            textSvg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="84" font-weight="bold" fill="${isWordHighlight ? '#FDE68A' : 'white'}" font-family="sans-serif">${e(line)}</text>`;
            y += 88;
        });

        if (phonetic) {
            textSvg += `<text x="${W / 2}" y="${y + 12}" text-anchor="middle" font-size="42" fill="${isWordHighlight ? '#DBEAFE' : '#CBD5E1'}" font-family="sans-serif">${e(phonetic)}</text>`;
            y += 88;
        }

        if (translation) {
            textSvg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="58" fill="${isTranslationHighlight ? '#FFFFFF' : '#FCD34D'}" font-weight="bold" font-family="sans-serif">${e(translation)}</text>`;
            y += 90;
        }

        exampleLines.forEach(line => {
            textSvg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="38" fill="${isExampleSentenceHighlight ? '#A7F3D0' : '#F8FAFC'}" font-family="sans-serif">${e(line)}</text>`;
            y += 52;
        });

        y += 8;
        exampleTranslationLines.forEach(line => {
            textSvg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="32" fill="${isExampleTranslationHighlight ? '#FDE68A' : '#CBD5E1'}" font-family="sans-serif">${e(line)}</text>`;
            y += 46;
        });

        textSvg += `</svg>`;
        const textLayer = await sharp(Buffer.from(textSvg)).png().toBuffer();
        await sharp(base).composite([{ input: textLayer, left: 0, top: 0 }]).png().toFile(outputPath);
    }

    async _renderOutroFrame(outputPath, { imagePath } = {}) {
        const background = await this._buildBackground(imagePath);
        const svg = `<svg width="${W}" height="${H}">
            <text x="${W / 2}" y="960" text-anchor="middle" font-size="108" font-weight="bold" fill="white" font-family="sans-serif">The End</text>
            <text x="${W / 2}" y="1060" text-anchor="middle" font-size="34" fill="rgba(255,255,255,0.78)" font-family="sans-serif">BookMelo</text>
        </svg>`;
        const textLayer = await sharp(Buffer.from(svg)).png().toBuffer();
        await sharp(background).composite([{ input: textLayer, left: 0, top: 0 }]).png().toFile(outputPath);
    }

    async _updateJob(jobId, fields) {
        const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
        if (!entries.length) return;
        const sets = entries.map(([key]) => `${key} = ?`);
        const values = entries.map(([, value]) => value);
        values.push(jobId);
        await query(`UPDATE marketing_category_video_jobs SET ${sets.join(', ')} WHERE id = ?`, values);
    }
}

module.exports = new CategoryWordVideoService();
