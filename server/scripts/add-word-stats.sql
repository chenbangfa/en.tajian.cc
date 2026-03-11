-- 为 words 表新增统计字段
-- view_count: 浏览次数（进入详情页+1）
-- assess_count: 评测次数（语音评测+1）

ALTER TABLE `words`
  ADD COLUMN `view_count` int(11) NOT NULL DEFAULT 0 COMMENT '浏览次数' AFTER `example_audio_female`,
  ADD COLUMN `assess_count` int(11) NOT NULL DEFAULT 0 COMMENT '评测次数' AFTER `view_count`;

-- 添加索引方便排序查询
ALTER TABLE `words`
  ADD INDEX `idx_view_count` (`view_count`),
  ADD INDEX `idx_created_at` (`created_at`);
