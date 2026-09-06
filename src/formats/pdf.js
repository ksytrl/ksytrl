/**
 * 最小 PDF 文本提取器（够用于文字版小说 PDF，不处理扫描图片版）。
 * 流程：扫描间接对象 → 展开对象流(ObjStm) → 找到页面与字体 →
 *       解压页面内容流 → 解析 BT/ET 里的 Tj/TJ/'/" → 用 ToUnicode CMap 还原文字。
 * 解压用浏览器原生 DecompressionStream，不依赖任何第三方库。
 */

const latin1 = (bytes) => {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return out;
};

async function inflate(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('浏览器不支持解压 PDF 数据流');
  for (const format of ['deflate', 'deflate-raw']) {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* 换一种再试 */
    }
  }
  throw new Error('数据流解压失败');
}

/* ---------------- 对象扫描 ---------------- */

function findObjects(raw) {
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m = re.exec(raw);
  while (m) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = raw.indexOf('endobj', start);
    objects.set(num, raw.slice(start, end === -1 ? raw.length : end));
    m = re.exec(raw);
  }
  return objects;
}

function streamBytes(bytes, raw, body, bodyStart, length) {
  const idx = body.search(/\bstream\b/);
  if (idx === -1) return null;
  let start = bodyStart + idx + 'stream'.length;
  if (raw[start] === '\r') start += 1;
  if (raw[start] === '\n') start += 1;
  const endIdx = raw.indexOf('endstream', start);
  if (endIdx === -1) return null;
  // 用 /Length 精确定位；没有就把 endstream 前的换行去掉，
  // 否则多出来的字节会让解压器报 "trailing junk"
  let end = endIdx;
  if (Number.isFinite(length) && length > 0 && start + length <= bytes.length) {
    end = start + length;
  } else {
    while (end > start && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end -= 1;
  }
  return bytes.subarray(start, end);
}

/** 取字典里某个键的值，支持嵌套的 << >> 与 [ ]（非贪婪正则会在内层 >> 处截断） */
function dictValue(dict, key) {
  if (!dict) return null;
  const keyRe = new RegExp(`/${key}(?![A-Za-z0-9])`);
  const found = dict.search(keyRe);
  if (found === -1) return null;
  let i = found + key.length + 1;
  while (i < dict.length && /\s/.test(dict[i])) i += 1;

  if (dict.startsWith('<<', i)) {
    let depth = 0;
    let j = i;
    while (j < dict.length) {
      if (dict.startsWith('<<', j)) { depth += 1; j += 2; continue; }
      if (dict.startsWith('>>', j)) { depth -= 1; j += 2; if (depth === 0) break; continue; }
      j += 1;
    }
    return dict.slice(i, j);
  }
  if (dict[i] === '[') {
    let depth = 0;
    let j = i;
    while (j < dict.length) {
      if (dict[j] === '[') depth += 1;
      else if (dict[j] === ']') { depth -= 1; if (depth === 0) { j += 1; break; } }
      j += 1;
    }
    return dict.slice(i, j);
  }
  if (dict[i] === '(') {
    let j = i + 1;
    while (j < dict.length) {
      if (dict[j] === '\\') { j += 2; continue; }
      if (dict[j] === ')') { j += 1; break; }
      j += 1;
    }
    return dict.slice(i, j);
  }
  const rest = dict.slice(i, i + 64);
  const ref = rest.match(/^(\d+\s+\d+\s+R)/);
  if (ref) return ref[1];
  const token = rest.match(/^(\/[^\s/<>[\]()]+|-?[\d.]+|true|false|null)/);
  return token ? token[1] : null;
}

const refNum = (value) => {
  const m = String(value || '').match(/^(\d+)\s+\d+\s+R$/);
  return m ? Number(m[1]) : null;
};

const refList = (value) => {
  const out = [];
  const re = /(\d+)\s+\d+\s+R/g;
  let m = re.exec(String(value || ''));
  while (m) { out.push(Number(m[1])); m = re.exec(String(value || '')); }
  return out;
};

/* ---------------- ToUnicode CMap ---------------- */

const hexToChars = (hex) => {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 3 < clean.length + 1; i += 4) {
    const unit = parseInt(clean.slice(i, i + 4), 16);
    if (Number.isFinite(unit)) out += String.fromCharCode(unit);
  }
  return out;
};

