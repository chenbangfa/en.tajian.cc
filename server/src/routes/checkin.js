const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { query } = require('../config/database');
const { authMiddleware, requirePoints } = require('../middlewares/auth');
const voiceService = require('../services/voice.service');

const router = express.Router();

// ===== 配置 =====

const MODE_CONFIG = {
    easy:      { word: 2, scene: 1, podcast: 0 },
    standard:  { word: 3, scene: 2, podcast: 1 },
    challenge: { word: 5, scene: 3, podcast: 1 }
};
const CHECKIN_STRATEGY = {
    random: 'random',
    curriculum: 'curriculum'
};

// 积分规则：每个任务按评分给积分
function calcTaskPoints(score) {
    if (score >= 90) return 5;
    if (score >= 80) return 4;
    if (score >= 60) return 3;
    return 1;
}

// 连续打卡加成倍率
function streakMultiplier(days) {
    if (days >= 30) return 2.0;
    if (days >= 7) return 1.5;
    if (days >= 3) return 1.2;
    return 1.0;
}

// 全部完成额外奖励
const COMPLETION_BONUS = { easy: 5, standard: 10, challenge: 20 };

// 里程碑定义
const MILESTONES = [
    { key: 'first_checkin',    days: 1,   name: '初次打卡',      desc: '完成第一次每日任务' },
    { key: 'streak_3',         days: 3,   name: '坚持3天',       desc: '连续打卡3天' },
    { key: 'streak_7',         days: 7,   name: '一周达人',      desc: '连续打卡7天' },
    { key: 'streak_14',        days: 14,  name: '两周坚持',      desc: '连续打卡14天' },
    { key: 'streak_30',        days: 30,  name: '月度之星',      desc: '连续打卡30天' },
    { key: 'streak_100',       days: 100, name: '百日传奇',      desc: '连续打卡100天' }
];

// 录音上传配置
const fs = require('fs');
const checkinUploadDir = path.join(__dirname, '../../uploads/checkin');
if (!fs.existsSync(checkinUploadDir)) {
    fs.mkdirSync(checkinUploadDir, { recursive: true });
}
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, checkinUploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// 用包裹函数处理 multer 错误，确保返回 JSON 而非默认错误页
const handleCheckinUpload = (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
        if (err) {
            console.error('Checkin上传错误:', err.message);
            return res.status(400).json({
                success: false,
                message: '录音上传失败: ' + err.message
            });
        }
        next();
    });
};

// 初始化表结构
(async () => {
    try {
        await query(`CREATE TABLE IF NOT EXISTS daily_task_plans (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL, task_date DATE NOT NULL,
            mode ENUM('easy','standard','challenge') DEFAULT 'standard',
            strategy ENUM('random','curriculum') DEFAULT 'random',
            course_id INT DEFAULT NULL,
            learning_level TINYINT DEFAULT 1,
            word_target INT DEFAULT 3, scene_target INT DEFAULT 2, podcast_target INT DEFAULT 1,
            word_completed INT DEFAULT 0, scene_completed INT DEFAULT 0, podcast_completed INT DEFAULT 0,
            total_score DECIMAL(7,2) DEFAULT 0, avg_score DECIMAL(5,2) DEFAULT 0,
            total_points INT DEFAULT 0, bonus_points INT DEFAULT 0,
            is_completed TINYINT(1) DEFAULT 0, completed_at TIMESTAMP NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY idx_user_date (user_id, task_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS daily_task_items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            plan_id INT NOT NULL, user_id INT NOT NULL,
            task_type ENUM('word','scene','podcast') NOT NULL,
            target_id INT DEFAULT NULL, course_item_id INT DEFAULT NULL, reference_text TEXT,
            extra_info JSON DEFAULT NULL,
            status ENUM('pending','completed','skipped') DEFAULT 'pending',
            assessment_id INT DEFAULT NULL, score DECIMAL(5,2) DEFAULT NULL,
            pronunciation_score DECIMAL(5,2) DEFAULT NULL,
            fluency_score DECIMAL(5,2) DEFAULT NULL,
            integrity_score DECIMAL(5,2) DEFAULT NULL,
            audio_url VARCHAR(500) DEFAULT NULL,
            points_earned INT DEFAULT 0, completed_at TIMESTAMP NULL,
            sort_order INT DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_plan (plan_id), KEY idx_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS user_achievements (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL, achievement_key VARCHAR(50) NOT NULL,
            achievement_name VARCHAR(100) NOT NULL, achievement_desc VARCHAR(255) DEFAULT NULL,
            achieved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY idx_user_achievement (user_id, achievement_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS checkin_shares (
            id INT AUTO_INCREMENT PRIMARY KEY,
            share_id VARCHAR(32) NOT NULL UNIQUE,
            user_id INT NOT NULL,
            plan_id INT NOT NULL,
            nickname VARCHAR(100) DEFAULT NULL,
            avatar_url VARCHAR(500) DEFAULT NULL,
            task_date DATE NOT NULL,
            mode VARCHAR(20) DEFAULT 'standard',
            streak_days INT DEFAULT 0,
            total_score DECIMAL(7,2) DEFAULT 0,
            avg_score DECIMAL(5,2) DEFAULT 0,
            total_points INT DEFAULT 0,
            items_snapshot JSON DEFAULT NULL COMMENT '任务明细快照',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            KEY idx_share_id (share_id),
            KEY idx_user (user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS checkin_course_categories (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(60) NOT NULL,
            icon VARCHAR(100) DEFAULT NULL COMMENT '图标emoji或路径',
            sort_order INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

        await query(`CREATE TABLE IF NOT EXISTS checkin_courses (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            description VARCHAR(500) DEFAULT NULL,
            level TINYINT DEFAULT 1 COMMENT '建议学习等级 0-9',
            is_active TINYINT(1) DEFAULT 1,
            is_vip TINYINT(1) DEFAULT 0 COMMENT '是否VIP专属课程',
            category_id INT DEFAULT NULL COMMENT '课程分类',
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

        // 兼容旧库：给 checkin_courses 加新字段
        try { await query(`ALTER TABLE checkin_courses ADD COLUMN is_vip TINYINT(1) DEFAULT 0 AFTER sort_order`); } catch (e) {}
        try { await query(`ALTER TABLE checkin_courses ADD COLUMN category_id INT DEFAULT NULL AFTER is_vip`); } catch (e) {}

        // 尝试添加 daily_mode 字段（如果不存在）
        try {
            await query(`ALTER TABLE users ADD COLUMN daily_mode ENUM('easy','standard','challenge') DEFAULT 'standard' AFTER total_study_minutes`);
        } catch (e) { /* 字段已存在则忽略 */ }
        try {
            await query(`ALTER TABLE users ADD COLUMN checkin_strategy ENUM('random','curriculum') DEFAULT 'random' AFTER daily_mode`);
        } catch (e) { /* 字段已存在则忽略 */ }
        try {
            await query(`ALTER TABLE users ADD COLUMN current_course_id INT DEFAULT NULL AFTER checkin_strategy`);
        } catch (e) { /* 字段已存在则忽略 */ }
        try {
            await query(`ALTER TABLE users ADD COLUMN learning_level TINYINT DEFAULT 1 AFTER current_course_id`);
        } catch (e) { /* 字段已存在则忽略 */ }
        try {
            await query(`ALTER TABLE users ADD COLUMN daily_word_target INT DEFAULT 10 AFTER learning_level`);
        } catch (e) { /* 字段已存在则忽略 */ }
        try {
            await query(`ALTER TABLE users ADD COLUMN daily_passing_score TINYINT DEFAULT 60 AFTER daily_word_target`);
        } catch (e) { /* 字段已存在则忽略 */ }

        // 补充 daily_task_items 可能缺少的字段
        const colsToAdd = [
            { name: 'pronunciation_score', sql: 'DECIMAL(5,2) DEFAULT NULL AFTER score' },
            { name: 'fluency_score', sql: 'DECIMAL(5,2) DEFAULT NULL AFTER pronunciation_score' },
            { name: 'integrity_score', sql: 'DECIMAL(5,2) DEFAULT NULL AFTER fluency_score' },
            { name: 'audio_url', sql: 'VARCHAR(500) DEFAULT NULL AFTER integrity_score' },
            { name: 'course_item_id', sql: 'INT DEFAULT NULL AFTER target_id' }
        ];
        for (const col of colsToAdd) {
            try {
                await query(`ALTER TABLE daily_task_items ADD COLUMN ${col.name} ${col.sql}`);
            } catch (e) { /* 字段已存在则忽略 */ }
        }

        const planColsToAdd = [
            { name: 'strategy', sql: `ENUM('random','curriculum') DEFAULT 'random' AFTER mode` },
            { name: 'course_id', sql: 'INT DEFAULT NULL AFTER strategy' },
            { name: 'learning_level', sql: 'TINYINT DEFAULT 1 AFTER course_id' }
        ];
        for (const col of planColsToAdd) {
            try {
                await query(`ALTER TABLE daily_task_plans ADD COLUMN ${col.name} ${col.sql}`);
            } catch (e) { /* 字段已存在则忽略 */ }
        }
    } catch (e) {
        console.error('每日任务表初始化失败（可忽略如果已存在）:', e.message);
    }
})();


// ===== 核心 API =====

/**
 * GET /checkin/plan - 获取或创建今日任务计划
 */
router.get('/plan', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date().toISOString().split('T')[0];

        // 获取用户打卡配置
        const [user] = await query(
            'SELECT daily_mode, checkin_strategy, current_course_id, learning_level FROM users WHERE id = ?',
            [userId]
        );
        const mode = (user && user.daily_mode) || 'standard';
        const strategy = (user && user.checkin_strategy) || CHECKIN_STRATEGY.random;
        const userCourseId = user && user.current_course_id ? Number(user.current_course_id) : null;
        const learningLevel = Math.max(0, Math.min(9, Number((user && user.learning_level) || 1)));

        let selectedCourse = null;
        if (strategy === CHECKIN_STRATEGY.curriculum && userCourseId) {
            [selectedCourse] = await query(
                'SELECT id, name, level FROM checkin_courses WHERE id = ? AND is_active = 1',
                [userCourseId]
            );
        }

        // 检查今天是否已有计划
        let [plan] = await query('SELECT * FROM daily_task_plans WHERE user_id = ? AND task_date = ?', [userId, today]);

        if (!plan) {
            // 创建新计划
            plan = await createDailyPlan(userId, today, mode, {
                strategy: selectedCourse ? CHECKIN_STRATEGY.curriculum : CHECKIN_STRATEGY.random,
                courseId: selectedCourse ? selectedCourse.id : null,
                learningLevel
            });
        } else {
            // 计划已存在，但如果任务项为空（上次创建可能失败），重新生成
            const [itemCount] = await query('SELECT COUNT(*) as cnt FROM daily_task_items WHERE plan_id = ?', [plan.id]);
            if (itemCount.cnt === 0 && !plan.is_completed) {
                await query('DELETE FROM daily_task_plans WHERE id = ?', [plan.id]);
                plan = await createDailyPlan(userId, today, mode, {
                    strategy: selectedCourse ? CHECKIN_STRATEGY.curriculum : CHECKIN_STRATEGY.random,
                    courseId: selectedCourse ? selectedCourse.id : null,
                    learningLevel
                });
            }
        }

        if (plan && plan.course_id && (!selectedCourse || Number(selectedCourse.id) !== Number(plan.course_id))) {
            [selectedCourse] = await query('SELECT id, name, level FROM checkin_courses WHERE id = ?', [plan.course_id]);
        }

        // 获取任务明细
        const items = await query(
            'SELECT * FROM daily_task_items WHERE plan_id = ? ORDER BY sort_order, task_type, id',
            [plan.id]
        );

        // 获取连续打卡天数
        const [stats] = await query('SELECT * FROM checkin_stats WHERE user_id = ?', [userId]);
        const consecutiveDays = (stats && stats.consecutive_days) || 0;
        const multiplier = streakMultiplier(consecutiveDays);

        res.json({
            success: true,
            data: {
                plan: {
                    ...plan,
                    strategy: plan.strategy || CHECKIN_STRATEGY.random,
                    course_id: plan.course_id || null,
                    learning_level: plan.learning_level || learningLevel,
                    course_name: selectedCourse ? selectedCourse.name : null,
                    streak_days: consecutiveDays,
                    streak_multiplier: multiplier,
                    completion_bonus: COMPLETION_BONUS[plan.mode] || 10
                },
                items: items.map(item => {
                    let audioUrl = item.audio_url;
                    if (audioUrl && !audioUrl.startsWith('/uploads/') && !audioUrl.startsWith('http')) {
                        const idx = audioUrl.indexOf('uploads/');
                        audioUrl = idx !== -1 ? '/' + audioUrl.substring(idx) : null;
                    }
                    return {
                        ...item,
                        audio_url: audioUrl,
                        extra_info: typeof item.extra_info === 'string' ? JSON.parse(item.extra_info) : (item.extra_info || {})
                    };
                })
            }
        });
    } catch (error) {
        console.error('获取每日计划错误:', error);
        res.status(500).json({ success: false, message: '获取任务失败' });
    }
});

