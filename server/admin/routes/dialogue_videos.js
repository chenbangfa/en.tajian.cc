/**
 * 对话视频管理路由
 * - GET  /dialogue-videos               管理页面
 * - GET  /dialogue-videos/api/list      任务列表
 * - POST /dialogue-videos/api/generate  创建生成任务
 * - DELETE /dialogue-videos/api/job/:id 删除任务
 * - GET  /dialogue-videos/api/scene/:sceneId/status  查询某场景的最新任务
 * - POST /dialogue-videos/api/scenes/status-batch    批量查状态
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const dlgVideoService = require('../../src/services/dialogue-video.service');

const router = express.Router();

// ===== 建表 =====
(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS dialogue_video_jobs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            scene_id INT NOT NULL,
            scene_title VARCHAR(255) DEFAULT '' COMMENT '冗余场景名',
            status ENUM('pending','processing','done','failed') DEFAULT 'pending',
            progress INT DEFAULT 0 COMMENT '0-100',
            config_json TEXT COMMENT '生成配置 {subtitle_mode}',
            video_url VARCHAR(500) DEFAULT '',
            cover_url VARCHAR(500) DEFAULT '',
            duration_seconds INT DEFAULT 0 COMMENT '最终时长',
            error_message VARCHAR(1000) DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_scene (scene_id),
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='对话视频生成任务'`);
        console.log('[DlgVideo] 任务表初始化完成');
        // 服务启动时恢复被打断的任务
        await query(`UPDATE dialogue_video_jobs SET status='pending' WHERE status='processing'`);
        // 触发一次处理
        setImmediate(() => dlgVideoService.processNextJob());
    } catch (e) {
        console.error('[DlgVideo] 建表失败:', e.message);
    }
})();

// ===== 页面 =====

router.get('/', (req, res) => {
    res.render('dialogue-videos/index', {
        page: 'dialogue-videos',
        title: '对话视频',
        user: req.session.adminUser
    });
});

// ===== API: 任务列表（分页） =====

router.get('/api/list', async (req, res) => {
    try {
        const { status, scene_id, page = 1, page_size = 20 } = req.query;
        let sql = `SELECT j.*, s.title as scene_title_full, s.title_en as scene_title_en,
                          s.cover_image as scene_cover, s.difficulty, s.guide_role, s.user_role
                   FROM dialogue_video_jobs j
                   LEFT JOIN dialogue_scenes s ON j.scene_id = s.id
                   WHERE 1=1`;
        const params = [];
        if (status) { sql += ' AND j.status = ?'; params.push(status); }
        if (scene_id) { sql += ' AND j.scene_id = ?'; params.push(parseInt(scene_id)); }

        const countSql = 'SELECT COUNT(*) as total FROM dialogue_video_jobs WHERE 1=1' +
            (status ? ' AND status = ?' : '') + (scene_id ? ' AND scene_id = ?' : '');
        const countParams = [...params];
        const [{ total }] = await query(countSql, countParams);

        sql += ' ORDER BY j.created_at DESC LIMIT ? OFFSET ?';
        const limit = parseInt(page_size);
        const offset = (parseInt(page) - 1) * limit;
        params.push(limit, offset);

        const list = await query(sql, params);
        res.json({ success: true, data: { list, total, page: parseInt(page), page_size: limit } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 创建生成任务 =====

router.post('/api/generate', async (req, res) => {
    try {
        const {
            scene_id,
            subtitle_mode = 'bilingual'
        } = req.body;

        if (!scene_id) return res.status(400).json({ success: false, message: '请选择对话场景' });

        const [scene] = await query(
            `SELECT id, title, title_en, cover_image FROM dialogue_scenes WHERE id = ?`,
            [scene_id]
        );
        if (!scene) return res.status(404).json({ success: false, message: '场景不存在' });

        // 校验台词素材
        const [{ lineTotal, lineWithAudio }] = await query(
            `SELECT COUNT(*) as lineTotal,
                    SUM(CASE WHEN audio_url IS NOT NULL AND audio_url != '' THEN 1 ELSE 0 END) as lineWithAudio
             FROM dialogue_lines WHERE scene_id = ?`, [scene_id]
        );
        if (lineTotal < 2) return res.status(400).json({ success: false, message: '场景至少需要 2 句台词' });
        if (lineWithAudio < lineTotal) {
            return res.status(400).json({
                success: false,
                message: `还有 ${lineTotal - lineWithAudio} 句缺少音频，请先生成 TTS`
            });
        }

        if (!['bilingual', 'english_only'].includes(subtitle_mode)) {
            return res.status(400).json({ success: false, message: '字幕模式无效' });
        }

        const config = { subtitle_mode };
        const result = await query(
            `INSERT INTO dialogue_video_jobs (scene_id, scene_title, config_json, status)
             VALUES (?, ?, ?, 'pending')`,
            [scene_id, scene.title || scene.title_en || '', JSON.stringify(config)]
        );

        res.json({ success: true, data: { job_id: result.insertId }, message: '任务已创建' });

        // 异步启动
        setImmediate(() => dlgVideoService.processNextJob());
    } catch (e) {
        console.error('创建对话视频任务错误:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 删除任务 =====

router.delete('/api/job/:id', async (req, res) => {
    try {
        const [job] = await query('SELECT * FROM dialogue_video_jobs WHERE id = ?', [req.params.id]);
        if (!job) return res.status(404).json({ success: false, message: '任务不存在' });

        if (job.status === 'processing') {
            return res.status(400).json({ success: false, message: '任务进行中，不能删除' });
        }

        const toDel = [job.video_url, job.cover_url].filter(u => u && u.startsWith('/uploads/'));
        for (const u of toDel) {
            const p = path.join(__dirname, '../..', u);
            if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }
        }

        await query('DELETE FROM dialogue_video_jobs WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '已删除' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 查询场景的最新任务状态 =====

router.get('/api/scene/:sceneId/status', async (req, res) => {
    try {
        const [job] = await query(
            `SELECT id, status, progress, video_url, cover_url, duration_seconds, error_message, created_at
             FROM dialogue_video_jobs
             WHERE scene_id = ? ORDER BY created_at DESC LIMIT 1`,
            [req.params.sceneId]
        );
        res.json({ success: true, data: job || null });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 批量查询多个场景的视频状态 =====

router.post('/api/scenes/status-batch', async (req, res) => {
    try {
        const { scene_ids = [] } = req.body;
        if (!Array.isArray(scene_ids) || !scene_ids.length) {
            return res.json({ success: true, data: {} });
        }
        const placeholders = scene_ids.map(() => '?').join(',');
        const rows = await query(
            `SELECT j1.scene_id, j1.id, j1.status, j1.progress, j1.video_url, j1.cover_url, j1.duration_seconds, j1.error_message
             FROM dialogue_video_jobs j1
             INNER JOIN (
                SELECT scene_id, MAX(created_at) as max_created
                FROM dialogue_video_jobs
                WHERE scene_id IN (${placeholders})
                GROUP BY scene_id
             ) j2 ON j1.scene_id = j2.scene_id AND j1.created_at = j2.max_created`,
            scene_ids
        );
        const map = {};
        for (const r of rows) map[r.scene_id] = r;
        res.json({ success: true, data: map });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
