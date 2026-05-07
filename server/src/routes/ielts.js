const express = require('express');
const { query } = require('../config/database');
const { authMiddleware } = require('../middlewares/auth');
const { enrichVocabularyModule } = require('../services/ielts-vocabulary.service');

const router = express.Router();

const COURSE_CODE = 'ielts-general-7-foundation';

const DAY1_MODULES = [
    {
        type: 'vocabulary',
        title: '单词 20 个',
        minutes: 30,
        required: true,
        content: {
            method: ['读 3 遍', '抄 1 遍', '用它说一个短句'],
            words: [
                ['I', '我', 'I am Chen.', '我是陈。'],
                ['you', '你', 'You are my friend.', '你是我的朋友。'],
                ['he', '他', 'He is a teacher.', '他是一名老师。'],
                ['she', '她', 'She is kind.', '她很友善。'],
                ['we', '我们', 'We study English.', '我们学习英语。'],
                ['they', '他们', 'They are students.', '他们是学生。'],
                ['name', '名字', 'My name is Chen.', '我的名字叫陈。'],
                ['China', '中国', 'I am from China.', '我来自中国。'],
                ['Chinese', '中国人/中文', 'I am Chinese.', '我是中国人。'],
                ['English', '英语', 'I study English.', '我学习英语。'],
                ['work', '工作', 'I work every day.', '我每天工作。'],
                ['job', '工作/职业', 'My job is good.', '我的工作不错。'],
                ['family', '家庭', 'I have a family.', '我有一个家庭。'],
                ['city', '城市', 'I live in a city.', '我住在一个城市里。'],
                ['home', '家', 'I am at home.', '我在家。'],
                ['like', '喜欢', 'I like English.', '我喜欢英语。'],
                ['want', '想要', 'I want to learn English.', '我想学习英语。'],
                ['learn', '学习', 'I learn English.', '我学习英语。'],
                ['study', '学习', 'I study English.', '我学习英语。'],
                ['future', '未来', 'I want a better future.', '我想要一个更好的未来。']
            ],
            focus_words: ['English', 'learn', 'study', 'work', 'future', 'China', 'Chinese', 'family', 'job', 'want']
        }
    },
    {
        type: 'grammar',
        title: '语法：I am / I want to',
        minutes: 25,
        required: true,
        content: {
            patterns: [
                {
                    title: 'I am...',
                    meaning: '我是……',
                    structure: 'I am + 身份/状态/地方',
                    examples: [
                        ['I am Chen.', '我是陈。'],
                        ['I am Chinese.', '我是中国人。'],
                        ['I am from China.', '我来自中国。'],
                        ['I am forty years old.', '我40岁。'],
                        ['I am a beginner.', '我是初学者。']
                    ]
                },
                {
                    title: 'I want to...',
                    meaning: '我想要做……',
                    structure: 'I want to + 动词',
                    examples: [
                        ['I want to learn English.', '我想学英语。'],
                        ['I want to improve my English.', '我想提高英语。'],
                        ['I want to take the IELTS test.', '我想考雅思。'],
                        ['I want to move to another country.', '我想去另一个国家生活。'],
                        ['I want to have more choices.', '我想有更多选择。']
                    ]
                }
            ]
        }
    },
    {
        type: 'listening',
        title: '听力 + 跟读',
        minutes: 25,
        required: true,
        content: {
            text: 'Hello, my name is Chen. I am from China. I am Chinese. I work as a software engineer. I want to learn English. I want to take the IELTS General Training test. I study English for two hours every day. English is not easy, but I will keep going.',
            translation: '你好，我叫陈。我来自中国。我是中国人。我是一名软件工程师。我想学习英语。我想参加雅思 General Training 考试。我每天学习英语两个小时。英语不容易，但我会坚持下去。',
            steps: ['第1遍：只听，不读', '第2遍：一句一句跟读', '第3遍：看英文跟读', '第4遍：不看中文，只看英文读', '第5遍：录音']
        }
    },
    {
        type: 'speaking',
        title: '口语输出：30 秒自我介绍',
        minutes: 20,
        required: true,
        content: {
            podcast_content_id: 58,
            pass_score: 80
        }
    },
    {
        type: 'writing',
        title: '写作：About Me 5 句',
        minutes: 20,
        required: true,
        content: {
            podcast_content_id: 62,
            pass_score: 80
        }
    }
];

let initialized = false;

function parseJson(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
}

function normalizeItemKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_\u4e00-\u9fa5-]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 80);
}

function makeItem(raw, index, fallbackType, fallbackTitle = '') {
    const title = raw.title || raw.word || raw.text || raw.prompt || fallbackTitle || `任务 ${index + 1}`;
    const stableKey = raw.key || raw.id;
    const keySource = raw.word || raw.title || raw.text || `${fallbackType}-${index + 1}`;
    return {
        key: normalizeItemKey(stableKey || `${index + 1}-${keySource}`) || `${fallbackType}-${index + 1}`,
        type: raw.type || fallbackType,
        title: String(title).slice(0, 120),
        subtitle: raw.subtitle || raw.translation || raw.meaning || raw.hint || '',
        prompt: raw.prompt || raw.example || raw.text || '',
        required: raw.required !== false,
        pass_score: raw.pass_score || raw.passScore || null,
        payload: raw
    };
}

