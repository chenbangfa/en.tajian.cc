const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const cosService = require('./cos.service');

/**
 * 语音服务 - 支持多引擎TTS + 语音评测
 * 
 * TTS 引擎切换:
 *   在 .env 中设置 TTS_ENGINE=google / tencent / youdao / volcengine
 *   中文可单独设置 CHINESE_TTS_ENGINE；未设置时跟随 TTS_ENGINE
 *   如果首选引擎失败，会自动尝试下一个引擎（fallback）
 */
class VoiceService {
    constructor() {
        this.youdaoConfig = config.youdao;
        this.tencentConfig = config.tencent;
        // TTS 引擎优先级（可通过环境变量 TTS_ENGINE 设置首选）
        this.preferredEngine = this.normalizeEngine(process.env.TTS_ENGINE || 'google');
        // 评测引擎（可通过环境变量 ASSESS_ENGINE 设置，默认 tencent）
        this.assessEngine = (process.env.ASSESS_ENGINE || 'tencent').toLowerCase();
        console.log(`[VoiceService] TTS 引擎: ${this.preferredEngine} (可在.env中修改 TTS_ENGINE)`);
        console.log(`[VoiceService] 评测引擎: ${this.assessEngine} (可在.env中修改 ASSESS_ENGINE)`);
    }

    normalizeSpeed(speed, fallback = 1.0) {
        const parsed = Number(speed);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(0.7, Math.min(1.2, parsed));
    }

    getGoogleTtsSpeed(scope = 'default') {
        const envMap = {
            picture_book: process.env.GOOGLE_TTS_SPEED_PICTURE_BOOK,
            dialogue: process.env.GOOGLE_TTS_SPEED_DIALOGUE,
            podcast: process.env.GOOGLE_TTS_SPEED_PODCAST,
            default: process.env.GOOGLE_TTS_SPEED_DEFAULT
        };
        const fallbackMap = {
            picture_book: 0.92,
            dialogue: 0.98,
            podcast: 0.96,
            default: 1.0
        };
        return this.normalizeSpeed(envMap[scope], fallbackMap[scope] || fallbackMap.default);
    }

    normalizeEngine(engine = '') {
        const normalized = String(engine || '').trim().toLowerCase();
        if (['doubao', 'volc'].includes(normalized)) return 'volcengine';
        if (['google', 'youdao', 'tencent', 'volcengine', 'auto'].includes(normalized)) return normalized;
        return 'auto';
    }

