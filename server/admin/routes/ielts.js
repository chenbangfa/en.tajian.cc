const express = require('express');
const { query } = require('../../src/config/database');
const { ensureVocabularyWords, enrichVocabularyModule } = require('../../src/services/ielts-vocabulary.service');

const router = express.Router();

let inited = false;

async function ensureIeltsTables() {
    if (inited) return;

    await query(`CREATE TABLE IF NOT EXISTS ielts_courses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(80) NOT NULL UNIQUE,
        title VARCHAR(160) NOT NULL,
        title_en VARCHAR(180) DEFAULT NULL,
        description TEXT,
        target_score VARCHAR(20) DEFAULT NULL,
        duration_days INT DEFAULT 30,
        daily_minutes INT DEFAULT 120,
        level_label VARCHAR(80) DEFAULT NULL,
        is_active TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        metadata JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_active_sort (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_days (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        day_number INT NOT NULL,
        title VARCHAR(160) NOT NULL,
        theme VARCHAR(160) DEFAULT NULL,
        objective TEXT,
        estimated_minutes INT DEFAULT 120,
        preview_next TEXT,
        is_active TINYINT(1) DEFAULT 1,
        metadata JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_course_day (course_id, day_number),
        KEY idx_course_active (course_id, is_active),
        CONSTRAINT fk_ielts_days_course FOREIGN KEY (course_id) REFERENCES ielts_courses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_day_modules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        day_id INT NOT NULL,
        module_type VARCHAR(40) NOT NULL,
        title VARCHAR(160) NOT NULL,
        estimated_minutes INT DEFAULT 10,
        is_required TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        content_json JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_day_sort (day_id, sort_order),
        KEY idx_day_type (day_id, module_type),
        CONSTRAINT fk_ielts_modules_day FOREIGN KEY (day_id) REFERENCES ielts_days(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_grammar_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        module_id INT NOT NULL,
        sort_order INT DEFAULT 0,
        title VARCHAR(180) NOT NULL,
        pattern VARCHAR(255) DEFAULT NULL,
        meaning VARCHAR(255) DEFAULT NULL,
        explanation TEXT,
        example_sentence TEXT,
        example_translation TEXT,
        target_output TEXT,
        pass_score INT DEFAULT 80,
        is_active TINYINT(1) DEFAULT 1,
        metadata JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_module_sort (module_id, sort_order),
        KEY idx_module_active (module_id, is_active),
        CONSTRAINT fk_ielts_grammar_module FOREIGN KEY (module_id) REFERENCES ielts_day_modules(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    try {
        await query(`ALTER TABLE ielts_day_modules MODIFY COLUMN module_type VARCHAR(40) NOT NULL`);
    } catch (e) { /* 兼容已是 VARCHAR 的环境 */ }

    await query(`CREATE TABLE IF NOT EXISTS ielts_user_enrollments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        course_id INT NOT NULL,
        start_date DATE NOT NULL,
        current_day INT DEFAULT 1,
        status ENUM('active','paused','completed') DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_course (user_id, course_id),
        KEY idx_user_status (user_id, status),
        CONSTRAINT fk_ielts_enroll_course FOREIGN KEY (course_id) REFERENCES ielts_courses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_module_progress (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        module_id INT NOT NULL,
        status ENUM('pending','completed') DEFAULT 'pending',
        score DECIMAL(5,2) DEFAULT NULL,
        user_answer TEXT,
        feedback_json JSON DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_module (user_id, module_id),
        KEY idx_user_status (user_id, status),
        CONSTRAINT fk_ielts_progress_module FOREIGN KEY (module_id) REFERENCES ielts_day_modules(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    inited = true;
}

function parseJson(value, fallback = null) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch (error) {
        return fallback;
    }
}

function normalizeJson(value, fallback = {}) {
    if (value == null || value === '') return JSON.stringify(fallback);
    if (typeof value === 'object') return JSON.stringify(value);
    JSON.parse(value);
    return value;
}

function toInt(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.trunc(num) : fallback;
}

function normalizeCourse(row) {
    return { ...row, metadata: parseJson(row.metadata, {}) };
}

function normalizeDay(row) {
    return { ...row, metadata: parseJson(row.metadata, {}) };
}

function normalizeModule(row) {
    return { ...row, content_json: parseJson(row.content_json, {}) };
}

function isGrammarModule(moduleType) {
    return moduleType === 'grammar' || moduleType === 'grammar_drill';
}

function isVocabularyLikeModule(moduleType) {
    return moduleType === 'vocabulary' || moduleType === 'pronunciation';
}

function normalizeGrammarItem(row) {
    return {
        ...row,
        metadata: parseJson(row.metadata, {})
    };
}

function normalizeGrammarItems(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item, index) => {
        const raw = item || {};
        const exampleSentence = String(raw.example_sentence || raw.exampleSentence || raw.sentence || raw.prompt || '').trim();
        const title = String(raw.title || raw.pattern || exampleSentence || `语法训练 ${index + 1}`).trim();
        return {
            sort_order: toInt(raw.sort_order ?? raw.sortOrder, index + 1),
            title,
            pattern: String(raw.pattern || raw.structure || '').trim(),
            meaning: String(raw.meaning || raw.translation || raw.cn || '').trim(),
            explanation: String(raw.explanation || raw.grammar_explanation || raw.grammar || '').trim(),
            example_sentence: exampleSentence,
            example_translation: String(raw.example_translation || raw.exampleTranslation || raw.translation || '').trim(),
            target_output: String(raw.target_output || raw.targetOutput || exampleSentence || raw.prompt || '').trim(),
            pass_score: toInt(raw.pass_score ?? raw.passScore, 80),
            is_active: raw.is_active === 0 || raw.is_active === false ? 0 : 1,
            metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}
        };
    }).filter(item => item.title || item.example_sentence || item.pattern);
}

