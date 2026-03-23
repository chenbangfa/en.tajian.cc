/**
 * Vertex AI 认证工具
 * 使用 Service Account 获取 Bearer Token，构造 Vertex AI API URL
 */
const path = require('path');
const { GoogleAuth } = require('google-auth-library');

class VertexAuth {
    constructor() {
        this.projectId = process.env.GOOGLE_CLOUD_PROJECT;
        this.region = process.env.GOOGLE_CLOUD_REGION || 'us-central1';

        const keyFilename = process.env.GOOGLE_SERVICE_ACCOUNT_PATH;
        if (keyFilename) {
            // 支持相对路径（相对于 server/ 目录）
            const absPath = path.isAbsolute(keyFilename)
                ? keyFilename
                : path.join(__dirname, '../../', keyFilename);

            this.auth = new GoogleAuth({
                keyFilename: absPath,
                scopes: ['https://www.googleapis.com/auth/cloud-platform']
            });
        } else {
            this.auth = null;
        }

        this.client = null;
    }

    get isConfigured() {
        return !!(this.auth && this.projectId);
    }

    async getAuthHeaders() {
        if (!this.auth) throw new Error('Vertex AI 未配置: 缺少 GOOGLE_SERVICE_ACCOUNT_PATH');
        if (!this.client) this.client = await this.auth.getClient();
        const token = await this.client.getAccessToken();
        return {
            'Authorization': `Bearer ${token.token}`,
            'Content-Type': 'application/json'
        };
    }

    getUrl(model, action = 'generateContent') {
        if (!this.projectId) throw new Error('Vertex AI 未配置: 缺少 GOOGLE_CLOUD_PROJECT');
        return `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/publishers/google/models/${model}:${action}`;
    }
}

module.exports = new VertexAuth();
