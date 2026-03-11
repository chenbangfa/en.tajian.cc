// pages/profile/profile.js
const app = getApp();
const api = require('../../services/api');

Page({
    data: {
        userInfo: null,
        stats: {
            wordsLearned: 0,
            masteredWords: 0,
            checkinDays: 0,
            consecutiveDays: 0
        }
    },

    onShow() {
        this.checkLogin();
    },

    checkLogin() {
        if (app.globalData.isLoggedIn) {
            this.setData({ userInfo: app.globalData.userInfo });
            this.loadStats();
        } else {
            this.setData({ userInfo: null });
        }
    },

    async loadStats() {
        try {
            const res = await api.get('/users/learning-progress');
            if (res.success) {
                this.setData({
                    stats: {
                        wordsLearned: res.data.words.total || 0,
                        masteredWords: res.data.words.mastered || 0,
                        checkinDays: res.data.checkin.total_days || 0,
                        consecutiveDays: res.data.checkin.consecutive_days || 0
                    }
                });
            }
        } catch (e) {
            console.error('加载统计失败:', e);
        }
    },

    async handleLogin() {
        try {
            wx.showLoading({ title: '登录中...' });
            await app.login();
            this.setData({ userInfo: app.globalData.userInfo });
            this.loadStats();
            wx.showToast({ title: '登录成功', icon: 'success' });
        } catch (e) {
            console.error('登录失败:', e);
            wx.showToast({ title: '登录失败', icon: 'none' });
        } finally {
            wx.hideLoading();
        }
    },

    goToCheckinHistory() {
        wx.navigateTo({ url: '/pages/checkin/checkin?tab=history' });
    },

    goToAssessmentHistory() {
        wx.navigateTo({ url: '/pages/profile/assessment/assessment' });
    },

    goToPoints() {
        wx.navigateTo({ url: '/pages/points/points' });
    },

    goToVip() {
        wx.navigateTo({ url: '/pages/vip/vip' });
    },

    goToSettings() {
        wx.navigateTo({ url: '/pages/profile/edit/edit' });
    },

    goToProfileEdit() {
        wx.navigateTo({ url: '/pages/profile/edit/edit' });
    },

    goToAbout() {
        wx.showToast({ title: '趣学英语 v1.0', icon: 'none' });
    }
});
