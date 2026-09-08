/**
 * 应用主控：导入 → 清洗排版 → 分章 → 阅读 / 跳章。
 * 纯前端，无后端，数据只存在浏览器本地。
 */
import { decodeBuffer, SUPPORTED_ENCODINGS } from './encoding.js';
import { cleanText, cleanBookTitle, CLEAN_DEFAULTS } from './cleaner.js';
import { parseEpub } from './formats/epub.js';
import { parsePdf } from './formats/pdf.js';
import {
  CHAPTER_RULES, DEFAULT_SPLIT_OPTIONS, splitChapters, analyzeRules, suggestRuleIds,
} from './chapters.js';
import {
  listBooks, getContent, saveBook, updateBook, deleteBook, newId,
  getMarks, saveMarks, markCounts,
  loadSettings, saveSettings, DEFAULT_SETTINGS,
} from './store.js';

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
  editingMark: null,
  nativeChapters: null,// 电子书自带目录
  batchAbort: false,
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
function hideModal(id) { $(id).classList.add('hidden'); }

/* =========================================================
 * 书架：分类、搜索、排序
 * =======================================================*/
const UNCATEGORIZED = '未分类';

function bookCategory(book) {
  return (book.category || '').trim() || UNCATEGORIZED;
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

function bookPercent(book) {
  if (!book.progress || !book.chapterCount || !book.lastReadAt) return 0;
  return Math.min(100, Math.round(((book.progress.chapterIndex + 1) / book.chapterCount) * 100));
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

function makeBookCard(book) {
  const card = el('div', 'book-card');
  card.dataset.id = book.id;
  card.appendChild(el('h3', null, book.title));

  const tags = el('div', 'tags');
  tags.appendChild(el('span', 'tag', bookCategory(book)));
  const kindLabel = { epub: 'EPUB', pdf: 'PDF', paste: '粘贴' }[book.kind];
  if (kindLabel) tags.appendChild(el('span', 'tag', kindLabel));
  const marks = (state.markCounts && state.markCounts.get(book.id)) || 0;
  if (marks) tags.appendChild(el('span', 'tag mark', `${marks} 条笔记/书签`));
  card.appendChild(tags);

  const percent = bookPercent(book);
  const meta = el('div', 'book-meta');
  meta.innerHTML = `${fmtNum(book.chapterCount)} 章 · ${fmtNum(book.charCount)} 字 · 已读 ${percent}%<br>`
    + `${book.lastReadAt ? `上次阅读：${new Date(book.lastReadAt).toLocaleString('zh-CN')}` : '尚未阅读'}`;
  card.appendChild(meta);

  const bar = el('div', 'book-progress');
  const inner = el('i');
  inner.style.width = `${percent}%`;
  bar.appendChild(inner);
  card.appendChild(bar);

  const actions = el('div', 'book-actions');
  const readBtn = el('button', 'primary-btn', book.progress && book.lastReadAt ? '继续阅读' : '开始阅读');
  readBtn.addEventListener('click', (e) => { e.stopPropagation(); openBook(book.id); });
  const catBtn = el('button', 'ghost-btn', '分类');
  catBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
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
    if (!confirm(`确定要从书架删除《${book.title}》吗？`)) return;
    await deleteBook(book.id);
    if (state.book && state.book.id === book.id) showShelf();
    else refreshShelf();
    toast('已删除');
  });
  actions.append(readBtn, catBtn, delBtn);
  card.appendChild(actions);
  card.addEventListener('click', () => openBook(book.id));
  return card;
}

