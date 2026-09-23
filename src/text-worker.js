/**
 * 后台线程：清洗、分章这类重活放在这里跑，界面（进度数字、小游戏）就不会被卡住。
 */
import { analyzeText } from './text-analyze.js';

self.onmessage = (event) => {
  const { id, payload } = event.data || {};
  try {
    const result = analyzeText(payload, (p, label) => self.postMessage({ id, type: 'progress', p, label }));
    self.postMessage({ id, type: 'done', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String((err && err.message) || err) });
  }
};
