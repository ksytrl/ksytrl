/**
 * 统一的"读取任意文件"层：按扩展名分派到对应解析器，
 * 都返回 { kind, name, raw, native, encoding, confident } 这一套结构。
 *
 * PDF 优先用 Mozilla 的 pdf.js（vendor/pdfjs），拿不到再退回自研最小解析器；
 * EPUB / DOCX 的 ZIP 解包优先用 JSZip，同样有自研兜底。
 */
import { decodeBuffer } from '../encoding.js';
import { cleanBookTitle } from '../cleaner.js';
import { parseEpub, htmlToText, decodeEntities, openZip } from './epub.js';
import { parsePdf, stripRunningHeads } from './pdf.js';
import { loadPdfjs } from './vendor.js';

/** 导入分栏：每一栏只认自己的扩展名 */
export const FORMAT_GROUPS = [
  {
    id: 'pdf',
    label: 'PDF',
    hint: '只挑 .pdf 文件；文字版直接读，扫描版会提示需要 OCR',
    exts: ['pdf'],
    accept: '.pdf,application/pdf',
  },
  {
    id: 'epub',
    label: 'EPUB',
    hint: '只挑 .epub 文件；自带目录会直接当章节用',
    exts: ['epub'],
    accept: '.epub,application/epub+zip',
  },
  {
    id: 'txt',
    label: 'TXT',
    hint: '只挑 .txt 文本；自动识别 UTF-8 / GBK / BIG5 / UTF-16',
    exts: ['txt', 'text', 'log'],
    accept: '.txt,.text,.log,text/plain',
  },
  {
    id: 'other',
    label: '其他格式',
    hint: 'MOBI / AZW3 / DOCX / HTML / Markdown / FB2 / RTF 也能读',
    exts: ['mobi', 'azw', 'azw3', 'prc', 'docx', 'html', 'htm', 'xhtml', 'md', 'markdown', 'fb2', 'rtf'],
    accept: '.mobi,.azw,.azw3,.prc,.docx,.html,.htm,.xhtml,.md,.markdown,.fb2,.rtf',
  },
];

export const ALL_EXTS = FORMAT_GROUPS.flatMap((g) => g.exts);

export function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

export function groupOf(name) {
  const ext = extOf(name);
  return FORMAT_GROUPS.find((g) => g.exts.includes(ext)) || null;
}

/* ---------------- PDF ---------------- */

/** pdf.js 的文字块 → 按行合并 */
function pdfItemsToLines(items) {
  const lines = [];
  let current = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    current += item.str;
    if (item.hasEOL) {
      if (current.trim()) lines.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

/**
 * 用 pdf.js 提取文字。
 * @param {ArrayBuffer} buffer
 * @param {{onProgress?: Function, onPassword?: Function}} options
 */
export async function extractPdfWithPdfjs(buffer, options = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer.slice(0)),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  if (options.onPassword) {
    task.onPassword = (updatePassword, reason) => {
      const password = options.onPassword(reason);
      if (password == null) task.destroy();
      else updatePassword(password);
    };
  }
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    /* eslint-disable no-await-in-loop */
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(pdfItemsToLines(content.items).join('\n'));
    page.cleanup();
    /* eslint-enable no-await-in-loop */
    if (options.onProgress) options.onProgress(i, doc.numPages);
  }
  const title = await doc.getMetadata().then((m) => (m && m.info && m.info.Title) || '').catch(() => '');
  doc.destroy();
  const cleaned = stripRunningHeads(pages);
  return { title, pages: cleaned, text: cleaned.filter(Boolean).join('\n\n'), via: 'pdf.js' };
}

export async function readPdf(buffer, options = {}) {
  let lastError = null;
  try {
    const result = await extractPdfWithPdfjs(buffer, options);
    if (result.text.replace(/\s/g, '')) return result;
    lastError = new Error('这个 PDF 里没有可提取的文字（多半是扫描图片版，需要先 OCR 转成文字）');
  } catch (err) {
    lastError = err;
    if (/password/i.test(err && err.name ? `${err.name} ${err.message}` : '')) {
      throw new Error('这个 PDF 需要密码，密码不对或者没有输入');
    }
  }
  // pdf.js 没跑起来（或没解析出文字）时，用自研解析器再试一次
  try {
    const fallback = await parsePdf(buffer);
    if (fallback.text.replace(/\s/g, '')) return { ...fallback, via: '内置解析器' };
  } catch (err) {
    if (!lastError) lastError = err;
  }
  throw lastError || new Error('PDF 解析失败');
}

/* ---------------- DOCX ---------------- */

