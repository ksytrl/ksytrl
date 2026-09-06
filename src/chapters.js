/**
 * 章节切分：内置多套常见标题规则，可任意组合，也支持自定义正则。
 * 识别不到时退化为"按行数自动分章"，保证任何文本都能跳章阅读。
 */

/** 内置规则。pattern 为字符串，运行时编译（方便存进 IndexedDB / localStorage） */
export const CHAPTER_RULES = [
  {
    id: 'cn-volume',
    name: '第N卷 / 第N部 / 第N篇',
    level: 1,
    pattern: '^第\\s*[0-9零一二三四五六七八九十百千两万〇]{1,12}\\s*[卷部篇](?![章节])(?:[\\s:：、.．-]*\\S.{0,30})?$',
  },
  {
    id: 'cn-chapter',
    name: '第N章 / 第N节 / 第N回 / 第N话',
    level: 2,
    pattern: '^第\\s*[0-9零一二三四五六七八九十百千两万〇]{1,12}\\s*[章节節回话話集幕折](?:[\\s:：、.．-]*\\S.{0,30})?$',
  },
  {
    id: 'cn-special',
    name: '楔子 / 序章 / 番外 / 后记 等特殊章',
    level: 2,
    pattern: '^(?:楔\\s*子|序\\s*章|序\\s*言|序|引\\s*子|前\\s*言|后\\s*记|後\\s*記|尾\\s*声|尾\\s*聲|终\\s*章|終\\s*章|大结局|大結局|番\\s*外(?:篇)?|作者[的之]?话|作者[的之]?話|新书感言|完本感言)(?:[\\s:：、.．-]*\\S.{0,30})?$',
  },
  {
    id: 'cn-plain-number',
    name: '一、xxx / 1. xxx（编号标题）',
    level: 2,
    pattern: '^(?:[0-9]{1,4}|[零一二三四五六七八九十百千两〇]{1,10})\\s*[、.．,，:：]\\s*\\S.{0,30}$',
  },
  {
    id: 'cn-bare-number',
    name: '纯数字独立成行（1 / 001）',
    level: 2,
    pattern: '^[0-9]{1,4}$',
  },
  {
    id: 'bracket-number',
    name: '（一） / 【第3章】 / [1] 括号编号',
    level: 2,
    pattern: '^[（(【\\[]\\s*(?:第)?\\s*[0-9零一二三四五六七八九十百千两〇]{1,10}\\s*(?:[章节回话卷])?\\s*[)）】\\]](?:[\\s:：、.．-]*\\S.{0,30})?$',
  },
  {
    id: 'en-chapter',
    name: 'Chapter 1 / Part I / Episode 3',
    level: 2,
    pattern: '^(?:chapter|chap\\.?|part|section|episode|book|volume)\\s+(?:[0-9]{1,4}|[ivxlcdm]{1,8})\\b.{0,40}$',
    flags: 'i',
  },
  {
    id: 'star-separator',
    name: '★ / ※ / ◆ 等符号包裹的标题',
    level: 2,
    pattern: '^[★☆※◆◇●○■□§*=-]{1,6}\\s*\\S.{0,30}?\\s*[★☆※◆◇●○■□§*=-]{1,6}$',
  },
];

const RULE_MAP = new Map(CHAPTER_RULES.map((r) => [r.id, r]));

export const DEFAULT_RULE_IDS = ['cn-volume', 'cn-chapter', 'cn-special'];

export const DEFAULT_SPLIT_OPTIONS = {
  ruleIds: DEFAULT_RULE_IDS.slice(),
  customPattern: '',
  maxTitleLength: 40,
  fallbackLines: 300,
  autoFallback: true,
  repairMissing: true,  // 按章节号连续性把"漏掉的章"从正文里补切出来
  repairMaxGap: 100,    // 单个缺口最多补多少章，避免异常文本被切碎
};

function compile(pattern, flags) {
  try {
    return new RegExp(pattern, flags || '');
  } catch {
    return null;
  }
}

