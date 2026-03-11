// pages/index/index.js
const app = getApp();
const api = require('../../services/api');

Page({
  data: {
    userInfo: null,
    stats: {
      wordsLearned: 0,
      checkinDays: 0
    },
    todayChecked: false,
    taskProgress: 0,
    taskCompleted: 0,
    taskTotal: 0,
    recommendWords: []
  },

  onLoad() {
    this.loadData();
  },

  onShow() {
    if (app.globalData.userInfo) {
      this.setData({ userInfo: app.globalData.userInfo });
      this.loadUserStats();
    }
  },

  async loadData() {
    // 加载推荐单词
    try {
      const res = await api.get('/words/random/6');
      if (res.success) {
        // 处理图片URL，添加完整域名
        const words = res.data.map(word => ({
          ...word,
          image_url: this.getFullImageUrl(word.image_url)
        }));
        this.setData({ recommendWords: words });
      }
    } catch (e) {
      console.error('加载推荐单词失败:', e);
    }
  },

  // 获取完整图片URL
  getFullImageUrl(url) {
    if (!url) return '/assets/images/placeholder.png';
    // 如果已经是完整URL，直接返回
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    // 相对路径，添加域名前缀
    const baseUrl = 'https://en.tajian.cc';
    return baseUrl + (url.startsWith('/') ? url : '/' + url);
  },

  async loadUserStats() {
    try {
      const res = await api.get('/users/learning-progress');
      if (res.success) {
        this.setData({
          stats: {
            wordsLearned: res.data.words.total || 0,
            checkinDays: res.data.checkin.total_days || 0
          }
        });
      }

      // 检查今日打卡状态
      const checkinRes = await api.get('/checkin/today');
      if (checkinRes.success) {
        const d = checkinRes.data;
        const completed = d.progress ? d.progress.completed : 0;
        const total = d.progress ? d.progress.total : 0;
        this.setData({
          todayChecked: d.checked_in_today,
          taskCompleted: completed,
          taskTotal: total,
          taskProgress: total > 0 ? Math.round((completed / total) * 100) : 0,
          stats: {
            ...this.data.stats,
            checkinDays: d.consecutive_days || this.data.stats.checkinDays
          }
        });
      }
    } catch (e) {
      console.error('加载用户统计失败:', e);
    }
  },

  // 导航函数
  goToVocabulary() {
    wx.switchTab({ url: '/pages/vocabulary/vocabulary' });
  },

  goToScene() {
    wx.navigateTo({ url: '/pages/scene/scene' });
  },

  goToCamera() {
    wx.navigateTo({ url: '/pages/camera/camera' });
  },

  goToAssessment() {
    wx.navigateTo({ url: '/pages/assessment/assessment' });
  },

  goToCheckin() {
    wx.navigateTo({ url: '/pages/checkin/checkin' });
  },

  goToPodcast() {
    wx.switchTab({ url: '/pages/podcast/podcast' });
  },

  goToWordDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/vocabulary/detail/detail?id=${id}` });
  }
});
