/**
 * 重新生成数据库中 WAV 格式的音频为 MP3
 * 适用于: 之前用 Google/腾讯 TTS 生成的 .wav 文件无法在微信真机播放
 *
 * 用法: node scripts/regen-wav-audio.js
 * 预计耗时: 每条约 2秒，根据 WAV 数量而定
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const fs   = require('fs');
const { query } = require('../src/config/database');
const voiceService = require('../src/services/voice.service');

const SERVER_ROOT = path.join(__dirname, '..');
const INTERVAL_MS = 1800; // 有道速率 3000次/小时，1.8s 间隔留余量

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isWav(url) {
    return url && url.toLowerCase().endsWith('.wav');
}

function deleteLocalFile(url) {
    if (!url || !url.startsWith('/uploads/')) return;
    const fullPath = path.join(SERVER_ROOT, url);
    try { fs.unlinkSync(fullPath); } catch (_) {}
}

async function run() {
    // 查找所有含 WAV 音频的单词
    const words = await query(`
        SELECT id, word, example_sentence,
               audio_url_female, audio_url_male,
               example_audio_female, example_audio_male
        FROM words
        WHERE audio_url_female LIKE '%.wav'
           OR audio_url_male LIKE '%.wav'
           OR example_audio_female LIKE '%.wav'
           OR example_audio_male LIKE '%.wav'
    `);

    if (words.length === 0) {
        console.log('✅ 没有需要处理的 WAV 音频');
        process.exit(0);
    }

    // 统计总任务数
    let totalTasks = 0;
    for (const w of words) {
        if (isWav(w.audio_url_female))      totalTasks++;
        if (isWav(w.audio_url_male))        totalTasks++;
        if (isWav(w.example_audio_female) && w.example_sentence) totalTasks++;
        if (isWav(w.example_audio_male)   && w.example_sentence) totalTasks++;
    }

    console.log(`找到 ${words.length} 个单词，共 ${totalTasks} 个 WAV 音频需要重新生成`);
    console.log(`预计耗时约 ${Math.ceil(totalTasks * INTERVAL_MS / 60000)} 分钟\n`);

    let done = 0, failed = 0, taskIdx = 0;

    for (const word of words) {
        const tasks = [];
        if (isWav(word.audio_url_female))
            tasks.push({ field: 'audio_url_female',    text: word.word,             voice: 'female', oldUrl: word.audio_url_female });
        if (isWav(word.audio_url_male))
            tasks.push({ field: 'audio_url_male',      text: word.word,             voice: 'male',   oldUrl: word.audio_url_male });
        if (isWav(word.example_audio_female) && word.example_sentence)
            tasks.push({ field: 'example_audio_female', text: word.example_sentence, voice: 'female', oldUrl: word.example_audio_female });
        if (isWav(word.example_audio_male) && word.example_sentence)
            tasks.push({ field: 'example_audio_male',  text: word.example_sentence, voice: 'male',   oldUrl: word.example_audio_male });

        for (const task of tasks) {
            taskIdx++;
            process.stdout.write(`[${taskIdx}/${totalTasks}] word#${word.id} "${word.word}" ${task.field} ... `);

            const result = await voiceService.textToSpeech(task.text, task.voice);

            if (result.success && result.audioUrl) {
                // 更新 DB
                await query(
                    `UPDATE words SET ${task.field} = ?, updated_at = NOW() WHERE id = ?`,
                    [result.audioUrl, word.id]
                );
                // 删除旧 WAV 文件
                deleteLocalFile(task.oldUrl);

                console.log(`✅ → ${result.audioUrl}`);
                done++;
            } else {
                console.log(`❌ 失败: ${result.error || '未知错误'}`);
                failed++;
            }

            if (taskIdx < totalTasks) await sleep(INTERVAL_MS);
        }
    }

    console.log(`\n全部完成: 成功 ${done}，失败 ${failed}`);
    process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
