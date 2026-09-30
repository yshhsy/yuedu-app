/* ================================================================
 * engine.js — 渲染引擎
 *  - 章节 HTML 生成（段落 / 插图 / 划线高亮注入）
 *  - 纵向分页计算（一屏一页，微信读书式）
 * ================================================================ */
'use strict';

const Engine = (() => {

  // 字体栈覆盖：iOS/macOS 系统字体（家族名 + PostScript 名双写法）→ Windows → Android/Linux 思源系 → 泛型兜底。
  // 部分浏览器只认其中一种写法，缺一种就会出现"选了宋体/楷体但渲染不变"的问题。
  const FONT_STACKS = {
    sans: `-apple-system,BlinkMacSystemFont,"Helvetica Neue","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",sans-serif`,
    // 宋体/楷体首选内嵌 web 字体（iOS 无 Songti SC/Kaiti SC 等系统字体，见 reader.js 懒加载）
    song: `"Yuedu Serif","Songti SC","STSongti-SC-Regular","STSong","SimSun","NSimSun","Source Han Serif SC","Noto Serif CJK SC","Noto Serif SC",serif`,
    hei:  `"PingFang SC","Heiti SC","Hiragino Sans GB","Microsoft YaHei","Source Han Sans SC","Noto Sans CJK SC",sans-serif`,
    kai:  `"Yuedu Kai","Kaiti SC","STKaiti-SC-Regular","STKaiti","KaiTi","BiauKai","AR PL UKai CN",serif`,
  };

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 章节全文（段落以 \n 分隔），与划词 offset 一一对应 */
  function buildFullText(paras) {
    const chunks = [];
    for (const p of paras) chunks.push(p.text || '');
    return chunks.join('\n');
  }

  /** 生成章节 HTML；highlights = [{id, start, end, color}]，offset 基于 buildFullText */
  function buildChapterHTML(paras, highlights) {
    const fullText = buildFullText(paras);
    const hlList = (highlights || [])
      .filter(h => typeof h.start === 'number')
      .sort((a, b) => a.start - b.start);

    const pieces = [];
    let off = 0;
    for (const p of paras) {
      if (p.img) {
        pieces.push(`<div class="rd-img"><img src="${p.img}" alt="插图" loading="lazy"></div>`);
        continue;
      }
      const t = p.text || '';
      const segStart = off, segEnd = off + t.length;
      let html = '';
      let pos = segStart;
      for (const h of hlList) {
        if (h.end <= segStart || h.start >= segEnd) continue;
        const s = Math.max(h.start, segStart), e = Math.min(h.end, segEnd);
        if (s > pos) html += esc(fullText.slice(pos, s));
        html += `<mark data-hl="${esc(h.id)}" style="--hl-color:${esc(h.color || '#f2b33d')}">${esc(fullText.slice(s, e))}</mark>`;
        pos = e;
      }
      html += esc(fullText.slice(pos, segEnd));
      pieces.push(`<p class="rd-p">${html}</p>`);
      off = segEnd + 1; // '\n'
    }
    return pieces.join('');
  }

  /** 一屏一页的页数：content 高 th，视口高 vh */
  function pageCountFor(th, vh) {
    if (th <= vh) return 1;
    return Math.ceil((th - vh) / vh) + 1;
  }

  /** 根据全局进度比例（0..1）找页码 */
  function pageForRatio(ratio, pageCount) {
    const p = Math.round((ratio || 0) * (pageCount - 1));
    return Math.max(0, Math.min(pageCount - 1, p));
  }

  /** 根据页码估比例（用于保存进度） */
  function ratioForPage(page, pageCount) {
    if (pageCount <= 1) return 0;
    return Math.max(0, Math.min(1, page / (pageCount - 1)));
  }

  return { FONT_STACKS, esc, buildFullText, buildChapterHTML, pageCountFor, pageForRatio, ratioForPage };
})();