async function getGrammarItems(moduleId) {
    const rows = await query(`
        SELECT *
        FROM ielts_grammar_items
        WHERE module_id = ?
        ORDER BY sort_order ASC, id ASC
    `, [moduleId]);
    return rows.map(normalizeGrammarItem);
}

async function attachGrammarItems(module) {
    const normalized = normalizeModule(module);
    if (!isGrammarModule(normalized.module_type)) return normalized;
    normalized.grammar_items = await getGrammarItems(normalized.id);
    return normalized;
}

async function replaceGrammarItems(moduleId, items) {
    await query('DELETE FROM ielts_grammar_items WHERE module_id = ?', [moduleId]);
    const normalizedItems = normalizeGrammarItems(items);
    for (let index = 0; index < normalizedItems.length; index += 1) {
        const item = normalizedItems[index];
        await query(`INSERT INTO ielts_grammar_items
            (module_id, sort_order, title, pattern, meaning, explanation, example_sentence, example_translation, target_output, pass_score, is_active, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            moduleId,
            item.sort_order || index + 1,
            item.title || `语法训练 ${index + 1}`,
            item.pattern || null,
            item.meaning || null,
            item.explanation || null,
            item.example_sentence || null,
            item.example_translation || null,
            item.target_output || item.example_sentence || null,
            item.pass_score || 80,
            item.is_active ? 1 : 0,
            normalizeJson(item.metadata, {})
        ]);
    }
}

router.use(async (req, res, next) => {
    try {
        await ensureIeltsTables();
        next();
    } catch (error) {
        console.error('[admin IELTS] 初始化失败:', error);
        res.status(500).json({ success: false, message: 'IELTS 表初始化失败' });
    }
});

router.get('/words/search', async (req, res) => {
    try {
        const keyword = String(req.query.q || '').trim();
        if (!keyword) return res.json({ success: true, data: [] });
        const rows = await query(`
            SELECT id, word, phonetic, translation, example_sentence, example_translation, grammar_explanation,
                   audio_url_female, audio_url_male, example_audio_female, example_audio_male
            FROM words
            WHERE word LIKE ? OR translation LIKE ?
            ORDER BY
                CASE WHEN LOWER(word) = LOWER(?) THEN 0 WHEN word LIKE ? THEN 1 ELSE 2 END,
                id DESC
            LIMIT 20
        `, [`%${keyword}%`, `%${keyword}%`, keyword, `${keyword}%`]);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('[admin IELTS] 搜索词库失败:', error);
        res.status(500).json({ success: false, message: '搜索词库失败' });
    }
});

router.get('/podcasts/search', async (req, res) => {
    try {
        const keyword = String(req.query.q || '').trim();
        const rows = await query(`
            SELECT id, title, title_en, content_text, translation, difficulty_level, duration_seconds,
                   CASE WHEN sentences_data = 'processing' THEN -1
                        WHEN sentences_data IS NOT NULL THEN 1
                        ELSE 0 END AS has_sentences
            FROM podcast_contents
            WHERE (? = '' OR title LIKE ? OR title_en LIKE ? OR content_text LIKE ?)
            ORDER BY id DESC
            LIMIT 30
        `, [keyword, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`]);
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('[admin IELTS] 搜索磨耳朵文章失败:', error);
        res.status(500).json({ success: false, message: '搜索磨耳朵文章失败' });
    }
});

