const COS = require('cos-nodejs-sdk-v5');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

class COSService {
    constructor() {
        this.bucket = process.env.COS_BUCKET;
        this.region = process.env.COS_REGION || 'ap-guangzhou';
        this.baseUrl = process.env.COS_BASE_URL; // e.g. https://your-bucket.cos.ap-guangzhou.myqcloud.com

        if (process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY) {
            this.cos = new COS({
                SecretId: process.env.COS_SECRET_ID,
                SecretKey: process.env.COS_SECRET_KEY,
            });
        } else {
            console.warn('[COSService] 未配置 COS_SECRET_ID/KEY，COS 上传不可用');
            this.cos = null;
        }
    }

    get isConfigured() {
        return !!(this.cos && this.bucket && this.baseUrl);
    }

    /**
     * 上传 Buffer 到 COS
     * @param {Buffer} buffer - 文件内容
     * @param {string} key - COS 对象路径，如 images/xxx.png
     * @returns {Promise<string>} 完整 COS URL
     */
    async uploadBuffer(buffer, key) {
        if (!this.isConfigured) {
            throw new Error('COS 未配置');
        }
        return new Promise((resolve, reject) => {
            this.cos.putObject({
                Bucket: this.bucket,
                Region: this.region,
                Key: key,
                Body: buffer,
            }, (err) => {
                if (err) return reject(err);
                resolve(`${this.baseUrl}/${key}`);
            });
        });
    }

    /**
     * 上传 Base64 图片到 COS（images/ 目录）
     * @param {string} base64Data - Base64 编码的图片数据
     * @param {string} prefix - 文件名前缀
     * @returns {Promise<string>} COS URL
     */
    async uploadBase64Image(base64Data, prefix) {
        const filename = `${prefix}_${Date.now()}.png`;
        const key = `images/${filename}`;
        const buffer = Buffer.from(base64Data, 'base64');
        return this.uploadBuffer(buffer, key);
    }

    /**
     * 上传音频 Buffer 到 COS（audio/ 目录）
     * @param {Buffer} audioData - 音频数据
     * @param {string} prefix - 文件名前缀
     * @param {string} ext - 扩展名 (mp3/wav)
     * @returns {Promise<string>} COS URL
     */
    async uploadAudio(audioData, prefix, ext = 'mp3') {
        const filename = `${prefix}_${Date.now()}.${ext}`;
        const key = `audio/${filename}`;
        return this.uploadBuffer(audioData, key);
    }

    /**
     * 上传本地文件到 COS（用于录音等）
     * @param {string} localPath - 本地文件路径
     * @param {string} folder - COS 文件夹，如 recordings
     * @param {string} originalname - 原始文件名（用于获取扩展名）
     * @returns {Promise<string>} COS URL
     */
    async uploadLocalFile(localPath, folder, originalname) {
        const ext = path.extname(originalname || localPath);
        const filename = `${uuidv4()}${ext}`;
        const key = `${folder}/${filename}`;
        const buffer = fs.readFileSync(localPath);
        return this.uploadBuffer(buffer, key);
    }
}

module.exports = new COSService();