export function parseToUnicode(text) {
  const map = new Map();
  const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block = charRe.exec(text);
  while (block) {
    const pairRe = /<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi;
    let pair = pairRe.exec(block[1]);
    while (pair) {
      map.set(parseInt(pair[1], 16), hexToChars(pair[2]));
      pair = pairRe.exec(block[1]);
    }
    block = charRe.exec(text);
  }
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  block = rangeRe.exec(text);
  while (block) {
    const body = block[1];
    const seqRe = /<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(?:<([0-9a-f]*)>|\[([\s\S]*?)\])/gi;
    let item = seqRe.exec(body);
    while (item) {
      const from = parseInt(item[1], 16);
      const to = parseInt(item[2], 16);
      if (item[3] != null) {
        const baseChars = hexToChars(item[3]);
        const baseCode = baseChars.charCodeAt(baseChars.length - 1) || 0;
        const prefix = baseChars.slice(0, -1);
        for (let c = from; c <= to && c - from < 65536; c += 1) {
          map.set(c, prefix + String.fromCharCode(baseCode + (c - from)));
        }
      } else if (item[4] != null) {
        const items = item[4].match(/<([0-9a-f]*)>/gi) || [];
        items.forEach((hx, i) => map.set(from + i, hexToChars(hx.slice(1, -1))));
      }
      item = seqRe.exec(body);
    }
    block = rangeRe.exec(text);
  }
  return map;
}

/* ---------------- 内容流解析 ---------------- */

function decodeLiteral(str) {
  const out = [];
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch !== '\\') { out.push(str.charCodeAt(i)); continue; }
    const next = str[i + 1];
    if (next == null) break;
    if (next >= '0' && next <= '7') {
      let oct = '';
      let k = i + 1;
      while (k < str.length && oct.length < 3 && str[k] >= '0' && str[k] <= '7') { oct += str[k]; k += 1; }
      out.push(parseInt(oct, 8));
      i = k - 1;
    } else {
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (next === '\n') { i += 1; continue; }
      out.push(map[next] != null ? map[next] : next.charCodeAt(0));
      i += 1;
    }
  }
  return out;
}

function bytesToText(codes, font) {
  const map = font && font.toUnicode;
  let out = '';
  if (font && font.twoByte) {
    for (let i = 0; i + 1 < codes.length; i += 2) {
      const code = (codes[i] << 8) | codes[i + 1];
      const mapped = map ? map.get(code) : null;
      out += mapped != null ? mapped : '';
    }
    return out;
  }
  for (const code of codes) {
    const mapped = map ? map.get(code) : null;
    if (mapped != null) out += mapped;
    else if (code >= 32 && code < 127) out += String.fromCharCode(code);
    else if (code >= 160) out += String.fromCharCode(code);
  }
  return out;
}

