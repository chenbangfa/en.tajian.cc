const express = require('express');
const { query } = require('../config/database');
const { authMiddleware, optionalAuth } = require('../middlewares/auth');

const router = express.Router();

// ===== 初始化表结构 =====
(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS picture_book_categories (
            id INT NOT NULL AUTO_INCREMENT,
            name VARCHAR(100) NOT NULL COMMENT '分类名称',
            name_en VARCHAR(100) DEFAULT NULL COMMENT '英文名称',
            icon VARCHAR(200) DEFAULT NULL COMMENT '分类图标URL',
            sort_order INT DEFAULT 0 COMMENT '排序',
            is_active TINYINT(1) DEFAULT 1 COMMENT '是否启用',
            created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本分类表'`);

        await query(`CREATE TABLE IF NOT EXISTS picture_books (
            id INT NOT NULL AUTO_INCREMENT,
            title VARCHAR(200) NOT NULL COMMENT '绘本标题',
            title_en VARCHAR(200) DEFAULT NULL COMMENT '英文标题',
            cover_url VARCHAR(500) DEFAULT NULL COMMENT '封面图URL',
            description TEXT DEFAULT NULL COMMENT '简介',
            category_id INT DEFAULT 0 COMMENT '分类ID',
            difficulty_level TINYINT DEFAULT 1 COMMENT '难度等级 1-5',
            age_group VARCHAR(20) DEFAULT NULL COMMENT '适合年龄段',
            page_count INT DEFAULT 0 COMMENT '总页数',
            is_free TINYINT(1) DEFAULT 1 COMMENT '是否免费',
            is_active TINYINT(1) DEFAULT 1 COMMENT '是否上架',
            sort_order INT DEFAULT 0 COMMENT '排序',
            read_count INT DEFAULT 0 COMMENT '阅读次数',
            created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_category (category_id),
            KEY idx_active_sort (is_active, sort_order)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本主表'`);

        await query(`CREATE TABLE IF NOT EXISTS picture_book_pages (
            id INT NOT NULL AUTO_INCREMENT,
            book_id INT NOT NULL COMMENT '绘本ID',
            page_number INT NOT NULL COMMENT '页码',
            image_url VARCHAR(500) DEFAULT NULL COMMENT '页面插图URL',
            text_en TEXT DEFAULT NULL COMMENT '英文文本',
            text_cn TEXT DEFAULT NULL COMMENT '中文翻译',
            audio_url VARCHAR(500) DEFAULT NULL COMMENT '朗读音频（女声）',
            audio_url_male VARCHAR(500) DEFAULT NULL COMMENT '朗读音频（男声）',
            sort_order INT DEFAULT 0 COMMENT '排序',
            created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_book_page (book_id, page_number)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本页面表'`);

        await query(`CREATE TABLE IF NOT EXISTS picture_book_hotspots (
            id INT NOT NULL AUTO_INCREMENT,
            page_id INT NOT NULL COMMENT '页面ID',
            book_id INT NOT NULL COMMENT '绘本ID',
            text_en VARCHAR(500) NOT NULL COMMENT '英文文本',
            translation VARCHAR(500) DEFAULT NULL COMMENT '中文翻译',
            phonetic VARCHAR(200) DEFAULT NULL COMMENT '音标',
            position_x DECIMAL(6,2) DEFAULT NULL COMMENT '热点X位置(%)',
            position_y DECIMAL(6,2) DEFAULT NULL COMMENT '热点Y位置(%)',
            width DECIMAL(6,2) DEFAULT NULL COMMENT '热点宽度(%)',
            height DECIMAL(6,2) DEFAULT NULL COMMENT '热点高度(%)',
            audio_url_female VARCHAR(500) DEFAULT NULL COMMENT '女声音频',
            audio_url_male VARCHAR(500) DEFAULT NULL COMMENT '男声音频',
            word_id INT DEFAULT NULL COMMENT '关联单词ID',
            sort_order INT DEFAULT 0 COMMENT '排序',
            created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            KEY idx_page (page_id),
            KEY idx_book (book_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本页面点读热点'`);

        await query(`CREATE TABLE IF NOT EXISTS picture_book_progress (
            id INT NOT NULL AUTO_INCREMENT,
            user_id INT NOT NULL,
            book_id INT NOT NULL,
            current_page INT DEFAULT 1 COMMENT '当前阅读到第几页',
            is_completed TINYINT(1) DEFAULT 0 COMMENT '是否读完',
            read_count INT DEFAULT 1 COMMENT '阅读次数',
            last_read_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uk_user_book (user_id, book_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户绘本阅读进度'`);

        console.log('[PictureBooks] 表结构初始化完成');
    } catch (e) {
        console.error('[PictureBooks] 表初始化失败:', e.message);
    }
})();

// ===== 公共 API（Phase 2 实现）=====

// 占位：获取分类列表
router.get('/categories', async (req, res) => {
    try {
        const categories = await query(
            'SELECT id, name, name_en, icon FROM picture_book_categories WHERE is_active = 1 ORDER BY sort_order ASC'
        );
        res.json({ success: true, data: categories });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 占位：获取绘本列表
router.get('/', async (req, res) => {
    try {
        const { category_id, page = 1, limit = 20 } = req.query;
        let sql = 'SELECT id, title, title_en, cover_url, difficulty_level, age_group, page_count, is_free FROM picture_books WHERE is_active = 1';
        const params = [];
        if (category_id) {
            sql += ' AND category_id = ?';
            params.push(parseInt(category_id));
        }
        sql += ' ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
        const books = await query(sql, params);
        res.json({ success: true, data: books });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
