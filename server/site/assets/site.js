const SITE = {
  initial: typeof window !== 'undefined' ? (window.__SITE_INITIAL__ || {}) : {},
  state: {
    books: { page: 1, limit: 12, categoryId: '', hasMore: true, loading: false },
    scenes: { page: 1, limit: 12, categoryId: '', hasMore: true, loading: false }
  }
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || data.success === false) throw new Error(data.message || 'Request failed');
  return data;
}

function hydrateNav() {
  const page = document.body.dataset.page || 'home';
  $$('.nav-links a').forEach((link) => {
    const nav = link.dataset.nav;
    link.classList.toggle('active', nav === page || (page === 'book-detail' && nav === 'books') || (page === 'scene-detail' && nav === 'scenes'));
  });
}

function mountNavToggle() {
  const toggle = $('.nav-toggle');
  const pill = $('.nav-pill');
  if (!toggle || !pill) return;
  toggle.addEventListener('click', () => {
    const open = !pill.classList.contains('menu-open');
    pill.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
}

function mountYear() {
  $$('[data-year]').forEach((node) => { node.textContent = String(new Date().getFullYear()); });
}

function setQrFallback(container, message = '小程序码加载失败') {
  const img = $('.qr-image', container);
  const pattern = $('[data-qr-pattern]', container);
  const loading = $('[data-qr-loading]', container);
  if (img) img.hidden = true;
  if (pattern) pattern.hidden = false;
  if (loading) {
    loading.hidden = false;
    loading.style.display = 'grid';
    loading.textContent = message;
  }
}

function setQrImage(container, url, alt) {
  const img = $('.qr-image', container);
  const pattern = $('[data-qr-pattern]', container);
  const loading = $('[data-qr-loading]', container);
  if (!img || !url) return setQrFallback(container);
  if (loading) {
    loading.hidden = false;
    loading.style.display = 'grid';
    loading.textContent = '正在加载小程序码...';
  }
  img.onload = () => {
    if (pattern) pattern.hidden = true;
    if (loading) loading.hidden = true;
  };
  img.onerror = () => setQrFallback(container);
  img.src = url;
  img.alt = alt || img.alt;
  img.hidden = false;
}

async function loadMiniProgramQr(selector, params, alt) {
  const container = $(selector);
  if (!container) return;
  try {
    const query = new URLSearchParams(params || { type: 'home' });
    const res = await fetchJson(`/api/site/mini-program-code?${query.toString()}`);
    setQrImage(container, res.data && res.data.url, alt);
  } catch (error) {
    setQrFallback(container, '暂时无法加载小程序码');
  }
}

function mountReadDemo() {
  const demo = $('#read-demo');
  if (!demo) return;
  const buttons = $$('[data-speak]', demo);
  const status = $('[data-read-status]', demo);
  const updateStatus = (text) => { if (status) status.textContent = text; };
  const speak = (text) => {
    if (!text) return;
    buttons.forEach((btn) => btn.classList.toggle('active', btn.dataset.speak === text));
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') {
      updateStatus('当前浏览器不支持语音播放');
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 0.86;
    utterance.pitch = 1.04;
    utterance.onstart = () => updateStatus('正在点读...');
    utterance.onend = () => updateStatus('点击词卡听发音');
    utterance.onerror = () => updateStatus('播放失败，请再点一次');
    window.speechSynthesis.speak(utterance);
  };
  buttons.forEach((btn) => btn.addEventListener('click', () => speak(btn.dataset.speak || btn.textContent.trim())));
}

function renderBookCard(book) {
  const cover = book.cover_url
    ? `<img src="${escapeHtml(book.cover_url)}" alt="${escapeHtml(book.title || book.title_en || '绘本封面')}" loading="lazy">`
    : `<div class="cover-placeholder"><span>${escapeHtml((book.title_en || book.title || 'Book').slice(0, 2).toUpperCase())}</span></div>`;
  return `<article class="content-card book-card">
    <a class="content-cover" href="/books/${book.id}">${cover}</a>
    <div class="content-info">
      <div class="pill-row"><span>${escapeHtml(book.category_name || 'Picture Book')}</span><span>Lv.${escapeHtml(book.difficulty_level || 3)}</span></div>
      <h3><a href="/books/${book.id}">${escapeHtml(book.title || '绘本')}</a></h3>
      <p>${escapeHtml(book.title_en || 'A story for visual English learning.')}</p>
      <a class="circle-link" href="/books/${book.id}" aria-label="查看绘本详情">›</a>
    </div>
  </article>`;
}

function renderSceneCard(scene) {
  const cover = scene.image_url
    ? `<img src="${escapeHtml(scene.image_url)}" alt="${escapeHtml(scene.name || scene.name_en || '学习场景')}" loading="lazy">`
    : `<div class="cover-placeholder"><span>${escapeHtml((scene.name_en || scene.name || 'Scene').slice(0, 2).toUpperCase())}</span></div>`;
  return `<article class="content-card scene-card">
    <a class="content-cover" href="/scenes/${scene.id}">${cover}</a>
    <div class="content-info">
      <div class="pill-row"><span>${escapeHtml(scene.category_name || 'Scene')}</span><span>Lv.${escapeHtml(scene.difficulty_level || 3)}</span></div>
      <h3><a href="/scenes/${scene.id}">${escapeHtml(scene.name || '学习场景')}</a></h3>
      <p>${escapeHtml(scene.description || scene.name_en || '点击画面学习真实场景里的英语表达。')}</p>
      <a class="circle-link" href="/scenes/${scene.id}" aria-label="查看场景详情">›</a>
    </div>
  </article>`;
}

async function loadBooks(reset = false) {
  const grid = $('#book-grid');
  const more = $('#books-load-more');
  if (!grid || SITE.state.books.loading) return;
  SITE.state.books.loading = true;
  if (more) more.disabled = true;
  try {
    const params = new URLSearchParams({ page: String(SITE.state.books.page), limit: String(SITE.state.books.limit) });
    if (SITE.state.books.categoryId) params.set('category_id', SITE.state.books.categoryId);
    const res = await fetchJson(`/api/picture-books?${params.toString()}`);
    const list = Array.isArray(res.data) ? res.data : [];
    if (reset) grid.innerHTML = '';
    grid.insertAdjacentHTML('beforeend', list.map(renderBookCard).join(''));
    const total = res.pagination ? Number(res.pagination.total || 0) : 0;
    SITE.state.books.hasMore = total ? SITE.state.books.page * SITE.state.books.limit < total : list.length === SITE.state.books.limit;
    SITE.state.books.page += 1;
    if (more) more.style.display = SITE.state.books.hasMore ? 'inline-flex' : 'none';
  } catch (error) {
    if (reset) grid.innerHTML = '<p class="tip-box">绘本加载失败，请稍后再试。</p>';
  } finally {
    SITE.state.books.loading = false;
    if (more) more.disabled = false;
  }
}

async function loadScenes(reset = false) {
  const grid = $('#scene-grid');
  const more = $('#scenes-load-more');
  if (!grid || SITE.state.scenes.loading) return;
  SITE.state.scenes.loading = true;
  if (more) more.disabled = true;
  try {
    const params = new URLSearchParams({ page: String(SITE.state.scenes.page), limit: String(SITE.state.scenes.limit) });
    if (SITE.state.scenes.categoryId) params.set('category_id', SITE.state.scenes.categoryId);
    const res = await fetchJson(`/api/scenes?${params.toString()}`);
    const list = res.data && Array.isArray(res.data.list) ? res.data.list : [];
    const pagination = res.data && res.data.pagination ? res.data.pagination : null;
    if (reset) grid.innerHTML = '';
    grid.insertAdjacentHTML('beforeend', list.map(renderSceneCard).join(''));
    const total = pagination ? Number(pagination.total || 0) : 0;
    SITE.state.scenes.hasMore = total ? SITE.state.scenes.page * SITE.state.scenes.limit < total : list.length === SITE.state.scenes.limit;
    SITE.state.scenes.page += 1;
    if (more) more.style.display = SITE.state.scenes.hasMore ? 'inline-flex' : 'none';
  } catch (error) {
    if (reset) grid.innerHTML = '<p class="tip-box">场景加载失败，请稍后再试。</p>';
  } finally {
    SITE.state.scenes.loading = false;
    if (more) more.disabled = false;
  }
}

function mountBooksPage() {
  if (!$('#book-grid')) return;
  SITE.state.books = { ...SITE.state.books, ...(SITE.initial.books || {}) };
  $$('#book-categories [data-book-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#book-categories [data-book-category]').forEach((item) => item.classList.remove('active', 'is-active'));
      btn.classList.add('active');
      SITE.state.books.categoryId = btn.dataset.bookCategory || '';
      SITE.state.books.page = 1;
      loadBooks(true);
    });
  });
  const more = $('#books-load-more');
  if (more) more.addEventListener('click', () => loadBooks(false));
}

