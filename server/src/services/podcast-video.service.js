const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { query } = require('../config/database');
const voiceService = require('./voice.service');
const aiService = require('./ai.service');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/podcast-videos');
const FPS = 30;
const AUDIO_VOLUME = 1.45;
const SEGMENT_GAP = 0.18;
const safeSeconds = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const FULL_LISTENING_GAP = safeSeconds(process.env.PODCAST_VIDEO_FULL_LISTENING_GAP, 0.72);
const PHASE_INTRO_TAIL_GAP = safeSeconds(process.env.PODCAST_VIDEO_PHASE_INTRO_TAIL_GAP, 0.55);
const SHORTS_SEGMENT_GAP = safeSeconds(process.env.PODCAST_VIDEO_SHORTS_SEGMENT_GAP, 0.12);
const SHORTS_FULL_LISTENING_GAP = safeSeconds(process.env.PODCAST_VIDEO_SHORTS_FULL_LISTENING_GAP, 0.48);
const SHORTS_PHASE_INTRO_TAIL_GAP = safeSeconds(process.env.PODCAST_VIDEO_SHORTS_PHASE_INTRO_TAIL_GAP, 0.32);

let H264_ENCODER = 'libx264';
try {
    const enc = execFileSync('ffmpeg', ['-encoders'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (enc.includes('libx264')) H264_ENCODER = 'libx264';
    else if (enc.includes('libopenh264')) H264_ENCODER = 'libopenh264';
    console.log(`[PodcastVideo] H.264 编码器: ${H264_ENCODER}`);
} catch (error) {
    console.warn('[PodcastVideo] FFmpeg 编码器检测失败');
}

let isProcessing = false;

class PodcastVideoService {
    constructor() {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    async processNextJob() {
        if (isProcessing) return;
        const [job] = await query(
            `SELECT * FROM podcast_video_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
        );
        if (!job) return;

        isProcessing = true;
        try {
            await this.generatePodcastVideo(job.id);
        } catch (error) {
            console.error('[PodcastVideo] 队列任务失败:', error.message);
        } finally {
            isProcessing = false;
            setImmediate(() => this.processNextJob());
        }
    }

    async generatePodcastVideo(jobId) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `podcast-video-${jobId}-`));
        try {
            await this._updateJob(jobId, { status: 'processing', progress: 0, error_message: '' });
            const [job] = await query('SELECT * FROM podcast_video_jobs WHERE id = ?', [jobId]);
            if (!job) throw new Error(`任务 ${jobId} 不存在`);

            const config = this._parseConfig(job.config_json);
            const aspect = this._normalizeAspect(config.aspect_ratio);
            const mode = this._normalizeMode(config.template_mode);
            const dims = aspect === '9:16'
                ? { W: 1080, H: 1920, isVertical: true, maxSentences: Number(config.max_sentences || 0) }
                : { W: 1920, H: 1080, isVertical: false, maxSentences: Number(config.max_sentences || 0) };
            const pacing = this._resolvePacing(aspect, config);

            const [content] = await query(`
                SELECT c.*, cat.name AS category_name, cat.name_en AS category_name_en
                FROM podcast_contents c
                LEFT JOIN podcast_categories cat ON c.category_id = cat.id
                WHERE c.id = ?
            `, [job.content_id]);
            if (!content) throw new Error('磨耳朵文章不存在');
            if (!content.content_text) throw new Error('文章英文内容为空');

            const prepared = await this._prepareSentences(content, mode, dims.maxSentences, tempDir);
            if (!prepared.sentences.length) throw new Error('文章没有可生成的视频句子');
            await this._persistSentenceAudioIfNeeded(content.id, prepared);
            await this._updateJob(jobId, { progress: 18, sentence_count: prepared.sentences.length });

            const baseName = `podcast_${content.id}_${mode}_${aspect.replace(':', 'x')}_${Date.now()}`;
            const coverPath = path.join(OUTPUT_DIR, `${baseName}.jpg`);
            const outputPath = path.join(OUTPUT_DIR, `${baseName}.mp4`);
            const coverUrl = `/uploads/podcast-videos/${baseName}.jpg`;
            const videoUrl = `/uploads/podcast-videos/${baseName}.mp4`;
            const segDir = path.join(tempDir, 'segments');
            fs.mkdirSync(segDir, { recursive: true });

            const generatedCover = await this._generateTopicCoverImage(content, prepared, dims, mode, tempDir).catch(error => {
                console.warn('[PodcastVideo] Gemini 封面图生成失败，使用文字封面:', error.message);
                return null;
            });
            dims.backgroundSvg = generatedCover ? await this._topicCoverBackgroundSvg(generatedCover, dims) : '';

            await this._renderCoverFrame(coverPath, content, prepared, dims, mode, tempDir);
            const segments = [];
            let segmentIndex = 0;
            const addSegment = async (framePath, audioPath, duration, label) => {
                const out = path.join(segDir, `seg_${String(segmentIndex++).padStart(4, '0')}_${label}.mp4`);
                await this._imageToVideo(framePath, audioPath, duration, out, dims);
                segments.push(out);
            };
            const addSpokenSegments = async (framePath, speechItems, fallbackDuration, label) => {
                const validItems = speechItems.filter(item => item && item.local);
                if (!validItems.length) {
                    await addSegment(framePath, null, fallbackDuration, label);
                    return;
                }
                for (let i = 0; i < validItems.length; i++) {
                    const item = validItems[i];
                    const duration = Math.max(item.minDuration || 1.2, await this._getAudioDuration(item.local)) + pacing.segmentGap + (item.tailPadding || 0);
                    await addSegment(framePath, item.local, duration, `${label}_${i + 1}`);
                }
            };

            const coverSpeech = await this._prepareCoverSpeech(content, mode, tempDir);
            await addSpokenSegments(coverPath, coverSpeech, pacing.coverFallbackDuration, 'cover');
            const firstIntroFrame = path.join(tempDir, 'phase_1_listen_first.png');
            const firstIntro = {
                step: 'Step 1',
                kicker: 'LISTEN FIRST',
                title: 'Listen to the whole passage once.',
                subtitle: "Don't stop yet. Catch the main idea and familiar words.",
                zh: '先完整盲听一遍，不暂停，抓住大意和熟悉的词。',
                spokenEn: dims.isVertical
                    ? 'Step one. Listen first. Catch the main idea.'
                    : "Step one. Listen first. Listen to the whole passage once. Don't stop yet. Catch the main idea and familiar words.",
                spokenZh: dims.isVertical
                    ? '第一步，先听一遍，抓住大意。'
                    : '第一步，先完整盲听一遍。不要暂停，抓住大意和熟悉的词。'
            };
            await this._renderPhaseIntroFrame(firstIntroFrame, content, dims, mode, firstIntro);
            await addSpokenSegments(firstIntroFrame, await this._prepareIntroSpeech(firstIntro, mode, tempDir, 'phase_1', pacing), pacing.phaseIntroFallbackDuration, 'phase_1');
            await this._updateJob(jobId, { progress: 22 });

            // 第一遍：完整英文朗读。逐句播放，画面显示文章脉络并高亮当前句。
            for (let i = 0; i < prepared.sentences.length; i++) {
                const sentence = prepared.sentences[i];
                const frame = path.join(tempDir, `full_${String(i + 1).padStart(3, '0')}.png`);
                await this._renderListeningFrame(frame, content, prepared.sentences, i, dims, mode);
                const dur = Math.max(1.4, await this._getAudioDuration(sentence.femaleLocal)) + pacing.fullListeningGap;
                await addSegment(frame, sentence.femaleLocal, dur, `full_${i + 1}`);
                await this._updateJob(jobId, { progress: 22 + Math.round(((i + 1) / prepared.sentences.length) * 28) });
            }

            const secondIntroFrame = path.join(tempDir, 'phase_2_sentence_focus.png');
            const secondIntro = {
                step: 'Step 2',
                kicker: 'SENTENCE FOCUS',
                title: 'Now listen sentence by sentence.',
                subtitle: 'Compare the female and male voices. Notice key words and patterns.',
                zh: '现在进入逐句精听，对比女声和男声，注意关键词和句型。',
                spokenEn: dims.isVertical
                    ? 'Step two. Sentence focus. Listen sentence by sentence.'
                    : 'Step two. Sentence focus. Now listen sentence by sentence. Compare the female and male voices. Notice key words and patterns.',
                spokenZh: dims.isVertical
                    ? '第二步，逐句精听。'
                    : '第二步，逐句精听。对比女声和男声，注意关键词和句型。'
            };
            await this._renderPhaseIntroFrame(secondIntroFrame, content, dims, mode, secondIntro);
            await addSpokenSegments(secondIntroFrame, await this._prepareIntroSpeech(secondIntro, mode, tempDir, 'phase_2', pacing), pacing.phaseIntroFallbackDuration, 'phase_2');

            // 第二遍：逐句训练。女声 -> 男声 -> 中文翻译发音(仅双语模板)。
            for (let i = 0; i < prepared.sentences.length; i++) {
                const sentence = prepared.sentences[i];
                const femaleFrame = path.join(tempDir, `train_${String(i + 1).padStart(3, '0')}_female.png`);
                const maleFrame = path.join(tempDir, `train_${String(i + 1).padStart(3, '0')}_male.png`);
                await this._renderTrainingFrame(femaleFrame, content, sentence, i, prepared.sentences.length, dims, mode, 'Female voice');
                await this._renderTrainingFrame(maleFrame, content, sentence, i, prepared.sentences.length, dims, mode, 'Male voice');
                await addSegment(femaleFrame, sentence.femaleLocal, Math.max(1.4, await this._getAudioDuration(sentence.femaleLocal)) + pacing.trainingGap, `train_${i + 1}_female`);
                await addSegment(maleFrame, sentence.maleLocal, Math.max(1.4, await this._getAudioDuration(sentence.maleLocal)) + pacing.trainingGap, `train_${i + 1}_male`);
                if (mode === 'bilingual' && sentence.translation && sentence.chineseLocal) {
                    const cnFrame = path.join(tempDir, `train_${String(i + 1).padStart(3, '0')}_cn.png`);
                    await this._renderTrainingFrame(cnFrame, content, sentence, i, prepared.sentences.length, dims, mode, 'Chinese meaning', 'translation');
                    await addSegment(cnFrame, sentence.chineseLocal, Math.max(1.2, await this._getAudioDuration(sentence.chineseLocal)) + pacing.trainingGap + pacing.chineseTranslationTailGap, `train_${i + 1}_cn`);
                }
                await this._updateJob(jobId, { progress: 50 + Math.round(((i + 1) / prepared.sentences.length) * 38) });
            }

            const reviewFrame = path.join(tempDir, 'review.png');
            await this._renderReviewFrame(reviewFrame, content, prepared, dims, mode);
            await addSegment(reviewFrame, null, pacing.reviewDuration, 'review');
            await this._updateJob(jobId, { progress: 92 });

            await this._concatVideos(segments, outputPath, tempDir);
            const finalDuration = await this._getAudioDuration(outputPath);
            await this._updateJob(jobId, {
                status: 'done',
                progress: 100,
                video_url: videoUrl,
                cover_url: coverUrl,
                duration_seconds: Math.round(finalDuration),
                error_message: ''
            });
            return videoUrl;
        } catch (error) {
            console.error(`[PodcastVideo] 任务 ${jobId} 失败:`, error);
            await this._updateJob(jobId, { status: 'failed', error_message: error.message || '生成失败' });
            throw error;
        } finally {
            this._cleanup(tempDir);
        }
    }

    async _prepareSentences(content, mode, maxSentences, tempDir) {
        let sentences = this._parseSentencesData(content.sentences_data);
        const fallbackTranslations = this._splitChineseSentences(content.translation || '');
        if (!sentences.length) {
            sentences = this._splitEnglishSentences(content.content_text || '').map((text, index) => ({
                text,
                translation: fallbackTranslations[index] || '',
                grammar: '',
                words: []
            }));
        } else {
            sentences = sentences.map((s, index) => ({
                text: String(s.text || '').trim(),
                translation: String(s.translation || fallbackTranslations[index] || '').trim(),
                grammar: String(s.grammar || '').trim(),
                words: Array.isArray(s.words) ? s.words : [],
                female_audio_url: s.female_audio_url || '',
                male_audio_url: s.male_audio_url || '',
                chinese_audio_url: s.chinese_audio_url || ''
            })).filter(s => s.text);
        }
        if (maxSentences > 0) sentences = sentences.slice(0, maxSentences);

        const speed = voiceService.getGoogleTtsSpeed('podcast');
        let changed = false;
        for (let i = 0; i < sentences.length; i++) {
            const s = sentences[i];
            if (!s.female_audio_url || this._shouldRegenerateEnglishAudio(s.female_audio_url)) {
                const result = await this._ttsEnglish(s.text, 'female', speed);
                s.female_audio_url = result.audioUrl;
                changed = true;
            }
            if (!s.male_audio_url || this._shouldRegenerateEnglishAudio(s.male_audio_url)) {
                const result = await this._ttsEnglish(s.text, 'male', speed);
                s.male_audio_url = result.audioUrl;
                changed = true;
            }
            if (mode === 'bilingual' && s.translation && !s.chinese_audio_url) {
                const result = await voiceService.textToSpeechChinese(s.translation, 'female', speed);
                if (result.success && result.audioUrl) {
                    s.chinese_audio_url = result.audioUrl;
                    changed = true;
                }
            }
            s.femaleLocal = await this._resolveUrl(s.female_audio_url, tempDir, `sentence_${i + 1}_female`);
            s.maleLocal = await this._resolveUrl(s.male_audio_url, tempDir, `sentence_${i + 1}_male`);
            s.chineseLocal = s.chinese_audio_url ? await this._resolveUrl(s.chinese_audio_url, tempDir, `sentence_${i + 1}_cn`).catch(() => null) : null;
        }
        return { sentences, changed };
    }

    async _persistSentenceAudioIfNeeded(contentId, prepared) {
        if (!prepared.changed) return;
        const payload = {
            sentences: prepared.sentences.map(s => ({
                text: s.text,
                translation: s.translation,
                grammar: s.grammar,
                words: s.words || [],
                female_audio_url: s.female_audio_url || '',
                male_audio_url: s.male_audio_url || '',
                chinese_audio_url: s.chinese_audio_url || ''
            }))
        };
        await query('UPDATE podcast_contents SET sentences_data = ? WHERE id = ?', [JSON.stringify(payload), contentId]);
    }

    async _ttsEnglish(text, voice, speed) {
        const engine = voiceService.normalizeEngine(process.env.PODCAST_VIDEO_EN_TTS_ENGINE || 'volcengine');
        const emotion = process.env.PODCAST_VIDEO_EN_TTS_EMOTION || 'happy';
        const effectiveSpeed = this._resolveEnglishTtsSpeed(voice, speed);
        const result = await voiceService.textToSpeechByEngine(text, engine, voice, effectiveSpeed, {
            emotion,
            emotionScale: process.env.PODCAST_VIDEO_EN_TTS_EMOTION_SCALE || 3
        });
        if (result.success && result.audioUrl) return result;

        console.warn(`[PodcastVideo] ${engine} 英文${voice}TTS失败，回退有道: ${result.error || '未返回音频'}`);
        const fallback = await voiceService.textToSpeechByEngine(text, 'youdao', voice, effectiveSpeed);
        if (!fallback.success || !fallback.audioUrl) throw new Error(fallback.error || `英文${voice}音频生成失败`);
        return fallback;
    }

    _resolveEnglishTtsSpeed(voice, baseSpeed) {
        const base = voiceService.normalizeSpeed(baseSpeed, 0.96);
        if (voice !== 'male') return base;
        const maleScale = Number(process.env.PODCAST_VIDEO_EN_MALE_SPEED_SCALE || 0.86);
        const safeScale = Number.isFinite(maleScale) ? maleScale : 0.86;
        return voiceService.normalizeSpeed(base * safeScale, 0.82);
    }

    _shouldRegenerateEnglishAudio(audioUrl) {
        const engine = voiceService.normalizeEngine(process.env.PODCAST_VIDEO_EN_TTS_ENGINE || 'volcengine');
        if (engine !== 'volcengine') return false;
        return /\/tts_yd_/.test(String(audioUrl || ''));
    }

    async _prepareCoverSpeech(content, mode, tempDir) {
        const speed = voiceService.getGoogleTtsSpeed('podcast');
        const items = [];
        const englishTitle = this._getEnglishTitle(content);
        const chineseTitle = this._getChineseTitle(content);
        if (englishTitle) {
            items.push(await this._createSpeechItem(englishTitle, 'en', 'female', speed, tempDir, 'cover_title_en', 1.2));
        }
        if (mode === 'bilingual' && chineseTitle) {
            items.push(await this._createSpeechItem(chineseTitle, 'zh', 'female', speed, tempDir, 'cover_title_zh', 1.0));
        }
        return items;
    }

    async _prepareIntroSpeech(stage, mode, tempDir, name, pacing = {}) {
        const speed = voiceService.getGoogleTtsSpeed('podcast');
        const englishText = stage.spokenEn || [stage.step, stage.kicker, stage.title, stage.subtitle].filter(Boolean).join('. ');
        const chineseText = stage.spokenZh || stage.zh;
        const phaseTail = Number.isFinite(pacing.phaseIntroTailGap) ? pacing.phaseIntroTailGap : PHASE_INTRO_TAIL_GAP;
        const items = [];
        if (englishText) {
            items.push(await this._createSpeechItem(englishText, 'en', 'female', speed, tempDir, `${name}_en`, 1.7, phaseTail));
        }
        if (mode === 'bilingual' && chineseText) {
            items.push(await this._createSpeechItem(chineseText, 'zh', 'female', speed, tempDir, `${name}_zh`, 1.3, phaseTail + 0.25));
        }
        return items;
    }

    async _createSpeechItem(text, lang, voice, speed, tempDir, name, minDuration, tailPadding) {
        try {
            const result = lang === 'zh'
                ? await voiceService.textToSpeechChinese(text, voice, speed)
                : await this._ttsEnglish(text, voice, speed);
            if (!result.success || !result.audioUrl) return null;
            return {
                local: await this._resolveUrl(result.audioUrl, tempDir, name),
                minDuration,
                tailPadding: Number.isFinite(tailPadding) ? tailPadding : (lang === 'zh' ? 0.75 : 0.25)
            };
        } catch (error) {
            console.warn(`[PodcastVideo] ${name} 提示音频生成失败:`, error.message);
            return null;
        }
    }

    async _renderCoverFrame(outPath, content, prepared, dims, mode, tempDir) {
        const { W, H, isVertical } = dims;
        const title = this._getEnglishTitle(content);
        const subtitle = mode === 'bilingual' ? this._getChineseTitle(content) : '';
        const badge = mode === 'bilingual' ? 'Bilingual Listening' : 'English Listening';
        const titleLines = this._wrapText(title, isVertical ? 19 : 34, isVertical ? 4 : 3);
        const subLines = subtitle ? this._wrapText(subtitle, isVertical ? 16 : 30, 2, true) : [];
        const titleSize = isVertical ? 76 : 78;
        const subSize = isVertical ? 44 : 46;
        const top = isVertical ? 310 : 230;
        const hasGeneratedCover = Boolean(dims.backgroundSvg);
        const bgSvg = hasGeneratedCover
            ? dims.backgroundSvg
            : `<rect width="${W}" height="${H}" fill="url(#bg)"/>${this._softShapes(W, H)}`;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}
            ${bgSvg}
            <rect width="${W}" height="${H}" fill="#0b1d13" opacity="${hasGeneratedCover ? 0.34 : 0}"/>
            ${this._watermark(W, H, isVertical)}
            <rect x="${isVertical ? 64 : 132}" y="${top - 70}" width="${W - (isVertical ? 128 : 264)}" height="${isVertical ? 760 : 520}" rx="${isVertical ? 42 : 48}" fill="${hasGeneratedCover ? 'rgba(255,255,255,0.76)' : 'rgba(255,255,255,0.86)'}" stroke="rgba(255,255,255,0.40)"/>
            <text x="${W / 2}" y="${top}" text-anchor="middle" font-size="${isVertical ? 34 : 30}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">${this._e(badge)}</text>
            ${this._textBlock(titleLines, W / 2, top + (isVertical ? 110 : 100), titleSize, isVertical ? 92 : 88, '#102116', '900', 'middle')}
            ${subLines.length ? this._textBlock(subLines, W / 2, top + (isVertical ? 490 : 365), subSize, subSize + 16, '#355548', '850', 'middle') : ''}
            <line x1="${W / 2 - (isVertical ? 210 : 270)}" x2="${W / 2 + (isVertical ? 210 : 270)}" y1="${H - (isVertical ? 420 : 230)}" y2="${H - (isVertical ? 420 : 230)}" stroke="${hasGeneratedCover ? '#ffffff' : '#9cc8a8'}" stroke-opacity="${hasGeneratedCover ? 0.72 : 1}" stroke-width="4" stroke-linecap="round"/>
            <text x="${W / 2}" y="${H - (isVertical ? 350 : 170)}" text-anchor="middle" font-size="${isVertical ? 34 : 30}" fill="${hasGeneratedCover ? '#ffffff' : '#355548'}" font-weight="900" font-family="Avenir Next, Arial" paint-order="stroke" stroke="${hasGeneratedCover ? '#173524' : 'transparent'}" stroke-width="3">${prepared.sentences.length} sentences · BookMelo</text>
        </svg>`;
        await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outPath);
    }

    async _generateTopicCoverImage(content, prepared, dims, mode, tempDir) {
        if (String(process.env.PODCAST_VIDEO_COVER_IMAGE_ENABLED || 'true').toLowerCase() === 'false') return null;
        const prompt = this._buildCoverImagePrompt(content, prepared, dims, mode);
        const result = await aiService.generateImage(prompt, { aspectRatio: dims.isVertical ? '9:16' : '16:9' });
        if (!result.success || !result.imageUrl) {
            throw new Error(result.error || 'Gemini 未返回封面图');
        }
        return this._resolveUrl(result.imageUrl, tempDir, 'podcast_cover_topic');
    }

    _buildCoverImagePrompt(content, prepared, dims, mode) {
        const title = this._getEnglishTitle(content);
        const textSample = prepared.sentences
            .slice(0, 5)
            .map(s => s.text)
            .join(' ');
        const aspectText = dims.isVertical ? 'vertical 9:16' : 'horizontal 16:9';
        const audience = mode === 'bilingual'
            ? 'Chinese English learners and beginner ESL learners'
            : 'global English learners';
        return `Create a premium YouTube podcast cover image for an English listening lesson.

Aspect ratio: ${aspectText}.
Lesson title: "${title}".
Article theme/context: ${textSample}
Audience: ${audience}.

Visual direction:
- YouTube-thumbnail-worthy but still premium and educational
- one strong, instantly readable focal subject related to the article theme
- emotional curiosity hook: make viewers wonder what the listening story is about
- clean editorial educational cover, warm modern style, trustworthy paid-course feeling
- cinematic but calm, suitable for English learning and listening practice
- strong depth, clear foreground/background separation, not a busy collage
- soft natural lighting, gentle green and cream color palette, subtle contrast
- leave a clean central area for title overlay
- high quality, polished, modern learning brand style

Important restrictions:
- no text, no letters, no subtitles, no logos, no watermark inside the generated image
- no distorted faces, no scary imagery, child-safe
- avoid clutter, avoid many small objects`;
    }

    async _topicCoverBackgroundSvg(imagePath, dims) {
        const { W, H } = dims;
        const data = await sharp(imagePath)
            .resize(W, H, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 88 })
            .toBuffer();
        const base64 = data.toString('base64');
        return `<image href="data:image/jpeg;base64,${base64}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`;
    }

    async _renderPhaseIntroFrame(outPath, content, dims, mode, stage) {
        const { W, H, isVertical } = dims;
        const title = this._getEnglishTitle(content);
        const panelX = isVertical ? 76 : 210;
        const panelW = W - panelX * 2;
        const panelH = isVertical ? 760 : 520;
        const panelY = Math.round((H - panelH) / 2) + (isVertical ? 30 : 24);
        const titleLines = this._wrapText(stage.title, isVertical ? 22 : 40, 3);
        const subLines = this._wrapText(stage.subtitle, isVertical ? 26 : 58, 3);
        const zhLines = mode === 'bilingual' ? this._wrapText(stage.zh, isVertical ? 18 : 36, 2, true) : [];
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}${this._frameBackground(dims)}
            <text x="${isVertical ? 70 : 130}" y="${isVertical ? 145 : 82}" font-size="${isVertical ? 28 : 24}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">${this._e(stage.kicker)}</text>
            <text x="${isVertical ? 70 : 130}" y="${isVertical ? 195 : 122}" font-size="${isVertical ? 34 : 30}" fill="#17231b" font-weight="900" font-family="Avenir Next, Arial">${this._e(this._shorten(title, isVertical ? 28 : 60))}</text>
            <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="${isVertical ? 54 : 58}" fill="rgba(255,255,255,0.88)" stroke="rgba(39,94,62,0.12)" filter="url(#shadow)"/>
            <circle cx="${W / 2}" cy="${panelY + (isVertical ? 145 : 105)}" r="${isVertical ? 64 : 54}" fill="#e8f6e9" stroke="#86c790" stroke-width="4"/>
            <text x="${W / 2}" y="${panelY + (isVertical ? 160 : 118)}" text-anchor="middle" font-size="${isVertical ? 32 : 28}" fill="#2d7a47" font-weight="950" font-family="Avenir Next, Arial">${this._e(stage.step)}</text>
            ${this._textBlock(titleLines, W / 2, panelY + (isVertical ? 280 : 230), isVertical ? 58 : 48, isVertical ? 74 : 62, '#102116', '950', 'middle')}
            ${this._textBlock(subLines, W / 2, panelY + (isVertical ? 520 : 385), isVertical ? 31 : 28, isVertical ? 45 : 40, '#52665a', '800', 'middle')}
            ${zhLines.length ? this._textBlock(zhLines, W / 2, panelY + (isVertical ? 655 : 470), isVertical ? 30 : 26, isVertical ? 42 : 36, '#8a651f', '850', 'middle') : ''}
            <text x="${W - (isVertical ? 70 : 130)}" y="${H - (isVertical ? 90 : 56)}" text-anchor="end" font-size="${isVertical ? 24 : 22}" fill="#789083" font-weight="800" font-family="Avenir Next, Arial">BookMelo Listening Lab</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outPath);
    }

    async _renderListeningFrame(outPath, content, sentences, activeIndex, dims, mode) {
        const { W, H, isVertical } = dims;
        const title = this._getEnglishTitle(content);
        const windowSize = isVertical ? 5 : 7;
        const half = Math.floor(windowSize / 2);
        let start = Math.max(0, activeIndex - half);
        if (start + windowSize > sentences.length) start = Math.max(0, sentences.length - windowSize);
        const visible = sentences.slice(start, start + windowSize);
        const panelX = isVertical ? 54 : 118;
        const panelY = isVertical ? 255 : 160;
        const panelW = W - panelX * 2;
        const panelH = H - (isVertical ? 445 : 270);
        const lineSize = isVertical ? 34 : 34;
        const lineGap = isVertical ? 72 : 62;
        const rowGap = isVertical ? 16 : 12;
        const rowData = visible.map((s, idx) => {
            const actualIndex = start + idx;
            const active = actualIndex === activeIndex;
            const lines = this._wrapText(s.text, isVertical ? 31 : 78, active ? 3 : 2);
            const rowH = Math.max(lineGap, lines.length * (lineSize + 10) + 20);
            return { actualIndex, active, lines, rowH };
        });
        const totalRowsH = rowData.reduce((sum, row) => sum + row.rowH, 0) + Math.max(0, rowData.length - 1) * rowGap;
        let y = panelY + Math.max(isVertical ? 70 : 58, Math.round((panelH - totalRowsH) / 2));
        const rows = rowData.map(row => {
            const rowY = y;
            const centerY = rowY + row.rowH / 2;
            y += row.rowH + rowGap;
            const textSize = row.active ? lineSize + 2 : lineSize - 3;
            const textGap = lineSize + 13;
            const blockH = (row.lines.length - 1) * textGap + textSize;
            const firstBaseline = centerY - blockH / 2 + textSize * 0.78;
            return `<g>
                <rect x="${panelX + 36}" y="${rowY}" width="${panelW - 72}" height="${row.rowH}" rx="24" fill="${row.active ? '#e8f6e9' : 'rgba(255,255,255,0.58)'}" stroke="${row.active ? '#72b77e' : 'rgba(39,94,62,0.08)'}" stroke-width="${row.active ? 3 : 1}"/>
                <text x="${panelX + 66}" y="${centerY + (isVertical ? 9 : 8)}" font-size="${isVertical ? 26 : 24}" fill="${row.active ? '#2d7a47' : '#8b9b91'}" font-weight="900" font-family="Avenir Next, Arial">${row.actualIndex + 1}</text>
                ${this._textBlock(row.lines, panelX + 118, firstBaseline, textSize, textGap, row.active ? '#102116' : '#596960', row.active ? '900' : '650', 'start')}
            </g>`;
        }).join('');
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}${this._frameBackground(dims)}${this._watermark(W, H, isVertical)}
            <text x="${panelX}" y="${isVertical ? 150 : 90}" font-size="${isVertical ? 28 : 24}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">FULL LISTENING</text>
            <text x="${panelX}" y="${isVertical ? 205 : 128}" font-size="${isVertical ? 40 : 36}" fill="#17231b" font-weight="900" font-family="Avenir Next, Arial">${this._e(this._shorten(title, isVertical ? 30 : 60))}</text>
            <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="38" fill="rgba(255,255,255,0.82)" stroke="rgba(39,94,62,0.12)"/>
            ${rows}
            <text x="${W - panelX}" y="${H - (isVertical ? 145 : 82)}" text-anchor="end" font-size="${isVertical ? 28 : 24}" fill="#5e7668" font-weight="800" font-family="Avenir Next, Arial">${activeIndex + 1} / ${sentences.length}</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outPath);
    }

    async _renderTrainingFrame(outPath, content, sentence, index, total, dims, mode, voiceLabel, highlight = 'sentence') {
        const { W, H, isVertical } = dims;
        const title = this._getEnglishTitle(content);
        const translationLines = mode === 'bilingual' && sentence.translation ? this._wrapText(sentence.translation, isVertical ? 18 : 44, 2, true) : [];
        const words = sentence.words || [];
        const grammar = sentence.grammar || '';
        const panelX = isVertical ? 54 : 120;
        const mainY = isVertical ? 238 : 178;
        const mainW = W - panelX * 2;
        const sentenceLayout = this._fitSentenceText(sentence.text, mainW - 108, isVertical);
        const sentenceLines = sentenceLayout.lines;
        const sentenceFont = sentenceLayout.fontSize;
        const sentenceGap = isVertical ? Math.round(sentenceFont * 1.23) : Math.round(sentenceFont * 1.25);
        const translationFont = isVertical ? 34 : 38;
        const translationGap = isVertical ? 46 : 48;
        const sentenceBlockH = Math.max(sentenceFont, (sentenceLines.length - 1) * sentenceGap + sentenceFont);
        const translationBlockH = translationLines.length ? (translationLines.length - 1) * translationGap + translationFont : 0;
        const mainH = isVertical
            ? Math.min(620, Math.max(390, 120 + sentenceBlockH + (translationLines.length ? 48 + translationBlockH : 0) + 54))
            : 420;
        const keyY = mainY + mainH + (isVertical ? 28 : 36);
        const sentenceY = mainY + (isVertical ? 154 : 155);
        const translationY = sentenceY + sentenceBlockH + (isVertical ? 42 : Math.max(58, mainH - 255));
        const mainStroke = highlight === 'translation' ? '#e8b65f' : (isVertical ? 'url(#accentStroke)' : '#72b77e');
        const mainFilter = isVertical ? ' filter="url(#softGlow)"' : '';
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}${this._frameBackground(dims)}${this._watermark(W, H, isVertical)}
            <text x="${panelX}" y="${isVertical ? 112 : 84}" font-size="${isVertical ? 27 : 24}" fill="#2d7a47" font-weight="950" letter-spacing="1.5" font-family="Avenir Next, Arial">SENTENCE TRAINING</text>
            <text x="${panelX}" y="${isVertical ? 164 : 124}" font-size="${isVertical ? 34 : 32}" fill="#17231b" font-weight="950" font-family="Avenir Next, Arial">${this._e(this._shorten(title, isVertical ? 28 : 62))}</text>
            <rect x="${panelX}" y="${mainY}" width="${mainW}" height="${mainH}" rx="${isVertical ? 46 : 42}" fill="${isVertical ? 'rgba(255,255,255,0.84)' : 'rgba(255,255,255,0.88)'}" stroke="${mainStroke}" stroke-width="${isVertical ? 5 : 4}"${mainFilter}/>
            <rect x="${panelX + 34}" y="${mainY + 34}" width="${isVertical ? 310 : 250}" height="${isVertical ? 54 : 46}" rx="${isVertical ? 27 : 23}" fill="${highlight === 'translation' ? '#fff6df' : '#eef9f0'}"/>
            <text x="${panelX + 58}" y="${mainY + (isVertical ? 70 : 64)}" font-size="${isVertical ? 26 : 26}" fill="${highlight === 'translation' ? '#9b6b15' : '#3d6f50'}" font-weight="950" font-family="Avenir Next, Arial">${this._e(voiceLabel)} · ${index + 1}/${total}</text>
            ${this._textBlock(sentenceLines, panelX + 58, sentenceY, sentenceFont, sentenceGap, '#102116', '950', 'start')}
            ${translationLines.length ? this._textBlock(translationLines, panelX + 60, translationY, translationFont, translationGap, highlight === 'translation' ? '#b27714' : '#5e7668', '900', 'start') : ''}
            ${this._renderKeyPanel(panelX, keyY, mainW, H - keyY - (isVertical ? 145 : 80), words, grammar, dims)}
            <text x="${W - panelX}" y="${H - (isVertical ? 86 : 48)}" text-anchor="end" font-size="${isVertical ? 24 : 22}" fill="#789083" font-weight="800" font-family="Avenir Next, Arial">BookMelo Listening Lab</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outPath);
    }

    _renderKeyPanel(x, y, w, h, words, grammar, dims) {
        const { isVertical } = dims;
        const visibleWords = words.slice(0, isVertical ? 8 : 6);
        const cols = isVertical ? 2 : 3;
        const rows = Math.ceil(visibleWords.length / cols);
        const chips = visibleWords.map((item, idx) => {
            const word = this._shorten(item.word || '', isVertical ? 14 : 20);
            const phonetic = this._shorten(this._formatPhonetic(item.phonetic || item.uk_phonetic || item.us_phonetic || ''), isVertical ? 14 : 22);
            const meaning = this._compactMeaning(item.translation || item.pos || '', isVertical ? 12 : 18);
            const chipGap = isVertical ? 20 : 24;
            const chipW = Math.floor((w - (isVertical ? 88 : 92) - chipGap * (cols - 1)) / cols);
            const cx = x + (isVertical ? 34 : 46) + (idx % cols) * (chipW + chipGap);
            const cy = y + (isVertical ? 122 : 118) + Math.floor(idx / cols) * (isVertical ? 86 : 86);
            const wordSize = isVertical ? (word.length > 11 ? 21 : 23) : (word.length > 16 ? 21 : 24);
            const phoneticSize = isVertical ? 16 : 17;
            const meaningSize = isVertical ? 18 : 18;
            return `<g><rect x="${cx}" y="${cy - 44}" width="${chipW}" height="${isVertical ? 68 : 70}" rx="${isVertical ? 28 : 28}" fill="#f3faf4" stroke="#cbe8d1"/>
                <text x="${cx + 20}" y="${cy - 16}" font-family="Avenir Next, Arial">
                    <tspan font-size="${wordSize}" fill="#213429" font-weight="900">${this._e(word)}</tspan>
                    ${phonetic ? `<tspan dx="8" font-size="${phoneticSize}" fill="#7d9185" font-weight="700">${this._e(phonetic)}</tspan>` : ''}
                </text>
                ${meaning ? `<text x="${cx + 20}" y="${cy + 14}" font-size="${meaningSize}" fill="#5f7b69" font-weight="800" font-family="Avenir Next, Arial">${this._e(meaning)}</text>` : ''}</g>`;
        }).join('');
        const grammarLines = this._wrapText(grammar || 'Listen for the sentence rhythm and key expression.', isVertical ? 24 : 64, isVertical ? 4 : 2, /[\u3400-\u9fff]/.test(grammar || ''));
        const patternY = isVertical ? y + 122 + Math.max(1, rows) * 86 + 46 : y + 288;
        const panelH = isVertical
            ? Math.max(360, Math.min(h, patternY - y + 72 + grammarLines.length * 36))
            : Math.max(180, h);
        const moreBadge = words.length > visibleWords.length
            ? `<text x="${x + w - 48}" y="${y + 48}" text-anchor="end" font-size="${isVertical ? 20 : 18}" fill="#5f7b69" font-weight="900" font-family="Avenir Next, Arial">+${words.length - visibleWords.length}</text>`
            : '';
        return `<g>
            <rect x="${x}" y="${y}" width="${w}" height="${panelH}" rx="34" fill="${isVertical ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.72)'}" stroke="rgba(39,94,62,0.10)" filter="${isVertical ? 'url(#softGlow)' : ''}"/>
            <text x="${x + 34}" y="${y + 48}" font-size="${isVertical ? 24 : 22}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">KEY WORDS / GRAMMAR</text>
            ${moreBadge}
            ${chips}
            ${visibleWords.length ? '' : `<text x="${x + 34}" y="${y + 122}" font-size="${isVertical ? 25 : 24}" fill="#5f7b69" font-weight="750" font-family="Avenir Next, Arial">Listen for the sentence rhythm.</text>`}
            <text x="${x + 34}" y="${patternY}" font-size="${isVertical ? 24 : 22}" fill="#8a651f" font-weight="900" font-family="Avenir Next, Arial">Pattern</text>
            ${this._textBlock(grammarLines, x + 34, patternY + (isVertical ? 45 : 38), isVertical ? 25 : 23, isVertical ? 36 : 32, '#6b5b31', '750', 'start')}
        </g>`;
    }

    async _renderReviewFrame(outPath, content, prepared, dims, mode) {
        const { W, H, isVertical } = dims;
        const words = [];
        const grammars = [];
        for (const s of prepared.sentences) {
            for (const w of (s.words || [])) {
                if (w.word && !words.some(x => String(x.word).toLowerCase() === String(w.word).toLowerCase())) words.push(w);
            }
            if (s.grammar && !grammars.includes(s.grammar)) grammars.push(s.grammar);
        }
        const grammarLines = (grammars.length ? grammars.slice(0, isVertical ? 2 : 3) : ['Review the sentence rhythm.', 'Repeat the useful sentence patterns.']);
        const x = isVertical ? 70 : 150;
        const wordPanelY = isVertical ? 295 : 215;
        const wordPanelH = isVertical ? 590 : 390;
        const patternY = isVertical ? 940 : 640;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}${this._frameBackground(dims)}${this._watermark(W, H, isVertical)}
            <text x="${x}" y="${isVertical ? 220 : 150}" font-size="${isVertical ? 62 : 60}" fill="#102116" font-weight="950" font-family="Avenir Next, Arial">Review</text>
            ${this._renderReviewKeyWordsPanel(x, wordPanelY, W - x * 2, wordPanelH, words, dims)}
            <rect x="${x}" y="${patternY}" width="${W - x * 2}" height="${isVertical ? 430 : 285}" rx="38" fill="rgba(255,255,255,0.74)"/>
            <text x="${x + 44}" y="${patternY + (isVertical ? 68 : 60)}" font-size="${isVertical ? 30 : 28}" fill="#8a651f" font-weight="900" font-family="Avenir Next, Arial">Patterns</text>
            ${this._listBlock(grammarLines, x + 48, patternY + (isVertical ? 140 : 120), isVertical ? 27 : 24, isVertical ? 46 : 40, '#5d4c26', isVertical ? 25 : 58, isVertical ? 2 : 2)}
            <text x="${W / 2}" y="${H - (isVertical ? 170 : 90)}" text-anchor="middle" font-size="${isVertical ? 34 : 30}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">The End · BookMelo</text>
        </svg>`;
        await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outPath);
    }

    _renderReviewKeyWordsPanel(x, y, w, h, words, dims) {
        const { isVertical } = dims;
        const visibleWords = words.slice(0, isVertical ? 10 : 9);
        const cols = isVertical ? 2 : 3;
        const chipGap = isVertical ? 16 : 24;
        const chipW = Math.floor((w - 96 - chipGap * (cols - 1)) / cols);
        const chipH = isVertical ? 70 : 74;
        const chips = visibleWords.map((item, idx) => {
            const word = this._shorten(item.word || '', isVertical ? 14 : 20);
            const phonetic = this._shorten(this._formatPhonetic(item.phonetic || item.uk_phonetic || item.us_phonetic || ''), isVertical ? 14 : 22);
            const meaning = this._compactMeaning(item.translation || item.pos || '', isVertical ? 12 : 18);
            const col = idx % cols;
            const row = Math.floor(idx / cols);
            const cx = x + 48 + col * (chipW + chipGap);
            const cy = y + (isVertical ? 134 : 122) + row * (chipH + (isVertical ? 14 : 18));
            const wordSize = isVertical ? 26 : (word.length > 16 ? 22 : 24);
            return `<g>
                <rect x="${cx}" y="${cy - 44}" width="${chipW}" height="${chipH}" rx="${isVertical ? 32 : 28}" fill="#f3faf4" stroke="#cbe8d1"/>
                <text x="${cx + 24}" y="${cy - 14}" font-family="Avenir Next, Arial">
                    <tspan font-size="${wordSize}" fill="#213429" font-weight="900">${this._e(word)}</tspan>
                    ${phonetic ? `<tspan dx="12" font-size="${isVertical ? 18 : 17}" fill="#7d9185" font-weight="700">${this._e(phonetic)}</tspan>` : ''}
                </text>
                ${meaning ? `<text x="${cx + 24}" y="${cy + 14}" font-size="${isVertical ? 20 : 18}" fill="#5f7b69" font-weight="750" font-family="Avenir Next, Arial">${this._e(meaning)}</text>` : ''}
            </g>`;
        }).join('');
        return `<g>
            <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="38" fill="rgba(255,255,255,0.84)"/>
            <text x="${x + 44}" y="${y + (isVertical ? 65 : 62)}" font-size="${isVertical ? 30 : 28}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">Key words</text>
            ${chips || `<text x="${x + 44}" y="${y + 145}" font-size="${isVertical ? 28 : 26}" fill="#5f7b69" font-weight="800" font-family="Avenir Next, Arial">Listen again and notice the main expressions.</text>`}
        </g>`;
    }

    async _imageToVideo(imagePath, audioPath, duration, outputPath, dims) {
        const { W, H } = dims;
        const hasAudio = audioPath && fs.existsSync(audioPath);
        const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}`;
        if (hasAudio) {
            await this._runFFmpeg([
                '-loop', '1', '-i', imagePath, '-i', audioPath,
                '-filter_complex', `[0:v]${vf}[v];[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${AUDIO_VOLUME},apad=whole_dur=${duration}[a]`,
                '-map', '[v]', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', String(FPS),
                '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
                '-t', String(duration), '-y', outputPath
            ]);
        } else {
            await this._runFFmpeg([
                '-loop', '1', '-i', imagePath,
                '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                '-filter_complex', `[0:v]${vf}[v];[1:a]anull[a]`,
                '-map', '[v]', '-map', '[a]',
                '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', String(FPS),
                '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
                '-t', String(duration), '-y', outputPath
            ]);
        }
    }

    async _concatVideos(segPaths, outputPath, tempDir) {
        const listFile = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(listFile, segPaths.map(p => `file '${p}'`).join('\n'));
        const raw = path.join(tempDir, 'raw_concat.mp4');
        await this._runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', raw]);
        await this._runFFmpeg([
            '-i', raw,
            '-c:v', H264_ENCODER, '-pix_fmt', 'yuv420p', '-r', String(FPS),
            '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
            '-movflags', '+faststart', '-y', outputPath
        ]);
    }

    _runFFmpeg(args) {
        return new Promise((resolve, reject) => {
            const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';
            proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
            proc.on('close', code => {
                if (code === 0) resolve();
                else reject(new Error(`FFmpeg 退出码 ${code}: ${stderr.split('\n').slice(-12).join('\n')}`));
            });
            proc.on('error', err => reject(new Error(`FFmpeg 启动失败: ${err.message}`)));
        });
    }

    async _getAudioDuration(filePath) {
        try {
            const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            return parseFloat(out.trim()) || 2;
        } catch (error) {
            return 2;
        }
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
        throw new Error(`无法解析音频地址: ${url}`);
    }

    _parseSentencesData(raw) {
        if (!raw || raw === 'processing') return [];
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(parsed?.sentences) ? parsed.sentences : [];
        } catch (error) {
            return [];
        }
    }

    _splitEnglishSentences(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) || [];
    }

    _splitChineseSentences(text) {
        return String(text || '')
            .replace(/\s+/g, '')
            .match(/[^。！？；]+[。！？；]?/g)?.map(s => s.trim()).filter(Boolean) || [];
    }

    _parseConfig(raw) {
        if (!raw) return {};
        if (typeof raw === 'object') return raw;
        try { return JSON.parse(raw); } catch { return {}; }
    }

    _normalizeAspect(value) {
        return String(value || '').trim() === '9:16' ? '9:16' : '16:9';
    }

    _normalizeMode(value) {
        return String(value || '').trim() === 'bilingual' ? 'bilingual' : 'english_only';
    }

    _resolvePacing(aspect, config = {}) {
        const isShorts = aspect === '9:16';
        const requested = String(config.pacing || '').trim();
        const preset = requested && requested !== 'auto' ? requested : (isShorts ? 'shorts_compact' : 'standard');
        const isSlow = preset === 'slow_learning';
        const isCompact = preset === 'shorts_compact';
        return {
            preset,
            segmentGap: safeSeconds(config.segment_gap, isCompact ? SHORTS_SEGMENT_GAP : (isSlow ? 0.28 : SEGMENT_GAP)),
            fullListeningGap: safeSeconds(config.full_listening_gap, isCompact ? SHORTS_FULL_LISTENING_GAP : (isSlow ? 0.95 : FULL_LISTENING_GAP)),
            trainingGap: safeSeconds(config.training_gap, isCompact ? 0.16 : (isSlow ? 0.36 : 0.22)),
            chineseTranslationTailGap: safeSeconds(config.chinese_translation_tail_gap, isCompact ? 0.72 : (isSlow ? 1.15 : 0.9)),
            phaseIntroTailGap: safeSeconds(config.phase_intro_tail_gap, isCompact ? SHORTS_PHASE_INTRO_TAIL_GAP : (isSlow ? 0.72 : PHASE_INTRO_TAIL_GAP)),
            coverFallbackDuration: safeSeconds(config.cover_fallback_duration, isShorts ? 1.4 : 2.2),
            phaseIntroFallbackDuration: safeSeconds(config.phase_intro_fallback_duration, isShorts ? 1.8 : 2.4),
            reviewDuration: safeSeconds(config.review_duration, isShorts ? 2.8 : 4.2)
        };
    }

    _getEnglishTitle(content) {
        const titleEn = String(content?.title_en || '').trim();
        if (titleEn) return titleEn;
        const title = String(content?.title || '').trim();
        return title && !/[\u3400-\u9fff]/.test(title) ? title : 'Listening Practice';
    }

    _getChineseTitle(content) {
        const title = String(content?.title_zh || content?.title || '').trim();
        if (!title || !/[\u3400-\u9fff]/.test(title)) return '';
        const englishTitle = String(content?.title_en || '').trim().toLowerCase();
        if (englishTitle && title.toLowerCase() === englishTitle) return '';
        return title;
    }

    _defs() {
        return `<defs>
            <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#f6fbf3"/>
                <stop offset="48%" stop-color="#eef8ed"/>
                <stop offset="100%" stop-color="#e7f1eb"/>
            </linearGradient>
            <linearGradient id="accentStroke" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#48b36b"/>
                <stop offset="52%" stop-color="#93d0ff"/>
                <stop offset="100%" stop-color="#f1c86b"/>
            </linearGradient>
            <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#25543b" flood-opacity="0.13"/></filter>
            <filter id="softGlow" x="-18%" y="-18%" width="136%" height="136%"><feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#214c35" flood-opacity="0.16"/></filter>
        </defs>`;
    }

    _frameBackground(dims) {
        const { W, H } = dims;
        if (dims.backgroundSvg) {
            return `${dims.backgroundSvg}
                <rect width="${W}" height="${H}" fill="#f6fbf3" opacity="${dims.isVertical ? 0.56 : 0.78}"/>
                <rect width="${W}" height="${H}" fill="url(#bg)" opacity="${dims.isVertical ? 0.34 : 0.46}"/>`;
        }
        return `<rect width="${W}" height="${H}" fill="url(#bg)"/>${this._softShapes(W, H)}`;
    }

    _softShapes(W, H) {
        return `<circle cx="${W * 0.08}" cy="${H * 0.08}" r="${Math.min(W, H) * 0.18}" fill="#cfead1" opacity="0.42"/>
            <circle cx="${W * 0.92}" cy="${H * 0.22}" r="${Math.min(W, H) * 0.22}" fill="#fff7d8" opacity="0.7"/>
            <circle cx="${W * 0.75}" cy="${H * 0.95}" r="${Math.min(W, H) * 0.26}" fill="#d8ecff" opacity="0.48"/>`;
    }

    _watermark(W, H, isVertical) {
        return '';
    }

    _renderKeyText(item) {
        const parts = [item.word, item.phonetic ? `/${item.phonetic}/` : '', item.translation].filter(Boolean);
        return parts.join('  ');
    }

    _textBlock(lines, x, y, size, gap, fill, weight, anchor = 'start') {
        return lines.map((line, i) => `<text x="${x}" y="${y + i * gap}" text-anchor="${anchor}" font-size="${size}" fill="${fill}" font-weight="${weight}" font-family="Avenir Next, Arial, sans-serif">${this._e(line)}</text>`).join('');
    }

    _listBlock(lines, x, y, size, gap, fill, maxChars, maxLinesPerItem = 2) {
        const out = [];
        let lineIndex = 0;
        for (const line of lines) {
            const wrapped = this._wrapText(line, maxChars, maxLinesPerItem, /[\u3400-\u9fff]/.test(line));
            for (const sub of wrapped) {
                out.push(`<text x="${x}" y="${y + lineIndex * gap}" font-size="${size}" fill="${fill}" font-weight="750" font-family="Avenir Next, Arial">${this._e(sub)}</text>`);
                lineIndex++;
            }
        }
        return out.join('');
    }

    _reviewWordsBlock(lines, x, y, width, isVertical) {
        const cols = isVertical ? 1 : 2;
        const colGap = isVertical ? 0 : 80;
        const colW = Math.floor((width - colGap * (cols - 1)) / cols);
        const rowGap = isVertical ? 54 : 48;
        return lines.map((line, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            const tx = x + col * (colW + colGap);
            const ty = y + row * rowGap;
            const short = this._shorten(line, isVertical ? 34 : 38);
            return `<text x="${tx}" y="${ty}" font-size="${isVertical ? 32 : 27}" fill="#17231b" font-weight="800" font-family="Avenir Next, Arial">${this._e(short)}</text>`;
        }).join('');
    }

    _wrapText(text, maxChars, maxLines = 3, isCjk = false) {
        const raw = String(text || '').trim();
        if (!raw) return [];
        let lines = [];
        if (isCjk || !raw.includes(' ')) {
            for (let i = 0; i < raw.length; i += maxChars) lines.push(raw.slice(i, i + maxChars));
        } else {
            const words = raw.split(/\s+/);
            let current = '';
            for (const word of words) {
                if ((current + ' ' + word).trim().length > maxChars && current) {
                    lines.push(current);
                    current = word;
                } else {
                    current = current ? `${current} ${word}` : word;
                }
            }
            if (current) lines.push(current);
        }
        if (lines.length > maxLines) {
            lines = lines.slice(0, maxLines);
            lines[maxLines - 1] = this._shorten(lines[maxLines - 1], Math.max(4, maxChars - 1));
        }
        return lines;
    }

    _fitSentenceText(text, maxWidth, isVertical) {
        const raw = String(text || '').trim();
        const maxLines = isVertical ? 6 : 4;
        const candidates = isVertical ? [60, 56, 52, 48, 44] : [62, 58, 54, 50, 46, 42];
        for (const fontSize of candidates) {
            const maxChars = Math.max(isVertical ? 17 : 28, Math.floor(maxWidth / (fontSize * 0.68)));
            const lines = this._wrapText(raw, maxChars, maxLines);
            const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
            const estimatedWidth = longest * fontSize * 0.64;
            const blockHeight = lines.length * fontSize * (isVertical ? 1.34 : 1.25);
            const heightLimit = isVertical ? 430 : 255;
            if (estimatedWidth <= maxWidth && blockHeight <= heightLimit) {
                return { lines, fontSize };
            }
        }
        const fallbackFont = isVertical ? 42 : 42;
        const fallbackChars = Math.max(isVertical ? 16 : 26, Math.floor(maxWidth / (fallbackFont * 0.68)));
        return {
            lines: this._wrapText(raw, fallbackChars, maxLines),
            fontSize: fallbackFont
        };
    }

    _shorten(text, max) {
        const raw = String(text || '').trim();
        return raw.length > max ? `${raw.slice(0, Math.max(1, max - 1))}…` : raw;
    }

    _compactMeaning(text, max) {
        let raw = String(text || '').trim();
        if (raw.length > max && /[（(]/.test(raw)) {
            raw = raw.replace(/[（(][^）)]*[）)]/g, '').trim();
        }
        return this._shorten(raw, max);
    }

    _formatPhonetic(value) {
        const raw = String(value || '').trim().replace(/^\/+|\/+$/g, '');
        return raw ? `/${raw}/` : '';
    }

    _e(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    async _updateJob(jobId, fields) {
        const sets = [];
        const values = [];
        for (const [key, value] of Object.entries(fields)) {
            sets.push(`${key} = ?`);
            values.push(value);
        }
        if (!sets.length) return;
        values.push(jobId);
        await query(`UPDATE podcast_video_jobs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, values);
    }

    _cleanup(dir) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) {}
    }
}

module.exports = new PodcastVideoService();
