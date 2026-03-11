const express = require('express');
const { query } = require('../config/database');
const { optionalAuth } = require('../middlewares/auth');

const router = express.Router();

// 获取场景分类列表 (扁平结构)
router.get('/', optionalAuth, async (req, res) => {
    try {
        const categories = await query(
            'SELECT * FROM scene_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
        );

        res.json({
            success: true,
            data: categories
        });
    } catch (error) {
        console.error('获取场景分类失败:', error);
        res.status(500).json({
            success: false,
            message: '获取分类失败'
        });
    }
});

module.exports = router;
