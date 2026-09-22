/**
 * 书架封面：优先用书里自带的（EPUB 内封、PDF 首页），
 * 没有就按书名生成一张配色封面。统一缩成小图存成 dataURL。
 */

export const COVER_W = 300;
export const COVER_H = 420;

/** 书名 → 稳定的色相，保证同一本书每次生成的封面一样 */
function hashHue(text) {
  let hash = 0;
  for (const ch of String(text || '未命名')) {
    hash = (hash * 31 + ch.codePointAt(0)) % 100000;
  }
  return hash % 360;
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** 竖排书名，长了就换列 */
function drawVerticalTitle(ctx, title, x, y, maxHeight, fontSize) {
  const chars = [...String(title || '')];
  const step = fontSize * 1.16;
  let column = 0;
  let offset = 0;
  for (const ch of chars) {
    if (offset + step > maxHeight) { column += 1; offset = 0; }
    if (column > 2) break;
    ctx.fillText(ch, x - column * (fontSize * 1.35), y + offset + fontSize);
    offset += step;
  }
}

/**
 * 按书名生成一张封面
 * @param {{title: string, author?: string, kind?: string}} book
 */
export function generateCover(book) {
  const title = (book && book.title) || '未命名';
  const hue = hashHue(title);
  const canvas = makeCanvas(COVER_W, COVER_H);
  const ctx = canvas.getContext('2d');

  const gradient = ctx.createLinearGradient(0, 0, COVER_W, COVER_H);
  gradient.addColorStop(0, `hsl(${hue}, 42%, 42%)`);
  gradient.addColorStop(1, `hsl(${(hue + 38) % 360}, 45%, 26%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, COVER_W, COVER_H);

  // 纹理：几道淡淡的斜线
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 18;
  for (let i = -COVER_H; i < COVER_W + COVER_H; i += 54) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + COVER_H, COVER_H);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 书脊
  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.fillRect(0, 0, 16, COVER_H);
  ctx.fillStyle = 'rgba(255,255,255,.14)';
  ctx.fillRect(16, 0, 3, COVER_H);

  // 边框
  ctx.strokeStyle = 'rgba(255,255,255,.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(34, 28, COVER_W - 62, COVER_H - 56);

  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'top';
  const fontSize = [...title].length > 8 ? 30 : 38;
  ctx.font = `600 ${fontSize}px "Noto Serif SC", "Songti SC", SimSun, serif`;
  drawVerticalTitle(ctx, title, COVER_W - 72, 56, COVER_H - 150, fontSize);

  const label = (book && book.author) || { epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI', docx: 'DOCX' }[book && book.kind] || '';
  if (label) {
    ctx.globalAlpha = 0.85;
    ctx.font = '500 16px "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(label, 48, COVER_H - 62);
    ctx.globalAlpha = 1;
  }
  return canvas.toDataURL('image/jpeg', 0.82);
}

/** 把任意图片（dataURL / Blob）缩放裁切成封面尺寸 */
export function fitCover(source) {
  return new Promise((resolve, reject) => {
    const url = typeof source === 'string' ? source : URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      const canvas = makeCanvas(COVER_W, COVER_H);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f0ece2';
      ctx.fillRect(0, 0, COVER_W, COVER_H);
      // cover 裁切：铺满且不变形
      const scale = Math.max(COVER_W / img.width, COVER_H / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (COVER_W - w) / 2, (COVER_H - h) / 2, w, h);
      if (typeof source !== 'string') URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => {
      if (typeof source !== 'string') URL.revokeObjectURL(url);
      reject(new Error('这张图片读不出来'));
    };
    img.src = url;
  });
}

/** 字节 + MIME → dataURL */
export function bytesToDataUrl(bytes, mime = 'image/jpeg') {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}
