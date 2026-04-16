// pages/dialogue/player/player.js
const app = getApp();
const api = require('../../../services/api');
const recorderManager = wx.getRecorderManager();

Page({
  data: {
    scene: null,
    lines: [],
    locked: false,
    phase: 'loading', // loading | intro | listen | practice | done

    // listen 阶段
    listenPlayingId: -1,     // 当前播放的 line id（-1=无）
    listenAutoPlaying: false, // 是否正在全部自动播放

    // practice 阶段
    practiceStep: 0,          // 当前台词序号（在 lines 中的索引）
    showHint: false,          // 是否显示用户台词提示
    isRecording: false,
    isAssessing: false,
    recordingTime: 0,
    assessResult: null,
    recordedAudioPath: '',     // 录音文件路径（回放用）
    playingMyAudio: false,     // 是否正在回放录音
    lineScores: [],            // [{lineId, score, passed}]

    // done 阶段
    avgScore: 0,
    stars: 0,

    // 显示中文翻译
    showCn: true,

    // VIP
    isVip: false
  },

  _audioCtx: null,
  _recordTimer: null,
  _autoPlayTimer: null,
  _suppressStop: false,
  _practiceGuideTimer: null,

  onLoad(options) {
    const userInfo = app.globalData.userInfo;
    this.setData({ isVip: this._checkVip(userInfo) });
    this._bindRecorder();
    if (options.id) this.loadScene(options.id);
  },

  onUnload() {
    this._stopAudio();
    this._stopMyAudio();
    this._clearAllTimers();
    this._suppressStop = true;
    try { recorderManager.stop(); } catch (e) {}
  },

  _checkVip(user) {
    if (!user || !user.vip_level || user.vip_level <= 0) return false;
    if (user.vip_expire_date && new Date(user.vip_expire_date) < new Date()) return false;
    return true;
  },

  // ===== 录音绑定 =====

  _bindRecorder() {
    if (typeof recorderManager.offStop === 'function') recorderManager.offStop();
    if (typeof recorderManager.offError === 'function') recorderManager.offError();

    recorderManager.onStop((res) => {
      if (this._suppressStop) { this._suppressStop = false; return; }
      if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
      this.setData({ isRecording: false, recordingTime: 0, recordedAudioPath: res.tempFilePath });
      this._submitAssessment(res.tempFilePath);
    });

    recorderManager.onError((err) => {
      if (this._suppressStop) return;
      console.error('[Dialogue] 录音错误:', err);
      if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
      this.setData({ isRecording: false, recordingTime: 0 });
      wx.showToast({ title: '录音失败，请重试', icon: 'none' });
    });
  },

  // ===== 音频播放（WAV 需先下载）=====

  _stopAudio() {
    if (this._audioCtx) {
      try { this._audioCtx.stop(); this._audioCtx.destroy(); } catch (e) {}
      this._audioCtx = null;
    }
    this.setData({ listenPlayingId: -1 });
  },

  _playAudio(url, onEnded) {
    if (!url) { if (onEnded) onEnded(); return; }
    this._stopAudio();

    const doPlay = (src) => {
      this._audioCtx = wx.createInnerAudioContext();
      this._audioCtx.obeyMuteSwitch = false;
      this._audioCtx.src = src;
      this._audioCtx.onEnded(() => {
        this.setData({ listenPlayingId: -1 });
        if (onEnded) onEnded();
      });
      this._audioCtx.onError((e) => {
        console.error('[Dialogue] 音频播放失败:', e);
        this.setData({ listenPlayingId: -1 });
        if (onEnded) onEnded();
      });
      this._audioCtx.play();
    };

    // Android 不支持直接播放远程 WAV，先下载
    if (url.match(/\.wav(\?|$)/i)) {
      wx.downloadFile({
        url,
        success: (res) => {
          if (res.statusCode === 200) doPlay(res.tempFilePath);
          else { if (onEnded) onEnded(); }
        },
        fail: () => { if (onEnded) onEnded(); }
      });
    } else {
      doPlay(url);
    }
  },

  _clearAllTimers() {
    if (this._autoPlayTimer) { clearTimeout(this._autoPlayTimer); this._autoPlayTimer = null; }
    if (this._practiceGuideTimer) { clearTimeout(this._practiceGuideTimer); this._practiceGuideTimer = null; }
    if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
  },

  // ===== 加载场景 =====

  async loadScene(id) {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await api.get(`/dialogue/scenes/${id}`);
      if (!res.success) { wx.showToast({ title: '加载失败', icon: 'none' }); return; }
      const scene = res.data;
      wx.setNavigationBarTitle({ title: scene.title });
      const lineScores = (scene.lines || [])
        .filter(l => l.role === 'user')
        .map(l => ({ lineId: l.id, score: null, passed: false }));
      this.setData({
        scene,
        lines: scene.lines || [],
        locked: !!scene.locked,
        lineScores,
        phase: 'intro'
      });
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  // ===== intro 阶段 =====

  startListen() {
    this._stopAudio();
    this.setData({ phase: 'listen', listenAutoPlaying: false, listenPlayingId: -1 });
  },

  goVip() {
    wx.navigateTo({ url: '/pages/vip/vip' });
  },

  // ===== listen 阶段 =====

  tapLine(e) {
    if (this.data.listenAutoPlaying) return;
    const { audio } = e.currentTarget.dataset;
    const id = Number(e.currentTarget.dataset.id);
    if (!audio) return;
    if (this.data.listenPlayingId === id) {
      this._stopAudio();
      return;
    }
    this._playAudio(audio, () => this.setData({ listenPlayingId: -1 }));
    this.setData({ listenPlayingId: id });
  },

  autoPlayAll() {
    if (this.data.listenAutoPlaying) {
      this._stopAudio();
      this._clearAllTimers();
      this.setData({ listenAutoPlaying: false, listenPlayingId: -1 });
      return;
    }
    this.setData({ listenAutoPlaying: true });
    this._autoPlayQueue(0);
  },

  _autoPlayQueue(idx) {
    const { lines } = this.data;
    if (idx >= lines.length) {
      this.setData({ listenAutoPlaying: false, listenPlayingId: -1 });
      return;
    }
    if (!this.data.listenAutoPlaying) return;
    const line = lines[idx];
    if (line.audio_url) {
      this._playAudio(line.audio_url, () => {
        this.setData({ listenPlayingId: -1 });
        this._autoPlayTimer = setTimeout(() => this._autoPlayQueue(idx + 1), 400);
      });
      this.setData({ listenPlayingId: line.id });
    } else {
      // 无音频：停顿后跳过
      this._autoPlayTimer = setTimeout(() => this._autoPlayQueue(idx + 1), 800);
    }
  },

  startPractice() {
    this._stopAudio();
    this._clearAllTimers();
    const lineScores = this.data.lines
      .filter(l => l.role === 'user')
      .map(l => ({ lineId: l.id, score: null, passed: false }));
    this.setData({
      phase: 'practice',
      practiceStep: 0,
      lineScores,
      showHint: false,
      assessResult: null,
      listenAutoPlaying: false
    });
    this._runPracticeStep(0);
  },

  // ===== practice 阶段状态机 =====

  _runPracticeStep(step) {
    const { lines } = this.data;
    if (step >= lines.length) {
      this._showDone();
      return;
    }
    const line = lines[step];
    this.setData({ practiceStep: step, assessResult: null, showHint: false });

    if (line.role === 'guide') {
      // 播放 guide 台词，结束后 600ms 自动跳到下一句
      if (line.audio_url) {
        this._playAudio(line.audio_url, () => {
          this._practiceGuideTimer = setTimeout(() => this._runPracticeStep(step + 1), 600);
        });
      } else {
        this._practiceGuideTimer = setTimeout(() => this._runPracticeStep(step + 1), 1200);
      }
    }
    // user line：等待用户录音，不自动推进
  },

  toggleHint() {
    this.setData({ showHint: !this.data.showHint });
  },

  toggleCn() {
    this.setData({ showCn: !this.data.showCn });
  },

  // ===== 录音（点击切换） =====

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
        const recordAuth = res.authSetting['scope.record'];
        if (recordAuth === true) {
          this._startRecord();
        } else if (recordAuth === false) {
          wx.showModal({
            title: '录音权限已关闭',
            content: '语音跟读需要录音权限，请在设置中开启"麦克风"权限',
            confirmText: '去设置',
            cancelText: '取消',
            success: (modalRes) => {
              if (modalRes.confirm) {
                wx.openSetting({
                  success: (settingRes) => {
                    if (settingRes.authSetting['scope.record']) this._startRecord();
                  }
                });
              }
            }
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
    this.setData({ isRecording: true, recordingTime: 0, assessResult: null });
    recorderManager.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1 });
    this._recordTimer = setInterval(() => {
      this.setData({ recordingTime: this.data.recordingTime + 1 });
    }, 1000);
  },

  async _submitAssessment(audioPath) {
    if (!audioPath) return;
    const { lines, practiceStep, lineScores } = this.data;
    const line = lines[practiceStep];
    if (!line || line.role !== 'user') return;

    this.setData({ isAssessing: true });
    wx.showLoading({ title: '评测中...' });
    try {
      const res = await api.upload('/voice/assess', audioPath, {
        reference_text: line.line_en,
        content_type: 'sentence',
        source: 'dialogue',
        source_id: this.data.scene.id,
        sentence_index: practiceStep
      });

      if (res.success) {
        const score = res.data.overall_score || 0;
        const passed = score >= 60;
        const newScores = [...lineScores];
        const scoreIdx = newScores.findIndex(s => s.lineId === line.id);
        if (scoreIdx >= 0) {
          // 保留最高分
          if (score > (newScores[scoreIdx].score || 0)) {
            newScores[scoreIdx] = { lineId: line.id, score, passed };
          }
        }
        this.setData({ assessResult: res.data, lineScores: newScores });
      } else {
        wx.showToast({ title: res.message || '评测失败，请重试', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '评测失败，请重试', icon: 'none' });
    } finally {
      this.setData({ isAssessing: false });
      wx.hideLoading();
    }
  },

  retryLine() {
    this._stopMyAudio();
    this.setData({ assessResult: null });
  },

  playMyRecording() {
    const { recordedAudioPath, playingMyAudio } = this.data;
    if (!recordedAudioPath) return;
    if (playingMyAudio) {
      this._stopMyAudio();
      return;
    }
    this._stopAudio();
    this._myAudioCtx = wx.createInnerAudioContext();
    this._myAudioCtx.obeyMuteSwitch = false;
    this._myAudioCtx.src = recordedAudioPath;
    this._myAudioCtx.onEnded(() => this.setData({ playingMyAudio: false }));
    this._myAudioCtx.onError(() => {
      this.setData({ playingMyAudio: false });
      wx.showToast({ title: '播放失败', icon: 'none' });
    });
    this.setData({ playingMyAudio: true });
    this._myAudioCtx.play();
  },

  _stopMyAudio() {
    if (this._myAudioCtx) {
      try { this._myAudioCtx.stop(); this._myAudioCtx.destroy(); } catch (e) {}
      this._myAudioCtx = null;
    }
    this.setData({ playingMyAudio: false });
  },

  nextLine() {
    const { practiceStep } = this.data;
    this.setData({ assessResult: null, showHint: false });
    this._runPracticeStep(practiceStep + 1);
  },

  // ===== done 阶段 =====

  _showDone() {
    const { lineScores } = this.data;
    const scored = lineScores.filter(s => s.score !== null);
    const avgScore = scored.length > 0
      ? Math.round(scored.reduce((sum, s) => sum + s.score, 0) / scored.length)
      : 0;
    const stars = avgScore >= 85 ? 3 : avgScore >= 70 ? 2 : 1;
    this.setData({ phase: 'done', avgScore, stars });
  },

  replayPractice() {
    this.startPractice();
  },

  backToListen() {
    this._stopAudio();
    this._clearAllTimers();
    this.setData({ phase: 'listen', listenAutoPlaying: false });
  },

  noop() {}
});
