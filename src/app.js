/**
 * 应用主控：导入 → 清洗排版 → 分章 → 阅读 / 跳章。
 * 纯前端，无后端，数据只存在浏览器本地。
 */
import { decodeBuffer, SUPPORTED_ENCODINGS } from './encoding.js';
import { cleanText, CLEAN_DEFAULTS } from './cleaner.js';
import {
  CHAPTER_RULES, DEFAULT_SPLIT_OPTIONS, splitChapters, analyzeRules, suggestRuleIds,
} from './chapters.js';
import {
  listBooks, getContent, saveBook, updateBook, deleteBook, newId,
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
  [...$('theme-row').children].forEach((b) => b.classList.toggle('active', b.dataset.themeValue === s.theme));
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
  $('overlay').classList.add('hidden');
}
function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }

/* =========================================================
 * 书架
 * =======================================================*/
async function refreshShelf() {
  state.books = await listBooks();
  const grid = $('book-grid');
  grid.innerHTML = '';
  $('shelf-count').textContent = state.books.length ? `共 ${state.books.length} 本` : '';
  $('shelf-empty').classList.toggle('hidden', state.books.length > 0);

  for (const book of state.books) {
    const card = el('div', 'book-card');
    card.appendChild(el('h3', null, book.title));
    const percent = book.progress && book.chapterCount
      ? Math.min(100, Math.round(((book.progress.chapterIndex + 1) / book.chapterCount) * 100))
      : 0;
    const meta = el('div', 'book-meta');
    meta.innerHTML = `${fmtNum(book.chapterCount)} 章 · ${fmtNum(book.charCount)} 字<br>`
      + `编码 ${escapeHtml(book.encoding || '-')} · 已读 ${percent}%<br>`
      + `${book.lastReadAt ? `上次阅读：${new Date(book.lastReadAt).toLocaleString('zh-CN')}` : '尚未阅读'}`;
    card.appendChild(meta);
    const bar = el('div', 'book-progress');
    const inner = el('i');
    inner.style.width = `${percent}%`;
    bar.appendChild(inner);
    card.appendChild(bar);

    const actions = el('div', 'book-actions');
    const readBtn = el('button', 'primary-btn', book.progress ? '继续阅读' : '开始阅读');
    readBtn.addEventListener('click', (e) => { e.stopPropagation(); openBook(book.id); });
    const delBtn = el('button', 'ghost-btn danger', '删除');
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`确定要从书架删除《${book.title}》吗？`)) return;
      await deleteBook(book.id);
      if (state.book && state.book.id === book.id) showShelf();
      refreshShelf();
      toast('已删除');
    });
    actions.append(readBtn, delBtn);
    card.appendChild(actions);
    card.addEventListener('click', () => openBook(book.id));
    grid.appendChild(card);
  }
}

function showShelf() {
  stopAutoScroll();
  state.book = null;
  $('view-shelf').classList.remove('hidden');
  $('view-reader').classList.add('hidden');
  $('btn-retypeset').hidden = true;
  $('btn-export').hidden = true;
  $('top-book').textContent = '清风阅读';
  $('top-chapter').textContent = '本地 TXT 小说阅读器';
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
  const { text, stats } = cleanText(pending.raw, cleanOpts, splitOpts);
  const { chapters, usedFallback } = splitChapters(text, splitOpts);

  pending.clean = text;
  pending.chapters = chapters;
  pending.cleanOptions = cleanOpts;
  pending.splitOptions = splitOpts;

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
    : `识别到 ${fmtNum(chapters.length)} 章`;
  updateRuleCounts(text);
}