function normalizeGrammarItem(row) {
    return {
        key: `grammar-${row.id || row.sort_order || ''}`.replace(/-$/, ''),
        type: 'grammar_drill',
        title: row.example_sentence || row.title || row.pattern || `语法训练 ${row.sort_order || ''}`,
        subtitle: row.example_translation || row.meaning || row.pattern || '',
        prompt: row.target_output || row.example_sentence || row.pattern || '',
        pattern_title: row.title || '',
        structure: row.pattern || '',
        grammar_explanation: row.explanation || '',
        example_sentence: row.example_sentence || row.target_output || '',
        example_translation: row.example_translation || row.meaning || '',
        pass_score: row.pass_score || 80,
        payload: {
            grammar_item_id: row.id,
            title: row.title || '',
            pattern: row.pattern || '',
            meaning: row.meaning || '',
            explanation: row.explanation || '',
            grammar_explanation: row.explanation || '',
            example_sentence: row.example_sentence || '',
            example_translation: row.example_translation || '',
            target_output: row.target_output || row.example_sentence || '',
            pass_score: row.pass_score || 80
        }
    };
}

function normalizePodcastItem(content = {}, module = {}) {
    const podcastId = content.podcast_content_id || content.podcast_id;
    const isSpeaking = ['speaking', 'speaking_output'].includes(module.module_type);
    const isWriting = ['writing', 'sentence_builder', 'typing_writing'].includes(module.module_type);
    const title = (module.podcast_content && module.podcast_content.title) || content.title || module.title || (isSpeaking ? '口语文章' : (isWriting ? '写作文章' : '听力文章'));
    return {
        key: `podcast-${podcastId || module.id}`,
        type: isSpeaking ? 'speaking_output' : (isWriting ? 'sentence_builder' : 'podcast_listening'),
        title,
        subtitle: (module.podcast_content && module.podcast_content.title_en) || content.translation || '',
        prompt: (module.podcast_content && module.podcast_content.content_text) || content.text || '',
        pass_score: content.pass_score || 80,
        payload: {
            podcast_content_id: podcastId || null,
            podcast_title: title,
            podcast_mode: isSpeaking ? 'speaking' : (isWriting ? 'writing' : 'listening'),
            translation: (module.podcast_content && module.podcast_content.translation) || content.translation || '',
            sentence_count: module.podcast_content ? module.podcast_content.sentence_count : 0,
            pass_score: content.pass_score || 80
        }
    };
}

function getItemExampleText(item) {
    const payload = item && item.payload ? item.payload : {};
    const example = payload.example_sentence || payload.example || payload.sentence || payload.sample || '';
    if (example) return String(example).trim();
    if (item && item.type === 'word' && item.prompt && item.prompt !== item.title) return String(item.prompt).trim();
    return '';
}

function getItemRequiredParts(item) {
    if (!item) return ['main'];
    const hasExample = !!getItemExampleText(item);
    if (item.type === 'word' && hasExample) return ['main', 'example'];
    return ['main'];
}

function getPassedParts(progressRow, data = {}) {
    const parts = data.passed_parts && typeof data.passed_parts === 'object'
        ? { ...data.passed_parts }
        : {};
    const legacyKind = data.assessed_kind || data.kind;
    if (progressRow && progressRow.status === 'completed' && legacyKind && !parts[legacyKind]) {
        parts[legacyKind] = {
            score: progressRow.score,
            assessment_id: progressRow.assessment_id,
            reference_text: data.reference_text || '',
            content_type: data.content_type || '',
            passed_at: progressRow.completed_at || null
        };
    }
    if (progressRow && progressRow.status === 'completed' && data.assessed && !legacyKind && !parts.main) {
        parts.main = {
            score: progressRow.score,
            assessment_id: progressRow.assessment_id,
            reference_text: data.reference_text || '',
            content_type: data.content_type || '',
            passed_at: progressRow.completed_at || null
        };
    }
    return parts;
}

