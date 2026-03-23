const express = require('express');
const { query } = require('../../src/config/database');

const router = express.Router();

// 获取整体统计
router.get('/overview', async (req, res) => {
    try {
        const [
            userStats,
            wordStats,
            sceneStats,
            podcastStats,
            checkinStats
        ] = await Promise.all([
            query('SELECT COUNT(*) as total, SUM(CASE WHEN vip_level > 0 THEN 1 ELSE 0 END) as vip_count FROM users'),
            query('SELECT COUNT(*) as total FROM words'),
            query('SELECT COUNT(*) as total FROM scenes WHERE is_active = 1'),
            query('SELECT COUNT(*) as total FROM podcast_contents'),
            query('SELECT COUNT(*) as total FROM reading_checkins WHERE checkin_date = CURDATE()')
        ]);

        res.json({
            success: true,
            data: {
                users: {
                    total: userStats[0].total,
                    vip: userStats[0].vip_count
                },
                words: wordStats[0].total,
                scenes: sceneStats[0].total,
                podcasts: podcastStats[0].total,
                today_checkins: checkinStats[0].total
            }
        });
    } catch (error) {
        console.error('获取统计错误:', error);
        res.status(500).json({ success: false, message: '获取统计失败' });
    }
});

// 获取用户统计
router.get('/users', async (req, res) => {
    try {
        const { days = 30 } = req.query;

        // 每日新增用户
        const dailyUsers = await query(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM users
      WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [parseInt(days)]);

        // VIP分布
        const vipDistribution = await query(`
      SELECT vip_level, COUNT(*) as count
      FROM users
      GROUP BY vip_level
    `);

        res.json({
            success: true,
            data: {
                daily: dailyUsers,
                vip_distribution: vipDistribution
            }
        });
    } catch (error) {
        console.error('获取用户统计错误:', error);
        res.status(500).json({ success: false, message: '获取用户统计失败' });
    }
});

// 获取学习统计
router.get('/learning', async (req, res) => {
    try {
        const { days = 7 } = req.query;

        // 每日打卡统计
        const dailyCheckins = await query(`
      SELECT checkin_date as date, COUNT(*) as count, AVG(score) as avg_score
      FROM reading_checkins
      WHERE checkin_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY checkin_date
      ORDER BY date
    `, [parseInt(days)]);

        // 热门学习内容
        const popularWords = await query(`
      SELECT w.word, w.translation, COUNT(*) as learn_count
      FROM word_learning_records wlr
      JOIN words w ON wlr.word_id = w.id
      GROUP BY wlr.word_id
      ORDER BY learn_count DESC
      LIMIT 10
    `);

        res.json({
            success: true,
            data: {
                daily_checkins: dailyCheckins,
                popular_words: popularWords
            }
        });
    } catch (error) {
        console.error('获取学习统计错误:', error);
        res.status(500).json({ success: false, message: '获取学习统计失败' });
    }
});

// ══════════════════════════════
//  仪表盘新 API
// ══════════════════════════════

// 仪表盘 8 大核心指标
router.get('/dashboard-overview', async (req, res) => {
    try {
        const [
            totalUsers,
            todayNew,
            todayCheckin,
            todayActive,
            vipUsers,
            todayRevenue,
            pointsConsumed,
            totalGrowth
        ] = await Promise.all([
            query('SELECT COUNT(*) as v FROM users'),
            query('SELECT COUNT(*) as v FROM users WHERE DATE(created_at) = CURDATE()'),
            query('SELECT COUNT(DISTINCT user_id) as v FROM daily_task_plans WHERE task_date = CURDATE() AND is_completed = 1'),
            query('SELECT COUNT(DISTINCT user_id) as v FROM daily_task_items WHERE DATE(completed_at) = CURDATE()'),
            query('SELECT COUNT(*) as v FROM users WHERE vip_level > 0 AND vip_expire_date >= CURDATE()'),
            query("SELECT COALESCE(SUM(amount), 0) as v FROM pay_orders WHERE status = 'paid' AND DATE(paid_at) = CURDATE()"),
            query("SELECT COALESCE(SUM(ABS(change_amount)), 0) as v FROM points_logs WHERE change_type = 'consume'"),
            query('SELECT COALESCE(SUM(growth_points), 0) as v FROM user_pet')
        ]);

        res.json({
            success: true,
            data: {
                totalUsers: totalUsers[0].v,
                todayNew: todayNew[0].v,
                todayCheckin: todayCheckin[0].v,
                todayActive: todayActive[0].v,
                vipUsers: vipUsers[0].v,
                todayRevenue: todayRevenue[0].v,
                pointsConsumed: pointsConsumed[0].v,
                totalGrowth: totalGrowth[0].v
            }
        });
    } catch (error) {
        console.error('仪表盘概览错误:', error);
        res.status(500).json({ success: false, message: '获取概览失败' });
    }
});

