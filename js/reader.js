/* ================================================================
 * reader.js — 阅读器
 *  - 一屏一页纵向分页、轻触/滑动翻页
 *  - 进度记忆、目录跳转、书签、划线、复制
 *  - 阅读设置（字号/行距/字体/主题/亮度）、阅读计时
 * ================================================================ */
'use strict';

const Reader = (() => {

  const DEFAULT_SETTINGS = { fontSize: 17, lineHeight: 1.8, fontFamily: 'sans', theme: 'day', brightness: 100 };
  const DEFAULT_CPM = 420;          // 默认阅读速度：字/分钟
  const SAVE_DEBOUNCE = 600;        // 进度保存防抖 ms
  const BOOKMARK_RADIUS = 60;       // 书签去重半径（字符）

  let S = Object.assign({}, DEFAULT_SETTINGS);
  let book = null;
  let chapterIdx = 0;
  let page = 0;
  let pageCount = 1;
  let parasCache = new Map();       // idx -> paras
  let saveTimer = null;
  let barsVisible = true;
  let sessionStart = 0;
  let sessionSecs = 0;
  let sessionChars = 0;
  let lastProgressChars = 0;        // 上次保存时的累计字符位置（用于速度统计）
  let cpm = DEFAULT_CPM;
  let suppressClick = false;
  let touch = { x0: 0, y0: 0, t0: 0, moved: false };

  const $ = (id) => document.getElementById(id);
  const els = {
    screen: 'reader-screen', content: 'reader-content', viewport: 'reader-viewport',
    bookTitle: 'reader-book-title', chapterTitle: 'reader-chapter-title',
    progress: 'progress-slider', progressText: 'progress-text',
    bookmark: 'btn-bookmark', theme: 'btn-theme', tocList: 'toc-list', tocPanel: 'toc-panel',
    selPopup: 'sel-popup', veil: 'brightness-veil',
  };

  /* ================= 设置 ================= */

  async function loadSettings() {
    S = Object.assign({}, DEFAULT_SETTINGS, await DB.getKV('settings', {}));
    applySettings();
  }
  async function saveSettings() {
    await DB.setKV('settings', S);
  }

  function applySettings() {
    const scr = $(els.screen);
    scr.setAttribute('data-theme', S.theme);
    const c = $(els.content);
    c.style.setProperty('--rd-fs', S.fontSize + 'px');
    c.style.setProperty('--rd-lh', S.lineHeight);
    c.style.setProperty('--rd-font', Engine.FONT_STACKS[S.fontFamily]);
    const veil = $(els.veil);
    veil.style.opacity = ((100 - S.brightness) / 100 * 0.6).toFixed(2);
    veil.classList.toggle('hidden', S.brightness >= 100);
    // 主题快捷按钮图标
    $(els.theme).querySelector('.ic-moon').classList.toggle('hidden', S.theme === 'night');
    $(els.theme).querySelector('.ic-sun').classList.toggle('hidden', S.theme !== 'night');
    // 设置面板控件
    $('font-size-val').textContent = S.fontSize;
    $('lineheight-slider').value = S.lineHeight;
    document.querySelectorAll('#font-family-options .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.font === S.fontFamily));
    document.querySelectorAll('#theme-options .theme-swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === S.theme));
    $('brightness-slider').value = S.brightness;
  }

  function setSetting(key, val, rerender = true) {
    S[key] = val;
    applySettings();
    saveSettings();
    if (rerender && book) reRenderKeepPos();
  }

  /* ================= 打开 / 关闭 ================= */

  async function open(bookId) {
    book = await DB.getBook(bookId);
    if (!book) return;
    chapterIdx = (book.progress && book.progress.chapter) || 0;
    if (chapterIdx >= book.chaptersMeta.length) chapterIdx = 0;
    parasCache = new Map();
    sessionStart = Date.now();
    sessionSecs = 0; sessionChars = 0;
    cpm = await DB.getKV('readSpeed', DEFAULT_CPM);
    lastProgressChars = 0;

    $(els.bookTitle).textContent = book.title;
    $(els.screen).classList.remove('hidden');
    $(els.chapterTitle).textContent = '';
    setBarsVisible(true);

    await loadChapter(chapterIdx);
    const ratio = (book.progress && book.progress.ratio) || 0;
    goPage(Engine.pageForRatio(ratio, pageCount), { animate: false });
    refreshUI();
    buildTocList();
  }

  async function close() {
    if (!book) return;
    await flushProgress();
    await flushReadingTime();
    $(els.screen).classList.add('hidden');
    closeSheets();
    book = null;
    window.dispatchEvent(new CustomEvent('reader-closed'));
  }

  /* ================= 章节加载与渲染 ================= */

  async function loadChapter(idx) {
    chapterIdx = idx;
    if (!parasCache.has(idx)) {
      const rec = await DB.getChapter(`${book.id}:${idx}`);
      parasCache.set(idx, (rec && rec.paras) || []);
    }
    await render();
  }

  async function render() {
    const paras = parasCache.get(chapterIdx) || [];
    const highlights = (book.highlights || []).filter(h => h.chapter === chapterIdx);
    const html = Engine.buildChapterHTML(paras, highlights);
    const c = $(els.content);
    c.classList.add('no-anim');
    c.innerHTML = html;
    c.style.transform = `translateY(0px)`;
    // 强制重排后测量
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const vh = $(els.viewport).clientHeight;
    pageCount = Engine.pageCountFor(c.offsetHeight, vh);
    $(els.chapterTitle).textContent = (book.chaptersMeta[chapterIdx] || {}).title || '';
    c.classList.remove('no-anim');
  }

  function applyTransform(p, animate = true) {
    const c = $(els.content);
    if (!animate) c.classList.add('no-anim');
    c.style.transform = `translateY(${-p * $(els.viewport).clientHeight}px)`;
    if (!animate) requestAnimationFrame(() => c.classList.remove('no-anim'));
  }

  function goPage(p, opts = {}) {
    const animate = opts.animate !== false;
    p = Math.max(0, Math.min(pageCount - 1, p));
    if (p === page && !opts.force) return;
    page = p;
    applyTransform(page, animate);
    refreshUI();
    scheduleSave();
  }

  /** 设置变化后保持阅读位置重绘 */
  async function reRenderKeepPos() {
    const ratio = Engine.ratioForPage(page, pageCount);
    await render();
    goPage(Engine.pageForRatio(ratio, pageCount), { animate: false });
    refreshUI();
    if (!$(els.tocPanel).classList.contains('hidden')) buildTocList();
  }

  /* ================= 翻页 ================= */

  async function nextPage() {
    if (page < pageCount - 1) { goPage(page + 1); return; }
    if (chapterIdx < book.chaptersMeta.length - 1) {
      await loadChapter(chapterIdx + 1);
      goPage(0, { animate: false });
      refreshUI();
    } else {
      toast('已经是最后一页啦');
    }
  }

  async function prevPage() {
    if (page > 0) { goPage(page - 1); return; }
    if (chapterIdx > 0) {
      await loadChapter(chapterIdx - 1);
      goPage(pageCount - 1, { animate: false });
      refreshUI();
    }
  }

  async function gotoChapter(idx, ratio = 0) {
    if (idx === chapterIdx) { goPage(Engine.pageForRatio(ratio, pageCount), { animate: false }); return; }
    await loadChapter(idx);
    goPage(Engine.pageForRatio(ratio, pageCount), { animate: false });
    refreshUI();
    closeSheet('toc-panel');
  }

  /* ================= UI 刷新 ================= */

  function refreshUI() {
    if (!book) return;
    const pct = Math.round(globalPercent() * 10000) / 100;
    $('progress-slider').value = pct;
    $('progress-text').textContent = `${pct}%`;
    updateBookmarkIcon();
    if (!$(els.tocPanel).classList.contains('hidden')) buildTocList();
  }

  function globalPercent() {
    const meta = book.chaptersMeta;
    let cum = 0;
    for (let i = 0; i < chapterIdx && i < meta.length; i++) cum += meta[i].charLen;
    const ratio = Engine.ratioForPage(page, pageCount);
    const curLen = (meta[chapterIdx] || {}).charLen || 1;
    return Math.max(0, Math.min(1, (cum + ratio * curLen) / Math.max(1, book.totalChars)));
  }

  function updateBookmarkIcon() {
    const has = currentBookmark();
    $(els.bookmark).querySelector('.ic-bm-on').classList.toggle('hidden', !has);
    $(els.bookmark).querySelector('.ic-bm-off').classList.toggle('hidden', has);
  }

  function currentOffset() {
    const ratio = Engine.ratioForPage(page, pageCount);
    const len = (book.chaptersMeta[chapterIdx] || {}).charLen || 1;
    return Math.round(ratio * len);
  }

  function currentBookmark() {
    const off = currentOffset();
    return (book.bookmarks || []).find(b => b.chapter === chapterIdx && Math.abs(b.offset - off) < BOOKMARK_RADIUS);
  }

  function toggleBookmark() {
    const off = currentOffset();
    const marks = book.bookmarks || [];
    const hit = marks.find(b => b.chapter === chapterIdx && Math.abs(b.offset - off) < BOOKMARK_RADIUS);
    const paras = parasCache.get(chapterIdx) || [];
    const fullText = Engine.buildFullText(paras);
    if (hit) {
      book.bookmarks = marks.filter(b => b !== hit);
      toast('已移除书签');
    } else {
      const preview = fullText.slice(Math.max(0, off - 12), Math.min(fullText.length, off + 28)).replace(/\n/g, ' ');
      marks.push({ chapter: chapterIdx, offset: off, preview, time: Date.now() });
      book.bookmarks = marks;
      toast('已添加书签');
    }
    saveBookNow();
    updateBookmarkIcon();
  }

  /* ================= 进度保存 ================= */

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushProgress, SAVE_DEBOUNCE);
  }

  async function flushProgress() {
    if (!book) return;
    const ratio = Engine.ratioForPage(page, pageCount);
    book.progress = { chapter: chapterIdx, ratio };
    book.lastReadAt = Date.now();
    await saveBookNow();
    await flushReadingTime();
  }

  async function saveBookNow() {
    if (!book) return;
    await DB.putBook(book);
  }

  /* ================= 阅读计时与速度 ================= */

  async function flushReadingTime() {
    if (!book || !sessionStart) return;
    const now = Date.now();
    const secs = Math.round((now - (sessionStart + sessionSecs * 1000)) / 1000);
    if (secs > 0) {
      sessionSecs += secs;
      const day = dayKey();
      const stats = await DB.getKV('readStats', {});
      stats[day] = (stats[day] || 0) + secs;
      await DB.setKV('readStats', stats);
      // 速度估计
      const cum = Math.round(globalPercent() * book.totalChars);
      const advanced = Math.max(0, cum - lastProgressChars);
      if (advanced > 0 && sessionSecs > 20) {
        const spd = Math.round(advanced / (sessionSecs / 60));
        if (spd > 60) { cpm = Math.round(cpm * 0.7 + spd * 0.3); await DB.setKV('readSpeed', cpm); }
      }
      lastProgressChars = cum;
    }
  }

  function dayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function todaySeconds() {
    return DB.getKV('readStats', {}).then(stats => (stats[dayKey()] || 0));
  }

  /* ================= 目录 ================= */

  function buildTocList() {
    const list = $(els.tocList);
    list.innerHTML = '';
    const meta = book.chaptersMeta;
    let cum = 0;
    meta.forEach((m, i) => {
      const item = document.createElement('button');
      item.className = 'toc-item' + (i === chapterIdx ? ' current' : '');
      const dot = i === chapterIdx ? '<span class="toc-dot"></span>' : '<span style="width:5px;flex-shrink:0"></span>';
      const pct = Math.min(100, Math.round((cum + m.charLen) / Math.max(1, book.totalChars) * 100));
      item.innerHTML = `${dot}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Engine.esc(m.title || `第 ${i + 1} 章`)}</span><span class="toc-pct">${pct}%</span>`;
      item.addEventListener('click', () => gotoChapter(i, 0));
      list.appendChild(item);
      cum += m.charLen;
    });
    // 滚动到当前章节
    const cur = list.querySelector('.toc-item.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }

  /* ================= 划词 / 划线 ================= */

  function textMap() {
    const root = $(els.content);
    const map = [];
    let domLen = 0, fullLen = 0;
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        map.push({ node, domStart: domLen, fullStart: fullLen });
        domLen += node.textContent.length;
        fullLen += node.textContent.length;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === 'P' && fullLen > 0) fullLen += 1;
      for (const c of node.childNodes) walk(c);
    };
    walk(root);
    return map;
  }

  function resolveOffset(map, node, offset) {
    if (node.nodeType === Node.TEXT_NODE) {
      const e = map.find(m => m.node === node);
      if (!e) return null;
      return e.fullStart + Math.max(0, Math.min(node.textContent.length, offset));
    }
    const child = node.childNodes[Math.min(offset, node.childNodes.length - 1)];
    if (child) {
      if (child.nodeType === Node.TEXT_NODE) return resolveOffset(map, child, 0);
      if (child.nodeType === Node.ELEMENT_NODE) {
        const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode();
        if (first) return resolveOffset(map, first, 0);
      }
    }
    return null;
  }

  function selectionOffsets() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const root = $(els.content);
    if (!root.contains(range.commonAncestorContainer)) return null;
    const map = textMap();
    const s = resolveOffset(map, range.startContainer, range.startOffset);
    const e = resolveOffset(map, range.endContainer, range.endOffset);
    if (s === null || e === null || e <= s || e - s > 800) return null;
    return { start: s, end: e };
  }

  function showSelPopup(rect) {
    const pop = $(els.selPopup);
    pop.classList.remove('hidden');
    pop.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 70), window.innerWidth - 70)}px`;
    pop.style.top = `${Math.max(rect.top - 8, 8)}px`;
  }

  function hideSelPopup() {
    $(els.selPopup).classList.add('hidden');
  }

  function handleSelection() {
    const off = selectionOffsets();
    if (!off) { hideSelPopup(); return; }
    const sel = window.getSelection();
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) { hideSelPopup(); return; }
    sel.__pending = off; // 供按钮使用
    showSelPopup(rect);
  }

  async function addHighlight() {
    const off = window.getSelection()?.__pending || selectionOffsets();
    if (!off) return;
    const paras = parasCache.get(chapterIdx) || [];
    const fullText = Engine.buildFullText(paras);
    let text = fullText.slice(off.start, off.end).replace(/\n/g, '').trim();
    if (!text) return;
    const hl = { id: `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, chapter: chapterIdx, start: off.start, end: off.end, text, color: '#f2b33d', time: Date.now() };
    book.highlights = book.highlights || [];
    book.highlights.push(hl);
    await saveBookNow();
    clearSelection();
    await render();
    // 定位回原来比例
    const ratio = Engine.ratioForPage(page, pageCount);
    goPage(Engine.pageForRatio(ratio, pageCount), { animate: false });
    toast('已划线');
  }

  function clearSelection() {
    hideSelPopup();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  async function copySelection() {
    const off = window.getSelection()?.__pending || selectionOffsets();
    const paras = parasCache.get(chapterIdx) || [];
    const fullText = Engine.buildFullText(paras);
    if (off) {
      const text = fullText.slice(off.start, off.end);
      try { await navigator.clipboard.writeText(text); toast('已复制'); } catch (e) { toast('复制失败'); }
    }
    clearSelection();
  }

  async function removeHighlight(id) {
    book.highlights = (book.highlights || []).filter(h => h.id !== id);
    await saveBookNow();
    await render();
    const ratio = Engine.ratioForPage(page, pageCount);
    goPage(Engine.pageForRatio(ratio, pageCount), { animate: false });
    toast('已删除划线');
  }

  /* ================= 触摸 / 鼠标 ================= */

  function bindGestures() {
    const body = $('reader-body');

    body.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      touch = { x0: t.clientX, y0: t.clientY, t0: Date.now(), moved: false };
    }, { passive: true });

    body.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - touch.x0, dy = t.clientY - touch.y0;
      const dt = Date.now() - touch.t0;
      if (dt > 500) { suppressClick = true; return; }      // 长按（选词）不翻页
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        suppressClick = true;                              // 滑动翻页
        if (dx < 0) nextPage(); else prevPage();
        return;
      }
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) {
        handleTap(t.clientX, window.innerWidth);
      }
    }, { passive: true });

    body.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; }
      if (!window.getSelection().isCollapsed) return;      // 有选区时不翻页
      handleTap(e.clientX, window.innerWidth);
    });

    document.addEventListener('keydown', (e) => {
      if (!book || $(els.screen).classList.contains('hidden')) return;
      if (e.key === 'ArrowRight') nextPage();
      if (e.key === 'ArrowLeft') prevPage();
      if (e.key === 'Escape') closeSheets();
    });
  }

  function handleTap(x, w) {
    if (x < w * 0.3) prevPage();
    else if (x > w * 0.7) nextPage();
    else toggleBars();
  }

  function setBarsVisible(v) {
    barsVisible = v;
    document.getElementById('reader-screen').classList.toggle('bars-hidden', !v);
  }
  function toggleBars() { setBarsVisible(!barsVisible); }

  /* ================= 面板 ================= */

  // 全局面板开关定义在 app.js（window.openSheet / closeSheet / closeSheets）
  function openSheet(id) { window.openSheet(id); }
  function closeSheet(id) { window.closeSheet(id); }
  function closeSheets() { window.closeSheets(); }

  function toast(msg) { window.YueduToast && window.YueduToast(msg); }

  /* ================= 绑定 ================= */

  function bind() {
    $('btn-back').addEventListener('click', close);
    $('btn-bookmark').addEventListener('click', toggleBookmark);

    $('btn-theme').addEventListener('click', () => {
      setSetting('theme', S.theme === 'night' ? 'day' : 'night');
    });

    // 进度条
    const slider = $('progress-slider');
    slider.addEventListener('input', () => {
      const pct = parseFloat(slider.value);
      const target = Math.round(pct / 100 * (pageCount - 1));
      applyTransform(target, false);
      page = target;
      refreshUI();
    });
    slider.addEventListener('change', () => scheduleSave());

    // 设置面板
    $('btn-more').addEventListener('click', () => openSheet('settings-panel'));
    $('font-plus').addEventListener('click', () => setSetting('fontSize', Math.min(28, S.fontSize + 1)));
    $('font-minus').addEventListener('click', () => setSetting('fontSize', Math.max(14, S.fontSize - 1)));
    $('lineheight-slider').addEventListener('input', (e) => { S.lineHeight = parseFloat(e.target.value); applySettings(); });
    $('lineheight-slider').addEventListener('change', () => { saveSettings(); reRenderKeepPos(); });
    $('brightness-slider').addEventListener('input', (e) => { S.brightness = parseInt(e.target.value); applySettings(); });
    $('brightness-slider').addEventListener('change', () => { saveSettings(); });
    document.querySelectorAll('#font-family-options .seg-btn').forEach(b => {
      b.addEventListener('click', () => setSetting('fontFamily', b.dataset.font));
    });
    document.querySelectorAll('#theme-options .theme-swatch').forEach(b => {
      b.addEventListener('click', () => setSetting('theme', b.dataset.theme));
    });

    // 目录
    $('btn-toc').addEventListener('click', () => { if (book) { openSheet('toc-panel'); buildTocList(); } });

    // 划词
    $('sel-highlight').addEventListener('click', addHighlight);
    $('sel-copy').addEventListener('click', copySelection);
    $(els.content).addEventListener('mouseup', (e) => { setTimeout(() => { if (!window.getSelection().isCollapsed) handleSelection(); }, 10); });
    $(els.content).addEventListener('touchend', (e) => {
      setTimeout(() => {
        if (window.getSelection() && !window.getSelection().isCollapsed) handleSelection();
      }, 350);
    });
    // 点击划线 → 删除
    $(els.content).addEventListener('click', (e) => {
      const mark = e.target.closest('mark[data-hl]');
      if (mark) {
        e.stopPropagation();
        const rect = mark.getBoundingClientRect();
        const pop = $(els.selPopup);
        pop.classList.remove('hidden');
        pop.innerHTML = '<button class="sel-btn" id="sel-del-hl" style="color:#ff8a8d"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0l-1 12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>删除划线</span></button>';
        pop.style.left = `${Math.min(Math.max(rect.left + rect.width / 2, 70), window.innerWidth - 70)}px`;
        pop.style.top = `${Math.max(rect.top - 8, 8)}px`;
        document.getElementById('sel-del-hl').addEventListener('click', () => { removeHighlight(mark.dataset.hl); hideSelPopup(); });
      }
    });

    // 生命周期
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushProgress(); });
    window.addEventListener('beforeunload', () => { if (book) flushProgress(); });
    window.addEventListener('resize', debounce(() => { if (book) reRenderKeepPos(); }, 200));

    // 面板关闭
    document.querySelectorAll('.sheet-close').forEach(b => b.addEventListener('click', () => closeSheet(b.dataset.close)));
    $('backdrop').addEventListener('click', closeSheets);

    bindGestures();
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ================= 对外 ================= */

  return {
    open, close, nextPage, prevPage, gotoChapter,
    loadSettings, applySettings, todaySeconds, flushReadingTime,
    bind, closeSheets,
  };
})();
