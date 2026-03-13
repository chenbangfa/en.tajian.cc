const express = require('express');
const { query } = require('../../src/config/database');

const router = express.Router();

let inited = false;
async function ensureCurriculumTables() {
    if (inited) return;

    await query(`CREATE TABLE IF NOT EXISTS checkin_courses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        description VARCHAR(500) DEFAULT NULL,
        level TINYINT DEFAULT 1 COMMENT '建议学习等级 0-9',
        is_active TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_level (level),
        KEY idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS checkin_course_chapters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        name VARCHAR(120) NOT NULL COMMENT '章节名称，如 Unit 1: Hello World',
        description VARCHAR(300) DEFAULT NULL,
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_course (course_id),
        CONSTRAINT fk_chapters_course FOREIGN KEY (course_id) REFERENCES checkin_courses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS checkin_course_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        chapter_id INT DEFAULT NULL,
        task_type ENUM('word','scene','podcast') NOT NULL,
        target_id INT NOT NULL,
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        note VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_course_item (course_id, task_type, target_id),
        KEY idx_course (course_id),
        KEY idx_chapter (chapter_id),
        KEY idx_type (task_type),
        CONSTRAINT fk_checkin_course_items_course FOREIGN KEY (course_id) REFERENCES checkin_courses(id) ON DELETE CASCADE,
        CONSTRAINT fk_checkin_course_items_chapter FOREIGN KEY (chapter_id) REFERENCES checkin_course_chapters(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS checkin_course_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(60) NOT NULL,
        icon VARCHAR(10) DEFAULT '📚' COMMENT 'emoji图标',
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // 兼容旧表：尝试加 chapter_id 列，已存在则忽略
    try {
        await query(`ALTER TABLE checkin_course_items ADD COLUMN chapter_id INT DEFAULT NULL AFTER course_id`);
        await query(`ALTER TABLE checkin_course_items ADD KEY idx_chapter (chapter_id)`);
        await query(`ALTER TABLE checkin_course_items ADD CONSTRAINT fk_checkin_course_items_chapter FOREIGN KEY (chapter_id) REFERENCES checkin_course_chapters(id) ON DELETE SET NULL`);
    } catch (e) { /* 列已存在，忽略 */ }

    // 兼容旧 checkin_courses：尝试加 is_vip / category_id 列
    try { await query(`ALTER TABLE checkin_courses ADD COLUMN is_vip TINYINT(1) DEFAULT 0 AFTER is_active`); } catch (e) {}
    try { await query(`ALTER TABLE checkin_courses ADD COLUMN category_id INT DEFAULT NULL AFTER is_vip`); } catch (e) {}

    inited = true;
}

router.use(async (req, res, next) => {
    try {
        await ensureCurriculumTables();
        next();
    } catch (error) {
        console.error('初始化课程表失败:', error);
        res.status(500).json({ success: false, message: '课程模块初始化失败' });
    }
});

// ═══════════════════════════════════════════
// 课程 CRUD
// ═══════════════════════════════════════════

router.get('/courses', async (req, res) => {
    try {
        const courses = await query(
            `SELECT c.*,
                    (SELECT COUNT(*) FROM checkin_course_items i WHERE i.course_id = c.id) AS item_count,
                    (SELECT COUNT(*) FROM checkin_course_chapters ch WHERE ch.course_id = c.id) AS chapter_count
             FROM checkin_courses c
             ORDER BY c.level ASC, c.sort_order ASC, c.id ASC`
        );
        res.json({ success: true, data: courses });
    } catch (error) {
        console.error('获取课程列表失败:', error);
        res.status(500).json({ success: false, message: '获取课程列表失败' });
    }
});

router.post('/courses', async (req, res) => {
    try {
        const { name, description = null, level = 1, sort_order = 0, is_active = 1, is_vip = 0, category_id = null } = req.body;
        if (!name) return res.status(400).json({ success: false, message: '课程名称不能为空' });
        const result = await query(
            `INSERT INTO checkin_courses (name, description, level, sort_order, is_active, is_vip, category_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [name, description, Number(level) || 1, Number(sort_order) || 0, is_active ? 1 : 0, is_vip ? 1 : 0, category_id ? Number(category_id) : null]
        );
        res.json({ success: true, data: { id: result.insertId }, message: '课程创建成功' });
    } catch (error) {
        console.error('创建课程失败:', error);
        res.status(500).json({ success: false, message: '创建课程失败' });
    }
});

