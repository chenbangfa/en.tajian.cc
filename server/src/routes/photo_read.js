const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authMiddleware, requirePoints } = require('../middlewares/auth');
const { query } = require('../config/database');
const aiService = require('../services/ai.service');
const voiceService = require('../services/voice.service');

const router = express.Router();

const POINTS_COST = 10;
const BASE_URL = process.env.BASE_URL || 'https://english.tajian.cc';

// 补全相对路径的域名
function withDomain(url) {
    if (!url) return null;
    if (url.startsWith('http')) return url;
    return BASE_URL + url;
} // 拍摄点读消耗积分

// 文件上传配置
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../../uploads/photo_reads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const suffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, suffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 前端已压缩，服务端给5MB宽裕
    fileFilter: (req, file, cb) => {
        if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('不支持的图片格式，请上传 JPG/PNG/WEBP'));
        }
    }
});

// ─────────────────────────────────────────────
// 分类管理
// ─────────────────────────────────────────────

// 获取用户分类列表
router.get('/categories', authMiddleware, async (req, res) => {
    try {
        const categories = await query(
            'SELECT * FROM user_photo_categories WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC',
            [req.user.id]
        );
        res.json({ success: true, data: categories });
    } catch (err) {
        console.error('获取分类失败:', err);
        res.status(500).json({ success: false, message: '获取分类失败' });
    }
});

// 创建分类
router.post('/categories', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: '请输入分类名称' });
        }
        const result = await query(
            'INSERT INTO user_photo_categories (user_id, name) VALUES (?, ?)',
            [req.user.id, name.trim()]
        );
        res.json({ success: true, data: { id: result.insertId, name: name.trim() } });
    } catch (err) {
        console.error('创建分类失败:', err);
        res.status(500).json({ success: false, message: '创建分类失败' });
    }
});

// 更新分类名称
router.put('/categories/:id', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: '请输入分类名称' });
        }
        const result = await query(
            'UPDATE user_photo_categories SET name = ? WHERE id = ? AND user_id = ?',
            [name.trim(), req.params.id, req.user.id]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: '分类不存在' });
        }
        res.json({ success: true, message: '更新成功' });
    } catch (err) {
        console.error('更新分类失败:', err);
        res.status(500).json({ success: false, message: '更新分类失败' });
    }
});