// 30天趋势（含环比）
router.get('/trends', async (req, res) => {
    try {
        const [newUsersCurrent, newUsersPrev, checkinTrend] = await Promise.all([
            // 近30天每日新增
            query(`SELECT DATE(created_at) as date, COUNT(*) as count
                   FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                   GROUP BY DATE(created_at) ORDER BY date`),
            // 前30天（环比对照）
            query(`SELECT DATE(created_at) as date, COUNT(*) as count
                   FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
                   AND created_at < DATE_SUB(CURDATE(), INTERVAL 30 DAY)
                   GROUP BY DATE(created_at) ORDER BY date`),
            // 近30天打卡趋势
            query(`SELECT task_date as date, COUNT(DISTINCT user_id) as count, AVG(avg_score) as avg_score
                   FROM daily_task_plans
                   WHERE task_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY) AND is_completed = 1
                   GROUP BY task_date ORDER BY date`)
        ]);

        res.json({
            success: true,
            data: { newUsersCurrent, newUsersPrev, checkinTrend }
        });
    } catch (error) {
        console.error('趋势统计错误:', error);
        res.status(500).json({ success: false, message: '获取趋势失败' });
    }
});

// 分布数据
router.get('/distributions', async (req, res) => {
    try {
        const [vip, assessments, modes, contentTypes] = await Promise.all([
            query('SELECT vip_level, COUNT(*) as count FROM users GROUP BY vip_level'),
            query(`SELECT
                CASE
                    WHEN overall_score < 20 THEN '0-20'
                    WHEN overall_score < 40 THEN '20-40'
                    WHEN overall_score < 60 THEN '40-60'
                    WHEN overall_score < 80 THEN '60-80'
                    ELSE '80-100'
                END as bucket, COUNT(*) as count
                FROM voice_assessments GROUP BY bucket ORDER BY bucket`),
            query('SELECT mode, COUNT(*) as count FROM daily_task_plans GROUP BY mode'),
            query('SELECT task_type, COUNT(*) as count FROM daily_task_items GROUP BY task_type')
        ]);

        res.json({
            success: true,
            data: { vip, assessments, modes, contentTypes }
        });
    } catch (error) {
        console.error('分布统计错误:', error);
        res.status(500).json({ success: false, message: '获取分布失败' });
    }
});

// 成长花园排行榜 Top 30
router.get('/garden-leaderboard', async (req, res) => {
    try {
        const list = await query(`
            SELECT up.user_id, u.nickname, u.avatar_url,
                   up.pet_name, up.pet_type, up.growth_points, up.growth_stage,
                   pgs.stage_name, pgs.image_url as stage_image
            FROM user_pet up
            JOIN users u ON up.user_id = u.id
            LEFT JOIN pet_growth_stages pgs ON pgs.pet_type = up.pet_type AND pgs.stage = up.growth_stage
            ORDER BY up.growth_points DESC
            LIMIT 30
        `);
        res.json({ success: true, data: list });
    } catch (error) {
        console.error('排行榜错误:', error);
        res.status(500).json({ success: false, message: '获取排行榜失败' });
    }
});

module.exports = router;