function mountScenesPage() {
  if (!$('#scene-grid')) return;
  SITE.state.scenes = { ...SITE.state.scenes, ...(SITE.initial.scenes || {}) };
  $$('#scene-categories [data-scene-category]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('#scene-categories [data-scene-category]').forEach((item) => item.classList.remove('active', 'is-active'));
      btn.classList.add('active');
      SITE.state.scenes.categoryId = btn.dataset.sceneCategory || '';
      SITE.state.scenes.page = 1;
      loadScenes(true);
    });
  });
  const more = $('#scenes-load-more');
  if (more) more.addEventListener('click', () => loadScenes(false));
}

function getPathId(prefix) {
  const pathname = window.location.pathname.replace(/\/+$/, '');
  if (!pathname.startsWith(prefix + '/')) return '';
  return pathname.slice(prefix.length + 1);
}

document.addEventListener('DOMContentLoaded', () => {
  hydrateNav();
  mountNavToggle();
  mountYear();
  mountReadDemo();
  mountBooksPage();
  mountScenesPage();

  const page = document.body.dataset.page;
  if (page === 'home' || page === 'books' || page === 'scenes' || page === 'parents') {
    loadMiniProgramQr('#mini-program', { type: 'home' }, '看图学英语小程序码');
  }
  if (page === 'book-detail') {
    const id = getPathId('/books');
    if (id) loadMiniProgramQr('#book-mini-program', { type: 'book', id }, '绘本小程序码');
  }
  if (page === 'scene-detail') {
    const id = getPathId('/scenes');
    if (id) loadMiniProgramQr('#scene-mini-program', { type: 'scene', id }, '场景小程序码');
  }
});
