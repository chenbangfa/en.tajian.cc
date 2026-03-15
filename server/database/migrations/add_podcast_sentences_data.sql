-- 为 podcast_contents 添加句子级分析数据字段
SET NAMES utf8mb4;

ALTER TABLE `podcast_contents`
  ADD COLUMN `sentences_data` LONGTEXT NULL COMMENT '句子级AI分析数据（JSON），processing=分析中' AFTER `chinese_audio_url`;
