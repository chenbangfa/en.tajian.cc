/**
 * 批量导入：英语启蒙·第一册 My English World
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/import-kids-starter-course.js
 *
 * 逻辑：
 *   1. 创建课程 "英语启蒙·第一册 My English World"（已存在则跳过）
 *   2. 创建 10 个章节（已存在则跳过）
 *   3. 每个单词：
 *      - 先按 word 精确匹配查 words 表
 *      - 找到 → 直接复用，打印 [复用]
 *      - 没找到 → 插入新词，打印 [新增]
 *   4. 创建 checkin_course_items 记录，关联 chapter（已存在则跳过）
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const { query } = require('../src/config/database');

// ─── 课程数据 ──────────────────────────────────────────────────────────────────

const COURSE = {
    name: '英语启蒙·第一册 My English World',
    description: '面向5-8岁零基础中国小朋友，参考剑桥YLE、人教版PEP综合设计，共10章117词',
    level: 1,
    sort_order: 1,
    is_active: 1
};

// word_type 映射
const TYPE_MAP = {
    'int.': 'other',
    'adv.': 'adv',
    'n.': 'noun',
    'pron.': 'pron',
    'v.': 'verb',
    'v./n.': 'noun',
    'adj.': 'adj',
    'num.': 'other',
    'n./v.': 'noun'
};

const CHAPTERS = [
    {
        name: 'Unit 1: Hello World — 问候与自我介绍',
        description: '会用英语打招呼、介绍自己名字、说再见',
        sort_order: 1,
        words: [
            { word: 'hello',   translation: '你好',        word_type: 'other', example_sentence: "Hello! I'm Mia." },
            { word: 'hi',      translation: '嗨',           word_type: 'other', example_sentence: "Hi! Are you Tom?" },
            { word: 'bye',     translation: '再见',         word_type: 'other', example_sentence: "Bye! See you!" },
            { word: 'yes',     translation: '是的',         word_type: 'adv',   example_sentence: "Yes, I am." },
            { word: 'no',      translation: '不是',         word_type: 'adv',   example_sentence: "No, I'm not." },
            { word: 'name',    translation: '名字',         word_type: 'noun',  example_sentence: "My name is Lily." },
            { word: 'I',       translation: '我',           word_type: 'pron',  example_sentence: "I like cats." },
            { word: 'my',      translation: '我的',         word_type: 'pron',  example_sentence: "My bag is red." },
            { word: 'you',     translation: '你',           word_type: 'pron',  example_sentence: "Are you happy?" },
            { word: 'am',      translation: '是（be动词）', word_type: 'verb',  example_sentence: "I am a student." },
            { word: 'good',    translation: '好的',         word_type: 'adj',   example_sentence: "Good morning!" },
            { word: 'morning', translation: '早晨',         word_type: 'noun',  example_sentence: "Good morning, Dad." }
        ]
    },
    {
        name: 'Unit 2: Numbers — 数字 1–20',
        description: '认读并说出1–20，会用数字表达年龄',
        sort_order: 2,
        words: [
            { word: 'one',      translation: '一',   word_type: 'other', example_sentence: "I have one cat." },
            { word: 'two',      translation: '二',   word_type: 'other', example_sentence: "Two birds fly." },
            { word: 'three',    translation: '三',   word_type: 'other', example_sentence: "I have three fish." },
            { word: 'four',     translation: '四',   word_type: 'other', example_sentence: "Four dogs run." },
            { word: 'five',     translation: '五',   word_type: 'other', example_sentence: "I am five." },
            { word: 'six',      translation: '六',   word_type: 'other', example_sentence: "Six red apples." },
            { word: 'seven',    translation: '七',   word_type: 'other', example_sentence: "Seven days a week." },
            { word: 'eight',    translation: '八',   word_type: 'other', example_sentence: "Eight legs on a spider." },
            { word: 'nine',     translation: '九',   word_type: 'other', example_sentence: "Nine yellow stars." },
            { word: 'ten',      translation: '十',   word_type: 'other', example_sentence: "I have ten fingers." },
            { word: 'eleven',   translation: '十一', word_type: 'other', example_sentence: "Eleven players on a team." },
            { word: 'twelve',   translation: '十二', word_type: 'other', example_sentence: "Twelve months a year." },
            { word: 'thirteen', translation: '十三', word_type: 'other', example_sentence: "She is thirteen." },
            { word: 'twenty',   translation: '二十', word_type: 'other', example_sentence: "I count to twenty." }
        ]
    },
    {
        name: 'Unit 3: Colors — 颜色',
        description: '认识10种基本颜色，会用颜色描述物品',
        sort_order: 3,
        words: [
            { word: 'red',    translation: '红色', word_type: 'adj',  example_sentence: "The apple is red." },
            { word: 'blue',   translation: '蓝色', word_type: 'adj',  example_sentence: "The sky is blue." },
            { word: 'yellow', translation: '黄色', word_type: 'adj',  example_sentence: "The sun is yellow." },
            { word: 'green',  translation: '绿色', word_type: 'adj',  example_sentence: "The leaf is green." },
            { word: 'orange', translation: '橙色', word_type: 'adj',  example_sentence: "I like orange." },
            { word: 'pink',   translation: '粉色', word_type: 'adj',  example_sentence: "She has a pink bag." },
            { word: 'purple', translation: '紫色', word_type: 'adj',  example_sentence: "The flower is purple." },
            { word: 'white',  translation: '白色', word_type: 'adj',  example_sentence: "The snow is white." },
            { word: 'black',  translation: '黑色', word_type: 'adj',  example_sentence: "The cat is black." },
            { word: 'brown',  translation: '棕色', word_type: 'adj',  example_sentence: "The bear is brown." },
            { word: 'color',  translation: '颜色', word_type: 'noun', example_sentence: "What color is this?" }
        ]
    },
    {
        name: 'Unit 4: Animals — 动物',
        description: '认识12种常见动物，会描述动物特征',
        sort_order: 4,
        words: [
            { word: 'cat',      translation: '猫',   word_type: 'noun', example_sentence: "The cat is black." },
            { word: 'dog',      translation: '狗',   word_type: 'noun', example_sentence: "My dog is big." },
            { word: 'bird',     translation: '鸟',   word_type: 'noun', example_sentence: "The bird can fly." },
            { word: 'fish',     translation: '鱼',   word_type: 'noun', example_sentence: "I have two fish." },
            { word: 'duck',     translation: '鸭子', word_type: 'noun', example_sentence: "The duck is yellow." },
            { word: 'frog',     translation: '青蛙', word_type: 'noun', example_sentence: "The frog is green." },
            { word: 'lion',     translation: '狮子', word_type: 'noun', example_sentence: "The lion is big." },
            { word: 'bear',     translation: '熊',   word_type: 'noun', example_sentence: "The bear is brown." },
            { word: 'rabbit',   translation: '兔子', word_type: 'noun', example_sentence: "The rabbit is white." },
            { word: 'monkey',   translation: '猴子', word_type: 'noun', example_sentence: "The monkey can jump." },
            { word: 'elephant', translation: '大象', word_type: 'noun', example_sentence: "The elephant is gray." },
            { word: 'panda',    translation: '熊猫', word_type: 'noun', example_sentence: "The panda is cute." }
        ]
    },
    {
        name: 'Unit 5: Body Parts — 身体部位',
        description: '认识身体各部位，会用I have / Touch your表达',
        sort_order: 5,
        words: [
            { word: 'head',  translation: '头',   word_type: 'noun', example_sentence: "Touch your head!" },
            { word: 'eye',   translation: '眼睛', word_type: 'noun', example_sentence: "I have two eyes." },
            { word: 'nose',  translation: '鼻子', word_type: 'noun', example_sentence: "My nose is small." },
            { word: 'mouth', translation: '嘴巴', word_type: 'noun', example_sentence: "Open your mouth." },
            { word: 'ear',   translation: '耳朵', word_type: 'noun', example_sentence: "I have two ears." },
            { word: 'hand',  translation: '手',   word_type: 'noun', example_sentence: "My hands are clean." },
            { word: 'foot',  translation: '脚',   word_type: 'noun', example_sentence: "I have two feet." },
            { word: 'leg',   translation: '腿',   word_type: 'noun', example_sentence: "The dog has four legs." },
            { word: 'arm',   translation: '手臂', word_type: 'noun', example_sentence: "Raise your arms!" },
            { word: 'hair',  translation: '头发', word_type: 'noun', example_sentence: "Her hair is black." },
            { word: 'face',  translation: '脸',   word_type: 'noun', example_sentence: "I wash my face." },
            { word: 'tooth', translation: '牙齿', word_type: 'noun', example_sentence: "Brush your teeth!" }
        ]
    },
    {
        name: 'Unit 6: Family — 家庭成员',
        description: '认识家庭成员称谓，会介绍自己的家庭',
        sort_order: 6,
        words: [
            { word: 'mom',     translation: '妈妈',      word_type: 'noun', example_sentence: "I love my mom." },
            { word: 'dad',     translation: '爸爸',      word_type: 'noun', example_sentence: "My dad is tall." },
            { word: 'baby',    translation: '宝宝',      word_type: 'noun', example_sentence: "The baby is cute." },
            { word: 'sister',  translation: '姐妹',      word_type: 'noun', example_sentence: "My sister is kind." },
            { word: 'brother', translation: '兄弟',      word_type: 'noun', example_sentence: "My brother is funny." },
            { word: 'grandma', translation: '奶奶/外婆', word_type: 'noun', example_sentence: "Grandma makes soup." },
            { word: 'grandpa', translation: '爷爷/外公', word_type: 'noun', example_sentence: "Grandpa tells stories." },
            { word: 'family',  translation: '家庭',      word_type: 'noun', example_sentence: "I love my family." },
            { word: 'home',    translation: '家',        word_type: 'noun', example_sentence: "I am at home." },
            { word: 'love',    translation: '爱',        word_type: 'verb', example_sentence: "I love you, Mom." }
        ]
    },
    {
        name: 'Unit 7: Food & Drinks — 食物与饮料',
        description: '认识常见食物饮料，会表达喜好和需要',
        sort_order: 7,
        words: [
            { word: 'apple',  translation: '苹果', word_type: 'noun', example_sentence: "I like apples." },
            { word: 'banana', translation: '香蕉', word_type: 'noun', example_sentence: "The banana is yellow." },
            { word: 'orange', translation: '橙子', word_type: 'noun', example_sentence: "I want an orange." },
            { word: 'rice',   translation: '米饭', word_type: 'noun', example_sentence: "I eat rice every day." },
            { word: 'bread',  translation: '面包', word_type: 'noun', example_sentence: "I want bread, please." },
            { word: 'egg',    translation: '鸡蛋', word_type: 'noun', example_sentence: "I eat one egg." },
            { word: 'milk',   translation: '牛奶', word_type: 'noun', example_sentence: "I drink milk." },
            { word: 'water',  translation: '水',   word_type: 'noun', example_sentence: "Drink more water!" },
            { word: 'cake',   translation: '蛋糕', word_type: 'noun', example_sentence: "I like cake." },
            { word: 'cookie', translation: '饼干', word_type: 'noun', example_sentence: "Can I have a cookie?" },
            { word: 'juice',  translation: '果汁', word_type: 'noun', example_sentence: "I want orange juice." },
            { word: 'soup',   translation: '汤',   word_type: 'noun', example_sentence: "The soup is hot." }
        ]
    },
    {
        name: 'Unit 8: School & Classroom — 学校与教室',
        description: '认识学校场景词汇，会简单描述学校生活',
        sort_order: 8,
        words: [
            { word: 'school',   translation: '学校', word_type: 'noun', example_sentence: "I go to school." },
            { word: 'class',    translation: '课/班级', word_type: 'noun', example_sentence: "I like English class." },
            { word: 'teacher',  translation: '老师', word_type: 'noun', example_sentence: "My teacher is nice." },
            { word: 'student',  translation: '学生', word_type: 'noun', example_sentence: "I am a student." },
            { word: 'book',     translation: '书',   word_type: 'noun', example_sentence: "Open your book!" },
            { word: 'pen',      translation: '笔',   word_type: 'noun', example_sentence: "I have a red pen." },
            { word: 'pencil',   translation: '铅笔', word_type: 'noun', example_sentence: "Use a pencil." },
            { word: 'bag',      translation: '书包', word_type: 'noun', example_sentence: "My bag is heavy." },
            { word: 'desk',     translation: '桌子', word_type: 'noun', example_sentence: "Sit at your desk." },
            { word: 'chair',    translation: '椅子', word_type: 'noun', example_sentence: "Sit on the chair." },
            { word: 'friend',   translation: '朋友', word_type: 'noun', example_sentence: "She is my friend." },
            { word: 'play',     translation: '玩/游戏', word_type: 'verb', example_sentence: "Let's play together." }
        ]
    },
    {
        name: 'Unit 9: Shapes — 形状',
        description: '认识基本形状，会描述物品形状',
        sort_order: 9,
        words: [
            { word: 'circle',    translation: '圆形',   word_type: 'noun', example_sentence: "The sun is a circle." },
            { word: 'square',    translation: '正方形', word_type: 'noun', example_sentence: "The window is a square." },
            { word: 'triangle',  translation: '三角形', word_type: 'noun', example_sentence: "A pizza slice is a triangle." },
            { word: 'rectangle', translation: '长方形', word_type: 'noun', example_sentence: "The door is a rectangle." },
            { word: 'star',      translation: '星形',   word_type: 'noun', example_sentence: "I drew a star." },
            { word: 'heart',     translation: '心形',   word_type: 'noun', example_sentence: "I made a heart." },
            { word: 'big',       translation: '大的',   word_type: 'adj',  example_sentence: "The elephant is big." },
            { word: 'small',     translation: '小的',   word_type: 'adj',  example_sentence: "The mouse is small." },
            { word: 'long',      translation: '长的',   word_type: 'adj',  example_sentence: "The snake is long." },
            { word: 'round',     translation: '圆的',   word_type: 'adj',  example_sentence: "The ball is round." }
        ]
    },
    {
        name: 'Unit 10: Weather & Seasons — 天气与季节',
        description: '认识天气和四季，会描述当天天气',
        sort_order: 10,
        words: [
            { word: 'sun',    translation: '太阳', word_type: 'noun', example_sentence: "The sun is bright." },
            { word: 'sunny',  translation: '晴天的', word_type: 'adj', example_sentence: "It's sunny today." },
            { word: 'rain',   translation: '雨/下雨', word_type: 'noun', example_sentence: "I like rain." },
            { word: 'rainy',  translation: '下雨的', word_type: 'adj', example_sentence: "It's rainy today." },
            { word: 'wind',   translation: '风',   word_type: 'noun', example_sentence: "The wind is strong." },
            { word: 'snow',   translation: '雪/下雪', word_type: 'noun', example_sentence: "I love snow!" },
            { word: 'hot',    translation: '热的', word_type: 'adj',  example_sentence: "It's hot in summer." },
            { word: 'cold',   translation: '冷的', word_type: 'adj',  example_sentence: "It's cold in winter." },
            { word: 'spring', translation: '春天', word_type: 'noun', example_sentence: "Spring is warm." },
            { word: 'summer', translation: '夏天', word_type: 'noun', example_sentence: "I swim in summer." },
            { word: 'autumn', translation: '秋天', word_type: 'noun', example_sentence: "Leaves fall in autumn." },
            { word: 'winter', translation: '冬天', word_type: 'noun', example_sentence: "It snows in winter." }
        ]
    }
];

// ─── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
    let newWords = 0, reusedWords = 0, newItems = 0, skippedItems = 0;

    // 1. 创建/复用课程
    let courseId;
    const existingCourses = await query(
        'SELECT id FROM checkin_courses WHERE name = ? LIMIT 1', [COURSE.name]
    );
    if (existingCourses.length) {
        courseId = existingCourses[0].id;
        console.log(`[课程] 已存在，复用 id=${courseId}：${COURSE.name}`);
    } else {
        const r = await query(
            `INSERT INTO checkin_courses (name, description, level, sort_order, is_active)
             VALUES (?, ?, ?, ?, ?)`,
            [COURSE.name, COURSE.description, COURSE.level, COURSE.sort_order, COURSE.is_active]
        );
        courseId = r.insertId;
        console.log(`[课程] 新增 id=${courseId}：${COURSE.name}`);
    }

    // 确保章节表存在（触发 ensureCurriculumTables 逻辑不在这里，直接 CREATE IF NOT EXISTS）
    await query(`CREATE TABLE IF NOT EXISTS checkin_course_chapters (
        id INT AUTO_INCREMENT PRIMARY KEY,
        course_id INT NOT NULL,
        name VARCHAR(120) NOT NULL,
        description VARCHAR(300) DEFAULT NULL,
        sort_order INT DEFAULT 0,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        KEY idx_course (course_id),
        CONSTRAINT fk_ccc_course FOREIGN KEY (course_id) REFERENCES checkin_courses(id) ON DELETE CASCADE
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
        CONSTRAINT fk_cci_course FOREIGN KEY (course_id) REFERENCES checkin_courses(id) ON DELETE CASCADE,
        CONSTRAINT fk_cci_chapter FOREIGN KEY (chapter_id) REFERENCES checkin_course_chapters(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    // 兼容旧表：加 chapter_id 列
    try {
        await query(`ALTER TABLE checkin_course_items ADD COLUMN chapter_id INT DEFAULT NULL AFTER course_id`);
    } catch (e) { /* 已存在，忽略 */ }

    // 2. 逐章处理
    for (const ch of CHAPTERS) {
        // 2a. 创建/复用章节
        let chapterId;
        const existingCh = await query(
            'SELECT id FROM checkin_course_chapters WHERE course_id = ? AND name = ? LIMIT 1',
            [courseId, ch.name]
        );
        if (existingCh.length) {
            chapterId = existingCh[0].id;
            console.log(`\n  [章节] 已存在 id=${chapterId}：${ch.name}`);
        } else {
            const r = await query(
                `INSERT INTO checkin_course_chapters (course_id, name, description, sort_order, is_active)
                 VALUES (?, ?, ?, ?, 1)`,
                [courseId, ch.name, ch.description, ch.sort_order]
            );
            chapterId = r.insertId;
            console.log(`\n  [章节] 新增 id=${chapterId}：${ch.name}`);
        }

        // 2b. 逐词处理
        for (let i = 0; i < ch.words.length; i++) {
            const w = ch.words[i];

            // 查 words 表（精确匹配，不区分大小写）
            const existing = await query(
                'SELECT id FROM words WHERE LOWER(word) = LOWER(?) LIMIT 1', [w.word]
            );

            let wordId;
            if (existing.length) {
                wordId = existing[0].id;
                reusedWords++;
                process.stdout.write(`    [复用] word_id=${wordId} ${w.word}\n`);
            } else {
                const r = await query(
                    `INSERT INTO words (word, translation, word_type, difficulty_level, example_sentence)
                     VALUES (?, ?, ?, 1, ?)`,
                    [w.word, w.translation, w.word_type, w.example_sentence]
                );
                wordId = r.insertId;
                newWords++;
                process.stdout.write(`    [新增] word_id=${wordId} ${w.word} (${w.translation})\n`);
            }

            // 2c. 创建 course item（跳过重复的 course_id+task_type+target_id）
            try {
                await query(
                    `INSERT INTO checkin_course_items (course_id, chapter_id, task_type, target_id, sort_order, is_active)
                     VALUES (?, ?, 'word', ?, ?, 1)`,
                    [courseId, chapterId, wordId, (i + 1) * 10]
                );
                newItems++;
            } catch (e) {
                if (e.code === 'ER_DUP_ENTRY') {
                    // 已存在，更新 chapter_id 和 sort_order
                    await query(
                        `UPDATE checkin_course_items
                         SET chapter_id = ?, sort_order = ?
                         WHERE course_id = ? AND task_type = 'word' AND target_id = ?`,
                        [chapterId, (i + 1) * 10, courseId, wordId]
                    );
                    skippedItems++;
                    process.stdout.write(`    [已存在] 更新 chapter_id item for word_id=${wordId}\n`);
                } else {
                    throw e;
                }
            }
        }
    }

    console.log('\n═══════════════════════════════════════');
    console.log(`完成！课程 id=${courseId}`);
    console.log(`单词：新增 ${newWords} 个，复用 ${reusedWords} 个`);
    console.log(`课程项：新增 ${newItems} 个，已存在更新 ${skippedItems} 个`);
    console.log('═══════════════════════════════════════');
    process.exit(0);
}

main().catch(err => {
    console.error('导入失败:', err);
    process.exit(1);
});
