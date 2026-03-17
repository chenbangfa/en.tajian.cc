/**
 * Google AI 中转代理服务
 * 运行在美国本地服务器，专门处理需要访问 Google API 的请求
 * 腾讯云服务器通过此代理调用 Google Gemini AI
 */
const express = require('express');
const axios = require('axios');
const path = require('path');
const sharp = require('sharp');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PROXY_PORT || 3005;
const API_KEY = process.env.PROXY_API_KEY;
const GOOGLE_AI_KEY = process.env.GOOGLE_AI_KEY;
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

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
        service: 'Google AI Proxy',
        googleKey: GOOGLE_AI_KEY ? 'configured' : 'MISSING',
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
    const { prompt } = req.body;
    if (!prompt) {
        return res.status(400).json({ success: false, error: '缺少 prompt 参数' });
    }

    if (!GOOGLE_AI_KEY) {
        return res.status(500).json({ success: false, error: '未配置 GOOGLE_AI_KEY' });
    }

    try {
        console.log(`[Proxy] 生成图片, prompt: ${prompt.substring(0, 80)}...`);

        const response = await axios.post(
            `${GEMINI_BASE}/models/gemini-2.5-flash-image:generateContent?key=${GOOGLE_AI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseModalities: ['image', 'text'] }
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
        );

        const parts = response.data.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
            if (part.inlineData?.mimeType?.startsWith('image/')) {
                const rawBuffer = Buffer.from(part.inlineData.data, 'base64');
                const rawKB = Math.round(rawBuffer.length / 1024);

                // 压缩：最大 1024px，JPEG quality=82，目标 ~150-250KB
                const compressed = await sharp(rawBuffer)
                    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
                    .jpeg({ quality: 82, progressive: true })
                    .toBuffer();

                console.log(`[Proxy] 图片生成成功, 原始 ${rawKB}KB → 压缩后 ${Math.round(compressed.length / 1024)}KB`);
                return res.json({
                    success: true,
                    imageData: compressed.toString('base64'),
                    mimeType: 'image/jpeg'
                });
            }
        }

        res.json({ success: false, error: '图片生成未返回有效数据，请稍后重试' });
    } catch (error) {
        console.error('[Proxy] generate-image error:', error.response?.data || error.message);
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
    if (!word) {
        return res.status(400).json({ success: false, error: '缺少 word 参数' });
    }

    if (!GOOGLE_AI_KEY) {
        return res.status(500).json({ success: false, error: '未配置 GOOGLE_AI_KEY' });
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

        console.log(`[Proxy] 增强单词: ${word}`);

        const response = await axios.post(
            `${GEMINI_BASE}/models/gemini-2.0-flash:generateContent?key=${GOOGLE_AI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        );

        const text = response.data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const data = JSON.parse(jsonMatch[0]);
                console.log(`[Proxy] 单词增强成功: ${word}`);
                return res.json({ success: true, data });
            }
        }

        res.json({ success: false, error: '无法解析 AI 响应' });
    } catch (error) {
        console.error('[Proxy] enhance-word error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== Google TTS ====================
/**
 * POST /proxy/tts
 * body: { text, voice }
 * response: { success, audioData (base64 WAV), ext }
 */
app.post('/proxy/tts', auth, async (req, res) => {
    const { text, voice = 'female' } = req.body;
    if (!text) {
        return res.status(400).json({ success: false, error: '缺少 text 参数' });
    }

    if (!GOOGLE_AI_KEY) {
        return res.status(500).json({ success: false, error: '未配置 GOOGLE_AI_KEY' });
    }

    try {
        const voiceMap = { male: 'Puck', female: 'Aoede' };
        const voiceName = voiceMap[voice] || 'Aoede';

        console.log(`[Proxy] Google TTS: "${text.substring(0, 40)}", voice: ${voiceName}`);

        const response = await axios.post(
            `${GEMINI_BASE}/models/gemini-2.5-flash-preview-tts:generateContent?key=${GOOGLE_AI_KEY}`,
            {
                contents: [{ parts: [{ text: `Say in a clear voice: ${text}` }] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }
                }
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        );

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
        console.error('[Proxy] tts error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 播客句子分析 ====================
/**
 * POST /proxy/analyze-podcast
 * body: { text } - 完整的英文文章内容
 * response: { success, sentences: [...] }
 */
app.post('/proxy/analyze-podcast', auth, async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ success: false, error: '缺少 text 参数' });
    if (!GOOGLE_AI_KEY) return res.status(500).json({ success: false, error: '未配置 GOOGLE_AI_KEY' });

    const prompt = `You are an English language learning assistant for Chinese children beginners.
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
${text}`;

    try {
        console.log(`[Proxy] 分析播客句子, 文本长度: ${text.length}`);
        const response = await axios.post(
            `${GEMINI_BASE}/models/gemini-2.0-flash:generateContent?key=${GOOGLE_AI_KEY}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
        );

        let raw = response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        raw = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.sentences)) {
            return res.json({ success: false, error: 'AI返回格式错误' });
        }
        console.log(`[Proxy] 播客分析成功, ${parsed.sentences.length} 句`);
        res.json({ success: true, sentences: parsed.sentences });
    } catch (error) {
        console.error('[Proxy] analyze-podcast error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: error.message });
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
    console.log(`🌐 Google AI Proxy 启动成功: http://localhost:${PORT}`);
    console.log(`🔑 API Key 鉴权: ${API_KEY ? '已启用' : '未启用（开发模式）'}`);
    console.log(`🤖 Google AI Key: ${GOOGLE_AI_KEY ? '已配置' : '❌ 未配置'}`);
});
