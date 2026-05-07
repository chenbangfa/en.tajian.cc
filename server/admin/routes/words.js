const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../../src/config/database');
const voiceService = require('../../src/services/voice.service');
const aiService = require('../../src/services/ai.service');

const router = express.Router();

(async () => {
    try {
        await query(`ALTER TABLE words ADD COLUMN translation_audio_url VARCHAR(500) DEFAULT NULL COMMENT '中文词义发音URL' AFTER translation`).catch(() => {});
        await query(`ALTER TABLE words ADD COLUMN example_translation_audio_url VARCHAR(500) DEFAULT NULL COMMENT '中文例句发音URL' AFTER example_translation`).catch(() => {});
    } catch (error) {
        console.error('[Admin Words] 初始化中文音频字段失败:', error.message);
    }
})();

/**
 * 删除本地文件（如果是本地路径）
 * 只删除以 /uploads/ 开头的本地文件，忽略外部URL和空值
 */
function deleteLocalFile(filePath) {
    if (!filePath || !filePath.startsWith('/uploads/')) return;
    const fullPath = path.join(__dirname, '../../', filePath);
    fs.unlink(fullPath, (err) => {
        if (err && err.code !== 'ENOENT') {
            console.error(`[删除文件失败] ${fullPath}:`, err.message);
        }
    });
}

function hasValue(value) {
    return value !== null && value !== undefined && String(value).trim() !== '';
}

async function generateChineseAudioAndSave(wordId, text, field) {
    const speed = voiceService.getGoogleTtsSpeed('default');
    const result = await voiceService.textToSpeechChinese(text, 'female', speed);
    if (!result.success || !result.audioUrl) {
        return {
            success: false,
            statusCode: result.statusCode || 500,
            message: result.error || '中文音频生成失败',
            retryAfterMs: result.retryAfterMs
        };
    }

    const [oldRow] = await query(`SELECT ${field} AS old_audio_url FROM words WHERE id = ?`, [wordId]);
    await query(`UPDATE words SET ${field} = ?, updated_at = NOW() WHERE id = ?`, [result.audioUrl, wordId]);
    if (oldRow?.old_audio_url && oldRow.old_audio_url !== result.audioUrl) {
        deleteLocalFile(oldRow.old_audio_url);
    }
    return { success: true, audioUrl: result.audioUrl };
}

// 获取单词列表（分页）
router.get('/', async (req, res) => {
    try {
        const { category_id, difficulty, search, page = 1, limit = 20, sort, order } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        let sql = `SELECT w.*, c.name as category_name FROM words w 
               LEFT JOIN word_categories c ON w.category_id = c.id WHERE 1=1`;
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

        if (search) {
            sql += ' AND (w.word LIKE ? OR w.translation LIKE ?)';
            countSql += ' AND (word LIKE ? OR translation LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
            countParams.push(`%${search}%`, `%${search}%`);
        }

        // 排序：支持按指定字段排序
        const allowedSortFields = { id: 'w.id', view_count: 'w.view_count', assess_count: 'w.assess_count', created_at: 'w.created_at', word: 'w.word' };
        const sortField = allowedSortFields[sort] || 'w.id';
        const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
        sql += ` ORDER BY ${sortField} ${sortOrder} LIMIT ${parseInt(limit)} OFFSET ${offset}`;

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
        res.status(500).json({ success: false, message: '获取单词列表失败' });
    }
});

// 获取单个单词
router.get('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const words = await query('SELECT * FROM words WHERE id = ?', [id]);

        if (words.length === 0) {
            return res.status(404).json({ success: false, message: '单词不存在' });
        }

        res.json({ success: true, data: words[0] });
    } catch (error) {
        console.error('获取单词错误:', error);
        res.status(500).json({ success: false, message: '获取单词失败' });
    }
});