    prepareChineseTtsText(text = '') {
        const original = String(text || '').trim();
        if (!original) return '';

        let cleaned = original
            // 词义里经常混入英文括注，如“梨(Pear)”，中文 TTS 只读中文部分。
            .replace(/（\s*[A-Za-z][^）]*）/g, '')
            .replace(/\(\s*[A-Za-z][^)]*\)/g, '')
            .replace(/\/[^/\u4e00-\u9fff]*\//g, '')
            .replace(/\s+/g, ' ')
            .trim();

        const parts = cleaned
            .split(/[;；,，、|/]+/)
            .map(part => part.trim())
            .filter(Boolean)
            .filter(part => /[\u3400-\u9fff]/.test(part) || !/[A-Za-z]/.test(part));

        if (parts.length) cleaned = parts.join('，');
        if (/[\u3400-\u9fff]/.test(cleaned)) {
            cleaned = cleaned
                .replace(/[A-Za-z][A-Za-z\s'’.-]*/g, '')
                .replace(/\s+/g, '')
                .replace(/[，,、；;：:]+$/g, '')
                .trim();
        }
        return /[\u3400-\u9fff]/.test(cleaned) ? cleaned : original;
    }

    async textToSpeechByEngine(text, engine = 'auto', voice = 'female', speed = 1.0) {
        const normalizedEngine = this.normalizeEngine(engine);

        switch (normalizedEngine) {
            case 'google':
                return this._googleTTS(text, voice, speed);
            case 'youdao':
                return this._youdaoTTS(text, voice, speed);
            case 'tencent':
                return this._tencentTTS(text, voice, speed);
            case 'volcengine':
                return this._volcengineTTS(text, voice, speed);
            default:
                return this.textToSpeech(text, voice, speed);
        }
    }

    /**
     * 统一 TTS 入口 - 自动选择引擎 + fallback
     * @param {string} text - 要合成的文本
     * @param {string} voice - 声音类型 (male/female)
     * @param {number} speed - 语速
     */
    async textToSpeech(text, voice = 'female', speed = 1.0) {
        // 构建引擎尝试顺序：首选引擎排第一，其余按顺序fallback
        const allEngines = ['volcengine', 'google', 'youdao', 'tencent'];
        const preferred = allEngines.includes(this.preferredEngine) ? this.preferredEngine : 'youdao';
        const engines = [preferred, ...allEngines.filter(e => e !== preferred)];

        for (let i = 0; i < engines.length; i++) {
            const engine = engines[i];
            const isFirstTry = (i === 0);

            try {
                let result;
                switch (engine) {
                    case 'google':
                        result = await this._googleTTS(text, voice, speed);
                        break;
                    case 'tencent':
                        result = await this._tencentTTS(text, voice, speed);
                        break;
                    case 'volcengine':
                        result = await this._volcengineTTS(text, voice, speed);
                        break;
                    case 'youdao':
                        result = await this._youdaoTTS(text, voice, speed);
                        break;
                    default:
                        continue;
                }

                if (result.success) {
                    if (!isFirstTry) {
                        console.log(`[VoiceService] ${this.preferredEngine} 失败, ${engine} 成功 (fallback)`);
                    }
                    return result;
                }

                // 不成功但没抛异常：429限速或配置缺失等
                console.warn(`[VoiceService] ${engine} TTS 失败: ${result.error}`);

                // 如果是最后一个引擎，直接返回失败结果
                if (i === engines.length - 1) return result;

            } catch (error) {
                console.warn(`[VoiceService] ${engine} TTS 异常: ${error.message}`);
                if (i === engines.length - 1) {
                    return { success: false, error: `所有TTS引擎均失败: ${error.message}`, statusCode: error.response?.status };
                }
            }
        }

        return { success: false, error: '所有TTS引擎均不可用' };
    }

    async googleTextToSpeech(text, voice = 'female', speed = 1.0) {
        return this._googleTTS(text, voice, this.normalizeSpeed(speed, 1.0));
    }

    async textToSpeechChinese(text, voice = 'female', speed = 1.0) {
        const ttsText = this.prepareChineseTtsText(text);
        if (!ttsText) return { success: false, error: '中文TTS文本为空' };

        const normalizedSpeed = this.normalizeSpeed(speed, 1.0);
        const configuredEngine = this.normalizeEngine(process.env.CHINESE_TTS_ENGINE || this.preferredEngine || 'youdao');
        const allowTencentFallback = String(process.env.ALLOW_TENCENT_TTS_FALLBACK || '').toLowerCase() === 'true';
        const defaultChineseEngines = ['volcengine', 'google'];
        let engines = configuredEngine === 'auto'
            ? defaultChineseEngines
            : [configuredEngine, ...defaultChineseEngines.filter(engine => engine !== configuredEngine)];
        // 只有显式指定 youdao 时才尝试它，避免中文被英文发音人误读。
        if (configuredEngine === 'youdao') {
            engines = ['youdao', ...defaultChineseEngines];
        }
        if (configuredEngine !== 'tencent' && allowTencentFallback) {
            engines.push('tencent');
        }
        if (configuredEngine !== 'tencent') {
            engines = engines.filter(engine => engine !== 'tencent');
        }

        for (const engine of engines) {
            try {
                let result;
                if (engine === 'youdao') {
                    result = await this._youdaoTTS(ttsText, voice, normalizedSpeed);
                } else if (engine === 'google') {
                    result = await this._googleTTS(ttsText, 'female', normalizedSpeed);
                } else if (engine === 'volcengine') {
                    result = await this._volcengineTTS(ttsText, voice, normalizedSpeed, { isChinese: true });
                } else if (engine === 'tencent') {
                    result = await this._tencentTTSChinese(ttsText, voice, normalizedSpeed);
                } else {
                    continue;
                }

                if (result.success) return { ...result, engine: result.engine || `${engine}-zh` };
                console.warn(`[VoiceService] 中文TTS ${engine} 失败: ${result.error}`);
            } catch (error) {
                console.warn(`[VoiceService] 中文TTS ${engine} 异常: ${error.message}`);
            }
        }

        return { success: false, error: `中文TTS均不可用: ${engines.join(', ')}` };
    }

    // ==================== 火山引擎 / 豆包 TTS V3 SSE ====================

    getVolcengineTtsConfig(voice = 'female', { isChinese = false } = {}) {
        const defaultSpeaker = process.env.VOLCENGINE_TTS_SPEAKER || 'zh_female_yingyujiaoyu_mars_bigtts';
        const chineseSpeaker = process.env.VOLCENGINE_TTS_SPEAKER_ZH || defaultSpeaker;
        const speakerMap = {
            female: process.env.VOLCENGINE_TTS_SPEAKER_FEMALE || defaultSpeaker,
            male: process.env.VOLCENGINE_TTS_SPEAKER_MALE || defaultSpeaker
        };
        return {
            appId: process.env.VOLCENGINE_TTS_APP_ID,
            accessKey: process.env.VOLCENGINE_TTS_ACCESS_KEY || process.env.VOLCENGINE_TTS_ACCESS_TOKEN,
            token: process.env.VOLCENGINE_TTS_ACCESS_TOKEN || process.env.VOLCENGINE_TTS_ACCESS_KEY,
            endpoint: process.env.VOLCENGINE_TTS_ENDPOINT || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse',
            resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID || 'seed-tts-1.0',
            speaker: isChinese ? chineseSpeaker : (speakerMap[voice] || speakerMap.female)
        };
    }

    resolveVolcengineSpeechRate(speed = 1.0) {
        const normalizedSpeed = this.normalizeSpeed(speed, 1.0);
        return Math.round((normalizedSpeed - 1.0) * 100);
    }

    async _volcengineTTS(text, voice = 'female', speed = 1.0, options = {}) {
        const cfg = this.getVolcengineTtsConfig(voice, options);
        if (!cfg.appId || !cfg.accessKey || !cfg.token) {
            return { success: false, error: 'Volcengine: 未配置 VOLCENGINE_TTS_APP_ID/ACCESS_KEY/ACCESS_TOKEN' };
        }

        const requestId = uuidv4();
        const payload = {
            user: { uid: `bookmelo_${Date.now()}` },
            req_params: {
                text,
                speaker: cfg.speaker,
                audio_params: {
                    format: 'mp3',
                    sample_rate: 24000,
                    speech_rate: this.resolveVolcengineSpeechRate(speed),
                    loudness_rate: Number(process.env.VOLCENGINE_TTS_LOUDNESS_RATE || 0)
                }
            }
        };

        console.log(`[TTS:Volcengine] speaker=${cfg.speaker}, text="${text.substring(0, 40)}..."`);

        const response = await axios.post(cfg.endpoint, payload, {
            responseType: 'stream',
            timeout: 60000,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
                'Authorization': `Bearer;${cfg.token}`,
                'X-Api-App-Id': cfg.appId,
                'X-Api-Access-Key': cfg.accessKey,
                'X-Api-Resource-Id': cfg.resourceId,
                'X-Api-Request-Id': requestId
            },
            validateStatus: () => true
        });

        let raw = '';
        for await (const chunk of response.data) {
            raw += chunk.toString('utf8');
        }

        if (response.status < 200 || response.status >= 300) {
            return { success: false, error: `Volcengine: HTTP ${response.status} ${raw.slice(0, 200)}` };
        }

        const audioChunks = [];
        const errors = [];
        for (const block of raw.split(/\n\n+/)) {
            const dataLines = block.split(/\n/).filter(line => line.startsWith('data:'));
            for (const line of dataLines) {
                const eventText = line.replace(/^data:\s*/, '').trim();
                if (!eventText || eventText === '[DONE]') continue;
                let event;
                try { event = JSON.parse(eventText); } catch { continue; }
                const code = Number(event.code);
                if (Number.isFinite(code) && ![0, 3000, 20000000].includes(code)) {
                    errors.push(event.message || `code=${event.code}`);
                }
                if (event.data) {
                    audioChunks.push(Buffer.from(event.data, 'base64'));
                }
            }
        }

        const audioBuffer = Buffer.concat(audioChunks);
        if (audioBuffer.length <= 500) {
            return { success: false, error: `Volcengine: 未返回有效音频${errors.length ? ` (${errors.join('; ')})` : ''}` };
        }

        const audioPath = await this.saveAudio(audioBuffer, 'tts_volc', 'mp3');
        console.log(`[TTS:Volcengine] ✅ 成功, ${audioBuffer.length} bytes`);
        return { success: true, audioUrl: audioPath, engine: 'volcengine' };
    }

    // ==================== Google Gemini TTS ====================

    buildGoogleTtsPrompt(text, speed = 1.0) {
        const normalizedSpeed = this.normalizeSpeed(speed, 1.0);
        if (normalizedSpeed <= 0.9) {
            return `Read this slowly, gently, and clearly for a child listener: ${text}`;
        }
        if (normalizedSpeed >= 1.1) {
            return `Read this clearly with a lively pace: ${text}`;
        }
        return `Read this clearly in a warm, natural voice: ${text}`;
    }

    async _googleTTSViaProxy(text, voice = 'female', speed = 1.0) {
        const proxyUrl = process.env.PROXY_BASE_URL;
        if (!proxyUrl) {
            return { success: false, error: 'Google: 未配置 PROXY_BASE_URL，无法通过美国代理请求 TTS' };
        }

        const headers = { 'Content-Type': 'application/json' };
        if (process.env.PROXY_API_KEY) {
            headers['X-Proxy-Key'] = process.env.PROXY_API_KEY;
        }

        let response;
        try {
            response = await axios.post(
                `${proxyUrl}/proxy/tts`,
                { text, voice, speed },
                { headers, timeout: 60000 }
            );
        } catch (err) {
            // 代理返回非 2xx 时 axios 抛异常，提取 JSON 错误信息
            const errData = err.response?.data;
            const errMsg = (typeof errData === 'object' && errData?.error) ? errData.error : (err.message || '代理请求失败');
            const statusCode = err.response?.status;
            const retryAfterMs = Number(err.response?.data?.retryAfterMs || err.retryAfterMs || 0);
            console.error(`[VoiceService] Google TTS 代理错误: ${statusCode} ${errMsg}`);
            return {
                success: false,
                error: `Google: ${errMsg}`,
                statusCode,
                retryAfterMs: retryAfterMs > 0 ? retryAfterMs : undefined
            };
        }

        if (response.data?.success && response.data?.audioData) {
            const audioBuffer = Buffer.from(response.data.audioData, 'base64');
            const ext = response.data.ext || 'wav';
            const audioPath = await this.saveAudio(audioBuffer, 'tts_google_proxy', ext);
            return { success: true, audioUrl: audioPath, engine: 'google-proxy' };
        }

        return { success: false, error: response.data?.error || 'Google: 代理未返回有效音频' };
    }

    async _googleTTS(text, voice = 'female', speed = 1.0) {
        if (process.env.PROXY_BASE_URL) {
            return this._googleTTSViaProxy(text, voice, speed);
        }

        const vertexAuth = require('../utils/vertex-auth');
        if (!vertexAuth.isConfigured) {
            return { success: false, error: 'Google: 未配置 Vertex AI' };
        }

        const voiceMap = { male: 'Puck', female: 'Aoede' };
        const voiceName = voiceMap[voice] || 'Aoede';

        console.log(`[TTS:Google] Vertex AI TTS, Voice: ${voiceName}, Text: ${text.substring(0, 30)}...`);

        const headers = await vertexAuth.getAuthHeaders();
        const response = await axios.post(
            vertexAuth.getUrl('gemini-2.5-flash-preview-tts'),
            {
                contents: [{ role: 'user', parts: [{ text: this.buildGoogleTtsPrompt(text, speed) }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName } }
                    }
                }
            },
            { headers, timeout: 30000 }
        );

        const candidates = response.data.candidates;
        if (candidates && candidates.length > 0) {
            const parts = candidates[0].content?.parts || [];
            for (const part of parts) {
                if (part.inlineData && part.inlineData.mimeType === 'audio/L16;codec=pcm;rate=24000') {
                    const pcmBuffer = Buffer.from(part.inlineData.data, 'base64');
                    const wavBuffer = this.addWavHeader(pcmBuffer, 24000, 1, 16);
                    const audioPath = await this.saveAudio(wavBuffer, 'tts', 'wav');
                    return { success: true, audioUrl: audioPath, engine: 'google' };
                }
            }
        }

        return { success: false, error: 'Google: Gemini API 未返回有效音频' };
    }

