const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../../src/config/database');
const aiService = require('../../src/services/ai.service');
const videoService = require('../../src/services/video.service');
const categoryWordVideoService = require('../../src/services/category-word-video.service');

const router = express.Router();

const categoryVideoCoverStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../uploads/marketing/category-videos/covers');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, `category_cover_${Date.now()}${path.extname(file.originalname) || '.jpg'}`);
    }
});
const categoryVideoCoverUpload = multer({
    storage: categoryVideoCoverStorage,
    limits: { fileSize: 10 * 1024 * 1024 }
});

function parseSceneCategoryItems(rawItems = '') {
    if (!rawItems) return [];
    const seen = new Set();
    return String(rawItems)
        .split(/[\n,，、;；|]+/)
        .map(item => item.trim())
        .filter(Boolean)
        .filter(item => {
            const key = item.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
}

function normalizeSceneWordKey(value = '') {
    return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

async function resolveCategoryVideoDefaultCover(categoryId) {
    if (!categoryId) return null;

    const [scene] = await query(`
        SELECT
            s.id,
            s.name,
            s.name_en,
            s.image_url,
            s.category_id,
            c.name AS category_name,
            c.name_en AS category_name_en
        FROM scenes s
        LEFT JOIN scene_categories c ON c.id = s.category_id
        WHERE s.is_active = 1
          AND s.image_url IS NOT NULL
          AND TRIM(s.image_url) != ''
          AND (
            s.category_id = ?
            OR s.category_id IN (
                SELECT id FROM scene_categories WHERE parent_id = ? AND is_active = 1
            )
          )
        ORDER BY
          CASE WHEN s.category_id = ? THEN 0 ELSE 1 END,
          s.sort_order ASC,
          s.created_at DESC,
          s.id DESC
        LIMIT 1
    `, [categoryId, categoryId, categoryId]);

    if (!scene) return null;

    return {
        scene_id: scene.id,
        scene_name: scene.name || '',
        scene_name_en: scene.name_en || '',
        category_id: scene.category_id || 0,
        category_name: scene.category_name || '',
        category_name_en: scene.category_name_en || '',
        image_url: scene.image_url || ''
    };
}

function buildCategoryVideoPreviewEntries(items, words, maxWords = 12) {
    const byWord = new Map();
    const byTranslation = new Map();

    words.forEach(word => {
        const wordKey = normalizeSceneWordKey(word.word);
        const translationKey = normalizeSceneWordKey(word.translation);
        if (wordKey && !byWord.has(wordKey)) byWord.set(wordKey, word);
        if (translationKey && !byTranslation.has(translationKey)) byTranslation.set(translationKey, word);
    });

    const entries = items.map((item, index) => {
        const normalized = normalizeSceneWordKey(item);
        const matchedWord = byWord.get(normalized) || byTranslation.get(normalized) || null;
        const missingFields = [];

        if (matchedWord) {
            if (!matchedWord.image_url) missingFields.push('图片');
            if (!matchedWord.phonetic) missingFields.push('音标');
            if (!matchedWord.translation) missingFields.push('中文释义');
            if (!matchedWord.example_sentence) missingFields.push('英文例句');
            if (!matchedWord.example_translation) missingFields.push('中文例句');
        }

        const audioNeedsFill = !!(
            matchedWord && (
                !matchedWord.translation_audio_url ||
                !matchedWord.audio_url_female ||
                !matchedWord.audio_url_male ||
                !matchedWord.example_translation_audio_url ||
                !matchedWord.example_audio_female ||
                !matchedWord.example_audio_male
            )
        );

        return {
            index: index + 1,
            source_text: item,
            normalized,
            matched: !!matchedWord,
            ready: !!matchedWord && missingFields.length === 0,
            missing_fields: missingFields,
            audio_needs_fill: audioNeedsFill,
            word: matchedWord ? {
                id: matchedWord.id,
                word: matchedWord.word,
                phonetic: matchedWord.phonetic || '',
                translation: matchedWord.translation || '',
                image_url: matchedWord.image_url || '',
                example_sentence: matchedWord.example_sentence || '',
                example_translation: matchedWord.example_translation || '',
                audio_url_female: matchedWord.audio_url_female || '',
                audio_url_male: matchedWord.audio_url_male || '',
                translation_audio_url: matchedWord.translation_audio_url || '',
                example_audio_female: matchedWord.example_audio_female || '',
                example_audio_male: matchedWord.example_audio_male || '',
                example_translation_audio_url: matchedWord.example_translation_audio_url || ''
            } : null
        };
    });

    const readyEntries = entries.filter(entry => entry.ready);
    const selectedEntries = readyEntries.slice(0, maxWords).map(entry => ({
        ...entry,
        selected_for_video: true
    }));

    return {
        entries,
        selectedEntries,
        summary: {
            total_items: entries.length,
            matched_count: entries.filter(entry => entry.matched).length,
            ready_count: readyEntries.length,
            blocked_count: entries.filter(entry => entry.matched && !entry.ready).length,
            missing_count: entries.filter(entry => !entry.matched).length,
            selected_count: selectedEntries.length,
            auto_fill_audio_count: selectedEntries.filter(entry => entry.audio_needs_fill).length,
            can_generate: selectedEntries.length >= 4
        }
    };
}

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
        // 新增封面图字段
        await query(`ALTER TABLE marketing_video_jobs ADD COLUMN cover_url VARCHAR(500) DEFAULT '' COMMENT '封面图URL' AFTER video_url`).catch(() => {});
        // words 表新增例句图片字段
        await query(`ALTER TABLE words ADD COLUMN example_image_url VARCHAR(500) DEFAULT NULL COMMENT '例句配图URL' AFTER example_translation`).catch(() => {});
        // words 表新增中文词义发音/中文例句发音字段，供视频与词卡等模块复用
        await query(`ALTER TABLE words ADD COLUMN translation_audio_url VARCHAR(500) DEFAULT NULL COMMENT '中文词义发音URL' AFTER translation`).catch(() => {});
        await query(`ALTER TABLE words ADD COLUMN example_translation_audio_url VARCHAR(500) DEFAULT NULL COMMENT '中文例句发音URL' AFTER example_translation`).catch(() => {});
        await query(`CREATE TABLE IF NOT EXISTS marketing_category_video_jobs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            category_id INT NOT NULL COMMENT '场景分类ID',
            category_name VARCHAR(255) NOT NULL DEFAULT '' COMMENT '分类名称',
            category_name_en VARCHAR(255) DEFAULT '' COMMENT '分类英文名',
            parent_category_name VARCHAR(255) DEFAULT '' COMMENT '父分类名称',
            template VARCHAR(50) DEFAULT 'category_words' COMMENT '视频模板',
            status ENUM('pending', 'processing', 'done', 'failed') DEFAULT 'pending',
            progress INT DEFAULT 0 COMMENT '进度0-100',
            word_count INT DEFAULT 0 COMMENT '实际词数',
            config_json JSON DEFAULT NULL COMMENT '生成配置快照',
            video_url VARCHAR(500) DEFAULT '' COMMENT '视频文件路径',
            cover_url VARCHAR(500) DEFAULT '' COMMENT '封面图路径',
            error_message TEXT COMMENT '错误信息',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_status (status),
            INDEX idx_category (category_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='分类单词视频任务'`);
        console.log('[Marketing] marketing_category_video_jobs 表初始化完成');
    } catch (e) {
        console.error('[Marketing] video_jobs 建表失败:', e.message);
    }
})();

