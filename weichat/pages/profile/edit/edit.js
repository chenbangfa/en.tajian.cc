// pages/profile/edit/edit.js
Page({
    data: {
        userInfo: {
            avatar_url: '/assets/images/default-avatar.png',
            nickname: '学习小达人',
            phone: '13800138000',
            id: '888888'
        },
        loading: false
    },

    onLoad(options) {
        // 静态展示，不加载真实数据
    },

    onChooseAvatar(e) {
        console.log('点击了选择头像 (静态演示)', e);
    },

    onNicknameBlur(e) {
        console.log('昵称输入结束 (静态演示)', e.detail.value);
    },

    onNicknameInput(e) {
        console.log('昵称输入中 (静态演示)', e.detail.value);
    },

    onPhoneInput(e) {
        console.log('手机号输入 (静态演示)', e.detail.value);
    },

    handleSave() {
        console.log('点击保存 (静态演示)');
        wx.showToast({
            title: '静态演示模式',
            icon: 'none'
        });
    }
});
