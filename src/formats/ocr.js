/**
 * 扫描版 PDF 的 OCR：用 pdf.js 把每页渲染成图，再交给 tesseract.js 识别文字。
 * 中文语言包（chi_sim）随仓库带在 vendor/tesseract/lang 下，可离线使用；
 * 其它语言（繁体、英文）按需从 CDN 取。单文件版没有 vendor 目录，全部走 CDN。
 */
import { loadPdfjs, inlineSource, loadScript, blobUrl } from './vendor.js';

const CDN = 'https://unpkg.com';
const TESSERACT_VERSION = '5.1.1';
const LOCAL_LANGS = ['chi_sim'];   // 仓库里自带的语言包

export const OCR_LANGS = [
  { id: 'chi_sim', label: '简体中文' },
  { id: 'chi_sim+eng', label: '简体中文 + 英文' },
  { id: 'chi_tra', label: '繁体中文' },
  { id: 'eng', label: '英文' },
];

export const OCR_SCALES = [
  { id: 1.5, label: '快（1.5x）' },
  { id: 2, label: '标准（2x）' },
  { id: 3, label: '精细（3x，慢）' },
];

const assetConfig = () => (typeof window !== 'undefined' && window.__NR_ASSETS) || { base: 'vendor/' };

let tesseractPromise = null;
function loadTesseract() {
  if (typeof window !== 'undefined' && window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tesseractPromise) {
    const inline = inlineSource('vendor-tesseract');
    const base = assetConfig().base;
    const url = inline
      ? blobUrl(inline)
      : (base ? `${base}tesseract/tesseract.min.js` : `${CDN}/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`);
    tesseractPromise = loadScript(url)
      .then(() => {
        if (!window.Tesseract) throw new Error('tesseract.js 未就绪');
        return window.Tesseract;
      })
      .catch((err) => { tesseractPromise = null; throw err; });
  }
  return tesseractPromise;
}

/** OCR 需要的三类资源路径：worker、wasm 内核、语言包 */
export function ocrPaths(lang) {
  const base = assetConfig().base;
  const localLang = base && LOCAL_LANGS.includes(lang);
  return {
    workerPath: base ? `${base}tesseract/worker.min.js` : `${CDN}/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
    corePath: base ? `${base}tesseract/` : `${CDN}/tesseract.js-core@${TESSERACT_VERSION}/`,
    langPath: localLang ? `${base}tesseract/lang` : `${CDN}/@tesseract.js-data/${lang.split('+')[0]}@1.0.0/4.0.0_best_int`,
  };
}

/** OCR 出来的中文常常字间夹空格，顺手收拾一下 */
export function tidyOcrText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    // 只去掉中文字之间的空格，换行交给排版逻辑判断（否则段落会被粘成一坨）
    .replace(/([　-〿一-鿿＀-￯])[ \t　]+(?=[　-〿一-鿿＀-￯])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => line || (arr[i - 1] || '').trim())
    .join('\n')
    .trim();
}

/** "1-20,25" → [1..20,25]；空则全部 */
export function parsePageRange(input, total) {
  const text = String(input || '').trim();
  if (!text) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set();
  for (const part of text.split(/[,，\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:\s*[-—~]\s*(\d+))?$/);
    if (!m) continue;
    const from = Math.max(1, Number(m[1]));
    const to = Math.min(total, Number(m[2] || m[1]));
    for (let i = from; i <= to; i += 1) pages.add(i);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * @param {ArrayBuffer} buffer PDF 内容
 * @param {{lang?: string, scale?: number, range?: string, onProgress?: Function, shouldStop?: Function}} options
 * @returns {Promise<{pages: Array<{page:number,text:string}>, text: string, total: number}>}
 */
export async function ocrPdf(buffer, options = {}) {
  const lang = options.lang || 'chi_sim';
  const scale = Number(options.scale) || 2;
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer.slice(0)), verbosity: 0 }).promise;
  const list = parsePageRange(options.range, doc.numPages);
  if (!list.length) throw new Error('页码范围里没有有效的页');

  const Tesseract = await loadTesseract();
  const paths = ocrPaths(lang);
  const report = (stage, extra) => options.onProgress && options.onProgress({ stage, ...extra });
  report('init', { done: 0, total: list.length, message: '正在准备识别引擎（首次会稍慢）…' });

  const worker = await Tesseract.createWorker(lang, 1, {
    workerPath: paths.workerPath,
    corePath: paths.corePath,
    langPath: paths.langPath,
    logger: (m) => {
      if (m && m.status && /loading|initializing/i.test(m.status)) {
        report('init', { done: 0, total: list.length, message: `${m.status} ${Math.round((m.progress || 0) * 100)}%` });
      }
    },
  });

  const pages = [];
  try {
    for (const pageNo of list) {
      if (options.shouldStop && options.shouldStop()) break;
      /* eslint-disable no-await-in-loop */
      const page = await doc.getPage(pageNo);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
      const { data } = await worker.recognize(canvas);
      /* eslint-enable no-await-in-loop */
      pages.push({ page: pageNo, text: tidyOcrText(data.text) });
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
      report('page', { done: pages.length, total: list.length, page: pageNo, message: `第 ${pageNo} 页识别完成` });
    }
  } finally {
    await worker.terminate().catch(() => {});
    doc.destroy();
  }

  return {
    pages,
    total: doc.numPages,
    text: pages.map((p) => p.text).filter(Boolean).join('\n\n'),
  };
}
