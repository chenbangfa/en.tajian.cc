/**
 * 批量压缩 uploads/images/ 下的图片
 * 超过 250KB 的图片转为 JPEG quality=82，最大边长 1024px
 * PNG 转 JPG 时同步更新数据库 image_url 字段
 *
 * 用法：node scripts/compress-images.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const sharp = require('sharp');
const fs = require('fs');
const { query } = require('../src/config/database');

const IMAGES_DIR = path.join(__dirname, '../uploads/images');
const MAX_BYTES = 250 * 1024;   // 超过 250KB 才处理
const MAX_DIM   = 1024;          // 最大边长
const QUALITY   = 82;            // JPEG 质量

async function run() {
    if (!fs.existsSync(IMAGES_DIR)) {
        console.error('目录不存在:', IMAGES_DIR);
        process.exit(1);
    }

    const files = fs.readdirSync(IMAGES_DIR)
        .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));

    console.log(`共 ${files.length} 张图片，目标 ≤ 250KB，开始处理...\n`);

    let compressed = 0, skipped = 0, failed = 0;
    const dbUpdates = []; // { oldUrl, newUrl }

    for (const file of files) {
        const filePath = path.join(IMAGES_DIR, file);
        const stat = fs.statSync(filePath);

        if (stat.size <= MAX_BYTES) {
            skipped++;
            continue;
        }

        const oldSizeKB = Math.round(stat.size / 1024);
        const ext = path.extname(file).toLowerCase();
        const basename = path.basename(file, ext);
        const newFile = `${basename}.jpg`;
        const newFilePath = path.join(IMAGES_DIR, newFile);
        const tmpPath = newFilePath + '.tmp';

        try {
            await sharp(filePath)
                .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: QUALITY, progressive: true })
                .toFile(tmpPath);

            const isRename = (ext !== '.jpg' && ext !== '.jpeg');

            if (isRename) {
                fs.renameSync(tmpPath, newFilePath);
                fs.unlinkSync(filePath);
                dbUpdates.push({
                    oldUrl: `/uploads/images/${file}`,
                    newUrl: `/uploads/images/${newFile}`
                });
            } else {
                // 同扩展名：覆盖原文件
                fs.renameSync(tmpPath, filePath);
            }

            const saved = fs.statSync(isRename ? newFilePath : filePath);
            console.log(`✅ ${file}  ${oldSizeKB}KB → ${Math.round(saved.size / 1024)}KB`);
            compressed++;
        } catch (e) {
            console.error(`❌ ${file}: ${e.message}`);
            failed++;
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
    }

    // 更新数据库
    if (dbUpdates.length > 0) {
        console.log(`\n更新数据库 ${dbUpdates.length} 条记录 (PNG→JPG)...`);
        for (const { oldUrl, newUrl } of dbUpdates) {
            await query('UPDATE words SET image_url = ? WHERE image_url = ?', [newUrl, oldUrl]);
        }
        console.log('✅ 数据库更新完成');
    }

    console.log(`\n完成：压缩 ${compressed} 张，跳过 ${skipped} 张，失败 ${failed} 张`);
    process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
