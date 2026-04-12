const express = require('express');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const aiService = require('../../src/services/ai.service');
const videoService = require('../../src/services/video.service');

const router = express.Router();

// ===== 建表 =====
(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS marketing_contents (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(255) NOT NULL COMMENT '文章标题',
            content_type ENUM('article', 'video_script') DEFAULT 'article' COMMENT '内容类型',
            platform VARCHAR(50) DEFAULT '' COMMENT '目标平台: 公众号/小红书/抖音等',
            source_type VARCHAR(50) DEFAULT '' COMMENT '素材来源类型: scene/picturebook/podcast/word',
            source_id INT DEFAULT 0 COMMENT '素材来源ID',
            source_title VARCHAR(255) DEFAULT '' COMMENT '素材来源标题(冗余)',
            ai_prompt TEXT COMMENT 'AI生成使用的提示词',
            body TEXT COMMENT '正文内容(markdown)',
            cover_url VARCHAR(500) DEFAULT '' COMMENT '封面图',
            tags VARCHAR(500) DEFAULT '' COMMENT '标签,逗号分隔',
            status ENUM('draft', 'published', 'archived') DEFAULT 'draft',
            publish_note VARCHAR(500) DEFAULT '' COMMENT '发布备注',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status (status),
            INDEX idx_source (source_type, source_id),
            INDEX idx_platform (platform)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='营销内容'`);
        console.log('[Marketing] 表初始化完成');
    } catch (e) {
        console.error('[Marketing] 建表失败:', e.message);
    }
})();

// ===== 页面路由 =====

router.get('/', (req, res) => {
    res.render('marketing/index', { page: 'marketing', title: '内容工坊', user: req.session.adminUser });
});

// ===== API: 内容列表 =====

router.get('/api/list', async (req, res) => {
    try {
        const { status, platform, source_type, keyword, page = 1, page_size = 20 } = req.query;
        let sql = 'SELECT * FROM marketing_contents WHERE 1=1';
        const params = [];

        if (status) { sql += ' AND status = ?'; params.push(status); }
        if (platform) { sql += ' AND platform = ?'; params.push(platform); }
        if (source_type) { sql += ' AND source_type = ?'; params.push(source_type); }
        if (keyword) {
            sql += ' AND (title LIKE ? OR body LIKE ? OR tags LIKE ?)';
            params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
        }

        // 总数
        const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [{ total }] = await query(countSql, params);

        sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
        const limit = parseInt(page_size);
        const offset = (parseInt(page) - 1) * limit;
        params.push(limit, offset);

        const list = await query(sql, params);
        res.json({ success: true, data: { list, total, page: parseInt(page), page_size: limit } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 搜索素材源 =====

router.get('/api/sources', async (req, res) => {
    try {
        const { type, keyword } = req.query;
        if (!type) return res.json({ success: true, data: [] });

        let results = [];
        const kw = keyword ? `%${keyword}%` : '%';

        switch (type) {
            case 'scene':
                results = await query(
                    `SELECT id, name as title, name_en as subtitle, image_url as cover FROM scenes WHERE name LIKE ? OR name_en LIKE ? ORDER BY id DESC LIMIT 30`,
                    [kw, kw]
                );
                break;
            case 'picturebook':
                results = await query(
                    `SELECT id, title, title_en as subtitle, cover_url as cover FROM picture_books WHERE title LIKE ? OR title_en LIKE ? ORDER BY id DESC LIMIT 30`,
                    [kw, kw]
                );
                break;
            case 'podcast':
                results = await query(
                    `SELECT id, title, category as subtitle, NULL as cover FROM podcast_contents WHERE title LIKE ? ORDER BY id DESC LIMIT 30`,
                    [kw]
                );
                break;
            case 'dialogue':
                results = await query(
                    `SELECT id, title, title_en as subtitle, cover_image as cover FROM dialogue_scenes WHERE title LIKE ? OR title_en LIKE ? ORDER BY id DESC LIMIT 30`,
                    [kw, kw]
                );
                break;
            case 'word':
                results = await query(
                    `SELECT id, word as title, translation as subtitle, image_url as cover FROM words WHERE word LIKE ? OR translation LIKE ? ORDER BY id DESC LIMIT 50`,
                    [kw, kw]
                );
                break;
        }

        res.json({ success: true, data: results });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 获取素材详情(供AI生成用) =====

router.get('/api/source-detail', async (req, res) => {
    try {
        const { type, id } = req.query;
        if (!type || !id) return res.status(400).json({ success: false, message: '缺少参数' });

        let detail = null;

        switch (type) {
            case 'scene': {
                const [scene] = await query('SELECT * FROM scenes WHERE id = ?', [id]);
                if (!scene) break;
                const words = await query('SELECT word, translation, phonetic, example_sentence FROM scene_words WHERE scene_id = ?', [id]);
                detail = { ...scene, words };
                break;
            }
            case 'picturebook': {
                const [book] = await query('SELECT * FROM picture_books WHERE id = ?', [id]);
                if (!book) break;
                const pages = await query('SELECT page_number, image_url, text_content, text_translation FROM picture_book_pages WHERE book_id = ? ORDER BY page_number', [id]);
                detail = { ...book, pages };
                break;
            }
            case 'podcast': {
                const [pod] = await query('SELECT * FROM podcast_contents WHERE id = ?', [id]);
                if (!pod) break;
                detail = pod;
                break;
            }
            case 'dialogue': {
                const [scene] = await query('SELECT * FROM dialogue_scenes WHERE id = ?', [id]);
                if (!scene) break;
                const lines = await query('SELECT role, line_en, line_cn FROM dialogue_lines WHERE scene_id = ? ORDER BY sort_order', [id]);
                detail = { ...scene, lines };
                break;
            }
            case 'word': {
                const [word] = await query('SELECT * FROM words WHERE id = ?', [id]);
                if (!word) break;
                detail = word;
                break;
            }
        }

        if (!detail) return res.status(404).json({ success: false, message: '素材不存在' });
        res.json({ success: true, data: detail });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: AI 生成文案 =====

router.post('/api/generate', async (req, res) => {
    try {
        const { source_type, source_id, platform, style } = req.body;
        if (!source_type || !source_id) return res.status(400).json({ success: false, message: '请选择素材' });

        // 获取素材详情
        let sourceTitle = '';
        let sourceContext = '';

        switch (source_type) {
            case 'scene': {
                const [scene] = await query('SELECT * FROM scenes WHERE id = ?', [source_id]);
                if (!scene) return res.status(404).json({ success: false, message: '场景不存在' });
                const words = await query('SELECT word, translation, phonetic FROM scene_words WHERE scene_id = ?', [source_id]);
                sourceTitle = scene.name;
                sourceContext = `场景名称: ${scene.name} (${scene.name_en || ''})\n场景描述: ${scene.description || ''}\n包含单词: ${words.map(w => `${w.word}(${w.translation})`).join(', ')}`;
                break;
            }
            case 'picturebook': {
                const [book] = await query('SELECT * FROM picture_books WHERE id = ?', [source_id]);
                if (!book) return res.status(404).json({ success: false, message: '绘本不存在' });
                const pages = await query('SELECT text_content, text_translation FROM picture_book_pages WHERE book_id = ? ORDER BY page_number', [source_id]);
                sourceTitle = book.title;
                sourceContext = `绘本标题: ${book.title} (${book.title_en || ''})\n绘本描述: ${book.description || ''}\n内容摘要: ${pages.map(p => p.text_content).filter(Boolean).join(' | ')}`;
                break;
            }
            case 'podcast': {
                const [pod] = await query('SELECT * FROM podcast_contents WHERE id = ?', [source_id]);
                if (!pod) return res.status(404).json({ success: false, message: '内容不存在' });
                sourceTitle = pod.title;
                sourceContext = `标题: ${pod.title}\n分类: ${pod.category || ''}\n内容: ${(pod.content_text || '').substring(0, 500)}\n翻译: ${(pod.translation || '').substring(0, 300)}`;
                break;
            }
            case 'dialogue': {
                const [scene] = await query('SELECT * FROM dialogue_scenes WHERE id = ?', [source_id]);
                if (!scene) return res.status(404).json({ success: false, message: '对话场景不存在' });
                const lines = await query('SELECT role, line_en, line_cn FROM dialogue_lines WHERE scene_id = ? ORDER BY sort_order', [source_id]);
                sourceTitle = scene.title;
                sourceContext = `对话场景: ${scene.title} (${scene.title_en || ''})\n场景描述: ${scene.description || ''}\n角色: ${scene.guide_role || ''} & ${scene.user_role || ''}\n对话内容:\n${lines.map(l => `${l.role}: ${l.line_en} (${l.line_cn || ''})`).join('\n')}`;
                break;
            }
            case 'word': {
                const [word] = await query('SELECT * FROM words WHERE id = ?', [source_id]);
                if (!word) return res.status(404).json({ success: false, message: '单词不存在' });
                sourceTitle = word.word;
                sourceContext = `单词: ${word.word}\n音标: ${word.phonetic || ''}\n翻译: ${word.translation || ''}\n例句: ${word.example_sentence || ''}\n例句翻译: ${word.example_translation || ''}\n语法: ${word.grammar_explanation || ''}`;
                break;
            }
        }

        // 构建AI提示词
        const platformGuide = {
            '公众号': '微信公众号文章，1000-1500字，标题吸引眼球，正文图文并茂风格，适合家长阅读，语气专业又亲切。包含引言、正文、总结。',
            '小红书': '小红书笔记，300-500字，标题含emoji和数字，正文分段短小精悍，多用emoji，口语化亲切风格，适合年轻妈妈群体。末尾加3-5个话题标签。',
            '抖音': '抖音短视频脚本，30-60秒，开头3秒抓注意力，中间展示核心内容，结尾引导关注。标注画面说明和配音文字。',
            '视频号': '视频号短视频脚本，1-3分钟，教育类风格，清晰的知识点讲解，适合家长和孩子一起看。标注画面和配音。',
        };

        const platformTip = platformGuide[platform] || '通用营销文案，800-1200字，面向儿童英语学习的家长群体。';
        const styleTip = style ? `\n写作风格要求: ${style}` : '';

        const prompt = `你是"她简看图学英语"的内容营销专家。这是一款儿童英语启蒙学习小程序，通过看图学单词、场景对话、绘本阅读、磨耳朵等方式帮助3-10岁孩子学英语。

请根据以下素材，为【${platform || '公众号'}】平台创作一篇营销内容。

## 素材信息
${sourceContext}

## 平台要求
${platformTip}${styleTip}

## 输出格式
请用JSON格式返回:
{
  "title": "文章标题",
  "body": "正文内容(支持markdown格式)",
  "tags": "标签1,标签2,标签3",
  "summary": "一句话摘要"
}

注意:
- 内容要自然融入素材中的英语学习内容，不要生硬推销
- 突出趣味性和教育性，引发家长共鸣
- 适当提及"她简看图学英语"小程序，但不要过于广告化
- 只返回JSON，不要其他内容`;

        // 调用 Gemini
        const result = await aiService.callGeminiText(prompt);
        if (!result.success) {
            return res.status(500).json({ success: false, message: result.error || 'AI生成失败' });
        }

        // 解析结果
        let generated;
        try {
            const jsonMatch = result.text.match(/\{[\s\S]*\}/);
            generated = JSON.parse(jsonMatch[0]);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'AI返回格式错误', raw: result.text });
        }

        res.json({
            success: true,
            data: {
                title: generated.title || '',
                body: generated.body || '',
                tags: generated.tags || '',
                summary: generated.summary || '',
                source_type,
                source_id,
                source_title: sourceTitle,
                platform: platform || '公众号',
                ai_prompt: prompt
            }
        });
    } catch (e) {
        console.error('[Marketing] AI生成错误:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 保存内容 =====

router.post('/api/save', async (req, res) => {
    try {
        const { id, title, content_type, platform, source_type, source_id, source_title, ai_prompt, body, cover_url, tags, status, publish_note } = req.body;
        if (!title) return res.status(400).json({ success: false, message: '标题不能为空' });

        if (id) {
            await query(
                `UPDATE marketing_contents SET title=?, content_type=?, platform=?, source_type=?, source_id=?, source_title=?, ai_prompt=?, body=?, cover_url=?, tags=?, status=?, publish_note=? WHERE id=?`,
                [title, content_type || 'article', platform || '', source_type || '', source_id || 0, source_title || '', ai_prompt || '', body || '', cover_url || '', tags || '', status || 'draft', publish_note || '', id]
            );
            res.json({ success: true, message: '已更新', id });
        } else {
            const result = await query(
                `INSERT INTO marketing_contents (title, content_type, platform, source_type, source_id, source_title, ai_prompt, body, cover_url, tags, status, publish_note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [title, content_type || 'article', platform || '', source_type || '', source_id || 0, source_title || '', ai_prompt || '', body || '', cover_url || '', tags || '', status || 'draft', publish_note || '']
            );
            res.json({ success: true, message: '已保存', id: result.insertId });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 获取单条 =====

router.get('/api/:id', async (req, res) => {
    try {
        const [item] = await query('SELECT * FROM marketing_contents WHERE id = ?', [req.params.id]);
        if (!item) return res.status(404).json({ success: false, message: '不存在' });
        res.json({ success: true, data: item });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 删除 =====

router.delete('/api/:id', async (req, res) => {
    try {
        await query('DELETE FROM marketing_contents WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '已删除' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== API: 批量更新状态 =====

router.put('/api/batch-status', async (req, res) => {
    try {
        const { ids, status } = req.body;
        if (!ids || !ids.length) return res.status(400).json({ success: false, message: '请选择内容' });
        await query(`UPDATE marketing_contents SET status = ? WHERE id IN (${ids.map(() => '?').join(',')})`, [status, ...ids]);
        res.json({ success: true, message: '已更新' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== 视频任务表 =====

(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS marketing_video_jobs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            word_id INT NOT NULL COMMENT '单词ID',
            word_text VARCHAR(200) NOT NULL DEFAULT '' COMMENT '单词文本(冗余)',
            template VARCHAR(50) DEFAULT 'daily_word' COMMENT '视频模板',
            status ENUM('pending', 'processing', 'done', 'failed') DEFAULT 'pending',
            progress INT DEFAULT 0 COMMENT '进度0-100',
            video_url VARCHAR(500) DEFAULT '' COMMENT '视频文件路径',
            error_message TEXT COMMENT '错误信息',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status (status),
            INDEX idx_word (word_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='视频生成任务'`);
        console.log('[Marketing] video_jobs 表初始化完成');
    } catch (e) {
        console.error('[Marketing] video_jobs 建表失败:', e.message);
    }
})();

// ===== 视频页面 =====

router.get('/videos', (req, res) => {
    res.render('marketing/videos', { page: 'marketing-videos', title: '视频工坊', user: req.session.adminUser });
});

// ===== Video API: 候选单词列表(有完整素材) =====

router.get('/api/video/candidates', async (req, res) => {
    try {
        const { keyword, page = 1, page_size = 30 } = req.query;
        let sql = `SELECT id, word, phonetic, translation, image_url, audio_url_female, audio_url_male
                    FROM words WHERE image_url IS NOT NULL AND image_url != ''
                    AND (audio_url_female IS NOT NULL AND audio_url_female != '' OR audio_url_male IS NOT NULL AND audio_url_male != '')`;
        const params = [];

        if (keyword) {
            sql += ' AND (word LIKE ? OR translation LIKE ?)';
            params.push(`%${keyword}%`, `%${keyword}%`);
        }

        // 总数
        const countSql = sql.replace(/SELECT .+ FROM/, 'SELECT COUNT(*) as total FROM');
        const [{ total }] = await query(countSql, params);

        sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        const limit = parseInt(page_size);
        const offset = (parseInt(page) - 1) * limit;
        params.push(limit, offset);

        const list = await query(sql, params);
        res.json({ success: true, data: { list, total, page: parseInt(page), page_size: limit } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== Video API: 生成视频 =====

router.post('/api/video/generate', async (req, res) => {
    try {
        const { word_id } = req.body;
        if (!word_id) return res.status(400).json({ success: false, message: '请选择单词' });

        // 检查单词存在
        const [word] = await query('SELECT id, word, image_url, audio_url_female FROM words WHERE id = ?', [word_id]);
        if (!word) return res.status(404).json({ success: false, message: '单词不存在' });

        // 创建任务
        const result = await query(
            'INSERT INTO marketing_video_jobs (word_id, word_text, template, status) VALUES (?, ?, ?, ?)',
            [word_id, word.word, 'daily_word', 'pending']
        );

        const jobId = result.insertId;
        res.json({ success: true, data: { job_id: jobId }, message: '任务已创建' });

        // 后台启动处理
        setImmediate(() => videoService.processNextJob());
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== Video API: 批量生成 =====

router.post('/api/video/batch', async (req, res) => {
    try {
        const { word_ids } = req.body;
        if (!word_ids || !word_ids.length) return res.status(400).json({ success: false, message: '请选择单词' });

        const jobIds = [];
        for (const wid of word_ids) {
            const [word] = await query('SELECT id, word FROM words WHERE id = ?', [wid]);
            if (!word) continue;
            const result = await query(
                'INSERT INTO marketing_video_jobs (word_id, word_text, template, status) VALUES (?, ?, ?, ?)',
                [wid, word.word, 'daily_word', 'pending']
            );
            jobIds.push(result.insertId);
        }

        res.json({ success: true, data: { job_ids: jobIds }, message: `已创建 ${jobIds.length} 个任务` });

        // 启动队列处理
        setImmediate(() => videoService.processNextJob());
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== Video API: 任务列表 =====

router.get('/api/video/jobs', async (req, res) => {
    try {
        const { status, page = 1, page_size = 20 } = req.query;
        let sql = 'SELECT * FROM marketing_video_jobs WHERE 1=1';
        const params = [];

        if (status) { sql += ' AND status = ?'; params.push(status); }

        const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
        const [{ total }] = await query(countSql, params);

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        const limit = parseInt(page_size);
        const offset = (parseInt(page) - 1) * limit;
        params.push(limit, offset);

        const list = await query(sql, params);
        res.json({ success: true, data: { list, total, page: parseInt(page), page_size: limit } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== Video API: 删除任务 =====

router.delete('/api/video/job/:id', async (req, res) => {
    try {
        const [job] = await query('SELECT * FROM marketing_video_jobs WHERE id = ?', [req.params.id]);
        if (!job) return res.status(404).json({ success: false, message: '任务不存在' });

        // 删除视频文件
        if (job.video_url && job.video_url.startsWith('/uploads/')) {
            const filePath = path.join(__dirname, '../..', job.video_url);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }

        await query('DELETE FROM marketing_video_jobs WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '已删除' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
