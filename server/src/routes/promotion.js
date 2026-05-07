const express = require('express');
const { authMiddleware } = require('../middlewares/auth');
const promotion = require('../services/promotion.service');

const router = express.Router();

router.get('/dashboard', authMiddleware, async (req, res) => {
    try {
        const dashboard = await promotion.getPromoterDashboard(req.user.id);
        if (!dashboard) {
            return res.status(403).json({
                success: false,
                message: '当前账号还不是已启用的推广员'
            });
        }

        try {
            const qrcode = await promotion.generatePromoterQrCode(req.user.id);
            dashboard.promoter.qr_code_url = qrcode.url;
            dashboard.promoter.qr_code_scene = qrcode.scene;
        } catch (qrError) {
            console.error('[Promotion] 生成推广二维码失败:', qrError.message);
            dashboard.promoter.qr_code_error = qrError.message || '推广二维码生成失败';
        }

        res.json({
            success: true,
            data: dashboard
        });
    } catch (error) {
        console.error('[Promotion] 获取推广员工作台失败:', error);
        res.status(500).json({
            success: false,
            message: '获取推广员工作台失败'
        });
    }
});

function extractPromoterCode(body = {}) {
    const direct = body.promoter_code || body.promoterCode || body.pm || body.p || body.code;
    if (direct) return promotion.normalizePromoterCode(direct);
    return promotion.parsePromoterScene(body.scene || '');
}

router.post('/bind', authMiddleware, async (req, res) => {
    try {
        const promoterCode = extractPromoterCode(req.body || {});
        const result = await promotion.bindUserByPromoterCode({
            userId: req.user.id,
            promoterCode,
            scene: req.body && req.body.scene,
            source: 'qrcode'
        });

        res.json({
            success: true,
            data: result,
            message: result.bound ? '推广关系绑定成功' : '无需重复绑定'
        });
    } catch (error) {
        console.error('[Promotion] 扫码绑定推广关系失败:', error);
        res.status(500).json({
            success: false,
            message: '绑定推广关系失败'
        });
    }
});

router.post('/qrcode/refresh', authMiddleware, async (req, res) => {
    try {
        const qrcode = await promotion.generatePromoterQrCode(req.user.id, { force: true });
        res.json({
            success: true,
            data: qrcode
        });
    } catch (error) {
        console.error('[Promotion] 刷新推广二维码失败:', error);
        res.status(500).json({
            success: false,
            message: error.message || '刷新推广二维码失败'
        });
    }
});

router.get('/bindings', authMiddleware, async (req, res) => {
    try {
        const data = await promotion.getPromoterBindings({
            userId: req.user.id,
            page: req.query.page,
            limit: req.query.limit,
            keyword: req.query.keyword || req.query.q || ''
        });

        if (!data) {
            return res.status(403).json({
                success: false,
                message: '当前账号还不是已启用的推广员'
            });
        }

        res.json({
            success: true,
            data
        });
    } catch (error) {
        console.error('[Promotion] 获取推广绑定用户失败:', error);
        res.status(500).json({
            success: false,
            message: '获取推广绑定用户失败'
        });
    }
});

router.post('/children', authMiddleware, async (req, res) => {
    try {
        const childUserId = Number.parseInt(req.body && req.body.user_id, 10);
        const ratePercent = Number(req.body && req.body.rate_percent);
        const rateBps = req.body && req.body.commission_rate_bps !== undefined
            ? Number.parseInt(req.body.commission_rate_bps, 10)
            : Math.round(ratePercent * 100);

        const detail = await promotion.enableChildPromoterByParent({
            parentUserId: req.user.id,
            childUserId,
            rateBps
        });

        res.json({
            success: true,
            message: '已设置为二级推广员',
            data: detail
        });
    } catch (error) {
        const message = error && error.message ? error.message : '设置二级推广员失败';
        const status = /不存在|不能为空|不能|超过|缺少|只能|比例|推广员/.test(message) ? 400 : 500;
        if (status >= 500) console.error('[Promotion] 设置二级推广员失败:', error);
        res.status(status).json({
            success: false,
            message
        });
    }
});

module.exports = router;
