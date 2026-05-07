const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { query } = require('../config/database');
const config = require('../config');

const router = express.Router();

const WXACODE_DIR = path.join(__dirname, '../../uploads/wxacode');
const BASE_URL = (process.env.BASE_URL || 'https://english.tajian.cc').replace(/\/$/, '');

const FALLBACK_ARTICLES = [
    {
        id: '',
        title: '如何把逛超市变成孩子愿意参与的英语输入场',
        summary: '从真实物品、动作和对话切入，把“学英语”变成孩子看得见、摸得到、愿意开口的体验。',
        source_type_label: '启蒙方法',
        href: '/parents'
    },
    {
        id: '',
        title: '绘本共读时，家长最值得反复做的三个动作',
        summary: '不是把每一句都翻译出来，而是先带孩子看图、提问、复述，让阅读更轻松也更有效。',
        source_type_label: '绘本共读',
        href: '/parents'
    },
    {
        id: '',
        title: '孩子不愿开口时，怎样降低英语表达的心理压力',
        summary: '先让孩子观察、听和模仿，再逐步鼓励表达，节奏放对了，开口就不会那么难。',
        source_type_label: '陪伴建议',
        href: '/parents'
    }
];

async function ensureBookWxacodeColumns() {
    const columns = [
        { name: 'wxacode_url', ddl: 'VARCHAR(500) DEFAULT NULL COMMENT "绘本小程序码URL"' },
        { name: 'wxacode_scene', ddl: 'VARCHAR(120) DEFAULT NULL COMMENT "绘本小程序码scene参数"' },
        { name: 'wxacode_generated_at', ddl: 'DATETIME DEFAULT NULL COMMENT "绘本小程序码生成时间"' }
    ];

    for (const col of columns) {
        const rows = await query('SHOW COLUMNS FROM picture_books LIKE ?', [col.name]);
        if (!rows || rows.length === 0) {
            await query(`ALTER TABLE picture_books ADD COLUMN ${col.name} ${col.ddl}`);
        }
    }
}

(async () => {
    try {
        await ensureBookWxacodeColumns();
    } catch (e) {
        console.error('[Site] 补齐绘本小程序码字段失败:', e.message);
    }
})();

function normalizeMedia(url) {
    if (!url) return '';
    return /^https?:\/\//i.test(url) ? url : `${BASE_URL}${url}`;
}

function localFileExists(relativeUrl) {
    if (!relativeUrl) return false;
    if (/^https?:\/\//i.test(relativeUrl)) return true;
    const localPath = path.join(__dirname, '../../', relativeUrl);
    return fs.existsSync(localPath);
}

function ensureWxacodeDir() {
    if (!fs.existsSync(WXACODE_DIR)) {
        fs.mkdirSync(WXACODE_DIR, { recursive: true });
    }
}

function buildCanonical(req) {
    return `${BASE_URL}${req.originalUrl.split('?')[0]}`;
}

function buildWebSiteSchema() {
    return {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: '看图学英语',
        alternateName: 'Visual English for Curious Kids',
        url: BASE_URL,
        inLanguage: 'zh-CN'
    };
}

function buildBreadcrumbSchema(items = []) {
    return {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: items.map((item, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: item.name,
            item: item.url
        }))
    };
}

