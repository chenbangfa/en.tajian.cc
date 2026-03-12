# 英语启蒙第一册：课程设计方案

> 面向中国零基础小朋友（5–8岁），参考剑桥少儿英语、人教版小学英语、Oxford Primary、
> 迪士尼英语、VIPKid、Magic Ears、Duolingo Kids 等国内外主流体系综合设计。

---

## 一、参考体系与核心理念

### 参考的主流课程体系

| 体系 | 核心特点 | 我们借鉴的点 |
|------|----------|-------------|
| 剑桥少儿英语 YLE Starters | 主题词汇 + 场景对话，约 300 核心词 | 主题分类方式、词汇频率选择 |
| 人教版小学英语（PEP）| 螺旋递进，生活化场景，图文结合 | 单元主题序列、句型设计 |
| Oxford Primary English | Phonics 音素意识先行，自然拼读贯穿 | Phonics 优先理念 |
| 迪士尼英语 | 情境沉浸，情感联结强 | 每词配图配音，趣味记忆 |
| VIPKid Level 1–2 | 互动性强，TPR 肢体反应教学 | 简短句型 + 肢体动作联结 |
| Duolingo Kids | 碎片化、游戏化，及时反馈 | 每课词量不超过 10 个 |
| 洪恩 GOGO 学英语 | 中国孩子视角，文化对照 | 中文注解方式、文化桥接 |

### 设计三原则

1. **主题化**：每个章节围绕一个生活主题，词汇有场景依托而非孤立记忆
2. **螺旋递进**：难度缓坡上升，前章词汇在后章例句中复现，强化记忆
3. **可发音优先**：入门阶段选择拼读规律强（CVC 结构）的单词，降低开口门槛

---

## 二、关于章节结构的建议

### 当前结构（扁平）

```
课程
└── 单词 A
└── 单词 B
└── 单词 C
    ... (100+ 个，无分层)
```

**问题：**
- 学习者看不到学习进度节奏，缺乏阶段成就感
- 管理员添加/排序 100+ 条目时操作繁琐
- 无法按章节安排「周计划」或「阶段测试」

### 建议结构（加章节）

```
课程
└── 第 1 章：Hello World（问候篇）
│   ├── 单词 1: hello
│   ├── 单词 2: hi
│   └── ...（8–12 个词）
└── 第 2 章：Numbers（数字篇）
│   └── ...
└── 第 3 章：Colors（颜色篇）
    └── ...
```

**需要的数据库变更：**

```sql
-- 新增章节表
CREATE TABLE checkin_course_chapters (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  course_id   INT NOT NULL,
  name        VARCHAR(120) NOT NULL COMMENT '章节名称，如 Unit 1: Hello World',
  name_en     VARCHAR(120) DEFAULT NULL COMMENT '英文名称',
  description VARCHAR(300) DEFAULT NULL,
  sort_order  INT DEFAULT 0,
  is_active   TINYINT(1) DEFAULT 1,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (course_id) REFERENCES checkin_courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- checkin_course_items 加 chapter_id（可空，兼容旧数据）
ALTER TABLE checkin_course_items
  ADD COLUMN chapter_id INT DEFAULT NULL AFTER course_id,
  ADD CONSTRAINT fk_item_chapter FOREIGN KEY (chapter_id)
    REFERENCES checkin_course_chapters(id) ON DELETE SET NULL;
```

> **向后兼容**：`chapter_id` 可空，现有课程数据无需迁移，新课程可选择是否使用章节。

---

## 三、第一册课程总览

**课程名称：** 英语启蒙·第一册 My English World
**适用年龄：** 5–8 岁
**学习基础：** 完全零基础
**总词量：** 120 个核心词
**章节数：** 10 章
**每章词量：** 10–14 词
**预计完课时间：** 约 60–90 天（每日 10 词目标，复习周期内）

### 章节序列设计逻辑

```
第1章 问候 → 第2章 数字 → 第3章 颜色 → 第4章 动物
    ↓ 词汇在例句中复现 ↓
第5章 身体 → 第6章 家庭 → 第7章 食物 → 第8章 学校
    ↓ 词汇在例句中复现 ↓
第9章 形状 → 第10章 天气
```

**选词原则：**
- 优先选自然拼读规律强的词（cat/dog/red/big）
- 参考 Dolch Word List 和 Fry 高频词
- 对照剑桥 YLE Starters 词表
- 每词配一个简单例句（5 词以内），便于评测跟读

---

## 四、详细课程大纲

---

### 第 1 章 · Hello World — 问候与自我介绍

