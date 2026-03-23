const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

module.exports = {
  // 服务器配置
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // 数据库配置
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'english_learning',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  },

  // JWT配置
  jwt: {
    secret: process.env.JWT_SECRET || 'default_secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  // Google Vertex AI 配置
  googleAI: {
    serviceAccountPath: process.env.GOOGLE_SERVICE_ACCOUNT_PATH,
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    region: process.env.GOOGLE_CLOUD_REGION || 'us-central1'
  },

  // 有道API配置
  youdao: {
    appKey: process.env.YOUDAO_APP_KEY,
    appSecret: process.env.YOUDAO_APP_SECRET
  },

  // 腾讯云配置
  tencent: {
    appId: process.env.TENCENT_APPID,
    secretId: process.env.TENCENT_SECRET_ID,
    secretKey: process.env.TENCENT_SECRET_KEY,
    region: process.env.TENCENT_REGION || 'ap-guangzhou'
  },

  // 文件上传配置
  upload: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024
  },

  // 微信小程序配置
  wechat: {
    appId: process.env.WECHAT_APPID,
    secret: process.env.WECHAT_SECRET
  },

  // 腾讯云 COS 对象存储
  cos: {
    secretId: process.env.COS_SECRET_ID,
    secretKey: process.env.COS_SECRET_KEY,
    bucket: process.env.COS_BUCKET,
    region: process.env.COS_REGION || 'ap-guangzhou',
    baseUrl: process.env.COS_BASE_URL
  }
};
