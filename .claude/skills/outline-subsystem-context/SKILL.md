---
name: outline-subsystem-context
description: 处理 outline（大纲）相关功能时召回，提供整个 outline 子系统的上下文地图——OutlineService（从活跃编辑器派生符号树 + 活动符号的两条 observable）、OutlineView 树视图（排序/过滤/折叠/跟随光标/聚焦自动选中）、视图状态与持久化、View/ViewContainer 注册三处、命令快捷键、以及它如何用「抽象主干 + 按编辑器类型分支」同时支持文件编辑器（Monaco）和 markdown 预览（DOM）两种来源。当任务涉及 OutlineService、OutlineView/OutlineViewToolbar、outlineViewState、大纲的 revealSymbol/activeSymbol/follow-cursor/filter-on-type/sort、大纲与 markdown 预览的协作（MarkdownPreviewRegistry / previewScrollMap）、@ 符号快速选择（FileSymbolQuickAccessProvider）、面包屑（Breadcrumbs，同源消费者），或要理解「大纲怎么拼起来、怎么兼容多种编辑器」时，先读它建立全局认知。符号数据来源（DocumentSymbolProvider 怎么来）见 [extend-language-plugin] / [markdown-subsystem-context]。
disable-model-invocation: true
---

# Outline 子系统 上下文地图

outline（大纲）是一个**语言无关**的功能：它从活跃编辑器的 **DocumentSymbol 树**派生出侧栏树视图，并跟踪「光标/视口当前所在的符号」。符号本身来自任意 `DocumentSymbolProvider`（TS / JSON / markdown 内置插件…）——**大纲不关心是哪种语言**，那是 [extend-language-plugin] 的事。

> ⚠️ 第一原则：动手前先认领你的改动落在**抽象主干**还是**编辑器类型分支**。
> - **抽象主干**（与编辑器类型无关）：符号树 observable、排序/过滤/折叠/跟随光标、树视图渲染、视图状态持久化、符号图标。绝大多数大纲需求都在这里，改一次两种编辑器都生效。
> - **编辑器类型分支**：只有「**怎么定位到具体编辑器**」这一步按输入类型分叉——文件编辑器走 `FileEditorRegistry` + Monaco，markdown 预览走 `MarkdownPreviewRegistry` + DOM。新增一类编辑器的大纲支持才需要碰这里。
> 把通用逻辑误塞进某个分支 = 另一种编辑器白改。

## 数据流一图

```
DocumentSymbolProvider(任意语言)              ← 符号来源，不属于本子系统
  │  ILanguageFeaturesService.getDocumentSymbolProviders(lang)
  ▼
OutlineService  ── outline / activeSymbol (两条 observable，抽象主干)
  │  ① 定位编辑器（唯一的类型分支）
  │     ├─ FileEditorInput   → FileEditorRegistry.get() → Monaco editor
  │     └─ MarkdownPreviewInput → MarkdownPreviewRegistry.get() → IMarkdownPreviewController
  ▼
OutlineView (Tree) ──读 outlineViewState（排序/过滤/折叠/跟随光标）
  │  点击/回车 → outlineService.revealSymbol(symbol)
  ▼
  ① 分支回写：file → editor.setPosition+reveal+focus；preview → controller.scrollToLine+focus

姊妹消费者（同样吃 outline / DocumentSymbol，但不是大纲视图）：
  Breadcrumbs.tsx（symbolTree 查询）、FileSymbolQuickAccessProvider（@ / @: 快速选择）
```

## 核心服务：OutlineService（抽象主干 + 唯一分支点）

`apps/editor/src/renderer/services/languageFeatures/OutlineService.ts`

