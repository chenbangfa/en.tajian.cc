const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authMiddleware, requirePoints } = require('../middlewares/auth');
const { query } = require('../config/database');
const voiceService = require('../services/voice.service');
const cosService = require('../services/cos.service');
const rewardService = require('../services/reward.service');

const router = express.Router();

// 上传目录的基路径（用于将本地文件路径转为可访问 URL）
const UPLOADS_BASE = path.join(__dirname, '../../uploads');

/**
 * 将本地文件路径转换为可访问的 URL 路径
 * 例: /xxx/server/uploads/recordings/abc.silk => /uploads/recordings/abc.silk
 */
function toAudioUrl(filePath) {
    if (!filePath) return null;
    // 如果已经是 URL 格式则直接返回
    if (filePath.startsWith('http') || filePath.startsWith('/uploads/')) return filePath;
    const idx = filePath.indexOf('uploads/');
    if (idx !== -1) return '/' + filePath.substring(idx);
    // 尝试提取文件名
    return '/uploads/recordings/' + path.basename(filePath);
}

// 初始化分享表（首次启动自动创建）
(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS voice_shares (
            id INT AUTO_INCREMENT PRIMARY KEY,
            share_id VARCHAR(32) NOT NULL UNIQUE,
            user_id INT NOT NULL,
            nickname VARCHAR(100) DEFAULT NULL,
            avatar_url VARCHAR(500) DEFAULT NULL,
            filter_desc VARCHAR(255) DEFAULT NULL COMMENT '筛选条件描述',
            filter_params JSON DEFAULT NULL COMMENT '筛选参数',
            total_count INT DEFAULT 0,
            avg_score DECIMAL(5,1) DEFAULT 0,
            max_score DECIMAL(5,1) DEFAULT 0,
            total_days INT DEFAULT 0,
            records_json JSON DEFAULT NULL COMMENT '精选记录快照',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_user (user_id),
            KEY idx_share (share_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评测分享记录'`);
    } catch (e) {
        // 表已存在则忽略
    }
})();

// 配置录音文件上传
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '../../uploads/recordings'));
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        // 微信小程序录音可能发送各种 mimetype，放宽限制
        const allowedTypes = ['audio/mp3', 'audio/wav', 'audio/mpeg', 'audio/m4a', 'audio/silk', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'video/mp4'];
        const allowedExts = ['.mp3', '.wav', '.silk', '.m4a', '.aac', '.ogg', '.webm', '.mp4'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext) || file.mimetype.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('不支持的音频格式: ' + file.mimetype));
        }
    }
});

// 语音合成（TTS）
router.post('/tts', authMiddleware, async (req, res) => {
    try {
        const { text, voice = 'female', speed = 1.0 } = req.body;

        if (!text) {
            return res.status(400).json({
                success: false,
                message: '请提供文本内容'
            });
        }

        // 检查缓存
        const cached = await query(
            'SELECT audio_url FROM tts_cache WHERE text_hash = MD5(?) AND voice = ?',
            [text, voice]
        );

        if (cached.length > 0) {
            return res.json({
                success: true,
                data: { audio_url: cached[0].audio_url, cached: true }
            });
        }

        // 调用有道TTS
        const result = await voiceService.textToSpeech(text, voice, speed);

        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || '语音合成失败'
            });
        }

        // 缓存结果
        await query(
            'INSERT INTO tts_cache (text_hash, text_content, voice, audio_url) VALUES (MD5(?), ?, ?, ?)',
            [text, text, voice, result.audioUrl]
        );

        res.json({
            success: true,
            data: { audio_url: result.audioUrl, cached: false }
        });
    } catch (error) {
        console.error('TTS错误:', error);
        res.status(500).json({
            success: false,
            message: '语音合成失败'
        });
    }
});

// 语音评测
// 用包裹函数处理 multer 错误，确保返回 JSON 而非 HTML
const handleUpload = (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
        if (err) {
            console.error('Multer上传错误:', err.message);
            return res.status(400).json({
                success: false,
                message: '录音上传失败: ' + err.message
            });
        }
        next();
    });
};

