// app.js
const api = require('./services/api');

App({
  onLaunch() {
    // 检查登录状态
    this.checkLogin();

    // 获取系统信息
    const systemInfo = wx.getSystemInfoSync();
    this.globalData.systemInfo = systemInfo;
    this.globalData.statusBarHeight = systemInfo.statusBarHeight;
    this.globalData.isIPhoneX = systemInfo.model.indexOf('iPhone X') > -1 ||
      systemInfo.model.indexOf('iPhone 1') > -1;
  },

  // 检查登录状态，如果没有token则自动登录
  async checkLogin() {
    const token = wx.getStorageSync('token');
    if (token) {
      try {
        // 验证token有效性
        const res = await api.get('/users/me');
        if (res.success) {
          this.globalData.userInfo = res.data;
          this.globalData.isLoggedIn = true;
        } else {
          // token失效，重新登录
          await this.login();
        }
      } catch (e) {
        console.error('Token验证失败:', e);
        // 验证失败也尝试重新登录
        await this.login();
      }
    } else {
      // 没有token，自动登录获取openid
      try {
        await this.login();
        console.log('自动登录成功');
      } catch (e) {
        console.error('自动登录失败:', e);
      }
    }
  },

  // 登录
  async login() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: async (res) => {
          if (res.code) {
            try {
              const loginRes = await api.post('/auth/login', { code: res.code });
              if (loginRes.success) {
                wx.setStorageSync('token', loginRes.data.token);
                this.globalData.userInfo = loginRes.data.user;
                this.globalData.isLoggedIn = true;
                resolve(loginRes.data);
              } else {
                // 微信登录失败，尝试 dev-login
                console.warn('微信登录失败，尝试开发登录');
                await this.devLogin(resolve, reject);
              }
            } catch (e) {
              console.warn('登录异常，尝试开发登录:', e);
              await this.devLogin(resolve, reject);
            }
          } else {
            reject(new Error('获取登录code失败'));
          }
        },
        fail: reject
      });
    });
  },

  // 开发环境登录（备用）
  async devLogin(resolve, reject) {
    try {
      const loginRes = await api.post('/auth/dev-login', { openid: 'mini_program_user_' + Date.now() });
      if (loginRes.success) {
        wx.setStorageSync('token', loginRes.data.token);
        this.globalData.userInfo = loginRes.data.user;
        this.globalData.isLoggedIn = true;
        console.log('开发登录成功');
        resolve(loginRes.data);
      } else {
        reject(new Error(loginRes.message || '开发登录失败'));
      }
    } catch (e) {
      reject(e);
    }
  },

  // 登出
  logout() {
    wx.removeStorageSync('token');
    this.globalData.userInfo = null;
    this.globalData.isLoggedIn = false;
  },

  globalData: {
    userInfo: null,
    isLoggedIn: false,
    systemInfo: null,
    statusBarHeight: 0,
    isIPhoneX: false,
    // API基础地址
    baseUrl: 'https://en.tajian.cc/api'
  }
});
