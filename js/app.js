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

/* ---------- 面板开关 ---------- */
const SHEET_IDS = ['toc-panel', 'settings-panel', 'import-panel', 'action-sheet'];
window.openSheet = function (id) {
  window.closeSheets();
  document.getElementById(id).classList.remove('hidden');
  document.getElementById('backdrop').classList.remove('hidden');
};
window.closeSheet = function (id) {
  document.getElementById(id).classList.add('hidden');
  if (!document.querySelector('.sheet:not(.hidden)')) document.getElementById('backdrop').classList.add('hidden');
};
window.closeSheets = function () {
  SHEET_IDS.forEach(id => document.getElementById(id).classList.add('hidden'));
  document.getElementById('backdrop').classList.add('hidden');
  document.getElementById('sel-popup') && document.getElementById('sel-popup').classList.add('hidden');
};

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
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW 注册失败', e));
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
