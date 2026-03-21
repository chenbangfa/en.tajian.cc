const express = require('express');
const { query } = require('../config/database');
const { optionalAuth } = require('../middlewares/auth');

const router = express.Router();

// 获取场景列表
router.get('/', optionalAuth, async (req, res) => {
    try {
        const { difficulty, category_id, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let sql = 'SELECT * FROM scenes WHERE is_active = 1';
        let countSql = 'SELECT COUNT(*) as total FROM scenes WHERE is_active = 1';
        const params = [];
        const countParams = [];

        if (difficulty) {
            sql += ' AND difficulty_level = ?';
            countSql += ' AND difficulty_level = ?';
            params.push(parseInt(difficulty));
            countParams.push(parseInt(difficulty));
        }

        if (category_id && category_id != 0) {
            // Filter by category OR its subcategories
            const catId = parseInt(category_id);
            sql += ' AND (category_id = ? OR category_id IN (SELECT id FROM scene_categories WHERE parent_id = ?))';
            countSql += ' AND (category_id = ? OR category_id IN (SELECT id FROM scene_categories WHERE parent_id = ?))';
            params.push(catId, catId);
            countParams.push(catId, catId);
        }

        sql += ' ORDER BY sort_order ASC, id DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);

        const [scenes, countResult] = await Promise.all([
            query(sql, params),
            query(countSql, countParams)
        ]);

        // Prepend base URL to image paths
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        const processedScenes = scenes.map(scene => ({
            ...scene,
            image_url: scene.image_url ? (scene.image_url.startsWith('http') ? scene.image_url : baseUrl + scene.image_url) : null
        }));

        res.json({
            success: true,
            data: {
                list: processedScenes,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countResult[0].total
                }
            }
        });
    } catch (error) {
        console.error('获取场景列表错误:', error);
        res.status(500).json({
            success: false,
            message: '获取场景列表失败'
        });
    }
});

// 获取场景详情（包含物体标注）
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const scenes = await query('SELECT * FROM scenes WHERE id = ? AND is_active = 1', [id]);

        if (scenes.length === 0) {
            return res.status(404).json({
                success: false,
                message: '场景不存在'
            });
        }

        const scene = scenes[0];

        // 获取场景中的物体标注（优先使用scene_objects自身字段，其次使用关联words表）
        const objects = await query(`
      SELECT so.*, 
             COALESCE(so.phonetic, w.phonetic) as phonetic,
             COALESCE(so.translation, w.translation) as translation,
             COALESCE(so.audio_url_female, w.audio_url_female) as audio_url_female,
             COALESCE(so.audio_url_male, w.audio_url_male) as audio_url_male,
             w.word, w.audio_url as word_audio_url
      FROM scene_objects so
      LEFT JOIN words w ON so.word_id = w.id
      WHERE so.scene_id = ?
      ORDER BY so.sort_order ASC
    `, [id]);

        // 获取上一页和下一页ID（同分类优先，到头后跨分类）
        const catId = scene.category_id;
        // 同分类内找上一张/下一张
        let [prev] = await query(
            'SELECT id FROM scenes WHERE category_id = ? AND id < ? AND is_active = 1 ORDER BY id DESC LIMIT 1', [catId, id]
        );
        let [next] = await query(
            'SELECT id FROM scenes WHERE category_id = ? AND id > ? AND is_active = 1 ORDER BY id ASC LIMIT 1', [catId, id]
        );
        // 同分类没有了，跨分类：找相邻分类的第一张/最后一张
        if (!prev) {
            // 上一个分类的最后一张
            const [prevCross] = await query(
                `SELECT s.id FROM scenes s
                 WHERE s.is_active = 1 AND (
                   s.category_id < ? OR (s.category_id = ? AND s.id < ?)
                 ) ORDER BY s.category_id DESC, s.id DESC LIMIT 1`, [catId, catId, id]
            );
            prev = prevCross;
        }
        if (!next) {
            // 下一个分类的第一张
            const [nextCross] = await query(
                `SELECT s.id FROM scenes s
                 WHERE s.is_active = 1 AND (
                   s.category_id > ? OR (s.category_id = ? AND s.id > ?)
                 ) ORDER BY s.category_id ASC, s.id ASC LIMIT 1`, [catId, catId, id]
            );
            next = nextCross;
        }
        scene.prev_id = prev ? prev.id : null;
        scene.next_id = next ? next.id : null;

        // Prepend base URL to paths
        const baseUrl = process.env.BASE_URL || 'https://en.tajian.cc';
        if (scene.image_url && !scene.image_url.startsWith('http')) {
            scene.image_url = baseUrl + scene.image_url;
        }

        // Process objects - add baseUrl to audio URLs
        scene.objects = objects.map(obj => {
            const processed = { ...obj };
            if (processed.audio_url_female && !processed.audio_url_female.startsWith('http')) {
                processed.audio_url_female = baseUrl + processed.audio_url_female;
            }
            if (processed.audio_url_male && !processed.audio_url_male.startsWith('http')) {
                processed.audio_url_male = baseUrl + processed.audio_url_male;
            }
            if (processed.word_audio_url && !processed.word_audio_url.startsWith('http')) {
                processed.word_audio_url = baseUrl + processed.word_audio_url;
            }
            return processed;
        });

        res.json({
            success: true,
            data: scene
        });
    } catch (error) {
        console.error('获取场景详情错误:', error);
        res.status(500).json({
            success: false,
            message: '获取场景详情失败'
        });
    }
});

// 语音评测 (Mock API)
const upload = require('multer')({ dest: 'uploads/audio/' });
router.post('/evaluate', optionalAuth, upload.single('audio'), async (req, res) => {
    try {
        const { word, text } = req.body;
        // Mock Assessment Logic
        // In real world, send req.file.path to Tencent Cloud SOE or Azure Speech

        const mockScore = Math.floor(Math.random() * (100 - 80 + 1)) + 80; // Random 80-100

        // Cleanup temp file
        // if (req.file) fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            data: {
                score: mockScore,
                feedback: mockScore > 90 ? 'Excellent!' : 'Good job!',
                detail: {
                    fluency: mockScore,
                    accuracy: mockScore,
                    integrity: 100
                }
            }
        });
    } catch (error) {
        console.error('语音评测错误:', error);
        res.status(500).json({ success: false, message: '评测失败' });
    }
});

module.exports = router;
