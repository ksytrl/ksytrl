/**
 * 纯逻辑单元测试（不依赖浏览器）：node tests/run-tests.mjs
 */
import { readFile } from 'node:fs/promises';
import { cleanText, isGarbledLine, tryFixMojibake, cleanBookTitle } from '../src/cleaner.js';
import {
  splitChapters, suggestRuleIds, analyzeRules, fallbackSplit,
  cnToNumber, parseChapterNumber, looseChapterNumber,
} from '../src/chapters.js';
import { decodeBuffer, scoreText } from '../src/encoding.js';
import { parseEpub, htmlToText } from '../src/formats/epub.js';
import { parsePdf, stripRunningHeads } from '../src/formats/pdf.js';
import {
  readDocx, readFb2, readHtml, readMarkdown, readRtf, readMobi, groupOf, FORMAT_GROUPS,
} from '../src/formats/readers.js';

const readBuffer = async (path) => {
  const buf = await readFile(new URL(path, import.meta.url));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

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

/* ---------- 缺章补切 ---------- */
group('缺章补切（章节号连号校验）');
{
  check('中文数字解析', cnToNumber('一百二十三') === 123 && cnToNumber('十') === 10 && cnToNumber('１２３') === 123);
  check('标准标题取章节号', parseChapterNumber('第一百二十三章 归途') === 123 && parseChapterNumber('Chapter 689') === 689);
  const loose = ['123', '(123)', '【123】', '123、标题', '第123節 标题', '123 标题'];
  check('宽松写法都能认出章节号', loose.every((l) => looseChapterNumber(l) === 123), JSON.stringify(loose.map(looseChapterNumber)));
  check('普通正文不会被当成章节号', looseChapterNumber('2008年的那个夏天') == null);

  // 第 3、4、5 章换了写法，主规则识别不到
  const text = [
    '第1章 甲', '正文一', '第2章 乙', '正文二',
    '3', '正文三', '(4)', '正文四', '5、换了写法', '正文五',
    '第6章 丙', '正文六',
  ].join('\n');
  const repaired = splitChapters(text, { ruleIds: ['cn-chapter'] });
  check('漏掉的章被补回来', repaired.chapters.length === 6, JSON.stringify(repaired.chapters.map((c) => c.title)));
  check('补章统计正确', repaired.repair.inserted === 3 && repaired.repair.filled.join() === '3,4,5', JSON.stringify(repaired.repair));
  check('补出来的章有正文', repaired.chapters[2].content.includes('正文三'), JSON.stringify(repaired.chapters[2]));
  const off = splitChapters(text, { ruleIds: ['cn-chapter'], repairMissing: false });
  check('可以关掉补章', off.chapters.length === 3, JSON.stringify(off.chapters.map((c) => c.title)));

  const gap = splitChapters(['第1章 甲', '正文', '第4章 丁', '正文'].join('\n'), { ruleIds: ['cn-chapter'] });
  check('正文里真的没有就如实报告缺章', gap.repair.stillMissing.join() === '2,3', JSON.stringify(gap.repair));
}

/* ---------- 书名清洗 ---------- */
group('书名清洗');
{
  const cases = [
    ['盘龙(www.biquge.com)【完结】.txt', '盘龙'],
    ['【笔趣阁 www.biquge.cc】斗破苍穹.txt', '斗破苍穹'],
    ['诡秘之主_精校版_www.xxx.net.txt', '诡秘之主'],
    ['雪中悍刀行（顶点小说网）全本txt下载', '雪中悍刀行'],
    ['凡人修仙传.epub', '凡人修仙传'],
    ['庆余年（猫腻）', '庆余年（猫腻）'],
  ];
  for (const [input, expect] of cases) {
    check(`${input} → ${expect}`, cleanBookTitle(input) === expect, cleanBookTitle(input));
  }
}

/* ---------- EPUB ---------- */
group('EPUB 解析');
{
  const epub = await parseEpub(await readBuffer('../samples/sample.epub'));
  check('读到书名与作者', epub.title.includes('夜行记') && epub.author === '佚名', JSON.stringify(epub.title));
  check('自带目录 3 章', epub.chapters.length === 3, JSON.stringify(epub.chapters.map((c) => c.title)));
  check('章节标题来自 toc.ncx', epub.chapters[0].title === '第一章 初遇', epub.chapters[0].title);
  check('正文不重复标题', !epub.chapters[0].content.startsWith('第一章'), JSON.stringify(epub.chapters[0].content.slice(0, 20)));
  check('书名清洗后干净', cleanBookTitle(epub.title) === '夜行记', cleanBookTitle(epub.title));
  check('HTML 转文本', htmlToText('<p>甲</p><p>乙&amp;丙</p>') === '甲\n乙&丙', JSON.stringify(htmlToText('<p>甲</p><p>乙&amp;丙</p>')));

  // 真实电子书里的常见变体
  const ns = await parseEpub(await readBuffer('../samples/sample-namespaced.epub'));
  check('带命名空间前缀的 EPUB（<opf:item> / <ncx:navPoint>）', ns.chapters.length === 3 && ns.title === '命名空间测试', JSON.stringify({ n: ns.chapters.length, t: ns.title }));
  const epub3 = await parseEpub(await readBuffer('../samples/sample-epub3.epub'));
  check('EPUB3 的 nav 目录 + 带 %20 的路径', epub3.chapters.length === 3 && epub3.chapters[1].title === '第二章 刀光', JSON.stringify(epub3.chapters.map((c) => c.title)));
  const single = await parseEpub(await readBuffer('../samples/sample-single-doc.epub'));
  check('整本只有一个 xhtml 时也能读到正文', single.chapters.length === 1 && single.chapters[0].content.includes('第三章 归途'), JSON.stringify(single.chapters.map((c) => c.content.length)));
  const singleSplit = splitChapters(cleanText(single.text, {}, { ruleIds: ['cn-chapter'] }).text, { ruleIds: ['cn-chapter'] });
  check('单文件 EPUB 可以按规则切出 3 章', singleSplit.chapters.length === 3, JSON.stringify(singleSplit.chapters.map((c) => c.title)));
}

/* ---------- PDF ---------- */
group('PDF 解析');
{
  const pdf = await parsePdf(await readBuffer('../samples/sample.pdf'));
  check('提取到 3 页', pdf.pages.length === 3, String(pdf.pages.length));
  check('中文正文提取正确', pdf.text.includes('夜色沉沉，他在林间遇见了那个人'), JSON.stringify(pdf.text.slice(0, 60)));
  const chapters = splitChapters(cleanText(pdf.text, {}, { ruleIds: ['cn-chapter'] }).text, { ruleIds: ['cn-chapter'] });
  check('PDF 文本可以正常分章', chapters.chapters.length === 3, JSON.stringify(chapters.chapters.map((c) => c.title)));

  // 带页眉页脚的 PDF：书名页眉和页码都不该混进正文（页码会被误当成章节号）
  const withHeads = await parsePdf(await readBuffer('../samples/sample-with-headers.pdf'));
  check('去掉重复页眉', !withHeads.text.includes('精校版'), JSON.stringify(withHeads.text.slice(0, 60)));
  check('去掉孤立页码行', !withHeads.text.split('\n').some((l) => /^\s*\d{1,3}\s*$/.test(l)), '');
  check('正文没被误删', withHeads.text.includes('用来验证提取效果'), '');
  // 现代 PDF 普遍把对象压进"对象流"，这条以前会直接抛错
  const objstm = await parsePdf(await readBuffer('../samples/sample-objstm.pdf'));
  check('对象流(ObjStm) + 交叉引用流的 PDF', objstm.text.includes('Chapter One') && objstm.text.includes('object stream'), JSON.stringify(objstm.text.slice(0, 60)));

  const heads = stripRunningHeads(['书名\n正文甲\n1', '书名\n正文乙\n2', '书名\n正文丙\n3', '书名\n正文丁\n4']);
  check('stripRunningHeads 直接调用', heads.join('|') === '正文甲|正文乙|正文丙|正文丁', JSON.stringify(heads));
}

/* ---------- 其它格式 ---------- */
group('更多格式（MOBI / DOCX / HTML / Markdown / FB2 / RTF）');
{
  const docx = await readDocx(await readBuffer('../samples/sample.docx'));
  check('DOCX 提取正文', docx.text.includes('第一章 初遇') && docx.text.includes('多年以后'), JSON.stringify(docx.text.slice(0, 30)));

  const fb2 = readFb2(await readBuffer('../samples/sample.fb2'));
  check('FB2（GBK 编码）提取正文与书名', fb2.title === '夜行记' && fb2.text.includes('刀光一闪'), JSON.stringify({ t: fb2.title, s: fb2.text.slice(0, 20) }));

  const html = readHtml(await readBuffer('../samples/sample.html'));
  check('HTML 提取正文与标题', html.title === '夜行记' && html.text.includes('第二章 刀光'), JSON.stringify(html.title));

  const md = readMarkdown(await readBuffer('../samples/sample.md'));
  check('Markdown 去掉标记保留正文', !md.text.includes('##') && md.text.includes('第三章 归途'), JSON.stringify(md.text.slice(0, 30)));

  const rtf = readRtf(await readBuffer('../samples/sample.rtf'));
  check('RTF（GBK 码页）还原中文', rtf.text.includes('夜色沉沉') && rtf.text.includes('第三章 归途'), JSON.stringify(rtf.text.slice(0, 30)));

  const mobi = readMobi(await readBuffer('../samples/sample.mobi'));
  check('MOBI 提取正文', mobi.text.includes('第一章 初遇') && mobi.text.includes('血溅在雪地上'), JSON.stringify(mobi.text.slice(0, 30)));

  check('分栏只认自己的扩展名',
    groupOf('a.pdf').id === 'pdf' && groupOf('a.epub').id === 'epub'
    && groupOf('a.txt').id === 'txt' && groupOf('a.mobi').id === 'other' && groupOf('a.zip') === null,
    JSON.stringify(FORMAT_GROUPS.map((g) => g.id)));
}

console.log(results.join('\n'));
console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
