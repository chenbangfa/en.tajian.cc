const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authMiddleware, requirePoints } = require('../middlewares/auth');
const { query } = require('../config/database');
const voiceService = require('../services/voice.service');
const cosService = require('../services/cos.service');

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

router.post('/assess', authMiddleware, requirePoints(3), handleUpload, async (req, res) => {
    try {
        const { reference_text, content_type = 'sentence' } = req.body;

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
      (user_id, content_type, reference_text, audio_url, overall_score, pronunciation_score, fluency_score, integrity_score, detail_result)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            req.user.id,
            content_type,
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
function buildFilterWhere(userId, { min_score, max_score, date } = {}) {
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
    }
    return { where, params };
}

// 获取评测历史（支持分数/日期筛选）
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20, min_score, max_score, date } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const { where, params } = buildFilterWhere(req.user.id, { min_score, max_score, date });

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
        const { min_score, max_score, date } = req.query;
        const { where, params } = buildFilterWhere(userId, { min_score, max_score, date });

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

module.exports = router;
