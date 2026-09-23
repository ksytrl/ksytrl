/**
 * 书里的图片 / 视频 / 音频：
 * 导入时把文件本体存进 IndexedDB，正文里只留一行占位标记 [[media:KEY]]，
 * 阅读时再把标记换成 <img> / <video> / <audio>。
 * 标记是纯 ASCII、单独成行，清洗、排版、分章、朗读都会跳过它。
 */

export const MEDIA_LINE = /^\s*\[\[media:([A-Za-z0-9_-]{1,40})\]\]\s*$/;

export const mediaToken = (key) => `[[media:${key}]]`;

export function isMediaLine(line) {
  return MEDIA_LINE.test(String(line || ''));
}

export function mediaKeyOf(line) {
  const m = String(line || '').match(MEDIA_LINE);
  return m ? m[1] : null;
}

/** 导出纯文本 / 预览时，把标记换成人能看懂的文字 */
export function describeMediaTokens(text, label = '［图片］') {
  return String(text || '').replace(/\[\[media:[A-Za-z0-9_-]{1,40}\]\]/g, label);
}

/** 按扩展名猜 MIME */
export function guessMime(path) {
  const ext = String(path || '').toLowerCase().split('?')[0].split('#')[0].split('.').pop();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav',
  }[ext] || 'application/octet-stream';
}

export function mediaKind(mime) {
  if (/^video\//.test(mime || '')) return 'video';
  if (/^audio\//.test(mime || '')) return 'audio';
  return 'image';
}
