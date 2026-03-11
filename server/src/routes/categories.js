const express = require('express');
const { query } = require('../config/database');
const { authMiddleware, optionalAuth } = require('../middlewares/auth');

const router = express.Router();

// 获取分类列表
router.get('/', async (req, res) => {
    try {
        const { parent_id } = req.query;

        let sql = 'SELECT * FROM word_categories WHERE 1=1';
        const params = [];

        if (parent_id !== undefined) {
            sql += ' AND parent_id = ?';
            params.push(parseInt(parent_id) || 0);
        }

        sql += ' ORDER BY sort_order ASC, id ASC';

        const categories = await query(sql, params);

        res.json({
            success: true,
            data: categories
        });
    } catch (error) {
        console.error('获取分类错误:', error);
        res.status(500).json({
            success: false,
            message: '获取分类失败'
        });
    }
});

// 获取分类树
router.get('/tree', async (req, res) => {
    try {
        const categories = await query('SELECT * FROM word_categories ORDER BY sort_order ASC, id ASC');

        // 构建树形结构
        const buildTree = (items, parentId = 0) => {
            return items
                .filter(item => item.parent_id === parentId)
                .map(item => ({
                    ...item,
                    children: buildTree(items, item.id)
                }));
        };

        const tree = buildTree(categories);

        res.json({
            success: true,
            data: tree
        });
    } catch (error) {
        console.error('获取分类树错误:', error);
        res.status(500).json({
            success: false,
            message: '获取分类树失败'
        });
    }
});

// 获取单个分类
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const categories = await query('SELECT * FROM word_categories WHERE id = ?', [id]);

        if (categories.length === 0) {
            return res.status(404).json({
                success: false,
                message: '分类不存在'
            });
        }

        res.json({
            success: true,
            data: categories[0]
        });
    } catch (error) {
        console.error('获取分类错误:', error);
        res.status(500).json({
            success: false,
            message: '获取分类失败'
        });
    }
});

module.exports = router;
