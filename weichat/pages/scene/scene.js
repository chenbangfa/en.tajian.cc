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
        scenes: [],
        loading: false,
        hasMore: true,
        page: 1,
        limit: 10
    },

    onLoad() {
        this.loadCategories();
        this.loadScenes();
    },

    onPullDownRefresh() {
        this.setData({ page: 1, hasMore: true });
        this.loadScenes().then(() => {
            wx.stopPullDownRefresh();
        });
    },

    async loadCategories() {
        try {
            // Note: Updated to use new scene-categories endpoint
            const res = await api.get('/scene-categories');
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
            this.loadScenes();
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
        this.loadScenes();
    },

    async loadScenes(append = false) {
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

            const res = await api.get('/scenes', params);

            if (res.success) {
                const newScenes = res.data.list;

                this.setData({
                    scenes: append ? [...this.data.scenes, ...newScenes] : newScenes,
                    hasMore: newScenes.length >= this.data.limit
                });
            }
        } catch (e) {
            console.error('加载场景失败:', e);
            wx.showToast({ title: '加载失败', icon: 'none' });
        } finally {
            this.setData({ loading: false });
        }
    },

    goToDetail(e) {
        const id = e.currentTarget.dataset.id;
        wx.navigateTo({ url: `/pages/scene/detail/detail?id=${id}` });
    }
});
