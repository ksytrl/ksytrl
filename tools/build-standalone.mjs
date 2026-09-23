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
  'src/media.js',
  'src/encoding.js',
  'src/chapters.js',
  'src/cleaner.js',
  'src/cover.js',
  'src/formats/zip.js',
  'src/formats/vendor.js',
  'src/formats/epub.js',
  'src/formats/pdf.js',
  'src/formats/readers.js',
  'src/formats/ocr.js',
  'src/text-analyze.js',
  'src/text-engine.js',
  'src/tts.js',
  'src/loader.js',
  'src/wait-game.js',
  'src/store.js',
  'src/app.js',
];

// 第三方库：以 <script type="text/plain"> 内联进页面，运行时转成 blob URL 加载
const VENDOR = [
  ['vendor-jszip', 'vendor/jszip/jszip.min.js'],
  ['vendor-pdfjs', 'vendor/pdfjs/pdf.min.js'],
  ['vendor-pdfjs-worker', 'vendor/pdfjs/pdf.worker.min.js'],
  ['vendor-tesseract', 'vendor/tesseract/tesseract.min.js'],
];

// 后台线程（清洗 / 分章）：把它依赖的几个模块拼成一个普通脚本，运行时用 blob URL 起 Worker
const WORKER_MODULES = ['src/media.js', 'src/chapters.js', 'src/cleaner.js', 'src/text-analyze.js', 'src/text-worker.js'];
const workerSource = () => WORKER_MODULES
  .map((file) => `/* ===== ${file} ===== */\n${stripModuleSyntax(read(file))}`)
  .join('\n\n')
  .replace(/<\/script/gi, '<\\/script');

const vendorBlocks = () => VENDOR.map(([id, file]) => {
  const src = read(file).replace(/<\/script/gi, '<\\/script');
  return `<script type="text/plain" id="${id}">\n${src}\n</scr` + 'ipt>';
}).join('\n');

const stripModuleSyntax = (code) => code
  .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];\s*$/gm, '')
  .replace(/^export\s+/gm, '');

const script = MODULES
  .map((file) => `/* ===== ${file} ===== */\n${stripModuleSyntax(read(file))}`)
  .join('\n\n');

const html = read('index.html')
  // 单文件版没有 vendor 目录：OCR 的识别引擎与语言包改从 CDN 取
  .replace("window.__NR_ASSETS = { base: 'vendor/' };", 'window.__NR_ASSETS = { base: null };')
  .replace('<link rel="manifest" href="manifest.webmanifest">', '')
  .replace('<link rel="apple-touch-icon" href="assets/icon-192.png">', '')
  // 用函数式 replacement，避免代码里的 $& / $1 被当成替换模式
  .replace('<link rel="stylesheet" href="assets/style.css">', () => `<style>\n${read('assets/style.css')}\n</style>`)
  .replace(
    '<script type="module" src="src/app.js"></script>',
    () => `${vendorBlocks()}\n<script type="text/plain" id="text-worker-src">\n${workerSource()}\n</scr` + `ipt>\n<script>\n(function () {\n'use strict';\n${script}\n})();\n</scr` + `ipt>`,
  );

mkdirSync(resolve(root, 'dist'), { recursive: true });
const out = resolve(root, 'dist/novel-reader.html');
writeFileSync(out, html, 'utf8');
console.log(`已生成 ${out}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
