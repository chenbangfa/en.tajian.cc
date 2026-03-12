/**
 * 修复例句与例句翻译不匹配问题
 *
 * 原因：enhance-new-words.js 跳过了已有例句，但翻译始终写入，导致两者来自不同来源。
 * 修复：对 id 733–771 的词重新调用 AI，强制同时覆盖 example_sentence + example_translation。
 *
 * 用法：node scripts/fix-example-mismatch.js [--dry-run] [--delay N]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { query }   = require('../src/config/database');
const aiService   = require('../src/services/ai.service');

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const delayIdx = args.indexOf('--delay');
const DELAY_MS = delayIdx >= 0 && args[delayIdx + 1] ? parseInt(args[delayIdx + 1]) : 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    const words = await query(
        `SELECT id, word, translation, example_sentence, example_translation
         FROM words WHERE id BETWEEN 733 AND 771 ORDER BY id ASC`
    );

    console.log(`待修复：${words.length} 个词，间隔 ${DELAY_MS}ms`);
    console.log(DRY_RUN ? '[DRY RUN]' : `[引擎：${process.env.PROXY_BASE_URL ? '代理→Gemini' : 'Gemini 直连'}]`);
    console.log('─'.repeat(70));

    let ok = 0, fail = 0;

    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        const prefix = `[${i + 1}/${words.length}] id=${w.id} ${w.word}`;

        if (DRY_RUN) {
            console.log(`${prefix}  DB句="${w.example_sentence}"  DB译="${w.example_translation}"`);
            continue;
        }

        try {
            const result = await aiService.enhanceWordData(w.word, w.translation);

            if (!result.success) {
                console.error(`${prefix}  ✗ ${result.error}`);
                fail++;
            } else {
                const d = result.data;
                if (!d.example_sentence || !d.example_translation) {
                    console.warn(`${prefix}  - AI 返回例句为空，跳过`);
                    fail++;
                } else {
                    await query(
                        `UPDATE words
                         SET example_sentence = ?, example_translation = ?
                         WHERE id = ?`,
                        [d.example_sentence, d.example_translation, w.id]
                    );
                    console.log(`${prefix}  ✓ 句="${d.example_sentence}"`);
                    console.log(`${' '.repeat(prefix.length + 4)}  译="${d.example_translation}"`);
                    ok++;
                }
            }
        } catch (err) {
            console.error(`${prefix}  ✗ 异常：${err.message}`);
            fail++;
        }

        if (i < words.length - 1) await sleep(DELAY_MS);
    }

    console.log('─'.repeat(70));
    console.log(`完成！成功 ${ok}，失败 ${fail}`);
    process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
