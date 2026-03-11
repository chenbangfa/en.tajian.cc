const express = require('express');
const { query, transaction } = require('../../src/config/database');
const aiService = require('../../src/services/ai.service');
const voiceService = require('../../src/services/voice.service');

const router = express.Router();

/**
 * 优化的AI提示词生成器
 * 根据单词和翻译生成适合儿童英语学习的图片提示词
 */
function generateOptimizedPrompt(word, translation, style = 'realistic') {
    // 判断是单词还是句子
    const isSentence = word.includes(' ') && word.split(' ').length > 2;

    // 基础提示词
    let basePrompt = '';

    if (isSentence) {
        // 句子场景生成
        basePrompt = `Create an illustration depicting the scene: "${word}". 
The image should clearly show the action or situation described.
Make it educational and suitable for children learning English.
The scene should be clear, colorful, and help children understand the meaning.`;
    } else {
        // 单词图片生成 - 根据词性和类型优化
        const wordLower = word.toLowerCase();

        // 检测是否是抽象概念
        const abstractWords = ['happy', 'sad', 'big', 'small', 'fast', 'slow', 'hot', 'cold', 'good', 'bad', 'new', 'old', 'tall', 'short', 'long'];
        const isAbstract = abstractWords.includes(wordLower);

        // 检测是否是颜色
        const colors = ['red', 'blue', 'yellow', 'green', 'orange', 'purple', 'pink', 'black', 'white', 'brown'];
        const isColor = colors.includes(wordLower);

        // 检测是否是数字
        const numbers = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
        const isNumber = numbers.includes(wordLower);

        // 检测是否是形状
        const shapes = ['circle', 'square', 'triangle', 'star', 'heart', 'rectangle', 'oval'];
        const isShape = shapes.includes(wordLower);

        if (isColor) {
            basePrompt = `Create a simple, clean image showing the color ${word}. 
Show multiple objects in ${word} color: a ${word} ball, ${word} flowers, ${word} balloons.
The background should be white or light colored to make the ${word} color stand out clearly.
Educational image for children to learn the color ${word}.`;
        } else if (isNumber) {
            const num = numbers.indexOf(wordLower) + 1;
            basePrompt = `Create a simple, educational image showing the number ${num}.
Show exactly ${num} cute, colorful objects (like apples, stars, or cartoon animals).
The number "${num}" should be displayed prominently.
Clean, child-friendly design on a soft colored background.`;
        } else if (isShape) {
            basePrompt = `Create a simple, clean image showing a perfect ${word} shape.
The ${word} should be colorful (rainbow or bright colors).
Add some cute decorations around it.
Clean white background, educational style for children.`;
        } else if (isAbstract) {
            // 抽象形容词 - 用对比或表情展示
            basePrompt = `Create an educational illustration for the word "${word}" (meaning: ${translation}).
Show this concept visually - for example:
- If it's an emotion, show a cute cartoon character expressing that emotion
- If it's a physical property, show clear examples (e.g., for "big", show a big elephant next to a small mouse)
Make it colorful, child-friendly, and the concept should be immediately understandable.`;
        } else {
            // 普通名词
            basePrompt = `Create a beautiful, clear image of a ${word} (${translation}).
The ${word} should be the main focus of the image, centered and clearly visible.
Show a realistic, friendly-looking ${word} that children would find appealing.
The background should be simple and not distract from the main subject.
High quality, educational style suitable for English vocabulary learning.`;
        }
    }

    // 风格修饰
    const styleModifiers = {
        realistic: `
Style: Photorealistic, high quality, like a professional photograph.
Lighting: Soft, natural lighting with gentle shadows.
Colors: Vibrant but natural colors.`,
        cartoon: `
Style: Cute cartoon/anime style, similar to children's storybook illustrations.
Character design: Friendly, round shapes, big expressive eyes if applicable.
Colors: Bright, saturated, cheerful palette.`,
        '3d': `
Style: 3D rendered, like Pixar or Disney animation.
Quality: Smooth, polished 3D with soft shadows and global illumination.
Look: Cute, approachable, modern 3D animation aesthetic.`,
        watercolor: `
Style: Beautiful watercolor painting with soft edges and color blending.
Texture: Visible paper texture, gentle color washes.
Mood: Dreamy, artistic, gentle and calming.`
    };

    const finalPrompt = basePrompt + (styleModifiers[style] || styleModifiers.realistic) + `

IMPORTANT:
- NO text, words, or letters in the image
- NO watermarks or signatures
- The image should be self-explanatory and help children learn the English word
- Safe for children, no scary or inappropriate content
- Square format (1:1 aspect ratio)`;

    return finalPrompt;
}