function buildModuleItems(module) {
    const content = parseJson(module.content_json || module.content, {});
    const type = module.module_type;
    if ((type === 'grammar' || type === 'grammar_drill') && Array.isArray(module.grammar_items) && module.grammar_items.length) {
        return module.grammar_items
            .filter(item => item.is_active !== 0)
            .map((item, index) => makeItem(normalizeGrammarItem(item), index, 'grammar_drill'));
    }

    if (Array.isArray(content.items) && content.items.length) {
        return content.items.map((item, index) => makeItem(item, index, item.type || type));
    }

    if (type === 'vocabulary' && Array.isArray(content.words)) {
        return content.words.map((word, index) => {
            const value = Array.isArray(word)
                ? { word: word[0], translation: word[1], example: word[2], example_translation: word[3] || '', type: 'word' }
                : {
                    ...word,
                    type: word.type || 'word',
                    example: word.example || word.example_sentence || word.sentence || '',
                    example_translation: word.example_translation || word.exampleTranslation || word.example_cn || ''
                };
            return makeItem(value, index, 'word');
        });
    }

    if ((type === 'grammar' || type === 'grammar_drill') && Array.isArray(content.patterns)) {
        const grammarItems = [];
        content.patterns.forEach((pattern) => {
            if (Array.isArray(pattern.examples) && pattern.examples.length) {
                pattern.examples.forEach((example) => {
                    const en = Array.isArray(example) ? example[0] : (example.text || example.en || example.sentence || '');
                    const cn = Array.isArray(example) ? example[1] : (example.translation || example.cn || '');
                    grammarItems.push({
                        type: 'grammar_drill',
                        title: en || pattern.title,
                        subtitle: cn || pattern.meaning || pattern.structure,
                        prompt: en,
                        pattern_title: pattern.title,
                        structure: pattern.structure
                    });
                });
            } else {
                grammarItems.push({
                    type: 'grammar_drill',
                    title: pattern.title,
                    subtitle: pattern.meaning || pattern.structure,
                    prompt: pattern.structure,
                    pattern
                });
            }
        });
        return grammarItems.map((item, index) => makeItem(item, index, 'grammar_drill'));
    }

    if ((type === 'listening' || type === 'podcast_listening' || type === 'shadowing') && Array.isArray(content.sentences)) {
        return content.sentences.map((sentence, index) => makeItem({
            type: type === 'listening' ? 'shadowing' : type,
            title: `跟读句子 ${index + 1}`,
            subtitle: sentence.translation || '',
            prompt: sentence.text || sentence.en || sentence
        }, index, 'shadowing'));
    }

    if ((type === 'listening' || type === 'podcast_listening' || type === 'speaking' || type === 'speaking_output' || type === 'writing' || type === 'sentence_builder' || type === 'typing_writing') && (content.podcast_content_id || content.podcast_id)) {
        const fallbackType = ['speaking', 'speaking_output'].includes(type)
            ? 'speaking_output'
            : (['writing', 'sentence_builder', 'typing_writing'].includes(type) ? 'sentence_builder' : 'podcast_listening');
        return [makeItem(normalizePodcastItem(content, module), 0, fallbackType)];
    }

    if (type === 'listening' || type === 'podcast_listening' || type === 'shadowing') {
        return [makeItem({
            type,
            title: type === 'podcast_listening' ? '听力文章' : '听力跟读',
            subtitle: content.translation || '',
            prompt: content.text || ''
        }, 0, type)];
    }

    if (type === 'speaking' || type === 'speaking_output' || type === 'writing' || type === 'sentence_builder' || type === 'typing_writing') {
        // 口语/写作统一绑定磨耳朵文章；不再回退到旧 prompt/sample，避免课程内容和后台绑定文章不一致。
        return [];
    }

    return [makeItem({
        type,
        title: module.title,
        subtitle: content.summary || '',
        prompt: content.target_output || ''
    }, 0, type || 'task')];
}

function attachProgressToItems(items, progressRows) {
    const progressMap = new Map((progressRows || []).map(row => [row.item_key, row]));
    return items.map(item => {
        const progress = progressMap.get(item.key);
        const progressData = progress ? parseJson(progress.progress_json, {}) : {};
        const requiredParts = getItemRequiredParts(item);
        const passedParts = getPassedParts(progress, progressData);
        const partWorkflowComplete = requiredParts.every(part => !!passedParts[part]);
        const completed = progress && progress.status === 'completed' && partWorkflowComplete;
        return {
            ...item,
            completed,
            progress: {
                status: progress ? progress.status : 'pending',
                score: progress ? progress.score : null,
                assessment_id: progress ? progress.assessment_id : null,
                answer_text: progress ? progress.answer_text : null,
                data: progressData,
                required_parts: requiredParts,
                passed_parts: passedParts,
                completed_parts: requiredParts.filter(part => !!passedParts[part]).length,
                completed_at: progress ? progress.completed_at : null
            }
        };
    });
}

function summarizeItems(items) {
    const required = items.filter(item => item.required !== false);
    const completedRequired = required.filter(item => item.completed).length;
    return {
        total: items.length,
        required_count: required.length,
        completed_required: completedRequired,
        complete: required.length === 0 || completedRequired >= required.length
    };
}