async function attachPodcastContent(module) {
    const normalized = normalizeModule(module);
    const content = normalized.content_json || {};
    const podcastId = Number(content.podcast_content_id || content.podcast_id || 0);
    const podcastModuleTypes = [
        'listening', 'podcast_listening', 'shadowing',
        'speaking', 'speaking_output',
        'writing', 'sentence_builder', 'typing_writing'
    ];
    if (!podcastId || !podcastModuleTypes.includes(normalized.module_type)) return normalized;
    const [podcast] = await query(`
        SELECT id, title, title_en, content_text, translation, difficulty_level, duration_seconds,
               CASE WHEN sentences_data = 'processing' THEN -1
                    WHEN sentences_data IS NOT NULL THEN 1
                    ELSE 0 END AS has_sentences
        FROM podcast_contents
        WHERE id = ?
    `, [podcastId]);
    normalized.podcast_content = podcast || null;
    return normalized;
}

router.get('/courses', async (req, res) => {
    try {
        const rows = await query(`
            SELECT c.*,
                   (SELECT COUNT(*) FROM ielts_days d WHERE d.course_id = c.id) AS day_count,
                   (SELECT COUNT(*) FROM ielts_day_modules m JOIN ielts_days d2 ON d2.id = m.day_id WHERE d2.course_id = c.id) AS module_count,
                   (SELECT COUNT(*) FROM ielts_user_enrollments e WHERE e.course_id = c.id) AS enrollment_count
            FROM ielts_courses c
            ORDER BY c.sort_order ASC, c.id ASC
        `);
        res.json({ success: true, data: rows.map(normalizeCourse) });
    } catch (error) {
        console.error('[admin IELTS] 获取课程失败:', error);
        res.status(500).json({ success: false, message: '获取 IELTS 课程失败' });
    }
});

