/* ================================================================
 * library.js — 书架
 *  - 封面渲染（EPUB 封面 / Canvas 生成封面）
 *  - 书籍导入（文件 / 链接）、删除、续读
 *  - 今日阅读统计
 * ================================================================ */
'use strict';

const Library = (() => {

  const PALETTES = [
    ['#2b5876', '#4e4376'], ['#134e5e', '#71b280'], ['#b45309', '#f59e0b'], ['#0f2027', '#2c5364'],
    ['#232526', '#414345'], ['#870000', '#190a05'], ['#1f4037', '#2d7d5c'], ['#6a3093', '#a044ff'],
    ['#c31432', '#240b36'], ['#355c7d', '#6c5b7b'], ['#007991', '#439a86'], ['#485563', '#29323c'],
    ['#e96443', '#904e95'], ['#2193b0', '#6dd5ed'], ['#3a1c71', '#d76d77'], ['#5f2c82', '#49a09d'],
  ];

  const $ = (id) => document.getElementById(id);
  let objectUrls = [];

  function revokeUrls() {
    objectUrls.forEach(u => URL.revokeObjectURL(u));
    objectUrls = [];
  }

  /* ================= 封面 ================= */

  function bookPct(b) {
    if (!b || !b.totalChars) return 0;
    const meta = b.chaptersMeta || [];
    let cum = 0;
    const ci = (b.progress && b.progress.chapter) || 0;
    for (let i = 0; i < Math.min(ci, meta.length); i++) cum += meta[i].charLen;
    const len = (meta[ci] || {}).charLen || 1;
    const ratio = (b.progress && b.progress.ratio) || 0;
    return Math.max(0, Math.min(1, (cum + ratio * len) / b.totalChars));
  }

  function coverHTML(b) {
    if (b.cover) {
      const url = URL.createObjectURL(b.cover);
      objectUrls.push(url);
      return `<img src="${url}" alt="${Engine.esc(b.title)}">`;
    }
    // 无封面时用文字兜底（导入时一般已生成，此处为保险）
    return `<div class="cover-fallback"><span class="cf-title">${Engine.esc(b.title || '')}</span><span class="cf-author">${Engine.esc(b.author || '')}</span></div>`;
  }

  function makeCard(b) {
    const el = document.createElement('div');
    el.className = 'book-card';
    const pct = Math.round(bookPct(b) * 100);
    const done = pct >= 100;
    el.innerHTML = `
      <div class="book-cover">${coverHTML(b)}<span class="book-more">···</span></div>
      <div class="book-info">
        <div class="b-title">${Engine.esc(b.title || '未命名')}</div>
        <div class="b-author">${Engine.esc(b.author || '未知作者')}</div>
        <div class="book-progress ${done ? 'done' : ''}"><i style="width:${pct}%"></i></div>
      </div>`;
    el.querySelector('.book-more').addEventListener('click', (e) => {
      e.stopPropagation();
      showActionSheet(b);
    });
    el.addEventListener('click', () => Reader.open(b.id));
    bindLongPress(el, () => showActionSheet(b));
    return el;
  }

  function bindLongPress(el, cb) {
    let t = null, x0 = 0, y0 = 0;
    el.addEventListener('touchstart', (e) => {
      const tch = e.changedTouches[0];
      x0 = tch.clientX; y0 = tch.clientY;
      t = setTimeout(() => { t = null; if (navigator.vibrate) navigator.vibrate(30); cb(); }, 560);
    }, { passive: true });
    const clear = () => { if (t) { clearTimeout(t); t = null; } };
    el.addEventListener('touchend', (e) => {
      const tch = e.changedTouches[0];
      if (Math.abs(tch.clientX - x0) > 12 || Math.abs(tch.clientY - y0) > 12) clear();
      else setTimeout(clear, 400);
    }, { passive: true });
    el.addEventListener('touchmove', clear, { passive: true });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); cb(); });
  }

  /* ================= 渲染 ================= */

  async function refresh() {
    revokeUrls();
    const books = await DB.allBooks();
    const shelf = $('bookshelf');
    shelf.innerHTML = '';
    $('empty-state').classList.toggle('hidden', books.length > 0);
    books.forEach(b => shelf.appendChild(makeCard(b)));
    updateTodayMinutes();
  }

  async function updateTodayMinutes() {
    const secs = await Reader.todaySeconds();
    const el = $('today-minutes');
    if (secs >= 60) {
      el.textContent = `今日已读 ${Math.round(secs / 60)} 分钟`;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  /* ================= 操作面板 ================= */

  function showActionSheet(b) {
    $('action-title').textContent = b.title;
    $('act-continue').onclick = () => { Reader.open(b.id); closeSheets(); };
    const restartBtn = $('act-restart');
    restartBtn.onclick = async () => {
      b.progress = { chapter: 0, ratio: 0 };
      await DB.putBook(b);
      closeSheets();
      toast('已从头开始');
      refresh();
    };
    const delBtn = $('act-delete');
    delBtn.textContent = '删除本书';
    let armed = false;
    delBtn.onclick = async () => {
      if (!armed) { armed = true; delBtn.textContent = '再次点击确认删除'; setTimeout(() => { armed = false; delBtn.textContent = '删除本书'; }, 3000); return; }
      await DB.deleteBook(b.id);
      closeSheets();
      toast('已删除');
      refresh();
    };
    openSheet('action-sheet');
  }

  /* ================= 导入 ================= */

  function openImport() {
    openSheet('import-panel');
    $('import-url-form').classList.add('hidden');
  }

  async function importFiles(files) {
    closeSheets();
    for (const file of files) {
      try {
        await importOne(file);
        toast(`《${file.name.replace(/\.(txt|epub)$/i, '')}》导入成功`);
      } catch (e) {
        console.error(e);
        toast(`《${file.name}》导入失败：${e.message || '格式不支持'}`);
      }
    }
    await refresh();
  }

  async function importOne(file) {
    const overlay = $('import-progress');
    const fill = $('ip-bar-fill');
    const sub = $('ip-sub');
    const title = $('ip-title');
    const show = (label, pct) => {
      overlay.classList.remove('hidden');
      title.textContent = `正在导入《${file.name.replace(/\.(txt|epub)$/i, '')}》`;
      fill.style.width = `${Math.max(3, Math.min(100, pct))}%`;
      sub.textContent = label || '';
    };
    show('准备解析…', 3);

    const isEpub = /\.epub$/i.test(file.name);
    const parsed = isEpub ? await Parser.parseEPUB(file, (s) => show(s.label, s.pct)) : await Parser.parseTXT(file, (s) => show(s.label, s.pct));

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    let totalChars = 0;
    const chaptersMeta = parsed.chapters.map((ch, i) => {
      let len = 0, n = 0;
      for (const p of ch.paras) if (p.text) { len += p.text.length; n++; }
      len += Math.max(0, n - 1);
      totalChars += len;
      return { title: ch.title, charLen: len };
    });

    for (let i = 0; i < parsed.chapters.length; i++) {
      await DB.putChapter({ id: `${id}:${i}`, bookId: id, idx: i, paras: parsed.chapters[i].paras });
      show(`保存章节 ${i + 1}/${parsed.chapters.length}…`, 50 + Math.round(45 * (i + 1) / parsed.chapters.length));
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 0));
    }

    let cover = parsed.coverBlob || null;
    if (!cover) {
      show('生成封面…', 97);
      cover = await generateCover(parsed.title, parsed.author);
    }

    const book = {
      id, title: parsed.title, author: parsed.author, format: isEpub ? 'epub' : 'txt',
      size: file.size, addedAt: Date.now(), lastReadAt: Date.now(), totalChars,
      chaptersMeta, progress: { chapter: 0, ratio: 0 }, bookmarks: [], highlights: [],
      cover,
    };
    await DB.putBook(book);
    overlay.classList.add('hidden');
    return book;
  }

  async function generateCover(title, author) {
    try {
      const w = 600, h = 900;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      let h1 = 0;
      for (let i = 0; i < (title || 'x').length; i++) h1 = (h1 * 31 + (title.charCodeAt(i) || 0)) >>> 0;
      const [c1, c2] = PALETTES[h1 % PALETTES.length];
      const grad = ctx.createLinearGradient(0, 0, w * 0.85, h);
      grad.addColorStop(0, c1); grad.addColorStop(1, c2);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      // 装饰线
      ctx.fillStyle = 'rgba(255,255,255,.14)';
      ctx.fillRect(0, 0, w, 6);
      // 书名
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      const isCJK = /[\u4e00-\u9fff]/.test(title || '');
      if (isCJK) {
        const chars = (title || '读').slice(0, 4);
        ctx.font = '700 118px "Songti SC","Noto Serif CJK SC","Kaiti SC",serif';
        ctx.fillText(chars, w / 2, h * 0.46);
        ctx.font = '28px "PingFang SC",sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,.8)';
        ctx.fillText((title || '').slice(4), w / 2, h * 0.46 + 90);
      } else {
        ctx.font = '700 64px "Helvetica Neue",sans-serif';
        ctx.fillText((title || 'BOOK').slice(0, 12), w / 2, h * 0.46);
      }
      // 作者
      if (author) {
        ctx.font = '26px "PingFang SC",sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,.62)';
        ctx.fillText(author, w / 2, h * 0.46 + 170);
      }
      // 底部小书形
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath();
      ctx.roundRect(w / 2 - 46, h - 130, 92, 56, 10);
      ctx.fill();
      ctx.fillStyle = c2;
      ctx.beginPath();
      ctx.roundRect(w / 2 - 8, h - 130, 16, 56, 4);
      ctx.fill();
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
      return blob;
    } catch (e) { return null; }
  }

  /* ================= 链接导入 ================= */

  async function importFromURL(url) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = url.split('?')[0].split('/').pop() || 'book.txt';
      const file = new File([blob], name, { type: blob.type || 'text/plain' });
      await importFiles([file]);
    } catch (e) {
      toast('链接导入失败：跨域限制或地址无效');
    }
  }

  /* ================= 云书架（电脑导入 → 手机自动同步） ================= */

  function cloudId(title) {
    let h = 0;
    for (const ch of title) h = (h * 31 + (ch.codePointAt(0) || 0)) >>> 0;
    return 'cloud' + h.toString(36);
  }

  // 解析 {book, author, chapters:[{number,title,paragraphs:[str...]}]} → {title, author, chapters:[{title, paras}]}
  async function importCloudJSON(id, data, label) {
    const overlay = $('import-progress');
    const fill = $('ip-bar-fill');
    const sub = $('ip-sub');
    const titleEl = $('ip-title');
    const title = (data.book || data.title || label || '未命名').trim();
    const author = (data.author || '').trim();
    const chapters = (data.chapters || []).map((ch, i) => ({
      title: (ch.title || '').trim() || `第 ${i + 1} 章`,
      paras: (ch.paragraphs || []).map(t => ({ text: (typeof t === 'string' ? t : (t && t.text) || '').trim() })).filter(p => p.text),
    })).filter(ch => ch.paras.length);

    overlay.classList.remove('hidden');
    titleEl.textContent = `正在同步《${title}》`;
    fill.style.width = '4%';
    sub.textContent = '整理章节…';

    let totalChars = 0;
    const chaptersMeta = chapters.map(ch => {
      let len = 0, n = 0;
      for (const p of ch.paras) if (p.text) { len += p.text.length; n++; }
      len += Math.max(0, n - 1);
      totalChars += len;
      return { title: ch.title, charLen: len };
    });

    for (let i = 0; i < chapters.length; i++) {
      await DB.putChapter({ id: `${id}:${i}`, bookId: id, idx: i, paras: chapters[i].paras });
      fill.style.width = `${10 + Math.round(80 * (i + 1) / chapters.length)}%`;
      sub.textContent = `章节 ${i + 1}/${chapters.length}`;
      if (i % 20 === 0) await new Promise(r => setTimeout(r, 0));
    }

    fill.style.width = '93%';
    sub.textContent = '生成封面…';
    const cover = await generateCover(title, author);

    const book = {
      id, title, author, format: 'json', size: data.size || 0,
      addedAt: Date.now(), lastReadAt: Date.now(), totalChars,
      chaptersMeta, progress: { chapter: 0, ratio: 0 }, bookmarks: [], highlights: [],
      cover,
    };
    await DB.putBook(book);
    overlay.classList.add('hidden');
    return book;
  }

  // 启动时自动同步云书架：读取 cloud-books.json 清单，把未导入的书拉取入库
  async function syncCloud() {
    let manifest;
    try {
      const res = await fetch('cloud-books.json', { cache: 'no-store' });
      if (!res.ok) return;
      manifest = await res.json();
    } catch (e) { return; } // 无云书架配置（本地开发）时静默跳过
    const list = (manifest && manifest.books) || [];
    if (!list.length) return;

    let imported = 0, failed = 0;
    for (const item of list) {
      const id = cloudId(item.title || item.file);
      if (await DB.getBook(id)) continue; // 已同步过则跳过
      try {
        const res = await fetch(item.file, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        await importCloudJSON(id, data, item.title);
        imported++;
      } catch (e) {
        console.error('云书架同步失败：', item.file, e);
        failed++;
      }
    }
    if (imported || failed) {
      await refresh();
      if (imported && !failed) toast(`云书架已就绪：《${list[0].title}》${imported > 1 ? ` 等 ${imported} 本` : ''}`);
      else if (failed) toast(`云书架同步：${imported ? imported + ' 本成功，' : ''}${failed} 本失败`);
    }
  }

  /* ================= 绑定 ================= */

  function bind() {
    $('btn-import').addEventListener('click', openImport);
    $('btn-import-empty').addEventListener('click', openImport);
    $('import-file-btn').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => {
      if (e.target.files.length) importFiles([...e.target.files]);
      e.target.value = '';
    });
    $('import-url-btn').addEventListener('click', () => $('import-url-form').classList.remove('hidden'));
    $('import-url-go').addEventListener('click', () => {
      const url = $('import-url-input').value.trim();
      if (url) { closeSheets(); importFromURL(url); $('import-url-input').value = ''; }
    });
    window.addEventListener('reader-closed', refresh);
  }

  return { bind, refresh, importFiles, syncCloud };
})();
