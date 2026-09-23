/**
 * 应用主控：导入 → 清洗排版 → 分章 → 阅读 / 跳章。
 * 纯前端，无后端，数据只存在浏览器本地。
 */
import { decodeBuffer, SUPPORTED_ENCODINGS } from './encoding.js';
import { cleanText, cleanBookTitle, CLEAN_DEFAULTS } from './cleaner.js';
import {
  FORMAT_GROUPS, readAnyFile, groupOf, extOf,
} from './formats/readers.js';
import { ocrPdf, OCR_LANGS, OCR_SCALES } from './formats/ocr.js';
import {
  splitSentences, supportsTts, listVoices, whenVoicesReady, createSpeaker, TTS_RATES,
} from './tts.js';
import {
  CHAPTER_RULES, DEFAULT_SPLIT_OPTIONS, splitChapters, analyzeRules, suggestRuleIds,
} from './chapters.js';
import {
  listBooks, getContent, saveBook, updateBook, deleteBook, newId,
  getMarks, saveMarks, markCounts, exportBackup, importBackup,
  saveCover, getCover, saveMedia, listMedia,
  loadSettings, saveSettings, DEFAULT_SETTINGS,
} from './store.js';
import {
  isMediaLine, mediaKeyOf, describeMediaTokens, mediaKind,
} from './media.js';
import { generateCover, fitCover } from './cover.js';

const APP_VERSION = '1.10.0';   // 显示在阅读设置里，方便确认用的是哪一版
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fmtNum = (n) => (n || 0).toLocaleString('zh-CN');

const state = {
  settings: loadSettings(),
  books: [],
  book: null,          // 当前书籍 meta
  chapterTexts: [],    // 当前书籍各章正文
  cleanTextValue: '',  // 当前书籍清洗后全文（导出用）
  chapterIndex: 0,
  tocReversed: false,
  highlight: '',
  autoScrollTimer: null,
  pending: null,       // 导入 / 重新排版的临时数据
  flow: null,          // 无缝滚动模式下已加载的章节区间
  marks: [],           // 当前书的书签与笔记
  markCounts: new Map(),
  covers: new Map(),
  mediaIndex: new Map(),  // 当前书的图片 / 视频：key → { mime, alt, blob }
  mediaUrls: new Map(),   // key → blob URL（换书时统一释放）
  shelf: { selecting: false, picked: new Set(), page: 1, status: 'all', tidyPlan: 'format' },
  editingMark: null,
  ocr: null,
  tts: null,          // 朗读状态：{ speaker, chapterIndex, sentences }
  nativeChapters: null,// 电子书自带目录
  batchAbort: false,
  importFormat: 'txt',   // 当前导入分栏：pdf / epub / txt / other
};

/* =========================================================
 * 阅读设置
 * =======================================================*/
function applySettings() {
  const s = state.settings;
  const fonts = { serif: 'var(--font-serif)', sans: 'var(--font-sans)', kai: 'var(--font-kai)', fangsong: 'var(--font-fangsong)' };
  const root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--reader-size', `${s.fontSize}px`);
  root.style.setProperty('--reader-line', String(s.lineHeight));
  root.style.setProperty('--reader-spacing', `${s.letterSpacing}px`);
  root.style.setProperty('--reader-para', `${s.paragraphSpacing}em`);
  root.style.setProperty('--reader-width', `${s.pageWidth}px`);
  root.style.setProperty('--reader-font', fonts[s.fontFamily] || fonts.serif);

  $('val-fontSize').textContent = `${s.fontSize}px`;
  $('val-lineHeight').textContent = s.lineHeight.toFixed(2);
  $('val-letterSpacing').textContent = `${s.letterSpacing}px`;
  $('val-paragraphSpacing').textContent = `${s.paragraphSpacing.toFixed(1)}em`;
  $('val-pageWidth').textContent = `${s.pageWidth}px`;
  ['fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'pageWidth', 'autoScrollSpeed']
    .forEach((k) => { $(`set-${k}`).value = s[k]; });
  $('set-fontFamily').value = s.fontFamily;
  $('shelf-sort').value = s.shelfSort || 'recent';
  $('app-version').textContent = `版本 ${APP_VERSION} · PDF / EPUB / TXT / MOBI / DOCX / HTML / MD / FB2 / RTF`;
  [...$('theme-row').children].forEach((b) => b.classList.toggle('active', b.dataset.themeValue === s.theme));
  [...$('mode-row').children].forEach((b) => b.classList.toggle('active', b.dataset.modeValue === (s.readingMode || 'scroll')));
  saveSettings(s);
}

function bindSettings() {
  const bind = (key, parse) => {
    $(`set-${key}`).addEventListener('input', (e) => {
      state.settings[key] = parse(e.target.value);
      applySettings();
    });
  };
  bind('fontSize', Number);
  bind('lineHeight', Number);
  bind('letterSpacing', Number);
  bind('paragraphSpacing', Number);
  bind('pageWidth', Number);
  bind('autoScrollSpeed', Number);
  $('set-fontFamily').addEventListener('change', (e) => {
    state.settings.fontFamily = e.target.value;
    applySettings();
  });
  $('theme-row').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-value]');
    if (!btn) return;
    state.settings.theme = btn.dataset.themeValue;
    applySettings();
  });
  $('mode-row').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode-value]');
    if (!btn) return;
    state.settings.readingMode = btn.dataset.modeValue;
    applySettings();
    if (state.book) renderReader(state.chapterIndex, 0);
    toast(btn.dataset.modeValue === 'scroll' ? '已切换为上下无缝滚动' : '已切换为一章一页');
  });
  $('btn-export-backup').addEventListener('click', () => doExportBackup(true));
  $('btn-export-light').addEventListener('click', () => doExportBackup(false));
  $('btn-import-backup').addEventListener('click', () => $('backup-input').click());
  $('backup-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) doImportBackup(file);
  });
  $('btn-reset-settings').addEventListener('click', () => {
    state.settings = { ...DEFAULT_SETTINGS };
    applySettings();
    toast('已恢复默认设置');
  });
}

/* =========================================================
 * 通用 UI
 * =======================================================*/
let toastTimer = null;
function toast(msg) {
  const node = $('toast');
  node.textContent = msg;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
}

function openPanel(id) {
  closePanels();
  $(id).classList.remove('hidden');
  $('overlay').classList.remove('hidden');
}
function closePanels() {
  $('toc-panel').classList.add('hidden');
  $('settings-panel').classList.add('hidden');
  $('marks-panel').classList.add('hidden');
  $('overlay').classList.add('hidden');
}
function showModal(id) { $(id).classList.remove('hidden'); }

/** 导入失败时给出看得懂的原因和下一步建议 */
function showError(fileName, message, tips = [], action = null) {
  $('error-file').textContent = fileName ? `文件：${fileName}` : '';
  $('error-msg').textContent = message;
  const list = $('error-tips');
  list.innerHTML = '';
  for (const tip of tips) list.appendChild(el('li', null, tip));
  const btn = $('error-action');
  btn.classList.toggle('hidden', !action);
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { hideModal('error-modal'); action.run(); };
  } else {
    btn.onclick = null;
  }
  showModal('error-modal');
}

function importTips(fileName) {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.pdf')) {
    return [
      '扫描版 PDF（整页是图片）里没有文字，需要先用 OCR 转成文字版',
      '加了密码/权限保护的 PDF 需要先解除保护',
      '也可以把 PDF 另存 / 转换成 TXT 或 EPUB 再导入',
    ];
  }
  if (lower.endsWith('.epub')) {
    return [
      '带 DRM 的 EPUB（从商店买的）无法直接打开，需要先去掉 DRM',
      '可以用别的工具把它转换成 TXT 再导入',
    ];
  }
  return ['可以试试换一种编码，或者把文件另存为 UTF-8 的 TXT 再导入'];
}
function hideModal(id) { $(id).classList.add('hidden'); }

/* =========================================================
 * 书架：分类侧栏 / 封面墙 / 搜索排序 / 批量管理 / 智能整理
 * =======================================================*/
const UNCATEGORIZED = '未分类';
const PAGE_SIZE = { grid: 60, list: 24 };

const STATUS_LABELS = { all: '全部', reading: '在读', unread: '未读', done: '读完' };

function bookCategory(book) {
  return (book.category || '').trim() || UNCATEGORIZED;
}

function bookPercent(book) {
  if (!book.progress || !book.chapterCount || !book.lastReadAt) return 0;
  return Math.min(100, Math.round(((book.progress.chapterIndex + 1) / book.chapterCount) * 100));
}

function readStatus(book) {
  if (!book.lastReadAt) return 'unread';
  return bookPercent(book) >= 98 ? 'done' : 'reading';
}

function allCategories() {
  const map = new Map();
  for (const book of state.books) {
    const cat = bookCategory(book);
    map.set(cat, (map.get(cat) || 0) + 1);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] === UNCATEGORIZED ? 1 : b[0] === UNCATEGORIZED ? -1 : b[1] - a[1] || a[0].localeCompare(b[0], 'zh')));
}

function sortBooks(books) {
  const mode = state.settings.shelfSort || 'recent';
  const copy = [...books];
  if (mode === 'title') copy.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  else if (mode === 'created') copy.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else if (mode === 'progress') copy.sort((a, b) => bookPercent(b) - bookPercent(a));
  else copy.sort((a, b) => (b.lastReadAt || b.createdAt || 0) - (a.lastReadAt || a.createdAt || 0));
  return copy;
}

async function refreshShelf() {
  state.books = await listBooks();
  try { state.markCounts = await markCounts(); } catch { state.markCounts = new Map(); }
  renderShelf();
  refreshCategoryOptions();
}

function refreshCategoryOptions() {
  const list = $('category-options');
  list.innerHTML = '';
  for (const [name] of allCategories()) {
    if (name === UNCATEGORIZED) continue;
    const opt = document.createElement('option');
    opt.value = name;
    list.appendChild(opt);
  }
}

/* ---------------- 封面：只给当前这一页的书按需加载 ---------------- */
async function loadCoversFor(books) {
  for (const book of books) {
    if (state.covers.has(book.id)) continue;
    /* eslint-disable no-await-in-loop */
    let row = null;
    try { row = await getCover(book.id); } catch { row = null; }
    if (!row || !row.dataUrl) {
      const dataUrl = generateCover({ title: book.title, kind: book.kind });
      row = { id: book.id, dataUrl, source: 'generated' };
      try { await saveCover(book.id, dataUrl, 'generated'); } catch { /* 忽略 */ }
    }
    /* eslint-enable no-await-in-loop */
    state.covers.set(book.id, row);
    const img = document.querySelector(`.book-card[data-id="${book.id}"] .cover img`);
    if (img) img.src = row.dataUrl;
  }
}

async function pickCoverImage(book) {
  const input = $('cover-input');
  input.value = '';
  state.coverTarget = book;
  input.click();
}

async function applyCoverFile(file) {
  const book = state.coverTarget;
  if (!book || !file) return;
  try {
    const dataUrl = await fitCover(file);
    await saveCover(book.id, dataUrl, 'custom');
    state.covers.set(book.id, { id: book.id, dataUrl, source: 'custom' });
    renderShelf();
    toast(`已更新《${book.title}》的封面`);
  } catch (err) {
    toast(`换封面失败：${err.message}`);
  }
}

async function regenerateCover(book) {
  const dataUrl = generateCover({ title: book.title, kind: book.kind });
  await saveCover(book.id, dataUrl, 'generated');
  state.covers.set(book.id, { id: book.id, dataUrl, source: 'generated' });
  renderShelf();
  toast('封面已重新生成');
}

/* ---------------- 批量管理 ---------------- */
function selecting() { return !!state.shelf.selecting; }

function togglePick(book) {
  if (state.shelf.picked.has(book.id)) state.shelf.picked.delete(book.id);
  else state.shelf.picked.add(book.id);
  renderShelf();
}

function exitSelectMode() {
  state.shelf.selecting = false;
  state.shelf.picked.clear();
  renderShelf();
}

async function bulkSetCategory() {
  const ids = [...state.shelf.picked];
  if (!ids.length) { toast('先选几本书'); return; }
  // eslint-disable-next-line no-alert
  const name = prompt(`把选中的 ${ids.length} 本书放到哪个分类？`, '');
  if (name == null) return;
  const category = name.trim() === UNCATEGORIZED ? '' : name.trim();
  for (const id of ids) {
    const book = state.books.find((b) => b.id === id);
    if (!book) continue;
    book.category = category;
    await updateBook(book);   // eslint-disable-line no-await-in-loop
  }
  state.shelf.picked.clear();     // 归完类就清掉勾选，免得下一步误操作
  await refreshShelf();
  toast(`${ids.length} 本书已归到「${category || UNCATEGORIZED}」`);
}

