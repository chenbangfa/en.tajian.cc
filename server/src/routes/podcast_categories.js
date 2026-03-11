const express = require('express');
const { query } = require('../config/database');
const router = express.Router();

// Get all active podcast categories (Flat list, client handles hierarchy)
router.get('/', async (req, res) => {
    try {
        const categories = await query(
            'SELECT * FROM podcast_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
        );

        res.json({
            success: true,
            data: categories
        });
    } catch (error) {
        console.error('获取播客分类失败:', error);
        res.status(500).json({
            success: false,
            message: '获取分类失败'
        });
    }
});

module.exports = router;
