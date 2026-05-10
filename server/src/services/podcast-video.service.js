const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { query } = require('../config/database');
const voiceService = require('./voice.service');

const SERVER_ROOT = path.join(__dirname, '../..');
const OUTPUT_DIR = path.join(SERVER_ROOT, 'uploads/podcast-videos');
const FPS = 30;
const AUDIO_VOLUME = 1.45;
const SEGMENT_GAP = 0.18;

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
                ? { W: 1080, H: 1920, isVertical: true, maxSentences: Number(config.max_sentences || 5) }
                : { W: 1920, H: 1080, isVertical: false, maxSentences: Number(config.max_sentences || 0) };

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

            await this._renderCoverFrame(coverPath, content, prepared, dims, mode);
            const segments = [];
            let segmentIndex = 0;
            const addSegment = async (framePath, audioPath, duration, label) => {
                const out = path.join(segDir, `seg_${String(segmentIndex++).padStart(4, '0')}_${label}.mp4`);
                await this._imageToVideo(framePath, audioPath, duration, out, dims);
                segments.push(out);
            };

            await addSegment(coverPath, null, aspect === '9:16' ? 1.2 : 2.2, 'cover');
            await this._updateJob(jobId, { progress: 22 });

            // 第一遍：完整英文朗读。逐句播放，画面显示文章脉络并高亮当前句。
            for (let i = 0; i < prepared.sentences.length; i++) {
                const sentence = prepared.sentences[i];
                const frame = path.join(tempDir, `full_${String(i + 1).padStart(3, '0')}.png`);
                await this._renderListeningFrame(frame, content, prepared.sentences, i, dims, mode);
                const dur = Math.max(1.4, await this._getAudioDuration(sentence.femaleLocal)) + SEGMENT_GAP;
                await addSegment(frame, sentence.femaleLocal, dur, `full_${i + 1}`);
                await this._updateJob(jobId, { progress: 22 + Math.round(((i + 1) / prepared.sentences.length) * 28) });
            }

            // 第二遍：逐句训练。女声 -> 男声 -> 中文翻译发音(仅双语模板)。
            for (let i = 0; i < prepared.sentences.length; i++) {
                const sentence = prepared.sentences[i];
                const femaleFrame = path.join(tempDir, `train_${String(i + 1).padStart(3, '0')}_female.png`);
                const maleFrame = path.join(tempDir, `train_${String(i + 1).padStart(3, '0')}_male.png`);
                await this._renderTrainingFrame(femaleFrame, content, sentence, i, prepared.sentences.length, dims, mode, 'Female voice');
                await this._renderTrainingFrame(maleFrame, content, sentence, i, prepared.sentences.length, dims, mode, 'Male voice');
                await addSegment(femaleFrame, sentence.femaleLocal, Math.max(1.4, await this._getAudioDuration(sentence.femaleLocal)) + SEGMENT_GAP, `train_${i + 1}_female`);
                await addSegment(maleFrame, sentence.maleLocal, Math.max(1.4, await this._getAudioDuration(sentence.maleLocal)) + SEGMENT_GAP, `train_${i + 1}_male`);
                if (mode === 'bilingual' && sentence.translation && sentence.chineseLocal) {
                    const cnFrame = path.join(tempDir, `train_${String(i + 1).padStart(3, '0')}_cn.png`);
                    await this._renderTrainingFrame(cnFrame, content, sentence, i, prepared.sentences.length, dims, mode, 'Chinese meaning', 'translation');
                    await addSegment(cnFrame, sentence.chineseLocal, Math.max(1.2, await this._getAudioDuration(sentence.chineseLocal)) + SEGMENT_GAP, `train_${i + 1}_cn`);
                }
                await this._updateJob(jobId, { progress: 50 + Math.round(((i + 1) / prepared.sentences.length) * 38) });
            }

            const reviewFrame = path.join(tempDir, 'review.png');
            await this._renderReviewFrame(reviewFrame, content, prepared, dims, mode);
            await addSegment(reviewFrame, null, aspect === '9:16' ? 2.2 : 4.2, 'review');
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

    async _renderCoverFrame(outPath, content, prepared, dims, mode) {
        const { W, H, isVertical } = dims;
        const title = content.title_en || content.title || 'Listening Practice';
        const subtitle = content.title || content.category_name || '';
        const badge = mode === 'bilingual' ? 'Bilingual Listening' : 'English Listening';
        const titleLines = this._wrapText(title, isVertical ? 19 : 34, isVertical ? 4 : 3);
        const subLines = this._wrapText(subtitle, isVertical ? 16 : 30, 2, true);
        const titleSize = isVertical ? 76 : 78;
        const subSize = isVertical ? 36 : 34;
        const top = isVertical ? 310 : 230;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}
            <rect width="${W}" height="${H}" fill="url(#bg)"/>
            ${this._softShapes(W, H)}
            ${this._watermark(W, H, isVertical)}
            <rect x="${isVertical ? 64 : 132}" y="${top - 70}" width="${W - (isVertical ? 128 : 264)}" height="${isVertical ? 760 : 520}" rx="${isVertical ? 42 : 48}" fill="rgba(255,255,255,0.86)" stroke="rgba(42,122,83,0.16)"/>
            <text x="${W / 2}" y="${top}" text-anchor="middle" font-size="${isVertical ? 34 : 30}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">${this._e(badge)}</text>
            ${this._textBlock(titleLines, W / 2, top + (isVertical ? 110 : 100), titleSize, isVertical ? 92 : 88, '#102116', '900', 'middle')}
            ${this._textBlock(subLines, W / 2, top + (isVertical ? 480 : 350), subSize, subSize + 15, '#52635b', '700', 'middle')}
            <line x1="${W / 2 - (isVertical ? 210 : 270)}" x2="${W / 2 + (isVertical ? 210 : 270)}" y1="${H - (isVertical ? 420 : 230)}" y2="${H - (isVertical ? 420 : 230)}" stroke="#9cc8a8" stroke-width="4" stroke-linecap="round"/>
            <text x="${W / 2}" y="${H - (isVertical ? 350 : 170)}" text-anchor="middle" font-size="${isVertical ? 34 : 30}" fill="#355548" font-weight="800" font-family="Avenir Next, Arial">${prepared.sentences.length} sentences · BookMelo</text>
        </svg>`;
        await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outPath);
    }

    async _renderListeningFrame(outPath, content, sentences, activeIndex, dims, mode) {
        const { W, H, isVertical } = dims;
        const title = content.title_en || content.title || 'Listening Practice';
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
        let y = panelY + (isVertical ? 112 : 98);
        const rows = visible.map((s, idx) => {
            const actualIndex = start + idx;
            const active = actualIndex === activeIndex;
            const lines = this._wrapText(s.text, isVertical ? 31 : 78, active ? 3 : 2);
            const rowH = Math.max(lineGap, lines.length * (lineSize + 10) + 20);
            const rowY = y;
            y += rowH + (isVertical ? 16 : 10);
            return `<g>
                <rect x="${panelX + 36}" y="${rowY - lineSize}" width="${panelW - 72}" height="${rowH}" rx="24" fill="${active ? '#e8f6e9' : 'rgba(255,255,255,0.58)'}" stroke="${active ? '#72b77e' : 'rgba(39,94,62,0.08)'}" stroke-width="${active ? 3 : 1}"/>
                <text x="${panelX + 66}" y="${rowY}" font-size="${isVertical ? 26 : 24}" fill="${active ? '#2d7a47' : '#8b9b91'}" font-weight="900" font-family="Avenir Next, Arial">${actualIndex + 1}</text>
                ${this._textBlock(lines, panelX + 118, rowY, active ? lineSize + 2 : lineSize - 3, lineSize + 13, active ? '#102116' : '#596960', active ? '900' : '650', 'start')}
            </g>`;
        }).join('');
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}<rect width="${W}" height="${H}" fill="url(#bg)"/>${this._softShapes(W, H)}${this._watermark(W, H, isVertical)}
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
        const title = content.title_en || content.title || 'Listening Practice';
        const maxChars = isVertical ? 25 : 58;
        const sentenceLines = this._wrapText(sentence.text, maxChars, isVertical ? 6 : 4);
        const translationLines = mode === 'bilingual' && sentence.translation ? this._wrapText(sentence.translation, isVertical ? 18 : 44, 2, true) : [];
        const words = (sentence.words || []).slice(0, isVertical ? 3 : 5);
        const grammar = sentence.grammar || '';
        const panelX = isVertical ? 58 : 120;
        const mainY = isVertical ? 260 : 178;
        const mainW = W - panelX * 2;
        const mainH = isVertical ? 700 : 420;
        const keyY = mainY + mainH + (isVertical ? 46 : 36);
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}<rect width="${W}" height="${H}" fill="url(#bg)"/>${this._softShapes(W, H)}${this._watermark(W, H, isVertical)}
            <text x="${panelX}" y="${isVertical ? 140 : 84}" font-size="${isVertical ? 28 : 24}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">SENTENCE TRAINING</text>
            <text x="${panelX}" y="${isVertical ? 195 : 124}" font-size="${isVertical ? 36 : 32}" fill="#17231b" font-weight="900" font-family="Avenir Next, Arial">${this._e(this._shorten(title, isVertical ? 28 : 62))}</text>
            <rect x="${panelX}" y="${mainY}" width="${mainW}" height="${mainH}" rx="42" fill="rgba(255,255,255,0.88)" stroke="${highlight === 'translation' ? '#e8b65f' : '#72b77e'}" stroke-width="4"/>
            <text x="${panelX + 46}" y="${mainY + 64}" font-size="${isVertical ? 30 : 26}" fill="#5e7668" font-weight="900" font-family="Avenir Next, Arial">${this._e(voiceLabel)} · ${index + 1}/${total}</text>
            ${this._textBlock(sentenceLines, panelX + 54, mainY + (isVertical ? 165 : 145), isVertical ? 56 : 48, isVertical ? 76 : 64, '#102116', '900', 'start')}
            ${translationLines.length ? this._textBlock(translationLines, panelX + 56, mainY + mainH - (isVertical ? 170 : 115), isVertical ? 34 : 30, isVertical ? 48 : 42, highlight === 'translation' ? '#b27714' : '#5e7668', '800', 'start') : ''}
            ${this._renderKeyPanel(panelX, keyY, mainW, H - keyY - (isVertical ? 145 : 80), words, grammar, dims)}
            <text x="${W - panelX}" y="${H - (isVertical ? 86 : 48)}" text-anchor="end" font-size="${isVertical ? 24 : 22}" fill="#789083" font-weight="800" font-family="Avenir Next, Arial">BookMelo Listening Lab</text>
        </svg>`;
        await sharp(Buffer.from(svg)).png().toFile(outPath);
    }

    _renderKeyPanel(x, y, w, h, words, grammar, dims) {
        const { isVertical } = dims;
        const visibleWords = words.slice(0, isVertical ? 3 : 4);
        const chips = words.map((item, idx) => {
            const word = this._shorten(item.word || '', isVertical ? 18 : 22);
            const meaning = this._shorten(item.translation || item.pos || '', isVertical ? 12 : 12);
            const cols = isVertical ? 1 : 2;
            const chipGap = isVertical ? 18 : 24;
            const chipW = isVertical ? w - 68 : Math.floor((w - 92 - chipGap) / cols);
            const cx = isVertical ? x + 34 : x + 46 + (idx % cols) * (chipW + chipGap);
            const cy = isVertical ? y + 128 + idx * 82 : y + 120 + Math.floor(idx / cols) * 82;
            const wordSize = isVertical ? 25 : (word.length > 16 ? 22 : 24);
            const meaningSize = isVertical ? 20 : 19;
            return `<g><rect x="${cx}" y="${cy - 42}" width="${chipW}" height="62" rx="31" fill="#f3faf4" stroke="#cbe8d1"/>
                <text x="${cx + 24}" y="${cy - 6}" font-size="${wordSize}" fill="#213429" font-weight="900" font-family="Avenir Next, Arial">${this._e(word)}</text>
                ${meaning ? `<text x="${cx + chipW - 24}" y="${cy - 7}" text-anchor="end" font-size="${meaningSize}" fill="#5f7b69" font-weight="700" font-family="Avenir Next, Arial">${this._e(meaning)}</text>` : ''}</g>`;
        }).slice(0, isVertical ? 3 : 4).join('');
        const grammarLines = this._wrapText(grammar || 'Listen for the sentence rhythm and key expression.', isVertical ? 24 : 64, isVertical ? 3 : 2, /[\u3400-\u9fff]/.test(grammar || ''));
        const patternY = isVertical ? y + 385 : y + 270;
        return `<g>
            <rect x="${x}" y="${y}" width="${w}" height="${Math.max(180, h)}" rx="34" fill="rgba(255,255,255,0.72)" stroke="rgba(39,94,62,0.10)"/>
            <text x="${x + 34}" y="${y + 48}" font-size="${isVertical ? 24 : 22}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">KEY WORDS / GRAMMAR</text>
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
        const wordLines = (words.length ? words.slice(0, isVertical ? 5 : 6).map(w => `${w.word}${w.translation ? ` - ${w.translation}` : ''}`) : ['Listen again and notice the main expressions.']);
        const grammarLines = (grammars.length ? grammars.slice(0, isVertical ? 2 : 3) : ['Review the sentence rhythm.', 'Repeat the useful sentence patterns.']);
        const x = isVertical ? 70 : 150;
        const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
            ${this._defs()}<rect width="${W}" height="${H}" fill="url(#bg)"/>${this._softShapes(W, H)}${this._watermark(W, H, isVertical)}
            <text x="${x}" y="${isVertical ? 220 : 150}" font-size="${isVertical ? 62 : 60}" fill="#102116" font-weight="950" font-family="Avenir Next, Arial">Review</text>
            <rect x="${x}" y="${isVertical ? 295 : 225}" width="${W - x * 2}" height="${isVertical ? 560 : 310}" rx="38" fill="rgba(255,255,255,0.84)"/>
            <text x="${x + 44}" y="${isVertical ? 360 : 285}" font-size="${isVertical ? 30 : 28}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">Key words</text>
            ${this._reviewWordsBlock(wordLines, x + 48, isVertical ? 430 : 345, W - x * 2 - 96, isVertical)}
            <rect x="${x}" y="${isVertical ? 920 : 590}" width="${W - x * 2}" height="${isVertical ? 430 : 290}" rx="38" fill="rgba(255,255,255,0.74)"/>
            <text x="${x + 44}" y="${isVertical ? 988 : 650}" font-size="${isVertical ? 30 : 28}" fill="#8a651f" font-weight="900" font-family="Avenir Next, Arial">Patterns</text>
            ${this._listBlock(grammarLines, x + 48, isVertical ? 1060 : 710, isVertical ? 27 : 24, isVertical ? 46 : 40, '#5d4c26', isVertical ? 25 : 58, isVertical ? 2 : 2)}
            <text x="${W / 2}" y="${H - (isVertical ? 170 : 90)}" text-anchor="middle" font-size="${isVertical ? 34 : 30}" fill="#2d7a47" font-weight="900" font-family="Avenir Next, Arial">The End · BookMelo</text>
        </svg>`;
        await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(outPath);
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

    _defs() {
        return `<defs>
            <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#f6fbf3"/>
                <stop offset="48%" stop-color="#eef8ed"/>
                <stop offset="100%" stop-color="#e7f1eb"/>
            </linearGradient>
            <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#25543b" flood-opacity="0.13"/></filter>
        </defs>`;
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

    _shorten(text, max) {
        const raw = String(text || '').trim();
        return raw.length > max ? `${raw.slice(0, Math.max(1, max - 1))}…` : raw;
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