function excerptText(text, limit = 120) {
    const plain = String(text || '')
        .replace(/[#>*`\-]/g, ' ')
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    if (!plain) return '';
    return plain.length > limit ? `${plain.slice(0, limit).trim()}...` : plain;
}

function sourceTypeLabel(type) {
    const map = {
        scene: '场景学习',
        picturebook: '绘本阅读',
        podcast: '磨耳朵',
        dialogue: '对话表达',
        word: '词汇启蒙'
    };
    return map[type] || '家长内容';
}

function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function markdownToHtml(markdown = '') {
    const lines = String(markdown || '').split(/\r?\n/);
    let html = '';
    let inList = false;

    const closeList = () => {
        if (inList) {
            html += '</ul>';
            inList = false;
        }
    };

    lines.forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line) {
            closeList();
            return;
        }

        const safe = line
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        if (/^###\s+/.test(line)) {
            closeList();
            html += `<h3>${safe.replace(/^###\s+/, '')}</h3>`;
            return;
        }
        if (/^##\s+/.test(line)) {
            closeList();
            html += `<h2>${safe.replace(/^##\s+/, '')}</h2>`;
            return;
        }
        if (/^#\s+/.test(line)) {
            closeList();
            html += `<h1>${safe.replace(/^#\s+/, '')}</h1>`;
            return;
        }
        if (/^[-*]\s+/.test(line)) {
            if (!inList) {
                html += '<ul>';
                inList = true;
            }
            html += `<li>${safe.replace(/^[-*]\s+/, '')}</li>`;
            return;
        }

        closeList();
        html += `<p>${safe}</p>`;
    });

    closeList();
    return html || '<p>正文整理中。</p>';
}

async function getWechatAccessToken() {
    if (!config.wechat.appId || !config.wechat.secret) {
        throw new Error('未配置 WECHAT_APPID / WECHAT_SECRET');
    }

    const tokenRes = await axios.get(
        `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.wechat.appId}&secret=${config.wechat.secret}`,
        { timeout: 15000 }
    );

    if (!tokenRes.data.access_token) {
        throw new Error(tokenRes.data.errmsg || '获取 access_token 失败');
    }

    return tokenRes.data.access_token;
}

async function generateWxacode({ scene, page, filename, lineColor }) {
    ensureWxacodeDir();
    const accessToken = await getWechatAccessToken();
    const wxRes = await axios.post(
        `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${accessToken}`,
        {
            scene,
            page,
            width: 430,
            auto_color: false,
            line_color: lineColor || { r: 31, g: 122, b: 107 },
            is_hyaline: false
        },
        { responseType: 'arraybuffer', timeout: 20000 }
    );

    const contentType = wxRes.headers['content-type'] || '';
    if (!contentType.includes('image')) {
        const errData = JSON.parse(Buffer.from(wxRes.data).toString());
        throw new Error(errData.errmsg || '生成小程序码失败');
    }

    const savePath = path.join(WXACODE_DIR, filename);
    fs.writeFileSync(savePath, wxRes.data);
    return `/uploads/wxacode/${filename}`;
}

async function getPictureBookCategories() {
    return query(
        'SELECT id, name, name_en, icon FROM picture_book_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
    );
}

async function getSceneCategories() {
    return query(
        'SELECT id, name FROM scene_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
    );
}

async function getBooks({ categoryId = '', limit = 12, page = 1 } = {}) {
    const offset = (page - 1) * limit;
    let sql = `
        SELECT b.id, b.title, b.title_en, b.cover_url, b.description, b.category_id, b.difficulty_level,
               b.page_count, b.is_free, c.name AS category_name, c.name_en AS category_name_en
        FROM picture_books b
        LEFT JOIN picture_book_categories c ON c.id = b.category_id
        WHERE b.is_active = 1
    `;
    const params = [];
    if (categoryId) {
        sql += ' AND b.category_id = ?';
        params.push(categoryId);
    }
    sql += ' ORDER BY b.sort_order ASC, b.id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const list = await query(sql, params);
    return list.map((item) => ({
        ...item,
        cover_url: normalizeMedia(item.cover_url),
        category_name: item.category_name || item.category_name_en || 'Picture Book'
    }));
}

async function countBooks(categoryId = '') {
    let sql = 'SELECT COUNT(*) AS total FROM picture_books WHERE is_active = 1';
    const params = [];
    if (categoryId) {
        sql += ' AND category_id = ?';
        params.push(categoryId);
    }
    const [row] = await query(sql, params);
    return parseInt(row?.total || 0, 10);
}

