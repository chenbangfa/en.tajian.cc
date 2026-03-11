-- ============================================
-- 迁移脚本: 新增 image_hint 字段 + 更新 AI 图片提示词模板
-- 执行方式: mysql -u root -p english_learning < scripts/add-image-hint.sql
-- ============================================

-- 1. words 表新增 image_hint 列
ALTER TABLE `words` ADD COLUMN `image_hint` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '图片生成建议' AFTER `grammar_explanation`;

-- 2. 更新 4 个图片生成提示词模板，加入 {{image_hint}} 支持

-- 2.1 通用图片生成 (image_generate)
UPDATE `ai_prompts` SET `prompt_template` = 'Create a beautiful, clear image of "{{word}}" ({{translation}}).
{{#if category}}Category context: {{category}}{{#if subcategory}} > {{subcategory}}{{/if}}.{{/if}}

The "{{word}}" should be the main focus of the image, centered and clearly visible.
Show a realistic, friendly-looking representation that children (ages 3-10) would find appealing and easy to understand.

{{#if image_hint}}IMPORTANT visual description from the user: {{image_hint}}
Follow this description closely to generate a more accurate and realistic image.
{{/if}}

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
- Square format (1:1 aspect ratio)',
`description` = '默认的单词图片生成模板。变量: {{word}}, {{translation}}, {{category}}, {{subcategory}}, {{image_hint}}'
WHERE `prompt_key` = 'image_generate';

-- 2.2 抽象词图片生成 (image_abstract)
UPDATE `ai_prompts` SET `prompt_template` = 'Create an educational illustration for the concept "{{word}}" ({{translation}}).

This is an abstract concept (adjective, emotion, or quality). Visualize it clearly using one of these strategies:
- If it is an EMOTION (happy, sad, angry): Show a cute cartoon character with an exaggerated facial expression clearly showing that emotion
- If it is a PHYSICAL PROPERTY (big, small, tall, short): Show a clear comparison with two objects side by side (e.g., a big elephant next to a small mouse)
- If it is a QUALITY (fast, slow, hot, cold): Show a dynamic scene that immediately conveys the concept (e.g., a rocket for "fast", an ice cube for "cold")
- If it is an ACTION (run, jump, eat): Show a cute character performing the action

{{#if image_hint}}IMPORTANT visual description from the user: {{image_hint}}
Follow this description closely to generate a more accurate and realistic image.
{{/if}}

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
- Square format (1:1 aspect ratio)',
`description` = '为抽象概念词(形容词/情感/动作等)生成直观的配图。变量: {{word}}, {{translation}}, {{image_hint}}'
WHERE `prompt_key` = 'image_abstract';

-- 2.3 颜色词图片生成 (image_color)
UPDATE `ai_prompts` SET `prompt_template` = 'Create a simple, beautiful image to teach children the color "{{word}}" ({{translation}}).

Show a collection of 3-4 common objects ALL in the color {{word}}:
- A {{word}} balloon
- A {{word}} flower
- A {{word}} fruit or toy
- Arranged in a pleasing, balanced composition

{{#if image_hint}}IMPORTANT visual description from the user: {{image_hint}}
Follow this description closely to generate a more accurate and realistic image.
{{/if}}

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
- Square format (1:1 aspect ratio)',
`description` = '为颜色类单词(red/blue/green等)生成色彩鲜明的配图。变量: {{word}}, {{translation}}, {{image_hint}}'
WHERE `prompt_key` = 'image_color';

-- 2.4 数字词图片生成 (image_number)
UPDATE `ai_prompts` SET `prompt_template` = 'Create a fun, educational image to teach children the number word "{{word}}" ({{translation}}).

Requirements:
- Show the EXACT correct quantity of cute, colorful objects (matching the number "{{word}}")
- Objects should be identical and arranged in a clear, countable pattern (e.g., in a row or grid)
- Use friendly, appealing objects like: stars, apples, cute animals, balloons, or flowers
- Each object should be clearly distinct and easy to count

{{#if image_hint}}IMPORTANT visual description from the user: {{image_hint}}
Follow this description closely to generate a more accurate and realistic image.
{{/if}}

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
- Square format (1:1 aspect ratio)',
`description` = '为数字类单词(one/two/three等)生成数量准确的趣味配图。变量: {{word}}, {{translation}}, {{image_hint}}'
WHERE `prompt_key` = 'image_number';

-- 完成
SELECT '✅ 迁移完成: image_hint 字段已添加，AI提示词已更新' AS result;
