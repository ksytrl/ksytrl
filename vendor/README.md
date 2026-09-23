# 第三方库（vendored）

这里放的是直接打包进项目的第三方库，都取自官方发布版本，未做修改。

| 目录 | 库 | 版本 | 来源 | 许可证 |
| --- | --- | --- | --- | --- |
| `pdfjs/` | [pdf.js](https://github.com/mozilla/pdf.js)（`pdfjs-dist` UMD 构建） | 3.11.174 | Mozilla | Apache-2.0 |
| `jszip/` | [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | Stuk | MIT / GPLv3 |
| `tesseract/` | [tesseract.js](https://github.com/naptha/tesseract.js) + `tesseract.js-core` | 5.1.1 | naptha | Apache-2.0 |
| `tesseract/lang/` | [tessdata](https://github.com/tesseract-ocr/tessdata) `chi_sim`（`4.0.0_best_int` 量化版，1.7 MB） | 4.0.0 | Google / tesseract-ocr | Apache-2.0 |

用途：

- **pdf.js** —— PDF 正文提取。浏览器里最成熟的 PDF 实现，能处理加密（空口令）、
  各种字体编码、对象流、损坏文件容错等我们自己实现不了的情况。项目里保留的
  `src/formats/pdf.js`（自研最小解析器）作为兜底，pdf.js 加载失败时仍可用。
- **JSZip** —— EPUB / DOCX 的 ZIP 解包。比我们自己基于 DecompressionStream 的实现
  更宽容（ZIP64、各种压缩方式、损坏目录项），同样保留自研实现作为兜底。

- **tesseract.js** —— 扫描版 PDF 的 OCR。页面先用 pdf.js 渲染成图，再交给它识别。
  只保留 SIMD + LSTM 的 wasm 内核（`tesseract-core-simd-lstm.wasm.js`，3.9 MB）以控制体积；
  简体中文语言包随仓库自带，可离线用，繁体 / 英文按需从 CDN 取。

更新方式：`npm pack pdfjs-dist@<版本>` / `npm pack jszip@<版本>` /
`npm pack tesseract.js@<版本>` / `npm pack tesseract.js-core@<版本>` /
`npm pack @tesseract.js-data/chi_sim`，取出 `build/`、`dist/` 或 `4.0.0_best_int/`
下对应文件替换即可，不要手改。