    // ==================== 腾讯云 TTS ====================

    async _tencentTTS(text, voice = 'female', speed = 1.0) {
        const { secretId, secretKey } = this.tencentConfig;
        if (!secretId || !secretKey) {
            return { success: false, error: 'Tencent: 未配置 TENCENT_SECRET_ID/KEY' };
        }

        // 腾讯云TTS VoiceType: 
        // 英文女声: 101051 (英文), 101003 (中英文), 101004 (中英文女声)
        // 英文男声: 101050 (英文), 101001 (中英文)
        const voiceTypeMap = { female: 101051, male: 101050 };
        const voiceType = voiceTypeMap[voice] || 101051;

        console.log(`[TTS:Tencent] VoiceType: ${voiceType}, Text: ${text.substring(0, 30)}...`);

        const timestamp = Math.floor(Date.now() / 1000);
        const host = 'tts.tencentcloudapi.com';
        const action = 'TextToVoice';
        const payload = {
            Text: text,
            SessionId: uuidv4(),
            VoiceType: voiceType,
            Volume: 5,       // 音量 0-10
            Speed: 0,        // 语速 -2~6
            Codec: 'wav',
            SampleRate: 16000,
            PrimaryLanguage: 2 // 2=英文
        };

        const result = await this.callTencentAPI(host, 'tts', action, payload, secretId, secretKey, timestamp);

        if (result.Response && result.Response.Audio) {
            const audioBuffer = Buffer.from(result.Response.Audio, 'base64');
            const audioPath = await this.saveAudio(audioBuffer, 'tts_tc', 'wav');
            return { success: true, audioUrl: audioPath, engine: 'tencent' };
        }

        const errMsg = result.Response?.Error?.Message || '腾讯云TTS未返回音频';
        return { success: false, error: `Tencent: ${errMsg}` };
    }

