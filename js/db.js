/* ================================================================
 * db.js — IndexedDB 封装
 * stores:
 *   books    : keyPath 'id'      书籍元数据（含书签/划线/进度）
 *   chapters : keyPath 'id'      id = `${bookId}:${chapterIndex}` 章节正文
 *   kv       : keyPath 'key'     全局设置与阅读统计
 * ================================================================ */
'use strict';

const DB = (() => {
  const DB_NAME = 'yuedu-db';
  const DB_VER = 1;
  let _db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          const st = db.createObjectStore('books', { keyPath: 'id' });
          st.createIndex('lastReadAt', 'lastReadAt');
        }
        if (!db.objectStoreNames.contains('chapters')) {
          db.createObjectStore('chapters', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return _db.transaction(store, mode).objectStore(store);
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  return {
    async init() { await open(); },
    /* ---------- books ---------- */
    async allBooks() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const st = db.transaction('books').objectStore('books');
        const req = st.getAll();
        req.onsuccess = () => {
          const list = req.result.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
          resolve(list);
        };
        req.onerror = () => reject(req.error);
      });
    },
    async getBook(id) {
      const db = await open();
      return reqP(tx('books', 'readonly').get(id));
    },
    putBook(book) {
      return open().then(() => reqP(tx('books', 'readwrite').put(book)));
    },
    async deleteBook(id) {
      const db = await open();
      await reqP(tx('books', 'readwrite').delete(id));
      // 级联删除章节
      await new Promise((resolve, reject) => {
        const t = db.transaction('chapters', 'readwrite');
        const st = t.objectStore('chapters');
        const req = st.openCursor(IDBKeyRange.bound(id + ':', id + ':\uffff'));
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) { cur.delete(); cur.continue(); }
          else resolve();
        };
        req.onerror = () => reject(req.error);
      });
    },
    /* ---------- chapters ---------- */
    async getChapter(id) {
      const db = await open();
      return reqP(tx('chapters', 'readonly').get(id));
    },
    putChapter(rec) {
      return open().then(() => reqP(tx('chapters', 'readwrite').put(rec)));
    },
    /* ---------- kv ---------- */
    async getKV(key, def = null) {
      const db = await open();
      const v = await reqP(tx('kv', 'readonly').get(key));
      return v === undefined ? def : v.value;
    },
    setKV(key, value) {
      return open().then(() => reqP(tx('kv', 'readwrite').put({ key, value })));
    },
  };
})();
