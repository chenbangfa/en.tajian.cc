const express = require('express');
const { query } = require('../config/database');
const { authMiddleware, optionalAuth } = require('../middlewares/auth');
const voiceService = require('../services/voice.service');

const router = express.Router();

// ===== 初始化表结构 =====
(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS dialogue_categories (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(50) NOT NULL,
            icon_emoji VARCHAR(10) DEFAULT '💬',
            sort_order INT DEFAULT 0,
            is_active TINYINT DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS dialogue_scenes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(100) NOT NULL,
            title_en VARCHAR(100),
            description TEXT COMMENT '中文情境描述',
            description_en TEXT COMMENT '英文情境描述',
            cover_image VARCHAR(500),
            category_id INT DEFAULT NULL,
            difficulty TINYINT DEFAULT 1 COMMENT '1=入门 2=进阶 3=挑战',
            guide_role VARCHAR(50) DEFAULT '服务员' COMMENT '对方角色',
            user_role VARCHAR(50) DEFAULT '顾客' COMMENT '用户角色',
            is_vip TINYINT DEFAULT 0,
            is_active TINYINT DEFAULT 1,
            sort_order INT DEFAULT 0,
            line_count INT DEFAULT 0 COMMENT '台词条数缓存',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS dialogue_lines (
            id INT AUTO_INCREMENT PRIMARY KEY,
            scene_id INT NOT NULL,
            role ENUM('guide','user') NOT NULL COMMENT 'guide=对方 user=学生',
            line_en VARCHAR(500) NOT NULL,
            line_cn VARCHAR(300),
            audio_url VARCHAR(500) COMMENT 'guide角色TTS音频',
            sort_order INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_scene (scene_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        console.log('[Dialogue] 表结构初始化完成');
    } catch (e) {
        console.error('[Dialogue] 表初始化失败:', e.message);
    }
})();

// ===== 工具：判断用户是否 VIP =====
function isUserVip(user) {
    if (!user) return false;
    if (!user.vip_level || user.vip_level <= 0) return false;
    if (user.vip_expire_date && new Date(user.vip_expire_date) < new Date()) return false;
    return true;
}

// ===== GET /dialogue/categories =====
router.get('/categories', async (req, res) => {
    try {
        const categories = await query(
            'SELECT * FROM dialogue_categories WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
        );
        res.json({ success: true, data: categories });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== GET /dialogue/scenes =====
router.get('/scenes', optionalAuth, async (req, res) => {
    try {
        const { category_id, group_name = '', page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        let sql = `SELECT s.id,s.title,s.title_en,s.description,s.cover_image,s.category_id,s.difficulty,s.guide_role,s.user_role,s.is_vip,s.line_count
                   FROM dialogue_scenes s
                   LEFT JOIN dialogue_categories c ON s.category_id = c.id
                   WHERE s.is_active=1`;
        const params = [];

        if (category_id && parseInt(category_id) > 0) {
            sql += ' AND s.category_id = ?';
            params.push(parseInt(category_id));
        }

        if (group_name) {
            sql += ' AND c.group_name = ?';
            params.push(group_name);
        }

        const countSql = sql.replace(
            `SELECT s.id,s.title,s.title_en,s.description,s.cover_image,s.category_id,s.difficulty,s.guide_role,s.user_role,s.is_vip,s.line_count`,
            'SELECT COUNT(*) as total'
        );
        sql += ' ORDER BY s.sort_order ASC, s.id DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const [scenes, countResult] = await Promise.all([
            query(sql, params),
            query(countSql, params.slice(0, -2))
        ]);

        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        const processed = scenes.map(s => ({
            ...s,
            cover_image: s.cover_image ? (s.cover_image.startsWith('http') ? s.cover_image : baseUrl + s.cover_image) : null
        }));

        res.json({
            success: true,
            data: processed,
            pagination: { page: parseInt(page), limit: parseInt(limit), total: countResult[0].total }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== GET /dialogue/scenes/:id =====
router.get('/scenes/:id', optionalAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const [scene] = await query('SELECT * FROM dialogue_scenes WHERE id = ? AND is_active = 1', [id]);
        if (!scene) return res.status(404).json({ success: false, message: '场景不存在' });

        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        if (scene.cover_image && !scene.cover_image.startsWith('http')) {
            scene.cover_image = baseUrl + scene.cover_image;
        }

        // VIP 场景：未登录或非 VIP 用户只返回基本信息，不返回台词
        const userVip = isUserVip(req.user);
        if (scene.is_vip && !userVip) {
            return res.json({ success: true, data: { ...scene, lines: [], locked: true } });
        }

        const lines = await query(
            'SELECT id,role,line_en,line_cn,audio_url,sort_order FROM dialogue_lines WHERE scene_id = ? ORDER BY sort_order ASC',
            [id]
        );

        const processedLines = lines.map(l => ({
            ...l,
            audio_url: l.audio_url ? (l.audio_url.startsWith('http') ? l.audio_url : baseUrl + l.audio_url) : null
        }));

        res.json({ success: true, data: { ...scene, lines: processedLines, locked: false } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== POST /dialogue/scenes/:id/tts  生成台词 TTS（固定角色发音：guide 女声 / user 男声）=====
router.post('/scenes/:id/tts', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const lines = await query(
            "SELECT id, role, line_en FROM dialogue_lines WHERE scene_id = ? AND (audio_url IS NULL OR audio_url = '')",
            [id]
        );
        if (lines.length === 0) return res.json({ success: true, message: '无需生成', generated: 0 });

        let generated = 0;
        for (const line of lines) {
            try {
                const speed = voiceService.getGoogleTtsSpeed('dialogue');
                const voice = line.role === 'guide' ? 'female' : 'male';
                const result = await voiceService.googleTextToSpeech(line.line_en, voice, speed);
                if (result.success && result.audioUrl) {
                    await query('UPDATE dialogue_lines SET audio_url = ? WHERE id = ?', [result.audioUrl, line.id]);
                    generated++;
                }
            } catch (e) {
                console.error(`[Dialogue TTS] line#${line.id} 失败:`, e.message);
            }
        }

        res.json({ success: true, generated, total: lines.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
