/**
 * 纯逻辑单元测试（不依赖浏览器）：node tests/run-tests.mjs
 */
import { cleanText, isGarbledLine, tryFixMojibake } from '../src/cleaner.js';
import { splitChapters, suggestRuleIds, analyzeRules, fallbackSplit } from '../src/chapters.js';
import { decodeBuffer, scoreText } from '../src/encoding.js';

let passed = 0;
let failed = 0;
const results = [];

function check(name, cond, detail) {
  if (cond) { passed += 1; results.push(`  ✓ ${name}`); }
  else { failed += 1; results.push(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function group(name) { results.push(`\n${name}`); }

/* ---------- 网址清理 ---------- */
group('删除网址');
{
  const cases = [
    ['请访问 http://www.biquge.com/book/1.html 阅读', 'http 链接'],
    ['www.piaotian.net 最新章节', 'www 域名'],
    ['ｗｗｗ．ｄｉｎｇｄｉａｎ．ｃｏｍ', '全角域名'],
    ['本站 piaotian点com 首发', '点 混淆'],
    ['w w w . 8 1 z w . c o m', '空格混淆'],
    ['联系邮箱 admin@example.org 投稿', '邮箱'],
    ['盗版请到 shubaow.cc/12/ 看', '裸域名+路径'],
  ];
  for (const [line, label] of cases) {
    const { text } = cleanText(line, { mergeWrappedLines: false }, {});
    const hasUrl = /(https?:\/\/|www\.|＠|@|点com|[a-z0-9-]+\.(?:com|net|cc|org))/i.test(text);
    check(`${label}：${line}`, !hasUrl, `清洗后仍有网址 → ${JSON.stringify(text)}`);
  }
  const keep = cleanText('他说：“3.5 秒内跑完 100 米。”', {}, {}).text;
  check('不误删普通小数', keep.includes('3.5'), keep);
}

/* ---------- 广告 / 乱码 ---------- */
group('删除广告与乱码');
{
  const raw = [
    '第一章 起点',
    '一秒记住【顶点小说】，为您提供精彩阅读。',
    '正文第一段内容在这里。',
    '锟斤拷锟斤拷锟斤拷',
    '================',
    'ÐÐ¾Ð±ÑÐ¾',
    '正文第二段内容在这里。',
  ].join('\n');
  const { text, stats } = cleanText(raw, {}, { ruleIds: ['cn-chapter'] });
  check('广告行被删除', !text.includes('一秒记住'), text);
  check('锟斤拷乱码被删除', !text.includes('锟斤拷'), text);
  check('分隔线被删除', !text.includes('===='), text);
  check('正文保留', text.includes('正文第一段内容在这里。') && text.includes('正文第二段内容在这里。'), text);
  check('标题保留', text.includes('第一章 起点'), text);
  check('统计有记录', stats.adLines >= 2 && stats.garbledLines >= 1, JSON.stringify(stats));

  check('乱码判定', isGarbledLine('烫烫烫烫烫烫') && !isGarbledLine('这是一段正常的中文。'));
  // 用真实字节构造"UTF-8 被当成 Latin-1 读"的乱码
  const mojibake = new TextDecoder('latin1').decode(new TextEncoder().encode('你好'));
  check('可还原乱码修复', tryFixMojibake(mojibake) === '你好', `${mojibake} → ${tryFixMojibake(mojibake)}`);
}

/* ---------- 排版 ---------- */
group('自动排版');
{
  const body = [];
  body.push('第一章 测试');
  for (let i = 0; i < 12; i += 1) {
    body.push('这是一段被硬换行截断的正文内容它足够长所以会被切开继续');
    body.push('后半句在这里结束了。');
    body.push('');
    body.push('');
  }
  const { text, stats } = cleanText(body.join('\n'), {}, { ruleIds: ['cn-chapter'] });
  check('硬换行被合并', stats.mergedLines > 0, JSON.stringify(stats));
  check('段首缩进', text.split('\n').filter((l) => l.trim()).slice(1).every((l) => l.startsWith('　　')), text.slice(0, 120));
  check('空行被压缩', !/\n\n\n/.test(text));
  const noIndent = cleanText('第一章 测试\n正文。', { indentParagraphs: false }, { ruleIds: ['cn-chapter'] }).text;
  check('可关闭缩进', noIndent === '第一章 测试\n正文。', JSON.stringify(noIndent));
}

/* ---------- 分章 ---------- */
group('章节划分');
{
  const samples = {
    '第N章': '第一章 开端\n甲\n第二章 发展\n乙\n第三章 结局\n丙',
    '第N回': '第一回 楔子\n甲\n第二回 上路\n乙\n第三回 归来\n丙',
    '卷+章': '第一卷 少年\n第1章 开端\n甲\n第2章 发展\n乙\n第二卷 青年\n第3章 远行\n丙',
    '特殊章': '楔子\n甲\n第一章 开端\n乙\n番外 后日谈\n丙',
    'Chapter': 'Chapter 1 Dawn\naaa\nChapter 2 Noon\nbbb\nChapter 3 Dusk\nccc',
    '编号标题': '一、开端\n甲\n二、发展\n乙\n三、结局\n丙',
    '括号编号': '（一）开端\n甲\n（二）发展\n乙\n（三）结局\n丙',
    '符号标题': '★ 开端 ★\n甲\n★ 发展 ★\n乙\n★ 结局 ★\n丙',
  };
  for (const [label, text] of Object.entries(samples)) {
    const ids = suggestRuleIds(text);
    const { chapters } = splitChapters(text, { ruleIds: ids });
    check(`${label} → 自动识别出 ${chapters.length} 章`, chapters.length >= 3, `规则=${ids} 结果=${chapters.map((c) => c.title)}`);
  }

  const vol = splitChapters(samples['卷+章'], { ruleIds: suggestRuleIds(samples['卷+章']) }).chapters;
  check('卷标题层级为 1', vol[0].level === 1 && vol[0].title === '第一卷 少年', JSON.stringify(vol.map((c) => [c.title, c.level])));

  const custom = splitChapters('※卷首※\n甲\n※卷中※\n乙', { ruleIds: [], customPattern: '^※.+※$' }).chapters;
  check('自定义正则生效', custom.length === 2, JSON.stringify(custom.map((c) => c.title)));

  const noTitle = Array.from({ length: 900 }, (_, i) => `这是第 ${i} 行普通内容。`).join('\n');
  const fb = splitChapters(noTitle, { ruleIds: ['cn-chapter'], fallbackLines: 300 });
  check('无标题时按行数分章', fb.usedFallback && fb.chapters.length === 3, JSON.stringify({ n: fb.chapters.length, fb: fb.usedFallback }));
  check('fallbackSplit 至少一章', fallbackSplit('abc').length === 1);

  const stats = analyzeRules(samples['第N章']);
  check('规则统计可用', stats.find((s) => s.id === 'cn-chapter').count === 3, JSON.stringify(stats.filter((s) => s.count)));

  const dialogue = splitChapters('第一章 开始\n他说：“第二章不算章节标题。”\n结束。', { ruleIds: ['cn-chapter'] }).chapters;
  check('对话中的"第二章"不误判', dialogue.length === 1, JSON.stringify(dialogue.map((c) => c.title)));
}

/* ---------- 编码 ---------- */
group('编码识别');
{
  const utf8 = new TextEncoder().encode('第一章 你好，世界。');
  check('UTF-8 识别', decodeBuffer(utf8.buffer).encoding === 'utf-8');
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  const d = decodeBuffer(bom.buffer);
  check('UTF-8 BOM 去除', d.text.startsWith('第一章'), JSON.stringify(d.text.slice(0, 5)));
  // GBK 的"中文"= D6 D0 CE C4，在 UTF-8 下不合法
  const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xb2, 0xe2, 0xca, 0xd4]);
  const g = decodeBuffer(gbk.buffer);
  check('GBK 识别', g.encoding === 'gb18030' && g.text.startsWith('中文'), JSON.stringify(g));
  check('打分函数偏好可读文本', scoreText('正常的中文内容') < scoreText('锟斤拷锟斤拷'), '');
}

console.log(results.join('\n'));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
