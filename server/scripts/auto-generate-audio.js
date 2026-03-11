#!/usr/bin/env node

/**
 * 自动生成缺失发音的脚本
 * 
 * 功能：
 *   1. 查询所有缺少男声或女声发音的单词
 *   2. 逐个调用 TTS 服务生成音频
 *   3. 更新数据库中的音频 URL
 *   4. 同时处理例句的男女声
 * 
 * 用法：
 *   node scripts/auto-generate-audio.js              # 生成所有缺失的发音
 *   node scripts/auto-generate-audio.js --word-only   # 只生成单词发音（不含例句）
 *   node scripts/auto-generate-audio.js --female-only  # 只生成女声
 *   node scripts/auto-generate-audio.js --male-only    # 只生成男声
 *   node scripts/auto-generate-audio.js --limit 50     # 最多处理50个单词
 *   node scripts/auto-generate-audio.js --dry-run      # 仅显示统计，不执行
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { query } = require('../src/config/database');
const voiceService = require('../src/services/voice.service');

// 解析命令行参数
const args = process.argv.slice(2);
const flags = {
    wordOnly: args.includes('--word-only'),
    femaleOnly: args.includes('--female-only'),
    maleOnly: args.includes('--male-only'),
    dryRun: args.includes('--dry-run'),
    limit: (() => {
        const idx = args.indexOf('--limit');
        return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1]) : 0;
    })()
};

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// TTS 请求间隔（毫秒）
// Google Gemini: 10 RPM -> 7000ms
// 有道: 3000次/小时 -> 约1.2s/次，设为 2s 留余量
// 腾讯: 根据套餐不同
const REQUEST_INTERVAL = process.env.TTS_ENGINE === 'google' ? 7000 : 2000;

// 429 重试配置
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 10000; // 首次重试等待 10s

/**
 * 带重试的 TTS 调用
 * 处理两种 429 情况：1) 异常抛出  2) 返回 { success: false, error: '429...' }
 */
async function ttsWithRetry(text, voice, retries = 0) {
    let result;
    try {
        result = await voiceService.textToSpeech(text, voice);
    } catch (e) {
        // 异常形式的 429
        const msg = e.message || '';
        const is429 = msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
        if (is429 && retries < MAX_RETRIES) {
            const waitTime = RETRY_BASE_DELAY * (retries + 1);
            console.log(`    ⏳ 速率限制(异常)，等待 ${waitTime / 1000}s 后重试 (${retries + 1}/${MAX_RETRIES})...`);
            await delay(waitTime);
            return ttsWithRetry(text, voice, retries + 1);
        }
        throw e;
    }

    // 返回值形式的 429
    if (!result.success) {
        const errMsg = result.error || '';
        const is429 = result.statusCode === 429 || errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota') || errMsg.includes('rate');
        if (is429 && retries < MAX_RETRIES) {
            const waitTime = RETRY_BASE_DELAY * (retries + 1);
            console.log(`    ⏳ 速率限制，等待 ${waitTime / 1000}s 后重试 (${retries + 1}/${MAX_RETRIES})...`);
            await delay(waitTime);
            return ttsWithRetry(text, voice, retries + 1);
        }
    }

    return result;
}

// 统计
const stats = {
    totalWords: 0,
    wordFemaleGenerated: 0,
    wordMaleGenerated: 0,
    exFemaleGenerated: 0,
    exMaleGenerated: 0,
    failed: 0,
    skipped: 0
};

