const api = require('../../services/api');
Page({
    data: { imageUrl: '', objects: [], loading: false },
    takePhoto() {
        const ctx = wx.createCameraContext();
        ctx.takePhoto({
            quality: 'high',
            success: (res) => {
                this.setData({ imageUrl: res.tempImagePath });
                this.recognizeImage(res.tempImagePath);
            }
        });
    },
    async recognizeImage(path) {
        this.setData({ loading: true });
        try {
            const res = await api.upload('/ai/recognize', path);
            if (res.success) this.setData({ objects: res.data.objects || [] });
            else wx.showToast({ title: res.message || '识别失败', icon: 'none' });
        } catch (e) { wx.showToast({ title: '识别失败', icon: 'none' }); }
        finally { this.setData({ loading: false }); }
    },
    retake() { this.setData({ imageUrl: '', objects: [] }); },
    playWord(e) { wx.showToast({ title: e.currentTarget.dataset.word, icon: 'none' }); },
    saveResult() { wx.showToast({ title: '保存成功', icon: 'success' }); wx.navigateBack(); }
});
