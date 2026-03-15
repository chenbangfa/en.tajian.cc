-- 用户课程学习进度表（独立于每日计划，持久化记录每门课的完成进度）
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `user_course_progress` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL COMMENT '用户ID',
  `course_id` int NOT NULL COMMENT '课程ID',
  `completed_count` int DEFAULT 0 COMMENT '已完成的课程item数',
  `total_count` int DEFAULT 0 COMMENT '课程总item数（缓存，避免每次重新统计）',
  `last_active_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '最近学习时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_course` (`user_id`, `course_id`),
  KEY `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户课程学习进度';
