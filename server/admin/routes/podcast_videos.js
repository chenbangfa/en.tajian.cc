/**
 * 磨耳朵播客视频工坊
 * - GET    /podcast-videos
 * - GET    /podcast-videos/api/candidates
 * - POST   /podcast-videos/api/generate
 * - GET    /podcast-videos/api/jobs
 * - DELETE /podcast-videos/api/job/:id
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const podcastVideoService = require('../../src/services/podcast-video.service');

const router = express.Router();

function normalizeAspectRatio(value) {
    return String(value || '').trim() === '9:16' ? '9:16' : '16:9';
}

function normalizeTemplateMode(value) {
    return String(value || '').trim() === 'bilingual' ? 'bilingual' : 'english_only';
}

function normalizePacing(value) {
    const pacing = String(value || '').trim();
    return ['auto', 'standard', 'slow_learning', 'shorts_compact'].includes(pacing) ? pacing : 'auto';
}

async function ensurePodcastVideoTable() {
    await query(`CREATE TABLE IF NOT EXISTS podcast_video_jobs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        content_id INT NOT NULL COMMENT '磨耳朵内容ID',
        content_title VARCHAR(255) NOT NULL DEFAULT '' COMMENT '文章标题快照',
        template VARCHAR(50) DEFAULT 'podcast_lesson' COMMENT '视频模板',
        status ENUM('pending', 'processing', 'done', 'failed') DEFAULT 'pending',
        progress INT DEFAULT 0 COMMENT '进度0-100',
        sentence_count INT DEFAULT 0 COMMENT '句子数',
        duration_seconds INT DEFAULT 0 COMMENT '视频时长',
        config_json JSON DEFAULT NULL COMMENT '生成配置',
        video_url VARCHAR(500) DEFAULT '' COMMENT '视频文件路径',
        cover_url VARCHAR(500) DEFAULT '' COMMENT '封面图路径',
        error_message TEXT COMMENT '错误信息',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_status (status),
        INDEX idx_content (content_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='磨耳朵播客视频任务'`);
    await query(`UPDATE podcast_video_jobs SET status = 'pending' WHERE status = 'processing'`).catch(() => {});
}

ensurePodcastVideoTable().catch(err => {
    console.error('[PodcastVideo] 建表失败:', err.message);
});

router.get('/', async (req, res) => {
    await ensurePodcastVideoTable().catch(() => {});
    res.render('podcast/videos', { page: 'podcast-videos', title: '磨耳朵视频', user: req.session.adminUser });
});

router.get('/api/candidates', async (req, res) => {
    try {
        const { keyword = '', category_id = '', page = 1, page_size = 20 } = req.query;
        const limit = Math.max(1, Math.min(100, parseInt(page_size, 10) || 20));
        const current = Math.max(1, parseInt(page, 10) || 1);
        const offset = (current - 1) * limit;
        const params = [];
        let where = 'WHERE c.content_text IS NOT NULL AND c.content_text <> ""';
        if (keyword) {
            where += ' AND (c.title LIKE ? OR c.title_en LIKE ? OR c.content_text LIKE ?)';
            params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
        }
        if (category_id) {
            where += ' AND c.category_id = ?';
            params.push(parseInt(category_id, 10));
        }

        const countRows = await query(`SELECT COUNT(*) AS total FROM podcast_contents c ${where}`, params);
        const rows = await query(`
            SELECT c.id, c.title, c.title_en, c.category_id, c.difficulty_level,
                   c.female_audio_url, c.male_audio_url, c.chinese_audio_url,
                   CASE WHEN c.sentences_data IS NOT NULL AND c.sentences_data <> '' AND c.sentences_data <> 'processing' THEN 1 ELSE 0 END AS has_sentences,
                   LENGTH(c.content_text) AS text_length,
                   cat.name AS category_name, cat.name_en AS category_name_en,
                   latest.video_url AS latest_video_url,
                   latest.cover_url AS latest_cover_url,
                   latest.status AS latest_status,
                   latest.config_json AS latest_config_json
            FROM podcast_contents c
            LEFT JOIN podcast_categories cat ON c.category_id = cat.id
            LEFT JOIN (
                SELECT j1.*
                FROM podcast_video_jobs j1
                INNER JOIN (
                    SELECT content_id, MAX(id) AS max_id FROM podcast_video_jobs GROUP BY content_id
                ) j2 ON j1.id = j2.max_id
            ) latest ON latest.content_id = c.id
            ${where}
            ORDER BY c.sort_order ASC, c.id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        res.json({
            success: true,
            data: {
                list: rows,
                total: Number(countRows[0]?.total || 0),
                page: current,
                page_size: limit
            }
        });
    } catch (error) {
        console.error('[PodcastVideo] 候选列表失败:', error);
        res.status(500).json({ success: false, message: error.message || '获取候选文章失败' });
    }
});

router.post('/api/generate', async (req, res) => {
    try {
        await ensurePodcastVideoTable();
        const contentId = Number(req.body.content_id || req.body.contentId || 0);
        if (!contentId) return res.status(400).json({ success: false, message: '请选择磨耳朵文章' });

        const [content] = await query('SELECT id, title, title_en, content_text FROM podcast_contents WHERE id = ?', [contentId]);
        if (!content) return res.status(404).json({ success: false, message: '文章不存在' });
        if (!content.content_text) return res.status(400).json({ success: false, message: '文章英文内容为空' });

        const aspectRatio = normalizeAspectRatio(req.body.aspect_ratio || req.body.aspectRatio);
        const templateMode = normalizeTemplateMode(req.body.template_mode || req.body.templateMode);
        const maxSentences = aspectRatio === '9:16'
            ? Math.max(1, Math.min(8, Number(req.body.max_sentences || req.body.maxSentences || 5)))
            : 0;
        const config = {
            aspect_ratio: aspectRatio,
            template_mode: templateMode,
            pacing: normalizePacing(req.body.pacing),
            max_sentences: maxSentences
        };

        const result = await query(
            `INSERT INTO podcast_video_jobs (content_id, content_title, template, status, config_json)
             VALUES (?, ?, 'podcast_lesson', 'pending', ?)`,
            [contentId, content.title_en || content.title || `Podcast ${contentId}`, JSON.stringify(config)]
        );

        res.json({ success: true, data: { job_id: result.insertId }, message: '视频任务已创建' });
        setImmediate(() => podcastVideoService.processNextJob());
    } catch (error) {
        console.error('[PodcastVideo] 创建任务失败:', error);
        res.status(500).json({ success: false, message: error.message || '创建任务失败' });
    }
});

router.get('/api/jobs', async (req, res) => {
    try {
        await ensurePodcastVideoTable();
        const { status = '', page = 1, page_size = 20 } = req.query;
        const limit = Math.max(1, Math.min(100, parseInt(page_size, 10) || 20));
        const current = Math.max(1, parseInt(page, 10) || 1);
        const offset = (current - 1) * limit;
        const params = [];
        let where = 'WHERE 1=1';
        if (status) {
            where += ' AND j.status = ?';
            params.push(status);
        }
        const countRows = await query(`SELECT COUNT(*) AS total FROM podcast_video_jobs j ${where}`, params);
        const rows = await query(`
            SELECT j.*, c.title AS podcast_title, c.title_en AS podcast_title_en, cat.name AS category_name
            FROM podcast_video_jobs j
            LEFT JOIN podcast_contents c ON j.content_id = c.id
            LEFT JOIN podcast_categories cat ON c.category_id = cat.id
            ${where}
            ORDER BY j.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);
        res.json({ success: true, data: { list: rows, total: Number(countRows[0]?.total || 0), page: current, page_size: limit } });
    } catch (error) {
        console.error('[PodcastVideo] 任务列表失败:', error);
        res.status(500).json({ success: false, message: error.message || '获取任务失败' });
    }
});

router.delete('/api/job/:id', async (req, res) => {
    try {
        const [job] = await query('SELECT * FROM podcast_video_jobs WHERE id = ?', [req.params.id]);
        if (!job) return res.status(404).json({ success: false, message: '任务不存在' });
        for (const url of [job.video_url, job.cover_url]) {
            if (url && url.startsWith('/uploads/')) {
                const p = path.join(__dirname, '../..', url);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            }
        }
        await query('DELETE FROM podcast_video_jobs WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '已删除' });
    } catch (error) {
        console.error('[PodcastVideo] 删除任务失败:', error);
        res.status(500).json({ success: false, message: error.message || '删除失败' });
    }
});

module.exports = router;