**学习目标：** 会用英语打招呼、介绍自己名字、说再见
**核心句型：** Hello! / Hi! / I'm ___ . / Goodbye! / Good morning/afternoon/night.

| # | 单词 | 词性 | 中文 | 例句 | 拼读特点 |
|---|------|------|------|------|---------|
| 1 | hello | int. | 你好 | Hello! I'm Mia. | 高频见面词 |
| 2 | hi | int. | 嗨 | Hi! Are you Tom? | 最短问候 |
| 3 | bye | int. | 再见 | Bye! See you! | CVC |
| 4 | yes | adv. | 是的 | Yes, I am. | CVC |
| 5 | no | adv. | 不是 | No, I'm not. | 高频 |
| 6 | name | n. | 名字 | My name is Lily. | 元音 a\_e |
| 7 | I | pron. | 我 | I like cats. | 字母词 |
| 8 | my | pron. | 我的 | My bag is red. | 高频代词 |
| 9 | you | pron. | 你 | Are you happy? | 高频代词 |
| 10 | am | v. | 是（be动词）| I am a student. | be动词入门 |
| 11 | good | adj. | 好的 | Good morning! | 形容词 |
| 12 | morning | n. | 早晨 | Good morning, Dad. | 时间词 |

---

### 第 2 章 · Numbers — 数字 1–20

**学习目标：** 认读并说出 1–20，会用数字表达年龄
**核心句型：** I'm ___ years old. / I have ___ ___ s.

| # | 单词 | 词性 | 中文 | 例句 |
|---|------|------|------|------|
| 1 | one | num. | 一 | I have one cat. |
| 2 | two | num. | 二 | Two birds fly. |
| 3 | three | num. | 三 | I have three fish. |
| 4 | four | num. | 四 | Four dogs run. |
| 5 | five | num. | 五 | I am five. |
| 6 | six | num. | 六 | Six red apples. |
| 7 | seven | num. | 七 | Seven days a week. |
| 8 | eight | num. | 八 | Eight legs on a spider. |
| 9 | nine | num. | 九 | Nine yellow stars. |
| 10 | ten | num. | 十 | I have ten fingers. |
| 11 | eleven | num. | 十一 | Eleven players on a team. |
| 12 | twelve | num. | 十二 | Twelve months a year. |
| 13 | thirteen | num. | 十三 | She is thirteen. |
| 14 | twenty | num. | 二十 | I count to twenty. |

---

### 第 3 章 · Colors — 颜色

**学习目标：** 认识 10 种基本颜色，会用颜色描述物品
**核心句型：** It's ___ . / The ___ is ___ . / I like ___ .

| # | 单词 | 词性 | 中文 | 例句 | 拼读特点 |
|---|------|------|------|------|---------|
| 1 | red | adj. | 红色 | The apple is red. | CVC |
| 2 | blue | adj. | 蓝色 | The sky is blue. | 元音 ue |
| 3 | yellow | adj. | 黄色 | The sun is yellow. | 双l |
| 4 | green | adj. | 绿色 | The leaf is green. | ee |
| 5 | orange | adj. | 橙色 | I like orange. | 水果同名 |
| 6 | pink | adj. | 粉色 | She has a pink bag. | ink 韵脚 |
| 7 | purple | adj. | 紫色 | The flower is purple. | |
| 8 | white | adj. | 白色 | The snow is white. | wh |
| 9 | black | adj. | 黑色 | The cat is black. | ack 韵脚 |
| 10 | brown | adj. | 棕色 | The bear is brown. | ow |
| 11 | color | n. | 颜色 | What color is this? | 核心名词 |

---

### 第 4 章 · Animals — 动物

**学习目标：** 认识 12 种常见动物，会描述动物特征
**核心句型：** I see a ___ . / The ___ is ___ . / I like ___ s.

| # | 单词 | 词性 | 中文 | 例句 | 拼读特点 |
|---|------|------|------|------|---------|
| 1 | cat | n. | 猫 | The cat is black. | CVC 经典 |
| 2 | dog | n. | 狗 | My dog is big. | CVC |
| 3 | bird | n. | 鸟 | The bird can fly. | ir |
| 4 | fish | n. | 鱼 | I have two fish. | sh |
| 5 | duck | n. | 鸭子 | The duck is yellow. | uck 韵脚 |
| 6 | frog | n. | 青蛙 | The frog is green. | 辅音丛 fr |
| 7 | lion | n. | 狮子 | The lion is big. | |
| 8 | bear | n. | 熊 | The bear is brown. | ear |
| 9 | rabbit | n. | 兔子 | The rabbit is white. | 双b |
| 10 | monkey | n. | 猴子 | The monkey can jump. | ey |
| 11 | elephant | n. | 大象 | The elephant is gray. | 多音节 |
| 12 | panda | n. | 熊猫 | The panda is cute. | 文化词 |

