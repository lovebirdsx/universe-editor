---
name: dirty-diff-inline-peek-feature
description: 点击 dirty-diff gutter 色条弹出内联 peek（HEAD↔当前，内嵌真 Monaco diff editor + 语法高亮 + 双侧行号 + Esc关闭/拖动调高/自动滚入视口 + 导航/Revert/Stage/打开完整diff），VSCode QuickDiffWidget 的 standalone-monaco 等价实现
metadata: 
  node_type: memory
  type: project
  originSessionId: 674ce5d9-3e47-4237-bb38-455d597592ac
---

对照 VSCode `quickDiffWidget.ts`（PeekViewWidget + EmbeddedDiffEditorWidget + ZoneWidget）实现"点击文档左侧修改色条弹出内联 diff"。我们是 monaco **standalone**，VSCode 私有 PeekView 模块被 tree-shake，但 `createDiffEditor` 在 standalone 可用（DiffEditor.tsx 已证），故 peek 直接**内嵌一个真 Monaco diff editor**——双侧行号 / 语法高亮 / 内部滚动全部白拿，比手写 DOM diff 强。详细套路 + 三类布局公式见 skill **[dirty-diff-inline-peek]**（本 memory 给状态与索引，做功能前先读 skill）。

**演进史（避免回退踩坑）**：初版曾用手写 DOM diff（content-widget + `computeLineDiff` 渲染增删 HTML，无高亮、宽度被内容撑不满宽）→ 改 overlay-widget 仍手写 DOM diff → **终版：overlay-widget + 空 view-zone 占位 + 内嵌 diff editor**。手写 DOM diff 那套已全删，**别再回退**。注意区分：gutter 色条的 region 计算仍用 `computeLineDiff`（见 [[linediff-myers-perf]]），但 peek 面板内容**不再**用它。

关键文件：
- `apps/editor/src/renderer/workbench/scm/dirtyDiff/InlineDirtyDiffController.ts` — peek 控制器。overlay-widget 渲染面板（header + body + 底部拖动手柄），空 view-zone 占位并经 `onDomNodeTop/onComputedHeight` 同步 top/height；body 里 `createDiffEditor`（`renderSideBySide:false` 内联模式，`scrollbar.alwaysConsumeMouseWheel:true` 让滚轮不穿透）。三套公式照搬 VSCode：①overlay 定位 `left=0`（盖住行号区最左）、`width=editorWidth - minimapWidth - verticalScrollbarWidth`（不压滚动条）；②初始高 `min(变更高+上下文+header, 编辑器1/3)`，拖动上限 `编辑器0.8`，下限 8 行；③`revealLineInCenterIfOutsideViewport(region.endLine)` 仅当变更出视口才滚入。提供 `panelHeightPx`/`maxHeightPx`/`resizeByPx` 供 host/E2E。
- `apps/editor/src/renderer/workbench/scm/dirtyDiff/DirtyDiffPeekRegistry.ts` — 模块单例（仿 MarkdownPreviewRegistry），暴露当前活动编辑器的 `IDirtyDiffPeekHost`（openAtLine/closePeek/isPeekOpen/getPeek*HeightPx/resizePeekByPx）给 action（Esc/show change）与 E2E。任一时刻至多一个 host。
- `apps/editor/src/renderer/contributions/dirtyDiff.ts` — `DirtyDiffRegion` 带 `originalStartLine/originalEndLine`（HEAD 侧行范围）；added 的 original 范围为空（end<start），`originalStartLine`=插入点前的 HEAD 行（0=文件头）。
- `apps/editor/src/renderer/contributions/DirtyDiffContribution.ts` — 实现 `IDirtyDiffPeekHost`+向 DirtyDiffPeekRegistry 注册。onMouseDown/onMouseUp 命中 `dirty-diff-gutter`→开/切/收 peek（再点同一条收起）。维护 context key **`dirtyDiffPeekVisible`**（VSCode 叫 dirtyDiffVisible），所有关闭路径统一走 `closePeek()` 同步清 key。Revert=纯 model executeEdits 可撤销（deleted 的文件头特例 originalStartLine===1）；Stage=先 save 再 `git.stageChange`；Open Changes 走 `git.openChange`(undefined,{pinned})。
- `apps/editor/src/renderer/actions/dirtyDiffActions.ts` — `CloseDirtyDiffPeekAction`（Esc，`when:dirtyDiffPeekVisible`，weight `WorkbenchContrib+50` 压过 Monaco 的 Esc 和工作台"聚焦编辑器组"Esc）+ `ShowChangeAtCursorAction`（在光标处开 peek）。两个都在 `actions/index.ts` registerAction2。
- gutter 点击区放大：`workbench.css` `.dirty-diff-gutter::before` 透明命中区（left -3px、宽12px）+ hover 时色条 3px→6px（VSCode 同款 hover glyph）。

Stage 后端（git 扩展）：
- `extensions/git/src/hunkPatch.ts` `selectHunkPatch` — `git diff -U0` 每个 hunk 1:1 对应一个 region，按行范围选 hunk 拼 header+hunk。
- `repository.ts` `stageChange` — diff -U0 → selectHunkPatch → `git apply --cached --unidiff-zero --whitespace=nowarn -`(stdin)。`gitService.ts` `gitExec` 的 `options.input` 走 stdin。命令常量 `packages/extensions-common/src/dirtyDiff.ts` `DirtyDiffCommands.stageChange`。
- 改 git 扩展后必须 `pnpm --filter @universe-editor/git build`（产物 dist/extension.js），否则运行时用旧 bundle。

样式 `workbench.css` `.inline-dirty-diff*`（overlay `position:absolute;z-index:10`，header 满宽、body 占满、底部 `.inline-dirty-diff-resize` ns-resize 手柄）。codicon 图标直接可用（monaco editor.main.js 自带 codicon.css+ttf）。

E2E：`apps/editor/e2e/specs/smoke.dirtyDiffPeek.spec.ts`（真 git 仓库 + 长文件远端造大改动，一次验封顶/滚入视口/拖动增高/Esc关闭）。probe 方法 `openDirtyDiffPeekAtLine`/`getDirtyDiffPeekState`/`isDirtyDiffPeekVisible`/`resizeDirtyDiffPeekByPx`。
