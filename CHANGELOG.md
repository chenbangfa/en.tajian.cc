# Changelog

记录每次功能修改，方便日后查阅和维护。

---

## 2026-03-12

### feat: 打卡评测弹窗新增"我的发音"播放 + 关闭按钮，修复录音混音 bug，打通录音存储链路

**涉及文件：**
- `weichat/pages/checkin/checkin.js`（前端，本地）
- `weichat/pages/checkin/checkin.wxml`（前端，本地）
- `weichat/pages/checkin/checkin.wxss`（前端，本地）
- `server/src/routes/checkin.js`（后端）

**改动说明：**

#### 1. Bug 修复：录音时停止所有音频播放
- **问题**：用户点击单词发音播放后再点击"开始录音"，播放的声音会混入录音，导致评测的是单词音频而非用户发音。
- **修复**：`_startRecord()` 开头加入 `_stopAudio()` + `_stopUserAudio()`，录音前强制停止所有音频。

#### 2. 新增：评分弹窗关闭按钮（✕）
- **问题**：评分弹窗只有"重新评测"和"下一个"，用户无法直接关闭。
- **修复**：弹窗左上角加 `✕` 关闭按钮，绑定 `closeAssessPanel()`，点击后关闭弹窗并停止用户录音回放。

#### 3. 新增：评分弹窗"我的发音"播放按钮
- 评测完成后，弹窗大分数下方显示"🔊 我的发音"胶囊按钮。
- 点击播放用户本次录音（本地临时文件），再次点击停止；播放中按钮变绿显示"播放中..."。
- 播放用户录音时自动停止单词参考音频，互斥播放。
- 新增实例变量 `_lastRecordingPath`、`_userAudioCtx`，状态变量 `isPlayingUserAudio`。

#### 4. 修复：用户录音未保存到打卡记录（关键链路修复）
- **问题**：`daily_task_items.audio_url` 一直为 NULL，导致打卡记录/分享中无法播放用户的录音。
- **根因**：`/voice/assess` 已将录音上传至 COS 并写入 `voice_assessments.audio_url`，但 `/checkin/v2/done` 从未将 `audio_url` 回写到 `daily_task_items`。
- **修复**：
  - 前端 `_markWordDone(word, assessmentId)` 接收 `assessment_id` 并传给 `/checkin/v2/done`
  - 后端 `v2/done` 收到 `assessment_id` 后查询 `voice_assessments`，将 `audio_url`、`score`、`pronunciation_score`、`fluency_score`、`integrity_score` 一并写入 `daily_task_items`
- **无需改数据库**：`daily_task_items` 表的 `audio_url`、`assessment_id`、各评分字段早已存在。

**完整数据流（修复后）：**
```
用户录音
  → POST /voice/assess（上传录音）
  → 录音存 COS → 写 voice_assessments（含 audio_url）→ 返回 assessment_id
  → 前端拿到 assessment_id
  → POST /checkin/v2/done（传 item_id + assessment_id）
  → 后端查 voice_assessments → 回写 daily_task_items（audio_url + 评分）
  → 打卡记录 / 分享页读 daily_task_items.audio_url → 有值 ✓
```

---

## 2026-03-12（补充）

### fix: 服务器实测确认 voice/history、voice/calendar、users/points 500 修复完成

服务端 SSH 实测三个接口均返回 200 OK。根本原因已确认（服务器 error log）：

```
Error: Incorrect arguments to mysqld_stmt_execute
errno: 1210, sqlState: 'HY000'
sql: SELECT * FROM points_logs WHERE user_id = ? ORDER BY ... LIMIT ? OFFSET ?
```

`mysql2` 的 `pool.execute()`（Prepared Statement）在 MySQL 8.4 中传递整数型 LIMIT/OFFSET 参数时
触发协议错误，改用 `pool.query()`（客户端转义）后完全消除。

---

## 2026-02-08

### feat: add passing_score to v2 checkin API
- v2 状态接口返回 `passingScore`，前端可根据用户设置的及格分数判断是否通过。

### feat: add simplified v2 check-in API (course-based word learning)
- 新增 `/checkin/v2/*` 系列接口，基于课程的单词打卡流程。
- 接口包括：`/v2/status`、`/v2/courses`、`/v2/enroll`、`/v2/today`、`/v2/done`、`/v2/settings`。
- 前端打卡页面 `pages/checkin/checkin` 完整重构，支持课程选择、连续打卡天数、进度追踪。

---

## 2025-xx-xx（历史）

### fix: WAV 格式音频无法在微信真机播放
- 录音格式改为 WAV 16000Hz 单声道，兼容微信真机环境。

### feat: 图片压缩 - 新图自动压缩 + 批量脚本
- 上传图片时自动压缩，新增批量压缩脚本。

### fix: 评测失败改为返回错误提示，去掉随机分兜底
- 语音评测失败时返回明确错误，不再用随机分数作为兜底。

### feat: 支持有道口语评测，新增 ASSESS_ENGINE 环境变量
- 通过环境变量 `ASSESS_ENGINE` 切换腾讯云 / 有道评测引擎。