/** 章节标题一般很短、不带成段的句读 */
function plausibleTitle(line, maxTitleLength) {
  if (!line) return false;
  if (line.length > maxTitleLength) return false;
  if (/[。；！？…]/.test(line.slice(0, -1))) return false;
  if (/["“”]/.test(line)) return false;
  return true;
}

export function compileRules(options = {}) {
  const opts = { ...DEFAULT_SPLIT_OPTIONS, ...options };
  const rules = [];
  for (const id of opts.ruleIds || []) {
    const rule = RULE_MAP.get(id);
    if (!rule) continue;
    const re = compile(rule.pattern, rule.flags);
    if (re) rules.push({ ...rule, re });
  }
  if (opts.customPattern && opts.customPattern.trim()) {
    const re = compile(opts.customPattern.trim(), 'i');
    if (re) rules.push({ id: 'custom', name: '自定义正则', level: 2, re });
  }
  return rules;
}

/** 判断一行是否像章节标题（清洗器也会用它，避免把标题跟正文粘到一起） */
export function looksLikeHeading(line, options) {
  const text = (line || '').trim();
  if (!text) return false;
  const opts = { ...DEFAULT_SPLIT_OPTIONS, ...(options || {}) };
  if (!plausibleTitle(text, opts.maxTitleLength)) return false;
  const rules = options && options.__compiled ? options.__compiled : compileRules({
    ...opts,
    ruleIds: opts.ruleIds && opts.ruleIds.length ? opts.ruleIds : ['cn-volume', 'cn-chapter', 'cn-special', 'en-chapter'],
  });
  return rules.some((r) => r.re.test(text));
}

/** 统计每条规则在文本中的命中次数，用于"自动识别分章方式" */
export function analyzeRules(text, maxTitleLength = DEFAULT_SPLIT_OPTIONS.maxTitleLength) {
  const lines = text.split('\n');
  const counts = new Map(CHAPTER_RULES.map((r) => [r.id, 0]));
  for (const raw of lines) {
    const line = raw.trim();
    if (!plausibleTitle(line, maxTitleLength)) continue;
    for (const rule of CHAPTER_RULES) {
      const re = compile(rule.pattern, rule.flags);
      if (re && re.test(line)) counts.set(rule.id, counts.get(rule.id) + 1);
    }
  }
  return CHAPTER_RULES.map((r) => ({ id: r.id, name: r.name, count: counts.get(r.id) }));
}

/** 自动挑选规则组合：优先中文章节体系，其次英文，最后编号类 */
export function suggestRuleIds(text, maxTitleLength) {
  const stats = new Map(analyzeRules(text, maxTitleLength).map((s) => [s.id, s.count]));
  const n = (id) => stats.get(id) || 0;
  const picked = [];
  // 先挑主章节规则
  if (n('cn-chapter') >= 2) picked.push('cn-chapter');
  else if (n('en-chapter') >= 2) picked.push('en-chapter');
  else if (n('bracket-number') >= 3) picked.push('bracket-number');
  else if (n('cn-plain-number') >= 3) picked.push('cn-plain-number');
  else if (n('star-separator') >= 3) picked.push('star-separator');
  else if (n('cn-bare-number') >= 3) picked.push('cn-bare-number');
  else if (n('cn-chapter') >= 1) picked.push('cn-chapter');
  else if (n('en-chapter') >= 1) picked.push('en-chapter');
  // 再补上分卷与楔子/番外之类的特殊章
  if (n('cn-volume') >= 1) picked.push('cn-volume');
  if (n('cn-special') >= 1) picked.push('cn-special');
  return picked;
}

function makeChapter(title, lines, level, startLine) {
  const content = lines.join('\n').replace(/^\n+|\n+$/g, '');
  return {
    title: title || '正文',
    level: level || 2,
    startLine,
    content,
    charCount: content.replace(/\s/g, '').length,
  };
}

/** 没有任何标题时，按行数均匀切分，保证仍可跳章 */
export function fallbackSplit(text, linesPerChapter = DEFAULT_SPLIT_OPTIONS.fallbackLines) {
  const lines = text.split('\n');
  const chapters = [];
  const size = Math.max(20, linesPerChapter);
  for (let i = 0; i < lines.length; i += size) {
    const slice = lines.slice(i, i + size);
    const firstText = slice.find((l) => l.trim()) || '';
    const hint = firstText.trim().slice(0, 16);
    chapters.push(
      makeChapter(`第${chapters.length + 1}节${hint ? ` ${hint}…` : ''}`, slice, 2, i),
    );
  }
  return chapters.length ? chapters : [makeChapter('正文', lines, 2, 0)];
}

/**
 * 主入口：把整本文本切成章节数组。
 * @returns {{chapters: Array, ruleIds: string[], usedFallback: boolean}}
 */
export function splitChapters(text, options = {}) {
  const opts = { ...DEFAULT_SPLIT_OPTIONS, ...options };
  const rules = compileRules(opts);
  const lines = text.split('\n');
  const chapters = [];

  if (rules.length) {
    let buffer = [];
    let title = null;
    let level = 2;
    let start = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      let matched = null;
      if (plausibleTitle(line, opts.maxTitleLength)) {
        matched = rules.find((r) => r.re.test(line)) || null;
      }
      if (matched) {
        if (title !== null || buffer.some((l) => l.trim())) {
          chapters.push(makeChapter(title === null ? '开篇' : title, buffer, title === null ? 2 : level, start));
        }
        title = line;
        level = matched.level;
        start = i;
        buffer = [];
      } else {
        buffer.push(lines[i]);
      }
    }
    if (title !== null || buffer.some((l) => l.trim())) {
      chapters.push(makeChapter(title === null ? '正文' : title, buffer, title === null ? 2 : level, start));
    }
  }

  const realChapters = chapters.filter((c) => c.charCount > 0 || c.level === 1);
  if (realChapters.length >= 2) {
    const repair = opts.repairMissing
      ? repairChapters(realChapters, opts)
      : { chapters: realChapters, inserted: 0, filled: [], stillMissing: [] };
    return {
      chapters: repair.chapters,
      ruleIds: rules.map((r) => r.id),
      usedFallback: false,
      repair: { inserted: repair.inserted, filled: repair.filled, stillMissing: repair.stillMissing },
    };
  }
  if (opts.autoFallback) {
    return {
      chapters: fallbackSplit(text, opts.fallbackLines),
      ruleIds: [],
      usedFallback: true,
      repair: { inserted: 0, filled: [], stillMissing: [] },
    };
  }
  return {
    chapters: realChapters.length ? realChapters : [makeChapter('正文', lines, 2, 0)],
    ruleIds: rules.map((r) => r.id),
    usedFallback: false,
    repair: { inserted: 0, filled: [], stillMissing: [] },
  };
}

/* =========================================================
 * 章节号解析 与 缺章补切
 * 场景：整本大部分章节用「第123章」，个别章节写成「123」「(123)」「第123節」等
 * 其它写法，没被主规则匹配到，于是那几章被并进了上一章里。
 * 这里按章节号的连续性找出缺口，再用宽松规则回到正文里把它们切出来。
 * =======================================================*/

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 壹: 1, 二: 2, 贰: 2, 两: 2, 三: 3, 叁: 3, 四: 4, 肆: 4, 五: 5, 伍: 5, 六: 6, 陆: 6, 七: 7, 柒: 7, 八: 8, 捌: 8, 九: 9, 玖: 9 };
const CN_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000 };
// 数字后面跟这些字，多半是"2008年""三十岁"这类正文，不是章节号
const NOT_CHAPTER_SUFFIX = /^[年月日号时分秒岁个人只条种次件元米克斤章回话節节]?[年月日号时分秒岁]/;

