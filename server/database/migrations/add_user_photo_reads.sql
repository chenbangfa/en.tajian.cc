-- 用户拍摄点读功能 - 数据库迁移
-- 创建时间: 2026-03-15

SET NAMES utf8mb4;

-- --------------------------------------------------------
-- 用户拍摄点读分类
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_photo_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '用户ID',
  `name` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '分类名称',
  `sort_order` int DEFAULT 0 COMMENT '排序（数字小靠前）',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户拍摄点读分类';

-- --------------------------------------------------------
-- 用户拍摄点读图片
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_photo_reads` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '用户ID',
  `title` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '图片标题（用户自定义或OCR第一行文字）',
  `image_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '图片URL',
  `thumbnail_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '缩略图URL（暂用image_url）',
  `category_id` int DEFAULT 0 COMMENT '分类ID，0=未分类',
  `objects_count` int DEFAULT 0 COMMENT '热点数量（冗余缓存）',
  `tts_generated` tinyint(1) DEFAULT 0 COMMENT '是否已完成TTS生成',
  `points_cost` int DEFAULT 10 COMMENT '消耗积分数',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_user_category` (`user_id`, `category_id`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户拍摄点读图片';

-- --------------------------------------------------------
-- 用户拍摄点读热点
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS `user_photo_objects` (
  `id` int NOT NULL AUTO_INCREMENT,
  `photo_id` int NOT NULL COMMENT '图片ID',
  `user_id` int NOT NULL COMMENT '用户ID（冗余）',
  `english_text` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '英文文本',
  `translation` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '中文翻译',
  `phonetic` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '音标',
  `position_x` decimal(6,2) DEFAULT NULL COMMENT '热点左上角X（相对图片宽度百分比）',
  `position_y` decimal(6,2) DEFAULT NULL COMMENT '热点左上角Y（相对图片高度百分比）',
  `width` decimal(6,2) DEFAULT NULL COMMENT '热点宽度（百分比）',
  `height` decimal(6,2) DEFAULT NULL COMMENT '热点高度（百分比）',
  `audio_url_male` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '男声TTS音频URL',
  `audio_url_female` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '女声TTS音频URL',
  `sort_order` int DEFAULT 0 COMMENT '排序',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_photo_id` (`photo_id`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户拍摄点读热点';
