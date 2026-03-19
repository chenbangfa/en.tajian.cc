const api = require('../../../services/api');
const recorderManager = wx.getRecorderManager();
const innerAudioContext = wx.createInnerAudioContext();

Page({
    data: {
        id: null,
        scene: null,
        sortedHotspots: [],
        currentWord: null,
        currentIndex: -1,
        isRecording: false,
        evaluationResult: null,
        imageWrapperWidth: 375,
        imageWrapperHeight: 500,
    },

    onLoad(options) {
        const sysInfo = wx.getSystemInfoSync();
        this.setData({ imageWrapperWidth: sysInfo.windowWidth });

        if (options.id) {
            this.setData({ id: options.id });
            this.loadScene(options.id);
        }

        recorderManager.onStop((res) => {
            if (this.data.isRecording) {
                this.uploadAndEvaluate(res.tempFilePath);
            }
        });
    },

    onUnload() {
        innerAudioContext.stop();
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
                // Sort hotspots by area descending (large first = bottom layer, small last = top layer)
                // so smaller hotspots are clickable on top of larger overlapping ones
                const objects = res.data.objects || [];
                const sorted = objects.map((item, idx) => ({
                    ...item,
                    objIndex: idx
                })).sort((a, b) => {
                    const areaA = (a.label_width || 10) * (a.label_height || 5);
                    const areaB = (b.label_width || 10) * (b.label_height || 5);
                    return areaB - areaA; // large first (bottom), small last (top)
                });
                this.setData({
                    scene: res.data,
                    sortedHotspots: sorted,
                    currentWord: null,
                    currentIndex: -1,
                    evaluationResult: null
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
            evaluationResult: null
        });
        this.playCurrentAudio();
    },

    // 上一个词条
    prevWord() {
        const { currentIndex, scene } = this.data;
        if (!scene || currentIndex <= 0) return;
        const idx = currentIndex - 1;
        const obj = scene.objects[idx];
        this.setData({ currentWord: obj, currentIndex: idx, evaluationResult: null });
        this.playCurrentAudio();
    },

    // 下一个词条
    nextWord() {
        const { currentIndex, scene } = this.data;
        if (!scene || currentIndex >= scene.objects.length - 1) return;
        const idx = currentIndex + 1;
        const obj = scene.objects[idx];
        this.setData({ currentWord: obj, currentIndex: idx, evaluationResult: null });
        this.playCurrentAudio();
    },

    // 播放当前单词音频
    playCurrentAudio() {
        if (!this.data.currentWord) return;
        const item = this.data.currentWord;
        const audioUrl = item.audio_url_female || item.audio_url_male || item.word_audio_url;
        const displayText = item.word || item.custom_label;

        if (audioUrl) {
            innerAudioContext.src = audioUrl;
            innerAudioContext.play();
        } else {
            wx.showToast({ title: displayText, icon: 'none' });
        }
    },

    // 开始录音
    startRecord() {
        if (!this.data.currentWord) return;
        this.setData({ isRecording: true });
        recorderManager.start({
            format: 'wav',
            sampleRate: 16000,
            numberOfChannels: 1,
            duration: 10000
        });
        wx.vibrateShort();
    },

    // 停止录音
    stopRecord() {
        if (!this.data.isRecording) return;
        this.setData({ isRecording: false });
        recorderManager.stop();
        wx.showLoading({ title: '评测中...' });
    },

    // 上传并评测
    async uploadAndEvaluate(filePath) {
        try {
            const res = await api.upload('/scenes/evaluate', filePath, {
                word: this.data.currentWord.word,
                text: this.data.currentWord.word
            }, 'audio');

            if (res.success) {
                this.setData({ evaluationResult: res.data });
            } else {
                wx.showToast({ title: '评测失败', icon: 'none' });
            }
        } catch (error) {
            console.error('评测请求错误', error);
            wx.showToast({ title: '网络异常', icon: 'none' });
        } finally {
            wx.hideLoading();
        }
    },

    clearScore() {
        this.setData({ evaluationResult: null });
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
