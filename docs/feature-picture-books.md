# 绘本故事功能规划

> 创建日期: 2026-03-19
> 状态: 规划中

---

## 一、功能定位

将现有「拍摄点读」(photo-read) 改造为「绘本故事」模块，由管理员在后台创建英语绘本小故事，配精美插图，用户在小程序端像翻书一样阅读，点击页面中的单词/句子可听发音、看翻译，并可跟读评测。

**核心体验：**
- 翻书阅读 — swiper 左右滑动翻页，沉浸式阅读
- 点读学习 — 点击页面上高亮的单词/句子，听发音、看翻译
- 跟读评测 — 对当前句子/单词进行语音评测，检验掌握程度
- 看图理解 — 精美配图帮助理解故事内容，增加学习兴趣

**与现有模块区别：**

| 模块 | 内容来源 | 单位 | 核心交互 |
|------|---------|------|---------|
| 场景学习 | 管理员 | 单张图+散词 | 点热点学单词 |
| 磨耳朵 | 管理员 | 音频文章 | 听力+逐句评测 |
| 绘本故事 | 管理员 | 多页图文故事 | 翻页阅读+点读+评测 |
| 拍摄点读 | 用户UGC | 单张照片 | OCR+点读 |

---

## 二、数据库设计

### 2.1 绘本分类表 `picture_book_categories`

```sql
CREATE TABLE `picture_book_categories` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL COMMENT '分类名称',
  `name_en` varchar(100) DEFAULT NULL COMMENT '英文名称',
  `icon` varchar(200) DEFAULT NULL COMMENT '分类图标URL',
  `sort_order` int DEFAULT 0 COMMENT '排序',
  `is_active` tinyint(1) DEFAULT 1 COMMENT '是否启用',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本分类表';
```

分类示例：启蒙认知、生活习惯、经典童话、自然科学、情绪管理

### 2.2 绘本主表 `picture_books`

