const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const config = require('../src/config');
const { testConnection } = require('../src/config/database');

const app = express();

// 中间件
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session配置
app.use(session({
    secret: process.env.SESSION_SECRET || 'english-admin-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24小时
    }
}));

// 静态文件
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/static', express.static(path.join(__dirname, 'public')));

// 视图引擎设置
const expressLayouts = require('express-ejs-layouts');
app.use(expressLayouts);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.set('layout', 'layout');
app.set('layout extractScripts', true);

// 认证中间件
const requireAuth = (req, res, next) => {
    if (!req.session.adminUser) {
        // 如果是API请求，返回401
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({
                success: false,
                message: '未登录，请先登录'
            });
        }
        // 页面请求重定向到登录页
        return res.redirect('/login');
    }
    next();
};

// 登录页面 (不需要认证)
app.get('/login', (req, res) => {
    if (req.session.adminUser) {
        return res.redirect('/');
    }
    res.render('login', { layout: false });
});

// 认证API路由 (不需要认证中间件)
app.use('/api/admin/auth', require('./routes/auth'));

// 受保护的页面路由
app.get('/', requireAuth, (req, res) => res.render('index', { page: 'dashboard', title: '数据统计', user: req.session.adminUser }));
app.get('/users', requireAuth, (req, res) => res.render('users/index', { page: 'users', title: '用户管理', user: req.session.adminUser }));
app.get('/categories', requireAuth, (req, res) => res.render('categories', { page: 'categories', title: '分类管理', user: req.session.adminUser }));
app.get('/words', requireAuth, (req, res) => res.render('words', { page: 'words', title: '单词管理', user: req.session.adminUser }));
app.get('/words/batch-tts', requireAuth, (req, res) => res.render('words/batch-tts', { page: 'words-batch-tts', title: '批量语音合成', user: req.session.adminUser }));
app.get('/podcast/categories', requireAuth, (req, res) => res.render('podcast/categories', { page: 'podcast-cat', title: '磨耳朵分类', user: req.session.adminUser }));
app.get('/podcast/contents', requireAuth, (req, res) => res.render('podcast/contents', { page: 'podcast-content', title: '磨耳朵内容', user: req.session.adminUser }));
app.get('/prompts', requireAuth, (req, res) => res.render('prompts', { page: 'prompts', title: '提示词管理', user: req.session.adminUser }));
app.get('/batch/import', requireAuth, (req, res) => res.render('batch/import', { page: 'batch-import', title: '批量导入', user: req.session.adminUser }));
app.get('/batch/generate', requireAuth, (req, res) => res.render('batch/generate', { page: 'batch-generate', title: '批量生成', user: req.session.adminUser }));
app.get('/checkin/curriculum', requireAuth, (req, res) => res.render('checkin/curriculum', { page: 'checkin-curriculum', title: '打卡课程', user: req.session.adminUser }));
app.get('/pet-stages', requireAuth, (req, res) => res.render('pet-stages/index', { page: 'pet-stages', title: '成长阶段', user: req.session.adminUser }));

// 场景管理页面
app.get('/scenes', requireAuth, (req, res) => res.render('scenes/index', { page: 'scenes-list', title: '场景列表', user: req.session.adminUser }));
app.get('/scenes/categories', requireAuth, (req, res) => res.render('scenes/categories', { page: 'scenes-cat', title: '场景分类', user: req.session.adminUser }));
app.get('/scenes/edit', requireAuth, (req, res) => res.render('scenes/edit', { page: 'scenes-list', title: '新建场景', user: req.session.adminUser, scene: undefined }));
app.get('/scenes/edit/:id', requireAuth, async (req, res) => {
    // 获取场景详情供编辑使用
    try {
        const { query } = require('../src/config/database');
        const [scene] = await query('SELECT * FROM scenes WHERE id = ?', [req.params.id]);
        if (!scene) return res.redirect('/scenes');
        res.render('scenes/edit', { page: 'scenes-list', title: '编辑场景', user: req.session.adminUser, scene });
    } catch (e) {
        res.redirect('/scenes');
    }
});

// 对话场景管理页面
app.get('/dialogue/categories', requireAuth, (req, res) => res.render('dialogue/categories', { page: 'dialogue-cat', title: '对话分类', user: req.session.adminUser }));
app.get('/dialogue/scenes', requireAuth, (req, res) => res.render('dialogue/scenes', { page: 'dialogue-scenes', title: '对话场景', user: req.session.adminUser }));
app.get('/dialogue/edit', requireAuth, (req, res) => res.render('dialogue/edit', { page: 'dialogue-scenes', title: '新建对话场景', user: req.session.adminUser, scene: null }));
app.get('/dialogue/edit/:id', requireAuth, async (req, res) => {
    try {
        const { query } = require('../src/config/database');
        const [scene] = await query('SELECT * FROM dialogue_scenes WHERE id = ?', [req.params.id]);
        if (!scene) return res.redirect('/dialogue/scenes');
        res.render('dialogue/edit', { page: 'dialogue-scenes', title: '编辑对话场景', user: req.session.adminUser, scene });
    } catch (e) {
        res.redirect('/dialogue/scenes');
    }
});

// 受保护的API路由
app.use('/api/admin/categories', requireAuth, require('./routes/categories'));
app.use('/api/admin/words', requireAuth, require('./routes/words'));
app.use('/api/admin/scenes', requireAuth, require('./routes/scenes'));
app.use('/api/admin/scene_categories', requireAuth, require('./routes/scene_categories'));
app.use('/api/admin/podcast_categories', requireAuth, require('./routes/podcast_categories'));
app.use('/api/admin/podcast', requireAuth, require('./routes/podcast'));
app.use('/api/admin/batch', requireAuth, require('./routes/batch'));
app.use('/api/admin/prompts', requireAuth, require('./routes/prompts'));
app.use('/api/admin/stats', requireAuth, require('./routes/stats'));
app.use('/api/admin/users', requireAuth, require('./routes/users'));
app.use('/api/admin/checkin-curriculum', requireAuth, require('./routes/checkin_curriculum'));
app.use('/api/admin/dialogue', requireAuth, require('./routes/dialogue'));
app.use('/picture-books/categories', requireAuth, require('./routes/picturebook_categories'));
app.use('/picturebook-videos', requireAuth, require('./routes/picturebook_videos'));
app.use('/dialogue-videos', requireAuth, require('./routes/dialogue_videos'));
app.use('/picture-books', requireAuth, require('./routes/picturebooks'));
app.use('/api/admin/pet-stages', requireAuth, require('./routes/pet_stages'));
app.use('/marketing', requireAuth, require('./routes/marketing'));

// 健康检查 (不需要认证)
app.get('/api/admin/health', (req, res) => {
    res.json({
        status: 'ok',
        service: 'admin',
        timestamp: new Date().toISOString()
    });
});

// 错误处理
app.use((err, req, res, next) => {
    console.error('Admin服务器错误:', err);
    res.status(err.status || 500).json({
        success: false,
        message: err.message || '服务器内部错误'
    });
});

// 启动服务器
const ADMIN_PORT = process.env.ADMIN_PORT || 3001;

async function startServer() {
    await testConnection();

    app.listen(ADMIN_PORT, () => {
        console.log(`🔧 管理后台启动成功: http://localhost:${ADMIN_PORT}`);
    });
}

startServer();

module.exports = app;
