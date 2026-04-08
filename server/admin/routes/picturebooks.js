const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { query } = require('../../src/config/database');
const voiceService = require('../../src/services/voice.service');
const aiService = require('../../src/services/ai.service');
const {
    normalizeComparableText,
    normalizePromptBookTitleToEnglish,
    buildCoverSourceText,
    buildPictureBookCoverPrompt,
    computeCoverPromptSync,
    buildPictureBookPagePrompt,
    computeImagePromptSync,
    ensurePictureBookPromptColumns
} = require('../../src/services/picturebookPrompt.service');

const router = express.Router();

ensurePictureBookPromptColumns(query).catch(err => {
    console.error('[PictureBooks Admin] 提示词同步字段初始化失败:', err.message);
});

async function getBookPromptContext(bookId) {
    const [book] = await query(
        `SELECT b.id, b.title, b.title_en, b.description, b.category_id, b.cover_prompt, b.cover_prompt_source_text, b.cover_prompt_mode,
                c.name AS category_name, c.name_en AS category_name_en
           FROM picture_books b
      LEFT JOIN picture_book_categories c ON b.category_id = c.id
          WHERE b.id = ?`,
        [bookId]
    );
    return book || null;
}

function buildPageApiPayload(page, book, baseUrl) {
    const normalizedPrompt = normalizePromptBookTitleToEnglish(page.image_prompt || '', book?.title || '', book?.title_en || '');
    const syncInfo = computeImagePromptSync({
        ...page,
        image_prompt: normalizedPrompt
    });

    return {
        ...page,
        image_prompt: normalizedPrompt,
        audio_url: page.audio_url ? (page.audio_url.startsWith('http') ? page.audio_url : baseUrl + page.audio_url) : null,
        audio_url_male: page.audio_url_male ? (page.audio_url_male.startsWith('http') ? page.audio_url_male : baseUrl + page.audio_url_male) : null,
        ...syncInfo
    };
}

async function getBookPagesForPrompt(bookId) {
    return query(
        'SELECT id, page_number, text_en FROM picture_book_pages WHERE book_id = ? ORDER BY sort_order ASC, page_number ASC',
        [bookId]
    );
}

async function buildCoverPromptPayload(bookId) {
    const book = await getBookPromptContext(bookId);
    if (!book) return null;
    const pages = await getBookPagesForPrompt(bookId);
    const syncInfo = computeCoverPromptSync(book, pages);
    return {
        ...book,
        ...syncInfo
    };
}

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

router.get('/batch-images', (req, res) => {
    res.render('picturebooks/batch-images', { page: 'pb-batch-images', title: '绘本批量生图', user: req.session.adminUser });
});