async function main() {
    console.log('='.repeat(60));
    console.log('  自动生成缺失发音脚本');
    console.log('='.repeat(60));
    console.log('');

    if (flags.dryRun) console.log('  [DRY RUN 模式] 仅显示统计，不会实际生成\n');
    if (flags.wordOnly) console.log('  模式: 仅生成单词发音（不含例句）');
    if (flags.femaleOnly) console.log('  模式: 仅生成女声');
    if (flags.maleOnly) console.log('  模式: 仅生成男声');
    if (flags.limit) console.log(`  限制: 最多处理 ${flags.limit} 个单词`);
    console.log('');

    try {
        // 1. 查询需要生成发音的单词
        let sql = `
            SELECT id, word, example_sentence,
                   audio_url_female, audio_url_male,
                   example_audio_female, example_audio_male
            FROM words
            WHERE 1=1
        `;

        const conditions = [];

        // 根据参数构建查询条件
        if (flags.femaleOnly) {
            conditions.push('(audio_url_female IS NULL OR audio_url_female = "")');
        } else if (flags.maleOnly) {
            conditions.push('(audio_url_male IS NULL OR audio_url_male = "")');
        } else {
            // 查找缺少任意发音的单词
            conditions.push(`(
                audio_url_female IS NULL OR audio_url_female = "" OR
                audio_url_male IS NULL OR audio_url_male = ""
                ${!flags.wordOnly ? `OR
                (example_sentence IS NOT NULL AND example_sentence != "" AND (
                    example_audio_female IS NULL OR example_audio_female = "" OR
                    example_audio_male IS NULL OR example_audio_male = ""
                ))` : ''}
            )`);
        }

        if (conditions.length > 0) {
            sql += ' AND ' + conditions.join(' AND ');
        }

        sql += ' ORDER BY id ASC';
        if (flags.limit) sql += ` LIMIT ${flags.limit}`;

        const words = await query(sql);
        stats.totalWords = words.length;

        // 预估需要生成的音频数
    let estAudioCount = 0;
    for (const w of words) {
        if (!flags.maleOnly && (!w.audio_url_female || w.audio_url_female === '')) estAudioCount++;
        if (!flags.femaleOnly && (!w.audio_url_male || w.audio_url_male === '')) estAudioCount++;
        if (!flags.wordOnly && w.example_sentence && w.example_sentence.trim()) {
            if (!flags.maleOnly && (!w.example_audio_female || w.example_audio_female === '')) estAudioCount++;
            if (!flags.femaleOnly && (!w.example_audio_male || w.example_audio_male === '')) estAudioCount++;
        }
    }
    const estMinutes = Math.ceil(estAudioCount * REQUEST_INTERVAL / 1000 / 60);

    console.log(`找到 ${words.length} 个需要处理的单词，预计生成 ${estAudioCount} 个音频`);
    console.log(`⏱  预估耗时: 约 ${estMinutes} 分钟 (每个请求间隔 ${REQUEST_INTERVAL / 1000}s，限速 10 RPM)\n`);

        if (words.length === 0) {
            console.log('所有单词都已有完整发音，无需处理！');
            process.exit(0);
        }

        if (flags.dryRun) {
            // 统计各项缺失数量
            let missFemale = 0, missMale = 0, missExF = 0, missExM = 0;
            for (const w of words) {
                if (!w.audio_url_female) missFemale++;
                if (!w.audio_url_male) missMale++;
                if (w.example_sentence && !w.example_audio_female) missExF++;
                if (w.example_sentence && !w.example_audio_male) missExM++;
            }
            console.log('缺失统计:');
            console.log(`  单词女声缺失: ${missFemale}`);
            console.log(`  单词男声缺失: ${missMale}`);
            console.log(`  例句女声缺失: ${missExF}`);
            console.log(`  例句男声缺失: ${missExM}`);
            console.log(`\n总计需要生成约 ${missFemale + missMale + missExF + missExM} 个音频`);
            process.exit(0);
        }

        // 2. 逐个处理
        for (let i = 0; i < words.length; i++) {
            const w = words[i];
            const progress = `[${i + 1}/${words.length}]`;

            console.log(`${progress} 处理: ${w.word} (ID: ${w.id})`);

            // 生成单词女声
            if (!flags.maleOnly && (!w.audio_url_female || w.audio_url_female === '')) {
                try {
                    console.log(`  → 生成女声...`);
                    const result = await ttsWithRetry(w.word, 'female');
                    if (result.success && result.audioUrl) {
                        await query('UPDATE words SET audio_url_female = ?, updated_at = NOW() WHERE id = ?', [result.audioUrl, w.id]);
                        stats.wordFemaleGenerated++;
                        console.log(`  ✅ 女声完成`);
                    } else {
                        console.log(`  ❌ 女声失败: ${result.error || '未知错误'}`);
                        stats.failed++;
                    }
                    await delay(REQUEST_INTERVAL);
                } catch (e) {
                    console.log(`  ❌ 女声异常: ${e.message}`);
                    stats.failed++;
                    await delay(REQUEST_INTERVAL);
                }
            }

            // 生成单词男声
            if (!flags.femaleOnly && (!w.audio_url_male || w.audio_url_male === '')) {
                try {
                    console.log(`  → 生成男声...`);
                    const result = await ttsWithRetry(w.word, 'male');
                    if (result.success && result.audioUrl) {
                        await query('UPDATE words SET audio_url_male = ?, updated_at = NOW() WHERE id = ?', [result.audioUrl, w.id]);
                        stats.wordMaleGenerated++;
                        console.log(`  ✅ 男声完成`);
                    } else {
                        console.log(`  ❌ 男声失败: ${result.error || '未知错误'}`);
                        stats.failed++;
                    }
                    await delay(REQUEST_INTERVAL);
                } catch (e) {
                    console.log(`  ❌ 男声异常: ${e.message}`);
                    stats.failed++;
                    await delay(REQUEST_INTERVAL);
                }
            }

            // 生成例句发音
            if (!flags.wordOnly && w.example_sentence && w.example_sentence.trim()) {
                // 例句女声
                if (!flags.maleOnly && (!w.example_audio_female || w.example_audio_female === '')) {
                    try {
                        console.log(`  → 生成例句女声...`);
                        const result = await ttsWithRetry(w.example_sentence, 'female');
                        if (result.success && result.audioUrl) {
                            await query('UPDATE words SET example_audio_female = ?, updated_at = NOW() WHERE id = ?', [result.audioUrl, w.id]);
                            stats.exFemaleGenerated++;
                            console.log(`  ✅ 例句女声完成`);
                        } else {
                            console.log(`  ❌ 例句女声失败: ${result.error || '未知错误'}`);
                            stats.failed++;
                        }
                        await delay(REQUEST_INTERVAL);
                    } catch (e) {
                        console.log(`  ❌ 例句女声异常: ${e.message}`);
                        stats.failed++;
                        await delay(REQUEST_INTERVAL);
                    }
                }

                // 例句男声
                if (!flags.femaleOnly && (!w.example_audio_male || w.example_audio_male === '')) {
                    try {
                        console.log(`  → 生成例句男声...`);
                        const result = await ttsWithRetry(w.example_sentence, 'male');
                        if (result.success && result.audioUrl) {
                            await query('UPDATE words SET example_audio_male = ?, updated_at = NOW() WHERE id = ?', [result.audioUrl, w.id]);
                            stats.exMaleGenerated++;
                            console.log(`  ✅ 例句男声完成`);
                        } else {
                            console.log(`  ❌ 例句男声失败: ${result.error || '未知错误'}`);
                            stats.failed++;
                        }
                        await delay(REQUEST_INTERVAL);
                    } catch (e) {
                        console.log(`  ❌ 例句男声异常: ${e.message}`);
                        stats.failed++;
                        await delay(REQUEST_INTERVAL);
                    }
                }
            }

            console.log('');
        }

        // 3. 输出最终统计
        console.log('='.repeat(60));
        console.log('  执行完毕！');
        console.log('='.repeat(60));
        console.log(`  处理单词数:      ${stats.totalWords}`);
        console.log(`  单词女声生成:    ${stats.wordFemaleGenerated}`);
        console.log(`  单词男声生成:    ${stats.wordMaleGenerated}`);
        console.log(`  例句女声生成:    ${stats.exFemaleGenerated}`);
        console.log(`  例句男声生成:    ${stats.exMaleGenerated}`);
        console.log(`  失败:            ${stats.failed}`);
        console.log(`  总生成数:        ${stats.wordFemaleGenerated + stats.wordMaleGenerated + stats.exFemaleGenerated + stats.exMaleGenerated}`);
        console.log('='.repeat(60));

    } catch (error) {
        console.error('脚本执行错误:', error);
    }

    process.exit(0);
}

main();
