const express = require('express');
const { query } = require('../config/database');
const { authMiddleware, optionalAuth } = require('../middlewares/auth');

const router = express.Router();

// 获取播客内容列表
router.get('/', optionalAuth, async (req, res) => {
    try {
        const { category_id, difficulty, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let sql = `
            SELECT 
                t.id, t.title, t.title_en, t.category_id, 
                pc.name_en as category_name_en,
                t.difficulty_level, t.duration_seconds, t.is_free, t.sort_order 
            FROM podcast_contents t
            LEFT JOIN podcast_categories pc ON t.category_id = pc.id
            WHERE 1=1
        `;

        let countSql = `
            SELECT COUNT(*) as total 
            FROM podcast_contents t
            LEFT JOIN podcast_categories pc ON t.category_id = pc.id
            WHERE 1=1
        `;

        const params = [];
        const countParams = [];

        if (category_id) {
            // Support filtering by specific Category ID OR via Parent Category ID
            // If category_id is a Parent, pc.parent_id will match
            sql += ' AND (t.category_id = ? OR pc.parent_id = ?)';
            countSql += ' AND (t.category_id = ? OR pc.parent_id = ?)';
            params.push(category_id, category_id);
            countParams.push(category_id, category_id);
        }

        if (difficulty) {
            sql += ' AND t.difficulty_level = ?';
            countSql += ' AND t.difficulty_level = ?';
            params.push(parseInt(difficulty));
            countParams.push(parseInt(difficulty));
        }

        // 非VIP用户只显示免费内容
        if (!req.user || req.user.vip_level === 0) {
            sql += ' AND t.is_free = 1';
            countSql += ' AND t.is_free = 1';
        }

        sql += ' ORDER BY t.sort_order ASC, t.id ASC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const [contents, countResult] = await Promise.all([
            query(sql, params),
            query(countSql, countParams)
        ]);

        res.json({
            success: true,
            data: {
                list: contents,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countResult[0].total
                }
            }
        });
    } catch (error) {
        console.error('获取播客列表错误:', error);
        res.status(500).json({
            success: false,
            message: '获取播客列表失败'
        });
    }
});

// 获取播客内容详情
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const contents = await query('SELECT * FROM podcast_contents WHERE id = ?', [id]);

        if (contents.length === 0) {
            return res.status(404).json({
                success: false,
                message: '内容不存在'
            });
        }

        const content = contents[0];

        // 解析 sentences_data JSON
        if (content.sentences_data && content.sentences_data !== 'processing') {
            try { content.sentences_data = JSON.parse(content.sentences_data); }
            catch (e) { content.sentences_data = null; }
        } else if (content.sentences_data === 'processing') {
            content.sentences_data = { processing: true };
        }

        // 检查访问权限
        if (!content.is_free) {
            if (!req.user || req.user.vip_level === 0) {
                return res.status(403).json({
                    success: false,
                    message: '此内容需要VIP会员'
                });
            }
        }

        // 更新播放进度
        if (req.user) {
            await query(`
        INSERT INTO podcast_progress (user_id, content_id, play_count, last_played_at)
        VALUES (?, ?, 1, NOW())
        ON DUPLICATE KEY UPDATE 
          play_count = play_count + 1,
          last_played_at = NOW()
      `, [req.user.id, id]);
        }

        res.json({
            success: true,
            data: content
        });
    } catch (error) {
        console.error('获取播客详情错误:', error);
        res.status(500).json({
            success: false,
            message: '获取播客详情失败'
        });
    }
});

// 更新播放进度
router.put('/progress/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { current_position } = req.body;

        await query(`
      INSERT INTO podcast_progress (user_id, content_id, current_position, last_played_at)
      VALUES (?, ?, ?, NOW())
      ON DUPLICATE KEY UPDATE 
        current_position = ?,
        last_played_at = NOW()
    `, [req.user.id, id, current_position, current_position]);

        res.json({
            success: true,
            message: '进度已保存'
        });
    } catch (error) {
        console.error('更新播放进度错误:', error);
        res.status(500).json({
            success: false,
            message: '更新播放进度失败'
        });
    }
});

// 获取分类列表
router.get('/meta/categories', async (req, res) => {
    try {
        const categories = [
            { value: 'daily_phrases', label: '日常短语' },
            { value: 'scene_dialogues', label: '场景对话' },
            { value: 'stories', label: '英语故事' },
            { value: 'songs', label: '英文儿歌' }
        ];

        res.json({
            success: true,
            data: categories
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: '获取分类失败'
        });
    }
});

module.exports = router;
