# universe-pdf

在编辑器里预览 `.pdf` 文件的扩展——市场里第一个基于 **webview / 自定义编辑器** 的扩展。
移植自 [vscode-pdf](https://github.com/tomoki1207/vscode-pdf)（Apache-2.0），把 `import "vscode"`
换成 `@universe-editor/extension-api`，通过 `window.registerCustomEditorProvider` 注册一个
`pdf.view` 自定义编辑器，用 Mozilla pdf.js 渲染。

这个扩展**不在 pnpm workspace 内**（它以 `.vsix` 形态经市场安装链路落地，而非内置扩展），
所以没有本地 `node_modules`：构建脚本从仓库根借用 workspace 里已装好的 esbuild / adm-zip。

## 目录

```
src/extension.ts          扩展入口（activate 里注册自定义编辑器）
assets/                   pdf.js 产物 + main.mjs/main.css（≈19MB，运行时经 asWebviewUri 加载，不打进 bundle）
esbuild.config.mjs        打包 src → dist/extension.js（.html 走 text loader 内联 viewer.html）
scripts/pack.mjs          把 package.json + icon.png + dist/ + assets/ 压成 extension/** 结构的 .vsix
```

## 构建 & 打包

```bash
# 前置：packages/extension-api 已构建出 dist（pnpm build 会做）
cd extensions-external/pdf
node esbuild.config.mjs     # → dist/extension.js
node scripts/pack.mjs       # → universe.universe-pdf-0.1.0.vsix
```

## 安装

命令面板运行 **扩展: 从 VSIX 安装…**（*Extensions: Install from VSIX…*），选中生成的 `.vsix`。
安装后双击任意 `.pdf` 即在标签页里渲染。

## 与上游的差异

- 去掉了 `workspace.createFileSystemWatcher` 依赖的「文件变更自动重载」——当前扩展 API 尚无文件监听能力。
- 资源经 `webview.asWebviewUri` + `localResourceRoots`（扩展目录）加载，CSP 由扩展在 HTML 里声明。
