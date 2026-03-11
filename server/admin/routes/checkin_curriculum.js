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

    await query(`CREATE TABLE IF NOT EXISTS checkin_course_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        task_type ENUM('word','scene','podcast') NOT NULL,
        target_id INT NOT NULL,
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        note VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_course_item (course_id, task_type, target_id),
        KEY idx_course (course_id),
        KEY idx_type (task_type),
        CONSTRAINT fk_checkin_course_items_course FOREIGN KEY (course_id) REFERENCES checkin_courses(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

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

// 课程列表
router.get('/courses', async (req, res) => {
    try {
        const courses = await query(
            `SELECT c.*,
                    (SELECT COUNT(*) FROM checkin_course_items i WHERE i.course_id = c.id) AS item_count
             FROM checkin_courses c
             ORDER BY c.level ASC, c.sort_order ASC, c.id ASC`
        );
        res.json({ success: true, data: courses });
    } catch (error) {
        console.error('获取课程列表失败:', error);
        res.status(500).json({ success: false, message: '获取课程列表失败' });
    }
});

// 新建课程
router.post('/courses', async (req, res) => {
    try {
        const { name, description = null, level = 1, sort_order = 0, is_active = 1 } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, message: '课程名称不能为空' });
        }
        const result = await query(
            `INSERT INTO checkin_courses (name, description, level, sort_order, is_active)
             VALUES (?, ?, ?, ?, ?)`,
            [name, description, Number(level) || 1, Number(sort_order) || 0, is_active ? 1 : 0]
        );
        res.json({ success: true, data: { id: result.insertId }, message: '课程创建成功' });
    } catch (error) {
        console.error('创建课程失败:', error);
        res.status(500).json({ success: false, message: '创建课程失败' });
    }
});

// 更新课程
router.put('/courses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description = null, level = 1, sort_order = 0, is_active = 1 } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, message: '课程名称不能为空' });
        }

        await query(
            `UPDATE checkin_courses
             SET name = ?, description = ?, level = ?, sort_order = ?, is_active = ?
             WHERE id = ?`,
            [name, description, Number(level) || 1, Number(sort_order) || 0, is_active ? 1 : 0, id]
        );

        res.json({ success: true, message: '课程更新成功' });
    } catch (error) {
        console.error('更新课程失败:', error);
        res.status(500).json({ success: false, message: '更新课程失败' });
    }
});

// 删除课程
router.delete('/courses/:id', async (req, res) => {
    try {
        await query('DELETE FROM checkin_courses WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '课程已删除' });
    } catch (error) {
        console.error('删除课程失败:', error);
        res.status(500).json({ success: false, message: '删除课程失败' });
    }
});

// 课程项列表
router.get('/courses/:courseId/items', async (req, res) => {
    try {
        const { courseId } = req.params;
        const rows = await query(
            `SELECT i.*,
                CASE i.task_type
                    WHEN 'word' THEN (SELECT w.word FROM words w WHERE w.id = i.target_id)
                    WHEN 'scene' THEN (SELECT so.custom_label FROM scene_objects so WHERE so.id = i.target_id)
                    WHEN 'podcast' THEN (SELECT pc.title FROM podcast_contents pc WHERE pc.id = i.target_id)
                END AS target_title,
                CASE i.task_type
                    WHEN 'word' THEN (SELECT w.translation FROM words w WHERE w.id = i.target_id)
                    WHEN 'scene' THEN (SELECT so.translation FROM scene_objects so WHERE so.id = i.target_id)
                    WHEN 'podcast' THEN (SELECT pc.translation FROM podcast_contents pc WHERE pc.id = i.target_id)
                END AS target_subtitle
             FROM checkin_course_items i
             WHERE i.course_id = ?
             ORDER BY i.sort_order ASC, i.id ASC`,
            [courseId]
        );
        res.json({ success: true, data: rows });
    } catch (error) {
        console.error('获取课程项失败:', error);
        res.status(500).json({ success: false, message: '获取课程项失败' });
    }
});

// 新建课程项
router.post('/courses/:courseId/items', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { task_type, target_id, sort_order = 0, is_active = 1, note = null } = req.body;

        if (!['word', 'scene', 'podcast'].includes(task_type)) {
            return res.status(400).json({ success: false, message: '任务类型不合法' });
        }

        const targetId = Number(target_id);
        if (!Number.isInteger(targetId) || targetId <= 0) {
            return res.status(400).json({ success: false, message: '目标ID不合法' });
        }

        await assertTargetExists(task_type, targetId);

        const result = await query(
            `INSERT INTO checkin_course_items (course_id, task_type, target_id, sort_order, is_active, note)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [courseId, task_type, targetId, Number(sort_order) || 0, is_active ? 1 : 0, note]
        );

        res.json({ success: true, data: { id: result.insertId }, message: '课程项创建成功' });
    } catch (error) {
        console.error('创建课程项失败:', error);
        res.status(500).json({ success: false, message: error.message || '创建课程项失败' });
    }
});

