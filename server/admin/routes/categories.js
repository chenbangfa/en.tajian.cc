const express = require('express');
const { query, transaction } = require('../../src/config/database');

const router = express.Router();

// 获取分类列表
router.get('/', async (req, res) => {
    try {
        const categories = await query('SELECT * FROM word_categories ORDER BY sort_order ASC, id ASC');
        res.json({ success: true, data: categories });
    } catch (error) {
        console.error('获取分类错误:', error);
        res.status(500).json({ success: false, message: '获取分类失败' });
    }
});

// 创建分类
router.post('/', async (req, res) => {
    try {
        const { name, name_en, parent_id = 0, icon, sort_order = 0 } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: '分类名称不能为空' });
        }

        const result = await query(
            'INSERT INTO word_categories (name, name_en, parent_id, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
            [name, name_en, parent_id, icon, sort_order]
        );

        res.json({
            success: true,
            data: { id: result.insertId },
            message: '创建成功'
        });
    } catch (error) {
        console.error('创建分类错误:', error);
        res.status(500).json({ success: false, message: '创建分类失败' });
    }
});

// 更新分类
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, name_en, parent_id, icon, sort_order } = req.body;

        await query(
            'UPDATE word_categories SET name = ?, name_en = ?, parent_id = ?, icon = ?, sort_order = ? WHERE id = ?',
            [name, name_en, parent_id, icon, sort_order, id]
        );

        res.json({ success: true, message: '更新成功' });
    } catch (error) {
        console.error('更新分类错误:', error);
        res.status(500).json({ success: false, message: '更新分类失败' });
    }
});

// 删除分类
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 检查是否有子分类
        const children = await query('SELECT COUNT(*) as count FROM word_categories WHERE parent_id = ?', [id]);
        if (children[0].count > 0) {
            return res.status(400).json({ success: false, message: '请先删除子分类' });
        }

        // 检查是否有关联单词
        const words = await query('SELECT COUNT(*) as count FROM words WHERE category_id = ?', [id]);
        if (words[0].count > 0) {
            return res.status(400).json({ success: false, message: '该分类下有单词，不能删除' });
        }

        await query('DELETE FROM word_categories WHERE id = ?', [id]);

        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        console.error('删除分类错误:', error);
        res.status(500).json({ success: false, message: '删除分类失败' });
    }
});

module.exports = router;
