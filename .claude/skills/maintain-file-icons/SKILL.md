---
name: maintain-file-icons
description: 维护资源管理器 / 编辑器 tab / 搜索 / SCM / session-diff / quickpick 里的**文件类型图标**（file icons）时召回。当任务涉及为某种文件/扩展名/文件名/语言/文件夹加或换图标、图标看起来朴素或辨识度差要升级、调整图标尺寸或图标–文字间距、扩充图标覆盖面、升级 material-icon-theme 版本、图标不显示或显示成默认 file 图标的排查、或理解"文件名/扩展名/语言→SVG"这条映射链路时使用。本仓库图标来源是 **material-icon-theme（MIT，彩色品牌 SVG）**，经一个可重跑导入脚本精选 SVG + 生成映射表，运行时零外部依赖、内联 SVG 渲染（非字体、非 icon-theme 可切换系统）。给出数据流、白名单维护流程、加图标的正确姿势、尺寸/间距落点与易踩坑。区别于 view-system-context（造侧栏 View）：本 skill 只管"文件条目前面那个小图标"。
disable-model-invocation: true
---

# 维护文件类型图标（Material 彩色图标）

本仓库的文件图标**不是** VSCode 那种可切换的 icon-theme 系统，也不是 seti 字体。它是一套**固定内置**的方案：从 `material-icon-theme`（MIT）精选彩色 SVG，用一个可重跑脚本复制 SVG + 生成映射表，运行时把 SVG 以 `?raw` 内联渲染。VSCode 的机制（JSON→CSS 特异性匹配 + woff 字体）我们**刻意没用**——因为不需要用户切主题，固定一套彩色品牌图标即可，内联 SVG 最简单、无自定义 scheme 风险、happy-dom 可断言。

## 数据流（从文件名到渲染）

```
resource(URI) ──► resolveFileIcon(resource, {isDirectory, expanded?, languageId?})
  1. 目录:  folderNamesExpanded[name] ?? folderNames[name] ?? 默认 folder/folder-open
  2. 文件:  fileNames[name]                      (完整文件名，小写)
         ► matchExtension(name)                 (最长后缀，支持 spec.ts/d.ts 复合)
         ► languageIds[language]                (language = 传入 languageId ?? languageForResource())
         ► 默认 file
  ──► FileIconDescriptor { icon: <material图标名>, id: `mi-<icon>` }
      ► FileIcon 组件: svgByName[icon] (import.meta.glob('./icons/*.svg',{query:'?raw',eager:true}))
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
7. **内联 SVG 不是字体**：渲染走 `dangerouslySetInnerHTML`，无 tone/color 类（material SVG 自带 `fill`）。想改颜色得改 SVG 本身，别加 CSS color（对内联 SVG 无效，除非 SVG 用 currentColor）。
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

- 相关 skill：[view-system-context]（侧栏 View 结构）、[fix-disposable-leak]（若给图标加订阅）
- VSCode 对照（我们**没照抄**其机制，仅参考数据源）：`vscode/extensions/theme-seti/`（字体方案）、`vscode/src/vs/editor/common/services/getIconClasses.ts`（class 生成）、`vscode/src/vs/workbench/services/themes/browser/fileIconThemeData.ts`（JSON→CSS）

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件
