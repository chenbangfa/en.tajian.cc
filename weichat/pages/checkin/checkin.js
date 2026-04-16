// pages/checkin/checkin.js
const api = require('../../services/api');
const app = getApp();
const recorderManager = wx.getRecorderManager();

// 滑块上限 500，step 5
const PASSING_OPTIONS = [60, 70, 80, 90];

Page({
  data: {
    // 当前屏幕: 'loading' | 'select-course' | 'learning' | 'complete'
    screen: 'loading',

    // 课程选择
    courses: [],
    selectedCourseId: null,
    enrollDailyTarget: 10,     // 报名时每日目标（直接数值，1-500）
    passingScoreOptions: PASSING_OPTIONS,
    settingsPassingIdx: 0,     // 默认 60

    // 学习状态
    enrolledCourseName: '',
    streakDays: 0,
    words: [],
    currentIdx: 0,
    doneCount: 0,
    totalCount: 0,
    courseLearnedCount: 0,
    courseTotalCount: 0,
    passingScore: 60,

    // 录音评测
    isRecording: false,
    recordingTime: 0,
    isAssessing: false,
    assessResult: null,   // { overall_score, pronunciation_score, fluency_score, integrity_score }
    assessPassed: false,

    // 音频播放
    isPlayingAudio: false,
    isPlayingUserAudio: false,
    isPlayingExample: false,
    currentVoice: 'female',

    // 完成页
    newAchievements: [],
    shareId: '',

    // 设置弹窗（学习中）
    showSettings: false,
    settingsDailyTarget: 10,  // 设置弹窗中每日目标（直接数值）
    settingsPassingIdx2: 0,   // 设置弹窗内专用，避免和选课页冲突

    // 跳过（连续评测失败次数）
    failCount: 0
  },

  _audioCtx: null,
  _userAudioCtx: null,
  _exampleAudioCtx: null,
  _lastRecordingPath: null,
  _recordTimer: null,
  _assessingLock: false,
  _suppressNextStop: false,
  _recorderActive: false,
  _loaded: false,

  onLoad() {
    this._bindRecorder();
    this.loadStatus();
  },

  onShow() {
    this._bindRecorder();
    if (this._loaded) this.loadStatus();
    this._loaded = true;
  },

  onHide() {
    // 切换页面时强制停止录音，防止麦克风被占用
    if (this.data.isRecording || this._recorderActive) {
      this._suppressNextStop = true;
      this._recorderActive = false;
      try { recorderManager.stop(); } catch (e) {}
      if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
      this.setData({ isRecording: false, recordingTime: 0 });
    }
  },

  onUnload() {
    this._stopAudio();
    this._stopUserAudio();
    this._stopExampleAudio();
    if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
    this._suppressNextStop = true;
    this._recorderActive = false;
    try { recorderManager.stop(); } catch (e) {}
  },

  _stopAudio() {
    if (this._audioCtx) {
      try { this._audioCtx.stop(); this._audioCtx.destroy(); } catch (e) {}
      this._audioCtx = null;
    }
    this.setData({ isPlayingAudio: false });
  },

  _stopUserAudio() {
    if (this._userAudioCtx) {
      try { this._userAudioCtx.stop(); this._userAudioCtx.destroy(); } catch (e) {}
      this._userAudioCtx = null;
    }
    this.setData({ isPlayingUserAudio: false });
  },

  _stopExampleAudio() {
    if (this._exampleAudioCtx) {
      try { this._exampleAudioCtx.stop(); this._exampleAudioCtx.destroy(); } catch (e) {}
      this._exampleAudioCtx = null;
    }
    this.setData({ isPlayingExample: false });
  },

  _bindRecorder() {
    if (typeof recorderManager.offStop === 'function') recorderManager.offStop();
    if (typeof recorderManager.offError === 'function') recorderManager.offError();
    if (typeof recorderManager.offStart === 'function') recorderManager.offStart();
    recorderManager.onStart(() => {
      this._recorderActive = true;
    });
    recorderManager.onStop((res) => {
      this._recorderActive = false;
      if (this._assessingLock) return;
      // 被 onError 或页面隐藏触发的强制停止，忽略
      if (this._suppressNextStop) {
        this._suppressNextStop = false;
        return;
      }
      if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
      this.setData({ isRecording: false, recordingTime: 0 });
      this.submitAssessment(res.tempFilePath);
    });
    recorderManager.onError((err) => {
      this._recorderActive = false;
      // 如果是我们主动触发的强制 stop 导致的错误，忽略
      if (this._suppressNextStop) return;
      console.error('录音错误:', err);
      if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
      this.setData({ isRecording: false, recordingTime: 0 });
      wx.showToast({ title: '录音失败，请重试', icon: 'none' });
    });
  },

  // ===== 状态加载 =====

  async loadStatus() {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await api.get('/checkin/v2/status');
      if (!res.success) { wx.showToast({ title: '加载失败', icon: 'none' }); return; }
      const d = res.data;
      this.setData({ passingScore: d.passingScore || 60 });

      if (!d.enrolled) {
        await this._loadCourses();
        this.setData({ screen: 'select-course' });
      } else if (d.todayComplete) {
        this.setData({
          screen: 'complete',
          streakDays: d.streakDays,
          enrolledCourseName: d.course ? d.course.name : '',
          doneCount: d.todayDoneCount,
          totalCount: d.dailyTarget,
          courseLearnedCount: d.learnedCount,
          courseTotalCount: d.courseItemCount || d.courseWordCount || 0
        });
        this._prepareShare();
      } else {
        await this._loadTodayWords();
      }
    } catch (e) {
      console.error('loadStatus error:', e);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async _loadCourses() {
    const res = await api.get('/checkin/v2/courses');
    if (res.success) {
      const d = res.data;
      const passingIdx = PASSING_OPTIONS.indexOf(d.passingScore);
      this.setData({
        courses: d.courses || [],
        selectedCourseId: d.currentCourseId || null,
        enrollDailyTarget: d.dailyTarget || 10,
        settingsPassingIdx: passingIdx >= 0 ? passingIdx : 0,
        passingScore: d.passingScore || 60
      });
    }
  },

  async _loadTodayWords() {
    const res = await api.get('/checkin/v2/today');
    if (!res.success) { wx.showToast({ title: res.message || '加载失败', icon: 'none' }); return; }
    const d = res.data;
    const baseUrl = (app.globalData.baseUrl || '').replace(/\/api$/, '');

    const words = (d.items || []).map(item => {
      if (item.image_url && item.image_url.startsWith('/')) item.image_url = baseUrl + item.image_url;
      if (item.audio_url_female && item.audio_url_female.startsWith('/')) item.audio_url_female = baseUrl + item.audio_url_female;
      if (item.audio_url_male && item.audio_url_male.startsWith('/')) item.audio_url_male = baseUrl + item.audio_url_male;
      if (item.example_audio_female && item.example_audio_female.startsWith('/')) item.example_audio_female = baseUrl + item.example_audio_female;
      if (item.example_audio_male && item.example_audio_male.startsWith('/')) item.example_audio_male = baseUrl + item.example_audio_male;
      return item;
    });

    const firstPendingIdx = words.findIndex(w => w.status === 'pending');
    const startIdx = firstPendingIdx >= 0 ? firstPendingIdx : 0;

    this.setData({
      screen: 'learning',
      words,
      currentIdx: startIdx,
      doneCount: d.doneCount,
      totalCount: d.dailyTarget,
      streakDays: d.streakDays,
      assessResult: null,
      assessPassed: false
    });

    if (words[startIdx]) this._ensureAudio(words[startIdx]);
  },

  // ===== 课程选择 =====

  selectCourse(e) {
    const { id } = e.currentTarget.dataset;
    this.setData({ selectedCourseId: id });
  },

  selectDailyTarget(e) {
    this.setData({ enrollDailyTarget: Number(e.detail.value) });
  },

  selectPassingScore(e) {
    this.setData({ settingsPassingIdx: Number(e.detail.value) });
  },

  async confirmEnroll() {
    const { selectedCourseId, enrollDailyTarget, passingScoreOptions, settingsPassingIdx } = this.data;
    if (!selectedCourseId) { wx.showToast({ title: '请选择课程', icon: 'none' }); return; }

    const daily_target = enrollDailyTarget || 10;
    const passing_score = passingScoreOptions[settingsPassingIdx] || 60;

    // 查询该课程是否有历史进度
    let resume = true;
    try {
      const prog = await api.get(`/checkin/v2/course-progress/${selectedCourseId}`);
      if (prog.success && prog.data.completed_count > 0) {
        const { completed_count, total_count } = prog.data;
        resume = await new Promise(resolve => {
          wx.showModal({
            title: '继续学习',
            content: `该课程已学习 ${completed_count}/${total_count} 个学习项，是否继续上次进度？`,
            confirmText: '继续学习',
            cancelText: '重新开始',
            success(r) { resolve(r.confirm); }
          });
        });
      }
    } catch (e) {}

    wx.showLoading({ title: '报名中...' });
    try {
      const res = await api.post('/checkin/v2/enroll', { course_id: selectedCourseId, daily_target, resume });
      if (res.success) {
        await api.post('/checkin/v2/settings', { passing_score });
        this.setData({ passingScore: passing_score });
        await this._loadTodayWords();
      } else {
        wx.showToast({ title: res.message || '报名失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ===== 录音评测 =====

  toggleRecord() {
    if (this.data.isAssessing) return;
    if (this.data.isRecording) {
      recorderManager.stop();
    } else {
      this._checkRecordPermission();
    }
  },

  _checkRecordPermission() {
    wx.getSetting({
      success: (res) => {
        const auth = res.authSetting['scope.record'];
        if (auth === true) {
          this._startRecord();
        } else if (auth === false) {
          wx.showModal({
            title: '需要录音权限',
            content: '请在设置中开启麦克风权限',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting(); }
          });
        } else {
          wx.authorize({
            scope: 'scope.record',
            success: () => this._startRecord(),
            fail: () => wx.showToast({ title: '需要录音权限', icon: 'none' })
          });
        }
      }
    });
  },

  _startRecord() {
    // 录音前停止所有播放，防止播放声音混入录音
    this._stopAudio();
    this._stopUserAudio();
    this._stopExampleAudio();

    const doStart = () => {
      this._suppressNextStop = false;
      this._assessingLock = false;
      this.setData({ isRecording: true, recordingTime: 0, assessResult: null, assessPassed: false });
      recorderManager.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1 });
      this._recordTimer = setInterval(() => {
        this.setData({ recordingTime: this.data.recordingTime + 1 });
      }, 1000);
    };

    if (this._recorderActive) {
      // 有残留录音，先 stop 再延迟启动
      this._suppressNextStop = true;
      try { recorderManager.stop(); } catch (e) {}
      setTimeout(doStart, 200);
    } else {
      // 无残留录音，直接启动（不调用 stop，避免触发假 onError）
      doStart();
    }
  },

  async submitAssessment(audioPath) {
    if (!audioPath || this._assessingLock) return;
    this._assessingLock = true;
    this._lastRecordingPath = audioPath;
    this.setData({ isAssessing: true });
    wx.showLoading({ title: '评测中...' });

    try {
      const word = this.data.words[this.data.currentIdx];
      if (!word) return;

      const text = ((word.taskType === 'picture_book_page' ? word.text_en : word.word) || word.reference_text || '').trim();
      const wordCount = text.split(/\s+/).length;
      const contentType = wordCount <= 2 ? 'word' : (wordCount <= 20 ? 'sentence' : 'paragraph');

      const res = await api.upload('/voice/assess', audioPath, {
        reference_text: text,
        content_type: contentType
      });

      if (res.success) {
        const score = res.data.overall_score || 0;
        const passed = score >= this.data.passingScore;
        this.setData({ assessResult: res.data, assessPassed: passed });

        if (passed) {
          this.setData({ failCount: 0 });
          // 静默标记完成，结果留在屏幕等用户操作
          await this._markWordDone(word, res.data.assessment_id);
        } else {
          this.setData({ failCount: this.data.failCount + 1 });
        }
      } else {
        wx.showToast({ title: res.message || '评测失败，请重试', icon: 'none' });
      }
    } catch (e) {
      console.error('评测错误:', e);
      wx.showToast({ title: '评测失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isAssessing: false });
      wx.hideLoading();
      this._assessingLock = false;
    }
  },

  async _markWordDone(word, assessmentId) {
    if (!word || word.status === 'completed') return;
    try {
      const body = { item_id: word.id };
      if (assessmentId) body.assessment_id = assessmentId;
      const res = await api.post('/checkin/v2/done', body);
      if (res.success) {
        const d = res.data;
        const words = [...this.data.words];
        const idx = words.findIndex(w => w.id === word.id);
        if (idx >= 0) words[idx] = { ...words[idx], status: 'completed' };
        this.setData({ words, doneCount: d.doneCount, newAchievements: d.newAchievements || [] });

        if (d.isComplete) {
          this._allComplete = { streakDays: d.streakDays, doneCount: d.doneCount };
          this._prepareShare();
        }
      }
    } catch (e) {
      console.error('标记完成失败:', e);
    }
  },

  retryWord() {
    this._stopUserAudio();
    this.setData({ assessResult: null, assessPassed: false });
  },

  async skipWord() {
    const word = this.data.words[this.data.currentIdx];
    if (!word) return;
    wx.showLoading({ title: '跳过中...' });
    try {
      await this._markWordDone(word, null);
    } finally {
      wx.hideLoading();
    }
    this.setData({ failCount: 0, assessResult: null, assessPassed: false });
    this.goNext();
  },

  closeAssessPanel() {
    this._stopUserAudio();
    this.setData({ assessResult: null, assessPassed: false });
  },

  playUserAudio() {
    const path = this._lastRecordingPath;
    if (!path) { wx.showToast({ title: '暂无录音', icon: 'none' }); return; }
    if (this.data.isPlayingUserAudio) {
      this._stopUserAudio();
      return;
    }
    this._stopAudio();
    this._stopUserAudio();
    this._userAudioCtx = wx.createInnerAudioContext();
    this._userAudioCtx.src = path;
    this._userAudioCtx.onPlay(() => this.setData({ isPlayingUserAudio: true }));
    this._userAudioCtx.onEnded(() => this.setData({ isPlayingUserAudio: false }));
    this._userAudioCtx.onError(() => this.setData({ isPlayingUserAudio: false }));
    this._userAudioCtx.play();
  },

  goNext() {
    // 如果全部完成，跳完成页
    if (this._allComplete) {
      const { streakDays, doneCount } = this._allComplete;
      this._allComplete = null;
      this.setData({ screen: 'complete', streakDays, doneCount, assessResult: null, assessPassed: false, failCount: 0 });
      return;
    }
    const { words, currentIdx } = this.data;
    const nextIdx = currentIdx + 1;
    if (nextIdx < words.length) {
      this.setData({ currentIdx: nextIdx, assessResult: null, assessPassed: false, failCount: 0 });
      this._ensureAudio(words[nextIdx]);
    }
  },

  // ===== 音频播放 =====

  playVoice(e) {
    if (this.data.isRecording) return;
    const voice = e.currentTarget.dataset.voice;
    this.setData({ currentVoice: voice });
    const word = this.data.words[this.data.currentIdx];
    if (!word) return;
    const url = voice === 'male' ? word.audio_url_male : word.audio_url_female;
    if (!url) { wx.showToast({ title: `暂无${voice === 'male' ? '男' : '女'}声音频`, icon: 'none' }); return; }

    this._stopAudio();
    this._audioCtx = wx.createInnerAudioContext();
    this._audioCtx.src = url;
    this._audioCtx.onPlay(() => this.setData({ isPlayingAudio: true }));
    this._audioCtx.onEnded(() => this.setData({ isPlayingAudio: false }));
    this._audioCtx.onError(() => this.setData({ isPlayingAudio: false }));
    this._audioCtx.play();
  },

  playExampleSentence(e) {
    if (this.data.isRecording) return;
    const voice = e.currentTarget.dataset.voice;
    const word = this.data.words[this.data.currentIdx];
    if (!word) return;
    const url = voice === 'male' ? word.example_audio_male : word.example_audio_female;
    if (!url) { wx.showToast({ title: `暂无例句${voice === 'male' ? '男' : '女'}声音频`, icon: 'none' }); return; }

    this._stopExampleAudio();
    this._exampleAudioCtx = wx.createInnerAudioContext();
    this._exampleAudioCtx.src = url;
    this._exampleAudioCtx.onPlay(() => this.setData({ isPlayingExample: true }));
    this._exampleAudioCtx.onEnded(() => this.setData({ isPlayingExample: false }));
    this._exampleAudioCtx.onError(() => this.setData({ isPlayingExample: false }));
    this._exampleAudioCtx.play();
  },

  async _ensureAudio(word) {
    if (!word) return;
    if (word.taskType && word.taskType !== 'word') return;
    const hasFemale = !!word.audio_url_female;
    const hasMale = !!word.audio_url_male;
    const hasExFemale = !!word.example_audio_female;
    const hasExMale = !!word.example_audio_male;
    const hasExample = !!word.example_sentence;

    const allComplete = hasFemale && hasMale && (!hasExample || (hasExFemale && hasExMale));
    if (allComplete) return;

    // wordId 是 words.id，word.id 是 daily_task_items.id
    const realWordId = word.wordId;
    if (!realWordId) return;

    console.log(`[AutoAudio] 单词 "${word.word}" 缺少音频，触发后台生成`);
    try {
      const res = await api.post(`/words/${realWordId}/ensure-audio`);
      if (res.success && res.generating && res.generating.length > 0) {
        this._pollForAudioUpdate(realWordId, res.generating.length);
      }
    } catch (e) {
      console.log('[AutoAudio] 触发生成失败:', e);
    }
  },

  _pollForAudioUpdate(wordId, count) {
    const firstDelay = 4000;
    const pollInterval = 4000;
    const maxPolls = Math.min(count * 2 + 2, 8);
    let pollCount = 0;
    const baseUrl = (app.globalData.baseUrl || '').replace(/\/api$/, '');

    const doPoll = () => {
      const { words, currentIdx } = this.data;
      // 用 wordId（words.id）做对比，item.id 是打卡任务ID
      if (!words[currentIdx] || words[currentIdx].wordId !== wordId) return;

      pollCount++;
      console.log(`[AutoAudio] 轮询 #${pollCount}/${maxPolls} (word#${wordId})`);

      api.get(`/words/${wordId}`).then(res => {
        if (!res.success) return;
        const u = res.data;
        if (u.audio_url_female && u.audio_url_female.startsWith('/')) u.audio_url_female = baseUrl + u.audio_url_female;
        if (u.audio_url_male && u.audio_url_male.startsWith('/')) u.audio_url_male = baseUrl + u.audio_url_male;
        if (u.example_audio_female && u.example_audio_female.startsWith('/')) u.example_audio_female = baseUrl + u.example_audio_female;
        if (u.example_audio_male && u.example_audio_male.startsWith('/')) u.example_audio_male = baseUrl + u.example_audio_male;

        // Re-check current idx (async race)
        const { words: ws, currentIdx: ci } = this.data;
        if (!ws[ci] || ws[ci].wordId !== wordId) return;

        const audioFields = ['audio_url_female', 'audio_url_male', 'example_audio_female', 'example_audio_male'];
        let hasNew = false;
        audioFields.forEach(f => { if (u[f] && !ws[ci][f]) hasNew = true; });

        if (hasNew) {
          const update = {};
          audioFields.forEach(f => { update[`words[${ci}].${f}`] = u[f] || ws[ci][f]; });
          this.setData(update);
          console.log(`[AutoAudio] 音频已更新 (word#${wordId})`);
        }

        const allDone = u.audio_url_female && u.audio_url_male &&
          (!u.example_sentence || (u.example_audio_female && u.example_audio_male));
        if (allDone || pollCount >= maxPolls) return;
        setTimeout(doPoll, pollInterval);
      }).catch(() => {});
    };

    setTimeout(doPoll, firstDelay);
  },

  // ===== 设置弹窗 =====

  openSettings() {
    const { totalCount, passingScore } = this.data;
    const passingIdx = PASSING_OPTIONS.indexOf(passingScore);
    this.setData({
      showSettings: true,
      settingsDailyTarget: totalCount || 10,
      settingsPassingIdx2: passingIdx >= 0 ? passingIdx : 0
    });
  },

  closeSettings() {
    this.setData({ showSettings: false });
  },

  settingsTargetChange(e) {
    this.setData({ settingsDailyTarget: Number(e.detail.value) });
  },

  settingsPassingChange(e) {
    this.setData({ settingsPassingIdx2: Number(e.detail.value) });
  },

  async saveSettings() {
    const { settingsDailyTarget, passingScoreOptions, settingsPassingIdx2 } = this.data;
    const daily_target = settingsDailyTarget || 10;
    const passing_score = passingScoreOptions[settingsPassingIdx2] || 60;

    wx.showLoading({ title: '保存中...' });
    try {
      await api.post('/checkin/v2/settings', { daily_target, passing_score });
      this.setData({ showSettings: false, passingScore: passing_score });
      wx.showToast({ title: '已保存', icon: 'success' });
      // 立即重新加载今日单词，让新目标生效
      await this._loadTodayWords();
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ===== 完成页 =====

  async changeCourse() {
    wx.showLoading({ title: '加载中...' });
    try {
      await this._loadCourses();
      this.setData({ screen: 'select-course', selectedCourseId: null, showSettings: false });
    } finally {
      wx.hideLoading();
    }
  },

  async _prepareShare() {
    try {
      const res = await api.post('/checkin/share');
      if (res.success && res.data && res.data.share_id) {
        this.setData({ shareId: res.data.share_id });
      }
    } catch (e) {
      console.log('预生成分享ID失败:', e);
    }
  },

  onShareAppMessage() {
    const { shareId, streakDays } = this.data;
    if (!shareId) {
      return { title: '我在趣学英语完成了今日打卡！', path: '/pages/checkin/checkin' };
    }
    return {
      title: `我已连续打卡${streakDays}天，快来挑战吧！`,
      path: `/pages/checkin/share/share?shareId=${shareId}`
    };
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  noop() {}
});
