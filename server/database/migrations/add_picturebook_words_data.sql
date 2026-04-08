-- 绘本页面词汇分析数据（JSON）
-- 结构: {"words":[{"word":"the","phonetic":"/ðə/","pos":"art.","translation":"这个"},…]}
ALTER TABLE picture_book_pages
  ADD COLUMN words_data LONGTEXT DEFAULT NULL COMMENT '全词AI分析（JSON）';