/** 中文 / 全角 / 阿拉伯数字 → 整数，无法解析返回 null */
export function cnToNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const half = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (/^[0-9]{1,6}$/.test(half)) return Number(half);
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      num = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const unit = CN_UNITS[ch];
      if (unit === 10000) {
        section = (section + num) * unit;
        total += section;
        section = 0;
      } else {
        section += (num === 0 ? 1 : num) * unit;
      }
      num = 0;
    } else {
      return null;
    }
  }
  const value = total + section + num;
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 从标题行里解析章节号（标准写法） */
export function parseChapterNumber(title) {
  const text = (title || '').trim();
  if (!text) return null;
  let m = text.match(/第\s*([0-9０-９零〇一二三四五六七八九十百千两万壹贰叁肆伍陆柒捌玖拾佰仟]{1,12})\s*[章节節回话話集幕折]/);
  if (m) return cnToNumber(m[1]);
  m = text.match(/^(?:chapter|chap\.?|part|episode|section)\s*([0-9]{1,6})\b/i);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 宽松解析：这一行"看起来是第几章"。
 * 覆盖 `123`、`123.`、`(123)`、`【123】`、`123 标题`、`第123節`、`一二三、标题` 等写法。
 */
export function looseChapterNumber(line, maxTitleLength = 60) {
  const text = (line || '').trim();
  if (!text || text.length > maxTitleLength) return null;
  const strict = parseChapterNumber(text);
  if (strict != null) return strict;

  const body = text.replace(/^[\s　（(【\[「『<《]+/, '').replace(/^第/, '');
  let m = body.match(/^([0-9０-９]{1,6})\s*(?:[章节節回话話集幕折])?\s*([)）】\]」』>》]|[、.．,，:：\-—–~～]|\s|$)(.*)$/);
  if (m) {
    const rest = `${m[2] || ''}${m[3] || ''}`.trim();
    if (NOT_CHAPTER_SUFFIX.test(rest)) return null;
    return cnToNumber(m[1]);
  }
  m = body.match(/^([零〇一二三四五六七八九十百千两壹贰叁肆伍陆柒捌玖拾佰仟]{1,10})\s*(?:[章节節回话話集幕折])?\s*(?:[)）】\]」』]|[、.．,，:：\-—–]|\s|$)/);
  if (m) return cnToNumber(m[1]);
  return null;
}