function openImportModal(raw, name, encodingInfo, existing) {
  state.pending = {
    raw,
    name,
    encoding: encodingInfo.encoding,
    buffer: encodingInfo.buffer || null,
    bookId: existing ? existing.id : null,
  };
  $('import-title').textContent = existing ? '重新排版 / 重新分章' : '导入并排版';
  $('import-confirm').textContent = existing ? '保存并重新阅读' : '导入并开始阅读';
  $('import-name').value = name;

  const encSelect = $('import-encoding');
  encSelect.innerHTML = '';
  for (const enc of SUPPORTED_ENCODINGS) {
    const opt = document.createElement('option');
    opt.value = enc.id;
    opt.textContent = enc.label;
    encSelect.appendChild(opt);
  }
  encSelect.value = 'auto';
  encSelect.disabled = !encodingInfo.buffer;
  $('import-encoding-hint').textContent = encodingInfo.buffer
    ? `自动识别结果：${encodingInfo.encoding}${encodingInfo.confident ? '' : '（把握不大，若显示乱码请手动切换）'}`
    : '粘贴导入的文本无需选择编码';

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
    progress: existing && existing.progress
      ? { chapterIndex: Math.min(existing.progress.chapterIndex, chapters.length - 1), ratio: 0 }
      : { chapterIndex: 0, ratio: 0 },
  };

  try {
    await saveBook(meta, {
      raw: pending.raw,
      clean: pending.clean,
      chapterTexts: chapters.map((c) => c.content),
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

async function handleFiles(files) {
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const decoded = decodeBuffer(buffer);
      const name = file.name.replace(/\.[^.]+$/, '');
      openImportModal(decoded.text, name, { ...decoded, buffer });
    } catch (err) {
      toast(`读取 ${file.name} 失败：${err.message}`);
    }
    break; // 一次处理一本，避免弹窗互相覆盖
  }
  if (files.length > 1) toast('一次导入一本，剩下的可以稍后再选');
}

/* =========================================================
 * 阅读
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
  state.chapterIndex = meta.progress ? Math.min(meta.progress.chapterIndex, state.chapterTexts.length - 1) : 0;

  $('view-shelf').classList.add('hidden');
  $('view-reader').classList.remove('hidden');
  $('btn-retypeset').hidden = false;
  $('btn-export').hidden = false;
  $('top-book').textContent = meta.title;
  renderToc();
  renderChapter(state.chapterIndex, meta.progress ? meta.progress.ratio : 0);
}

function chapterTitleAt(i) {
  const c = state.book && state.book.chapters[i];
  return c ? c.title : '';
}

function renderChapter(index, restoreRatio = 0) {
  if (!state.book) return;
  const total = state.chapterTexts.length;
  const i = Math.max(0, Math.min(total - 1, index));
  state.chapterIndex = i;

  $('chapter-title').textContent = chapterTitleAt(i);
  const body = $('chapter-body');
  const text = state.chapterTexts[i] || '';
  const lines = text.split('\n');
  const html = lines.map((line) => {
    const t = line.trim();
    if (!t) return '<p class="blank"></p>';
    let safe = escapeHtml(line);
    if (state.highlight) {
      const re = new RegExp(escapeRegExp(state.highlight), 'gi');
      safe = safe.replace(re, (m) => `<mark>${m}</mark>`);
    }
    return `<p>${safe}</p>`;
  }).join('');
  body.innerHTML = html || '<p class="muted">（本章没有正文）</p>';

  $('top-chapter').textContent = `第 ${i + 1} / ${total} 章 · ${chapterTitleAt(i)}`;
  $('jump-input').value = i + 1;
  $('toc-jump').value = i + 1;
  $('btn-prev').disabled = i === 0;
  $('btn-next').disabled = i === total - 1;
  highlightTocItem(i);

  const target = restoreRatio > 0
    ? Math.max(0, (document.documentElement.scrollHeight - window.innerHeight) * restoreRatio)
    : 0;
  window.scrollTo({ top: target, behavior: 'auto' });
  // 内容渲染完成后再修正一次滚动位置
  if (restoreRatio > 0) {
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, max * restoreRatio), behavior: 'auto' });
    });
  }
  updateProgressBar();
  saveProgress();
}

function goChapter(index, opts = {}) {
  if (!state.book) return;
  const total = state.chapterTexts.length;
  if (index < 0 || index >= total) {
    toast(index < 0 ? '已经是第一章了' : '已经是最后一章了');
    return;
  }
  state.highlight = opts.highlight || '';
  renderChapter(index, 0);
  if (opts.closePanel !== false) closePanels();
}

function updateProgressBar() {
  if (!state.book) return;
  const total = state.chapterTexts.length;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
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
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    state.book.progress = { chapterIndex: state.chapterIndex, ratio };
    state.book.lastReadAt = Date.now();
    try { await updateBook(state.book); } catch { /* 忽略写入失败 */ }
  }, 400);
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
      if (state.chapterIndex < state.chapterTexts.length - 1) goChapter(state.chapterIndex + 1, { closePanel: false });
      else { stopAutoScroll(); return; }
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
  dz.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
  });

  $('btn-paste').addEventListener('click', () => showModal('paste-modal'));
  $('paste-cancel').addEventListener('click', () => hideModal('paste-modal'));
  $('paste-close').addEventListener('click', () => hideModal('paste-modal'));
  $('paste-confirm').addEventListener('click', () => {
    const text = $('paste-text').value;
    if (!text.trim()) { toast('请先粘贴正文'); return; }
    hideModal('paste-modal');
    openImportModal(text, ($('paste-name').value || '未命名小说').trim(), { encoding: 'utf-8', confident: true });
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

  $('btn-export').addEventListener('click', exportClean);
  $('btn-retypeset').addEventListener('click', () => {
    if (!state.book) return;
    openImportModal(state.rawTextValue, state.book.title, { encoding: state.book.encoding, confident: true }, state.book);
  });

  $('btn-prev').addEventListener('click', () => goChapter(state.chapterIndex - 1, { closePanel: false }));
  $('btn-next').addEventListener('click', () => goChapter(state.chapterIndex + 1, { closePanel: false }));
  const jump = (value) => {
    const n = Number(value);
    if (!n || n < 1 || n > state.chapterTexts.length) { toast(`请输入 1 - ${state.chapterTexts.length} 之间的章节号`); return; }
    goChapter(n - 1);
  };
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
    updateProgressBar();
    saveProgress();
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.key === 'Escape') { closePanels(); hideModal('import-modal'); hideModal('paste-modal'); return; }
    if (!state.book) return;
    switch (e.key) {
      case 'ArrowLeft': goChapter(state.chapterIndex - 1, { closePanel: false }); break;
      case 'ArrowRight': goChapter(state.chapterIndex + 1, { closePanel: false }); break;
      case 't': case 'T': $('btn-toc').click(); break;
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
async function main() {
  applySettings();
  bindSettings();
  bindImportInputs();
  bindEvents();
  await refreshShelf();
  // 自动打开上次在读的书
  const last = state.books.find((b) => b.lastReadAt);
  if (last && last.progress) openBook(last.id);
}

main().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`);
});
