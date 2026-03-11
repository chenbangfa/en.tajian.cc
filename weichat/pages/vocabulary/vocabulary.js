// pages/vocabulary/vocabulary.js
const api = require('../../services/api');

Page({
    data: {
        categories: [],
        parentCategories: [],  // 一级分类
        childCategories: [],   // 当前选中一级分类的二级分类
        currentCategory: 0,    // 用于API查询的分类ID
        currentSubCategory: 0, // 当前选中的二级分类ID
        currentCategoryName: '',       // 显示用：一级分类名
        currentSubCategoryName: '',    // 显示用：二级分类名
        selectedParent: 0,     // 抽屉中选中的一级分类ID
        selectedParentName: '', // 抽屉中选中的一级分类名
        showDrawer: false,
        words: [],
        loading: false,
        loadingMore: false,    // 加载更多状态（区分首次加载和翻页）
        hasMore: true,
        page: 1,
        limit: 10,
        generatingAudioId: 0   // 正在生成音频的单词ID（用于显示loading）
    },

    onLoad() {
        this.loadCategories();
        this.loadWords();
    },

    onPullDownRefresh() {
        this.setData({ page: 1, hasMore: true });
        this.loadWords().then(() => {
            wx.stopPullDownRefresh();
        });
    },

    // 页面上拉触底自动加载更多
    onReachBottom() {
        if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) {
            this.setData({ page: this.data.page + 1, loadingMore: true });
            this.loadWords(true).finally(() => {
                this.setData({ loadingMore: false });
            });
        }
    },

    async loadCategories() {
        try {
            const res = await api.get('/categories');
            if (res.success) {
                const allCategories = res.data;
                // 分离一级分类（没有parent_id的）和二级分类
                const parentCategories = allCategories.filter(c => !c.parent_id);
                this.setData({
                    categories: allCategories,
                    parentCategories
                });
            }
        } catch (e) {
            console.error('加载分类失败:', e);
        }
    },

    // 打开分类抽屉
    openDrawer() {
        this.setData({ showDrawer: true });
    },

    // 关闭分类抽屉
    closeDrawer() {
        this.setData({ showDrawer: false });
    },

    // 选择一级分类（抽屉左侧）
    selectParent(e) {
        const id = parseInt(e.currentTarget.dataset.id);
        const name = e.currentTarget.dataset.name || '';

        if (id === 0) {
            // 选择"全部"
            this.setData({
                selectedParent: 0,
                selectedParentName: '',
                childCategories: [],
                currentCategory: 0,
                currentSubCategory: 0,
                currentCategoryName: '',
                currentSubCategoryName: '',
                showDrawer: false,
                page: 1,
                hasMore: true
            });
            this.loadWords();
        } else {
            // 选择某个一级分类，加载其二级分类
            const childCategories = this.data.categories.filter(c => c.parent_id === id);
            this.setData({
                selectedParent: id,
                selectedParentName: name,
                childCategories
            });
        }
    },

    // 选择二级分类（抽屉右侧）
    selectChild(e) {
        const id = parseInt(e.currentTarget.dataset.id);
        const name = e.currentTarget.dataset.name || '';

        if (id === 0) {
            // 选择"全部xx"（查询一级分类下所有）
            this.setData({
                currentCategory: this.data.selectedParent,
                currentSubCategory: 0,
                currentCategoryName: this.data.selectedParentName,
                currentSubCategoryName: '',
                showDrawer: false,
                page: 1,
                hasMore: true
            });
        } else {
            // 选择某个二级分类
            this.setData({
                currentCategory: id,  // API查询用二级分类ID
                currentSubCategory: id,
                currentCategoryName: this.data.selectedParentName,
                currentSubCategoryName: name,
                showDrawer: false,
                page: 1,
                hasMore: true
            });
        }
        this.loadWords();
    },

    async loadWords(append = false) {
        if (this.data.loading) return;

        this.setData({ loading: true });

        try {
            const params = {
                page: this.data.page,
                limit: this.data.limit
            };

            if (this.data.currentCategory > 0) {
                params.category_id = this.data.currentCategory;
            }

            const res = await api.get('/words', params);

            if (res.success) {
                const app = getApp();
                // 获取服务器基础地址 (去掉/api)
                const baseUrl = app.globalData.baseUrl.replace('/api', '');

                const newWords = res.data.list.map(word => {
                    // 处理图片URL
                    if (word.image_url && word.image_url.startsWith('/')) {
                        word.image_url = baseUrl + word.image_url;
                    }
                    // 处理音频URL (优先使用女声)
                    if (word.audio_url_female && word.audio_url_female.startsWith('/')) {
                        word.audio_url_female = baseUrl + word.audio_url_female;
                    }
                    if (word.audio_url_male && word.audio_url_male.startsWith('/')) {
                        word.audio_url_male = baseUrl + word.audio_url_male;
                    }
                    // 设置默认播放音频为女声
                    word.audio_url = word.audio_url_female || word.audio_url_male || null;
                    return word;
                });

                this.setData({
                    words: append ? [...this.data.words, ...newWords] : newWords,
                    hasMore: newWords.length >= this.data.limit
                });
            }
        } catch (e) {
            console.error('加载单词失败:', e);
            wx.showToast({ title: '加载失败', icon: 'none' });
        } finally {
            this.setData({ loading: false });
        }
    },

    selectCategory(e) {
        const id = parseInt(e.currentTarget.dataset.id);
        this.setData({
            currentCategory: id,
            page: 1,
            hasMore: true
        });
        this.loadWords();
    },

    goToDetail(e) {
        const id = e.currentTarget.dataset.id;
        wx.navigateTo({ url: `/pages/vocabulary/detail/detail?id=${id}` });
    },

    playAudio(e) {
        const { id, word, url } = e.currentTarget.dataset;

        if (url) {
            // 有音频，直接播放
            const audio = wx.createInnerAudioContext();
            audio.src = url;
            audio.play();
            audio.onError((err) => {
                console.error('音频播放错误:', err);
                wx.showToast({ title: '播放失败', icon: 'none' });
            });
        } else if (id) {
            // 没有音频，触发后台生成并等待播放
            this._generateAndPlay(id, word);
        }
    },

    /**
     * 没有音频时，调用 ensure-audio API 生成，然后轮询获取并播放
     */
    async _generateAndPlay(wordId, wordText) {
        // 防止重复点击
        if (this.data.generatingAudioId === wordId) return;

        this.setData({ generatingAudioId: wordId });
        wx.showLoading({ title: '生成发音中...', mask: false });

        try {
            // 触发后台生成
            const res = await api.post(`/words/${wordId}/ensure-audio`);
            if (!res.success || !res.generating || res.generating.length === 0) {
                wx.hideLoading();
                this.setData({ generatingAudioId: 0 });
                wx.showToast({ title: '暂无法生成', icon: 'none' });
                return;
            }

            // 轮询等待音频就绪（每2秒查一次，最多查10次=20秒）
            const maxPolls = 10;
            const interval = 2000;
            let found = false;

            for (let i = 0; i < maxPolls; i++) {
                await new Promise(r => setTimeout(r, interval));

                try {
                    const wordRes = await api.get(`/words/${wordId}`);
                    if (wordRes.success && wordRes.data) {
                        const w = wordRes.data;
                        const audioUrl = w.audio_url_female || w.audio_url_male;

                        if (audioUrl) {
                            // 音频已生成，更新列表数据并播放
                            const app = getApp();
                            const baseUrl = app.globalData.baseUrl.replace('/api', '');
                            const fullUrl = audioUrl.startsWith('/') ? baseUrl + audioUrl : audioUrl;

                            // 更新 words 列表中对应项的音频
                            const words = this.data.words;
                            const idx = words.findIndex(item => item.id === wordId);
                            if (idx >= 0) {
                                const updatedFields = {};
                                if (w.audio_url_female) {
                                    const femaleUrl = w.audio_url_female.startsWith('/') ? baseUrl + w.audio_url_female : w.audio_url_female;
                                    updatedFields[`words[${idx}].audio_url_female`] = femaleUrl;
                                    updatedFields[`words[${idx}].audio_url`] = femaleUrl;
                                }
                                if (w.audio_url_male) {
                                    const maleUrl = w.audio_url_male.startsWith('/') ? baseUrl + w.audio_url_male : w.audio_url_male;
                                    updatedFields[`words[${idx}].audio_url_male`] = maleUrl;
                                    if (!w.audio_url_female) {
                                        updatedFields[`words[${idx}].audio_url`] = maleUrl;
                                    }
                                }
                                this.setData(updatedFields);
                            }

                            // 播放
                            wx.hideLoading();
                            const audio = wx.createInnerAudioContext();
                            audio.src = fullUrl;
                            audio.play();
                            found = true;
                            break;
                        }
                    }
                } catch (pollErr) {
                    console.log('[playAudio] 轮询出错:', pollErr);
                }
            }

            if (!found) {
                wx.hideLoading();
                wx.showToast({ title: '生成超时，请稍后再试', icon: 'none' });
            }
        } catch (e) {
            wx.hideLoading();
            console.error('[playAudio] 生成音频失败:', e);
            wx.showToast({ title: '生成失败', icon: 'none' });
        } finally {
            this.setData({ generatingAudioId: 0 });
        }
    }
});