/** 用于排版时保护"没被规则识别出来的疑似标题行"，避免被合并进正文 */
export function looksLikeLooseHeading(line, maxTitleLength = 40) {
  const text = (line || '').trim();
  if (!text || text.length > maxTitleLength) return false;
  if (/[。！？；]$/.test(text)) return false;
  if (/["“”]/.test(text)) return false;
  return looseChapterNumber(text, maxTitleLength) != null;
}

function sliceChapter(source, lines, from, to, title, level, repaired) {
  const chapter = makeChapter(title, lines.slice(from, to), level, (source.startLine || 0) + from);
  if (repaired) chapter.repaired = true;
  return chapter;
}

/**
 * 在一章正文里找出这些章节号对应的标题行，并切成多章。
 * @returns {{parts: Array, found: number[]}}
 */
function splitByMissingNumbers(chapter, wanted, maxTitleLength) {
  const lines = chapter.content.split('\n');
  const boundaries = [];
  let k = 0;
  for (let i = 0; i < lines.length && k < wanted.length; i += 1) {
    const num = looseChapterNumber(lines[i], maxTitleLength);
    if (num == null) continue;
    if (num === wanted[k]) {
      boundaries.push({ line: i, num, title: lines[i].trim() });
      k += 1;
    }
  }
  if (!boundaries.length) return { parts: [chapter], found: [] };

  const parts = [];
  const head = sliceChapter(chapter, lines, 0, boundaries[0].line, chapter.title, chapter.level, false);
  parts.push(head);
  for (let b = 0; b < boundaries.length; b += 1) {
    const start = boundaries[b].line;
    const end = b + 1 < boundaries.length ? boundaries[b + 1].line : lines.length;
    parts.push(sliceChapter(chapter, lines, start + 1, end, boundaries[b].title, 2, true));
  }
  return { parts, found: boundaries.map((b) => b.num) };
}

/**
 * 按章节号连续性修复缺章。
 * @param {Array} chapters splitChapters 的结果
 * @returns {{chapters: Array, inserted: number, filled: number[], stillMissing: number[]}}
 */
export function repairChapters(chapters, options = {}) {
  const opts = { ...DEFAULT_SPLIT_OPTIONS, ...options };
  const maxTitleLength = Math.max(opts.maxTitleLength || 40, 60);
  const maxGap = opts.repairMaxGap || 100;
  const seqs = chapters.map((c) => (c.level === 1 ? null : parseChapterNumber(c.title)));
  const out = [];
  const filled = [];
  const stillMissing = [];

  for (let i = 0; i < chapters.length; i += 1) {
    const chapter = chapters[i];
    const seq = seqs[i];
    if (seq == null) { out.push(chapter); continue; }

    let j = i + 1;
    while (j < chapters.length && seqs[j] == null) j += 1;
    const nextSeq = j < chapters.length ? seqs[j] : null;
    if (nextSeq == null || nextSeq - seq <= 1 || nextSeq - seq > maxGap) { out.push(chapter); continue; }

    const wanted = [];
    for (let n = seq + 1; n < nextSeq; n += 1) wanted.push(n);
    const { parts, found } = splitByMissingNumbers(chapter, wanted, maxTitleLength);
    out.push(...parts);
    filled.push(...found);
    for (const n of wanted) if (!found.includes(n)) stillMissing.push(n);
  }

  return {
    chapters: out,
    inserted: out.length - chapters.length,
    filled,
    stillMissing,
  };
}