    getTencentChineseVoiceType(voice = 'female') {
        const voiceMap = {
            female: Number(process.env.TENCENT_CHINESE_VOICE_FEMALE || 101002),
            male: Number(process.env.TENCENT_CHINESE_VOICE_MALE || 101001)
        };
        return voiceMap[voice] || voiceMap.female;
    }

    resolveTencentSpeedValue(speed = 1.0) {
        const normalizedSpeed = this.normalizeSpeed(speed, 1.0);
        if (normalizedSpeed <= 0.75) return -2;
        if (normalizedSpeed <= 0.9) return -1;
        if (normalizedSpeed >= 1.18) return 2;
        if (normalizedSpeed >= 1.08) return 1;
        return 0;
    }

    async _tencentTTSChinese(text, voice = 'female', speed = 1.0) {
        const { secretId, secretKey } = this.tencentConfig;
        if (!secretId || !secretKey) {
            return { success: false, error: 'Tencent: 未配置 TENCENT_SECRET_ID/KEY' };
        }

        const voiceType = this.getTencentChineseVoiceType(voice);
        const timestamp = Math.floor(Date.now() / 1000);
        const host = 'tts.tencentcloudapi.com';
        const action = 'TextToVoice';
        const payload = {
            Text: text,
            SessionId: uuidv4(),
            VoiceType: voiceType,
            Volume: 5,
            Speed: this.resolveTencentSpeedValue(speed),
            Codec: 'wav',
            SampleRate: 16000,
            PrimaryLanguage: 1
        };

        console.log(`[TTS:Tencent:ZH] VoiceType: ${voiceType}, Text: ${text.substring(0, 30)}...`);

        const result = await this.callTencentAPI(host, 'tts', action, payload, secretId, secretKey, timestamp);

        if (result.Response && result.Response.Audio) {
            const audioBuffer = Buffer.from(result.Response.Audio, 'base64');
            const audioPath = await this.saveAudio(audioBuffer, 'tts_tc_zh', 'wav');
            return { success: true, audioUrl: audioPath, engine: 'tencent-zh' };
        }

        const errMsg = result.Response?.Error?.Message || '腾讯云中文TTS未返回音频';
        return { success: false, error: `Tencent: ${errMsg}` };
    }

