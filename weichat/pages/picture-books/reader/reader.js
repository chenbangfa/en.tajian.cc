const api = require('../../../services/api');

const MEDIA_BASE = 'https://english.tajian.cc';
function fullUrl(u) {
    if (!u) return u;
    return u.startsWith('http') ? u : MEDIA_BASE + u;
}

// 单一全局 audio context
let _audio = null;
function getAudio() {
    if (!_audio) _audio = wx.createInnerAudioContext();
    return _audio;
}

Page({
    data: {
        bookId: null,
        book: null,
        pages: [],
        currentPage: null,

        screenWidth: 375,
        safeAreaBottom: 0,
        imageHeights: {},
        swiperHeight: 500,
        imageWrapWidth: 0,
        storyBarHeight: 0,
        pageToolsBottom: 96,

        currentPageIndex: 0,
        currentHotspot: null,
        currentHotspotIndex: -1,

        isPlaying: false,
        narrationPlaying: false,

        isLandscape: false,
        showTranslation: false,
        wordPopup: null
    },

    _autoTimer: null,
    _audioMode: '',
    _audioCache: {},
    _audioRequestSeq: 0,

    _getWindowInfo() {
        try {
            if (typeof wx.getWindowInfo === 'function') {
                return wx.getWindowInfo();
            }
        } catch (e) {}
        return { windowWidth: 375, windowHeight: 667, safeArea: null };
    },

    _getSafeAreaBottom(win) {
        if (win && win.safeArea && win.windowHeight) {
            return Math.max(0, (win.windowHeight || 0) - (win.safeArea.bottom || 0));
        }
        return 0;
    },

    onLoad(options) {
        const win = this._getWindowInfo();
        const landscape = (win.windowWidth || 375) > (win.windowHeight || 667);
        this.setData({
            screenWidth: win.windowWidth || 375,
            safeAreaBottom: this._getSafeAreaBottom(win),
            isLandscape: landscape,
            swiperHeight: win.windowHeight || 667
        });

        if (options.id) {
            this.setData({ bookId: parseInt(options.id) });
            this.loadBook(options.id);
        }

        this._initAudio();
    },

    // 系统横竖屏切换回调
    onResize(res) {
        const size = res && res.size ? res.size : this._getWindowInfo();
        const windowWidth = size.windowWidth || size.width || this.data.screenWidth || 375;
        const windowHeight = size.windowHeight || size.height || this._getWindowInfo().windowHeight || 667;
        const landscape = windowWidth > windowHeight;
        const update = { screenWidth: windowWidth, isLandscape: landscape };
        this.setData(update, () => {
            this._measureStoryBarHeight(() => {
                const sizeUpdate = {};
                this._applySwiperSize(sizeUpdate);
                this.setData(sizeUpdate);
            });
        });
    },

    onUnload() {
        if (_audio) {
            try { _audio.stop(); _audio.destroy(); } catch (e) {}
            _audio = null;
        }
        this._audioCache = {};
        this._saveProgress();
    },

    // ─── 音频 ───

    _initAudio() {
        const audio = getAudio();
        audio.onPlay(() => {
            if (this._audioMode === 'narration') {
                this.setData({ narrationPlaying: true, isPlaying: false });
            } else {
                this.setData({ isPlaying: true, narrationPlaying: false });
            }
        });
        audio.onPause(() => this.setData({ isPlaying: false, narrationPlaying: false }));
        audio.onStop(() => this.setData({ isPlaying: false, narrationPlaying: false }));
        audio.onError(() => this.setData({ isPlaying: false, narrationPlaying: false }));
        audio.onEnded(() => this.setData({ isPlaying: false, narrationPlaying: false }));
    },

    // ─── 加载 ───

    async loadBook(id) {
        wx.showLoading({ title: '加载中...' });
        try {
            const res = await api.get(`/picture-books/${id}`);
            if (res.success) {
                const book = res.data.book;
                book.cover_url = fullUrl(book.cover_url);
                const contentPages = res.data.pages.map(p => {
                    const words = (p.words_data && p.words_data.words) || [];
                    // 为每个词的 audio_url 补全域名
                    words.forEach(w => { if (w.audio_url) w.audio_url = fullUrl(w.audio_url); });
                    return {
                        ...p,
                        image_url: fullUrl(p.image_url),
                        audio_url: fullUrl(p.audio_url),
                        audio_url_male: fullUrl(p.audio_url_male),
                        tokens: p.text_en ? this._tokenize(p.text_en, words) : [],
                        hotspots: p.hotspots.map(h => ({
                            ...h,
                            audio_url_female: fullUrl(h.audio_url_female),
                            audio_url_male: fullUrl(h.audio_url_male)
                        }))
                    };
                });
                const pages = book.cover_url
                    ? [{
                        id: `cover_${book.id}`,
                        page_number: 0,
                        image_url: book.cover_url,
                        audio_url: '',
                        audio_url_male: '',
                        text_en: '',
                        text_cn: '',
                        hotspots: [],
                        is_cover: true
                    }, ...contentPages]
                    : contentPages;
                this.setData({
                    book,
                    pages,
                    currentPage: pages[0] || null
                }, () => {
                    wx.setNavigationBarTitle({
                        title: book.title || '绘本阅读'
                    });
                    this._measureStoryBarHeight(() => {
                        const sizeUpdate = {};
                        this._applySwiperSize(sizeUpdate);
                        this.setData(sizeUpdate);
                    });
                });
            } else {
                wx.showToast({ title: '加载失败', icon: 'none' });
            }
        } catch (e) {
            wx.showToast({ title: '加载失败', icon: 'none' });
        } finally {
            wx.hideLoading();
        }
    },

    // 记录每页图片原始宽高比 & 竖屏渲染高度
    _imageRatios: {},     // idx → width/height
    _portraitHeights: {}, // idx → 竖屏渲染高度

    onImageLoad(e) {
        const { width, height } = e.detail;
        const idx = e.currentTarget.dataset.index;
        const ratio = width / height;
        this._imageRatios[idx] = ratio;

        const renderedHeight = (height / width) * this.data.screenWidth;
        this._portraitHeights[idx] = renderedHeight;

        const update = { [`imageHeights[${idx}]`]: renderedHeight };
        if (idx === this.data.currentPageIndex) {
            this._measureStoryBarHeight(() => {
                this._applySwiperSize(update);
                this.setData(update);
            });
            return;
        }
        this.setData(update);
    },

    // 根据当前横竖屏状态计算 swiper 高度 & image-wrap 尺寸
    // swiper 高度 = 视口高度；图片按等比自然撑高，超出部分通过 scroll-view 滚动
    _applySwiperSize(update) {
        const idx = this.data.currentPageIndex;
        const win = this._getWindowInfo();
        const fullW = win.windowWidth || this.data.screenWidth || 375;
        const fullH = win.windowHeight || 667;

        // swiper 始终占满视口高度
        update.swiperHeight = fullH;

        if (this.data.isLandscape) {
            // 横屏：优先让图片高度适配视口，宽度不超过屏幕宽度
            // 若宽度被 cap 到屏幕宽，图片会比视口高 → scroll-view 可滚动
            const ratio = this._imageRatios[idx];
            update.imageWrapWidth = ratio
                ? Math.min(Math.round(fullH * ratio), fullW)
                : fullW;
        } else {
            // 竖屏：图片满宽，高度按原图比例自然撑开
            // 手机上多数图片刚好一屏；iPad 若图片较高则可滚动查看
            update.imageWrapWidth = fullW;
        }
        this._applyPageToolsBottom(update, win);
    },

    _applyPageToolsBottom(update, winArg) {
        if (this.data.isLandscape) {
            update.pageToolsBottom = 14;
            return;
        }
        const win = winArg || this._getWindowInfo();
        const safeBottom = this._getSafeAreaBottom(win);
        const storyBarH = this.data.storyBarHeight || 0;
        const hasHotspot = !!this.data.currentHotspot;
        const hotspotExtra = hasHotspot ? 92 : 0;
        update.pageToolsBottom = Math.max(16, safeBottom + storyBarH + 12 + hotspotExtra);
    },

    _measureStoryBarHeight(cb) {
        if (this.data.isLandscape) {
            this.setData({ storyBarHeight: 0 }, () => cb && cb());
            return;
        }

        const q = wx.createSelectorQuery();
        q.select('.story-bar').boundingClientRect();
        q.exec((res) => {
            const rect = res && res[0];
            const h = rect && rect.height ? Math.ceil(rect.height) : 0;
            this.setData({ storyBarHeight: h }, () => cb && cb());
        });
    },

    // ─── Swiper ───

    onSwiperChange(e) {
        if (e.detail.source === 'touch' || e.detail.source === 'autoplay') {
            const idx = e.detail.current;
            const audio = getAudio();
            audio.stop();
            const update = {
                currentPageIndex: idx,
                currentPage: this.data.pages[idx] || null,
                currentHotspot: null,
                currentHotspotIndex: -1,
                isPlaying: false,
                narrationPlaying: false,
                wordPopup: null
            };
            this.setData(update, () => {
                this._measureStoryBarHeight(() => {
                    const sizeUpdate = {};
                    this._applySwiperSize(sizeUpdate);
                    this.setData(sizeUpdate);
                });
            });
        }
    },

    // ─── 热点 ───

    onHotspotTap(e) {
        const { hotspot, hotspotIndex } = e.currentTarget.dataset;
        this.setData({
            currentHotspot: hotspot,
            currentHotspotIndex: hotspotIndex
        });
        this._playHotspot(hotspot);
    },

    toggleFloatBar() {
        this.setData({ showTranslation: !this.data.showTranslation }, () => {
            this._measureStoryBarHeight(() => {
                const sizeUpdate = {};
                this._applySwiperSize(sizeUpdate);
                this.setData(sizeUpdate);
            });
        });
    },

    async _resolvePlayableAudioSrc(audioUrl) {
        if (!audioUrl) return '';
        if (!/^https?:\/\//i.test(audioUrl)) return audioUrl;
        if (this._audioCache[audioUrl]) return this._audioCache[audioUrl];

        const res = await new Promise((resolve, reject) => {
            wx.downloadFile({
                url: audioUrl,
                success: resolve,
                fail: reject
            });
        });

        if (!res || res.statusCode !== 200 || !res.tempFilePath) {
            throw new Error('音频下载失败');
        }

        this._audioCache[audioUrl] = res.tempFilePath;
        return res.tempFilePath;
    },

    async _playAudioUrl(audioUrl, mode) {
        if (!audioUrl) return;
        const requestId = ++this._audioRequestSeq;
        const audio = getAudio();
        this._audioMode = mode;
        audio.stop();

        try {
            const playableSrc = await this._resolvePlayableAudioSrc(audioUrl);
            if (requestId !== this._audioRequestSeq) return;
            audio.src = playableSrc;
            audio.play();
        } catch (e) {
            console.error('[PictureBookReader] 播放音频失败:', e);
            this.setData({ isPlaying: false, narrationPlaying: false });
            wx.showToast({ title: '音频播放失败', icon: 'none' });
        }
    },

    async _playHotspot(hotspot) {
        let audioUrl = hotspot.audio_url_female || hotspot.audio_url_male;

        if (!audioUrl) {
            wx.showLoading({ title: '生成语音...' });
            try {
                const res = await api.post(`/picture-books/hotspots/${hotspot.id}/tts`);
                wx.hideLoading();
                if (res.success) {
                    const ttsData = {
                        audio_url_female: fullUrl(res.data.audio_url_female),
                        audio_url_male: fullUrl(res.data.audio_url_male)
                    };
                    const { pages, currentPageIndex, currentHotspotIndex } = this.data;
                    const newPages = [...pages];
                    const hs = [...newPages[currentPageIndex].hotspots];
                    hs[currentHotspotIndex] = { ...hs[currentHotspotIndex], ...ttsData };
                    newPages[currentPageIndex] = { ...newPages[currentPageIndex], hotspots: hs };
                    const updated = hs[currentHotspotIndex];
                    this.setData({ pages: newPages, currentHotspot: updated });
                    hotspot = updated;
                    audioUrl = ttsData.audio_url_female || ttsData.audio_url_male;
                } else {
                    wx.showToast({ title: '语音生成失败', icon: 'none' });
                    return;
                }
            } catch (e) {
                wx.hideLoading();
                wx.showToast({ title: '语音生成失败', icon: 'none' });
                return;
            }
        }

        if (!audioUrl) return;
        await this._playAudioUrl(audioUrl, 'hotspot');
    },

    togglePlay() {
        const audio = getAudio();
        if (this.data.isPlaying) {
            audio.pause();
        } else if (this.data.currentHotspot) {
            this._playHotspot(this.data.currentHotspot);
        }
    },

    _getCurrentPageAudioUrl() {
        const page = this.data.pages[this.data.currentPageIndex];
        if (!page) return '';
        return page.audio_url || page.audio_url_male || '';
    },

    _playCurrentPageNarration() {
        const audioUrl = this._getCurrentPageAudioUrl();
        if (!audioUrl) {
            wx.showToast({ title: '本页暂无朗读音频', icon: 'none' });
            return;
        }
        this._playAudioUrl(audioUrl, 'narration');
    },

    toggleNarrationPlay() {
        const audio = getAudio();
        if (this.data.narrationPlaying) {
            audio.pause();
            return;
        }
        this._playCurrentPageNarration();
    },

    // ─── 单词查词 ───

    _tokenize(text, words) {
        const kMap = {};
        words.forEach(w => { kMap[w.word.toLowerCase()] = w; });

        // 多词短语优先（最长匹配）
        const phrases = Object.keys(kMap).filter(k => k.includes(' ')).sort((a, b) => b.length - a.length);

        const tokens = [];
        let pos = 0;
        while (pos < text.length) {
            let matched = false;

            if (phrases.length && /[a-zA-Z]/.test(text[pos])) {
                for (const phrase of phrases) {
                    const seg = text.substr(pos, phrase.length);
                    if (seg.toLowerCase() === phrase) {
                        const after = text[pos + phrase.length];
                        if (!after || /[^a-zA-Z'-]/.test(after)) {
                            tokens.push({ text: seg, hasWord: true, wordData: kMap[phrase] });
                            pos += phrase.length;
                            matched = true;
                            break;
                        }
                    }
                }
            }

            if (!matched) {
                const wordMatch = /^([a-zA-Z'-]+)/.exec(text.substring(pos));
                if (wordMatch) {
                    const word = wordMatch[1];
                    const wd = kMap[word.toLowerCase()];
                    tokens.push({ text: word, hasWord: !!wd, wordData: wd || null });
                    pos += word.length;
                } else {
                    const nonWord = /^([^a-zA-Z'-]+)/.exec(text.substring(pos));
                    if (nonWord) {
                        tokens.push({ text: nonWord[1], hasWord: false, wordData: null });
                        pos += nonWord[1].length;
                    } else {
                        tokens.push({ text: text[pos], hasWord: false, wordData: null });
                        pos++;
                    }
                }
            }
        }
        return tokens;
    },

    showWordDetail(e) {
        const { tidx } = e.currentTarget.dataset;
        const page = this.data.currentPage;
        if (!page || !page.tokens) return;
        const token = page.tokens[Number(tidx)];
        if (token && token.hasWord && token.wordData) {
            this.setData({ wordPopup: token.wordData });
        }
    },

    closeWordPopup() {
        this.setData({ wordPopup: null });
    },

    playWordAudio() {
        const url = this.data.wordPopup && this.data.wordPopup.audio_url;
        if (!url) return;
        const tmp = wx.createInnerAudioContext();
        tmp.src = url;
        tmp.play();
        tmp.onEnded(() => tmp.destroy());
        tmp.onError(() => tmp.destroy());
    },

    noop() {},

    // ─── 导航 ───

    goBack() {
        wx.navigateBack();
    },

    // ─── 进度 ───

    async _saveProgress() {
        if (!this.data.bookId || !this.data.pages.length) return;
        try {
            const hasCover = !!(this.data.pages[0] && this.data.pages[0].is_cover);
            const contentCurrentPage = hasCover
                ? Math.max(1, this.data.currentPageIndex)
                : (this.data.currentPageIndex + 1);
            const isCompleted = hasCover
                ? this.data.currentPageIndex >= this.data.pages.length - 1
                : this.data.currentPageIndex >= this.data.pages.length - 1;
            await api.post(`/picture-books/${this.data.bookId}/progress`, {
                current_page: contentCurrentPage,
                is_completed: isCompleted
            });
        } catch (e) {}
    }
});
