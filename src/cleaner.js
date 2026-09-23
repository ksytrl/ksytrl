/**
 * 正文清洗 + 自动排版。
 * 目标：把从各种小说站扒下来的 TXT 变成干净可读的正文——
 *  1) 删除推广网址（含全角、空格、"点/dot"混淆写法）
 *  2) 删除站点广告行、水印行、分隔符行
 *  3) 修复 / 丢弃乱码
 *  4) 合并被硬换行打断的段落、压缩空行、统一段首缩进
 */

import {
  looksLikeHeading, looksLikeLooseHeading, compileRules, DEFAULT_SPLIT_OPTIONS,
} from './chapters.js';
import { isMediaLine } from './media.js';

export const CLEAN_DEFAULTS = {
  removeUrls: true,        // 删除网址
  removeAds: true,         // 删除广告 / 水印行
  removeSeparators: true,  // 删除 ==== ---- 之类的分隔线
  fixMojibake: true,       // 修复 UTF-8 被按 Latin-1 读出的乱码
  dropGarbledLines: true,  // 丢弃整行乱码
  mergeWrappedLines: true, // 合并硬换行导致的断句
  normalizeSpaces: true,   // 统一空白、去行尾空格
  fullWidthPunct: false,   // 半角标点转全角
  indentParagraphs: true,  // 段首缩进两个全角空格
  blankLinesBetweenParagraphs: 1,
  extraAdKeywords: [],     // 用户自定义要删除的关键词
};

// 用 new RegExp 写不可见字符，避免源码里出现真正的控制字符
const ZERO_WIDTH = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]', 'g');
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');
const NON_ASCII = new RegExp('[^\\u0000-\\u007F]');
const CJK_OR_ASCII = new RegExp(
  '[\\u0020-\\u007E\\u3000-\\u303F\\u3040-\\u30FF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uFF00-\\uFFEF]',
);
const HAS_CJK = new RegExp('[\\u4E00-\\u9FFF]');
const SPACE_RUN = /[  　]{2,}/g;
const LEADING_SPACE = /^[\s　]+/;
const TRAILING_SPACE = /[\s　]+$/;