- **注入依赖**：`IEditorService`（活跃编辑器变化）、`ILanguageFeaturesService`（枚举 DocumentSymbolProvider）。
- **暴露**（接口 `IOutlineService`）：
  - `outline: IObservable<OutlineModel | undefined>`——`{ uri, roots, languageId, version }`，version 单调递增。
  - `activeSymbol: IObservable<DocumentSymbol | undefined>`——光标/视口顶部所在符号。
  - `revealSymbol(symbol)` / `captureViewState()` / `previewSymbol(symbol)` / `restoreViewState(state)`——后三个给 @ 快速选择用（见下）。
- **唯一类型分支**：
  - `_attachActiveEditor()`——按输入类型分流到 `_attachFileEditor`（Monaco）或 `_attachPreview`（预览）。
  - 文件分支：`FileEditorRegistry.get(input)` 拿编辑器，符号从 `editor.getModel()`/markers 拉，活动符号靠 `editor.getPosition()` + `onDidChangeCursorPosition`。
  - 预览分支：`MonacoModelRegistry.peek(preview.sourceUri)` 拿**源文件共享 model**（预览本身无 Monaco），活动符号靠 `controller.getTopVisibleLine()` + `controller.onDidScroll`。
- **`revealSymbol` 两分支必须对称**：file 分支 `setPosition + revealLineInCenterIfOutsideViewport + focus`；preview 分支 `controller.scrollToLine + controller.focus`。**任一分支漏掉 focus 都是「点了大纲焦点不回编辑器」的 bug**（已修，勿回退）。
- **冷启动重试退避**：语言服务器冷启动时 `roots` 可能暂时为空。`_attachGeneration` 计数器 + 指数退避（`INITIAL_PULL_RETRY_MS=250` → `MAX_PULL_RETRY_MS=2000`，总预算 `PULL_RETRY_BUDGET_MS=180_000`）。切文件时 generation 递增以作废旧的重试链。`onDidChangeMarkers`（诊断到达 ≈ 语言服务器就绪）也会触发重拉。
- **DI 注册**：`renderer/main.tsx`——`createInstance(OutlineService)` → `services.set(IOutlineService, …)`。

## 视图层

`apps/editor/src/renderer/workbench/outline/`

```
OutlineView.tsx           树视图主体。通用 Tree（@universe-editor/workbench-ui）+ useOwnedTreeModel。
                          读 outlineViewState 驱动：排序 buildNodes、过滤 pruneTree/collectMatchedIds、
                          折叠展开信号、跟随光标 expand 祖先+select。点击/onActivate → revealSymbol。
                          onTreeFocus：聚焦时若无「仍可见的」焦点项，自动选 activeSymbol→首行（VSCode 风）。
                          经 useViewFocusable('workbench.view.outline.main') 注册容器供 focusView 聚焦。
OutlineViewToolbar.tsx    标题栏：折叠/展开切换按钮 + 溢出菜单（Follow Cursor / Filter on Type /
                          Sort By position·name·kind）。全部读写 outlineViewState。
outlineViewState.ts       模块级 observable 单例：followCursor / filterOnType / sortBy（持久化）
                          + allCollapsed（视图回写）+ collapseAll/expandAll（单调递增信号，不持久化）。
OutlineView.module.css    .row 的 .active(光标符号左边栏) / .selected / .focused / .match / .dim。
OutlineViewToolbar.module.css
```

- **Tree 的契约**（`packages/workbench-ui/src/tree/{Tree.tsx,TreeModel.ts}`）：键盘导航/虚拟化/选择都在 Tree；行内容靠 `renderRow`。注意 **`TreeModel.refresh()` 不清 `_focused`**（只有 `reset()` 清），切文档后旧焦点 id 会残留——所以 `onTreeFocus` 的 guard 必须判断「焦点项**仍在可见列表里**」，而不是简单的 `focused != null`。
- **聚焦自动选中**走 Tree 的 `onFocus` prop（容器生命周期由 Tree 托管），**不要**改回手动 `addEventListener('focus')`：大纲常冷启动空挂载，手动监听会因 `containerRef` 当时为 null 而永远漏挂。

## 注册接入点（加 View 的三处必改 + 状态持久化）

