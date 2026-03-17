/**
 * 磨耳朵（Podcast）管理路由
 */
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../../src/config/database');
const voiceService = require('../../src/services/voice.service');
const config = require('../../src/config');

// ==================== 分类管理 ====================

// 获取所有分类
router.get('/categories', async (req, res) => {
    try {
        const categories = await query(
            'SELECT * FROM podcast_categories ORDER BY sort_order, id'
        );
        res.json({ success: true, data: categories });
    } catch (error) {
        console.error('获取播客分类失败:', error);
        res.status(500).json({ success: false, message: '获取分类失败' });
    }
});

// 创建分类
router.post('/categories', async (req, res) => {
    try {
        const { name, name_en, icon, description, sort_order = 0 } = req.body;

        if (!name) {
            return res.status(400).json({ success: false, message: '分类名称不能为空' });
        }

        const result = await query(
            `INSERT INTO podcast_categories (name, name_en, icon, description, sort_order) 
             VALUES (?, ?, ?, ?, ?)`,
            [name, name_en, icon, description, sort_order]
        );

        res.json({ success: true, data: { id: result.insertId }, message: '创建成功' });
    } catch (error) {
        console.error('创建播客分类失败:', error);
        res.status(500).json({ success: false, message: '创建分类失败' });
    }
});

// 更新分类
router.put('/categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, name_en, icon, description, sort_order, is_active } = req.body;

        await query(
            `UPDATE podcast_categories 
             SET name = ?, name_en = ?, icon = ?, description = ?, sort_order = ?, is_active = ?
             WHERE id = ?`,
            [name, name_en, icon, description, sort_order, is_active !== false, id]
        );

        res.json({ success: true, message: '更新成功' });
    } catch (error) {
        console.error('更新播客分类失败:', error);
        res.status(500).json({ success: false, message: '更新分类失败' });
    }
});

// 删除分类
router.delete('/categories/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM podcast_categories WHERE id = ?', [id]);
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        console.error('删除播客分类失败:', error);
        res.status(500).json({ success: false, message: '删除分类失败' });
    }
});

// ==================== 内容管理 ====================