router.post('/courses', async (req, res) => {
    try {
        const {
            code,
            title,
            title_en = null,
            description = null,
            target_score = null,
            duration_days = 30,
            daily_minutes = 120,
            level_label = null,
            is_active = 1,
            sort_order = 0,
            metadata = {}
        } = req.body;
        if (!code || !title) return res.status(400).json({ success: false, message: '课程 code 和标题不能为空' });

        const result = await query(`INSERT INTO ielts_courses
            (code, title, title_en, description, target_score, duration_days, daily_minutes, level_label, is_active, sort_order, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            String(code).trim(),
            String(title).trim(),
            title_en || null,
            description || null,
            target_score || null,
            toInt(duration_days, 30),
            toInt(daily_minutes, 120),
            level_label || null,
            is_active ? 1 : 0,
            toInt(sort_order, 0),
            normalizeJson(metadata, {})
        ]);
        res.json({ success: true, data: { id: result.insertId }, message: 'IELTS 课程已创建' });
    } catch (error) {
        console.error('[admin IELTS] 创建课程失败:', error);
        res.status(500).json({ success: false, message: error.code === 'ER_DUP_ENTRY' ? '课程 code 已存在' : '创建 IELTS 课程失败' });
    }
});

router.put('/courses/:id', async (req, res) => {
    try {
        const {
            title,
            title_en = null,
            description = null,
            target_score = null,
            duration_days = 30,
            daily_minutes = 120,
            level_label = null,
            is_active = 1,
            sort_order = 0,
            metadata = {}
        } = req.body;
        if (!title) return res.status(400).json({ success: false, message: '课程标题不能为空' });

        await query(`UPDATE ielts_courses
            SET title=?, title_en=?, description=?, target_score=?, duration_days=?, daily_minutes=?, level_label=?, is_active=?, sort_order=?, metadata=?
            WHERE id=?`, [
            String(title).trim(),
            title_en || null,
            description || null,
            target_score || null,
            toInt(duration_days, 30),
            toInt(daily_minutes, 120),
            level_label || null,
            is_active ? 1 : 0,
            toInt(sort_order, 0),
            normalizeJson(metadata, {}),
            req.params.id
        ]);
        res.json({ success: true, message: 'IELTS 课程已保存' });
    } catch (error) {
        console.error('[admin IELTS] 保存课程失败:', error);
        res.status(500).json({ success: false, message: '保存 IELTS 课程失败，请检查 metadata JSON 格式' });
    }
});

router.get('/courses/:courseId/days', async (req, res) => {
    try {
        const rows = await query(`
            SELECT d.*,
                   (SELECT COUNT(*) FROM ielts_day_modules m WHERE m.day_id = d.id) AS module_count
            FROM ielts_days d
            WHERE d.course_id = ?
            ORDER BY d.day_number ASC, d.id ASC
        `, [req.params.courseId]);
        res.json({ success: true, data: rows.map(normalizeDay) });
    } catch (error) {
        console.error('[admin IELTS] 获取 Day 列表失败:', error);
        res.status(500).json({ success: false, message: '获取 Day 列表失败' });
    }
});

router.post('/courses/:courseId/days', async (req, res) => {
    try {
        const { day_number, title, theme = null, objective = null, estimated_minutes = 120, preview_next = null, is_active = 1, metadata = {} } = req.body;
        if (!day_number || !title) return res.status(400).json({ success: false, message: 'Day 编号和标题不能为空' });

        const result = await query(`INSERT INTO ielts_days
            (course_id, day_number, title, theme, objective, estimated_minutes, preview_next, is_active, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            req.params.courseId,
            toInt(day_number, 1),
            String(title).trim(),
            theme || null,
            objective || null,
            toInt(estimated_minutes, 120),
            preview_next || null,
            is_active ? 1 : 0,
            normalizeJson(metadata, {})
        ]);
        res.json({ success: true, data: { id: result.insertId }, message: 'Day 已创建' });
    } catch (error) {
        console.error('[admin IELTS] 创建 Day 失败:', error);
        res.status(500).json({ success: false, message: error.code === 'ER_DUP_ENTRY' ? '该 Day 编号已存在' : '创建 Day 失败' });
    }
});

router.get('/days/:dayId', async (req, res) => {
    try {
        const [day] = await query('SELECT * FROM ielts_days WHERE id = ?', [req.params.dayId]);
        if (!day) return res.status(404).json({ success: false, message: 'Day 不存在' });
        const modules = await query('SELECT * FROM ielts_day_modules WHERE day_id = ? ORDER BY sort_order ASC, id ASC', [req.params.dayId]);
        const normalizedModules = await Promise.all(modules.map(async (module) => {
            const enriched = await enrichVocabularyModule(module);
            const withGrammar = await attachGrammarItems(enriched);
            return attachPodcastContent(withGrammar);
        }));
        res.json({ success: true, data: { day: normalizeDay(day), modules: normalizedModules } });
    } catch (error) {
        console.error('[admin IELTS] 获取 Day 详情失败:', error);
        res.status(500).json({ success: false, message: '获取 Day 详情失败' });
    }
});

