// pages/vocabulary/detail/detail.js
const api = require('../../../services/api');
const recorderManager = wx.getRecorderManager();

Page({
    data: {
        word: null,
        loading: true,
        currentVoice: 'female', // 'female' or 'male'
        wordList: [], // 用于上一个/下一个切换
        currentIndex: -1,
        // 评测相关
        isRecording: false,
        recordingTime: 0,
        audioPath: '',
        showResult: false,
        assessResult: null,
        isAssessing: false,
        // 打卡模式
        checkinMode: false,
        checkinTaskId: null,
        checkinResult: null  // 打卡模式下的完成结果
    },

    recordTimer: null,
    _assessingLock: false,

    onLoad(options) {
        // 检查是否打卡模式
        if (options.checkin_task_id) {
            this.setData({
                checkinMode: true,
                checkinTaskId: options.checkin_task_id
            });
            wx.setNavigationBarTitle({ title: '每日打卡 · 跟读' });
        }

        if (options.id) {
            this.loadWord(options.id);
            // 从全局获取单词列表用于切换（仅非打卡模式）
            if (!options.checkin_task_id) {
                const pages = getCurrentPages();
                if (pages.length >= 2) {
                    const prevPage = pages[pages.length - 2];
                    if (prevPage.data && prevPage.data.words) {
                        const wordList = prevPage.data.words;
                        const currentIndex = wordList.findIndex(w => w.id == options.id);
                        this.setData({ wordList, currentIndex });
                    }
                }
            }
        }

        // 绑定录音回调
        this._bindRecorder();
    },

    onShow() {
        // 从其他页面返回时重新绑定录音回调（防止被其他页面覆盖）
        this._bindRecorder();
    },

    onUnload() {
        if (this.recordTimer) {
            clearInterval(this.recordTimer);
        }
    },

    _bindRecorder() {
        if (typeof recorderManager.offStop === 'function') recorderManager.offStop();
        if (typeof recorderManager.offError === 'function') recorderManager.offError();
        recorderManager.onStop((res) => {
            if (this._assessingLock) return;
            this.setData({ audioPath: res.tempFilePath, isRecording: false, recordingTime: 0 });
            if (this.recordTimer) {
                clearInterval(this.recordTimer);
                this.recordTimer = null;
            }
            this.submitAssessment(res.tempFilePath);
        });
        recorderManager.onError((err) => {
            console.error('录音错误:', err);
            this.setData({ isRecording: false, recordingTime: 0 });
            wx.showToast({ title: '录音失败', icon: 'none' });
        });
    },

    async loadWord(id) {
        try {
            const res = await api.get(`/words/${id}`);
            if (res.success) {
                const word = this._processUrls(res.data);

                this.setData({
                    word,
                    loading: false,
                    showResult: false,
                    assessResult: null,
                    audioPath: ''
                });
                wx.setNavigationBarTitle({ title: word.word });

                // 检查是否缺失音频，如果缺失则后台触发生成
                this._ensureAudio(word);
            }
        } catch (e) {
            console.error('加载单词失败:', e);
            wx.showToast({ title: '加载失败', icon: 'none' });
        }
    },

    /**
     * 处理所有相对URL为绝对URL
     */
    _processUrls(word) {
        const app = getApp();
        const baseUrl = app.globalData.baseUrl.replace('/api', '');
        const urlFields = ['image_url', 'audio_url_female', 'audio_url_male', 'example_audio_female', 'example_audio_male'];
        urlFields.forEach(field => {
            if (word[field] && word[field].startsWith('/')) {
                word[field] = baseUrl + word[field];
            }
        });
        return word;
    },

    /**
     * 检查并自动生成缺失的音频
     * 后台异步调用，不阻塞页面。生成完成后轮询刷新音频URL。
     */
    async _ensureAudio(word) {
        const hasFemale = !!word.audio_url_female;
        const hasMale = !!word.audio_url_male;
        const hasExFemale = !!word.example_audio_female;
        const hasExMale = !!word.example_audio_male;
        const hasExample = !!word.example_sentence;

        // 如果所有音频都有，不需要生成
        const allComplete = hasFemale && hasMale && (!hasExample || (hasExFemale && hasExMale));
        if (allComplete) return;

        console.log(`[AutoAudio] 单词 "${word.word}" 缺少音频，触发后台生成`);

        try {
            const res = await api.post(`/words/${word.id}/ensure-audio`);
            if (res.success && res.generating && res.generating.length > 0) {
                // 后台正在生成，延迟后轮询刷新
                this._pollForAudioUpdate(word.id, res.generating.length);
            }
        } catch (e) {
            console.log('[AutoAudio] 触发生成失败:', e);
        }
    },

    /**
     * 轮询获取更新后的音频URL
     * 根据要生成的数量，设定合理的轮询间隔和次数
     */
    _pollForAudioUpdate(wordId, count) {
        // 有道TTS约2s/个，4个音频约8-10s
        const firstDelay = 4000;      // 首次等4秒
        const pollInterval = 4000;    // 之后每4秒查一次
        const maxPolls = Math.min(count * 2 + 2, 8); // 最多轮询次数
        let pollCount = 0;

        const doPoll = () => {
            // 如果页面已经切换到其他单词，停止轮询
            if (!this.data.word || this.data.word.id !== wordId) return;

            pollCount++;
            console.log(`[AutoAudio] 轮询 #${pollCount}/${maxPolls} (word#${wordId})`);

            api.get(`/words/${wordId}`).then(res => {
                if (res.success) {
                    const updatedWord = this._processUrls(res.data);
                    const currentWord = this.data.word;

                    // 检查是否有新的音频URL
                    let hasNew = false;
                    const audioFields = ['audio_url_female', 'audio_url_male', 'example_audio_female', 'example_audio_male'];
                    audioFields.forEach(field => {
                        if (updatedWord[field] && !currentWord[field]) {
                            hasNew = true;
                        }
                    });

                    if (hasNew) {
                        // 更新页面数据（保留其他状态）
                        this.setData({
                            'word.audio_url_female': updatedWord.audio_url_female || currentWord.audio_url_female,
                            'word.audio_url_male': updatedWord.audio_url_male || currentWord.audio_url_male,
                            'word.example_audio_female': updatedWord.example_audio_female || currentWord.example_audio_female,
                            'word.example_audio_male': updatedWord.example_audio_male || currentWord.example_audio_male,
                        });
                        console.log(`[AutoAudio] 音频已更新 (word#${wordId})`);
                    }

                    // 检查是否全部完成
                    const allDone = updatedWord.audio_url_female && updatedWord.audio_url_male &&
                        (!updatedWord.example_sentence || (updatedWord.example_audio_female && updatedWord.example_audio_male));

                    if (allDone || pollCount >= maxPolls) {
                        if (allDone) console.log(`[AutoAudio] 全部音频就绪 (word#${wordId})`);
                        return; // 停止轮询
                    }

                    // 继续轮询
                    setTimeout(doPoll, pollInterval);
                }
            }).catch(() => {});
        };

        // 首次延迟后开始轮询
        setTimeout(doPoll, firstDelay);
    },

    // 直接播放指定声音
    playVoice(e) {
        const voice = e.currentTarget.dataset.voice;
        this.setData({ currentVoice: voice }); // 依然更新选中状态，用于高亮

        const { word } = this.data;
        const audioUrl = voice === 'male' ? word.audio_url_male : word.audio_url_female;

        if (audioUrl) {
            const audio = wx.createInnerAudioContext();
            audio.src = audioUrl;
            audio.play();
        } else {
            wx.showToast({ title: `暂无${voice === 'male' ? '男' : '女'}声音频`, icon: 'none' });
        }
    },

    // 播放单词音频
    playAudio() {
        const { word, currentVoice } = this.data;
        const audioUrl = currentVoice === 'male' ? word.audio_url_male : word.audio_url_female;

        if (audioUrl) {
            const audio = wx.createInnerAudioContext();
            audio.src = audioUrl;
            audio.play();
            audio.onError((err) => {
                console.error('音频播放错误:', err);
                wx.showToast({ title: '播放失败', icon: 'none' });
            });
        } else {
            wx.showToast({ title: `暂无${currentVoice === 'male' ? '男' : '女'}声音频`, icon: 'none' });
        }
    },

    // 播放例句音频（旧方法保留兼容）
    playSentence() {
        const { word, currentVoice } = this.data;
        const audioUrl = currentVoice === 'male' ? word.example_audio_male : word.example_audio_female;

        if (audioUrl) {
            const audio = wx.createInnerAudioContext();
            audio.src = audioUrl;
            audio.play();
        } else {
            wx.showToast({ title: `暂无例句${currentVoice === 'male' ? '男' : '女'}声`, icon: 'none' });
        }
    },

    // 播放例句音频（指定声音）
    playExampleSentence(e) {
        const voice = e.currentTarget.dataset.voice;
        const { word } = this.data;
        const audioUrl = voice === 'male' ? word.example_audio_male : word.example_audio_female;

        if (audioUrl) {
            const audio = wx.createInnerAudioContext();
            audio.src = audioUrl;
            audio.play();
        } else {
            wx.showToast({ title: `暂无例句${voice === 'male' ? '男' : '女'}声音频`, icon: 'none' });
        }
    },

    // 切换录音状态 (点击开始/停止)
    toggleRecord() {
        if (this.data.isAssessing) {
            return; // 评测中不允许操作
        }

        if (this.data.isRecording) {
            // 正在录音 -> 停止录音
            recorderManager.stop();
        } else {
            // 未录音 -> 先检查录音权限再开始
            this._checkRecordPermission();
        }
    },

    // 检查录音权限并开始录音
    _checkRecordPermission() {
        wx.getSetting({
            success: (res) => {
                const recordAuth = res.authSetting['scope.record'];

                if (recordAuth === true) {
                    // 已授权，直接开始录音
                    this._startRecord();
                } else if (recordAuth === false) {
                    // 曾被拒绝过，引导用户去设置页手动开启
                    wx.showModal({
                        title: '录音权限已关闭',
                        content: '语音跟读需要录音权限，请在设置中开启"麦克风"权限',
                        confirmText: '去设置',
                        cancelText: '取消',
                        success: (modalRes) => {
                            if (modalRes.confirm) {
                                wx.openSetting({
                                    success: (settingRes) => {
                                        if (settingRes.authSetting['scope.record']) {
                                            // 用户在设置页开启了权限
                                            this._startRecord();
                                        }
                                    }
                                });
                            }
                        }
                    });
                } else {
                    // 首次请求（undefined），调用 wx.authorize 触发系统授权弹窗
                    wx.authorize({
                        scope: 'scope.record',
                        success: () => {
                            this._startRecord();
                        },
                        fail: () => {
                            // 用户拒绝了首次授权
                            wx.showToast({ title: '需要录音权限', icon: 'none' });
                        }
                    });
                }
            },
            fail: () => {
                wx.showToast({ title: '获取权限状态失败', icon: 'none' });
            }
        });
    },

    // 开始录音
    _startRecord() {
        this.setData({ isRecording: true, recordingTime: 0, showResult: false, assessResult: null });
        recorderManager.start({
            format: 'mp3',
            sampleRate: 16000,
            numberOfChannels: 1
        });
        // 计时器
        this.recordTimer = setInterval(() => {
            this.setData({ recordingTime: this.data.recordingTime + 1 });
        }, 1000);
    },

    // 提交评测
    async submitAssessment(audioPath) {
        if (!audioPath || this._assessingLock) return;
        this._assessingLock = true;
        this.setData({ isAssessing: true });
        wx.showLoading({ title: '评测中...' });

        try {
            if (this.data.checkinMode && this.data.checkinTaskId) {
                const taskId = Number(this.data.checkinTaskId);
                if (!Number.isInteger(taskId) || taskId <= 0) {
                    wx.showToast({ title: '任务参数异常，请返回重试', icon: 'none' });
                    return;
                }
                // 打卡模式：走打卡接口
                const res = await api.upload('/checkin/complete-task', audioPath, {
                    task_id: String(taskId)
                });

                if (res.success) {
                    const data = res.data;
                    this.setData({
                        assessResult: {
                            overall_score: data.score,
                            pronunciation_score: data.pronunciation_score,
                            fluency_score: data.fluency_score,
                            integrity_score: data.integrity_score
                        },
                        checkinResult: data,
                        showResult: true
                    });
                } else {
                    wx.showToast({ title: res.message || '评测失败', icon: 'none' });
                }
            } else {
                // 普通模式：走语音评测接口
                const res = await api.upload('/voice/assess', audioPath, {
                    reference_text: this.data.word.word,
                    content_type: 'word'
                });

                if (res.success) {
                    this.setData({
                        assessResult: res.data,
                        showResult: true
                    });
                } else {
                    wx.showToast({ title: res.message || '评测失败', icon: 'none' });
                }
            }
        } catch (e) {
            console.error('评测错误:', e);
            wx.showToast({ title: '评测失败', icon: 'none' });
        } finally {
            this.setData({ isAssessing: false });
            wx.hideLoading();
            this._assessingLock = false;
        }
    },

    // 播放用户录音
    playUserRecording() {
        if (this.data.audioPath) {
            const audio = wx.createInnerAudioContext();
            audio.src = this.data.audioPath;
            audio.play();
        }
    },

    // 关闭评测结果弹窗
    closeResult() {
        this.setData({ showResult: false });
    },

    // 再试一次
    tryAgain() {
        this.setData({ showResult: false, assessResult: null, audioPath: '' });
    },

    // 打卡模式：返回任务列表
    checkinGoBack() {
        wx.navigateBack();
    },

    // 上一个单词
    prevWord() {
        const { wordList, currentIndex } = this.data;
        if (currentIndex > 0) {
            const prevWord = wordList[currentIndex - 1];
            this.setData({ currentIndex: currentIndex - 1, loading: true });
            this.loadWord(prevWord.id);
        } else {
            wx.showToast({ title: '已是第一个', icon: 'none' });
        }
    },

    // 下一个单词
    nextWord() {
        const { wordList, currentIndex } = this.data;
        if (currentIndex < wordList.length - 1) {
            const nextWord = wordList[currentIndex + 1];
            this.setData({ currentIndex: currentIndex + 1, loading: true });
            this.loadWord(nextWord.id);
        } else {
            wx.showToast({ title: '已是最后一个', icon: 'none' });
        }
    },

    goToWord(e) {
        const id = e.currentTarget.dataset.id;
        this.loadWord(id);
    },

    noop() { }
});