/**
 * AI增强单词数据
 * 支持两种输入格式:
 *   1. { words: [{word, translation, image_hint}] }  (CSV导入模式)
 *   2. { text: "word/translation\n..." }              (旧文本模式，兼容)
 */
router.post('/ai-enhance', async (req, res) => {
    try {
        let words = [];

        if (req.body.words && Array.isArray(req.body.words)) {
            // CSV 导入模式：直接接收解析后的数组
            words = req.body.words.filter(item => item.word && item.word.trim());
        } else if (req.body.text && req.body.text.trim()) {
            // 旧文本模式（兼容）
            const lines = req.body.text.trim().split('\n').filter(line => line.trim());
            words = lines.map(line => {
                const parts = line.split('/').map(p => p.trim());
                return { word: parts[0] || '', translation: parts[1] || '' };
            }).filter(item => item.word);
        }

        if (words.length === 0) {
            return res.status(400).json({ success: false, message: '未能解析出有效单词' });
        }

        console.log(`[Batch] AI增强 ${words.length} 个单词...`);

        // 调用AI增强 - 现在返回 {results, promptUsed}
        const { results: enhancedWords, promptUsed } = await aiService.batchEnhanceWords(words);

        res.json({
            success: true,
            data: enhancedWords,
            promptUsed: promptUsed,
            message: `成功增强 ${enhancedWords.filter(w => !w.error).length} 个单词`
        });
    } catch (error) {
        console.error('AI增强单词错误:', error);
        res.status(500).json({ success: false, message: 'AI增强失败: ' + error.message });
    }
});

/**
 * 批量导入单词
 */