router.post('/assess', authMiddleware, requirePoints(5), handleUpload, async (req, res) => {
    try {
        const { reference_text, content_type = 'sentence', source = 'checkin', source_id, sentence_index } = req.body;

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: '请上传录音文件'
            });
        }

        if (!reference_text) {
            return res.status(400).json({
                success: false,
                message: '请提供参考文本'
            });
        }

        // 调用腾讯云语音评测
        const result = await voiceService.assessPronunciation(
            req.file.path,
            reference_text,
            content_type
        );

        if (!result.success) {
            return res.status(500).json({
                success: false,
                message: result.error || '语音评测失败'
            });
        }

        // 上传录音到 COS（优先），回退本地路径
        let recordingUrl = req.file.path;
        if (cosService.isConfigured) {
            try {
                recordingUrl = await cosService.uploadLocalFile(req.file.path, 'recordings', req.file.originalname);
                fs.unlink(req.file.path, () => {}); // 上传成功后删除本地临时文件
            } catch (err) {
                console.error('[voice/assess] COS 上传录音失败，保留本地路径:', err.message);
            }
        }

        // 保存评测记录
        const insertResult = await query(`
      INSERT INTO voice_assessments
      (user_id, content_type, source, source_id, sentence_index, reference_text, audio_url, overall_score, pronunciation_score, fluency_score, integrity_score, detail_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            req.user.id,
            content_type,
            source || 'checkin',
            source_id ? parseInt(source_id) : null,
            sentence_index !== undefined && sentence_index !== null ? parseInt(sentence_index) : null,
            reference_text,
            recordingUrl,
            result.overallScore,
            result.pronunciationScore,
            result.fluencyScore,
            result.integrityScore,
            JSON.stringify(result.details)
        ]);

        // 异步更新单词评测次数（通过 reference_text 匹配单词）
        if (content_type === 'word' && reference_text) {
            query('UPDATE words SET assess_count = assess_count + 1 WHERE word = ?', [reference_text.trim()]).catch(() => { });
        }

        // 扣除积分
        await query(
            'UPDATE users SET points = points - ? WHERE id = ?',
            [req.pointsToDeduct, req.user.id]
        );

        await query(
            'INSERT INTO points_logs (user_id, change_amount, change_type, description) VALUES (?, ?, ?, ?)',
            [req.user.id, -req.pointsToDeduct, 'consume', '语音评测']
        );

        // ── 成长花园：高分评测奖励（按单词去重，每个单词每天最多奖励1次）──
        try {
            await rewardService.checkAndReward(req.user.id, 'high_score', {
                score: result.overallScore,
                sourceKey: reference_text.trim()
            });
        } catch (e) {
            console.error('[Reward] 评测奖励发放失败:', e.message);
        }

        res.json({
            success: true,
            data: {
                assessment_id: insertResult.insertId,
                overall_score: result.overallScore,
                pronunciation_score: result.pronunciationScore,
                fluency_score: result.fluencyScore,
                integrity_score: result.integrityScore,
                details: result.details
            }
        });
    } catch (error) {
        console.error('语音评测错误:', error);
        res.status(500).json({
            success: false,
            message: '语音评测失败'
        });
    }
});

// 构建筛选 WHERE 子句（共用逻辑）
function buildFilterWhere(userId, { min_score, max_score, date, month, source } = {}) {
    let where = 'WHERE user_id = ?';
    const params = [userId];
    if (min_score) {
        where += ' AND overall_score >= ?';
        params.push(parseFloat(min_score));
    }
    if (max_score) {
        where += ' AND overall_score < ?';
        params.push(parseFloat(max_score));
    }
    if (date) {
        where += ' AND DATE(created_at) = ?';
        params.push(date);
    } else if (month) {
        // month 格式 YYYY-MM，匹配整月
        where += ' AND DATE_FORMAT(created_at, \'%Y-%m\') = ?';
        params.push(month);
    }
    if (source && source !== 'all') {
        where += ' AND source = ?';
        params.push(source);
    }
    return { where, params };
}

// 获取评测历史（支持分数/日期/来源筛选）
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20, min_score, max_score, date, source } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const { where, params } = buildFilterWhere(req.user.id, { min_score, max_score, date, source });

        const [records, countResult] = await Promise.all([
            query(
                `SELECT * FROM voice_assessments ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                [...params, parseInt(limit), offset]
            ),
            query(
                `SELECT COUNT(*) as total FROM voice_assessments ${where}`,
                [...params]
            )
        ]);

        // 转换音频路径为可访问 URL
        const list = records.map(r => ({
            ...r,
            audio_url: toAudioUrl(r.audio_url)
        }));

        res.json({
            success: true,
            data: {
                list,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countResult[0].total
                }
            }
        });
    } catch (error) {
        console.error('获取评测历史错误:', error);
        res.status(500).json({ success: false, message: error.sqlMessage || error.message || '获取评测历史失败' });
    }
});