async function getBookDetail(id) {
    const [book] = await query(`
        SELECT b.*, c.name AS category_name, c.name_en AS category_name_en
        FROM picture_books b
        LEFT JOIN picture_book_categories c ON c.id = b.category_id
        WHERE b.id = ? AND b.is_active = 1
    `, [id]);
    if (!book) return null;

    const pages = await query(
        'SELECT id, page_number, image_url, text_en, text_cn FROM picture_book_pages WHERE book_id = ? ORDER BY page_number ASC',
        [id]
    );

    return {
        ...book,
        cover_url: normalizeMedia(book.cover_url),
        category_name: book.category_name || book.category_name_en || 'Picture Book',
        pages: pages.map((item) => ({
            ...item,
            image_url: normalizeMedia(item.image_url)
        }))
    };
}

async function getScenes({ categoryId = '', limit = 12, page = 1 } = {}) {
    const offset = (page - 1) * limit;
    let sql = `
        SELECT s.id, s.name, s.name_en, s.description, s.image_url, s.category_id, s.difficulty_level, c.name AS category_name
        FROM scenes s
        LEFT JOIN scene_categories c ON c.id = s.category_id
        WHERE s.is_active = 1
    `;
    const params = [];
    if (categoryId) {
        sql += ' AND s.category_id = ?';
        params.push(categoryId);
    }
    sql += ' ORDER BY s.sort_order ASC, s.id DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const list = await query(sql, params);
    return list.map((item) => ({
        ...item,
        image_url: normalizeMedia(item.image_url),
        category_name: item.category_name || 'Scene Learning'
    }));
}

async function countScenes(categoryId = '') {
    let sql = 'SELECT COUNT(*) AS total FROM scenes WHERE is_active = 1';
    const params = [];
    if (categoryId) {
        sql += ' AND category_id = ?';
        params.push(categoryId);
    }
    const [row] = await query(sql, params);
    return parseInt(row?.total || 0, 10);
}

async function getSceneDetail(id) {
    const [scene] = await query(`
        SELECT s.*, c.name AS category_name
        FROM scenes s
        LEFT JOIN scene_categories c ON c.id = s.category_id
        WHERE s.id = ? AND s.is_active = 1
    `, [id]);
    if (!scene) return null;

    const objects = await query(`
        SELECT so.*,
               COALESCE(so.phonetic, w.phonetic) AS phonetic,
               COALESCE(so.translation, w.translation) AS translation,
               COALESCE(so.audio_url_female, w.audio_url_female) AS audio_url_female,
               COALESCE(so.audio_url_male, w.audio_url_male) AS audio_url_male
        FROM scene_objects so
        LEFT JOIN words w ON so.word_id = w.id
        WHERE so.scene_id = ?
        ORDER BY so.sort_order ASC, so.id ASC
    `, [id]);

    return {
        ...scene,
        image_url: normalizeMedia(scene.image_url),
        category_name: scene.category_name || 'Scene Learning',
        objects
    };
}

async function getPublishedArticles(limit = 6) {
    const list = await query(`
        SELECT id, title, platform, source_type, source_id, source_title, body, cover_url, tags, created_at
        FROM marketing_contents
        WHERE content_type = 'article' AND status = 'published'
        ORDER BY updated_at DESC, id DESC
        LIMIT ?
    `, [limit]);

    return list.map((item) => ({
        ...item,
        cover_url: normalizeMedia(item.cover_url),
        excerpt: excerptText(item.body, 120),
        summary: excerptText(item.body, 96),
        created_date: formatDate(item.created_at),
        source_type_label: sourceTypeLabel(item.source_type),
        href: `/parents/${item.id}`
    }));
}

async function getArticleById(id) {
    const [item] = await query(`
        SELECT id, title, platform, source_type, source_id, source_title, body, cover_url, tags, created_at
        FROM marketing_contents
        WHERE id = ? AND content_type = 'article' AND status = 'published'
    `, [id]);
    if (!item) return null;
    return {
        ...item,
        cover_url: normalizeMedia(item.cover_url),
        excerpt: excerptText(item.body, 140),
        summary: excerptText(item.body, 110),
        created_date: formatDate(item.created_at),
        source_type_label: sourceTypeLabel(item.source_type),
        body_html: markdownToHtml(item.body),
        href: `/parents/${item.id}`
    };
}