// 更新课程项
router.put('/items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { task_type, target_id, sort_order = 0, is_active = 1, note = null } = req.body;

        if (!['word', 'scene', 'podcast'].includes(task_type)) {
            return res.status(400).json({ success: false, message: '任务类型不合法' });
        }

        const targetId = Number(target_id);
        if (!Number.isInteger(targetId) || targetId <= 0) {
            return res.status(400).json({ success: false, message: '目标ID不合法' });
        }

        await assertTargetExists(task_type, targetId);

        await query(
            `UPDATE checkin_course_items
             SET task_type = ?, target_id = ?, sort_order = ?, is_active = ?, note = ?
             WHERE id = ?`,
            [task_type, targetId, Number(sort_order) || 0, is_active ? 1 : 0, note, id]
        );

        res.json({ success: true, message: '课程项更新成功' });
    } catch (error) {
        console.error('更新课程项失败:', error);
        res.status(500).json({ success: false, message: error.message || '更新课程项失败' });
    }
});

// 删除课程项
router.delete('/items/:id', async (req, res) => {
    try {
        await query('DELETE FROM checkin_course_items WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: '课程项已删除' });
    } catch (error) {
        console.error('删除课程项失败:', error);
        res.status(500).json({ success: false, message: '删除课程项失败' });
    }
});

// 查询可选素材
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
                 ORDER BY difficulty_level ASC, id DESC
                 LIMIT 100`,
                [keyword, `%${keyword}%`, `%${keyword}%`, difficulty || null, difficulty || null]
            );
        } else if (taskType === 'scene') {
            rows = await query(
                `SELECT so.id, so.custom_label AS title,
                        CONCAT(COALESCE(so.translation, ''), ' / ', COALESCE(s.name, '')) AS subtitle,
                        s.difficulty_level
                 FROM scene_objects so
                 JOIN scenes s ON s.id = so.scene_id
                 WHERE so.custom_label IS NOT NULL AND so.custom_label != ''
                   AND (? = '' OR so.custom_label LIKE ? OR so.translation LIKE ?)
                   AND (? IS NULL OR s.difficulty_level = ?)
                 ORDER BY s.difficulty_level ASC, so.id DESC
                 LIMIT 100`,
                [keyword, `%${keyword}%`, `%${keyword}%`, difficulty || null, difficulty || null]
            );
        } else if (taskType === 'podcast') {
            rows = await query(
                `SELECT id, title, translation AS subtitle, difficulty_level
                 FROM podcast_contents
                 WHERE content_text IS NOT NULL AND content_text != ''
                   AND (? = '' OR title LIKE ? OR content_text LIKE ?)
                   AND (? IS NULL OR difficulty_level = ?)
                 ORDER BY difficulty_level ASC, id DESC
                 LIMIT 100`,
                [keyword, `%${keyword}%`, `%${keyword}%`, difficulty || null, difficulty || null]
            );
        } else {
            return res.status(400).json({ success: false, message: '不支持的任务类型' });
        }

        res.json({ success: true, data: rows.map(r => ({
            id: r.id,
            title: r.title,
            subtitle: r.subtitle,
            difficulty_level: r.difficulty_level || 1
        })) });
    } catch (error) {
        console.error('查询素材失败:', error);
        res.status(500).json({ success: false, message: '查询素材失败' });
    }
});

async function assertTargetExists(taskType, targetId) {
    if (taskType === 'word') {
        const [row] = await query('SELECT id FROM words WHERE id = ?', [targetId]);
        if (!row) throw new Error('单词不存在');
        return;
    }
    if (taskType === 'scene') {
        const [row] = await query(
            `SELECT so.id
             FROM scene_objects so
             JOIN scenes s ON s.id = so.scene_id AND s.is_active = 1
             WHERE so.id = ?`,
            [targetId]
        );
        if (!row) throw new Error('场景标签不存在或所属场景未启用');
        return;
    }
    if (taskType === 'podcast') {
        const [row] = await query('SELECT id FROM podcast_contents WHERE id = ?', [targetId]);
        if (!row) throw new Error('播客内容不存在');
    }
}

module.exports = router;