/**
 * GET /checkin/curriculum - 获取课程化打卡配置
 */
router.get('/curriculum', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const [user] = await query(
            'SELECT checkin_strategy, current_course_id, learning_level FROM users WHERE id = ?',
            [userId]
        );
        const courses = await query(
            'SELECT id, name, description, level, sort_order FROM checkin_courses WHERE is_active = 1 ORDER BY level, sort_order, id'
        );

        res.json({
            success: true,
            data: {
                strategy: (user && user.checkin_strategy) || CHECKIN_STRATEGY.random,
                current_course_id: (user && user.current_course_id) || null,
                learning_level: (user && user.learning_level) || 1,
                courses
            }
        });
    } catch (error) {
        console.error('获取课程配置失败:', error);
        res.status(500).json({ success: false, message: '获取课程配置失败' });
    }
});

/**
 * POST /checkin/curriculum - 设置课程化打卡配置
 */
router.post('/curriculum', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const applyToday = !!req.body.apply_today;
        const strategy = req.body.strategy === CHECKIN_STRATEGY.curriculum
            ? CHECKIN_STRATEGY.curriculum
            : CHECKIN_STRATEGY.random;
        const learningLevel = Math.max(0, Math.min(9, Number(req.body.learning_level || 1)));
        let courseId = req.body.course_id ? Number(req.body.course_id) : null;

        if (strategy === CHECKIN_STRATEGY.curriculum) {
            if (!Number.isInteger(courseId) || courseId <= 0) {
                return res.status(400).json({ success: false, message: '请选择课程' });
            }
            const [course] = await query('SELECT id FROM checkin_courses WHERE id = ? AND is_active = 1', [courseId]);
            if (!course) {
                return res.status(400).json({ success: false, message: '课程不存在或未启用' });
            }
        } else {
            courseId = null;
        }

        await query(
            `UPDATE users
             SET checkin_strategy = ?, current_course_id = ?, learning_level = ?
             WHERE id = ?`,
            [strategy, courseId, learningLevel, userId]
        );

        let appliedToday = false;
        let applyNote = '次日生效';
        if (applyToday) {
            const today = new Date().toISOString().split('T')[0];
            const [todayPlan] = await query(
                'SELECT * FROM daily_task_plans WHERE user_id = ? AND task_date = ?',
                [userId, today]
            );
            // 用户要求即时生效：无论今天状态如何，都重建今天计划
            if (todayPlan) {
                await query('DELETE FROM daily_task_plans WHERE id = ?', [todayPlan.id]);
            }
            const [userMode] = await query('SELECT daily_mode FROM users WHERE id = ?', [userId]);
            await createDailyPlan(userId, today, (userMode && userMode.daily_mode) || 'standard', {
                strategy,
                courseId,
                learningLevel
            });
            appliedToday = true;
            applyNote = '已立即生效';
        }

        res.json({
            success: true,
            message: `课程配置已更新（${applyNote}）`,
            data: { strategy, course_id: courseId, learning_level: learningLevel, applied_today: appliedToday }
        });
    } catch (error) {
        console.error('设置课程配置失败:', error);
        res.status(500).json({ success: false, message: '设置课程配置失败' });
    }
});

/**
 * POST /checkin/complete-task - 完成单个任务（上传录音 + 评测）
 */