async function getRelatedArticles({ sourceType = '', sourceId = 0, excludeId = 0, limit = 3 } = {}) {
    const params = [];
    let sql = `
        SELECT id, title, platform, source_type, source_id, source_title, body, cover_url, tags, created_at
        FROM marketing_contents
        WHERE content_type = 'article' AND status = 'published'
    `;

    if (sourceType) {
        sql += ' AND source_type = ?';
        params.push(sourceType);
    }
    if (sourceId) {
        sql += ' AND source_id = ?';
        params.push(sourceId);
    }
    if (excludeId) {
        sql += ' AND id <> ?';
        params.push(excludeId);
    }

    sql += ' ORDER BY updated_at DESC, id DESC LIMIT ?';
    params.push(limit);

    const rows = await query(sql, params);
    if (rows.length >= limit || (!sourceType && !sourceId)) {
        return rows.map((item) => ({
            ...item,
            cover_url: normalizeMedia(item.cover_url),
            excerpt: excerptText(item.body, 120),
            summary: excerptText(item.body, 96),
            created_date: formatDate(item.created_at),
            source_type_label: sourceTypeLabel(item.source_type),
            href: `/parents/${item.id}`
        }));
    }

    const extra = await getPublishedArticles(limit + 2);
    return [...rows.map((item) => ({
        ...item,
        cover_url: normalizeMedia(item.cover_url),
        excerpt: excerptText(item.body, 120),
        summary: excerptText(item.body, 96),
        created_date: formatDate(item.created_at),
        source_type_label: sourceTypeLabel(item.source_type),
        href: `/parents/${item.id}`
    })), ...extra]
        .filter((item, index, list) => item.id !== excludeId && list.findIndex((node) => node.id === item.id) === index)
        .slice(0, limit);
}

function renderSite(res, view, options) {
    return res.render(view, options);
}

router.get('/', async (req, res, next) => {
    try {
        const [featuredBooks, featuredScenes, articles, totalBooks, totalScenes] = await Promise.all([
            getBooks({ limit: 6, page: 1 }),
            getScenes({ limit: 6, page: 1 }),
            getPublishedArticles(3),
            countBooks(),
            countScenes()
        ]);

        const homeArticles = articles.length ? articles : FALLBACK_ARTICLES;

        renderSite(res, 'home', {
            pageKey: 'home',
            metaTitle: '看图学英语 | 场景单词、故事绘本与对话练习',
            metaDescription: '看图学英语把场景单词、故事绘本、对话练习和点读跟读连成一套适合儿童长期使用的英语学习体验。',
            metaKeywords: '看图学英语,儿童英语点读,英语绘本,场景英语,看图学英语,英语小程序',
            canonicalUrl: buildCanonical(req),
            metaImage: '',
            structuredData: buildWebSiteSchema(),
            featuredBooks,
            featuredScenes,
            homeArticles,
            stats: {
                sceneCount: totalScenes,
                bookCount: totalBooks,
                articleCount: homeArticles.length
            },
            initialState: {
                featuredBooks,
                featuredScenes
            }
        });
    } catch (e) {
        next(e);
    }
});

router.get('/books', async (req, res, next) => {
    try {
        const [categories, books, total] = await Promise.all([
            getPictureBookCategories(),
            getBooks({ limit: 12, page: 1 }),
            countBooks()
        ]);
        renderSite(res, 'books', {
            pageKey: 'books',
            metaTitle: '绘本馆 | 看图学英语',
            metaDescription: '浏览看图学英语的儿童英语绘本馆，把知识、故事和英语表达放进同一本好读、好看、适合孩子坚持的绘本里。',
            metaKeywords: '英语绘本,儿童英语阅读,英语启蒙绘本,科普绘本,英语小程序',
            canonicalUrl: buildCanonical(req),
            metaImage: '',
            structuredData: buildBreadcrumbSchema([
                { name: '看图学英语', url: BASE_URL },
                { name: '绘本馆', url: buildCanonical(req) }
            ]),
            categories,
            books,
            hasMore: total > books.length,
            initialState: {
                books: {
                    page: 2,
                    limit: 12,
                    categoryId: '',
                    hasMore: total > books.length
                },
                bookCategories: categories
            }
        });
    } catch (e) {
        next(e);
    }
});