/** 解析一页的内容流，返回按行组织的文本 */
export function extractTextFromContent(content, fonts) {
  const lines = [];
  let line = '';
  let font = null;
  let lastY = null;
  let lastX = null;

  const flush = () => {
    if (line.trim()) lines.push(line.trim());
    line = '';
  };

  const tokenRe = /\/([^\s/<>\[\]()]+)|\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]*)>|(-?[\d.]+)|(\[|\])|([A-Za-z'"*]+)/g;
  const stack = [];
  let m = tokenRe.exec(content);
  while (m) {
    if (m[1] != null) stack.push({ type: 'name', value: m[1] });
    else if (m[2] != null) stack.push({ type: 'string', value: decodeLiteral(m[2]) });
    else if (m[3] != null) {
      const hex = m[3].replace(/\s+/g, '');
      const codes = [];
      for (let i = 0; i < hex.length; i += 2) codes.push(parseInt(hex.slice(i, i + 2).padEnd(2, '0'), 16));
      stack.push({ type: 'string', value: codes });
    } else if (m[4] != null) stack.push({ type: 'number', value: Number(m[4]) });
    else if (m[5] != null) stack.push({ type: 'punct', value: m[5] });
    else {
      const op = m[6];
      const nums = stack.filter((t) => t.type === 'number').map((t) => t.value);
      switch (op) {
        case 'Tf': {
          const name = [...stack].reverse().find((t) => t.type === 'name');
          font = name ? fonts.get(name.value) || null : null;
          break;
        }
        case 'Tm': {
          const y = nums.length >= 6 ? nums[5] : null;
          const x = nums.length >= 6 ? nums[4] : null;
          if (lastY != null && y != null && Math.abs(y - lastY) > 0.8) flush();
          else if (x != null && lastX != null && x - lastX > 4 && line && !/\s$/.test(line) && /[A-Za-z0-9,.;:!?)]$/.test(line)) line += ' ';
          if (y != null) lastY = y;
          if (x != null) lastX = x;
          break;
        }
        case 'Td': case 'TD': {
          const ty = nums.length >= 2 ? nums[1] : 0;
          if (Math.abs(ty) > 0.8) { flush(); lastY = lastY == null ? 0 : lastY + ty; }
          break;
        }
        case 'T*': flush(); break;
        case 'ET': break;
        case 'Tj': case "'": case '"': {
          if (op !== 'Tj') flush();
          const str = [...stack].reverse().find((t) => t.type === 'string');
          if (str) line += bytesToText(str.value, font);
          break;
        }
        case 'TJ': {
          for (const token of stack) {
            if (token.type === 'string') line += bytesToText(token.value, font);
            else if (token.type === 'number' && token.value < -180) line += ' ';
          }
          break;
        }
        default: break;
      }
      stack.length = 0;
    }
    m = tokenRe.exec(content);
  }
  flush();
  return lines;
}

/* ---------------- 主入口 ---------------- */

async function decodeStream(bytes, raw, body, bodyStart, length) {
  const data = streamBytes(bytes, raw, body, bodyStart, length);
  if (!data) return null;
  const filter = dictValue(body, 'Filter') || '';
  if (/FlateDecode/.test(filter)) {
    try { return await inflate(data); } catch { return null; }
  }
  if (/DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode/.test(filter)) return null;
  return data;
}

/**
 * @param {ArrayBuffer} buffer PDF 文件
 * @returns {Promise<{title:string, pages:string[], text:string}>}
 */
