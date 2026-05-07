/**
 * Google AI 中转代理服务（Vertex AI）
 * 运行在美国本地服务器，专门处理需要访问 Google API 的请求
 * 腾讯云服务器通过此代理调用 Google Gemini AI
 */
const express = require('express');
const axios = require('axios');
const path = require('path');
const sharp = require('sharp');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const vertexAuth = require('../src/utils/vertex-auth');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PROXY_PORT || 3005;
const API_KEY = process.env.PROXY_API_KEY;

function getTargetSizeByAspectRatio(aspectRatio = '') {
    const val = String(aspectRatio || '').trim();
    if (!val) return null;
    if (val === '16:9') return { width: 1280, height: 720 };
    if (val === '9:16') return { width: 720, height: 1280 };
    return null;
}

function buildGoogleTtsPrompt(text, speed = 1.0) {
    if (speed <= 0.9) {
        return `Read this slowly, gently, and clearly for a child listener: ${text}`;
    }
    if (speed >= 1.1) {
        return `Read this clearly with a lively pace: ${text}`;
    }
    return `Read this clearly in a warm, natural voice: ${text}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const PROXY_TTS_MIN_INTERVAL_MS = Math.max(
    1000,
    Number(process.env.PROXY_TTS_MIN_INTERVAL_MS || 15000)
);
const PROXY_TTS_COOLDOWN_MS = Math.max(
    PROXY_TTS_MIN_INTERVAL_MS,
    Number(process.env.PROXY_TTS_COOLDOWN_MS || 10 * 60 * 1000)
);

let ttsQueue = Promise.resolve();
let ttsLastRequestAt = 0;
let ttsCooldownUntil = 0;
const PROXY_IMAGE_MIN_INTERVAL_MS = Math.max(
    1000,
    Number(process.env.PROXY_IMAGE_MIN_INTERVAL_MS || 10000)
);
const PROXY_IMAGE_COOLDOWN_MS = Math.max(
    PROXY_IMAGE_MIN_INTERVAL_MS,
    Number(process.env.PROXY_IMAGE_COOLDOWN_MS || 60 * 1000)
);
let imageQueue = Promise.resolve();
let imageLastRequestAt = 0;
let imageCooldownUntil = 0;
const PROXY_ANALYZE_MIN_INTERVAL_MS = Math.max(
    1000,
    Number(process.env.PROXY_ANALYZE_MIN_INTERVAL_MS || 20000)
);
const PROXY_ANALYZE_COOLDOWN_MS = Math.max(
    PROXY_ANALYZE_MIN_INTERVAL_MS,
    Number(process.env.PROXY_ANALYZE_COOLDOWN_MS || 120 * 1000)
);
let analyzeQueue = Promise.resolve();
let analyzeLastRequestAt = 0;
let analyzeCooldownUntil = 0;

function getUpstreamError(error) {
    const status = error?.response?.status || 500;
    const errObj = error?.response?.data?.error || {};
    const code = errObj.status || '';
    const message = errObj.message || error?.message || 'Upstream request failed';
    return { status, code, message: String(message) };
}

function isRateLimitedUpstreamError(error) {
    const { status, code, message } = getUpstreamError(error);
    return status === 429
        || code === 'RESOURCE_EXHAUSTED'
        || /resource exhausted|quota exceeded|try again later|too many requests/i.test(message);
}

function isRetryableUpstreamError(error) {
    const { status, code, message } = getUpstreamError(error);
    const networkCode = String(error?.code || '').toUpperCase();
    return status === 429
        || status >= 500
        || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(networkCode)
        || code === 'RESOURCE_EXHAUSTED'
        || /timeout|resource exhausted|quota exceeded|try again later/i.test(message);
}

function mapProxyStatus(error) {
    const { status, code, message } = getUpstreamError(error);
    if (status === 429 || code === 'RESOURCE_EXHAUSTED' || /resource exhausted|quota exceeded|try again later/i.test(message)) {
        return 429;
    }
    if (status >= 400 && status < 500) return status;
    return 500;
}

function stripMarkdownJsonFence(rawText = '') {
    return String(rawText || '')
        .replace(/```json\n?/gi, '')
        .replace(/```\n?/g, '')
        .trim();
}

function extractJsonObjectText(rawText = '') {
    const cleaned = stripMarkdownJsonFence(rawText);

    if (!cleaned) return '';

    const firstBrace = cleaned.indexOf('{');
    if (firstBrace < 0) return cleaned;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = firstBrace; i < cleaned.length; i++) {
        const ch = cleaned[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') {
            depth++;
            continue;
        }
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                return cleaned.slice(firstBrace, i + 1);
            }
        }
    }

    return cleaned;
}

function normalizeLikelyJsonText(rawText = '') {
    return stripMarkdownJsonFence(rawText)
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
        .trim();
}

function sanitizePictureBookWordEntry(entry) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const word = String(entry.word || entry.term || entry.text || '').trim();
    if (!word) return null;
    return {
        word,
        phonetic: String(entry.phonetic || entry.pronunciation || '').trim(),
        pos: String(entry.pos || entry.partOfSpeech || '').trim(),
        translation: String(entry.translation || entry.meaning || entry.chinese || '').trim()
    };
}

function tryParsePictureBookWordsJson(candidateText = '') {
    if (!candidateText) return null;
    const parsed = JSON.parse(candidateText);
    const words = Array.isArray(parsed?.words) ? parsed.words.map(sanitizePictureBookWordEntry).filter(Boolean) : null;
    if (!words) return null;
    return { words, parsed };
}

function salvagePictureBookWords(rawText = '') {
    const cleaned = normalizeLikelyJsonText(rawText);
    const wordsKeyIndex = cleaned.indexOf('"words"');
    if (wordsKeyIndex < 0) return [];
    const arrayStart = cleaned.indexOf('[', wordsKeyIndex);
    if (arrayStart < 0) return [];

    const items = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let objectStart = -1;

    for (let i = arrayStart + 1; i < cleaned.length; i++) {
        const ch = cleaned[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') {
            if (depth === 0) objectStart = i;
            depth++;
            continue;
        }
        if (ch === '}') {
            depth--;
            if (depth === 0 && objectStart >= 0) {
                const candidate = cleaned.slice(objectStart, i + 1);
                try {
                    const parsed = JSON.parse(candidate);
                    const normalized = sanitizePictureBookWordEntry(parsed);
                    if (normalized) items.push(normalized);
                } catch (_) {}
                objectStart = -1;
            }
            continue;
        }
        if (ch === ']' && depth === 0) {
            break;
        }
    }

    return items;
}

function truncateForLog(text = '', max = 4000) {
    const s = String(text || '');
    return s.length <= max ? s : `${s.slice(0, max)}\n...[truncated ${s.length - max} chars]`;
}

function parsePictureBookWordsResponse(rawText = '') {
    const candidates = [];
    const stripped = stripMarkdownJsonFence(rawText);
    const extracted = extractJsonObjectText(rawText);
    const normalized = normalizeLikelyJsonText(rawText);
    const extractedNormalized = normalizeLikelyJsonText(extracted);

    for (const text of [stripped, extracted, normalized, extractedNormalized]) {
        if (text && !candidates.includes(text)) candidates.push(text);
    }

    let lastError = null;
    for (const candidate of candidates) {
        try {
            const result = tryParsePictureBookWordsJson(candidate);
            if (result) return { words: result.words, recovered: candidate !== stripped };
        } catch (error) {
            lastError = error;
        }
    }

    const salvagedWords = salvagePictureBookWords(rawText);
    if (salvagedWords.length > 0) {
        return { words: salvagedWords, recovered: true, salvaged: true };
    }

    throw lastError || new Error('AI返回格式错误: 无法解析 words JSON');
}

async function withRetry(label, taskFn, options = {}) {
    const {
        maxAttempts = 3,
        baseDelayMs = 1200,
        retryOnRateLimit = true
    } = options;

    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await taskFn();
        } catch (error) {
            lastError = error;
            if (!retryOnRateLimit && isRateLimitedUpstreamError(error)) {
                throw error;
            }
            if (!isRetryableUpstreamError(error) || attempt >= maxAttempts) {
                throw error;
            }
            const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
            console.warn(`[Proxy] ${label} retry ${attempt}/${maxAttempts}, wait=${waitMs}ms`);
            await sleep(waitMs);
        }
    }
    throw lastError || new Error(`${label} failed`);
}

function getTtsCooldownRemainingMs() {
    return Math.max(0, ttsCooldownUntil - Date.now());
}

function createTtsCooldownError(remainingMs) {
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const error = new Error(`Google TTS 正在冷却，请在 ${seconds} 秒后重试`);
    error.response = {
        status: 429,
        data: {
            error: {
                status: 'RESOURCE_EXHAUSTED',
                message: `Google TTS 正在冷却，请在 ${seconds} 秒后重试`
            }
        }
    };
    error.retryAfterMs = remainingMs;
    return error;
}

async function enqueueTtsRequest(taskFn) {
    const run = async () => {
        const cooldownRemainingMs = getTtsCooldownRemainingMs();
        if (cooldownRemainingMs > 0) {
            throw createTtsCooldownError(cooldownRemainingMs);
        }

        const waitMs = Math.max(0, PROXY_TTS_MIN_INTERVAL_MS - (Date.now() - ttsLastRequestAt));
        if (waitMs > 0) {
            console.log(`[Proxy] TTS 限速等待 ${waitMs}ms`);
            await sleep(waitMs);
        }

        ttsLastRequestAt = Date.now();

        try {
            return await taskFn();
        } catch (error) {
            if (isRateLimitedUpstreamError(error)) {
                ttsCooldownUntil = Math.max(ttsCooldownUntil, Date.now() + PROXY_TTS_COOLDOWN_MS);
                error.retryAfterMs = error.retryAfterMs || PROXY_TTS_COOLDOWN_MS;
                console.warn(`[Proxy] TTS 触发冷却，持续 ${error.retryAfterMs}ms`);
            }
            throw error;
        }
    };

    const current = ttsQueue.then(run, run);
    ttsQueue = current.catch(() => {});
    return current;
}

function getImageCooldownRemainingMs() {
    return Math.max(0, imageCooldownUntil - Date.now());
}

function createImageCooldownError(remainingMs) {
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const error = new Error(`图片生成正在冷却，请在 ${seconds} 秒后重试`);
    error.response = {
        status: 429,
        data: {
            error: {
                status: 'RESOURCE_EXHAUSTED',
                message: `图片生成正在冷却，请在 ${seconds} 秒后重试`
            }
        }
    };
    error.retryAfterMs = remainingMs;
    return error;
}

async function enqueueImageRequest(taskFn) {
    const run = async () => {
        const cooldownRemainingMs = getImageCooldownRemainingMs();
        if (cooldownRemainingMs > 0) {
            throw createImageCooldownError(cooldownRemainingMs);
        }

        const waitMs = Math.max(0, PROXY_IMAGE_MIN_INTERVAL_MS - (Date.now() - imageLastRequestAt));
        if (waitMs > 0) {
            console.log(`[Proxy] Image 限速等待 ${waitMs}ms`);
            await sleep(waitMs);
        }

        imageLastRequestAt = Date.now();

        try {
            return await taskFn();
        } catch (error) {
            if (isRateLimitedUpstreamError(error)) {
                imageCooldownUntil = Math.max(imageCooldownUntil, Date.now() + PROXY_IMAGE_COOLDOWN_MS);
                error.retryAfterMs = error.retryAfterMs || PROXY_IMAGE_COOLDOWN_MS;
                console.warn(`[Proxy] Image 触发冷却，持续 ${error.retryAfterMs}ms`);
            }
            throw error;
        }
    };

    const current = imageQueue.then(run, run);
    imageQueue = current.catch(() => {});
    return current;
}

function getAnalyzeCooldownRemainingMs() {
    return Math.max(0, analyzeCooldownUntil - Date.now());
}

function createAnalyzeCooldownError(remainingMs) {
    const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
    const error = new Error(`绘本词汇分析正在冷却，请在 ${seconds} 秒后重试`);
    error.response = {
        status: 429,
        data: {
            error: {
                status: 'RESOURCE_EXHAUSTED',
                message: `绘本词汇分析正在冷却，请在 ${seconds} 秒后重试`
            }
        }
    };
    error.retryAfterMs = remainingMs;
    return error;
}

async function enqueueAnalyzeRequest(taskFn) {
    const run = async () => {
        const cooldownRemainingMs = getAnalyzeCooldownRemainingMs();
        if (cooldownRemainingMs > 0) {
            throw createAnalyzeCooldownError(cooldownRemainingMs);
        }

        const waitMs = Math.max(0, PROXY_ANALYZE_MIN_INTERVAL_MS - (Date.now() - analyzeLastRequestAt));
        if (waitMs > 0) {
            console.log(`[Proxy] Analyze 限速等待 ${waitMs}ms`);
            await sleep(waitMs);
        }

        analyzeLastRequestAt = Date.now();

        try {
            return await taskFn();
        } catch (error) {
            if (isRateLimitedUpstreamError(error)) {
                analyzeCooldownUntil = Math.max(analyzeCooldownUntil, Date.now() + PROXY_ANALYZE_COOLDOWN_MS);
                error.retryAfterMs = error.retryAfterMs || PROXY_ANALYZE_COOLDOWN_MS;
                console.warn(`[Proxy] Analyze 触发冷却，持续 ${error.retryAfterMs}ms`);
            }
            throw error;
        }
    };

    const current = analyzeQueue.then(run, run);
    analyzeQueue = current.catch(() => {});
    return current;
}

// ==================== 鉴权中间件 ====================

function auth(req, res, next) {
    if (!API_KEY) return next(); // 未配置则跳过（仅开发调试用）
    if (req.headers['x-proxy-key'] !== API_KEY) {
        return res.status(401).json({ success: false, error: '无效的 Proxy API Key' });
    }
    next();
}

// ==================== 健康检查 ====================

app.get('/proxy/health', (req, res) => {
    res.json({
        success: true,
        service: 'Google AI Proxy (Vertex AI)',
        vertexAI: vertexAuth.isConfigured ? 'configured' : 'MISSING',
        project: process.env.GOOGLE_CLOUD_PROJECT || 'NOT SET',
        region: process.env.GOOGLE_CLOUD_REGION || 'us-central1',
        time: new Date().toISOString()
    });
});

// ==================== 图片生成 ====================
/**
 * POST /proxy/generate-image
 * body: { prompt } - 完整的图片生成提示词（由腾讯云服务器构建好再传入）
 * response: { success, imageData (base64), mimeType }
 */
app.post('/proxy/generate-image', auth, async (req, res) => {
    const { prompt, aspectRatio = '' } = req.body || {};
    if (!prompt) {
        return res.status(400).json({ success: false, error: '缺少 prompt 参数' });
    }

    if (!vertexAuth.isConfigured) {
        return res.status(500).json({ success: false, error: '未配置 Vertex AI' });
    }

    try {
        console.log(`[Proxy] 生成图片 (Vertex AI), prompt: ${prompt.substring(0, 80)}... aspectRatio=${aspectRatio || 'auto'}`);

        const headers = await vertexAuth.getAuthHeaders();
        let rawBuffer = null;

        await enqueueImageRequest(async () => {
            // Gemini 图片生成模型 fallback 链：3.1 Flash → 3 Pro
            const IMAGE_MODELS = [
                'gemini-3.1-flash-image-preview',
                'gemini-3-pro-image-preview'
            ];

            for (let i = 0; i < IMAGE_MODELS.length; i++) {
                const model = IMAGE_MODELS[i];
                try {
                    const response = await withRetry(
                        `generate-image(${model})`,
                        () => axios.post(
                            vertexAuth.getUrl(model),
                            {
                                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                                generationConfig: { responseModalities: ['image', 'text'] }
                            },
                            { headers, timeout: 180000 }
                        ),
                        { maxAttempts: 2, baseDelayMs: 30000, retryOnRateLimit: false }
                    );

                    const parts = response.data.candidates?.[0]?.content?.parts || [];
                    for (const part of parts) {
                        if (part.inlineData?.mimeType?.startsWith('image/')) {
                            rawBuffer = Buffer.from(part.inlineData.data, 'base64');
                            break;
                        }
                    }
                    if (rawBuffer) {
                        console.log(`[Proxy] 模型 ${model} 生成成功`);
                        return response.data;
                    }
                } catch (err) {
                    console.warn(`[Proxy] 模型 ${model} 失败: ${getUpstreamError(err).message}`);
                    if (i < IMAGE_MODELS.length - 1) {
                        console.log(`[Proxy] 降级到 ${IMAGE_MODELS[i + 1]}`);
                    } else {
                        throw err; // 所有模型都失败，抛出最后的错误
                    }
                }
            }
            return null;
        });

        if (!rawBuffer) {
            return res.json({ success: false, error: '图片生成未返回有效数据，请稍后重试' });
        }

        const rawKB = Math.round(rawBuffer.length / 1024);
        const targetSize = getTargetSizeByAspectRatio(aspectRatio);
        const compressed = targetSize
            // 指定画幅时，强制输出精确比例（中心裁切），避免后续视频链路出现细黑边
            ? await sharp(rawBuffer)
                .resize(targetSize.width, targetSize.height, { fit: 'cover', position: 'centre' })
                .jpeg({ quality: 85, progressive: true })
                .toBuffer()
            // 未指定画幅时沿用原逻辑
            : await sharp(rawBuffer)
                .resize(1080, null, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 85, progressive: true })
                .toBuffer();

        console.log(`[Proxy] 图片生成成功, 原始 ${rawKB}KB → 压缩后 ${Math.round(compressed.length / 1024)}KB`);
        return res.json({
            success: true,
            imageData: compressed.toString('base64'),
            mimeType: 'image/jpeg'
        });
    } catch (error) {
        const up = getUpstreamError(error);
        const status = mapProxyStatus(error);
        const retryAfterMs = error.retryAfterMs || (status === 429 ? getImageCooldownRemainingMs() : 0);
        console.error('[Proxy] generate-image error:', status, up.code, up.message);
        if (status === 429 && retryAfterMs > 0) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        }
        res.status(status).json({
            success: false,
            error: up.message,
            code: up.code,
            retryAfterMs: status === 429 && retryAfterMs > 0 ? retryAfterMs : undefined
        });
    }
});

// ==================== Gemini 通用文本生成 ====================
/**
 * POST /proxy/gemini-text
 * body: { prompt }
 * response: { success, text }
 */
app.post('/proxy/gemini-text', auth, async (req, res) => {
    const { prompt } = req.body;
    if (!prompt) {
        return res.status(400).json({ success: false, error: '缺少 prompt 参数' });
    }

    try {
        const headers = await vertexAuth.getAuthHeaders();
        const response = await enqueueAnalyzeRequest(() => withRetry(
            'gemini-text',
            () => axios.post(
                vertexAuth.getUrl('gemini-2.5-flash'),
                {
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
                },
                { headers, timeout: 60000 }
            ),
            { maxAttempts: 2, baseDelayMs: 30000, retryOnRateLimit: false }
        ));

        const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            return res.json({ success: true, text });
        }
        res.json({ success: false, error: 'Gemini 未返回文本' });
    } catch (error) {
        const up = getUpstreamError(error);
        const status = mapProxyStatus(error);
        const retryAfterMs = error.retryAfterMs || (status === 429 ? getAnalyzeCooldownRemainingMs() : 0);
        console.error('[Proxy] gemini-text error:', status, up.code, up.message);
        if (status === 429 && retryAfterMs > 0) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        }
        res.status(status).json({
            success: false,
            error: up.message,
            code: up.code,
            retryAfterMs: status === 429 && retryAfterMs > 0 ? retryAfterMs : undefined
        });
    }
});

// ==================== Veo 视频生成（长任务） ====================

async function fetchRemoteAsBase64(fileUrl) {
    const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
    const buffer = Buffer.from(response.data);
    return {
        base64: buffer.toString('base64'),
        mimeType: response.headers['content-type'] || 'image/jpeg'
    };
}

/**
 * POST /proxy/veo/start
 * body: { prompt, referenceImageUrl?, modelId?, durationSeconds?, aspectRatio?, resolution? }
 * response: { success, operationName, modelId }
 */
app.post('/proxy/veo/start', auth, async (req, res) => {
    const {
        prompt,
        referenceImageUrl = '',
        modelId = (process.env.VEO_MODEL_ID || 'veo-3.1-fast-generate-001'),
        durationSeconds = 4,
        aspectRatio = '16:9',
        resolution = '720p'
    } = req.body || {};

    if (!prompt) {
        return res.status(400).json({ success: false, error: '缺少 prompt 参数' });
    }
    if (!vertexAuth.isConfigured) {
        return res.status(500).json({ success: false, error: '未配置 Vertex AI' });
    }

    try {
        const instance = { prompt };
        if (referenceImageUrl) {
            const ref = await fetchRemoteAsBase64(referenceImageUrl);
            instance.image = {
                bytesBase64Encoded: ref.base64,
                mimeType: ref.mimeType
            };
        }

        const headers = await vertexAuth.getAuthHeaders();
        const response = await axios.post(
            vertexAuth.getUrl(modelId, 'predictLongRunning'),
            {
                instances: [instance],
                parameters: {
                    sampleCount: 1,
                    durationSeconds,
                    aspectRatio,
                    resolution,
                    generateAudio: false
                }
            },
            { headers, timeout: 90000 }
        );

        const operationName = response.data?.name;
        if (!operationName) {
            return res.json({ success: false, error: 'Veo 未返回 operationName' });
        }

        res.json({ success: true, operationName, modelId });
    } catch (error) {
        console.error('[Proxy] veo/start error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.error?.message || error.message
        });
    }
});

/**
 * POST /proxy/veo/poll
 * body: { operationName, modelId? }
 * response: { success, done, video? }
 */
app.post('/proxy/veo/poll', auth, async (req, res) => {
    const {
        operationName,
        modelId = (process.env.VEO_MODEL_ID || 'veo-3.1-fast-generate-001')
    } = req.body || {};

    if (!operationName) {
        return res.status(400).json({ success: false, error: '缺少 operationName 参数' });
    }
    if (!vertexAuth.isConfigured) {
        return res.status(500).json({ success: false, error: '未配置 Vertex AI' });
    }

    try {
        const headers = await vertexAuth.getAuthHeaders();
        const response = await axios.post(
            vertexAuth.getUrl(modelId, 'fetchPredictOperation'),
            { operationName },
            { headers, timeout: 90000 }
        );

        const op = response.data || {};
        if (!op.done) return res.json({ success: true, done: false });

        if (op.error) {
            return res.json({
                success: false,
                done: true,
                error: op.error.message || op.error.code || 'Veo 任务失败'
            });
        }

        const videos = op.response?.videos || [];
        const first = videos[0];
        if (!first) {
            return res.json({ success: false, done: true, error: 'Veo 未返回视频数据' });
        }

        const video = {
            mimeType: first.mimeType || 'video/mp4',
            bytesBase64Encoded: first.bytesBase64Encoded || '',
            gcsUri: first.gcsUri || ''
        };

        return res.json({ success: true, done: true, video });
    } catch (error) {
        console.error('[Proxy] veo/poll error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: error.response?.data?.error?.message || error.message
        });
    }
});

// ==================== 单词增强 ====================
/**
 * POST /proxy/enhance-word
 * body: { word, translation, prompt? }
 *   - prompt: 可选，传入时直接使用该提示词（由腾讯云服务器从数据库读取模板后构建）
 * response: { success, data: { phonetic, translation, example_sentence, ... } }
 */
app.post('/proxy/enhance-word', auth, async (req, res) => {
    const { word, translation, prompt: customPrompt } = req.body;
    const requestedEngine = String(req.body?.engine || 'gemini').trim().toLowerCase();
    const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
    if (!word) {
        return res.status(400).json({ success: false, error: '缺少 word 参数' });
    }

    if (requestedEngine === 'deepseek' && !hasDeepSeek) {
        return res.status(500).json({ success: false, error: '未配置 DeepSeek API' });
    }

    if (requestedEngine !== 'deepseek' && !vertexAuth.isConfigured) {
        return res.status(500).json({ success: false, error: '未配置 Vertex AI' });
    }

    try {
        const needTranslation = !translation || !translation.trim();

        const prompt = customPrompt || `You are an English teacher creating learning materials for Chinese children (ages 5-10).

For the English word "${word}"${needTranslation ? '' : ` (meaning: ${translation})`}, please provide:

1. phonetic: IPA phonetic transcription (e.g., /ˈæpl/)
${needTranslation ? '2. translation: Chinese translation of the word\n' : ''}3. example_sentence: A simple, fun English sentence using this word (max 10 words, suitable for children)
4. example_translation: Chinese translation of the example sentence
5. grammar_explanation: Brief grammar analysis in Chinese (2-3 sentences)

Respond ONLY with a valid JSON object:
{
  "phonetic": "/ˈæpl/",
  ${needTranslation ? '"translation": "苹果",' : ''}
  "example_sentence": "I like to eat apples.",
  "example_translation": "我喜欢吃苹果。",
  "grammar_explanation": "这是一个简单的主谓宾句式。I(主语)+like(谓语)+to eat apples(宾语)。"
}`;

        console.log(`[Proxy] 增强单词: ${word}, engine=${requestedEngine}`);

        let text = '';
        if (requestedEngine === 'deepseek') {
            const response = await axios.post(
                'https://api.deepseek.com/chat/completions',
                {
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: 'You are a JSON-only assistant. Return ONLY valid JSON, no markdown, no explanation.' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.2,
                    max_tokens: 1024,
                    response_format: { type: 'json_object' }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 60000
                }
            );
            text = response.data?.choices?.[0]?.message?.content || '';
        } else {
            const headers = await vertexAuth.getAuthHeaders();
            const response = await enqueueAnalyzeRequest(() => withRetry(
                'enhance-word',
                () => axios.post(
                    vertexAuth.getUrl('gemini-2.5-flash'),
                    {
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
                    },
                    { headers, timeout: 30000 }
                ),
                { maxAttempts: 2, baseDelayMs: 30000, retryOnRateLimit: false }
            ));
            text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }

        if (text) {
            const jsonText = extractJsonObjectText(text);
            if (jsonText) {
                const data = JSON.parse(jsonText);
                console.log(`[Proxy] 单词增强成功: ${word}`);
                return res.json({ success: true, data });
            }
        }

        res.json({ success: false, error: '无法解析 AI 响应' });
    } catch (error) {
        const up = getUpstreamError(error);
        const status = mapProxyStatus(error);
        const retryAfterMs = error.retryAfterMs || (status === 429 ? getAnalyzeCooldownRemainingMs() : 0);
        console.error('[Proxy] enhance-word error:', status, up.code, up.message);
        if (status === 429 && retryAfterMs > 0) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        }
        res.status(status).json({
            success: false,
            error: up.message,
            code: up.code,
            retryAfterMs: status === 429 && retryAfterMs > 0 ? retryAfterMs : undefined
        });
    }
});

// ==================== Google TTS ====================
/**
 * POST /proxy/tts
 * body: { text, voice }
 * response: { success, audioData (base64 WAV), ext }
 */
app.post('/proxy/tts', auth, async (req, res) => {
    const { text, voice = 'female', speed = 1.0 } = req.body;
    if (!text) {
        return res.status(400).json({ success: false, error: '缺少 text 参数' });
    }

    if (!vertexAuth.isConfigured) {
        return res.status(500).json({ success: false, error: '未配置 Vertex AI' });
    }

    try {
        const voiceMap = { male: 'Puck', female: 'Aoede' };
        const voiceName = voiceMap[voice] || 'Aoede';

        console.log(`[Proxy] Google TTS (Vertex AI): "${text.substring(0, 40)}", voice: ${voiceName}`);

        const headers = await vertexAuth.getAuthHeaders();
        const response = await enqueueTtsRequest(() => withRetry(
            'tts',
            () => axios.post(
                vertexAuth.getUrl('gemini-2.5-flash-preview-tts'),
                {
                    contents: [{ role: 'user', parts: [{ text: buildGoogleTtsPrompt(text, speed) }] }],
                    generationConfig: {
                        responseModalities: ['AUDIO'],
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
                    }
                },
                { headers, timeout: 30000 }
            ),
            { maxAttempts: 2, baseDelayMs: 30000, retryOnRateLimit: false }
        ));

        const parts = response.data.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
            if (part.inlineData?.mimeType === 'audio/L16;codec=pcm;rate=24000') {
                const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
                const wavBuffer = addWavHeader(pcmBuffer, 24000, 1, 16);
                console.log(`[Proxy] TTS 成功, size: ${wavBuffer.length} bytes`);
                return res.json({
                    success: true,
                    audioData: wavBuffer.toString('base64'),
                    ext: 'wav'
                });
            }
        }

        res.json({ success: false, error: 'Google TTS 未返回有效音频' });
    } catch (error) {
        const up = getUpstreamError(error);
        const status = mapProxyStatus(error);
        const retryAfterMs = error.retryAfterMs || (status === 429 ? getTtsCooldownRemainingMs() : 0);
        console.error('[Proxy] tts error:', status, up.code, up.message);
        if (status === 429 && retryAfterMs > 0) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        }
        res.status(status).json({
            success: false,
            error: up.message,
            code: up.code,
            retryAfterMs: status === 429 && retryAfterMs > 0 ? retryAfterMs : undefined
        });
    }
});

// ==================== 播客句子分析 ====================
/**
 * POST /proxy/analyze-podcast
 * body: { text } - 完整的英文文章内容
 * response: { success, sentences: [...] }
 */
// 每次最多分析的句子数，避免输出超出 token 限制
const PODCAST_CHUNK_SIZE = 6;

function buildAnalyzePrompt(chunkText) {
    return `You are an English language learning assistant for Chinese children beginners.
Analyze the following English text. Split into individual sentences.
For each sentence provide:
1. Exact sentence text (copied verbatim from the original, including any spelling mistakes — do NOT correct typos)
2. Natural Chinese translation
3. Brief grammar analysis in Chinese (e.g. "主语+谓语+宾语，一般现在时")
4. Word/phrase list following these rules strictly:
   STEP 1 — Find all common multi-word phrases first (phrasal verbs like "get up/wake up/go to bed", collocations like "every day/get home/o'clock", etc.)
   STEP 2 — Find remaining individual content words (nouns, verbs, adjectives, adverbs, numbers, pronouns) that are NOT already covered by a phrase from Step 1.
   STEP 3 — Combine Step 1 + Step 2 as the final word list. A word already inside a phrase must NOT appear again as a separate entry.
   Example: "I get up at seven o'clock every day." → phrases: ["get up","o'clock","every day"] + words: ["seven"] (not "get","up","day" separately)
   IMPORTANT: the "word" field must use the EXACT spelling as it appears in the sentence (do not fix typos).
   For each entry: IPA phonetic (for phrases use the full phrase pronunciation), abbreviated pos (n./v./adj./adv./num./pron./phr.v./phr.), Chinese translation.

Return ONLY valid JSON (no markdown, no explanation):
{"sentences":[{"text":"...","translation":"...","grammar":"...","words":[{"word":"...","phonetic":"...","pos":"...","translation":"..."}]}]}

Text:
${chunkText}`;
}

async function analyzeChunkWithGemini(chunkText) {
    const headers = await vertexAuth.getAuthHeaders();
    const response = await enqueueAnalyzeRequest(() => withRetry(
        'analyze-podcast',
        () => axios.post(
            vertexAuth.getUrl('gemini-2.5-flash'),
            {
                contents: [{ role: 'user', parts: [{ text: buildAnalyzePrompt(chunkText) }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: 'application/json' }
            },
            { headers, timeout: 90000 }
        ),
        { maxAttempts: 2, baseDelayMs: 30000, retryOnRateLimit: false }
    ));
    const parsed = JSON.parse(extractJsonObjectText(response.data.candidates?.[0]?.content?.parts?.[0]?.text || ''));
    if (!Array.isArray(parsed.sentences)) throw new Error('AI返回格式错误');
    return parsed.sentences;
}

async function analyzeChunkWithDeepSeek(chunkText) {
    const response = await axios.post(
        'https://api.deepseek.com/chat/completions',
        {
            model: 'deepseek-chat',
            messages: [
                { role: 'system', content: 'You are a JSON-only assistant. Return ONLY valid JSON, no markdown, no explanation.' },
                { role: 'user', content: buildAnalyzePrompt(chunkText) }
            ],
            temperature: 0,
            max_tokens: 8192,
            response_format: { type: 'json_object' }
        },
        {
            headers: {
                'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                'Content-Type': 'application/json'
            },
            timeout: 90000
        }
    );
    const parsed = JSON.parse(extractJsonObjectText(response.data.choices?.[0]?.message?.content || ''));
    if (!Array.isArray(parsed.sentences)) throw new Error('AI返回格式错误');
    return parsed.sentences;
}

app.post('/proxy/analyze-podcast', auth, async (req, res) => {
    const { text } = req.body;
    const requestedEngine = String(req.body?.engine || 'deepseek').trim().toLowerCase();
    const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
    const engine = requestedEngine === 'gemini'
        ? 'gemini'
        : (hasDeepSeek ? 'deepseek' : 'gemini');
    if (!text) return res.status(400).json({ success: false, error: '缺少 text 参数' });
    if (!vertexAuth.isConfigured && !hasDeepSeek) {
        return res.status(500).json({ success: false, error: '未配置 AI 引擎（Vertex AI 或 DeepSeek）' });
    }

    try {
        // 按句子分割，每块不超过 PODCAST_CHUNK_SIZE 句，避免输出超出 token 限制
        const sentenceList = text.match(/[^.!?]+[.!?]+[\s]*/g) || [text];
        const chunks = [];
        for (let i = 0; i < sentenceList.length; i += PODCAST_CHUNK_SIZE) {
            chunks.push(sentenceList.slice(i, i + PODCAST_CHUNK_SIZE).join('').trim());
        }

        console.log(`[Proxy] 分析播客, engine=${engine}, 文本长度: ${text.length}, 分 ${chunks.length} 块处理`);

        const allSentences = [];
        for (const chunk of chunks) {
            const sentences = engine === 'deepseek'
                ? await analyzeChunkWithDeepSeek(chunk)
                : await analyzeChunkWithGemini(chunk);
            allSentences.push(...sentences);
        }

        console.log(`[Proxy] 播客分析成功, ${allSentences.length} 句`);
        res.json({ success: true, sentences: allSentences, engine });
    } catch (error) {
        const up = getUpstreamError(error);
        const status = mapProxyStatus(error);
        const retryAfterMs = error.retryAfterMs || (status === 429 ? getAnalyzeCooldownRemainingMs() : 0);
        console.error('[Proxy] analyze-podcast error:', status, up.code, up.message);
        if (status === 429 && retryAfterMs > 0) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        }
        res.status(status).json({
            success: false,
            error: up.message,
            code: up.code,
            retryAfterMs: status === 429 && retryAfterMs > 0 ? retryAfterMs : undefined
        });
    }
});

// ==================== 绘本全词分析 ====================
/**
 * POST /proxy/analyze-picturebook-words
 * body: { text } - 绘本某页的英文文本（通常1-2句）
 * response: { success, words: [...] }
 */
function buildPictureBookWordsPrompt(text) {
    return `You are an English language learning assistant for Chinese children (ages 4-8).
Analyze EVERY word and phrase in the following English text from a children's picture book.

Rules:
1. STEP 1: Identify multi-word phrases first (phrasal verbs like "wake up", collocations like "ice cream", "every day", "a lot of").
2. STEP 2: List ALL remaining individual words NOT already inside a phrase — including articles (the/a/an), prepositions (in/on/at), pronouns (I/he/she), conjunctions (and/but), auxiliary verbs (is/are/was), etc.
3. A word already inside a phrase MUST NOT appear again separately.
4. The "word" field must use the EXACT spelling/capitalization from the text.
5. Order the words array by their first appearance position in the text.

For each entry provide:
- word: exact text from the sentence
- phonetic: IPA pronunciation (for phrases, give the full phrase pronunciation)
- pos: abbreviated part of speech (n./v./adj./adv./prep./art./pron./conj./phr.v./phr./num./det./aux./interj.)
- translation: Chinese translation appropriate for this sentence context

Return ONLY valid JSON (no markdown, no explanation):
{"words":[{"word":"...","phonetic":"...","pos":"...","translation":"..."}]}

Text:
${text}`;
}

app.post('/proxy/analyze-picturebook-words', auth, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ success: false, error: '缺少 text 参数' });

    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
    const useDeepSeek = DEEPSEEK_KEY && (!vertexAuth.isConfigured || process.env.AI_ANALYZE_ENGINE === 'deepseek');

    try {
        let rawText;
        if (useDeepSeek) {
            // DeepSeek 路径
            const response = await axios.post(
                'https://api.deepseek.com/chat/completions',
                {
                    model: 'deepseek-chat',
                    messages: [
                        { role: 'system', content: 'You are a JSON-only assistant. Return ONLY valid JSON, no markdown, no explanation.' },
                        { role: 'user', content: buildPictureBookWordsPrompt(text) }
                    ],
                    temperature: 0,
                    max_tokens: 4096,
                    response_format: { type: 'json_object' }
                },
                {
                    headers: { 'Authorization': `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' },
                    timeout: 60000
                }
            );
            rawText = response.data.choices?.[0]?.message?.content || '';
            console.log('[Proxy] analyze-picturebook-words using DeepSeek');
        } else if (vertexAuth.isConfigured) {
            // Vertex AI 路径
            const headers = await vertexAuth.getAuthHeaders();
            const response = await enqueueAnalyzeRequest(() => withRetry(
                'analyze-picturebook-words',
                () => axios.post(
                    vertexAuth.getUrl('gemini-2.5-flash'),
                    {
                        contents: [{ role: 'user', parts: [{ text: buildPictureBookWordsPrompt(text) }] }],
                        generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' }
                    },
                    { headers, timeout: 60000 }
                ),
                { maxAttempts: 2, baseDelayMs: 30000, retryOnRateLimit: false }
            ));
            rawText = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        } else {
            return res.status(500).json({ success: false, error: '未配置 AI 引擎（Vertex AI 或 DeepSeek）' });
        }

        let parsed;
        try {
            parsed = parsePictureBookWordsResponse(rawText);
        } catch (parseError) {
            parseError.rawResponseText = rawText;
            throw parseError;
        }

        if (parsed.recovered) {
            console.warn('[Proxy] analyze-picturebook-words 使用恢复解析:', { salvaged: !!parsed.salvaged, rawLength: rawText.length });
        }

        console.log(`[Proxy] 绘本词汇分析成功, ${parsed.words.length} 词`);
        res.json({ success: true, words: parsed.words });
    } catch (error) {
        const up = getUpstreamError(error);
        const status = mapProxyStatus(error);
        const retryAfterMs = error.retryAfterMs || (status === 429 ? getAnalyzeCooldownRemainingMs() : 0);
        if (status === 500 && /JSON|Unexpected end|Unterminated string|property name/i.test(String(up.message || ''))) {
            console.error('[Proxy] analyze-picturebook-words raw-response:', truncateForLog(error.rawResponseText || error.response?.data?.candidates?.[0]?.content?.parts?.[0]?.text || ''));
        }
        console.error('[Proxy] analyze-picturebook-words error:', status, up.code, up.message);
        if (status === 429 && retryAfterMs > 0) {
            res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        }
        const friendlyMessage = status === 429
            ? `AI 限流保护，请在 ${Math.max(1, Math.ceil((retryAfterMs || PROXY_ANALYZE_COOLDOWN_MS) / 1000))} 秒后重试`
            : (/JSON|Unexpected end|Unterminated string|property name/i.test(String(up.message || ''))
                ? 'AI 返回的词汇 JSON 不完整，请重试'
                : up.message);
        res.status(status).json({
            success: false,
            error: friendlyMessage,
            code: up.code,
            retryAfterMs: status === 429 && retryAfterMs > 0 ? retryAfterMs : undefined
        });
    }
});