router.post('/complete-task', authMiddleware, requirePoints(1), handleCheckinUpload, async (req, res) => {
    try {
        const userId = req.user.id;
        const { task_id } = req.body;
        const taskId = Number(task_id);

        if (!req.file) {
            return res.status(400).json({ success: false, message: '请上传录音' });
        }
        if (!task_id) {
            return res.status(400).json({ success: false, message: '缺少任务ID' });
        }
        if (!Number.isInteger(taskId) || taskId <= 0) {
            return res.status(400).json({ success: false, message: '无效任务ID' });
        }

        // 获取任务
        const [task] = await query('SELECT * FROM daily_task_items WHERE id = ? AND user_id = ?', [taskId, userId]);
        if (!task) {
            return res.status(404).json({ success: false, message: '任务不存在' });
        }
        if (task.status === 'completed') {
            return res.status(400).json({ success: false, message: '任务已完成' });
        }

        // 获取计划
        const [plan] = await query('SELECT * FROM daily_task_plans WHERE id = ?', [task.plan_id]);
        if (!plan) {
            return res.status(404).json({ success: false, message: '计划不存在' });
        }

        // 语音评测
        const contentType = task.task_type === 'podcast' ? 'paragraph' : (task.task_type === 'scene' ? 'sentence' : 'word');
        const assessResult = await voiceService.assessPronunciation(
            req.file.path,
            task.reference_text,
            contentType
        );

        const overallScore = assessResult.overallScore || 0;

        // 保存评测记录
        const assessInsert = await query(
            `INSERT INTO voice_assessments (user_id, content_type, reference_text, audio_url, overall_score, pronunciation_score, fluency_score, integrity_score, detail_result)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [userId, contentType, task.reference_text, req.file.path,
             overallScore, assessResult.pronunciationScore || 0,
             assessResult.fluencyScore || 0, assessResult.integrityScore || 0,
             JSON.stringify(assessResult.details || {})]
        );

        // 计算积分
        const basePoints = calcTaskPoints(overallScore);

        // 获取连续天数计算加成
        const [stats] = await query('SELECT * FROM checkin_stats WHERE user_id = ?', [userId]);
        const multiplier = streakMultiplier((stats && stats.consecutive_days) || 0);
        const earnedPoints = Math.round(basePoints * multiplier);

        // 更新任务状态
        await query(
            `UPDATE daily_task_items SET status = 'completed', assessment_id = ?,
                    score = ?, pronunciation_score = ?, fluency_score = ?, integrity_score = ?,
                    audio_url = ?, points_earned = ?, completed_at = NOW()
             WHERE id = ?`,
            [assessInsert.insertId, overallScore,
             assessResult.pronunciationScore || 0, assessResult.fluencyScore || 0, assessResult.integrityScore || 0,
             req.file.path, earnedPoints, task.id]
        );

        // 更新计划统计
        const typeField = task.task_type + '_completed';
        await query(
            `UPDATE daily_task_plans SET ${typeField} = ${typeField} + 1,
                    total_score = total_score + ?, total_points = total_points + ?
             WHERE id = ?`,
            [overallScore, earnedPoints, plan.id]
        );

        // 扣除积分
        await query('UPDATE users SET points = points - ? WHERE id = ?', [req.pointsToDeduct, userId]);

        // 奖励积分
        if (earnedPoints > 0) {
            await query('UPDATE users SET points = points + ? WHERE id = ?', [earnedPoints, userId]);
            await query(
                'INSERT INTO points_logs (user_id, change_amount, change_type, description) VALUES (?, ?, ?, ?)',
                [userId, earnedPoints, 'reward', `每日任务(${task.task_type})评分${overallScore}`]
            );
        }

        // 如果是单词任务，更新学习记录
        if (task.task_type === 'word' && task.target_id) {
            query(`INSERT INTO word_learning_records (user_id, word_id, learn_count, correct_count, last_learned_at, mastery_level)
                   VALUES (?, ?, 1, ?, NOW(), ?)
                   ON DUPLICATE KEY UPDATE learn_count = learn_count + 1, correct_count = correct_count + ?, last_learned_at = NOW(),
                   mastery_level = LEAST(5, mastery_level + ?)`,
                [userId, task.target_id, overallScore >= 60 ? 1 : 0, overallScore >= 80 ? 2 : (overallScore >= 60 ? 1 : 0),
                 overallScore >= 60 ? 1 : 0, overallScore >= 80 ? 1 : 0]
            ).catch(() => {});
        }

        // 检查是否全部完成
        const [planUpdated] = await query('SELECT * FROM daily_task_plans WHERE id = ?', [plan.id]);
        let allComplete = false;
        let bonusPoints = 0;
        let newAchievements = [];

        if (planUpdated.word_completed >= planUpdated.word_target &&
            planUpdated.scene_completed >= planUpdated.scene_target &&
            planUpdated.podcast_completed >= planUpdated.podcast_target &&
            !planUpdated.is_completed) {

            allComplete = true;
            bonusPoints = COMPLETION_BONUS[planUpdated.mode] || 10;
            const bonusWithMultiplier = Math.round(bonusPoints * multiplier);

            // 计算平均分
            const [avgResult] = await query(
                'SELECT AVG(score) as avg FROM daily_task_items WHERE plan_id = ? AND status = ?',
                [plan.id, 'completed']
            );

            // 标记计划完成
            await query(
                `UPDATE daily_task_plans SET is_completed = 1, completed_at = NOW(),
                        bonus_points = ?, avg_score = ?, total_points = total_points + ?
                 WHERE id = ?`,
                [bonusWithMultiplier, avgResult.avg || 0, bonusWithMultiplier, plan.id]
            );

            // 奖励额外积分
            await query('UPDATE users SET points = points + ? WHERE id = ?', [bonusWithMultiplier, userId]);
            await query(
                'INSERT INTO points_logs (user_id, change_amount, change_type, description) VALUES (?, ?, ?, ?)',
                [userId, bonusWithMultiplier, 'reward', `每日打卡全部完成奖励(x${multiplier})`]
            );

            // 更新打卡统计
            const today = new Date().toISOString().split('T')[0];
            await updateCheckinStats(userId, today, avgResult.avg || 0);

            // 检查里程碑
            newAchievements = await checkAchievements(userId);
        }

        res.json({
            success: true,
            data: {
                score: overallScore,
                pronunciation_score: assessResult.pronunciationScore || 0,
                fluency_score: assessResult.fluencyScore || 0,
                integrity_score: assessResult.integrityScore || 0,
                points_earned: earnedPoints,
                all_complete: allComplete,
                bonus_points: bonusPoints,
                new_achievements: newAchievements
            }
        });
    } catch (error) {
        console.error('完成任务错误:', error);
        res.status(500).json({ success: false, message: '提交失败' });
    }
});

/**
 * POST /checkin/refresh-tasks - 换一批任务（仅刷新未完成的）
 */
router.post('/refresh-tasks', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { task_type } = req.body; // 可选: 只刷新某个类型
        const today = new Date().toISOString().split('T')[0];

        const [plan] = await query('SELECT * FROM daily_task_plans WHERE user_id = ? AND task_date = ?', [userId, today]);
        if (!plan) {
            return res.status(404).json({ success: false, message: '今日计划不存在' });
        }

        // 删除未完成的任务
        let delSql = 'DELETE FROM daily_task_items WHERE plan_id = ? AND status = ?';
        const delParams = [plan.id, 'pending'];
        if (task_type) {
            delSql += ' AND task_type = ?';
            delParams.push(task_type);
        }
        await query(delSql, delParams);

        // 获取已完成任务的 target_id 列表（避免重复）
        const completedItems = await query(
            'SELECT target_id, task_type FROM daily_task_items WHERE plan_id = ?',
            [plan.id]
        );
        const excludeIds = { word: [], scene: [], podcast: [] };
        completedItems.forEach(i => {
            if (i.target_id) excludeIds[i.task_type].push(i.target_id);
        });

        // 计算需要补充的数量
        const completedCounts = { word: 0, scene: 0, podcast: 0 };
        completedItems.forEach(i => { if (i.task_type) completedCounts[i.task_type]++; });

        const targets = MODE_CONFIG[plan.mode] || MODE_CONFIG.standard;
        let sortOrder = 100;

        for (const type of ['word', 'scene', 'podcast']) {
            if (task_type && task_type !== type) continue;
            const needed = targets[type] - completedCounts[type];
            if (needed <= 0) continue;

            const newItems = await generateTaskItems(userId, type, needed, excludeIds[type], {
                strategy: plan.strategy || CHECKIN_STRATEGY.random,
                courseId: plan.course_id || null,
                learningLevel: plan.learning_level || 1
            });
            for (const item of newItems) {
                await query(
                    `INSERT INTO daily_task_items (plan_id, user_id, task_type, target_id, course_item_id, reference_text, extra_info, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [plan.id, userId, type, item.target_id, item.course_item_id || null, item.reference_text, JSON.stringify(item.extra_info), sortOrder++]
                );
            }
        }

        // 重新获取所有任务
        const items = await query('SELECT * FROM daily_task_items WHERE plan_id = ? ORDER BY sort_order, task_type, id', [plan.id]);

        res.json({
            success: true,
            data: {
                items: items.map(item => ({
                    ...item,
                    extra_info: typeof item.extra_info === 'string' ? JSON.parse(item.extra_info) : (item.extra_info || {})
                }))
            }
        });
    } catch (error) {
        console.error('刷新任务错误:', error);
        res.status(500).json({ success: false, message: '刷新失败' });
    }
});

