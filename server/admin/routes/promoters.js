const express = require('express');
const { query } = require('../../src/config/database');
const promotion = require('../../src/services/promotion.service');

const router = express.Router();

function toPositiveInt(value, fallback, { min = 1, max = 100 } = {}) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function parseRateBps(body = {}) {
    if (body.commission_rate_bps !== undefined && body.commission_rate_bps !== '') {
        return Number.parseInt(body.commission_rate_bps, 10);
    }
    if (body.rate_percent !== undefined && body.rate_percent !== '') {
        return Math.round(Number(body.rate_percent) * 100);
    }
    throw new Error('请填写分账比例');
}

function respondError(res, error, fallback = '操作失败') {
    const message = error && error.message ? error.message : fallback;
    const status = /不存在|不能为空|无效|不能|超过|必须|未启用|请填写/.test(message) ? 400 : 500;
    if (status >= 500) console.error('[Admin Promoters] 操作失败:', error);
    return res.status(status).json({ success: false, message });
}

function appendSearch(where, params, search) {
    const keyword = String(search || '').trim();
    if (!keyword) return;
    const like = `%${keyword}%`;
    if (/^\d+$/.test(keyword)) {
        where.push('(u.id = ? OR u.nickname LIKE ? OR u.phone LIKE ? OR u.openid LIKE ? OR p.promoter_code LIKE ?)');
        params.push(Number(keyword), like, like, like, like);
    } else {
        where.push('(u.nickname LIKE ? OR u.phone LIKE ? OR u.openid LIKE ? OR p.promoter_code LIKE ?)');
        params.push(like, like, like, like);
    }
}

router.get('/summary', async (req, res) => {
    try {
        await promotion.ensureReady();
        const [row] = await query(`
            SELECT
                COUNT(*) AS total_promoters,
                SUM(status = 'active') AS active_promoters,
                SUM(receiver_status = 'added') AS receivers_added,
                SUM(receiver_status IN ('missing', 'pending', 'failed')) AS receivers_pending,
                COALESCE(SUM(total_sales_cent), 0) AS total_sales_cent,
                COALESCE(SUM(total_profitsharing_cent), 0) AS total_profitsharing_cent
            FROM promoters
        `);

        res.json({ success: true, data: row || {} });
    } catch (error) {
        respondError(res, error, '获取推广概览失败');
    }
});

router.get('/users/search', async (req, res) => {
    try {
        await promotion.ensureReady();
        const keyword = String(req.query.q || '').trim();
        const limit = toPositiveInt(req.query.limit, 20, { min: 1, max: 50 });
        const where = [];
        const params = [];

        if (keyword) {
            const like = `%${keyword}%`;
            if (/^\d+$/.test(keyword)) {
                where.push('(u.id = ? OR u.nickname LIKE ? OR u.phone LIKE ? OR u.openid LIKE ?)');
                params.push(Number(keyword), like, like, like);
            } else {
                where.push('(u.nickname LIKE ? OR u.phone LIKE ? OR u.openid LIKE ?)');
                params.push(like, like, like);
            }
        }

        const users = await query(`
            SELECT u.id, u.nickname, u.avatar_url, u.phone, u.openid, u.vip_level, u.points, u.created_at,
                   p.promoter_code, p.status AS promoter_status, p.commission_rate_bps,
                   p.parent_promoter_user_id, p.receiver_status,
                   pb.promoter_user_id AS bound_promoter_user_id,
                   owner.nickname AS bound_promoter_nickname
            FROM users u
            LEFT JOIN promoters p ON p.user_id = u.id
            LEFT JOIN promotion_bindings pb ON pb.user_id = u.id
            LEFT JOIN users owner ON owner.id = pb.promoter_user_id
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY (p.id IS NULL) DESC, u.created_at DESC
            LIMIT ?
        `, [...params, limit]);

        res.json({ success: true, data: users });
    } catch (error) {
        respondError(res, error, '搜索用户失败');
    }
});

