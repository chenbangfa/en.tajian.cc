const app = getApp();
const api = require('../../../services/api');

Page({
  data: {
    loading: false,
    enrolled: false,
    currentDay: 1,
    selectedDayNumber: 0,
    course: {},
    days: [],
    day: {},
    modules: [],
    summary: { required_count: 0, completed_required: 0, complete: false },
    typeLabels: {
      goal: '目标', vocabulary: '单词', pronunciation: '发音', grammar: '语法',
      grammar_drill: '语法闯关', listening: '听力', podcast_listening: '听力',
      shadowing: '跟读', speaking: '口语', speaking_output: '口语',
      writing: '写作', sentence_builder: '写作', typing_writing: '写作'
    }
  },

  onLoad() {
    this.loadOverview();
  },

  onShow() {
    this.loadOverview(true);
  },

  async loadOverview(silent = false) {
    if (!silent) wx.showLoading({ title: '加载中...' });
    this.setData({ loading: true });
    try {
      if (app.loginReady) {
        try { await app.loginReady; } catch (e) {}
      }
      const res = await api.get('/ielts/overview');
      if (res.success) {
        const currentDay = res.data.current_day || 1;
        this.setData({
          course: res.data.course || {},
          enrolled: !!res.data.enrolled,
          currentDay,
          selectedDayNumber: this.data.selectedDayNumber || currentDay,
          days: res.data.days || []
        });
        if (res.data.enrolled) {
          await this.loadDayDetail(this.data.selectedDayNumber || currentDay, true);
        } else {
          this.setData({ day: {}, modules: [], summary: { required_count: 0, completed_required: 0, complete: false } });
        }
      }
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
      if (!silent) wx.hideLoading();
    }
  },

  async startOrContinue() {
    if (!this.data.enrolled) {
      wx.showLoading({ title: '开启计划...' });
      try {
        const res = await api.post('/ielts/enroll');
        if (!res.success) {
          wx.showToast({ title: res.message || '开启失败', icon: 'none' });
          return;
        }
        await this.loadOverview(true);
      } catch (e) {
        wx.showToast({ title: '开启失败', icon: 'none' });
        return;
      } finally {
        wx.hideLoading();
      }
    }
    const day = this.data.currentDay || 1;
    this.setData({ selectedDayNumber: day });
    await this.loadDayDetail(day);
  },

  goDay(e) {
    const day = Number(e.currentTarget.dataset.day || 1);
    const locked = e.currentTarget.dataset.locked;
    if (locked) {
      wx.showToast({ title: '先完成前面的学习', icon: 'none' });
      return;
    }
    if (!this.data.enrolled) {
      this.startOrContinue();
      return;
    }
    this.setData({ selectedDayNumber: day });
    this.loadDayDetail(day);
  },

  async loadDayDetail(dayNumber, silent = false) {
    if (!this.data.enrolled) return;
    if (!silent) wx.showLoading({ title: '加载任务...' });
    try {
      const res = await api.get(`/ielts/days/${dayNumber}`);
      if (!res.success) {
        wx.showToast({ title: res.message || '加载失败', icon: 'none' });
        return;
      }
      const modules = (res.data.modules || []).map((module) => ({
        ...module,
        type_label: this.data.typeLabels[module.module_type] || module.module_type
      }));
      this.setData({
        day: res.data.day || {},
        modules,
        summary: res.data.summary || { required_count: 0, completed_required: 0, complete: false },
        selectedDayNumber: Number(dayNumber || 1)
      });
    } catch (e) {
      wx.showToast({ title: '加载任务失败', icon: 'none' });
    } finally {
      if (!silent) wx.hideLoading();
    }
  },

  openModuleTask(e) {
    const id = Number(e.currentTarget.dataset.id || 0);
    if (!id) return;
    wx.navigateTo({
      url: `/pages/ielts/task/task?day=${this.data.selectedDayNumber || this.data.currentDay || 1}&moduleId=${id}`
    });
  }
});