router.get('/books/:id', async (req, res, next) => {
    try {
        const book = await getBookDetail(parseInt(req.params.id, 10));
        if (!book) return next();

        const previewPages = book.pages.slice(0, 5);
        const relatedBooks = (await getBooks({ categoryId: book.category_id, limit: 4, page: 1 }))
            .filter((item) => item.id !== book.id)
            .slice(0, 3);
        const relatedArticles = await getRelatedArticles({ sourceType: 'picturebook', sourceId: book.id, limit: 3 });
        const previewText = previewPages.map((item) => item.text_en).join(' ');
        const learningGoals = [
            book.description || '围绕真实主题理解图像、知识与英语表达的关系。',
            previewPages[0]?.text_en || '先根据图片和上下文建立理解。',
            previewPages[1]?.text_en || '在重复输入中自然接住关键词和句型。'
        ].filter(Boolean).slice(0, 3);

        renderSite(res, 'book-detail', {
            pageKey: 'book-detail',
            metaTitle: `${book.title} | 绘本详情 | 看图学英语`,
            metaDescription: excerptText(book.description || previewText, 120) || `${book.title} 绘本详情页，适合孩子继续在小程序里点读、听音频和跟读。`,
            metaKeywords: `${book.title},${book.title_en || ''},英语绘本,儿童英语阅读,看图学英语`,
            canonicalUrl: buildCanonical(req),
            metaImage: book.cover_url || '',
            structuredData: [
                buildBreadcrumbSchema([
                    { name: '看图学英语', url: BASE_URL },
                    { name: '绘本馆', url: `${BASE_URL}/books` },
                    { name: book.title, url: buildCanonical(req) }
                ]),
                {
                    '@context': 'https://schema.org',
                    '@type': 'Book',
                    name: book.title,
                    alternateName: book.title_en || '',
                    description: excerptText(book.description || previewText, 180),
                    image: book.cover_url || undefined,
                    inLanguage: 'en',
                    numberOfPages: book.page_count || book.pages.length || undefined
                }
            ],
            book,
            pages: book.pages,
            previewPages,
            relatedBooks,
            relatedArticles,
            learningGoals,
            initialState: {
                bookId: book.id
            }
        });
    } catch (e) {
        next(e);
    }
});

router.get('/scenes', async (req, res, next) => {
    try {
        const [categories, scenes, total] = await Promise.all([
            getSceneCategories(),
            getScenes({ limit: 12, page: 1 }),
            countScenes()
        ]);
        renderSite(res, 'scenes', {
            pageKey: 'scenes',
            metaTitle: '场景学习 | 看图学英语',
            metaDescription: '在真实生活场景里理解词汇、句子和表达。浏览看图学英语的场景学习库，帮助孩子把英语和生活画面连起来。',
            metaKeywords: '场景英语,看图学英语,英语点读,儿童英语启蒙,场景词汇',
            canonicalUrl: buildCanonical(req),
            metaImage: '',
            structuredData: buildBreadcrumbSchema([
                { name: '看图学英语', url: BASE_URL },
                { name: '场景学习', url: buildCanonical(req) }
            ]),
            categories,
            scenes,
            hasMore: total > scenes.length,
            initialState: {
                scenes: {
                    page: 2,
                    limit: 12,
                    categoryId: '',
                    hasMore: total > scenes.length
                },
                sceneCategories: categories
            }
        });
    } catch (e) {
        next(e);
    }
});

