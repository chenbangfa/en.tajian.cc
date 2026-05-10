const express = require('express');
const cors = require('cors');
const path = require('path');
const session = require('express-session');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const config = require('../src/config');
const { testConnection, query } = require('../src/config/database');
const { parseSceneH5Token } = require('./utils/h5-scene-token');

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

function normalizeH5MediaUrl(url) {
    if (!url) return '';
    const value = String(url).trim();
    if (!value) return '';
    if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:')) return value;
    return value.startsWith('/') ? value : `/${value}`;
}

function serializeForInlineJson(value) {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

const sceneObjectSemanticColumnsReady = (async function ensureSceneObjectSemanticAudioColumns() {
    try {
        const columns = [
            { name: 'translation_audio_url', ddl: 'VARCHAR(500) DEFAULT NULL COMMENT "场景释义中文发音URL"' },
            { name: 'translation_audio_text', ddl: 'VARCHAR(255) DEFAULT NULL COMMENT "生成场景中文发音时使用的文本"' }
        ];
        for (const col of columns) {
            const rows = await query('SHOW COLUMNS FROM scene_objects LIKE ?', [col.name]);
            if (!rows || rows.length === 0) {
                await query(`ALTER TABLE scene_objects ADD COLUMN ${col.name} ${col.ddl}`);
            }
        }
    } catch (e) {
        console.error('[H5 Scene Reader] 补齐场景对象中文音频字段失败:', e.message);
    }
})();

// 公开 H5 场景点读页：用于后台复制链接后直接分享/打开，不依赖后台登录态。
app.get('/h5/scenes/:token', async (req, res, next) => {
    try {
        await sceneObjectSemanticColumnsReady;
        const sceneId = parseSceneH5Token(req.params.token);
        if (!sceneId) return next();

        const [scene] = await query(`
            SELECT s.*, c.name AS category_name, c.name_en AS category_name_en
            FROM scenes s
            LEFT JOIN scene_categories c ON c.id = s.category_id
            WHERE s.id = ?
            LIMIT 1
        `, [sceneId]);
        if (!scene) return next();

        const objects = await query(`
            SELECT so.*,
                   COALESCE(so.phonetic, w.phonetic) AS phonetic,
                   COALESCE(so.translation, w.translation) AS translation,
                   COALESCE(w.audio_url_female, so.audio_url_female) AS audio_url_female,
                   COALESCE(w.audio_url_male, so.audio_url_male) AS audio_url_male,
                   so.translation_audio_url AS scene_translation_audio_url,
                   so.translation_audio_text AS scene_translation_audio_text,
                   w.translation AS word_translation,
                   w.translation_audio_url AS word_translation_audio_url,
                   w.word,
                   w.audio_url AS word_audio_url
            FROM scene_objects so
            LEFT JOIN words w ON so.word_id = w.id
            WHERE so.scene_id = ?
            ORDER BY so.sort_order ASC, so.id ASC
        `, [sceneId]);

        const h5Scene = {
            ...scene,
            image_url: normalizeH5MediaUrl(scene.image_url),
            category_name: scene.category_name || scene.category_name_en || '',
            objects: objects.map((obj) => ({
                ...obj,
                audio_url_female: normalizeH5MediaUrl(obj.audio_url_female),
                audio_url_male: normalizeH5MediaUrl(obj.audio_url_male),
                scene_translation_audio_url: normalizeH5MediaUrl(obj.scene_translation_audio_url),
                word_translation_audio_url: normalizeH5MediaUrl(obj.word_translation_audio_url),
                word_audio_url: normalizeH5MediaUrl(obj.word_audio_url)
            }))
        };

        res.render('h5/scene-reader', {
            layout: false,
            scene: h5Scene,
            sceneJson: serializeForInlineJson(h5Scene)
        });
    } catch (e) {
        console.error('[H5 Scene Reader] 渲染失败:', e);
        next(e);
    }
});

// 受保护的页面路由
app.get('/', requireAuth, (req, res) => res.render('index', { page: 'dashboard', title: '数据统计', user: req.session.adminUser }));
app.get('/users', requireAuth, (req, res) => res.render('users/index', { page: 'users', title: '用户管理', user: req.session.adminUser }));
app.get('/promoters', requireAuth, (req, res) => res.render('promoters/index', { page: 'promoters', title: '推广员管理', user: req.session.adminUser }));
app.get('/categories', requireAuth, (req, res) => res.render('categories', { page: 'categories', title: '分类管理', user: req.session.adminUser }));
app.get('/words', requireAuth, (req, res) => res.render('words', { page: 'words', title: '单词管理', user: req.session.adminUser }));
app.get('/words/batch-enhance', requireAuth, (req, res) => res.render('words/batch-enhance', { page: 'words-batch-enhance', title: '单词批量 AI 补全', user: req.session.adminUser }));
app.get('/words/batch-tts', requireAuth, (req, res) => res.render('words/batch-tts', { page: 'words-batch-tts', title: '批量语音合成', user: req.session.adminUser }));
app.get('/podcast/categories', requireAuth, (req, res) => res.render('podcast/categories', { page: 'podcast-cat', title: '磨耳朵分类', user: req.session.adminUser }));
app.get('/podcast/contents', requireAuth, (req, res) => res.render('podcast/contents', { page: 'podcast-content', title: '磨耳朵内容', user: req.session.adminUser }));
app.get('/prompts', requireAuth, (req, res) => res.render('prompts', { page: 'prompts', title: '提示词管理', user: req.session.adminUser }));
app.get('/batch/import', requireAuth, (req, res) => res.render('batch/import', { page: 'batch-import', title: '批量导入', user: req.session.adminUser }));
app.get('/batch/generate', requireAuth, (req, res) => res.render('batch/generate', { page: 'batch-generate', title: '批量生成', user: req.session.adminUser }));
app.get('/checkin/curriculum', requireAuth, (req, res) => res.render('checkin/curriculum', { page: 'checkin-curriculum', title: '打卡课程', user: req.session.adminUser }));
app.get('/ielts', requireAuth, (req, res) => res.render('ielts/index', { page: 'ielts', title: 'IELTS课程', user: req.session.adminUser }));
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
app.use('/api/admin/promoters', requireAuth, require('./routes/promoters'));
app.use('/api/admin/checkin-curriculum', requireAuth, require('./routes/checkin_curriculum'));
app.use('/api/admin/ielts', requireAuth, require('./routes/ielts'));
app.use('/api/admin/dialogue', requireAuth, require('./routes/dialogue'));
app.use('/picture-books/categories', requireAuth, require('./routes/picturebook_categories'));
app.use('/picturebook-videos', requireAuth, require('./routes/picturebook_videos'));
app.use('/podcast-videos', requireAuth, require('./routes/podcast_videos'));
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
