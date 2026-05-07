// app.js
const api = require('./services/api');
const AUTH_REQUEST_TIMEOUT = 10000;

App({
  onLaunch(options = {}) {
    // 获取系统信息
    const systemInfo = wx.getSystemInfoSync();
    this.globalData.systemInfo = systemInfo;
    this.globalData.statusBarHeight = systemInfo.statusBarHeight;
    this.globalData.isIPhoneX = systemInfo.model.indexOf('iPhone X') > -1 ||
      systemInfo.model.indexOf('iPhone 1') > -1;

    this.capturePromotionLaunchOptions(options);

    // 检查登录状态（保存 promise，供各页面 await 等待登录完成）
    this.loginReady = this.checkLogin();
  },

  onShow(options = {}) {
    this.capturePromotionLaunchOptions(options);
    if (this.globalData.isLoggedIn) {
      this.bindPendingPromoter();
    }
  },

  requestAuth(url, data = {}) {
    const baseUrl = this.globalData.baseUrl;
    const doRequest = () => new Promise((resolve, reject) => {
      wx.request({
        url: baseUrl + url,
        method: 'POST',
        data,
        timeout: AUTH_REQUEST_TIMEOUT,
        header: { 'Content-Type': 'application/json' },
        success: (res) => {
          if (res.statusCode === 200) {
            resolve(res.data);
          } else {
            reject(res.data || new Error(`HTTP ${res.statusCode}`));
          }
        },
        fail: reject
      });
    });
    // 网络层自动重试（应对 ERR_CONNECTION_CLOSED）
    let attempt = 0;
    const tryRequest = () => {
      attempt++;
      return doRequest().catch((err) => {
        const msg = (err && err.errMsg) || '';
        if ((msg.includes('request:fail') || msg.includes('ERR_CONNECTION')) && attempt <= 2) {
          return tryRequest();
        }
        throw err;
      });
    };
    return tryRequest();
  },

  isDevtools() {
    const systemInfo = this.globalData.systemInfo || {};
    return systemInfo.platform === 'devtools';
  },

  canUseDevLogin() {
    if (!this.isDevtools() || !this.globalData.enableDevLogin) return false;
    const baseUrl = String(this.globalData.baseUrl || '');
    return /localhost|127\.0\.0\.1|192\.168\.|10\.0\.|172\.(1[6-9]|2\d|3[01])\./.test(baseUrl);
  },

  isTimeoutOrNetworkError(error) {
    const msg = String((error && (error.errMsg || error.message)) || error || '').toLowerCase();
    return msg.includes('timeout') || msg.includes('request:fail') || msg.includes('err_connection');
  },

  safeDecode(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
  },

  normalizePromoterCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 32);
  },

  extractPromoterCodeFromOptions(options = {}) {
    const query = options.query || {};
    const direct = query.promoter_code || query.promoterCode || query.pm || query.p || query.code;
    if (direct) return this.normalizePromoterCode(direct);

    const scene = this.safeDecode(query.scene || '');
    if (!scene) return '';
    if (/^PM[A-Z0-9]{6,}$/i.test(scene)) {
      return this.normalizePromoterCode(scene);
    }

    const params = {};
    scene.split('&').forEach((pair) => {
      const parts = pair.split('=');
      const key = (parts.shift() || '').trim();
      if (!key) return;
      params[key] = parts.join('=').trim();
    });

    return this.normalizePromoterCode(
      params.pm ||
      params.p ||
      params.promoter_code ||
      params.promoterCode ||
      params.code ||
      ''
    );
  },

  capturePromotionLaunchOptions(options = {}) {
    const code = this.extractPromoterCodeFromOptions(options);
    if (!code) return;
    this.globalData.pendingPromoterCode = code;
    wx.setStorageSync('pending_promoter_code', code);
  },

  async bindPendingPromoter() {
    const code = this.globalData.pendingPromoterCode || wx.getStorageSync('pending_promoter_code');
    const token = wx.getStorageSync('token');
    if (!code || !token || !this.globalData.isLoggedIn) return;
    if (this.globalData.bindingPromoterCode === code) return;

    this.globalData.bindingPromoterCode = code;
    try {
      const res = await api.request({
        url: '/promotion/bind',
        method: 'POST',
        data: { promoter_code: code },
        silent: true
      });

      if (res && res.success) {
        this.globalData.pendingPromoterCode = '';
        wx.removeStorageSync('pending_promoter_code');
      }
    } catch (e) {
      console.warn('推广关系自动绑定失败:', e);
    } finally {
      this.globalData.bindingPromoterCode = '';
    }
  },

  // 检查登录状态，如果没有token则自动登录
  async checkLogin() {
    const token = wx.getStorageSync('token');
    if (token) {
      try {
        // 验证token有效性
        const res = await api.request({
          url: '/users/me',
          method: 'GET',
          silent: true
        });
        if (res.success) {
          this.globalData.userInfo = res.data;
          this.globalData.isLoggedIn = true;
          await this.bindPendingPromoter();
        } else {
          // token失效，重新登录
          await this.login();
        }
      } catch (e) {
        if (this.isTimeoutOrNetworkError(e)) {
          console.warn('Token验证暂时失败，保留本地登录态，稍后页面请求会自动重试:', e);
          return;
        }
        console.warn('Token验证失败，准备重新登录:', e);
        // 验证失败也尝试重新登录
        await this.login();
      }
    } else {
      // 没有token，自动登录获取openid
      try {
        await this.login();
        console.log('自动登录成功');
      } catch (e) {
        if (this.isTimeoutOrNetworkError(e)) {
          console.warn('自动登录暂时超时，已跳过本次启动登录:', e);
        } else {
          console.warn('自动登录失败:', e);
        }
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
              const loginRes = await this.requestAuth('/auth/login', { code: res.code });
              if (loginRes.success) {
                wx.setStorageSync('token', loginRes.data.token);
                this.globalData.userInfo = loginRes.data.user;
                this.globalData.isLoggedIn = true;
                await this.bindPendingPromoter();
                resolve(loginRes.data);
              } else {
                if (this.canUseDevLogin()) {
                  console.warn('微信登录失败，开发者工具本地环境尝试 dev-login');
                  await this.devLogin(resolve, reject);
                } else {
                  reject(new Error(loginRes.message || '微信登录失败'));
                }
              }
            } catch (e) {
              if (this.canUseDevLogin()) {
                console.warn('登录异常，开发者工具本地环境尝试 dev-login:', e);
                await this.devLogin(resolve, reject);
              } else {
                reject(e);
              }
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
      const loginRes = await this.requestAuth('/auth/dev-login', { openid: 'mini_program_user_' + Date.now() });
      if (loginRes.success) {
        wx.setStorageSync('token', loginRes.data.token);
        this.globalData.userInfo = loginRes.data.user;
        this.globalData.isLoggedIn = true;
        await this.bindPendingPromoter();
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
    baseUrl: 'https://english.tajian.cc/api',
    enableDevLogin: false,
    pendingPromoterCode: '',
    bindingPromoterCode: ''
  }
});
