/**
 * Google AI 认证工具
 * 使用 Service Account / ADC 获取 Bearer Token，调用 Vertex AI Gemini API
 * 计费走 Google Cloud Vertex AI 体系
 */
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

const VERTEX_BASE = 'https://aiplatform.googleapis.com/v1';

class GoogleAIAuth {
    constructor() {
        const keyFilename = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
        this.projectId = process.env.GOOGLE_CLOUD_PROJECT;
        this.region = process.env.GOOGLE_CLOUD_REGION || 'us-central1';

        const authOptions = {
            scopes: ['https://www.googleapis.com/auth/cloud-platform']
        };

        if (keyFilename) {
            // 支持相对路径（相对于 server/ 目录）
            authOptions.keyFilename = path.isAbsolute(keyFilename)
                ? keyFilename
                : path.join(__dirname, '../../', keyFilename);
        }

        // 若未提供 keyFilename，将尝试走 ADC（如 GCE/GKE/Cloud Run 或本地 gcloud 登录）
        this.auth = new GoogleAuth(authOptions);
        this.client = null;
    }

    get isConfigured() {
        return !!this.projectId;
    }

    async getAuthHeaders() {
        if (!this.projectId) throw new Error('Google AI 未配置: 缺少 GOOGLE_CLOUD_PROJECT');
        if (!this.client) this.client = await this.auth.getClient();
        const token = await this.client.getAccessToken();
        return {
            'Authorization': `Bearer ${token.token}`,
            'Content-Type': 'application/json'
        };
    }

    getUrl(model, action = 'generateContent') {
        if (!this.projectId) throw new Error('Google AI 未配置: 缺少 GOOGLE_CLOUD_PROJECT');
        return `${VERTEX_BASE}/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${model}:${action}`;
    }
}

module.exports = new GoogleAIAuth();