async function bulkDelete() {
  const ids = [...state.shelf.picked];
  if (!ids.length) { toast('先选几本书'); return; }
  // eslint-disable-next-line no-alert
  if (!confirm(`确定要删除选中的 ${ids.length} 本书吗？（连同它们的书签笔记）`)) return;
  for (const id of ids) await deleteBook(id);   // eslint-disable-line no-await-in-loop
  state.shelf.picked.clear();
  await refreshShelf();
  toast(`已删除 ${ids.length} 本`);
}

function renderBulkBar() {
  const bar = $('bulk-bar');
  bar.classList.toggle('hidden', !selecting());
  $('bulk-count').textContent = `已选 ${state.shelf.picked.size} 本`;
}

/* ---------------- 智能整理 ---------------- */
/** 去掉"第X部/上中下"之类的卷号，得到系列名 */
export function seriesKey(title) {
  const original = String(title || '').trim();
  let name = original;
  name = name.replace(/[\s_\-—]*[（(【\[]?\s*(?:第?\s*[0-9一二三四五六七八九十百]+\s*[部卷集册季]|上|中|下|终|完结|番外)\s*[)）】\]]?\s*$/g, '');
  // 去掉结尾的序号，但书名本身就是数字时不要动（比如《1984》）
  const stripped = name.replace(/[\s_\-—]+[0-9]{1,3}\s*$/, '');
  if (stripped.trim().length >= 2) name = stripped;
  return name.trim().length >= 2 ? name.trim() : original;
}

const TIDY_PLANS = [
  {
    id: 'format',
    label: '按格式分',
    desc: 'PDF / EPUB / TXT / MOBI …，一眼看出每本是什么文件',
    keyOf: (book) => ({
      pdf: 'PDF', epub: 'EPUB', txt: 'TXT', mobi: 'MOBI', docx: 'DOCX',
      html: 'HTML', md: 'Markdown', fb2: 'FB2', rtf: 'RTF', paste: '粘贴文本',
    }[book.kind] || 'TXT'),
  },
  {
    id: 'status',
    label: '按阅读状态分',
    desc: '在读 / 未读 / 读完，接着读哪本一目了然',
    keyOf: (book) => STATUS_LABELS[readStatus(book)],
  },
  {
    id: 'series',
    label: '按书名系列分',
    desc: '「斗破苍穹 第一部」「斗破苍穹 第二部」会归到同一个系列；落单的书放进「单本」',
    keyOf: (book) => seriesKey(book.title),
    postProcess: (groups) => {
      const out = new Map();
      for (const [key, books] of groups) {
        if (books.length >= 2) out.set(key, books);
        else out.set('单本', (out.get('单本') || []).concat(books));
      }
      return out;
    },
  },
];

function planGroups(plan) {
  const groups = new Map();
  for (const book of state.books) {
    const key = plan.keyOf(book) || UNCATEGORIZED;
    groups.set(key, (groups.get(key) || []).concat(book));
  }
  return plan.postProcess ? plan.postProcess(groups) : groups;
}

function renderTidyOptions() {
  const box = $('tidy-options');
  box.innerHTML = '';
  for (const plan of TIDY_PLANS) {
    const label = el('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'tidy-plan';
    input.value = plan.id;
    input.checked = plan.id === (state.shelf.tidyPlan || 'format');
    input.addEventListener('change', () => {
      state.shelf.tidyPlan = plan.id;
      renderTidyPreview();
    });
    const text = el('div');
    text.append(el('div', null, plan.label), el('div', 'desc', plan.desc));
    label.append(input, text);
    box.appendChild(label);
  }
  renderTidyPreview();
}

function renderTidyPreview() {
  const plan = TIDY_PLANS.find((p) => p.id === (state.shelf.tidyPlan || 'format')) || TIDY_PLANS[0];
  const groups = planGroups(plan);
  const sample = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 6)
    .map(([name, books]) => `${name}（${books.length}）`)
    .join('、');
  $('tidy-preview').textContent = `会分成 ${groups.size} 个分类：${sample}${groups.size > 6 ? ' …' : ''}`;
}

async function applyTidy() {
  const plan = TIDY_PLANS.find((p) => p.id === (state.shelf.tidyPlan || 'format')) || TIDY_PLANS[0];
  const groups = planGroups(plan);
  let changed = 0;
  for (const [name, books] of groups) {
    for (const book of books) {
      if (bookCategory(book) === name) continue;
      book.category = name === UNCATEGORIZED ? '' : name;
      await updateBook(book);   // eslint-disable-line no-await-in-loop
      changed += 1;
    }
  }
  hideModal('tidy-modal');
  state.settings.shelfCategory = '';
  saveSettings(state.settings);
  await refreshShelf();
  toast(`整理完成：${groups.size} 个分类，调整了 ${changed} 本`);
}

/* ---------------- 渲染 ---------------- */
function makeBookCard(book) {
  const grid = (state.settings.shelfView || 'grid') === 'grid';
  const card = el('div', `book-card${state.shelf.picked.has(book.id) ? ' picked' : ''}`);
  card.dataset.id = book.id;

  const coverBox = el('div', 'cover');
  const img = document.createElement('img');
  img.alt = `《${book.title}》封面`;
  img.loading = 'lazy';
  const known = state.covers.get(book.id);
  if (known) img.src = known.dataUrl;
  coverBox.appendChild(img);
  coverBox.appendChild(el('div', 'pick', state.shelf.picked.has(book.id) ? '✓' : ''));
  const ops = el('div', 'cover-ops');
  const changeBtn = el('button', null, '换图');
  changeBtn.addEventListener('click', (e) => { e.stopPropagation(); pickCoverImage(book); });
  const regenBtn = el('button', null, '重生成');
  regenBtn.addEventListener('click', (e) => { e.stopPropagation(); regenerateCover(book); });
  ops.append(changeBtn, regenBtn);
  coverBox.appendChild(ops);
  card.appendChild(coverBox);

  const main = el('div', 'book-main');
  card.appendChild(main);
  main.appendChild(el('h3', null, book.title));

  const percent = bookPercent(book);
  if (!grid) {
    const tags = el('div', 'tags');
    tags.appendChild(el('span', 'tag', bookCategory(book)));
    const kindLabel = { epub: 'EPUB', pdf: 'PDF', paste: '粘贴' }[book.kind];
    if (kindLabel) tags.appendChild(el('span', 'tag', kindLabel));
    const marks = (state.markCounts && state.markCounts.get(book.id)) || 0;
    if (marks) tags.appendChild(el('span', 'tag mark', `${marks} 条笔记/书签`));
    main.appendChild(tags);
  }

  const meta = el('div', 'book-meta');
  meta.innerHTML = grid
    ? `${fmtNum(book.chapterCount)} 章 · ${percent ? `已读 ${percent}%` : '未读'}`
    : `${fmtNum(book.chapterCount)} 章 · ${fmtNum(book.charCount)} 字 · 已读 ${percent}%<br>`
      + `${book.lastReadAt ? `上次阅读：${new Date(book.lastReadAt).toLocaleString('zh-CN')}` : '尚未阅读'}`;
  main.appendChild(meta);

  const bar = el('div', 'book-progress');
  const inner = el('i');
  inner.style.width = `${percent}%`;
  bar.appendChild(inner);
  main.appendChild(bar);

  if (!grid) {
    const actions = el('div', 'book-actions');
    const readBtn = el('button', 'primary-btn', book.lastReadAt ? '继续阅读' : '开始阅读');
    readBtn.addEventListener('click', (e) => { e.stopPropagation(); openBook(book.id); });
    const catBtn = el('button', 'ghost-btn', '分类');
    catBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // eslint-disable-next-line no-alert
      const next = prompt(`把《${book.title}》放到哪个分类？`, bookCategory(book));
      if (next == null) return;
      book.category = next.trim() === UNCATEGORIZED ? '' : next.trim();
      await updateBook(book);
      await refreshShelf();
      toast(`已移动到「${bookCategory(book)}」`);
    });
    const delBtn = el('button', 'ghost-btn danger', '删除');
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      // eslint-disable-next-line no-alert
      if (!confirm(`确定要从书架删除《${book.title}》吗？`)) return;
      await deleteBook(book.id);
      if (state.book && state.book.id === book.id) showShelf();
      else refreshShelf();
      toast('已删除');
    });
    actions.append(readBtn, catBtn, delBtn);
    main.appendChild(actions);
  }

  card.addEventListener('click', () => {
    if (selecting()) togglePick(book);
    else openBook(book.id);
  });
  return card;
}

function filteredBooks() {
  const query = ($('shelf-search').value || '').trim().toLowerCase();
  const category = state.settings.shelfCategory || '';
  const status = state.shelf.status || 'all';
  let books = state.books;
  if (status !== 'all') books = books.filter((b) => readStatus(b) === status);
  if (category) books = books.filter((b) => bookCategory(b) === category);
  if (query) {
    books = books.filter((b) => b.title.toLowerCase().includes(query)
      || bookCategory(b).toLowerCase().includes(query));
  }
  return sortBooks(books);
}

function renderSide() {
  const side = $('shelf-side');
  side.innerHTML = '';
  const status = state.shelf.status || 'all';
  const activeCat = state.settings.shelfCategory || '';

  const statusGroup = el('div', 'side-group');
  statusGroup.appendChild(el('div', 'side-title', '阅读状态'));
  const counts = { all: state.books.length, reading: 0, unread: 0, done: 0 };
  for (const book of state.books) counts[readStatus(book)] += 1;
  for (const key of ['all', 'reading', 'unread', 'done']) {
    const item = el('div', `side-item${status === key ? ' active' : ''}`);
    item.dataset.status = key;
    item.append(el('span', 'name', STATUS_LABELS[key]), el('span', 'n', String(counts[key])));
    item.addEventListener('click', () => {
      state.shelf.status = key;
      state.shelf.page = 1;
      renderShelf();
    });
    statusGroup.appendChild(item);
  }
  side.appendChild(statusGroup);

  const cats = allCategories();
  const catGroup = el('div', 'side-group');
  catGroup.appendChild(el('div', 'side-title', `分类（${cats.length}）`));
  const all = el('div', `side-item${activeCat ? '' : ' active'}`);
  all.append(el('span', 'name', '全部分类'), el('span', 'n', String(state.books.length)));
  all.addEventListener('click', () => {
    state.settings.shelfCategory = '';
    saveSettings(state.settings);
    state.shelf.page = 1;
    renderShelf();
  });
  catGroup.appendChild(all);
  for (const [name, count] of cats) {
    const item = el('div', `side-item${activeCat === name ? ' active' : ''}`);
    item.dataset.category = name;
    item.append(el('span', 'name', name), el('span', 'n', String(count)));
    item.addEventListener('click', () => {
      state.settings.shelfCategory = activeCat === name ? '' : name;
      saveSettings(state.settings);
      state.shelf.page = 1;
      renderShelf();
    });
    catGroup.appendChild(item);
  }
  side.appendChild(catGroup);
}

function renderPager(total, pageSize) {
  const pager = $('pager');
  const pages = Math.ceil(total / pageSize);
  pager.innerHTML = '';
  pager.classList.toggle('hidden', pages <= 1);
  if (pages <= 1) return;
  const page = state.shelf.page;
  const prev = el('button', 'ghost-btn', '上一页');
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => { state.shelf.page -= 1; renderShelf(); window.scrollTo({ top: 0 }); });
  const next = el('button', 'ghost-btn', '下一页');
  next.disabled = page >= pages;
  next.addEventListener('click', () => { state.shelf.page += 1; renderShelf(); window.scrollTo({ top: 0 }); });
  pager.append(prev, el('span', 'info', `第 ${page} / ${pages} 页`), next);
}

