// pages/profile/assessment/assessment.js
const api = require('../../../services/api');
const app = getApp();

Page({
  data: {
    // 统计数据（全局）
    stats: {
      total_count: 0,
      avg_score: 0,
      max_score: 0,
      total_days: 0,
      month_days: 0,
      month_count: 0
    },
    // 日历
    calendarTitle: '',
    calendarDays: [],
    calendarYear: 0,
    calendarMonth: 0,
    calendarData: {},
    selectedDate: '',
    // 筛选
    activeFilter: 'all',
    // 列表
    records: [],
    page: 1,
    loading: false,
    loadingMore: false,
    noMore: false,
    // 音频播放
    playingId: null,
    // 海报
    showPoster: false,
    shareId: '',
    filteredStats: null  // 筛选后的统计（用于海报）
  },

  _audioCtx: null,

  onLoad() {
    const now = new Date();
    this.setData({
      calendarYear: now.getFullYear(),
      calendarMonth: now.getMonth() + 1
    });
    this.loadStats();
    this.loadCalendar();
    this.loadRecords(true);
  },

  onUnload() {
    this._destroyAudio();
  },

  onReachBottom() {
    if (!this.data.loadingMore && !this.data.noMore) {
      this.loadRecords(false);
    }
  },

  // ===== 数据加载 =====

  async loadStats() {
    try {
      const res = await api.get('/voice/stats');
      if (res.success) {
        this.setData({ stats: res.data });
      }
    } catch (e) {
      console.error('加载统计失败:', e);
    }
  },

  async loadCalendar() {
    const { calendarYear, calendarMonth } = this.data;
    const monthStr = `${calendarYear}-${String(calendarMonth).padStart(2, '0')}`;
    try {
      const res = await api.get('/voice/calendar', { month: monthStr });
      if (res.success) {
        const map = {};
        (res.data.days || []).forEach(d => {
          map[d.date] = { count: d.count, avg_score: d.avg_score };
        });
        this.setData({ calendarData: map });
        this.buildCalendar();
      }
    } catch (e) {
      console.error('加载日历失败:', e);
      this.buildCalendar();
    }
  },

  async loadRecords(reset) {
    if (this.data.loading) return;
    const page = reset ? 1 : this.data.page;
    this.setData({
      loading: true,
      loadingMore: !reset
    });

    const params = { page, limit: 20 };
    this._applyFilterParams(params);

    try {
      const res = await api.get('/voice/history', params);
      if (res.success) {
        const newRecords = (res.data.list || []).map(r => this.formatRecord(r));
        const total = res.data.pagination.total;
        const allRecords = reset ? newRecords : this.data.records.concat(newRecords);

        this.setData({
          records: allRecords,
          page: page + 1,
          noMore: allRecords.length >= total,
          loading: false,
          loadingMore: false
        });
      } else {
        this.setData({ loading: false, loadingMore: false });
      }
    } catch (e) {
      console.error('加载记录失败:', e);
      this.setData({ loading: false, loadingMore: false });
    }
  },

  // 将当前筛选条件应用到请求参数
  _applyFilterParams(params) {
    const { activeFilter, selectedDate } = this.data;
    if (activeFilter === '90') {
      params.min_score = 90;
    } else if (activeFilter === '80') {
      params.min_score = 80;
      params.max_score = 90;
    } else if (activeFilter === '60') {
      params.min_score = 60;
      params.max_score = 80;
    } else if (activeFilter === 'low') {
      params.max_score = 60;
    }
    if (selectedDate) {
      params.date = selectedDate;
    }
  },

  // ===== 日历构建 =====

  buildCalendar() {
    const { calendarYear, calendarMonth, calendarData, selectedDate } = this.data;
    const title = `${calendarYear}年${calendarMonth}月`;
    const firstDay = new Date(calendarYear, calendarMonth - 1, 1).getDay();
    const daysInMonth = new Date(calendarYear, calendarMonth, 0).getDate();

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    let maxCount = 0;
    Object.values(calendarData).forEach(d => {
      if (d.count > maxCount) maxCount = d.count;
    });

    const days = [];
    for (let i = 0; i < firstDay; i++) {
      days.push({ empty: true });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${calendarYear}-${String(calendarMonth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const info = calendarData[dateStr] || {};
      const count = info.count || 0;
      let heat = 0;
      if (count > 0 && maxCount > 0) {
        const ratio = count / maxCount;
        if (ratio <= 0.25) heat = 1;
        else if (ratio <= 0.5) heat = 2;
        else if (ratio <= 0.75) heat = 3;
        else heat = 4;
      }
      days.push({
        day: d,
        date: dateStr,
        count,
        heat,
        isToday: dateStr === todayStr,
        isSelected: dateStr === selectedDate
      });
    }

    this.setData({ calendarTitle: title, calendarDays: days });
  },

  prevMonth() {
    let { calendarYear, calendarMonth } = this.data;
    calendarMonth--;
    if (calendarMonth < 1) { calendarMonth = 12; calendarYear--; }
    this.setData({ calendarYear, calendarMonth, selectedDate: '' });
    this.loadCalendar();
    this.loadRecords(true);
  },

  nextMonth() {
    let { calendarYear, calendarMonth } = this.data;
    calendarMonth++;
    if (calendarMonth > 12) { calendarMonth = 1; calendarYear++; }
    this.setData({ calendarYear, calendarMonth, selectedDate: '' });
    this.loadCalendar();
    this.loadRecords(true);
  },

  onDayTap(e) {
    const { date, empty } = e.currentTarget.dataset;
    if (empty) return;
    const selected = this.data.selectedDate === date ? '' : date;
    this.setData({ selectedDate: selected });
    this.buildCalendar();
    this.loadRecords(true);
  },

  clearDateFilter() {
    this.setData({ selectedDate: '' });
    this.buildCalendar();
    this.loadRecords(true);
  },

  // ===== 筛选 =====

  setFilter(e) {
    const filter = e.currentTarget.dataset.filter;
    if (filter === this.data.activeFilter) return;
    this.setData({ activeFilter: filter });
    this.loadRecords(true);
  },

  // ===== 格式化 =====

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

  // ===== 音频播放 =====

  playAudio(e) {
    const { id, url } = e.currentTarget.dataset;
    if (!url) {
      wx.showToast({ title: '录音不可用', icon: 'none' });
      return;
    }

    // 如果正在播放同一条，则停止
    if (this.data.playingId === id) {
      this._destroyAudio();
      this.setData({ playingId: null });
      return;
    }

    this._destroyAudio();
    this.setData({ playingId: id });

    const baseUrl = (app && app.globalData && app.globalData.baseUrl) || 'https://en.tajian.cc/api';
    // 音频 URL 拼接：去掉 /api 后缀获取域名
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

  // ===== 分享与海报 =====

  async generatePoster() {
    wx.showLoading({ title: '生成中...' });

    // 1. 根据当前筛选条件获取统计并创建分享记录
    const shareParams = {};
    this._applyFilterParams(shareParams);

    try {
      const res = await api.post('/voice/share', shareParams);
      if (res.success) {
        this.setData({
          shareId: res.data.share_id,
          filteredStats: res.data.stats,
          filterDesc: res.data.filter_desc,
          showPoster: true
        });
        setTimeout(() => this.drawPoster(), 300);
      } else {
        wx.hideLoading();
        wx.showToast({ title: '生成失败', icon: 'none' });
      }
    } catch (e) {
      console.error('生成分享失败:', e);
      wx.hideLoading();
      wx.showToast({ title: '生成失败', icon: 'none' });
    }
  },

  drawPoster() {
    const ctx = wx.createCanvasContext('posterCanvas', this);
    const fStats = this.data.filteredStats || this.data.stats;
    const filterDesc = this.data.filterDesc || '全部评测';

    const W = 300;
    const H = 450;

    // 背景
    ctx.setFillStyle('#FFFFFF');
    ctx.fillRect(0, 0, W, H);

    // 顶部渐变装饰条
    const grd = ctx.createLinearGradient(0, 0, W, 90);
    grd.addColorStop(0, '#00B894');
    grd.addColorStop(1, '#0984E3');
    ctx.setFillStyle(grd);
    ctx.fillRect(0, 0, W, 90);

    // 标题
    ctx.setFillStyle('#FFFFFF');
    ctx.setFontSize(18);
    ctx.setTextAlign('center');
    ctx.fillText('趣学英语 · 学习成就', W / 2, 32);

    // 筛选条件标签
    ctx.setFontSize(11);
    ctx.setFillStyle('rgba(255,255,255,0.85)');
    ctx.fillText(filterDesc, W / 2, 52);

    // 日期
    const now = new Date();
    const dateStr = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    ctx.setFontSize(10);
    ctx.setFillStyle('rgba(255,255,255,0.6)');
    ctx.fillText(dateStr, W / 2, 72);

    // 分数大圆环
    const cx = W / 2;
    const cy = 160;
    const r = 45;

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.setStrokeStyle('#E8F5E9');
    ctx.setLineWidth(6);
    ctx.stroke();

    const avgScore = fStats.avg_score || 0;
    const scoreAngle = (avgScore / 100) * 2 * Math.PI;
    let scoreColor = '#FF6B6B';
    if (avgScore >= 90) scoreColor = '#00B894';
    else if (avgScore >= 80) scoreColor = '#0984E3';
    else if (avgScore >= 60) scoreColor = '#FF9F43';

    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + scoreAngle);
    ctx.setStrokeStyle(scoreColor);
    ctx.setLineWidth(6);
    ctx.setLineCap('round');
    ctx.stroke();

    ctx.setFillStyle('#2D3436');
    ctx.setFontSize(28);
    ctx.setTextAlign('center');
    ctx.fillText(String(avgScore), cx, cy + 8);

    ctx.setFontSize(10);
    ctx.setFillStyle('#B2BEC3');
    ctx.fillText('平均分', cx, cy + 24);

    // 统计网格
    const gridY = 235;
    const items = [
      { label: '总评测', value: String(fStats.total_count || 0) },
      { label: '最高分', value: String(fStats.max_score || 0) },
      { label: '打卡天数', value: String(fStats.total_days || 0) }
    ];
    const colW = W / 3;
    items.forEach((item, i) => {
      const x = colW * i + colW / 2;
      ctx.setFillStyle('#2D3436');
      ctx.setFontSize(18);
      ctx.setTextAlign('center');
      ctx.fillText(item.value, x, gridY);

      ctx.setFillStyle('#B2BEC3');
      ctx.setFontSize(9);
      ctx.fillText(item.label, x, gridY + 18);
    });

    // 分割线
    ctx.setStrokeStyle('#F1F2F6');
    ctx.setLineWidth(1);
    ctx.beginPath();
    ctx.moveTo(20, gridY + 38);
    ctx.lineTo(W - 20, gridY + 38);
    ctx.stroke();

    // 鼓励语
    const msgY = gridY + 65;
    ctx.setFillStyle('#636E72');
    ctx.setFontSize(12);
    ctx.setTextAlign('center');
    let msg = '继续加油！';
    if (avgScore >= 90) msg = '太棒了！你是英语之星！';
    else if (avgScore >= 80) msg = '非常优秀！保持这个势头！';
    else if (avgScore >= 60) msg = '表现不错，继续努力！';
    ctx.fillText(msg, W / 2, msgY);

    // 提示扫码
    ctx.setFillStyle('#B2BEC3');
    ctx.setFontSize(9);
    ctx.fillText('打开趣学英语小程序查看详情', W / 2, msgY + 22);

    // 底部装饰
    ctx.setFillStyle('#F8F9FA');
    ctx.fillRect(0, H - 45, W, 45);
    ctx.setFillStyle('#B2BEC3');
    ctx.setFontSize(10);
    ctx.setTextAlign('center');
    ctx.fillText('— 趣学英语 —', W / 2, H - 18);

    ctx.draw(false, () => {
      wx.hideLoading();
    });
  },

  savePoster() {
    wx.canvasToTempFilePath({
      canvasId: 'posterCanvas',
      success: (res) => {
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => {
            wx.showToast({ title: '已保存到相册', icon: 'success' });
          },
          fail: (err) => {
            if (err.errMsg.indexOf('auth deny') !== -1 || err.errMsg.indexOf('authorize') !== -1) {
              wx.showModal({
                title: '提示',
                content: '需要授权保存到相册权限',
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

  onShareAppMessage() {
    const { shareId, filteredStats, stats, filterDesc } = this.data;
    const s = filteredStats || stats;
    const title = filterDesc && filterDesc !== '全部评测'
      ? `我的${filterDesc}成绩：平均${s.avg_score}分，共${s.total_count}次评测！`
      : `我在趣学英语已评测${s.total_count}次，平均分${s.avg_score}分！`;

    return {
      title,
      path: shareId
        ? `/pages/profile/assessment/share?id=${shareId}`
        : '/pages/index/index'
    };
  }
});
