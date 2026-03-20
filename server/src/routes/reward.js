const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../config/database');
const { authMiddleware } = require('../middlewares/auth');
const rewardService = require('../services/reward.service');

const PARENT_SECRET = process.env.JWT_SECRET || 'english-learning-secret';

// ─── Multer 配置（奖品图片） ───
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../../uploads/rewards');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `prize_${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── 建表 ───
(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS parent_settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            manage_password VARCHAR(255) NOT NULL,
            flower_name VARCHAR(20) DEFAULT '小红花',
            flower_icon VARCHAR(10) DEFAULT '🌸',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_user (user_id)
        )`);

        await query(`CREATE TABLE IF NOT EXISTS user_pet (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            pet_type VARCHAR(20) NOT NULL,
            pet_name VARCHAR(50) DEFAULT '',
            growth_points INT DEFAULT 0,
            growth_stage INT DEFAULT 1,
            health_status VARCHAR(20) DEFAULT 'healthy',
            last_activity_date DATE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_user (user_id)
        )`);

        await query(`CREATE TABLE IF NOT EXISTS pet_types (
            id INT AUTO_INCREMENT PRIMARY KEY,
            type_key VARCHAR(30) NOT NULL UNIQUE,
            name VARCHAR(50) NOT NULL,
            icon VARCHAR(10) DEFAULT '',
            sort_order INT DEFAULT 0,
            is_active TINYINT(1) DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);

        // 预置默认伙伴类型
        const defaultTypes = [
            ['flower', '花', '🌸', 1],
            ['tree', '树', '🌳', 2],
            ['cat', '猫', '🐱', 3],
            ['dog', '狗', '🐕', 4]
        ];
        for (const t of defaultTypes) {
            await query(
                'INSERT IGNORE INTO pet_types (type_key, name, icon, sort_order) VALUES (?, ?, ?, ?)',
                t
            );
        }

        await query(`CREATE TABLE IF NOT EXISTS pet_growth_stages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            pet_type VARCHAR(20) NOT NULL,
            stage INT NOT NULL,
            stage_name VARCHAR(50) NOT NULL,
            required_points INT NOT NULL,
            image_url VARCHAR(500),
            animation_url VARCHAR(500),
            animation_type VARCHAR(20) DEFAULT 'image',
            unlock_message VARCHAR(200),
            description VARCHAR(200),
            sort_order INT DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_type_stage (pet_type, stage)
        )`);

        await query(`CREATE TABLE IF NOT EXISTS reward_rules (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            rule_type VARCHAR(30) NOT NULL,
            threshold INT DEFAULT 0,
            flowers INT DEFAULT 1,
            growth INT DEFAULT 1,
            enabled TINYINT(1) DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uk_user_rule (user_id, rule_type)
        )`);

        await query(`CREATE TABLE IF NOT EXISTS flower_transactions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            amount INT NOT NULL,
            growth_amount INT DEFAULT 0,
            balance_after INT NOT NULL,
            source_type VARCHAR(30) NOT NULL,
            source_id INT DEFAULT NULL,
            description VARCHAR(200),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user_time (user_id, created_at)
        )`);

        await query(`CREATE TABLE IF NOT EXISTS reward_prizes (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            image_url VARCHAR(500),
            cost INT NOT NULL,
            stock INT DEFAULT -1,
            is_active TINYINT(1) DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_user (user_id)
        )`);

        await query(`CREATE TABLE IF NOT EXISTS reward_exchanges (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            prize_id INT,
            prize_name VARCHAR(100),
            prize_image_url VARCHAR(500),
            cost INT NOT NULL,
            status VARCHAR(20) DEFAULT 'pending',
            child_note VARCHAR(500),
            parent_note VARCHAR(500),
            fulfilled_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user_status (user_id, status)
        )`);

        // 预置成长阶段（如果为空）
        const [countRow] = await query('SELECT COUNT(*) as cnt FROM pet_growth_stages');
        if (countRow.cnt === 0) {
            const stages = [
                // flower
                ['flower', 1, '种子', 0, '开始你的成长之旅！', '一颗充满希望的种子'],
                ['flower', 2, '发芽', 50, '你的努力开始生根发芽了！', '嫩绿的小芽破土而出'],
                ['flower', 3, '小苗', 200, '越来越茁壮了！', '小苗在阳光下成长'],
                ['flower', 4, '含苞', 500, '就快要开花啦！', '花苞含苞待放'],
                ['flower', 5, '盛开', 1000, '太棒了，花开了！', '美丽的花朵绽放'],
                ['flower', 6, '花园', 2000, '你创造了一个美丽的花园！', '繁花似锦的小花园'],
                // tree
                ['tree', 1, '种子', 0, '种下一颗希望的种子！', '一颗小小的树种'],
                ['tree', 2, '嫩芽', 50, '生命开始萌动！', '破土而出的嫩芽'],
                ['tree', 3, '小树', 200, '小树苗在茁壮成长！', '枝叶渐渐茂盛'],
                ['tree', 4, '大树', 500, '已经长成一棵大树了！', '枝繁叶茂的大树'],
                ['tree', 5, '开花', 1000, '大树开花了，真美！', '繁花满枝的大树'],
                ['tree', 6, '硕果', 2000, '硕果累累，丰收啦！', '果实挂满枝头'],
                // cat
                ['cat', 1, '小奶猫', 0, '一只小奶猫来到了你身边！', '软萌可爱的小奶猫'],
                ['cat', 2, '小猫', 50, '小猫咪出生啦！', '软萌的小奶猫'],
                ['cat', 3, '少年猫', 200, '小猫在快乐成长！', '活泼好动的少年猫'],
                ['cat', 4, '成年猫', 500, '已经是优雅的大猫了！', '优雅自信的成年猫'],
                ['cat', 5, '国王猫', 1000, '猫咪戴上了皇冠！', '威风凛凛的国王猫'],
                ['cat', 6, '传说猫', 2000, '传说中的神猫降临！', '拥有神秘力量的传说猫'],
                // dog
                ['dog', 1, '小奶狗', 0, '一只小奶狗来到了你身边！', '摇尾巴的小奶狗'],
                ['dog', 2, '小狗', 50, '汪汪！小狗出生了！', '摇尾巴的小奶狗'],
                ['dog', 3, '少年狗', 200, '小狗越来越强壮！', '充满活力的少年狗'],
                ['dog', 4, '成年狗', 500, '忠诚可靠的好伙伴！', '帅气的成年狗'],
                ['dog', 5, '导盲犬', 1000, '狗狗成为了助人英雄！', '佩戴勋章的导盲犬'],
                ['dog', 6, '传说狗', 2000, '传说中的神犬降临！', '拥有神秘力量的传说狗']
            ];
            for (const s of stages) {
                await query(
                    `INSERT IGNORE INTO pet_growth_stages (pet_type, stage, stage_name, required_points, unlock_message, description, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [s[0], s[1], s[2], s[3], s[4], s[5], s[1]]
                );
            }
        }

        console.log('[Reward] 表初始化完成');
    } catch (e) {
        console.error('[Reward] 建表失败:', e);
    }
})();

// ─── 家长 token 验证中间件 ───
function parentAuth(req, res, next) {
    const token = req.headers['parent-token'];
    if (!token) return res.status(403).json({ success: false, message: '需要家长验证' });
    try {
        const decoded = jwt.verify(token, PARENT_SECRET);
        if (decoded.userId !== req.user.id) {
            return res.status(403).json({ success: false, message: '验证失效' });
        }
        next();
    } catch (e) {
        return res.status(403).json({ success: false, message: '验证已过期，请重新输入密码' });
    }
}

// ════════════════════════════════════════
//  花园端
// ════════════════════════════════════════

// 花园主页数据
router.get('/garden', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const [pet] = await query('SELECT * FROM user_pet WHERE user_id = ?', [userId]);

        if (!pet) {
            return res.json({ success: true, data: { hasPet: false } });
        }

        // 当前阶段
        const [currentStage] = await query(
            'SELECT * FROM pet_growth_stages WHERE pet_type = ? AND stage = ?',
            [pet.pet_type, pet.growth_stage]
        );

        // 下一阶段
        const [nextStage] = await query(
            `SELECT * FROM pet_growth_stages WHERE pet_type = ? AND stage > ?
             ORDER BY stage ASC LIMIT 1`,
            [pet.pet_type, pet.growth_stage]
        );

        // 余额
        const balance = await rewardService.getBalance(userId);

        // 今日获得
        const today = new Date().toISOString().slice(0, 10);
        const [todayStats] = await query(
            `SELECT COALESCE(SUM(amount), 0) as flowers, COALESCE(SUM(growth_amount), 0) as growth
             FROM flower_transactions WHERE user_id = ? AND amount > 0 AND DATE(created_at) = ?`,
            [userId, today]
        );

        // 花名设置
        const [settings] = await query(
            'SELECT flower_name, flower_icon FROM parent_settings WHERE user_id = ?',
            [userId]
        );

        res.json({
            success: true,
            data: {
                hasPet: true,
                pet,
                currentStage,
                nextStage,
                balance,
                todayFlowers: todayStats.flowers,
                todayGrowth: todayStats.growth,
                flowerName: settings ? settings.flower_name : '小红花',
                flowerIcon: settings ? settings.flower_icon : '🌸'
            }
        });
    } catch (e) {
        console.error('[Reward] garden error:', e);
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 选择伙伴
router.post('/garden/pet', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { pet_type, pet_name } = req.body;

        // 动态校验伙伴类型
        const [typeRow] = await query('SELECT type_key FROM pet_types WHERE type_key = ? AND is_active = 1', [pet_type]);
        if (!typeRow) {
            return res.json({ success: false, message: '无效的伙伴类型' });
        }

        const [existing] = await query('SELECT id FROM user_pet WHERE user_id = ?', [userId]);
        if (existing) {
            return res.json({ success: false, message: '已经有伙伴了' });
        }

        const today = new Date().toISOString().slice(0, 10);
        await query(
            `INSERT INTO user_pet (user_id, pet_type, pet_name, growth_points, growth_stage, health_status, last_activity_date)
             VALUES (?, ?, ?, 0, 1, 'healthy', ?)`,
            [userId, pet_type, pet_name || '', today]
        );

        // 创建默认规则
        const defaultRules = [
            ['checkin_complete', 0, 5, 5],
            ['high_score', 90, 1, 1],
            ['streak_days', 7, 20, 20],
            ['book_complete', 0, 3, 3]
        ];
        for (const r of defaultRules) {
            await query(
                `INSERT IGNORE INTO reward_rules (user_id, rule_type, threshold, flowers, growth)
                 VALUES (?, ?, ?, ?, ?)`,
                [userId, r[0], r[1], r[2], r[3]]
            );
        }

        res.json({ success: true });
    } catch (e) {
        console.error('[Reward] create pet error:', e);
        res.status(500).json({ success: false, message: '创建失败' });
    }
});

// 获取所有可选伙伴类型
router.get('/garden/types', authMiddleware, async (req, res) => {
    try {
        const types = await query(
            'SELECT type_key, name, icon FROM pet_types WHERE is_active = 1 ORDER BY sort_order ASC'
        );
        // 为每个类型附加 stage 1 的图片
        for (const t of types) {
            const [stage1] = await query(
                'SELECT image_url FROM pet_growth_stages WHERE pet_type = ? AND stage = 1',
                [t.type_key]
            );
            t.image_url = stage1 ? stage1.image_url : null;
        }
        res.json({ success: true, data: types });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 获取某类型所有阶段
router.get('/garden/stages', authMiddleware, async (req, res) => {
    try {
        const { pet_type } = req.query;
        const stages = await query(
            'SELECT * FROM pet_growth_stages WHERE pet_type = ? ORDER BY stage ASC',
            [pet_type || 'flower']
        );
        res.json({ success: true, data: stages });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 小红花流水
router.get('/flowers', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;

        const list = await query(
            `SELECT * FROM flower_transactions WHERE user_id = ?
             ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [userId, limit, offset]
        );
        res.json({ success: true, data: list });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 奖品列表
router.get('/shop', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const prizes = await query(
            'SELECT * FROM reward_prizes WHERE user_id = ? AND is_active = 1 ORDER BY created_at DESC',
            [userId]
        );
        res.json({ success: true, data: prizes });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 兑换
router.post('/exchange', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { prize_id, child_note } = req.body;

        const [prize] = await query(
            'SELECT * FROM reward_prizes WHERE id = ? AND user_id = ? AND is_active = 1',
            [prize_id, userId]
        );
        if (!prize) return res.json({ success: false, message: '奖品不存在' });

        if (prize.stock === 0) return res.json({ success: false, message: '奖品已兑完' });

        // 扣花
        const deductResult = await rewardService.deductFlowers(
            userId, prize.cost, null, `兑换「${prize.name}」`
        );
        if (!deductResult.success) return res.json(deductResult);

        // 创建兑换记录
        const result = await query(
            `INSERT INTO reward_exchanges (user_id, prize_id, prize_name, prize_image_url, cost, child_note)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, prize.id, prize.name, prize.image_url, prize.cost, child_note || '']
        );

        // 更新流水的 source_id
        await query(
            `UPDATE flower_transactions SET source_id = ?
             WHERE user_id = ? AND source_type = 'exchange' ORDER BY id DESC LIMIT 1`,
            [result.insertId, userId]
        );

        // 扣库存
        if (prize.stock > 0) {
            await query('UPDATE reward_prizes SET stock = stock - 1 WHERE id = ?', [prize.id]);
        }

        res.json({ success: true, data: { exchangeId: result.insertId, balance: deductResult.balance } });
    } catch (e) {
        console.error('[Reward] exchange error:', e);
        res.status(500).json({ success: false, message: '兑换失败' });
    }
});

// 兑换记录
router.get('/exchanges', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const list = await query(
            'SELECT * FROM reward_exchanges WHERE user_id = ? ORDER BY created_at DESC',
            [userId]
        );
        res.json({ success: true, data: list });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// ════════════════════════════════════════
//  家长管理端
// ════════════════════════════════════════

// 首次设置密码
router.post('/parent/setup', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { password } = req.body;
        if (!password || password.length < 4) {
            return res.json({ success: false, message: '密码至少4位' });
        }

        const [existing] = await query('SELECT id FROM parent_settings WHERE user_id = ?', [userId]);
        if (existing) return res.json({ success: false, message: '已设置密码，请使用验证接口' });

        const hash = await bcrypt.hash(password, 10);
        await query(
            'INSERT INTO parent_settings (user_id, manage_password) VALUES (?, ?)',
            [userId, hash]
        );

        const token = jwt.sign({ userId, type: 'parent' }, PARENT_SECRET, { expiresIn: '30m' });
        res.json({ success: true, data: { token } });
    } catch (e) {
        console.error('[Reward] parent setup error:', e);
        res.status(500).json({ success: false, message: '设置失败' });
    }
});

// 验证密码
router.post('/parent/verify', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { password } = req.body;

        const [settings] = await query('SELECT * FROM parent_settings WHERE user_id = ?', [userId]);
        if (!settings) return res.json({ success: false, message: '未设置密码', needSetup: true });

        const match = await bcrypt.compare(password, settings.manage_password);
        if (!match) return res.json({ success: false, message: '密码错误' });

        const token = jwt.sign({ userId, type: 'parent' }, PARENT_SECRET, { expiresIn: '30m' });
        res.json({ success: true, data: { token } });
    } catch (e) {
        res.status(500).json({ success: false, message: '验证失败' });
    }
});

// 检查是否已设置密码
router.get('/parent/check', authMiddleware, async (req, res) => {
    try {
        const [settings] = await query('SELECT id FROM parent_settings WHERE user_id = ?', [req.user.id]);
        res.json({ success: true, data: { hasPassword: !!settings } });
    } catch (e) {
        res.status(500).json({ success: false, message: '检查失败' });
    }
});

// 获取设置
router.get('/parent/settings', authMiddleware, parentAuth, async (req, res) => {
    try {
        const [settings] = await query(
            'SELECT flower_name, flower_icon FROM parent_settings WHERE user_id = ?',
            [req.user.id]
        );
        res.json({ success: true, data: settings || { flower_name: '小红花', flower_icon: '🌸' } });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 更新设置
router.put('/parent/settings', authMiddleware, parentAuth, async (req, res) => {
    try {
        const { flower_name, flower_icon } = req.body;
        await query(
            'UPDATE parent_settings SET flower_name = ?, flower_icon = ? WHERE user_id = ?',
            [flower_name || '小红花', flower_icon || '🌸', req.user.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 修改密码
router.put('/parent/password', authMiddleware, parentAuth, async (req, res) => {
    try {
        const { old_password, new_password } = req.body;
        if (!new_password || new_password.length < 4) {
            return res.json({ success: false, message: '新密码至少4位' });
        }

        const [settings] = await query('SELECT manage_password FROM parent_settings WHERE user_id = ?', [req.user.id]);
        const match = await bcrypt.compare(old_password, settings.manage_password);
        if (!match) return res.json({ success: false, message: '原密码错误' });

        const hash = await bcrypt.hash(new_password, 10);
        await query('UPDATE parent_settings SET manage_password = ? WHERE user_id = ?', [hash, req.user.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '修改失败' });
    }
});

// 规则列表
router.get('/parent/rules', authMiddleware, parentAuth, async (req, res) => {
    try {
        const rules = await query('SELECT * FROM reward_rules WHERE user_id = ? ORDER BY id', [req.user.id]);
        res.json({ success: true, data: rules });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 更新规则
router.put('/parent/rules/:id', authMiddleware, parentAuth, async (req, res) => {
    try {
        const { flowers, growth, threshold, enabled } = req.body;
        await query(
            `UPDATE reward_rules SET flowers = ?, growth = ?, threshold = ?, enabled = ?
             WHERE id = ? AND user_id = ?`,
            [flowers, growth, threshold, enabled ? 1 : 0, req.params.id, req.user.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 奖品列表
router.get('/parent/prizes', authMiddleware, parentAuth, async (req, res) => {
    try {
        const prizes = await query(
            'SELECT * FROM reward_prizes WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]
        );
        res.json({ success: true, data: prizes });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 新增奖品
router.post('/parent/prizes', authMiddleware, parentAuth, upload.single('image'), async (req, res) => {
    try {
        const { name, cost, stock } = req.body;
        const image_url = req.file ? `/uploads/rewards/${req.file.filename}` : null;

        const result = await query(
            'INSERT INTO reward_prizes (user_id, name, image_url, cost, stock) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, name, image_url, parseInt(cost), parseInt(stock) || -1]
        );
        res.json({ success: true, data: { id: result.insertId } });
    } catch (e) {
        res.status(500).json({ success: false, message: '添加失败' });
    }
});

// 编辑奖品
router.put('/parent/prizes/:id', authMiddleware, parentAuth, upload.single('image'), async (req, res) => {
    try {
        const { name, cost, stock, is_active } = req.body;
        let sql = 'UPDATE reward_prizes SET name = ?, cost = ?, stock = ?, is_active = ?';
        const params = [name, parseInt(cost), parseInt(stock) || -1, is_active !== undefined ? (is_active ? 1 : 0) : 1];

        if (req.file) {
            sql += ', image_url = ?';
            params.push(`/uploads/rewards/${req.file.filename}`);
        }

        sql += ' WHERE id = ? AND user_id = ?';
        params.push(req.params.id, req.user.id);

        await query(sql, params);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 删除奖品
router.delete('/parent/prizes/:id', authMiddleware, parentAuth, async (req, res) => {
    try {
        await query('DELETE FROM reward_prizes WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

// 待审核兑换
router.get('/parent/exchanges', authMiddleware, parentAuth, async (req, res) => {
    try {
        const list = await query(
            `SELECT * FROM reward_exchanges WHERE user_id = ? ORDER BY
             CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC`,
            [req.user.id]
        );
        res.json({ success: true, data: list });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 审核兑换
router.put('/parent/exchanges/:id', authMiddleware, parentAuth, async (req, res) => {
    try {
        const { status, parent_note } = req.body;
        if (!['fulfilled', 'rejected'].includes(status)) {
            return res.json({ success: false, message: '无效状态' });
        }

        const [exchange] = await query(
            'SELECT * FROM reward_exchanges WHERE id = ? AND user_id = ? AND status = ?',
            [req.params.id, req.user.id, 'pending']
        );
        if (!exchange) return res.json({ success: false, message: '记录不存在或已处理' });

        if (status === 'rejected') {
            // 退还小红花
            await rewardService.giftFlowers(req.user.id, exchange.cost, 0, `兑换「${exchange.prize_name}」被拒绝，退还`);
        }

        await query(
            `UPDATE reward_exchanges SET status = ?, parent_note = ?, fulfilled_at = ?
             WHERE id = ?`,
            [status, parent_note || '', status === 'fulfilled' ? new Date() : null, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '操作失败' });
    }
});

// 手动赠花
router.post('/parent/gift', authMiddleware, parentAuth, async (req, res) => {
    try {
        const { flowers, growth, description } = req.body;
        const result = await rewardService.giftFlowers(
            req.user.id,
            parseInt(flowers) || 1,
            parseInt(growth) || 1,
            description || '家长奖励'
        );
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, message: '赠送失败' });
    }
});

module.exports = router;
