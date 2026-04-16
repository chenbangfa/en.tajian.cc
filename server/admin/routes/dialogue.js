const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const voiceService = require('../../src/services/voice.service');
const aiService = require('../../src/services/ai.service');
const tencentImageService = require('../../src/services/tencent-image.service');

const router = express.Router();

function resolveAdminTtsEngine(req) {
    const engine = voiceService.normalizeEngine(req.body?.engine || req.query?.engine || 'youdao');
    return engine === 'auto' ? 'youdao' : engine;
}

async function generateDialogueLineAudio(line, engine) {
    const voice = line.role === 'guide' ? 'female' : 'male';
    const speed = engine === 'google' ? voiceService.getGoogleTtsSpeed('dialogue') : 1.0;
    return voiceService.textToSpeechByEngine(line.line_en, engine, voice, speed);
}

function sanitizeEnglish(text = '') {
    return String(text || '')
        .replace(/[\u4e00-\u9fff]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildDialogueCoverPrompt(scene = {}, lines = []) {
    const titleEn = sanitizeEnglish(scene.title_en);
    const descriptionEn = sanitizeEnglish(scene.description_en);
    const lineEns = (lines || [])
        .map(line => sanitizeEnglish(line.line_en))
        .filter(Boolean);
    const corpus = [titleEn, descriptionEn, ...lineEns].join(' ').toLowerCase();

    const difficulty = {
        1: 'beginner',
        2: 'intermediate',
        3: 'advanced'
    }[Number(scene.difficulty)] || 'intermediate';

    let setting = 'a clear real-life learning setting';
    let action = 'two people having a natural face-to-face dialogue';
    let details = ['expressive faces', 'clear environment', 'supportive interaction'];

    if (/lost|backpack|school bag|bag|lost-item|lost item/.test(corpus)) {
        if (/train|station|platform/.test(corpus)) {
            setting = 'a train-station lost-and-found desk';
        } else if (/school|teacher|homework/.test(corpus)) {
            setting = 'a school lost-and-found office';
        } else {
            setting = 'a public lost-and-found counter';
        }
        action = 'a worried school-age child reporting a missing school backpack to a helpful adult staff member';
        details = ['a green school backpack', 'a small panda zipper tag', 'a lost-item form on the counter'];
    } else if (/restaurant|menu|order|waiter|food|drink/.test(corpus)) {
        setting = 'a bright family-friendly restaurant';
        action = 'a learner ordering food while a staff member helps politely';
        details = ['menu on the table', 'food or drinks', 'friendly eye contact'];
    } else if (/doctor|hospital|dentist|tooth|fever|clinic/.test(corpus)) {
        setting = 'a clean clinic or consultation room';
        action = 'a child talking to a calm medical worker about a health problem';
        details = ['gentle body language', 'medical desk or chair', 'reassuring atmosphere'];
    } else if (/school|classroom|teacher|homework|library/.test(corpus)) {
        setting = 'a warm classroom or school learning space';
        action = 'a student talking with a teacher or school helper in a realistic school moment';
        details = ['books or worksheets', 'school furniture', 'focused but natural expressions'];
    } else if (/supermarket|shop|store|cashier|buy|shopping/.test(corpus)) {
        setting = 'a supermarket or everyday shop';
        action = 'a learner talking with staff during a shopping moment';
        details = ['shopping basket or products', 'service counter', 'clear everyday setting'];
    } else if (/travel|airport|hotel|passport|check-in|museum/.test(corpus)) {
        setting = 'a travel-related public place';
        action = 'two people solving a travel-related question together';
        details = ['travel props', 'signage or counter', 'clear public environment'];
    }

    const guideRole = sanitizeEnglish(scene.guide_role) || (action.includes('staff member') ? 'helpful adult staff member' : 'guide');
    const userRole = sanitizeEnglish(scene.user_role) || 'school-age child';
    const sampleBeat = lineEns.slice(0, 3).join(' ');

    return [
        'Create a cover illustration for an English dialogue learning scene.',
        titleEn ? `Scene title: "${titleEn}".` : '',
        descriptionEn ? `Story context: ${descriptionEn}.` : '',
        `Setting: ${setting}.`,
        `Characters: one ${guideRole} and one ${userRole}.`,
        `Main action: ${action}.`,
        `Important visual details: ${details.join(', ')}.`,
        sampleBeat ? `Conversation beat reference: ${sampleBeat}` : '',
        `Level: ${difficulty}.`,
        'Style: realistic illustration, warm natural light, medium shot, clear composition, emotionally readable, suitable for learners.',
        'No text, no watermark, no speech bubbles, no subtitles.'
    ].filter(Boolean).join(' ');
}

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

// ===== Categories CRUD =====

router.get('/categories', async (req, res) => {
    try {
        const cats = await query(`
            SELECT c.*,
                   (
                     SELECT COUNT(*)
                     FROM dialogue_scenes s
                     WHERE s.category_id = c.id AND s.is_active = 1
                   ) AS scene_count
            FROM dialogue_categories c
            WHERE c.is_active = 1
            ORDER BY c.group_name ASC, c.sort_order ASC, c.id ASC
        `);
        res.json({ success: true, data: cats });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/categories', async (req, res) => {
    try {
        const { name, icon_emoji, group_name, sort_order } = req.body;
        const result = await query(
            'INSERT INTO dialogue_categories (name, icon_emoji, group_name, sort_order) VALUES (?,?,?,?)',
            [name, icon_emoji || '💬', group_name || '', sort_order || 0]
        );
        res.json({ success: true, id: result.insertId });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/categories/:id', async (req, res) => {
    try {
        const { name, icon_emoji, group_name, sort_order } = req.body;
        await query(
            'UPDATE dialogue_categories SET name=?, icon_emoji=?, group_name=?, sort_order=? WHERE id=?',
            [name, icon_emoji || '💬', group_name || '', sort_order || 0, req.params.id]
        );
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/categories/:id', async (req, res) => {
    try {
        await query('UPDATE dialogue_categories SET is_active = 0 WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== Scene CRUD =====

router.get('/scenes', async (req, res) => {
    try {
        const { category_id } = req.query;
        let sql = `SELECT s.*, c.name as category_name,
            (SELECT COUNT(*) FROM dialogue_lines WHERE scene_id = s.id) as real_line_count,
            (SELECT COUNT(*) FROM dialogue_lines WHERE scene_id = s.id AND audio_url IS NOT NULL AND audio_url != '') as ready_audio_count,
            (SELECT COUNT(*) FROM dialogue_lines WHERE scene_id = s.id AND (audio_url IS NULL OR audio_url = '')) as missing_audio_count
            FROM dialogue_scenes s
            LEFT JOIN dialogue_categories c ON s.category_id = c.id
            WHERE s.is_active=1`;
        const params = [];
        if (category_id) {
            sql += ' AND s.category_id = ?';
            params.push(parseInt(category_id));
        }
        sql += ' ORDER BY s.sort_order ASC, s.id DESC';
        const scenes = await query(sql, params);
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

router.get('/scenes/:id/cover-prompt', async (req, res) => {
    try {
        const [scene] = await query('SELECT * FROM dialogue_scenes WHERE id = ?', [req.params.id]);
        if (!scene) return res.status(404).json({ success: false, message: '场景不存在' });

        const lines = await query(
            'SELECT role, line_en FROM dialogue_lines WHERE scene_id = ? ORDER BY sort_order ASC, id ASC LIMIT 6',
            [req.params.id]
        );

        const prompt = buildDialogueCoverPrompt(scene, lines);
        res.json({ success: true, prompt });
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

// ===== 单条台词 TTS 生成 =====

router.post('/lines/:id/tts', async (req, res) => {
    try {
        const [line] = await query('SELECT id, role, line_en FROM dialogue_lines WHERE id = ?', [req.params.id]);
        if (!line) return res.status(404).json({ success: false, message: '台词不存在' });

        const engine = resolveAdminTtsEngine(req);
        const voice = line.role === 'guide' ? 'female' : 'male';
        const result = await generateDialogueLineAudio(line, engine);
        if (result.success && result.audioUrl) {
            await query('UPDATE dialogue_lines SET audio_url = ? WHERE id = ?', [result.audioUrl, line.id]);
            const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
            const fullUrl = result.audioUrl.startsWith('http') ? result.audioUrl : baseUrl + result.audioUrl;
            return res.json({ success: true, audio_url: fullUrl, voice, engine: result.engine || engine });
        }
        res.status(500).json({ success: false, message: result.error || '生成失败' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== TTS 生成（固定角色发音：guide 女声 / user 男声）=====

router.post('/scenes/:id/tts', async (req, res) => {
    try {
        const engine = resolveAdminTtsEngine(req);
        const lines = await query(
            "SELECT id, role, line_en FROM dialogue_lines WHERE scene_id = ? AND (audio_url IS NULL OR audio_url = '')",
            [req.params.id]
        );
        if (lines.length === 0) return res.json({ success: true, message: '无需生成', generated: 0 });

        let generated = 0;
        for (const line of lines) {
            try {
                const result = await generateDialogueLineAudio(line, engine);
                if (result.success && result.audioUrl) {
                    await query('UPDATE dialogue_lines SET audio_url = ? WHERE id = ?', [result.audioUrl, line.id]);
                    generated++;
                }
            } catch (e) {
                console.error(`[Dialogue TTS] line#${line.id} 失败:`, e.message);
            }
        }

        res.json({ success: true, generated, total: lines.length, engine });
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
        const { prompt, provider = 'gemini' } = req.body;
        if (!prompt) return res.status(400).json({ success: false, message: '请提供描述' });
        const normalizedProvider = String(provider || 'gemini').trim().toLowerCase();
        const result = normalizedProvider === 'tencent'
            ? await tencentImageService.generateImage(prompt)
            : await aiService.generateImage(prompt);
        if (result.success) {
            res.json({ success: true, imageUrl: result.imageUrl, provider: normalizedProvider });
        } else {
            res.status(500).json({ success: false, message: result.error || '生成失败' });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.buildDialogueCoverPrompt = buildDialogueCoverPrompt;

module.exports = router;
