const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const sizeOf = require('image-size');
const tencentcloud = require("tencentcloud-sdk-nodejs-ocr");
const OcrClient = tencentcloud.ocr.v20181119.Client;
const cosService = require('./cos.service');
const vertexAuth = require('../utils/vertex-auth');
require('dotenv').config(); // Ensure env vars are loaded

/**
 * Google Gemini AI 图片生成服务 (Vertex AI)
 */
class AIService {
    constructor() {
        this.vertexAuth = vertexAuth;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _isRetryableProxyError(error) {
        const status = error?.response?.status;
        const code = String(error?.code || '').toUpperCase();
        const msg = error?.response?.data?.error || error?.message || '';
        return status === 429
            || status >= 500
            || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE'].includes(code)
            || /timeout|resource exhausted|quota exceeded|try again later/i.test(String(msg));
    }

    _extractProxyError(error) {
        const status = error?.response?.status;
        const body = error?.response?.data;
        const bodyError = body?.error;
        const code = body?.code || bodyError?.code || bodyError?.status || '';
        const msg = (typeof bodyError === 'string' ? bodyError : bodyError?.message) || body?.message || error?.message || '代理请求失败';
        const retryAfterMs = Number(body?.retryAfterMs || error?.retryAfterMs || 0);
        return {
            status,
            code: String(code || ''),
            message: String(msg),
            retryAfterMs: retryAfterMs > 0 ? retryAfterMs : undefined
        };
    }

    _readProxyImageData(body) {
        if (!body || typeof body !== 'object') return '';
        if (body.imageData && typeof body.imageData === 'string') return body.imageData;
        if (body.data?.imageData && typeof body.data.imageData === 'string') return body.data.imageData;
        if (body.image_base64 && typeof body.image_base64 === 'string') return body.image_base64;
        return '';
    }

    async _postProxyWithRetry(pathname, payload, options = {}) {
        const {
            timeout = 90000,
            maxAttempts = 3,
            baseDelayMs = 1500,
            retryOnRateLimit = true
        } = options;

        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await axios.post(
                    `${process.env.PROXY_BASE_URL}${pathname}`,
                    payload,
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Proxy-Key': process.env.PROXY_API_KEY || ''
                        },
                        timeout
                    }
                );
            } catch (error) {
                lastError = error;
                const extracted = this._extractProxyError(error);
                if (!retryOnRateLimit && (extracted.status === 429 || /resource exhausted|quota exceeded|try again later/i.test(extracted.message))) {
                    throw error;
                }
                if (!this._isRetryableProxyError(error) || attempt >= maxAttempts) {
                    throw error;
                }
                const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
                console.warn(`[AIService] 代理请求重试 ${pathname} attempt=${attempt}/${maxAttempts}, wait=${waitMs}ms`);
                await this._sleep(waitMs);
            }
        }
        throw lastError || new Error('代理请求失败');
    }

    /**
     * 生成单词图片 - 使用数据库提示词模板
     * @param {string} word - 要生成图片的单词
     * @param {Object} options - 配置选项
     * @param {string} options.translation - 中文翻译
     * @param {string} options.category - 一级分类名称
     * @param {string} options.category_en - 一级分类英文名
     * @param {string} options.subcategory - 二级分类名称（如有）
     * @param {string} options.image_hint - 图片生成建议（用户自定义描述）
     * @param {string} options.promptKey - 提示词模板key (默认 'image_generate')
     */
    async generateWordImage(word, options = {}) {
        try {
            const {
                translation = '',
                category = '',
                category_en = '',
                subcategory = '',
                image_hint = '',
                promptKey = 'image_generate'
            } = options;

            // 从数据库获取提示词模板
            let promptTemplate = await this.getPromptTemplate(promptKey);

            let prompt;
            if (promptTemplate) {
                // 替换模板变量（包含 image_hint）
                prompt = this.replaceTemplateVariables(promptTemplate, {
                    word,
                    translation,
                    category,
                    category_en,
                    subcategory,
                    image_hint
                });
            } else {
                // 默认提示词（兜底）
                const categoryContext = category ? `Category: ${category}${subcategory ? ' > ' + subcategory : ''}. ` : '';
                const hintContext = image_hint ? `\nIMPORTANT visual description: ${image_hint}\nFollow this description closely for a more accurate image.` : '';
                prompt = `Create a beautiful, clear image of a ${word}${translation ? ` (${translation})` : ''}.
${categoryContext}${hintContext}
The ${word} should be the main focus of the image, centered and clearly visible.
Show a realistic, friendly-looking ${word} that children would find appealing.
The background should be simple and not distract from the main subject.
High quality, educational style suitable for English vocabulary learning.

IMPORTANT:
- NO text, words, or letters in the image
- NO watermarks or signatures
- Safe for children, no scary or inappropriate content
- Square format (1:1 aspect ratio)`;
            }

            console.log('[AIService] 生成图片提示词:', prompt.substring(0, 150) + '...');

            // 使用 Gemini 2.0 Flash Image Generation
            const result = await this.generateImage(prompt);
            return result;
        } catch (error) {
            console.error('生成单词图片错误:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || '图片生成服务暂不可用'
            };
        }
    }

    /**
     * 例句场景图片生成 - 结合单词 + 例句，面向 3-8 岁儿童
     * 目标：通过画面帮助小朋友理解例句含义，单词所指对象视觉高亮
     *
     * @param {string} word - 目标单词（英文）
     * @param {Object} options
     * @param {string} options.translation - 单词中文翻译
     * @param {string} options.example_sentence - 例句（英文）
     * @param {string} options.example_translation - 例句中文翻译
     * @param {string} options.category - 一级分类
     * @param {string} options.image_hint - 可选额外视觉提示
     */
    async generateExampleImage(word, options = {}) {
        try {
            const {
                translation = '',
                example_sentence = '',
                example_translation = '',
                category = '',
                image_hint = ''
            } = options;

            if (!example_sentence) {
                return { success: false, error: '例句为空，无法生成例句图' };
            }

            // 优先从 DB 取模板；无则用内置儿童友好提示词
            let prompt;
            const template = await this.getPromptTemplate('example_image_generate');
            if (template) {
                prompt = this.replaceTemplateVariables(template, {
                    word,
                    translation,
                    example_sentence,
                    example_translation,
                    category,
                    image_hint
                });
            } else {
                const hintLine = image_hint ? `\nExtra visual hint: ${image_hint}` : '';
                const catLine = category ? `\nTopic context: ${category}.` : '';
                prompt = `Create a warm, friendly cartoon illustration for a children's English learning app (audience: ages 3-8).

STORY TO ILLUSTRATE:
- English: "${example_sentence}"
- Chinese meaning: "${example_translation || '(see English)'}"

KEY VOCABULARY TO HIGHLIGHT: "${word}"${translation ? ` (${translation})` : ''}
The "${word}" must be the clear visual focal point — larger, brighter, or center-positioned — so a child can instantly connect the word to the object/action in the picture.${catLine}${hintLine}

STYLE:
- Soft cartoon / picture-book style, rounded shapes, cheerful atmosphere
- Bright warm colors, gentle lighting, NOT photorealistic
- Characters (if any) have big friendly eyes, cute kid-like proportions, visible smiles
- Simple uncluttered background that supports comprehension, not distracts
- Show the action/scene literally from the sentence so the meaning is obvious without words

STRICT RULES:
- NO text, letters, numbers, speech bubbles, or captions anywhere in the image
- NO watermarks, signatures, or logos
- Kid-safe: no scary, violent, sad, or inappropriate content
- Square format (1:1 aspect ratio), high resolution`;
            }

            console.log('[AIService] 生成例句图提示词:', prompt.substring(0, 160) + '...');
            const result = await this.generateImage(prompt);
            return result;
        } catch (error) {
            console.error('生成例句图错误:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || '例句图生成失败'
            };
        }
    }

    /**
     * 场景图片生成 - 带服务端 prompt 增强
     * @param {string} userPrompt - 用户输入的场景描述
     * @param {Object} options - 场景上下文 { ai_style, name, name_en, category_name, category_name_en, difficulty_level, items }
     */
    async generateSceneImage(userPrompt, options = {}) {
        try {
            const cleanPrompt = String(userPrompt || '').trim();
            if (!cleanPrompt) {
                return {
                    success: false,
                    error: '提示词不能为空'
                };
            }

            const styleRaw = String(options.ai_style || options.style || 'scene').toLowerCase();
            const aiStyle = ['poster', 'scene', 'custom'].includes(styleRaw) ? styleRaw : 'scene';

            // poster/custom 模式：按用户提示词直出，不走场景模板增强，避免风格串用
            if (aiStyle === 'poster') {
                console.log('[AIService] 词汇海报提示词:', cleanPrompt.substring(0, 200) + '...');
                // 按用户要求回退到 Gemini 生图链路（不传 aspectRatio，避免走 Imagen）
                return this.generateImage(cleanPrompt);
            }
            if (aiStyle === 'custom') {
                console.log('[AIService] 自定义提示词:', cleanPrompt.substring(0, 200) + '...');
                return this.generateImage(cleanPrompt);
            }

            const {
                name = '',
                name_en = '',
                category_name = '',
                category_name_en = '',
                difficulty_level = '',
                items = ''
            } = options;

            // 从数据库获取提示词模板
            let promptTemplate = await this.getPromptTemplate('scene_image_generate');

            let prompt;
            if (promptTemplate) {
                prompt = this.replaceTemplateVariables(promptTemplate, {
                    user_prompt: cleanPrompt,
                    name,
                    name_en,
                    category_name,
                    category_name_en,
                    difficulty_level: String(difficulty_level),
                    items
                });
            } else {
                // 默认提示词（兜底）
                const sceneLabel = name_en ? `${name_en}${name ? ` (${name})` : ''}` : (name || 'a scene');
                const categoryLine = category_name ? `\nCategory: ${category_name_en || ''} (${category_name})` : '';
                const itemsLine = items ? `\nObjects that should appear in the scene: ${items}` : '';
                const difficultyLine = difficulty_level ? `\n- Detail level: ${difficulty_level}/5 (1=very simple with few objects, 5=rich scene with many details)` : '';

                prompt = `Create a children's educational scene illustration for an English learning app.

Scene: ${sceneLabel}${categoryLine}${itemsLine}

User description: ${cleanPrompt}

Style Requirements:
- Colorful, cheerful illustration style suitable for children ages 3-10
- Bright, warm color palette with soft lighting
- Clean composition with clearly recognizable objects
- Friendly, inviting atmosphere that makes children want to explore
- Each object should be clearly distinct and easy to identify by tapping
- Slight cartoon/illustration style but objects should be realistic enough for children to recognize in real life${difficultyLine}

STRICT RULES:
- NO text, words, letters, numbers, or labels anywhere in the image
- NO watermarks, signatures, or logos
- NO scary, violent, or inappropriate content
- Safe and friendly for young children
- Square format (1:1 aspect ratio)`;
            }

            console.log('[AIService] 场景图片提示词:', prompt.substring(0, 200) + '...');

            const result = await this.generateImage(prompt, { aspectRatio: '1:1' });
            return result;
        } catch (error) {
            console.error('生成场景图片错误:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || '图片生成服务暂不可用'
            };
        }
    }

    /**
     * 通用图片生成方法 - 优先走代理（腾讯云），直连作为降级
     * @param {string} prompt - 完整的图片生成提示词
     */
    async generateImage(prompt, options = {}) {
        const { aspectRatio = '' } = options || {};

        // 配置了 PROXY_BASE_URL 时，走美国服务器代理
        if (process.env.PROXY_BASE_URL) {
            return this._generateImageViaProxy(prompt, { aspectRatio });
        }

        try {
            console.log('[AIService] 开始生成图片 (Vertex AI)...');
            console.log('[AIService] Prompt:', prompt.substring(0, 100) + '...');

            // 需要指定画幅比例时，走 Imagen（支持 aspectRatio）
            if (aspectRatio) {
                return await this._generateImageDirectWithAspect(prompt, aspectRatio);
            }

            const headers = await this.vertexAuth.getAuthHeaders();
            const modelIds = [
                'gemini-3.1-flash-image-preview',
                'gemini-3-pro-image-preview'
            ];

            let lastError = null;
            for (let i = 0; i < modelIds.length; i++) {
                const modelId = modelIds[i];
                try {
                    const response = await axios.post(
                        this.vertexAuth.getUrl(modelId),
                        {
                            contents: [{ role: 'user', parts: [{ text: prompt }] }],
                            generationConfig: { responseModalities: ['image', 'text'] }
                        },
                        { headers, timeout: 120000 }
                    );

                    const candidates = response.data.candidates;
                    if (candidates && candidates.length > 0) {
                        const parts = candidates[0].content?.parts || [];
                        for (const part of parts) {
                            if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
                                const imageData = part.inlineData.data;
                                const imagePath = await this.saveBase64Image(imageData, `gen_${Date.now()}`);
                                console.log(`[AIService] 图片生成成功(${modelId}):`, imagePath);
                                return { success: true, imageUrl: imagePath };
                            }
                        }
                    }
                } catch (e) {
                    lastError = e;
                    console.warn(`[AIService] 模型 ${modelId} 生图失败:`, e.response?.data?.error?.message || e.message);
                    if (i < modelIds.length - 1) {
                        console.warn(`[AIService] 切换到备选模型: ${modelIds[i + 1]}`);
                    }
                }
            }

            if (lastError) throw lastError;

            return {
                success: false,
                error: '图片生成未返回有效数据，请稍后重试'
            };
        } catch (error) {
            console.error('[AIService] 图片生成错误:', error.response?.data || error.message);

            return {
                success: false,
                error: error.response?.data?.error?.message || error.message || '图片生成服务暂不可用'
            };
        }
    }

    async _generateImageDirectWithAspect(prompt, aspectRatio = '16:9') {
        const headers = await this.vertexAuth.getAuthHeaders();
        const response = await axios.post(
            this.vertexAuth.getUrl('imagen-3.0-generate-002', 'predict'),
            {
                instances: [{ prompt }],
                parameters: {
                    sampleCount: 1,
                    aspectRatio
                }
            },
            { headers, timeout: 120000 }
        );

        const imageData = response.data?.predictions?.[0]?.bytesBase64Encoded;
        if (!imageData) {
            return { success: false, error: '图片生成未返回有效数据，请稍后重试' };
        }

        const imagePath = await this.saveBase64Image(imageData, `gen_${Date.now()}`);
        console.log(`[AIService] Imagen(${aspectRatio}) 图片生成成功:`, imagePath);
        return { success: true, imageUrl: imagePath };
    }

    // [已删除] 旧版 generateSceneImage - 直连 Vertex AI，已被新版替代（line 156）
    // 新版走代理 + prompt 模板增强

    /**
     * 智能文本识别 (OCR) - 支持 Gemini Vision 和 有道 OCR
     * @param {string} imagePath - 图片路径
     * @param {string} engine - 引擎 'youdao' | 'gemini' (默认)
     */
    async recognizeImageText(imagePath, engine = 'gemini') {
        if (engine === 'youdao' && config.youdao.appKey) {
            return this.youdaoOCR(imagePath);
        }
        if (engine === 'tencent' && process.env.TENCENT_SECRET_ID) {
            return this.tencentOCR(imagePath);
        }
        return this.geminiOCR(imagePath);
    }

    /**
     * 腾讯云通用印刷体识别
     */
    async tencentOCR(imagePath) {
        try {
            const client = new OcrClient({
                credential: {
                    secretId: process.env.TENCENT_SECRET_ID,
                    secretKey: process.env.TENCENT_SECRET_KEY,
                },
                region: process.env.TENCENT_REGION || "ap-guangzhou",
                profile: {
                    httpProfile: {
                        endpoint: "ocr.tencentcloudapi.com",
                    },
                },
            });

            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const dimensions = sizeOf(imageBuffer);
            const { width: imgW, height: imgH } = dimensions;

            return new Promise((resolve) => {
                client.GeneralBasicOCR({
                    ImageBase64: base64Image
                }).then(
                    (data) => {
                        const words = (data.TextDetections || []).map(item => {
                            const poly = item.Polygon; // [{X,Y},...]
                            const xs = poly.map(p => p.X);
                            const ys = poly.map(p => p.Y);
                            const minX = Math.min(...xs);
                            const maxX = Math.max(...xs);
                            const minY = Math.min(...ys);
                            const maxY = Math.max(...ys);

                            return {
                                text: item.DetectedText,
                                rect: {
                                    x: (minX / imgW) * 100,
                                    y: (minY / imgH) * 100,
                                    w: ((maxX - minX) / imgW) * 100,
                                    h: ((maxY - minY) / imgH) * 100
                                }
                            };
                        });
                        console.log('[TencentOCR] Success, words:', words.length);
                        resolve({ success: true, engine: 'tencent', words });
                    },
                    (err) => {
                        console.error('Tencent OCR Error:', err);
                        resolve({
                            success: false,
                            error: `腾讯云OCR识别失败: ${err.message || err.code}`,
                            rawError: err
                        });
                    }
                );
            });

        } catch (error) {
            console.error('Tencent OCR Init Error:', error);
            return {
                success: false,
                error: `腾讯云OCR服务初始化失败: ${error.message}`,
                stack: error.stack
            };
        }
    }

    /**
     * 使用 Gemini Vision 识别图片中的文字和坐标
     * @param {string} imagePath - 图片路径
     */
    async geminiOCR(imagePath) {
        try {
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const mimeType = this.getMimeType(imagePath);

            const headers = await this.vertexAuth.getAuthHeaders();
            const response = await axios.post(
                this.vertexAuth.getUrl('gemini-2.0-flash-exp'),
                {
                    contents: [{
                        role: 'user',
                        parts: [
                            {
                                text: `Detect text in this image.
Return a JSON array where each item has "text" and "box" [ymin, xmin, ymax, xmax].
IMPORTANT: The coordinates [ymin, xmin, ymax, xmax] must be on a scale of 0 to 1000.
(e.g., [0, 0, 1000, 1000] is the entire image).
Do NOT crop or offset. Inspect the FULL image.

Example response format:
[
  {"text": "Apple", "box": [100, 200, 300, 400]},
  {"text": "Car", "box": [500, 600, 700, 800]}
]
Only return valid JSON.`
                            },
                            {
                                inline_data: {
                                    mime_type: mimeType,
                                    data: base64Image
                                }
                            }
                        ]
                    }],
                    generationConfig: {
                        responseMimeType: "application/json"
                    }
                },
                { headers }
            );

            const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            let words = [];

            if (text) {
                try {
                    const rawData = JSON.parse(text);
                    if (Array.isArray(rawData)) {
                        words = rawData.map(item => {
                            // Gemini 0-1000 scale -> 0-100%
                            const [ymin, xmin, ymax, xmax] = item.box || [0, 0, 0, 0];
                            return {
                                text: item.text,
                                rect: {
                                    x: (xmin / 1000) * 100,
                                    y: (ymin / 1000) * 100,
                                    w: ((xmax - xmin) / 1000) * 100,
                                    h: ((ymax - ymin) / 1000) * 100
                                }
                            };
                        });
                    }
                } catch (e) {
                    console.error('Gemini OCR 解析错误:', e);
                    console.log('Gemini Raw Text:', text);
                }
            } else {
                console.log('Gemini returned no text parts');
            }

            return { success: true, engine: 'gemini', words };
        } catch (error) {
            console.error('Gemini OCR 错误:', error);
            return {
                success: false,
                error: `Gemini OCR 服务不可用: ${error.message}`,
                rawError: error.response?.data || error.message
            };
        }
    }

    /**
     * 使用 Gemini Vision 识别图片内容 (原有方法，保留用于场景描述)
     * @param {string} imagePath - 图片路径
     */
    async recognizeImage(imagePath) {
        try {
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const mimeType = this.getMimeType(imagePath);

            const headers = await this.vertexAuth.getAuthHeaders();
            const response = await axios.post(
                this.vertexAuth.getUrl('gemini-2.0-flash-exp'),
                {
                    contents: [{
                        role: 'user',
                        parts: [
                            {
                                text: `Analyze this image and identify all visible objects. For each object, provide:
1. The English word for the object
2. The Chinese translation
3. A simple English sentence using the word
Return the result as a JSON array with format:
[{"word": "cat", "translation": "猫", "sentence": "I see a cute cat."}]
Only return the JSON array, no other text.`
                            },
                            {
                                inline_data: {
                                    mime_type: mimeType,
                                    data: base64Image
                                }
                            }
                        ]
                    }]
                },
                {
                    headers
                }
            );

            const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                try {
                    // 提取JSON数组
                    const jsonMatch = text.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        const objects = JSON.parse(jsonMatch[0]);
                        return { success: true, objects };
                    }
                } catch (e) {
                    console.error('解析识别结果错误:', e);
                }
            }

            return { success: true, objects: [] };
        } catch (error) {
            console.error('图片识别错误:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || '图片识别服务暂不可用'
            };
        }
    }

    /**
     * 调用有道OCR识别图片中的英文单词和位置
     * @param {string} imagePath - 图片路径
     */
    async youdaoOCR(imagePath) {
        try {
            // Defensive check for config
            if (!config.youdao) {
                return { success: false, error: '有道API配置未找到' };
            }
            const { appKey, appSecret } = config.youdao;

            if (!appKey || !appSecret) {
                return { success: false, error: '有道API未配置 (缺少Key或Secret)' };
            }

            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');

            const salt = uuidv4();
            const curtime = Math.round(Date.now() / 1000).toString();
            const input = base64Image.length <= 20
                ? base64Image
                : base64Image.substring(0, 10) + base64Image.length + base64Image.substring(base64Image.length - 10);

            const signStr = appKey + input + salt + curtime + appSecret;
            const sign = crypto.createHash('sha256').update(signStr).digest('hex');

            const response = await axios.post(
                'https://openapi.youdao.com/ocrapi',
                new URLSearchParams({
                    img: base64Image,
                    langType: 'zh-CHS',
                    detectType: '10012',
                    imageType: '1',
                    appKey,
                    salt,
                    sign,
                    signType: 'v3',
                    curtime
                }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            if (response.data.errorCode === '0') {
                const words = [];
                const regions = response.data.Result?.regions || [];

                // Get Image Dimensions for percentage calculation
                let imgW = 0, imgH = 0;
                try {
                    const dimensions = sizeOf(imageBuffer);
                    imgW = dimensions.width;
                    imgH = dimensions.height;
                } catch (e) {
                    console.error('Image Size Error:', e);
                }

                for (const region of regions) {
                    for (const line of region.lines || []) {
                        // boundingBox: "x1,y1,x2,y2,x3,y3,x4,y4" (8 corner coordinates)
                        const parts = (line.boundingBox || "").split(',').map(Number);
                        if (parts.length === 8 && imgW > 0 && imgH > 0) {
                            // Extract x and y values from corners
                            const xs = [parts[0], parts[2], parts[4], parts[6]];
                            const ys = [parts[1], parts[3], parts[5], parts[7]];
                            const minX = Math.min(...xs);
                            const maxX = Math.max(...xs);
                            const minY = Math.min(...ys);
                            const maxY = Math.max(...ys);

                            words.push({
                                text: line.text,
                                rect: {
                                    x: (minX / imgW) * 100,
                                    y: (minY / imgH) * 100,
                                    w: ((maxX - minX) / imgW) * 100,
                                    h: ((maxY - minY) / imgH) * 100
                                }
                            });
                        }
                    }
                }

                // 合并垂直相邻、水平重叠的文本行（解决 "Chinese"+"cabbage" 拆分问题）
                const merged = this._mergeAdjacentWords(words);

                return {
                    success: true,
                    engine: 'youdao',
                    words: merged
                };
            }

            return {
                success: false,
                error: `有道OCR错误: ErrorCode=${response.data.errorCode}`,
                rawResponse: response.data
            };
        } catch (error) {
            console.error('有道OCR错误:', error.message, error.response?.data);
            return { success: false, error: '有道OCR服务暂不可用: ' + error.message };
        }
    }

    /**
     * 通过美国代理服务器生成图片
     */
    async _generateImageViaProxy(prompt, options = {}) {
        try {
            console.log('[AIService] 通过代理生成图片...');
            const runGenerate = async (withAspect = true) => {
                const payload = { prompt };
                if (withAspect && options.aspectRatio) payload.aspectRatio = options.aspectRatio;
                const response = await this._postProxyWithRetry(
                    '/proxy/generate-image',
                    payload,
                    { timeout: 210000, maxAttempts: 2, baseDelayMs: 30000, retryOnRateLimit: false }
                );
                return response?.data || {};
            };

            const primary = await runGenerate(true);
            const primaryImageData = this._readProxyImageData(primary);
            if (primary.success && primaryImageData) {
                const imageUrl = await this.saveBase64Image(primaryImageData, `gen_${Date.now()}`);
                console.log('[AIService] 代理图片生成成功:', imageUrl);
                return { success: true, imageUrl };
            }

            // 指定画幅比例时，Imagen 可能因配额限制失败；降级一次走 Gemini 生图，避免流程直接中断
            if (options.aspectRatio) {
                const msg = String(primary?.error || primary?.message || '');
                const code = String(primary?.code || '');
                const shouldFallbackNoAspect = !primaryImageData || /quota exceeded|resource exhausted|429|imagen/i.test(`${msg} ${code}`);
                if (shouldFallbackNoAspect) {
                    console.warn('[AIService] 代理图片生成降级重试: fallback to no-aspect request');
                    const fallback = await runGenerate(false);
                    const fallbackImageData = this._readProxyImageData(fallback);
                    if (fallback.success && fallbackImageData) {
                        const imageUrl = await this.saveBase64Image(fallbackImageData, `gen_${Date.now()}`);
                        console.log('[AIService] 代理图片生成降级成功:', imageUrl);
                        return { success: true, imageUrl };
                    }
                    const fallbackError = fallback?.error || fallback?.message || '';
                    const joinedError = [msg, fallbackError].filter(Boolean).join('；');
                    return { success: false, error: joinedError || '代理返回失败' };
                }
            }

            return { success: false, error: primary.error || primary.message || '代理返回失败' };
        } catch (error) {
            const proxyErr = this._extractProxyError(error);
            console.error('[AIService] 代理图片生成失败:', proxyErr.status, proxyErr.code, proxyErr.message);
            return {
                success: false,
                error: `代理服务不可用: ${proxyErr.message}`,
                statusCode: proxyErr.status,
                retryAfterMs: proxyErr.retryAfterMs
            };
        }
    }

    /**
     * 保存Base64图片：优先上传 COS，不可用时回退到本地
     */
    /**
     * 合并垂直相邻、水平重叠的 OCR 文本行
     * 例如 "Chinese" + "cabbage" → "Chinese cabbage"
     */
    _mergeAdjacentWords(words) {
        if (words.length <= 1) return words;

        const merged = [...words];
        let changed = true;

        while (changed) {
            changed = false;
            for (let i = 0; i < merged.length; i++) {
                for (let j = i + 1; j < merged.length; j++) {
                    const a = merged[i];
                    const b = merged[j];

                    // 水平重叠判断：两个框的 X 范围有交集
                    const aLeft = a.rect.x, aRight = a.rect.x + a.rect.w;
                    const bLeft = b.rect.x, bRight = b.rect.x + b.rect.w;
                    const overlapX = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
                    const minW = Math.min(a.rect.w, b.rect.w);
                    // 水平重叠需超过较窄框宽度的 30%
                    if (overlapX < minW * 0.3) continue;

                    // 垂直间距判断：两个框的 Y 间距小于较矮框高度的 80%
                    const aTop = a.rect.y, aBottom = a.rect.y + a.rect.h;
                    const bTop = b.rect.y, bBottom = b.rect.y + b.rect.h;
                    const gapY = Math.max(0, Math.max(aTop, bTop) - Math.min(aBottom, bBottom));
                    const minH = Math.min(a.rect.h, b.rect.h);
                    if (gapY > minH * 0.8) continue;

                    // 合并：文本拼接，框取并集
                    const upper = aTop <= bTop ? a : b;
                    const lower = aTop <= bTop ? b : a;
                    const newLeft = Math.min(aLeft, bLeft);
                    const newTop = Math.min(aTop, bTop);
                    const newRight = Math.max(aRight, bRight);
                    const newBottom = Math.max(aBottom, bBottom);

                    merged[i] = {
                        text: upper.text + ' ' + lower.text,
                        rect: {
                            x: newLeft,
                            y: newTop,
                            w: newRight - newLeft,
                            h: newBottom - newTop
                        }
                    };
                    merged.splice(j, 1);
                    changed = true;
                    break;
                }
                if (changed) break;
            }
        }

        return merged;
    }

    async saveBase64Image(base64Data, prefix) {
        // 优先上传到 COS
        if (cosService.isConfigured) {
            try {
                const url = await cosService.uploadBase64Image(base64Data, prefix);
                console.log('[AIService] 图片已上传 COS:', url);
                return url;
            } catch (err) {
                console.error('[AIService] COS 上传失败，回退本地:', err.message);
            }
        }

        // 回退：保存到本地（压缩至 JPEG quality=82，最大 1024px）
        const sharp = require('sharp');
        const uploadsDir = path.join(__dirname, '../../uploads/images');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const filename = `${prefix}_${Date.now()}.jpg`;
        const filePath = path.join(uploadsDir, filename);
        const rawBuffer = Buffer.from(base64Data, 'base64');
        const compressed = await sharp(rawBuffer)
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 82, progressive: true })
            .toBuffer();
        fs.writeFileSync(filePath, compressed);
        console.log(`[AIService] 图片保存本地: ${Math.round(rawBuffer.length/1024)}KB → ${Math.round(compressed.length/1024)}KB`);
        return `/uploads/images/${filename}`;
    }

    /**
     * 通用文本生成 (Gemini 2.0 Flash)
     * @param {string} prompt - 提示词
     * @returns {Object} { success: boolean, text?: string, error?: string }
     */
    async callGeminiText(prompt) {
        const doCall = async () => {
            const headers = await this.vertexAuth.getAuthHeaders();
            const response = await axios.post(
                this.vertexAuth.getUrl('gemini-2.5-flash'),
                {
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
                },
                { headers, timeout: 60000 }
            );
            const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return { success: true, text };
            return { success: false, error: 'Gemini 未返回文本' };
        };

        // 优先走代理（国内服务器无法直连 Google API）
        if (process.env.PROXY_BASE_URL) {
            try {
                const resp = await this._postProxyWithRetry(
                    '/proxy/gemini-text',
                    { prompt },
                    { timeout: 65000, maxAttempts: 3, baseDelayMs: 1500 }
                );
                if (resp.data.success && resp.data.text) return { success: true, text: resp.data.text };
                console.warn('[AIService] 代理文本生成返回失败:', resp.data.error);
                return { success: false, error: resp.data.error || '代理文本生成失败' };
            } catch (e) {
                const proxyErr = this._extractProxyError(e);
                console.error('[AIService] 代理文本生成异常:', e.code, proxyErr.status, proxyErr.message);
                return { success: false, error: `代理不可用: ${proxyErr.message}` };
            }
        }

        // 无代理配置时才尝试直连
        try {
            return await doCall();
        } catch (error) {
            console.error('[AIService] Gemini文本生成失败:', error.response?.data || error.message);
            return { success: false, error: error.response?.data?.error?.message || error.message };
        }
    }

    /**
     * 发起 Veo 视频生成长任务（支持 text-to-video / image-to-video）
     */
    async startVeoVideoTask({
        prompt,
        referenceImageUrl = '',
        modelId = (process.env.VEO_MODEL_ID || 'veo-3.1-fast-generate-001'),
        durationSeconds = 4,
        aspectRatio = '16:9',
        resolution = '720p'
    }) {
        if (!prompt) return { success: false, error: '缺少 prompt' };

        // 优先走代理（中国机通常无法稳定直连 Google API）
        if (process.env.PROXY_BASE_URL) {
            try {
                const resp = await axios.post(
                    `${process.env.PROXY_BASE_URL}/proxy/veo/start`,
                    { prompt, referenceImageUrl, modelId, durationSeconds, aspectRatio, resolution },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Proxy-Key': process.env.PROXY_API_KEY || ''
                        },
                        timeout: 90000
                    }
                );
                return resp.data;
            } catch (e) {
                return { success: false, error: `Veo代理不可用: ${e.message}` };
            }
        }

        try {
            const headers = await this.vertexAuth.getAuthHeaders();
            const instance = { prompt };

            if (referenceImageUrl) {
                const ref = await this._fetchRemoteFileAsBase64(referenceImageUrl);
                if (ref.success) {
                    instance.image = {
                        bytesBase64Encoded: ref.base64,
                        mimeType: ref.mimeType
                    };
                } else {
                    return { success: false, error: ref.error || '参考图读取失败' };
                }
            }

            const payload = {
                instances: [instance],
                parameters: {
                    sampleCount: 1,
                    durationSeconds,
                    aspectRatio,
                    resolution,
                    generateAudio: false
                }
            };

            const response = await axios.post(
                this.vertexAuth.getUrl(modelId, 'predictLongRunning'),
                payload,
                { headers, timeout: 90000 }
            );

            const operationName = response.data?.name;
            if (!operationName) return { success: false, error: 'Veo 未返回 operationName' };

            return {
                success: true,
                operationName,
                modelId
            };
        } catch (error) {
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message || '发起 Veo 任务失败'
            };
        }
    }

    /**
     * 轮询 Veo 长任务
     */
    async pollVeoVideoTask({
        operationName,
        modelId = (process.env.VEO_MODEL_ID || 'veo-3.1-fast-generate-001')
    }) {
        if (!operationName) return { success: false, error: '缺少 operationName' };

        if (process.env.PROXY_BASE_URL) {
            try {
                const resp = await axios.post(
                    `${process.env.PROXY_BASE_URL}/proxy/veo/poll`,
                    { operationName, modelId },
                    {
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Proxy-Key': process.env.PROXY_API_KEY || ''
                        },
                        timeout: 90000
                    }
                );
                const data = resp.data || {};
                if (data.success && data.done && data.video?.bytesBase64Encoded) {
                    const saved = await this.saveBase64Video(data.video.bytesBase64Encoded, `veo_${Date.now()}`, data.video.mimeType || 'video/mp4');
                    return { success: true, done: true, videoUrl: saved, mimeType: data.video.mimeType || 'video/mp4' };
                }
                return data;
            } catch (e) {
                return { success: false, error: `Veo代理轮询失败: ${e.message}` };
            }
        }

        try {
            const headers = await this.vertexAuth.getAuthHeaders();
            const response = await axios.post(
                this.vertexAuth.getUrl(modelId, 'fetchPredictOperation'),
                { operationName },
                { headers, timeout: 90000 }
            );

            const op = response.data || {};
            if (!op.done) return { success: true, done: false };

            if (op.error) {
                const msg = op.error.message || op.error.code || 'Veo 任务失败';
                return { success: false, done: true, error: msg };
            }

            const videos = op.response?.videos || [];
            const first = videos[0];
            if (!first) return { success: false, done: true, error: 'Veo 未返回视频数据' };

            if (first.bytesBase64Encoded) {
                const saved = await this.saveBase64Video(first.bytesBase64Encoded, `veo_${Date.now()}`, first.mimeType || 'video/mp4');
                return { success: true, done: true, videoUrl: saved, mimeType: first.mimeType || 'video/mp4' };
            }

            if (first.gcsUri) {
                return { success: false, done: true, error: `Veo 返回 GCS 结果(${first.gcsUri})，当前未配置自动拉取` };
            }

            return { success: false, done: true, error: 'Veo 返回格式不支持' };
        } catch (error) {
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message || '轮询 Veo 任务失败'
            };
        }
    }

    async _fetchRemoteFileAsBase64(fileUrl) {
        try {
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
            const buffer = Buffer.from(response.data);
            const mimeType = response.headers['content-type'] || 'image/jpeg';
            return { success: true, base64: buffer.toString('base64'), mimeType };
        } catch (error) {
            return { success: false, error: `下载参考图失败: ${error.message}` };
        }
    }

    async saveBase64Video(base64Data, prefix = 'veo', mimeType = 'video/mp4') {
        const extMap = {
            'video/mp4': 'mp4',
            'video/mpeg': 'mpeg',
            'video/mov': 'mov',
            'video/quicktime': 'mov',
            'video/webm': 'webm'
        };
        const ext = extMap[String(mimeType || '').toLowerCase()] || 'mp4';

        const uploadsDir = path.join(__dirname, '../../uploads/pet-stages');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }

        const filename = `${prefix}_${Date.now()}.${ext}`;
        const filePath = path.join(uploadsDir, filename);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return `/uploads/pet-stages/${filename}`;
    }

    /**
     * 获取MIME类型
     */
    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif'
        };
        return mimeTypes[ext] || 'image/jpeg';
    }

    /**
     * 从数据库获取提示词模板
     * @param {string} promptKey - 提示词标识
     * @returns {string|null} 提示词模板
     */
    async getPromptTemplate(promptKey) {
        try {
            const { query } = require('../config/database');
            const [prompt] = await query(
                'SELECT prompt_template FROM ai_prompts WHERE prompt_key = ? AND is_active = TRUE',
                [promptKey]
            );
            return prompt ? prompt.prompt_template : null;
        } catch (error) {
            console.error(`[AIService] 获取提示词失败 [${promptKey}]:`, error.message);
            return null;
        }
    }

    /**
     * 替换提示词模板中的变量
     * @param {string} template - 提示词模板
     * @param {Object} variables - 变量对象 {word, translation, ...}
     * @returns {string} 替换后的提示词
     */
    replaceTemplateVariables(template, variables) {
        let result = template;
        for (const [key, value] of Object.entries(variables)) {
            result = result.replace(new RegExp(`{{${key}}}`, 'g'), value || '');
        }
        // 处理条件语法 {{#if variable}}content{{/if}}
        result = result.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (match, varName, content) => {
            return variables[varName] ? content : '';
        });
        result = result.replace(/{{#unless (\w+)}}([\s\S]*?){{\/unless}}/g, (match, varName, content) => {
            return !variables[varName] ? content : '';
        });
        return result;
    }

    /**
     * 使用 AI 增强单词数据
     * 生成音标、翻译（如果缺失）、例句、例句翻译、语法详解
     * @param {string} word - 英语单词
     * @param {string} translation - 中文翻译（可选）
     * @param {string} customPrompt - 自定义提示词（可选）
     * @returns {Object} 增强后的单词数据
     */
    async enhanceWordData(word, translation = '', customPrompt = null) {
        // 配置了 PROXY_BASE_URL 时，走美国服务器代理
        if (process.env.PROXY_BASE_URL) {
            return this._enhanceWordViaProxy(word, translation, customPrompt);
        }

        try {
            console.log(`[AIService] 增强单词数据: ${word}`);

            const needTranslation = !translation || translation.trim() === '';

            // 优先使用自定义提示词，否则从数据库获取，最后使用默认
            let promptTemplate = customPrompt;
            if (!promptTemplate) {
                promptTemplate = await this.getPromptTemplate('word_enhance');
            }

            let prompt;
            if (promptTemplate) {
                prompt = this.replaceTemplateVariables(promptTemplate, {
                    word,
                    translation: needTranslation ? '' : translation
                });
            } else {
                // 默认提示词（兜底）
                prompt = `You are an English teacher creating learning materials for Chinese children (ages 5-10).

For the English word "${word}"${needTranslation ? '' : ` (meaning: ${translation})`}, please provide:

1. **phonetic**: IPA phonetic transcription (e.g., /ˈæpl/)
${needTranslation ? '2. **translation**: Chinese translation of the word' : ''}
3. **example_sentence**: A simple, fun English sentence using this word (suitable for children, max 10 words)
4. **example_translation**: Chinese translation of the example sentence
5. **grammar_explanation**: Brief grammar analysis of the example sentence in Chinese (explain word types, sentence structure, key grammar points - keep it concise, 2-3 sentences max)

Respond ONLY with a valid JSON object in this exact format:
{
  "phonetic": "/ˈæpl/",
  ${needTranslation ? '"translation": "苹果",' : ''}
  "example_sentence": "I like to eat apples.",
  "example_translation": "我喜欢吃苹果。",
  "grammar_explanation": "这是一个简单的主谓宾句式。I(主语)+like(谓语动词)+to eat apples(不定式做宾语)。like to do表示喜欢做某事。"
}`;
            }

            const headers = await this.vertexAuth.getAuthHeaders();
            const response = await axios.post(
                this.vertexAuth.getUrl('gemini-2.5-flash'),
                {
                    contents: [{
                        role: 'user',
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 1024
                    }
                },
                { headers, timeout: 30000 }
            );

            const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                // 提取 JSON
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const data = JSON.parse(jsonMatch[0]);
                    console.log(`[AIService] 增强成功: ${word}`);
                    return {
                        success: true,
                        prompt: prompt, // 返回使用的提示词
                        data: {
                            word: data.word || word,
                            phonetic: data.phonetic || '',
                            // 支持多种字段名
                            translation: data.translation || data.chinese_translation || translation,
                            example_sentence: data.example_sentence || '',
                            example_translation: data.example_translation || data.example_sentence_translation || '',
                            grammar_explanation: data.grammar_explanation || data.grammar_explanation_cn || ''
                        }
                    };
                }
            }

            console.error(`[AIService] 增强失败: ${word} - 无法解析响应`);
            return { success: false, error: '无法解析AI响应', word, prompt };
        } catch (error) {
            console.error(`[AIService] 增强单词错误 [${word}]:`, error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || error.message,
                word
            };
        }
    }

    /**
     * 批量增强单词数据
     * @param {Array} words - 单词列表 [{word, translation?}, ...]
     * @param {string} customPrompt - 自定义提示词（可选）
     * @returns {Object} { results: Array, promptUsed: string }
     */
    async batchEnhanceWords(words, customPrompt = null) {
        const results = [];
        let promptUsed = null;

        for (const item of words) {
            const result = await this.enhanceWordData(item.word, item.translation, customPrompt);
            if (!promptUsed && result.prompt) {
                promptUsed = result.prompt;
            }
            if (result.success) {
                results.push(result.data);
            } else {
                // 失败时返回原始数据
                results.push({
                    word: item.word,
                    translation: item.translation || '',
                    phonetic: '',
                    example_sentence: '',
                    example_translation: '',
                    grammar_explanation: '',
                    error: result.error
                });
            }
            // 避免速率限制
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        return { results, promptUsed };
    }

    /**
     * 通过美国代理服务器增强单词数据
     */
    async _enhanceWordViaProxy(word, translation, customPrompt) {
        try {
            console.log(`[AIService] 通过代理增强单词: ${word}`);

            // 先从本地数据库读取提示词模板（数据库在腾讯云，可直接访问）
            let prompt = customPrompt;
            if (!prompt) {
                const template = await this.getPromptTemplate('word_enhance');
                if (template) {
                    const needTranslation = !translation || !translation.trim();
                    prompt = this.replaceTemplateVariables(template, {
                        word,
                        translation: needTranslation ? '' : translation
                    });
                }
            }

            const response = await this._postProxyWithRetry(
                '/proxy/enhance-word',
                { word, translation, prompt },
                { timeout: 35000, maxAttempts: 3, baseDelayMs: 1200 }
            );

            if (response.data.success && response.data.data) {
                const data = response.data.data;
                console.log(`[AIService] 代理增强成功: ${word}`);
                return {
                    success: true,
                    prompt,
                    data: {
                        word: data.word || word,
                        phonetic: data.phonetic || '',
                        translation: data.translation || data.chinese_translation || translation,
                        example_sentence: data.example_sentence || '',
                        example_translation: data.example_translation || data.example_sentence_translation || '',
                        grammar_explanation: data.grammar_explanation || data.grammar_explanation_cn || ''
                    }
                };
            }

            return { success: false, error: response.data.error || '代理返回失败', word };
        } catch (error) {
            const proxyErr = this._extractProxyError(error);
            console.error(`[AIService] 代理增强失败 [${word}]:`, proxyErr.status, proxyErr.message);
            return { success: false, error: `代理服务不可用: ${proxyErr.message}`, word };
        }
    }

    /**
     * 翻译文本 (使用有道翻译API)
     * @param {string} text - 要翻译的英文文本
     * @returns {Object} { success: boolean, translation?: string, error?: string }
     */
    async translateText(text) {
        try {
            const appKey = process.env.YOUDAO_APP_KEY;
            const appSecret = process.env.YOUDAO_APP_SECRET;

            if (!appKey || !appSecret) {
                console.warn('[AIService] 有道翻译API未配置，使用Gemini翻译');
                return await this.translateWithGemini(text);
            }

            const salt = uuidv4();
            const curtime = Math.floor(Date.now() / 1000).toString();
            const input = text.length > 20 ? text.substring(0, 10) + text.length + text.substring(text.length - 10) : text;
            const signStr = appKey + input + salt + curtime + appSecret;
            const sign = crypto.createHash('sha256').update(signStr).digest('hex');

            const response = await axios.post('https://openapi.youdao.com/api', null, {
                params: {
                    q: text,
                    from: 'en',
                    to: 'zh-CHS',
                    appKey: appKey,
                    salt: salt,
                    sign: sign,
                    signType: 'v3',
                    curtime: curtime
                }
            });

            if (response.data.errorCode === '0' && response.data.translation) {
                return {
                    success: true,
                    translation: response.data.translation[0]
                };
            } else {
                console.error('[AIService] 有道翻译失败:', response.data);
                return { success: false, error: '翻译失败: ' + response.data.errorCode };
            }
        } catch (error) {
            console.error('[AIService] 翻译错误:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * 使用Gemini翻译 (备用方案)
     */
    async translateWithGemini(text) {
        try {
            const prompt = `Translate the following English text to Chinese. Only respond with the translation, nothing else.\n\nText: ${text}`;
            const result = await this.callGeminiText(prompt);
            if (result.success && result.text) {
                return { success: true, translation: result.text.trim() };
            }
            return { success: false, error: result.error || '无翻译结果' };
        } catch (error) {
            console.error('[AIService] Gemini翻译错误:', error.message);
            return { success: false, error: error.message };
        }
    }

    /**
     * 获取音标 (使用有道词典API或Gemini)
     * @param {string} text - 单词或短语
     * @returns {Object} { success: boolean, phonetic?: string, error?: string }
     */
    async getPhonetic(text) {
        try {
            const prompt = `Provide the IPA (International Phonetic Alphabet) pronunciation for the following English text. Only respond with the IPA notation, nothing else. If it's a sentence, provide the pronunciation for key words separated by spaces.\n\nText: ${text}`;
            const result = await this.callGeminiText(prompt);
            if (result.success && result.text) {
                // 清理结果，移除所有外层斜杠
                let phonetic = result.text.trim().replace(/^\/+/, '').replace(/\/+$/, '');
                return { success: true, phonetic };
            }
            return { success: false, error: result.error || '无法获取音标' };
        } catch (error) {
            console.error('[AIService] 获取音标错误:', error.message, error.stack);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new AIService();
