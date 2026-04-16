const api = require('../../../services/api');
const recorderManager = wx.getRecorderManager();

Page({
    data: {
        id: null,
        scene: null,
        sortedHotspots: [],
        currentWord: null,
        currentIndex: -1,
        isRecording: false,
        recordingTime: 0,
        isAssessing: false,
        assessResult: null,
        isPlayingUserAudio: false,
        imageWrapperWidth: 375,
        imageWrapperHeight: 500,
    },

    _audioCtx: null,
    _userAudioCtx: null,
    _lastRecordingPath: null,
    _recordTimer: null,
    _assessingLock: false,
    _suppressNextStop: false,
    _recorderActive: false,

    onLoad(options) {
        const sysInfo = wx.getSystemInfoSync();
        this.setData({ imageWrapperWidth: sysInfo.windowWidth });

        // 支持普通跳转 ?id=X 和小程序码扫码 scene=id%3DX
        let sceneId = options.id;
        if (!sceneId && options.scene) {
            const params = decodeURIComponent(options.scene);
            const match = params.match(/id=(\d+)/);
            if (match) sceneId = match[1];
        }

        if (sceneId) {
            this.setData({ id: sceneId });
            this.loadScene(sceneId);
        }

        this._bindRecorder();
    },

    onHide() {
        if (this.data.isRecording || this._recorderActive) {
            this._suppressNextStop = true;
            this._recorderActive = false;
            try { recorderManager.stop(); } catch (e) {}
            if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
            this.setData({ isRecording: false, recordingTime: 0 });
        }
    },

    onUnload() {
        this._stopAudio();
        this._stopUserAudio();
        if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
        this._suppressNextStop = true;
        this._recorderActive = false;
        try { recorderManager.stop(); } catch (e) {}
    },

    _bindRecorder() {
        if (typeof recorderManager.offStop === 'function') recorderManager.offStop();
        if (typeof recorderManager.offError === 'function') recorderManager.offError();
        if (typeof recorderManager.offStart === 'function') recorderManager.offStart();
        recorderManager.onStart(() => {
            this._recorderActive = true;
        });
        recorderManager.onStop((res) => {
            this._recorderActive = false;
            if (this._assessingLock) return;
            if (this._suppressNextStop) { this._suppressNextStop = false; return; }
            if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
            this.setData({ isRecording: false, recordingTime: 0 });
            this.submitAssessment(res.tempFilePath);
        });
        recorderManager.onError((err) => {
            this._recorderActive = false;
            if (this._suppressNextStop) return;
            console.error('录音错误:', err);
            if (this._recordTimer) { clearInterval(this._recordTimer); this._recordTimer = null; }
            this.setData({ isRecording: false, recordingTime: 0 });
            wx.showToast({ title: '录音失败，请重试', icon: 'none' });
        });
    },

    _stopAudio() {
        if (this._audioCtx) {
            try { this._audioCtx.stop(); this._audioCtx.destroy(); } catch (e) {}
            this._audioCtx = null;
        }
    },

    _stopUserAudio() {
        if (this._userAudioCtx) {
            try { this._userAudioCtx.stop(); this._userAudioCtx.destroy(); } catch (e) {}
            this._userAudioCtx = null;
        }
        this.setData({ isPlayingUserAudio: false });
    },

    onImageLoad(e) {
        const { width, height } = e.detail;
        const renderedHeight = (height / width) * this.data.imageWrapperWidth;
        this.setData({ imageWrapperHeight: renderedHeight });
    },

    async loadScene(id) {
        wx.showLoading({ title: '加载中...' });
        try {
            const res = await api.get(`/scenes/${id}`);
            if (res.success) {
                const objects = res.data.objects || [];
                const sorted = objects.map((item, idx) => ({
                    ...item,
                    objIndex: idx
                })).sort((a, b) => {
                    const areaA = (a.label_width || 10) * (a.label_height || 5);
                    const areaB = (b.label_width || 10) * (b.label_height || 5);
                    return areaB - areaA;
                });
                this.setData({
                    scene: res.data,
                    sortedHotspots: sorted,
                    currentWord: null,
                    currentIndex: -1,
                    assessResult: null
                });
                wx.setNavigationBarTitle({ title: res.data.name });
            }
        } catch (error) {
            console.error(error);
            wx.showToast({ title: '加载失败', icon: 'none' });
        } finally {
            wx.hideLoading();
        }
    },

    // 点击热点
    onHotspotTap(e) {
        const index = e.currentTarget.dataset.index;
        const item = this.data.scene.objects[index];
        this.setData({
            currentWord: item,
            currentIndex: index,
            assessResult: null
        });
        this.playAudio();
    },

    // 播放当前单词音频
    playAudio(e) {
        if (this.data.isRecording) return;
        if (!this.data.currentWord) return;
        const item = this.data.currentWord;
        const voice = e ? e.currentTarget.dataset.voice : 'female';
        const audioUrl = voice === 'male'
            ? (item.audio_url_male || item.audio_url_female || item.word_audio_url)
            : (item.audio_url_female || item.audio_url_male || item.word_audio_url);

        if (audioUrl) {
            this._stopAudio();
            this._audioCtx = wx.createInnerAudioContext();
            this._audioCtx.src = audioUrl;
            this._audioCtx.onError(() => {});
            this._audioCtx.play();
        }
    },

    // 录音评测
    toggleRecord() {
        if (this.data.isAssessing) return;
        if (!this.data.currentWord) {
            wx.showToast({ title: '请先点击图片中的物品', icon: 'none' });
            return;
        }
        if (this.data.isRecording) {
            recorderManager.stop();
        } else {
            this._checkRecordPermission();
        }
    },

    _checkRecordPermission() {
        wx.getSetting({
            success: (res) => {
                const auth = res.authSetting['scope.record'];
                if (auth === true) {
                    this._startRecord();
                } else if (auth === false) {
                    wx.showModal({
                        title: '需要录音权限',
                        content: '请在设置中开启麦克风权限',
                        confirmText: '去设置',
                        success: (r) => { if (r.confirm) wx.openSetting(); }
                    });
                } else {
                    wx.authorize({
                        scope: 'scope.record',
                        success: () => this._startRecord(),
                        fail: () => wx.showToast({ title: '需要录音权限', icon: 'none' })
                    });
                }
            }
        });
    },

    _startRecord() {
        this._stopAudio();
        this._stopUserAudio();

        const doStart = () => {
            this._suppressNextStop = false;
            this._assessingLock = false;
            this.setData({ isRecording: true, recordingTime: 0, assessResult: null });
            recorderManager.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1 });
            this._recordTimer = setInterval(() => {
                this.setData({ recordingTime: this.data.recordingTime + 1 });
            }, 1000);
        };

        if (this._recorderActive) {
            // 有残留录音，先 stop 再延迟启动
            this._suppressNextStop = true;
            try { recorderManager.stop(); } catch (e) {}
            setTimeout(doStart, 200);
        } else {
            // 无残留录音，直接启动（不调用 stop，避免触发 NotFoundError）
            doStart();
        }
    },

    async submitAssessment(audioPath) {
        if (!audioPath || this._assessingLock) return;
        this._assessingLock = true;
        this._lastRecordingPath = audioPath;
        this.setData({ isAssessing: true });
        wx.showLoading({ title: '评测中...' });

        try {
            const word = this.data.currentWord;
            if (!word) return;
            const text = word.word || word.custom_label;

            const res = await api.upload('/voice/assess', audioPath, {
                reference_text: text,
                content_type: 'word',
                source: 'scene',
                source_id: this.data.id
            });

            if (res.success) {
                this.setData({ assessResult: res.data });
            } else {
                wx.showToast({ title: res.message || '评测失败', icon: 'none' });
            }
        } catch (error) {
            console.error('评测错误:', error);
            wx.showToast({ title: '评测失败，请重试', icon: 'none' });
        } finally {
            this.setData({ isAssessing: false });
            wx.hideLoading();
            this._assessingLock = false;
        }
    },

    retryRecord() {
        this._stopUserAudio();
        this.setData({ assessResult: null });
    },

    closeAssessPanel() {
        this._stopUserAudio();
        this.setData({ assessResult: null });
    },

    playUserAudio() {
        const path = this._lastRecordingPath;
        if (!path) return;
        if (this.data.isPlayingUserAudio) {
            this._stopUserAudio();
            return;
        }
        this._stopAudio();
        this._stopUserAudio();
        this._userAudioCtx = wx.createInnerAudioContext();
        this._userAudioCtx.src = path;
        this._userAudioCtx.onPlay(() => this.setData({ isPlayingUserAudio: true }));
        this._userAudioCtx.onEnded(() => this.setData({ isPlayingUserAudio: false }));
        this._userAudioCtx.onError(() => this.setData({ isPlayingUserAudio: false }));
        this._userAudioCtx.play();
    },

    onPrev() {
        const prevId = this.data.scene.prev_id;
        if (prevId) {
            this.setData({ id: prevId });
            this.loadScene(prevId);
        }
    },

    onNext() {
        const nextId = this.data.scene.next_id;
        if (nextId) {
            this.setData({ id: nextId });
            this.loadScene(nextId);
        }
    }
});
