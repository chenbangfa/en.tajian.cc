/**
 * 批量 AI 补全：为新增单词生成音标、例句、例句翻译、语法说明
 *
 * 用法（在 server/ 目录下执行）：
 *   node scripts/enhance-new-words.js              # 补全所有 phonetic 为空的新词（id 733–771）
 *   node scripts/enhance-new-words.js --dry-run    # 仅列出待处理词，不调用 AI
 *   node scripts/enhance-new-words.js --delay 3000 # 自定义间隔毫秒（默认 5000）
 *   node scripts/enhance-new-words.js --all        # 补全词库中所有 phonetic 为空的单词（范围更大）
 *
 * 频率说明：
 *   Gemini Flash 免费层 15 RPM，默认 5s 间隔（12 RPM），留 20% 余量
 *   走代理（PROXY_BASE_URL）时同样受此限制
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { query } = require('../src/config/database');
const aiService = require('../src/services/ai.service');

const args = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const ALL_MODE = args.includes('--all');
const delayIdx = args.indexOf('--delay');
const DELAY_MS = delayIdx >= 0 && args[delayIdx + 1] ? parseInt(args[delayIdx + 1]) : 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    // 查询待补全单词
    let words;
    if (ALL_MODE) {
        words = await query(
            `SELECT id, word, translation, phonetic, example_sentence
             FROM words
             WHERE (phonetic IS NULL OR phonetic = '')
             ORDER BY id ASC`
        );
    } else {
        // 只补全课程导入的新词（id 733–771）
        words = await query(
            `SELECT id, word, translation, phonetic, example_sentence
             FROM words
             WHERE id BETWEEN 733 AND 771
               AND (phonetic IS NULL OR phonetic = '')
             ORDER BY id ASC`
        );
    }

    if (!words.length) {
        console.log('没有需要补全的单词。');
        process.exit(0);
    }

    console.log(`待补全单词：${words.length} 个，间隔 ${DELAY_MS}ms，预计耗时 ~${Math.ceil(words.length * DELAY_MS / 1000)} 秒`);
    console.log(DRY_RUN ? '[DRY RUN 模式，不调用 AI]' : `[AI引擎：${process.env.PROXY_BASE_URL ? '代理→Gemini' : 'Gemini 直连'}]`);
    console.log('─'.repeat(60));

    let ok = 0, fail = 0;

    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const prefix = `[${i + 1}/${words.length}] id=${w.id} ${w.word}`;

        if (DRY_RUN) {
            console.log(`${prefix}  → 待补全`);
            continue;
        }

        try {
            const result = await aiService.enhanceWordData(w.word, w.translation);

            if (!result.success) {
                console.error(`${prefix}  ✗ 失败：${result.error}`);
                fail++;
            } else {
                const d = result.data;

                // 只更新空字段，不覆盖已有内容
                const updates = [];
                const params  = [];

                if (d.phonetic) {
                    updates.push('phonetic = ?');
                    params.push(d.phonetic);
                }
                // example_sentence：若 DB 已有值则跳过（我们导入时已设了基础例句）
                if (d.example_sentence && (!w.example_sentence || w.example_sentence.trim() === '')) {
                    updates.push('example_sentence = ?');
                    params.push(d.example_sentence);
                }
                if (d.example_translation) {
                    updates.push('example_translation = ?');
                    params.push(d.example_translation);
                }
                if (d.grammar_explanation) {
                    updates.push('grammar_explanation = ?');
                    params.push(d.grammar_explanation);
                }

                if (updates.length) {
                    params.push(w.id);
                    await query(`UPDATE words SET ${updates.join(', ')} WHERE id = ?`, params);
                    console.log(`${prefix}  ✓ 音标=${d.phonetic}  例句=${d.example_sentence?.substring(0, 40)}`);
                } else {
                    console.log(`${prefix}  - AI返回空数据，跳过`);
                }
                ok++;
            }
        } catch (err) {
            console.error(`${prefix}  ✗ 异常：${err.message}`);
            fail++;
        }

        // 避免触发 Gemini 频率限制（最后一个词不需要等）
        if (i < words.length - 1) {
            await sleep(DELAY_MS);
        }
    }

    console.log('─'.repeat(60));
    console.log(`完成！成功 ${ok} 个，失败 ${fail} 个`);
    process.exit(0);
}

main().catch(err => {
    console.error('脚本异常：', err);
    process.exit(1);
});
