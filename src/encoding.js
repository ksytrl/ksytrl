/**
 * 文本编码识别与解码。
 * 小说 TXT 常见编码：UTF-8、GBK/GB18030、BIG5、UTF-16。
 * 选错编码是"满屏乱码"最主要的原因，所以这里做多编码试解码 + 打分。
 */

export const SUPPORTED_ENCODINGS = [
  { id: 'auto', label: '自动识别' },
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'gb18030', label: 'GBK / GB18030（简体）' },
  { id: 'big5', label: 'BIG5（繁体）' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
];

// 典型乱码特征字符：GBK 当 UTF-8 读会出现 U+FFFD；UTF-8 当 GBK 读会出现"锟斤拷"一类。
const MOJIBAKE_CHARS = /[�锟斤拷烫屯珑聯茫芒篓陇搂驴陆Ã Â â€ï¿]/g;
const CJK = /[㐀-鿿豈-﫿]/g;
const READABLE = /[　-〿一-鿿＀-￯ -~぀-ヿ\n\r\t]/g;

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

/** 对一次解码结果打分，分数越低越可信 */
export function scoreText(text) {
  if (!text) return Number.POSITIVE_INFINITY;
  const sample = text.length > 200000 ? text.slice(0, 200000) : text;
  const len = sample.length || 1;
  const bad = countMatches(sample, MOJIBAKE_CHARS);
  const readable = countMatches(sample, READABLE);
  const cjk = countMatches(sample, CJK);
  // 乱码率权重最高；可读字符占比越高越好；中文占比作为轻微加分项
  return (bad / len) * 100 + (1 - readable / len) * 10 - Math.min(cjk / len, 0.6);
}

function decodeWith(buffer, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch {
    return null;
  }
}

function detectBom(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

/** UTF-8 合法性严格校验（不合法说明多半是 GBK/BIG5） */
function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {ArrayBuffer} buffer 文件内容
 * @param {string} [forced] 指定编码，'auto' 或空则自动识别
 * @returns {{text: string, encoding: string, confident: boolean}}
 */
export function decodeBuffer(buffer, forced) {
  const bytes = new Uint8Array(buffer);
  const bom = detectBom(bytes);

  if (forced && forced !== 'auto') {
    return { text: stripBom(decodeWith(bytes, forced) || ''), encoding: forced, confident: true };
  }
  if (bom) {
    return { text: stripBom(decodeWith(bytes, bom) || ''), encoding: bom, confident: true };
  }
  // 大量 0x00 说明是无 BOM 的 UTF-16
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  let zeros = 0;
  for (let i = 0; i < head.length; i += 1) if (head[i] === 0) zeros += 1;
  if (zeros > head.length * 0.25) {
    let evenZero = 0;
    for (let i = 0; i < head.length; i += 2) if (head[i] === 0) evenZero += 1;
    const enc = evenZero > head.length / 4 ? 'utf-16be' : 'utf-16le';
    return { text: stripBom(decodeWith(bytes, enc) || ''), encoding: enc, confident: true };
  }
  if (isValidUtf8(bytes)) {
    return { text: stripBom(decodeWith(bytes, 'utf-8') || ''), encoding: 'utf-8', confident: true };
  }

  const candidates = ['gb18030', 'big5', 'utf-8'];
  let best = null;
  for (const enc of candidates) {
    const text = decodeWith(bytes, enc);
    if (text == null) continue;
    const score = scoreText(text);
    if (!best || score < best.score) best = { text, encoding: enc, score };
  }
  if (!best) return { text: '', encoding: 'utf-8', confident: false };
  return { text: stripBom(best.text), encoding: best.encoding, confident: best.score < 1 };
}

export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