router.post('/words', async (req, res) => {
    try {
        const { words, auto_generate_image = false, auto_generate_audio = false } = req.body;

        if (!Array.isArray(words) || words.length === 0) {
            return res.status(400).json({ success: false, message: '请提供单词列表' });
        }

        const results = {
            success: [],
            failed: [],
            total: words.length
        };

        for (const wordData of words) {
            try {
                const { word, translation, phonetic, category_id, difficulty_level = 1, word_type = 'noun', display_mode = 'image', example_sentence, example_translation, grammar_explanation, image_hint } = wordData;

                if (!word || !translation) {
                    results.failed.push({ word: word || 'unknown', error: '单词或翻译为空' });
                    continue;
                }

                let image_url = wordData.image_url || null;
                let audio_url = wordData.audio_url || null;

                // 自动生成图片（使用 image_hint 辅助生成更精准的图片）
                if (auto_generate_image && !image_url) {
                    try {
                        const imageResult = await aiService.generateWordImage(word, {
                            translation,
                            image_hint: image_hint || '',
                            promptKey: 'image_generate'
                        });
                        if (imageResult.success) {
                            image_url = imageResult.imageUrl;
                        }
                    } catch (e) {
                        console.error(`生成图片失败 [${word}]:`, e.message);
                    }
                }

                // 自动生成音频
                if (auto_generate_audio && !audio_url) {
                    try {
                        const audioResult = await voiceService.textToSpeech(word, 'female', 1.0);
                        if (audioResult.success && audioResult.audioUrl) {
                            audio_url = audioResult.audioUrl;
                        }
                    } catch (e) {
                        console.error(`生成音频失败 [${word}]:`, e.message);
                    }
                }

                // 插入数据库 - 包含 image_hint 字段
                const result = await query(`
          INSERT INTO words 
          (word, phonetic, translation, category_id, difficulty_level, word_type, display_mode, image_url, audio_url, example_sentence, example_translation, grammar_explanation, image_hint)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [word, phonetic, translation, category_id, difficulty_level, word_type, display_mode, image_url, audio_url, example_sentence, example_translation, grammar_explanation || null, image_hint || null]);

                results.success.push({
                    id: result.insertId,
                    word,
                    image_url,
                    audio_url
                });

            } catch (error) {
                results.failed.push({
                    word: wordData.word || 'unknown',
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            data: results,
            message: `成功导入 ${results.success.length} 个单词，失败 ${results.failed.length} 个`
        });
    } catch (error) {
        console.error('批量导入单词错误:', error);
        res.status(500).json({ success: false, message: '批量导入失败' });
    }
});

/**
 * 为单个单词生成图片（用于单词管理页面和批量生成）
 */
router.post('/generate-single', async (req, res) => {
    try {
        const { word_id, word, translation, promptKey = 'image_generate', image_hint: reqImageHint } = req.body;

        if (!word) {
            return res.status(400).json({ success: false, message: '请提供单词' });
        }

        // 如果有word_id，查询分类信息和图片建议
        let category = '', category_en = '', subcategory = '', image_hint = reqImageHint || '';
        if (word_id) {
            const [wordRecord] = await query(
                `SELECT w.image_hint,
                        c.name as category, c.name_en as category_en,
                        pc.name as parent_category, pc.name_en as parent_category_en
                 FROM words w
                 LEFT JOIN word_categories c ON w.category_id = c.id
                 LEFT JOIN word_categories pc ON c.parent_id = pc.id
                 WHERE w.id = ?`,
                [word_id]
            );
            if (wordRecord) {
                if (wordRecord.parent_category) {
                    category = wordRecord.parent_category;
                    category_en = wordRecord.parent_category_en;
                    subcategory = wordRecord.category;
                } else {
                    category = wordRecord.category || '';
                    category_en = wordRecord.category_en || '';
                }
                // 请求中的 image_hint 优先，否则使用数据库中的
                if (!image_hint) {
                    image_hint = wordRecord.image_hint || '';
                }
            }
        }

        console.log(`[AI] 生成图片: ${word}, 分类: ${category}${subcategory ? ' > ' + subcategory : ''}${image_hint ? ', 图片建议: ' + image_hint : ''}`);

        // 调用图片生成方法（携带 image_hint）
        const imageResult = await aiService.generateWordImage(word, {
            translation: translation || word,
            category,
            category_en,
            subcategory,
            image_hint,
            promptKey
        });

        if (!imageResult.success) {
            return res.status(500).json({
                success: false,
                message: imageResult.error || '图片生成失败'
            });
        }

        // 如果有word_id，更新数据库
        if (word_id) {
            await query(
                'UPDATE words SET image_url = ?, updated_at = NOW() WHERE id = ?',
                [imageResult.imageUrl, word_id]
            );
        }

        res.json({
            success: true,
            data: {
                word,
                image_url: imageResult.imageUrl
            }
        });
    } catch (error) {
        console.error('生成单词图片错误:', error);
        res.status(500).json({ success: false, message: error.message || '生成失败' });
    }
});

/**
 * 为单个单词生成音频
 */
router.post('/generate-audio-single', async (req, res) => {
    try {
        const { word_id, word, voice = 'female' } = req.body;

        if (!word) {
            return res.status(400).json({ success: false, message: '请提供单词' });
        }

        console.log(`[Audio] 生成音频: ${word}, 声音: ${voice}`);

        // 调用TTS生成音频
        const audioResult = await voiceService.textToSpeech(word, voice);

        if (!audioResult.success) {
            return res.status(500).json({
                success: false,
                message: audioResult.error || '音频生成失败'
            });
        }

        // 如果有word_id，更新数据库（根据voice决定更新哪个字段）
        if (word_id) {
            const column = voice === 'male' ? 'audio_url_male' : 'audio_url_female';
            await query(
                `UPDATE words SET ${column} = ?, updated_at = NOW() WHERE id = ?`,
                [audioResult.audioUrl, word_id]
            );
        }

        res.json({
            success: true,
            data: {
                word,
                voice,
                audio_url: audioResult.audioUrl
            }
        });
    } catch (error) {
        console.error('生成单词音频错误:', error);
        res.status(500).json({ success: false, message: error.message || '生成失败' });
    }
});

/**
 * 为例句生成音频
 */
router.post('/generate-example-audio', async (req, res) => {
    try {
        const { word_id, example_sentence, voice = 'female' } = req.body;

        if (!example_sentence) {
            return res.status(400).json({ success: false, message: '请提供例句' });
        }

        console.log(`[Audio] 生成例句音频: ${example_sentence.substring(0, 30)}..., 声音: ${voice}`);

        // 调用TTS生成音频
        const audioResult = await voiceService.textToSpeech(example_sentence, voice);

        if (!audioResult.success) {
            return res.status(500).json({
                success: false,
                message: audioResult.error || '音频生成失败'
            });
        }

        // 如果有word_id，更新数据库
        if (word_id) {
            const column = voice === 'male' ? 'example_audio_male' : 'example_audio_female';
            await query(
                `UPDATE words SET ${column} = ?, updated_at = NOW() WHERE id = ?`,
                [audioResult.audioUrl, word_id]
            );
        }

        res.json({
            success: true,
            data: {
                voice,
                audio_url: audioResult.audioUrl
            }
        });
    } catch (error) {
        console.error('生成例句音频错误:', error);
        res.status(500).json({ success: false, message: error.message || '生成失败' });
    }
});

/**
 * 批量生成单词图片（为已有单词生成图片）
 */
router.post('/generate-images', async (req, res) => {
    try {
        const { word_ids, promptKey = 'image_generate' } = req.body;

        if (!Array.isArray(word_ids) || word_ids.length === 0) {
            return res.status(400).json({ success: false, message: '请提供单词ID列表' });
        }

        // 限制一次最多处理20个
        const idsToProcess = word_ids.slice(0, 20);

        // 查询单词及其分类信息（包括父分类和图片建议）
        const words = await query(
            `SELECT w.id, w.word, w.translation, w.image_hint,
                    c.name as category, c.name_en as category_en,
                    pc.name as parent_category, pc.name_en as parent_category_en
             FROM words w
             LEFT JOIN word_categories c ON w.category_id = c.id
             LEFT JOIN word_categories pc ON c.parent_id = pc.id
             WHERE w.id IN (${idsToProcess.map(() => '?').join(',')})`,
            idsToProcess
        );

        const results = {
            success: [],
            failed: [],
            total: words.length
        };

        for (const wordRecord of words) {
            try {
                // 确定一级和二级分类
                let category, subcategory, category_en;
                if (wordRecord.parent_category) {
                    // 有父分类：父分类是一级，当前分类是二级
                    category = wordRecord.parent_category;
                    category_en = wordRecord.parent_category_en;
                    subcategory = wordRecord.category;
                } else {
                    // 没有父分类：当前分类是一级
                    category = wordRecord.category || '';
                    category_en = wordRecord.category_en || '';
                    subcategory = '';
                }

                const imageResult = await aiService.generateWordImage(wordRecord.word, {
                    translation: wordRecord.translation,
                    category,
                    category_en,
                    subcategory,
                    image_hint: wordRecord.image_hint || '',
                    promptKey
                });

                if (imageResult.success) {
                    await query(
                        'UPDATE words SET image_url = ?, updated_at = NOW() WHERE id = ?',
                        [imageResult.imageUrl, wordRecord.id]
                    );
                    results.success.push({
                        id: wordRecord.id,
                        word: wordRecord.word,
                        image_url: imageResult.imageUrl
                    });
                } else {
                    results.failed.push({
                        id: wordRecord.id,
                        word: wordRecord.word,
                        error: imageResult.error
                    });
                }
            } catch (error) {
                results.failed.push({
                    id: wordRecord.id,
                    word: wordRecord.word,
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            data: results,
            message: `成功生成 ${results.success.length} 张图片`
        });
    } catch (error) {
        console.error('批量生成图片错误:', error);
        res.status(500).json({ success: false, message: '批量生成图片失败' });
    }
});

/**
 * 批量更新图片建议并重新生成图片
 * POST /batch/update-hints-and-regenerate
 * 
 * body: { items: [{ word: 'Apple', image_hint: '一个红色苹果' }, ...] }
 * 
 * 流程：
 *   1. 根据 word 匹配数据库中已有的单词
 *   2. 更新 image_hint 字段
 *   3. 逐个重新生成图片并保存
 */
router.post('/update-hints-and-regenerate', async (req, res) => {
    try {
        const { items } = req.body;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: '请提供更新数据' });
        }

        // 先批量匹配数据库中的单词
        const wordNames = items.map(i => i.word.trim());
        const placeholders = wordNames.map(() => '?').join(',');
        const existingWords = await query(
            `SELECT w.id, w.word, w.translation, w.image_hint, w.image_url,
                    c.name as category, c.name_en as category_en,
                    pc.name as parent_category, pc.name_en as parent_category_en
             FROM words w
             LEFT JOIN word_categories c ON w.category_id = c.id
             LEFT JOIN word_categories pc ON c.parent_id = pc.id
             WHERE w.word IN (${placeholders})`,
            wordNames
        );

        // 建立 word -> db record 映射（不区分大小写）
        const wordMap = {};
        existingWords.forEach(w => {
            wordMap[w.word.toLowerCase()] = w;
        });

        const results = { matched: [], notFound: [], success: [], failed: [] };

        // 匹配并更新 image_hint
        for (const item of items) {
            const key = item.word.trim().toLowerCase();
            const dbWord = wordMap[key];

            if (!dbWord) {
                results.notFound.push(item.word);
                continue;
            }

            results.matched.push({ id: dbWord.id, word: dbWord.word, image_hint: item.image_hint });

            // 更新 image_hint
            await query(
                'UPDATE words SET image_hint = ?, updated_at = NOW() WHERE id = ?',
                [item.image_hint || '', dbWord.id]
            );
        }

        // 逐个重新生成图片
        for (const item of results.matched) {
            const dbWord = wordMap[item.word.toLowerCase()];
            try {
                let category = '', category_en = '', subcategory = '';
                if (dbWord.parent_category) {
                    category = dbWord.parent_category;
                    category_en = dbWord.parent_category_en;
                    subcategory = dbWord.category;
                } else {
                    category = dbWord.category || '';
                    category_en = dbWord.category_en || '';
                }

                const imageResult = await aiService.generateWordImage(dbWord.word, {
                    translation: dbWord.translation,
                    category,
                    category_en,
                    subcategory,
                    image_hint: item.image_hint || '',
                    promptKey: 'image_generate'
                });

                if (imageResult.success) {
                    await query(
                        'UPDATE words SET image_url = ?, updated_at = NOW() WHERE id = ?',
                        [imageResult.imageUrl, dbWord.id]
                    );
                    results.success.push({
                        id: dbWord.id,
                        word: dbWord.word,
                        image_url: imageResult.imageUrl,
                        image_hint: item.image_hint
                    });
                } else {
                    results.failed.push({ word: dbWord.word, error: imageResult.error });
                }
            } catch (err) {
                results.failed.push({ word: dbWord.word, error: err.message });
            }
        }

        res.json({
            success: true,
            data: results,
            message: `匹配 ${results.matched.length} 个，成功 ${results.success.length} 个，失败 ${results.failed.length} 个` +
                (results.notFound.length > 0 ? `，未找到 ${results.notFound.length} 个` : '')
        });
    } catch (error) {
        console.error('批量更新图片建议错误:', error);
        res.status(500).json({ success: false, message: '批量更新失败' });
    }
});

/**
 * 批量导入播客内容
 */
router.post('/podcast', async (req, res) => {
    try {
        const { contents, auto_generate_audio = false } = req.body;

        if (!Array.isArray(contents) || contents.length === 0) {
            return res.status(400).json({ success: false, message: '请提供内容列表' });
        }

        const results = {
            success: [],
            failed: [],
            total: contents.length
        };

        for (const content of contents) {
            try {
                const {
                    title, title_en, category = 'daily_phrases', difficulty_level = 1,
                    content_text, translation, is_free = true, sort_order = 0
                } = content;

                if (!title || !content_text) {
                    results.failed.push({ title: title || 'unknown', error: '标题或内容为空' });
                    continue;
                }

                let male_audio_url = content.male_audio_url || null;
                let female_audio_url = content.female_audio_url || null;
                let chinese_audio_url = content.chinese_audio_url || null;

                const result = await query(`
          INSERT INTO podcast_contents 
          (title, title_en, category, difficulty_level, content_text, translation, male_audio_url, female_audio_url, chinese_audio_url, is_free, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [title, title_en, category, difficulty_level, content_text, translation, male_audio_url, female_audio_url, chinese_audio_url, is_free, sort_order]);

                results.success.push({
                    id: result.insertId,
                    title
                });

            } catch (error) {
                results.failed.push({
                    title: content.title || 'unknown',
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            data: results,
            message: `成功导入 ${results.success.length} 个内容`
        });
    } catch (error) {
        console.error('批量导入播客内容错误:', error);
        res.status(500).json({ success: false, message: '批量导入失败' });
    }
});

/**
 * 通过AI生成场景并识别物体
 */
router.post('/generate-scene', async (req, res) => {
    try {
        const { scene_name, scene_description } = req.body;

        if (!scene_name) {
            return res.status(400).json({ success: false, message: '请提供场景名称' });
        }

        // 生成场景图片的优化提示词
        const prompt = `Create a detailed illustration of a ${scene_name} scene.
${scene_description ? `Description: ${scene_description}` : ''}

The image should show a typical ${scene_name} with many common objects that children can identify and learn.
Style: Colorful, detailed, cartoon-style illustration suitable for children's education.
Objects should be clearly visible and easy to point at.
Clean, organized composition with good lighting.

NO text, labels, or watermarks in the image.`;

        const imageResult = await aiService.generateImage(prompt);

        if (!imageResult.success) {
            return res.status(500).json({
                success: false,
                message: imageResult.error || '场景图片生成失败'
            });
        }

        // 创建场景记录
        const sceneResult = await query(`
      INSERT INTO scenes (name, name_en, description, image_url, difficulty_level)
      VALUES (?, ?, ?, ?, ?)
    `, [scene_name, scene_name, scene_description, imageResult.imageUrl, 1]);

        res.json({
            success: true,
            data: {
                scene_id: sceneResult.insertId,
                image_url: imageResult.imageUrl
            },
            message: '场景创建成功，请在管理后台添加物体标注'
        });
    } catch (error) {
        console.error('生成场景错误:', error);
        res.status(500).json({ success: false, message: '生成场景失败' });
    }
});

module.exports = router;