/**
 * POST /checkin/set-mode - 设置任务模式
 */
router.post('/set-mode', authMiddleware, async (req, res) => {
    try {
        const { mode } = req.body;
        if (!MODE_CONFIG[mode]) {
            return res.status(400).json({ success: false, message: '无效模式' });
        }
        await query('UPDATE users SET daily_mode = ? WHERE id = ?', [mode, req.user.id]);
        res.json({ success: true, data: { mode } });
    } catch (error) {
        res.status(500).json({ success: false, message: '设置失败' });
    }
});

/**
 * GET /checkin/stats - 打卡统计
 */
router.get('/stats', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;

        const [stats] = await query('SELECT * FROM checkin_stats WHERE user_id = ?', [userId]);
        const [user] = await query('SELECT daily_mode FROM users WHERE id = ?', [userId]);

        // 本月打卡日历
        const now = new Date();
        const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

        const monthRecords = await query(
            `SELECT task_date, avg_score, is_completed FROM daily_task_plans
             WHERE user_id = ? AND task_date BETWEEN ? AND ? AND is_completed = 1`,
            [userId, firstDay, lastDay]
        );

        // 最近成就
        const achievements = await query(
            'SELECT * FROM user_achievements WHERE user_id = ? ORDER BY achieved_at DESC LIMIT 5',
            [userId]
        );

        res.json({
            success: true,
            data: {
                stats: stats || { total_days: 0, consecutive_days: 0, max_consecutive: 0, total_score: 0 },
                mode: (user && user.daily_mode) || 'standard',
                month_records: monthRecords,
                achievements,
                streak_multiplier: streakMultiplier((stats && stats.consecutive_days) || 0)
            }
        });
    } catch (error) {
        console.error('获取统计错误:', error);
        res.status(500).json({ success: false, message: '获取统计失败' });
    }
});

/**
 * GET /checkin/today - 简化接口（首页用，快速获取今日状态）
 */
