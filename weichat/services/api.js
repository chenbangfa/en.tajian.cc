/**
 * API服务封装
 */

// 默认API地址
const DEFAULT_BASE_URL = 'https://english.tajian.cc/api';
const REQUEST_TIMEOUT = 10000;
const UPLOAD_TIMEOUT = 30000;

// 单次请求（内部使用）
function _doRequest(options) {
    return new Promise((resolve, reject) => {
        const app = getApp();
        const baseUrl = (app && app.globalData && app.globalData.baseUrl) || DEFAULT_BASE_URL;
        const token = wx.getStorageSync('token');

        wx.request({
            url: baseUrl + options.url,
            method: options.method || 'GET',
            data: options.data,
            timeout: options.timeout || REQUEST_TIMEOUT,
            header: {
                'Content-Type': 'application/json',
                'Authorization': token ? `Bearer ${token}` : ''
            },
            success: (res) => {
                if (res.statusCode === 200) {
                    resolve(res.data);
                } else if (res.statusCode === 401) {
                    wx.removeStorageSync('token');
                    if (app && app.globalData) {
                        app.globalData.isLoggedIn = false;
                        app.globalData.userInfo = null;
                    }
                    if (!options.silent) {
                        wx.showToast({ title: '请重新登录', icon: 'none' });
                    }
                    reject(new Error('未授权'));
                } else {
                    reject(res.data);
                }
            },
            fail: (err) => {
                reject(err);
            }
        });
    });
}

// 请求拦截（含自动重试，应对首次连接 ERR_CONNECTION_CLOSED）
const MAX_RETRIES = 2;

function request(options) {
    let attempt = 0;
    const tryRequest = () => {
        attempt++;
        return _doRequest(options).catch((err) => {
            const msg = (err && err.errMsg) || '';
            const isNetworkError = msg.includes('request:fail') || msg.includes('ERR_CONNECTION');
            if (isNetworkError && attempt <= MAX_RETRIES) {
                return tryRequest();
            }
            console.error('请求失败:', err);
            if (!options.silent) {
                wx.showToast({ title: '网络请求失败', icon: 'none' });
            }
            throw err;
        });
    };
    return tryRequest();
}

// GET请求
function get(url, data = {}) {
    return request({ url, method: 'GET', data });
}

// POST请求
function post(url, data = {}) {
    return request({ url, method: 'POST', data });
}

// PUT请求
function put(url, data = {}) {
    return request({ url, method: 'PUT', data });
}

// DELETE请求
function del(url, data = {}) {
    return request({ url, method: 'DELETE', data });
}

// 上传文件
function upload(url, filePath, formData = {}, fieldName = 'audio') {
    return new Promise((resolve, reject) => {
        const app = getApp();
        const baseUrl = (app && app.globalData && app.globalData.baseUrl) || DEFAULT_BASE_URL;
        const token = wx.getStorageSync('token');

        wx.uploadFile({
            url: baseUrl + url,
            filePath,
            name: fieldName,
            formData,
            timeout: UPLOAD_TIMEOUT,
            header: {
                'Authorization': token ? `Bearer ${token}` : ''
            },
            success: (res) => {
                console.log('[upload]', {
                    url: baseUrl + url,
                    statusCode: res.statusCode
                });
                const rawData = res.data;
                const parseUploadResponse = () => {
                    if (typeof rawData === 'object' && rawData !== null) {
                        return rawData;
                    }
                    if (typeof rawData !== 'string') {
                        throw new Error('响应格式异常');
                    }
                    // 标准 JSON
                    try {
                        return JSON.parse(rawData);
                    } catch (_) {
                        // 兼容服务端前后混入日志/HTML 时，尝试提取 JSON 主体
                        const first = rawData.indexOf('{');
                        const last = rawData.lastIndexOf('}');
                        if (first !== -1 && last > first) {
                            return JSON.parse(rawData.slice(first, last + 1));
                        }
                        throw new Error('响应非JSON');
                    }
                };

                try {
                    const data = parseUploadResponse();
                    if (res.statusCode === 200) {
                        resolve(data);
                    } else if (res.statusCode === 401) {
                        wx.removeStorageSync('token');
                        if (app && app.globalData) {
                            app.globalData.isLoggedIn = false;
                            app.globalData.userInfo = null;
                        }
                        resolve({ success: false, message: data.message || '请先登录' });
                    } else {
                        // 403 (积分不足等) 或其他错误，保留服务器返回的 message
                        resolve({ success: false, message: data.message || '请求失败' });
                    }
                } catch (e) {
                    const preview = typeof rawData === 'string' ? rawData.slice(0, 400) : rawData;
                    console.error('上传响应解析失败:', e, res.statusCode, preview);
                    const text = typeof rawData === 'string' ? rawData : '';
                    if (text.includes('任务不存在')) {
                        resolve({ success: false, message: '任务不存在，请返回刷新后重试' });
                        return;
                    }
                    if (res.statusCode === 524) {
                        resolve({ success: false, message: '网关超时(524)，评测服务响应过慢，请稍后重试' });
                        return;
                    }
                    if (res.statusCode >= 500) {
                        resolve({ success: false, message: `服务器异常(${res.statusCode})，请稍后重试` });
                    } else if (res.statusCode >= 400) {
                        resolve({ success: false, message: `请求异常(${res.statusCode})，请重试` });
                    } else {
                        resolve({ success: false, message: '服务器响应异常' });
                    }
                }
            },
            fail: (err) => {
                console.error('上传网络错误:', err);
                resolve({ success: false, message: '网络连接失败，请检查网络' });
            }
        });
    });
}

module.exports = {
    request,
    get,
    post,
    put,
    del,
    upload
};
