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
        },
        showAbout: false,
        aboutTab: 'intro',
        baseUrl: '',
        avatarDisplayUrl: '/assets/images/default-avatar.png'
    },

    onLoad() {
        const baseUrl = (app.globalData.baseUrl || '').replace(/\/api$/, '');
        this.setData({ baseUrl });
    },

    async onShow() {
        if (!app.globalData.isLoggedIn && app.loginReady) {
            try { await app.loginReady; } catch (e) {}
        }
        this.checkLogin();
    },

    normalizeAvatarUrl(url) {
        if (!url) return '/assets/images/default-avatar.png';
        const value = String(url).trim();
        if (!value) return '/assets/images/default-avatar.png';
        if (/^https?:\/\//i.test(value) || value.startsWith('wxfile://')) return value;
        if (value.startsWith('/uploads/')) return this.data.baseUrl ? `${this.data.baseUrl}${value}` : value;
        return value;
    },

    async checkLogin() {
        if (app.globalData.isLoggedIn) {
            this.setData({
                userInfo: app.globalData.userInfo,
                avatarDisplayUrl: this.normalizeAvatarUrl(app.globalData.userInfo && app.globalData.userInfo.avatar_url)
            });
            this.refreshUserInfo();
            this.loadStats();
        } else {
            this.setData({ userInfo: null, avatarDisplayUrl: '/assets/images/default-avatar.png' });
        }
    },

    async refreshUserInfo() {
        try {
            const res = await api.get('/users/me');
            if (res.success && res.data) {
                app.globalData.userInfo = res.data;
                this.setData({
                    userInfo: res.data,
                    avatarDisplayUrl: this.normalizeAvatarUrl(res.data.avatar_url)
                });
            }
        } catch (e) {
            console.error('刷新用户资料失败:', e);
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
            this.setData({
                userInfo: app.globalData.userInfo,
                avatarDisplayUrl: this.normalizeAvatarUrl(app.globalData.userInfo && app.globalData.userInfo.avatar_url)
            });
            this.refreshUserInfo();
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
        wx.navigateTo({ url: '/pages/checkin/history/history' });
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

    goToGarden() {
        wx.navigateTo({ url: '/pages/reward/garden/garden' });
    },

    goToPromoterDashboard() {
        if (!this.data.userInfo || !this.data.userInfo.is_promoter) {
            wx.showToast({ title: '当前账号还不是推广员', icon: 'none' });
            return;
        }
        wx.navigateTo({ url: '/pages/promoter/dashboard/dashboard' });
    },

    goToPhotoRead() {
        const user = this.data.userInfo;
        if (!user || !user.vip_level || user.vip_level <= 0) {
            wx.showModal({
                title: 'VIP 专属功能',
                content: '拍摄点读为 VIP 专属功能，开通会员即可使用',
                confirmText: '去开通',
                cancelText: '取消',
                success: (res) => {
                    if (res.confirm) wx.navigateTo({ url: '/pages/vip/vip' });
                }
            });
            return;
        }
        wx.navigateTo({ url: '/pages/photo-read/index' });
    },

    goToAbout() {
        this.setData({ showAbout: true, aboutTab: 'intro' });
    },

    hideAbout() {
        this.setData({ showAbout: false });
    },

    switchAboutTab(e) {
        this.setData({ aboutTab: e.currentTarget.dataset.tab });
    },

    noop() { /* 阻止事件冒泡 */ }
});
