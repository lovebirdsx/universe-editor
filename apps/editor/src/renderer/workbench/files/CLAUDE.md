# apps/editor/src/renderer/workbench/files/CLAUDE.md

文件类型图标系统（`resolveFileIcon` + `FileIcon` 组件 + `materialIconMap.ts` 生成物 + `icons/*.svg`）与资源语言解析（`resourceLanguage.ts` / `resourceInfo.ts`）在本目录；图标导入脚本在 `apps/editor/scripts/import-material-icons.mjs`。本文是文件图标的维护手册（改图标前先读）。

## 维护文件类型图标（Material 彩色图标）

文件图标**是** VSCode 那种可切换的 icon-theme 系统（Phase 4 起）：`workbench.iconTheme` 设置驱动，`FileIcon` 组件按活动主题分流渲染。当前有两条渲染路径：

- **JSON 文件图标主题激活（默认）**：走 stylesheet 协议类——`FileIcon` 只发 `file-icon`/`folder-icon`/`ts-lang-file-icon` 等 class（`getFileIconClasses`），真正的图形由主题贡献的 CSS 经 `::before` background 绘制。内置默认主题 `universe-material`（`extensions/theme-defaults/icons/universe-material-icon-theme.json`，与颜色主题同扩展）就是这种 JSON 主题，**数据源与本目录的 material 白名单同源**。第三方 VSCode 文件图标主题扩展装上后也会出现在「文件图标主题」列表里（对齐 VSCode `fileIconThemeData` JSON→CSS 机制）。
- **None（`workbench.iconTheme: null`）**：回退到本目录的**内联 SVG 方案**——`resolveFileIcon` + `FileIcon` 把 `material-icon-theme`（MIT）精选彩色 SVG 以 `?raw` 内联渲染。这套内联数据由可重跑脚本生成，无自定义 scheme、happy-dom 可断言，也是单元测试（容器里无 theme service）走的兜底路径。

**本目录维护的是内联 SVG 数据与解析逻辑**，它同时喂给 None 路径和 universe-material JSON 主题的图标源。改图标（加/换/升级 material 版本）仍只动本目录脚本与生成物。主题切换/JSON→CSS/热更新的机制在 `services/themes/`（见其 CLAUDE.md）。

## 数据流（从文件名到渲染）

```
resource(URI) ──► resolveFileIcon(resource, {isDirectory, expanded?, languageId?})
  1. 目录:  folderNamesExpanded[name] ?? folderNames[name] ?? 默认 folder/folder-open
  2. 文件:  fileNames[name]                      (完整文件名，小写)
         ► matchExtension(name)                 (最长后缀，支持 spec.ts/d.ts 复合)
         ► languageIds[language]                (language = 传入 languageId ?? languageForResource())
         ► 默认 file
  ──► FileIconDescriptor { icon: <material图标名>, id: `mi-<icon>` }

FileIcon 组件分流（useFileIconThemeActive，订阅 onDidFileIconThemeChange）：
  ├─ 主题激活（默认）: getFileIconClasses → <span class="file-icon ts-lang-file-icon ...">
  │                    主题 CSS 绘图形；data-file-icon="file"/"folder"
  └─ None / 无 theme service: svgByName[icon] (import.meta.glob('./icons/*.svg',{query:'?raw',eager:true}))
                       dangerouslySetInnerHTML 内联，data-file-icon="mi-<icon>"
```

优先级：**文件名 > 扩展名 > 语言 > 默认**。这是手写的 if 顺序（不是 CSS 特异性），就在 `resolveFileIcon` 里。

## 关键文件

- `apps/editor/scripts/import-material-icons.mjs` —— **可重跑导入脚本**（白名单 → 复制 SVG + 生成映射）。维护图标的主入口。
- `apps/editor/src/renderer/workbench/files/materialIconMap.ts` —— **生成物**，`/* eslint-disable */` 开头，**别手改**，改脚本重跑。含 `materialIconDefaults / materialFileNames / materialFileExtensions / materialLanguageIds / materialFolderNames / materialFolderNamesExpanded`。
- `apps/editor/src/renderer/workbench/files/icons/*.svg` —— **生成物**，203 个精选 SVG + `LICENSE`（MIT 归属）。
- `apps/editor/src/renderer/workbench/files/fileIconTheme.tsx` —— `resolveFileIcon` + `FileIcon` 组件（内联 SVG 渲染、复合扩展名匹配、symlink 角标）。
- `apps/editor/src/renderer/workbench/files/resourceLanguage.ts` —— 扩展名/文件名 → Monaco languageId，供 language 兜底分支用。
- `apps/editor/src/renderer/workbench/files/FileIcon.module.css` —— 图标容器/glyph 尺寸/symlink 角标（**无 tone 着色**，material 自带彩色）。
- `material-icon-theme` 是 `pnpm-workspace.yaml` catalog + `apps/editor` **devDependency（build-time only）**，运行时不打进 bundle。

