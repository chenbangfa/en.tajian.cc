const crypto = require('crypto');

const TOKEN_VERSION = 'v1';

function getSecret() {
    return process.env.H5_SCENE_TOKEN_SECRET
        || process.env.SESSION_SECRET
        || 'english-admin-secret-key-2026';
}

function getKey() {
    return crypto.createHash('sha256').update(getSecret()).digest();
}

function encode(value) {
    return Buffer.from(value).toString('base64url');
}

function decode(value) {
    return Buffer.from(value, 'base64url');
}

function createSceneH5Token(sceneId) {
    const id = parseInt(sceneId, 10);
    if (!Number.isFinite(id) || id <= 0) {
        throw new Error('Invalid scene id');
    }

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const payload = JSON.stringify({ id, iat: Date.now() });
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [TOKEN_VERSION, encode(iv), encode(encrypted), encode(tag)].join('.');
}

function parseSceneH5Token(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;

    try {
        const [, ivText, encryptedText, tagText] = parts;
        const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), decode(ivText));
        decipher.setAuthTag(decode(tagText));
        const decrypted = Buffer.concat([decipher.update(decode(encryptedText)), decipher.final()]);
        const payload = JSON.parse(decrypted.toString('utf8'));
        const id = parseInt(payload.id, 10);
        return Number.isFinite(id) && id > 0 ? id : null;
    } catch (e) {
        return null;
    }
}

module.exports = {
    createSceneH5Token,
    parseSceneH5Token
};
