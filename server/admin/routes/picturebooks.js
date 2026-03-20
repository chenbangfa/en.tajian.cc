const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const voiceService = require('../../src/services/voice.service');
const aiService = require('../../src/services/ai.service');

const router = express.Router();

// Multer config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../../uploads/picturebooks');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `pb_${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage });

// ===== 页面路由 =====

router.get('/', (req, res) => {
    res.render('picturebooks/index', { page: 'pb-list', title: '绘本管理', user: req.session.adminUser });
});

router.get('/edit/new', (req, res) => {
    res.render('picturebooks/edit', { page: 'pb-list', title: '新建绘本', user: req.session.adminUser, book: null });
});

router.get('/edit/:id', async (req, res) => {
    try {
        const [book] = await query('SELECT * FROM picture_books WHERE id = ?', [req.params.id]);
        if (!book) return res.redirect('/picture-books');
        res.render('picturebooks/edit', { page: 'pb-list', title: '编辑绘本', user: req.session.adminUser, book });
    } catch (e) {
        res.redirect('/picture-books');
    }
});

// ===== API: 绘本 CRUD =====

router.get('/api/list', async (req, res) => {
    try {
        const { category_id, keyword } = req.query;
        let sql = `SELECT b.*, c.name as category_name
            FROM picture_books b
            LEFT JOIN picture_book_categories c ON b.category_id = c.id
            WHERE 1=1`;
        const params = [];

        if (category_id) {
            sql += ' AND b.category_id = ?';
            params.push(parseInt(category_id));
        }
        if (keyword) {
            sql += ' AND (b.title LIKE ? OR b.title_en LIKE ?)';
            params.push(`%${keyword}%`, `%${keyword}%`);
        }

        sql += ' ORDER BY b.sort_order ASC, b.id DESC';
        const books = await query(sql, params);
        res.json({ success: true, data: books });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/create', async (req, res) => {
    try {
        const { title, title_en, description, category_id, difficulty_level, age_group, cover_url, is_free } = req.body;
        if (!title) return res.status(400).json({ success: false, message: '标题不能为空' });

        const result = await query(
            'INSERT INTO picture_books (title, title_en, description, category_id, difficulty_level, age_group, cover_url, is_free) VALUES (?,?,?,?,?,?,?,?)',
            [title, title_en || '', description || '', category_id || 0, difficulty_level || 1, age_group || null, cover_url || null, is_free !== undefined ? is_free : 1]
        );
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/:id', async (req, res) => {
    try {
        const { title, title_en, description, category_id, difficulty_level, age_group, cover_url, is_free, is_active, sort_order } = req.body;
        await query(
            `UPDATE picture_books SET title=?, title_en=?, description=?, category_id=?, difficulty_level=?, age_group=?, cover_url=?, is_free=?, is_active=?, sort_order=? WHERE id=?`,
            [title, title_en || '', description || '', category_id || 0, difficulty_level || 1, age_group || null, cover_url || null,
             is_free !== undefined ? is_free : 1, is_active !== undefined ? is_active : 1, sort_order || 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/:id', async (req, res) => {
    try {
        await query('DELETE FROM picture_book_hotspots WHERE book_id = ?', [req.params.id]);
        await query('DELETE FROM picture_book_pages WHERE book_id = ?', [req.params.id]);
        await query('DELETE FROM picture_book_progress WHERE book_id = ?', [req.params.id]);
        await query('DELETE FROM picture_books WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 页面管理 =====

router.get('/api/:id/pages', async (req, res) => {
    try {
        const pages = await query(
            'SELECT * FROM picture_book_pages WHERE book_id = ? ORDER BY sort_order ASC, page_number ASC',
            [req.params.id]
        );
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        const processed = pages.map(p => ({
            ...p,
            audio_url: p.audio_url ? (p.audio_url.startsWith('http') ? p.audio_url : baseUrl + p.audio_url) : null,
            audio_url_male: p.audio_url_male ? (p.audio_url_male.startsWith('http') ? p.audio_url_male : baseUrl + p.audio_url_male) : null
        }));
        res.json({ success: true, data: processed });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/:id/pages', async (req, res) => {
    try {
        const bookId = req.params.id;
        // Get next page number
        const [maxPage] = await query('SELECT COALESCE(MAX(page_number), 0) as max_num FROM picture_book_pages WHERE book_id = ?', [bookId]);
        const pageNumber = maxPage.max_num + 1;

        const result = await query(
            'INSERT INTO picture_book_pages (book_id, page_number, sort_order) VALUES (?, ?, ?)',
            [bookId, pageNumber, pageNumber]
        );

        // Update page_count
        await query('UPDATE picture_books SET page_count = (SELECT COUNT(*) FROM picture_book_pages WHERE book_id = ?) WHERE id = ?', [bookId, bookId]);

        res.json({ success: true, id: result.insertId, page_number: pageNumber });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/:id/pages/:pageId', async (req, res) => {
    try {
        const { text_en, text_cn, image_url, audio_url, audio_url_male } = req.body;
        const fields = [];
        const params = [];

        if (text_en !== undefined) { fields.push('text_en=?'); params.push(text_en); }
        if (text_cn !== undefined) { fields.push('text_cn=?'); params.push(text_cn); }
        if (image_url !== undefined) { fields.push('image_url=?'); params.push(image_url); }
        if (audio_url !== undefined) { fields.push('audio_url=?'); params.push(audio_url); }
        if (audio_url_male !== undefined) { fields.push('audio_url_male=?'); params.push(audio_url_male); }

        if (fields.length === 0) return res.json({ success: true, message: '无更新' });

        params.push(req.params.pageId, req.params.id);
        await query(`UPDATE picture_book_pages SET ${fields.join(',')} WHERE id=? AND book_id=?`, params);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/:id/pages/:pageId', async (req, res) => {
    try {
        const bookId = req.params.id;
        await query('DELETE FROM picture_book_hotspots WHERE page_id = ?', [req.params.pageId]);
        await query('DELETE FROM picture_book_pages WHERE id = ? AND book_id = ?', [req.params.pageId, bookId]);

        // Renumber pages
        const pages = await query('SELECT id FROM picture_book_pages WHERE book_id = ? ORDER BY sort_order ASC', [bookId]);
        for (let i = 0; i < pages.length; i++) {
            await query('UPDATE picture_book_pages SET page_number = ?, sort_order = ? WHERE id = ?', [i + 1, i + 1, pages[i].id]);
        }

        // Update page_count
        await query('UPDATE picture_books SET page_count = ? WHERE id = ?', [pages.length, bookId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/:id/pages/reorder', async (req, res) => {
    try {
        const { pageIds } = req.body;
        if (!pageIds || !Array.isArray(pageIds)) return res.status(400).json({ success: false, message: '无效数据' });

        for (let i = 0; i < pageIds.length; i++) {
            await query('UPDATE picture_book_pages SET sort_order = ?, page_number = ? WHERE id = ? AND book_id = ?',
                [i + 1, i + 1, pageIds[i], req.params.id]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: TTS 生成 =====

router.post('/api/:id/pages/:pageId/tts', async (req, res) => {
    try {
        const [page] = await query('SELECT id, text_en FROM picture_book_pages WHERE id = ? AND book_id = ?', [req.params.pageId, req.params.id]);
        if (!page) return res.status(404).json({ success: false, message: '页面不存在' });
        if (!page.text_en) return res.status(400).json({ success: false, message: '页面无英文文本' });

        const { voice = 'female' } = req.body;
        const result = await voiceService.textToSpeech(page.text_en, voice, 1.0);
        if (result.success && result.audioUrl) {
            const field = voice === 'male' ? 'audio_url_male' : 'audio_url';
            await query(`UPDATE picture_book_pages SET ${field} = ? WHERE id = ?`, [result.audioUrl, page.id]);

            const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
            const fullUrl = result.audioUrl.startsWith('http') ? result.audioUrl : baseUrl + result.audioUrl;
            return res.json({ success: true, audio_url: fullUrl, voice });
        }
        res.status(500).json({ success: false, message: result.error || '生成失败' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 图片上传 =====

router.post('/api/upload-image', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '无文件' });

    // Try COS upload
    const cosService = require('../../src/services/cos.service');
    if (cosService.isConfigured) {
        try {
            const fileBuffer = fs.readFileSync(req.file.path);
            const url = await cosService.uploadBuffer(fileBuffer, `images/pb_${Date.now()}${path.extname(req.file.originalname)}`);
            fs.unlinkSync(req.file.path);
            return res.json({ success: true, url });
        } catch (e) {
            console.error('[PictureBooks] COS上传失败，回退本地:', e.message);
        }
    }

    res.json({ success: true, url: `/uploads/picturebooks/${req.file.filename}` });
});

router.post('/api/upload-cover', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '无文件' });

    const cosService = require('../../src/services/cos.service');
    if (cosService.isConfigured) {
        try {
            const fileBuffer = fs.readFileSync(req.file.path);
            const url = await cosService.uploadBuffer(fileBuffer, `images/pb_cover_${Date.now()}${path.extname(req.file.originalname)}`);
            fs.unlinkSync(req.file.path);
            return res.json({ success: true, url });
        } catch (e) {
            console.error('[PictureBooks] COS上传失败，回退本地:', e.message);
        }
    }

    res.json({ success: true, url: `/uploads/picturebooks/${req.file.filename}` });
});

// ===== API: AI 生成封面 =====

router.post('/api/:id/generate-cover', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ success: false, message: '请提供描述' });
        const result = await aiService.generateImage(prompt);
        if (result.success) {
            res.json({ success: true, imageUrl: result.imageUrl });
        } else {
            res.status(500).json({ success: false, message: result.error || '生成失败' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
