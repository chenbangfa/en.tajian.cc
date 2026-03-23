/**
 * Google AI 认证工具
 * 使用 Service Account 获取 Bearer Token，调用 Generative Language API
 * 计费走 Google Cloud 项目，可使用 $300 赠金
 */
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

class GoogleAIAuth {
    constructor() {
        const keyFilename = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
        if (keyFilename) {
            // 支持相对路径（相对于 server/ 目录）
            const absPath = path.isAbsolute(keyFilename)
                ? keyFilename
                : path.join(__dirname, '../../', keyFilename);

            this.auth = new GoogleAuth({
                keyFilename: absPath,
                scopes: [
                    'https://www.googleapis.com/auth/cloud-platform',
                    'https://www.googleapis.com/auth/generative-language'
                ]
            });
        } else {
            this.auth = null;
        }

        this.client = null;
    }

    get isConfigured() {
        return !!this.auth;
    }

    async getAuthHeaders() {
        if (!this.auth) throw new Error('Google AI 未配置: 缺少 GOOGLE_SERVICE_ACCOUNT_PATH');
        if (!this.client) this.client = await this.auth.getClient();
        const token = await this.client.getAccessToken();
        return {
            'Authorization': `Bearer ${token.token}`,
            'Content-Type': 'application/json'
        };
    }

    getUrl(model, action = 'generateContent') {
        return `${GEMINI_BASE}/models/${model}:${action}`;
    }
}

module.exports = new GoogleAIAuth();
