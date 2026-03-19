const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const voiceService = require('../../src/services/voice.service');
const aiService = require('../../src/services/ai.service');

const router = express.Router();

// Multer for cover image upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../../uploads/dialogue');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `dialogue_cover_${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage });

// ===== Scene CRUD =====

router.get('/scenes', async (req, res) => {
    try {
        const scenes = await query(
            'SELECT * FROM dialogue_scenes WHERE is_active=1 ORDER BY sort_order ASC, id DESC'
        );
        res.json({ success: true, data: scenes });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/scenes/:id', async (req, res) => {
    try {
        const [scene] = await query('SELECT * FROM dialogue_scenes WHERE id = ?', [req.params.id]);
        if (!scene) return res.status(404).json({ success: false, message: '场景不存在' });
        res.json({ success: true, data: scene });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/scenes', async (req, res) => {
    try {
        const { title, title_en, description, guide_role, user_role, difficulty, is_vip, cover_image } = req.body;
        const result = await query(
            'INSERT INTO dialogue_scenes (title, title_en, description, guide_role, user_role, difficulty, is_vip, cover_image) VALUES (?,?,?,?,?,?,?,?)',
            [title, title_en || '', description || '', guide_role || '服务员', user_role || '顾客', difficulty || 1, is_vip || 0, cover_image || null]
        );
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/scenes/:id', async (req, res) => {
    try {
        const { title, title_en, description, guide_role, user_role, difficulty, is_vip, cover_image } = req.body;
        await query(
            'UPDATE dialogue_scenes SET title=?, title_en=?, description=?, guide_role=?, user_role=?, difficulty=?, is_vip=?, cover_image=? WHERE id=?',
            [title, title_en || '', description || '', guide_role || '服务员', user_role || '顾客', difficulty || 1, is_vip || 0, cover_image || null, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/scenes/:id', async (req, res) => {
    try {
        await query('DELETE FROM dialogue_lines WHERE scene_id = ?', [req.params.id]);
        await query('DELETE FROM dialogue_scenes WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== Lines CRUD =====

router.get('/scenes/:id/lines', async (req, res) => {
    try {
        const lines = await query(
            'SELECT * FROM dialogue_lines WHERE scene_id = ? ORDER BY sort_order ASC',
            [req.params.id]
        );
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        const processed = lines.map(l => ({
            ...l,
            audio_url: l.audio_url ? (l.audio_url.startsWith('http') ? l.audio_url : baseUrl + l.audio_url) : null
        }));
        res.json({ success: true, data: processed });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/scenes/:id/lines', async (req, res) => {
    try {
        const { role, line_en, line_cn, sort_order } = req.body;
        const result = await query(
            'INSERT INTO dialogue_lines (scene_id, role, line_en, line_cn, sort_order) VALUES (?,?,?,?,?)',
            [req.params.id, role, line_en, line_cn || '', sort_order || 0]
        );
        // Update line_count
        await query(
            'UPDATE dialogue_scenes SET line_count = (SELECT COUNT(*) FROM dialogue_lines WHERE scene_id = ?) WHERE id = ?',
            [req.params.id, req.params.id]
        );
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/lines/:id', async (req, res) => {
    try {
        const { line_en, line_cn, sort_order } = req.body;
        await query(
            'UPDATE dialogue_lines SET line_en=?, line_cn=?, sort_order=? WHERE id=?',
            [line_en, line_cn || '', sort_order || 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/lines/:id', async (req, res) => {
    try {
        const [line] = await query('SELECT scene_id FROM dialogue_lines WHERE id = ?', [req.params.id]);
        await query('DELETE FROM dialogue_lines WHERE id = ?', [req.params.id]);
        if (line) {
            await query(
                'UPDATE dialogue_scenes SET line_count = (SELECT COUNT(*) FROM dialogue_lines WHERE scene_id = ?) WHERE id = ?',
                [line.scene_id, line.scene_id]
            );
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== TTS 生成（guide 女声 + user 男声）=====

router.post('/scenes/:id/tts', async (req, res) => {
    try {
        const lines = await query(
            "SELECT id, role, line_en FROM dialogue_lines WHERE scene_id = ? AND (audio_url IS NULL OR audio_url = '')",
            [req.params.id]
        );
        if (lines.length === 0) return res.json({ success: true, message: '无需生成', generated: 0 });

        let generated = 0;
        for (const line of lines) {
            try {
                const voice = line.role === 'guide' ? 'female' : 'male';
                const result = await voiceService.textToSpeech(line.line_en, voice, 1.0);
                if (result.success && result.audioUrl) {
                    await query('UPDATE dialogue_lines SET audio_url = ? WHERE id = ?', [result.audioUrl, line.id]);
                    generated++;
                }
            } catch (e) {
                console.error(`[Dialogue TTS] line#${line.id} 失败:`, e.message);
            }
        }

        res.json({ success: true, generated, total: lines.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== 封面图片上传 =====

router.post('/upload-cover', upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '无文件' });

    // Try COS upload
    const cosService = require('../../src/services/cos.service');
    if (cosService.isConfigured) {
        try {
            const fileBuffer = fs.readFileSync(req.file.path);
            const url = await cosService.uploadBuffer(fileBuffer, `images/dialogue_cover_${Date.now()}${path.extname(req.file.originalname)}`);
            fs.unlinkSync(req.file.path);
            return res.json({ success: true, url });
        } catch (e) {
            console.error('[Dialogue] COS上传失败，回退本地:', e.message);
        }
    }

    res.json({ success: true, url: `/uploads/dialogue/${req.file.filename}` });
});

// ===== AI 生成封面 =====

router.post('/generate-cover', async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) return res.status(400).json({ success: false, message: '请提供描述' });
        const result = await aiService.generateImage(prompt);
        if (result.success) {
            res.json({ success: true, imageUrl: result.imageUrl });
        } else {
            res.status(500).json({ success: false, message: result.error || '生成失败' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
