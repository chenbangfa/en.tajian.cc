const express = require('express');
const bcrypt = require('bcrypt');
const { query } = require('../../src/config/database');

const router = express.Router();

// 登录
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                success: false,
                message: '请输入用户名和密码'
            });
        }

        // 查询用户
        const users = await query(
            'SELECT * FROM admin_users WHERE username = ? AND is_active = TRUE',
            [username]
        );

        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: '用户名或密码错误'
            });
        }

        const user = users[0];

        // 验证密码
        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                message: '用户名或密码错误'
            });
        }

        // 更新最后登录时间
        await query(
            'UPDATE admin_users SET last_login_at = NOW() WHERE id = ?',
            [user.id]
        );

        // 设置session
        req.session.adminUser = {
            id: user.id,
            username: user.username,
            displayName: user.display_name
        };

        res.json({
            success: true,
            message: '登录成功',
            data: {
                username: user.username,
                displayName: user.display_name
            }
        });

    } catch (error) {
        console.error('登录错误:', error);
        res.status(500).json({
            success: false,
            message: '服务器错误'
        });
    }
});

// 登出
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({
                success: false,
                message: '登出失败'
            });
        }
        res.json({
            success: true,
            message: '已登出'
        });
    });
});

// 获取当前用户信息
router.get('/me', (req, res) => {
    if (!req.session.adminUser) {
        return res.status(401).json({
            success: false,
            message: '未登录'
        });
    }
    res.json({
        success: true,
        data: req.session.adminUser
    });
});

// 修改密码
router.post('/change-password', async (req, res) => {
    try {
        if (!req.session.adminUser) {
            return res.status(401).json({
                success: false,
                message: '未登录'
            });
        }

        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: '请输入当前密码和新密码'
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: '新密码长度至少6位'
            });
        }

        // 查询当前用户
        const users = await query(
            'SELECT * FROM admin_users WHERE id = ?',
            [req.session.adminUser.id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: '用户不存在'
            });
        }

        const user = users[0];

        // 验证当前密码
        const isValid = await bcrypt.compare(currentPassword, user.password_hash);
        if (!isValid) {
            return res.status(400).json({
                success: false,
                message: '当前密码错误'
            });
        }

        // 生成新密码hash
        const newHash = await bcrypt.hash(newPassword, 10);

        // 更新密码
        await query(
            'UPDATE admin_users SET password_hash = ? WHERE id = ?',
            [newHash, user.id]
        );

        res.json({
            success: true,
            message: '密码修改成功'
        });

    } catch (error) {
        console.error('修改密码错误:', error);
        res.status(500).json({
            success: false,
            message: '服务器错误'
        });
    }
});

module.exports = router;