router.put('/courses/:id', async (req, res) => {
    try {
        const { name, description = null, level = 1, sort_order = 0, is_active = 1, is_vip = 0, category_id = null } = req.body;
        if (!name) return res.status(400).json({ success: false, message: '课程名称不能为空' });
        await query(
            `UPDATE checkin_courses SET name=?, description=?, level=?, sort_order=?, is_active=?, is_vip=?, category_id=? WHERE id=?`,
            [name, description, Number(level) || 1, Number(sort_order) || 0, is_active ? 1 : 0, is_vip ? 1 : 0, category_id ? Number(category_id) : null, req.params.id]
        );
        res.json({ success: true, message: '课程更新成功' });
    } catch (error) {
        console.error('更新课程失败:', error);
        res.status(500).json({ success: false, message: '更新课程失败' });
    }
});

router.delete('/courses/:id', async (req, res) => {
    try {
        await query('DELETE FROM checkin_courses WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '课程已删除' });
    } catch (error) {
        console.error('删除课程失败:', error);
        res.status(500).json({ success: false, message: '删除课程失败' });
    }
});

// ═══════════════════════════════════════════
// 章节 CRUD
// ═══════════════════════════════════════════

router.get('/courses/:courseId/chapters', async (req, res) => {
    try {
        const chapters = await query(
            `SELECT ch.*,
                    (SELECT COUNT(*) FROM checkin_course_items i WHERE i.chapter_id = ch.id) AS item_count
             FROM checkin_course_chapters ch
             WHERE ch.course_id = ?
             ORDER BY ch.sort_order ASC, ch.id ASC`,
            [req.params.courseId]
        );
        res.json({ success: true, data: chapters });
    } catch (error) {
        console.error('获取章节列表失败:', error);
        res.status(500).json({ success: false, message: '获取章节列表失败' });
    }
});

router.post('/courses/:courseId/chapters', async (req, res) => {
    try {
        const { name, description = null, sort_order = 0, is_active = 1 } = req.body;
        if (!name) return res.status(400).json({ success: false, message: '章节名称不能为空' });
        const result = await query(
            `INSERT INTO checkin_course_chapters (course_id, name, description, sort_order, is_active) VALUES (?, ?, ?, ?, ?)`,
            [req.params.courseId, name, description, Number(sort_order) || 0, is_active ? 1 : 0]
        );
        res.json({ success: true, data: { id: result.insertId }, message: '章节创建成功' });
    } catch (error) {
        console.error('创建章节失败:', error);
        res.status(500).json({ success: false, message: '创建章节失败' });
    }
});

router.put('/chapters/:id', async (req, res) => {
    try {
        const { name, description = null, sort_order = 0, is_active = 1 } = req.body;
        if (!name) return res.status(400).json({ success: false, message: '章节名称不能为空' });
        await query(
            `UPDATE checkin_course_chapters SET name=?, description=?, sort_order=?, is_active=? WHERE id=?`,
            [name, description, Number(sort_order) || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: '章节更新成功' });
    } catch (error) {
        console.error('更新章节失败:', error);
        res.status(500).json({ success: false, message: '更新章节失败' });
    }
});

router.delete('/chapters/:id', async (req, res) => {
    try {
        // 章节下的 items chapter_id 会被 FK ON DELETE SET NULL 自动置空
        await query('DELETE FROM checkin_course_chapters WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '章节已删除（内容已移至未分配）' });
    } catch (error) {
        console.error('删除章节失败:', error);
        res.status(500).json({ success: false, message: '删除章节失败' });
    }
});

// ═══════════════════════════════════════════
// 课程内容 CRUD
// ═══════════════════════════════════════════

// 获取课程内容（支持 ?chapterId=X 过滤；chapterId=0 表示"未分配"）
router.get('/courses/:courseId/items', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { chapterId } = req.query;

        let chapterCondition = '';
        const params = [courseId];
        if (chapterId === '0') {
            chapterCondition = 'AND i.chapter_id IS NULL';
        } else if (chapterId) {
            chapterCondition = 'AND i.chapter_id = ?';
            params.push(Number(chapterId));
        }

        const rows = await query(
            `SELECT i.*,
                CASE i.task_type
                    WHEN 'word'    THEN (SELECT w.word        FROM words w           WHERE w.id  = i.target_id)
                    WHEN 'scene'   THEN (SELECT so.custom_label FROM scene_objects so WHERE so.id = i.target_id)
                    WHEN 'podcast' THEN (SELECT pc.title       FROM podcast_contents pc WHERE pc.id = i.target_id)
                END AS target_title,
                CASE i.task_type
                    WHEN 'word'    THEN (SELECT w.translation   FROM words w           WHERE w.id  = i.target_id)
                    WHEN 'scene'   THEN (SELECT so.translation  FROM scene_objects so  WHERE so.id = i.target_id)
                    WHEN 'podcast' THEN (SELECT pc.translation  FROM podcast_contents pc WHERE pc.id = i.target_id)
                END AS target_subtitle
             FROM checkin_course_items i
             WHERE i.course_id = ? ${chapterCondition}
             ORDER BY i.sort_order ASC, i.id ASC`,
            params
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取课程项失败:', error);
        res.status(500).json({ success: false, message: '获取课程项失败' });
    }
});

router.post('/courses/:courseId/items', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { task_type, target_id, chapter_id = null, sort_order = 0, is_active = 1, note = null } = req.body;

        if (!['word', 'scene', 'podcast'].includes(task_type))
            return res.status(400).json({ success: false, message: '任务类型不合法' });

        const targetId = Number(target_id);
        if (!Number.isInteger(targetId) || targetId <= 0)
            return res.status(400).json({ success: false, message: '目标ID不合法' });

        await assertTargetExists(task_type, targetId);

        const chId = chapter_id ? Number(chapter_id) : null;
        const result = await query(
            `INSERT INTO checkin_course_items (course_id, chapter_id, task_type, target_id, sort_order, is_active, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [courseId, chId, task_type, targetId, Number(sort_order) || 0, is_active ? 1 : 0, note]
        );
        res.json({ success: true, data: { id: result.insertId }, message: '课程项创建成功' });
    } catch (error) {
        console.error('创建课程项失败:', error);
        res.status(500).json({ success: false, message: error.message || '创建课程项失败' });
    }
});

router.put('/items/:id', async (req, res) => {
    try {
        const { task_type, target_id, chapter_id = null, sort_order = 0, is_active = 1, note = null } = req.body;

        if (!['word', 'scene', 'podcast'].includes(task_type))
            return res.status(400).json({ success: false, message: '任务类型不合法' });

        const targetId = Number(target_id);
        if (!Number.isInteger(targetId) || targetId <= 0)
            return res.status(400).json({ success: false, message: '目标ID不合法' });

        await assertTargetExists(task_type, targetId);

        const chId = chapter_id ? Number(chapter_id) : null;
        await query(
            `UPDATE checkin_course_items
             SET task_type=?, target_id=?, chapter_id=?, sort_order=?, is_active=?, note=?
             WHERE id=?`,
            [task_type, targetId, chId, Number(sort_order) || 0, is_active ? 1 : 0, note, req.params.id]
        );
        res.json({ success: true, message: '课程项更新成功' });
    } catch (error) {
        console.error('更新课程项失败:', error);
        res.status(500).json({ success: false, message: error.message || '更新课程项失败' });
    }
});

router.delete('/items/:id', async (req, res) => {
    try {
        await query('DELETE FROM checkin_course_items WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '课程项已删除' });
    } catch (error) {
        console.error('删除课程项失败:', error);
        res.status(500).json({ success: false, message: '删除课程项失败' });
    }
});

// ═══════════════════════════════════════════
// 素材查询
// ═══════════════════════════════════════════

router.get('/sources/:taskType', async (req, res) => {
    try {
        const { taskType } = req.params;
        const { keyword = '', difficulty } = req.query;
        let rows = [];

        if (taskType === 'word') {
            rows = await query(
                `SELECT id, word AS title, translation AS subtitle, difficulty_level
                 FROM words
                 WHERE word IS NOT NULL AND word != ''
                   AND (? = '' OR word LIKE ? OR translation LIKE ?)
                   AND (? IS NULL OR difficulty_level = ?)
                 ORDER BY difficulty_level ASC, id DESC LIMIT 100`,
                [keyword, `%${keyword}%`, `%${keyword}%`, difficulty || null, difficulty || null]
            );
        } else if (taskType === 'scene') {
            rows = await query(
                `SELECT so.id, so.custom_label AS title,
                        CONCAT(COALESCE(so.translation,''),' / ',COALESCE(s.name,'')) AS subtitle,
                        s.difficulty_level
                 FROM scene_objects so JOIN scenes s ON s.id = so.scene_id
                 WHERE so.custom_label IS NOT NULL AND so.custom_label != ''
                   AND (? = '' OR so.custom_label LIKE ? OR so.translation LIKE ?)
                   AND (? IS NULL OR s.difficulty_level = ?)
                 ORDER BY s.difficulty_level ASC, so.id DESC LIMIT 100`,
                [keyword, `%${keyword}%`, `%${keyword}%`, difficulty || null, difficulty || null]
            );
        } else if (taskType === 'podcast') {
            rows = await query(
                `SELECT id, title, translation AS subtitle, difficulty_level
                 FROM podcast_contents
                 WHERE content_text IS NOT NULL AND content_text != ''
                   AND (? = '' OR title LIKE ? OR content_text LIKE ?)
                   AND (? IS NULL OR difficulty_level = ?)
                 ORDER BY difficulty_level ASC, id DESC LIMIT 100`,
                [keyword, `%${keyword}%`, `%${keyword}%`, difficulty || null, difficulty || null]
            );
        } else {
            return res.status(400).json({ success: false, message: '不支持的任务类型' });
        }

        res.json({ success: true, data: rows.map(r => ({
            id: r.id, title: r.title, subtitle: r.subtitle, difficulty_level: r.difficulty_level || 1
        })) });
    } catch (error) {
        console.error('查询素材失败:', error);
        res.status(500).json({ success: false, message: '查询素材失败' });
    }
});

// ═══════════════════════════════════════════
// 课程分类 CRUD
// ═══════════════════════════════════════════

router.get('/categories', async (req, res) => {
    try {
        const rows = await query(
            `SELECT cat.*, COUNT(c.id) AS course_count
             FROM checkin_course_categories cat
             LEFT JOIN checkin_courses c ON c.category_id = cat.id
             GROUP BY cat.id
             ORDER BY cat.sort_order ASC, cat.id ASC`
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取分类失败:', error);
        res.status(500).json({ success: false, message: '获取分类失败' });
    }
});

router.post('/categories', async (req, res) => {
    try {
        const { name, icon = '📚', sort_order = 0, is_active = 1 } = req.body;
        if (!name) return res.status(400).json({ success: false, message: '分类名称不能为空' });
        const result = await query(
            `INSERT INTO checkin_course_categories (name, icon, sort_order, is_active) VALUES (?, ?, ?, ?)`,
            [name, icon, Number(sort_order) || 0, is_active ? 1 : 0]
        );
        res.json({ success: true, data: { id: result.insertId }, message: '分类创建成功' });
    } catch (error) {
        console.error('创建分类失败:', error);
        res.status(500).json({ success: false, message: '创建分类失败' });
    }
});

router.put('/categories/:id', async (req, res) => {
    try {
        const { name, icon = '📚', sort_order = 0, is_active = 1 } = req.body;
        if (!name) return res.status(400).json({ success: false, message: '分类名称不能为空' });
        await query(
            `UPDATE checkin_course_categories SET name=?, icon=?, sort_order=?, is_active=? WHERE id=?`,
            [name, icon, Number(sort_order) || 0, is_active ? 1 : 0, req.params.id]
        );
        res.json({ success: true, message: '分类更新成功' });
    } catch (error) {
        console.error('更新分类失败:', error);
        res.status(500).json({ success: false, message: '更新分类失败' });
    }
});

router.delete('/categories/:id', async (req, res) => {
    try {
        // 将该分类下的课程 category_id 置空
        await query(`UPDATE checkin_courses SET category_id = NULL WHERE category_id = ?`, [req.params.id]);
        await query(`DELETE FROM checkin_course_categories WHERE id = ?`, [req.params.id]);
        res.json({ success: true, message: '分类已删除，关联课程已解除绑定' });
    } catch (error) {
        console.error('删除分类失败:', error);
        res.status(500).json({ success: false, message: '删除分类失败' });
    }
});

async function assertTargetExists(taskType, targetId) {
    if (taskType === 'word') {
        const [row] = await query('SELECT id FROM words WHERE id = ?', [targetId]);
        if (!row) throw new Error('单词不存在');
    } else if (taskType === 'scene') {
        const [row] = await query(
            `SELECT so.id FROM scene_objects so JOIN scenes s ON s.id = so.scene_id AND s.is_active = 1 WHERE so.id = ?`,
            [targetId]
        );
        if (!row) throw new Error('场景标签不存在或所属场景未启用');
    } else if (taskType === 'podcast') {
        const [row] = await query('SELECT id FROM podcast_contents WHERE id = ?', [targetId]);
        if (!row) throw new Error('播客内容不存在');
    }
}

module.exports = router;
