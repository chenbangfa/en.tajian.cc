const api = require('../../services/api');

Page({
    data: {
        // Categories Logic
        categories: [],
        parentCategories: [],
        childCategories: [],

        // Selection State
        selectedParent: 0,
        selectedParentName: '',
        currentCategory: 0,      // API filter ID
        currentSubCategory: 0,   // Active Child ID

        // Display Names
        currentCategoryName: '全部',

        // UI State
        showDrawer: false,

        // Content List
        contents: [],
        loading: false,
        hasMore: true,
        page: 1,
        limit: 10
    },

    onLoad() {
        this.loadCategories();
        this.loadContents();
    },

    onPullDownRefresh() {
        this.setData({ page: 1, hasMore: true });
        this.loadContents().then(() => wx.stopPullDownRefresh());
    },

    onReachBottom() {
        if (this.data.hasMore) {
            this.setData({ page: this.data.page + 1 });
            this.loadContents(true);
        }
    },

    // Load 2-level categories
    async loadCategories() {
        try {
            const res = await api.get('/podcast-categories');
            if (res.success) {
                const all = res.data;
                const parents = all.filter(c => !c.parent_id);
                this.setData({
                    categories: all,
                    parentCategories: parents
                });
            }
        } catch (e) { console.error(e); }
    },

    // Drawer Actions
    openDrawer() { this.setData({ showDrawer: true }); },
    closeDrawer() { this.setData({ showDrawer: false }); },

    // Select Parent Category (Left Side)
    selectParent(e) {
        const id = parseInt(e.currentTarget.dataset.id);
        const name = e.currentTarget.dataset.name;

        if (id === 0) {
            // Select "All" -> Reset everything
            this.setData({
                selectedParent: 0,
                selectedParentName: '',
                childCategories: [],

                // Reset effective filter
                currentCategory: 0,
                currentSubCategory: 0,
                currentCategoryName: '全部',
                showDrawer: false,
                page: 1
            });
            this.loadContents();
        } else {
            // Select specific parent -> Show children
            const children = this.data.categories.filter(c => c.parent_id === id);
            this.setData({
                selectedParent: id,
                selectedParentName: name,
                childCategories: children
            });
        }
    },

    // Select Child Category (Right Side)
    selectChild(e) {
        const id = parseInt(e.currentTarget.dataset.id);
        const name = e.currentTarget.dataset.name;

        if (id === 0) {
            // "All" under a parent category
            this.setData({
                currentCategory: this.data.selectedParent, // Filter by Parent ID
                currentSubCategory: 0,
                currentCategoryName: this.data.selectedParentName,
                showDrawer: false,
                page: 1
            });
        } else {
            // Specific child category
            this.setData({
                currentCategory: id,
                currentSubCategory: id,
                currentCategoryName: name,
                showDrawer: false,
                page: 1
            });
        }
        this.loadContents();
    },

    async loadContents(append = false) {
        if (this.data.loading && !append) return;
        this.setData({ loading: true });

        try {
            const params = {
                page: this.data.page,
                limit: this.data.limit
            };

            if (this.data.currentCategory > 0) {
                params.category_id = this.data.currentCategory;
            }

            const res = await api.get('/podcast', params);
            if (res.success) {
                const list = res.data.list;
                this.setData({
                    contents: append ? [...this.data.contents, ...list] : list,
                    hasMore: list.length >= this.data.limit
                });
            }
        } catch (e) { console.error(e); }
        finally { this.setData({ loading: false }); }
    },

    goToPlayer(e) {
        const id = e.currentTarget.dataset.id;
        wx.navigateTo({ url: `/pages/podcast/player/player?id=${id}` });
    }
});
