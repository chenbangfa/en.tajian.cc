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

module.exports = router;
