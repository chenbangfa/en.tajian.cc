const express = require('express');
const { query } = require('../config/database');
const { authMiddleware, optionalAuth } = require('../middlewares/auth');
const voiceService = require('../services/voice.service');
const rewardService = require('../services/reward.service');
const { ensurePictureBookPromptColumns } = require('../services/picturebookPrompt.service');
const {
    decoratePictureBook,
    matchesFilter,
    getV1ThemeOptions
} = require('../utils/picturebook-reader-meta');

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
            cover_prompt TEXT DEFAULT NULL COMMENT '封面图AI提示词',
            cover_prompt_source_text TEXT DEFAULT NULL COMMENT '封面提示词对应的整本内容快照',
            cover_prompt_mode VARCHAR(20) DEFAULT 'auto' COMMENT '封面提示词模式 auto/manual',
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
            image_prompt TEXT DEFAULT NULL COMMENT '页面插图AI提示词',
            image_prompt_source_text TEXT DEFAULT NULL COMMENT '图片提示词对应的英文正文快照',
            image_prompt_mode VARCHAR(20) DEFAULT 'auto' COMMENT '页面图片提示词模式 auto/manual',
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

        await ensurePictureBookPromptColumns(query);

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

router.get('/filters', async (req, res) => {
    try {
        res.json({
            success: true,
            data: {
                stages: [
                    { id: 'all', name: '全部' },
                    { id: 'v1', name: 'V1 启蒙' },
                    { id: 'v2', name: 'V2 进阶' },
                    { id: 'v3', name: 'V3 主题' }
                ],
                reader_levels: [
                    { id: '', name: '全部等级' },
                    { id: 'L0', name: 'L0' },
                    { id: 'L1', name: 'L1' },
                    { id: 'L2', name: 'L2' }
                ],
                age_groups: [
                    { id: '', name: '全部年龄' },
                    { id: '3-4', name: '3-4岁' },
                    { id: '4-5', name: '4-5岁' },
                    { id: '5-6', name: '5-6岁' }
                ],
                themes: getV1ThemeOptions()
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 占位：获取绘本列表
router.get('/', async (req, res) => {
    try {
        const {
            category_id,
            keyword = '',
            reader_stage = 'all',
            reader_level = '',
            age_group = '',
            display_theme = '',
            page = 1,
            limit = 20
        } = req.query;

        let sql = 'SELECT id, title, title_en, cover_url, category_id, difficulty_level, age_group, page_count, is_free, sort_order FROM picture_books WHERE is_active = 1';
        const params = [];
        if (keyword) {
            sql += ' AND (title LIKE ? OR title_en LIKE ?)';
            params.push(`%${keyword}%`, `%${keyword}%`);
        }
        sql += ' ORDER BY sort_order ASC, id DESC';

        const rows = await query(sql, params);
        const decorated = rows.map(decoratePictureBook);
        const filtered = decorated.filter((book) =>
            matchesFilter(book, {
                categoryId: category_id ? parseInt(category_id) : 0,
                readerStage: reader_stage,
                readerLevel: reader_level,
                ageGroup: age_group,
                displayTheme: display_theme
            })
        );

        const pageNum = parseInt(page) || 1;
        const pageSize = parseInt(limit) || 20;
        const total = filtered.length;
        const paged = filtered.slice((pageNum - 1) * pageSize, pageNum * pageSize);

        res.json({
            success: true,
            data: paged,
            pagination: {
                page: pageNum,
                limit: pageSize,
                total
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 获取绘本详情（含所有页面+热点）
router.get('/:id', async (req, res) => {
    try {
        const bookId = parseInt(req.params.id);
        const [book] = await query(
            'SELECT id, title, title_en, cover_url, description, category_id, difficulty_level, age_group, page_count, is_free FROM picture_books WHERE id = ? AND is_active = 1',
            [bookId]
        );
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });

        const pages = await query(
            'SELECT id, page_number, image_url, text_en, text_cn, audio_url, audio_url_male, words_data FROM picture_book_pages WHERE book_id = ? ORDER BY page_number ASC',
            [bookId]
        );

        const hotspots = await query(
            'SELECT id, page_id, text_en, translation, phonetic, position_x, position_y, width, height, audio_url_female, audio_url_male, sort_order FROM picture_book_hotspots WHERE book_id = ? ORDER BY sort_order ASC',
            [bookId]
        );

        // 将热点嵌入对应页面
        const hotspotMap = {};
        for (const h of hotspots) {
            if (!hotspotMap[h.page_id]) hotspotMap[h.page_id] = [];
            hotspotMap[h.page_id].push(h);
        }
        const pagesWithHotspots = pages.map(p => {
            let wordsData = null;
            if (p.words_data) {
                try { wordsData = typeof p.words_data === 'string' ? JSON.parse(p.words_data) : p.words_data; } catch (e) {}
            }
            return {
                ...p,
                words_data: wordsData,
                hotspots: hotspotMap[p.id] || []
            };
        });

        // 增加阅读次数
        await query('UPDATE picture_books SET read_count = read_count + 1 WHERE id = ?', [bookId]);

        res.json({ success: true, data: { book, pages: pagesWithHotspots } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 保存阅读进度
router.post('/:id/progress', authMiddleware, async (req, res) => {
    try {
        const bookId = parseInt(req.params.id);
        const userId = req.user.id;
        const { current_page, is_completed } = req.body;

        await query(
            `INSERT INTO picture_book_progress (user_id, book_id, current_page, is_completed)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                current_page = VALUES(current_page),
                is_completed = VALUES(is_completed),
                read_count = read_count + IF(VALUES(is_completed) = 1, 1, 0)`,
            [userId, bookId, current_page || 1, is_completed ? 1 : 0]
        );

        // ── 成长花园：绘本阅读完成奖励 ──
        if (is_completed) {
            try {
                await rewardService.checkAndReward(userId, 'book_complete', {});
            } catch (e) {
                console.error('[Reward] 绘本奖励发放失败:', e.message);
            }
        }

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 为热点生成TTS
router.post('/hotspots/:id/tts', authMiddleware, async (req, res) => {
    try {
        const hotspotId = parseInt(req.params.id);
        const [hotspot] = await query(
            'SELECT id, text_en, audio_url_female, audio_url_male FROM picture_book_hotspots WHERE id = ?',
            [hotspotId]
        );
        if (!hotspot) return res.status(404).json({ success: false, message: '热点不存在' });

        // 已有女声音频直接返回
        if (hotspot.audio_url_female) {
            return res.json({
                success: true,
                data: { audio_url_female: hotspot.audio_url_female, audio_url_male: hotspot.audio_url_male }
            });
        }

        const text = hotspot.text_en;

        // 先查 words 表复用已有音频
        const [wordRow] = await query(
            'SELECT audio_url_male, audio_url_female FROM words WHERE LOWER(word) = LOWER(?) AND audio_url_female IS NOT NULL LIMIT 1',
            [text]
        );

        let audioFemale = hotspot.audio_url_female;
        let audioMale = hotspot.audio_url_male;

        if (wordRow && wordRow.audio_url_female) {
            audioFemale = audioFemale || wordRow.audio_url_female;
            audioMale = audioMale || wordRow.audio_url_male;
        }

        // 缺失的女声音频用 Google 代理生成
        if (!audioFemale) {
            const hotspotSpeed = voiceService.getGoogleTtsSpeed('picture_book');
            const result = await voiceService.googleTextToSpeech(text, 'female', hotspotSpeed);
            if (result.success) {
                audioFemale = result.audioUrl;
            }
        }

        // 更新数据库
        await query(
            'UPDATE picture_book_hotspots SET audio_url_female = ?, audio_url_male = ? WHERE id = ?',
            [audioFemale, audioMale, hotspotId]
        );

        res.json({
            success: true,
            data: { audio_url_female: audioFemale, audio_url_male: audioMale }
        });
    } catch (e) {
        console.error('[PictureBooks] TTS生成失败:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
