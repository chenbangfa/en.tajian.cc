const api = require('../../../services/api');
const MEDIA_BASE_URL = 'https://en.tajian.cc';

Page({
    data: {
        content: null,
        isPlaying: false,
        speed: 1.0,
        readChinese: true,

        // Playlist State
        playSequence: [], // ['male', 'female', 'chinese']
        currentIndex: 0,

        // Progress State
        duration: 0,
        currentTime: 0,
        progress: 0,
        durationStr: '00:00',
        currentTimeStr: '00:00',
        isDragging: false
    },

    onLoad(options) {
        if (options.id) this.loadContent(options.id);
        this.setupAudioContext();
    },

    onUnload() {
        if (this.innerAudioContext) {
            this.innerAudioContext.stop();
            this.innerAudioContext.destroy();
        }
    },

    setupAudioContext() {
        this.innerAudioContext = wx.createInnerAudioContext();

        // Playback Events
        this.innerAudioContext.onPlay(() => this.setData({ isPlaying: true }));
        this.innerAudioContext.onPause(() => this.setData({ isPlaying: false }));
        this.innerAudioContext.onStop(() => this.setData({ isPlaying: false }));

        // Update Progress
        this.innerAudioContext.onTimeUpdate(() => {
            if (this.data.isDragging) return;
            const duration = this.innerAudioContext.duration;
            const currentTime = this.innerAudioContext.currentTime;
            this.setData({
                duration,
                currentTime,
                durationStr: this.formatTime(duration),
                currentTimeStr: this.formatTime(currentTime),
                progress: (currentTime / duration) * 100
            });
        });

        // Sequence Logic
        this.innerAudioContext.onEnded(() => {
            this.playNextInSequence();
        });

        this.innerAudioContext.onError((res) => {
            console.error('播放错误:', res.errMsg);
            this.setData({ isPlaying: false });
        });
    },

    async loadContent(id) {
        wx.showLoading({ title: '加载中...' });
        try {
            const res = await api.get(`/podcast/${id}`);
            if (res.success) {
                const content = res.data;
                this.setData({ content });
                wx.setNavigationBarTitle({ title: content.title });

                // Build Playlist
                this.buildPlaylist(content);

                // Auto Play First
                if (this.data.playSequence.length > 0) {
                    this.playCurrent();
                } else {
                    wx.showToast({ title: '暂无音频', icon: 'none' });
                }
            }
        } catch (e) { console.error(e); }
        finally { wx.hideLoading(); }
    },

    formatUrl(url) {
        if (!url) return '';
        if (url.startsWith('http')) return url;
        return MEDIA_BASE_URL + url;
    },

    buildPlaylist(content) {
        const sequence = [];
        if (content.male_audio_url) sequence.push({ type: 'male', url: this.formatUrl(content.male_audio_url) });
        if (content.female_audio_url) sequence.push({ type: 'female', url: this.formatUrl(content.female_audio_url) });
        if (this.data.readChinese && content.chinese_audio_url) sequence.push({ type: 'chinese', url: this.formatUrl(content.chinese_audio_url) });

        this.setData({
            playSequence: sequence,
            currentIndex: 0
        });
    },

    playCurrent() {
        if (this.data.currentIndex >= this.data.playSequence.length) {
            this.setData({ isPlaying: false });
            return;
        }

        const item = this.data.playSequence[this.data.currentIndex];
        console.log('播放音频:', item.url);

        if (this.innerAudioContext) {
            this.innerAudioContext.src = item.url;
            this.innerAudioContext.playbackRate = this.data.speed;
            this.innerAudioContext.play();
        }
    },

    playNextInSequence() {
        let nextIndex = this.data.currentIndex + 1;
        if (nextIndex >= this.data.playSequence.length) {
            nextIndex = 0; // Loop forever
        }

        this.setData({ currentIndex: nextIndex });
        this.playCurrent();
    },

    togglePlay() {
        if (this.data.isPlaying) {
            this.innerAudioContext.pause();
        } else {
            this.innerAudioContext.play();
        }
    },

    changeSpeed(e) {
        const speeds = [0.5, 0.75, 1.0, 1.25, 1.5];
        const newSpeed = speeds[e.detail.value];
        this.setData({ speed: newSpeed });
        if (this.innerAudioContext) {
            this.innerAudioContext.playbackRate = newSpeed;
        }
    },

    toggleChineseRaw() {
        const newVal = !this.data.readChinese;
        this.setData({ readChinese: newVal });
        this.buildPlaylist(this.data.content);
    },

    // Seek
    onSliderChanging(e) {
        this.setData({ isDragging: true });
    },

    onSliderChange(e) {
        const val = e.detail.value;
        const targetTime = (val / 100) * this.data.duration;
        if (this.innerAudioContext) {
            this.innerAudioContext.seek(targetTime);
        }
        this.setData({
            isDragging: false,
            currentTime: targetTime,
            progress: val
        });
    },

    formatTime(seconds) {
        if (!seconds) return '00:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
});
