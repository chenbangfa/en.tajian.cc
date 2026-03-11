// pages/checkin/checkin.js
const api = require('../../services/api');
const app = getApp();
const recorderManager = wx.getRecorderManager();

const MODE_TEXT = { easy: '☕ 轻松', standard: '📚 标准', challenge: '🔥 挑战' };
const STRATEGY_TEXT = { random: '随机练习', curriculum: '课程学习' };

Page({
  data: {
    // 计划
    plan: {},
    wordTasks: [],
    sceneTasks: [],
    podcastTasks: [],
    // 进度
    streakDays: 0,
    multiplier: 1,
    currentMode: 'standard',
    modeText: '📚 标准',
    completedCount: 0,
    totalCount: 0,
    progressPercent: 0,
    wordDone: false,
    sceneDone: false,
    podcastDone: false,
    allComplete: false,
    // 任务执行
    activeTask: null,
    isRecording: false,
    isAssessing: false,
    recordTime: 0,
    // 结果弹窗
    showResult: false,
    resultData: {},
    newAchievements: [],
    // 模式弹窗
    showModeModal: false,
    // 学习路径（阶段2）
    showPathModal: false,
    checkinStrategy: 'random',
    strategyText: '随机练习',
    pathSummary: '随机练习',
    curriculumCourses: [],
    currentCourseId: null,
    currentCourseName: '',
    learningLevel: 1,
    // 弹窗暂存
    pathStrategyDraft: 'random',
    pathCourseIdDraft: null,
    pathLevelDraft: 1,
    // 分享
    shareId: '',
    showPoster: false,
    recordPlayingId: -1
  },

  _audioCtx: null,
  _recordTimer: null,
  _submittingTask: false,

  onLoad() {
    this._bindRecorder();
    this.loadCurriculumConfig();
    this.loadPlan();
  },

  onUnload() {
    this._destroyAudio();
    clearInterval(this._recordTimer);
  },

  onShow() {
    // 从其他页面（如 detail）返回时，重新绑定录音回调
    this._bindRecorder();
    if (this._loaded) {
      this.loadCurriculumConfig();
      this.loadPlan();
    }
    this._loaded = true;
  },

  _bindRecorder() {
    if (typeof recorderManager.offStop === 'function') recorderManager.offStop();
    if (typeof recorderManager.offError === 'function') recorderManager.offError();
    recorderManager.onStop((res) => {
      if (this._stopped) return;
      this._submitTask(res.tempFilePath);
    });
    recorderManager.onError(() => {
      this.setData({ isRecording: false, isAssessing: false, recordTime: 0 });
      clearInterval(this._recordTimer);
      wx.showToast({ title: '录音失败', icon: 'none' });
    });
  },

  // ===== 数据加载 =====

  async loadPlan() {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await api.get('/checkin/plan');
      if (res.success) {
        const { plan, items } = res.data;
        this._updatePlanState(plan, items);
      }
    } catch (e) {
      console.error('加载计划失败:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async loadCurriculumConfig() {
    try {
      const res = await api.get('/checkin/curriculum');
      if (!res.success) return;
      const data = res.data || {};
      const courses = data.courses || [];
      const currentCourseId = data.current_course_id || null;
      const matched = courses.find(c => String(c.id) === String(currentCourseId));
      const strategy = data.strategy || 'random';

      this.setData({
        checkinStrategy: strategy,
        strategyText: STRATEGY_TEXT[strategy] || STRATEGY_TEXT.random,
        pathSummary: strategy === 'curriculum' && matched ? `${STRATEGY_TEXT.curriculum} · ${matched.name}` : (STRATEGY_TEXT[strategy] || STRATEGY_TEXT.random),
        curriculumCourses: courses,
        currentCourseId,
        currentCourseName: matched ? matched.name : '',
        learningLevel: Number(data.learning_level || 1)
      });
    } catch (e) {
      console.error('加载课程配置失败:', e);
    }
  },

  _updatePlanState(plan, items) {
    // 补全所有资源的 https URL
    const baseUrl = (app.globalData.baseUrl || '').replace(/\/api$/, '');
    items.forEach(item => {
      const info = item.extra_info || {};
      const urlKeys = ['image_url', 'audio_female', 'audio_male', 'audio_url_female', 'audio_url_male',
                        'scene_image', 'male_audio_url', 'female_audio_url', 'chinese_audio_url',
                        'example_audio_female', 'example_audio_male'];
      urlKeys.forEach(key => {
        if (info[key] && typeof info[key] === 'string' && info[key].startsWith('/')) {
          info[key] = baseUrl + info[key];
        }
      });
      item.extra_info = info;
      // 补全用户录音 URL
      if (item.audio_url && typeof item.audio_url === 'string' && item.audio_url.startsWith('/')) {
        item.audio_url = baseUrl + item.audio_url;
      }
    });

    const wordTasks = items.filter(i => i.task_type === 'word');
    const sceneTasks = items.filter(i => i.task_type === 'scene');
    const podcastTasks = items.filter(i => i.task_type === 'podcast');

    const completed = items.filter(i => i.status === 'completed').length;
    const total = items.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    const wordDone = (plan.word_target || 0) === 0 || (plan.word_completed || 0) >= (plan.word_target || 0);
    const sceneDone = (plan.scene_target || 0) === 0 || (plan.scene_completed || 0) >= (plan.scene_target || 0);
    const podcastDone = (plan.podcast_target || 0) === 0 || (plan.podcast_completed || 0) >= (plan.podcast_target || 0);

    this.setData({
      plan,
      wordTasks,
      sceneTasks,
      podcastTasks,
      streakDays: plan.streak_days || 0,
      multiplier: plan.streak_multiplier || 1,
      currentMode: plan.mode || 'standard',
      modeText: MODE_TEXT[plan.mode] || '📚 标准',
      completedCount: completed,
      totalCount: total,
      progressPercent: percent,
      wordDone,
      sceneDone,
      podcastDone,
      allComplete: !!plan.is_completed,
      newAchievements: []
    });

    if (plan.strategy) {
      this.setData({
        checkinStrategy: plan.strategy,
        strategyText: STRATEGY_TEXT[plan.strategy] || STRATEGY_TEXT.random,
        pathSummary: plan.strategy === 'curriculum' && (plan.course_name || this.data.currentCourseName)
          ? `${STRATEGY_TEXT.curriculum} · ${plan.course_name || this.data.currentCourseName}`
          : (STRATEGY_TEXT[plan.strategy] || STRATEGY_TEXT.random),
        learningLevel: Number(plan.learning_level || this.data.learningLevel || 1),
        currentCourseId: plan.course_id || this.data.currentCourseId,
        currentCourseName: plan.course_name || this.data.currentCourseName
      });
    }
  },

  // ===== 任务执行 =====

  startTask(e) {
    const { taskId, taskType } = e.currentTarget.dataset;
    const listMap = {
      word: this.data.wordTasks,
      scene: this.data.sceneTasks,
      podcast: this.data.podcastTasks
    };
    const task = (listMap[taskType] || []).find(t => String(t.id) === String(taskId));
    if (!task) {
      wx.showToast({ title: '任务已刷新，请重试', icon: 'none' });
      this.loadPlan();
      return;
    }
    if (task.status === 'completed') return;

    if (task.task_type === 'word' && task.target_id) {
      // 单词任务：跳转到 detail 页面（打卡模式）
      wx.navigateTo({
        url: `/pages/vocabulary/detail/detail?id=${task.target_id}&checkin_task_id=${task.id}`
      });
      return;
    }

    // 场景/播客任务：使用内嵌执行视图
    this.setData({ activeTask: task });
  },

  exitTask() {
    this._destroyAudio();
    this.setData({ activeTask: null });
  },

  playDemo(e) {
    const gender = e.currentTarget.dataset.gender;
    const task = this.data.activeTask;
    if (!task) return;

    let audioUrl = null;
    const info = task.extra_info || {};

    if (task.task_type === 'word') {
      audioUrl = gender === 'male' ? info.audio_male : info.audio_female;
    } else if (task.task_type === 'scene') {
      audioUrl = gender === 'male' ? info.audio_male : info.audio_female;
    } else if (task.task_type === 'podcast') {
      audioUrl = gender === 'male' ? info.male_audio_url : info.female_audio_url;
    }

    if (!audioUrl) {
      wx.showToast({ title: '暂无音频', icon: 'none' });
      return;
    }

    this._destroyAudio();
    this._audioCtx = wx.createInnerAudioContext();
    const baseUrl = (app && app.globalData && app.globalData.baseUrl) || 'https://en.tajian.cc/api';
    const domain = baseUrl.replace(/\/api$/, '');
    this._audioCtx.src = audioUrl.startsWith('http') ? audioUrl : domain + audioUrl;
    this._audioCtx.play();
  },

  _destroyAudio() {
    if (this._audioCtx) {
      try { this._audioCtx.stop(); this._audioCtx.destroy(); } catch (e) {}
      this._audioCtx = null;
    }
  },

  // ===== 录音 =====

  startRecord() {
    if (this.data.isRecording || this.data.isAssessing || !this.data.activeTask) return;
    this._stopped = false;

    // 检查权限
    wx.getSetting({
      success: (res) => {
        const status = res.authSetting['scope.record'];
        if (status === false) {
          wx.showModal({
            title: '需要录音权限',
            content: '请到设置中开启录音权限',
            success: (r) => { if (r.confirm) wx.openSetting(); }
          });
        } else if (status === undefined) {
          wx.authorize({
            scope: 'scope.record',
            success: () => this._doStartRecord(),
            fail: () => wx.showToast({ title: '需要录音权限', icon: 'none' })
          });
        } else {
          this._doStartRecord();
        }
      }
    });
  },

  _doStartRecord() {
    this.setData({ isRecording: true, recordTime: 0 });
    this._recordTimer = setInterval(() => {
      this.setData({ recordTime: this.data.recordTime + 1 });
    }, 1000);
    recorderManager.start({ format: 'mp3', sampleRate: 16000, numberOfChannels: 1 });
  },

  stopRecord() {
    if (!this.data.isRecording) return;
    clearInterval(this._recordTimer);
    this.setData({ isRecording: false });
    recorderManager.stop();
  },

  async _submitTask(filePath) {
    if (this._submittingTask || !filePath) return;
    const task = this.data.activeTask;
    if (!task) return;
    const taskId = Number(task.id);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      wx.showToast({ title: '任务参数异常，请重试', icon: 'none' });
      this.loadPlan();
      return;
    }
    this._submittingTask = true;

    this.setData({ isAssessing: true });
    this._destroyAudio();

    try {
      const res = await api.upload('/checkin/complete-task', filePath, { task_id: String(taskId) });

      this.setData({ isAssessing: false });

      if (res.success) {
        const resultData = res.data;
        this.setData({
          showResult: true,
          resultData,
          newAchievements: resultData.new_achievements || []
        });

        // 刷新计划数据
        this._refreshPlanAfterComplete();
      } else {
        if (res.message && res.message.indexOf('任务不存在') > -1) {
          this.loadPlan();
        }
        wx.showToast({ title: res.message || '提交失败', icon: 'none' });
      }
    } catch (e) {
      console.error('提交任务失败:', e);
      this.setData({ isAssessing: false });
      wx.showToast({ title: '提交失败', icon: 'none' });
    } finally {
      this._submittingTask = false;
    }
  },

  async _refreshPlanAfterComplete() {
    try {
      const res = await api.get('/checkin/plan');
      if (res.success) {
        const { plan, items } = res.data;
        this._updatePlanState(plan, items);
      }
    } catch (e) {}
  },

  retryTask() {
    this.setData({ showResult: false });
    // 保持在当前任务执行视图
  },

  closeResult() {
    const { resultData } = this.data;
    this.setData({ showResult: false, activeTask: null });

    if (resultData.all_complete) {
      // 全部完成，显示庆祝
      this.setData({ allComplete: true });
    }
  },

  // ===== 换一批 =====

  async refreshTasks(e) {
    const type = e.currentTarget.dataset.type;
    wx.showLoading({ title: '刷新中...' });
    try {
      const res = await api.post('/checkin/refresh-tasks', { task_type: type });
      if (res.success) {
        // 重新加载整个计划（简单可靠）
        await this.loadPlan();
      }
    } catch (e) {
      wx.showToast({ title: '刷新失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ===== 模式选择 =====

  showModeSelector() {
    this.setData({ showModeModal: true });
  },

  closeModeModal() {
    this.setData({ showModeModal: false });
  },

  async selectMode(e) {
    const mode = e.currentTarget.dataset.mode;
    try {
      const res = await api.post('/checkin/set-mode', { mode });
      if (res.success) {
        this.setData({ currentMode: mode, modeText: MODE_TEXT[mode], showModeModal: false });
        wx.showToast({ title: '明日生效', icon: 'success' });
      }
    } catch (e) {
      wx.showToast({ title: '设置失败', icon: 'none' });
    }
  },

  showPathSelector() {
    this.setData({
      showPathModal: true,
      pathStrategyDraft: this.data.checkinStrategy || 'random',
      pathCourseIdDraft: this.data.currentCourseId || (this.data.curriculumCourses[0] && this.data.curriculumCourses[0].id) || null,
      pathLevelDraft: Number(this.data.learningLevel || 1)
    });
  },

  closePathModal() {
    this.setData({ showPathModal: false });
  },

  selectPathStrategy(e) {
    const strategy = e.currentTarget.dataset.strategy;
    this.setData({ pathStrategyDraft: strategy });
  },

  chooseCourse(e) {
    const courseId = Number(e.currentTarget.dataset.id);
    this.setData({ pathCourseIdDraft: courseId });
  },

  onLevelChange(e) {
    const level = Number(e.detail.value || 1);
    this.setData({ pathLevelDraft: level });
  },

  async savePathConfig() {
    const strategy = this.data.pathStrategyDraft || 'random';
    const courseId = this.data.pathCourseIdDraft;
    const learningLevel = Number(this.data.pathLevelDraft || 1);

    if (strategy === 'curriculum' && !courseId) {
      wx.showToast({ title: '请选择课程', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中...' });
    try {
      const res = await api.post('/checkin/curriculum', {
        strategy,
        course_id: strategy === 'curriculum' ? courseId : null,
        learning_level: learningLevel,
        apply_today: true
      });
      if (!res.success) {
        wx.showToast({ title: res.message || '保存失败', icon: 'none' });
        return;
      }

      const matched = this.data.curriculumCourses.find(c => String(c.id) === String(courseId));
      this.setData({
        showPathModal: false,
        checkinStrategy: strategy,
        strategyText: STRATEGY_TEXT[strategy] || STRATEGY_TEXT.random,
        pathSummary: strategy === 'curriculum' && matched ? `${STRATEGY_TEXT.curriculum} · ${matched.name}` : (STRATEGY_TEXT[strategy] || STRATEGY_TEXT.random),
        currentCourseId: strategy === 'curriculum' ? courseId : null,
        currentCourseName: strategy === 'curriculum' && matched ? matched.name : '',
        learningLevel
      });

      wx.showToast({ title: res.message || '已保存', icon: 'none' });
      this.loadPlan();
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ===== 录音回放 =====

  playRecordAudio(e) {
    const id = e.currentTarget.dataset.id;
    const url = e.currentTarget.dataset.url;

    if (this.data.recordPlayingId === id) {
      this._destroyAudio();
      this.setData({ recordPlayingId: -1 });
      return;
    }

    this._destroyAudio();
    this._audioCtx = wx.createInnerAudioContext();
    this._audioCtx.src = url;
    this._audioCtx.onEnded(() => this.setData({ recordPlayingId: -1 }));
    this._audioCtx.onError(() => {
      this.setData({ recordPlayingId: -1 });
      wx.showToast({ title: '播放失败', icon: 'none' });
    });
    this.setData({ recordPlayingId: id });
    this._audioCtx.play();
  },

  // ===== 导航 =====

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // ===== 分享 =====

  async onShareAppMessage() {
    const { plan, streakDays, shareId } = this.data;

    // 如果还没生成 shareId，先生成
    let sid = shareId;
    if (!sid) {
      try {
        const res = await api.post('/checkin/share');
        if (res.success && res.data.share_id) {
          sid = res.data.share_id;
          this.setData({ shareId: sid });
        }
      } catch (e) {}
    }

    if (sid) {
      return {
        title: `我已连续学习${streakDays}天，今日平均${plan.avg_score || 0}分！来看看我的打卡`,
        path: `/pages/checkin/share/share?shareId=${sid}`
      };
    }
    return {
      title: `我已连续学习${streakDays}天！来一起学英语吧`,
      path: '/pages/index/index'
    };
  },

  async generatePoster() {
    wx.showLoading({ title: '生成海报中...' });

    // 先确保有 shareId
    let sid = this.data.shareId;
    if (!sid) {
      try {
        const res = await api.post('/checkin/share');
        if (res.success && res.data.share_id) {
          sid = res.data.share_id;
          this.setData({ shareId: sid });
        }
      } catch (e) {
        wx.hideLoading();
        wx.showToast({ title: '生成失败', icon: 'none' });
        return;
      }
    }

    this.setData({ showPoster: true });

    // 延迟绘制（等 canvas 渲染完成）
    setTimeout(() => {
      this._drawPoster();
      wx.hideLoading();
    }, 300);
  },

  _drawPoster() {
    const ctx = wx.createCanvasContext('checkinPoster', this);
    const { plan, streakDays, completedCount, totalCount, wordTasks } = this.data;

    const W = 300, H = 450;

    // 背景渐变
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#2D3436');
    grd.addColorStop(0.35, '#636E72');
    grd.addColorStop(1, '#FFFFFF');
    ctx.setFillStyle(grd);
    ctx.fillRect(0, 0, W, H);

    // 标题
    ctx.setFillStyle('#FFFFFF');
    ctx.setFontSize(18);
    ctx.setTextAlign('center');
    ctx.fillText('每日打卡', W / 2, 35);

    // 日期
    const d = new Date();
    const dateStr = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    ctx.setFontSize(10);
    ctx.setFillStyle('rgba(255,255,255,0.7)');
    ctx.fillText(dateStr, W / 2, 55);

    // 平均分圆圈
    ctx.beginPath();
    ctx.arc(W / 2, 105, 35, 0, Math.PI * 2);
    ctx.setFillStyle('rgba(255,255,255,0.15)');
    ctx.fill();

    ctx.setFillStyle('#FFFFFF');
    ctx.setFontSize(24);
    ctx.setTextAlign('center');
    ctx.fillText(String(Math.round(plan.avg_score || 0)), W / 2, 113);
    ctx.setFontSize(8);
    ctx.setFillStyle('rgba(255,255,255,0.6)');
    ctx.fillText('平均分', W / 2, 128);

    // 三栏统计
    const stats = [
      { label: '连续', value: streakDays + '天' },
      { label: '任务', value: completedCount + '/' + totalCount },
      { label: '积分', value: '+' + (plan.total_points || 0) }
    ];
    stats.forEach((s, i) => {
      const x = 50 + i * 100;
      ctx.setFillStyle('#FFFFFF');
      ctx.setFontSize(14);
      ctx.fillText(String(s.value), x, 170);
      ctx.setFontSize(8);
      ctx.setFillStyle('rgba(255,255,255,0.6)');
      ctx.fillText(s.label, x, 183);
    });

    // 白色卡片
    const cardY = 200;
    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(15, cardY, W - 30, H - cardY - 40);

    // 圆角装饰线
    ctx.setStrokeStyle('#F1F2F6');
    ctx.setLineWidth(0.5);
    ctx.moveTo(30, cardY + 25);
    ctx.lineTo(W - 30, cardY + 25);
    ctx.stroke();

    // 打卡单词标题
    ctx.setFillStyle('#2D3436');
    ctx.setTextAlign('left');
    ctx.setFontSize(11);
    ctx.fillText('打卡单词', 28, cardY + 18);

    // 单词列表
    const allTasks = [...wordTasks];
    allTasks.slice(0, 5).forEach((task, i) => {
      const y = cardY + 42 + i * 30;
      const info = task.extra_info || {};

      ctx.setFillStyle('#2D3436');
      ctx.setFontSize(12);
      ctx.fillText(info.word || task.reference_text || '', 28, y);

      ctx.setFillStyle('#B2BEC3');
      ctx.setFontSize(8);
      const subText = ((info.phonetic || '') + ' ' + (info.translation || '')).substring(0, 20);
      ctx.fillText(subText, 28, y + 13);

      if (task.score) {
        ctx.setTextAlign('right');
        ctx.setFillStyle(task.score >= 90 ? '#2ED573' : (task.score >= 60 ? '#F39C12' : '#FF6B6B'));
        ctx.setFontSize(13);
        ctx.fillText(Math.round(task.score) + '分', W - 28, y + 3);
        ctx.setTextAlign('left');
      }
    });

    // 底部引导
    ctx.setTextAlign('center');
    ctx.setFillStyle('#B2BEC3');
    ctx.setFontSize(8);
    ctx.fillText('趣学英语 · 和我一起打卡学英语', W / 2, H - 18);

    ctx.draw();
  },

  savePoster() {
    wx.canvasToTempFilePath({
      canvasId: 'checkinPoster',
      success: (res) => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => {
            wx.showToast({ title: '已保存到相册', icon: 'success' });
          },
          fail: (err) => {
            if (err.errMsg.indexOf('auth deny') > -1 || err.errMsg.indexOf('authorize') > -1) {
              wx.showModal({
                title: '需要相册权限',
                content: '请到设置中允许保存到相册',
                success: (r) => { if (r.confirm) wx.openSetting(); }
              });
            } else {
              wx.showToast({ title: '保存失败', icon: 'none' });
            }
          }
        });
      },
      fail: () => {
        wx.showToast({ title: '生成图片失败', icon: 'none' });
      }
    }, this);
  },

  closePoster() {
    this.setData({ showPoster: false });
  },

  noop() {}
});
