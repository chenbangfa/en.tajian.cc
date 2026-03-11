-- ============================================
-- 恢复 admin_users 和 ai_prompts 表数据
-- 执行方式: mysql -u root -p english_learning < restore-admin-and-prompts.sql
-- ============================================

-- 1. 插入管理员账户 (用户名: admin, 密码: bangfa)
INSERT INTO `admin_users` (`username`, `password_hash`, `display_name`, `is_active`)
VALUES ('admin', '$2b$10$zEYxb2ejt5qJJga12qT72uE29fbG7Bj0RbXpNNfHUYBo2sTV34koy', '管理员', 1);

-- 2. 插入 AI 提示词模板

-- 2.1 单词增强提示词 (word_enhance)
-- 用途: 批量导入时 AI 自动补全单词数据 (音标、翻译、例句、语法详解)
-- 使用位置: ai.service.js -> enhanceWordData() -> batchEnhanceWords()
-- 模板变量: {{word}}, {{translation}}
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('word_enhance', '单词数据增强', 'You are an expert English teacher creating learning materials for Chinese children (ages 3-10).

For the English word "{{word}}"{{#if translation}} (meaning: {{translation}}){{/if}}, please provide the following information:

1. **phonetic**: IPA phonetic transcription (e.g., /ˈæpl/)
{{#unless translation}}2. **translation**: The most common Chinese translation of the word (simple, child-friendly)
{{/unless}}3. **example_sentence**: A simple, fun English sentence using this word that a child can understand (max 10 words, use present tense when possible)
4. **example_translation**: Chinese translation of the example sentence
5. **grammar_explanation**: Brief grammar analysis of the example sentence in Chinese. Explain:
   - Sentence structure (主谓宾/主系表 etc.)
   - Key grammar points (tense, word types)
   - Keep it concise (2-3 sentences max)

Requirements:
- Example sentences should be about topics children love: animals, food, family, games, nature
- Use simple vocabulary (suitable for beginners)
- Make the sentence vivid and fun

Respond ONLY with a valid JSON object:
{
  "phonetic": "/ˈæpl/",
  {{#unless translation}}"translation": "苹果",
  {{/unless}}"example_sentence": "I like to eat red apples.",
  "example_translation": "我喜欢吃红苹果。",
  "grammar_explanation": "这是主谓宾结构。I(主语) like(谓语) to eat red apples(宾语)。like to do表示"喜欢做某事"，red是形容词修饰名词apples。"
}', '批量导入单词时，AI自动生成音标、翻译、例句和语法详解。变量: {{word}}, {{translation}}', 1);

-- 2.2 通用图片生成提示词 (image_generate)
-- 用途: 为普通单词生成配图 (默认模板)
-- 使用位置: ai.service.js -> generateWordImage() -> batch generate-single
-- 模板变量: {{word}}, {{translation}}, {{category}}, {{category_en}}, {{subcategory}}
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('image_generate', '通用图片生成', 'Create a beautiful, clear image of "{{word}}" ({{translation}}).
{{#if category}}Category context: {{category}}{{#if subcategory}} > {{subcategory}}{{/if}}.{{/if}}

The "{{word}}" should be the main focus of the image, centered and clearly visible.
Show a realistic, friendly-looking representation that children (ages 3-10) would find appealing and easy to understand.

Style Guidelines:
- Clean, simple background (solid light color or soft gradient) that does not distract from the main subject
- Bright, vibrant but natural colors
- Soft, warm lighting with gentle shadows
- High quality, photorealistic style
- The image should immediately help a child understand what "{{word}}" means

STRICT RULES:
- NO text, words, letters, numbers, or labels in the image
- NO watermarks, signatures, or logos
- NO scary, violent, or inappropriate content
- Safe and friendly for young children
- Square format (1:1 aspect ratio)', '默认的单词图片生成模板。变量: {{word}}, {{translation}}, {{category}}, {{subcategory}}', 1);

-- 2.3 抽象词图片生成提示词 (image_abstract)
-- 用途: 为抽象概念词 (形容词、情感词等) 生成配图
-- 使用位置: batch/generate.ejs 下拉选择
-- 模板变量: {{word}}, {{translation}}, {{category}}, {{category_en}}, {{subcategory}}
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('image_abstract', '抽象词图片生成', 'Create an educational illustration for the concept "{{word}}" ({{translation}}).

This is an abstract concept (adjective, emotion, or quality). Visualize it clearly using one of these strategies:
- If it is an EMOTION (happy, sad, angry): Show a cute cartoon character with an exaggerated facial expression clearly showing that emotion
- If it is a PHYSICAL PROPERTY (big, small, tall, short): Show a clear comparison with two objects side by side (e.g., a big elephant next to a small mouse)
- If it is a QUALITY (fast, slow, hot, cold): Show a dynamic scene that immediately conveys the concept (e.g., a rocket for "fast", an ice cube for "cold")
- If it is an ACTION (run, jump, eat): Show a cute character performing the action

Style Guidelines:
- Colorful, child-friendly cartoon/illustration style
- Round, friendly character designs with big expressive features
- Bright, cheerful color palette (pastels + vivid accents)
- The concept should be IMMEDIATELY understandable at a glance
- Simple, clean composition

STRICT RULES:
- NO text, words, letters, numbers, or labels in the image
- NO watermarks or signatures
- Safe for children (ages 3-10)
- Square format (1:1 aspect ratio)', '为抽象概念词(形容词/情感/动作等)生成直观的配图。变量: {{word}}, {{translation}}', 1);

-- 2.4 颜色词图片生成提示词 (image_color)
-- 用途: 为颜色相关单词生成配图
-- 使用位置: batch/generate.ejs 下拉选择
-- 模板变量: {{word}}, {{translation}}, {{category}}, {{category_en}}, {{subcategory}}
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('image_color', '颜色词图片生成', 'Create a simple, beautiful image to teach children the color "{{word}}" ({{translation}}).

Show a collection of 3-4 common objects ALL in the color {{word}}:
- A {{word}} balloon
- A {{word}} flower
- A {{word}} fruit or toy
- Arranged in a pleasing, balanced composition

Style Guidelines:
- Clean white or very light background to make the {{word}} color POP
- Objects should be photorealistic with vivid, saturated {{word}} coloring
- Soft lighting to show the true color clearly
- Objects should be things children easily recognize
- The {{word}} color should DOMINATE the image

STRICT RULES:
- NO text, words, letters, numbers, or labels in the image
- NO watermarks or signatures
- Safe for children (ages 3-10)
- Square format (1:1 aspect ratio)', '为颜色类单词(red/blue/green等)生成色彩鲜明的配图。变量: {{word}}, {{translation}}', 1);

-- 2.5 数字词图片生成提示词 (image_number)
-- 用途: 为数字相关单词生成配图
-- 使用位置: batch/generate.ejs 下拉选择
-- 模板变量: {{word}}, {{translation}}, {{category}}, {{category_en}}, {{subcategory}}
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('image_number', '数字词图片生成', 'Create a fun, educational image to teach children the number word "{{word}}" ({{translation}}).

Requirements:
- Show the EXACT correct quantity of cute, colorful objects (matching the number "{{word}}")
- Objects should be identical and arranged in a clear, countable pattern (e.g., in a row or grid)
- Use friendly, appealing objects like: stars, apples, cute animals, balloons, or flowers
- Each object should be clearly distinct and easy to count

Style Guidelines:
- Clean, soft-colored background (light blue, light yellow, or white)
- Bright, cheerful cartoon style
- Objects should be large enough to count easily
- Balanced, organized composition
- The arrangement should make counting intuitive for children

STRICT RULES:
- NO text, words, letters, numbers, or digits in the image
- NO watermarks or signatures
- The NUMBER of objects must be EXACTLY correct for "{{word}}"
- Safe for children (ages 3-10)
- Square format (1:1 aspect ratio)', '为数字类单词(one/two/three等)生成数量准确的趣味配图。变量: {{word}}, {{translation}}', 1);

-- 完成
SELECT '✅ 数据恢复完成!' AS result;
SELECT '管理员账户: admin / bangfa' AS admin_info;
SELECT CONCAT('AI提示词: ', COUNT(*), ' 条') AS prompts_info FROM ai_prompts;
