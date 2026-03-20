const express = require('express');
const cors = require('cors');
const path = require('path');
const config = require('./config');
const { testConnection } = require('./config/database');

const app = express();

// 中间件配置
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 静态文件服务
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// 健康检查接口
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: config.nodeEnv
    });
});

// API路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/words', require('./routes/words'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/scenes', require('./routes/scenes'));
app.use('/api/scene-categories', require('./routes/scene_categories'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/voice', require('./routes/voice'));
app.use('/api/podcast', require('./routes/podcast'));
app.use('/api/podcast-categories', require('./routes/podcast_categories'));
app.use('/api/checkin', require('./routes/checkin'));
app.use('/api/users', require('./routes/users'));
app.use('/api/photo-read', require('./routes/photo_read'));
app.use('/api/dialogue', require('./routes/dialogue'));
app.use('/api/picture-books', require('./routes/picture_books'));
app.use('/api/reward', require('./routes/reward'));

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(err.status || 500).json({
        success: false,
        message: err.message || '服务器内部错误',
        ...(config.nodeEnv === 'development' && { stack: err.stack })
    });
});

// 404处理
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: '接口不存在'
    });
});

// 启动服务器
async function startServer() {
    // 测试数据库连接
    await testConnection();

    app.listen(config.port, () => {
        console.log(`🚀 服务器启动成功: http://localhost:${config.port}`);
        console.log(`📝 环境: ${config.nodeEnv}`);
    });
}

startServer();

module.exports = app;