function renderShelf() {
  const view = state.settings.shelfView || 'grid';
  const grid = $('book-grid');
  grid.className = `book-grid ${view === 'grid' ? 'grid-view' : 'list-view'}`;
  $('view-toggle').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.body.classList.toggle('shelf-selecting', selecting());
  $('btn-select-mode').textContent = selecting() ? '退出批量' : '批量管理';

  renderSide();
  $('category-bar').innerHTML = '';    // 分类改到侧栏，这里留空

  const books = filteredBooks();
  const pageSize = PAGE_SIZE[view] || 60;
  const pages = Math.max(1, Math.ceil(books.length / pageSize));
  if (state.shelf.page > pages) state.shelf.page = pages;
  const start = (state.shelf.page - 1) * pageSize;
  const pageBooks = books.slice(start, start + pageSize);

  const scope = state.settings.shelfCategory || STATUS_LABELS[state.shelf.status || 'all'];
  $('shelf-count').textContent = state.books.length
    ? `共 ${state.books.length} 本${books.length !== state.books.length ? `，${scope} ${books.length} 本` : ''}`
    : '';
  $('shelf-empty').classList.toggle('hidden', state.books.length > 0);

  grid.innerHTML = '';
  for (const book of pageBooks) grid.appendChild(makeBookCard(book));
  if (!pageBooks.length && state.books.length) {
    const tip = el('p', 'empty-tip', '这里没有符合条件的书');
    tip.style.gridColumn = '1 / -1';
    grid.appendChild(tip);
  }
  renderPager(books.length, pageSize);
  renderBulkBar();
  loadCoversFor(pageBooks);
}

function showShelf() {
  stopAutoScroll();
  stopTts();
  releaseMediaUrls();
  state.mediaIndex = new Map();
  state.book = null;
  state.marks = [];
  $('view-shelf').classList.remove('hidden');
  $('view-reader').classList.add('hidden');
  $('btn-retypeset').hidden = true;
  $('btn-export').hidden = true;
  $('btn-marks').hidden = true;
  $('btn-tts').hidden = true;
  $('top-book').textContent = '清风阅读';
  $('top-chapter').textContent = '本地小说阅读器 · PDF / EPUB / TXT / MOBI …';
  $('progressbar').style.width = '0';
  hideResumeHint();
  closePanels();
  refreshShelf();
}

/* =========================================================
 * 导入流程
 * =======================================================*/
function collectCleanOptions() {
  return {
    removeUrls: $('opt-removeUrls').checked,
    removeAds: $('opt-removeAds').checked,
    removeSeparators: $('opt-removeSeparators').checked,
    fixMojibake: $('opt-fixMojibake').checked,
    dropGarbledLines: $('opt-dropGarbledLines').checked,
    mergeWrappedLines: $('opt-mergeWrappedLines').checked,
    normalizeSpaces: $('opt-normalizeSpaces').checked,
    fullWidthPunct: $('opt-fullWidthPunct').checked,
    indentParagraphs: $('opt-indentParagraphs').checked,
    blankLinesBetweenParagraphs: Number($('opt-blankLines').value) || 0,
    extraAdKeywords: $('opt-adKeywords').value.split(/[,，\s]+/).filter(Boolean),
  };
}

function collectSplitOptions() {
  return {
    ruleIds: [...$('rule-list').querySelectorAll('input:checked')].map((i) => i.value),
    customPattern: $('opt-custom').value,
    maxTitleLength: Number($('opt-maxTitle').value) || DEFAULT_SPLIT_OPTIONS.maxTitleLength,
    fallbackLines: Number($('opt-fallbackLines').value) || DEFAULT_SPLIT_OPTIONS.fallbackLines,
    autoFallback: $('opt-autoFallback').checked,
    repairMissing: $('opt-repairMissing').checked,
  };
}

function fillOptionsUI(cleanOpts, splitOpts) {
  const c = { ...CLEAN_DEFAULTS, ...cleanOpts };
  $('opt-removeUrls').checked = c.removeUrls;
  $('opt-removeAds').checked = c.removeAds;
  $('opt-removeSeparators').checked = c.removeSeparators;
  $('opt-fixMojibake').checked = c.fixMojibake;
  $('opt-dropGarbledLines').checked = c.dropGarbledLines;
  $('opt-mergeWrappedLines').checked = c.mergeWrappedLines;
  $('opt-normalizeSpaces').checked = c.normalizeSpaces;
  $('opt-fullWidthPunct').checked = c.fullWidthPunct;
  $('opt-indentParagraphs').checked = c.indentParagraphs;
  $('opt-blankLines').value = c.blankLinesBetweenParagraphs;
  $('opt-adKeywords').value = (c.extraAdKeywords || []).join(',');

  const s = { ...DEFAULT_SPLIT_OPTIONS, ...splitOpts };
  $('opt-custom').value = s.customPattern || '';
  $('opt-maxTitle').value = s.maxTitleLength;
  $('opt-fallbackLines').value = s.fallbackLines;
  $('opt-autoFallback').checked = s.autoFallback;
  $('opt-repairMissing').checked = s.repairMissing !== false;
  buildRuleList(s.ruleIds);
}

function buildRuleList(activeIds) {
  const box = $('rule-list');
  box.innerHTML = '';
  for (const rule of CHAPTER_RULES) {
    const label = el('label', 'check');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = rule.id;
    input.checked = activeIds.includes(rule.id);
    input.addEventListener('change', schedulePreview);
    label.append(input, el('span', null, rule.name), el('span', 'count', ''));
    label.dataset.ruleId = rule.id;
    box.appendChild(label);
  }
}

function updateRuleCounts(text) {
  const stats = analyzeRules(text, Number($('opt-maxTitle').value) || 40);
  for (const s of stats) {
    const label = $('rule-list').querySelector(`[data-rule-id="${s.id}"] .count`);
    if (label) label.textContent = s.count ? `命中 ${s.count}` : '未命中';
  }
  $('rule-stats').textContent = '「命中」为该规则在全文中匹配到的标题行数，可勾选多条规则组合使用。';
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  $('import-status').textContent = '正在分析…';
  previewTimer = setTimeout(runPreview, 180);
}

