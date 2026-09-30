/* ================================================================
 * reader.js — 阅读器（纵向连续滚动模式）
 *  - 章节无缝拼接，滚动到边缘自动加载前后章（双端加载）
 *  - 滚动驱动进度/章节标题/进度条，全局百分比跨章累计
 *  - 纵向连续滚动阅读，上下滑动即翻页（唯一翻页方式）
 *  - 轻点任意处切换工具栏；顶栏常驻返回入口
 *  - 进度记忆、目录跳转、书签、划线、复制
 *  - 阅读设置（字号/行距/字体/主题/亮度）、阅读计时
 * ================================================================ */
'use strict';

const Reader = (() => {

  const DEFAULT_SETTINGS = { fontSize: 17, lineHeight: 1.8, fontFamily: 'sans', theme: 'day', brightness: 100 };
  const DEFAULT_CPM = 420;          // 默认阅读速度：字/分钟
  const SAVE_DEBOUNCE = 600;        // 进度保存防抖 ms
  const BOOKMARK_RADIUS = 60;       // 书签去重半径（字符）
  const MAX_RENDER = 6;             // 单次最多渲染章节数（双端加载裁剪用）
  const LOAD_EDGE = 420;            // 距边缘多少 px 触发前后章加载
  const PAD_TOP = 0.08;             // 章节定位顶部留白（视口高比例）
  const PAD_BOTTOM = 0.12;          // 章节定位底部留白（视口高比例）

  let S = Object.assign({}, DEFAULT_SETTINGS);
  let book = null;
  let rendered = [];                // 已渲染章节 idx（升序）
  let curChapter = 0;               // 当前可视章节 idx
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
  let scrollBusy = false;

  const $ = (id) => document.getElementById(id);
  const els = {
    screen: 'reader-screen', content: 'reader-content', viewport: 'reader-viewport',
    bookTitle: 'reader-book-title', chapterTitle: 'reader-chapter-title',
    progress: 'progress-slider', progressText: 'progress-text',
    bookmark: 'btn-bookmark', theme: 'btn-theme', tocList: 'toc-list', tocPanel: 'toc-panel',
    selPopup: 'sel-popup', veil: 'brightness-veil',
  };
  const vp = () => $(els.viewport);
  const cnt = () => $(els.content);
  const vh = () => vp().clientHeight;

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
    // 夜间/白昼同步浏览器系统栏颜色（灵动岛周围不突兀）；夜间同时带动书架与面板整体变暗
    const THEME_COLORS = { day: '#f6f6f4', sepia: '#f2e8d4', green: '#dde7d2', night: '#141414' };
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[S.theme] || '#f6f6f4');
    document.body.classList.toggle('app-dark', S.theme === 'night');
    const c = cnt();
    c.style.setProperty('--rd-fs', S.fontSize + 'px');
    c.style.setProperty('--rd-lh', S.lineHeight);
    c.style.setProperty('--rd-font', Engine.FONT_STACKS[S.fontFamily]);
    ensureWebFont(S.fontFamily); // 持久化的宋体/楷体设置在重开 App 后也要确保字体已加载
    const veil = $(els.veil);
    veil.style.opacity = ((100 - S.brightness) / 100 * 0.6).toFixed(2);
    veil.classList.toggle('hidden', S.brightness >= 100);
    $(els.theme).querySelector('.ic-moon').classList.toggle('hidden', S.theme === 'night');
    $(els.theme).querySelector('.ic-sun').classList.toggle('hidden', S.theme !== 'night');
    $('font-size-val').textContent = S.fontSize;
    $('lineheight-slider').value = S.lineHeight;
    document.querySelectorAll('#font-family-options .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.font === S.fontFamily));
    document.querySelectorAll('#theme-options .theme-swatch').forEach(b => b.classList.toggle('active', b.dataset.theme === S.theme));
    $('brightness-slider').value = S.brightness;
  }

  /* ================= 内嵌字体懒加载 =================
     iOS 无 Songti SC/Kaiti SC 等系统字体，宋体/楷体改用内嵌子集 woff2
     （按全部书籍字符集子集化，选中时才下载，SW 缓存后离线可用） */
  const WEB_FONTS = {
    song: { family: 'Yuedu Serif', file: 'fonts/NotoSerifSC-sub.woff2' },
    kai:  { family: 'Yuedu Kai',   file: 'fonts/LXGWWenKai-sub.woff2' },
  };
  const webFontState = {}; // undefined=未加载 1=加载中 2=已就绪 0=失败可重试
  function ensureWebFont(key) {
    const def = WEB_FONTS[key];
    if (!def || webFontState[key] || typeof FontFace === 'undefined') return;
    webFontState[key] = 1;
    const ff = new FontFace(def.family, `url(${def.file})`, { display: 'swap' });
    ff.load().then((f) => {
      document.fonts.add(f);
      webFontState[key] = 2;
    }).catch(() => { webFontState[key] = 0; }); // 失败则回退系统字体栈，可重试
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
    curChapter = (book.progress && book.progress.chapter) || 0;
    if (curChapter >= book.chaptersMeta.length) curChapter = 0;
    parasCache = new Map();
    sessionStart = Date.now();
    sessionSecs = 0; sessionChars = 0;
    cpm = await DB.getKV('readSpeed', DEFAULT_CPM);
    lastProgressChars = 0;

    $(els.bookTitle).textContent = book.title;
    const scr = $(els.screen);
    scr.classList.add('pre-enter');      // 先摆在屏幕右侧外（无过渡）
    scr.classList.remove('hidden');
    setBarsVisible(true);

    cnt().style.opacity = '0';   // 打开时淡入，避免渲染闪跳
    await renderChaptersAround(curChapter);
    const ratio = (book.progress && book.progress.ratio) || 0;
    scrollToRatio(curChapter, ratio);
    await doubleRaf();
    cnt().style.opacity = '1';
    scr.classList.remove('pre-enter');  // 从右侧滑入到位
    $(els.chapterTitle).textContent = (book.chaptersMeta[curChapter] || {}).title || '';
    refreshUI();
    buildTocList();
  }

  async function close() {
    if (!book) return;
    const b = book;
    book = null;                     // 立即置空：后续重复点击直接忽略，也阻断后台继续读写
    try {
      book = b; await flushProgress();
    } catch (e) { /* 存进度失败不阻断返回 */ }
    book = null;
    // 返回转场：向右滑出，动画结束后真正隐藏
    const scr = $(els.screen);
    scr.classList.add('slide-out', 'animating');
    closeSheets();
    setTimeout(() => {
      scr.classList.remove('slide-out', 'animating');
      scr.classList.add('hidden');
    }, 330);
    window.dispatchEvent(new CustomEvent('reader-closed'));
  }

  /* ================= 章节渲染 ================= */

  async function chapterParas(idx) {
    if (!parasCache.has(idx)) {
      const rec = await DB.getChapter(`${book.id}:${idx}`);
      parasCache.set(idx, (rec && rec.paras) || []);
    }
    return parasCache.get(idx);
  }

  function chapterHTML(idx) {
    const meta = book.chaptersMeta[idx] || {};
    const paras = parasCache.get(idx) || [];
    const highlights = (book.highlights || []).filter(h => h.chapter === idx);
    const body = Engine.buildChapterHTML(paras, highlights);
    const name = meta.title || `第 ${idx + 1} 章`;
    return `<div class="rd-chapter" data-idx="${idx}">
  <div class="rd-chapter-head"><span class="rd-chapter-name">${Engine.esc(name)}</span><span class="rd-chapter-rule"></span></div>
  <div class="rd-chapter-body">${body}</div>
</div>`;
  }

  /** 以某章为中心渲染（该章 + 后两章），用于打开/跳转 */
  async function renderChaptersAround(idx) {
    const total = book.chaptersMeta.length;
    rendered = [];
    for (let i = Math.max(0, idx); i < Math.min(total, idx + 3); i++) rendered.push(i);
    await renderAll();
    await doubleRaf();
  }

  /** 重建全部已渲染章节 DOM（先预载 paras，append/prepend 后保持视口内容位置） */
  async function renderAll() {
    await Promise.all(rendered.map(idx => chapterParas(idx)));
    const c = cnt();
    let html = rendered.map(chapterHTML).join('');
    const total = book.chaptersMeta.length;
    if (rendered.length && rendered[rendered.length - 1] === total - 1) html += '<div class="rd-end">— 全书完 —</div>';
    c.innerHTML = html;
  }

  function doubleRaf() {
    // 标签页被遮挡（分屏/后台）时 rAF 不会触发，加超时兜底避免打开书籍永久挂起
    return new Promise(r => {
      let done = false;
      const finish = () => { if (!done) { done = true; r(); } };
      requestAnimationFrame(() => requestAnimationFrame(finish));
      setTimeout(finish, 120);
    });
  }

  /** 章节位置表 idx -> {top, height}（相对 content 内容区） */
  function chapterPositions() {
    const map = new Map();
    for (const el of cnt().querySelectorAll('.rd-chapter')) {
      const idx = parseInt(el.dataset.idx, 10);
      if (!isNaN(idx)) map.set(idx, { top: el.offsetTop, height: el.offsetHeight });
    }
    return map;
  }

  /** 视口中线所在的章节 */
  function currentChapterIdx() {
    const pos = chapterPositions();
    if (pos.size === 0) return curChapter;
    const mid = vp().scrollTop + vh() / 2;
    let best = rendered[0], bestTop = -Infinity;
    for (const [idx, p] of pos) {
      if (mid >= p.top && mid < p.top + p.height) return idx;
      if (p.top <= mid && p.top > bestTop) { best = idx; bestTop = p.top; }
    }
    return best !== undefined ? best : rendered[0];
  }

  /** 指定章节内的滚动比例 0..1（默认当前可视章节） */
  function currentRatio(idx = currentChapterIdx()) {
    const pos = chapterPositions();
    const p = pos.get(idx);
    if (!p) return 0;
    const mid = vp().scrollTop + vh() / 2;
    return Math.max(0, Math.min(1, (mid - p.top) / Math.max(1, p.height)));
  }

  /** 全书进度 0..1（跨章按 charLen 累计） */
  function globalPercent() {
    const meta = book.chaptersMeta;
    let cum = 0;
    for (let i = 0; i < curChapter && i < meta.length; i++) cum += meta[i].charLen;
    const len = (meta[curChapter] || {}).charLen || 1;
    return Math.max(0, Math.min(1, (cum + currentRatio(curChapter) * len) / Math.max(1, book.totalChars)));
  }

  /** 把某章内比例映射为 scrollTop 并定位 */
  function scrollToRatio(idx, ratio) {
    const v = vp();
    const pos = chapterPositions();
    const p = pos.get(idx);
    if (!p) return;
    const max = Math.max(0, v.scrollHeight - v.clientHeight);
    const padT = Math.round(PAD_TOP * vh());
    const padB = Math.round(PAD_BOTTOM * vh());
    const start = Math.max(0, p.top - padT);
    const end = Math.min(max, p.top + p.height - v.clientHeight + padB);
    const t = Math.max(0, Math.min(1, ratio || 0));
    v.scrollTop = start + t * Math.max(0, end - start);
  }

  /** 全书百分比 → 反解章节定位（跨章自动渲染） */
  async function seekToPercent(pct) {
    pct = Math.max(0, Math.min(1, pct));
    const meta = book.chaptersMeta;
    const target = Math.round(pct * Math.max(1, book.totalChars));
    let cum = 0, idx = 0;
    for (let i = 0; i < meta.length; i++) {
      if (cum + meta[i].charLen >= target || i === meta.length - 1) { idx = i; break; }
      cum += meta[i].charLen;
    }
    const len = meta[idx].charLen || 1;
    const ratio = Math.max(0, Math.min(1, (target - cum) / len));
    if (!rendered.includes(idx)) await renderChaptersAround(idx);
    curChapter = idx;
    scrollToRatio(idx, ratio);
    $(els.chapterTitle).textContent = (book.chaptersMeta[idx] || {}).title || '';
    refreshUI();
    scheduleSave();
  }

  /** 设置/窗口变化后保持阅读位置重绘 */
  async function reRenderKeepPos() {
    const idx = curChapter;
    const ratio = currentRatio(idx);
    await renderChaptersAround(idx);
    curChapter = idx;
    scrollToRatio(idx, ratio);
    refreshUI();
    if (!$(els.tocPanel).classList.contains('hidden')) buildTocList();
  }

  /* ================= 增量滚动加载 ================= */

  function onScroll() {
    if (scrollBusy) return;
    scrollBusy = true;
    requestAnimationFrame(() => {
      scrollBusy = false;
      if (!book) return;
      const idx = currentChapterIdx();
      const changed = idx !== curChapter;
      curChapter = idx;
      const meta = book.chaptersMeta[curChapter] || {};
      if (changed) $(els.chapterTitle).textContent = meta.title || '';
      updateProgressUI();
      updateBookmarkIcon();
      scheduleSave();
      maybeLoadMore();
    });
  }

  /** 底栏进度文本：百分比 + 按个人阅读速度估算的剩余时间 */
  function updateProgressUI() {
    const pct = Math.round(globalPercent() * 10000) / 100;
    $('progress-slider').value = pct;
    const remainChars = Math.max(0, book.totalChars * (1 - pct / 100));
    let remain = '';
    if (remainChars > 500) {
      const mins = Math.round(remainChars / Math.max(60, cpm));
      remain = mins >= 60 ? `剩${Math.floor(mins / 60)}时${mins % 60}分` : `剩${mins}分钟`;
    }
    $('progress-text').textContent = remain ? `${pct}% · ${remain}` : `${pct}%`;
  }

  function maybeLoadMore() {
    const v = vp();
    const total = book.chaptersMeta.length;
    const last = rendered[rendered.length - 1];
    if (v.scrollTop + v.clientHeight > v.scrollHeight - LOAD_EDGE) {
      if (last < total - 1) appendChapter(last + 1);
    } else if (v.scrollTop < LOAD_EDGE) {
      if (rendered[0] > 0) prependChapter(rendered[0] - 1);
    }
  }

  /** 底部追加下一章：增量 DOM，不重建整页（无闪烁无跳动）；超上限时丢弃最前章并补偿滚动位置 */
  async function appendChapter(idx) {
    await chapterParas(idx);
    rendered.push(idx);
    const c = cnt();
    if (rendered.length > MAX_RENDER) {
      const drop = rendered.shift();
      const node = c.querySelector(`.rd-chapter[data-idx="${drop}"]`);
      if (node) { const h = node.offsetHeight; node.remove(); vp().scrollTop = Math.max(0, vp().scrollTop - h); }
      parasCache.delete(drop);
    }
    c.insertAdjacentHTML('beforeend', chapterHTML(idx));
    syncEndMark();
  }

  /** 顶部预载上一章：增量 DOM；超上限时丢弃最后章 */
  async function prependChapter(idx) {
    await chapterParas(idx);
    rendered.unshift(idx);
    const c = cnt();
    if (rendered.length > MAX_RENDER) {
      const drop = rendered.pop();
      const node = c.querySelector(`.rd-chapter[data-idx="${drop}"]`);
      if (node) node.remove();
      parasCache.delete(drop);
    }
    c.insertAdjacentHTML('afterbegin', chapterHTML(idx));
    vp().scrollTop += c.firstElementChild.offsetHeight;
    syncEndMark();
  }

  /** 维护“全书完”标记：最后一章在窗口内则显示，否则移除 */
  function syncEndMark() {
    const c = cnt();
    const has = !!c.querySelector('.rd-end');
    const should = rendered[rendered.length - 1] === book.chaptersMeta.length - 1;
    if (should && !has) c.insertAdjacentHTML('beforeend', '<div class="rd-end">— 全书完 —</div>');
    if (!should && has) c.querySelector('.rd-end').remove();
  }

  /* ================= 翻屏 ================= */

  function scrollScreen(dir) {
    const v = vp();
    const atEnd = v.scrollTop + v.clientHeight >= v.scrollHeight - 2;
    const atStart = v.scrollTop <= 2;
    if (dir > 0 && atEnd) {
      const last = rendered[rendered.length - 1];
      if (last < book.chaptersMeta.length - 1) {
        // 末尾章节尚未渲染：先增量加载再翻页，避免“点了没反应”
        appendChapter(last + 1).then(() => scrollScreen(dir));
      } else toast('已经是最后一页啦');
      return;
    }
    if (dir < 0 && atStart) {
      if (rendered[0] <= 0) toast('已经到开头啦');
      return;
    }
    const from = v.scrollTop;
    v.scrollBy({ top: dir * Math.round(0.92 * vh()), behavior: 'smooth' });
    // 兜底：个别环境（后台标签页 rAF 冻结）smooth 动画不执行，350ms 后未动则直接跳转
    setTimeout(() => {
      if (Math.abs(v.scrollTop - from) < 2) v.scrollBy({ top: dir * Math.round(0.92 * vh()), behavior: 'auto' });
    }, 350);
  }

  async function gotoChapter(idx, ratio = 0) {
    if (idx < 0 || idx >= book.chaptersMeta.length) return;
    await renderChaptersAround(idx);
    curChapter = idx;
    scrollToRatio(idx, ratio);
    $(els.chapterTitle).textContent = (book.chaptersMeta[idx] || {}).title || '';
    refreshUI();
    closeSheet('toc-panel');
  }

  /* ================= UI 刷新 ================= */

  function refreshUI() {
    if (!book) return;
    updateProgressUI();
    updateBookmarkIcon();
    if (!$(els.tocPanel).classList.contains('hidden')) buildTocList();
  }

  /** 当前阅读位置在章节内的字符偏移（书签用） */
  function currentOffset() {
    const len = (book.chaptersMeta[curChapter] || {}).charLen || 1;
    return Math.round(currentRatio(curChapter) * len);
  }

  function currentBookmark() {
    const off = currentOffset();
    return (book.bookmarks || []).find(b => b.chapter === curChapter && Math.abs(b.offset - off) < BOOKMARK_RADIUS);
  }

  let bmIconState = null; // null=未知，true=有书签，false=无书签
  function updateBookmarkIcon() {
    const has = !!currentBookmark();
    if (has === bmIconState) return; // 状态未变不碰 DOM，避免滚动时每帧重绘导致图标闪烁
    bmIconState = has;
    $(els.bookmark).querySelector('.ic-bm-on').classList.toggle('hidden', !has);
    $(els.bookmark).querySelector('.ic-bm-off').classList.toggle('hidden', has);
  }

  function toggleBookmark() {
    const off = currentOffset();
    const marks = book.bookmarks || [];
    const hit = marks.find(b => b.chapter === curChapter && Math.abs(b.offset - off) < BOOKMARK_RADIUS);
    const paras = parasCache.get(curChapter) || [];
    const fullText = Engine.buildFullText(paras);
    if (hit) {
      book.bookmarks = marks.filter(b => b !== hit);
      toast('已移除书签');
    } else {
      const preview = fullText.slice(Math.max(0, off - 12), Math.min(fullText.length, off + 28)).replace(/\n/g, ' ');
      marks.push({ chapter: curChapter, offset: off, preview, time: Date.now() });
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
    book.progress = { chapter: curChapter, ratio: currentRatio(curChapter) };
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
      const isCur = i === curChapter;
      const isRead = i < curChapter;
      item.className = 'toc-item' + (isCur ? ' current' : '') + (isRead ? ' read' : '');
      const dot = isCur ? '<span class="toc-dot"></span>' : '<span style="width:5px;flex-shrink:0"></span>';
      const pct = Math.min(100, Math.round((cum + m.charLen) / Math.max(1, book.totalChars) * 100));
      item.innerHTML = `${dot}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${Engine.esc(m.title || `第 ${i + 1} 章`)}</span><span class="toc-pct">${pct}%</span>`;
      item.addEventListener('click', () => gotoChapter(i, 0));
      list.appendChild(item);
      cum += m.charLen;
    });
    const cur = list.querySelector('.toc-item.current');
    // 只在目录列表自身内滚动定位，不牵动外层阅读容器（避免打开目录时阅读页闪跳）
    if (cur) {
      const listEl = list;
      listEl.scrollTop = cur.offsetTop - listEl.clientHeight / 2 + cur.offsetHeight / 2;
    }
  }

  /* ================= 划词 / 划线 ================= */

  function textMap() {
    const root = cnt();
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

  /** 选区 → 章节内字符偏移 {chapter, start, end}（跨章 DOM 下映射到所属章节） */
  function selectionOffsets() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const root = cnt();
    if (!root.contains(range.commonAncestorContainer)) return null;
    const map = textMap();
    const byNode = new Map(map.map(m => [m.node, m]));

    const chapOf = (node) => {
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      const chap = el && el.closest ? el.closest('.rd-chapter') : null;
      if (!chap) return null;
      const walker = document.createTreeWalker(chap, NodeFilter.SHOW_TEXT);
      let first = null, last = null;
      while (walker.nextNode()) { if (!first) first = walker.currentNode; last = walker.currentNode; }
      if (!first) return null;
      const fe = byNode.get(first), le = byNode.get(last);
      if (!fe || !le) return null;
      return { idx: parseInt(chap.dataset.idx, 10), start: fe.fullStart, end: le.fullStart + last.textContent.length };
    };

    const sp = chapOf(range.startContainer);
    const ep = chapOf(range.endContainer);
    if (!sp || !ep || sp.idx !== ep.idx) return null;
    const s = resolveOffset(map, range.startContainer, range.startOffset);
    const e = resolveOffset(map, range.endContainer, range.endOffset);
    if (s === null || e === null || e <= s || e - s > 800) return null;
    return { chapter: sp.idx, start: s - sp.start, end: e - sp.start };
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
    sel.__pending = off;
    showSelPopup(rect);
  }

  async function addHighlight() {
    const off = window.getSelection()?.__pending || selectionOffsets();
    if (!off) return;
    const paras = parasCache.get(off.chapter) || [];
    const fullText = Engine.buildFullText(paras);
    let text = fullText.slice(off.start, off.end).replace(/\n/g, '').trim();
    if (!text) return;
    const hl = { id: `h${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, chapter: off.chapter, start: off.start, end: off.end, text, color: '#f2b33d', time: Date.now() };
    book.highlights = book.highlights || [];
    book.highlights.push(hl);
    await saveBookNow();
    clearSelection();
    const ratio = currentRatio(off.chapter);
    await renderChaptersAround(off.chapter);
    curChapter = off.chapter;
    scrollToRatio(off.chapter, ratio);
    toast('已划线');
  }

  function clearSelection() {
    hideSelPopup();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  async function copySelection() {
    const off = window.getSelection()?.__pending || selectionOffsets();
    const paras = parasCache.get(off ? off.chapter : curChapter) || [];
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
    const ratio = currentRatio(curChapter);
    await renderChaptersAround(curChapter);
    scrollToRatio(curChapter, ratio);
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
      if (dt > 500) { suppressClick = true; return; }      // 长按（选词）不响应
      // 轻点（标记 suppressClick，拦截紧随其后的合成 click，避免双触发）
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) { suppressClick = true; handleTap(); }
      // 其余（纵向滑动）交给浏览器原生滚动
    }, { passive: true });

    body.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; }
      if (!window.getSelection().isCollapsed) return;      // 有选区时不翻页
      handleTap(e.clientX, window.innerWidth);
    });

    document.addEventListener('keydown', (e) => {
      if (!book || $(els.screen).classList.contains('hidden')) return;
      if (e.key === 'PageDown' || e.key === 'ArrowDown') scrollScreen(1);
      if (e.key === 'PageUp' || e.key === 'ArrowUp') scrollScreen(-1);
      if (e.key === ' ' && !e.repeat && e.target === document.body) { e.preventDefault(); scrollScreen(1); }
      if (e.key === 'Escape') closeSheets();
    });
  }

  /** 轻点：切换工具栏显隐（正文上下滑动翻页，不涉及点击翻页） */
  function handleTap() { toggleBars(); }

  function setBarsVisible(v) {
    barsVisible = v;
    document.getElementById('reader-screen').classList.toggle('bars-hidden', !v);
  }
  function toggleBars() { setBarsVisible(!barsVisible); }

  /* ================= 面板 ================= */

  function openSheet(id) { window.openSheet(id); }
  function closeSheet(id) { window.closeSheet(id); }
  function closeSheets() { window.closeSheets(); }

  function toast(msg) { window.YueduToast && window.YueduToast(msg); }

  /* ================= 绑定 ================= */

  function bind() {
    $('btn-back').addEventListener('click', close);
    $('btn-bookmark').addEventListener('click', toggleBookmark);

    // 主题切换只换 CSS 变量，无需重排正文
    $('btn-theme').addEventListener('click', () => {
      setSetting('theme', S.theme === 'night' ? 'day' : 'night', false);
    });

    // 进度条：拖动时只实时显示百分比（不重排不卡）；松手才跨章定位
    const slider = $('progress-slider');
    slider.addEventListener('input', () => {
      const pct = Math.round(parseFloat(slider.value) * 100) / 100;
      $('progress-text').textContent = `${pct}%`;
    });
    slider.addEventListener('change', () => seekToPercent(parseFloat(slider.value) / 100));

    // 设置面板
    $('btn-more').addEventListener('click', () => openSheet('settings-panel'));
    $('font-plus').addEventListener('click', () => setSetting('fontSize', Math.min(28, S.fontSize + 1)));
    $('font-minus').addEventListener('click', () => setSetting('fontSize', Math.max(14, S.fontSize - 1)));
    $('lineheight-slider').addEventListener('input', (e) => { S.lineHeight = parseFloat(e.target.value); applySettings(); });
    $('lineheight-slider').addEventListener('change', () => { saveSettings(); reRenderKeepPos(); });
    $('brightness-slider').addEventListener('input', (e) => { S.brightness = parseInt(e.target.value); applySettings(); });
    $('brightness-slider').addEventListener('change', () => { saveSettings(); });
    document.querySelectorAll('#font-family-options .seg-btn').forEach(b => {
      // 字体切换只改 CSS 变量，浏览器自动重排，无需重建 DOM（避免正文闪跳）
      // 宋体/楷体需先懒加载内嵌 web 字体（iOS 缺系统字体）
      b.addEventListener('click', () => { ensureWebFont(b.dataset.font); setSetting('fontFamily', b.dataset.font, false); });
    });
    document.querySelectorAll('#theme-options .theme-swatch').forEach(b => {
      b.addEventListener('click', () => setSetting('theme', b.dataset.theme, false));
    });

    // 目录
    $('btn-toc').addEventListener('click', () => { if (book) { openSheet('toc-panel'); buildTocList(); } });

    // 划词
    $('sel-highlight').addEventListener('click', addHighlight);
    $('sel-copy').addEventListener('click', copySelection);
    cnt().addEventListener('mouseup', (e) => { setTimeout(() => { if (!window.getSelection().isCollapsed) handleSelection(); }, 10); });
    cnt().addEventListener('touchend', (e) => {
      setTimeout(() => {
        if (window.getSelection() && !window.getSelection().isCollapsed) handleSelection();
      }, 350);
    });
    // 点击划线 → 删除
    cnt().addEventListener('click', (e) => {
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

    // 滚动监听
    vp().addEventListener('scroll', onScroll, { passive: true });

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
    open, close, gotoChapter,
    loadSettings, applySettings, todaySeconds, flushReadingTime,
    bind, closeSheets,
  };
})();