// 获取内容列表
router.get('/', async (req, res) => {
    try {
        const { category_id, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        let sql = `SELECT c.id, c.title, c.title_en, c.category_id, c.difficulty_level,
                          c.is_free, c.sort_order, c.male_audio_url, c.female_audio_url, c.chinese_audio_url,
                          CASE WHEN c.sentences_data = 'processing' THEN -1
                               WHEN c.sentences_data IS NOT NULL THEN 1
                               ELSE 0 END as has_sentences,
                          cat.name as category_name,
                          cat.parent_id as category_parent_id,
                          pcat.name as parent_category_name
                   FROM podcast_contents c
                   LEFT JOIN podcast_categories cat ON c.category_id = cat.id
                   LEFT JOIN podcast_categories pcat ON cat.parent_id = pcat.id`;
        const params = [];

        if (category_id) {
            sql += ' WHERE c.category_id = ?';
            params.push(category_id);
        }

        sql += ' ORDER BY c.sort_order, c.id DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const contents = await query(sql, params);

        // 获取总数
        let countSql = 'SELECT COUNT(*) as total FROM podcast_contents';
        if (category_id) {
            countSql += ' WHERE category_id = ?';
        }
        const [{ total }] = await query(countSql, category_id ? [category_id] : []);

        res.json({
            success: true,
            data: {
                list: contents,
                total,
                page: parseInt(page),
                limit: parseInt(limit)
            }
        });
    } catch (error) {
        console.error('获取播客内容失败:', error);
        res.status(500).json({ success: false, message: '获取内容失败' });
    }
});

// 获取单个内容
router.get('/:id', async (req, res) => {
    try {
        const [content] = await query(
            `SELECT c.*, cat.name as category_name 
             FROM podcast_contents c 
             LEFT JOIN podcast_categories cat ON c.category_id = cat.id 
             WHERE c.id = ?`,
            [req.params.id]
        );

        if (!content) {
            return res.status(404).json({ success: false, message: '内容不存在' });
        }

        if (content.sentences_data && content.sentences_data !== 'processing') {
            try { content.sentences_data = JSON.parse(content.sentences_data); } catch (e) { content.sentences_data = null; }
        } else if (content.sentences_data === 'processing') {
            content.sentences_data = { processing: true };
        }

        res.json({ success: true, data: content });
    } catch (error) {
        console.error('获取播客内容失败:', error);
        res.status(500).json({ success: false, message: '获取内容失败' });
    }
});

// 创建内容
router.post('/', async (req, res) => {
    try {
        const {
            title, title_en, category_id, difficulty_level = 1,
            content_text, translation, is_free = true, sort_order = 0
        } = req.body;

        if (!title || !content_text) {
            return res.status(400).json({ success: false, message: '标题和内容不能为空' });
        }

        // 注意：如果数据库仍有 category ENUM 字段且非空，这里可能需要传入一个默认值
        // 建议执行迁移将 category 字段设为 NULL 或删除
        const result = await query(
            `INSERT INTO podcast_contents 
             (title, title_en, category_id, difficulty_level, content_text, translation, is_free, sort_order, category) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                title,
                title_en || null,
                category_id || null, // 允许为空
                difficulty_level,
                content_text,
                translation || null,
                is_free,
                sort_order,
                'stories' // Legacy category field fallback
            ]
        );

        res.json({ success: true, data: { id: result.insertId }, message: '创建成功' });
    } catch (error) {
        console.error('创建播客内容失败:', error);
        res.status(500).json({ success: false, message: '创建内容失败' });
    }
});

// 更新内容
router.put('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            title, title_en, category_id, difficulty_level,
            content_text, translation, is_free, sort_order
        } = req.body;

        // 构建更新字段，避免覆盖未传的音频字段
        const updates = [
            title,
            title_en || null,
            category_id || null,
            difficulty_level,
            content_text,
            translation || null,
            is_free,
            sort_order,
            id
        ];

        await query(
            `UPDATE podcast_contents SET
             title = ?, title_en = ?, category_id = ?, difficulty_level = ?,
             content_text = ?, translation = ?, is_free = ?, sort_order = ?
             WHERE id = ?`,
            updates
        );

        res.json({ success: true, message: '更新成功' });
    } catch (error) {
        console.error('更新播客内容失败:', error);
        res.status(500).json({ success: false, message: '更新内容失败' });
    }
});

// 删除内容
router.delete('/:id', async (req, res) => {
    try {
        await query('DELETE FROM podcast_contents WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        console.error('删除播客内容失败:', error);
        res.status(500).json({ success: false, message: '删除内容失败' });
    }
});

// ==================== 音频生成 ====================

// 生成单个音频
router.post('/generate-audio', async (req, res) => {
    try {
        const { content_id, voice_type } = req.body;

        if (!content_id || !voice_type) {
            return res.status(400).json({ success: false, message: '缺少参数' });
        }

        const [content] = await query(
            'SELECT content_text, translation FROM podcast_contents WHERE id = ?',
            [content_id]
        );

        if (!content) {
            return res.status(404).json({ success: false, message: '内容不存在' });
        }

        let text, voice;
        if (voice_type === 'chinese') {
            text = content.translation;
            voice = 'female';
        } else {
            text = content.content_text;
            voice = voice_type;
        }

        if (!text) {
            return res.status(400).json({ success: false, message: '文本内容为空' });
        }

        console.log(`[Podcast] 生成${voice_type}音频: ${text.substring(0, 50)}...`);

        const result = await voiceService.textToSpeech(text, voice, voice_type === 'chinese' ? 'zh-CN' : 'en-US');

        if (!result.success) {
            return res.status(500).json({ success: false, message: result.error || '音频生成失败' });
        }

        const updateField = voice_type === 'male' ? 'male_audio_url' :
            voice_type === 'female' ? 'female_audio_url' : 'chinese_audio_url';

        await query(`UPDATE podcast_contents SET ${updateField} = ? WHERE id = ?`, [result.audioUrl, content_id]);

        res.json({ success: true, data: { audio_url: result.audioUrl }, message: '音频生成成功' });
    } catch (error) {
        console.error('生成播客音频失败:', error);
        res.status(500).json({ success: false, message: '音频生成失败' });
    }
});

// 批量生成所有音频
router.post('/generate-all-audio', async (req, res) => {
    try {
        const { content_id } = req.body;

        const [content] = await query(
            'SELECT content_text, translation FROM podcast_contents WHERE id = ?',
            [content_id]
        );

        if (!content) {
            return res.status(404).json({ success: false, message: '内容不存在' });
        }

        const results = { male: null, female: null, chinese: null };

        if (content.content_text) {
            const maleResult = await voiceService.textToSpeech(content.content_text, 'male', 'en-US');
            if (maleResult.success) {
                results.male = maleResult.audioUrl;
                await query('UPDATE podcast_contents SET male_audio_url = ? WHERE id = ?', [maleResult.audioUrl, content_id]);
            }

            const femaleResult = await voiceService.textToSpeech(content.content_text, 'female', 'en-US');
            if (femaleResult.success) {
                results.female = femaleResult.audioUrl;
                await query('UPDATE podcast_contents SET female_audio_url = ? WHERE id = ?', [femaleResult.audioUrl, content_id]);
            }
        }

        if (content.translation) {
            const chineseResult = await voiceService.textToSpeech(content.translation, 'female', 'zh-CN');
            if (chineseResult.success) {
                results.chinese = chineseResult.audioUrl;
                await query('UPDATE podcast_contents SET chinese_audio_url = ? WHERE id = ?', [chineseResult.audioUrl, content_id]);
            }
        }

        res.json({ success: true, data: results, message: '音频生成完成' });
    } catch (error) {
        console.error('批量生成播客音频失败:', error);
        res.status(500).json({ success: false, message: '音频生成失败' });
    }
});

// ==================== AI 句子分析 ====================

/**
 * POST /podcast/analyze-sentences/:id
 * 用 Gemini 拆分句子 + 翻译 + 语法 + 关键词，并为每句生成 TTS 音频
 */
router.post('/analyze-sentences/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const [content] = await query('SELECT * FROM podcast_contents WHERE id = ?', [id]);
        if (!content) return res.status(404).json({ success: false, message: '内容不存在' });
        if (!content.content_text) return res.status(400).json({ success: false, message: '内容文本为空' });

        // 标记为处理中
        await query("UPDATE podcast_contents SET sentences_data = 'processing' WHERE id = ?", [id]);

        // 1. Gemini 分析
        const aiResult = await _geminiAnalyze(content.content_text);
        if (!aiResult.success) {
            await query('UPDATE podcast_contents SET sentences_data = NULL WHERE id = ?', [id]);
            return res.status(500).json({ success: false, message: 'AI分析失败: ' + aiResult.error });
        }

        const sentences = aiResult.sentences;

        // 2. 为每句生成 TTS + 为关键词查找/生成音频
        for (const s of sentences) {
            // 句子男声
            const mRes = await voiceService.textToSpeech(s.text, 'male', 'en-US').catch(() => ({ success: false }));
            if (mRes.success) s.male_audio_url = mRes.audioUrl;

            // 句子女声
            const fRes = await voiceService.textToSpeech(s.text, 'female', 'en-US').catch(() => ({ success: false }));
            if (fRes.success) s.female_audio_url = fRes.audioUrl;

            // 关键词音频 + 音标复用
            // 策略：audio/phonetic 与含义无关可复用；translation/pos 用 AI 的（上下文相关）
            for (const w of (s.words || [])) {
                const [wRow] = await query(
                    'SELECT audio_url_female, audio_url_male, phonetic FROM words WHERE LOWER(word) = LOWER(?) LIMIT 1',
                    [w.word]
                );
                if (wRow) {
                    // 复用音频
                    w.audio_url = wRow.audio_url_female || wRow.audio_url_male || null;
                    // 复用音标（仅当 AI 未提供时）
                    if (!w.phonetic && wRow.phonetic) w.phonetic = wRow.phonetic;
                } else {
                    // words 表无记录：生成 TTS 音频
                    const wTts = await voiceService.textToSpeech(w.word, 'female', 'en-US').catch(() => ({ success: false }));
                    if (wTts.success) w.audio_url = wTts.audioUrl;
                }
            }
        }

        // 3. 保存
        await query(
            'UPDATE podcast_contents SET sentences_data = ? WHERE id = ?',
            [JSON.stringify({ sentences }), id]
        );

        res.json({ success: true, data: { sentences_count: sentences.length }, message: `分析完成，共 ${sentences.length} 句` });
    } catch (e) {
        console.error('[Podcast] analyze-sentences error:', e);
        await query('UPDATE podcast_contents SET sentences_data = NULL WHERE id = ?', [id]).catch(() => {});
        res.status(500).json({ success: false, message: e.message });
    }
});

async function _geminiAnalyze(text) {
    try {
        const proxyUrl = process.env.PROXY_BASE_URL;
        const proxyKey = process.env.PROXY_API_KEY;
        if (!proxyUrl) return { success: false, error: '未配置 PROXY_BASE_URL（美国代理服务器地址）' };

        const resp = await axios.post(
            `${proxyUrl}/proxy/analyze-podcast`,
            { text },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Proxy-Key': proxyKey || ''
                },
                timeout: 90000
            }
        );

        if (resp.data.success && Array.isArray(resp.data.sentences)) {
            return { success: true, sentences: resp.data.sentences };
        }
        return { success: false, error: resp.data.error || '代理返回失败' };
    } catch (e) {
        return { success: false, error: `代理服务不可用: ${e.message}` };
    }
}

module.exports = router;