    // ==================== 有道 TTS ====================
    // 文档: https://ai.youdao.com/DOCSIRMA/html/tts/api/yyhc/index.html
    // voiceName 发音人参数（必填）
    // speed: "1" 正常语速, 最小 "0.5", 最大 "2.0"

    async _youdaoTTS(text, voice = 'female', speed = 1.0) {
        const { appKey, appSecret } = this.youdaoConfig;
        if (!appKey || !appSecret) {
            return { success: false, error: 'Youdao: 未配置 YOUDAO_APP_KEY/SECRET' };
        }

        // 有道发音人: 英文美式女声 youxiaomei, 英文英式男声 youxiaoguan
        // 可选: youxiaoying(英式女), youyating(美式女), Saila(英式女), youxiaowei(英中男)
        const voiceNameMap = {
            female: process.env.YOUDAO_VOICE_FEMALE || 'youxiaomei',
            male: process.env.YOUDAO_VOICE_MALE || 'youxiaoguan'
        };
        const voiceName = voiceNameMap[voice] || 'youxiaomei';

        // 语速: 女声正常(1.0), 男声慢速(0.8) - 方便听清
        const speedMap = {
            female: process.env.YOUDAO_SPEED_FEMALE || '1',
            male: process.env.YOUDAO_SPEED_MALE || '0.8'
        };
        const ttsSpeed = speedMap[voice] || '1';

        const salt = uuidv4();
        const curtime = Math.floor(Date.now() / 1000).toString();

        // 签名: sha256(appKey + input + salt + curtime + appSecret)
        const input = text.length > 20
            ? text.substring(0, 10) + text.length + text.substring(text.length - 10)
            : text;
        const sign = crypto.createHash('sha256')
            .update(appKey + input + salt + curtime + appSecret)
            .digest('hex');

        console.log(`[TTS:Youdao] voiceName=${voiceName}, speed=${ttsSpeed}, text="${text.substring(0, 40)}..."`);

        const response = await axios.post(
            'https://openapi.youdao.com/ttsapi',
            new URLSearchParams({
                q: text,
                appKey: appKey,
                salt: salt,
                sign: sign,
                signType: 'v3',
                curtime: curtime,
                voiceName: voiceName,
                format: 'mp3',
                speed: ttsSpeed,
                volume: '1.00'
            }).toString(),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                responseType: 'arraybuffer',
                timeout: 15000
            }
        );