// 评测统计概览（支持筛选参数）
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { min_score, max_score, date, month, source } = req.query;
        const { where, params } = buildFilterWhere(userId, { min_score, max_score, date, month, source });

        // 根据筛选条件统计
        const [overall] = await query(
            `SELECT COUNT(*) as total_count,
                    ROUND(AVG(overall_score), 1) as avg_score,
                    MAX(overall_score) as max_score,
                    COUNT(DISTINCT DATE(created_at)) as total_days
             FROM voice_assessments ${where}`,
            params
        );

        // 本月评测（也受筛选影响）
        const now = new Date();
        const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
        const monthParams = [...params, monthStart];
        const [monthly] = await query(
            `SELECT COUNT(DISTINCT DATE(created_at)) as month_days,
                    COUNT(*) as month_count
             FROM voice_assessments
             ${where} AND DATE(created_at) >= ?`,
            monthParams
        );

        res.json({
            success: true,
            data: {
                total_count: overall.total_count || 0,
                avg_score: parseFloat(overall.avg_score) || 0,
                max_score: parseFloat(overall.max_score) || 0,
                total_days: overall.total_days || 0,
                month_days: monthly.month_days || 0,
                month_count: monthly.month_count || 0
            }
        });
    } catch (error) {
        console.error('获取评测统计错误:', error);
        res.status(500).json({ success: false, message: '获取统计失败' });
    }
});

// 日历热力图数据
router.get('/calendar', authMiddleware, async (req, res) => {
    try {
        const { month } = req.query; // 格式: 2026-02
        const userId = req.user.id;

        let startDate, endDate;
        if (month && /^\d{4}-\d{2}$/.test(month)) {
            startDate = `${month}-01`;
            const [y, m] = month.split('-').map(Number);
            const lastDay = new Date(y, m, 0).getDate();
            endDate = `${month}-${String(lastDay).padStart(2, '0')}`;
        } else {
            const now = new Date();
            const y = now.getFullYear();
            const m = String(now.getMonth() + 1).padStart(2, '0');
            startDate = `${y}-${m}-01`;
            const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
            endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
        }

        const days = await query(
            `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as \`date\`,
                    COUNT(*) as count,
                    ROUND(AVG(overall_score), 1) as avg_score
             FROM voice_assessments
             WHERE user_id = ? AND DATE(created_at) BETWEEN ? AND ?
             GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
             ORDER BY \`date\``,
            [userId, startDate, endDate]
        );

        res.json({
            success: true,
            data: { month: month || startDate.substring(0, 7), days }
        });
    } catch (error) {
        console.error('获取日历数据错误:', error);
        res.status(500).json({ success: false, message: error.sqlMessage || error.message || '获取日历数据失败' });
    }
});