```
contributions/BuiltInViewContainersContribution.ts  注册 ViewContainer 'workbench.view.outline'
                                                     （location: SecondarySideBar 右侧栏）
contributions/BuiltInViewsContribution.ts            注册 View 'workbench.view.outline.main'
                                                     （componentKey: 'outline.main'）
contributions/ViewComponentsContribution.ts          ViewComponentRegistry.register('outline.main', OutlineView)
contributions/OutlineViewStateContribution.ts        持久化偏好到 GLOBAL storage（key 'outline.viewState'，
                                                     只存 followCursor/filterOnType/sortBy），启动 hydrate。
                                                     在 contributions/index.ts 注册
```

（这三处 = apps/editor/CLAUDE.md 「套路 B：加 View」的标准三件套。）

## 命令 / 快捷键

`actions/layoutActions.ts` → `FocusOutlineAction`（id `outline.focus`，快捷键 `ctrl+shift+q`，`f1: true`）：
调 `ILayoutService.focusView('workbench.view.outline.main', { source: 'command' })` → 触发 OutlineView 里 `useViewFocusable` 注册的容器 focus → 触发 `onTreeFocus` 自动选中。在 `actions/index.ts` 用 `registerAction2` 注册。

## 与预览协作的句柄（编辑器类型分支用到）

```
services/editor/FileEditorRegistry.ts          FileEditorInput → 活的 Monaco editor。get()/onDidChange。
workbench/editor/monaco/MonacoModelRegistry.ts URI↔TextModel 引用计数表。peek() 只读不改计数——
                                               预览分支用它拿源文件 model（预览/源同开时共享同一个）。
services/editor/MarkdownPreviewRegistry.ts     source URI → IMarkdownPreviewController：
                                               scrollToLine / getTopVisibleLine / focus / onDidScroll。
                                               预览是 React div 没有 Monaco，这是大纲够到它的唯一句柄。
workbench/editor/previewScrollMap.ts           纯函数：源行号↔预览像素。previewTopForLine /
                                               lineForPreviewTop / collectEntries（读 DOM 的 data-line）。
                                               data-line 是 0-based，函数内部统一转 1-based。
```

> 预览这条线的形态属于 markdown 子系统，详见 [markdown-subsystem-context] 线②。大纲只通过 `IMarkdownPreviewController` 与它解耦协作——**给预览加新交互能力时，优先扩 `IMarkdownPreviewController` 接口**（如当初加 `focus()`），三处同步：接口（MarkdownPreviewRegistry.ts）、实现（MarkdownPreviewEditor.tsx 的 controller 对象）、调用（OutlineService.revealSymbol / _recomputeActiveSymbol）。

## 符号数据来源 & 图标 & 同源消费者

- **符号来源**：`ILanguageFeaturesService.registerDocumentSymbolProvider` 注册的任意 provider。大纲不注册 provider，只**枚举消费**。markdown 由内置插件 `extensions/markdown` 提供（标题符号 kind=String，图标特例渲染成 `#`）。新语言要出现在大纲里 → 给它加 DocumentSymbolProvider，见 [extend-language-plugin]。
- **纯函数树工具**（`services/languageFeatures/`，无 Monaco 依赖、易单测）：
  - `symbolTree.ts`——`findSymbolAtLine`（活动符号）、`symbolAncestryPath`（跟随光标展开祖先）。**`Breadcrumbs.tsx` 也用它**——改 symbolTree 要顾及面包屑。
  - `outlineFlatten.ts`——`flattenOutline`（@ 前序）、`groupSymbolsByKind`（@: 分组），给快速选择用。
- **图标**：`workbench/symbols/symbolIcon.tsx`——`SymbolIcon` / `symbolIconId`，按 kind+languageId 映射 codicon + 语义色；markdown 标题特例。

## @ / @: 符号快速选择（复用大纲的 reveal/preview 三连）

