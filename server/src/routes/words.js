const express = require('express');
const { query } = require('../config/database');
const { authMiddleware, optionalAuth } = require('../middlewares/auth');
const voiceService = require('../services/voice.service');

const router = express.Router();

// 获取单词列表
router.get('/', optionalAuth, async (req, res) => {
    try {
        const { category_id, difficulty, word_type, search, page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let sql = `
      SELECT w.*, c.name as category_name 
      FROM words w 
      LEFT JOIN word_categories c ON w.category_id = c.id 
      WHERE 1=1
    `;
        let countSql = 'SELECT COUNT(*) as total FROM words WHERE 1=1';
        const params = [];
        const countParams = [];

        if (category_id) {
            sql += ' AND w.category_id = ?';
            countSql += ' AND category_id = ?';
            params.push(parseInt(category_id));
            countParams.push(parseInt(category_id));
        }

        if (difficulty) {
            sql += ' AND w.difficulty_level = ?';
            countSql += ' AND difficulty_level = ?';
            params.push(parseInt(difficulty));
            countParams.push(parseInt(difficulty));
        }

        if (word_type) {
            sql += ' AND w.word_type = ?';
            countSql += ' AND word_type = ?';
            params.push(word_type);
            countParams.push(word_type);
        }

        if (search) {
            sql += ' AND (w.word LIKE ? OR w.translation LIKE ?)';
            countSql += ' AND (word LIKE ? OR translation LIKE ?)';
            const searchPattern = `%${search}%`;
            params.push(searchPattern, searchPattern);
            countParams.push(searchPattern, searchPattern);
        }

        // 排序：热门优先（浏览量降序），同浏览量按添加时间正序（最早添加的先显示）
        sql += ` ORDER BY w.view_count DESC, w.created_at ASC LIMIT ${parseInt(limit)} OFFSET ${offset}`;

        const [words, countResult] = await Promise.all([
            query(sql, params),
            query(countSql, countParams)
        ]);

        res.json({
            success: true,
            data: {
                list: words,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total: countResult[0].total
                }
            }
        });
    } catch (error) {
        console.error('获取单词列表错误:', error);
        res.status(500).json({
            success: false,
            message: '获取单词列表失败'
        });
    }
});

// 获取单个单词详情
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const words = await query(`
      SELECT w.*, c.name as category_name 
      FROM words w 
      LEFT JOIN word_categories c ON w.category_id = c.id 
      WHERE w.id = ?
    `, [id]);

        if (words.length === 0) {
            return res.status(404).json({
                success: false,
                message: '单词不存在'
            });
        }

        const word = words[0];

        // 异步增加浏览量（不阻塞响应）
        query('UPDATE words SET view_count = view_count + 1 WHERE id = ?', [id]).catch(() => {});

        // 获取反义词
        const antonyms = await query(`
      SELECT w.* FROM words w
      INNER JOIN antonyms a ON (a.word_id_1 = w.id OR a.word_id_2 = w.id)
      WHERE (a.word_id_1 = ? OR a.word_id_2 = ?) AND w.id != ?
    `, [id, id, id]);

        word.antonyms = antonyms;

        // 记录学习进度（如果登录）
        if (req.user) {
            await query(`
        INSERT INTO word_learning_records (user_id, word_id, learn_count, last_learned_at)
        VALUES (?, ?, 1, NOW())
        ON DUPLICATE KEY UPDATE 
          learn_count = learn_count + 1,
          last_learned_at = NOW()
      `, [req.user.id, id]);
        }

        res.json({
            success: true,
            data: word
        });
    } catch (error) {
        console.error('获取单词详情错误:', error);
        res.status(500).json({
            success: false,
            message: '获取单词详情失败'
        });
    }
});

/**
 * 自动补全缺失的音频
 * POST /words/:id/ensure-audio
 * 
 * 小程序进入单词详情页时调用。
 * 后台异步生成缺失的音频（单词男女声、例句男女声），不阻塞前端。
 * 返回: { success: true, generating: ['audio_url_female', ...], word: {...} }
 */
