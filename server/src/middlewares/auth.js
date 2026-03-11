const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../config/database');

// 验证JWT令牌
const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                success: false,
                message: '未提供认证令牌'
            });
        }

        const token = authHeader.substring(7);
        const decoded = jwt.verify(token, config.jwt.secret);

        // 查询用户信息
        const users = await query(
            'SELECT id, openid, nickname, avatar_url, vip_level, vip_expire_date, points FROM users WHERE id = ?',
            [decoded.userId]
        );

        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: '用户不存在'
            });
        }

        req.user = users[0];
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                message: '令牌已过期'
            });
        }
        return res.status(401).json({
            success: false,
            message: '无效的认证令牌'
        });
    }
};

// 可选认证（不强制要求登录）
const optionalAuth = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.substring(7);
            const decoded = jwt.verify(token, config.jwt.secret);

            const users = await query(
                'SELECT id, openid, nickname, avatar_url, vip_level, vip_expire_date, points FROM users WHERE id = ?',
                [decoded.userId]
            );

            if (users.length > 0) {
                req.user = users[0];
            }
        }
        next();
    } catch (error) {
        // 忽略认证错误，继续处理请求
        next();
    }
};

// 检查VIP权限
const requireVip = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: '请先登录'
        });
    }

    const now = new Date();
    const expireDate = new Date(req.user.vip_expire_date);

    if (req.user.vip_level === 0 || expireDate < now) {
        return res.status(403).json({
            success: false,
            message: '此功能需要VIP会员'
        });
    }

    next();
};

// 检查积分
const requirePoints = (pointsNeeded) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: '请先登录'
            });
        }

        if (req.user.points < pointsNeeded) {
            return res.status(403).json({
                success: false,
                message: `积分不足，需要${pointsNeeded}积分`,
                required: pointsNeeded,
                current: req.user.points
            });
        }

        req.pointsToDeduct = pointsNeeded;
        next();
    };
};

module.exports = {
    authMiddleware,
    optionalAuth,
    requireVip,
    requirePoints
};
