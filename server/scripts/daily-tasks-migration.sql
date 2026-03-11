-- =============================================
-- 每日任务系统 - 数据库迁移
-- =============================================

-- 1. 每日任务计划表（每天每用户一条主记录）
CREATE TABLE IF NOT EXISTS `daily_task_plans` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `task_date` DATE NOT NULL,
  `mode` ENUM('easy', 'standard', 'challenge') DEFAULT 'standard' COMMENT '任务模式',
  `word_target` INT DEFAULT 3 COMMENT '单词目标数',
  `scene_target` INT DEFAULT 2 COMMENT '场景句子目标数',
  `podcast_target` INT DEFAULT 1 COMMENT '播客目标数',
  `word_completed` INT DEFAULT 0 COMMENT '已完成单词数',
  `scene_completed` INT DEFAULT 0 COMMENT '已完成场景数',
  `podcast_completed` INT DEFAULT 0 COMMENT '已完成播客数',
  `total_score` DECIMAL(7,2) DEFAULT 0 COMMENT '总评测得分',
  `avg_score` DECIMAL(5,2) DEFAULT 0 COMMENT '平均分',
  `total_points` INT DEFAULT 0 COMMENT '获得积分',
  `bonus_points` INT DEFAULT 0 COMMENT '全部完成额外奖励',
  `is_completed` TINYINT(1) DEFAULT 0 COMMENT '是否全部完成（打卡成功）',
  `completed_at` TIMESTAMP NULL DEFAULT NULL COMMENT '完成时间',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `idx_user_date` (`user_id`, `task_date`),
  KEY `idx_user` (`user_id`),
  KEY `idx_date` (`task_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每日任务计划';

-- 2. 每日任务明细表
CREATE TABLE IF NOT EXISTS `daily_task_items` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `plan_id` INT NOT NULL,
  `user_id` INT NOT NULL,
  `task_type` ENUM('word', 'scene', 'podcast') NOT NULL COMMENT '任务类型',
  `target_id` INT DEFAULT NULL COMMENT '关联ID(word_id/scene_object_id/content_id)',
  `reference_text` TEXT COMMENT '跟读参考文本',
  `extra_info` JSON DEFAULT NULL COMMENT '额外信息(单词翻译/音标/图片/音频URL等)',
  `status` ENUM('pending', 'completed', 'skipped') DEFAULT 'pending',
  `assessment_id` INT DEFAULT NULL COMMENT '关联语音评测ID',
  `score` DECIMAL(5,2) DEFAULT NULL COMMENT '评测得分',
  `points_earned` INT DEFAULT 0 COMMENT '本任务获得积分',
  `completed_at` TIMESTAMP NULL DEFAULT NULL,
  `sort_order` INT DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_plan` (`plan_id`),
  KEY `idx_user` (`user_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='每日任务明细';

-- 3. 用户成就/里程碑表
CREATE TABLE IF NOT EXISTS `user_achievements` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `achievement_key` VARCHAR(50) NOT NULL COMMENT '成就标识',
  `achievement_name` VARCHAR(100) NOT NULL COMMENT '成就名称',
  `achievement_desc` VARCHAR(255) DEFAULT NULL COMMENT '成就描述',
  `achieved_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `idx_user_achievement` (`user_id`, `achievement_key`),
  KEY `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户成就';

-- 4. 用户任务模式偏好（如果字段不存在则添加）
-- MySQL 5.7 不支持 IF NOT EXISTS 语法，用存储过程安全添加
DROP PROCEDURE IF EXISTS _add_daily_mode;
DELIMITER $$
CREATE PROCEDURE _add_daily_mode()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'daily_mode') THEN
    ALTER TABLE `users` ADD COLUMN `daily_mode` ENUM('easy','standard','challenge') DEFAULT 'standard' COMMENT '每日任务模式' AFTER `total_study_minutes`;
  END IF;
END$$
DELIMITER ;
CALL _add_daily_mode();
DROP PROCEDURE IF EXISTS _add_daily_mode;

-- 注：podcast_contents 已有 difficulty_level tinyint(4) DEFAULT 1，含义为 1=简单 2=中等 3=困难，无需修改