function renderShelf() {
  const query = ($('shelf-search').value || '').trim().toLowerCase();
  const activeCat = state.settings.shelfCategory || '';
  const grid = $('book-grid');
  grid.innerHTML = '';

  // 分类筛选条
  const bar = $('category-bar');
  bar.innerHTML = '';
  const cats = allCategories();
  if (cats.length > 1) {
    const all = el('button', `cat-chip${activeCat ? '' : ' active'}`);
    all.innerHTML = `全部<span class="n">${state.books.length}</span>`;
    all.addEventListener('click', () => {
      state.settings.shelfCategory = '';
      saveSettings(state.settings);
      renderShelf();
    });
    bar.appendChild(all);
    for (const [name, count] of cats) {
      const chip = el('button', `cat-chip${activeCat === name ? ' active' : ''}`);
      chip.innerHTML = `${escapeHtml(name)}<span class="n">${count}</span>`;
      chip.addEventListener('click', () => {
        state.settings.shelfCategory = activeCat === name ? '' : name;
        saveSettings(state.settings);
        renderShelf();
      });
      bar.appendChild(chip);
    }
  }

  let books = state.books;
  if (activeCat) books = books.filter((b) => bookCategory(b) === activeCat);
  if (query) {
    books = books.filter((b) => b.title.toLowerCase().includes(query)
      || bookCategory(b).toLowerCase().includes(query));
  }
  books = sortBooks(books);

  $('shelf-count').textContent = state.books.length
    ? `共 ${state.books.length} 本${books.length !== state.books.length ? `，当前显示 ${books.length} 本` : ''}`
    : '';
  $('shelf-empty').classList.toggle('hidden', state.books.length > 0);

  // 不筛选、不搜索且有多个分类时，按分类分组显示
  const grouped = !activeCat && !query && cats.length > 1;
  if (grouped) {
    for (const [name] of cats) {
      const inCat = sortBooks(state.books.filter((b) => bookCategory(b) === name));
      if (!inCat.length) continue;
      const title = el('h3', 'shelf-group-title', `${name}（${inCat.length}）`);
      grid.appendChild(title);
      title.style.gridColumn = '1 / -1';
      for (const book of inCat) grid.appendChild(makeBookCard(book));
    }
  } else {
    for (const book of books) grid.appendChild(makeBookCard(book));
    if (!books.length && state.books.length) {
      const tip = el('p', 'empty-tip', '没有匹配的书');
      tip.style.gridColumn = '1 / -1';
      grid.appendChild(tip);
    }
  }
}

function showShelf() {
  stopAutoScroll();
  state.book = null;
  state.marks = [];
  $('view-shelf').classList.remove('hidden');
  $('view-reader').classList.add('hidden');
  $('btn-retypeset').hidden = true;
  $('btn-export').hidden = true;
  $('btn-marks').hidden = true;
  $('top-book').textContent = '清风阅读';
  $('top-chapter').textContent = '本地小说阅读器 · TXT / EPUB / PDF';
  $('progressbar').style.width = '0';
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

  $('preview-text').textContent = text.slice(0, 900) || '（清洗后内容为空，请检查清洗选项）';
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
  };
  $('source-field').hidden = !state.pending.native;
  $('opt-source').value = state.pending.native
    ? ((existing && existing.chapterSource) || 'native')
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
  const kindLabel = { txt: 'TXT', epub: 'EPUB', pdf: 'PDF', paste: '粘贴文本' }[state.pending.kind] || 'TXT';
  $('import-encoding-hint').textContent = state.pending.kind === 'txt'
    ? (encodingInfo.buffer
      ? `自动识别结果：${encodingInfo.encoding}${encodingInfo.confident ? '' : '（把握不大，若显示乱码请手动切换）'}`
      : '粘贴导入的文本无需选择编码')
    : `${kindLabel} 文件已解析为文本，无需选择编码`;

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
  hideModal('import-modal');
  state.pending = null;
  await refreshShelf();
  await openBook(id);
  toast(`《${title}》已导入，共 ${chapters.length} 章`);
}

const SUPPORTED_EXT = /\.(txt|text|epub|pdf)$/i;

/** 从文件的相对路径推断分类：用它所在的那层文件夹名 */
function categoryFromPath(file) {
  const path = file.webkitRelativePath || file.__relPath || '';
  const parts = path.split('/').filter(Boolean);
  parts.pop();                       // 去掉文件名
  if (!parts.length) return '';
  return parts[parts.length - 1];    // 直接所在的文件夹
}