router.post('/:id/ensure-audio', optionalAuth, async (req, res) => {
    try {
        const { id } = req.params;

        // 查询当前单词的音频状态
        const words = await query('SELECT id, word, example_sentence, audio_url_female, audio_url_male, example_audio_female, example_audio_male FROM words WHERE id = ?', [id]);
        if (words.length === 0) {
            return res.status(404).json({ success: false, message: '单词不存在' });
        }

        const w = words[0];
        const missing = [];

        // 检测缺失的音频
        if (!w.audio_url_female) missing.push({ field: 'audio_url_female', text: w.word, voice: 'female' });
        if (!w.audio_url_male) missing.push({ field: 'audio_url_male', text: w.word, voice: 'male' });
        if (w.example_sentence) {
            if (!w.example_audio_female) missing.push({ field: 'example_audio_female', text: w.example_sentence, voice: 'female' });
            if (!w.example_audio_male) missing.push({ field: 'example_audio_male', text: w.example_sentence, voice: 'male' });
        }

        if (missing.length === 0) {
            return res.json({ success: true, generating: [], message: '音频已完整' });
        }

        // 先立即返回，告知前端哪些在生成
        const generatingFields = missing.map(m => m.field);
        res.json({
            success: true,
            generating: generatingFields,
            message: `正在后台生成 ${missing.length} 个音频`
        });

        // 后台异步逐个生成（有道限速 3000次/小时 ≈ 0.8s/次，用2s间隔留余量）
        (async () => {
            const INTERVAL = 2000;
            for (let i = 0; i < missing.length; i++) {
                const item = missing[i];
                try {
                    console.log(`[AutoAudio] 生成 word#${w.id} ${item.field} (${item.voice})...`);
                    const result = await voiceService.textToSpeech(item.text, item.voice);
                    if (result.success && result.audioUrl) {
                        await query(`UPDATE words SET ${item.field} = ?, updated_at = NOW() WHERE id = ?`, [result.audioUrl, w.id]);
                        console.log(`[AutoAudio] ✅ word#${w.id} ${item.field} 完成 (${result.engine || 'unknown'})`);
                    } else {
                        console.log(`[AutoAudio] ❌ word#${w.id} ${item.field} 失败: ${result.error}`);
                    }
                } catch (e) {
                    console.log(`[AutoAudio] ❌ word#${w.id} ${item.field} 异常: ${e.message}`);
                }
                // 限速间隔（最后一个不需要等）
                if (i < missing.length - 1) {
                    await new Promise(r => setTimeout(r, INTERVAL));
                }
            }
            console.log(`[AutoAudio] word#${w.id} "${w.word}" 全部处理完毕`);
        })().catch(e => console.error('[AutoAudio] 后台任务异常:', e));

    } catch (error) {
        console.error('ensure-audio 错误:', error);
        res.status(500).json({ success: false, message: '检查音频失败' });
    }
});

// 随机获取单词（用于学习）
router.get('/random/:count', optionalAuth, async (req, res) => {
    try {
        const { count } = req.params;
        const { category_id, difficulty } = req.query;
        const wordCount = Math.min(parseInt(count) || 10, 50);

        let sql = 'SELECT * FROM words WHERE 1=1';
        const params = [];

        if (category_id) {
            sql += ' AND category_id = ?';
            params.push(parseInt(category_id));
        }

        if (difficulty) {
            sql += ' AND difficulty_level = ?';
            params.push(parseInt(difficulty));
        }

        sql += ` ORDER BY RAND() LIMIT ${wordCount}`;

        const words = await query(sql, params);

        res.json({
            success: true,
            data: words
        });
    } catch (error) {
        console.error('获取随机单词错误:', error);
        res.status(500).json({
            success: false,
            message: '获取随机单词失败'
        });
    }
});

module.exports = router;
