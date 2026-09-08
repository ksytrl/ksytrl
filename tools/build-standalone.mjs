/**
 * 把 index.html + assets/style.css + src/*.js 打包成一个单文件 HTML，
 * 双击即可离线使用（file:// 下 ES module 会被浏览器拦截，所以这里转成普通脚本）。
 * 用法：node tools/build-standalone.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

// 依赖顺序：被依赖的排前面
const MODULES = [
  'src/encoding.js',
  'src/chapters.js',
  'src/cleaner.js',
  'src/formats/zip.js',
  'src/formats/epub.js',
  'src/formats/pdf.js',
  'src/store.js',
  'src/app.js',
];

const stripModuleSyntax = (code) => code
  .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];\s*$/gm, '')
  .replace(/^export\s+/gm, '');

const script = MODULES
  .map((file) => `/* ===== ${file} ===== */\n${stripModuleSyntax(read(file))}`)
  .join('\n\n');

const html = read('index.html')
  .replace('<link rel="manifest" href="manifest.webmanifest">', '')
  .replace('<link rel="apple-touch-icon" href="assets/icon-192.png">', '')
  // 用函数式 replacement，避免代码里的 $& / $1 被当成替换模式
  .replace('<link rel="stylesheet" href="assets/style.css">', () => `<style>\n${read('assets/style.css')}\n</style>`)
  .replace(
    '<script type="module" src="src/app.js"></script>',
    () => `<script>\n(function () {\n'use strict';\n${script}\n})();\n</scr` + `ipt>`,
  );

mkdirSync(resolve(root, 'dist'), { recursive: true });
const out = resolve(root, 'dist/novel-reader.html');
writeFileSync(out, html, 'utf8');
console.log(`已生成 ${out}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
