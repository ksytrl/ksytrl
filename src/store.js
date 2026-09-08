/**
 * 书架存储：书籍元信息 + 正文放 IndexedDB（可存几十 MB），阅读设置放 localStorage。
 * 全部在浏览器本地，不上传任何内容。
 */

const DB_NAME = 'novel-reader';
const DB_VERSION = 2;
const STORE_BOOKS = 'books';
const STORE_CONTENT = 'contents';
const STORE_MARKS = 'marks';   // 书签与笔记
const SETTINGS_KEY = 'novel-reader:settings';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CONTENT)) {
        db.createObjectStore(STORE_CONTENT, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_MARKS)) {
        db.createObjectStore(STORE_MARKS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeNames, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? storeNames.map((n) => transaction.objectStore(n))
      : transaction.objectStore(storeNames);
    let result;
    try {
      result = fn(stores);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

function reqValue(request) {
  return { __req: request };
}

export function newId() {
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 列出书架（按最近阅读排序） */
export async function listBooks() {
  const books = await tx(STORE_BOOKS, 'readonly', (store) => reqValue(store.getAll()));
  return (books || []).sort((a, b) => (b.lastReadAt || b.createdAt || 0) - (a.lastReadAt || a.createdAt || 0));
}

export async function getBook(id) {
  return tx(STORE_BOOKS, 'readonly', (store) => reqValue(store.get(id)));
}

export async function getContent(id) {
  return tx(STORE_CONTENT, 'readonly', (store) => reqValue(store.get(id)));
}

/**
 * @param {object} meta 书籍元信息（含目录）
 * @param {{raw: string, clean: string, chapterTexts: string[]}} content 原文、清洗后正文与各章正文
 */
export async function saveBook(meta, content) {
  await tx([STORE_BOOKS, STORE_CONTENT], 'readwrite', ([books, contents]) => {
    books.put(meta);
    contents.put({
      id: meta.id,
      raw: content.raw,
      clean: content.clean,
      chapterTexts: content.chapterTexts || [],
      nativeChapters: content.nativeChapters || null,
    });
  });
  return meta;
}

export async function updateBook(meta) {
  await tx(STORE_BOOKS, 'readwrite', (store) => store.put(meta));
  return meta;
}

export async function deleteBook(id) {
  await tx([STORE_BOOKS, STORE_CONTENT, STORE_MARKS], 'readwrite', ([books, contents, marks]) => {
    books.delete(id);
    contents.delete(id);
    marks.delete(id);
  });
}

/* ---------------- 书签与笔记 ---------------- */

/** @returns {Promise<Array>} 该书的书签 / 笔记列表 */
export async function getMarks(bookId) {
  const row = await tx(STORE_MARKS, 'readonly', (store) => reqValue(store.get(bookId)));
  return (row && row.items) || [];
}

export async function saveMarks(bookId, items) {
  await tx(STORE_MARKS, 'readwrite', (store) => store.put({ id: bookId, items }));
  return items;
}

/** 所有书的笔记数量，书架上用来显示角标 */
export async function markCounts() {
  const rows = await tx(STORE_MARKS, 'readonly', (store) => reqValue(store.getAll()));
  const map = new Map();
  for (const row of rows || []) map.set(row.id, (row.items || []).length);
  return map;
}

export const DEFAULT_SETTINGS = {
  theme: 'sepia',
  shelfSort: 'recent',      // recent | title | created
  shelfCategory: '',        // 书架当前筛选的分类，空 = 全部
  readingMode: 'scroll',   // 'scroll' = 上下无缝滚动，'paged' = 一章一页
  fontSize: 20,
  lineHeight: 1.9,
  letterSpacing: 0,
  paragraphSpacing: 0.8,
  pageWidth: 720,
  fontFamily: 'serif',
  autoScrollSpeed: 40,
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式下可能失败，忽略 */
  }
}