/** 各种形态的网址 */
const URL_PATTERNS = [
  // 邮箱
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi,
  // 协议开头
  /(?:https?|ftp|thunder|ed2k):\/\/[^\s，。！？、；："'“”‘’）】》]+/gi,
  // www. / wap. / m. 开头
  /(?<![a-z0-9])(?:www|wap|m|3w|bbs|book|txt|www\d)[.．。][a-z0-9-]+(?:[.．。][a-z0-9-]{2,})+(?:\/[^\s，。！？"'）】》]*)?/gi,
  // 裸域名 + 常见顶级域
  /(?<![a-z0-9])[a-z0-9-]{2,}(?:[.．。][a-z0-9-]{2,})*[.．。](?:com|cn|net|org|cc|xyz|top|info|tv|me|la|biz|vip|shop|club|site|online|pro|ink|fun|wang|ltd|co|io|us|hk|tw|mobi|icu|space)(?:\.[a-z]{2})?\b(?:\/[^\s，。！？"'）】》]*)?/gi,
  // 全角网址 ｗｗｗ．ｘｘ．ｃｏｍ
  /[ｗＷ]{2,3}[.．。][ａ-ｚＡ-Ｚ０-９－]+(?:[.．。][ａ-ｚＡ-Ｚ０-９－]+)+/g,
  // 混淆写法：w w w . x x . c o m
  /\bw\s*[.．。点點]?\s*w\s*[.．。点點]?\s*w\s*[.．。点點\s]\s*[a-z0-9\s]{2,20}[.．。点點\s]\s*(?:com|cn|net|org|cc|tv|me|xyz)\b/gi,
  // 混淆写法：piaotian点com
  /[a-z0-9-]{2,}\s*(?:点|點|dot|\[点\]|【点】)\s*(?:com|cn|net|org|cc|tv|me|xyz)\b/gi,
];

/** 广告 / 水印关键词 */
const AD_KEYWORDS = [
  '最新章节', '最新章節', '更新最快', '更新最新', '无弹窗', '無彈窗', '免费阅读', '免費閱讀',
  '手机阅读', '手機閱讀', '手机版', '请记住本站', '请记住', '记住本站', '记住网址', '请收藏',
  '收藏本站', '本站域名', '一秒记住', '一秒記住', '看正版', '正版首发', '首发', '首發',
  '独家发布', '獨家發佈', '全文阅读', '全文閱讀', '小说网', '小說網', '小说阅读网', '文学网',
  '书友', '書友', '网友上传', '手打', 'txt下载', 'txt电子书', 'txt全集', '电子书下载',
  '本书由', '本文由', '整理制作', '仅供交流', '仅供试阅', '请支持正版', '支持正版', '版权归',
  '转载', '轉載', '章节内容开始', '章节报错', '举报错误', '推荐本书', '加入书签', '返回目录',
  '上一页', '下一页', '上一頁', '下一頁', '扫码', '扫描二维码', '公众号', '微信', 'QQ群',
  '广告', '廣告', '书迷楼', '笔趣', '飘天', '顶点小说', '八一中文', '追书',
];

const SEPARATOR_LINE = /^[\s\-=_*~·—…＝＿※★☆◆◇●○■□▲△+#|/\\.。、,，:：;；!！?？'"“”‘’()（）\[\]【】<>《》]+$/;
const MOJIBAKE_HINT = new RegExp('[\\u00C2-\\u00F4][\\u0080-\\u00BF]');
const MOJIBAKE_TOKENS = /锟斤拷|烫烫烫|屯屯屯|嚙|锘匡|锛屾|鏄庣|�/;
const ENDING_PUNCT = /[。！？…”』」》）】.!?"'’~～—]$/;

function stripUrls(line, stats) {
  let out = line;
  for (const re of URL_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, () => {
      stats.urlsRemoved += 1;
      return '';
    });
  }
  return out;
}

/** UTF-8 字节被当成 Latin-1 解码后的经典乱码（Ã©、â€œ），尝试还原 */
export function tryFixMojibake(line) {
  // UTF-8 多字节序列被逐字节当成 Latin-1：高位字符后面跟着 U+0080-U+00BF
  if (!MOJIBAKE_HINT.test(line)) return line;
  try {
    const bytes = new Uint8Array(line.length);
    for (let i = 0; i < line.length; i += 1) {
      const code = line.charCodeAt(i);
      if (code > 0xff) return line;
      bytes[i] = code;
    }
    const fixed = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // 只有还原出中日韩文字才认为修复成功，避免破坏正常的西文
    return HAS_CJK.test(fixed) ? fixed : line;
  } catch {
    return line;
  }
}

/** 整行乱码判定：可读字符占比过低，或包含典型乱码串 */
export function isGarbledLine(line) {
  const text = line.trim();
  if (!text) return false;
  if (MOJIBAKE_TOKENS.test(text)) return true;
  const chars = [...text];
  if (chars.length < 4) return false;
  let readable = 0;
  for (const ch of chars) if (CJK_OR_ASCII.test(ch)) readable += 1;
  const ratio = readable / chars.length;
  if (ratio < 0.7) return true;
  if (!HAS_CJK.test(text) && NON_ASCII.test(text) && ratio < 0.9) return true;
  return false;
}

function isAdLine(line, keywords) {
  const text = line.trim();
  if (!text) return false;
  if (text.length > 60) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => k && lower.includes(k.toLowerCase()));
}

function toFullWidthPunct(line) {
  return line
    .replace(/,(?=[^\d]|$)/g, '，')
    .replace(/;/g, '；')
    .replace(/!/g, '！')
    .replace(/\?/g, '？')
    .replace(/:(?=[^\d]|$)/g, '：')
    .replace(/\.{3,}/g, '……');
}

/** 估算原文的硬换行宽度（用于判断某行是否被截断） */
function estimateWrapWidth(lines) {
  const lens = lines.map((l) => l.trim().length).filter((n) => n > 0).sort((a, b) => a - b);
  if (lens.length < 8) return 0;
  const p90 = lens[Math.floor(lens.length * 0.9)];
  return p90 >= 20 ? Math.max(20, Math.floor(p90 * 0.72)) : 0;
}

/**
 * 主入口
 * @param {string} raw 原始文本
 * @param {object} options 清洗选项
 * @param {object} splitOptions 分章选项（用于保护标题行不被合并 / 误删）
 * @returns {{text: string, stats: object}}
 */
export function cleanText(raw, options = {}, splitOptions = {}, onProgress = null) {
  const opts = { ...CLEAN_DEFAULTS, ...options };
  const splitOpts = { ...DEFAULT_SPLIT_OPTIONS, ...splitOptions };
  const compiled = compileRules({
    ...splitOpts,
    ruleIds: splitOpts.ruleIds && splitOpts.ruleIds.length
      ? splitOpts.ruleIds
      : ['cn-volume', 'cn-chapter', 'cn-special', 'en-chapter'],
  });
  const headingOpts = { ...splitOpts, __compiled: compiled };

  const stats = {
    originalChars: raw.length,
    originalLines: 0,
    urlsRemoved: 0,
    adLines: 0,
    garbledLines: 0,
    mojibakeFixed: 0,
    mergedLines: 0,
    blankLinesRemoved: 0,
    finalChars: 0,
    finalLines: 0,
  };

  const normalized = raw.replace(/\r\n?/g, '\n').replace(ZERO_WIDTH, '').replace(CONTROL, '');
  const lines = normalized.split('\n');
  stats.originalLines = lines.length;

  const keywords = opts.removeAds
    ? AD_KEYWORDS.concat(opts.extraAdKeywords || []).filter(Boolean)
    : (opts.extraAdKeywords || []).filter(Boolean);

  // ---- 逐行清洗 ----
  const cleaned = [];
  const total = lines.length || 1;
  let lineNo = 0;
  for (const original of lines) {
    lineNo += 1;
    if (onProgress && lineNo % 4000 === 0) onProgress((lineNo / total) * 0.75);
    let line = original;

    // 图片 / 视频占位标记：原样保留，不参与任何清洗规则
    if (isMediaLine(line)) {
      cleaned.push(line.trim());
      continue;
    }

    if (opts.fixMojibake) {
      const fixed = tryFixMojibake(line);
      if (fixed !== line) {
        stats.mojibakeFixed += 1;
        line = fixed;
      }
    }

    const isHeading = looksLikeHeading(line, headingOpts);

    if (opts.removeUrls && !isHeading) {
      const before = line;
      line = stripUrls(line, stats);
      // 整行本来就是网址（去掉后只剩标点）→ 整行丢弃
      if (before.trim() && !line.replace(/[\s　\-—_|·:：,，.。()（）\[\]【】<>《》]/g, '')) {
        continue;
      }
    }

    if (!isHeading && keywords.length && isAdLine(line, keywords)) {
      stats.adLines += 1;
      continue;
    }

    if (opts.removeSeparators && !isHeading && line.trim() && SEPARATOR_LINE.test(line.trim())) {
      stats.adLines += 1;
      continue;
    }

    if (opts.dropGarbledLines && !isHeading && isGarbledLine(line)) {
      stats.garbledLines += 1;
      continue;
    }

    if (opts.normalizeSpaces) {
      line = line.replace(/\t/g, ' ').replace(SPACE_RUN, ' ')
        .replace(LEADING_SPACE, '').replace(TRAILING_SPACE, '');
    }

    if (opts.fullWidthPunct && !isHeading) line = toFullWidthPunct(line);

    cleaned.push(line);
  }

  // ---- 合并被硬换行拆断的段落 ----
  let merged = cleaned;
  if (opts.mergeWrappedLines) {
    const wrapWidth = estimateWrapWidth(cleaned);
    merged = [];
    for (let i = 0; i < cleaned.length; i += 1) {
      if (onProgress && i % 6000 === 0) onProgress(0.75 + (i / (cleaned.length || 1)) * 0.2);
      const trimmed = cleaned[i].trim();
      if (!trimmed) {
        merged.push('');
        continue;
      }
      // 规则识别到的标题、以及"疑似标题"（例如只写了 123 的那种）都不参与合并，
      // 否则漏识别的标题会被粘进正文，后面就再也补不回来了
      if (isMediaLine(trimmed)
        || looksLikeHeading(trimmed, headingOpts) || looksLikeLooseHeading(trimmed, splitOpts.maxTitleLength)) {
        merged.push(trimmed);
        continue;
      }
      let current = trimmed;
      while (wrapWidth > 0 && i + 1 < cleaned.length) {
        const next = cleaned[i + 1] ? cleaned[i + 1].trim() : '';
        if (!next) break;
        if (isMediaLine(next)) break;
        if (looksLikeHeading(next, headingOpts) || looksLikeLooseHeading(next, splitOpts.maxTitleLength)) break;
        if (current.length < wrapWidth) break;
        if (ENDING_PUNCT.test(current)) break;
        if (/^[“"「『]/.test(next)) break;
        current += next;
        stats.mergedLines += 1;
        i += 1;
      }
      merged.push(current);
    }
  }

  // ---- 压缩空行 + 段首缩进 ----
  const maxBlank = Math.max(0, Number(opts.blankLinesBetweenParagraphs) || 0);
  const out = [];
  let blank = 0;
  for (const line of merged) {
    if (!line.trim()) {
      blank += 1;
      if (blank > maxBlank) {
        stats.blankLinesRemoved += 1;
        continue;
      }
      out.push('');
      continue;
    }
    blank = 0;
    const isHeading = isMediaLine(line) || looksLikeHeading(line, headingOpts);
    if (opts.indentParagraphs && !isHeading) out.push(`　　${line.trim()}`);
    else out.push(line.trim());
  }

  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();

  const result = out.join('\n');
  stats.finalChars = result.length;
  stats.finalLines = out.length;
  return { text: result, stats };
}

export const AD_KEYWORD_LIST = AD_KEYWORDS;

/**
 * 清洗书名：文件名 / 电子书元信息里常带网址、站点名和推广后缀，
 * 例如「盘龙(www.biquge.com)【完结】.txt」→「盘龙」。
 */
export function cleanBookTitle(raw) {
  let name = String(raw || '').trim();
  if (!name) return '未命名小说';
  name = name.replace(/\.(txt|text|epub|pdf|html?|umd|azw3?|mobi)$/i, '');
  name = name.replace(/[_]+/g, ' ');   // 下划线常被用来拼接站点名
  // 先去掉整段网址
  const stats = { urlsRemoved: 0 };
  name = stripUrls(name, stats);
  // 括号里只剩站点 / 推广字样的，整块去掉
  name = name.replace(/[（(【\[「{][^）)】\]」}]{0,40}[）)】\]」}]/g, (block) => {
    const inner = block.slice(1, -1).trim();
    if (!inner) return '';   // 括号里原本是网址，去完就空了
    const siteish = /(网|阁|书屋|书城|书院|书站|书库|书吧|文学|小说|下载|txt|首发|独家|手打|论坛|贴吧|整理|校对|精校|完结|全本|更新|连载|免费|无弹窗)/i;
    return siteish.test(inner) ? '' : block;
  });
  // 常见推广后缀 / 前缀
  const junk = [
    '最新章节', '全本', '全集', '完结', '完本', '精校版', '精校', '校对版', '未删减', '珍藏版',
    'txt下载', 'txt全集下载', 'txt', '电子书', '免费阅读', '手打', '独家首发', '首发', '整理',
    '小说网', '书屋', '书城', '文学网', 'novel', 'downloads', 'download',
  ];
  for (const word of junk) {
    name = name.replace(new RegExp(`[\\s\\-_—·|~,，。、【】\\[\\]()（）]*${escapeForRegExp(word)}[\\s\\-_—·|~,，。、【】\\[\\]()（）]*`, 'gi'), ' ');
  }
  name = name
    .replace(/[_]+/g, ' ')
    .replace(/[\s　]{2,}/g, ' ')
    .replace(/^[\s\-_—·|~,，。、:：]+|[\s\-_—·|~,，。、:：]+$/g, '')
    .trim();
  return name || '未命名小说';
}

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