`services/quickInput/providers/FileSymbolQuickAccessProvider.ts`——`@`（文档顺序）/ `@:`（按 kind 分组）。
打开时 `outline.captureViewState()` 存快照；`onDidChangeActive` → `previewSymbol`（实时高亮不移光标）；
`onDidAccept` → `revealSymbol`；取消 → `restoreViewState`。
**这三个方法目前只有文件编辑器分支有实质行为**（preview 分支里 capture/preview/restore 基本是 no-op，因为预览无 Monaco 装饰/选区）。改这三个方法时记得这一点。

## 关键架构决策与「为什么」

- **大纲语言无关，分支只在「定位编辑器」**：符号、排序、过滤、树渲染对所有语言/编辑器一致；只有「光标在哪、滚到哪、焦点给谁」依赖具体编辑器宿主。把分支收敛到 `_attach*` / `revealSymbol` / `_recomputeActiveSymbol` 三处，其余全主干——所以「给预览加大纲」当初只新增了一个分支，没动主干。
- **预览用 controller 句柄而非直连**：预览是纯 React div，没有 Monaco API。`IMarkdownPreviewController` 把「滚到某行 / 顶部是第几行 / 聚焦 / 滚动事件」抽象出来，让 OutlineService 用与文件编辑器对称的方式操作它。
- **冷启动重试**：DocumentSymbol 依赖语言服务器，冷启动有延迟。指数退避 + generation 作废，避免「打开文件大纲一直空」又不无限重试。这是 e2e `smoke.outline.spec.ts` 用 `test.slow()` + 轮询的原因。
- **偏好持久化用 GLOBAL scope**：大纲的 sort/follow/filter 是跨工作区的用户习惯，不随项目变（对标 VSCode）。折叠信号是瞬时 UI 动作，不持久化。

## 常见任务 → 改哪里

- **改排序/过滤/折叠/跟随光标的行为或 UI**：`OutlineView.tsx`（逻辑）+ `OutlineViewToolbar.tsx`（按钮）+ `outlineViewState.ts`（新偏好加 observable+setter）。新增可持久化偏好别忘 `OutlineViewStateContribution.ts` 的 hydrate/写回 + `PersistedOutlineState`。
- **改大纲项点击/回车的跳转行为**：`OutlineService.revealSymbol`——**两个分支都要改**，保持对称（尤其 focus）。
- **改活动符号（高亮/跟随）的判定**：`_recomputeActiveSymbol` + `symbolTree.findSymbolAtLine`（注意面包屑同源）。
- **新增一类编辑器的大纲支持**：仿照预览分支——给该编辑器建一个 Registry + controller 接口，在 `_attachActiveEditor` 加分支、`revealSymbol`/`_recomputeActiveSymbol` 加分支。主干不动。
- **给预览大纲加新交互**（如 hover 预览、双向滚动同步增强）：扩 `IMarkdownPreviewController`（三处同步），见上。
- **某语言不显示大纲**：不是大纲的问题——去给它加 `DocumentSymbolProvider`（[extend-language-plugin] / markdown 见 [markdown-subsystem-context]）。先用 e2e probe `getOutlineSymbols()` 确认 service 层有没有拿到符号，再判断是 provider 缺失还是视图问题。
- **改符号图标/颜色**：`workbench/symbols/symbolIcon.tsx`。

## 易踩坑速记

