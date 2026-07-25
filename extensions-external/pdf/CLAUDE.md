# extensions-external/pdf/CLAUDE.md

PDF 预览扩展——webview / 自定义编辑器预览的**范例扩展**，写任何新预览扩展（3D、音视频、CSV、自定义二进制格式…）都照抄它。webview 基建（五层架构、iframe/CSP/焦点全部已知坑）见 `apps/editor/src/renderer/workbench/webview/CLAUDE.md`——做 webview 相关改动前先读它建立基建认知。

## 写一个新预览扩展（最常见任务）：照抄本目录

新预览扩展**故意放在 pnpm workspace 外**（`extensions-external/<name>/`），因为它以 .vsix 形态经市场链路装进 restricted host，不是内置扩展（workspace globs 只含 `apps/*`/`packages/*`/`extensions/*`）。骨架：

```
extensions-external/<name>/
  src/extension.ts        activate 里 window.registerCustomEditorProvider(viewType, { openCustomDocument, resolveCustomEditor })
  assets/                 预览器静态资产（如 pdf.js 19MB）——运行时经 asWebviewUri 加载，不打进 bundle
  package.json            engines.universe 匹配 bump 后 API version；contributes.customEditors；activationEvents:["onCustomEditor:<viewType>"]；files:["dist","assets","icon.png"]
  esbuild.config.mjs      bundle src→dist；.html 走 text loader 内联模板 HTML；alias @universe-editor/extension-api → 其 dist
  scripts/pack.mjs        压成 extension/** 结构的 .vsix（[Content_Types].xml + extension.vsixmanifest 占位 + extension/package.json + dist + assets）
  tsconfig.json / src/html.d.ts / README.md / .gitignore(dist,*.vsix)
```

**out-of-workspace 构建的关键坑**：该目录没有本地 `node_modules`。
- esbuild：从 workspace 里装了它的包借——`createRequire(resolve(repoRoot,'extensions/numbered-bookmarks/package.json'))`，且 Windows 下动态 `import()` 绝对路径须 `pathToFileURL(...).href`。
- adm-zip（打包用）：`createRequire(resolve(repoRoot,'packages/extension-packaging/package.json'))`。
- @types/node + extension-api 类型：tsconfig 用 `typeRoots` 指向 workspace 的 `@types`，`paths` 把 `@universe-editor/extension-api` 映射到其 `dist/index.d.ts`。
- 前置：`packages/extension-api` 得先有 dist（`pnpm build` 会做）。
- 构建/打包：`node esbuild.config.mjs && node scripts/pack.mjs` → `<publisher>.<name>-<version>.vsix`。用真实安装路径的 `readVsixManifest`（extension-packaging）验它能被读。

**扩展侧代码要点**（`extension.ts`）：
- 用 `context.extensionPath` 拼资产路径；`asWebviewUri(fileUri(...))` 转 URL 填进 HTML。
- 模板 HTML（如 pdf.js viewer.html）经 esbuild `.html` text loader 内联成字符串，再字符串替换：剥掉硬编码的相对 `<script>/<link>`，注入 `asWebviewUri` 后的 URL + CSP meta。
- `localResourceRoots` **必须同时包含扩展目录和文档所在目录**（漏文档目录 → 预览器出 UI 但空内容，见基建文档坑②）。
- 装了 API 依赖的三方扩展移植：`import "vscode"` → `@universe-editor/extension-api`，语义基本对齐；砍掉现有 API 无的能力（如 `createFileSystemWatcher` 自动重载）。

## 关键参考路径

- `apps/editor/src/renderer/workbench/webview/CLAUDE.md` —— webview 基建 + 全部已知坑（**必读前置**）
- `packages/extension-api/src/webview.ts` —— Webview / CustomReadonlyEditorProvider 契约
- `apps/editor/e2e/specs/smoke.webview.spec.ts` —— 内联扩展全链路冒烟范例

## 其它

- 后续发现新经验，需同步更新本文件。