export async function parsePdf(buffer) {
  const bytes = new Uint8Array(buffer);
  const raw = latin1(bytes);
  if (!raw.startsWith('%PDF')) throw new Error('不是有效的 PDF 文件');

  // 对象体在 raw 中的位置，供 stream 定位
  const bodies = new Map();
  const offsets = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m = re.exec(raw);
  while (m) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const end = raw.indexOf('endobj', start);
    bodies.set(num, raw.slice(start, end === -1 ? raw.length : end));
    offsets.set(num, start);
    m = re.exec(raw);
  }

  // 展开对象流：里面的对象没有 "N 0 obj" 头
  for (const [num, body] of [...bodies]) {
    if (!/\/Type\s*\/ObjStm/.test(body)) continue;
    const data = await decodeStream(bytes, raw, body, offsets.get(num), streamLength(body));
    if (!data) continue;
    const text = latin1(data);
    const count = Number(dictValue(body, 'N') || 0);
    const first = Number(dictValue(body, 'First') || 0);
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < count; i += 1) {
      const objNum = header[i * 2];
      const objOff = header[i * 2 + 1];
      if (!Number.isFinite(objNum) || !Number.isFinite(objOff)) continue;
      const nextOff = i + 1 < count ? header[i * 2 + 3] : text.length - first;
      if (!bodies.has(objNum)) bodies.set(objNum, text.slice(first + objOff, first + nextOff));
    }
  }

  const streamLength = (body) => {
    const value = dictValue(body, 'Length');
    const ref = refNum(value);
    if (ref != null && bodies.has(ref)) return Number((bodies.get(ref).match(/-?\d+/) || [])[0]);
    return Number(value);
  };

  // 字体：编号 → {twoByte, toUnicode}
  const fontCache = new Map();
  const getFont = async (num) => {
    if (fontCache.has(num)) return fontCache.get(num);
    const body = bodies.get(num);
    if (!body) return null;
    const subtype = dictValue(body, 'Subtype') || '';
    const encoding = dictValue(body, 'Encoding') || '';
    const twoByte = /Type0/.test(subtype) || /Identity-[HV]|UCS2|UniGB|UniCNS|GBK-EUC-H/.test(encoding);
    let toUnicode = null;
    const tuRef = refNum(dictValue(body, 'ToUnicode'));
    if (tuRef != null && bodies.has(tuRef)) {
      const data = await decodeStream(bytes, raw, bodies.get(tuRef), offsets.get(tuRef), streamLength(bodies.get(tuRef)));
      if (data) toUnicode = parseToUnicode(latin1(data));
    }
    const font = { twoByte, toUnicode };
    fontCache.set(num, font);
    return font;
  };

  // 页面：沿 Catalog → Pages → Kids 走，拿不到就退回按对象序号排序
  const pageNums = [];
  const catalogNum = [...bodies.keys()].find((n) => /\/Type\s*\/Catalog/.test(bodies.get(n)));
  const walk = (num, depth, inherited) => {
    if (depth > 32 || !bodies.has(num)) return;
    const body = bodies.get(num);
    const resources = dictValue(body, 'Resources') || inherited;
    if (/\/Type\s*\/Page\b/.test(body)) { pageNums.push({ num, resources }); return; }
    for (const kid of refList(dictValue(body, 'Kids'))) walk(kid, depth + 1, resources);
  };
  if (catalogNum != null) {
    const pagesRef = refNum(dictValue(bodies.get(catalogNum), 'Pages'));
    if (pagesRef != null) walk(pagesRef, 0, null);
  }
  if (!pageNums.length) {
    for (const [num, body] of bodies) {
      if (/\/Type\s*\/Page\b/.test(body)) pageNums.push({ num, resources: dictValue(body, 'Resources') });
    }
    pageNums.sort((a, b) => a.num - b.num);
  }

  const pages = [];
  for (const page of pageNums) {
    const body = bodies.get(page.num);
    // 字体资源：/Font << /F1 5 0 R >> 或 /Font 6 0 R
    const fonts = new Map();
    let resources = page.resources || dictValue(body, 'Resources');
    const resRef = refNum(resources);
    if (resRef != null && bodies.has(resRef)) resources = bodies.get(resRef);
    let fontDict = resources ? dictValue(resources, 'Font') : null;
    const fontRef = refNum(fontDict);
    if (fontRef != null && bodies.has(fontRef)) fontDict = bodies.get(fontRef);
    if (fontDict) {
      const fre = /\/([^\s/<>\[\]]+)\s+(\d+)\s+\d+\s+R/g;
      let fm = fre.exec(fontDict);
      while (fm) {
        // eslint-disable-next-line no-await-in-loop
        const font = await getFont(Number(fm[2]));
        if (font) fonts.set(fm[1], font);
        fm = fre.exec(fontDict);
      }
    }

    let content = '';
    for (const cnum of refList(dictValue(body, 'Contents'))) {
      if (!bodies.has(cnum)) continue;
      // eslint-disable-next-line no-await-in-loop
      const data = await decodeStream(bytes, raw, bodies.get(cnum), offsets.get(cnum), streamLength(bodies.get(cnum)));
      if (data) content += `${latin1(data)}\n`;
    }
    if (!content) { pages.push(''); continue; }
    pages.push(extractTextFromContent(content, fonts).join('\n'));
  }

  const text = pages.filter(Boolean).join('\n\n');
  const infoNum = [...bodies.keys()].find((n) => /\/Title\s*\(/.test(bodies.get(n)));
  let title = '';
  if (infoNum != null) {
    const t = dictValue(bodies.get(infoNum), 'Title');
    if (t && t.startsWith('(')) title = String.fromCharCode(...decodeLiteral(t.slice(1, -1)));
  }
  if (!text.replace(/\s/g, '')) {
    throw new Error('这个 PDF 里没有可提取的文字（可能是扫描图片版，需要 OCR）');
  }
  return { title, pages, text };
}
