const api = require('../../../services/api');
const MEDIA_BASE_URL = 'https://english.tajian.cc';

Page({
    data: {
        content: null,
        mode: 'full',          // 'full' | 'sentences'

        // ── Sentences mode ──
        sentences: [],
        currentSentenceIdx: 0,
        showTranslation: false,
        showGrammar: false,
        wordPopup: null,       // { word, phonetic, pos, translation, audio_url }
        grammarPopup: null,    // { text, grammar, translation }

        // ── Audio / progress ──
        isPlaying: false,
        duration: 0,
        currentTime: 0,
        progress: 0,
        durationStr: '00:00',
        currentTimeStr: '00:00',
        isDragging: false,

        // ── Full mode extras ──
        readChinese: true,
        playSequence: [],
        currentIndex: 0,

        // ── 评测历史 ──
        articleAvgScore: 0,   // 0 表示从未评测
        articleMastery: ''    // 'excellent' | 'good' | 'needs_practice' | ''
    },

    onLoad(options) {
        this._setupAudio();
        if (options.id) this._loadContent(options.id);
    },

    onUnload() {
        if (this._audio) { this._audio.stop(); this._audio.destroy(); }
    },

    // ─────────────────── Audio context ───────────────────

    _setupAudio() {
        this._audio = wx.createInnerAudioContext();
        this._audio.onPlay(() => this.setData({ isPlaying: true }));
        this._audio.onPause(() => this.setData({ isPlaying: false }));
        this._audio.onStop(() => this.setData({ isPlaying: false }));
        this._audio.onError(res => {
            console.error('播放错误:', res.errMsg);
            this.setData({ isPlaying: false });
        });
        this._audio.onTimeUpdate(() => {
            if (this.data.isDragging) return;
            const dur = this._audio.duration || 0;
            const cur = this._audio.currentTime || 0;
            this.setData({
                duration: dur, currentTime: cur,
                durationStr: this._fmt(dur), currentTimeStr: this._fmt(cur),
                progress: dur > 0 ? (cur / dur) * 100 : 0
            });
        });
        this._audio.onEnded(() => {
            if (this.data.mode === 'sentences') {
                if (this._autoAdvance) this._nextSentence();
                else this.setData({ isPlaying: false });
            } else {
                this._nextInSequence();
            }
        });
    },

    // ─────────────────── Load content ───────────────────

    async _loadContent(id) {
        wx.showLoading({ title: '加载中...' });
        try {
            const res = await api.get(`/podcast/${id}`);
            if (!res.success) { wx.showToast({ title: '加载失败', icon: 'none' }); return; }
            const content = res.data;
            this.setData({ content });
            wx.setNavigationBarTitle({ title: content.title });

            if (content.sentences_data && content.sentences_data.sentences) {
                const sentences = this._processSentences(content.sentences_data.sentences);
                // 不自动播放，等用户手动点击
                this.setData({ mode: 'sentences', sentences, currentSentenceIdx: 0 });
            } else {
                this.setData({ mode: 'full' });
                this._buildPlaylist(content);
                // 不自动播放，等用户手动点击
            }
            // 异步拉取该文章的评测历史（不阻塞页面）
            this._loadArticleScore(content.id);
        } catch (e) {
            console.error(e);
            wx.showToast({ title: '加载失败', icon: 'none' });
        } finally {
            wx.hideLoading();
        }
    },

    // ─────────────────── 评测历史 ───────────────────

    async _loadArticleScore(contentId) {
        try {
            const res = await api.get(`/voice/podcast-summary/${contentId}`);
            if (res.success && res.data.assessed_count > 0) {
                this.setData({
                    articleAvgScore: res.data.avg_score,
                    articleMastery: res.data.mastery
                });
            }
        } catch (e) { /* 静默失败 */ }
    },

    // ─────────────────── Sentences mode ───────────────────

    _processSentences(raw) {
        return raw.map((s, i) => ({
            ...s,
            index: i,
            male_audio_url: s.male_audio_url ? this._url(s.male_audio_url) : null,
            female_audio_url: s.female_audio_url ? this._url(s.female_audio_url) : null,
            words: (s.words || []).map(w => ({ ...w, audio_url: w.audio_url ? this._url(w.audio_url) : null })),
            tokens: this._tokenize(s.text, s.words || [])
        }));
    },

    _tokenize(text, keyWords) {
        const kMap = {};
        keyWords.forEach((w, i) => { kMap[w.word.toLowerCase()] = { ...w, widx: i, audio_url: w.audio_url ? this._url(w.audio_url) : null }; });

        // Sort multi-word phrases longest-first so they take priority over single words
        const phrases = Object.keys(kMap).filter(k => k.includes(' ')).sort((a, b) => b.length - a.length);

        const tokens = [];
        let pos = 0;
        while (pos < text.length) {
            let matched = false;

            // Try multi-word phrases first (only when we're at a word-start character)
            if (phrases.length && /[a-zA-Z]/.test(text[pos])) {
                for (const phrase of phrases) {
                    const seg = text.substr(pos, phrase.length);
                    if (seg.toLowerCase() === phrase) {
                        // Ensure it ends at a word boundary
                        const after = text[pos + phrase.length];
                        if (!after || /[^a-zA-Z'-]/.test(after)) {
                            tokens.push({ text: seg, isKey: true, wordData: kMap[phrase] });
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
                    const kd = kMap[word.toLowerCase()];
                    tokens.push({ text: word, isKey: !!kd, wordData: kd || null });
                    pos += word.length;
                } else {
                    const nonWordMatch = /^([^a-zA-Z'-]+)/.exec(text.substring(pos));
                    if (nonWordMatch) {
                        tokens.push({ text: nonWordMatch[1], isKey: false, wordData: null });
                        pos += nonWordMatch[1].length;
                    } else {
                        tokens.push({ text: text[pos], isKey: false, wordData: null });
                        pos++;
                    }
                }
            }
        }
        return tokens;
    },

    _playSentence(idx, autoAdvance = false) {
        const { sentences } = this.data;
        if (idx < 0 || idx >= sentences.length) return;
        const s = sentences[idx];
        const url = s.female_audio_url || s.male_audio_url;
        if (!url) { wx.showToast({ title: '该句暂无音频', icon: 'none' }); return; }
        this._autoAdvance = autoAdvance;
        this.setData({ currentSentenceIdx: idx, progress: 0, currentTime: 0, duration: 0 });
        this._audio.src = url;
        this._audio.play();
    },

    _nextSentence() {
        const { currentSentenceIdx, sentences } = this.data;
        if (currentSentenceIdx < sentences.length - 1) {
            this._playSentence(currentSentenceIdx + 1, true);
        } else {
            this._autoAdvance = false;
            this.setData({ isPlaying: false });
        }
    },

    onSentenceTap(e) {
        this._playSentence(Number(e.currentTarget.dataset.index), false);
    },

    playPrevSentence() { this._playSentence(this.data.currentSentenceIdx - 1, false); },
    playNextSentence() { this._playSentence(this.data.currentSentenceIdx + 1, false); },

    toggleTranslation() { this.setData({ showTranslation: !this.data.showTranslation }); },
    toggleGrammar() { this.setData({ showGrammar: !this.data.showGrammar }); },

    showWordDetail(e) {
        const { sidx, widx } = e.currentTarget.dataset;
        const sentence = this.data.sentences[Number(sidx)];
        if (!sentence) return;
        const token = sentence.tokens[Number(widx)];
        if (token && token.isKey && token.wordData) {
            this.setData({ wordPopup: token.wordData });
        }
    },

    closeWordPopup() { this.setData({ wordPopup: null }); },

    playWordAudio() {
        const url = this.data.wordPopup && this.data.wordPopup.audio_url;
        if (!url) return;
        // 用独立 audio context 播放单词，避免干扰句子播放状态
        const tmp = wx.createInnerAudioContext();
        tmp.src = url;
        tmp.play();
        tmp.onEnded(() => tmp.destroy());
        tmp.onError(() => tmp.destroy());
    },

    showGrammarPopup(e) {
        const s = this.data.sentences[Number(e.currentTarget.dataset.index)];
        if (s) this.setData({ grammarPopup: { text: s.text, grammar: s.grammar, translation: s.translation } });
    },

    closeGrammarPopup() { this.setData({ grammarPopup: null }); },

    // ─────────────────── Full mode ───────────────────

    _buildPlaylist(content) {
        const seq = [];
        if (content.female_audio_url || content.male_audio_url) {
            seq.push({ type: 'female', url: this._url(content.female_audio_url || content.male_audio_url) });
        }
        if (this.data.readChinese && content.chinese_audio_url) seq.push({ type: 'chinese', url: this._url(content.chinese_audio_url) });
        this.setData({ playSequence: seq, currentIndex: 0 });
    },

    _playCurrent() {
        const { currentIndex, playSequence } = this.data;
        if (currentIndex >= playSequence.length) { this.setData({ isPlaying: false }); return; }
        this._audio.src = playSequence[currentIndex].url;
        this._audio.play();
    },

    _nextInSequence() {
        let next = this.data.currentIndex + 1;
        if (next >= this.data.playSequence.length) next = 0;
        this.setData({ currentIndex: next });
        this._playCurrent();
    },

    toggleChineseRaw() {
        this.setData({ readChinese: !this.data.readChinese });
        this._buildPlaylist(this.data.content);
    },

    // ─────────────────── Common controls ───────────────────

    togglePlay() {
        if (this.data.isPlaying) {
            this._autoAdvance = false;
            this._audio.pause();
        } else {
            if (this.data.mode === 'sentences') {
                this._playSentence(this.data.currentSentenceIdx, true);
            } else {
                this._playCurrent();
            }
        }
    },

    onSliderChanging() { this.setData({ isDragging: true }); },

    onSliderChange(e) {
        const val = e.detail.value;
        const t = (val / 100) * this.data.duration;
        if (this._audio) this._audio.seek(t);
        this.setData({ isDragging: false, currentTime: t, progress: val });
    },

    // ─────────────────── Helpers ───────────────────

    _url(u) {
        if (!u) return '';
        return u.startsWith('http') ? u : MEDIA_BASE_URL + u;
    },

    _fmt(s) {
        if (!s) return '00:00';
        return `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
    },

    goAssess() {
        const { content } = this.data;
        if (!content) return;
        // 暂停当前播放
        if (this._audio) { this._audio.pause(); }
        wx.navigateTo({
            url: `/pages/podcast/assess/assess?id=${content.id}&title=${encodeURIComponent(content.title || '')}`
        });
    },

    noop() {}
});