## 加/换一个图标（正确姿势）

**核心机制**：脚本以「图标名白名单」驱动，从 material 的 manifest **反查**所有指向白名单图标的映射键。所以你通常**只需在白名单加一个图标名**，`package.json`/`package-lock.json`/… 这些键会被自动带出，不用逐个列。

1. 编辑 `import-material-icons.mjs` 的 `KEEP_FILE_ICONS` 或 `KEEP_FOLDER_ICONS`，加上 material 的**图标名**（= `icons/<name>.svg` 的 basename，也是 manifest `iconDefinitions` 的 key）。
   - 不确定图标名？去 material 包里查：`iconDefinitions[manifest.fileExtensions['xxx']]` 或直接翻 `node_modules/material-icon-theme/icons/`。
2. `node apps/editor/scripts/import-material-icons.mjs` —— 重新生成 SVG + map。
3. 看脚本输出：**`not found in package` 警告** = 你写的图标名不存在（typo 或 material 里叫别的名，如 SolidJS 无独立图标、`.ini`→`settings`、`.bat`→`console`、`.wgsl`→`shader`）。删掉或改对。
4. `pnpm check` 验证。若改了测试断言涉及的图标（见下），同步测试。

**只想覆盖某个特定文件名/扩展名**（material 没有该键，但你想手工指定）：material manifest 里没有的键，脚本反查不到。此时在脚本里给对应 assoc 手工补一条（或加 material 里已有的近似图标名到白名单，让它自然带出键）。

## 尺寸与间距落点

- **explorer 图标尺寸**：`ExplorerTreeNode.tsx` 的 `<FileIcon size={16}>`。Material SVG 是 16×16 viewBox 设计，16px 最清晰（对齐 VSCode）。
- **explorer 图标–文字间距**：`ExplorerView.module.css` 的 `.icon { margin-right: 6px }`（VSCode 常见值）。`.icon` 容器 `width:18px` 居中 16px 图标。
- 其它消费方各自传 `size`（tab/search/scm/session-diff/quickpick）；改尺寸去各自调用点，别改组件默认。

## 消费方（都复用 `FileIcon`，改组件即全生效）

`ExplorerTreeNode.tsx` / `EditorGroupView.tsx`（tab，仅 file/untitled 且 input 无自定义 getIconId 时）/ `SearchResultsTree.tsx` / `ScmView.tsx` / `SessionChangesView.tsx` / `QuickInput.tsx`+`contextIcon.tsx`。加新消费方直接 `<FileIcon resource=... isDirectory=... size=... />`。

## 测试断言（改图标映射可能要同步）

4 处按 `data-file-icon="mi-<name>"` 断言，改了对应映射要同步：
- `editor/__tests__/EditorGroupView.test.tsx`（`mi-typescript` / `mi-nodejs`）
- `explorer/__tests__/ExplorerView.test.tsx`（`mi-folder-src` / `mi-readme`）
- `search/__tests__/SearchResultsTree.test.tsx`（`mi-typescript` / `mi-nodejs`）
- `files/__tests__/fileIconTheme.test.tsx`（`mi-nodejs` / `mi-folder-src(-open)` / `mi-json` / `mi-document`(plaintext 兜底) / `mi-file`(无匹配兜底)）

这些单测容器里**没有** theme service，走内联 SVG 兜底路径，故 `data-file-icon` 是 `mi-<name>`。**JSON 主题激活时**（真实 app / 装了 theme service 的 e2e）stylesheet 模式的 `data-file-icon` 是 `file`/`folder`，图形断言要靠协议 class（如 `ts-lang-file-icon`），不是 `mi-*`。

