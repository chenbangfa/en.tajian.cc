// pages/checkin/share/share.js
const api = require('../../../services/api');
const app = getApp();

Page({
  data: {
    loading: true,
    error: null,
    shareData: null,
    shareId: '',
    formatDate: '',
    completedCount: 0,
    playingId: -1
  },

  _audioCtx: null,

  onLoad(options) {
    if (options.shareId) {
      this.setData({ shareId: options.shareId });
      this.loadShareData(options.shareId);
    } else {
      this.setData({ loading: false, error: '无效的分享链接' });
    }
  },

  onUnload() {
    this._destroyAudio();
  },

  async loadShareData(shareId) {
    try {
      const res = await api.get(`/checkin/share/${shareId}`);
      if (res.success) {
        const data = res.data;
        const baseUrl = (app.globalData.baseUrl || '').replace(/\/api$/, '');

        // 补全所有资源URL
        (data.items || []).forEach(item => {
          const info = item.extra_info || {};
          ['image_url', 'audio_female', 'audio_male', 'audio_url_female', 'audio_url_male',
           'scene_image', 'male_audio_url', 'female_audio_url'].forEach(key => {
            if (info[key] && typeof info[key] === 'string' && info[key].startsWith('/')) {
              info[key] = baseUrl + info[key];
            }
          });
          // 补全用户录音URL
          if (item.audio_url && item.audio_url.startsWith('/')) {
            item.audio_url = baseUrl + item.audio_url;
          }
          item.extra_info = info;
        });

        // 补全头像URL
        if (data.avatar_url && data.avatar_url.startsWith('/')) {
          data.avatar_url = baseUrl + data.avatar_url;
        }

        const completedCount = (data.items || []).filter(i => i.status === 'completed').length;

        // 格式化日期
        let formatDate = '';
        if (data.task_date) {
          const d = new Date(data.task_date);
          formatDate = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
        }

        this.setData({
          loading: false,
          shareData: data,
          formatDate,
          completedCount
        });
      } else {
        this.setData({ loading: false, error: res.message || '加载失败' });
      }
    } catch (e) {
      console.error('加载分享数据失败:', e);
      this.setData({ loading: false, error: '加载失败，请稍后再试' });
    }
  },

  playAudio(e) {
    const index = e.currentTarget.dataset.index;
    const url = e.currentTarget.dataset.url;

    if (this.data.playingId === index) {
      // 停止播放
      this._destroyAudio();
      this.setData({ playingId: -1 });
      return;
    }

    this._destroyAudio();
    this._audioCtx = wx.createInnerAudioContext();
    this._audioCtx.src = url;

    this._audioCtx.onEnded(() => {
      this.setData({ playingId: -1 });
    });
    this._audioCtx.onError(() => {
      this.setData({ playingId: -1 });
      wx.showToast({ title: '播放失败', icon: 'none' });
    });

    this.setData({ playingId: index });
    this._audioCtx.play();
  },

  _destroyAudio() {
    if (this._audioCtx) {
      try { this._audioCtx.stop(); this._audioCtx.destroy(); } catch (e) {}
      this._audioCtx = null;
    }
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onShareAppMessage() {
    const { shareData, shareId } = this.data;
    return {
      title: `${shareData.nickname || '学习达人'}今日打卡，平均${shareData.avg_score || 0}分！快来看看`,
      path: `/pages/checkin/share/share?shareId=${shareId}`
    };
  }
});