router.get('/scenes/:id', async (req, res, next) => {
    try {
        const scene = await getSceneDetail(parseInt(req.params.id, 10));
        if (!scene) return next();

        const relatedScenes = (await getScenes({ categoryId: scene.category_id, limit: 4, page: 1 }))
            .filter((item) => item.id !== scene.id)
            .slice(0, 3);
        const relatedArticles = await getRelatedArticles({ sourceType: 'scene', sourceId: scene.id, limit: 3 });
        const focusWords = scene.objects.slice(0, 6).map((item) => item.text_en || item.custom_label).filter(Boolean);

        renderSite(res, 'scene-detail', {
            pageKey: 'scene-detail',
            metaTitle: `${scene.name} | 场景详情 | 看图学英语`,
            metaDescription: excerptText(scene.description || scene.objects.map((item) => item.text_en).join(' '), 120) || `${scene.name} 场景详情页，可继续在小程序里点读发音、看翻译和做表达练习。`,
            metaKeywords: `${scene.name},${scene.name_en || ''},场景英语,英语点读,看图学英语`,
            canonicalUrl: buildCanonical(req),
            metaImage: scene.image_url || '',
            structuredData: [
                buildBreadcrumbSchema([
                    { name: '看图学英语', url: BASE_URL },
                    { name: '场景学习', url: `${BASE_URL}/scenes` },
                    { name: scene.name, url: buildCanonical(req) }
                ]),
                {
                    '@context': 'https://schema.org',
                    '@type': 'CreativeWork',
                    name: scene.name,
                    alternateName: scene.name_en || '',
                    description: excerptText(scene.description || focusWords.join(' '), 180),
                    image: scene.image_url || undefined,
                    keywords: focusWords.join(', ')
                }
            ],
            scene,
            relatedScenes,
            relatedArticles,
            focusWords,
            initialState: {
                sceneId: scene.id
            }
        });
    } catch (e) {
        next(e);
    }
});

router.get('/parents', async (req, res, next) => {
    try {
        const articles = await getPublishedArticles(9);
        renderSite(res, 'parents', {
            pageKey: 'parents',
            metaTitle: '家长内容 | 看图学英语',
            metaDescription: '给家长看的英语启蒙内容入口：方法、陪伴建议、阅读路径和真实使用场景，让英语学习既有内容也有节奏。',
            metaKeywords: '英语启蒙方法,家长陪读,绘本共读,场景英语,看图学英语',
            canonicalUrl: buildCanonical(req),
            metaImage: '',
            structuredData: buildBreadcrumbSchema([
                { name: '看图学英语', url: BASE_URL },
                { name: '家长内容', url: buildCanonical(req) }
            ]),
            articles: articles.length ? articles : FALLBACK_ARTICLES,
            initialState: {}
        });
    } catch (e) {
        next(e);
    }
});

router.get('/parents/:id', async (req, res, next) => {
    try {
        const article = await getArticleById(parseInt(req.params.id, 10));
        if (!article) return next();
        const relatedArticles = (await getPublishedArticles(4)).filter((item) => item.id !== article.id).slice(0, 3);

        renderSite(res, 'article-detail', {
            pageKey: 'parents',
            metaTitle: `${article.title} | 家长内容 | 看图学英语`,
            metaDescription: article.summary || article.excerpt || '给家长看的英语启蒙内容文章页。',
            metaKeywords: `${article.title},英语启蒙方法,家长内容,看图学英语`,
            canonicalUrl: buildCanonical(req),
            metaImage: article.cover_url || '',
            structuredData: [
                buildBreadcrumbSchema([
                    { name: '看图学英语', url: BASE_URL },
                    { name: '家长内容', url: `${BASE_URL}/parents` },
                    { name: article.title, url: buildCanonical(req) }
                ]),
                {
                    '@context': 'https://schema.org',
                    '@type': 'Article',
                    headline: article.title,
                    datePublished: article.created_at,
                    description: article.summary || article.excerpt,
                    image: article.cover_url || undefined,
                    mainEntityOfPage: buildCanonical(req)
                }
            ],
            article,
            relatedArticles,
            initialState: {}
        });
    } catch (e) {
        next(e);
    }
});