function runPreview() {
  const pending = state.pending;
  if (!pending) return;
  const cleanOpts = collectCleanOptions();
  const splitOpts = collectSplitOptions();
  const useNative = pending.native && $('opt-source').value === 'native';

  let text;
  let stats;
  let chapters;
  let usedFallback = false;
  let repair = { inserted: 0, filled: [], stillMissing: [] };

  if (useNative) {
    // 电子书自带目录：逐章清洗，章节结构保持不变
    const cleanedChapters = pending.native.map((c) => {
      const res = cleanText(c.content, cleanOpts, splitOpts);
      return { title: cleanBookTitle(c.title) === c.title ? c.title : c.title, content: res.text, stats: res.stats };
    });
    chapters = cleanedChapters.map((c) => ({
      title: c.title,
      level: 2,
      content: c.content,
      charCount: c.content.replace(/\s/g, '').length,
    }));
    stats = cleanedChapters.reduce((acc, c) => {
      Object.keys(acc).forEach((k) => { acc[k] += c.stats[k] || 0; });
      return acc;
    }, {
      originalChars: 0, originalLines: 0, urlsRemoved: 0, adLines: 0, garbledLines: 0,
      mojibakeFixed: 0, mergedLines: 0, blankLinesRemoved: 0, finalChars: 0, finalLines: 0,
    });
    text = chapters.map((c) => `${c.title}\n${c.content}`).join('\n\n');
  } else {
    const cleaned = cleanText(pending.raw, cleanOpts, splitOpts);
    text = cleaned.text;
    stats = cleaned.stats;
    const split = splitChapters(text, splitOpts);
    chapters = split.chapters;
    usedFallback = split.usedFallback;
    repair = split.repair || repair;
  }

  pending.clean = text;
  pending.chapters = chapters;
  pending.cleanOptions = cleanOpts;
  pending.splitOptions = splitOpts;
  pending.useNative = useNative;

  $('preview-stats').textContent =
    `原文 ${fmtNum(stats.originalChars)} 字 → 清洗后 ${fmtNum(stats.finalChars)} 字；`
    + `删网址 ${stats.urlsRemoved} 处、广告/分隔行 ${stats.adLines} 行、乱码行 ${stats.garbledLines} 行、`
    + `修复乱码 ${stats.mojibakeFixed} 行、合并断行 ${stats.mergedLines} 处、压缩空行 ${stats.blankLinesRemoved} 行`;

  const list = $('preview-toc');
  list.innerHTML = '';
  chapters.slice(0, 12).forEach((c) => {
    const li = el('li', c.level === 1 ? 'volume' : null, `${c.title}（${fmtNum(c.charCount)} 字）`);
    list.appendChild(li);
  });
  if (chapters.length > 12) list.appendChild(el('li', 'muted', `… 共 ${fmtNum(chapters.length)} 章`));

  $('preview-text').textContent = describeMediaTokens(text.slice(0, 900)) || '（清洗后内容为空，请检查清洗选项）';
  const mediaCount = (pending.media || []).length;
  if (mediaCount) {
    const videos = pending.media.filter((m) => /^video\//.test(m.mime)).length;
    const audios = pending.media.filter((m) => /^audio\//.test(m.mime)).length;
    const images = mediaCount - videos - audios;
    const parts = [images && `${images} 张图片`, videos && `${videos} 段视频`, audios && `${audios} 段音频`].filter(Boolean);
    $('preview-stats').textContent += `；另含 ${parts.join('、')}，会原位显示`;
  }
  $('import-status').textContent = usedFallback
    ? `未匹配到章节标题，已按每 ${splitOpts.fallbackLines} 行自动分为 ${chapters.length} 章`
    : `识别到 ${fmtNum(chapters.length)} 章${useNative ? '（来自电子书自带目录）' : ''}`;

  const repairBox = $('repair-stats');
  if (useNative) {
    repairBox.textContent = '使用电子书自带目录时不需要补章。';
  } else if (repair.inserted > 0) {
    const sample = repair.filled.slice(0, 12).join('、');
    repairBox.textContent = `已补回 ${repair.inserted} 章（换了写法没被规则识别的）：第 ${sample}${repair.filled.length > 12 ? ' 等' : ''} 章`
      + (repair.stillMissing.length ? `；仍缺 ${repair.stillMissing.length} 章（正文里确实找不到）：第 ${repair.stillMissing.slice(0, 8).join('、')} 章` : '');
  } else if (repair.stillMissing.length) {
    repairBox.textContent = `章节号不连续，缺 ${repair.stillMissing.length} 章：第 ${repair.stillMissing.slice(0, 12).join('、')} 章；`
      + '正文里没找到对应标题，可能是原文就少了这些章。';
  } else {
    repairBox.textContent = splitOpts.repairMissing ? '章节号连续，没有发现漏掉的章。' : '';
  }

  updateRuleCounts(text);
}

function openImportModal(raw, name, encodingInfo, existing, native) {
  state.pending = {
    raw,
    name,
    category: encodingInfo.category || '',
    encoding: encodingInfo.encoding,
    buffer: encodingInfo.buffer || null,
    bookId: existing ? existing.id : null,
    native: native && native.length ? native : null,
    kind: encodingInfo.kind || 'txt',
    file: encodingInfo.file || null,
    cover: encodingInfo.cover || null,
    media: encodingInfo.media || [],
  };
  // PDF 文字提取不理想时，可以直接转去 OCR
  $('btn-ocr-again').classList.toggle('hidden', !(encodingInfo.file && extOf(encodingInfo.file.name) === 'pdf'));
  $('source-field').hidden = !state.pending.native;
  // 有的 EPUB 整本只有一个 xhtml，自带"目录"只有一条，这时默认按规则重新分章
  const nativeUsable = !!(state.pending.native && state.pending.native.length > 1);
  $('opt-source').value = state.pending.native
    ? ((existing && existing.chapterSource) || (nativeUsable ? 'native' : 'rules'))
    : 'rules';
  $('import-title').textContent = existing ? '重新排版 / 重新分章' : '导入并排版';
  $('import-confirm').textContent = existing ? '保存并重新阅读' : '导入并开始阅读';
  $('import-name').value = name;
  $('import-category').value = existing ? (existing.category || '') : (state.pending.category || '');

  const encSelect = $('import-encoding');
  encSelect.innerHTML = '';
  for (const enc of SUPPORTED_ENCODINGS) {
    const opt = document.createElement('option');
    opt.value = enc.id;
    opt.textContent = enc.label;
    encSelect.appendChild(opt);
  }
  encSelect.value = 'auto';
  encSelect.disabled = !encodingInfo.buffer || state.pending.kind !== 'txt';
  const kindLabel = {
    txt: 'TXT', epub: 'EPUB', pdf: 'PDF', paste: '粘贴文本',
    docx: 'DOCX', html: 'HTML', md: 'Markdown', fb2: 'FB2', rtf: 'RTF', mobi: 'MOBI/AZW3',
  }[state.pending.kind] || '文本';
  const viaNote = encodingInfo.via ? `（解析器：${encodingInfo.via}）` : '';
  $('import-encoding-hint').textContent = state.pending.kind === 'txt'
    ? (encodingInfo.buffer
      ? `自动识别结果：${encodingInfo.encoding}${encodingInfo.confident ? '' : '（把握不大，若显示乱码请手动切换）'}`
      : '粘贴导入的文本无需选择编码')
    : `${kindLabel} 文件已解析为文本${viaNote}，无需选择编码`;

  const suggested = existing && existing.splitOptions && existing.splitOptions.ruleIds.length
    ? existing.splitOptions.ruleIds
    : (suggestRuleIds(raw) .length ? suggestRuleIds(raw) : DEFAULT_SPLIT_OPTIONS.ruleIds);
  fillOptionsUI(
    existing ? existing.cleanOptions : CLEAN_DEFAULTS,
    { ...DEFAULT_SPLIT_OPTIONS, ...(existing ? existing.splitOptions : {}), ruleIds: suggested },
  );
  showModal('import-modal');
  runPreview();
}

function bindImportInputs() {
  const ids = ['opt-removeUrls', 'opt-removeAds', 'opt-removeSeparators', 'opt-fixMojibake',
    'opt-dropGarbledLines', 'opt-mergeWrappedLines', 'opt-normalizeSpaces', 'opt-fullWidthPunct',
    'opt-indentParagraphs', 'opt-autoFallback'];
  ids.forEach((id) => $(id).addEventListener('change', schedulePreview));
  ['opt-blankLines', 'opt-adKeywords', 'opt-custom', 'opt-maxTitle', 'opt-fallbackLines']
    .forEach((id) => $(id).addEventListener('input', schedulePreview));

  $('opt-source').addEventListener('change', schedulePreview);
  $('opt-repairMissing').addEventListener('change', schedulePreview);
  $('import-encoding').addEventListener('change', () => {
    const pending = state.pending;
    if (!pending || !pending.buffer) return;
    const decoded = decodeBuffer(pending.buffer, $('import-encoding').value);
    pending.raw = decoded.text;
    pending.encoding = decoded.encoding;
    $('import-encoding-hint').textContent = `当前使用编码：${decoded.encoding}`;
    runPreview();
  });

  $('btn-auto-detect').addEventListener('click', () => {
    const pending = state.pending;
    if (!pending) return;
    const ids2 = suggestRuleIds(pending.raw, Number($('opt-maxTitle').value) || 40);
    if (!ids2.length) {
      toast('未识别到常见章节标题，可试试自定义正则或按行数分章');
      return;
    }
    buildRuleList(ids2);
    runPreview();
    toast(`已选用：${ids2.join(' + ')}`);
  });

  $('import-cancel').addEventListener('click', () => hideModal('import-modal'));
  $('import-close').addEventListener('click', () => hideModal('import-modal'));
  $('import-confirm').addEventListener('click', confirmImport);
}

async function confirmImport() {
  const pending = state.pending;
  if (!pending) return;
  if (!pending.chapters || !pending.chapters.length) runPreview();
  const title = ($('import-name').value || '未命名小说').trim();
  const chapters = pending.chapters;
  const id = pending.bookId || newId();
  const existing = state.books.find((b) => b.id === id);

  const meta = {
    id,
    title,
    encoding: pending.encoding,
    createdAt: existing ? existing.createdAt : Date.now(),
    lastReadAt: Date.now(),
    charCount: pending.clean.replace(/\s/g, '').length,
    chapterCount: chapters.length,
    chapters: chapters.map((c) => ({ title: c.title, level: c.level, charCount: c.charCount })),
    cleanOptions: pending.cleanOptions,
    splitOptions: pending.splitOptions,
    chapterSource: pending.useNative ? 'native' : 'rules',
    kind: pending.kind || 'txt',
    category: ($('import-category').value || '').trim(),
    progress: existing && existing.progress
      ? { chapterIndex: Math.min(existing.progress.chapterIndex, chapters.length - 1), ratio: 0 }
      : { chapterIndex: 0, ratio: 0 },
  };

  try {
    await saveBook(meta, {
      raw: pending.raw,
      clean: pending.clean,
      chapterTexts: chapters.map((c) => c.content),
      nativeChapters: pending.native || null,
    });
  } catch (err) {
    toast(`保存失败：${err && err.message ? err.message : err}`);
    return;
  }
  // 封面：优先用书里自带的，没有就按书名生成
  try {
    const dataUrl = pending.cover ? await fitCover(pending.cover) : generateCover({ title, kind: meta.kind });
    await saveCover(id, dataUrl, pending.cover ? 'embedded' : 'generated');
  } catch { /* 封面失败不影响导入 */ }
  // 书里的图片 / 视频
  if (pending.media && pending.media.length) {
    try { await saveMedia(id, pending.media); } catch (err) { toast(`图片保存失败：${err.message}`); }
  }

  hideModal('import-modal');
  state.pending = null;
  await refreshShelf();
  await openBook(id);
  toast(`《${title}》已导入，共 ${chapters.length} 章`);
}

const FORMAT_ICONS = { pdf: '📕', epub: '📗', txt: '📄', other: '🗂️' };

function activeGroup() {
  return FORMAT_GROUPS.find((g) => g.id === (state.importFormat || 'pdf')) || FORMAT_GROUPS[0];
}

/** 渲染导入分栏，并让文件选择框只认当前这一栏的类型 */
function renderFormatTabs() {
  const bar = $('format-tabs');
  bar.innerHTML = '';
  for (const group of FORMAT_GROUPS) {
    const btn = el('button', group.id === state.importFormat ? 'active' : null, group.label);
    btn.dataset.fmt = group.id;
    btn.addEventListener('click', () => {
      state.importFormat = group.id;
      try { localStorage.setItem('novel-reader:importFormat', group.id); } catch { /* 忽略 */ }
      renderFormatTabs();
    });
    bar.appendChild(btn);
  }
  const group = activeGroup();
  $('file-input').setAttribute('accept', group.accept);
  $('btn-choose').textContent = `选择 ${group.label} 文件`;
  $('btn-choose-folder').textContent = `导入文件夹里的 ${group.label}`;
  $('dz-icon').textContent = FORMAT_ICONS[group.id] || '📖';
  $('dz-hint').textContent = `${group.hint} · 也可以把文件或整个文件夹拖到这里`;
}

/** 从文件的相对路径推断分类：用它所在的那层文件夹名 */
function categoryFromPath(file) {
  const path = file.webkitRelativePath || file.__relPath || '';
  const parts = path.split('/').filter(Boolean);
  parts.pop();                       // 去掉文件名
  if (!parts.length) return '';
  return parts[parts.length - 1];    // 直接所在的文件夹
}

/** PDF 需要密码时问一下用户 */
function askPdfPassword() {
  // eslint-disable-next-line no-alert
  return prompt('这个 PDF 有密码保护，请输入打开密码：');
}

async function readBookFile(file) {
  const info = await readAnyFile(file, { onPassword: askPdfPassword });
  return { ...info, buffer: info.buffer || null };
}

/** 自带目录 → 章节数组（逐章清洗） */
function nativeToChapters(native, cleanOpts, splitOpts) {
  return native.map((c) => {
    const content = cleanText(c.content, cleanOpts, splitOpts).text;
    return { title: c.title, level: 2, content, charCount: content.replace(/\s/g, '').length };
  }).filter((c) => c.charCount > 0);
}

async function handleFiles(files, opts = {}) {
  const group = activeGroup();
  const all = [...files];
  const list = all.filter((f) => group.exts.includes(extOf(f.name)));
  const skipped = all.length - list.length;
  if (!list.length) {
    // 拖进来的文件都属于另一栏时，自动切过去（用"选择文件"按钮则始终只认当前栏）
    const others = [...new Set(all.map((f) => groupOf(f.name)).filter(Boolean).map((g) => g.id))];
    if (others.length === 1) {
      state.importFormat = others[0];
      renderFormatTabs();
      const target = activeGroup();
      toast(`已切到「${target.label}」栏`);
      await handleFiles(all, opts);
      return;
    }
    toast(others.length
      ? `这些文件分属「${others.join('、')}」几类，请分别切到对应的栏导入`
      : `当前在「${group.label}」栏，只接受 ${group.exts.map((e) => `.${e}`).join(' / ')}`);
    return;
  }
  if (skipped > 0) toast(`「${group.label}」栏只导入了 ${list.length} 个文件，忽略了 ${skipped} 个其它类型`);
  if (list.length === 1 && !opts.batch) {
    try {
      const info = await readBookFile(list[0]);
      if (!info.raw || !info.raw.replace(/\s/g, '')) {
        const ocrAction = extOf(list[0].name) === 'pdf'
          ? { label: '用 OCR 识别文字', run: () => openOcrModal(list[0]) }
          : null;
        showError(list[0].name, '这个文件里没有解析出可读的文字。', importTips(list[0].name), ocrAction);
        return;
      }
      info.category = categoryFromPath(list[0]);
      info.file = list[0];
      openImportModal(info.raw, info.name, info, null, info.native);
    } catch (err) {
      const file = list[0];
      const ocrAction = extOf(file.name) === 'pdf'
        ? { label: '用 OCR 识别文字', run: () => openOcrModal(file) }
        : null;
      showError(file.name, `读取失败：${err.message}`, importTips(file.name), ocrAction);
    }
    return;
  }
  await batchImport(list);
}

/** 一键把一批文件（整个文件夹）按推荐设置导入书架 */
async function batchImport(files) {
  state.batchAbort = false;
  showModal('batch-modal');
  $('batch-title').textContent = `批量导入 ${files.length} 个文件`;
  $('batch-done').classList.add('hidden');
  $('batch-cancel').classList.remove('hidden');
  const listEl = $('batch-list');
  listEl.innerHTML = '';
  const existing = await listBooks();
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i += 1) {
    if (state.batchAbort) break;
    const file = files[i];
    $('batch-status').textContent = `(${i + 1}/${files.length}) 正在处理：${file.name}`;
    $('batch-bar').style.width = `${((i / files.length) * 100).toFixed(1)}%`;
    try {
      /* eslint-disable no-await-in-loop */
      const info = await readBookFile(file);
      if (!info.raw || !info.raw.replace(/\s/g, '')) throw new Error('没有可读的文字');

      const ruleIds = suggestRuleIds(info.raw);
      const splitOpts = {
        ...DEFAULT_SPLIT_OPTIONS,
        ruleIds: ruleIds.length ? ruleIds : DEFAULT_SPLIT_OPTIONS.ruleIds,
      };
      const cleaned = cleanText(info.raw, CLEAN_DEFAULTS, splitOpts);
      const useNative = !!(info.native && info.native.length > 1);
      const split = useNative ? null : splitChapters(cleaned.text, splitOpts);
      const chapters = useNative ? nativeToChapters(info.native, CLEAN_DEFAULTS, splitOpts) : split.chapters;
      const charCount = cleaned.text.replace(/\s/g, '').length;

      const dup = existing.find((b) => b.title === info.name && Math.abs((b.charCount || 0) - charCount) < 50);
      if (dup) {
        skipped += 1;
        listEl.appendChild(el('li', 'ok', `《${info.name}》已在书架，跳过`));
        continue;
      }

      const meta = {
        id: newId(),
        title: info.name,
        encoding: info.encoding,
        kind: info.kind,
        category: categoryFromPath(file),
        createdAt: Date.now(),
        lastReadAt: 0,
        charCount,
        chapterCount: chapters.length,
        chapters: chapters.map((c) => ({ title: c.title, level: c.level, charCount: c.charCount })),
        cleanOptions: { ...CLEAN_DEFAULTS },
        splitOptions: splitOpts,
        chapterSource: useNative ? 'native' : 'rules',
        progress: { chapterIndex: 0, ratio: 0 },
      };
      await saveBook(meta, {
        raw: info.raw,
        clean: useNative ? chapters.map((c) => `${c.title}\n${c.content}`).join('\n\n') : cleaned.text,
        chapterTexts: chapters.map((c) => c.content),
        nativeChapters: info.native || null,
      });
      try {
        const dataUrl = info.cover ? await fitCover(info.cover) : generateCover({ title: info.name, kind: info.kind });
        await saveCover(meta.id, dataUrl, info.cover ? 'embedded' : 'generated');
      } catch { /* 封面失败不影响入库 */ }
      if (info.media && info.media.length) {
        try { await saveMedia(meta.id, info.media); } catch { /* 媒体失败不影响入库 */ }
      }
      existing.push(meta);
      ok += 1;
      const repaired = split && split.repair && split.repair.inserted ? `，补回 ${split.repair.inserted} 章` : '';
      const cat = meta.category ? `［${meta.category}］` : '';
      listEl.appendChild(el('li', 'ok', `${cat}《${info.name}》${chapters.length} 章${repaired}`));
    } catch (err) {
      failed += 1;
      listEl.appendChild(el('li', 'fail', `${file.name}：${err.message}`));
    }
    listEl.scrollTop = listEl.scrollHeight;
    await new Promise((r) => setTimeout(r, 0));   // 让界面有机会刷新
    /* eslint-enable no-await-in-loop */
  }

  $('batch-bar').style.width = '100%';
  $('batch-status').textContent = `完成：成功 ${ok} 本，跳过 ${skipped} 本，失败 ${failed} 本`;
  $('batch-cancel').classList.add('hidden');
  $('batch-done').classList.remove('hidden');
  await refreshShelf();
}

/** 从拖拽事件里取出文件（支持整个文件夹） */
async function filesFromDataTransfer(dt) {
  const out = [];
  const walk = async (entry) => {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      // fullPath 形如 /玄幻/某书.txt，用来推断分类
      try { file.__relPath = (entry.fullPath || '').replace(/^\//, ''); } catch { /* 只读时忽略 */ }
      out.push(file);
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch = [];
      do {
        // eslint-disable-next-line no-await-in-loop
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        // eslint-disable-next-line no-await-in-loop
        for (const child of batch) await walk(child);
      } while (batch.length);
    }
  };
  const entries = [...(dt.items || [])]
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length) {
    for (const entry of entries) await walk(entry);   // eslint-disable-line no-await-in-loop
    if (out.length) return out;
  }
  return [...dt.files];
}

/* =========================================================
 * 阅读（支持「一章一页」与「上下无缝滚动」两种模式）
 * =======================================================*/
async function openBook(id) {
  const meta = state.books.find((b) => b.id === id) || (await listBooks()).find((b) => b.id === id);
  if (!meta) { toast('书籍不存在'); return; }
  const content = await getContent(id);
  if (!content) { toast('正文数据丢失，请重新导入'); return; }

  releaseMediaUrls();
  state.mediaIndex = new Map();
  try {
    for (const row of await listMedia(id)) state.mediaIndex.set(row.key, row);
  } catch { /* 读不到媒体就当纯文字书 */ }

  state.book = meta;
  state.chapterTexts = content.chapterTexts && content.chapterTexts.length
    ? content.chapterTexts
    : [content.clean || ''];
  state.cleanTextValue = content.clean || '';
  state.rawTextValue = content.raw || '';
  state.nativeChapters = content.nativeChapters || null;
  state.chapterIndex = meta.progress ? Math.min(meta.progress.chapterIndex, state.chapterTexts.length - 1) : 0;

  $('view-shelf').classList.add('hidden');
  $('view-reader').classList.remove('hidden');
  $('btn-retypeset').hidden = false;
  $('btn-export').hidden = false;
  $('btn-marks').hidden = false;
  $('btn-tts').hidden = false;
  $('top-book').textContent = meta.title;
  await loadMarks();
  renderMarks();
  renderToc();
  const resumeRatio = meta.progress ? meta.progress.ratio : 0;
  renderReader(state.chapterIndex, resumeRatio);
  if (meta.lastReadAt && (state.chapterIndex > 0 || resumeRatio > 0.02)) {
    showResumeHint(state.chapterIndex, resumeRatio);
  } else {
    hideResumeHint();
  }
}

function chapterTitleAt(i) {
  const c = state.book && state.book.chapters[i];
  return c ? c.title : '';
}

function isScrollMode() {
  return state.settings.readingMode !== 'paged';
}

/** 把一章正文转成段落 HTML */
/* ---------------- 书内图片 / 视频 ---------------- */
function mediaUrl(key) {
  if (state.mediaUrls.has(key)) return state.mediaUrls.get(key);
  const row = state.mediaIndex.get(key);
  if (!row || !row.blob) return '';
  const url = URL.createObjectURL(row.blob);
  state.mediaUrls.set(key, url);
  return url;
}

function releaseMediaUrls() {
  for (const url of state.mediaUrls.values()) URL.revokeObjectURL(url);
  state.mediaUrls.clear();
}

/** 把一行 [[media:KEY]] 渲染成图片 / 视频 / 音频 */
function mediaHtml(line) {
  const key = mediaKeyOf(line);
  const row = key ? state.mediaIndex.get(key) : null;
  if (!row) {
    return '<figure class="book-media missing"><div class="media-missing">［这里原本有一张图片或视频，'
      + '但导入时没有保存下来。重新导入这本书即可看到］</div></figure>';
  }
  const url = mediaUrl(key);
  const alt = escapeHtml(row.alt || '');
  const kind = mediaKind(row.mime);
  let body;
  if (kind === 'video') body = `<video controls preload="metadata" src="${url}" data-media="${key}"></video>`;
  else if (kind === 'audio') body = `<audio controls preload="metadata" src="${url}" data-media="${key}"></audio>`;
  else body = `<img src="${url}" alt="${alt}" loading="lazy" data-media="${key}" title="点击查看大图">`;
  const caption = row.alt ? `<figcaption>${alt}</figcaption>` : '';
  return `<figure class="book-media ${kind}">${body}${caption}</figure>`;
}

function openLightbox(src, alt) {
  const box = $('lightbox');
  $('lightbox-img').src = src;
  $('lightbox-img').alt = alt || '';
  $('lightbox-caption').textContent = alt || '';
  box.classList.remove('hidden');
}

function ttsActiveFor(index) {
  return !!(state.tts && state.tts.chapterIndex === index);
}

function chapterInnerHtml(index) {
  const text = state.chapterTexts[index] || '';
  // 朗读当前章时，按句子拆成 span，方便读到哪句高亮哪句
  if (ttsActiveFor(index)) {
    let counter = 0;
    const html = text.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '<p class="blank"></p>';
      if (isMediaLine(trimmed)) return mediaHtml(trimmed);
      const indent = (line.match(/^[\s　]*/) || [''])[0];
      const inner = splitSentences(trimmed)
        .map((sentence) => {
          const span = `<span class="tts-s" data-s="${counter}">${escapeHtml(sentence)}</span>`;
          counter += 1;
          return span;
        })
        .join('');
      return `<p>${escapeHtml(indent)}${inner}</p>`;
    }).join('');
    return html || '<p class="muted">（本章没有正文）</p>';
  }
  const noteSegments = state.highlight ? [] : noteSegmentsFor(index);
  const html = text.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return '<p class="blank"></p>';
    if (isMediaLine(t)) return mediaHtml(t);
    let safe = escapeHtml(line);
    if (state.highlight) {
      const re = new RegExp(escapeRegExp(state.highlight), 'gi');
      safe = safe.replace(re, (m) => `<mark>${m}</mark>`);
    } else {
      for (const seg of noteSegments) {
        const escaped = escapeHtml(seg);
        if (safe.includes(escaped)) safe = safe.split(escaped).join(`<span class="note-hl">${escaped}</span>`);
      }
    }
    return `<p>${safe}</p>`;
  }).join('');
  return html || '<p class="muted">（本章没有正文）</p>';
}

