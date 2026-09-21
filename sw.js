/* 清风阅读 Service Worker：应用外壳离线可用；书籍本身存在 IndexedDB，本来就是离线的 */
const VERSION = 'v4';
const CACHE = `qingfeng-reader-${VERSION}`;
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/style.css',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './src/app.js',
  './src/store.js',
  './src/cleaner.js',
  './src/chapters.js',
  './src/encoding.js',
  './src/formats/zip.js',
  './src/formats/vendor.js',
  './src/formats/epub.js',
  './src/formats/pdf.js',
  './src/formats/readers.js',
  './vendor/jszip/jszip.min.js',
  './vendor/pdfjs/pdf.min.js',
  './vendor/pdfjs/pdf.worker.min.js',
  './vendor/tesseract/tesseract.min.js',
  './vendor/tesseract/worker.min.js',
  './src/formats/ocr.js',
  './src/tts.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => Promise.all(
        // 个别文件失败时不要整体装不上
        SHELL.map((url) => cache.add(url).catch(() => null)),
      )))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// OCR 的 wasm 内核和语言包体积很大（合计约 5MB），不进 SW 缓存，
// 交给浏览器自身的 HTTP 缓存，避免装一次应用就占掉几 MB 配额。
const SKIP_CACHE = /\/vendor\/tesseract\/(tesseract-core|lang\/)/;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (SKIP_CACHE.test(url.pathname)) return;

  // 页面导航：优先网络，断网时回落到缓存的首页
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./'))),
    );
    return;
  }

  // 其它同源资源：缓存优先，同时后台更新
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
