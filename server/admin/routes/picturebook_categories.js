const express = require('express');
const router = express.Router();
const { query } = require('../../src/config/database');

// 页面路由
router.get('/', (req, res) => {
    res.render('picturebooks/categories', { page: 'pb-cat', title: '绘本分类', user: req.session.adminUser });
});

// 获取分类列表
router.get('/api/list', async (req, res) => {
    try {
        const categories = await query(
            'SELECT * FROM picture_book_categories ORDER BY sort_order ASC, id ASC'
        );
        res.json({ success: true, data: categories });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 创建分类
router.post('/api/create', async (req, res) => {
    try {
        const { name, name_en, icon, sort_order = 0 } = req.body;
        if (!name) return res.status(400).json({ success: false, message: '分类名称不能为空' });

        const result = await query(
            'INSERT INTO picture_book_categories (name, name_en, icon, sort_order) VALUES (?, ?, ?, ?)',
            [name, name_en || null, icon || null, sort_order]
        );
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 更新分类
router.put('/api/:id', async (req, res) => {
    try {
        const { name, name_en, icon, sort_order, is_active } = req.body;
        await query(
            'UPDATE picture_book_categories SET name=?, name_en=?, icon=?, sort_order=?, is_active=? WHERE id=?',
            [name, name_en || null, icon || null, sort_order || 0, is_active !== undefined ? is_active : 1, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 删除分类
router.delete('/api/:id', async (req, res) => {
    try {
        const books = await query('SELECT COUNT(*) as count FROM picture_books WHERE category_id = ?', [req.params.id]);
        if (books[0].count > 0) {
            return res.status(400).json({ success: false, message: '该分类下有绘本，无法删除' });
        }
        await query('DELETE FROM picture_book_categories WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 批量排序
router.put('/api/reorder', async (req, res) => {
    try {
        const { items } = req.body;
        if (!items || !Array.isArray(items)) return res.status(400).json({ success: false, message: '无效数据' });

        for (let i = 0; i < items.length; i++) {
            await query('UPDATE picture_book_categories SET sort_order = ? WHERE id = ?', [i, items[i]]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