function makeFlowSection(index) {
  const section = el('section', 'flow-chapter');
  section.dataset.index = String(index);
  const h = el('h2', null, chapterTitleAt(index));
  const body = el('div', 'flow-body');
  body.innerHTML = chapterInnerHtml(index);
  section.append(h, body);
  return section;
}

function renderReader(index, restoreRatio = 0) {
  if (!state.book) return;
  const total = state.chapterTexts.length;
  const i = Math.max(0, Math.min(total - 1, index));
  state.chapterIndex = i;
  if (isScrollMode()) renderFlow(i, restoreRatio);
  else renderPaged(i, restoreRatio);
  updateChapterChrome();
  updateProgressBar();
  saveProgress();
}

/** 同步"跳转到第几章"输入框：用户正在输入时不要覆盖他填的值 */
function syncJumpInput(node, value) {
  if (!node) return;
  if (document.activeElement === node) return;
  if (node.dataset.dirty === '1') return;
  node.value = value;
}

function clearJumpDirty() {
  $('jump-input').dataset.dirty = '';
  $('toc-jump').dataset.dirty = '';
}

let resumeTimer = null;
/** 打开书时提示"已回到上次读到的位置"，并在正文里画一条分隔线 */
function showResumeHint(chapterIndex, ratio) {
  const banner = $('resume-banner');
  const percent = Math.round((ratio || 0) * 100);
  $('resume-text').textContent = `已回到上次读到的位置 · 第 ${chapterIndex + 1} 章 ${chapterTitleAt(chapterIndex)}`
    + (percent > 1 ? `（本章 ${percent}%）` : '');
  banner.classList.remove('hidden');
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => banner.classList.add('hidden'), 8000);

  // 在恢复到的位置插一条"上次读到这里"
  requestAnimationFrame(() => {
    document.querySelectorAll('.resume-mark').forEach((n) => n.remove());
    if (!ratio || ratio <= 0.02) return;
    const paragraphs = [...document.querySelectorAll('#view-reader p')]
      .filter((p) => p.textContent.trim());
    const target = paragraphs.find((p) => p.getBoundingClientRect().bottom > 160);
    if (!target || !target.parentNode) return;
    const mark = el('div', 'resume-mark', '上次读到这里');
    target.parentNode.insertBefore(mark, target);
  });
}

function hideResumeHint() {
  $('resume-banner').classList.add('hidden');
  clearTimeout(resumeTimer);
}

function updateChapterChrome() {
  const total = state.chapterTexts.length;
  const i = state.chapterIndex;
  $('top-chapter').textContent = `第 ${i + 1} / ${total} 章 · ${chapterTitleAt(i)}`;
  syncJumpInput($('jump-input'), i + 1);
  syncJumpInput($('toc-jump'), i + 1);
  $('btn-prev').disabled = i === 0;
  $('btn-next').disabled = i === total - 1;
  highlightTocItem(i);
}

function scrollToRatio(ratio) {
  const apply = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: Math.max(0, max * ratio), behavior: 'auto' });
  };
  apply();
  requestAnimationFrame(apply);
}

function renderPaged(i, restoreRatio) {
  $('chapter').classList.remove('hidden');
  $('chapter-flow').classList.add('hidden');
  $('flow-tip').classList.add('hidden');
  $('chapter-title').textContent = chapterTitleAt(i);
  $('chapter-body').innerHTML = chapterInnerHtml(i);
  if (restoreRatio > 0) scrollToRatio(restoreRatio);
  else window.scrollTo({ top: 0, behavior: 'auto' });
}

function renderFlow(i, restoreRatio) {
  $('chapter').classList.add('hidden');
  const flow = $('chapter-flow');
  flow.classList.remove('hidden');
  flow.innerHTML = '';
  flow.appendChild(makeFlowSection(i));
  state.flow = { first: i, last: i };
  state.lastScrollY = 0;
  // 刚跳过来的一瞬间不要往前补章：浏览器把页面滚到位时会产生"向上滚"的假信号
  state.prependLockUntil = Date.now() + 700;
  $('flow-tip').classList.toggle('hidden', i !== state.chapterTexts.length - 1);
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (restoreRatio > 0) {
    requestAnimationFrame(() => {
      const section = flow.firstElementChild;
      if (!section) return;
      window.scrollTo({ top: Math.max(0, section.offsetTop + section.offsetHeight * restoreRatio), behavior: 'auto' });
    });
  }
  // 章节可能很短，先填满一屏，保证有可滚动的空间
  requestAnimationFrame(fillViewport);
}

/** 内容不够一屏时继续往下接，避免短章节导致没法滚动 */
function fillViewport(maxAdd = 12) {
  let added = 0;
  while (added < maxAdd
    && document.documentElement.scrollHeight <= window.innerHeight + 600
    && appendNextChapter()) added += 1;
  return added;
}

function appendNextChapter() {
  if (!isScrollMode() || !state.flow) return false;
  const next = state.flow.last + 1;
  if (next >= state.chapterTexts.length) {
    $('flow-tip').classList.remove('hidden');
    return false;
  }
  $('chapter-flow').appendChild(makeFlowSection(next));
  state.flow.last = next;
  return true;
}

function prependPrevChapter() {
  if (!isScrollMode() || !state.flow) return false;
  const prev = state.flow.first - 1;
  if (prev < 0) return false;
  const flow = $('chapter-flow');
  const before = document.documentElement.scrollHeight;
  flow.insertBefore(makeFlowSection(prev), flow.firstElementChild);
  const after = document.documentElement.scrollHeight;
  window.scrollBy(0, after - before);   // 保持视线不动
  state.flow.first = prev;
  return true;
}

