const express = require('express');
const { query } = require('../../src/config/database');

const router = express.Router();

// 用户列表（搜索、筛选、分页）
router.get('/', async (req, res) => {
    try {
        const { search, vip_level, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let whereClauses = ['1=1'];
        const params = [];

        if (search) {
            whereClauses.push('(u.nickname LIKE ? OR u.phone LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
        }

        if (vip_level !== undefined && vip_level !== '') {
            whereClauses.push('u.vip_level = ?');
            params.push(parseInt(vip_level));
        }

        const where = whereClauses.join(' AND ');

        // 总数
        const [countRow] = await query(
            `SELECT COUNT(*) as total FROM users u WHERE ${where}`,
            params
        );

        // 列表
        const list = await query(
            `SELECT u.id, u.nickname, u.avatar_url, u.phone, u.vip_level, u.vip_expire_date,
                    u.points, u.total_study_minutes, u.created_at,
                    cs.consecutive_days, cs.total_days,
                    up.pet_name, up.growth_points, up.growth_stage, up.pet_type
             FROM users u
             LEFT JOIN checkin_stats cs ON cs.user_id = u.id
             LEFT JOIN user_pet up ON up.user_id = u.id
             WHERE ${where}
             ORDER BY u.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, parseInt(limit), offset]
        );

        res.json({
            success: true,
            data: {
                list,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countRow.total
                }
            }
        });
    } catch (error) {
        console.error('获取用户列表错误:', error);
        res.status(500).json({ success: false, message: '获取用户列表失败' });
    }
});

// 用户详情
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const [
            users,
            checkinStats,
            recentPlans,
            petInfo,
            recentOrders,
            recentAssessments
        ] = await Promise.all([
            query('SELECT * FROM users WHERE id = ?', [id]),
            query('SELECT * FROM checkin_stats WHERE user_id = ?', [id]),
            query('SELECT task_date, mode, total_score, avg_score, is_completed, word_completed, scene_completed, podcast_completed FROM daily_task_plans WHERE user_id = ? ORDER BY task_date DESC LIMIT 10', [id]),
            query(`SELECT up.*, pt.name as type_name, pgs.stage_name, pgs.image_url as stage_image
                   FROM user_pet up
                   LEFT JOIN pet_types pt ON up.pet_type = pt.type_key
                   LEFT JOIN pet_growth_stages pgs ON pgs.pet_type = up.pet_type AND pgs.stage = up.growth_stage
                   WHERE up.user_id = ?`, [id]),
            query('SELECT order_no, product_name, amount, status, created_at, paid_at FROM pay_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [id]),
            query('SELECT content_type, reference_text, overall_score, pronunciation_score, fluency_score, integrity_score, created_at FROM voice_assessments WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [id])
        ]);

        if (!users.length) {
            return res.status(404).json({ success: false, message: '用户不存在' });
        }

        res.json({
            success: true,
            data: {
                user: users[0],
                checkinStats: checkinStats[0] || null,
                recentPlans,
                pet: petInfo[0] || null,
                recentOrders,
                recentAssessments
            }
        });
    } catch (error) {
        console.error('获取用户详情错误:', error);
        res.status(500).json({ success: false, message: '获取用户详情失败' });
    }
});

module.exports = router;
