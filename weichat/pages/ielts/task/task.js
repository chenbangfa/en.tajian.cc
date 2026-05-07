const api = require('../../../services/api');
const recorderManager = wx.getRecorderManager();

Page({
  data: {
    dayNumber: 1,
    day: {},
    modules: [],
    currentModule: {},
    activeModuleId: null,
    taskModuleId: null,
    summary: { required_count: 0, completed_required: 0, complete: false },
    typeLabels: {
      goal: '目标', vocabulary: '单词', pronunciation: '发音', grammar: '语法',
      grammar_drill: '语法闯关', listening: '听力', podcast_listening: '文章听力',
      shadowing: '跟读', speaking: '口语', speaking_output: '口语输出',
      writing: '写作', sentence_builder: '拼句写作', typing_writing: '拼写写作'
    },
    writingText: '',
    ttsPlaying: false,
    playingItemKey: '',
    isRecording: false,
    recordingItemKey: '',
    assessingItemKey: '',
    isAssessing: false,
    recordingTime: 0,
    speakingResult: {},
    passScore: 80,
    passScoreOptions: [70, 80, 90]
  },

  _audioCtx: null,
  _recordTimer: null,
  _recorderBound: false,
  _recordTarget: null,
  _ttsUrlCache: {},

  onLoad(options) {
    const savedPassScore = Number(wx.getStorageSync('ieltsPassScore') || 80);
    const moduleId = Number(options.moduleId || options.id || 0);
    this.setData({
      dayNumber: Number(options.day || 1),
      activeModuleId: moduleId || null,
      taskModuleId: moduleId || null,
      passScore: [70, 80, 90].includes(savedPassScore) ? savedPassScore : 80
    });
    this._bindRecorder();
    this.loadDay();
  },

  onShow() {
    // 其他评测页也会使用全局 RecorderManager，返回本页时重新绑定，避免回调被覆盖。
    this._bindRecorder(true);
  },

  onUnload() {
    this._stopAudio();
    this._clearRecordTimer();
    try { recorderManager.stop(); } catch (e) {}
  },

  _bindRecorder(force = false) {
    if (this._recorderBound && !force) return;
    if (force) {
      try { recorderManager.offStop(); } catch (e) {}
      try { recorderManager.offError(); } catch (e) {}
    }
    this._recorderBound = true;
    recorderManager.onStop((res) => {
      this._clearRecordTimer();
      const target = this._recordTarget || { mode: 'module' };
      this._recordTarget = null;
      this.setData({ isRecording: false, recordingTime: 0, recordingItemKey: '' });
      if (target.mode === 'item') {
        this.submitItemAssessment(res.tempFilePath, target);
      } else {
        this.submitSpeaking(res.tempFilePath);
      }
    });
    recorderManager.onError(() => {
      this._clearRecordTimer();
      this._recordTarget = null;
      this.setData({ isRecording: false, recordingTime: 0, recordingItemKey: '', assessingItemKey: '', isAssessing: false });
      wx.showToast({ title: '录音失败', icon: 'none' });
    });
  },

  _clearRecordTimer() {
    if (this._recordTimer) {
      clearInterval(this._recordTimer);
      this._recordTimer = null;
    }
  },

  _stopRecordingUi() {
    this._clearRecordTimer();
    this.setData({ isRecording: false, recordingTime: 0, recordingItemKey: '' });
  },

  _getItemExample(item) {
    const payload = item && item.payload ? item.payload : {};
    const example = payload.example_sentence || payload.example || payload.sentence || payload.sample || '';
    if (example) return String(example).trim();
    if (item.type === 'word' && item.prompt && item.prompt !== item.title) return String(item.prompt).trim();
    return '';
  },

  _getItemExampleTranslation(item) {
    const payload = item && item.payload ? item.payload : {};
    return String(payload.example_translation || payload.exampleTranslation || payload.example_cn || payload.exampleCn || '').trim();
  },

  _getItemGrammarExplanation(item) {
    const payload = item && item.payload ? item.payload : {};
    return String(payload.grammar_explanation || payload.grammarExplanation || payload.grammar || '').trim();
  },

  _getItemPhonetic(item) {
    const payload = item && item.payload ? item.payload : {};
    return String(payload.phonetic || item.phonetic || '').trim();
  },

  _getItemReference(item, module = {}, kind = 'main') {
    const payload = item && item.payload ? item.payload : {};
    if (kind === 'example') return this._getItemExample(item);
    if (['word', 'pronunciation'].includes(item.type) || module.module_type === 'vocabulary' || module.module_type === 'pronunciation') {
      return String(payload.word || item.word || item.title || '').trim();
    }
    const text = item.reference_text || item.prompt || payload.reference_text || payload.prompt || payload.text || payload.en || payload.sentence || '';
    if (text) return String(text).trim();
    if (['listening', 'podcast_listening', 'shadowing', 'speaking_output'].includes(item.type)) return String(item.title || '').trim();
    return String(item.title || '').trim();
  },

  _getAssessContentType(item, module = {}, kind = 'main') {
    if (kind === 'example') return 'sentence';
    if (['word', 'pronunciation'].includes(item.type) || ['vocabulary', 'pronunciation'].includes(module.module_type)) return 'word';
    if (['speaking', 'speaking_output'].includes(item.type) || ['speaking', 'speaking_output'].includes(module.module_type)) return 'paragraph';
    const reference = this._getItemReference(item, module);
    const sentenceCount = (reference.match(/[.!?。！？]/g) || []).length;
    return reference.length > 80 || sentenceCount > 1 ? 'paragraph' : 'sentence';
  },

  _canAssessItem(item, module = {}) {
    const trainableTypes = ['goal', 'word', 'pronunciation', 'grammar_drill', 'listening', 'podcast_listening', 'shadowing', 'speaking_output'];
    const trainableModules = ['goal', 'vocabulary', 'pronunciation', 'grammar', 'grammar_drill', 'listening', 'podcast_listening', 'shadowing', 'speaking', 'speaking_output'];
    return !!this._getItemReference(item, module) && (trainableTypes.includes(item.type) || trainableModules.includes(module.module_type));
  },

  async loadDay() {
    wx.showLoading({ title: '加载中...' });
    try {
      const res = await api.get(`/ielts/days/${this.data.dayNumber}`);
      if (res.success) {
        const modules = (res.data.modules || []).map(m => ({
          ...m,
          type_label: this.data.typeLabels[m.module_type] || m.module_type,
          items: (m.items || []).map((item, index) => {
            const referenceText = this._getItemReference(item, m);
            const exampleText = this._getItemExample(item);
            const exampleTranslation = this._getItemExampleTranslation(item);
            const grammarExplanation = this._getItemGrammarExplanation(item);
            const phonetic = this._getItemPhonetic(item);
            const payload = item.payload || {};
            const passedParts = item.progress && item.progress.passed_parts ? item.progress.passed_parts : {};
            return {
              ...item,
              index: index + 1,
              type_label: this.data.typeLabels[item.type] || item.type || '任务',
              reference_text: referenceText,
              example_text: exampleText,
              example_translation: exampleTranslation,
              grammar_explanation: grammarExplanation,
              phonetic,
              audio_url: payload.audio_url || '',
              audio_url_female: payload.audio_url_female || payload.audio_url || '',
              audio_url_male: payload.audio_url_male || '',
              example_audio_female: payload.example_audio_female || '',
              example_audio_male: payload.example_audio_male || '',
              content_type: this._getAssessContentType(item, m),
              example_content_type: 'sentence',
              can_play: !!referenceText,
              can_assess: this._canAssessItem(item, m),
              can_example_play: !!exampleText,
              can_example_assess: !!exampleText && (item.type === 'word' || ['vocabulary', 'pronunciation', 'grammar', 'grammar_drill'].includes(m.module_type)),
              main_passed: !!passedParts.main || !!item.completed,
              example_passed: !!passedParts.example || !!item.completed,
              pass_score: Number(this.data.passScore || 80)
            };
          })
        }));
        const activeModuleId = Number(this.data.taskModuleId || this.data.activeModuleId || 0);
        const current = (activeModuleId ? modules.find(m => Number(m.id) === activeModuleId) : null)
          || modules[0]
          || {};
        this.setData({
          day: res.data.day || {},
          modules,
          summary: res.data.summary || {},
          activeModuleId: current.id || null,
          currentModule: current,
          writingText: current.progress && current.progress.answer_text ? current.progress.answer_text : ''
        });
        wx.setNavigationBarTitle({ title: current.title || res.data.day.title || 'IELTS 任务' });
      } else {
        wx.showToast({ title: res.message || '加载失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  selectModule(e) {
    const id = Number(e.currentTarget.dataset.id);
    const mod = this.data.modules.find(m => Number(m.id) === id) || {};
    this.setData({
      activeModuleId: id,
      currentModule: mod,
      writingText: mod.progress && mod.progress.answer_text ? mod.progress.answer_text : '',
      speakingResult: ['speaking', 'speaking_output'].includes(mod.module_type) && mod.progress && mod.progress.score ? { overall_score: mod.progress.score } : {}
    });
  },

  onWritingInput(e) {
    this.setData({ writingText: e.detail.value });
  },

  async submitWritingTask() {
    const mod = this.data.currentModule || {};
    const podcast = mod.podcast_content || {};
    const firstItem = (mod.items || [])[0];
    const text = (this.data.writingText || '').trim();
    if (this.data.isAssessing) return;
    if (text.length < 20) {
      wx.showToast({ title: '先写一段英文内容', icon: 'none' });
      return;
    }

    this.setData({ isAssessing: true });
    wx.showLoading({ title: '保存中...' });
    try {
      if (firstItem && firstItem.key) {
        const res = await api.post(`/ielts/modules/${mod.id}/items/${encodeURIComponent(firstItem.key)}/complete`, {
          answer_text: text,
          progress: {
            writing_submitted: true,
            word_count: text.split(/\s+/).filter(Boolean).length,
            reference_text: podcast.content_text || firstItem.prompt || '',
            podcast_content_id: podcast.id || null
          }
        });
        if (!res.success) {
          wx.showToast({ title: res.message || '保存失败', icon: 'none' });
          return;
        }
      } else {
        await this.completeCurrentModule({
          progress: {
            writing_submitted: true,
            word_count: text.split(/\s+/).filter(Boolean).length,
            podcast_content_id: podcast.id || null
          }
        });
      }
      wx.showToast({ title: '写作已提交', icon: 'success' });
      await this.loadDay();
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      this.setData({ isAssessing: false });
      wx.hideLoading();
    }
  },

  changePassScore(e) {
    const score = Number(e.currentTarget.dataset.score || 80);
    wx.setStorageSync('ieltsPassScore', score);
    const rebuildItems = (items = []) => items.map(item => ({ ...item, pass_score: score }));
    const modules = (this.data.modules || []).map(module => ({
      ...module,
      items: rebuildItems(module.items || [])
    }));
    const currentModule = {
      ...this.data.currentModule,
      items: rebuildItems(this.data.currentModule.items || [])
    };
    this.setData({ passScore: score, modules, currentModule });
    wx.showToast({ title: `${score} 分过关`, icon: 'none' });
  },

  async completeItem(e) {
    const key = e.currentTarget.dataset.key;
    const mod = this.data.currentModule;
    const item = (mod.items || []).find(entry => entry.key === key);
    if (!mod.id || !item) return;

    const body = { progress: { manual: true, item_type: item.type } };
    const writingTypes = ['writing', 'sentence_builder', 'typing_writing'];
    if (writingTypes.includes(mod.module_type) || writingTypes.includes(item.type)) {
      const text = (this.data.writingText || '').trim();
      if (text.length < 10) {
        wx.showToast({ title: '先完成写作/拼句内容', icon: 'none' });
        return;
      }
      body.answer_text = text;
      body.progress.word_count = text.split(/\s+/).filter(Boolean).length;
    }

    wx.showLoading({ title: '保存中...' });
    try {
      const res = await api.post(`/ielts/modules/${mod.id}/items/${encodeURIComponent(key)}/complete`, body);
      if (res.success) {
        wx.showToast({ title: res.data && res.data.item_summary && res.data.item_summary.complete ? '模块过关' : '任务过关', icon: 'success' });
        await this.loadDay();
      } else {
        wx.showToast({ title: res.message || '保存失败', icon: 'none' });
      }
    } catch (err) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async playItem(e) {
    const key = e.currentTarget.dataset.key;
    const kind = e.currentTarget.dataset.kind || 'main';
    const item = (this.data.currentModule.items || []).find(entry => entry.key === key);
    const text = kind === 'example' ? item && item.example_text : item && item.reference_text;
    if (!item || !text) {
      wx.showToast({ title: '没有可播放文本', icon: 'none' });
      return;
    }
    const savedAudioUrl = kind === 'example'
      ? (item.example_audio_female || '')
      : (item.audio_url_female || item.audio_url || '');
    if (savedAudioUrl) {
      this._playAudioUrl(this._normalizeMediaUrl(savedAudioUrl), { itemKey: `${key}:${kind}` });
      return;
    }
    await this._playText(text, { itemKey: `${key}:${kind}` });
  },

  async completeCurrentModule(extra = {}) {
    const mod = this.data.currentModule;
    if (!mod.id) return;
    const body = { progress: { manual: true, ...extra.progress } };

    if (['writing', 'sentence_builder', 'typing_writing'].includes(mod.module_type)) {
      const text = (this.data.writingText || '').trim();
      if (text.length < 20) {
        wx.showToast({ title: '先写完 5 句英文', icon: 'none' });
        return;
      }
      body.answer_text = text;
      body.progress.word_count = text.split(/\s+/).filter(Boolean).length;
    }

    if (extra.score) body.score = extra.score;
    if (extra.assessment_id) body.assessment_id = extra.assessment_id;

    wx.showLoading({ title: '保存中...' });
    try {
      const res = await api.post(`/ielts/modules/${mod.id}/complete`, body);
      if (res.success) {
        wx.showToast({ title: '已完成', icon: 'success' });
        await this.loadDay();
      } else {
        wx.showToast({ title: res.message || '保存失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  async playListening() {
    const text = this.data.currentModule.content && this.data.currentModule.content.text;
    if (!text || this.data.ttsPlaying) return;
    await this._playText(text);
  },

  _getPodcastIeltsParams() {
    const mod = this.data.currentModule || {};
    const podcast = mod.podcast_content || {};
    const firstItem = (mod.items || [])[0] || {};
    if (!podcast.id) return '';
    return [
      `ielts_module_id=${encodeURIComponent(mod.id || '')}`,
      `ielts_item_key=${encodeURIComponent(firstItem.key || '')}`,
      `ielts_pass_score=${encodeURIComponent(this.data.passScore || firstItem.pass_score || 80)}`,
      `ielts_day=${encodeURIComponent(this.data.dayNumber || 1)}`
    ].join('&');
  },

  openPodcastPlayer() {
    const mod = this.data.currentModule || {};
    const podcast = mod.podcast_content || {};
    if (!podcast.id) {
      wx.showToast({ title: '未绑定文章', icon: 'none' });
      return;
    }
    const extra = this._getPodcastIeltsParams();
    wx.navigateTo({
      url: `/pages/podcast/player/player?id=${podcast.id}&${extra}`
    });
  },

  openPodcastAssess() {
    const mod = this.data.currentModule || {};
    const podcast = mod.podcast_content || {};
    if (!podcast.id) {
      wx.showToast({ title: '未绑定文章', icon: 'none' });
      return;
    }
    const extra = this._getPodcastIeltsParams();
    wx.navigateTo({
      url: `/pages/podcast/assess/assess?id=${podcast.id}&title=${encodeURIComponent(podcast.title || '')}&${extra}`
    });
  },

  async _playText(text, options = {}) {
    const cacheKey = `${options.voice || 'female'}:${text}`;
    if (this._ttsUrlCache[cacheKey]) {
      this._playAudioUrl(this._ttsUrlCache[cacheKey], options);
      return;
    }
    wx.showLoading({ title: '加载音频...' });
    try {
      const res = await api.post('/voice/tts', { text, voice: 'female', speed: 0.9 });
      if (!res.success || !res.data.audio_url) {
        wx.showToast({ title: res.message || '播放失败', icon: 'none' });
        return;
      }
      const app = getApp();
      const baseUrl = (app.globalData.baseUrl || '').replace(/\/api$/, '');
      const audioUrl = res.data.audio_url.startsWith('/') ? baseUrl + res.data.audio_url : res.data.audio_url;
      this._ttsUrlCache[cacheKey] = audioUrl;
      this._playAudioUrl(audioUrl, options);
    } catch (e) {
      wx.showToast({ title: '播放失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  _playAudioUrl(audioUrl, options = {}) {
    this._stopAudio();
    this._audioCtx = wx.createInnerAudioContext();
    this._audioCtx.src = audioUrl;
    this._audioCtx.onPlay(() => this.setData({ ttsPlaying: true, playingItemKey: options.itemKey || '' }));
    this._audioCtx.onEnded(() => this.setData({ ttsPlaying: false, playingItemKey: '' }));
    this._audioCtx.onError(() => this.setData({ ttsPlaying: false, playingItemKey: '' }));
    this._audioCtx.play();
  },

  _normalizeMediaUrl(url) {
    if (!url) return '';
    if (/^(https?:)?\/\//i.test(url) || url.startsWith('wxfile://')) return url;
    const app = getApp();
    const baseUrl = (app.globalData.baseUrl || '').replace(/\/api$/, '');
    return url.startsWith('/') ? baseUrl + url : `${baseUrl}/${url}`;
  },

  _stopAudio() {
    if (this._audioCtx) {
      try { this._audioCtx.stop(); this._audioCtx.destroy(); } catch (e) {}
      this._audioCtx = null;
    }
    this.setData({ ttsPlaying: false, playingItemKey: '' });
  },

  toggleRecord() {
    if (this.data.isAssessing) return;
    if (this.data.isRecording) {
      this._stopRecordingUi();
      try {
        recorderManager.stop();
      } catch (e) {
        this._recordTarget = null;
        wx.showToast({ title: '停止录音失败', icon: 'none' });
      }
      return;
    }
    this._stopAudio();
    this._recordTarget = { mode: 'module' };
    this.setData({ isRecording: true, recordingTime: 0, speakingResult: {} });
    try {
      recorderManager.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1, duration: 300000 });
    } catch (e) {
      this._recordTarget = null;
      this._stopRecordingUi();
      wx.showToast({ title: '录音启动失败', icon: 'none' });
      return;
    }
    this._recordTimer = setInterval(() => {
      this.setData({ recordingTime: this.data.recordingTime + 1 });
    }, 1000);
  },

  toggleItemRecord(e) {
    if (this.data.isAssessing) return;
    const key = e.currentTarget.dataset.key;
    const kind = e.currentTarget.dataset.kind || 'main';
    const mod = this.data.currentModule;
    const item = (mod.items || []).find(entry => entry.key === key);
    const referenceText = kind === 'example' ? item && item.example_text : item && item.reference_text;
    if (!item || !referenceText) {
      wx.showToast({ title: '没有评测文本', icon: 'none' });
      return;
    }
    if (this.data.isRecording) {
      this._stopRecordingUi();
      try {
        recorderManager.stop();
      } catch (err) {
        this._recordTarget = null;
        wx.showToast({ title: '停止录音失败', icon: 'none' });
      }
      return;
    }
    this._stopAudio();
    this._recordTarget = { mode: 'item', module: mod, item, kind, referenceText };
    this.setData({ isRecording: true, recordingTime: 0, recordingItemKey: `${key}:${kind}`, assessingItemKey: '' });
    try {
      recorderManager.start({ format: 'wav', sampleRate: 16000, numberOfChannels: 1, duration: 300000 });
    } catch (err) {
      this._recordTarget = null;
      this._stopRecordingUi();
      wx.showToast({ title: '录音启动失败', icon: 'none' });
      return;
    }
    this._recordTimer = setInterval(() => {
      this.setData({ recordingTime: this.data.recordingTime + 1 });
    }, 1000);
  },

  _setItemLocalScore(key, score) {
    const items = (this.data.currentModule.items || []).map(item => (
      item.key === key ? { ...item, last_score: score } : item
    ));
    this.setData({ 'currentModule.items': items });
  },

  async submitItemAssessment(filePath, target) {
    const { module: mod, item, kind = 'main', referenceText } = target;
    const finalReference = referenceText || this._getItemReference(item, mod, kind);
    if (!filePath || !item || !finalReference) return;
    this.setData({ isAssessing: true, assessingItemKey: `${item.key}:${kind}` });
    wx.showLoading({ title: '评测中...' });
    try {
      const res = await api.upload('/voice/assess', filePath, {
        reference_text: finalReference,
        content_type: kind === 'example' ? 'sentence' : (item.content_type || this._getAssessContentType(item, mod)),
        source: 'ielts_item',
        source_id: mod.id,
        sentence_index: item.index || 0
      });
      if (!res.success) {
        wx.showToast({ title: res.message || '评测失败', icon: 'none' });
        return;
      }

      const score = Number(res.data && res.data.overall_score);
      const passScore = Number(item.pass_score || 70);
      this._setItemLocalScore(item.key, Number.isFinite(score) ? score : 0);
      if (!Number.isFinite(score) || score < passScore) {
        wx.showToast({ title: `本次 ${score || 0} 分，${passScore} 分过关`, icon: 'none' });
        return;
      }

      const completeRes = await api.post(`/ielts/modules/${mod.id}/items/${encodeURIComponent(item.key)}/complete`, {
        score,
        assessment_id: res.data.assessment_id,
        progress: {
          assessed: true,
          assessed_kind: kind,
          reference_text: finalReference,
          content_type: kind === 'example' ? 'sentence' : (item.content_type || this._getAssessContentType(item, mod))
        }
      });
      const partSummary = completeRes && completeRes.data && completeRes.data.item_part_summary;
      if (partSummary && !partSummary.complete) {
        wx.showToast({ title: kind === 'example' ? '例句已过，继续单词' : '单词已过，继续例句', icon: 'none' });
      } else {
        wx.showToast({ title: '评测过关', icon: 'success' });
      }
      await this.loadDay();
    } catch (e) {
      wx.showToast({ title: '评测失败', icon: 'none' });
    } finally {
      this.setData({ isAssessing: false, assessingItemKey: '', recordingItemKey: '' });
      wx.hideLoading();
    }
  },

  async submitSpeaking(filePath) {
    const mod = this.data.currentModule;
    const podcast = mod.podcast_content || {};
    const prompt = (podcast.content_text || '').trim();
    if (!filePath || !prompt) return;
    this.setData({ isAssessing: true });
    wx.showLoading({ title: '评测中...' });
    try {
      const res = await api.upload('/voice/assess', filePath, {
        reference_text: prompt,
        content_type: 'paragraph',
        source: 'ielts',
        source_id: this.data.day.id
      });
      if (res.success) {
        this.setData({ speakingResult: res.data || {} });
        const score = Number(res.data && res.data.overall_score);
        const firstItem = (mod.items || [])[0];
        const passScore = Number((firstItem && firstItem.pass_score) || this.data.passScore || 80);
        if (!Number.isFinite(score) || score < passScore) {
          wx.showToast({ title: `本次 ${score || 0} 分，${passScore} 分过关`, icon: 'none' });
          return;
        }
        if (firstItem) {
          await api.post(`/ielts/modules/${mod.id}/items/${encodeURIComponent(firstItem.key)}/complete`, {
            score,
            assessment_id: res.data.assessment_id,
            progress: {
              speaking_assessed: true,
              reference_text: prompt,
              content_type: 'paragraph',
              podcast_content_id: podcast.id || null
            }
          });
          wx.showToast({ title: '口语过关', icon: 'success' });
          await this.loadDay();
        } else {
          await this.completeCurrentModule({
            score: res.data.overall_score,
            assessment_id: res.data.assessment_id,
            progress: { speaking_assessed: true }
          });
        }
      } else {
        wx.showToast({ title: res.message || '评测失败', icon: 'none' });
      }
    } catch (e) {
      wx.showToast({ title: '评测失败', icon: 'none' });
    } finally {
      this.setData({ isAssessing: false });
      wx.hideLoading();
    }
  }
});