```sql
CREATE TABLE `picture_books` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(200) NOT NULL COMMENT '绘本标题',
  `title_en` varchar(200) DEFAULT NULL COMMENT '英文标题',
  `cover_url` varchar(500) DEFAULT NULL COMMENT '封面图URL',
  `description` text DEFAULT NULL COMMENT '简介',
  `category_id` int DEFAULT 0 COMMENT '分类ID',
  `difficulty_level` tinyint DEFAULT 1 COMMENT '难度等级 1-5',
  `age_group` varchar(20) DEFAULT NULL COMMENT '适合年龄段 如 3-6, 6-9',
  `page_count` int DEFAULT 0 COMMENT '总页数（冗余缓存）',
  `is_free` tinyint(1) DEFAULT 1 COMMENT '是否免费',
  `is_active` tinyint(1) DEFAULT 1 COMMENT '是否上架',
  `sort_order` int DEFAULT 0 COMMENT '排序',
  `read_count` int DEFAULT 0 COMMENT '阅读次数',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_category` (`category_id`),
  KEY `idx_active_sort` (`is_active`, `sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本主表';
```

### 2.3 绘本页面表 `picture_book_pages`

每个绘本有多页，每页一张图 + 一段英文文本 + 中文翻译 + 整句音频。

```sql
CREATE TABLE `picture_book_pages` (
  `id` int NOT NULL AUTO_INCREMENT,
  `book_id` int NOT NULL COMMENT '绘本ID',
  `page_number` int NOT NULL COMMENT '页码（从1开始）',
  `image_url` varchar(500) DEFAULT NULL COMMENT '页面插图URL',
  `text_en` text DEFAULT NULL COMMENT '英文文本（该页故事内容）',
  `text_cn` text DEFAULT NULL COMMENT '中文翻译',
  `audio_url` varchar(500) DEFAULT NULL COMMENT '整段朗读音频（女声）',
  `audio_url_male` varchar(500) DEFAULT NULL COMMENT '整段朗读音频（男声）',
  `sort_order` int DEFAULT 0 COMMENT '排序（= page_number）',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_book_page` (`book_id`, `page_number`),
  CONSTRAINT `fk_page_book` FOREIGN KEY (`book_id`) REFERENCES `picture_books`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本页面表';
```

### 2.4 页面点读热点表 `picture_book_hotspots`

每页上可点击的单词/短语，有位置信息和独立音频。

```sql
CREATE TABLE `picture_book_hotspots` (
  `id` int NOT NULL AUTO_INCREMENT,
  `page_id` int NOT NULL COMMENT '页面ID',
  `book_id` int NOT NULL COMMENT '绘本ID（冗余，方便查询）',
  `text_en` varchar(500) NOT NULL COMMENT '英文文本',
  `translation` varchar(500) DEFAULT NULL COMMENT '中文翻译',
  `phonetic` varchar(200) DEFAULT NULL COMMENT '音标',
  `position_x` decimal(6,2) DEFAULT NULL COMMENT '热点X位置（%）',
  `position_y` decimal(6,2) DEFAULT NULL COMMENT '热点Y位置（%）',
  `width` decimal(6,2) DEFAULT NULL COMMENT '热点宽度（%）',
  `height` decimal(6,2) DEFAULT NULL COMMENT '热点高度（%）',
  `audio_url_female` varchar(500) DEFAULT NULL COMMENT '女声音频',
  `audio_url_male` varchar(500) DEFAULT NULL COMMENT '男声音频',
  `word_id` int DEFAULT NULL COMMENT '关联单词ID（可选）',
  `sort_order` int DEFAULT 0 COMMENT '排序',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_page` (`page_id`),
  KEY `idx_book` (`book_id`),
  CONSTRAINT `fk_hotspot_page` FOREIGN KEY (`page_id`) REFERENCES `picture_book_pages`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='绘本页面点读热点';
```

### 2.5 用户阅读进度表 `picture_book_progress`

```sql
CREATE TABLE `picture_book_progress` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `book_id` int NOT NULL,
  `current_page` int DEFAULT 1 COMMENT '当前阅读到第几页',
  `is_completed` tinyint(1) DEFAULT 0 COMMENT '是否读完',
  `read_count` int DEFAULT 1 COMMENT '阅读次数',
  `last_read_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_user_book` (`user_id`, `book_id`),
  CONSTRAINT `fk_progress_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_progress_book` FOREIGN KEY (`book_id`) REFERENCES `picture_books`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户绘本阅读进度';
```

### ER 关系

```
picture_book_categories (1) ──→ (N) picture_books
picture_books (1) ──→ (N) picture_book_pages
picture_book_pages (1) ──→ (N) picture_book_hotspots
picture_books (1) ──→ (N) picture_book_progress ←── (N) users
```

---

## 三、后台管理设计

### 3.1 页面结构

```
/picture-books/categories    → 绘本分类管理（CRUD）
/picture-books               → 绘本列表（搜索、筛选、上下架）
/picture-books/edit           → 新建绘本
/picture-books/edit/:id       → 编辑绘本（含页面管理）
```

### 3.2 绘本编辑页核心交互

**三栏布局（参考 scenes/edit）：**

| 左栏 | 中栏 | 右栏 |
|------|------|------|
| 绘本基本信息 | 页面预览+编辑 | 页面列表+热点列表 |
| 标题/分类/难度/封面 | 当前页图片+热点标注 | 拖拽排序页面 |
| 保存按钮 | 文本编辑区 | 批量生成音频按钮 |

**关键功能：**
- 页面管理：添加页面、拖拽排序、删除页面
- 每页编辑：上传插图、编辑英文文本和中文翻译
- 热点标注：在图片上框选可点击区域（复用 scenes/edit 的热点编辑逻辑）
- OCR 辅助：对插图做 OCR 自动识别英文文本及位置
- TTS 生成：批量为页面文本和热点生成男/女声音频
- AI 辅助：根据故事主题 AI 生成每页英文文本和中文翻译

---

## 四、微信小程序设计

### 4.1 页面路由（复用 photo-read 路径）

```
pages/photo-read/index       → 绘本书架（浏览、筛选）
pages/photo-read/detail/detail → 绘本阅读器（翻页阅读）
pages/photo-read/edit/edit    → 保留：用户拍摄点读（原功能不删）
```

> 注意：保留 photo-read/edit 路径给用户 UGC 拍摄点读功能，
> index 和 detail 改为绘本故事展示。

### 4.2 绘本书架页 (index)

**布局：**
```
┌─────────────────────────┐
│  绘本故事                │ ← 页面标题
├─────────────────────────┤
│ [全部] [启蒙] [童话] ... │ ← 分类 tab 横向滚动
├─────────────────────────┤
│ ┌──────┐  ┌──────┐      │
│ │ 封面 │  │ 封面 │      │ ← 双列网格
│ │      │  │      │      │
│ ├──────┤  ├──────┤      │
│ │标题  │  │标题  │      │
│ │难度⭐│  │难度⭐│      │
│ │进度条│  │进度条│      │ ← 已读进度
│ └──────┘  └──────┘      │
│ ┌──────┐  ┌──────┐      │
│ │ ...  │  │ ...  │      │
└─────────────────────────┘
```

**功能要点：**
- 分类横向滚动 tab
- 封面卡片展示：封面图、标题、难度星标、页数
- 用户阅读进度条（已读 N/M 页）
- 已读完标记 ✓
- 下拉刷新 + 上拉加载更多

### 4.3 绘本阅读器 (detail) — 核心页面

**翻书体验：**
```
┌─────────────────────────────┐
│ ← 返回    The Big Red Dog  │ ← 导航栏
├─────────────────────────────┤
│                             │
│    ┌───────────────────┐    │
│    │                   │    │
│    │   页面插图         │    │ ← swiper 左右滑动翻页
│    │   (可点击热点)     │    │
│    │                   │    │
│    └───────────────────┘    │
│                             │
│  "The big red dog ran       │ ← 英文文本（可点击单词高亮）
│   across the green field."  │
│                             │
│  大红狗跑过了绿色的田野。    │ ← 中文翻译（可折叠）
│                             │
├─────────────────────────────┤
│  🔊 朗读  │  🎤 跟读  │ 3/12 │ ← 底部操作栏
└─────────────────────────────┘
```

**交互设计：**

1. **翻页** — `<swiper>` 组件实现左右滑动，带翻页动画
2. **点读图片热点** — 点击图片上标注区域，弹出单词卡片（发音+翻译+音标）
3. **点读文本** — 点击英文文本中的单词，高亮+发音+显示翻译
4. **整句朗读** — 点击 🔊 按钮播放当前页整句音频
5. **跟读评测** — 点击 🎤 按钮进入评测模式，录音后打分
6. **翻译切换** — 中文翻译默认显示，可收起
7. **进度保存** — 翻页时自动保存阅读进度
8. **页码显示** — 底部显示当前页/总页数

**评测弹窗** — 复用 checkin 风格底部面板（分数+明细+重试）

---

## 五、API 设计

### 5.1 公共 API（小程序端）

```
GET    /api/picture-books/categories          → 分类列表
GET    /api/picture-books                     → 绘本列表（分页+分类筛选+难度筛选）
GET    /api/picture-books/:id                 → 绘本详情（含所有页面+热点）
POST   /api/picture-books/:id/progress        → 保存阅读进度 { current_page }
GET    /api/picture-books/my-progress          → 我的阅读进度（批量）
```

### 5.2 管理 API（后台）

```
# 分类
GET    /api/admin/picture-book-categories       → 分类列表
POST   /api/admin/picture-book-categories       → 新建分类
PUT    /api/admin/picture-book-categories/:id    → 编辑分类
DELETE /api/admin/picture-book-categories/:id    → 删除分类

# 绘本
GET    /api/admin/picture-books                 → 绘本列表
POST   /api/admin/picture-books                 → 新建绘本
PUT    /api/admin/picture-books/:id             → 编辑绘本基本信息
DELETE /api/admin/picture-books/:id             → 删除绘本

# 页面
GET    /api/admin/picture-books/:id/pages       → 页面列表
POST   /api/admin/picture-books/:id/pages       → 添加页面
PUT    /api/admin/picture-book-pages/:pageId     → 编辑页面
DELETE /api/admin/picture-book-pages/:pageId     → 删除页面
POST   /api/admin/picture-book-pages/reorder     → 批量排序

# 热点
POST   /api/admin/picture-book-pages/:pageId/hotspots      → 添加热点
PUT    /api/admin/picture-book-hotspots/:id                → 编辑热点
DELETE /api/admin/picture-book-hotspots/:id                → 删除热点

# 批量操作
POST   /api/admin/picture-books/:id/generate-tts           → 批量生成音频
POST   /api/admin/picture-book-pages/:pageId/ocr           → OCR 识别页面
POST   /api/admin/picture-books/:id/ai-generate            → AI 生成故事文本

# 上传
POST   /api/admin/picture-books/upload                     → 上传图片
```

---

## 六、实施计划

### Phase 1: 数据基础 + 后台管理（优先）

1. 创建数据库表（5张表）
2. 后台分类管理页（参考 scenes/categories）
3. 后台绘本列表页（参考 scenes/index）
4. 后台绘本编辑页（三栏布局：基本信息 + 页面预览 + 页面列表）
5. 页面 CRUD + 图片上传
6. 热点标注（复用 scenes/edit 的热点编辑逻辑）
7. 批量 TTS 生成

### Phase 2: 小程序阅读体验

1. 改造 photo-read/index → 绘本书架页
2. 改造 photo-read/detail → 绘本阅读器
   - swiper 翻页
   - 图片热点点读
   - 文本点读
   - 整句朗读
3. 阅读进度保存
4. 跟读评测（复用 /voice/assess）

### Phase 3: 增强功能

1. AI 辅助生成故事内容
2. AI 生成配图
3. 阅读统计与成就
4. 评测历史接入评测中心（source = 'picture_book'）

---

## 七、关键技术决策

1. **复用 photo-read 路径** — 避免修改 app.json 页面注册（小程序审核友好），edit 页面保留给用户 UGC
2. **页面数据一次性加载** — 绘本详情接口返回所有页面+热点，前端 swiper 翻页无需额外请求
3. **热点编辑复用** — 后台热点标注逻辑复用 scenes/edit 的 canvas overlay + percentage 坐标方案
4. **音频生成策略** — 优先匹配 words 表已有音频，不存在则调用 TTS 生成（同 photo-read 策略）
5. **翻页组件** — 使用 `<swiper>` + `current` 属性实现，通过 `bindchange` 事件保存进度
