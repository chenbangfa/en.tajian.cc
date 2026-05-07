/**
 * 绘本视频管理路由
 * - GET  /picturebook-videos               管理页面
 * - GET  /picturebook-videos/api/list      任务列表
 * - POST /picturebook-videos/api/generate  创建生成任务
 * - DELETE /picturebook-videos/api/job/:id 删除任务
 * - GET  /picturebook-videos/api/book/:bookId/status  查询某本书的最新任务
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const pbVideoService = require('../../src/services/picturebook-video.service');

const router = express.Router();

// ===== 建表 =====
(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS picture_book_video_jobs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            book_id INT NOT NULL,
            book_title VARCHAR(255) DEFAULT '' COMMENT '冗余书名',
            status ENUM('pending','processing','done','failed') DEFAULT 'pending',
            progress INT DEFAULT 0 COMMENT '0-100',
            config_json TEXT COMMENT '生成配置 {subtitle_mode, duration_mode, voice}',
            video_url VARCHAR(500) DEFAULT '',
            cover_url VARCHAR(500) DEFAULT '',
            duration_seconds INT DEFAULT 0 COMMENT '最终时长',
            error_message VARCHAR(1000) DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_book (book_id),
            INDEX idx_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本视频生成任务'`);
        console.log('[PBVideo] 任务表初始化完成');
        // 服务启动时恢复被打断的任务（processing → pending）
        await query(`UPDATE picture_book_video_jobs SET status='pending' WHERE status='processing'`);
        // 触发一次处理
        setImmediate(() => pbVideoService.processNextJob());
    } catch (e) {
        console.error('[PBVideo] 建表失败:', e.message);
    }
})();

// ===== 页面 =====

router.get('/', (req, res) => {
    res.render('picturebook-videos/index', {
        page: 'pb-videos',
        title: '绘本视频',
        user: req.session.adminUser
    });
});

// ===== API: 任务列表（分页） =====

router.get('/api/list', async (req, res) => {
    try {
        const { status, book_id, page = 1, page_size = 20 } = req.query;
        let sql = `SELECT j.*, b.title as book_title_full, b.title_en as book_title_en, b.cover_url as book_cover
                   FROM picture_book_video_jobs j
                   LEFT JOIN picture_books b ON j.book_id = b.id
                   WHERE 1=1`;
        const params = [];
        if (status) { sql += ' AND j.status = ?'; params.push(status); }
        if (book_id) { sql += ' AND j.book_id = ?'; params.push(parseInt(book_id)); }

        const countSql = 'SELECT COUNT(*) as total FROM picture_book_video_jobs WHERE 1=1' +
            (status ? ' AND status = ?' : '') + (book_id ? ' AND book_id = ?' : '');
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
            book_id,
            subtitle_mode = 'bilingual',     // bilingual | english_only
            duration_mode = 'shorts_60',     // shorts_60 | full_75
            voice = 'female'                 // female (目前唯一)
        } = req.body;

        if (!book_id) return res.status(400).json({ success: false, message: '请选择绘本' });

        const [book] = await query(
            `SELECT id, title, title_en, cover_url, page_count FROM picture_books WHERE id = ?`,
            [book_id]
        );
        if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });

        // 校验页面素材齐全度
        const [{ pageTotal, pageWithImg, pageWithAudio }] = await query(
            `SELECT COUNT(*) as pageTotal,
                    SUM(CASE WHEN image_url IS NOT NULL AND image_url != '' THEN 1 ELSE 0 END) as pageWithImg,
                    SUM(CASE WHEN audio_url IS NOT NULL AND audio_url != '' THEN 1 ELSE 0 END) as pageWithAudio
               FROM picture_book_pages WHERE book_id = ?`, [book_id]
        );
        if (pageTotal == 0) return res.status(400).json({ success: false, message: '绘本没有页面' });
        if (pageWithImg < pageTotal) return res.status(400).json({ success: false, message: `还有 ${pageTotal - pageWithImg} 页缺少图片，请先补齐` });
        if (pageWithAudio < pageTotal) return res.status(400).json({ success: false, message: `还有 ${pageTotal - pageWithAudio} 页缺少音频，请先合成` });

        // 校验参数
        if (!['bilingual', 'english_only'].includes(subtitle_mode)) {
            return res.status(400).json({ success: false, message: '字幕模式无效' });
        }
        if (!['shorts_60', 'full_75'].includes(duration_mode)) {
            return res.status(400).json({ success: false, message: '时长模式无效' });
        }

        const config = { subtitle_mode, duration_mode, voice };
        const result = await query(
            `INSERT INTO picture_book_video_jobs (book_id, book_title, config_json, status)
             VALUES (?, ?, ?, 'pending')`,
            [book_id, book.title || book.title_en || '', JSON.stringify(config)]
        );

        res.json({ success: true, data: { job_id: result.insertId }, message: '任务已创建' });

        // 异步启动
        setImmediate(() => pbVideoService.processNextJob());
    } catch (e) {
        console.error('创建绘本视频任务错误:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 删除任务（连同视频和封面文件） =====

router.delete('/api/job/:id', async (req, res) => {
    try {
        const [job] = await query('SELECT * FROM picture_book_video_jobs WHERE id = ?', [req.params.id]);
        if (!job) return res.status(404).json({ success: false, message: '任务不存在' });

        if (job.status === 'processing') {
            return res.status(400).json({ success: false, message: '任务进行中，不能删除' });
        }

        const toDel = [job.video_url, job.cover_url].filter(u => u && u.startsWith('/uploads/'));
        for (const u of toDel) {
            const p = path.join(__dirname, '../..', u);
            if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) { /* ignore */ } }
        }

        await query('DELETE FROM picture_book_video_jobs WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '已删除' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 查询书的最新任务状态（绘本列表页 badge 用） =====

router.get('/api/book/:bookId/status', async (req, res) => {
    try {
        const [job] = await query(
            `SELECT id, status, progress, video_url, cover_url, duration_seconds, error_message, created_at
             FROM picture_book_video_jobs
             WHERE book_id = ? ORDER BY created_at DESC LIMIT 1`,
            [req.params.bookId]
        );
        res.json({ success: true, data: job || null });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 批量查询多本书的视频状态（列表页一次性加载） =====

router.post('/api/books/status-batch', async (req, res) => {
    try {
        const { book_ids = [] } = req.body;
        if (!Array.isArray(book_ids) || !book_ids.length) {
            return res.json({ success: true, data: {} });
        }
        const placeholders = book_ids.map(() => '?').join(',');
        const rows = await query(
            `SELECT j1.book_id, j1.id, j1.status, j1.progress, j1.video_url, j1.cover_url, j1.duration_seconds, j1.error_message
             FROM picture_book_video_jobs j1
             INNER JOIN (
                SELECT book_id, MAX(created_at) as max_created
                FROM picture_book_video_jobs
                WHERE book_id IN (${placeholders})
                GROUP BY book_id
             ) j2 ON j1.book_id = j2.book_id AND j1.created_at = j2.max_created`,
            book_ids
        );
        const map = {};
        for (const r of rows) map[r.book_id] = r;
        res.json({ success: true, data: map });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
