const express = require('express');
const fs = require('fs');
const path = require('path');
const { query } = require('../../src/config/database');

const router = express.Router();

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
            example_audio_female: 'example_audio_female',
            example_audio_male: 'example_audio_male',
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
        const words = await query('SELECT image_url, audio_url_female, audio_url_male, example_audio_female, example_audio_male FROM words WHERE id = ?', [id]);
        if (words.length > 0) {
            const w = words[0];
            deleteLocalFile(w.image_url);
            deleteLocalFile(w.audio_url_female);
            deleteLocalFile(w.audio_url_male);
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
            `SELECT id, image_url, audio_url_female, audio_url_male, example_audio_female, example_audio_male FROM words WHERE id IN (${placeholders})`,
            ids
        );

        // 删除关联的本地文件
        let filesDeleted = 0;
        for (const w of words) {
            const files = [w.image_url, w.audio_url_female, w.audio_url_male, w.example_audio_female, w.example_audio_male];
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

module.exports = router;
