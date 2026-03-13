-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- 主机： localhost
-- 生成日期： 2026-03-12 20:49:09
-- 服务器版本： 8.4.5
-- PHP 版本： 8.2.28

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- 数据库： `english_learning`
--

-- --------------------------------------------------------

--
-- 表的结构 `admin_users`
--

CREATE TABLE `admin_users` (
  `id` int NOT NULL,
  `username` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '用户名',
  `password_hash` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '密码哈希(bcrypt)',
  `display_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '显示名称',
  `is_active` tinyint(1) DEFAULT '1' COMMENT '是否启用',
  `last_login_at` timestamp NULL DEFAULT NULL COMMENT '最后登录时间',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='管理员用户表';

-- --------------------------------------------------------

--
-- 表的结构 `ai_prompts`
--

CREATE TABLE `ai_prompts` (
  `id` int NOT NULL,
  `prompt_key` varchar(50) NOT NULL,
  `prompt_name` varchar(100) NOT NULL,
  `prompt_template` text NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT '1',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- --------------------------------------------------------

--
-- 表的结构 `antonyms`
--

CREATE TABLE `antonyms` (
  `id` int NOT NULL,
  `word_id_1` int NOT NULL,
  `word_id_2` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='反义词关系';

-- --------------------------------------------------------

--
-- 表的结构 `checkin_course_categories`
--

CREATE TABLE `checkin_course_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `icon` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT '📚' COMMENT 'emoji图标或路径',
  `sort_order` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- 表的结构 `checkin_courses`
--

CREATE TABLE `checkin_courses` (
  `id` int NOT NULL,
  `name` varchar(120) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `description` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `level` tinyint DEFAULT '1' COMMENT '建议学习等级 0-9',
  `is_active` tinyint(1) DEFAULT '1',
  `sort_order` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- 表的结构 `checkin_course_items`
--

CREATE TABLE `checkin_course_items` (
  `id` int NOT NULL,
  `course_id` int NOT NULL,
  `task_type` enum('word','scene','podcast') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_id` int NOT NULL,
  `sort_order` int DEFAULT '0',
  `is_active` tinyint(1) DEFAULT '1',
  `note` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- 表的结构 `checkin_shares`
--

CREATE TABLE `checkin_shares` (
  `id` int NOT NULL,
  `share_id` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '分享唯一ID',
  `user_id` int NOT NULL,
  `plan_id` int NOT NULL,
  `nickname` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `avatar_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `task_date` date NOT NULL COMMENT '任务日期',
  `mode` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'standard',
  `streak_days` int DEFAULT '0',
  `total_score` decimal(7,2) DEFAULT '0.00',
  `avg_score` decimal(5,2) DEFAULT '0.00',
  `total_points` int DEFAULT '0',
  `items_snapshot` json DEFAULT NULL COMMENT '任务明细快照',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='打卡分享记录';

-- --------------------------------------------------------

--
-- 表的结构 `checkin_stats`
--

CREATE TABLE `checkin_stats` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `total_days` int DEFAULT '0' COMMENT '累计打卡天数',
  `consecutive_days` int DEFAULT '0' COMMENT '连续打卡天数',
  `max_consecutive` int DEFAULT '0' COMMENT '最长连续天数',
  `total_score` decimal(10,2) DEFAULT '0.00' COMMENT '累计得分',
  `last_checkin_date` date DEFAULT NULL COMMENT '最后打卡日期'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='打卡统计';

-- --------------------------------------------------------

--
-- 表的结构 `daily_task_items`
--

CREATE TABLE `daily_task_items` (
  `id` int NOT NULL,
  `plan_id` int NOT NULL,
  `user_id` int NOT NULL,
  `task_type` enum('word','scene','podcast') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `target_id` int DEFAULT NULL,
  `course_item_id` int DEFAULT NULL,
  `reference_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci,
  `extra_info` json DEFAULT NULL,
  `status` enum('pending','completed','skipped') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'pending',
  `assessment_id` int DEFAULT NULL,
  `score` decimal(5,2) DEFAULT NULL,
  `pronunciation_score` decimal(5,2) DEFAULT NULL,
  `fluency_score` decimal(5,2) DEFAULT NULL,
  `integrity_score` decimal(5,2) DEFAULT NULL,
  `audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `points_earned` int DEFAULT '0',
  `completed_at` timestamp NULL DEFAULT NULL,
  `sort_order` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- 表的结构 `daily_task_plans`
--

CREATE TABLE `daily_task_plans` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `task_date` date NOT NULL,
  `mode` enum('easy','standard','challenge') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'standard',
  `strategy` enum('random','curriculum') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'random',
  `course_id` int DEFAULT NULL,
  `learning_level` tinyint DEFAULT '1',
  `word_target` int DEFAULT '3',
  `scene_target` int DEFAULT '2',
  `podcast_target` int DEFAULT '1',
  `word_completed` int DEFAULT '0',
  `scene_completed` int DEFAULT '0',
  `podcast_completed` int DEFAULT '0',
  `total_score` decimal(7,2) DEFAULT '0.00',
  `avg_score` decimal(5,2) DEFAULT '0.00',
  `total_points` int DEFAULT '0',
  `bonus_points` int DEFAULT '0',
  `is_completed` tinyint(1) DEFAULT '0',
  `completed_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- 表的结构 `podcast_categories`
--

CREATE TABLE `podcast_categories` (
  `id` int NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '分类名称',
  `name_en` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '英文名称',
  `parent_id` int DEFAULT '0' COMMENT '父分类ID',
  `icon` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '图标',
  `sort_order` int DEFAULT '0' COMMENT '排序',
  `is_active` tinyint(1) DEFAULT '1' COMMENT '是否启用',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='播客分类表';

-- --------------------------------------------------------

--
-- 表的结构 `podcast_contents`
--

CREATE TABLE `podcast_contents` (
  `id` int NOT NULL,
  `category_id` int DEFAULT NULL,
  `title` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '标题',
  `title_en` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '英文标题',
  `category` enum('daily_phrases','scene_dialogues','stories','songs') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `difficulty_level` tinyint DEFAULT '1' COMMENT '难度等级',
  `content_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '英文内容',
  `translation` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '中文翻译',
  `male_audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '男声音频URL',
  `female_audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '女声音频URL',
  `chinese_audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '中文音频URL',
  `duration_seconds` int DEFAULT NULL COMMENT '时长（秒）',
  `is_free` tinyint(1) DEFAULT '1' COMMENT '是否免费',
  `sort_order` int DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='播客内容';

-- --------------------------------------------------------

--
-- 表的结构 `podcast_progress`
--

CREATE TABLE `podcast_progress` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `content_id` int NOT NULL,
  `current_position` int DEFAULT '0' COMMENT '当前位置（句子索引）',
  `play_count` int DEFAULT '0' COMMENT '播放次数',
  `last_played_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='播客播放进度';

-- --------------------------------------------------------

--
-- 表的结构 `points_logs`
--

CREATE TABLE `points_logs` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `change_amount` int NOT NULL COMMENT '变动数量（正负）',
  `change_type` enum('consume','reward','recharge','refund') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '变动类型',
  `description` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '描述',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='积分日志';

-- --------------------------------------------------------

--
-- 表的结构 `reading_checkins`
--

CREATE TABLE `reading_checkins` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `content_id` int NOT NULL COMMENT '阅读内容ID',
  `recording_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '录音文件URL',
  `assessment_id` int DEFAULT NULL COMMENT '关联评测结果ID',
  `score` decimal(5,2) DEFAULT NULL COMMENT '打卡得分',
  `checkin_date` date NOT NULL COMMENT '打卡日期',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='阅读打卡记录';

-- --------------------------------------------------------

--
-- 表的结构 `scenes`
--

CREATE TABLE `scenes` (
  `id` int NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '场景名称',
  `name_en` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '英文名称',
  `description` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '描述',
  `category_id` int DEFAULT '0' COMMENT '分类ID',
  `image_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '场景图片URL',
  `thumbnail_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '缩略图URL',
  `difficulty_level` tinyint DEFAULT '1' COMMENT '难度等级',
  `is_active` tinyint(1) DEFAULT '1' COMMENT '是否启用',
  `sort_order` int DEFAULT '0' COMMENT '排序',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='场景表';

-- --------------------------------------------------------

--
-- 表的结构 `scene_categories`
--

CREATE TABLE `scene_categories` (
  `id` int NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '分类名称',
  `name_en` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '英文名称',
  `parent_id` int DEFAULT '0' COMMENT '父分类ID (0表示一级分类)',
  `icon` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '图标/封面图',
  `sort_order` int DEFAULT '0' COMMENT '排序',
  `is_active` tinyint(1) DEFAULT '1' COMMENT '是否启用',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='场景分类表';

-- --------------------------------------------------------

--
-- 表的结构 `scene_objects`
--

CREATE TABLE `scene_objects` (
  `id` int NOT NULL,
  `scene_id` int NOT NULL,
  `word_id` int DEFAULT NULL COMMENT '关联单词ID',
  `custom_label` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '自定义标签（可以是句子）',
  `phonetic` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '音标',
  `translation` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '中文翻译',
  `audio_url_male` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '男声音频',
  `audio_url_female` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '女声音频',
  `position_x` decimal(5,2) DEFAULT NULL COMMENT '相对位置X（百分比）',
  `position_y` decimal(5,2) DEFAULT NULL COMMENT '相对位置Y（百分比）',
  `label_width` decimal(5,2) DEFAULT NULL COMMENT '标签宽度',
  `label_height` decimal(5,2) DEFAULT NULL COMMENT '标签高度',
  `audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '音频URL',
  `sort_order` int DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='场景物体标注';

-- --------------------------------------------------------

--
-- 表的结构 `tts_cache`
--

CREATE TABLE `tts_cache` (
  `id` int NOT NULL,
  `text_hash` char(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '文本MD5哈希',
  `text_content` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '原始文本',
  `voice` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'female' COMMENT '声音类型',
  `audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '音频URL',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='TTS缓存';

-- --------------------------------------------------------

--
-- 表的结构 `users`
--

CREATE TABLE `users` (
  `id` int NOT NULL,
  `openid` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '微信openid',
  `unionid` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '微信unionid',
  `nickname` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '昵称',
  `avatar_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '头像URL',
  `phone` varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '手机号',
  `vip_level` tinyint DEFAULT '0' COMMENT 'VIP等级 0:普通 1:月卡 2:年卡',
  `vip_expire_date` date DEFAULT NULL COMMENT 'VIP过期日期',
  `points` int DEFAULT '0' COMMENT '积分',
  `total_study_minutes` int DEFAULT '0' COMMENT '累计学习分钟数',
  `daily_mode` enum('easy','standard','challenge') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'standard',
  `checkin_strategy` enum('random','curriculum') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'random',
  `current_course_id` int DEFAULT NULL,
  `learning_level` tinyint DEFAULT '1',
  `daily_word_target` int DEFAULT '10',
  `daily_passing_score` tinyint DEFAULT '60',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户表';

-- --------------------------------------------------------

--
-- 表的结构 `user_achievements`
--

CREATE TABLE `user_achievements` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `achievement_key` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `achievement_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `achievement_desc` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `achieved_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- 表的结构 `voice_assessments`
--

CREATE TABLE `voice_assessments` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `content_type` enum('word','sentence','paragraph') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'sentence',
  `reference_text` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '参考文本',
  `audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '录音URL',
  `overall_score` decimal(5,2) DEFAULT NULL COMMENT '总分',
  `pronunciation_score` decimal(5,2) DEFAULT NULL COMMENT '发音分',
  `fluency_score` decimal(5,2) DEFAULT NULL COMMENT '流利度',
  `integrity_score` decimal(5,2) DEFAULT NULL COMMENT '完整度',
  `detail_result` json DEFAULT NULL COMMENT '详细结果',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='语音评测记录';

-- --------------------------------------------------------

--
-- 表的结构 `voice_shares`
--

CREATE TABLE `voice_shares` (
  `id` int NOT NULL,
  `share_id` varchar(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` int NOT NULL,
  `nickname` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `avatar_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `filter_desc` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '筛选条件描述',
  `filter_params` json DEFAULT NULL COMMENT '筛选参数',
  `total_count` int DEFAULT '0',
  `avg_score` decimal(5,1) DEFAULT '0.0',
  `max_score` decimal(5,1) DEFAULT '0.0',
  `total_days` int DEFAULT '0',
  `records_json` json DEFAULT NULL COMMENT '精选记录快照',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='评测分享记录';

-- --------------------------------------------------------

--
-- 表的结构 `words`
--

CREATE TABLE `words` (
  `id` int NOT NULL,
  `word` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '单词/短语/句子内容',
  `phonetic` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '音标（单词/短语均适用）',
  `translation` varchar(200) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '中文翻译',
  `category_id` int DEFAULT NULL COMMENT '分类ID',
  `difficulty_level` tinyint DEFAULT '1' COMMENT '难度等级 1-5',
  `word_type` enum('noun','verb','adj','adv','prep','conj','pron','other') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'noun' COMMENT '词性',
  `content_type` enum('word','phrase','sentence') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'word' COMMENT '内容类型：单词/短语/句子',
  `display_mode` enum('image','calendar','animation','icon') CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT 'image' COMMENT '展示模式',
  `image_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '图片URL（短语/句子可用场景图）',
  `audio_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '音频URL',
  `audio_url_male` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '男声音频URL',
  `audio_url_female` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '女声音频URL',
  `example_sentence` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '例句（sentence类型时为扩展说明）',
  `example_translation` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '例句翻译',
  `grammar_explanation` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '语法/用法详解',
  `image_hint` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '图片生成建议',
  `video_url` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '视频URL（短语/句子动态演示）',
  `example_audio_male` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '例句男声音频URL',
  `example_audio_female` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '例句女声音频URL',
  `view_count` int NOT NULL DEFAULT '0' COMMENT '浏览次数',
  `assess_count` int NOT NULL DEFAULT '0' COMMENT '评测次数',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='单词表';

-- --------------------------------------------------------

--
-- 表的结构 `word_categories`
--

CREATE TABLE `word_categories` (
  `id` int NOT NULL,
  `name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL COMMENT '分类名称',
  `name_en` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '英文名称',
  `parent_id` int DEFAULT '0' COMMENT '父分类ID',
  `icon` varchar(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL COMMENT '图标',
  `sort_order` int DEFAULT '0' COMMENT '排序',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='单词分类';

-- --------------------------------------------------------

--
-- 表的结构 `word_learning_records`
--

CREATE TABLE `word_learning_records` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  `word_id` int NOT NULL,
  `learn_count` int DEFAULT '0' COMMENT '学习次数',
  `correct_count` int DEFAULT '0' COMMENT '正确次数',
  `last_learned_at` timestamp NULL DEFAULT NULL COMMENT '最后学习时间',
  `mastery_level` tinyint DEFAULT '0' COMMENT '掌握程度 0-5',
  `next_review_at` timestamp NULL DEFAULT NULL COMMENT '下次复习时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='单词学习记录';

--
-- 转储表的索引
--

--
-- 表的索引 `admin_users`
--
ALTER TABLE `admin_users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `username` (`username`),
  ADD KEY `idx_username` (`username`);

--
-- 表的索引 `ai_prompts`
--
ALTER TABLE `ai_prompts`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `prompt_key` (`prompt_key`);

--
-- 表的索引 `antonyms`
--
ALTER TABLE `antonyms`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `pair` (`word_id_1`,`word_id_2`),
  ADD KEY `word_id_2` (`word_id_2`);

--
-- 表的索引 `checkin_courses`
--
ALTER TABLE `checkin_courses`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_level` (`level`),
  ADD KEY `idx_active` (`is_active`);

--
-- 表的索引 `checkin_course_items`
--
ALTER TABLE `checkin_course_items`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uniq_course_item` (`course_id`,`task_type`,`target_id`),
  ADD KEY `idx_course` (`course_id`),
  ADD KEY `idx_type` (`task_type`);

--
-- 表的索引 `checkin_shares`
--
ALTER TABLE `checkin_shares`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_share_id` (`share_id`),
  ADD KEY `idx_user` (`user_id`),
  ADD KEY `checkin_shares_ibfk_2` (`plan_id`);

--
-- 表的索引 `checkin_stats`
--
ALTER TABLE `checkin_stats`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `user_id` (`user_id`);

--
-- 表的索引 `daily_task_items`
--
ALTER TABLE `daily_task_items`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_plan` (`plan_id`);

--
-- 表的索引 `daily_task_plans`
--
ALTER TABLE `daily_task_plans`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_user_date` (`user_id`,`task_date`);

--
-- 表的索引 `podcast_categories`
--
ALTER TABLE `podcast_categories`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_parent` (`parent_id`);

--
-- 表的索引 `podcast_contents`
--
ALTER TABLE `podcast_contents`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_category` (`category`),
  ADD KEY `idx_free` (`is_free`),
  ADD KEY `idx_category_id` (`category_id`);

--
-- 表的索引 `podcast_progress`
--
ALTER TABLE `podcast_progress`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `user_content` (`user_id`,`content_id`),
  ADD KEY `content_id` (`content_id`);

--
-- 表的索引 `points_logs`
--
ALTER TABLE `points_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user` (`user_id`);

--
-- 表的索引 `reading_checkins`
--
ALTER TABLE `reading_checkins`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `user_daily` (`user_id`,`content_id`,`checkin_date`),
  ADD KEY `idx_date` (`checkin_date`),
  ADD KEY `content_id` (`content_id`),
  ADD KEY `assessment_id` (`assessment_id`);

--
-- 表的索引 `scenes`
--
ALTER TABLE `scenes`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_active` (`is_active`),
  ADD KEY `idx_category` (`category_id`);

--
-- 表的索引 `scene_categories`
--
ALTER TABLE `scene_categories`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_parent` (`parent_id`);

--
-- 表的索引 `scene_objects`
--
ALTER TABLE `scene_objects`
  ADD PRIMARY KEY (`id`),
  ADD KEY `scene_id` (`scene_id`),
  ADD KEY `word_id` (`word_id`);

--
-- 表的索引 `tts_cache`
--
ALTER TABLE `tts_cache`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `hash_voice` (`text_hash`,`voice`);

--
-- 表的索引 `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `openid` (`openid`),
  ADD KEY `idx_openid` (`openid`),
  ADD KEY `idx_vip` (`vip_level`,`vip_expire_date`);

--
-- 表的索引 `user_achievements`
--
ALTER TABLE `user_achievements`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `idx_user_achievement` (`user_id`,`achievement_key`);

--
-- 表的索引 `voice_assessments`
--
ALTER TABLE `voice_assessments`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_user` (`user_id`);

--
-- 表的索引 `voice_shares`
--
ALTER TABLE `voice_shares`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `share_id` (`share_id`),
  ADD KEY `idx_user` (`user_id`),
  ADD KEY `idx_share` (`share_id`);

--
-- 表的索引 `words`
--
ALTER TABLE `words`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_category` (`category_id`),
  ADD KEY `idx_difficulty` (`difficulty_level`),
  ADD KEY `idx_word` (`word`),
  ADD KEY `idx_view_count` (`view_count`),
  ADD KEY `idx_created_at` (`created_at`);

--
-- 表的索引 `word_categories`
--
ALTER TABLE `word_categories`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_parent` (`parent_id`);

--
-- 表的索引 `word_learning_records`
--
ALTER TABLE `word_learning_records`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `user_word` (`user_id`,`word_id`),
  ADD KEY `word_id` (`word_id`);

--
-- 在导出的表使用AUTO_INCREMENT
--

--
-- 使用表AUTO_INCREMENT `admin_users`
--
ALTER TABLE `admin_users`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `ai_prompts`
--
ALTER TABLE `ai_prompts`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `antonyms`
--
ALTER TABLE `antonyms`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `checkin_courses`
--
ALTER TABLE `checkin_courses`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `checkin_course_items`
--
ALTER TABLE `checkin_course_items`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `checkin_shares`
--
ALTER TABLE `checkin_shares`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `checkin_stats`
--
ALTER TABLE `checkin_stats`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `daily_task_items`
--
ALTER TABLE `daily_task_items`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `daily_task_plans`
--
ALTER TABLE `daily_task_plans`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `podcast_categories`
--
ALTER TABLE `podcast_categories`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `podcast_contents`
--
ALTER TABLE `podcast_contents`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `podcast_progress`
--
ALTER TABLE `podcast_progress`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `points_logs`
--
ALTER TABLE `points_logs`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `reading_checkins`
--
ALTER TABLE `reading_checkins`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `scenes`
--
ALTER TABLE `scenes`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `scene_categories`
--
ALTER TABLE `scene_categories`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `scene_objects`
--
ALTER TABLE `scene_objects`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `tts_cache`
--
ALTER TABLE `tts_cache`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `users`
--
ALTER TABLE `users`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `user_achievements`
--
ALTER TABLE `user_achievements`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `voice_assessments`
--
ALTER TABLE `voice_assessments`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `voice_shares`
--
ALTER TABLE `voice_shares`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `words`
--
ALTER TABLE `words`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `word_categories`
--
ALTER TABLE `word_categories`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 使用表AUTO_INCREMENT `word_learning_records`
--
ALTER TABLE `word_learning_records`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- 限制导出的表
--

--
-- 限制表 `antonyms`
--
ALTER TABLE `antonyms`
  ADD CONSTRAINT `antonyms_ibfk_1` FOREIGN KEY (`word_id_1`) REFERENCES `words` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `antonyms_ibfk_2` FOREIGN KEY (`word_id_2`) REFERENCES `words` (`id`) ON DELETE CASCADE;

--
-- 限制表 `checkin_course_items`
--
ALTER TABLE `checkin_course_items`
  ADD CONSTRAINT `fk_checkin_course_items_course` FOREIGN KEY (`course_id`) REFERENCES `checkin_courses` (`id`) ON DELETE CASCADE;

--
-- 限制表 `checkin_shares`
--
ALTER TABLE `checkin_shares`
  ADD CONSTRAINT `checkin_shares_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `checkin_shares_ibfk_2` FOREIGN KEY (`plan_id`) REFERENCES `daily_task_plans` (`id`) ON DELETE CASCADE;

--
-- 限制表 `checkin_stats`
--
ALTER TABLE `checkin_stats`
  ADD CONSTRAINT `checkin_stats_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- 限制表 `podcast_contents`
--
ALTER TABLE `podcast_contents`
  ADD CONSTRAINT `podcast_contents_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `podcast_categories` (`id`) ON DELETE SET NULL;

--
-- 限制表 `podcast_progress`
--
ALTER TABLE `podcast_progress`
  ADD CONSTRAINT `podcast_progress_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `podcast_progress_ibfk_2` FOREIGN KEY (`content_id`) REFERENCES `podcast_contents` (`id`) ON DELETE CASCADE;

--
-- 限制表 `points_logs`
--
ALTER TABLE `points_logs`
  ADD CONSTRAINT `points_logs_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- 限制表 `reading_checkins`
--
ALTER TABLE `reading_checkins`
  ADD CONSTRAINT `reading_checkins_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `reading_checkins_ibfk_2` FOREIGN KEY (`content_id`) REFERENCES `podcast_contents` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `reading_checkins_ibfk_3` FOREIGN KEY (`assessment_id`) REFERENCES `voice_assessments` (`id`) ON DELETE SET NULL;

--
-- 限制表 `scene_objects`
--
ALTER TABLE `scene_objects`
  ADD CONSTRAINT `scene_objects_ibfk_1` FOREIGN KEY (`scene_id`) REFERENCES `scenes` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `scene_objects_ibfk_2` FOREIGN KEY (`word_id`) REFERENCES `words` (`id`) ON DELETE SET NULL;

--
-- 限制表 `voice_assessments`
--
ALTER TABLE `voice_assessments`
  ADD CONSTRAINT `voice_assessments_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

--
-- 限制表 `words`
--
ALTER TABLE `words`
  ADD CONSTRAINT `words_ibfk_1` FOREIGN KEY (`category_id`) REFERENCES `word_categories` (`id`) ON DELETE SET NULL;

--
-- 限制表 `word_learning_records`
--
ALTER TABLE `word_learning_records`
  ADD CONSTRAINT `word_learning_records_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  ADD CONSTRAINT `word_learning_records_ibfk_2` FOREIGN KEY (`word_id`) REFERENCES `words` (`id`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
