const express = require('express');
const router = express.Router();
const { query } = require('../../src/config/database');
const { getPodcastCategorySnapshot } = require('../utils/podcast-category-tree');

// 获取分类树
router.get('/', async (req, res) => {
    try {
        const snapshot = await getPodcastCategorySnapshot(query);
        res.json({
            success: true,
            data: snapshot
        });
    } catch (error) {
        console.error('获取播客分类失败:', error);
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

        await query(
            'INSERT INTO podcast_categories (name, name_en, parent_id, icon, sort_order) VALUES (?, ?, ?, ?, ?)',
            [name, name_en, parent_id, icon, sort_order]
        );

        res.json({ success: true, message: '创建成功' });
    } catch (error) {
        console.error('创建播客分类失败:', error);
        res.status(500).json({ success: false, message: '创建失败' });
    }
});

// 更新分类
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, name_en, parent_id, icon, sort_order, is_active } = req.body;

        await query(
            'UPDATE podcast_categories SET name=?, name_en=?, parent_id=?, icon=?, sort_order=?, is_active=? WHERE id=?',
            [name, name_en, parent_id, icon, sort_order, is_active, id]
        );

        res.json({ success: true, message: '更新成功' });
    } catch (error) {
        console.error('更新播客分类失败:', error);
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 删除分类
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 检查是否有子分类
        const children = await query('SELECT COUNT(*) as count FROM podcast_categories WHERE parent_id = ?', [id]);
        if (children[0].count > 0) {
            return res.status(400).json({ success: false, message: '请先删除子分类' });
        }

        // 检查是否有关联内容
        const contents = await query('SELECT COUNT(*) as count FROM podcast_contents WHERE category_id = ?', [id]);
        if (contents[0].count > 0) {
            return res.status(400).json({ success: false, message: '该分类下有播客内容，无法删除' });
        }

        await query('DELETE FROM podcast_categories WHERE id = ?', [id]);
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        console.error('删除播客分类失败:', error);
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

module.exports = router;
