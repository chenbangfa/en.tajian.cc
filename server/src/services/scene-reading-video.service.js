const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { query } = require('../config/database');
const videoService = require('./video.service');
const voiceService = require('./voice.service');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/scene-reading-videos');
const W = 1080;
const H = 1920;
const SCENE_BOX = { x: 16, y: 76, w: 1048, h: 1456 };
const CARD = { x: 34, y: 1548, w: 1012, h: 264 };
const GAP = 0.28;
const AUDIO_VOLUME = 1.45;
const SILENT_SEGMENT_DURATION = 1.25;

let isProcessingSceneReadingVideo = false;

class SceneReadingVideoService {
    constructor() {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    async processNextJob() {
        if (isProcessingSceneReadingVideo) return;

        const [job] = await query(
            `SELECT * FROM scene_reading_video_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
        );
        if (!job) return;

        isProcessingSceneReadingVideo = true;
        try {
            let config = {};
            try { config = JSON.parse(job.config_json || '{}'); } catch (e) { /* ignore */ }
            await this.generateSceneReadingVideo(job.scene_id, job.id, config);
        } catch (error) {
            console.error('[SceneReadingVideo] 队列任务失败:', error.message);
        } finally {
            isProcessingSceneReadingVideo = false;
            setImmediate(() => this.processNextJob());
        }
    }

    async generateSceneReadingVideo(sceneId, jobId, config = {}) {
        const includeChinese = config.includeChinese !== false;
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `scene-reading-${jobId}-`));

        try {
            await this._updateJob(jobId, { status: 'processing', progress: 2, error_message: '' });

            const [scene] = await query(
                `SELECT s.*, c.name AS category_name, c.name_en AS category_name_en
                 FROM scenes s
                 LEFT JOIN scene_categories c ON c.id = s.category_id
                 WHERE s.id = ? LIMIT 1`,
                [sceneId]
            );
            if (!scene) throw new Error('场景不存在');
            if (!scene.image_url) throw new Error('场景缺少图片，无法生成点读视频');

            const objects = await query(`
                SELECT so.*,
                       COALESCE(so.phonetic, w.phonetic) AS phonetic,
                       COALESCE(so.translation, w.translation) AS translation,
                       so.audio_url_female AS scene_audio_url_female,
                       so.audio_url_male AS scene_audio_url_male,
                       so.translation_audio_url AS scene_translation_audio_url,
                       so.translation_audio_text AS scene_translation_audio_text,
                       w.audio_url_female AS word_audio_url_female,
                       w.audio_url_male AS word_audio_url_male,
                       w.translation AS word_translation,
                       w.translation_audio_url AS word_translation_audio_url,
                       w.word,
                       w.audio_url AS word_audio_url
                FROM scene_objects so
                LEFT JOIN words w ON so.word_id = w.id
                WHERE so.scene_id = ?
                  AND so.position_x IS NOT NULL
                  AND so.position_y IS NOT NULL
                  AND so.label_width IS NOT NULL
                  AND so.label_height IS NOT NULL
                ORDER BY so.sort_order ASC, so.id ASC
            `, [sceneId]);
            if (!objects.length) throw new Error('场景没有可点读热点，请先标注热点');

            const sceneImage = await videoService._resolveUrl(scene.image_url, tempDir, 'scene_image');
            const layout = await this._computeSceneLayout(sceneImage);
            await this._updateJob(jobId, { progress: 8 });

            const hydrated = [];
            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                const audioSteps = await this._resolveObjectAudioSteps(obj, tempDir, i, includeChinese);
                hydrated.push({ ...obj, audioSteps });
                await this._updateJob(jobId, { progress: 8 + Math.round(((i + 1) / objects.length) * 12) });
            }

            const slug = this._slugify(scene.name_en || scene.name || `scene_${sceneId}`);
            const baseName = `scene_reading_${sceneId}_${slug}_${Date.now()}`;
            const outputPath = path.join(OUTPUT_DIR, `${baseName}.mp4`);
            const coverPath = path.join(OUTPUT_DIR, `${baseName}.jpg`);
            const videoUrl = `/uploads/scene-reading-videos/${baseName}.mp4`;
            const coverUrl = `/uploads/scene-reading-videos/${baseName}.jpg`;
            const segDir = path.join(tempDir, 'segments');
            fs.mkdirSync(segDir, { recursive: true });
            const segments = [];

            const totalSegments = hydrated.reduce((sum, obj) => sum + Math.max(obj.audioSteps.length, 1), 0);
            let renderedSegments = 0;

            for (let i = 0; i < hydrated.length; i++) {
                const obj = hydrated[i];
                const framePath = path.join(tempDir, `frame_${String(i + 1).padStart(3, '0')}.png`);
                await this._renderWordFrame(framePath, {
                    scene,
                    sceneImage,
                    layout,
                    object: obj,
                    index: i + 1,
                    total: hydrated.length,
                    includeChinese
                });
                if (i === 0) fs.copyFileSync(framePath, coverPath);

                const steps = obj.audioSteps.length
                    ? obj.audioSteps
                    : [{ type: 'silent', audioPath: null, duration: SILENT_SEGMENT_DURATION }];

                for (let j = 0; j < steps.length; j++) {
                    const step = steps[j];
                    const segPath = path.join(segDir, `seg_${String(segments.length + 1).padStart(3, '0')}.mp4`);
                    await videoService._imgToVideo(framePath, step.audioPath, step.duration + GAP, segPath, {
                        noZoom: true,
                        noFadeIn: true,
                        noFadeOut: true,
                        audioVolume: AUDIO_VOLUME
                    });
                    segments.push(segPath);
                    renderedSegments += 1;
                    const progress = 20 + Math.round((renderedSegments / Math.max(totalSegments, 1)) * 70);
                    await this._updateJob(jobId, { progress: Math.min(progress, 90) });
                }
            }

            const endFrame = path.join(tempDir, 'the_end.png');
            await this._renderEndFrame(endFrame, { sceneImage });
            const endSegment = path.join(segDir, `seg_${String(hydrated.length + 1).padStart(3, '0')}_end.mp4`);
            await videoService._imgToVideo(endFrame, null, 1.35, endSegment, { noZoom: true, noFadeIn: true });
            segments.push(endSegment);

            await this._concatSegmentsNoBgm(segments, outputPath, tempDir);
            const durationSeconds = await videoService._getAudioDuration(outputPath);
            await this._updateJob(jobId, {
                status: 'done',
                progress: 100,
                video_url: videoUrl,
                cover_url: coverUrl,
                duration_seconds: Math.round(durationSeconds),
                error_message: ''
            });
            return videoUrl;
        } catch (error) {
            console.error(`[SceneReadingVideo] 任务 ${jobId} 失败:`, error);
            await this._updateJob(jobId, {
                status: 'failed',
                error_message: error.message || '生成失败'
            });
            throw error;
        } finally {
            videoService._cleanup(tempDir);
        }
    }

    async _resolveObjectAudioSteps(obj, tempDir, index, includeChinese) {
        const steps = [];
        if (includeChinese) {
            const chinese = await this._resolveChineseAudio(obj, tempDir, index);
            if (chinese) steps.push(chinese);
        }

        const female = await this._resolveEnglishAudio(obj, tempDir, index, 'female');
        if (female) steps.push(female);

        const male = await this._resolveEnglishAudio(obj, tempDir, index, 'male');
        if (male) steps.push(male);

        return steps;
    }

    async _resolveChineseAudio(obj, tempDir, index) {
        const text = String(obj.translation || '').trim();
        if (!text) return null;

        const wordTranslation = String(obj.word_translation || '').trim();
        const canReuseWordAudio = !!(obj.word_id && wordTranslation && this._sameText(wordTranslation, text));
        const sceneAudioText = String(obj.scene_translation_audio_text || '').trim();
        const canReuseSceneAudio = !!(obj.scene_translation_audio_url && sceneAudioText && this._sameText(sceneAudioText, text));
        let audioUrl = canReuseSceneAudio
            ? (obj.scene_translation_audio_url || '')
            : (canReuseWordAudio ? (obj.word_translation_audio_url || '') : '');

        if (!audioUrl) {
            try {
                if (canReuseWordAudio) {
                    audioUrl = await videoService._generateAndPersistWordAudio(obj.word_id, {
                        field: 'translation_audio_url',
                        text,
                        voice: 'female',
                        speed: voiceService.getGoogleTtsSpeed('default'),
                        isChinese: true
                    });
                } else {
                    const result = await voiceService.textToSpeechChinese(text, 'female', voiceService.getGoogleTtsSpeed('default'));
                    if (result.success && result.audioUrl) audioUrl = result.audioUrl;
                }
                if (audioUrl) {
                    await query(
                        'UPDATE scene_objects SET translation_audio_url = ?, translation_audio_text = ? WHERE id = ?',
                        [audioUrl, text, obj.id]
                    );
                }
            } catch (error) {
                console.warn(`[SceneReadingVideo] 中文音频生成失败 ${obj.custom_label || obj.word || obj.id}: ${error.message}`);
            }
        }

        return this._resolveAudioStep(audioUrl, tempDir, `audio_${index + 1}_zh`, 'zh');
    }

    async _resolveEnglishAudio(obj, tempDir, index, voice) {
        const word = String(obj.custom_label || obj.word || '').trim();
        if (!word) return null;

        const linkedWordText = String(obj.word || '').trim();
        const isLinkedWordText = !!(obj.word_id && linkedWordText && this._sameText(linkedWordText, word));
        const wordAudioUrl = voice === 'male'
            ? (obj.word_audio_url_male || '')
            : (obj.word_audio_url_female || obj.word_audio_url || '');
        const sceneAudioUrl = voice === 'male'
            ? (obj.scene_audio_url_male || obj.audio_url_male || '')
            : (obj.scene_audio_url_female || obj.audio_url_female || '');

        // words 页面重生发音后，点读视频应优先拿 words 最新音频；scene_objects 旧字段只做兜底。
        let audioUrl = isLinkedWordText ? (wordAudioUrl || sceneAudioUrl) : (sceneAudioUrl || wordAudioUrl);

        if (!audioUrl) {
            try {
                if (obj.word_id && obj.word && String(obj.word).trim() === word) {
                    audioUrl = await videoService._generateAndPersistWordAudio(obj.word_id, {
                        field: voice === 'male' ? 'audio_url_male' : 'audio_url_female',
                        text: word,
                        voice,
                        speed: voiceService.getGoogleTtsSpeed('default'),
                        engine: 'youdao'
                    });
                } else {
                    const result = await voiceService.textToSpeechByEngine(word, 'youdao', voice, voiceService.getGoogleTtsSpeed('default'));
                    if (result.success && result.audioUrl) audioUrl = result.audioUrl;
                }
            } catch (error) {
                console.warn(`[SceneReadingVideo] ${voice} 英文音频生成失败 ${word}: ${error.message}`);
            }
        }

        // 男声缺失时不复用女声，避免“女声读两遍”造成误解。
        if (!audioUrl && voice === 'female') audioUrl = obj.word_audio_url || '';
        return this._resolveAudioStep(audioUrl, tempDir, `audio_${index + 1}_${voice}`, voice);
    }

    _sameText(a, b) {
        return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    }

    async _resolveAudioStep(audioUrl, tempDir, name, type) {
        if (!audioUrl) return null;
        try {
            const audioPath = await videoService._resolveUrl(audioUrl, tempDir, name);
            const duration = Math.max(1.0, await videoService._getAudioDuration(audioPath));
            return { type, audioPath, duration };
        } catch (error) {
            console.warn(`[SceneReadingVideo] 音频解析失败 ${name}: ${error.message}`);
            return null;
        }
    }

    async _computeSceneLayout(sceneImage) {
        const meta = await sharp(sceneImage).metadata();
        const iw = meta.width || 1080;
        const ih = meta.height || 1920;
        const scale = Math.min(SCENE_BOX.w / iw, SCENE_BOX.h / ih);
        const width = Math.round(iw * scale);
        const height = Math.round(ih * scale);
        return {
            left: Math.round(SCENE_BOX.x + (SCENE_BOX.w - width) / 2),
            top: Math.round(SCENE_BOX.y + (SCENE_BOX.h - height) / 2),
            width,
            height
        };
    }

    async _buildBackground(sceneImage) {
        const blurred = await sharp(sceneImage)
            .resize(W, H, { fit: 'cover' })
            .blur(18)
            .modulate({ brightness: 0.74, saturation: 0.92 })
            .png()
            .toBuffer();
        const overlay = await sharp(Buffer.from(`<svg width="${W}" height="${H}">
            <defs>
                <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="rgba(240,250,235,0.42)"/>
                    <stop offset="0.58" stop-color="rgba(255,255,255,0.16)"/>
                    <stop offset="1" stop-color="rgba(23,32,51,0.28)"/>
                </linearGradient>
            </defs>
            <rect width="${W}" height="${H}" fill="url(#g)"/>
        </svg>`)).png().toBuffer();
        return sharp(blurred).composite([{ input: overlay, left: 0, top: 0 }]).png().toBuffer();
    }

    async _renderWordFrame(outputPath, { scene, sceneImage, layout, object, index, total, includeChinese }) {
        const background = await this._buildBackground(sceneImage);
        const sceneLayer = await sharp(sceneImage)
            .resize(layout.width, layout.height, { fit: 'contain' })
            .png()
            .toBuffer();
        const sceneShadow = await sharp(Buffer.from(`<svg width="${layout.width + 24}" height="${layout.height + 24}">
            <rect x="8" y="10" width="${layout.width + 8}" height="${layout.height + 8}" rx="32" fill="rgba(15,23,42,0.18)"/>
            <rect x="0" y="0" width="${layout.width + 10}" height="${layout.height + 10}" rx="32" fill="rgba(255,255,255,0.58)"/>
        </svg>`)).png().toBuffer();
        let base = await sharp(background).composite([
            { input: sceneShadow, left: layout.left - 5, top: layout.top - 5 },
            { input: sceneLayer, left: layout.left, top: layout.top }
        ]).png().toBuffer();

        const highlight = this._objectRectToFrame(object, layout);
        const word = object.custom_label || object.word || `Word ${index}`;
        const phonetic = this._formatPhonetic(object.phonetic || '');
        const translation = includeChinese ? (object.translation || '') : '';
        const e = videoService._svgEsc.bind(videoService);
        const wordLines = videoService._wrapLines(String(word), 16).slice(0, 2);
        const translationLines = videoService._wrapLines(String(translation), 14).slice(0, 2);

        let svg = `<svg width="${W}" height="${H}">
            <text x="54" y="62" font-size="30" font-weight="700" fill="rgba(31,98,54,0.88)" font-family="sans-serif">BookMelo</text>
            <rect x="${Math.max(0, highlight.x)}" y="${Math.max(0, highlight.y)}" width="${highlight.w}" height="${highlight.h}" rx="26" fill="rgba(61,139,79,0.14)" stroke="#2F8D4A" stroke-width="8"/>
            <rect x="${CARD.x}" y="${CARD.y}" width="${CARD.w}" height="${CARD.h}" rx="38" fill="rgba(255,255,255,0.9)" stroke="rgba(61,139,79,0.22)" stroke-width="2"/>
            <text x="${CARD.x + CARD.w - 48}" y="${CARD.y + 48}" text-anchor="end" font-size="28" font-weight="800" fill="rgba(31,98,54,0.66)" font-family="sans-serif">${index} / ${total}</text>
        `;
        let y = CARD.y + (includeChinese ? 82 : 104);
        wordLines.forEach(line => {
            svg += `<text x="${W / 2}" y="${y}" text-anchor="middle" font-size="${includeChinese ? 66 : 76}" font-weight="900" fill="#172033" font-family="sans-serif">${e(line)}</text>`;
            y += includeChinese ? 70 : 82;
        });
        if (phonetic) {
            svg += `<text x="${W / 2}" y="${y + 2}" text-anchor="middle" font-size="${includeChinese ? 36 : 42}" fill="#64748B" font-family="sans-serif">${e(phonetic)}</text>`;
            y += includeChinese ? 48 : 62;
        }
        translationLines.forEach(line => {
            svg += `<text x="${W / 2}" y="${y + 8}" text-anchor="middle" font-size="42" font-weight="800" fill="#2F8D4A" font-family="sans-serif">${e(line)}</text>`;
            y += 48;
        });
        svg += `</svg>`;

        const textLayer = await sharp(Buffer.from(svg)).png().toBuffer();
        await sharp(base).composite([{ input: textLayer, left: 0, top: 0 }]).jpeg({ quality: 90 }).toFile(outputPath);
    }

    async _renderEndFrame(outputPath, { sceneImage }) {
        const background = await this._buildBackground(sceneImage);
        const svg = `<svg width="${W}" height="${H}">
            <rect x="150" y="760" width="780" height="310" rx="70" fill="rgba(255,255,255,0.82)"/>
            <text x="${W / 2}" y="900" text-anchor="middle" font-size="94" font-weight="900" fill="#172033" font-family="sans-serif">The End</text>
            <text x="${W / 2}" y="990" text-anchor="middle" font-size="42" font-weight="800" fill="#2F8D4A" font-family="sans-serif">BookMelo</text>
        </svg>`;
        const textLayer = await sharp(Buffer.from(svg)).png().toBuffer();
        await sharp(background).composite([{ input: textLayer, left: 0, top: 0 }]).jpeg({ quality: 90 }).toFile(outputPath);
    }

    _objectRectToFrame(obj, layout) {
        const x = Number(obj.position_x || 0) / 100;
        const y = Number(obj.position_y || 0) / 100;
        const w = Number(obj.label_width || 10) / 100;
        const h = Number(obj.label_height || 8) / 100;
        return {
            x: Math.round(layout.left + x * layout.width),
            y: Math.round(layout.top + y * layout.height),
            w: Math.max(20, Math.round(w * layout.width)),
            h: Math.max(20, Math.round(h * layout.height))
        };
    }

    _formatPhonetic(value = '') {
        const clean = String(value || '').trim().replace(/^\/+|\/+$/g, '').trim();
        return clean ? `/${clean}/` : '';
    }

    async _concatSegmentsNoBgm(segPaths, outputPath, tempDir) {
        const listFile = path.join(tempDir, 'scene_reading_concat.txt');
        fs.writeFileSync(listFile, segPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
        await videoService._runFFmpeg([
            '-f', 'concat',
            '-safe', '0',
            '-i', listFile,
            '-c', 'copy',
            '-y', outputPath
        ]);
    }

    _slugify(input, fallback = 'scene_reading') {
        const value = String(input || '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 44);
        return value || fallback;
    }

    async _updateJob(jobId, fields) {
        const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
        if (!entries.length) return;
        const sets = entries.map(([key]) => `${key} = ?`);
        const values = entries.map(([, value]) => value);
        values.push(jobId);
        await query(`UPDATE scene_reading_video_jobs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, values);
    }
}

module.exports = new SceneReadingVideoService();
