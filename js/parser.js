/* ================================================================
 * parser.js — 书籍解析
 *  parseTXT(file, onProgress)  → ParsedBook
 *  parseEPUB(file, onProgress) → ParsedBook
 * ParsedBook = {
 *   title, author, coverBlob,
 *   chapters: [{ title, paras: Array<{text}|{img:dataURI}> }]
 * }
 * ================================================================ */
'use strict';

const Parser = (() => {

  const CHAP_RE = /^[\s　]*(第[〇零一二三四五六七八九十百千万两0-9０-９]+[章节卷回集部篇][^\n]{0,40}|序章|序言|序\b|楔子|引子|前言|自序|后记|尾声|终章|番外[篇集]?[^\n]{0,30})[\s　]*$/;
  const BLOCK_TAGS = new Set(['p','div','h1','h2','h3','h4','h5','h6','li','blockquote','pre','tr','dt','dd','section','article','figure','figcaption','td','th','ul','ol','table','caption','header','footer','aside','main','hr']);
  const DROP_TAGS = new Set(['script','style','noscript','svg','head','iframe','object','embed','template','link','meta','title']);

  /* ---------------- 通用工具 ---------------- */

  function titleFromFilename(name) {
    let t = (name || '').replace(/\.(txt|epub)$/i, '');
    t = t.replace(/[\[\(（【]\s*[^\])】]{0,14}\s*[\]\)）】]/g, '').trim();
    return t || '未命名书籍';
  }

  function decodeText(buf) {
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    let s = new TextDecoder('utf-8').decode(bytes);
    let bad = 0;
    for (let i = 0; i < s.length && bad <= 20; i++) if (s.charCodeAt(i) === 0xFFFD) bad++;
    if (bad > 0) {
      try { s = new TextDecoder('gbk').decode(bytes); } catch (e) { /* keep utf8 result */ }
    }
    return s;
  }

  function cleanLines(ls) {
    const out = [];
    for (const l of ls) {
      const t = l.replace(/\s+/g, ' ').trim();
      if (t) out.push({ text: t });
    }
    return out;
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ---------------- TXT ---------------- */

  async function parseTXT(file, onProgress) {
    const name = file.name || 'book.txt';
    onProgress && onProgress({ label: '读取文件…', pct: 10 });
    const buf = await file.arrayBuffer();
    onProgress && onProgress({ label: '识别编码与章节…', pct: 40 });
    let text = decodeText(buf);
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');

    const chapters = [];
    let curTitle = '';
    let curLines = [];
    const push = () => {
      const paras = cleanLines(curLines);
      if (paras.length) chapters.push({ title: curTitle || paras[0].text.slice(0, 30), paras });
      curLines = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/^\uFEFF/, '').trim();
      if (!line) continue;
      if (CHAP_RE.test(line)) { push(); curTitle = line; }
      else curLines.push(lines[i].trim());
      if (i % 20000 === 0) await sleep(0); // 保持 UI 响应
    }
    push();

    // 章节过少则整本视为单章
    let title = titleFromFilename(name);
    if (chapters.length < 3 && chapters.length > 0) {
      const only = chapters[0];
      chapters.splice(0, chapters.length);
      chapters.push({ title: title, paras: only.paras });
    } else if (chapters.length === 0) {
      chapters.push({ title: title, paras: [] });
    }

    // 去掉开头疑似"目录"的正文段
    if (chapters.length > 1 && chapters[0].paras.length <= 60) {
      const p0 = chapters[0].paras[0];
      if (p0 && p0.text === '目录') chapters.shift();
    }

    onProgress && onProgress({ label: '解析完成', pct: 100 });
    return { title, author: '', coverBlob: null, format: 'txt', chapters };
  }

  /* ---------------- EPUB ---------------- */

  function joinPath(dir, href) {
    const base = dir.split('/');
    const parts = href.split('/');
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') base.pop();
      else base.push(p);
    }
    return base.join('/').replace(/^\/+/, '');
  }

  function parseXML(str, type = 'application/xml') {
    return new DOMParser().parseFromString(str, type);
  }

  function textOf(node) { return (node && node.textContent || '').trim(); }

  function firstMatch(nodeList, re) {
    for (const n of nodeList) { const t = textOf(n); if (re.test(t)) return t; }
    return '';
  }

  async function loadText(zip, path) {
    const f = zip.file(path);
    if (!f) return '';
    const ab = await f.async('arraybuffer');
    return decodeText(ab);
  }

  /* HTML → 段落（含图片 dataURI） */
  async function htmlToParas(zip, chapterDir, html) {
    const doc = parseXML(html, 'text/html');
    const root = doc.body || doc;
    const paras = [];
    let buf = [];

    const flush = () => {
      const t = buf.join('').replace(/\s+/g, ' ').trim();
      if (t) paras.push({ text: t });
      buf = [];
    };

    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { buf.push(node.textContent); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      if (DROP_TAGS.has(tag)) return;
      if (tag === 'br') { flush(); return; }
      if (tag === 'img' || tag === 'image') {
        flush();
        const src = node.getAttribute('src') || node.getAttribute('xlink:href') || '';
        if (src) paras.push({ img: src });
        return;
      }
      if (BLOCK_TAGS.has(tag)) flush();
      for (const c of node.childNodes) walk(c);
      if (BLOCK_TAGS.has(tag)) flush();
    };
    walk(root);
    flush();

    // 解析图片为 dataURI（缺失则删除）
    const resolved = [];
    for (const p of paras) {
      if (p.img) {
        const clean = decodeURIComponent(p.img.split('#')[0]);
        if (!clean) continue;
        const path = joinPath(chapterDir, clean);
        const f = zip.file(path);
        if (f) {
          try {
            const blob = await f.async('blob');
            const uri = await blobToDataURL(blob);
            if (uri && uri.length < 900_000) resolved.push({ img: uri });
          } catch (e) { /* 忽略坏图 */ }
        }
      } else {
        resolved.push(p);
      }
    }
    return resolved;
  }

  async function parseEPUB(file, onProgress) {
    onProgress && onProgress({ label: '解压 EPUB…', pct: 5 });
    const zip = await JSZip.loadAsync(await file.arrayBuffer());

    onProgress && onProgress({ label: '读取元数据…', pct: 15 });
    // container.xml → OPF
    const containerXml = await loadText(zip, 'META-INF/container.xml');
    const containerDoc = parseXML(containerXml);
    let opfPath = '';
    const rootfiles = containerDoc.getElementsByTagNameNS('*', 'rootfile');
    for (const rf of rootfiles) {
      opfPath = rf.getAttribute('full-path') || '';
      if (opfPath) break;
    }
    if (!opfPath) {
      // 回退：找第一个 .opf
      let found = '';
      zip.forEach((p, f) => { if (!found && /\.opf$/i.test(p) && !f.dir) found = p; });
      opfPath = found;
    }
    if (!opfPath) throw new Error('无法定位 EPUB 书籍文件');

    const opfDir = opfPath.split('/').slice(0, -1).join('/');
    const opf = parseXML(await loadText(zip, opfPath));
    const err = opf.getElementsByTagName('parsererror');
    if (err.length) throw new Error('EPUB 元数据解析失败');

    // 元数据
    const ns = (tag) => {
      const els = opf.getElementsByTagNameNS('*', tag);
      return els.length ? (els[0].textContent || '').trim() : '';
    };
    let title = ns('title') || titleFromFilename(file.name);
    let author = ns('creator') || '';

    // manifest
    const items = {};
    const manItems = opf.getElementsByTagNameNS('*', 'item');
    for (const it of manItems) {
      const id = it.getAttribute('id');
      const href = it.getAttribute('href');
      const media = it.getAttribute('media-type');
      const props = it.getAttribute('properties') || '';
      if (id && href) items[id] = { href, media, props, path: joinPath(opfDir, href) };
    }

    // 封面
    let coverBlob = null;
    for (const id in items) {
      const it = items[id];
      if (/cover/i.test(id) || /cover-image/i.test(it.props) || (it.media && it.media.startsWith('image/'))) {
        const f = zip.file(it.path);
        if (f) { try { coverBlob = await f.async('blob'); } catch (e) {} }
        if (coverBlob) break;
      }
    }

    // spine 顺序
    const spineOrder = [];
    const spineRefs = opf.getElementsByTagNameNS('*', 'itemref');
    for (const sr of spineRefs) {
      const idref = sr.getAttribute('idref');
      if (idref && items[idref]) spineOrder.push(idref);
    }
    if (!spineOrder.length) {
      for (const id in items) if (items[id].media && /html|xhtml/.test(items[id].media)) spineOrder.push(id);
    }

    // 目录标题（ncx / nav）
    let tocLabels = [];
    for (const p of Object.values(items)) {
      if (/\.ncx$/i.test(p.href)) {
        try {
          const ncx = parseXML(await loadText(zip, p.path));
          const labels = [];
          const navPoints = ncx.getElementsByTagNameNS('*', 'navPoint');
          for (const np of navPoints) {
            const lbl = np.getElementsByTagNameNS('*', 'navLabel')[0];
            const txt = lbl ? textOf(lbl.getElementsByTagNameNS('*', 'text')[0]) : '';
            if (txt) labels.push(txt);
          }
          if (labels.length) tocLabels = labels;
        } catch (e) {}
        break;
      }
    }
    if (!tocLabels.length) {
      for (const p of Object.values(items)) {
        if (/nav\.x?html?$/i.test(p.href) || /nav/i.test(p.href) && /xhtml|html/i.test(p.media)) {
          try {
            const nav = parseXML(await loadText(zip, p.path), 'text/html');
            const links = nav.querySelectorAll('nav ol li a, nav ol a');
            const labels = [];
            for (const a of links) { const t = (a.textContent || '').trim(); if (t) labels.push(t); }
            if (labels.length > 2) tocLabels = labels;
          } catch (e) {}
          break;
        }
      }
    }

    // 逐章解析
    const chapters = [];
    const total = spineOrder.length;
    for (let i = 0; i < total; i++) {
      const it = items[spineOrder[i]];
      onProgress && onProgress({ label: `解析章节 ${i + 1}/${total}…`, pct: 15 + Math.round(75 * i / total) });
      let html = '';
      try { html = await loadText(zip, it.path); } catch (e) {}
      if (!html) continue;
      let paras = [];
      try { paras = await htmlToParas(zip, it.path.split('/').slice(0, -1).join('/'), html); } catch (e) {}
      // 章节标题
      let chTitle = tocLabels[i] || '';
      if (!chTitle) {
        const doc = parseXML(html, 'text/html');
        const h = doc.querySelector('h1,h2,h3,h4');
        chTitle = h ? (h.textContent || '').trim() : '';
      }
      if (!chTitle) chTitle = `第 ${chapters.length + 1} 章`;
      chapters.push({ title: chTitle.slice(0, 40), paras });
      await sleep(0);
    }
    if (!chapters.length) throw new Error('EPUB 中没有可读内容');

    onProgress && onProgress({ label: '解析完成', pct: 100 });
    return { title, author, coverBlob, format: 'epub', chapters };
  }

  return { parseTXT, parseEPUB, titleFromFilename };
})();
