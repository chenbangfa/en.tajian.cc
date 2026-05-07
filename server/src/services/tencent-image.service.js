const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cloudbase = require('@cloudbase/node-sdk');
const cosService = require('./cos.service');

class TencentImageService {
    constructor() {
        this.envId = process.env.TENCENT_CB_ENV || process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || '';
        this.secretId = process.env.TENCENT_SECRET_ID || '';
        this.secretKey = process.env.TENCENT_SECRET_KEY || '';
        this.model = process.env.TENCENT_HUNYUAN_IMAGE_MODEL || 'hunyuan-image';
        this.version = process.env.TENCENT_HUNYUAN_IMAGE_VERSION || 'v1.9';
        this.size = process.env.TENCENT_HUNYUAN_IMAGE_SIZE || '1024x768';
        this.timeout = Number(process.env.TENCENT_HUNYUAN_TIMEOUT_MS || 180000);
    }

    get isConfigured() {
        return !!(this.envId && this.secretId && this.secretKey);
    }

    createApp() {
        return cloudbase.init({
            env: this.envId,
            secretId: this.secretId,
            secretKey: this.secretKey,
            timeout: this.timeout
        });
    }

    async generateImage(prompt, options = {}) {
        if (!this.isConfigured) {
            return {
                success: false,
                error: '腾讯混元未配置，请先在 .env 设置 TENCENT_CB_ENV / TENCENT_SECRET_ID / TENCENT_SECRET_KEY'
            };
        }

        try {
            const app = this.createApp();
            const ai = app.ai();
            const imageModel = ai.createImageModel('hunyuan-exp');
            const result = await imageModel.generateImage({
                model: this.normalizeModel(options.model || this.model),
                version: options.version || this.version,
                prompt,
                size: options.size || this.size,
                revise: true
            });

            const tempUrl = result?.data?.[0]?.url;
            if (!tempUrl) {
                return {
                    success: false,
                    error: '腾讯混元未返回有效图片地址'
                };
            }

            const imageUrl = await this.persistRemoteImage(tempUrl);
            return {
                success: true,
                imageUrl
            };
        } catch (error) {
            console.error('[TencentImageService] 生成失败:', error?.response?.data || error.message);
            return {
                success: false,
                error: error?.response?.data?.message || error.message || '腾讯混元生成失败'
            };
        }
    }

    async persistRemoteImage(tempUrl) {
        const response = await axios.get(tempUrl, {
            responseType: 'arraybuffer',
            timeout: 120000
        });

        const buffer = Buffer.from(response.data);
        const ext = this.resolveExt(response.headers['content-type'], tempUrl);
        const filename = `dialogue_cover_${Date.now()}${ext}`;

        if (cosService.isConfigured) {
            return cosService.uploadBuffer(buffer, `images/${filename}`);
        }

        const dir = path.join(__dirname, '../../uploads/dialogue');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, filename), buffer);
        return `/uploads/dialogue/${filename}`;
    }

    resolveExt(contentType = '', url = '') {
        if (/png/i.test(contentType)) return '.png';
        if (/webp/i.test(contentType)) return '.webp';
        if (/jpeg|jpg/i.test(contentType)) return '.jpg';
        const ext = path.extname(new URL(url).pathname || '');
        return ext || '.png';
    }

    normalizeModel(model = '') {
        const normalized = String(model || '').trim();
        if (!normalized) return 'hunyuan-image';
        if (normalized === 'hunyuan-image') return normalized;
        if (/^hunyuan-image-v/i.test(normalized)) return 'hunyuan-image';
        return normalized;
    }
}

module.exports = new TencentImageService();