---

### 第 5 章 · Body Parts — 身体部位

**学习目标：** 认识身体各部位，会用 I have / Touch your ___ 表达
**核心句型：** Touch your ___ . / I have two ___ s. / My ___ is ___ .

| # | 单词 | 词性 | 中文 | 例句 |
|---|------|------|------|------|
| 1 | head | n. | 头 | Touch your head! |
| 2 | eye | n. | 眼睛 | I have two eyes. |
| 3 | nose | n. | 鼻子 | My nose is small. |
| 4 | mouth | n. | 嘴巴 | Open your mouth. |
| 5 | ear | n. | 耳朵 | I have two ears. |
| 6 | hand | n. | 手 | My hands are clean. |
| 7 | foot | n. | 脚 | I have two feet. |
| 8 | leg | n. | 腿 | The dog has four legs. |
| 9 | arm | n. | 手臂 | Raise your arms! |
| 10 | hair | n. | 头发 | Her hair is black. |
| 11 | face | n. | 脸 | I wash my face. |
| 12 | tooth | n. | 牙齿 | Brush your teeth! |

---

### 第 6 章 · Family — 家庭成员

**学习目标：** 认识家庭成员称谓，会介绍自己的家庭
**核心句型：** This is my ___ . / I love my ___ . / My ___ is kind.

| # | 单词 | 词性 | 中文 | 例句 |
|---|------|------|------|------|
| 1 | mom | n. | 妈妈 | I love my mom. |
| 2 | dad | n. | 爸爸 | My dad is tall. |
| 3 | baby | n. | 宝宝 | The baby is cute. |
| 4 | sister | n. | 姐妹 | My sister is kind. |
| 5 | brother | n. | 兄弟 | My brother is funny. |
| 6 | grandma | n. | 奶奶/外婆 | Grandma makes soup. |
| 7 | grandpa | n. | 爷爷/外公 | Grandpa tells stories. |
| 8 | family | n. | 家庭 | I love my family. |
| 9 | home | n. | 家 | I am at home. |
| 10 | love | v./n. | 爱 | I love you, Mom. |

---

### 第 7 章 · Food & Drinks — 食物与饮料

**学习目标：** 认识常见食物饮料，会表达喜好和需要
**核心句型：** I like ___ . / I don't like ___ . / I want ___ , please.

| # | 单词 | 词性 | 中文 | 例句 |
|---|------|------|------|------|
| 1 | apple | n. | 苹果 | I like apples. |
| 2 | banana | n. | 香蕉 | The banana is yellow. |
| 3 | orange | n. | 橙子 | I want an orange. |
| 4 | rice | n. | 米饭 | I eat rice every day. |
| 5 | bread | n. | 面包 | I want bread, please. |
| 6 | egg | n. | 鸡蛋 | I eat one egg. |
| 7 | milk | n. | 牛奶 | I drink milk. |
| 8 | water | n. | 水 | Drink more water! |
| 9 | cake | n. | 蛋糕 | I like cake. |
| 10 | cookie | n. | 饼干 | Can I have a cookie? |
| 11 | juice | n. | 果汁 | I want orange juice. |
| 12 | soup | n. | 汤 | The soup is hot. |

---

### 第 8 章 · School & Classroom — 学校与教室

**学习目标：** 认识学校场景词汇，会简单描述学校生活
**核心句型：** Open your book. / This is a ___ . / I go to school.

| # | 单词 | 词性 | 中文 | 例句 |
|---|------|------|------|------|
| 1 | school | n. | 学校 | I go to school. |
| 2 | class | n. | 班级/课 | I like English class. |
| 3 | teacher | n. | 老师 | My teacher is nice. |
| 4 | student | n. | 学生 | I am a student. |
| 5 | book | n. | 书 | Open your book! |
| 6 | pen | n. | 笔 | I have a red pen. |
| 7 | pencil | n. | 铅笔 | Use a pencil. |
| 8 | bag | n. | 书包 | My bag is heavy. |
| 9 | desk | n. | 桌子 | Sit at your desk. |
| 10 | chair | n. | 椅子 | Sit on the chair. |
| 11 | friend | n. | 朋友 | She is my friend. |
| 12 | play | v. | 玩/游戏 | Let's play together. |

---

### 第 9 章 · Shapes — 形状

**学习目标：** 认识基本形状，会描述物品形状
**核心句型：** It's a ___ . / I see a ___ . / The ___ is ___ shaped.

