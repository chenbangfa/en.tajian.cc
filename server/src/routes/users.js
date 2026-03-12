const express = require('express');
const { query } = require('../config/database');
const { authMiddleware } = require('../middlewares/auth');

const router = express.Router();

// 获取当前用户信息
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const users = await query(`
      SELECT id, openid, nickname, avatar_url, phone, vip_level, vip_expire_date, 
             points, total_study_minutes, created_at
      FROM users WHERE id = ?
    `, [req.user.id]);

        res.json({
            success: true,
            data: users[0]
        });
    } catch (error) {
        console.error('获取用户信息错误:', error);
        res.status(500).json({
            success: false,
            message: '获取用户信息失败'
        });
    }
});

// 获取积分详情
router.get('/points', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20, type = 'all', startDate, endDate } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClause = 'WHERE user_id = ?';
        let params = [req.user.id];

        // 类型筛选
        if (type === 'income') {
            whereClause += ' AND change_amount > 0';
        } else if (type === 'expense') {
            whereClause += ' AND change_amount < 0';
        }

        // 日期筛选
        if (startDate) {
            whereClause += ' AND DATE(created_at) >= ?';
            params.push(startDate);
        }
        if (endDate) {
            whereClause += ' AND DATE(created_at) <= ?';
            params.push(endDate);
        }

        const [logs, countResult, user] = await Promise.all([
            query(
                `SELECT * FROM points_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
                [...params, parseInt(limit), offset]
            ),
            query(
                `SELECT COUNT(*) as total FROM points_logs ${whereClause}`,
                params
            ),
            query(
                'SELECT points FROM users WHERE id = ?',
                [req.user.id]
            )
        ]);

        res.json({
            success: true,
            data: {
                current_points: user[0].points,
                list: logs,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countResult[0].total
                }
            }
        });
    } catch (error) {
        console.error('获取积分详情错误:', error);
        res.status(500).json({
            success: false,
            message: error.sqlMessage || error.message || '获取积分详情失败'
        });
    }
});

// 获取学习进度
router.get('/learning-progress', authMiddleware, async (req, res) => {
    try {
        // 单词学习统计
        const wordStats = await query(`
      SELECT 
        COUNT(*) as total_words,
        SUM(CASE WHEN mastery_level >= 3 THEN 1 ELSE 0 END) as mastered_words,
        SUM(learn_count) as total_learn_count
      FROM word_learning_records 
      WHERE user_id = ?
    `, [req.user.id]);

        // 最近学习的单词
        const recentWords = await query(`
      SELECT wlr.*, w.word, w.translation
      FROM word_learning_records wlr
      LEFT JOIN words w ON wlr.word_id = w.id
      WHERE wlr.user_id = ?
      ORDER BY wlr.last_learned_at DESC
      LIMIT 10
    `, [req.user.id]);

        // 打卡统计
        const checkinStats = await query(
            'SELECT * FROM checkin_stats WHERE user_id = ?',
            [req.user.id]
        );

        res.json({
            success: true,
            data: {
                words: {
                    total: wordStats[0].total_words || 0,
                    mastered: wordStats[0].mastered_words || 0,
                    learn_count: wordStats[0].total_learn_count || 0
                },
                recent_words: recentWords,
                checkin: checkinStats[0] || {
                    total_days: 0,
                    consecutive_days: 0,
                    total_score: 0
                }
            }
        });
    } catch (error) {
        console.error('获取学习进度错误:', error);
        res.status(500).json({
            success: false,
            message: '获取学习进度失败'
        });
    }
});

// 购买VIP
router.post('/buy-vip', authMiddleware, async (req, res) => {
    try {
        const { vip_type } = req.body; // 'month' | 'year'

        // 这里应该接入微信支付
        // 暂时使用积分兑换模拟
        const prices = {
            month: 500,
            year: 3000
        };

        const days = {
            month: 30,
            year: 365
        };

        const price = prices[vip_type];
        if (!price) {
            return res.status(400).json({
                success: false,
                message: '无效的VIP类型'
            });
        }

        // 检查积分
        if (req.user.points < price) {
            return res.status(400).json({
                success: false,
                message: `积分不足，需要${price}积分`
            });
        }

        // 计算新的过期时间
        const currentExpire = req.user.vip_expire_date ? new Date(req.user.vip_expire_date) : new Date();
        const now = new Date();
        const baseDate = currentExpire > now ? currentExpire : now;
        const newExpire = new Date(baseDate.getTime() + days[vip_type] * 24 * 60 * 60 * 1000);

        // 更新用户VIP
        await query(`
      UPDATE users SET 
        vip_level = 1, 
        vip_expire_date = ?,
        points = points - ?
      WHERE id = ?
    `, [newExpire.toISOString().split('T')[0], price, req.user.id]);

        // 记录积分消耗
        await query(
            'INSERT INTO points_logs (user_id, change_amount, change_type, description) VALUES (?, ?, ?, ?)',
            [req.user.id, -price, 'consume', `兑换VIP${vip_type === 'month' ? '月卡' : '年卡'}`]
        );

        res.json({
            success: true,
            message: 'VIP开通成功',
            data: {
                vip_level: 1,
                vip_expire_date: newExpire.toISOString().split('T')[0]
            }
        });
    } catch (error) {
        console.error('购买VIP错误:', error);
        res.status(500).json({
            success: false,
            message: '购买VIP失败'
        });
    }
});

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 配置multer存储
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../../uploads/avatars');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('只允许上传图片文件'));
        }
    }
});

// 上传头像
router.post('/avatar', authMiddleware, upload.single('avatar'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: '请选择要上传的图片'
            });
        }

        const avatarUrl = `/uploads/avatars/${req.file.filename}`;
        res.json({
            success: true,
            data: {
                url: avatarUrl
            }
        });
    } catch (error) {
        console.error('上传头像错误:', error);
        res.status(500).json({
            success: false,
            message: '上传头像失败'
        });
    }
});

// 更新个人信息
router.put('/me', authMiddleware, async (req, res) => {
    try {
        const { nickname, avatar_url, phone } = req.body;

        // 构建更新字段
        const updates = [];
        const params = [];

        if (nickname !== undefined) {
            updates.push('nickname = ?');
            params.push(nickname);
        }

        if (avatar_url !== undefined) {
            updates.push('avatar_url = ?');
            params.push(avatar_url);
        }

        if (phone !== undefined) {
            updates.push('phone = ?');
            params.push(phone);
        }

        if (updates.length === 0) {
            return res.json({
                success: true,
                message: '没有需要更新的信息'
            });
        }

        params.push(req.user.id);

        await query(
            `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
            params
        );

        res.json({
            success: true,
            message: '更新成功'
        });
    } catch (error) {
        console.error('更新用户信息错误:', error);
        res.status(500).json({
            success: false,
            message: '更新用户信息失败'
        });
    }
});

module.exports = router;
