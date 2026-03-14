-- ============================================================
-- 迁移：统一 AI 补全提示词到 ai_prompts 表
-- 执行：mysql -u root -p english_learning < migrate-enhance-prompts.sql
-- ============================================================

-- 1. 更新 word_enhance：加入禁止拼音指令 + existing_sentence 支持
UPDATE `ai_prompts` SET `prompt_template` =
'You are an expert English teacher creating learning materials for Chinese children (ages 3-10).

For the English word "{{word}}"{{#if translation}} (meaning: {{translation}}){{/if}}:
{{#if existing_sentence}}The word already has an example sentence: "{{existing_sentence}}" — please translate it for example_translation only, do not generate a new sentence.
{{/if}}
Please provide:
{{#unless existing_sentence}}1. **phonetic**: IPA phonetic transcription (e.g., /ˈæpl/)
2. **example_sentence**: A simple, fun English sentence (max 10 words, suitable for children)
{{/unless}}3. **example_translation**: Chinese translation of the example sentence

IMPORTANT: example_translation must contain ONLY Chinese characters. Do NOT include pinyin, romanization, phonetics, or any extra parentheses/brackets.

Requirements:
- Example sentences should be about topics children love: animals, food, family, games, nature
- Use simple vocabulary (suitable for beginners)

Respond ONLY with valid JSON:
{"phonetic": "/ˈæpl/", "example_sentence": "I like to eat red apples.", "example_translation": "我喜欢吃红苹果。"}'
WHERE `prompt_key` = 'word_enhance';

-- 2. 新增 word_translate：单词已有例句，只补中文翻译
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('word_translate', '单词例句翻译',
'Translate this English example sentence to Chinese for children\'s English learning (ages 5-10).
Word: "{{word}}"{{#if translation}} (meaning: {{translation}}){{/if}}
Example sentence: "{{example_sentence}}"

IMPORTANT: Output ONLY the Chinese translation. Do NOT include pinyin, romanization, phonetics, or any extra parentheses/brackets.

Respond ONLY with valid JSON:
{"example_translation": "我喜欢吃苹果。"}',
'单词已有例句时，只生成例句的中文翻译。变量: {{word}}, {{translation}}, {{example_sentence}}', 1)
ON DUPLICATE KEY UPDATE
  `prompt_name`     = VALUES(`prompt_name`),
  `prompt_template` = VALUES(`prompt_template`),
  `description`     = VALUES(`description`);

-- 3. 新增 phrase_enhance：短语无例句，生成例句+翻译
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('phrase_enhance', '短语例句生成',
'You are an English teacher for Chinese children (ages 5-10).
For the English phrase "{{word}}"{{#if translation}} (meaning: {{translation}}){{/if}}, please provide:
1. **example_sentence**: A simple, natural English example sentence using this phrase (max 12 words)
2. **example_translation**: Chinese translation of that sentence

IMPORTANT: example_translation must contain ONLY Chinese characters. Do NOT include pinyin, romanization, phonetics, or any extra parentheses/brackets.

Respond ONLY with valid JSON:
{"example_sentence": "You are welcome here.", "example_translation": "你在这里受欢迎。"}',
'短语无例句时，生成例句及其中文翻译。变量: {{word}}, {{translation}}', 1)
ON DUPLICATE KEY UPDATE
  `prompt_name`     = VALUES(`prompt_name`),
  `prompt_template` = VALUES(`prompt_template`),
  `description`     = VALUES(`description`);

-- 4. 新增 phrase_translate：短语已有例句，只补中文翻译
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('phrase_translate', '短语例句翻译',
'Translate this English example sentence to Chinese for children\'s English learning (ages 5-10).
Phrase: "{{word}}"{{#if translation}} (meaning: {{translation}}){{/if}}
Example sentence: "{{example_sentence}}"

IMPORTANT: Output ONLY the Chinese translation. Do NOT include pinyin, romanization, phonetics, or any extra parentheses/brackets.

Respond ONLY with valid JSON:
{"example_translation": "不客气！"}',
'短语已有例句时，只生成例句的中文翻译。变量: {{word}}, {{translation}}, {{example_sentence}}', 1)
ON DUPLICATE KEY UPDATE
  `prompt_name`     = VALUES(`prompt_name`),
  `prompt_template` = VALUES(`prompt_template`),
  `description`     = VALUES(`description`);

-- 5. 新增 sentence_translate：句子类型，翻译句子
INSERT INTO `ai_prompts` (`prompt_key`, `prompt_name`, `prompt_template`, `description`, `is_active`)
VALUES ('sentence_translate', '句子翻译',
'You are an English teacher for Chinese children (ages 5-10).
Translate the following English sentence into natural, simple Chinese.
{{#if translation}}Reference meaning: {{translation}}{{/if}}

English: "{{sentence}}"

IMPORTANT: Output ONLY the Chinese translation. Do NOT include pinyin, romanization, phonetics, or any extra parentheses/brackets.

Respond ONLY with valid JSON:
{"example_translation": "今天鞋子打折啦！"}',
'句子类型内容的中文翻译。变量: {{sentence}}, {{translation}}', 1)
ON DUPLICATE KEY UPDATE
  `prompt_name`     = VALUES(`prompt_name`),
  `prompt_template` = VALUES(`prompt_template`),
  `description`     = VALUES(`description`);

SELECT CONCAT('✅ 迁移完成，当前提示词数量: ', COUNT(*), ' 条') AS result FROM ai_prompts;