// 创建分享记录
router.post('/share', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { min_score, max_score, date } = req.body;
        const { where, params } = buildFilterWhere(userId, { min_score, max_score, date });

        // 计算筛选后的统计
        const [stats] = await query(
            `SELECT COUNT(*) as total_count,
                    ROUND(AVG(overall_score), 1) as avg_score,
                    MAX(overall_score) as max_score,
                    COUNT(DISTINCT DATE(created_at)) as total_days
             FROM voice_assessments ${where}`,
            params
        );

        // 获取精选记录（最近 20 条）
        const records = await query(
            `SELECT id, content_type, reference_text, overall_score, pronunciation_score,
                    fluency_score, integrity_score, audio_url, created_at
             FROM voice_assessments ${where}
             ORDER BY created_at DESC LIMIT 20`,
            [...params]
        );

        // 转换音频 URL
        const recordsWithUrl = records.map(r => ({
            ...r,
            audio_url: toAudioUrl(r.audio_url)
        }));

        // 获取用户信息
        const [user] = await query('SELECT nickname, avatar_url FROM users WHERE id = ?', [userId]);

        // 生成唯一 share_id
        const shareId = crypto.randomBytes(12).toString('hex');

        // 构建筛选描述
        let filterDesc = '全部评测';
        const parts = [];
        if (min_score && parseFloat(min_score) >= 90) parts.push('90分以上');
        else if (min_score && max_score) parts.push(`${min_score}-${max_score}分`);
        else if (max_score && parseFloat(max_score) <= 60) parts.push('60分以下');
        if (date) parts.push(date);
        if (parts.length) filterDesc = parts.join(' · ');

        await query(
            `INSERT INTO voice_shares (share_id, user_id, nickname, avatar_url, filter_desc, filter_params, total_count, avg_score, max_score, total_days, records_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                shareId, userId,
                user ? user.nickname : null,
                user ? user.avatar_url : null,
                filterDesc,
                JSON.stringify({ min_score, max_score, date }),
                stats.total_count || 0,
                parseFloat(stats.avg_score) || 0,
                parseFloat(stats.max_score) || 0,
                stats.total_days || 0,
                JSON.stringify(recordsWithUrl)
            ]
        );

        res.json({
            success: true,
            data: {
                share_id: shareId,
                stats: {
                    total_count: stats.total_count || 0,
                    avg_score: parseFloat(stats.avg_score) || 0,
                    max_score: parseFloat(stats.max_score) || 0,
                    total_days: stats.total_days || 0
                },
                filter_desc: filterDesc
            }
        });
    } catch (error) {
        console.error('创建分享记录错误:', error);
        res.status(500).json({ success: false, message: '创建分享失败' });
    }
});

// 查看分享记录（公开接口，无需登录）
router.get('/share/:shareId', async (req, res) => {
    try {
        const [share] = await query(
            'SELECT * FROM voice_shares WHERE share_id = ?',
            [req.params.shareId]
        );

        if (!share) {
            return res.status(404).json({ success: false, message: '分享记录不存在' });
        }

        let records = [];
        try {
            records = typeof share.records_json === 'string'
                ? JSON.parse(share.records_json)
                : (share.records_json || []);
        } catch (e) {
            records = [];
        }

        res.json({
            success: true,
            data: {
                share_id: share.share_id,
                nickname: share.nickname || '学习小达人',
                avatar_url: share.avatar_url,
                filter_desc: share.filter_desc,
                total_count: share.total_count,
                avg_score: parseFloat(share.avg_score) || 0,
                max_score: parseFloat(share.max_score) || 0,
                total_days: share.total_days,
                records,
                created_at: share.created_at
            }
        });
    } catch (error) {
        console.error('查看分享记录错误:', error);
        res.status(500).json({ success: false, message: '获取分享记录失败' });
    }
});

// 磨耳朵朗读分享 —— 创建分享记录
router.post('/podcast-share', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { content_id, content_title, sentences } = req.body;
        if (!content_id) return res.status(400).json({ success: false, message: '缺少 content_id' });

        // 从 DB 查询该用户对该文章每句的最高分 + 对应录音
        const rows = await query(`
            SELECT va.sentence_index, va.reference_text, va.overall_score AS best_score, va.audio_url
            FROM voice_assessments va
            INNER JOIN (
                SELECT sentence_index, MAX(overall_score) AS max_score
                FROM voice_assessments
                WHERE user_id = ? AND source = 'podcast' AND source_id = ?
                  AND sentence_index IS NOT NULL
                GROUP BY sentence_index
            ) t ON va.sentence_index = t.sentence_index AND va.overall_score = t.max_score
            WHERE va.user_id = ? AND va.source = 'podcast' AND va.source_id = ?
            GROUP BY va.sentence_index
            ORDER BY va.sentence_index
        `, [userId, content_id, userId, content_id]);

        if (rows.length === 0) return res.status(400).json({ success: false, message: '暂无评测记录' });

        // 合并 DB 数据与前端传入的 sentences（含 translation）
        const sentenceMap = {};
        (sentences || []).forEach(s => { sentenceMap[s.index] = s; });

        const sentencesJson = rows.map(r => ({
            index: r.sentence_index,
            text: r.reference_text || (sentenceMap[r.sentence_index] || {}).text || '',
            translation: (sentenceMap[r.sentence_index] || {}).translation || '',
            score: Math.round(parseFloat(r.best_score) || 0),
            audio_url: toAudioUrl(r.audio_url)
        }));

        const avgScore = Math.round(sentencesJson.reduce((s, r) => s + r.score, 0) / sentencesJson.length);
        let mastery = 'needs_practice';
        if (avgScore >= 85) mastery = 'excellent';
        else if (avgScore >= 70) mastery = 'good';

        // 获取用户信息
        const [user] = await query('SELECT nickname, avatar_url FROM users WHERE id = ?', [userId]);

        const shareId = crypto.randomBytes(12).toString('hex');
        await query(`
            CREATE TABLE IF NOT EXISTS podcast_assessment_shares (
                id INT AUTO_INCREMENT PRIMARY KEY,
                share_id VARCHAR(32) NOT NULL UNIQUE,
                user_id INT NOT NULL,
                nickname VARCHAR(100) DEFAULT NULL,
                avatar_url VARCHAR(500) DEFAULT NULL,
                content_id INT NOT NULL,
                content_title VARCHAR(255) DEFAULT NULL,
                avg_score DECIMAL(5,1) DEFAULT 0,
                mastery VARCHAR(20) DEFAULT NULL,
                sentences_json JSON DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_share (share_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await query(`
            INSERT INTO podcast_assessment_shares
            (share_id, user_id, nickname, avatar_url, content_id, content_title, avg_score, mastery, sentences_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            shareId, userId,
            user ? user.nickname : null,
            user ? user.avatar_url : null,
            content_id,
            content_title || '',
            avgScore,
            mastery,
            JSON.stringify(sentencesJson)
        ]);

        res.json({ success: true, data: { share_id: shareId, avg_score: avgScore, mastery } });
    } catch (error) {
        console.error('创建磨耳朵分享错误:', error);
        res.status(500).json({ success: false, message: '创建分享失败' });
    }
});

// 磨耳朵朗读分享 —— 查看（公开）
router.get('/podcast-share/:shareId', async (req, res) => {
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS podcast_assessment_shares (
                id INT AUTO_INCREMENT PRIMARY KEY,
                share_id VARCHAR(32) NOT NULL UNIQUE,
                user_id INT NOT NULL,
                nickname VARCHAR(100) DEFAULT NULL,
                avatar_url VARCHAR(500) DEFAULT NULL,
                content_id INT NOT NULL,
                content_title VARCHAR(255) DEFAULT NULL,
                avg_score DECIMAL(5,1) DEFAULT 0,
                mastery VARCHAR(20) DEFAULT NULL,
                sentences_json JSON DEFAULT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                KEY idx_share (share_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        const [share] = await query(
            'SELECT * FROM podcast_assessment_shares WHERE share_id = ?',
            [req.params.shareId]
        );
        if (!share) return res.status(404).json({ success: false, message: '分享不存在' });

        let sentences = [];
        try { sentences = typeof share.sentences_json === 'string' ? JSON.parse(share.sentences_json) : (share.sentences_json || []); } catch (e) {}

        res.json({
            success: true,
            data: {
                share_id: share.share_id,
                nickname: share.nickname || '学习达人',
                avatar_url: share.avatar_url,
                content_id: share.content_id,
                content_title: share.content_title,
                avg_score: parseFloat(share.avg_score) || 0,
                mastery: share.mastery,
                sentences,
                created_at: share.created_at
            }
        });
    } catch (error) {
        console.error('获取磨耳朵分享错误:', error);
        res.status(500).json({ success: false, message: '获取分享失败' });
    }
});

// 批量获取磨耳朵掌握度（供列表页使用）
// GET /voice/podcast-mastery?ids=1,2,3
router.get('/podcast-mastery', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const idsStr = req.query.ids || '';
        const ids = idsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
        if (ids.length === 0) return res.json({ success: true, data: {} });

        const placeholders = ids.map(() => '?').join(',');
        const rows = await query(`
            SELECT source_id,
                   ROUND(AVG(best_score), 1) AS avg_score,
                   SUM(attempts) AS total_attempts
            FROM (
                SELECT source_id, sentence_index,
                       MAX(overall_score) AS best_score,
                       COUNT(*) AS attempts
                FROM voice_assessments
                WHERE user_id = ? AND source = 'podcast' AND source_id IN (${placeholders})
                  AND sentence_index IS NOT NULL
                GROUP BY source_id, sentence_index
            ) t
            GROUP BY source_id
        `, [userId, ...ids]);

        const data = {};
        rows.forEach(r => {
            const avg = parseFloat(r.avg_score) || 0;
            let mastery = 'assessed';
            if (avg >= 85) mastery = 'excellent';
            else if (avg >= 70) mastery = 'good';
            else mastery = 'needs_practice';
            data[r.source_id] = { avg_score: Math.round(avg), mastery };
        });

        res.json({ success: true, data });
    } catch (error) {
        console.error('批量掌握度查询错误:', error);
        res.status(500).json({ success: false, message: '查询失败' });
    }
});

// 磨耳朵文章评测汇总
router.get('/podcast-summary/:contentId', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const contentId = parseInt(req.params.contentId);
        if (!contentId) return res.status(400).json({ success: false, message: '缺少 contentId' });

        // 查询该用户对该文章所有句子的最高分记录
        const rows = await query(`
            SELECT sentence_index,
                   MAX(overall_score) AS best_score,
                   MAX(pronunciation_score) AS best_pronunciation,
                   MAX(fluency_score) AS best_fluency,
                   MAX(integrity_score) AS best_integrity,
                   COUNT(*) AS attempts
            FROM voice_assessments
            WHERE user_id = ? AND source = 'podcast' AND source_id = ?
              AND sentence_index IS NOT NULL
            GROUP BY sentence_index
            ORDER BY sentence_index
        `, [userId, contentId]);

        const sentences = rows.map(r => ({
            index: r.sentence_index,
            best_score: parseFloat(r.best_score) || 0,
            best_pronunciation: parseFloat(r.best_pronunciation) || 0,
            best_fluency: parseFloat(r.best_fluency) || 0,
            best_integrity: parseFloat(r.best_integrity) || 0,
            attempts: r.attempts
        }));

        const avgScore = sentences.length > 0
            ? Math.round(sentences.reduce((s, r) => s + r.best_score, 0) / sentences.length)
            : 0;

        let mastery = 'none';
        if (sentences.length > 0) {
            if (avgScore >= 85) mastery = 'excellent';
            else if (avgScore >= 70) mastery = 'good';
            else mastery = 'needs_practice';
        }

        res.json({
            success: true,
            data: {
                content_id: contentId,
                assessed_count: sentences.length,
                avg_score: avgScore,
                mastery,
                sentences
            }
        });
    } catch (error) {
        console.error('获取磨耳朵汇总错误:', error);
        res.status(500).json({ success: false, message: '获取汇总失败' });
    }
});

module.exports = router;
