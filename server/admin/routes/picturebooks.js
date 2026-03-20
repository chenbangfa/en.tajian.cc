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

// ===== API: 热点管理 =====

router.get('/api/:id/pages/:pageId/hotspots', async (req, res) => {
    try {
        const hotspots = await query(
            'SELECT * FROM picture_book_hotspots WHERE page_id = ? AND book_id = ? ORDER BY sort_order ASC',
            [req.params.pageId, req.params.id]
        );
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        const processed = hotspots.map(h => ({
            ...h,
            audio_url_female: h.audio_url_female ? (h.audio_url_female.startsWith('http') ? h.audio_url_female : baseUrl + h.audio_url_female) : null,
            audio_url_male: h.audio_url_male ? (h.audio_url_male.startsWith('http') ? h.audio_url_male : baseUrl + h.audio_url_male) : null
        }));
        res.json({ success: true, data: processed });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/:id/pages/:pageId/hotspots', async (req, res) => {
    try {
        const { text_en, translation, position_x, position_y, width, height } = req.body;
        if (!text_en) return res.status(400).json({ success: false, message: '文本不能为空' });

        const [maxSort] = await query('SELECT COALESCE(MAX(sort_order), 0) as max_sort FROM picture_book_hotspots WHERE page_id = ?', [req.params.pageId]);
        const result = await query(
            'INSERT INTO picture_book_hotspots (page_id, book_id, text_en, translation, position_x, position_y, width, height, sort_order) VALUES (?,?,?,?,?,?,?,?,?)',
            [req.params.pageId, req.params.id, text_en, translation || null, position_x || null, position_y || null, width || null, height || null, maxSort.max_sort + 1]
        );
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/hotspots/:hotspotId', async (req, res) => {
    try {
        const { text_en, translation, phonetic, position_x, position_y, width, height } = req.body;
        const fields = [];
        const params = [];

        if (text_en !== undefined) { fields.push('text_en=?'); params.push(text_en); }
        if (translation !== undefined) { fields.push('translation=?'); params.push(translation); }
        if (phonetic !== undefined) { fields.push('phonetic=?'); params.push(phonetic); }
        if (position_x !== undefined) { fields.push('position_x=?'); params.push(position_x); }
        if (position_y !== undefined) { fields.push('position_y=?'); params.push(position_y); }
        if (width !== undefined) { fields.push('width=?'); params.push(width); }
        if (height !== undefined) { fields.push('height=?'); params.push(height); }

        if (fields.length === 0) return res.json({ success: true });

        params.push(req.params.hotspotId);
        await query(`UPDATE picture_book_hotspots SET ${fields.join(',')} WHERE id=?`, params);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/hotspots/:hotspotId', async (req, res) => {
    try {
        await query('DELETE FROM picture_book_hotspots WHERE id = ?', [req.params.hotspotId]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 批量保存热点（OCR 识别后一次性写入）
router.post('/api/:id/pages/:pageId/hotspots/batch', async (req, res) => {
    try {
        const { hotspots } = req.body;
        if (!hotspots || !Array.isArray(hotspots)) return res.status(400).json({ success: false, message: '无效数据' });

        const bookId = req.params.id;
        const pageId = req.params.pageId;
        const inserted = [];

        for (let i = 0; i < hotspots.length; i++) {
            const h = hotspots[i];
            const result = await query(
                'INSERT INTO picture_book_hotspots (page_id, book_id, text_en, position_x, position_y, width, height, sort_order) VALUES (?,?,?,?,?,?,?,?)',
                [pageId, bookId, h.text_en || h.text, h.position_x, h.position_y, h.width, h.height, i + 1]
            );
            inserted.push({ id: result.insertId, text_en: h.text_en || h.text });
        }

        res.json({ success: true, data: inserted, count: inserted.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// OCR 识别页面图片
router.post('/api/:id/pages/:pageId/ocr', async (req, res) => {
    try {
        const [page] = await query('SELECT * FROM picture_book_pages WHERE id = ? AND book_id = ?', [req.params.pageId, req.params.id]);
        if (!page) return res.status(404).json({ success: false, message: '页面不存在' });
        if (!page.image_url) return res.status(400).json({ success: false, message: '页面无图片' });

        const { engine = 'youdao' } = req.body;

        // 处理相对路径
        let imagePath = page.image_url;
        if (imagePath.startsWith('/')) {
            imagePath = path.join(__dirname, '../../', imagePath);
        }

        const result = await aiService.recognizeImageText(imagePath, engine);
        if (result.success) {
            // OCR 返回 { text, rect: {x,y,w,h} } 格式，转为热点格式
            const hotspots = (result.words || []).map(w => ({
                text_en: w.text,
                position_x: w.rect.x,
                position_y: w.rect.y,
                width: w.rect.w,
                height: w.rect.h
            }));
            res.json({ success: true, hotspots, raw_count: hotspots.length });
        } else {
            res.status(500).json({ success: false, message: result.error || '识别失败' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 生成单个热点的翻译+音标+TTS
router.post('/api/hotspots/:hotspotId/generate', async (req, res) => {
    try {
        const [hotspot] = await query('SELECT * FROM picture_book_hotspots WHERE id = ?', [req.params.hotspotId]);
        if (!hotspot) return res.status(404).json({ success: false, message: '热点不存在' });

        const text = hotspot.text_en;
        if (!text) return res.status(400).json({ success: false, message: '热点无文本' });

        // 1. 检查是否匹配已有单词
        const [existingWord] = await query('SELECT * FROM words WHERE word = ? LIMIT 1', [text.toLowerCase().trim()]);

        let phonetic = '', translation = '', audioMale = '', audioFemale = '';

        if (existingWord) {
            phonetic = existingWord.phonetic || '';
            translation = existingWord.translation || '';
            audioMale = existingWord.audio_url_male || '';
            audioFemale = existingWord.audio_url_female || '';
            await query('UPDATE picture_book_hotspots SET word_id = ? WHERE id = ?', [existingWord.id, hotspot.id]);
            console.log(`[PB-Generate] 关联已有单词: ${text} -> word_id=${existingWord.id}`);
        } else {
            console.log(`[PB-Generate] 生成新数据: ${text}`);

            const phoneticResult = await aiService.getPhonetic(text);
            if (phoneticResult.success) phonetic = phoneticResult.phonetic;

            const translateResult = await aiService.translateText(text);
            if (translateResult.success) translation = translateResult.translation;

            try {
                const femaleResult = await voiceService.textToSpeech(text, 'female');
                if (femaleResult.success) audioFemale = femaleResult.audioUrl;

                const maleResult = await voiceService.textToSpeech(text, 'male');
                if (maleResult.success) audioMale = maleResult.audioUrl;
            } catch (ttsError) {
                console.error('[PB-Generate] TTS错误:', ttsError.message);
            }
        }

        await query(
            'UPDATE picture_book_hotspots SET phonetic=?, translation=?, audio_url_female=?, audio_url_male=? WHERE id=?',
            [phonetic, translation, audioFemale, audioMale, hotspot.id]
        );

        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        res.json({
            success: true,
            data: {
                id: hotspot.id,
                phonetic,
                translation,
                audio_url_female: audioFemale ? (audioFemale.startsWith('http') ? audioFemale : baseUrl + audioFemale) : '',
                audio_url_male: audioMale ? (audioMale.startsWith('http') ? audioMale : baseUrl + audioMale) : '',
                word_id: existingWord?.id || null
            }
        });
    } catch (e) {
        console.error('[PB-Generate] 错误:', e);
        res.status(500).json({ success: false, message: e.message });
    }
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