async function ensureIeltsTables() {
    if (initialized) return;

    await query(`CREATE TABLE IF NOT EXISTS ielts_courses (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(80) NOT NULL UNIQUE,
        title VARCHAR(160) NOT NULL,
        title_en VARCHAR(160) DEFAULT NULL,
        description TEXT,
        target_score VARCHAR(30) DEFAULT NULL,
        duration_days INT DEFAULT 30,
        daily_minutes INT DEFAULT 120,
        level_label VARCHAR(80) DEFAULT NULL,
        is_active TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        metadata JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_days (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        day_number INT NOT NULL,
        title VARCHAR(160) NOT NULL,
        theme VARCHAR(120) DEFAULT NULL,
        objective TEXT,
        estimated_minutes INT DEFAULT 120,
        preview_next TEXT,
        is_active TINYINT(1) DEFAULT 1,
        metadata JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_course_day (course_id, day_number),
        KEY idx_course (course_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_day_modules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        day_id INT NOT NULL,
        module_type VARCHAR(40) NOT NULL,
        title VARCHAR(160) NOT NULL,
        estimated_minutes INT DEFAULT 0,
        is_required TINYINT(1) DEFAULT 1,
        sort_order INT DEFAULT 0,
        content_json JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_day_module_sort (day_id, sort_order),
        KEY idx_day (day_id),
        KEY idx_type (module_type)
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
        KEY idx_module_active (module_id, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_user_enrollments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        course_id INT NOT NULL,
        start_date DATE NOT NULL,
        current_day INT DEFAULT 1,
        status ENUM('active','paused','completed') DEFAULT 'active',
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_course (user_id, course_id),
        KEY idx_user (user_id),
        KEY idx_course (course_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_module_progress (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        course_id INT NOT NULL,
        day_id INT NOT NULL,
        module_id INT NOT NULL,
        status ENUM('pending','completed') DEFAULT 'pending',
        score DECIMAL(5,2) DEFAULT NULL,
        assessment_id INT DEFAULT NULL,
        answer_text TEXT DEFAULT NULL,
        progress_json JSON DEFAULT NULL,
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_module (user_id, module_id),
        KEY idx_user_course (user_id, course_id),
        KEY idx_day (day_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await query(`CREATE TABLE IF NOT EXISTS ielts_module_item_progress (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        course_id INT NOT NULL,
        day_id INT NOT NULL,
        module_id INT NOT NULL,
        item_key VARCHAR(120) NOT NULL,
        item_type VARCHAR(40) DEFAULT NULL,
        status ENUM('pending','completed') DEFAULT 'pending',
        score DECIMAL(5,2) DEFAULT NULL,
        assessment_id INT DEFAULT NULL,
        answer_text TEXT DEFAULT NULL,
        audio_url VARCHAR(500) DEFAULT NULL,
        progress_json JSON DEFAULT NULL,
        completed_at TIMESTAMP NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_module_item (user_id, module_id, item_key),
        KEY idx_user_course (user_id, course_id),
        KEY idx_day (day_id),
        KEY idx_module (module_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await seedDayOne();
    initialized = true;
}

async function seedDayOne() {
    const metadata = {
        month_goal: {
            words: '500-800 个基础词',
            grammar: '会用 I am / I have / I like / I want / I can',
            listening: '能听懂慢速简单句',
            speaking: '能自我介绍 1 分钟',
            writing: '能写 80-100 词小短文'
        },
        weeks: [
            '第1周：自我介绍 + 基础句型',
            '第2周：时间、数字、购物、交通',
            '第3周：住房、健康、预约、服务',
            '第4周：简单邮件 + 口语表达'
        ]
    };

    let [course] = await query('SELECT id FROM ielts_courses WHERE code = ?', [COURSE_CODE]);
    if (!course) {
        await query(`INSERT INTO ielts_courses
            (code, title, title_en, description, target_score, duration_days, daily_minutes, level_label, is_active, sort_order, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 10, ?)`, [
            COURSE_CODE,
            'IELTS General Training',
            'IELTS General Training',
            '阶段目标先稳住 7.0，同时按更高分能力建设：单词、基础句型、慢速听力、口语表达与短文写作。',
            '7.0',
            30,
            120,
            '基础薄弱 / 长期路线',
            JSON.stringify(metadata)
        ]);
        [course] = await query('SELECT id FROM ielts_courses WHERE code = ?', [COURSE_CODE]);
    }
    if (!course) return;

    let [day] = await query('SELECT id FROM ielts_days WHERE course_id = ? AND day_number = 1', [course.id]);
    if (!day) {
        await query(`INSERT INTO ielts_days
            (course_id, day_number, title, theme, objective, estimated_minutes, preview_next, is_active, metadata)
            VALUES (?, 1, ?, ?, ?, 120, ?, 1, ?)`, [
            course.id,
            'Day 1 自我介绍',
            'Self-introduction 自我介绍',
            '能用英语说出自己的名字、来自哪里、职业和学习英语的原因。',
            'Day 2 Family 家庭：家庭成员、I have... / My family has...、介绍自己的家庭。',
            JSON.stringify({ source: '雅思课程.md', output: '20个单词 + 2个句型 + 1段自我介绍 + 1次录音 + 5句写作' })
        ]);
        [day] = await query('SELECT id FROM ielts_days WHERE course_id = ? AND day_number = 1', [course.id]);
    }
    if (!day) return;

    for (let index = 0; index < DAY1_MODULES.length; index++) {
        const mod = DAY1_MODULES[index];
        const [existingModule] = await query(
            'SELECT id FROM ielts_day_modules WHERE day_id = ? AND sort_order = ?',
            [day.id, index + 1]
        );
        if (!existingModule) {
            await query(`INSERT INTO ielts_day_modules
                (day_id, module_type, title, estimated_minutes, is_required, sort_order, content_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)`, [
                day.id,
                mod.type,
                mod.title,
                mod.minutes,
                mod.required ? 1 : 0,
                index + 1,
                JSON.stringify(mod.content)
            ]);
        }
    }
}

router.use(async (req, res, next) => {
    try {
        await ensureIeltsTables();
        next();
    } catch (error) {
        console.error('[ielts] 初始化失败:', error);
        res.status(500).json({ success: false, message: 'IELTS 课程初始化失败' });
    }
});

async function getCourse() {
    const [course] = await query('SELECT * FROM ielts_courses WHERE code = ? AND is_active = 1', [COURSE_CODE]);
    if (!course) return null;
    course.metadata = parseJson(course.metadata, {});
    return course;
}

async function getEnrollment(userId, courseId) {
    const [enrollment] = await query(
        'SELECT * FROM ielts_user_enrollments WHERE user_id = ? AND course_id = ?',
        [userId, courseId]
    );
    return enrollment || null;
}

router.get('/overview', authMiddleware, async (req, res) => {
    try {
        const course = await getCourse();
        if (!course) return res.status(404).json({ success: false, message: '课程不存在' });

        const enrollment = await getEnrollment(req.user.id, course.id);
        const days = await query(`
            SELECT d.*,
                   COUNT(m.id) AS module_count,
                   SUM(CASE WHEN m.is_required = 1 THEN 1 ELSE 0 END) AS required_count,
                   SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS completed_count
            FROM ielts_days d
            LEFT JOIN ielts_day_modules m ON m.day_id = d.id
            LEFT JOIN ielts_module_progress p ON p.module_id = m.id AND p.user_id = ?
            WHERE d.course_id = ? AND d.is_active = 1
            GROUP BY d.id
            ORDER BY d.day_number ASC`, [req.user.id, course.id]);

        const currentDay = enrollment ? Number(enrollment.current_day || 1) : 1;
        res.json({
            success: true,
            data: {
                course,
                enrolled: !!enrollment,
                enrollment,
                current_day: currentDay,
                days: days.map(day => ({
                    ...day,
                    metadata: parseJson(day.metadata, {}),
                    module_count: Number(day.module_count || 0),
                    required_count: Number(day.required_count || 0),
                    completed_count: Number(day.completed_count || 0),
                    locked: !enrollment ? day.day_number > 1 : day.day_number > currentDay + 1
                }))
            }
        });
    } catch (error) {
        console.error('[ielts] overview error:', error);
        res.status(500).json({ success: false, message: '获取 IELTS 课程失败' });
    }
});

router.post('/enroll', authMiddleware, async (req, res) => {
    try {
        const course = await getCourse();
        if (!course) return res.status(404).json({ success: false, message: '课程不存在' });

        await query(`INSERT INTO ielts_user_enrollments (user_id, course_id, start_date, current_day, status)
            VALUES (?, ?, CURDATE(), 1, 'active')
            ON DUPLICATE KEY UPDATE status = 'active', updated_at = NOW()`, [req.user.id, course.id]);

        const enrollment = await getEnrollment(req.user.id, course.id);
        res.json({ success: true, data: { enrollment }, message: '已开始 IELTS 学习计划' });
    } catch (error) {
        console.error('[ielts] enroll error:', error);
        res.status(500).json({ success: false, message: '开始课程失败' });
    }
});

router.get('/days/:dayNumber', authMiddleware, async (req, res) => {
    try {
        const dayNumber = Math.max(1, Number(req.params.dayNumber || 1));
        const course = await getCourse();
        if (!course) return res.status(404).json({ success: false, message: '课程不存在' });

        const [day] = await query(
            'SELECT * FROM ielts_days WHERE course_id = ? AND day_number = ? AND is_active = 1',
            [course.id, dayNumber]
        );
        if (!day) return res.status(404).json({ success: false, message: '今日课程暂未开放' });

        const modules = await query(`
            SELECT m.*, p.status AS progress_status, p.score, p.assessment_id, p.answer_text,
                   p.progress_json, p.completed_at
            FROM ielts_day_modules m
            LEFT JOIN ielts_module_progress p ON p.module_id = m.id AND p.user_id = ?
            WHERE m.day_id = ?
            ORDER BY m.sort_order ASC`, [req.user.id, day.id]);

        const moduleIds = modules.map(m => m.id);
        let podcastById = {};
        const podcastIds = [...new Set(modules.map((m) => {
            const content = parseJson(m.content_json, {});
            return Number(content.podcast_content_id || content.podcast_id || 0);
        }).filter(id => Number.isInteger(id) && id > 0))];
        if (podcastIds.length) {
            const placeholders = podcastIds.map(() => '?').join(',');
            const podcastRows = await query(`
                SELECT id, title, title_en, content_text, translation, duration_seconds,
                       female_audio_url, male_audio_url, chinese_audio_url, sentences_data
                FROM podcast_contents
                WHERE id IN (${placeholders})
            `, podcastIds);
            podcastById = podcastRows.reduce((acc, row) => {
                let sentenceCount = 0;
                if (row.sentences_data && row.sentences_data !== 'processing') {
                    try {
                        const parsed = typeof row.sentences_data === 'string' ? JSON.parse(row.sentences_data) : row.sentences_data;
                        sentenceCount = Array.isArray(parsed && parsed.sentences) ? parsed.sentences.length : 0;
                    } catch (_) {}
                }
                acc[row.id] = {
                    id: row.id,
                    title: row.title,
                    title_en: row.title_en,
                    content_text: row.content_text,
                    translation: row.translation,
                    duration_seconds: row.duration_seconds,
                    female_audio_url: row.female_audio_url,
                    male_audio_url: row.male_audio_url,
                    chinese_audio_url: row.chinese_audio_url,
                    sentence_count: sentenceCount
                };
                return acc;
            }, {});
        }

        let grammarItemsByModule = {};
        const grammarModuleIds = modules
            .filter(m => m.module_type === 'grammar' || m.module_type === 'grammar_drill')
            .map(m => m.id);
        if (grammarModuleIds.length) {
            const placeholders = grammarModuleIds.map(() => '?').join(',');
            const grammarRows = await query(
                `SELECT *
                 FROM ielts_grammar_items
                 WHERE module_id IN (${placeholders}) AND is_active = 1
                 ORDER BY sort_order ASC, id ASC`,
                grammarModuleIds
            );
            grammarItemsByModule = grammarRows.reduce((acc, row) => {
                if (!acc[row.module_id]) acc[row.module_id] = [];
                acc[row.module_id].push(row);
                return acc;
            }, {});
        }

        let itemProgressRows = [];
        if (moduleIds.length) {
            const placeholders = moduleIds.map(() => '?').join(',');
            itemProgressRows = await query(
                `SELECT * FROM ielts_module_item_progress WHERE user_id = ? AND module_id IN (${placeholders})`,
                [req.user.id, ...moduleIds]
            );
        }
        const itemProgressByModule = itemProgressRows.reduce((acc, row) => {
            if (!acc[row.module_id]) acc[row.module_id] = [];
            acc[row.module_id].push(row);
            return acc;
        }, {});

        const normalizedModules = await Promise.all(modules.map(async (rawModule) => {
            const m = await enrichVocabularyModule(rawModule);
            if (m.module_type === 'grammar' || m.module_type === 'grammar_drill') {
                m.grammar_items = grammarItemsByModule[m.id] || [];
            }
            const content = parseJson(m.content_json, {});
            const podcastId = Number(content.podcast_content_id || content.podcast_id || 0);
            if (podcastId && podcastById[podcastId]) {
                m.podcast_content = podcastById[podcastId];
            }
            const items = attachProgressToItems(buildModuleItems(m), itemProgressByModule[m.id] || []);
            const itemSummary = summarizeItems(items);
            const completed = items.length ? itemSummary.complete : m.progress_status === 'completed';
            return {
                id: m.id,
                day_id: m.day_id,
                module_type: m.module_type,
                title: m.title,
                estimated_minutes: m.estimated_minutes,
                is_required: !!m.is_required,
                sort_order: m.sort_order,
                content,
                podcast_content: m.podcast_content || null,
                items,
                item_summary: itemSummary,
                progress: {
                    status: completed ? 'completed' : (m.progress_status || 'pending'),
                    completed,
                    score: m.score,
                    assessment_id: m.assessment_id,
                    answer_text: m.answer_text,
                    data: parseJson(m.progress_json, {}),
                    completed_at: m.completed_at
                }
            };
        }));

        const completedRequired = normalizedModules.filter(m => m.is_required && m.progress.completed).length;
        const requiredCount = normalizedModules.filter(m => m.is_required).length;

        res.json({
            success: true,
            data: {
                course,
                day: { ...day, metadata: parseJson(day.metadata, {}) },
                modules: normalizedModules,
                summary: {
                    required_count: requiredCount,
                    completed_required: completedRequired,
                    complete: requiredCount > 0 && completedRequired >= requiredCount
                }
            }
        });
    } catch (error) {
        console.error('[ielts] day error:', error);
        res.status(500).json({ success: false, message: '获取每日课程失败' });
    }
});

router.post('/modules/:moduleId/complete', authMiddleware, async (req, res) => {
    try {
        const moduleId = Number(req.params.moduleId);
        if (!Number.isInteger(moduleId) || moduleId <= 0) {
            return res.status(400).json({ success: false, message: '模块不存在' });
        }

        const [module] = await query(`
            SELECT m.*, d.course_id, d.id AS day_id, d.day_number
            FROM ielts_day_modules m
            JOIN ielts_days d ON d.id = m.day_id
            WHERE m.id = ?`, [moduleId]);
        if (!module) return res.status(404).json({ success: false, message: '模块不存在' });

        const score = req.body.score !== undefined && req.body.score !== null ? Number(req.body.score) : null;
        const assessmentId = req.body.assessment_id ? Number(req.body.assessment_id) : null;
        const answerText = req.body.answer_text ? String(req.body.answer_text).trim() : null;
        const progress = req.body.progress && typeof req.body.progress === 'object' ? req.body.progress : {};

        await query(`INSERT INTO ielts_module_progress
            (user_id, course_id, day_id, module_id, status, score, assessment_id, answer_text, progress_json, completed_at)
            VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
                status = 'completed', score = VALUES(score), assessment_id = VALUES(assessment_id),
                answer_text = VALUES(answer_text), progress_json = VALUES(progress_json), completed_at = NOW(), updated_at = NOW()`, [
            req.user.id,
            module.course_id,
            module.day_id,
            module.id,
            Number.isFinite(score) ? score : null,
            assessmentId,
            answerText,
            JSON.stringify(progress)
        ]);

        const requiredRows = await query(`
            SELECT m.id, m.is_required, p.status
            FROM ielts_day_modules m
            LEFT JOIN ielts_module_progress p ON p.module_id = m.id AND p.user_id = ?
            WHERE m.day_id = ?`, [req.user.id, module.day_id]);
        const requiredCount = requiredRows.filter(r => r.is_required).length;
        const completedRequired = requiredRows.filter(r => r.is_required && r.status === 'completed').length;

        if (requiredCount > 0 && completedRequired >= requiredCount) {
            await query(`UPDATE ielts_user_enrollments
                SET current_day = GREATEST(current_day, ?), updated_at = NOW()
                WHERE user_id = ? AND course_id = ?`, [Number(module.day_number) + 1, req.user.id, module.course_id]);
        }

        res.json({
            success: true,
            message: '模块已完成',
            data: { required_count: requiredCount, completed_required: completedRequired }
        });
    } catch (error) {
        console.error('[ielts] complete error:', error);
        res.status(500).json({ success: false, message: '保存学习进度失败' });
    }
});

router.post('/modules/:moduleId/items/:itemKey/complete', authMiddleware, async (req, res) => {
    try {
        const moduleId = Number(req.params.moduleId);
        const itemKey = decodeURIComponent(req.params.itemKey || '').trim();
        if (!Number.isInteger(moduleId) || moduleId <= 0 || !itemKey) {
            return res.status(400).json({ success: false, message: '任务不存在' });
        }

        const [module] = await query(`
            SELECT m.*, d.course_id, d.id AS day_id, d.day_number
            FROM ielts_day_modules m
            JOIN ielts_days d ON d.id = m.day_id
            WHERE m.id = ?`, [moduleId]);
        if (!module) return res.status(404).json({ success: false, message: '任务不存在' });

        const preparedModule = await enrichVocabularyModule(module);
        const preparedContent = parseJson(preparedModule.content_json, {});
        const podcastId = Number(preparedContent.podcast_content_id || preparedContent.podcast_id || 0);
        if (podcastId) {
            const [podcast] = await query(`
                SELECT id, title, title_en, content_text, translation, duration_seconds,
                       female_audio_url, male_audio_url, chinese_audio_url, sentences_data
                FROM podcast_contents
                WHERE id = ?
            `, [podcastId]);
            if (podcast) {
                let sentenceCount = 0;
                if (podcast.sentences_data && podcast.sentences_data !== 'processing') {
                    try {
                        const parsed = typeof podcast.sentences_data === 'string' ? JSON.parse(podcast.sentences_data) : podcast.sentences_data;
                        sentenceCount = Array.isArray(parsed && parsed.sentences) ? parsed.sentences.length : 0;
                    } catch (_) {}
                }
                preparedModule.podcast_content = { ...podcast, sentence_count: sentenceCount };
            }
        }
        const items = buildModuleItems(preparedModule);
        const item = items.find(entry => entry.key === itemKey);
        if (!item) return res.status(404).json({ success: false, message: '任务配置不存在，请刷新后重试' });

        const score = req.body.score !== undefined && req.body.score !== null ? Number(req.body.score) : null;
        const assessmentId = req.body.assessment_id ? Number(req.body.assessment_id) : null;
        const answerText = req.body.answer_text ? String(req.body.answer_text).trim() : null;
        const audioUrl = req.body.audio_url ? String(req.body.audio_url).trim() : null;
        const progress = req.body.progress && typeof req.body.progress === 'object' ? req.body.progress : {};
        const requiredParts = getItemRequiredParts(item);
        const assessedKind = progress.assessed_kind || progress.kind || req.body.kind || (progress.assessed ? 'main' : null);
        const [existingProgress] = await query(
            'SELECT * FROM ielts_module_item_progress WHERE user_id = ? AND module_id = ? AND item_key = ?',
            [req.user.id, module.id, item.key]
        );
        const existingData = existingProgress ? parseJson(existingProgress.progress_json, {}) : {};
        const passedParts = getPassedParts(existingProgress, existingData);

        if (requiredParts.length > 1 && assessedKind && requiredParts.includes(assessedKind)) {
            passedParts[assessedKind] = {
                score: Number.isFinite(score) ? score : null,
                assessment_id: assessmentId,
                reference_text: progress.reference_text || '',
                content_type: progress.content_type || '',
                passed_at: new Date().toISOString()
            };
        } else if (requiredParts.length <= 1 || progress.manual || !assessedKind) {
            requiredParts.forEach(part => {
                passedParts[part] = {
                    score: Number.isFinite(score) ? score : null,
                    assessment_id: assessmentId,
                    reference_text: progress.reference_text || '',
                    content_type: progress.content_type || '',
                    passed_at: new Date().toISOString()
                };
            });
        }

        const itemComplete = requiredParts.every(part => !!passedParts[part]);
        const passedScores = Object.values(passedParts)
            .map(part => Number(part && part.score))
            .filter(value => Number.isFinite(value));
        const storedScore = passedScores.length
            ? passedScores.reduce((sum, value) => sum + value, 0) / passedScores.length
            : (Number.isFinite(score) ? score : null);
        const progressJson = {
            ...existingData,
            ...progress,
            title: item.title,
            required_parts: requiredParts,
            passed_parts: passedParts,
            assessed_kind: assessedKind || existingData.assessed_kind || null,
            item_complete: itemComplete
        };

        await query(`INSERT INTO ielts_module_item_progress
            (user_id, course_id, day_id, module_id, item_key, item_type, status, score, assessment_id, answer_text, audio_url, progress_json, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, IF(? = 'completed', NOW(), NULL))
            ON DUPLICATE KEY UPDATE
                item_type = VALUES(item_type), status = VALUES(status), score = VALUES(score),
                assessment_id = VALUES(assessment_id), answer_text = VALUES(answer_text), audio_url = VALUES(audio_url),
                progress_json = VALUES(progress_json), completed_at = IF(VALUES(status) = 'completed', NOW(), NULL),
                updated_at = NOW()`, [
            req.user.id,
            module.course_id,
            module.day_id,
            module.id,
            item.key,
            item.type,
            itemComplete ? 'completed' : 'pending',
            storedScore,
            assessmentId,
            answerText,
            audioUrl,
            JSON.stringify(progressJson),
            itemComplete ? 'completed' : 'pending'
        ]);

        const itemProgressRows = await query(
            'SELECT * FROM ielts_module_item_progress WHERE user_id = ? AND module_id = ?',
            [req.user.id, module.id]
        );
        const itemsWithProgress = attachProgressToItems(items, itemProgressRows);
        const itemSummary = summarizeItems(itemsWithProgress);

        if (itemSummary.complete) {
            const completedScores = itemsWithProgress
                .map(entry => Number(entry.progress && entry.progress.score))
                .filter(value => Number.isFinite(value));
            const avgScore = completedScores.length
                ? completedScores.reduce((sum, value) => sum + value, 0) / completedScores.length
                : null;

            await query(`INSERT INTO ielts_module_progress
                (user_id, course_id, day_id, module_id, status, score, progress_json, completed_at)
                VALUES (?, ?, ?, ?, 'completed', ?, ?, NOW())
                ON DUPLICATE KEY UPDATE
                    status = 'completed', score = VALUES(score), progress_json = VALUES(progress_json),
                    completed_at = NOW(), updated_at = NOW()`, [
                req.user.id,
                module.course_id,
                module.day_id,
                module.id,
                avgScore,
                JSON.stringify({ auto_from_items: true, item_summary: itemSummary })
            ]);
        } else {
            await query(`UPDATE ielts_module_progress
                SET status = 'pending', completed_at = NULL, progress_json = ?, updated_at = NOW()
                WHERE user_id = ? AND module_id = ?`, [
                JSON.stringify({ auto_from_items: true, item_summary: itemSummary }),
                req.user.id,
                module.id
            ]);
        }

        const requiredRows = await query(`
            SELECT m.id, m.is_required, p.status
            FROM ielts_day_modules m
            LEFT JOIN ielts_module_progress p ON p.module_id = m.id AND p.user_id = ?
            WHERE m.day_id = ?`, [req.user.id, module.day_id]);
        const requiredCount = requiredRows.filter(r => r.is_required).length;
        const completedRequired = requiredRows.filter(r => r.is_required && r.status === 'completed').length;

        if (requiredCount > 0 && completedRequired >= requiredCount) {
            await query(`UPDATE ielts_user_enrollments
                SET current_day = GREATEST(current_day, ?), updated_at = NOW()
                WHERE user_id = ? AND course_id = ?`, [Number(module.day_number) + 1, req.user.id, module.course_id]);
        }

        res.json({
            success: true,
            message: itemSummary.complete ? '模块已过关' : '任务已过关',
            data: {
                item: { ...item, completed: itemComplete },
                item_complete: itemComplete,
                item_part_summary: {
                    required_parts: requiredParts,
                    passed_parts: passedParts,
                    completed_count: requiredParts.filter(part => !!passedParts[part]).length,
                    required_count: requiredParts.length,
                    complete: itemComplete
                },
                item_summary: itemSummary,
                day_summary: { required_count: requiredCount, completed_required: completedRequired }
            }
        });
    } catch (error) {
        console.error('[ielts] item complete error:', error);
        res.status(500).json({ success: false, message: '保存任务进度失败' });
    }
});

module.exports = router;
