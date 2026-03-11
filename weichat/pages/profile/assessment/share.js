// pages/profile/assessment/share.js
const api = require('../../../services/api');
const app = getApp();

Page({
  data: {
    loading: true,
    error: '',
    shareData: null,
    records: [],
    shareTime: '',
    playingId: null
  },

  _audioCtx: null,

  onLoad(options) {
    if (options.id) {
      this.loadShareData(options.id);
    } else {
      this.setData({ loading: false, error: '分享链接无效' });
    }
  },

  onUnload() {
    this._destroyAudio();
  },

  async loadShareData(shareId) {
    try {
      const res = await api.get(`/voice/share/${shareId}`);
      if (res.success) {
        const data = res.data;
        const records = (data.records || []).map(r => this.formatRecord(r));
        const d = new Date(data.created_at);
        const shareTime = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;

        this.setData({
          shareData: data,
          records,
          shareTime,
          loading: false
        });
      } else {
        this.setData({ loading: false, error: '分享记录不存在或已过期' });
      }
    } catch (e) {
      console.error('加载分享数据失败:', e);
      this.setData({ loading: false, error: '加载失败，请稍后重试' });
    }
  },

  formatRecord(r) {
    const score = parseFloat(r.overall_score) || 0;
    let scoreClass = 'score-low';
    if (score >= 90) scoreClass = 'score-excellent';
    else if (score >= 80) scoreClass = 'score-good';
    else if (score >= 60) scoreClass = 'score-medium';

    const d = new Date(r.created_at);
    const timeText = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    return {
      ...r,
      overall_score: Math.round(score),
      pronunciation_score: Math.round(parseFloat(r.pronunciation_score) || 0),
      fluency_score: Math.round(parseFloat(r.fluency_score) || 0),
      integrity_score: Math.round(parseFloat(r.integrity_score) || 0),
      scoreClass,
      timeText
    };
  },

  playAudio(e) {
    const { id, url } = e.currentTarget.dataset;
    if (!url) {
      wx.showToast({ title: '录音不可用', icon: 'none' });
      return;
    }

    if (this.data.playingId === id) {
      this._destroyAudio();
      this.setData({ playingId: null });
      return;
    }

    this._destroyAudio();
    this.setData({ playingId: id });

    const baseUrl = (app && app.globalData && app.globalData.baseUrl) || 'https://en.tajian.cc/api';
    const domain = baseUrl.replace(/\/api$/, '');
    const fullUrl = url.startsWith('http') ? url : domain + url;

    this._audioCtx = wx.createInnerAudioContext();
    this._audioCtx.src = fullUrl;
    this._audioCtx.onEnded(() => {
      this.setData({ playingId: null });
    });
    this._audioCtx.onError((err) => {
      console.error('播放失败:', err);
      this.setData({ playingId: null });
      wx.showToast({ title: '播放失败', icon: 'none' });
    });
    this._audioCtx.play();
  },

  _destroyAudio() {
    if (this._audioCtx) {
      this._audioCtx.stop();
      this._audioCtx.destroy();
      this._audioCtx = null;
    }
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    const { shareData } = this.data;
    return {
      title: `${shareData.nickname || '学习小达人'}的英语学习成就`,
      path: `/pages/profile/assessment/share?id=${shareData.share_id}`
    };
  }
});