// ==================== WAV 工具函数 ====================

function addWavHeader(samples, sampleRate, numChannels, bitDepth) {
    const byteRate = sampleRate * numChannels * bitDepth / 8;
    const blockAlign = numChannels * bitDepth / 8;
    const dataSize = samples.length;
    const buffer = Buffer.alloc(44);
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitDepth, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);
    return Buffer.concat([buffer, samples]);
}

// ==================== 启动 ====================

app.listen(PORT, () => {
    console.log(`🌐 Google AI Proxy (Vertex AI) 启动成功: http://localhost:${PORT}`);
    console.log(`🔑 API Key 鉴权: ${API_KEY ? '已启用' : '未启用（开发模式）'}`);
    console.log(`🤖 Vertex AI: ${vertexAuth.isConfigured ? '已配置' : '❌ 未配置'}`);
    console.log(`📍 Project: ${process.env.GOOGLE_CLOUD_PROJECT || 'NOT SET'}, Region: ${process.env.GOOGLE_CLOUD_REGION || 'us-central1'}`);
    console.log(`🖼️ Image 限速: 最小间隔 ${PROXY_IMAGE_MIN_INTERVAL_MS}ms, 冷却 ${PROXY_IMAGE_COOLDOWN_MS}ms`);
    console.log(`🔊 TTS 限速: 最小间隔 ${PROXY_TTS_MIN_INTERVAL_MS}ms, 冷却 ${PROXY_TTS_COOLDOWN_MS}ms`);
    console.log(`🧠 Analyze 限速: 最小间隔 ${PROXY_ANALYZE_MIN_INTERVAL_MS}ms, 冷却 ${PROXY_ANALYZE_COOLDOWN_MS}ms`);
});