// 创建单词
router.post('/', async (req, res) => {
    try {
        const {
            word, phonetic, translation, category_id, difficulty_level = 1,
            word_type = 'noun', display_mode = 'image', image_url, audio_url,
            example_sentence, example_translation, image_hint
        } = req.body;

        if (!word || !translation) {
            return res.status(400).json({ success: false, message: '单词和翻译不能为空' });
        }

        const result = await query(`
      INSERT INTO words
      (word, phonetic, translation, category_id, difficulty_level, word_type, display_mode, image_url, audio_url, example_sentence, example_translation, image_hint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
            word,
            phonetic || null,
            translation,
            category_id || null,
            difficulty_level,
            word_type,
            display_mode,
            image_url || null,
            audio_url || null,
            example_sentence || null,
            example_translation || null,
            image_hint || null
        ]);

        res.json({
            success: true,
            data: { id: result.insertId },
            message: '创建成功'
        });
    } catch (error) {
        console.error('创建单词错误:', error);
        res.status(500).json({ success: false, message: '创建单词失败' });
    }
});

// 更新单词（动态更新，只修改前端实际发送的字段）
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 允许更新的字段映射（前端字段名 -> 数据库字段名）
        const allowedFields = {
            word: 'word',
            phonetic: 'phonetic',
            translation: 'translation',
            translation_audio_url: 'translation_audio_url',
            category_id: 'category_id',
            difficulty_level: 'difficulty_level',
            word_type: 'word_type',
            display_mode: 'display_mode',
            image_url: 'image_url',
            audio_url: 'audio_url',
            audio_url_female: 'audio_url_female',
            audio_url_male: 'audio_url_male',
            example_sentence: 'example_sentence',
            example_translation: 'example_translation',
            example_translation_audio_url: 'example_translation_audio_url',
            example_audio_female: 'example_audio_female',
            example_audio_male: 'example_audio_male',
            example_image_url: 'example_image_url',
            grammar_explanation: 'grammar_explanation',
            image_hint: 'image_hint'
        };

        const setClauses = [];
        const params = [];

        for (const [key, dbCol] of Object.entries(allowedFields)) {
            if (req.body[key] !== undefined) {
                setClauses.push(`${dbCol} = ?`);
                // 空字符串转为 null（对于可选字段）
                const val = req.body[key];
                params.push(val === '' ? null : val);
            }
        }

        if (setClauses.length === 0) {
            return res.status(400).json({ success: false, message: '没有需要更新的字段' });
        }

        setClauses.push('updated_at = NOW()');
        params.push(id);

        await query(
            `UPDATE words SET ${setClauses.join(', ')} WHERE id = ?`,
            params
        );

        res.json({ success: true, message: '更新成功' });
    } catch (error) {
        console.error('更新单词错误:', error);
        res.status(500).json({ success: false, message: '更新单词失败: ' + error.message });
    }
});

// 删除单词（同时删除关联文件）
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // 先查询文件路径
        const words = await query('SELECT image_url, example_image_url, audio_url_female, audio_url_male, translation_audio_url, example_translation_audio_url, example_audio_female, example_audio_male FROM words WHERE id = ?', [id]);
        if (words.length > 0) {
            const w = words[0];
            deleteLocalFile(w.image_url);
            deleteLocalFile(w.example_image_url);
            deleteLocalFile(w.translation_audio_url);
            deleteLocalFile(w.audio_url_female);
            deleteLocalFile(w.audio_url_male);
            deleteLocalFile(w.example_translation_audio_url);
            deleteLocalFile(w.example_audio_female);
            deleteLocalFile(w.example_audio_male);
        }

        await query('DELETE FROM words WHERE id = ?', [id]);
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        console.error('删除单词错误:', error);
        res.status(500).json({ success: false, message: '删除单词失败' });
    }
});

// 批量删除单词（同时删除关联文件）
router.post('/batch-delete', async (req, res) => {
    try {
        const { ids } = req.body;

        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(400).json({ success: false, message: '请提供要删除的单词ID列表' });
        }

        const placeholders = ids.map(() => '?').join(',');

        // 查询所有要删除的单词的文件路径
        const words = await query(
            `SELECT id, image_url, example_image_url, translation_audio_url, audio_url_female, audio_url_male, example_translation_audio_url, example_audio_female, example_audio_male FROM words WHERE id IN (${placeholders})`,
            ids
        );

        // 删除关联的本地文件
        let filesDeleted = 0;
        for (const w of words) {
            const files = [w.image_url, w.example_image_url, w.translation_audio_url, w.audio_url_female, w.audio_url_male, w.example_translation_audio_url, w.example_audio_female, w.example_audio_male];
            files.forEach(f => {
                if (f && f.startsWith('/uploads/')) {
                    deleteLocalFile(f);
                    filesDeleted++;
                }
            });
        }

        // 批量删除数据库记录
        const result = await query(`DELETE FROM words WHERE id IN (${placeholders})`, ids);

        res.json({
            success: true,
            message: `已删除 ${result.affectedRows} 个单词，清理了 ${filesDeleted} 个文件`,
            data: { deleted: result.affectedRows, filesDeleted }
        });
    } catch (error) {
        console.error('批量删除单词错误:', error);
        res.status(500).json({ success: false, message: '批量删除失败' });
    }
});

// 设置反义词
router.post('/:id/antonym', async (req, res) => {
    try {
        const { id } = req.params;
        const { antonym_id } = req.body;

        if (!antonym_id || id == antonym_id) {
            return res.status(400).json({ success: false, message: '无效的反义词ID' });
        }

        // 确保 id1 < id2 避免重复
        const [id1, id2] = [parseInt(id), parseInt(antonym_id)].sort((a, b) => a - b);

        await query(
            'INSERT IGNORE INTO antonyms (word_id_1, word_id_2) VALUES (?, ?)',
            [id1, id2]
        );

        res.json({ success: true, message: '反义词设置成功' });
    } catch (error) {
        console.error('设置反义词错误:', error);
        res.status(500).json({ success: false, message: '设置反义词失败' });
    }
});

// ===== 批量语音合成 =====

// 获取缺少音频的单词列表
router.get('/batch-tts/candidates', async (req, res) => {
    try {
        const { voice = 'all', limit = 30 } = req.query;
        const safeLimit = Math.min(100, Math.max(10, parseInt(limit, 10) || 30));
        let where = '1=1';
        if (voice === 'female') where = "(audio_url_female IS NULL OR audio_url_female = '')";
        else if (voice === 'male') where = "(audio_url_male IS NULL OR audio_url_male = '')";
        else where = "(audio_url_female IS NULL OR audio_url_female = '' OR audio_url_male IS NULL OR audio_url_male = '')";

        const words = await query(
            `SELECT id, word, content_type, audio_url_female, audio_url_male
               FROM words WHERE ${where}
              ORDER BY id DESC LIMIT ?`,
            [safeLimit]
        );
        res.json({ success: true, data: words, total: words.length });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 获取需要批量 AI 补全的候选单词
router.get('/batch-enhance/candidates', async (req, res) => {
    try {
        const {
            category_id,
            difficulty,
            word_type,
            search = '',
            limit = 1000
        } = req.query;

        const safeLimit = Math.min(2000, Math.max(50, parseInt(limit, 10) || 1000));
        let sql = `
            SELECT w.id, w.word, w.translation, w.phonetic, w.content_type, w.word_type,
                   w.example_sentence, w.example_translation, w.grammar_explanation,
                   w.image_url, w.updated_at, c.name AS category_name
              FROM words w
              LEFT JOIN word_categories c ON w.category_id = c.id
             WHERE 1=1
        `;
        const params = [];

        if (category_id) {
            sql += ' AND w.category_id = ?';
            params.push(parseInt(category_id, 10));
        }

        if (difficulty) {
            sql += ' AND w.difficulty_level = ?';
            params.push(parseInt(difficulty, 10));
        }

        if (word_type) {
            sql += ' AND w.word_type = ?';
            params.push(word_type);
        }

        if (search && String(search).trim()) {
            sql += ' AND (w.word LIKE ? OR w.translation LIKE ? OR w.example_sentence LIKE ?)';
            const q = `%${String(search).trim()}%`;
            params.push(q, q, q);
        }

        sql += ' ORDER BY w.id DESC LIMIT ?';
        params.push(safeLimit);

        const rows = await query(sql, params);
        const candidates = rows
            .map((w) => {
                const ct = w.content_type || 'word';
                const needPhonetic = !hasValue(w.phonetic) && ct === 'word';
                const hasExample = hasValue(w.example_sentence);
                const needExample = ct !== 'sentence' && !hasExample;
                const needExampleTranslation = !hasValue(w.example_translation);
                const needGrammar = !hasValue(w.grammar_explanation);
                const missingCount = [needPhonetic, needExample, needExampleTranslation, needGrammar].filter(Boolean).length;

                return {
                    ...w,
                    missing: {
                        phonetic: needPhonetic,
                        example_sentence: needExample,
                        example_translation: needExampleTranslation,
                        grammar_explanation: needGrammar
                    },
                    missing_count: missingCount,
                    needs_enhance: missingCount > 0
                };
            })
            .filter((w) => w.needs_enhance);

        res.json({
            success: true,
            data: candidates,
            total: candidates.length,
            limit: safeLimit
        });
    } catch (error) {
        console.error('获取批量 AI 补全候选错误:', error);
        res.status(500).json({ success: false, message: error.message || '获取候选项失败' });
    }
});

// 为单个词生成 TTS
router.post('/batch-tts/generate', async (req, res) => {
    try {
        const { word_id, engine = 'google', voice = 'female' } = req.body;
        if (!word_id) return res.status(400).json({ success: false, message: '缺少 word_id' });

        const [word] = await query('SELECT id, word FROM words WHERE id = ?', [word_id]);
        if (!word) return res.status(404).json({ success: false, message: '单词不存在' });

        const speed = 1.0;
        let result;

        if (engine === 'google') {
            result = await voiceService.googleTextToSpeech(word.word, voice, speed);
        } else {
            // youdao 通过统一入口（会自动 fallback）
            result = await voiceService.textToSpeech(word.word, voice, speed);
        }

        if (!result.success || !result.audioUrl) {
            return res.status(result.statusCode || 500).json({
                success: false,
                message: result.error || '合成失败',
                retryAfterMs: result.retryAfterMs
            });
        }

        const col = voice === 'male' ? 'audio_url_male' : 'audio_url_female';
        await query(`UPDATE words SET ${col} = ? WHERE id = ?`, [result.audioUrl, word_id]);

        res.json({ success: true, audio_url: result.audioUrl });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/:id/generate-translation-audio', async (req, res) => {
    try {
        const { id } = req.params;
        const [word] = await query('SELECT id, translation FROM words WHERE id = ?', [id]);
        if (!word) return res.status(404).json({ success: false, message: '单词不存在' });
        const text = String(req.body?.text || word.translation || '').trim();
        if (!text) return res.status(400).json({ success: false, message: '该单词没有中文词义' });

        const result = await generateChineseAudioAndSave(id, text, 'translation_audio_url');
        if (!result.success) {
            return res.status(result.statusCode || 500).json({
                success: false,
                message: result.message,
                retryAfterMs: result.retryAfterMs
            });
        }

        res.json({ success: true, data: { audio_url: result.audioUrl } });
    } catch (error) {
        console.error('生成中文词义发音错误:', error);
        res.status(500).json({ success: false, message: error.message || '生成失败' });
    }
});

router.post('/:id/generate-example-translation-audio', async (req, res) => {
    try {
        const { id } = req.params;
        const [word] = await query('SELECT id, example_translation FROM words WHERE id = ?', [id]);
        if (!word) return res.status(404).json({ success: false, message: '单词不存在' });
        const text = String(req.body?.text || word.example_translation || '').trim();
        if (!text) return res.status(400).json({ success: false, message: '该单词没有中文例句' });

        const result = await generateChineseAudioAndSave(id, text, 'example_translation_audio_url');
        if (!result.success) {
            return res.status(result.statusCode || 500).json({
                success: false,
                message: result.message,
                retryAfterMs: result.retryAfterMs
            });
        }

        res.json({ success: true, data: { audio_url: result.audioUrl } });
    } catch (error) {
        console.error('生成中文例句发音错误:', error);
        res.status(500).json({ success: false, message: error.message || '生成失败' });
    }
});

// ===== 例句图片 AI 生成 =====
// POST /words/:id/generate-example-image
// body: { image_hint? } 其余字段从 DB 读取（word, translation, example_sentence, example_translation, category）
router.post('/:id/generate-example-image', async (req, res) => {
    try {
        const { id } = req.params;
        const { image_hint: reqHint = '' } = req.body || {};

        const [w] = await query(
            `SELECT w.id, w.word, w.translation, w.example_sentence, w.example_translation,
                    w.image_hint, w.example_image_url,
                    c.name as category, pc.name as parent_category
             FROM words w
             LEFT JOIN word_categories c ON w.category_id = c.id
             LEFT JOIN word_categories pc ON c.parent_id = pc.id
             WHERE w.id = ?`,
            [id]
        );
        if (!w) return res.status(404).json({ success: false, message: '单词不存在' });
        if (!w.example_sentence) return res.status(400).json({ success: false, message: '该单词没有例句，请先补全例句' });

        const category = w.parent_category || w.category || '';
        const image_hint = reqHint || w.image_hint || '';

        console.log(`[Words] 生成例句图: ${w.word} / 例句: ${w.example_sentence.substring(0, 40)}...`);

        const result = await aiService.generateExampleImage(w.word, {
            translation: w.translation,
            example_sentence: w.example_sentence,
            example_translation: w.example_translation,
            category,
            image_hint
        });

        if (!result.success || !result.imageUrl) {
            return res.status(500).json({ success: false, message: result.error || '例句图生成失败' });
        }

        // 删除旧文件（若是本地）
        if (w.example_image_url) deleteLocalFile(w.example_image_url);

        await query('UPDATE words SET example_image_url = ?, updated_at = NOW() WHERE id = ?', [result.imageUrl, id]);

        res.json({ success: true, data: { example_image_url: result.imageUrl } });
    } catch (e) {
        console.error('生成例句图错误:', e);
        res.status(500).json({ success: false, message: e.message || '生成失败' });
    }
});

module.exports = router;
