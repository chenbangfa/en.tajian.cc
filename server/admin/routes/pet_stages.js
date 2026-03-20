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

// 获取所有伙伴类型
router.get('/api/types', async (req, res) => {
    try {
        const types = await query('SELECT DISTINCT pet_type FROM pet_growth_stages ORDER BY pet_type');
        res.json({ success: true, data: types.map(t => t.pet_type) });
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