// 删除分类（图片移至未分类）
router.delete('/categories/:id', authMiddleware, async (req, res) => {
    try {
        await query(
            'UPDATE user_photo_reads SET category_id = 0 WHERE category_id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        await query(
            'DELETE FROM user_photo_categories WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        res.json({ success: true, message: '删除成功，图片已移至未分类' });
    } catch (err) {
        console.error('删除分类失败:', err);
        res.status(500).json({ success: false, message: '删除分类失败' });
    }
});

// ─────────────────────────────────────────────
// 图片列表 & 详情
// ─────────────────────────────────────────────

// 获取用户图片列表（支持分类筛选、分页）
router.get('/list', authMiddleware, async (req, res) => {
    try {
        const { category_id, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let sql = 'SELECT * FROM user_photo_reads WHERE user_id = ?';
        const params = [req.user.id];

        if (category_id !== undefined && category_id !== '') {
            sql += ' AND category_id = ?';
            params.push(parseInt(category_id));
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const photos = await query(sql, params);

        // 总数
        let countSql = 'SELECT COUNT(*) as total FROM user_photo_reads WHERE user_id = ?';
        const countParams = [req.user.id];
        if (category_id !== undefined && category_id !== '') {
            countSql += ' AND category_id = ?';
            countParams.push(parseInt(category_id));
        }
        const [{ total }] = await query(countSql, countParams);

        // 补全图片域名
        photos.forEach(p => { p.image_url = withDomain(p.image_url); });

        res.json({
            success: true,
            data: {
                photos,
                pagination: { page: parseInt(page), limit: parseInt(limit), total }
            }
        });
    } catch (err) {
        console.error('获取图片列表失败:', err);
        res.status(500).json({ success: false, message: '获取图片列表失败' });
    }
});

// 获取单张图片详情（含热点）
router.get('/:id', authMiddleware, async (req, res) => {
    try {
        const [photo] = await query(
            'SELECT * FROM user_photo_reads WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (!photo) {
            return res.status(404).json({ success: false, message: '图片不存在' });
        }
        const objects = await query(
            'SELECT * FROM user_photo_objects WHERE photo_id = ? ORDER BY sort_order ASC, id ASC',
            [req.params.id]
        );

        // 补全域名
        photo.image_url = withDomain(photo.image_url);
        objects.forEach(o => {
            o.audio_url_male = withDomain(o.audio_url_male);
            o.audio_url_female = withDomain(o.audio_url_female);
        });

        res.json({ success: true, data: { ...photo, objects } });
    } catch (err) {
        console.error('获取图片详情失败:', err);
        res.status(500).json({ success: false, message: '获取图片详情失败' });
    }
});

// ─────────────────────────────────────────────
// 上传图片 + OCR识别（核心接口，消耗10积分）
// ─────────────────────────────────────────────
router.post('/upload', authMiddleware, requirePoints(POINTS_COST), upload.single('image'), async (req, res) => {
    const filePath = req.file ? req.file.path : null;
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: '请上传图片' });
        }

        // 生成访问URL（相对路径转为可访问URL）
        const relativePath = req.file.path.replace(path.join(__dirname, '../../'), '');
        const imageUrl = '/' + relativePath.replace(/\\/g, '/');

        // 调用有道OCR识别图片中的英文文字和位置
        const ocrResult = await aiService.youdaoOCR(filePath);

        let objects = [];
        if (ocrResult.success && ocrResult.words && ocrResult.words.length > 0) {
            // 批量翻译英文文字
            const translateTasks = ocrResult.words.map(w =>
                aiService.translateText(w.text)
                    .catch(() => ({ success: false }))
            );
            const translations = await Promise.all(translateTasks);

            objects = ocrResult.words.map((w, i) => ({
                english_text: w.text,
                translation: translations[i]?.success ? translations[i].translation : '',
                phonetic: '',
                position_x: parseFloat(w.rect.x.toFixed(2)),
                position_y: parseFloat(w.rect.y.toFixed(2)),
                width: parseFloat(w.rect.w.toFixed(2)),
                height: parseFloat(w.rect.h.toFixed(2))
            }));
        }

        // 扣除积分
        await query('UPDATE users SET points = points - ? WHERE id = ?', [POINTS_COST, req.user.id]);
        await query(
            'INSERT INTO points_logs (user_id, change_amount, change_type, description) VALUES (?, ?, ?, ?)',
            [req.user.id, -POINTS_COST, 'consume', '拍摄点读：上传识别图片']
        );

        res.json({
            success: true,
            data: {
                image_url: imageUrl,
                file_path: filePath,
                objects,
                ocr_engine: ocrResult.engine || 'youdao',
                points_cost: POINTS_COST
            }
        });
    } catch (err) {
        console.error('上传识别失败:', err);
        // 识别失败时删除已上传文件
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).json({ success: false, message: '图片识别失败，请重试' });
    }
});

