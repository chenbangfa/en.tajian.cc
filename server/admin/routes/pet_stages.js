const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');

// Multer 配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../../uploads/pet-stages');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `stage_${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ══════════════════════════════
//  伙伴类型管理
// ══════════════════════════════

// 获取所有伙伴类型（从 pet_types 表）
router.get('/api/types', async (req, res) => {
    try {
        const types = await query('SELECT * FROM pet_types ORDER BY sort_order ASC, id ASC');
        res.json({ success: true, data: types });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 新增伙伴类型
router.post('/api/types', async (req, res) => {
    try {
        const { type_key, name, icon, sort_order } = req.body;
        if (!type_key || !name) return res.json({ success: false, message: '请填写标识和名称' });

        const result = await query(
            'INSERT INTO pet_types (type_key, name, icon, sort_order) VALUES (?, ?, ?, ?)',
            [type_key.toLowerCase().replace(/[^a-z0-9_]/g, ''), name, icon || '', sort_order || 0]
        );
        res.json({ success: true, data: { id: result.insertId } });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.json({ success: false, message: '该标识已存在' });
        res.status(500).json({ success: false, message: '创建失败' });
    }
});

// 编辑伙伴类型
router.put('/api/types/:id', async (req, res) => {
    try {
        const { name, icon, sort_order, is_active } = req.body;
        await query(
            'UPDATE pet_types SET name = ?, icon = ?, sort_order = ?, is_active = ? WHERE id = ?',
            [name, icon || '', sort_order || 0, is_active !== undefined ? (is_active ? 1 : 0) : 1, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 删除伙伴类型
router.delete('/api/types/:id', async (req, res) => {
    try {
        // 检查是否有用户在使用
        const [typeRow] = await query('SELECT type_key FROM pet_types WHERE id = ?', [req.params.id]);
        if (typeRow) {
            const [used] = await query('SELECT COUNT(*) as cnt FROM user_pet WHERE pet_type = ?', [typeRow.type_key]);
            if (used && used.cnt > 0) {
                return res.json({ success: false, message: `有 ${used.cnt} 个用户正在使用该类型，无法删除` });
            }
        }
        await query('DELETE FROM pet_types WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

// ══════════════════════════════
//  成长阶段管理
// ══════════════════════════════

// 列表（按 pet_type 分组）
router.get('/api/list', async (req, res) => {
    try {
        const { pet_type } = req.query;
        let sql = 'SELECT * FROM pet_growth_stages';
        const params = [];
        if (pet_type) {
            sql += ' WHERE pet_type = ?';
            params.push(pet_type);
        }
        sql += ' ORDER BY pet_type, stage ASC';
        const stages = await query(sql, params);
        res.json({ success: true, data: stages });
    } catch (e) {
        res.status(500).json({ success: false, message: '加载失败' });
    }
});

// 新增阶段
router.post('/api/create', async (req, res) => {
    try {
        const { pet_type, stage, stage_name, required_points, unlock_message, description, animation_type } = req.body;
        const result = await query(
            `INSERT INTO pet_growth_stages (pet_type, stage, stage_name, required_points, unlock_message, description, animation_type, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [pet_type, stage, stage_name, required_points || 0, unlock_message || '', description || '', animation_type || 'image', stage]
        );
        res.json({ success: true, data: { id: result.insertId } });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') {
            return res.json({ success: false, message: '该类型的此阶段已存在' });
        }
        res.status(500).json({ success: false, message: '创建失败' });
    }
});

// 编辑阶段
router.put('/api/:id', async (req, res) => {
    try {
        const { stage_name, required_points, unlock_message, description, animation_type } = req.body;
        await query(
            `UPDATE pet_growth_stages SET stage_name = ?, required_points = ?,
             unlock_message = ?, description = ?, animation_type = ? WHERE id = ?`,
            [stage_name, required_points, unlock_message || '', description || '', animation_type || 'image', req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 删除阶段
router.delete('/api/:id', async (req, res) => {
    try {
        await query('DELETE FROM pet_growth_stages WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

// 上传图片/动画
router.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '无文件' });
    const url = `/uploads/pet-stages/${req.file.filename}`;

    // 如果指定了 stage_id，直接更新
    const { stage_id, field } = req.body;
    if (stage_id) {
        const col = field === 'animation' ? 'animation_url' : 'image_url';
        query(`UPDATE pet_growth_stages SET ${col} = ? WHERE id = ?`, [url, stage_id])
            .then(() => res.json({ success: true, url }))
            .catch(() => res.json({ success: true, url }));
    } else {
        res.json({ success: true, url });
    }
});

module.exports = router;