/** 按扩展名解析成统一的「待导入」结构 */
async function readBookFile(file) {
  const buffer = await file.arrayBuffer();
  const lower = (file.name || '').toLowerCase();
  if (lower.endsWith('.epub')) {
    const book = await parseEpub(buffer);
    return {
      kind: 'epub',
      raw: book.text,
      name: cleanBookTitle(book.title || file.name),
      encoding: 'utf-8',
      confident: true,
      native: book.chapters,
      buffer: null,
    };
  }
  if (lower.endsWith('.pdf')) {
    const pdf = await parsePdf(buffer);
    return {
      kind: 'pdf',
      raw: pdf.text,
      name: cleanBookTitle(pdf.title || file.name),
      encoding: 'utf-8',
      confident: true,
      native: null,
      buffer: null,
    };
  }
  const decoded = decodeBuffer(buffer);
  return {
    kind: 'txt',
    raw: decoded.text,
    name: cleanBookTitle(file.name),
    encoding: decoded.encoding,
    confident: decoded.confident,
    native: null,
    buffer,
  };
}

/** 自带目录 → 章节数组（逐章清洗） */
function nativeToChapters(native, cleanOpts, splitOpts) {
  return native.map((c) => {
    const content = cleanText(c.content, cleanOpts, splitOpts).text;
    return { title: c.title, level: 2, content, charCount: content.replace(/\s/g, '').length };
  }).filter((c) => c.charCount > 0);
}

async function handleFiles(files, opts = {}) {
  const list = [...files].filter((f) => SUPPORTED_EXT.test(f.name || ''));
  if (!list.length) {
    toast('没有找到可导入的 TXT / EPUB / PDF 文件');
    return;
  }
  if (list.length === 1 && !opts.batch) {
    try {
      const info = await readBookFile(list[0]);
      if (!info.raw || !info.raw.replace(/\s/g, '')) { toast(`${list[0].name} 里没有可读的文字`); return; }
      info.category = categoryFromPath(list[0]);
      openImportModal(info.raw, info.name, info, null, info.native);
    } catch (err) {
      toast(`读取 ${list[0].name} 失败：${err.message}`);
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
  $('top-book').textContent = meta.title;
  await loadMarks();
  renderMarks();
  renderToc();
  renderReader(state.chapterIndex, meta.progress ? meta.progress.ratio : 0);
}

function chapterTitleAt(i) {
  const c = state.book && state.book.chapters[i];
  return c ? c.title : '';
}

function isScrollMode() {
  return state.settings.readingMode !== 'paged';
}

/** 把一章正文转成段落 HTML */
function chapterInnerHtml(index) {
  const text = state.chapterTexts[index] || '';
  const noteSegments = state.highlight ? [] : noteSegmentsFor(index);
  const html = text.split('\n').map((line) => {
    const t = line.trim();
    if (!t) return '<p class="blank"></p>';
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
  renderReader(index, 0);
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
  const blob = new Blob([state.cleanTextValue], { type: 'text/plain;charset=utf-8' });
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
    shelfSearchTimer = setTimeout(renderShelf, 150);
  });
  $('shelf-sort').addEventListener('change', (e) => {
    state.settings.shelfSort = e.target.value;
    saveSettings(state.settings);
    renderShelf();
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
      hideModal('import-modal'); hideModal('paste-modal'); hideModal('note-modal');
      return;
    }
    if (!state.book) return;
    switch (e.key) {
      case 'ArrowLeft': goChapter(state.chapterIndex - 1, { closePanel: false }); break;
      case 'ArrowRight': goChapter(state.chapterIndex + 1, { closePanel: false }); break;
      case 't': case 'T': $('btn-toc').click(); break;
      case 'b': case 'B': $('btn-marks').click(); break;
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