router.get('/api/site/articles', async (req, res) => {
    try {
        const items = await getPublishedArticles(parseInt(req.query.limit || '12', 10));
        res.json({ success: true, data: items });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/site/mini-program-code', async (req, res) => {
    try {
        const type = String(req.query.type || 'home').trim().toLowerCase();
        const force = req.query.force === '1' || req.query.force === 'true';
        const id = parseInt(req.query.id || 0, 10);

        if (!['home', 'scene', 'book'].includes(type)) {
            return res.status(400).json({ success: false, message: 'type 仅支持 home / scene / book' });
        }

        if ((type === 'scene' || type === 'book') && !id) {
            return res.status(400).json({ success: false, message: '缺少 id 参数' });
        }

        if (type === 'home') {
            const filename = 'wxacode_site_home.png';
            const cachedUrl = `/uploads/wxacode/${filename}`;
            if (!force && localFileExists(cachedUrl)) {
                return res.json({
                    success: true,
                    data: {
                        type,
                        id: null,
                        scene: 'from=site',
                        page: 'pages/index/index',
                        url: cachedUrl,
                        cached: true
                    }
                });
            }

            const url = await generateWxacode({
                scene: 'from=site',
                page: 'pages/index/index',
                filename,
                lineColor: { r: 31, g: 122, b: 107 }
            });

            return res.json({
                success: true,
                data: {
                    type,
                    id: null,
                    scene: 'from=site',
                    page: 'pages/index/index',
                    url,
                    cached: false
                }
            });
        }

        if (type === 'scene') {
            const [scene] = await query('SELECT id, name, wxacode_url, wxacode_scene FROM scenes WHERE id = ?', [id]);
            if (!scene) {
                return res.status(404).json({ success: false, message: '场景不存在' });
            }

            const sceneParam = scene.wxacode_scene || `id=${id}`;
            if (!force && scene.wxacode_url && localFileExists(scene.wxacode_url)) {
                return res.json({
                    success: true,
                    data: {
                        type,
                        id,
                        title: scene.name,
                        scene: sceneParam,
                        page: 'pages/scene/detail/detail',
                        url: scene.wxacode_url,
                        cached: true
                    }
                });
            }

            const url = await generateWxacode({
                scene: sceneParam,
                page: 'pages/scene/detail/detail',
                filename: `wxacode_scene_${id}.png`,
                lineColor: { r: 31, g: 122, b: 107 }
            });

            await query(
                'UPDATE scenes SET wxacode_url = ?, wxacode_scene = ?, wxacode_generated_at = NOW() WHERE id = ?',
                [url, sceneParam, id]
            );

            return res.json({
                success: true,
                data: {
                    type,
                    id,
                    title: scene.name,
                    scene: sceneParam,
                    page: 'pages/scene/detail/detail',
                    url,
                    cached: false
                }
            });
        }

        const [book] = await query(
            'SELECT id, title, wxacode_url, wxacode_scene FROM picture_books WHERE id = ? AND is_active = 1',
            [id]
        );
        if (!book) {
            return res.status(404).json({ success: false, message: '绘本不存在' });
        }

        const sceneParam = book.wxacode_scene || `type=b&id=${id}`;
        if (!force && book.wxacode_url && localFileExists(book.wxacode_url)) {
            return res.json({
                success: true,
                data: {
                    type,
                    id,
                    title: book.title,
                    scene: sceneParam,
                    page: 'pages/entry/entry',
                    url: book.wxacode_url,
                    cached: true
                }
            });
        }

        const url = await generateWxacode({
            scene: sceneParam,
            page: 'pages/entry/entry',
            filename: `wxacode_book_${id}.png`,
            lineColor: { r: 242, g: 141, b: 82 }
        });

        await query(
            'UPDATE picture_books SET wxacode_url = ?, wxacode_scene = ?, wxacode_generated_at = NOW() WHERE id = ?',
            [url, sceneParam, id]
        );

        return res.json({
            success: true,
            data: {
                type,
                id,
                title: book.title,
                scene: sceneParam,
                page: 'pages/entry/entry',
                url,
                cached: false
            }
        });
    } catch (e) {
        console.error('[Site] 获取小程序码失败:', e.message);
        return res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
