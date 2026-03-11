const app = getApp();
const api = require('../../services/api');

Page({
    data: {
        currentPoints: 0,
        list: [],
        page: 1,
        hasMore: true,
        isLoading: false,
        isRefreshing: false,
        currentType: 'all',
        startDate: '',
        endDate: '',
        showFilterModal: false,
        tempStartDate: '',
        tempEndDate: ''
    },

    onLoad() {
        this.loadPoints();
    },

    // 切换类型
    onTabChange(e) {
        const type = e.currentTarget.dataset.type;
        if (this.data.currentType === type) return;

        this.setData({
            currentType: type,
            page: 1,
            hasMore: true,
            list: []
        }, () => {
            this.loadPoints();
        });
    },

    // 打开筛选弹窗
    openFilterModal() {
        this.setData({
            showFilterModal: true,
            tempStartDate: this.data.startDate,
            tempEndDate: this.data.endDate
        });
    },

    // 关闭筛选弹窗
    closeFilterModal() {
        this.setData({
            showFilterModal: false
        });
    },

    // 选择临时开始日期
    onTempStartDateChange(e) {
        this.setData({ tempStartDate: e.detail.value });
    },

    // 选择临时结束日期
    onTempEndDateChange(e) {
        this.setData({ tempEndDate: e.detail.value });
    },

    // 重置筛选
    resetFilter() {
        this.setData({
            tempStartDate: '',
            tempEndDate: ''
        });
    },

    // 确认筛选
    confirmFilter() {
        this.setData({
            startDate: this.data.tempStartDate,
            endDate: this.data.tempEndDate,
            showFilterModal: false,
            page: 1,
            hasMore: true,
            list: []
        }, () => {
            this.loadPoints();
        });
    },

    // 下拉刷新
    onPullDownRefresh() {
        this.setData({
            page: 1,
            hasMore: true,
            isRefreshing: true
        }, () => {
            this.loadPoints();
        });
    },

    // 上拉加载更多
    onReachBottom() {
        if (this.data.hasMore && !this.data.isLoading) {
            this.setData({
                page: this.data.page + 1
            }, () => {
                this.loadPoints();
            });
        }
    },

    async loadPoints() {
        if (this.data.isLoading && !this.data.isRefreshing) return;

        this.setData({ isLoading: true });

        try {
            const params = {
                page: this.data.page,
                limit: 20,
                type: this.data.currentType
            };

            if (this.data.startDate) params.startDate = this.data.startDate;
            if (this.data.endDate) params.endDate = this.data.endDate;

            const res = await api.get('/users/points', params);

            if (res.success) {
                const newItems = res.data.list.map(item => ({
                    ...item,
                    formattedDate: this.formatDate(item.created_at),
                    isPositive: item.change_amount > 0,
                    amountStr: item.change_amount > 0 ? `+${item.change_amount}` : `${item.change_amount}`
                }));

                // 如果是第一页（或刷新），覆盖列表；否则追加
                const list = this.data.page === 1 ? newItems : this.data.list.concat(newItems);

                this.setData({
                    list: list,
                    currentPoints: res.data.current_points,
                    hasMore: list.length < res.data.pagination.total,
                    isLoading: false,
                    isRefreshing: false
                });

                if (this.data.isRefreshing) {
                    wx.stopPullDownRefresh();
                }
            }
        } catch (err) {
            console.error('加载积分明细失败', err);
            this.setData({ isLoading: false, isRefreshing: false });
            wx.showToast({
                title: '加载失败',
                icon: 'none'
            });
        }
    },

    formatDate(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const y = date.getFullYear();
        const m = (date.getMonth() + 1).toString().padStart(2, '0');
        const d = date.getDate().toString().padStart(2, '0');
        const h = date.getHours().toString().padStart(2, '0');
        const min = date.getMinutes().toString().padStart(2, '0');
        return `${y}-${m}-${d} ${h}:${min}`;
    }
});
