/**
 * 清洗 + 分章的完整流程（纯函数）。
 * 既能在 Web Worker 里跑（不卡界面），也能在主线程直接调用（Worker 不可用时兜底）。
 */
import { cleanText } from './cleaner.js';
import {
  splitChapters, analyzeRules, suggestRuleIds, DEFAULT_SPLIT_OPTIONS,
} from './chapters.js';

const EMPTY_STATS = () => ({
  originalChars: 0, originalLines: 0, urlsRemoved: 0, adLines: 0, garbledLines: 0,
  mojibakeFixed: 0, mergedLines: 0, blankLinesRemoved: 0, finalChars: 0, finalLines: 0,
});

/**
 * @param {{raw: string, native?: Array, useNative?: boolean, cleanOpts: object, splitOpts: object, autoRules?: boolean}} payload
 * @param {(fraction: number, label?: string) => void} [onProgress]
 */
export function analyzeText(payload, onProgress) {
  const report = (p, label) => { if (onProgress) onProgress(Math.max(0, Math.min(1, p)), label); };
  const cleanOpts = payload.cleanOpts || {};
  let splitOpts = { ...DEFAULT_SPLIT_OPTIONS, ...(payload.splitOpts || {}) };

  // 新导入的书：先自动挑分章规则
  if (payload.autoRules) {
    report(0.02, '识别章节写法…');
    const ids = suggestRuleIds(payload.raw || '', splitOpts.maxTitleLength);
    splitOpts = { ...splitOpts, ruleIds: ids.length ? ids : DEFAULT_SPLIT_OPTIONS.ruleIds };
  }

  let text;
  let stats;
  let chapters;
  let usedFallback = false;
  let repair = { inserted: 0, filled: [], stillMissing: [] };

  if (payload.useNative && payload.native && payload.native.length) {
    // 电子书自带目录：逐章清洗，章节结构不变
    stats = EMPTY_STATS();
    chapters = [];
    const total = payload.native.length;
    payload.native.forEach((c, i) => {
      if (i % 5 === 0) report(0.05 + (i / total) * 0.85, `清洗第 ${i + 1} / ${total} 章…`);
      const res = cleanText(c.content, cleanOpts, splitOpts);
      Object.keys(stats).forEach((k) => { stats[k] += res.stats[k] || 0; });
      chapters.push({
        title: c.title, level: 2, content: res.text, charCount: res.text.replace(/\s/g, '').length,
      });
    });
    text = chapters.map((c) => `${c.title}\n${c.content}`).join('\n\n');
  } else {
    const cleaned = cleanText(payload.raw || '', cleanOpts, splitOpts,
      (p) => report(0.05 + p * 0.75, '清洗乱码、删除网址与广告…'));
    text = cleaned.text;
    stats = cleaned.stats;
    report(0.82, '识别章节、补回漏掉的章…');
    const split = splitChapters(text, splitOpts);
    chapters = split.chapters;
    usedFallback = split.usedFallback;
    repair = split.repair || repair;
  }

  report(0.94, '统计分章规则…');
  const ruleStats = analyzeRules(text, splitOpts.maxTitleLength || 40);
  report(1, '完成');
  return {
    text, stats, chapters, usedFallback, repair, ruleStats, ruleIds: splitOpts.ruleIds,
  };
}
