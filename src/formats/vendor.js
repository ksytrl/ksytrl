/**
 * 第三方库的按需加载（pdf.js / JSZip）。
 * 两种运行形态都支持：
 *  - 模块版：从 vendor/ 目录加载真实文件
 *  - 单文件版：源码以 <script type="text/plain"> 内联在页面里，转成 blob URL 再加载
 * 加载失败不会致命，调用方会退回到项目自带的最小实现。
 */

const inlineSource = (id) => {
  const node = typeof document !== 'undefined' ? document.getElementById(id) : null;
  const text = node && node.textContent ? node.textContent.trim() : '';
  return text.length > 100 ? node.textContent : null;
};

const blobUrl = (source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`脚本加载失败：${url}`));
    document.head.appendChild(script);
  });
}

let jszipPromise = null;
/** @returns {Promise<any>} JSZip 构造函数 */
export function loadJsZip() {
  if (typeof window !== 'undefined' && window.JSZip) return Promise.resolve(window.JSZip);
  if (!jszipPromise) {
    const inline = inlineSource('vendor-jszip');
    jszipPromise = loadScript(inline ? blobUrl(inline) : 'vendor/jszip/jszip.min.js')
      .then(() => {
        if (!window.JSZip) throw new Error('JSZip 未就绪');
        return window.JSZip;
      })
      .catch((err) => { jszipPromise = null; throw err; });
  }
  return jszipPromise;
}

let pdfjsPromise = null;
/** @returns {Promise<any>} pdfjsLib */
export function loadPdfjs() {
  if (!pdfjsPromise) {
    const inlineLib = inlineSource('vendor-pdfjs');
    const inlineWorker = inlineSource('vendor-pdfjs-worker');
    pdfjsPromise = loadScript(inlineLib ? blobUrl(inlineLib) : 'vendor/pdfjs/pdf.min.js')
      .then(() => {
        const lib = window.pdfjsLib;
        if (!lib) throw new Error('pdf.js 未就绪');
        lib.GlobalWorkerOptions.workerSrc = inlineWorker
          ? blobUrl(inlineWorker)
          : 'vendor/pdfjs/pdf.worker.min.js';
        return lib;
      })
      .catch((err) => { pdfjsPromise = null; throw err; });
  }
  return pdfjsPromise;
}
