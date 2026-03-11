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
require('dotenv').config(); // Ensure env vars are loaded

/**
 * Google Gemini AI 图片生成服务
 */
class AIService {
    constructor() {
        this.apiKey = config.googleAI.apiKey;
        this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
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
     * 通用图片生成方法 - 优先走代理（腾讯云），直连作为降级
     * @param {string} prompt - 完整的图片生成提示词
     */
    async generateImage(prompt) {
        // 配置了 PROXY_BASE_URL 时，走美国服务器代理
        if (process.env.PROXY_BASE_URL) {
            return this._generateImageViaProxy(prompt);
        }

        try {
            console.log('[AIService] 开始生成图片 (Nano Banana)...');
            console.log('[AIService] Prompt:', prompt.substring(0, 100) + '...');

            // 使用 Gemini 2.0 Flash Image Generation 模型
            const response = await axios.post(
                `${this.baseUrl}/models/gemini-2.0-flash-preview-image-generation:generateContent?key=${this.apiKey}`,
                {
                    contents: [{
                        parts: [{
                            text: prompt
                        }]
                    }],
                    generationConfig: {
                        responseModalities: ["image", "text"]
                    }
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    timeout: 120000 // 120秒超时
                }
            );

            // 检查响应中是否有图片数据
            const candidates = response.data.candidates;
            if (candidates && candidates.length > 0) {
                const parts = candidates[0].content?.parts || [];

                for (const part of parts) {
                    if (part.inlineData && part.inlineData.mimeType?.startsWith('image/')) {
                        const imageData = part.inlineData.data;
                        const imagePath = await this.saveBase64Image(imageData, `gen_${Date.now()}`);

                        console.log('[AIService] Nano Banana 图片生成成功:', imagePath);
                        return {
                            success: true,
                            imageUrl: imagePath
                        };
                    }
                }

                // 如果没有图片，输出调试信息
                console.log('[AIService] Gemini 未返回图片，响应:', JSON.stringify(parts).substring(0, 500));
            }

            return {
                success: false,
                error: '图片生成未返回有效数据，请稍后重试'
            };
        } catch (error) {
            console.error('[AIService] Nano Banana 生成图片错误:', error.response?.data || error.message);

            return {
                success: false,
                error: error.response?.data?.error?.message || error.message || '图片生成服务暂不可用'
            };
        }
    }

    /**
     * 生成场景图片
     * @param {string} sceneName - 场景名称
     * @param {string} description - 场景描述
     */
    async generateSceneImage(sceneName, description = '') {
        try {
            const prompt = `A detailed illustration of ${sceneName} scene for children's English learning. ${description}. 
        The image should contain various clearly visible objects that children can learn English words from. 
        Educational, colorful, engaging, with labeled objects. High quality, suitable for young learners.`;

            const response = await axios.post(
                `${this.baseUrl}/models/imagen-3.0-generate-002:predict`,
                {
                    instances: [{ prompt }],
                    parameters: {
                        sampleCount: 1,
                        aspectRatio: '16:9',
                        safetyFilterLevel: 'block_some'
                    }
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json'
                    }
                }
            );

            if (response.data.predictions && response.data.predictions.length > 0) {
                const imageData = response.data.predictions[0].bytesBase64Encoded;
                const imagePath = await this.saveBase64Image(imageData, `scene_${sceneName}`);

                return {
                    success: true,
                    imageUrl: imagePath,
                    sceneName
                };
            }

            return { success: false, error: '场景图片生成失败' };
        } catch (error) {
            console.error('生成场景图片错误:', error.response?.data || error.message);
            return {
                success: false,
                error: error.response?.data?.error?.message || '场景图片生成服务暂不可用'
            };
        }
    }

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

            const response = await axios.post(
                `${this.baseUrl}/models/gemini-2.0-flash-exp:generateContent?key=${this.apiKey}`,
                {
                    contents: [{
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
                { headers: { 'Content-Type': 'application/json' } }
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

            const response = await axios.post(
                `${this.baseUrl}/models/gemini-2.0-flash-exp:generateContent?key=${this.apiKey}`,
                {
                    contents: [{
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
                    headers: {
                        'Content-Type': 'application/json'
                    }
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

                return {
                    success: true,
                    engine: 'youdao',
                    words: words
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
    async _generateImageViaProxy(prompt) {
        try {
            console.log('[AIService] 通过代理生成图片...');
            const response = await axios.post(
                `${process.env.PROXY_BASE_URL}/proxy/generate-image`,
                { prompt },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Proxy-Key': process.env.PROXY_API_KEY || ''
                    },
                    timeout: 130000
                }
            );

            if (response.data.success && response.data.imageData) {
                const imageUrl = await this.saveBase64Image(response.data.imageData, `gen_${Date.now()}`);
                console.log('[AIService] 代理图片生成成功:', imageUrl);
                return { success: true, imageUrl };
            }

            return { success: false, error: response.data.error || '代理返回失败' };
        } catch (error) {
            console.error('[AIService] 代理图片生成失败:', error.message);
            return { success: false, error: `代理服务不可用: ${error.message}` };
        }
    }

    /**
     * 保存Base64图片：优先上传 COS，不可用时回退到本地
     */
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

        // 回退：保存到本地
        const uploadsDir = path.join(__dirname, '../../uploads/images');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        const filename = `${prefix}_${Date.now()}.png`;
        const filePath = path.join(uploadsDir, filename);
        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
        return `/uploads/images/${filename}`;
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

            const response = await axios.post(
                `${this.baseUrl}/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
                {
                    contents: [{
                        parts: [{ text: prompt }]
                    }],
                    generationConfig: {
                        temperature: 0.3,
                        maxOutputTokens: 1024
                    }
                },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 30000
                }
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

            const response = await axios.post(
                `${process.env.PROXY_BASE_URL}/proxy/enhance-word`,
                { word, translation, prompt },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Proxy-Key': process.env.PROXY_API_KEY || ''
                    },
                    timeout: 35000
                }
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
            console.error(`[AIService] 代理增强失败 [${word}]:`, error.message);
            return { success: false, error: `代理服务不可用: ${error.message}`, word };
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
            const response = await axios.post(
                `${this.baseUrl}/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
                {
                    contents: [{
                        parts: [{
                            text: `Translate the following English text to Chinese. Only respond with the translation, nothing else.\n\nText: ${text}`
                        }]
                    }]
                }
            );

            const result = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (result) {
                return { success: true, translation: result.trim() };
            }
            return { success: false, error: '无翻译结果' };
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
            // 先尝试使用Gemini生成音标
            const response = await axios.post(
                `${this.baseUrl}/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
                {
                    contents: [{
                        parts: [{
                            text: `Provide the IPA (International Phonetic Alphabet) pronunciation for the following English text. Only respond with the IPA notation, nothing else. If it's a sentence, provide the pronunciation for key words separated by spaces.\n\nText: ${text}`
                        }]
                    }]
                }
            );

            const result = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (result) {
                // 清理结果，移除可能的斜杠
                let phonetic = result.trim().replace(/^\//, '').replace(/\/$/, '');
                return { success: true, phonetic };
            }
            return { success: false, error: '无法获取音标' };
        } catch (error) {
            console.error('[AIService] 获取音标错误:', error.message);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new AIService();