router.get('/', async (req, res) => {
    try {
        await promotion.ensureReady();
        const page = toPositiveInt(req.query.page, 1, { min: 1, max: 100000 });
        const limit = toPositiveInt(req.query.limit, 20, { min: 5, max: 100 });
        const offset = (page - 1) * limit;
        const { search, status, receiver_status, level } = req.query;
        const where = ['1=1'];
        const params = [];

        appendSearch(where, params, search);

        if (status && ['active', 'disabled'].includes(status)) {
            where.push('p.status = ?');
            params.push(status);
        }

        if (receiver_status && ['missing', 'pending', 'added', 'failed'].includes(receiver_status)) {
            where.push('p.receiver_status = ?');
            params.push(receiver_status);
        }

        if (level === 'root') where.push('p.parent_promoter_user_id IS NULL');
        if (level === 'child') where.push('p.parent_promoter_user_id IS NOT NULL');

        const sqlWhere = where.join(' AND ');
        const [countRow] = await query(`
            SELECT COUNT(*) AS total
            FROM promoters p
            JOIN users u ON u.id = p.user_id
            WHERE ${sqlWhere}
        `, params);

        const list = await query(`
            SELECT p.*,
                   u.nickname, u.avatar_url, u.phone, u.openid, u.created_at AS user_created_at,
                   parent.nickname AS parent_nickname,
                   r.receiver_type, r.receiver_account, r.receiver_name, r.relation_type,
                   r.add_status, r.add_error_code, r.add_error_message, r.added_at,
                   COALESCE(direct_bindings.direct_count, 0) AS direct_user_count,
                   COALESCE(root_bindings.root_count, 0) AS root_user_count,
                   COALESCE(child_promoters.child_count, 0) AS child_promoter_count
            FROM promoters p
            JOIN users u ON u.id = p.user_id
            LEFT JOIN users parent ON parent.id = p.parent_promoter_user_id
            LEFT JOIN profitsharing_receivers r ON r.promoter_user_id = p.user_id
            LEFT JOIN (
                SELECT promoter_user_id, COUNT(*) AS direct_count
                FROM promotion_bindings
                GROUP BY promoter_user_id
            ) direct_bindings ON direct_bindings.promoter_user_id = p.user_id
            LEFT JOIN (
                SELECT root_promoter_user_id, COUNT(*) AS root_count
                FROM promotion_bindings
                GROUP BY root_promoter_user_id
            ) root_bindings ON root_bindings.root_promoter_user_id = p.user_id
            LEFT JOIN (
                SELECT parent_promoter_user_id, COUNT(*) AS child_count
                FROM promoters
                WHERE parent_promoter_user_id IS NOT NULL
                GROUP BY parent_promoter_user_id
            ) child_promoters ON child_promoters.parent_promoter_user_id = p.user_id
            WHERE ${sqlWhere}
            ORDER BY p.created_at DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, offset]);

        res.json({
            success: true,
            data: {
                list,
                pagination: {
                    page,
                    limit,
                    total: countRow ? countRow.total : 0
                }
            }
        });
    } catch (error) {
        respondError(res, error, '获取推广员列表失败');
    }
});

router.get('/:userId', async (req, res) => {
    try {
        const detail = await promotion.getPromoterDetail(req.params.userId);
        if (!detail) return res.status(404).json({ success: false, message: '推广员不存在' });
        res.json({ success: true, data: detail });
    } catch (error) {
        respondError(res, error, '获取推广员详情失败');
    }
});

router.get('/:userId/bindings', async (req, res) => {
    try {
        await promotion.ensureReady();
        const userId = Number.parseInt(req.params.userId, 10);
        const page = toPositiveInt(req.query.page, 1, { min: 1, max: 100000 });
        const limit = toPositiveInt(req.query.limit, 20, { min: 5, max: 100 });
        const offset = (page - 1) * limit;
        const [countRow] = await query(`
            SELECT COUNT(*) AS total
            FROM promotion_bindings pb
            WHERE pb.promoter_user_id = ? OR pb.root_promoter_user_id = ?
        `, [userId, userId]);
        const list = await query(`
            SELECT pb.*, u.nickname, u.avatar_url, u.phone, u.created_at AS user_created_at,
                   direct_owner.nickname AS promoter_nickname,
                   root_owner.nickname AS root_promoter_nickname
            FROM promotion_bindings pb
            JOIN users u ON u.id = pb.user_id
            LEFT JOIN users direct_owner ON direct_owner.id = pb.promoter_user_id
            LEFT JOIN users root_owner ON root_owner.id = pb.root_promoter_user_id
            WHERE pb.promoter_user_id = ? OR pb.root_promoter_user_id = ?
            ORDER BY pb.bound_at DESC
            LIMIT ? OFFSET ?
        `, [userId, userId, limit, offset]);
        res.json({
            success: true,
            data: {
                list,
                pagination: { page, limit, total: countRow ? countRow.total : 0 }
            }
        });
    } catch (error) {
        respondError(res, error, '获取绑定用户失败');
    }
});

router.post('/:userId/enable', async (req, res) => {
    try {
        const detail = await promotion.enableRootPromoter({
            userId: req.params.userId,
            rateBps: parseRateBps(req.body),
            adminId: req.session.adminUser && req.session.adminUser.id
        });
        res.json({ success: true, message: '已启用推广员', data: detail });
    } catch (error) {
        respondError(res, error, '启用推广员失败');
    }
});

router.put('/:userId/rate', async (req, res) => {
    try {
        const detail = await promotion.updateRootPromoterRate(req.params.userId, parseRateBps(req.body));
        res.json({ success: true, message: '已更新分账比例', data: detail });
    } catch (error) {
        respondError(res, error, '更新分账比例失败');
    }
});

router.patch('/:userId/status', async (req, res) => {
    try {
        const detail = await promotion.setPromoterStatus(req.params.userId, req.body.status);
        res.json({ success: true, message: '状态已更新', data: detail });
    } catch (error) {
        respondError(res, error, '更新推广员状态失败');
    }
});

router.put('/:userId/receiver', async (req, res) => {
    try {
        const detail = await promotion.upsertReceiver(req.params.userId, req.body);
        res.json({ success: true, message: '接收方资料已保存', data: detail });
    } catch (error) {
        respondError(res, error, '保存接收方失败');
    }
});

router.post('/bindings/manual', async (req, res) => {
    try {
        const detail = await promotion.bindUserToPromoter({
            userId: req.body.user_id,
            promoterUserId: req.body.promoter_user_id,
            source: 'manual'
        });
        res.json({ success: true, message: '绑定关系已保存', data: detail });
    } catch (error) {
        respondError(res, error, '保存绑定关系失败');
    }
});

module.exports = router;