router.put('/days/:id', async (req, res) => {
    try {
        const { day_number, title, theme = null, objective = null, estimated_minutes = 120, preview_next = null, is_active = 1, metadata = {} } = req.body;
        if (!day_number || !title) return res.status(400).json({ success: false, message: 'Day 编号和标题不能为空' });

        await query(`UPDATE ielts_days
            SET day_number=?, title=?, theme=?, objective=?, estimated_minutes=?, preview_next=?, is_active=?, metadata=?
            WHERE id=?`, [
            toInt(day_number, 1),
            String(title).trim(),
            theme || null,
            objective || null,
            toInt(estimated_minutes, 120),
            preview_next || null,
            is_active ? 1 : 0,
            normalizeJson(metadata, {}),
            req.params.id
        ]);
        res.json({ success: true, message: 'Day 已保存' });
    } catch (error) {
        console.error('[admin IELTS] 保存 Day 失败:', error);
        res.status(500).json({ success: false, message: error.code === 'ER_DUP_ENTRY' ? '该 Day 编号已存在' : '保存 Day 失败，请检查 metadata JSON 格式' });
    }
});

router.delete('/days/:id', async (req, res) => {
    try {
        await query('DELETE FROM ielts_days WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Day 已删除' });
    } catch (error) {
        console.error('[admin IELTS] 删除 Day 失败:', error);
        res.status(500).json({ success: false, message: '删除 Day 失败' });
    }
});

router.post('/days/:dayId/modules', async (req, res) => {
    try {
        const { module_type = 'goal', title, estimated_minutes = 10, is_required = 1, sort_order = 0, content_json = {}, grammar_items = [] } = req.body;
        if (!title) return res.status(400).json({ success: false, message: '模块标题不能为空' });
        const normalizedContent = isVocabularyLikeModule(module_type) ? await ensureVocabularyWords(content_json) : content_json;

        const result = await query(`INSERT INTO ielts_day_modules
            (day_id, module_type, title, estimated_minutes, is_required, sort_order, content_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [
            req.params.dayId,
            module_type,
            String(title).trim(),
            toInt(estimated_minutes, 10),
            is_required ? 1 : 0,
            toInt(sort_order, 0),
            normalizeJson(normalizedContent, {})
        ]);
        if (isGrammarModule(module_type)) {
            await replaceGrammarItems(result.insertId, grammar_items);
        }
        res.json({ success: true, data: { id: result.insertId }, message: '模块已创建' });
    } catch (error) {
        console.error('[admin IELTS] 创建模块失败:', error);
        res.status(500).json({ success: false, message: error.code === 'ER_DUP_ENTRY' ? '模块排序号已存在' : '创建模块失败，请检查 content_json JSON 格式' });
    }
});

router.put('/modules/:id', async (req, res) => {
    try {
        const { module_type = 'goal', title, estimated_minutes = 10, is_required = 1, sort_order = 0, content_json = {}, grammar_items = [] } = req.body;
        if (!title) return res.status(400).json({ success: false, message: '模块标题不能为空' });
        const normalizedContent = isVocabularyLikeModule(module_type) ? await ensureVocabularyWords(content_json) : content_json;

        await query(`UPDATE ielts_day_modules
            SET module_type=?, title=?, estimated_minutes=?, is_required=?, sort_order=?, content_json=?
            WHERE id=?`, [
            module_type,
            String(title).trim(),
            toInt(estimated_minutes, 10),
            is_required ? 1 : 0,
            toInt(sort_order, 0),
            normalizeJson(normalizedContent, {}),
            req.params.id
        ]);
        if (isGrammarModule(module_type)) {
            await replaceGrammarItems(req.params.id, grammar_items);
        } else {
            await query('DELETE FROM ielts_grammar_items WHERE module_id = ?', [req.params.id]);
        }
        res.json({ success: true, message: '模块已保存' });
    } catch (error) {
        console.error('[admin IELTS] 保存模块失败:', error);
        res.status(500).json({ success: false, message: error.code === 'ER_DUP_ENTRY' ? '模块排序号已存在' : '保存模块失败，请检查 content_json JSON 格式' });
    }
});

router.delete('/modules/:id', async (req, res) => {
    try {
        await query('DELETE FROM ielts_day_modules WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '模块已删除' });
    } catch (error) {
        console.error('[admin IELTS] 删除模块失败:', error);
        res.status(500).json({ success: false, message: '删除模块失败' });
    }
});

module.exports = router;