        // 成功返回: Content-Type: audio/mp3, 二进制数据
        // 失败返回: Content-Type: application/json, JSON错误
        const contentType = response.headers['content-type'] || '';

        if (contentType.includes('audio') || contentType.includes('mp3') || contentType.includes('octet-stream')) {
            const audioBuffer = Buffer.from(response.data);
            if (audioBuffer.length > 500) {
                const audioPath = await this.saveAudio(audioBuffer, 'tts_yd', 'mp3');
                console.log(`[TTS:Youdao] ✅ 成功, ${audioBuffer.length} bytes`);
                return { success: true, audioUrl: audioPath, engine: 'youdao' };
            }
        }

        // 解析错误JSON
        try {
            const errText = Buffer.from(response.data).toString('utf-8');
            const errJson = JSON.parse(errText);
            const code = errJson.errorCode;
            console.error(`[TTS:Youdao] ❌ errorCode=${code}`);
            return { success: false, error: `Youdao: errorCode=${code}` };
        } catch {
            return { success: false, error: 'Youdao: 返回数据异常' };
        }
    }

    // ==================== 公共方法 ====================

    /**
     * 为 PCM 数据添加 WAV 头
     */
    addWavHeader(samples, sampleRate, numChannels, bitDepth) {
        const byteRate = sampleRate * numChannels * bitDepth / 8;
        const blockAlign = numChannels * bitDepth / 8;
        const dataSize = samples.length;
        const chunkSize = 36 + dataSize;

        const buffer = Buffer.alloc(44);
        buffer.write('RIFF', 0);
        buffer.writeUInt32LE(chunkSize, 4);
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

    /**
     * 统一评测入口 - 根据 ASSESS_ENGINE 选择引擎
     */
    async assessPronunciation(audioPath, referenceText, contentType = 'sentence') {
        if (this.assessEngine === 'youdao') {
            return this._youdaoAssess(audioPath, referenceText, contentType);
        }
        return this._tencentAssess(audioPath, referenceText, contentType);
    }

    /**
     * 有道口语评测 (ISE API)
     * 文档: https://ai.youdao.com/DOCSIRMA/html/tts/api/yypc/index.html
     *
     * 注意：q = base64音频数据，text = 评测参考文本
     * 签名基于 q（音频base64）而非文本，signType 固定 v2
     */
    async _youdaoAssess(audioPath, referenceText, contentType = 'sentence') {
        const { appKey, appSecret } = this.youdaoConfig;
        if (!appKey || !appSecret) {
            return { success: false, error: '评测服务未配置，请联系管理员' };
        }

        try {
            const audioBuffer = fs.readFileSync(audioPath);
            const audioBase64 = audioBuffer.toString('base64');

            // 判断音频格式（小程序录 mp3，如报 2005 错误需改为 wav）
            const ext = path.extname(audioPath).toLowerCase().replace('.', '') || 'mp3';

            const salt = uuidv4();
            const curtime = Math.floor(Date.now() / 1000).toString();

            // 签名基于 q（音频base64），signType 固定 v2（文档规定）
            const q = audioBase64;
            const input = q.length > 20
                ? q.substring(0, 10) + q.length + q.substring(q.length - 10)
                : q;
            const sign = crypto.createHash('sha256')
                .update(appKey + input + salt + curtime + appSecret)
                .digest('hex');

            console.log(`[Assess:Youdao] 评测 "${referenceText}"`);

            const response = await axios.post(
                'https://openapi.youdao.com/iseapi',
                new URLSearchParams({
                    q: audioBase64,       // 音频 base64
                    text: referenceText,  // 参考文本
                    langType: 'en',
                    appKey,
                    salt,
                    curtime,
                    sign,
                    signType: 'v2',
                    format: 'wav',
                    rate: '16000',
                    channel: '1',
                    type: '1'             // 固定: base64上传
                }).toString(),
                {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 15000
                }
            );

            const data = response.data;
            console.log('[Assess:Youdao] 原始响应:', JSON.stringify(data).substring(0, 400));

            if (data.errorCode && data.errorCode !== '0') {
                console.error(`[Assess:Youdao] 错误 errorCode=${data.errorCode}`);
                return { success: false, error: '评测服务开小差了，请稍后重试' };
            }

            // 响应字段在顶层（无 result 嵌套）
            // 对于单词评测，overall 会被 fluency/integrity 拖低（短词无意义）
            // 改用单词级别的 pronunciation 分，更准确反映发音质量
            let overallScore = Math.round(parseFloat(data.overall || 0));
            if (contentType === 'word' && data.words && data.words.length > 0) {
                const wordScore = Math.round(parseFloat(data.words[0].pronunciation || 0));
                if (wordScore > 0) overallScore = wordScore;
            }

            return {
                success: true,
                overallScore,
                pronunciationScore: Math.round(parseFloat(data.pronunciation || 0)),
                fluencyScore: Math.round(parseFloat(data.fluency || 0)),
                integrityScore: Math.round(parseFloat(data.integrity || 0)),
                details: {
                    words: (data.words || []).map(w => ({
                        word: w.word || '',
                        score: Math.round(parseFloat(w.pronunciation || 0))
                    }))
                }
            };
        } catch (error) {
            console.error('[Assess:Youdao] 异常:', error.message);
            return { success: false, error: '评测服务开小差了，请稍后重试' };
        }
    }

    /**
     * 腾讯云智聆口语评测（WebSocket API）
     */
    async _tencentAssess(audioPath, referenceText, contentType = 'sentence') {
        const { secretId, secretKey, appId } = this.tencentConfig;

        if (!secretId || !secretKey || !appId) {
            return { success: false, error: '评测服务未配置，请联系管理员' };
        }

        return new Promise((resolve, reject) => {
            try {
                const audioBuffer = fs.readFileSync(audioPath);

                const evalModeMap = { word: 0, sentence: 1, paragraph: 2 };
                const timestamp = Math.floor(Date.now() / 1000);
                const expired = timestamp + 86400;
                const nonce = Math.floor(Math.random() * 100000000);
                const voiceId = `voice_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                const params = {
                    eval_mode: evalModeMap[contentType] || 0,
                    expired, nonce,
                    ref_text: referenceText,
                    score_coeff: 1.5,
                    secretid: secretId,
                    sentence_info_enabled: 1,
                    server_engine_type: '16k_en',
                    text_mode: 0,
                    timestamp,
                    voice_format: 2,
                    voice_id: voiceId,
                    rec_mode: 0
                };

                const sortedKeys = Object.keys(params).sort();
                const queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
                const signStr = `soe.cloud.tencent.com/soe/api/${appId}?${queryString}`;
                const signature = crypto.createHmac('sha1', secretKey).update(signStr).digest('base64');

                const encodedParams = sortedKeys.map(key =>
                    `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`
                ).join('&');

                const wsUrl = `wss://soe.cloud.tencent.com/soe/api/${appId}?${encodedParams}&signature=${encodeURIComponent(signature)}`;

                const WebSocket = require('ws');
                const ws = new WebSocket(wsUrl);

                let result = null;
                let handshakeComplete = false;

                ws.on('open', () => { console.log('SOE WebSocket connected'); });

                ws.on('message', (data) => {
                    try {
                        const response = JSON.parse(data.toString());

                        if (response.code === 0 && response.voice_id && !handshakeComplete) {
                            handshakeComplete = true;
                            const CHUNK_SIZE = 4096;
                            const totalChunks = Math.ceil(audioBuffer.length / CHUNK_SIZE);

                            const sendChunk = (index) => {
                                if (index >= totalChunks) {
                                    ws.send(JSON.stringify({ type: 'end' }));
                                    return;
                                }
                                const start = index * CHUNK_SIZE;
                                const end = Math.min(start + CHUNK_SIZE, audioBuffer.length);
                                const chunk = audioBuffer.slice(start, end);
                                ws.send(chunk, { binary: true }, (err) => {
                                    if (!err) setTimeout(() => sendChunk(index + 1), 10);
                                });
                            };
                            sendChunk(0);

                        } else if (response.result) {
                            let evalResult;
                            try {
                                evalResult = typeof response.result === 'string' ? JSON.parse(response.result) : response.result;
                            } catch { evalResult = response.result; }

                            result = {
                                success: true,
                                overallScore: Math.round((evalResult.PronAccuracy || 0) * 100) / 100,
                                pronunciationScore: Math.round((evalResult.PronAccuracy || 0) * 100) / 100,
                                fluencyScore: Math.round((evalResult.PronFluency || 0) * 100),
                                integrityScore: Math.round((evalResult.PronCompletion || 0) * 100),
                                details: { words: evalResult.Words || [], sentenceInfo: evalResult.SentenceInfoSet || [] }
                            };
                        } else if (response.final === 1) {
                            ws.close();
                        } else if (response.code !== 0 && response.code !== undefined) {
                            if (result && result.success) { ws.close(); return; }
                            result = { success: false, error: response.message || '评测失败' };
                            ws.close();
                        }
                    } catch (e) { console.error('解析SOE响应错误:', e); }
                });

                ws.on('close', () => {
                    resolve(result || { success: false, error: '评测服务开小差了，请稍后重试' });
                });

                ws.on('error', (error) => {
                    if (result && result.success) return;
                    resolve({ success: false, error: '评测服务开小差了，请稍后重试' });
                });

                setTimeout(() => {
                    if (ws.readyState === WebSocket.OPEN) ws.close();
                    if (!result) resolve({ success: false, error: '评测超时，请稍后重试' });
                }, 30000);

            } catch (error) {
                console.error('语音评测错误:', error.message);
                resolve({ success: false, error: '评测服务开小差了，请稍后重试' });
            }
        });
    }

    /**
     * 调用腾讯云API (TC3签名)
     */
    async callTencentAPI(host, service, action, payload, secretId, secretKey, timestamp) {
        const date = new Date(timestamp * 1000).toISOString().split('T')[0];
        const payloadStr = JSON.stringify(payload);
        const hashedPayload = crypto.createHash('sha256').update(payloadStr).digest('hex');

        const canonicalRequest = [
            'POST', '/', '',
            `content-type:application/json; charset=utf-8\nhost:${host}\n`,
            'content-type;host',
            hashedPayload
        ].join('\n');

        const algorithm = 'TC3-HMAC-SHA256';
        const credentialScope = `${date}/${service}/tc3_request`;
        const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
        const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

        const secretDate = crypto.createHmac('sha256', `TC3${secretKey}`).update(date).digest();
        const secretService = crypto.createHmac('sha256', secretDate).update(service).digest();
        const secretSigning = crypto.createHmac('sha256', secretService).update('tc3_request').digest();
        const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

        const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;

        const response = await axios.post(`https://${host}`, payload, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Host': host,
                'Authorization': authorization,
                'X-TC-Action': action,
                'X-TC-Version': '2019-08-23',
                'X-TC-Timestamp': timestamp.toString(),
                'X-TC-Region': this.tencentConfig.region
            },
            timeout: 15000
        });

        return response.data;
    }

    /**
     * 模拟评测结果（开发测试用）
     */
    mockAssessment(referenceText) {
        const baseScore = 70 + Math.random() * 25;
        return {
            success: true,
            overallScore: Math.round(baseScore),
            pronunciationScore: Math.round(baseScore + (Math.random() - 0.5) * 10),
            fluencyScore: Math.round(baseScore + (Math.random() - 0.5) * 10),
            integrityScore: Math.round(baseScore + (Math.random() - 0.5) * 5),
            details: {
                words: referenceText.split(' ').map(word => ({
                    word, score: Math.round(70 + Math.random() * 25)
                })),
                isMock: true
            }
        };
    }

    /**
     * 保存音频文件：优先上传 COS，不可用时回退到本地
     */
    async saveAudio(audioData, prefix, ext = 'mp3') {
        // 优先上传到 COS
        if (cosService.isConfigured) {
            try {
                const url = await cosService.uploadAudio(audioData, prefix, ext);
                console.log(`[VoiceService] 音频已上传 COS: ${url}`);
                return url;
            } catch (err) {
                console.error('[VoiceService] COS 上传失败，回退本地:', err.message);
            }
        }

        // 回退：保存到本地
        const audioDir = path.join(__dirname, '../../uploads/audio');
        if (!fs.existsSync(audioDir)) {
            fs.mkdirSync(audioDir, { recursive: true });
        }
        const filename = `${prefix}_${Date.now()}.${ext}`;
        const filePath = path.join(audioDir, filename);
        fs.writeFileSync(filePath, audioData);
        return `/uploads/audio/${filename}`;
    }
}

module.exports = new VoiceService();