export async function readDocx(buffer) {
  const zip = await openZip(buffer);
  const xml = await zip.text('word/document.xml');
  if (!xml) throw new Error('这不是有效的 .docx 文件（缺少 word/document.xml）');
  const text = decodeEntities(
    xml
      .replace(/<w:br[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<w:tab[^>]*\/?>/g, ' ')
      .replace(/<[^>]+>/g, ''),
  ).replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw new Error('这个 Word 文档里没有文字');
  return { text, title: '' };
}

/* ---------------- FB2 / HTML / Markdown / RTF ---------------- */

function decodeByDeclaration(buffer) {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(buffer).subarray(0, 2048));
  const m = head.match(/encoding\s*=\s*["']([\w-]+)["']/i) || head.match(/charset\s*=\s*["']?([\w-]+)/i);
  if (m) {
    const enc = m[1].toLowerCase().replace('gb2312', 'gb18030').replace('gbk', 'gb18030');
    try {
      return { text: new TextDecoder(enc, { fatal: false }).decode(new Uint8Array(buffer)), encoding: enc };
    } catch { /* 声明的编码不认识就走自动识别 */ }
  }
  const decoded = decodeBuffer(buffer);
  return { text: decoded.text, encoding: decoded.encoding };
}

export function readFb2(buffer) {
  const { text: xml, encoding } = decodeByDeclaration(buffer);
  const title = decodeEntities((xml.match(/<book-title[^>]*>([\s\S]*?)<\/book-title>/i) || [])[1] || '').trim();
  const bodies = xml.match(/<body[^>]*>[\s\S]*?<\/body>/gi) || [];
  const source = bodies.length ? bodies.join('\n') : xml;
  const text = decodeEntities(
    source
      .replace(/<empty-line\s*\/?>/gi, '\n')
      .replace(/<\/(p|title|subtitle|section|v|stanza)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, title, encoding };
}

export function readHtml(buffer) {
  const { text: html, encoding } = decodeByDeclaration(buffer);
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  return { text: htmlToText(html), title, encoding };
}

export function readMarkdown(buffer) {
  const decoded = decodeBuffer(buffer);
  const title = (decoded.text.match(/^#\s+(.+)$/m) || [])[1] || '';
  const text = decoded.text
    .replace(/^```[\s\S]*?^```$/gm, (block) => block.replace(/^```.*$/gm, ''))
    .replace(/^(#{1,6})\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|`)/g, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, title: title.trim(), encoding: decoded.encoding };
}

/** RTF：去掉控制字但保留 \'xx 转义出来的中文字节 */
export function readRtf(buffer) {
  const raw = new TextDecoder('latin1').decode(new Uint8Array(buffer));
  const cpMatch = raw.match(/\\ansicpg(\d+)/);
  const codepage = cpMatch ? Number(cpMatch[1]) : 1252;
  const decoder = new TextDecoder(codepage === 936 ? 'gb18030' : (codepage === 950 ? 'big5' : 'windows-1252'), { fatal: false });
  const body = raw.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|\*[^{}]*)[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, '');
  const bytes = [];
  const pushText = (s) => { for (const ch of s) bytes.push(ch.charCodeAt(0) & 0xff); };
  const re = /\\'([0-9a-fA-F]{2})|\\u(-?\d+)\s?\??|\\(par|line|page)\b|\\[a-zA-Z]+-?\d*\s?|[{}]|([^\\{}]+)/g;
  let m = re.exec(body);
  while (m) {
    if (m[1]) bytes.push(parseInt(m[1], 16));
    else if (m[2]) {
      const code = Number(m[2]);
      pushText(String.fromCharCode(code < 0 ? code + 65536 : code));
    } else if (m[3]) bytes.push(10);
    else if (m[4]) pushText(m[4]);
    m = re.exec(body);
  }
  const text = decoder.decode(new Uint8Array(bytes)).replace(/\n{3,}/g, '\n\n').trim();
  return { text, title: '', encoding: `rtf-cp${codepage}` };
}

/* ---------------- MOBI / AZW3 ---------------- */

function palmDocDecompress(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    i += 1;
    if (b === 0) out.push(0);
    else if (b <= 8) { for (let j = 0; j < b && i < bytes.length; j += 1) { out.push(bytes[i]); i += 1; } }
    else if (b <= 0x7f) out.push(b);
    else if (b <= 0xbf) {
      const b2 = bytes[i];
      i += 1;
      const pair = (b << 8) | b2;
      const distance = (pair >> 3) & 0x07ff;
      const length = (pair & 7) + 3;
      const start = out.length - distance;
      if (start < 0) break;
      for (let j = 0; j < length; j += 1) out.push(out[start + j]);
    } else {
      out.push(32);
      out.push(b ^ 0x80);
    }
  }
  return new Uint8Array(out);
}

export function readMobi(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 80) throw new Error('文件太小，不像是 MOBI');
  const type = new TextDecoder('latin1').decode(bytes.subarray(60, 68));
  if (!/BOOKMOBI|TEXtREAd/.test(type)) throw new Error('不是 MOBI / AZW 格式（PalmDB 头不对）');

  const recordCount = view.getUint16(76);
  const offsets = [];
  for (let i = 0; i < recordCount; i += 1) offsets.push(view.getUint32(78 + i * 8));
  offsets.push(bytes.length);

  const rec0 = bytes.subarray(offsets[0], offsets[1]);
  const rec0View = new DataView(rec0.buffer, rec0.byteOffset, rec0.byteLength);
  const compression = rec0View.getUint16(0);
  const textLength = rec0View.getUint32(4);
  const textRecords = rec0View.getUint16(8);
  const encryption = rec0View.getUint16(12);
  if (encryption !== 0) throw new Error('这本书带 DRM 加密，需要先去掉 DRM 才能阅读');
  if (compression === 17480) throw new Error('这本 MOBI 用了 HUFF/CDIC 压缩，暂时读不了，建议先转换成 EPUB');

  let encoding = 'utf-8';
  if (rec0.length > 32 && new TextDecoder('latin1').decode(rec0.subarray(16, 20)) === 'MOBI') {
    encoding = rec0View.getUint32(28) === 1252 ? 'windows-1252' : 'utf-8';
  }

  const parts = [];
  for (let i = 1; i <= textRecords && i < offsets.length - 1; i += 1) {
    const chunk = bytes.subarray(offsets[i], offsets[i + 1]);
    parts.push(compression === 2 ? palmDocDecompress(chunk) : chunk);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const merged = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) { merged.set(part, pos); pos += part.length; }

  const html = new TextDecoder(encoding, { fatal: false }).decode(merged.subarray(0, textLength || merged.length));
  const text = htmlToText(html);
  if (!text.replace(/\s/g, '')) throw new Error('没能从这本 MOBI 里读出文字，建议先转换成 EPUB 或 TXT');
  const title = decodeEntities((html.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '').trim();
  return { text, title, encoding };
}

/* ---------------- 统一入口 ---------------- */

/**
 * @param {File} file
 * @param {{onProgress?: Function, onPassword?: Function}} options
 */
export async function readAnyFile(file, options = {}) {
  const buffer = await file.arrayBuffer();
  const ext = extOf(file.name);
  const base = { buffer: null, native: null, confident: true, encoding: 'utf-8' };

  if (ext === 'pdf') {
    const pdf = await readPdf(buffer, options);
    return { ...base, kind: 'pdf', raw: pdf.text, name: cleanBookTitle(pdf.title || file.name), via: pdf.via };
  }
  if (ext === 'epub') {
    const book = await parseEpub(buffer);
    if (!book.chapters.length) throw new Error('这个 EPUB 里没有解析出正文，可能带 DRM 或文件损坏');
    return {
      ...base,
      kind: 'epub',
      raw: book.text,
      native: book.chapters,
      name: cleanBookTitle(book.title || file.name),
    };
  }
  if (ext === 'docx') {
    const doc = await readDocx(buffer);
    return { ...base, kind: 'docx', raw: doc.text, name: cleanBookTitle(doc.title || file.name) };
  }
  if (ext === 'fb2') {
    const book = readFb2(buffer);
    return { ...base, kind: 'fb2', raw: book.text, encoding: book.encoding, name: cleanBookTitle(book.title || file.name) };
  }
  if (['html', 'htm', 'xhtml'].includes(ext)) {
    const page = readHtml(buffer);
    return { ...base, kind: 'html', raw: page.text, encoding: page.encoding, name: cleanBookTitle(page.title || file.name) };
  }
  if (['md', 'markdown'].includes(ext)) {
    const doc = readMarkdown(buffer);
    return { ...base, kind: 'md', raw: doc.text, encoding: doc.encoding, name: cleanBookTitle(doc.title || file.name) };
  }
  if (ext === 'rtf') {
    const doc = readRtf(buffer);
    return { ...base, kind: 'rtf', raw: doc.text, encoding: doc.encoding, name: cleanBookTitle(file.name) };
  }
  if (['mobi', 'azw', 'azw3', 'prc'].includes(ext)) {
    const book = readMobi(buffer);
    return { ...base, kind: 'mobi', raw: book.text, encoding: book.encoding, name: cleanBookTitle(book.title || file.name) };
  }

  // 其余一律按纯文本处理（含 .txt / .log，以及没有扩展名的文件）
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