| # | 单词 | 词性 | 中文 | 例句 |
|---|------|------|------|------|
| 1 | circle | n. | 圆形 | The sun is a circle. |
| 2 | square | n. | 正方形 | The window is a square. |
| 3 | triangle | n. | 三角形 | A pizza slice is a triangle. |
| 4 | rectangle | n. | 长方形 | The door is a rectangle. |
| 5 | star | n. | 星形 | I drew a star. |
| 6 | heart | n. | 心形 | I made a heart. |
| 7 | big | adj. | 大的 | The elephant is big. |
| 8 | small | adj. | 小的 | The mouse is small. |
| 9 | long | adj. | 长的 | The snake is long. |
| 10 | round | adj. | 圆的 | The ball is round. |

---

### 第 10 章 · Weather & Seasons — 天气与季节

**学习目标：** 认识天气和四季，会描述当天天气
**核心句型：** It's ___ today. / I like ___ . / In summer, it's hot.

| # | 单词 | 词性 | 中文 | 例句 |
|---|------|------|------|------|
| 1 | sun | n. | 太阳 | The sun is bright. |
| 2 | sunny | adj. | 晴天的 | It's sunny today. |
| 3 | rain | n./v. | 雨/下雨 | I like rain. |
| 4 | rainy | adj. | 下雨的 | It's rainy today. |
| 5 | wind | n. | 风 | The wind is strong. |
| 6 | snow | n./v. | 雪/下雪 | I love snow! |
| 7 | hot | adj. | 热的 | It's hot in summer. |
| 8 | cold | adj. | 冷的 | It's cold in winter. |
| 9 | spring | n. | 春天 | Spring is warm. |
| 10 | summer | n. | 夏天 | I swim in summer. |
| 11 | autumn | n. | 秋天 | Leaves fall in autumn. |
| 12 | winter | n. | 冬天 | It snows in winter. |

---

## 五、词汇统计

| 章节 | 主题 | 词量 |
|------|------|------|
| 第 1 章 | 问候 Hello World | 12 |
| 第 2 章 | 数字 Numbers | 14 |
| 第 3 章 | 颜色 Colors | 11 |
| 第 4 章 | 动物 Animals | 12 |
| 第 5 章 | 身体 Body Parts | 12 |
| 第 6 章 | 家庭 Family | 10 |
| 第 7 章 | 食物 Food & Drinks | 12 |
| 第 8 章 | 学校 School | 12 |
| 第 9 章 | 形状 Shapes | 10 |
| 第 10 章 | 天气 Weather | 12 |
| **合计** | | **117 词** |

---

## 六、跨章节复现设计（螺旋记忆）

好的课程设计不是词汇孤立出现一次就过，而是让前面学过的词在后面的例句中自然复现：

| 后章使用前章词的例子 |
|---|
| 第 4 章例句「The cat is **black**」复现第 3 章颜色 black |
| 第 5 章例句「My **hands** are **clean**」为第 8 章 clean 铺垫 |
| 第 6 章例句「My dad is **tall**」复现形容词概念 |
| 第 7 章例句「The banana is **yellow**」复现第 3 章颜色 yellow |
| 第 10 章例句「I **swim** in summer」为后续动词学习铺垫 |

---

## 七、第二册方向（预告）

完成第一册后，第二册（中阶启蒙）可以覆盖：

- 动作动词 20+（run / jump / eat / sleep / sing...）
- 常用形容词扩展（happy / sad / big / small / fast / slow...）
- 时间词（today / yesterday / tomorrow / morning / night...）
- 简单句型（Can you ___? / Do you like ___? / Where is ___?）
- 字母拼读进阶（Phonics A–Z 自然拼读系统）

---

## 八、实施建议

### 打卡课程里的配置建议

- **每日目标**：10 词（一章约 1–2 天完成）
- **及格分数**：建议 60 分起步（针对孩子，鼓励为主）
- **进度展示**：学完一章时有章节通关反馈

### 内容录入优先级

1. 先录入第 1–4 章（Hello / Numbers / Colors / Animals）作为内测版
2. 每个单词需要：配图 + 女声/男声音频 + 例句
3. 例句建议重新录制儿童发音版本（标准美式，语速较慢）

### 评测适配建议

现有打卡评测是针对**单词发音**的，对小朋友这个设置是合适的。后续可以考虑：
- 难度降低版：只评测单个音节 / 分数放宽
- 鼓励模式：低于及格分时给鼓励语而非"未通过"的红色标签

---

*本文档版本：v1.0 · 2026-03-12*
*设计参考：Cambridge YLE Starters Wordlist · Fry High-Frequency Words · 人教版 PEP 小学英语 1–2 册 · Oxford Primary English*