// ─────────────────────────────────────────────
// 保存图片（含热点）并异步生成TTS
// ─────────────────────────────────────────────
router.post('/save', authMiddleware, async (req, res) => {
    try {
        const { image_url, title, category_id = 0, objects = [] } = req.body;

        if (!image_url) {
            return res.status(400).json({ success: false, message: '缺少图片地址' });
        }

        // 保存图片记录
        const photoResult = await query(
            `INSERT INTO user_photo_reads (user_id, title, image_url, category_id, objects_count)
             VALUES (?, ?, ?, ?, ?)`,
            [req.user.id, title || null, image_url, parseInt(category_id), objects.length]
        );
        const photoId = photoResult.insertId;

        // 批量插入热点
        if (objects.length > 0) {
            const values = objects.map((o, i) => [
                photoId,
                req.user.id,
                o.english_text || '',
                o.translation || null,
                o.phonetic || null,
                o.position_x !== undefined ? o.position_x : null,
                o.position_y !== undefined ? o.position_y : null,
                o.width !== undefined ? o.width : null,
                o.height !== undefined ? o.height : null,
                i
            ]);
            for (const v of values) {
                await query(
                    `INSERT INTO user_photo_objects
                     (photo_id, user_id, english_text, translation, phonetic, position_x, position_y, width, height, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    v
                );
            }
        }

        res.json({ success: true, data: { photo_id: photoId }, message: '保存成功，正在生成语音...' });

        // 异步生成TTS（不阻塞响应）
        generateTTSForPhoto(photoId, req.user.id).catch(err =>
            console.error(`[TTS] 图片${photoId} TTS生成失败:`, err)
        );
    } catch (err) {
        console.error('保存图片失败:', err);
        res.status(500).json({ success: false, message: '保存失败，请重试' });
    }
});

// ─────────────────────────────────────────────
// 更新图片信息（标题、分类）
// ─────────────────────────────────────────────
router.put('/:id', authMiddleware, async (req, res) => {
    try {
        const { title, category_id } = req.body;
        const fields = [];
        const params = [];

        if (title !== undefined) { fields.push('title = ?'); params.push(title); }
        if (category_id !== undefined) { fields.push('category_id = ?'); params.push(parseInt(category_id)); }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, message: '没有要更新的字段' });
        }

        params.push(req.params.id, req.user.id);
        const result = await query(
            `UPDATE user_photo_reads SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
            params
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ success: false, message: '图片不存在' });
        }
        res.json({ success: true, message: '更新成功' });
    } catch (err) {
        console.error('更新图片失败:', err);
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 删除图片（含热点和文件）
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const [photo] = await query(
            'SELECT * FROM user_photo_reads WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (!photo) {
            return res.status(404).json({ success: false, message: '图片不存在' });
        }

        // 删除热点
        await query('DELETE FROM user_photo_objects WHERE photo_id = ?', [req.params.id]);
        // 删除图片记录
        await query('DELETE FROM user_photo_reads WHERE id = ?', [req.params.id]);

        // 删除实际文件
        if (photo.image_url) {
            const filePath = path.join(__dirname, '../../', photo.image_url);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }

        res.json({ success: true, message: '删除成功' });
    } catch (err) {
        console.error('删除图片失败:', err);
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

// ─────────────────────────────────────────────
// 热点管理
// ─────────────────────────────────────────────

// 更新热点（英文文字可修改，触发重新翻译+重新生成TTS）
router.put('/objects/:id', authMiddleware, async (req, res) => {
    try {
        const { english_text, translation, phonetic } = req.body;

        const [obj] = await query(
            'SELECT upo.*, upr.user_id FROM user_photo_objects upo JOIN user_photo_reads upr ON upr.id = upo.photo_id WHERE upo.id = ?',
            [req.params.id]
        );
        if (!obj || obj.user_id !== req.user.id) {
            return res.status(404).json({ success: false, message: '热点不存在' });
        }

        const textChanged = english_text !== undefined && english_text.trim() !== obj.english_text.trim();
        const fields = [];
        const params = [];

        if (english_text !== undefined) {
            fields.push('english_text = ?');
            params.push(english_text);
            // 只有英文内容真正变化时才清空旧TTS
            if (textChanged) {
                fields.push('audio_url_male = NULL', 'audio_url_female = NULL');
            }
        }
        if (translation !== undefined) { fields.push('translation = ?'); params.push(translation); }
        if (phonetic !== undefined) { fields.push('phonetic = ?'); params.push(phonetic); }

        if (fields.length > 0) {
            params.push(req.params.id);
            await query(`UPDATE user_photo_objects SET ${fields.join(', ')} WHERE id = ?`, params);
        }

        res.json({ success: true, message: '更新成功' });

        // 如果英文文字变了，异步重新翻译并生成TTS
        if (textChanged) {
            (async () => {
                try {
                    const transResult = await aiService.translateText(english_text);
                    if (transResult.success) {
                        await query('UPDATE user_photo_objects SET translation = ? WHERE id = ?',
                            [transResult.translation, req.params.id]);
                    }
                    await regenerateTTSForObject(req.params.id, english_text);
                } catch (e) {
                    console.error('[TTS] 热点更新TTS失败:', e);
                }
            })();
        }
    } catch (err) {
        console.error('更新热点失败:', err);
        res.status(500).json({ success: false, message: '更新失败' });
    }
});

// 删除热点
router.delete('/objects/:id', authMiddleware, async (req, res) => {
    try {
        const [obj] = await query(
            'SELECT upo.*, upr.user_id FROM user_photo_objects upo JOIN user_photo_reads upr ON upr.id = upo.photo_id WHERE upo.id = ?',
            [req.params.id]
        );
        if (!obj || obj.user_id !== req.user.id) {
            return res.status(404).json({ success: false, message: '热点不存在' });
        }
        await query('DELETE FROM user_photo_objects WHERE id = ?', [req.params.id]);
        // 更新热点数量
        await query(
            'UPDATE user_photo_reads SET objects_count = (SELECT COUNT(*) FROM user_photo_objects WHERE photo_id = ?) WHERE id = ?',
            [obj.photo_id, obj.photo_id]
        );
        res.json({ success: true, message: '删除成功' });
    } catch (err) {
        console.error('删除热点失败:', err);
        res.status(500).json({ success: false, message: '删除失败' });
    }
});

// 手动添加热点（用户自己在图片上标注）
router.post('/objects', authMiddleware, async (req, res) => {
    try {
        const { photo_id, english_text, translation, position_x, position_y, width = 10, height = 5 } = req.body;

        if (!photo_id || !english_text) {
            return res.status(400).json({ success: false, message: '缺少必要参数' });
        }

        // 验证图片归属
        const [photo] = await query(
            'SELECT id FROM user_photo_reads WHERE id = ? AND user_id = ?',
            [photo_id, req.user.id]
        );
        if (!photo) {
            return res.status(404).json({ success: false, message: '图片不存在' });
        }

        const result = await query(
            `INSERT INTO user_photo_objects (photo_id, user_id, english_text, translation, position_x, position_y, width, height)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [photo_id, req.user.id, english_text, translation || null,
             position_x || 50, position_y || 50, width, height]
        );

        // 更新热点数量
        await query(
            'UPDATE user_photo_reads SET objects_count = objects_count + 1 WHERE id = ?',
            [photo_id]
        );

        const newObj = {
            id: result.insertId, photo_id, english_text,
            translation, position_x, position_y, width, height
        };

        res.json({ success: true, data: newObj });

        // 异步生成TTS
        regenerateTTSForObject(result.insertId, english_text).catch(e =>
            console.error('[TTS] 新热点TTS失败:', e)
        );
    } catch (err) {
        console.error('添加热点失败:', err);
        res.status(500).json({ success: false, message: '添加失败' });
    }
});

// 手动触发重新生成TTS（针对整张图片）
router.post('/:id/generate-tts', authMiddleware, async (req, res) => {
    try {
        const [photo] = await query(
            'SELECT id FROM user_photo_reads WHERE id = ? AND user_id = ?',
            [req.params.id, req.user.id]
        );
        if (!photo) {
            return res.status(404).json({ success: false, message: '图片不存在' });
        }

        res.json({ success: true, message: 'TTS生成中，稍后刷新即可播放' });

        generateTTSForPhoto(req.params.id, req.user.id).catch(err =>
            console.error(`[TTS] 手动触发TTS失败:`, err)
        );
    } catch (err) {
        console.error('触发TTS失败:', err);
        res.status(500).json({ success: false, message: '触发失败' });
    }
});

// ─────────────────────────────────────────────
// 内部辅助：批量生成一张图片所有热点的TTS
// ─────────────────────────────────────────────
async function generateTTSForPhoto(photoId, userId) {
    const objects = await query(
        'SELECT * FROM user_photo_objects WHERE photo_id = ? AND (audio_url_male IS NULL OR audio_url_female IS NULL)',
        [photoId]
    );

    for (const obj of objects) {
        await regenerateTTSForObject(obj.id, obj.english_text);
    }

    await query('UPDATE user_photo_reads SET tts_generated = 1 WHERE id = ?', [photoId]);
    console.log(`[TTS] 图片 ${photoId} TTS全部生成完毕（共${objects.length}个热点）`);
}

async function regenerateTTSForObject(objId, text) {
    try {
        // 优先查 words 表：完全匹配（不区分大小写）
        const [wordRow] = await query(
            'SELECT audio_url_male, audio_url_female FROM words WHERE LOWER(word) = LOWER(?) AND audio_url_male IS NOT NULL LIMIT 1',
            [text.trim()]
        );

        let maleUrl, femaleUrl;
        if (wordRow && wordRow.audio_url_male) {
            // 直接复用单词表里的音频
            maleUrl = wordRow.audio_url_male;
            femaleUrl = wordRow.audio_url_female || null;
            console.log(`[TTS] 热点 ${objId} 复用单词表音频: ${text}`);
        } else {
            // 调用 TTS 服务生成
            const [maleResult, femaleResult] = await Promise.all([
                voiceService.textToSpeech(text, 'male'),
                voiceService.textToSpeech(text, 'female')
            ]);
            maleUrl = maleResult?.success ? maleResult.audioUrl : null;
            femaleUrl = femaleResult?.success ? femaleResult.audioUrl : null;
            console.log(`[TTS] 热点 ${objId} TTS生成: ${text} male=${!!maleUrl} female=${!!femaleUrl}`);
        }

        await query(
            'UPDATE user_photo_objects SET audio_url_male = ?, audio_url_female = ? WHERE id = ?',
            [maleUrl, femaleUrl, objId]
        );
    } catch (err) {
        console.error(`[TTS] 热点 ${objId} 生成失败:`, err.message);
    }
}

module.exports = router;
