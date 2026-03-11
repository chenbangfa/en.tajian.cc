// pages/vip/vip.js
const app = getApp();

Page({
    data: {
        userInfo: null,
        selectedType: 'vip', // 'vip' or 'point'
        selectedPlanIndex: 1, // 默认选中年卡
        selectedPointIndex: -1,
        loading: false,
        currentPrice: '168',
        plans: [
            {
                id: 'month',
                name: '月度VIP',
                pointsGrant: '送3000积分/月',
                price: '19.9',
                desc: '低门槛体验'
            },
            {
                id: 'year',
                name: '年度VIP',
                pointsGrant: '送36000积分/年',
                price: '168',
                originalPrice: '238.8',
                desc: '省 ¥70.8',
                recommend: true
            }
        ],
        pointPackages: [
            { id: 'p1', points: 600, price: '6', desc: '¥1/100分' },
            { id: 'p2', points: 2000, price: '18', desc: '9折优惠' },
            { id: 'p3', points: 8000, price: '68', desc: '85折优惠' }
        ],
        benefits: [
            { name: 'AI语音评测', desc: '无限次精准纠音', icon: '/assets/icons/icon-mic.svg' },
            { name: '专属课程', desc: '解锁全部高级课程', icon: '/assets/icons/icon-book.svg' },
            { name: '离线下载', desc: '随时随地磨耳朵', icon: '/assets/icons/icon-archive.svg' },
            { name: '尊贵标识', desc: '专属VIP皇冠头像', icon: '/assets/icons/icon-crown.svg' }
        ]
    },

    onLoad(options) {
        this.setData({
            userInfo: app.globalData.userInfo
        });
    },

    selectVipPlan(e) {
        const index = e.currentTarget.dataset.index;
        this.setData({
            selectedType: 'vip',
            selectedPlanIndex: index,
            selectedPointIndex: -1,
            currentPrice: this.data.plans[index].price
        });
    },

    selectPointPackage(e) {
        const index = e.currentTarget.dataset.index;
        this.setData({
            selectedType: 'point',
            selectedPointIndex: index,
            selectedPlanIndex: -1,
            currentPrice: this.data.pointPackages[index].price
        });
    },

    handleSubscribe() {
        if (this.data.loading) return;

        let item, typeName;
        if (this.data.selectedType === 'vip') {
            item = this.data.plans[this.data.selectedPlanIndex];
            typeName = item.name;
        } else {
            item = this.data.pointPackages[this.data.selectedPointIndex];
            typeName = item.points + '积分包';
        }

        if (!item) {
            wx.showToast({ title: '请选择商品', icon: 'none' });
            return;
        }

        // 模拟支付流程
        wx.showModal({
            title: '确认支付',
            content: `确定支付 ¥${item.price} 购买${typeName}吗？\n(模拟支付环境)`,
            confirmColor: '#CEA868',
            success: (res) => {
                if (res.confirm) {
                    this.processPayment(item, this.data.selectedType);
                }
            }
        });
    },

    processPayment(item, type) {
        this.setData({ loading: true });
        wx.showLoading({ title: '支付中...' });

        // 模拟后端API调用延迟
        setTimeout(() => {
            wx.hideLoading();
            this.setData({ loading: false });

            if (type === 'vip') {
                this.updateVipStatus(item);
            } else {
                this.updatePoints(item);
            }

            wx.showToast({
                title: '购买成功',
                icon: 'success',
                duration: 2000
            });

            // 稍微延迟后刷新显示，不一定要返回
            const pages = getCurrentPages();
            const prevPage = pages[pages.length - 2];
            if (prevPage) {
                prevPage.setData({ userInfo: this.data.userInfo });
            }

        }, 1500);
    },

    updateVipStatus(plan) {
        // 模拟更新VIP
        const now = new Date();
        const durationDays = plan.id === 'year' ? 365 : 30;
        const expireDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
        const expireDateStr = expireDate.toISOString().split('T')[0];

        // 赠送积分
        const pointsGrant = plan.id === 'year' ? 36000 : 3000;

        const newUserInfo = {
            ...this.data.userInfo,
            vip_level: 1,
            vip_expire_date: expireDateStr,
            points: (this.data.userInfo.points || 0) + pointsGrant
        };

        app.globalData.userInfo = newUserInfo;
        this.setData({ userInfo: newUserInfo });
    },

    updatePoints(pkg) {
        const newUserInfo = {
            ...this.data.userInfo,
            points: (this.data.userInfo.points || 0) + pkg.points
        };

        app.globalData.userInfo = newUserInfo;
        this.setData({ userInfo: newUserInfo });
    }
});