router.get('/batch-audio', (req, res) => {
    res.render('picturebooks/batch-audio', { page: 'pb-batch-audio', title: '绘本批量配音', user: req.session.adminUser });
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

router.get('/api/batch/cover-candidates', async (req, res) => {
    try {
        const { category_id, mode = 'missing' } = req.query;
        let sql = `SELECT b.id, b.title, b.title_en, b.cover_url, b.cover_prompt, b.page_count,
                          b.category_id, c.name AS category_name
                     FROM picture_books b
                LEFT JOIN picture_book_categories c ON b.category_id = c.id
                    WHERE 1=1`;
        const params = [];

        if (category_id) {
            sql += ' AND b.category_id = ?';
            params.push(parseInt(category_id));
        }
        if (mode !== 'all') {
            sql += ` AND (b.cover_url IS NULL OR b.cover_url = '')`;
        }

        sql += ' ORDER BY b.sort_order ASC, b.id ASC';
        const books = await query(sql, params);
        res.json({ success: true, data: books });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/batch/page-candidates', async (req, res) => {
    try {
        const { category_id, mode = 'missing' } = req.query;
        let sql = `SELECT p.id AS page_id, p.book_id, p.page_number, p.image_url, p.image_prompt, p.text_en,
                          b.title, b.title_en, b.category_id, c.name AS category_name
                     FROM picture_book_pages p
               INNER JOIN picture_books b ON p.book_id = b.id
                LEFT JOIN picture_book_categories c ON b.category_id = c.id
                    WHERE 1=1`;
        const params = [];

        if (category_id) {
            sql += ' AND b.category_id = ?';
            params.push(parseInt(category_id));
        }
        if (mode !== 'all') {
            sql += ` AND (p.image_url IS NULL OR p.image_url = '')`;
        }

        sql += ' ORDER BY b.sort_order ASC, b.id ASC, p.page_number ASC';
        const pages = await query(sql, params);
        res.json({ success: true, data: pages });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/batch/audio-candidates', async (req, res) => {
    try {
        const { category_id, mode = 'missing' } = req.query;
        let sql = `
            SELECT b.id, b.title, b.title_en, b.cover_url, b.page_count, b.category_id,
                   c.name AS category_name,
                   SUM(CASE WHEN p.text_en IS NOT NULL AND TRIM(p.text_en) <> '' THEN 1 ELSE 0 END) AS total_audio_pages,
                   SUM(CASE WHEN p.text_en IS NOT NULL AND TRIM(p.text_en) <> '' AND (p.audio_url IS NULL OR p.audio_url = '') THEN 1 ELSE 0 END) AS missing_audio_pages,
                   MIN(CASE WHEN p.text_en IS NOT NULL AND TRIM(p.text_en) <> '' AND (p.audio_url IS NULL OR p.audio_url = '') THEN p.page_number ELSE NULL END) AS first_missing_page
              FROM picture_books b
         LEFT JOIN picture_book_pages p ON p.book_id = b.id
         LEFT JOIN picture_book_categories c ON b.category_id = c.id
             WHERE 1=1`;
        const params = [];

        if (category_id) {
            sql += ' AND b.category_id = ?';
            params.push(parseInt(category_id, 10));
        }

        sql += ' GROUP BY b.id, b.title, b.title_en, b.cover_url, b.page_count, b.category_id, c.name';
        if (mode === 'all') {
            sql += ' HAVING total_audio_pages > 0';
        } else {
            sql += ' HAVING missing_audio_pages > 0';
        }

        sql += ' ORDER BY missing_audio_pages DESC, b.sort_order ASC, b.id ASC';
        const books = await query(sql, params);
        res.json({ success: true, data: books });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/:id/generate-audio-batch', async (req, res) => {
    try {
        const bookId = parseInt(req.params.id, 10);
        const mode = req.body?.mode === 'all' ? 'all' : 'missing';

        const [book] = await query('SELECT id, title FROM picture_books WHERE id = ?', [bookId]);
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });

        const pages = await query(
            `SELECT id, page_number, text_en, audio_url
               FROM picture_book_pages
              WHERE book_id = ?
                AND text_en IS NOT NULL
                AND TRIM(text_en) <> ''
              ORDER BY page_number ASC`,
            [bookId]
        );

        const targetPages = pages.filter(page => mode === 'all' || !page.audio_url);
        if (targetPages.length === 0) {
            return res.json({
                success: true,
                generated: 0,
                total: pages.length,
                speed: voiceService.getGoogleTtsSpeed('picture_book'),
                voice: 'female',
                message: '无需生成'
            });
        }

        const speed = voiceService.getGoogleTtsSpeed('picture_book');
        let generated = 0;
        const failedPages = [];

        for (let i = 0; i < targetPages.length; i++) {
            const page = targetPages[i];
            // 页间延迟：中国→美国代理→Google，留足时间避免 429 限流
            if (i > 0) await new Promise(r => setTimeout(r, 6000));
            try {
                const result = await voiceService.googleTextToSpeech(page.text_en, 'female', speed);
                if (!result.success || !result.audioUrl) {
                    throw new Error(result.error || '生成失败');
                }
                await query('UPDATE picture_book_pages SET audio_url = ? WHERE id = ?', [result.audioUrl, page.id]);
                generated++;
            } catch (err) {
                failedPages.push({
                    page_number: page.page_number,
                    error: err.message || '生成失败'
                });
            }
        }

        // 部分成功也算成功（已生成的页已写入 DB，下次只补缺失页）
        const allFailed = generated === 0 && failedPages.length > 0;
        if (allFailed) {
            return res.status(500).json({
                success: false,
                message: `${book.title} 全部 ${failedPages.length} 页配音失败`,
                generated,
                total: targetPages.length,
                failed_pages: failedPages,
                speed,
                voice: 'female'
            });
        }

        res.json({
            success: true,
            generated,
            total: targetPages.length,
            failed_pages: failedPages,
            message: failedPages.length > 0
                ? `${book.title} 完成 ${generated}/${targetPages.length} 页，${failedPages.length} 页失败（下次可补齐）`
                : undefined,
            speed,
            voice: 'female'
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/create', async (req, res) => {
    try {
        const { title, title_en, description, category_id, difficulty_level, age_group, cover_url, cover_prompt, is_free } = req.body;
        if (!title) return res.status(400).json({ success: false, message: '标题不能为空' });

        const result = await query(
            'INSERT INTO picture_books (title, title_en, description, category_id, difficulty_level, age_group, cover_url, cover_prompt, is_free) VALUES (?,?,?,?,?,?,?,?,?)',
            [title, title_en || '', description || '', category_id || 0, difficulty_level || 1, age_group || null, cover_url || null, cover_prompt || null, is_free !== undefined ? is_free : 1]
        );
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/:id', async (req, res) => {
    try {
        const { title, title_en, description, category_id, difficulty_level, age_group, cover_url, cover_prompt, is_free, is_active, sort_order } = req.body;
        await query(
            `UPDATE picture_books SET title=?, title_en=?, description=?, category_id=?, difficulty_level=?, age_group=?, cover_url=?, cover_prompt=?, is_free=?, is_active=?, sort_order=? WHERE id=?`,
            [title, title_en || '', description || '', category_id || 0, difficulty_level || 1, age_group || null, cover_url || null,
             cover_prompt || null, is_free !== undefined ? is_free : 1, is_active !== undefined ? is_active : 1, sort_order || 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/api/:id/cover-prompt', async (req, res) => {
    try {
        const coverPrompt = String(req.body?.cover_prompt || '').trim();
        const pages = await getBookPagesForPrompt(req.params.id);
        const book = await getBookPromptContext(req.params.id);
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });

        const sourceText = buildCoverSourceText(book, pages);
        await query(
            'UPDATE picture_books SET cover_prompt = ?, cover_prompt_source_text = ?, cover_prompt_mode = ? WHERE id = ?',
            [coverPrompt || null, sourceText || null, 'manual', req.params.id]
        );

        const payload = await buildCoverPromptPayload(req.params.id);
        res.json({
            success: true,
            cover_prompt: payload.cover_prompt || '',
            cover_prompt_mode: payload.cover_prompt_mode || 'manual',
            cover_prompt_sync_status: payload.cover_prompt_sync_status,
            cover_prompt_needs_sync: payload.cover_prompt_needs_sync
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/:id/cover-prompt-status', async (req, res) => {
    try {
        const payload = await buildCoverPromptPayload(req.params.id);
        if (!payload) return res.status(404).json({ success: false, message: '绘本不存在' });
        res.json({
            success: true,
            data: {
                cover_prompt: payload.cover_prompt || '',
                cover_prompt_mode: payload.cover_prompt_mode || 'auto',
                cover_prompt_sync_status: payload.cover_prompt_sync_status,
                cover_prompt_needs_sync: payload.cover_prompt_needs_sync
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/:id/rebuild-cover-prompt', async (req, res) => {
    try {
        const book = await getBookPromptContext(req.params.id);
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });
        const pages = await getBookPagesForPrompt(req.params.id);
        const prompt = buildPictureBookCoverPrompt(book, pages);
        const sourceText = buildCoverSourceText(book, pages);

        await query(
            'UPDATE picture_books SET cover_prompt = ?, cover_prompt_source_text = ?, cover_prompt_mode = ? WHERE id = ?',
            [prompt, sourceText, 'auto', req.params.id]
        );

        const payload = await buildCoverPromptPayload(req.params.id);
        res.json({
            success: true,
            data: {
                cover_prompt: payload.cover_prompt || '',
                cover_prompt_mode: payload.cover_prompt_mode || 'auto',
                cover_prompt_sync_status: payload.cover_prompt_sync_status,
                cover_prompt_needs_sync: payload.cover_prompt_needs_sync
            }
        });
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
        const book = await getBookPromptContext(req.params.id);
        const pages = await query(
            'SELECT * FROM picture_book_pages WHERE book_id = ? ORDER BY sort_order ASC, page_number ASC',
            [req.params.id]
        );
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        const processed = pages.map(p => buildPageApiPayload(p, book, baseUrl));
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
        const { text_en, text_cn, image_url, image_prompt, audio_url, audio_url_male } = req.body;
        const book = await getBookPromptContext(req.params.id);
        const [existingPage] = await query(
            'SELECT id, text_en, image_prompt, image_prompt_source_text, image_prompt_mode, page_number FROM picture_book_pages WHERE id = ? AND book_id = ?',
            [req.params.pageId, req.params.id]
        );
        if (!existingPage) return res.status(404).json({ success: false, message: '页面不存在' });

        const fields = [];
        const params = [];

        if (text_en !== undefined) { fields.push('text_en=?'); params.push(text_en); }
        if (text_cn !== undefined) { fields.push('text_cn=?'); params.push(text_cn); }
        if (image_url !== undefined) { fields.push('image_url=?'); params.push(image_url); }
        if (audio_url !== undefined) { fields.push('audio_url=?'); params.push(audio_url); }
        if (audio_url_male !== undefined) { fields.push('audio_url_male=?'); params.push(audio_url_male); }

        if (image_prompt !== undefined) {
            const promptText = normalizePromptBookTitleToEnglish(
                image_prompt,
                book?.title || '',
                book?.title_en || ''
            );
            const effectiveTextEn = text_en !== undefined ? text_en : existingPage.text_en;
            fields.push('image_prompt=?');
            params.push(promptText);
            fields.push('image_prompt_source_text=?');
            params.push(normalizeComparableText(effectiveTextEn || ''));
            fields.push('image_prompt_mode=?');
            params.push('manual');
        }

        if (fields.length === 0) return res.json({ success: true, message: '无更新' });

        params.push(req.params.pageId, req.params.id);
        await query(`UPDATE picture_book_pages SET ${fields.join(',')} WHERE id=? AND book_id=?`, params);
        const [updatedPage] = await query('SELECT * FROM picture_book_pages WHERE id = ? AND book_id = ?', [req.params.pageId, req.params.id]);
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        res.json({ success: true, data: buildPageApiPayload(updatedPage, book, baseUrl) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/:id/pages/:pageId/rebuild-prompt', async (req, res) => {
    try {
        const book = await getBookPromptContext(req.params.id);
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });

        const [page] = await query(
            'SELECT * FROM picture_book_pages WHERE id = ? AND book_id = ?',
            [req.params.pageId, req.params.id]
        );
        if (!page) return res.status(404).json({ success: false, message: '页面不存在' });
        if (!normalizeComparableText(page.text_en)) {
            return res.status(400).json({ success: false, message: '请先填写本页英文文本，再重建图片提示词' });
        }

        const prompt = buildPictureBookPagePrompt(book, page);
        await query(
            `UPDATE picture_book_pages
                SET image_prompt = ?, image_prompt_source_text = ?, image_prompt_mode = 'auto'
              WHERE id = ? AND book_id = ?`,
            [prompt, normalizeComparableText(page.text_en), req.params.pageId, req.params.id]
        );

        const [updatedPage] = await query('SELECT * FROM picture_book_pages WHERE id = ? AND book_id = ?', [req.params.pageId, req.params.id]);
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        res.json({ success: true, data: buildPageApiPayload(updatedPage, book, baseUrl) });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/:id/rebuild-page-prompts', async (req, res) => {
    try {
        const book = await getBookPromptContext(req.params.id);
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });

        const pages = await query(
            'SELECT * FROM picture_book_pages WHERE book_id = ? ORDER BY sort_order ASC, page_number ASC',
            [req.params.id]
        );

        let updated = 0;
        let skipped = 0;
        for (const page of pages) {
            if (!normalizeComparableText(page.text_en)) {
                skipped++;
                continue;
            }
            const prompt = buildPictureBookPagePrompt(book, page);
            await query(
                `UPDATE picture_book_pages
                    SET image_prompt = ?, image_prompt_source_text = ?, image_prompt_mode = 'auto'
                  WHERE id = ? AND book_id = ?`,
                [prompt, normalizeComparableText(page.text_en), page.id, req.params.id]
            );
            updated++;
        }

        res.json({ success: true, updated, skipped });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// AI 生成内容页图片（按页面提示词）
router.post('/api/:id/pages/:pageId/generate-image', async (req, res) => {
    try {
        const bookId = req.params.id;
        const pageId = req.params.pageId;
        const inputPrompt = String(req.body?.prompt || '').trim();
        const book = await getBookPromptContext(bookId);

        const [page] = await query(
            'SELECT id, image_prompt FROM picture_book_pages WHERE id = ? AND book_id = ?',
            [pageId, bookId]
        );
        if (!page) return res.status(404).json({ success: false, message: '页面不存在' });

        const finalPromptRaw = inputPrompt || String(page.image_prompt || '').trim();
        const finalPrompt = normalizePromptBookTitleToEnglish(finalPromptRaw, book?.title || '', book?.title_en || '');
        if (!finalPrompt) {
            return res.status(400).json({ success: false, message: '请先填写页面图片AI提示词' });
        }

        const result = await aiService.generateImage(finalPrompt);
        if (!result.success || !result.imageUrl) {
            return res.status(500).json({ success: false, message: result.error || '生成失败' });
        }

        await query(
            'UPDATE picture_book_pages SET image_url = ?, image_prompt = ? WHERE id = ? AND book_id = ?',
            [result.imageUrl, finalPrompt, pageId, bookId]
        );
        const [updatedPage] = await query('SELECT * FROM picture_book_pages WHERE id = ? AND book_id = ?', [pageId, bookId]);
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        res.json({
            success: true,
            imageUrl: result.imageUrl,
            image_prompt: finalPrompt,
            data: buildPageApiPayload(updatedPage, book, baseUrl)
        });
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

        const speed = voiceService.getGoogleTtsSpeed('picture_book');
        const result = await voiceService.googleTextToSpeech(page.text_en, 'female', speed);
        if (result.success && result.audioUrl) {
            await query('UPDATE picture_book_pages SET audio_url = ? WHERE id = ?', [result.audioUrl, page.id]);

            const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
            const fullUrl = result.audioUrl.startsWith('http') ? result.audioUrl : baseUrl + result.audioUrl;
            return res.json({ success: true, audio_url: fullUrl, voice: 'female', speed, engine: result.engine || 'google' });
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
                const hotspotSpeed = voiceService.getGoogleTtsSpeed('picture_book');
                const femaleResult = await voiceService.googleTextToSpeech(text, 'female', hotspotSpeed);
                if (femaleResult.success) audioFemale = femaleResult.audioUrl;
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
        const inputPrompt = String(req.body?.prompt || '').trim();
        const book = await getBookPromptContext(req.params.id);
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });
        const pages = await getBookPagesForPrompt(req.params.id);
        const generatedPrompt = buildPictureBookCoverPrompt(book, pages);
        const finalPromptRaw = inputPrompt || String(book.cover_prompt || '').trim() || generatedPrompt;
        const normalizedPrompt = normalizePromptBookTitleToEnglish(finalPromptRaw, book?.title || '', book?.title_en || '');
        if (!normalizedPrompt) return res.status(400).json({ success: false, message: '请先填写或重建封面提示词' });
        const result = await aiService.generateImage(normalizedPrompt);
        if (result.success) {
            const sourceText = buildCoverSourceText(book, pages);
            const mode = inputPrompt ? 'manual' : (book.cover_prompt_mode || 'auto');
            await query(
                'UPDATE picture_books SET cover_url = ?, cover_prompt = ?, cover_prompt_source_text = ?, cover_prompt_mode = ? WHERE id = ?',
                [result.imageUrl, normalizedPrompt, sourceText, mode, req.params.id]
            );
            const payload = await buildCoverPromptPayload(req.params.id);
            res.json({
                success: true,
                imageUrl: result.imageUrl,
                data: {
                    cover_url: result.imageUrl,
                    cover_prompt: payload.cover_prompt || normalizedPrompt,
                    cover_prompt_mode: payload.cover_prompt_mode || mode,
                    cover_prompt_sync_status: payload.cover_prompt_sync_status,
                    cover_prompt_needs_sync: payload.cover_prompt_needs_sync
                }
            });
        } else {
            res.status(500).json({ success: false, message: result.error || '生成失败' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== 批量词汇分析页面 =====

router.get('/batch-vocab', (req, res) => {
    res.render('picturebooks/batch-vocab', { page: 'pb-batch-vocab', title: '绘本批量词汇分析', user: req.session.adminUser });
});

// 获取待分析候选列表
router.get('/api/batch/vocab-candidates', async (req, res) => {
    try {
        const { category_id, mode = 'missing' } = req.query;
        let sql = `
            SELECT b.id, b.title, b.title_en, b.cover_url, b.category_id,
                   c.name AS category_name,
                   COUNT(p.id) AS total_text_pages,
                   SUM(CASE WHEN p.text_en IS NOT NULL AND TRIM(p.text_en) <> '' AND (p.words_data IS NULL OR p.words_data = '') THEN 1 ELSE 0 END) AS missing_vocab_pages,
                   SUM(CASE WHEN p.text_en IS NOT NULL AND TRIM(p.text_en) <> '' AND p.words_data IS NOT NULL AND p.words_data <> '' THEN 1 ELSE 0 END) AS done_vocab_pages
              FROM picture_books b
         LEFT JOIN picture_book_pages p ON p.book_id = b.id AND p.text_en IS NOT NULL AND TRIM(p.text_en) <> ''
         LEFT JOIN picture_book_categories c ON b.category_id = c.id
             WHERE 1=1`;
        const params = [];
        if (category_id) {
            sql += ' AND b.category_id = ?';
            params.push(parseInt(category_id, 10));
        }
        sql += ' GROUP BY b.id, b.title, b.title_en, b.cover_url, b.category_id, c.name';
        if (mode === 'all') {
            sql += ' HAVING total_text_pages > 0';
        } else {
            sql += ' HAVING missing_vocab_pages > 0';
        }
        sql += ' ORDER BY missing_vocab_pages DESC, b.id ASC';
        const books = await query(sql, params);
        res.json({ success: true, data: books });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 单本绘本词汇分析
router.post('/api/:id/analyze-vocab', async (req, res) => {
    try {
        const bookId = parseInt(req.params.id, 10);
        const mode = req.body?.mode === 'all' ? 'all' : 'missing';

        const [book] = await query('SELECT id, title FROM picture_books WHERE id = ?', [bookId]);
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });

        const pages = await query(
            `SELECT id, page_number, text_en, words_data
               FROM picture_book_pages
              WHERE book_id = ? AND text_en IS NOT NULL AND TRIM(text_en) <> ''
              ORDER BY page_number ASC`,
            [bookId]
        );

        const targetPages = pages.filter(p => mode === 'all' || !p.words_data);
        if (targetPages.length === 0) {
            return res.json({ success: true, analyzed: 0, total: pages.length, message: '无需分析' });
        }

        const proxyUrl = process.env.PROXY_BASE_URL;
        const proxyKey = process.env.PROXY_API_KEY;
        if (!proxyUrl) return res.status(500).json({ success: false, message: '未配置 PROXY_BASE_URL' });

        let analyzed = 0;
        const failedPages = [];

        for (let i = 0; i < targetPages.length; i++) {
            const page = targetPages[i];
            if (i > 0) await new Promise(r => setTimeout(r, 1500));

            try {
                // 1. AI 分析全部单词
                const resp = await axios.post(
                    `${proxyUrl}/proxy/analyze-picturebook-words`,
                    { text: page.text_en },
                    { headers: { 'Content-Type': 'application/json', 'X-Proxy-Key': proxyKey || '' }, timeout: 60000 }
                );
                if (!resp.data.success || !Array.isArray(resp.data.words)) {
                    throw new Error(resp.data.error || 'AI 分析失败');
                }

                const words = resp.data.words;

                // 2. 复用 words 表已有音频/音标（快速 DB 查询，不生成新 TTS）
                for (const w of words) {
                    const [wRow] = await query(
                        'SELECT audio_url_female, audio_url_male, phonetic FROM words WHERE LOWER(word) = LOWER(?) LIMIT 1',
                        [w.word]
                    );
                    if (wRow) {
                        w.audio_url = wRow.audio_url_female || wRow.audio_url_male || null;
                        if (!w.phonetic && wRow.phonetic) w.phonetic = wRow.phonetic;
                    }
                }

                // 3. 保存
                await query('UPDATE picture_book_pages SET words_data = ? WHERE id = ?', [JSON.stringify({ words }), page.id]);
                analyzed++;
            } catch (err) {
                failedPages.push({ page_number: page.page_number, error: err.message || '分析失败' });
            }
        }

        const allFailed = analyzed === 0 && failedPages.length > 0;
        if (allFailed) {
            return res.status(500).json({
                success: false,
                message: `${book.title} 全部 ${failedPages.length} 页分析失败`,
                analyzed, total: targetPages.length, failed_pages: failedPages
            });
        }

        res.json({
            success: true, analyzed, total: targetPages.length, failed_pages: failedPages,
            message: failedPages.length > 0
                ? `${book.title} 完成 ${analyzed}/${targetPages.length} 页，${failedPages.length} 页失败`
                : undefined
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