1. **revealSymbol 漏 focus**（已修，勿回退）：preview 分支必须 `controller.scrollToLine` **后再 `controller.focus()`**，否则回车后焦点滞留在大纲树。file 分支同理末尾 `editor.focus()`。
2. **TreeModel 切文档不清 `_focused`**：`onTreeFocus` 的 guard 要判「焦点项仍可见」（`visible.some(n=>n.id===focusedId)`），不能只判 `focused != null`，否则切到新文档后旧焦点残留导致不自动选首项。
3. **聚焦自动选中要用 Tree 的 onFocus prop**：大纲常空挂载（冷启动），手动 `containerRef.addEventListener('focus')` 会因挂载时 `containerRef` 为 null 且 effect 不重跑而**永远漏挂**。
4. **预览源 model 用 `peek` 不用 `acquire`**：`_attachPreview` 只读源文件 model，用 `MonacoModelRegistry.peek` 不改引用计数；用 acquire 会泄漏引用。源文件从未在编辑器打开过的「孤立预览」→ peek 拿不到 model → 大纲暂空（已知限制）。
5. **data-line 0-based vs 行号 1-based**：`previewScrollMap.collectEntries` 读的 DOM `data-line` 是 0-based（Monaco 行号-1），所有映射函数对外用 1-based。跨这层别忘 ±1。
6. **加 View 三件套缺一不可**：Container / View / ViewComponentRegistry 注册三处漏一处，大纲标签页就出不来或空白（apps/editor/CLAUDE.md 套路 B）。

## 验证

```bash
cd apps/editor && pnpm vitest run --project renderer \
  src/renderer/services/languageFeatures/__tests__/OutlineService.test.ts \
  src/renderer/workbench/outline/__tests__/OutlineView.test.tsx \
  src/renderer/workbench/editor/__tests__/previewScrollMap.test.ts   # 大纲相关单测
pnpm check                                          # lint+typecheck+全量 test
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test specs/smoke.outline.spec.ts            # 大纲（文件）冒烟
cd apps/editor && pnpm exec playwright test specs/smoke.markdownPreview.spec.ts    # 含「切预览后大纲仍在」
```

e2e 探针（`renderer/e2e/probe.ts`）：`getOutlineSymbols()`（递归扁平符号名）、`getOutlineUri()`、`getActiveEditorTypeId()`（判当前是 file 还是 markdown.preview）。

## 关键参考路径

- `apps/editor/src/renderer/services/languageFeatures/OutlineService.ts` —— 服务主干 + 唯一类型分支 + 重试退避
- `apps/editor/src/renderer/workbench/outline/OutlineView.tsx` —— 树视图（排序/过滤/折叠/跟随/聚焦自动选中）
- `apps/editor/src/renderer/workbench/outline/OutlineViewToolbar.tsx` —— 标题栏按钮/溢出菜单
- `apps/editor/src/renderer/workbench/outline/outlineViewState.ts` —— 偏好/信号 observable 单例
- `apps/editor/src/renderer/contributions/{BuiltInViewContainers,BuiltInViews,ViewComponents,OutlineViewState}Contribution.ts` —— 注册三件套 + 持久化
- `apps/editor/src/renderer/actions/layoutActions.ts` —— `FocusOutlineAction`（outline.focus / ctrl+shift+q）
- `apps/editor/src/renderer/services/editor/{FileEditorRegistry,MarkdownPreviewRegistry}.ts` —— 两类编辑器句柄
- `apps/editor/src/renderer/workbench/editor/monaco/MonacoModelRegistry.ts` —— 共享 model（peek）
- `apps/editor/src/renderer/workbench/editor/previewScrollMap.ts` —— 源行↔预览像素纯函数
- `apps/editor/src/renderer/services/languageFeatures/{symbolTree,outlineFlatten}.ts` —— 纯树查询（symbolTree 面包屑同源）
- `apps/editor/src/renderer/workbench/symbols/symbolIcon.tsx` —— 符号图标
- `apps/editor/src/renderer/services/quickInput/providers/FileSymbolQuickAccessProvider.ts` —— @ / @: 复用 reveal/preview/restore
- `apps/editor/src/renderer/workbench/editor/Breadcrumbs.tsx` —— 同源消费者（symbolTree）
- 测试：`…/languageFeatures/__tests__/OutlineService.test.ts`、`…/outline/__tests__/OutlineView.test.tsx`、`…/editor/__tests__/previewScrollMap.test.ts`、`apps/editor/e2e/specs/smoke.outline.spec.ts`
- 相关 skill：[extend-language-plugin]（符号来源/语言插件套路）、[markdown-subsystem-context]（预览线②形态）
