const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { query } = require('../../src/config/database');
const aiService = require('../../src/services/ai.service');
const config = require('../../src/config');

const router = express.Router();

// 确保场景表具备小程序码缓存字段
(async function ensureSceneWxacodeColumns() {
    try {
        const columns = [
            { name: 'wxacode_url', ddl: 'VARCHAR(500) DEFAULT NULL COMMENT "场景小程序码URL"' },
            { name: 'wxacode_scene', ddl: 'VARCHAR(120) DEFAULT NULL COMMENT "小程序码scene参数"' },
            { name: 'wxacode_generated_at', ddl: 'DATETIME DEFAULT NULL COMMENT "小程序码生成时间"' }
        ];
        for (const col of columns) {
            const rows = await query('SHOW COLUMNS FROM scenes LIKE ?', [col.name]);
            if (!rows || rows.length === 0) {
                await query(`ALTER TABLE scenes ADD COLUMN ${col.name} ${col.ddl}`);
            }
        }
    } catch (e) {
        console.error('[Scenes] 补齐小程序码字段失败:', e.message);
    }
})();

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
        const { keyword, category_id, without_image, page = 1, limit = 20 } = req.query;
        const pageNum = Math.max(parseInt(page, 10) || 1, 1);
        const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const offset = (pageNum - 1) * pageSize;

        let sql = `
            SELECT s.*, c.name as category_name,
            (SELECT COUNT(*) FROM scene_objects WHERE scene_id = s.id) as object_count
            FROM scenes s
            LEFT JOIN scene_categories c ON s.category_id = c.id
            WHERE 1=1
        `;
        let countSql = `
            SELECT COUNT(*) as total
            FROM scenes s
            WHERE 1=1
        `;
        const params = [];
        const countParams = [];

        if (keyword) {
            sql += ` AND (s.name LIKE ? OR s.name_en LIKE ?)`;
            params.push(`%${keyword}%`, `%${keyword}%`);
            countSql += ` AND (s.name LIKE ? OR s.name_en LIKE ?)`;
            countParams.push(`%${keyword}%`, `%${keyword}%`);
        }

        if (category_id) {
            sql += ` AND s.category_id = ?`;
            params.push(category_id);
            countSql += ` AND s.category_id = ?`;
            countParams.push(category_id);
        }

        if (String(without_image || '') === '1' || String(without_image || '').toLowerCase() === 'true') {
            sql += ` AND (s.image_url IS NULL OR TRIM(s.image_url) = '')`;
            countSql += ` AND (s.image_url IS NULL OR TRIM(s.image_url) = '')`;
        }

        sql += ` ORDER BY s.sort_order ASC, s.created_at DESC LIMIT ? OFFSET ?`;
        params.push(pageSize, offset);

        const [scenes, [countResult]] = await Promise.all([
            query(sql, params),
            query(countSql, countParams)
        ]);

        const total = parseInt(countResult?.total || 0, 10);
        const totalPages = Math.max(Math.ceil(total / pageSize), 1);

        res.json({
            success: true,
            data: {
                items: scenes,
                pagination: {
                    page: pageNum,
                    limit: pageSize,
                    total,
                    total_pages: totalPages,
                    has_prev: pageNum > 1,
                    has_next: pageNum < totalPages
                }
            }
        });
    } catch (error) {
        console.error('获取场景列表错误:', error);
        res.status(500).json({ success: false, message: '获取场景列表失败' });
    }
});

