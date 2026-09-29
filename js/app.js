/* ================================================================
 * app.js — 应用入口
 *  - 启动（DB、设置、绑定、书架渲染）
 *  - 全局：toast / 面板开关
 *  - Service Worker 注册（离线支持）
 * ================================================================ */
'use strict';

/* ---------- Toast ---------- */
let toastTimer = null;
window.YueduToast = function (msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
};

/* ---------- 面板开关（带关闭动画：下滑收起 + 遮罩淡出） ---------- */
const SHEET_IDS = ['toc-panel', 'settings-panel', 'import-panel', 'action-sheet'];
const sheetTimers = new Map();
let backdropTimer = null;

function cancelSheetTimer(id) {
  const t = sheetTimers.get(id);
  if (t) { clearTimeout(t); sheetTimers.delete(id); }
}
function hideSheetAnimated(id) {
  const el = document.getElementById(id);
  if (!el || el.classList.contains('hidden')) return;
  cancelSheetTimer(id);
  el.classList.add('closing');
  sheetTimers.set(id, setTimeout(() => {
    el.classList.remove('closing');
    el.classList.add('hidden');
    sheetTimers.delete(id);
  }, 210));
}
function hideBackdropAnimated() {
  const bd = document.getElementById('backdrop');
  if (!bd || bd.classList.contains('hidden')) return;
  if (backdropTimer) clearTimeout(backdropTimer);
  bd.classList.add('closing');
  backdropTimer = setTimeout(() => {
    bd.classList.add('hidden');
    bd.classList.remove('closing');
    backdropTimer = null;
  }, 170);
}
function showBackdrop() {
  if (backdropTimer) { clearTimeout(backdropTimer); backdropTimer = null; }
  const bd = document.getElementById('backdrop');
  bd.classList.remove('closing', 'hidden');
}

window.openSheet = function (id) {
  // 先收起其他面板，再展示目标面板（若目标正处于关闭动画中则直接拉回）
  SHEET_IDS.forEach(sid => { if (sid !== id) hideSheetAnimated(sid); });
  cancelSheetTimer(id);
  const el = document.getElementById(id);
  el.classList.remove('closing', 'hidden');
  showBackdrop();
};
window.closeSheet = function (id) {
  hideSheetAnimated(id);
  if (!document.querySelector('.sheet:not(.hidden):not(.closing)')) hideBackdropAnimated();
};
window.closeSheets = function () {
  SHEET_IDS.forEach(hideSheetAnimated);
  hideBackdropAnimated();
  const sel = document.getElementById('sel-popup');
  if (sel) sel.classList.add('hidden');
};

// 全局：Escape 关闭面板（书架页也生效）
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.closeSheets();
});

/* ---------- 启动 ---------- */
async function boot() {
  try {
    await DB.init();
  } catch (e) {
    console.error('IndexedDB 不可用', e);
    alert('当前环境不支持本地存储，请使用较新的浏览器（Chrome / Safari / Edge）。');
    return;
  }
  await Reader.loadSettings();
  Library.bind();
  Reader.bind();
  await Library.refresh();
  // 云书架自动同步：电脑端已部署的书，手机端首次打开自动拉取导入
  await Library.syncCloud();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 注册失败', e));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
