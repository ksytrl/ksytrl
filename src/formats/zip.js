/**
 * 极简 ZIP 读取（EPUB 就是一个 ZIP）。
 * 解压用浏览器原生的 DecompressionStream('deflate-raw')，不依赖任何第三方库。
 */

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

function u16(view, off) { return view.getUint16(off, true); }
function u32(view, off) { return view.getUint32(off, true); }

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 EPUB（缺少 DecompressionStream）');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<Map<string, {method:number, offset:number, size:number, read:() => Promise<Uint8Array>}>>}
 */
export async function readZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // 从尾部找 End Of Central Directory
  let eocd = -1;
  const limit = Math.max(0, bytes.length - 66000);
  for (let i = bytes.length - 22; i >= limit; i -= 1) {
    if (u32(view, i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP / EPUB 文件');

  const count = u16(view, eocd + 10);
  let ptr = u32(view, eocd + 16);
  const entries = new Map();
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < count && ptr + 46 <= bytes.length; i += 1) {
    if (u32(view, ptr) !== CD_SIG) break;
    const method = u16(view, ptr + 10);
    const compressedSize = u32(view, ptr + 20);
    const nameLen = u16(view, ptr + 28);
    const extraLen = u16(view, ptr + 30);
    const commentLen = u16(view, ptr + 32);
    const localOffset = u32(view, ptr + 42);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    entries.set(name, {
      name,
      method,
      read: async () => {
        const lnLen = u16(view, localOffset + 26);
        const leLen = u16(view, localOffset + 28);
        const start = localOffset + 30 + lnLen + leLen;
        const raw = bytes.subarray(start, start + compressedSize);
        if (method === 0) return raw;
        if (method === 8) return inflateRaw(raw);
        throw new Error(`不支持的压缩方式：${method}`);
      },
    });
  }
  return entries;
}

/** 读取 ZIP 中的一个文本文件 */
export async function readZipText(entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  return new TextDecoder('utf-8').decode(await entry.read());
}
