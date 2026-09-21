# 第三方库（vendored）

这里放的是直接打包进项目的第三方库，都取自官方发布版本，未做修改。

| 目录 | 库 | 版本 | 来源 | 许可证 |
| --- | --- | --- | --- | --- |
| `pdfjs/` | [pdf.js](https://github.com/mozilla/pdf.js)（`pdfjs-dist` UMD 构建） | 3.11.174 | Mozilla | Apache-2.0 |
| `jszip/` | [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | Stuk | MIT / GPLv3 |

用途：

- **pdf.js** —— PDF 正文提取。浏览器里最成熟的 PDF 实现，能处理加密（空口令）、
  各种字体编码、对象流、损坏文件容错等我们自己实现不了的情况。项目里保留的
  `src/formats/pdf.js`（自研最小解析器）作为兜底，pdf.js 加载失败时仍可用。
- **JSZip** —— EPUB / DOCX 的 ZIP 解包。比我们自己基于 DecompressionStream 的实现
  更宽容（ZIP64、各种压缩方式、损坏目录项），同样保留自研实现作为兜底。

更新方式：`npm pack pdfjs-dist@<版本>` / `npm pack jszip@<版本>`，取出 `build/` 或
`dist/` 下对应文件替换即可，不要手改。
