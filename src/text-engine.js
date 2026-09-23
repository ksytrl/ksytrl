/**
 * 主线程这边的"文本引擎"：优先把清洗 / 分章丢给 Web Worker，
 * Worker 起不来（老浏览器、特殊环境）就自动在主线程里算，结果完全一样。
 *
 * - 模块版：new Worker('src/text-worker.js', { type: 'module' })
 * - 单文件版：构建时把相关代码内联成 <script type="text/plain" id="text-worker-src">，
 *   运行时转成 blob URL 起一个普通 Worker
 */
import { analyzeText } from './text-analyze.js';

export function createTextEngine() {
  let worker = null;
  let broken = false;
  let seq = 0;
  const jobs = new Map();

  const failAll = (reason) => {
    broken = true;
    for (const job of jobs.values()) job.reject(Object.assign(new Error(reason), { workerBroken: true }));
    jobs.clear();
    if (worker) { try { worker.terminate(); } catch { /* 忽略 */ } }
    worker = null;
  };

  function getWorker() {
    if (broken || typeof Worker === 'undefined') return null;
    if (worker) return worker;
    try {
      const inline = typeof document !== 'undefined' ? document.getElementById('text-worker-src') : null;
      if (inline && inline.textContent.length > 100) {
        const url = URL.createObjectURL(new Blob([inline.textContent], { type: 'text/javascript' }));
        worker = new Worker(url);
      } else {
        worker = new Worker('src/text-worker.js', { type: 'module' });
      }
    } catch {
      broken = true;
      return null;
    }
    worker.onmessage = (event) => {
      const msg = event.data || {};
      const job = jobs.get(msg.id);
      if (!job) return;
      if (msg.type === 'progress') { if (job.onProgress) job.onProgress(msg.p, msg.label); return; }
      jobs.delete(msg.id);
      if (msg.type === 'done') job.resolve(msg.result);
      else job.reject(new Error(msg.message || '分析失败'));
    };
    worker.onerror = (event) => {
      if (event && event.preventDefault) event.preventDefault();
      failAll('worker-error');
    };
    return worker;
  }

  return {
    /** 当前是否在用后台线程 */
    get usingWorker() { return !!worker && !broken; },

    /**
     * @param {object} payload 见 analyzeText
     * @param {(fraction: number, label?: string) => void} [onProgress]
     */
    analyze(payload, onProgress) {
      const w = getWorker();
      if (!w) return Promise.resolve().then(() => analyzeText(payload, onProgress));
      seq += 1;
      const id = seq;
      return new Promise((resolve, reject) => {
        jobs.set(id, { resolve, reject, onProgress });
        w.postMessage({ id, payload });
      }).catch((err) => {
        // Worker 挂了：换主线程再算一次，保证功能不受影响
        if (err && err.workerBroken) return analyzeText(payload, onProgress);
        throw err;
      });
    },
  };
}