注意 `package.json` → material 图标名是 **`nodejs`**（不是 `package`）；`tsconfig.json`→`tsconfig`；`readme.md`→`readme`；未知扩展但可识别为 plaintext 的文件 → `document`（比通用 `file` 友好）；连 language 都无匹配才落 `file`。

## 升级 material-icon-theme 版本

改 `pnpm-workspace.yaml` catalog 的 `material-icon-theme` 版本 → `pnpm install` → 重跑脚本 → `pnpm check` + `pnpm e2e`。留意脚本的 `not found` 警告（上游可能重命名图标）。

## 易踩坑速记

1. **别手改生成物**：`materialIconMap.ts` / `icons/*.svg` 是脚本产出，改脚本重跑。生成文件顶部 `/* eslint-disable */` 让 4100 行数据免于 prettier lint（否则报 4100 problems）。
2. **扩展名键不带点**：material manifest 的 `fileExtensions` key 是 `ts`/`py`（无点），但 `extensionOfBasename` 返回带点的 `.ts`。`matchExtension` 用 `name.indexOf('.')` 切后缀查，别混淆。
3. **键大小写**：脚本对 fileNames/fileExtensions/folderNames 键统一 `toLowerCase()`（`pickAssoc(..., true)`），因为运行时 basename 已小写。漏了会有永不命中的大写键（如 `Dockerfile`、`META-INF`）。
4. **图标名 ≠ 文件类型名**：SolidJS 无独立图标、`.ini`→`settings`、`.bat`→`console`、`.wgsl`→`shader`、`.wat`→`webassembly`、`.xlsx`→`table`、`assets` 文件夹→`folder-resource`。写白名单前先确认 material 里的真名，否则 `not found` 警告。
5. **folder-open 变体**：脚本对每个 kept folder 自动带出 `<name>-open.svg`（若存在）+ manifest 的 `folderNamesExpanded`。别单独往白名单加 `-open`。
6. **复合扩展名**：`foo.spec.ts` 先试 `spec.ts` 再试 `ts`（最长后缀优先），`matchExtension` 已实现，material 有 `spec.ts`/`d.ts`/`cy.js` 等复合键。
7. **内联 SVG 不是字体**：None 路径渲染走 `dangerouslySetInnerHTML`，无 tone/color 类（material SVG 自带 `fill`）。想改颜色得改 SVG 本身，别加 CSS color（对内联 SVG 无效，除非 SVG 用 currentColor）。JSON 主题路径同理——颜色由主题 SVG/CSS 决定。
8. **e2e 跑 `out/` 产物**：改了 renderer 后先 `pnpm --filter @universe-editor/editor build` 再单跑 spec，否则看旧图标。根 `pnpm e2e` 会自动先 build。
9. **体积权衡**：全量 material 是 1250 图标/3.3MB；精选 203 个约 467KB 内联进 bundle。加图标前想想是否常见，冷门类型落默认 `file`/`document` 也可接受。

## 验证

```bash
node apps/editor/scripts/import-material-icons.mjs        # 重新生成（看 not found 警告）
pnpm check                                                # lint+typecheck+test，仅看错误
pnpm --filter @universe-editor/editor build               # e2e 跑 out/，改 renderer 后必重建
pnpm e2e                                                  # explorer/tab 渲染冒烟
```

## 相关

- 相关：`apps/editor/src/renderer/services/views/CLAUDE.md`（侧栏 View 结构）；skill [fix-disposable-leak]（若给图标加订阅）
- 主题切换机制（iconThemes 扩展点 / JSON→CSS / 热更新）：`apps/editor/src/renderer/services/themes/CLAUDE.md`、`services/themes/fileIconThemeData.ts` + `generateFileIconThemeCss.ts`
- 类名协议（本目录输出端）：`fileIconClasses.ts`（VSCode `getIconClasses` 对等物）必须与 `services/themes/generateFileIconThemeCss.ts`（CSS 生成端）的 `cssClassName` 保持一致
- VSCode 对照（icon-theme 机制已对齐；内联 SVG 路径参考其数据源）：`vscode/src/vs/editor/common/services/getIconClasses.ts`（class 生成）、`vscode/src/vs/workbench/services/themes/browser/fileIconThemeData.ts`（JSON→CSS）

## 其它
- 后续发现新经验，需同步更新本文件