router.get('/today', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date().toISOString().split('T')[0];

        const [plan] = await query(
            'SELECT is_completed, word_target, word_completed, scene_target, scene_completed, podcast_target, podcast_completed FROM daily_task_plans WHERE user_id = ? AND task_date = ?',
            [userId, today]
        );

        const [stats] = await query('SELECT consecutive_days, total_days FROM checkin_stats WHERE user_id = ?', [userId]);

        const totalTarget = plan ? (plan.word_target + plan.scene_target + plan.podcast_target) : 0;
        const totalCompleted = plan ? (plan.word_completed + plan.scene_completed + plan.podcast_completed) : 0;

        res.json({
            success: true,
            data: {
                has_plan: !!plan,
                checked_in_today: plan ? !!plan.is_completed : false,
                progress: { total: totalTarget, completed: totalCompleted },
                consecutive_days: (stats && stats.consecutive_days) || 0,
                total_days: (stats && stats.total_days) || 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取状态失败' });
    }
});

/**
 * GET /checkin/history - 打卡历史
 */
router.get('/history', authMiddleware, async (req, res) => {
    try {
        const { page = 1, limit = 20 } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);

        const [records, countResult] = await Promise.all([
            query(
                `SELECT * FROM daily_task_plans WHERE user_id = ? AND is_completed = 1 ORDER BY task_date DESC LIMIT ? OFFSET ?`,
                [req.user.id, parseInt(limit), offset]
            ),
            query('SELECT COUNT(*) as total FROM daily_task_plans WHERE user_id = ? AND is_completed = 1', [req.user.id])
        ]);

        res.json({
            success: true,
            data: {
                list: records,
                pagination: { page: parseInt(page), limit: parseInt(limit), total: countResult[0].total }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取历史失败' });
    }
});


/**
 * POST /checkin/share - 生成打卡分享记录
 */
router.post('/share', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date().toISOString().split('T')[0];

        // 获取今日计划
        const [plan] = await query(
            'SELECT * FROM daily_task_plans WHERE user_id = ? AND task_date = ?',
            [userId, today]
        );
        if (!plan) {
            return res.status(400).json({ success: false, message: '今天还没有任务计划' });
        }

        // 获取完成的任务项
        const items = await query(
            'SELECT * FROM daily_task_items WHERE plan_id = ? ORDER BY sort_order, task_type, id',
            [plan.id]
        );

        // 处理任务项（补全音频URL为相对路径）
        const UPLOADS_BASE = path.join(__dirname, '../../uploads');
        function toRelativeUrl(filePath) {
            if (!filePath) return null;
            if (filePath.startsWith('/uploads/')) return filePath;
            if (filePath.startsWith('http')) return filePath;
            const idx = filePath.indexOf('uploads/');
            if (idx !== -1) return '/' + filePath.substring(idx);
            return '/uploads/recordings/' + path.basename(filePath);
        }

        const itemsSnapshot = items.map(item => ({
            task_type: item.task_type,
            reference_text: item.reference_text,
            extra_info: typeof item.extra_info === 'string' ? JSON.parse(item.extra_info) : (item.extra_info || {}),
            status: item.status,
            score: item.score,
            pronunciation_score: item.pronunciation_score,
            fluency_score: item.fluency_score,
            integrity_score: item.integrity_score,
            audio_url: toRelativeUrl(item.audio_url),
            points_earned: item.points_earned
        }));

        // 获取用户信息
        const [user] = await query('SELECT nickname, avatar_url FROM users WHERE id = ?', [userId]);

        // 获取连续天数
        const [stats] = await query('SELECT consecutive_days FROM checkin_stats WHERE user_id = ?', [userId]);
        const streakDays = (stats && stats.consecutive_days) || 0;

        // 直接从已完成任务项计算平均分（plan.avg_score 只有全部完成后才写入）
        const scoredItems = items.filter(i => i.status === 'completed' && i.score > 0);
        const avgScore = scoredItems.length > 0
            ? Math.round(scoredItems.reduce((sum, i) => sum + Number(i.score), 0) / scoredItems.length)
            : 0;

        // 生成分享ID
        const shareId = crypto.randomBytes(12).toString('hex');

        await query(
            `INSERT INTO checkin_shares (share_id, user_id, plan_id, nickname, avatar_url, task_date, mode, streak_days, total_score, avg_score, total_points, items_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [shareId, userId, plan.id,
             user ? user.nickname : null, user ? user.avatar_url : null,
             plan.task_date, plan.mode, streakDays,
             plan.total_score, avgScore, plan.total_points,
             JSON.stringify(itemsSnapshot)]
        );

        res.json({
            success: true,
            data: {
                share_id: shareId,
                plan,
                items: itemsSnapshot,
                streak_days: streakDays
            }
        });
    } catch (error) {
        console.error('生成分享错误:', error);
        res.status(500).json({ success: false, message: '生成分享失败' });
    }
});

/**
 * GET /checkin/share/:shareId - 查看打卡分享（公开接口）
 */
router.get('/share/:shareId', async (req, res) => {
    try {
        const { shareId } = req.params;
        const [share] = await query('SELECT * FROM checkin_shares WHERE share_id = ?', [shareId]);

        if (!share) {
            return res.status(404).json({ success: false, message: '分享记录不存在' });
        }

        const items = typeof share.items_snapshot === 'string'
            ? JSON.parse(share.items_snapshot)
            : (share.items_snapshot || []);

        res.json({
            success: true,
            data: {
                share_id: share.share_id,
                nickname: share.nickname || '学习达人',
                avatar_url: share.avatar_url,
                task_date: share.task_date,
                mode: share.mode,
                streak_days: share.streak_days,
                total_score: share.total_score,
                avg_score: share.avg_score,
                total_points: share.total_points,
                items
            }
        });
    } catch (error) {
        console.error('查看分享错误:', error);
        res.status(500).json({ success: false, message: '获取分享失败' });
    }
});


// ===== 辅助函数 =====

/**
 * 创建每日计划
 */
async function createDailyPlan(userId, today, mode, options = {}) {
    const targets = { ...(MODE_CONFIG[mode] || MODE_CONFIG.standard) };
    const strategy = options.strategy === CHECKIN_STRATEGY.curriculum ? CHECKIN_STRATEGY.curriculum : CHECKIN_STRATEGY.random;
    const courseId = options.courseId ? Number(options.courseId) : null;
    const learningLevel = Math.max(0, Math.min(9, Number(options.learningLevel || 1)));

    // 检查各模块实际可用内容数量，动态调整目标
    const [wordCount] = await query("SELECT COUNT(*) as cnt FROM words WHERE word IS NOT NULL AND word != ''");
    const [sceneCount] = await query("SELECT COUNT(*) as cnt FROM scene_objects so JOIN scenes s ON s.id = so.scene_id AND s.is_active = 1 WHERE so.custom_label IS NOT NULL AND so.custom_label != ''");
    const [podcastCount] = await query("SELECT COUNT(*) as cnt FROM podcast_contents WHERE content_text IS NOT NULL AND content_text != ''");

    targets.word = Math.min(targets.word, wordCount.cnt);
    targets.scene = Math.min(targets.scene, sceneCount.cnt);
    targets.podcast = Math.min(targets.podcast, podcastCount.cnt);

    // 如果所有内容都为 0，至少保证有任务提示
    console.log(`[每日任务] 创建计划 - 可用内容: 单词${wordCount.cnt} 场景${sceneCount.cnt} 播客${podcastCount.cnt} -> 目标: word=${targets.word} scene=${targets.scene} podcast=${targets.podcast}`);

    const planInsert = await query(
        `INSERT INTO daily_task_plans (user_id, task_date, mode, strategy, course_id, learning_level, word_target, scene_target, podcast_target)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, today, mode, strategy, courseId, learningLevel, targets.word, targets.scene, targets.podcast]
    );
    const planId = planInsert.insertId;

    let sortOrder = 0;

    // 生成各类型任务
    for (const type of ['word', 'scene', 'podcast']) {
        if (targets[type] <= 0) continue;
        try {
            const items = await generateTaskItems(userId, type, targets[type], [], {
                strategy,
                courseId,
                learningLevel
            });
            for (const item of items) {
                await query(
                    `INSERT INTO daily_task_items (plan_id, user_id, task_type, target_id, course_item_id, reference_text, extra_info, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [planId, userId, type, item.target_id, item.course_item_id || null, item.reference_text, JSON.stringify(item.extra_info), sortOrder++]
                );
            }
        } catch (e) {
            console.error(`[每日任务] 生成${type}任务失败:`, e.message);
        }
    }

    // 返回创建的计划
    const [plan] = await query('SELECT * FROM daily_task_plans WHERE id = ?', [planId]);
    return plan;
}

/**
 * 生成指定类型的任务项
 */
async function generateTaskItems(userId, type, count, excludeIds, options = {}) {
    const strategy = options.strategy === CHECKIN_STRATEGY.curriculum ? CHECKIN_STRATEGY.curriculum : CHECKIN_STRATEGY.random;
    const courseId = options.courseId ? Number(options.courseId) : null;
    const learningLevel = Math.max(0, Math.min(9, Number(options.learningLevel || 1)));
    let items = [];

    if (strategy === CHECKIN_STRATEGY.curriculum && courseId) {
        items = await generateCurriculumTaskItems(userId, type, count, excludeIds, { courseId });
        if (items.length >= count) {
            return items.slice(0, count);
        }
    }

    const fallbackExclude = [
        ...excludeIds,
        ...items.map(i => i.target_id).filter(Boolean)
    ];
    const randomItems = await generateRandomTaskItems(userId, type, count - items.length, fallbackExclude, { learningLevel });
    return [...items, ...randomItems].slice(0, count);
}

async function generateCurriculumTaskItems(userId, type, count, excludeIds, options = {}) {
    const courseId = Number(options.courseId);
    if (!Number.isInteger(courseId) || courseId <= 0) return [];

    const excludeClause = excludeIds.length > 0
        ? ` AND ci.target_id NOT IN (${excludeIds.map(() => '?').join(',')}) `
        : '';
    const excludeParams = excludeIds.length > 0 ? [...excludeIds] : [];

    const rows = await query(
        `SELECT ci.id as course_item_id, ci.target_id
         FROM checkin_course_items ci
         WHERE ci.course_id = ?
           AND ci.task_type = ?
           AND ci.is_active = 1
           ${excludeClause}
           AND NOT EXISTS (
                SELECT 1 FROM daily_task_items dti
                WHERE dti.user_id = ? AND dti.course_item_id = ci.id AND dti.status = 'completed'
           )
         ORDER BY ci.sort_order ASC, ci.id ASC
         LIMIT ?`,
        [courseId, type, ...excludeParams, userId, count]
    );
    if (!rows.length) return [];

    const targetIds = rows.map(r => r.target_id);
    const courseItemMap = new Map(rows.map(r => [String(r.target_id), r.course_item_id]));

    if (type === 'word') {
        const list = await query(
            `SELECT id, word, phonetic, translation, image_url, audio_url_female, audio_url_male
             FROM words WHERE id IN (${targetIds.map(() => '?').join(',')})`,
            targetIds
        );
        return list.map(w => ({
            target_id: w.id,
            course_item_id: courseItemMap.get(String(w.id)),
            reference_text: w.word,
            extra_info: {
                word: w.word,
                phonetic: w.phonetic,
                translation: w.translation,
                image_url: w.image_url,
                audio_female: w.audio_url_female,
                audio_male: w.audio_url_male
            }
        }));
    }

    if (type === 'scene') {
        const list = await query(
            `SELECT so.id, so.custom_label, so.phonetic, so.translation,
                    so.audio_url_female, so.audio_url_male,
                    s.name as scene_name, s.image_url as scene_image
             FROM scene_objects so
             JOIN scenes s ON s.id = so.scene_id AND s.is_active = 1
             WHERE so.id IN (${targetIds.map(() => '?').join(',')})`,
            targetIds
        );
        return list.map(o => ({
            target_id: o.id,
            course_item_id: courseItemMap.get(String(o.id)),
            reference_text: o.custom_label,
            extra_info: {
                label: o.custom_label,
                phonetic: o.phonetic,
                translation: o.translation,
                scene_name: o.scene_name,
                scene_image: o.scene_image,
                audio_female: o.audio_url_female,
                audio_male: o.audio_url_male
            }
        }));
    }

    if (type === 'podcast') {
        const list = await query(
            `SELECT id, title, title_en, content_text, translation,
                    difficulty_level, male_audio_url, female_audio_url, chinese_audio_url
             FROM podcast_contents
             WHERE id IN (${targetIds.map(() => '?').join(',')})`,
            targetIds
        );
        return list.map(c => ({
            target_id: c.id,
            course_item_id: courseItemMap.get(String(c.id)),
            reference_text: c.content_text,
            extra_info: {
                title: c.title,
                title_en: c.title_en,
                content_text: c.content_text,
                translation: c.translation,
                difficulty_level: c.difficulty_level,
                male_audio_url: c.male_audio_url,
                female_audio_url: c.female_audio_url,
                chinese_audio_url: c.chinese_audio_url
            }
        }));
    }

    return [];
}

async function generateRandomTaskItems(userId, type, count, excludeIds, options = {}) {
    if (count <= 0) return [];

    const items = [];
    const level = Math.max(0, Math.min(9, Number(options.learningLevel || 1)));
    const maxLevel = Math.min(9, level + 1);
    const excludeClause = excludeIds.length > 0 ? `AND t.id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
    const excludeParams = excludeIds.length > 0 ? [...excludeIds] : [];

    if (type === 'word') {
        const words = await query(
            `SELECT w.id, w.word, w.phonetic, w.translation, w.image_url,
                    w.audio_url_female, w.audio_url_male, w.difficulty_level
             FROM words w
             LEFT JOIN word_learning_records lr ON lr.word_id = w.id AND lr.user_id = ?
             WHERE w.word IS NOT NULL AND w.word != ''
               AND (w.difficulty_level IS NULL OR w.difficulty_level <= ?)
             ${excludeClause.replace(/t\.id/g, 'w.id')}
             ORDER BY
                CASE WHEN lr.id IS NULL THEN 0 ELSE 1 END,
                COALESCE(lr.mastery_level, 0) ASC,
                w.difficulty_level ASC,
                RAND()
             LIMIT ?`,
            [userId, maxLevel, ...excludeParams, count]
        );

        for (const w of words) {
            items.push({
                target_id: w.id,
                reference_text: w.word,
                extra_info: {
                    word: w.word,
                    phonetic: w.phonetic,
                    translation: w.translation,
                    image_url: w.image_url,
                    audio_female: w.audio_url_female,
                    audio_male: w.audio_url_male
                }
            });
        }
    } else if (type === 'scene') {
        const objects = await query(
            `SELECT so.id, so.custom_label, so.phonetic, so.translation,
                    so.audio_url_female, so.audio_url_male,
                    s.name as scene_name, s.image_url as scene_image, s.difficulty_level
             FROM scene_objects so
             JOIN scenes s ON s.id = so.scene_id AND s.is_active = 1
             WHERE so.custom_label IS NOT NULL AND so.custom_label != ''
               AND (s.difficulty_level IS NULL OR s.difficulty_level <= ?)
             ${excludeClause.replace(/t\.id/g, 'so.id')}
             ORDER BY s.difficulty_level ASC, RAND()
             LIMIT ?`,
            [maxLevel, ...excludeParams, count]
        );

        for (const o of objects) {
            items.push({
                target_id: o.id,
                reference_text: o.custom_label,
                extra_info: {
                    label: o.custom_label,
                    phonetic: o.phonetic,
                    translation: o.translation,
                    scene_name: o.scene_name,
                    scene_image: o.scene_image,
                    audio_female: o.audio_url_female,
                    audio_male: o.audio_url_male
                }
            });
        }
    } else if (type === 'podcast') {
        const contents = await query(
            `SELECT pc.id, pc.title, pc.title_en, pc.content_text, pc.translation,
                    pc.difficulty_level, pc.male_audio_url, pc.female_audio_url,
                    pc.chinese_audio_url
             FROM podcast_contents pc
             LEFT JOIN podcast_progress pp ON pp.content_id = pc.id AND pp.user_id = ?
             WHERE pc.content_text IS NOT NULL AND pc.content_text != ''
               AND (pc.difficulty_level IS NULL OR pc.difficulty_level <= ?)
             ${excludeClause.replace(/t\.id/g, 'pc.id')}
             ORDER BY
                CASE WHEN pp.id IS NULL THEN 0 ELSE 1 END,
                pc.difficulty_level ASC,
                RAND()
             LIMIT ?`,
            [userId, maxLevel, ...excludeParams, count]
        );

        for (const c of contents) {
            items.push({
                target_id: c.id,
                reference_text: c.content_text,
                extra_info: {
                    title: c.title,
                    title_en: c.title_en,
                    content_text: c.content_text,
                    translation: c.translation,
                    difficulty_level: c.difficulty_level,
                    male_audio_url: c.male_audio_url,
                    female_audio_url: c.female_audio_url,
                    chinese_audio_url: c.chinese_audio_url
                }
            });
        }
    }

    return items;
}

/**
 * 更新打卡统计
 */
async function updateCheckinStats(userId, checkinDate, score) {
    const [stats] = await query('SELECT * FROM checkin_stats WHERE user_id = ?', [userId]);

    if (!stats) {
        await query(
            `INSERT INTO checkin_stats (user_id, total_days, consecutive_days, max_consecutive, total_score, last_checkin_date)
             VALUES (?, 1, 1, 1, ?, ?)`,
            [userId, score, checkinDate]
        );
    } else {
        const lastDate = new Date(stats.last_checkin_date);
        const currentDate = new Date(checkinDate);
        const diffDays = Math.floor((currentDate - lastDate) / (86400000));

        let newConsecutive = stats.consecutive_days;
        if (diffDays === 1) {
            newConsecutive += 1;
        } else if (diffDays > 1) {
            newConsecutive = 1;
        }
        // diffDays === 0 表示同一天，不增加

        await query(
            `UPDATE checkin_stats SET total_days = total_days + ?,
                    consecutive_days = ?, max_consecutive = GREATEST(max_consecutive, ?),
                    total_score = total_score + ?, last_checkin_date = ?
             WHERE user_id = ?`,
            [diffDays > 0 ? 1 : 0, newConsecutive, newConsecutive, score, checkinDate, userId]
        );
    }
}

/**
 * 检查并解锁成就
 */
async function checkAchievements(userId) {
    const [stats] = await query('SELECT * FROM checkin_stats WHERE user_id = ?', [userId]);
    if (!stats) return [];

    const newAchievements = [];

    for (const ms of MILESTONES) {
        if (stats.consecutive_days >= ms.days) {
            try {
                await query(
                    `INSERT IGNORE INTO user_achievements (user_id, achievement_key, achievement_name, achievement_desc)
                     VALUES (?, ?, ?, ?)`,
                    [userId, ms.key, ms.name, ms.desc]
                );
                // 如果插入成功（之前没有这个成就），加入新成就列表
                const result = await query(
                    'SELECT * FROM user_achievements WHERE user_id = ? AND achievement_key = ? AND achieved_at >= DATE_SUB(NOW(), INTERVAL 5 SECOND)',
                    [userId, ms.key]
                );
                if (result.length > 0) {
                    newAchievements.push({ key: ms.key, name: ms.name, desc: ms.desc });
                }
            } catch (e) { /* 已存在忽略 */ }
        }
    }

    return newAchievements;
}

// ===== V2 简化打卡 API =====

/**
 * GET /checkin/v2/status - 获取打卡状态（课程报名+今日进度+连续天数）
 */
router.get('/v2/status', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date().toISOString().split('T')[0];

        const [user] = await query(
            'SELECT current_course_id, daily_word_target, daily_passing_score FROM users WHERE id = ?',
            [userId]
        );

        const courseId = user && user.current_course_id;
        const dailyTarget = (user && user.daily_word_target) || 10;
        const passingScore = (user && user.daily_passing_score) || 60;

        let course = null;
        let courseWordCount = 0;
        let learnedCount = 0;

        if (courseId) {
            [course] = await query(
                'SELECT id, name, description FROM checkin_courses WHERE id = ? AND is_active = 1',
                [courseId]
            );
            if (course) {
                const [cnt] = await query(
                    'SELECT COUNT(*) as cnt FROM checkin_course_items WHERE course_id = ? AND task_type = "word" AND is_active = 1',
                    [courseId]
                );
                courseWordCount = cnt ? cnt.cnt : 0;

                const [lcnt] = await query(`
                    SELECT COUNT(DISTINCT dti.course_item_id) as cnt
                    FROM daily_task_items dti
                    WHERE dti.user_id = ? AND dti.status = 'completed' AND dti.course_item_id IS NOT NULL
                    AND dti.course_item_id IN (
                        SELECT id FROM checkin_course_items WHERE course_id = ? AND task_type = 'word'
                    )
                `, [userId, courseId]);
                learnedCount = lcnt ? lcnt.cnt : 0;
            }
        }

        let todayDoneCount = 0;
        let todayComplete = false;
        const [plan] = await query(
            'SELECT word_completed, is_completed FROM daily_task_plans WHERE user_id = ? AND task_date = ?',
            [userId, today]
        );
        if (plan) {
            todayDoneCount = plan.word_completed || 0;
            todayComplete = !!plan.is_completed;
        }

        const [stats] = await query('SELECT consecutive_days, total_days FROM checkin_stats WHERE user_id = ?', [userId]);
        const streakDays = stats ? stats.consecutive_days : 0;
        const totalDays = stats ? stats.total_days : 0;

        res.json({
            success: true,
            data: { enrolled: !!course, course, dailyTarget, passingScore, courseWordCount, learnedCount, todayDoneCount, todayComplete, streakDays, totalDays }
        });
    } catch (e) {
        console.error('v2/status error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * GET /checkin/v2/course-categories - 课程分类列表（公开）
 */
router.get('/v2/course-categories', async (req, res) => {
    try {
        const cats = await query('SELECT id, name, icon FROM checkin_course_categories ORDER BY sort_order, id');
        res.json({ success: true, data: cats });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 课程聚合公共 SQL 片段
const COURSE_AGGREGATE_SQL = `
    SELECT c.id, c.name, c.description, c.level, c.is_vip, c.category_id,
           cc.name AS category_name,
           COUNT(DISTINCT CASE WHEN ci.task_type = 'word' THEN ci.target_id END) AS word_count,
           COUNT(DISTINCT ci.id) AS total_count,
           COUNT(DISTINCT w.category_id) AS chapter_count,
           (SELECT COUNT(*) FROM users u WHERE u.current_course_id = c.id) + 1000 AS learner_count
    FROM checkin_courses c
    LEFT JOIN checkin_course_categories cc ON cc.id = c.category_id
    LEFT JOIN checkin_course_items ci ON ci.course_id = c.id AND ci.is_active = 1
    LEFT JOIN words w ON w.id = ci.target_id AND ci.task_type = 'word'`;

/**
 * GET /checkin/v2/hot-courses - 热门课程列表（公开，首页展示用，支持分页）
 */
router.get('/v2/hot-courses', async (req, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(20, Number(req.query.limit) || 5);
        const offset = (page - 1) * limit;

        const courses = await query(
            `${COURSE_AGGREGATE_SQL}
             WHERE c.is_active = 1
             GROUP BY c.id
             ORDER BY c.sort_order, c.id
             LIMIT ? OFFSET ?`,
            [limit, offset]
        );
        const [{ total }] = await query('SELECT COUNT(*) AS total FROM checkin_courses WHERE is_active = 1');
        res.json({ success: true, data: courses, pagination: { total, page, limit, hasMore: offset + courses.length < total } });
    } catch (e) {
        console.error('hot-courses error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * GET /checkin/v2/all-courses - 全部课程（公开，支持分类筛选 + 分页）
 */
router.get('/v2/all-courses', async (req, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(30, Number(req.query.limit) || 20);
        const offset = (page - 1) * limit;
        const categoryId = req.query.category_id ? Number(req.query.category_id) : null;

        const whereParts = ['c.is_active = 1'];
        const params = [];
        if (categoryId) { whereParts.push('c.category_id = ?'); params.push(categoryId); }
        const where = whereParts.join(' AND ');

        const courses = await query(
            `${COURSE_AGGREGATE_SQL}
             WHERE ${where}
             GROUP BY c.id
             ORDER BY c.is_vip ASC, c.sort_order, c.id
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [{ total }] = await query(
            `SELECT COUNT(*) AS total FROM checkin_courses c WHERE ${where}`, params
        );
        res.json({ success: true, data: courses, pagination: { total, page, limit, hasMore: offset + courses.length < total } });
    } catch (e) {
        console.error('all-courses error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * GET /checkin/v2/course-detail/:id - 课程详情（公开）
 */
router.get('/v2/course-detail/:id', async (req, res) => {
    try {
        const courseId = Number(req.params.id);
        const [course] = await query(
            `${COURSE_AGGREGATE_SQL}
             WHERE c.id = ? AND c.is_active = 1
             GROUP BY c.id`,
            [courseId]
        );
        if (!course) return res.status(404).json({ success: false, message: '课程不存在' });

        // 章节列表（按单词所属分类分组）
        const chapters = await query(
            `SELECT COALESCE(wc.id, 0) AS category_id,
                    COALESCE(wc.name, '基础词汇') AS category_name,
                    COUNT(ci.id) AS word_count
             FROM checkin_course_items ci
             LEFT JOIN words w ON w.id = ci.target_id
             LEFT JOIN word_categories wc ON wc.id = w.category_id
             WHERE ci.course_id = ? AND ci.task_type = 'word' AND ci.is_active = 1
             GROUP BY wc.id, wc.name
             ORDER BY MIN(ci.sort_order)`,
            [courseId]
        );

        // 示例单词（最多6个，带图片）
        const baseUrl = process.env.BASE_URL || '';
        const sampleWords = await query(
            `SELECT w.id, w.word, w.translation, w.phonetic, w.image_url
             FROM checkin_course_items ci
             JOIN words w ON w.id = ci.target_id
             WHERE ci.course_id = ? AND ci.task_type = 'word' AND ci.is_active = 1
             ORDER BY ci.sort_order, ci.id LIMIT 6`,
            [courseId]
        );
        sampleWords.forEach(w => {
            if (w.image_url && w.image_url.startsWith('/')) w.image_url = baseUrl + w.image_url;
        });

        res.json({ success: true, data: { ...course, chapters, sampleWords } });
    } catch (e) {
        console.error('course-detail error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * GET /checkin/v2/courses - 获取可报名课程列表
 */
router.get('/v2/courses', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const courses = await query(
            'SELECT id, name, description, level FROM checkin_courses WHERE is_active = 1 ORDER BY sort_order, id'
        );
        for (const c of courses) {
            const [cnt] = await query(
                'SELECT COUNT(*) as cnt FROM checkin_course_items WHERE course_id = ? AND task_type = "word" AND is_active = 1',
                [c.id]
            );
            c.wordCount = cnt ? cnt.cnt : 0;
        }
        const [user] = await query('SELECT current_course_id, daily_word_target, daily_passing_score FROM users WHERE id = ?', [userId]);
        res.json({
            success: true,
            data: {
                courses,
                currentCourseId: user ? user.current_course_id : null,
                dailyTarget: user ? (user.daily_word_target || 10) : 10,
                passingScore: user ? (user.daily_passing_score || 60) : 60
            }
        });
    } catch (e) {
        console.error('v2/courses error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * POST /checkin/v2/enroll - 报名课程
 * body: { course_id, daily_target }
 */
router.post('/v2/enroll', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { course_id, daily_target = 10 } = req.body;
        if (!course_id) return res.status(400).json({ success: false, message: '请选择课程' });

        const target = Math.min(50, Math.max(1, Number(daily_target)));
        const [course] = await query('SELECT id, name, is_vip FROM checkin_courses WHERE id = ? AND is_active = 1', [course_id]);
        if (!course) return res.status(404).json({ success: false, message: '课程不存在' });

        // VIP 课程鉴权
        if (course.is_vip) {
            const [user] = await query('SELECT vip_level, vip_expire_date FROM users WHERE id = ?', [userId]);
            const today = new Date().toISOString().split('T')[0];
            const isVip = user && user.vip_level > 0 && user.vip_expire_date && user.vip_expire_date >= today;
            if (!isVip) {
                return res.json({ success: false, message: '该课程为VIP专属，请先开通会员', code: 'VIP_REQUIRED' });
            }
        }

        await query(
            'UPDATE users SET current_course_id = ?, daily_word_target = ?, checkin_strategy = "curriculum" WHERE id = ?',
            [course_id, target, userId]
        );

        // 删除今天未完成的计划，让今天重新生成
        const today = new Date().toISOString().split('T')[0];
        const [todayPlan] = await query(
            'SELECT id, is_completed FROM daily_task_plans WHERE user_id = ? AND task_date = ?',
            [userId, today]
        );
        if (todayPlan && !todayPlan.is_completed) {
            await query('DELETE FROM daily_task_items WHERE plan_id = ?', [todayPlan.id]);
            await query('DELETE FROM daily_task_plans WHERE id = ?', [todayPlan.id]);
        }

        res.json({ success: true, message: `已报名《${course.name}》`, data: { course } });
    } catch (e) {
        console.error('v2/enroll error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * GET /checkin/v2/today - 获取今日单词列表
 */
router.get('/v2/today', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const today = new Date().toISOString().split('T')[0];

        const [user] = await query(
            'SELECT current_course_id, daily_word_target FROM users WHERE id = ?',
            [userId]
        );
        if (!user || !user.current_course_id) {
            return res.json({ success: false, message: '请先选择课程' });
        }

        const courseId = user.current_course_id;
        const dailyTarget = Number(user.daily_word_target) || 10;

        let [plan] = await query(
            'SELECT * FROM daily_task_plans WHERE user_id = ? AND task_date = ?',
            [userId, today]
        );

        if (!plan) {
            // 获取已学过的 course_item_id（历史任意日期）
            const learnedRows = await query(`
                SELECT DISTINCT course_item_id
                FROM daily_task_items
                WHERE user_id = ? AND status = 'completed' AND course_item_id IN (
                    SELECT id FROM checkin_course_items WHERE course_id = ? AND task_type = 'word'
                )
            `, [userId, courseId]);
            const learnedIds = new Set(learnedRows.map(r => r.course_item_id));

            // 课程所有单词（按顺序）
            const courseItems = await query(`
                SELECT ci.id as course_item_id, ci.target_id as word_id, ci.sort_order
                FROM checkin_course_items ci
                WHERE ci.course_id = ? AND ci.task_type = 'word' AND ci.is_active = 1
                ORDER BY ci.sort_order, ci.id
            `, [courseId]);

            let todayItems = courseItems.filter(ci => !learnedIds.has(ci.course_item_id));
            // 课程快学完时，用已学的补充（复习）
            if (todayItems.length < dailyTarget) {
                const reviewItems = courseItems.filter(ci => learnedIds.has(ci.course_item_id));
                todayItems = [...todayItems, ...reviewItems].slice(0, dailyTarget);
            }
            todayItems = todayItems.slice(0, dailyTarget);

            // 创建计划
            const planResult = await query(
                `INSERT INTO daily_task_plans (user_id, task_date, mode, strategy, course_id, word_target, scene_target, podcast_target)
                 VALUES (?, ?, 'easy', 'curriculum', ?, ?, 0, 0)`,
                [userId, today, courseId, dailyTarget]
            );
            const planId = planResult.insertId;

            if (todayItems.length > 0) {
                const wordIds = todayItems.map(i => i.word_id);
                const words = await query(
                    `SELECT id, word, phonetic, translation, image_url, audio_url_female, audio_url_male, example_sentence, example_translation
                     FROM words WHERE id IN (${wordIds.map(() => '?').join(',')})`,
                    wordIds
                );
                const wordMap = {};
                words.forEach(w => { wordMap[w.id] = w; });

                for (let i = 0; i < todayItems.length; i++) {
                    const ci = todayItems[i];
                    const word = wordMap[ci.word_id];
                    if (!word) continue;
                    await query(
                        `INSERT INTO daily_task_items (plan_id, user_id, task_type, target_id, course_item_id, reference_text, extra_info, status, sort_order)
                         VALUES (?, ?, 'word', ?, ?, ?, ?, 'pending', ?)`,
                        [planId, userId, word.id, ci.course_item_id, word.word, JSON.stringify({
                            word: word.word, phonetic: word.phonetic, translation: word.translation,
                            image_url: word.image_url, audio_url_female: word.audio_url_female, audio_url_male: word.audio_url_male,
                            example_sentence: word.example_sentence, example_translation: word.example_translation
                        }), i]
                    );
                }
            }

            [plan] = await query('SELECT * FROM daily_task_plans WHERE id = ?', [planId]);
        }

        const items = await query(
            `SELECT dti.id, dti.status, dti.course_item_id, dti.target_id, dti.sort_order,
                    w.word, w.phonetic, w.translation, w.image_url,
                    w.audio_url_female, w.audio_url_male,
                    w.example_sentence, w.example_translation,
                    w.example_audio_female, w.example_audio_male
             FROM daily_task_items dti
             LEFT JOIN words w ON w.id = dti.target_id
             WHERE dti.plan_id = ? AND dti.task_type = 'word'
             ORDER BY dti.sort_order, dti.id`,
            [plan.id]
        );

        const [stats] = await query('SELECT consecutive_days FROM checkin_stats WHERE user_id = ?', [userId]);

        res.json({
            success: true,
            data: {
                planId: plan.id,
                dailyTarget: plan.word_target,
                doneCount: plan.word_completed || 0,
                isComplete: !!plan.is_completed,
                streakDays: stats ? stats.consecutive_days : 0,
                items: items.map(item => ({
                    id: item.id,
                    status: item.status,
                    courseItemId: item.course_item_id,
                    wordId: item.target_id,
                    word: item.word,
                    phonetic: item.phonetic,
                    translation: item.translation,
                    image_url: item.image_url,
                    audio_url_female: item.audio_url_female,
                    audio_url_male: item.audio_url_male,
                    example_sentence: item.example_sentence,
                    example_translation: item.example_translation,
                    example_audio_female: item.example_audio_female,
                    example_audio_male: item.example_audio_male,
                }))
            }
        });
    } catch (e) {
        console.error('v2/today error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * POST /checkin/v2/done - 标记单词已学
 * body: { item_id }
 */
router.post('/v2/done', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { item_id, assessment_id } = req.body;
        if (!item_id) return res.status(400).json({ success: false, message: '参数错误' });

        const [item] = await query('SELECT * FROM daily_task_items WHERE id = ? AND user_id = ?', [item_id, userId]);
        if (!item) return res.status(404).json({ success: false, message: '任务不存在' });

        if (item.status !== 'completed') {
            if (assessment_id) {
                // 从 voice_assessments 取回录音地址和评分，一并写入 daily_task_items
                const [assessment] = await query(
                    'SELECT * FROM voice_assessments WHERE id = ? AND user_id = ?',
                    [assessment_id, userId]
                );
                if (assessment) {
                    await query(
                        `UPDATE daily_task_items
                         SET status = "completed", assessment_id = ?, audio_url = ?,
                             score = ?, pronunciation_score = ?, fluency_score = ?, integrity_score = ?,
                             completed_at = NOW()
                         WHERE id = ?`,
                        [assessment.id, assessment.audio_url,
                         assessment.overall_score, assessment.pronunciation_score,
                         assessment.fluency_score, assessment.integrity_score,
                         item_id]
                    );
                } else {
                    await query('UPDATE daily_task_items SET status = "completed", completed_at = NOW() WHERE id = ?', [item_id]);
                }
            } else {
                await query('UPDATE daily_task_items SET status = "completed", completed_at = NOW() WHERE id = ?', [item_id]);
            }
        }

        const [plan] = await query('SELECT * FROM daily_task_plans WHERE id = ?', [item.plan_id]);
        if (!plan) return res.json({ success: true, data: { doneCount: 1, isComplete: false, streakDays: 0, newAchievements: [] } });

        // 重新统计已完成数（避免重复计数）
        const [cntRow] = await query(
            'SELECT COUNT(*) as cnt FROM daily_task_items WHERE plan_id = ? AND status = "completed"',
            [plan.id]
        );
        const newDoneCount = cntRow ? cntRow.cnt : 0;
        const isComplete = newDoneCount >= (plan.word_target || 10);

        if (isComplete && !plan.is_completed) {
            await query('UPDATE daily_task_plans SET word_completed = ?, is_completed = 1, completed_at = NOW() WHERE id = ?',
                [newDoneCount, plan.id]);
            const today = new Date().toISOString().split('T')[0];
            await updateCheckinStats(userId, today, 0);
        } else {
            await query('UPDATE daily_task_plans SET word_completed = ? WHERE id = ?', [newDoneCount, plan.id]);
        }

        // 更新单词学习记录
        if (item.target_id) {
            try {
                await query(`
                    INSERT INTO word_learning_records (user_id, word_id, learning_count, mastery_level, last_learned_at, updated_at)
                    VALUES (?, ?, 1, 1, NOW(), NOW())
                    ON DUPLICATE KEY UPDATE learning_count = learning_count + 1,
                        mastery_level = LEAST(mastery_level + 1, 5), last_learned_at = NOW(), updated_at = NOW()
                `, [userId, item.target_id]);
            } catch (e) { /* word_learning_records 可能不存在，忽略 */ }
        }

        const newAchievements = isComplete ? await checkAchievements(userId) : [];
        const [stats] = await query('SELECT consecutive_days FROM checkin_stats WHERE user_id = ?', [userId]);

        res.json({
            success: true,
            data: { doneCount: newDoneCount, dailyTarget: plan.word_target, isComplete, streakDays: stats ? stats.consecutive_days : 0, newAchievements }
        });
    } catch (e) {
        console.error('v2/done error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

/**
 * POST /checkin/v2/settings - 更新每日目标和及格分数
 * body: { daily_target?, passing_score? }
 */
router.post('/v2/settings', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const { daily_target, passing_score } = req.body;
        const updates = [];
        const params = [];

        if (daily_target !== undefined) {
            updates.push('daily_word_target = ?');
            params.push(Math.min(50, Math.max(1, Number(daily_target))));
        }
        if (passing_score !== undefined) {
            const validScores = [60, 70, 80, 90];
            updates.push('daily_passing_score = ?');
            params.push(validScores.includes(Number(passing_score)) ? Number(passing_score) : 60);
        }

        if (updates.length > 0) {
            params.push(userId);
            await query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        }

        res.json({ success: true });
    } catch (e) {
        console.error('v2/settings error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
