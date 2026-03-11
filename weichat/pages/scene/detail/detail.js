const api = require('../../../services/api');
const recorderManager = wx.getRecorderManager();
const innerAudioContext = wx.createInnerAudioContext();

Page({
    data: {
        id: null,
        scene: null,
        currentWord: null, // 当前选中的单词对象
        isRecording: false,
        evaluationResult: null, // { score: 90, feedback: '...' }
        imageWrapperWidth: 375, // 默认屏幕宽度
        imageWrapperHeight: 500, // 默认高度
    },

    onLoad(options) {
        // 获取屏幕宽度
        const sysInfo = wx.getSystemInfoSync();
        this.setData({ imageWrapperWidth: sysInfo.windowWidth });

        if (options.id) {
            this.setData({ id: options.id });
            this.loadScene(options.id);
        }

        // 监听录音停止事件
        recorderManager.onStop((res) => {
            if (this.data.isRecording) {
                this.uploadAndEvaluate(res.tempFilePath);
            }
        });
    },

    onUnload() {
        innerAudioContext.stop();
    },

    // 图片加载完成，获取实际渲染尺寸
    onImageLoad(e) {
        const { width, height } = e.detail;
        const screenWidth = this.data.imageWrapperWidth;
        // 按宽度自适应计算高度
        const renderedHeight = (height / width) * screenWidth;
        console.log('Image loaded:', width, height, '->', screenWidth, renderedHeight);
        this.setData({
            imageWrapperHeight: renderedHeight
        });
    },

    // 加载场景数据
    async loadScene(id) {
        wx.showLoading({ title: '加载中...' });
        try {
            const res = await api.get(`/scenes/${id}`);
            if (res.success) {
                this.setData({
                    scene: res.data,
                    currentWord: null,
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
        const { item } = e.currentTarget.dataset;
        this.setData({
            currentWord: item,
            evaluationResult: null // 切换单词时重置评分
        });

        // 自动播放音频
        this.playCurrentAudio();
    },

    // 播放当前单词音频
    playCurrentAudio() {
        if (!this.data.currentWord) return;

        const item = this.data.currentWord;
        // 优先使用场景热点自身的音频，其次使用关联单词的音频
        const audioUrl = item.audio_url_female || item.audio_url_male || item.word_audio_url;
        const displayText = item.word || item.custom_label;

        if (audioUrl) {
            innerAudioContext.src = audioUrl;
            innerAudioContext.play();
        } else {
            // 如果没有音频，提示文本
            wx.showToast({ title: displayText, icon: 'none' });
        }
    },

    // 开始录音
    startRecord() {
        if (!this.data.currentWord) return;

        this.setData({ isRecording: true });
        recorderManager.start({
            format: 'mp3',
            duration: 10000 // 最长10秒
        });
        wx.vibrateShort(); // 震动反馈
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
                // 播放好评音效（可选）
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

    // 清除评分
    clearScore() {
        this.setData({ evaluationResult: null });
    },

    // 上一页
    onPrev() {
        const prevId = this.data.scene.prev_id;
        if (prevId) {
            this.setData({ id: prevId });
            this.loadScene(prevId);
        }
    },

    // 下一页
    onNext() {
        const nextId = this.data.scene.next_id;
        if (nextId) {
            this.setData({ id: nextId });
            this.loadScene(nextId);
        }
    }
});