// ===== 视频页面 =====

router.get('/videos', (req, res) => {
    res.render('marketing/videos', { page: 'marketing-videos', title: '视频工坊', user: req.session.adminUser });
});

router.get('/category-videos', (req, res) => {
    res.render('marketing/category-videos', { page: 'marketing-category-videos', title: '分类单词视频', user: req.session.adminUser });
});

router.post('/api/category-video/upload-cover', categoryVideoCoverUpload.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: '请选择要上传的封面图' });
        }

        res.json({
            success: true,
            data: {
                url: `/uploads/marketing/category-videos/covers/${req.file.filename}`,
                filename: req.file.filename,
                original_name: req.file.originalname || ''
            },
            message: '封面图上传成功'
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
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
        // 删除封面图
        if (job.cover_url && job.cover_url.startsWith('/uploads/')) {
            const coverPath = path.join(__dirname, '../..', job.cover_url);
            if (fs.existsSync(coverPath)) {
                fs.unlinkSync(coverPath);
            }
        }

        await query('DELETE FROM marketing_video_jobs WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '已删除' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== Category Video API: 分类列表 =====

router.get('/api/category-video/categories', async (req, res) => {
    try {
        const { keyword = '' } = req.query;
        const params = [];
        let sql = `
            SELECT
                c.id,
                c.name,
                c.name_en,
                c.parent_id,
                c.icon,
                c.items,
                c.sort_order,
                c.is_active,
                p.name AS parent_name,
                p.name_en AS parent_name_en
            FROM scene_categories c
            LEFT JOIN scene_categories p ON p.id = c.parent_id
            WHERE c.is_active = 1
              AND c.items IS NOT NULL
              AND TRIM(c.items) != ''
        `;

        if (keyword) {
            sql += ` AND (
                c.name LIKE ? OR c.name_en LIKE ? OR
                p.name LIKE ? OR p.name_en LIKE ?
            )`;
            const kw = `%${keyword}%`;
            params.push(kw, kw, kw, kw);
        }

        sql += ' ORDER BY COALESCE(p.sort_order, c.sort_order) ASC, c.parent_id ASC, c.sort_order ASC, c.id ASC';

        const rows = await query(sql, params);
        const list = rows.map(row => {
            const parsedItems = parseSceneCategoryItems(row.items);
            return {
                id: row.id,
                name: row.name,
                name_en: row.name_en || '',
                parent_id: row.parent_id || 0,
                parent_name: row.parent_name || '',
                parent_name_en: row.parent_name_en || '',
                icon: row.icon || '',
                items_count: parsedItems.length,
                sample_items: parsedItems.slice(0, 6),
                has_items: parsedItems.length > 0,
                display_name: row.parent_name ? `${row.parent_name} / ${row.name}` : row.name
            };
        });

        res.json({ success: true, data: list });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== Category Video API: 分类词表预览 =====

router.get('/api/category-video/preview', async (req, res) => {
    try {
        const categoryId = parseInt(req.query.category_id, 10);
        const maxWords = Math.min(Math.max(parseInt(req.query.max_words || '12', 10), 1), 30);

        if (!categoryId) {
            return res.status(400).json({ success: false, message: '请选择分类' });
        }

        const [category] = await query(`
            SELECT
                c.id,
                c.name,
                c.name_en,
                c.parent_id,
                c.icon,
                c.items,
                p.name AS parent_name,
                p.name_en AS parent_name_en
            FROM scene_categories c
            LEFT JOIN scene_categories p ON p.id = c.parent_id
            WHERE c.id = ?
            LIMIT 1
        `, [categoryId]);

        if (!category) {
            return res.status(404).json({ success: false, message: '分类不存在' });
        }

        const parsedItems = parseSceneCategoryItems(category.items);
        const defaultCover = await resolveCategoryVideoDefaultCover(category.id);
        if (parsedItems.length === 0) {
            return res.json({
                success: true,
                data: {
                    category: {
                        id: category.id,
                        name: category.name,
                        name_en: category.name_en || '',
                        parent_name: category.parent_name || '',
                        parent_name_en: category.parent_name_en || ''
                    },
                    default_cover: defaultCover,
                    raw_items: [],
                    entries: [],
                    selected_entries: [],
                    summary: {
                        total_items: 0,
                        matched_count: 0,
                        ready_count: 0,
                        blocked_count: 0,
                        missing_count: 0,
                        selected_count: 0,
                        auto_fill_audio_count: 0,
                        can_generate: false
                    }
                }
            });
        }

        const normalizedItems = parsedItems.map(normalizeSceneWordKey).filter(Boolean);
        const placeholders = normalizedItems.map(() => '?').join(',');
        const words = await query(`
            SELECT
                id,
                word,
                phonetic,
                translation,
                image_url,
                example_sentence,
                example_translation,
                audio_url_female,
                audio_url_male,
                translation_audio_url,
                example_audio_female,
                example_audio_male,
                example_translation_audio_url
            FROM words
            WHERE LOWER(TRIM(word)) IN (${placeholders})
               OR LOWER(TRIM(translation)) IN (${placeholders})
        `, [...normalizedItems, ...normalizedItems]);

        const preview = buildCategoryVideoPreviewEntries(parsedItems, words, maxWords);

        res.json({
            success: true,
            data: {
                category: {
                    id: category.id,
                    name: category.name,
                    name_en: category.name_en || '',
                    parent_name: category.parent_name || '',
                    parent_name_en: category.parent_name_en || '',
                    icon: category.icon || '',
                    display_name: category.parent_name ? `${category.parent_name} / ${category.name}` : category.name
                },
                default_cover: defaultCover,
                raw_items: parsedItems,
                entries: preview.entries,
                selected_entries: preview.selectedEntries,
                summary: preview.summary,
                max_words: maxWords
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/api/category-video/generate', async (req, res) => {
    try {
        const categoryId = parseInt(req.body.category_id, 10);
        const maxWords = Math.min(Math.max(parseInt(req.body.max_words || '12', 10), 1), 30);
        const customCoverUrl = String(req.body.custom_cover_url || '').trim();
        const categoryNameOverride = String(req.body.category_name || '').trim();
        const categoryNameEnOverride = String(req.body.category_name_en || '').trim();
        const parentCategoryNameOverride = String(req.body.parent_category_name || '').trim();
        const requestedSelectedWordIds = Array.isArray(req.body.selected_word_ids)
            ? [...new Set(req.body.selected_word_ids.map(id => parseInt(id, 10)).filter(Boolean))]
            : [];

        if (!categoryId) {
            return res.status(400).json({ success: false, message: '请选择分类' });
        }

        const [category] = await query(`
            SELECT
                c.id,
                c.name,
                c.name_en,
                c.parent_id,
                c.icon,
                c.items,
                p.name AS parent_name,
                p.name_en AS parent_name_en
            FROM scene_categories c
            LEFT JOIN scene_categories p ON p.id = c.parent_id
            WHERE c.id = ?
            LIMIT 1
        `, [categoryId]);

        if (!category) {
            return res.status(404).json({ success: false, message: '分类不存在' });
        }

        const parsedItems = parseSceneCategoryItems(category.items);
        const defaultCover = await resolveCategoryVideoDefaultCover(category.id);
        if (parsedItems.length === 0) {
            return res.status(400).json({ success: false, message: '该分类没有可用词表' });
        }

        const normalizedItems = parsedItems.map(normalizeSceneWordKey).filter(Boolean);
        const placeholders = normalizedItems.map(() => '?').join(',');
        const words = await query(`
            SELECT
                id,
                word,
                phonetic,
                translation,
                image_url,
                example_sentence,
                example_translation,
                audio_url_female,
                audio_url_male,
                translation_audio_url,
                example_audio_female,
                example_audio_male,
                example_translation_audio_url
            FROM words
            WHERE LOWER(TRIM(word)) IN (${placeholders})
               OR LOWER(TRIM(translation)) IN (${placeholders})
        `, [...normalizedItems, ...normalizedItems]);

        const preview = buildCategoryVideoPreviewEntries(parsedItems, words, maxWords);
        let selectedEntries = preview.selectedEntries;
        const effectiveCategoryName = categoryNameOverride || category.name || '';
        const effectiveCategoryNameEn = categoryNameEnOverride || category.name_en || '';
        const effectiveParentCategoryName = parentCategoryNameOverride || category.parent_name || '';

        if (requestedSelectedWordIds.length > 0) {
            if (requestedSelectedWordIds.length > maxWords) {
                return res.status(400).json({
                    success: false,
                    message: `最多只能选择 ${maxWords} 个词`
                });
            }

            const selectedSet = new Set(requestedSelectedWordIds);
            selectedEntries = preview.entries
                .filter(entry => entry.ready && entry.word && selectedSet.has(entry.word.id))
                .map(entry => ({
                    ...entry,
                    selected_for_video: true
                }));

            if (selectedEntries.length !== requestedSelectedWordIds.length) {
                return res.status(400).json({
                    success: false,
                    message: '所选词里包含未就绪项，请刷新预览后重新选择'
                });
            }
        }

        if (selectedEntries.length < 4) {
            return res.status(400).json({
                success: false,
                message: '当前可进入视频的单词少于 4 个，请先补齐图片、音标或例句素材'
            });
        }

        const config = {
            category_id: category.id,
            category_name: effectiveCategoryName,
            category_name_en: effectiveCategoryNameEn,
            parent_category_name: effectiveParentCategoryName,
            max_words: maxWords,
            selected_word_ids: selectedEntries.map(entry => entry.word.id),
            default_cover_url: defaultCover?.image_url || '',
            default_cover_scene_id: defaultCover?.scene_id || 0,
            default_cover_scene_name: defaultCover?.scene_name || '',
            custom_cover_url: customCoverUrl,
            selected_words_snapshot: selectedEntries.map(entry => ({
                id: entry.word.id,
                word: entry.word.word,
                translation: entry.word.translation
            })),
            auto_fill_audio: true
        };

        const result = await query(
            `INSERT INTO marketing_category_video_jobs
            (category_id, category_name, category_name_en, parent_category_name, template, status, progress, word_count, config_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                category.id,
                effectiveCategoryName,
                effectiveCategoryNameEn,
                effectiveParentCategoryName,
                'category_words',
                'pending',
                0,
                selectedEntries.length,
                JSON.stringify(config)
            ]
        );

        res.json({
            success: true,
            data: { job_id: result.insertId, selected_count: selectedEntries.length },
            message: `已创建分类视频任务，将生成 ${selectedEntries.length} 个单词的分类视频`
        });

        setImmediate(() => categoryWordVideoService.processNextJob());
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/api/category-video/jobs', async (req, res) => {
    try {
        const { status, page = 1, page_size = 20 } = req.query;
        let sql = 'SELECT * FROM marketing_category_video_jobs WHERE 1=1';
        const params = [];

        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }

        const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) AS total');
        const [{ total }] = await query(countSql, params);

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        const limit = parseInt(page_size, 10);
        const offset = (parseInt(page, 10) - 1) * limit;
        params.push(limit, offset);

        const list = await query(sql, params);
        res.json({ success: true, data: { list, total, page: parseInt(page, 10), page_size: limit } });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/api/category-video/job/:id', async (req, res) => {
    try {
        const [job] = await query('SELECT * FROM marketing_category_video_jobs WHERE id = ?', [req.params.id]);
        if (!job) return res.status(404).json({ success: false, message: '任务不存在' });

        if (job.video_url && job.video_url.startsWith('/uploads/')) {
            const filePath = path.join(__dirname, '../..', job.video_url);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }

        if (job.cover_url && job.cover_url.startsWith('/uploads/')) {
            const coverPath = path.join(__dirname, '../..', job.cover_url);
            if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
        }

        await query('DELETE FROM marketing_category_video_jobs WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '已删除' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
