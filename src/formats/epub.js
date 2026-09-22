/**
 * EPUB 解析：ZIP → container.xml → OPF（元信息 / manifest / spine）→ 各 XHTML 正文，
 * 目录标题优先取 EPUB 自带的 nav / toc.ncx，其次取文档里的第一个标题标签。
 * 用正则做轻量解析，浏览器和 Node 里都能跑，不依赖 DOMParser。
 */
import { readZip, readZipText } from './zip.js';
import { loadJsZip } from './vendor.js';

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–', middot: '·',
};

export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] != null ? ENTITIES[name.toLowerCase()] : m));
}

/** HTML / XHTML → 纯文本，保留段落换行 */
export function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<\?[\s\S]*?\?>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<head\b[\s\S]*?<\/head>/gi, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<(br|hr)\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|pre)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 生成"允许命名空间前缀"的标签正则，例如 <item> 与 <opf:item> 都能匹配 */
function tagRe(name, extra = '', flags = 'i') {
  return new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b${extra}`, flags);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return m ? m[1] : '';
}

/** 正文文档：优先看 media-type，缺失时看扩展名 */
function isDocItem(item) {
  if (!item) return false;
  if (/xhtml|html/i.test(item.type || '')) return true;
  if (item.type) return false;
  return /\.(x?html?|htm)$/i.test(item.href || '');
}

function resolvePath(base, href) {
  const clean = decodeURIComponent(String(href || '').split('#')[0].trim());
  if (!clean) return '';
  const parts = `${base}${clean}`.split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function firstTagText(html, tags = 'h1|h2|h3|h4|h5|h6') {
  const m = html.match(new RegExp(`<(?:${tags})[^>]*>([\\s\\S]*?)</(?:${tags})>`, 'i'));
  if (!m) return '';
  return htmlToText(m[1]).split('\n')[0].trim().slice(0, 60);
}

/** 从 toc.ncx / nav.xhtml 中取「文件路径 → 章节标题」 */
function parseToc(tocText, tocPath, isNcx) {
  const base = tocPath.includes('/') ? tocPath.replace(/[^/]+$/, '') : '';
  const map = new Map();
  if (!tocText) return map;
  if (isNcx) {
    const re = new RegExp(
      '<(?:[A-Za-z0-9_-]+:)?navPoint\\b[\\s\\S]*?'
      + '<(?:[A-Za-z0-9_-]+:)?text[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?text>[\\s\\S]*?'
      + '<(?:[A-Za-z0-9_-]+:)?content\\b[^>]*src\\s*=\\s*["\']([^"\']+)["\']',
      'gi',
    );
    let m = re.exec(tocText);
    while (m) {
      const label = htmlToText(m[1]).trim();
      const path = resolvePath(base, m[2]);
      if (path && label && !map.has(path)) map.set(path, label);
      m = re.exec(tocText);
    }
  } else {
    const re = new RegExp('<(?:[A-Za-z0-9_-]+:)?a\\b[^>]*href\\s*=\\s*["\']([^"\']+)["\'][^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?a>', 'gi');
    let m = re.exec(tocText);
    while (m) {
      const path = resolvePath(base, m[1]);
      const label = htmlToText(m[2]).trim();
      if (path && label && !map.has(path)) map.set(path, label);
      m = re.exec(tocText);
    }
  }
  return map;
}

/**
 * @param {ArrayBuffer} buffer EPUB 文件
 * @returns {Promise<{title:string, author:string, chapters:Array<{title:string,content:string}>, text:string}>}
 */
/**
 * 统一的 ZIP 读取接口：优先用 JSZip（对各种奇怪的 ZIP 更宽容），
 * 拿不到就退回项目自带的最小实现。
 * @returns {Promise<{names: () => string[], text: (name: string) => Promise<string|null>}>}
 */
export async function openZip(buffer) {
  try {
    const JSZip = await loadJsZip();
    const zip = await JSZip.loadAsync(buffer);
    return {
      via: 'jszip',
      names: () => Object.keys(zip.files).filter((n) => !zip.files[n].dir),
      text: async (name) => {
        const file = zip.file(name);
        return file ? file.async('string') : null;
      },
      bytes: async (name) => {
        const file = zip.file(name);
        return file ? file.async('uint8array') : null;
      },
    };
  } catch {
    const entries = await readZip(buffer);
    return {
      via: 'builtin',
      names: () => [...entries.keys()],
      text: (name) => readZipText(entries, name),
      bytes: async (name) => {
        const entry = entries.get(name);
        return entry ? entry.read() : null;
      },
    };
  }
}

export async function parseEpub(buffer) {
  const zip = await openZip(buffer);
  const container = await zip.text('META-INF/container.xml');
  const rootfileRe = tagRe('rootfile', '[^>]*>');
  let opfPath = container ? attr((container.match(rootfileRe) || [''])[0], 'full-path') : '';
  if (!opfPath) {
    opfPath = zip.names().find((n) => n.toLowerCase().endsWith('.opf')) || '';
  }
  if (!opfPath) {
    const names = zip.names();
    if (names.some((n) => /\.(xhtml|html|htm)$/i.test(n))) {
      // 没有 OPF，但有网页文件：按文件名顺序当作章节
      const docs = names.filter((n) => /\.(xhtml|html|htm)$/i.test(n)).sort();
      const chapters = [];
      for (const name of docs) {
        const html = await zip.text(name);              // eslint-disable-line no-await-in-loop
        const content = htmlToText(html || '');
        if (content.replace(/\s/g, '')) chapters.push({ title: firstTagText(html) || name.split('/').pop(), content });
      }
      if (chapters.length) {
        return { title: '', author: '', chapters, text: chapters.map((c) => `${c.title}\n${c.content}`).join('\n\n') };
      }
    }
    throw new Error('这个 EPUB 里找不到 OPF 索引文件，可能带 DRM 或者文件损坏');
  }

  const opf = await zip.text(opfPath);
  const base = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';

  const metaText = (name) => {
    const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}>`, 'i');
    return decodeEntities((opf.match(re) || [])[1] || '').trim();
  };
  const title = metaText('title');
  const author = metaText('creator');

  // manifest
  const manifest = new Map();
  const itemRe = tagRe('item', '[^>]*/?>', 'gi');
  let im = itemRe.exec(opf);
  while (im) {
    const tag = im[0];
    const id = attr(tag, 'id');
    if (id) {
      manifest.set(id, {
        href: resolvePath(base, attr(tag, 'href')),
        type: attr(tag, 'media-type'),
        properties: attr(tag, 'properties'),
      });
    }
    im = itemRe.exec(opf);
  }

  // 目录
  let tocMap = new Map();
  const navItem = [...manifest.values()].find((i) => (i.properties || '').includes('nav'));
  const ncxItem = [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml');
  if (navItem) tocMap = parseToc(await zip.text(navItem.href), navItem.href, false);
  if (!tocMap.size && ncxItem) tocMap = parseToc(await zip.text(ncxItem.href), ncxItem.href, true);

  // spine 顺序
  const spine = [];
  const refRe = tagRe('itemref', '[^>]*>', 'gi');
  let rm = refRe.exec(opf);
  while (rm) {
    const idref = attr(rm[0], 'idref');
    const item = manifest.get(idref);
    if (item && isDocItem(item)) spine.push(item);
    rm = refRe.exec(opf);
  }
  const docs = spine.length ? spine : [...manifest.values()].filter(isDocItem);

  // 内封：先看 metadata 里的 <meta name="cover">，再看 properties="cover-image"，最后按文件名猜
  let cover = null;
  const coverMetaId = (opf.match(/<meta[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i)
    || opf.match(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']cover["']/i) || [])[1];
  const coverItem = (coverMetaId && manifest.get(coverMetaId))
    || [...manifest.values()].find((i) => (i.properties || '').includes('cover-image'))
    || [...manifest.values()].find((i) => /^image\//i.test(i.type || '') && /cover/i.test(i.href || ''));
  if (coverItem && zip.bytes) {
    try {
      const bytes = await zip.bytes(coverItem.href);
      if (bytes && bytes.length) cover = { bytes, mime: coverItem.type || 'image/jpeg' };
    } catch { /* 拿不到封面不影响读书 */ }
  }

  const chapters = [];
  for (const doc of docs) {
    const html = await zip.text(doc.href);
    if (html == null) continue;
    const content = htmlToText(html);
    if (!content.replace(/\s/g, '')) continue;
    const label = tocMap.get(doc.href) || firstTagText(html)
      || htmlToText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim() || `第${chapters.length + 1}节`;
    // 正文里往往还留着一行和目录相同的标题，去掉避免重复
    const lines = content.split('\n');
    while (lines.length && (!lines[0].trim() || lines[0].trim() === label.trim())) lines.shift();
    chapters.push({ title: label, content: lines.join('\n') });
  }

  const text = chapters.map((c) => `${c.title}\n${c.content}`).join('\n\n');
  return { title, author, chapters, text, cover };
}
