/**
 * 为 import-kids-starter-course.js 新增的 39 个单词分配 category_id
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/assign-word-categories.js
 *
 * 操作：
 *   1. 创建「问候用语」「常用词汇」两个新分类（parent=基础认知 id=43）
 *   2. 按词精确匹配，更新 category_id（仅更新 category_id 为 NULL 的词，避免覆盖已有分类）
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const { query } = require('../src/config/database');

// ─── 分类映射 ──────────────────────────────────────────────────────────────────
// key = 单词（精确，区分大小写）
// value = category_id 或 { name, parent_id } 表示需要创建的新分类
const ASSIGNMENTS = [
    // ── 新建：问候用语（parent=基础认知 43）──
    { words: ['hello', 'hi', 'bye', 'yes', 'no', 'good'], newCat: { name: '问候用语', parent_id: 43 } },

    // ── 新建：常用词汇（parent=基础认知 43）──
    { words: ['I', 'my', 'you', 'am', 'name'], newCat: { name: '常用词汇', parent_id: 43 } },

    // ── 数字（46）──
    { words: ['eleven', 'twelve', 'thirteen', 'twenty'], catId: 46 },

    // ── 颜色（44）── color 这个词本身
    { words: ['color'], catId: 44 },

    // ── 野生动物（38）──
    { words: ['frog'], catId: 38 },

    // ── 家庭成员（24）──
    { words: ['mom', 'dad', 'grandma', 'grandpa'], catId: 24 },

    // ── 家居生活（11）── home 是「家」的概念
    { words: ['home'], catId: 11 },

    // ── 动作表情（26）── love/play 是动作/情感
    { words: ['love', 'play'], catId: 26 },

    // ── 肉类海鲜（4）── egg 属蛋白质类食物，最近似分类
    { words: ['egg'], catId: 4 },

    // ── 主食谷物（6）── soup 属基础饮食
    { words: ['soup'], catId: 6 },

    // ── 学习文具（32）── class 属学校/教育场景
    { words: ['class'], catId: 32 },

    // ── 形状（45）── big/small/long/round 描述形态的形容词
    { words: ['big', 'small', 'long', 'round'], catId: 45 },

    // ── 自然气象（42）── 天气形容词和气候词
    { words: ['sunny', 'rainy', 'hot', 'cold'], catId: 42 },

    // ── 时间（47）── 四季
    { words: ['spring', 'summer', 'autumn', 'winter'], catId: 47 },
];

// ─── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
    let updated = 0, skipped = 0;

    for (const group of ASSIGNMENTS) {
        // 若需要创建分类，先查是否已存在
        let catId = group.catId;
        if (group.newCat) {
            const existing = await query(
                'SELECT id FROM word_categories WHERE name = ? AND parent_id = ? LIMIT 1',
                [group.newCat.name, group.newCat.parent_id]
            );
            if (existing.length) {
                catId = existing[0].id;
                console.log(`[分类] 已存在 id=${catId}「${group.newCat.name}」`);
            } else {
                const r = await query(
                    'INSERT INTO word_categories (name, parent_id, sort_order) VALUES (?, ?, 0)',
                    [group.newCat.name, group.newCat.parent_id]
                );
                catId = r.insertId;
                console.log(`[分类] 新增 id=${catId}「${group.newCat.name}」（parent=${group.newCat.parent_id}）`);
            }
        }

        // 更新该组每个单词
        for (const word of group.words) {
            // 只更新 category_id 为 NULL 的（不覆盖已有分类）
            const rows = await query(
                'SELECT id, category_id FROM words WHERE LOWER(word) = LOWER(?) LIMIT 1',
                [word]
            );
            if (!rows.length) {
                console.log(`  [跳过] 词库中找不到「${word}」`);
                skipped++;
                continue;
            }
            const w = rows[0];
            if (w.category_id !== null) {
                console.log(`  [已有] id=${w.id} ${word} → category_id=${w.category_id}，跳过`);
                skipped++;
                continue;
            }
            await query('UPDATE words SET category_id = ? WHERE id = ?', [catId, w.id]);
            console.log(`  [更新] id=${w.id} ${word} → category_id=${catId}`);
            updated++;
        }
    }

    console.log('\n═══════════════════════════════════════');
    console.log(`完成！更新 ${updated} 个单词，跳过 ${skipped} 个`);
    console.log('═══════════════════════════════════════');
    process.exit(0);
}

main().catch(err => {
    console.error('执行失败:', err);
    process.exit(1);
});
