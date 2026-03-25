const express = require('express');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const config = require('../config');
const { query } = require('../config/database');

const router = express.Router();

// 微信小程序登录
router.post('/login', async (req, res) => {
    try {
        const { code } = req.body;

        if (!code) {
            return res.status(400).json({
                success: false,
                message: '缺少登录code'
            });
        }

        // 调用微信API获取openid
        const wxResponse = await axios.get('https://api.weixin.qq.com/sns/jscode2session', {
            params: {
                appid: config.wechat.appId,
                secret: config.wechat.secret,
                js_code: code,
                grant_type: 'authorization_code'
            }
        });

        const { openid, session_key, unionid } = wxResponse.data;

        if (!openid) {
            return res.status(400).json({
                success: false,
                message: '微信登录失败',
                error: wxResponse.data
            });
        }

        // 查询或创建用户
        let users = await query('SELECT * FROM users WHERE openid = ?', [openid]);
        let userId;

        if (users.length === 0) {
            // 新用户注册
            const result = await query(
                'INSERT INTO users (openid, unionid, points) VALUES (?, ?, ?)',
                [openid, unionid || null, 500] // 新用户赠送500积分
            );
            userId = result.insertId;
        } else {
            userId = users[0].id;
        }

        // 生成JWT令牌
        const token = jwt.sign(
            { userId, openid },
            config.jwt.secret,
            { expiresIn: config.jwt.expiresIn }
        );

        // 获取用户信息
        users = await query('SELECT * FROM users WHERE id = ?', [userId]);
        const user = users[0];

        res.json({
            success: true,
            data: {
                token,
                user: {
                    id: user.id,
                    nickname: user.nickname,
                    avatar_url: user.avatar_url,
                    vip_level: user.vip_level,
                    vip_expire_date: user.vip_expire_date,
                    points: user.points
                }
            }
        });
    } catch (error) {
        console.error('登录错误:', error);
        res.status(500).json({
            success: false,
            message: '登录失败'
        });
    }
});

// 更新用户信息
router.put('/profile', require('../middlewares/auth').authMiddleware, async (req, res) => {
    try {
        const { nickname, avatar_url } = req.body;
        const userId = req.user.id;

        await query(
            'UPDATE users SET nickname = ?, avatar_url = ?, updated_at = NOW() WHERE id = ?',
            [nickname, avatar_url, userId]
        );

        res.json({
            success: true,
            message: '更新成功'
        });
    } catch (error) {
        console.error('更新用户信息错误:', error);
        res.status(500).json({
            success: false,
            message: '更新失败'
        });
    }
});

// 开发环境测试登录（绕过微信）
if (config.nodeEnv === 'development') {
    router.post('/dev-login', async (req, res) => {
        try {
            const { openid } = req.body;
            const testOpenid = openid || 'dev_test_user_001';

            let users = await query('SELECT * FROM users WHERE openid = ?', [testOpenid]);
            let userId;

            if (users.length === 0) {
                const result = await query(
                    'INSERT INTO users (openid, nickname, points) VALUES (?, ?, ?)',
                    [testOpenid, '测试用户', 1000]
                );
                userId = result.insertId;
            } else {
                userId = users[0].id;
            }

            const token = jwt.sign(
                { userId, openid: testOpenid },
                config.jwt.secret,
                { expiresIn: config.jwt.expiresIn }
            );

            users = await query('SELECT * FROM users WHERE id = ?', [userId]);
            const user = users[0];

            res.json({
                success: true,
                data: {
                    token,
                    user: {
                        id: user.id,
                        nickname: user.nickname,
                        avatar_url: user.avatar_url,
                        vip_level: user.vip_level,
                        points: user.points
                    }
                }
            });
        } catch (error) {
            console.error('开发登录错误:', error);
            res.status(500).json({
                success: false,
                message: '登录失败'
            });
        }
    });
}

module.exports = router;
