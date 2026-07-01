---
name: extension-manifest-nls
description: 插件 manifest 静态贡献点（命令title/子菜单label/配置description）中文本地化机制，VSCode 式 %key% + package.nls.json
metadata: 
  node_type: memory
  type: project
  originSessionId: 3c663683-6d02-4dbc-8c8b-9ce3e9166ac0
---

插件 `contributes` 里的用户可见字符串（命令 `title`/`category`、子菜单 `label`、配置 `description`）此前是英文硬编码，命令面板/菜单不跟随语言。已按 VSCode `package.nls` 范式做本地化。

**机制（host 侧扫描时替换，非 renderer）**：
- manifest 里写 `%key%` 占位符；扩展根目录配 `package.nls.json`（英文默认，必备）+ `package.nls.<locale>.json`（如 `package.nls.zh-cn.json`）。
- `packages/extension-host/src/nls.ts`：`loadNlsBundle(extPath, locale)` 加载 locale bundle 并 merge 到默认 bundle（缺 key 回退英文）；`localizeManifest(raw, bundle)` 深度遍历替换整串 `%key%`（非整串或缺 key 原样保留，miss 可见）。
- `extensionScanner.scanOne/scanExtensions` 新增 `locale` 参数，在 `parseManifest` 前替换原始 JSON。
- locale 传递链：renderer `getCurrentLocale()`（`shared/i18n/availableLocales`）→ `ExtHostStartSpec.locale` → `extensionHostMainService` 写 env `UNIVERSE_DISPLAY_LOCALE` → `bootstrap.ts` 读 env 传给 scanner。

**Why**：静态贡献点在激活前就要注册进命令面板，`git/src/nls.ts` 那套只管**运行时**字符串（进度/按钮），管不到 manifest。

**How to apply**：
- 新增/改内置插件的可见文案：manifest 用 `%key%`，两份 nls 文件补 key（zh-cn 用带声调正字）。
- **打包红线**：nls 文件必须显式列进插件 `package.json` 的 `files` 数组（如 git 的 `["dist","package.nls.json","package.nls.zh-cn.json"]`）；`scripts/release/runtime-resources.mjs` 的 `extensionPackageFiles` 只复制 files 列出的字面量条目，不支持通配符，漏列则打包版丢本地化。
- 改 host 侧（scanner/nls/bootstrap）后必须 `pnpm --filter @universe-editor/extension-host build` 重建 dist，否则 dev/e2e 仍用旧产物。
- 相关：[[extension-system-progress]] [[monaco-055-editcontext-nls]]