/** 只保留当前章节附近的若干章，避免长时间滚动后 DOM 越堆越大 */
function trimFlow() {
  const flow = $('chapter-flow');
  const keep = 6;
  while (flow.children.length > keep * 2 && state.chapterIndex - state.flow.first > keep) {
    const first = flow.firstElementChild;
    const height = first.offsetHeight;
    first.remove();
    window.scrollBy(0, -height);
    state.flow.first += 1;
  }
  while (flow.children.length > keep * 2 && state.flow.last - state.chapterIndex > keep) {
    flow.lastElementChild.remove();
    state.flow.last -= 1;
  }
}

/** 滚动时判断"现在读到第几章"，并按需要加载上下文 */
function onFlowScroll() {
  if (!isScrollMode() || !state.flow || !state.book) return;
  const flow = $('chapter-flow');
  const doc = document.documentElement;
  const prev = state.lastScrollY == null ? window.scrollY : state.lastScrollY;
  const goingUp = prev - window.scrollY > 4;
  state.lastScrollY = window.scrollY;
  if (window.scrollY + window.innerHeight > doc.scrollHeight - 1500) { appendNextChapter(); fillViewport(4); }
  // 只有确实在往上翻、且不在跳章后的锁定期内，才往前补章
  if (goingUp && window.scrollY < 800 && Date.now() > (state.prependLockUntil || 0)) prependPrevChapter();

  let current = state.chapterIndex;
  for (const section of flow.children) {
    const rect = section.getBoundingClientRect();
    if (rect.top <= 140 && rect.bottom > 140) { current = Number(section.dataset.index); break; }
    if (rect.top > 140) { current = Number(section.dataset.index); break; }
  }
  if (current !== state.chapterIndex) {
    state.chapterIndex = current;
    updateChapterChrome();
    trimFlow();
  }
}

function goChapter(index, opts = {}) {
  if (!state.book) return;
  const total = state.chapterTexts.length;
  if (index < 0 || index >= total) {
    toast(index < 0 ? '已经是第一章了' : '已经是最后一章了');
    return;
  }
  state.highlight = opts.highlight || '';
  hideResumeHint();
  renderReader(index, 0);
  if (state.tts && state.tts.chapterIndex !== index && !opts.fromTts) {
    loadTtsChapter(index, state.tts.speaker.playing);
  }
  if (opts.closePanel !== false) closePanels();
}

/** 当前章内的阅读比例（两种模式通用） */
function currentRatio() {
  if (isScrollMode() && state.flow) {
    const section = [...$('chapter-flow').children].find((n) => Number(n.dataset.index) === state.chapterIndex);
    if (section && section.offsetHeight > 0) {
      const passed = window.scrollY - section.offsetTop;
      return Math.min(1, Math.max(0, passed / section.offsetHeight));
    }
    return 0;
  }
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

function updateProgressBar() {
  if (!state.book) return 0;
  const total = state.chapterTexts.length;
  const ratio = currentRatio();
  const percent = ((state.chapterIndex + ratio) / total) * 100;
  $('progressbar').style.width = `${Math.min(100, percent).toFixed(2)}%`;
  return ratio;
}

let saveTimer = null;
function saveProgress() {
  if (!state.book) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!state.book) return;
    state.book.progress = { chapterIndex: state.chapterIndex, ratio: currentRatio() };
    state.book.lastReadAt = Date.now();
    try { await updateBook(state.book); } catch { /* 忽略写入失败 */ }
  }, 400);
}

/* =========================================================
 * 书签与笔记
 * =======================================================*/
const markId = () => `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

async function loadMarks() {
  state.marks = state.book ? await getMarks(state.book.id).catch(() => []) : [];
}

async function persistMarks() {
  if (!state.book) return;
  try {
    await saveMarks(state.book.id, state.marks);
    state.markCounts.set(state.book.id, state.marks.length);
  } catch { /* 写入失败时至少界面还是对的 */ }
}

/** 当前屏幕上第一段文字，作为书签的摘要 */
function firstVisibleText() {
  const paragraphs = document.querySelectorAll('#view-reader p');
  for (const p of paragraphs) {
    const rect = p.getBoundingClientRect();
    if (rect.bottom > 150 && rect.top < window.innerHeight && p.textContent.trim()) {
      return p.textContent.trim().slice(0, 60);
    }
  }
  return '';
}

function chapterIndexOfNode(node) {
  const elNode = node && (node.nodeType === 1 ? node : node.parentElement);
  const section = elNode && elNode.closest ? elNode.closest('.flow-chapter') : null;
  return section ? Number(section.dataset.index) : state.chapterIndex;
}

async function addMark(mark) {
  state.marks.push(mark);
  await persistMarks();
  renderMarks();
  if (mark.chapterIndex === state.chapterIndex || isScrollMode()) refreshNoteHighlights();
}

async function addBookmark(quote) {
  if (!state.book) return;
  const index = state.chapterIndex;
  await addMark({
    id: markId(),
    type: 'bookmark',
    fromSelection: !!quote,
    chapterIndex: index,
    chapterTitle: chapterTitleAt(index),
    ratio: currentRatio(),
    quote: (quote || firstVisibleText()).slice(0, 200),
    note: '',
    createdAt: Date.now(),
  });
  toast(`已在「${chapterTitleAt(index)}」加书签`);
}

async function deleteMark(id) {
  state.marks = state.marks.filter((m) => m.id !== id);
  await persistMarks();
  renderMarks();
  refreshNoteHighlights();
}

function openNoteModal(mark, quote, chapterIndex) {
  state.editingMark = mark || null;
  state.pendingNote = mark ? null : { quote, chapterIndex };
  $('note-title').textContent = mark ? '编辑笔记' : '写笔记';
  $('note-quote').textContent = mark ? mark.quote : quote;
  $('note-quote').classList.toggle('hidden', !(mark ? mark.quote : quote));
  $('note-text').value = mark ? mark.note : '';
  $('note-delete').classList.toggle('hidden', !mark);
  showModal('note-modal');
  setTimeout(() => $('note-text').focus(), 50);
}

async function saveNoteFromModal() {
  const text = $('note-text').value.trim();
  if (state.editingMark) {
    state.editingMark.note = text;
    state.editingMark.type = 'note';
    await persistMarks();
  } else if (state.pendingNote) {
    const index = state.pendingNote.chapterIndex;
    await addMark({
      id: markId(),
      type: 'note',
      chapterIndex: index,
      chapterTitle: chapterTitleAt(index),
      ratio: currentRatio(),
      quote: state.pendingNote.quote.slice(0, 500),
      note: text,
      createdAt: Date.now(),
    });
  }
  hideModal('note-modal');
  state.editingMark = null;
  state.pendingNote = null;
  renderMarks();
  refreshNoteHighlights();
  toast('笔记已保存');
}

function sortedMarks() {
  return [...state.marks].sort((a, b) => a.chapterIndex - b.chapterIndex || a.ratio - b.ratio || a.createdAt - b.createdAt);
}

function renderMarks() {
  const list = $('marks-list');
  list.innerHTML = '';
  const marks = sortedMarks();
  if (!marks.length) {
    list.appendChild(el('div', 'toc-hit muted', '还没有书签或笔记。阅读时点上面的按钮加书签，或选中一段文字写笔记。'));
    return;
  }
  for (const mark of marks) {
    const item = el('div', 'mark-item');
    const where = el('div', 'where');
    where.append(
      el('span', 'kind', mark.type === 'note' ? '笔记' : '书签'),
      el('span', null, `第 ${mark.chapterIndex + 1} 章 · ${mark.chapterTitle || chapterTitleAt(mark.chapterIndex)}`),
    );
    item.appendChild(where);
    if (mark.quote) item.appendChild(el('div', 'quote', `「${mark.quote}」`));
    if (mark.note) item.appendChild(el('div', 'note', mark.note));

    const ops = el('div', 'ops');
    const go = el('button', 'ghost-btn', '跳过去');
    go.addEventListener('click', (e) => { e.stopPropagation(); jumpToMark(mark); });
    const edit = el('button', 'ghost-btn', mark.note ? '编辑' : '加笔记');
    edit.addEventListener('click', (e) => { e.stopPropagation(); openNoteModal(mark); });
    const del = el('button', 'ghost-btn danger', '删除');
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteMark(mark.id); });
    ops.append(go, edit, del);
    item.appendChild(ops);
    item.addEventListener('click', () => jumpToMark(mark));
    list.appendChild(item);
  }
}

function jumpToMark(mark) {
  if (!state.book) return;
  state.highlight = '';
  renderReader(mark.chapterIndex, mark.ratio || 0);
  closePanels();
  toast(`已跳到第 ${mark.chapterIndex + 1} 章`);
}

/** 笔记引用过的句子在正文里做下划线高亮 */
function noteSegmentsFor(index) {
  const segments = [];
  for (const mark of state.marks) {
    if (mark.chapterIndex !== index || !mark.quote) continue;
    if (mark.type !== 'note' && !mark.fromSelection) continue;   // 自动摘要的书签不做高亮
    for (const part of mark.quote.split('\n')) {
      const seg = part.trim();
      if (seg.length >= 3) segments.push(seg);
    }
  }
  return segments;
}

function refreshNoteHighlights() {
  if (!state.book) return;
  if (isScrollMode()) {
    const flow = $('chapter-flow');
    for (const section of flow.children) {
      const index = Number(section.dataset.index);
      const body = section.querySelector('.flow-body');
      if (body) body.innerHTML = chapterInnerHtml(index);
    }
  } else {
    $('chapter-body').innerHTML = chapterInnerHtml(state.chapterIndex);
  }
}

function exportMarks() {
  if (!state.book) return;
  const marks = sortedMarks();
  if (!marks.length) { toast('还没有书签或笔记'); return; }
  const lines = [`# ${state.book.title} · 书签与笔记`, ''];
  for (const mark of marks) {
    lines.push(`## 第 ${mark.chapterIndex + 1} 章 ${mark.chapterTitle || ''}（${mark.type === 'note' ? '笔记' : '书签'}）`);
    if (mark.quote) lines.push(`> ${mark.quote.replace(/\n/g, '\n> ')}`);
    if (mark.note) lines.push('', mark.note);
    lines.push('', `— ${new Date(mark.createdAt).toLocaleString('zh-CN')}`, '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.book.title}-书签笔记.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出书签与笔记');
}

/* ---- 选中文字后的浮层 ---- */
function hideSelPop() {
  $('sel-pop').classList.add('hidden');
  state.selection = null;
}