// 1.1 批量补齐：将缺失分类自动创建为“待生成图片”的空场景
router.post('/sync-missing-categories', async (req, res) => {
    try {
        const missingCategories = await query(`
            SELECT c.id, c.name, c.name_en, c.sort_order
            FROM scene_categories c
            WHERE c.is_active = 1
              AND (
                c.parent_id <> 0
                OR NOT EXISTS (
                    SELECT 1 FROM scene_categories ch
                    WHERE ch.parent_id = c.id AND ch.is_active = 1
                )
              )
              AND NOT EXISTS (
                SELECT 1 FROM scenes s WHERE s.category_id = c.id
              )
            ORDER BY c.sort_order ASC, c.id ASC
        `);

        let inserted = 0;
        for (const cat of missingCategories) {
            await query(
                `INSERT INTO scenes
                 (name, name_en, description, category_id, image_url, difficulty_level, is_active, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
                [
                    cat.name || `分类${cat.id}`,
                    cat.name_en || '',
                    '待生成图片',
                    cat.id,
                    null,
                    1,
                    cat.sort_order || 0
                ]
            );
            inserted++;
        }

        res.json({
            success: true,
            message: inserted > 0 ? `已补齐 ${inserted} 个缺失分类场景` : '没有缺失分类需要补齐',
            data: {
                inserted,
                missing_category_ids: missingCategories.map(c => c.id),
                missing_category_names: missingCategories.map(c => c.name)
            }
        });
    } catch (error) {
        console.error('补齐缺失分类场景失败:', error);
        res.status(500).json({ success: false, message: '补齐失败' });
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
            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                await query(
                    'INSERT INTO scene_objects (scene_id, custom_label, position_x, position_y, label_width, label_height, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [sceneId, obj.custom_label, obj.position_x, obj.position_y, obj.label_width, obj.label_height, i]
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

        if (objects && Array.isArray(objects)) {
            // Collect IDs of existing objects that should be kept
            const keepIds = objects.filter(o => o.id).map(o => o.id);

            // Delete objects that are no longer in the list
            if (keepIds.length > 0) {
                await query(
                    `DELETE FROM scene_objects WHERE scene_id = ? AND id NOT IN (${keepIds.map(() => '?').join(',')})`,
                    [id, ...keepIds]
                );
            } else {
                await query('DELETE FROM scene_objects WHERE scene_id = ?', [id]);
            }

            // Update existing or insert new objects, preserving generated data
            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                if (obj.id) {
                    // Update existing object (only position/label/sort_order, preserve audio/phonetic/translation/word_id)
                    await query(
                        'UPDATE scene_objects SET custom_label=?, position_x=?, position_y=?, label_width=?, label_height=?, sort_order=? WHERE id=? AND scene_id=?',
                        [obj.custom_label, obj.position_x, obj.position_y, obj.label_width, obj.label_height, i, obj.id, id]
                    );
                } else {
                    // Insert new object
                    await query(
                        'INSERT INTO scene_objects (scene_id, custom_label, position_x, position_y, label_width, label_height, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [id, obj.custom_label, obj.position_x, obj.position_y, obj.label_width, obj.label_height, i]
                    );
                }
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

// 5. AI 生成图片 (带 prompt 增强)
router.post('/generate-image', async (req, res) => {
    try {
        const { prompt, ai_style, name, name_en, category_id, difficulty_level } = req.body;
        const userPrompt = String(prompt || '').trim();
        if (!userPrompt) {
            return res.status(400).json({ success: false, message: '提示词不能为空' });
        }

        const style = String(ai_style || '').toLowerCase();
        const aiStyle = ['poster', 'scene', 'custom'].includes(style) ? style : 'scene';

        // 查分类信息用于 prompt 增强
        let category_name = '', category_name_en = '', items = '';
        if (category_id) {
            const [cat] = await query(
                'SELECT name, name_en, items FROM scene_categories WHERE id = ?',
                [category_id]
            );
            if (cat) {
                category_name = cat.name || '';
                category_name_en = cat.name_en || '';
                items = cat.items || '';
            }
        }

        const result = await aiService.generateSceneImage(userPrompt, {
            ai_style: aiStyle,
            name: name || '',
            name_en: name_en || '',
            category_name,
            category_name_en,
            difficulty_level: difficulty_level || '',
            items
        });

        if (result.success) {
            res.json({ success: true, imageUrl: result.imageUrl });
        } else {
            res.status(500).json({ success: false, message: result.error });
        }
    } catch (error) {
        console.error('生成场景图片错误:', error.message, error.stack);
        res.status(500).json({ success: false, message: error.message || '生成失败' });
    }
});

// 6. 智能识别 OCR
router.post('/ocr', async (req, res) => {
    try {
        const { imageUrl, engine = 'youdao' } = req.body;

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

// 7. 生成小程序码
router.get('/:id/wxacode', async (req, res) => {
    try {
        const sceneId = req.params.id;
        const force = req.query.force === '1' || req.query.force === 'true';
        const [scene] = await query('SELECT id, wxacode_url, wxacode_scene FROM scenes WHERE id = ?', [sceneId]);
        if (!scene) {
            return res.status(404).json({ success: false, message: '场景不存在' });
        }

        const savedUrl = scene.wxacode_url || '';
        const savedScene = scene.wxacode_scene || `id=${sceneId}`;
        if (!force && savedUrl) {
            if (/^https?:\/\//i.test(savedUrl)) {
                return res.json({ success: true, url: savedUrl, scene: savedScene, cached: true });
            }
            const localPath = path.join(__dirname, '../../', savedUrl);
            if (fs.existsSync(localPath)) {
                return res.json({ success: true, url: savedUrl, scene: savedScene, cached: true });
            }
        }

        // 获取 access_token
        const tokenRes = await axios.get(
            `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${config.wechat.appId}&secret=${config.wechat.secret}`
        );
        if (!tokenRes.data.access_token) {
            return res.status(500).json({ success: false, message: '获取access_token失败', detail: tokenRes.data });
        }

        // 调用 wxacode.getUnlimited 生成小程序码
        const wxRes = await axios.post(
            `https://api.weixin.qq.com/wxa/getwxacodeunlimit?access_token=${tokenRes.data.access_token}`,
            {
                scene: savedScene,
                page: 'pages/scene/detail/detail',
                width: 430,
                auto_color: false,
                line_color: { r: 45, g: 52, b: 54 },
                is_hyaline: false
            },
            { responseType: 'arraybuffer', timeout: 15000 }
        );

        // 微信返回图片二进制或 JSON 错误
        const contentType = wxRes.headers['content-type'];
        if (contentType && contentType.includes('image')) {
            // 保存到本地
            const filename = `wxacode_scene_${sceneId}.png`;
            const savePath = path.join(__dirname, '../../uploads/wxacode');
            if (!fs.existsSync(savePath)) fs.mkdirSync(savePath, { recursive: true });
            const filePath = path.join(savePath, filename);
            fs.writeFileSync(filePath, wxRes.data);
            const url = `/uploads/wxacode/${filename}`;

            await query(
                'UPDATE scenes SET wxacode_url = ?, wxacode_scene = ?, wxacode_generated_at = NOW() WHERE id = ?',
                [url, savedScene, sceneId]
            );

            res.json({ success: true, url, scene: savedScene, cached: false });
        } else {
            const errData = JSON.parse(Buffer.from(wxRes.data).toString());
            res.status(500).json({ success: false, message: errData.errmsg || '生成失败', errcode: errData.errcode });
        }
    } catch (e) {
        console.error('生成小程序码失败:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

// 8. 删除场景
router.delete('/:id', async (req, res) => {
    try {
        // 查询场景图片路径
        const scenes = await query('SELECT image_url FROM scenes WHERE id = ?', [req.params.id]);
        if (scenes.length > 0 && scenes[0].image_url) {
            const imageUrl = scenes[0].image_url;
            // 仅删除本地上传的图片（以 /uploads/ 开头）
            if (imageUrl.startsWith('/uploads/')) {
                const filePath = path.join(__dirname, '../../', imageUrl);
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }
        }

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

// 8.1 更新热点音标/翻译
router.post('/objects/:objId/update-fields', async (req, res) => {
    try {
        const { objId } = req.params;
        const { phonetic, translation } = req.body;
        const sets = [];
        const params = [];
        if (phonetic !== undefined) { sets.push('phonetic = ?'); params.push(phonetic); }
        if (translation !== undefined) { sets.push('translation = ?'); params.push(translation); }
        if (sets.length === 0) return res.json({ success: false, message: '无更新字段' });
        params.push(objId);
        await query(`UPDATE scene_objects SET ${sets.join(', ')} WHERE id = ?`, params);
        res.json({ success: true });
    } catch (e) {
        console.error('更新热点字段失败:', e);
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 9. 生成热点音频和翻译
const voiceService = require('../../src/services/voice.service');

function normalizeHotspotText(text = '') {
    return String(text || '').trim();
}

function normalizePhonetic(phonetic = '') {
    return String(phonetic || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function inferWordContentType(text = '') {
    const t = normalizeHotspotText(text);
    if (!t) return 'word';
    const words = t.split(/\s+/).filter(Boolean);
    if (/[.!?。！？]/.test(t) || words.length >= 5) return 'sentence';
    if (words.length >= 2) return 'phrase';
    return 'word';
}

router.post('/objects/:objId/generate', async (req, res) => {
    try {
        const { objId } = req.params;

        // 获取热点对象
        const [obj] = await query('SELECT * FROM scene_objects WHERE id = ?', [objId]);
        if (!obj) {
            return res.status(404).json({ success: false, message: '热点不存在' });
        }

        const text = normalizeHotspotText(obj.custom_label);
        if (!text) {
            return res.status(400).json({ success: false, message: '热点无文本' });
        }

        // 1) 优先按标准化文本查 words 表（复用）
        const [existingWord] = await query(
            'SELECT * FROM words WHERE LOWER(TRIM(word)) = LOWER(TRIM(?)) ORDER BY id ASC LIMIT 1',
            [text]
        );

        let phonetic = '';
        let translation = '';
        let audioMale = '';
        let audioFemale = '';
        let linkedWordId = null;

        if (existingWord) {
            linkedWordId = existingWord.id;
            // 场景已有数据优先，其次复用 words 数据
            phonetic = normalizePhonetic(obj.phonetic || existingWord.phonetic || '');
            translation = obj.translation || existingWord.translation || '';
            audioMale = obj.audio_url_male || existingWord.audio_url_male || '';
            audioFemale = obj.audio_url_female || existingWord.audio_url_female || '';

            if (!phonetic) {
                const phoneticResult = await aiService.getPhonetic(text);
                if (phoneticResult.success) {
                    phonetic = normalizePhonetic(phoneticResult.phonetic);
                }
            }

            if (!translation) {
                const translateResult = await aiService.translateText(text);
                if (translateResult.success) {
                    translation = translateResult.translation;
                }
            }

            // words 有缺失音频时自动补齐（仅生成缺失项）
            if (!audioMale) {
                try {
                    const maleResult = await voiceService.textToSpeech(text, 'male');
                    if (maleResult.success) audioMale = maleResult.audioUrl;
                } catch (e) {
                    console.error('[Generate] 生成男声音频失败:', e.message);
                }
            }

            if (!audioFemale) {
                try {
                    const femaleResult = await voiceService.textToSpeech(text, 'female');
                    if (femaleResult.success) audioFemale = femaleResult.audioUrl;
                } catch (e) {
                    console.error('[Generate] 生成女声音频失败:', e.message);
                }
            }

            await query(
                `UPDATE words
                 SET phonetic = COALESCE(NULLIF(?, ''), phonetic),
                     translation = COALESCE(NULLIF(?, ''), translation),
                     audio_url_male = COALESCE(NULLIF(?, ''), audio_url_male),
                     audio_url_female = COALESCE(NULLIF(?, ''), audio_url_female),
                     updated_at = NOW()
                 WHERE id = ?`,
                [phonetic, translation, audioMale, audioFemale, linkedWordId]
            );

            // 更新word_id关联
            await query('UPDATE scene_objects SET word_id = ? WHERE id = ?', [linkedWordId, objId]);
            console.log(`[Generate] 关联并补齐已有单词: ${text} -> word_id=${linkedWordId}`);
        } else {
            // 2) words 无匹配时：生成并入 words 基础表
            console.log(`[Generate] words无匹配，生成并入库: ${text}`);

            phonetic = normalizePhonetic(obj.phonetic || '');
            translation = obj.translation || '';
            audioMale = obj.audio_url_male || '';
            audioFemale = obj.audio_url_female || '';

            // 获取音标
            if (!phonetic) {
                const phoneticResult = await aiService.getPhonetic(text);
                if (phoneticResult.success) {
                    phonetic = normalizePhonetic(phoneticResult.phonetic);
                }
            }

            // 获取翻译
            if (!translation) {
                const translateResult = await aiService.translateText(text);
                if (translateResult.success) {
                    translation = translateResult.translation;
                }
            }

            // 生成TTS音频
            try {
                if (!audioMale) {
                    const maleResult = await voiceService.textToSpeech(text, 'male');
                    if (maleResult.success) {
                        audioMale = maleResult.audioUrl;
                    }
                }

                if (!audioFemale) {
                    const femaleResult = await voiceService.textToSpeech(text, 'female');
                    if (femaleResult.success) {
                        audioFemale = femaleResult.audioUrl;
                    }
                }
            } catch (ttsError) {
                console.error('[Generate] TTS错误:', ttsError.message);
                // TTS失败不阻断流程
            }

            const contentType = inferWordContentType(text);
            const insertResult = await query(
                `INSERT INTO words
                 (word, phonetic, translation, content_type, audio_url_male, audio_url_female, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
                [
                    text,
                    phonetic || null,
                    translation || null,
                    contentType,
                    audioMale || null,
                    audioFemale || null
                ]
            );
            linkedWordId = insertResult.insertId;
            console.log(`[Generate] 新增words: ${text} -> word_id=${linkedWordId}`);
        }

        // 3) 回写 scene_objects（与 words 保持同步）
        await query(`
            UPDATE scene_objects 
            SET word_id = ?, phonetic = ?, translation = ?, audio_url_male = ?, audio_url_female = ?
            WHERE id = ?
        `, [linkedWordId || null, phonetic, translation, audioMale, audioFemale, objId]);

        res.json({
            success: true,
            data: {
                id: objId,
                phonetic,
                translation,
                audio_url_male: audioMale,
                audio_url_female: audioFemale,
                linked_word_id: linkedWordId
            }
        });
    } catch (error) {
        console.error('[Generate] 错误:', error);
        res.status(500).json({ success: false, message: '生成失败: ' + error.message });
    }
});

module.exports = router;
