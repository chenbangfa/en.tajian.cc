const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const aiService = require('../../src/services/ai.service');

const router = express.Router();

// Multer Config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads/scenes');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `scene_${Date.now()}${path.extname(file.originalname)}`);
    }
});
const upload = multer({ storage });

// --- API Endpoints ---

// 1. 获取场景列表 (支持搜索和筛选)
router.get('/', async (req, res) => {
    try {
        const { keyword, category_id, page = 1, limit = 20 } = req.query;
        let sql = `
            SELECT s.*, c.name as category_name,
            (SELECT COUNT(*) FROM scene_objects WHERE scene_id = s.id) as object_count
            FROM scenes s
            LEFT JOIN scene_categories c ON s.category_id = c.id
            WHERE 1=1
        `;
        const params = [];

        if (keyword) {
            sql += ` AND (s.name LIKE ? OR s.name_en LIKE ?)`;
            params.push(`%${keyword}%`, `%${keyword}%`);
        }

        if (category_id) {
            sql += ` AND s.category_id = ?`;
            params.push(category_id);
        }

        sql += ` ORDER BY s.sort_order ASC, s.created_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), (page - 1) * parseInt(limit));

        const scenes = await query(sql, params);

        // Count Total (Optional but good practice)
        // const [total] = await query('SELECT COUNT(*) as count FROM scenes ...');

        res.json({ success: true, data: { items: scenes } });
    } catch (error) {
        console.error('获取场景列表错误:', error);
        res.status(500).json({ success: false, message: '获取场景列表失败' });
    }
});

// 2. 获取场景详情
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const [scene] = await query('SELECT * FROM scenes WHERE id = ?', [id]);

        if (!scene) {
            return res.status(404).json({ success: false, message: '场景不存在' });
        }

        res.json({ success: true, data: scene });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取详情失败' });
    }
});

// 2.1 获取场景标注物体
router.get('/:id/objects', async (req, res) => {
    try {
        const objects = await query(`
            SELECT * FROM scene_objects WHERE scene_id = ? ORDER BY sort_order ASC
        `, [req.params.id]);
        res.json({ success: true, data: objects });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取标注失败' });
    }
});


// 3. 创建/更新场景主体 (包含关联 objects 的逻辑)
router.post('/', async (req, res) => {
    try {
        const { name, name_en, category_id, difficulty_level, image_url, objects } = req.body;

        // Insert Scene
        const result = await query(
            'INSERT INTO scenes (name, name_en, category_id, difficulty_level, image_url, is_active) VALUES (?, ?, ?, ?, ?, 1)',
            [name, name_en || '', category_id || 0, difficulty_level || 1, image_url]
        );
        const sceneId = result.insertId;

        // Insert Objects
        if (objects && Array.isArray(objects)) {
            for (const obj of objects) {
                await query(
                    'INSERT INTO scene_objects (scene_id, custom_label, position_x, position_y, label_width, label_height) VALUES (?, ?, ?, ?, ?, ?)',
                    [sceneId, obj.custom_label, obj.position_x, obj.position_y, obj.label_width, obj.label_height]
                );
            }
        }

        res.json({ success: true, message: '创建成功', id: sceneId });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '创建失败' });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, name_en, category_id, difficulty_level, image_url, objects } = req.body;

        await query(
            'UPDATE scenes SET name=?, name_en=?, category_id=?, difficulty_level=?, image_url=? WHERE id=?',
            [name, name_en, category_id, difficulty_level, image_url, id]
        );

        // Replace Objects (Delete all and re-insert for simplicity)
        await query('DELETE FROM scene_objects WHERE scene_id = ?', [id]);

        if (objects && Array.isArray(objects)) {
            for (const obj of objects) {
                await query(
                    'INSERT INTO scene_objects (scene_id, custom_label, position_x, position_y, label_width, label_height) VALUES (?, ?, ?, ?, ?, ?)',
                    [id, obj.custom_label, obj.position_x, obj.position_y, obj.label_width, obj.label_height]
                );
            }
        }

        res.json({ success: true, message: '更新成功' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: '更新失败' });
    }
});


// 4. 图片上传
router.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '无文件' });
    res.json({ success: true, url: `/uploads/scenes/${req.file.filename}` });
});

// 5. AI 生成图片
router.post('/generate-image', async (req, res) => {
    try {
        const { prompt, name } = req.body;
        // 使用场景专属方法，或者通用方法
        const result = await aiService.generateSceneImage(name || 'scene', prompt);

        if (result.success) {
            res.json({ success: true, imageUrl: result.imageUrl });
        } else {
            res.status(500).json({ success: false, message: result.error });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '生成失败' });
    }
});

// 6. 智能识别 OCR
router.post('/ocr', async (req, res) => {
    try {
        const { imageUrl, engine = 'gemini' } = req.body;

        if (!imageUrl) return res.status(400).json({ success: false, message: '无图片地址' });

        // 处理相对路径
        let imagePath = imageUrl;
        if (imageUrl.startsWith('/')) {
            imagePath = path.join(__dirname, '../../', imageUrl);
        }

        const result = await aiService.recognizeImageText(imagePath, engine);
        res.json(result);
    } catch (error) {
        console.error('OCR Error:', error);
        res.status(500).json({ success: false, message: '识别服务错误' });
    }
});

// 7. 删除场景
router.delete('/:id', async (req, res) => {
    try {
        await query('DELETE FROM scene_objects WHERE scene_id = ?', [req.params.id]);
        await query('DELETE FROM scenes WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '删除成功' });
    } catch (e) {
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

// 8. 更新热点标签
router.post('/objects/:objId/update-label', async (req, res) => {
    try {
        const { objId } = req.params;
        const { custom_label } = req.body;

        await query('UPDATE scene_objects SET custom_label = ? WHERE id = ?', [custom_label, objId]);
        res.json({ success: true });
    } catch (e) {
        console.error('更新标签失败:', e);
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 9. 生成热点音频和翻译
const voiceService = require('../../src/services/voice.service');

router.post('/objects/:objId/generate', async (req, res) => {
    try {
        const { objId } = req.params;

        // 获取热点对象
        const [obj] = await query('SELECT * FROM scene_objects WHERE id = ?', [objId]);
        if (!obj) {
            return res.status(404).json({ success: false, message: '热点不存在' });
        }

        const text = obj.custom_label;
        if (!text) {
            return res.status(400).json({ success: false, message: '热点无文本' });
        }

        // 1. 检查是否匹配已有单词
        const [existingWord] = await query(
            'SELECT * FROM words WHERE word = ? LIMIT 1',
            [text.toLowerCase().trim()]
        );

        let phonetic = '';
        let translation = '';
        let audioMale = '';
        let audioFemale = '';

        if (existingWord) {
            // 使用已有单词数据
            phonetic = existingWord.phonetic || '';
            translation = existingWord.translation || '';
            audioMale = existingWord.audio_url_male || '';
            audioFemale = existingWord.audio_url_female || '';

            // 更新word_id关联
            await query('UPDATE scene_objects SET word_id = ? WHERE id = ?', [existingWord.id, objId]);
            console.log(`[Generate] 关联已有单词: ${text} -> word_id=${existingWord.id}`);
        } else {
            // 生成新数据
            console.log(`[Generate] 生成新数据: ${text}`);

            // 获取音标
            const phoneticResult = await aiService.getPhonetic(text);
            if (phoneticResult.success) {
                phonetic = phoneticResult.phonetic;
            }

            // 获取翻译
            const translateResult = await aiService.translateText(text);
            if (translateResult.success) {
                translation = translateResult.translation;
            }

            // 生成TTS音频
            try {
                const maleResult = await voiceService.textToSpeech(text, 'male');
                if (maleResult.success) {
                    audioMale = maleResult.audioUrl;
                }

                const femaleResult = await voiceService.textToSpeech(text, 'female');
                if (femaleResult.success) {
                    audioFemale = femaleResult.audioUrl;
                }
            } catch (ttsError) {
                console.error('[Generate] TTS错误:', ttsError.message);
                // TTS失败不阻断流程
            }
        }

        // 更新scene_objects
        await query(`
            UPDATE scene_objects 
            SET phonetic = ?, translation = ?, audio_url_male = ?, audio_url_female = ?
            WHERE id = ?
        `, [phonetic, translation, audioMale, audioFemale, objId]);

        res.json({
            success: true,
            data: {
                id: objId,
                phonetic,
                translation,
                audio_url_male: audioMale,
                audio_url_female: audioFemale,
                linked_word_id: existingWord?.id || null
            }
        });
    } catch (error) {
        console.error('[Generate] 错误:', error);
        res.status(500).json({ success: false, message: '生成失败: ' + error.message });
    }
});

module.exports = router;