function onSelectionEnd() {
  if (!state.book || $('view-reader').classList.contains('hidden')) return;
  const sel = window.getSelection();
  const text = sel ? sel.toString().trim() : '';
  if (!text || text.length < 2) { hideSelPop(); return; }
  const node = sel.anchorNode;
  const holder = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!holder || !holder.closest('#view-reader')) { hideSelPop(); return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  const pop = $('sel-pop');
  pop.classList.remove('hidden');
  const top = rect.top + window.scrollY - pop.offsetHeight - 10;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, rect.left + window.scrollX))}px`;
  pop.style.top = `${Math.max(window.scrollY + 8, top)}px`;
  state.selection = { text, chapterIndex: chapterIndexOfNode(node) };
}

/* =========================================================
 * 目录 / 搜索
 * =======================================================*/
function renderToc() {
  const list = $('toc-list');
  list.innerHTML = '';
  if (!state.book) return;
  const chapters = state.book.chapters;
  $('toc-meta').textContent = `共 ${fmtNum(chapters.length)} 章 · ${fmtNum(state.book.charCount)} 字`;

  const query = $('toc-search').value.trim();
  const order = chapters.map((c, i) => i);
  if (state.tocReversed) order.reverse();

  // 正文搜索
  if (query.length >= 2) {
    const hits = searchContent(query, 200);
    if (hits.length) {
      const head = el('div', 'toc-hit');
      head.innerHTML = `<div class="where">正文命中 ${hits.length} 处${hits.length >= 200 ? '（仅显示前 200 处）' : ''}</div>`;
      list.appendChild(head);
      for (const hit of hits) {
        const item = el('div', 'toc-hit');
        item.innerHTML = `<div class="where">第 ${hit.index + 1} 章 · ${escapeHtml(chapters[hit.index].title)}</div>`
          + `<div class="snippet">${hit.snippet}</div>`;
        item.addEventListener('click', () => goChapter(hit.index, { highlight: query }));
        list.appendChild(item);
      }
      return;
    }
  }

  let shown = 0;
  for (const i of order) {
    const c = chapters[i];
    if (query && !c.title.toLowerCase().includes(query.toLowerCase())) continue;
    const item = el('div', `toc-item${c.level === 1 ? ' volume' : ''}${i === state.chapterIndex ? ' active' : ''}`);
    item.dataset.index = String(i);
    item.append(
      el('span', 'idx', String(i + 1)),
      el('span', 'name', c.title),
      el('span', 'size', c.charCount ? `${fmtNum(c.charCount)}字` : ''),
    );
    item.addEventListener('click', () => goChapter(i));
    list.appendChild(item);
    shown += 1;
  }
  if (!shown) list.appendChild(el('div', 'toc-hit muted', query ? '没有匹配的章节' : '暂无目录'));
}

function highlightTocItem(index) {
  const list = $('toc-list');
  list.querySelectorAll('.toc-item.active').forEach((n) => n.classList.remove('active'));
  const node = list.querySelector(`.toc-item[data-index="${index}"]`);
  if (node) {
    node.classList.add('active');
    node.scrollIntoView({ block: 'nearest' });
  }
}

function searchContent(query, limit) {
  const hits = [];
  const lower = query.toLowerCase();
  for (let i = 0; i < state.chapterTexts.length && hits.length < limit; i += 1) {
    const text = state.chapterTexts[i] || '';
    const hay = text.toLowerCase();
    let from = 0;
    while (hits.length < limit) {
      const pos = hay.indexOf(lower, from);
      if (pos === -1) break;
      const start = Math.max(0, pos - 18);
      const end = Math.min(text.length, pos + query.length + 22);
      const snippet = `${start > 0 ? '…' : ''}${escapeHtml(text.slice(start, pos))}`
        + `<mark>${escapeHtml(text.slice(pos, pos + query.length))}</mark>`
        + `${escapeHtml(text.slice(pos + query.length, end))}${end < text.length ? '…' : ''}`;
      hits.push({ index: i, snippet });
      from = pos + query.length;
    }
  }
  return hits;
}

/* =========================================================
 * 自动滚动
 * =======================================================*/
function startAutoScroll() {
  stopAutoScroll();
  let last = performance.now();
  const step = (now) => {
    const dt = (now - last) / 1000;
    last = now;
    window.scrollBy(0, (state.settings.autoScrollSpeed || 40) * dt);
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (window.scrollY >= max - 1) {
      // 滚动模式下后面的章节会自动接上，翻页模式才需要手动跳下一章
      const more = isScrollMode() ? appendNextChapter() : false;
      if (!more) {
        if (!isScrollMode() && state.chapterIndex < state.chapterTexts.length - 1) {
          goChapter(state.chapterIndex + 1, { closePanel: false });
        } else { stopAutoScroll(); return; }
      }
    }
    state.autoScrollTimer = requestAnimationFrame(step);
  };
  state.autoScrollTimer = requestAnimationFrame(step);
  $('btn-autoscroll').textContent = '停止自动滚动';
}
function stopAutoScroll() {
  if (state.autoScrollTimer) cancelAnimationFrame(state.autoScrollTimer);
  state.autoScrollTimer = null;
  $('btn-autoscroll').textContent = '开始自动滚动';
}

/* =========================================================
 * 导出
 * =======================================================*/
function exportClean() {
  if (!state.book) return;
  const blob = new Blob([describeMediaTokens(state.cleanTextValue)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.book.title}（已排版）.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出排版后的 TXT');
}

/* =========================================================
 * 事件绑定
 * =======================================================*/
function bindEvents() {
  $('btn-choose').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  });

  const dz = $('dropzone');
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
    e.preventDefault(); dz.classList.remove('dragover');
  }));
  dz.addEventListener('drop', async (e) => handleFiles(await filesFromDataTransfer(e.dataTransfer)));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!e.dataTransfer) return;
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) handleFiles(files);
  });

  let shelfSearchTimer = null;
  $('shelf-search').addEventListener('input', () => {
    clearTimeout(shelfSearchTimer);
    shelfSearchTimer = setTimeout(() => { state.shelf.page = 1; renderShelf(); }, 150);
  });
  $('shelf-sort').addEventListener('change', (e) => {
    state.settings.shelfSort = e.target.value;
    saveSettings(state.settings);
    state.shelf.page = 1;
    renderShelf();
  });
  $('view-toggle').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    state.settings.shelfView = btn.dataset.view;
    saveSettings(state.settings);
    state.shelf.page = 1;
    renderShelf();
  });
  $('btn-select-mode').addEventListener('click', () => {
    if (selecting()) exitSelectMode();
    else { state.shelf.selecting = true; renderShelf(); }
  });
  $('bulk-exit').addEventListener('click', exitSelectMode);
  $('bulk-none').addEventListener('click', () => { state.shelf.picked.clear(); renderShelf(); });
  $('bulk-all').addEventListener('click', () => {
    document.querySelectorAll('#book-grid .book-card').forEach((card) => state.shelf.picked.add(card.dataset.id));
    renderShelf();
  });
  $('bulk-category').addEventListener('click', bulkSetCategory);
  $('bulk-delete').addEventListener('click', bulkDelete);
  $('btn-tidy').addEventListener('click', () => { renderTidyOptions(); showModal('tidy-modal'); });
  $('tidy-cancel').addEventListener('click', () => hideModal('tidy-modal'));
  $('tidy-close').addEventListener('click', () => hideModal('tidy-modal'));
  $('tidy-apply').addEventListener('click', applyTidy);

  $('cover-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) applyCoverFile(file);
  });
  $('btn-choose-folder').addEventListener('click', () => $('folder-input').click());
  $('folder-input').addEventListener('change', (e) => {
    handleFiles([...e.target.files], { batch: true });
    e.target.value = '';
  });
  $('batch-cancel').addEventListener('click', () => { state.batchAbort = true; });
  $('batch-done').addEventListener('click', () => hideModal('batch-modal'));

  $('btn-paste').addEventListener('click', () => showModal('paste-modal'));
  $('paste-cancel').addEventListener('click', () => hideModal('paste-modal'));
  $('paste-close').addEventListener('click', () => hideModal('paste-modal'));
  $('paste-confirm').addEventListener('click', () => {
    const text = $('paste-text').value;
    if (!text.trim()) { toast('请先粘贴正文'); return; }
    hideModal('paste-modal');
    openImportModal(text, cleanBookTitle($('paste-name').value || '未命名小说'), { encoding: 'utf-8', confident: true, kind: 'paste' });
  });

  $('btn-shelf').addEventListener('click', showShelf);
  $('btn-toc').addEventListener('click', () => {
    if (!state.book) { toast('请先打开一本书'); return; }
    renderToc();
    openPanel('toc-panel');
    highlightTocItem(state.chapterIndex);
  });
  $('btn-settings').addEventListener('click', () => openPanel('settings-panel'));
  $('overlay').addEventListener('click', closePanels);
  document.querySelectorAll('[data-close-panel]').forEach((b) => b.addEventListener('click', closePanels));

  $('btn-marks').addEventListener('click', () => {
    if (!state.book) { toast('请先打开一本书'); return; }
    renderMarks();
    openPanel('marks-panel');
  });
  $('btn-add-bookmark').addEventListener('click', () => addBookmark());
  $('btn-export-marks').addEventListener('click', exportMarks);
  $('sel-note').addEventListener('click', () => {
    if (!state.selection) return;
    const { text, chapterIndex } = state.selection;
    hideSelPop();
    openNoteModal(null, text, chapterIndex);
  });
  $('sel-mark').addEventListener('click', () => {
    if (!state.selection) return;
    const { text } = state.selection;
    hideSelPop();
    addBookmark(text);
  });
  $('view-reader').addEventListener('click', (e) => {
    const img = e.target.closest && e.target.closest('.book-media img');
    if (img) openLightbox(img.src, img.alt);
  });
  $('lightbox').addEventListener('click', () => $('lightbox').classList.add('hidden'));
  $('btn-tts').addEventListener('click', toggleTts);
  $('tts-toggle').addEventListener('click', toggleTts);
  $('tts-prev').addEventListener('click', () => { if (state.tts) state.tts.speaker.jump(-1); updateTtsBar(); });
  $('tts-next').addEventListener('click', () => { if (state.tts) state.tts.speaker.jump(1); updateTtsBar(); });
  $('tts-close').addEventListener('click', stopTts);
  $('tts-rate').addEventListener('change', (e) => {
    state.settings.ttsRate = Number(e.target.value) || 1;
    saveSettings(state.settings);
    if (state.tts) state.tts.speaker.setRate(state.settings.ttsRate);
  });
  $('tts-voice').addEventListener('change', (e) => {
    state.settings.ttsVoice = e.target.value;
    saveSettings(state.settings);
    if (state.tts) state.tts.speaker.setVoice(currentVoice());
  });
  $('ocr-start').addEventListener('click', runOcr);
  $('ocr-stop').addEventListener('click', () => {
    if (state.ocr) state.ocr.stop = true;
    $('ocr-status').textContent = '正在停止……（当前这页识别完就停）';
  });
  $('ocr-use').addEventListener('click', useOcrResult);
  $('ocr-cancel').addEventListener('click', () => { if (state.ocr) state.ocr.stop = true; hideModal('ocr-modal'); });
  $('ocr-close').addEventListener('click', () => { if (state.ocr) state.ocr.stop = true; hideModal('ocr-modal'); });
  $('btn-ocr-again').addEventListener('click', () => {
    if (state.pending && state.pending.file) {
      hideModal('import-modal');
      openOcrModal(state.pending.file);
    }
  });
  $('error-ok').addEventListener('click', () => hideModal('error-modal'));
  $('error-close').addEventListener('click', () => hideModal('error-modal'));
  $('note-save').addEventListener('click', saveNoteFromModal);
  $('note-cancel').addEventListener('click', () => hideModal('note-modal'));
  $('note-close').addEventListener('click', () => hideModal('note-modal'));
  $('note-delete').addEventListener('click', async () => {
    if (!state.editingMark) return;
    await deleteMark(state.editingMark.id);
    state.editingMark = null;
    hideModal('note-modal');
    toast('已删除');
  });
  $('note-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNoteFromModal();
  });
  document.addEventListener('mouseup', (e) => {
    if (e.target.closest && e.target.closest('#sel-pop')) return;
    setTimeout(onSelectionEnd, 10);
  });
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || !sel.toString().trim()) hideSelPop();
  });
  window.addEventListener('scroll', hideSelPop, { passive: true });

  $('btn-export').addEventListener('click', exportClean);
  $('btn-retypeset').addEventListener('click', () => {
    if (!state.book) return;
    openImportModal(
      state.rawTextValue,
      state.book.title,
      { encoding: state.book.encoding, confident: true, kind: state.book.kind || 'txt' },
      state.book,
      state.nativeChapters,
    );
  });

  $('resume-close').addEventListener('click', hideResumeHint);
  $('resume-restart').addEventListener('click', () => {
    hideResumeHint();
    document.querySelectorAll('.resume-mark').forEach((n) => n.remove());
    renderReader(state.chapterIndex, 0);
  });
  $('btn-prev').addEventListener('click', () => goChapter(state.chapterIndex - 1, { closePanel: false }));
  $('btn-next').addEventListener('click', () => goChapter(state.chapterIndex + 1, { closePanel: false }));
  const jump = (value) => {
    const n = Number(value);
    if (!n || n < 1 || n > state.chapterTexts.length) { toast(`请输入 1 - ${state.chapterTexts.length} 之间的章节号`); return; }
    clearJumpDirty();
    goChapter(n - 1);
  };
  // 输入过章节号之后，滚动带来的"当前章"更新不能再覆盖输入框
  ['jump-input', 'toc-jump'].forEach((id) => {
    $(id).addEventListener('input', (e) => { e.target.dataset.dirty = '1'; });
  });
  $('btn-jump').addEventListener('click', () => jump($('jump-input').value));
  $('jump-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(e.target.value); });
  $('toc-jump-btn').addEventListener('click', () => jump($('toc-jump').value));
  $('toc-jump').addEventListener('keydown', (e) => { if (e.key === 'Enter') jump(e.target.value); });
  $('toc-sort').addEventListener('click', () => {
    state.tocReversed = !state.tocReversed;
    $('toc-sort').textContent = state.tocReversed ? '正序' : '倒序';
    renderToc();
  });
  let tocSearchTimer = null;
  $('toc-search').addEventListener('input', () => {
    clearTimeout(tocSearchTimer);
    tocSearchTimer = setTimeout(renderToc, 200);
  });

  $('btn-autoscroll').addEventListener('click', () => {
    if (state.autoScrollTimer) stopAutoScroll();
    else startAutoScroll();
  });

  window.addEventListener('scroll', () => {
    if (!state.book) return;
    onFlowScroll();
    updateProgressBar();
    saveProgress();
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') {
      closePanels(); hideSelPop();
      $('lightbox').classList.add('hidden');
      hideModal('import-modal'); hideModal('paste-modal'); hideModal('note-modal');
      hideModal('error-modal'); hideModal('ocr-modal'); hideModal('tidy-modal');
      return;
    }
    if (!state.book) return;
    switch (e.key) {
      case 'ArrowLeft': goChapter(state.chapterIndex - 1, { closePanel: false }); break;
      case 'ArrowRight': goChapter(state.chapterIndex + 1, { closePanel: false }); break;
      case 't': case 'T': $('btn-toc').click(); break;
      case 'b': case 'B': $('btn-marks').click(); break;
      case 'p': case 'P': toggleTts(); break;
      case 'd': case 'D': addBookmark(); break;
      case 's': case 'S': openPanel('settings-panel'); break;
      case 'g': case 'G':
        $('btn-toc').click();
        setTimeout(() => $('toc-jump').focus(), 60);
        e.preventDefault();
        break;
      case '+': case '=':
        state.settings.fontSize = Math.min(36, state.settings.fontSize + 1); applySettings(); break;
      case '-': case '_':
        state.settings.fontSize = Math.max(14, state.settings.fontSize - 1); applySettings(); break;
      default: break;
    }
  });
}

/* =========================================================
 * 启动
 * =======================================================*/
/* =========================================================
 * 朗读（听书）
 * =======================================================*/
function fillTtsControls() {
  const rateSelect = $('tts-rate');
  if (!rateSelect.options.length) {
    for (const rate of TTS_RATES) {
      const opt = document.createElement('option');
      opt.value = String(rate);
      opt.textContent = `${rate}x`;
      rateSelect.appendChild(opt);
    }
  }
  rateSelect.value = String(state.settings.ttsRate || 1);
}

async function fillTtsVoices() {
  const select = $('tts-voice');
  const voices = await whenVoicesReady();
  select.innerHTML = '';
  if (!voices.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '系统默认';
    select.appendChild(opt);
    return voices;
  }
  for (const voice of voices) {
    const opt = document.createElement('option');
    opt.value = voice.name;
    opt.textContent = `${voice.name}（${voice.lang}）`;
    select.appendChild(opt);
  }
  const saved = state.settings.ttsVoice;
  if (saved && voices.some((v) => v.name === saved)) select.value = saved;
  return voices;
}

function currentVoice() {
  const name = $('tts-voice').value;
  return listVoices().find((v) => v.name === name) || null;
}

function highlightSentence(index) {
  document.querySelectorAll('.tts-s.active').forEach((n) => n.classList.remove('active'));
  const node = document.querySelector(`.tts-s[data-s="${index}"]`);
  if (!node) return;
  node.classList.add('active');
  const rect = node.getBoundingClientRect();
  if (rect.top < 120 || rect.bottom > window.innerHeight - 120) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function updateTtsBar() {
  if (!state.tts) return;
  const { speaker } = state.tts;
  $('tts-toggle').textContent = speaker.playing ? '⏸' : '▶';
  $('tts-info').textContent = `第 ${state.tts.chapterIndex + 1} 章 · 第 ${Math.min(speaker.index + 1, speaker.total)} / ${speaker.total} 句`;
}

/** 找下一章有正文的（卷标题这类空章直接跳过） */
function nextReadableChapter(from) {
  for (let i = from; i < state.chapterTexts.length; i += 1) {
    if (splitSentences(state.chapterTexts[i] || '').length) return i;
  }
  return -1;
}

function loadTtsChapter(index, autoplay = true) {
  if (!state.tts) return;
  let target = index;
  let sentences = splitSentences(state.chapterTexts[target] || '');
  if (!sentences.length && autoplay) {
    // 卷标题之类没有正文，直接往后找一章能读的
    const next = nextReadableChapter(target + 1);
    if (next === -1) { toast('后面没有可朗读的正文了'); stopTts(); return; }
    target = next;
    sentences = splitSentences(state.chapterTexts[target] || '');
    if (target !== state.chapterIndex) goChapter(target, { closePanel: false, fromTts: true });
  }
  state.tts.chapterIndex = target;
  state.tts.speaker.load(sentences, 0);
  refreshNoteHighlights();          // 重新渲染，带上句子 span
  if (autoplay && sentences.length) state.tts.speaker.play(0);
  else updateTtsBar();
}

async function startTts() {
  if (!state.book) { toast('请先打开一本书'); return; }
  if (!supportsTts()) {
    showError('', '这个浏览器不支持朗读（缺少语音合成接口）。', [
      '换用 Chrome / Edge / Safari 等主流浏览器',
      '手机上通常需要系统里装有中文语音包',
    ]);
    return;
  }
  fillTtsControls();
  const voices = await fillTtsVoices();
  if (!voices.length) toast('系统里没找到语音包，会用浏览器默认音色');

  if (!state.tts) {
    const speaker = createSpeaker({
      rate: state.settings.ttsRate || 1,
      onSentence: ({ index }) => { highlightSentence(index); updateTtsBar(); },
      onPause: () => updateTtsBar(),
      onFinish: () => {
        // 一章读完自动接下一章
        const next = state.tts ? nextReadableChapter(state.tts.chapterIndex + 1) : -1;
        if (next !== -1) {
          goChapter(next, { closePanel: false, fromTts: true });
          loadTtsChapter(next, true);
          toast(`朗读：接着读第 ${next + 1} 章`);
        } else {
          toast('全书读完了');
          stopTts();
        }
      },
      onError: (err) => {
        if (err === 'unsupported') return;
        toast(`朗读出错：${err}`);
        updateTtsBar();
      },
    });
    state.tts = { speaker, chapterIndex: state.chapterIndex };
    speaker.setVoice(currentVoice());
  }
  $('tts-bar').classList.remove('hidden');
  loadTtsChapter(state.chapterIndex, true);
}

function stopTts() {
  if (!state.tts) return;
  state.tts.speaker.stop();
  const index = state.tts.chapterIndex;
  state.tts = null;
  $('tts-bar').classList.add('hidden');
  document.querySelectorAll('.tts-s.active').forEach((n) => n.classList.remove('active'));
  if (state.book && index === state.chapterIndex) refreshNoteHighlights();
}

function toggleTts() {
  if (!state.tts) { startTts(); return; }
  const { speaker } = state.tts;
  if (speaker.playing) speaker.pause();
  else speaker.play(speaker.index);
  updateTtsBar();
}

/* =========================================================
 * 扫描版 PDF 的 OCR
 * =======================================================*/
function fillOcrOptions() {
  const langSelect = $('ocr-lang');
  if (!langSelect.options.length) {
    for (const lang of OCR_LANGS) {
      const opt = document.createElement('option');
      opt.value = lang.id;
      opt.textContent = lang.label;
      langSelect.appendChild(opt);
    }
  }
  const scaleSelect = $('ocr-scale');
  if (!scaleSelect.options.length) {
    for (const scale of OCR_SCALES) {
      const opt = document.createElement('option');
      opt.value = String(scale.id);
      opt.textContent = scale.label;
      scaleSelect.appendChild(opt);
    }
    scaleSelect.value = '2';
  }
}

function openOcrModal(file) {
  fillOcrOptions();
  state.ocr = { file, running: false, stop: false, result: null };
  $('ocr-file').textContent = `文件：${file.name}`;
  $('ocr-range').value = '';
  $('ocr-bar').style.width = '0';
  $('ocr-status').textContent = '识别在你自己电脑上跑，不会上传文件；每页大概几秒钟，页数多可以先只识别前几页试试。';
  $('ocr-preview').classList.add('hidden');
  $('ocr-preview').textContent = '';
  $('ocr-start').classList.remove('hidden');
  $('ocr-use').classList.add('hidden');
  $('ocr-stop').classList.add('hidden');
  showModal('ocr-modal');
}

async function runOcr() {
  const task = state.ocr;
  if (!task || task.running) return;
  task.running = true;
  task.stop = false;
  $('ocr-start').classList.add('hidden');
  $('ocr-stop').classList.remove('hidden');
  $('ocr-use').classList.add('hidden');
  try {
    const buffer = await task.file.arrayBuffer();
    const result = await ocrPdf(buffer, {
      lang: $('ocr-lang').value,
      scale: Number($('ocr-scale').value),
      range: $('ocr-range').value,
      shouldStop: () => task.stop,
      onProgress: ({ done, total, message }) => {
        const percent = total ? (done / total) * 100 : 0;
        $('ocr-bar').style.width = `${percent.toFixed(1)}%`;
        $('ocr-status').textContent = total
          ? `${message || ''}（${done} / ${total} 页）`
          : (message || '');
      },
    });
    task.result = result;
    if (!result.text.replace(/\s/g, '')) {
      $('ocr-status').textContent = '没识别出文字。可以换个语言、把清晰度调高再试一次。';
    } else {
      const chars = result.text.replace(/\s/g, '').length;
      $('ocr-status').textContent = `识别完成：${result.pages.length} 页，共 ${fmtNum(chars)} 字。`;
      $('ocr-preview').textContent = result.text.slice(0, 600);
      $('ocr-preview').classList.remove('hidden');
      $('ocr-use').classList.remove('hidden');
    }
  } catch (err) {
    $('ocr-status').textContent = `识别失败：${err.message}`;
    if (/加载失败|未就绪|fetch|network/i.test(err.message)) {
      $('ocr-status').textContent += '（单文件版的 OCR 需要联网下载识别引擎，离线请用模块版 / 已安装的应用）';
    }
  } finally {
    task.running = false;
    $('ocr-stop').classList.add('hidden');
    $('ocr-start').classList.remove('hidden');
    $('ocr-start').textContent = '重新识别';
  }
}

function useOcrResult() {
  const task = state.ocr;
  if (!task || !task.result) return;
  hideModal('ocr-modal');
  const name = cleanBookTitle(task.file.name);
  openImportModal(task.result.text, name, {
    encoding: 'utf-8',
    confident: true,
    kind: 'pdf',
    via: `OCR（${$('ocr-lang').selectedOptions[0].textContent}）`,
    category: categoryFromPath(task.file),
  });
}

/* =========================================================
 * 备份与恢复
 * =======================================================*/
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function doExportBackup(includeText) {
  toast(includeText ? '正在打包备份，书多的话要等一会…' : '正在导出进度与笔记…');
  try {
    const data = await exportBackup({ includeText });
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    downloadBlob(blob, `清风阅读备份-${includeText ? '完整' : '进度笔记'}-${stamp}.json`);
    const size = (blob.size / 1024 / 1024).toFixed(2);
    toast(`已导出 ${data.books.length} 本书的备份（${size} MB）`);
  } catch (err) {
    showError('', `导出失败：${err.message}`, ['书特别多时可以试试"只导进度笔记"']);
  }
}

async function doImportBackup(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await importBackup(data);
    await refreshShelf();
    if (state.book) {
      state.marks = await getMarks(state.book.id).catch(() => state.marks);
      renderMarks();
    }
    applySettings();
    const parts = [];
    if (result.restored) parts.push(`恢复 ${result.restored} 本`);
    if (result.merged) parts.push(`合并进度/笔记 ${result.merged} 本`);
    if (result.skipped) parts.push(`跳过 ${result.skipped} 本（备份里没有正文且书架上没有）`);
    toast(parts.length ? parts.join('，') : '备份里没有可恢复的内容');
  } catch (err) {
    showError(file.name, `恢复失败：${err.message}`, ['请选择由本应用导出的 .json 备份文件']);
  }
}

/* =========================================================
 * PWA：离线可用 + 可安装
 * =======================================================*/
function setupPwa() {
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 不支持就算了 */ });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    $('btn-install').hidden = false;
  });
  $('btn-install').addEventListener('click', async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    const choice = await state.installPrompt.userChoice.catch(() => null);
    state.installPrompt = null;
    $('btn-install').hidden = true;
    if (choice && choice.outcome === 'accepted') toast('已添加到桌面');
  });
  window.addEventListener('appinstalled', () => { $('btn-install').hidden = true; });
}

async function main() {
  applySettings();
  bindSettings();
  bindImportInputs();
  try { state.importFormat = localStorage.getItem('novel-reader:importFormat') || 'txt'; } catch { state.importFormat = 'txt'; }
  renderFormatTabs();
  bindEvents();
  setupPwa();
  await refreshShelf();
  // 自动打开上次在读的书
  const last = state.books.find((b) => b.lastReadAt);
  if (last && last.progress) openBook(last.id);
}

main().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`);
});
