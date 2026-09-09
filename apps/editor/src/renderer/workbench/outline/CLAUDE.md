# apps/editor/src/renderer/workbench/outline/CLAUDE.md

outline（大纲）子系统的视图层在本目录（OutlineView/OutlineViewToolbar/outlineViewState），服务主干 OutlineService 在 `services/languageFeatures/`（语言无关，与 symbolTree 等纯函数同域）。本文是 outline 子系统的上下文地图（处理相关任务前通读）。

outline 是**语言无关**功能：从活跃编辑器的 **DocumentSymbol 树**派生侧栏树视图，并跟踪「光标/视口当前所在符号」。符号来自任意 `DocumentSymbolProvider`（TS/JSON/markdown 内置插件…），那是 [extend-language-plugin] 的事。

> ⚠️ 第一原则：先认领改动落在**抽象主干**还是**编辑器类型分支**。
> - **抽象主干**（与编辑器类型无关）：符号树 observable、排序/过滤/折叠/跟随光标、树渲染、视图状态持久化、图标。绝大多数需求在这，改一次所有编辑器生效。
> - **编辑器类型分支**：只有「**怎么定位到具体编辑器**」按输入类型分叉（file→FileEditorRegistry+Monaco；preview→MarkdownPreviewRegistry+DOM；session/graph 同理）。新增一类编辑器的大纲支持才碰这里。
> 通用逻辑误塞进某分支 = 另一种编辑器白改。

## 数据流一图

```
DocumentSymbolProvider(任意语言) → ILanguageFeaturesService.getDocumentSymbolProviders(lang)
  ↓
OutlineService（outline / activeSymbol 两条 observable，抽象主干）
  ↓ ① 定位编辑器（唯一类型分支：FileEditorRegistry / MarkdownPreviewRegistry / AcpSessionOutlineRegistry / GraphOutlineRegistry）
OutlineView (Tree) 读 outlineViewState（排序/过滤/折叠/跟随光标）
  点击/回车 → revealSymbol → 分支回写（file: setPosition+reveal+focus；preview: scrollToLine+focus；session: scrollToKey+focus；graph: selectCommit）
姊妹消费者（同样吃 outline / DocumentSymbol，但不是大纲视图）：Breadcrumbs.tsx（symbolTree 查询）、FileSymbolQuickAccessProvider（@ / @:）
```

## 核心服务：OutlineService（`services/languageFeatures/OutlineService.ts`）

- 接口 `IOutlineService`：`outline: IObservable<OutlineModel | undefined>`（`{uri, roots, languageId, version}`）、`activeSymbol`、`revealSymbol` / `captureViewState` / `previewSymbol` / `restoreViewState`（后三个给 @ 快速选择）。
- **唯一类型分支** `_attachActiveEditor()`：file 分支 `FileEditorRegistry.get(input)` + `getPosition()`/cursor 事件；preview 分支 `MonacoModelRegistry.peek(sourceUri)` 拿**源文件共享 model**（预览无 Monaco）+ `controller.getTopVisibleLine()`/`onDidScroll`；session 分支 `AcpSessionOutlineRegistry`；graph 分支 `GraphOutlineRegistry.get(kind, instanceKey)`（instanceKey = input 的 `resource.toString()`，多实例图谱按实例路由，缺省回退最近注册）。
- **`revealSymbol` 两分支必须对称**：file `setPosition + revealLineInCenterIfOutsideViewport + focus`；preview `scrollToLine + focus`。**任一分支漏 focus 都是「点了大纲焦点不回编辑器」的 bug**（已修勿回退）。
- **冷启动重试退避**：`_attachGeneration` 计数 + 指数退避（250→2000ms，总预算 180s）；切文件 generation 递增作废旧重试链；`onDidChangeMarkers`（诊断到达≈LS 就绪）也触发重拉。
- DI：`renderer/main.tsx` `createInstance(OutlineService)` → `services.set(IOutlineService, …)`。

## 视图层（本目录）

```
OutlineView.tsx          树视图主体。通用 Tree（@universe-editor/workbench-ui）+ useOwnedTreeModel；读 outlineViewState 驱动（排序/过滤/折叠/跟随光标）；点击/onActivate → revealSymbol；onTreeFocus：无「仍可见」焦点项时自动选 activeSymbol→首行；经 useViewFocusable('workbench.view.outline.main') 注册容器
OutlineViewToolbar.tsx   标题栏：折叠/展开 + 溢出菜单（Follow Cursor / Filter on Type / Sort By position·name·kind），全读写 outlineViewState
outlineViewState.ts      模块级 observable 单例：followCursor / filterOnType / sortBy（持久化）+ allCollapsed（视图回写）+ collapseAll/expandAll（信号，不持久化）
```

- **Tree 契约**：`TreeModel.refresh()` 不清 `_focused`（只有 `reset()` 清），切文档后旧焦点 id 残留——`onTreeFocus` 的 guard 必须判「焦点项**仍在可见列表里**」，不能只判 `focused != null`。
- **聚焦自动选中走 Tree 的 `onFocus` prop**（容器生命周期由 Tree 托管），勿改回手动 `addEventListener('focus')`：大纲常冷启动空挂载，手动监听会因 `containerRef` 当时为 null 永远漏挂。

## 注册接入点（加 View 两步 + 状态持久化）

- 两步：`BuiltInViewContainersContribution.ts`（Container `workbench.view.outline` 在 SecondarySideBar）+ `BuiltInViewsContribution.ts`（`registerViewWithComponent` 绑 View `workbench.view.outline.main` ↔ OutlineView，componentKey 由 id 派生）——即 apps/editor/CLAUDE.md 套路 B。
- 持久化：`contributions/OutlineViewStateContribution.ts` 存 GLOBAL storage（key `outline.viewState`，只存 followCursor/filterOnType/sortBy），启动 hydrate；在 `contributions/index.ts` 注册。

## 命令 / 快捷键

`actions/layoutActions.ts` → `FocusOutlineAction`（id `outline.focus`，`ctrl+shift+q`）：`ILayoutService.focusView('workbench.view.outline.main', …)` → 触发 `onTreeFocus` 自动选中。`actions/index.ts` 注册。

## 与预览协作的句柄（编辑器类型分支用到）

```
services/editor/FileEditorRegistry.ts           FileEditorInput → 活的 Monaco editor
workbench/editor/monaco/MonacoModelRegistry.ts  URI↔TextModel 引用计数表；peek() 只读不改计数（预览分支拿源文件 model）
services/editor/MarkdownPreviewRegistry.ts      source URI → IMarkdownPreviewController：scrollToLine / getTopVisibleLine / focus / onDidScroll（预览是 React div 没有 Monaco，这是大纲够到它的唯一句柄）
workbench/editor/previewScrollMap.ts            纯函数：源行号↔预览像素（读 DOM data-line；data-line 0-based，函数对外统一 1-based）
```

> 预览这条线的形态属于 markdown 子系统（`workbench/markdown/CLAUDE.md` 线②）。大纲只经 `IMarkdownPreviewController` 解耦协作——**给预览加新交互能力时优先扩 `IMarkdownPreviewController` 接口**（如当初加 `focus()`），三处同步：接口（MarkdownPreviewRegistry.ts）/ 实现（MarkdownPreviewEditor.tsx 的 controller 对象）/ 调用（OutlineService.revealSymbol / _recomputeActiveSymbol）。

## 符号数据来源 & 图标 & 同源消费者

- **符号来源**：`ILanguageFeaturesService.registerDocumentSymbolProvider` 注册的任意 provider；大纲只**枚举消费**。markdown 由内置插件 `extensions/markdown` 提供（标题 kind=String，图标特例渲染成 `#`）。新语言要出现在大纲 → 给它加 DocumentSymbolProvider（[extend-language-plugin]）。
- **纯函数树工具**（`services/languageFeatures/`，无 Monaco 依赖）：`symbolTree.ts`——`findSymbolAtLine`（活动符号）/ `symbolAncestryPath`（跟随光标展开祖先），**Breadcrumbs.tsx 也用它**，改它要顾及面包屑；`outlineFlatten.ts`——`flattenOutline`（@ 前序）/ `groupSymbolsByKind`（@: 分组）。
- **图标**：`workbench/symbols/symbolIcon.tsx`——按 kind+languageId 映射 codicon + 语义色；markdown 标题特例。

## @ / @: 符号快速选择（复用大纲的 reveal/preview 三连）

`services/quickInput/providers/FileSymbolQuickAccessProvider.ts`：打开时 `captureViewState()` 存快照；`onDidChangeActive` → `previewSymbol`（实时高亮不移光标）；`onDidAccept` → `revealSymbol`；取消 → `restoreViewState`。**这三个方法目前只有文件编辑器分支有实质行为**（preview 分支 capture/preview/restore 基本 no-op；graph 分支 previewSymbol 有实质行为——scrollToCommit 只滚动）。改这三个方法时记得这一点。

## 关键架构决策

- **分支收敛在三处**：`_attach*` / `revealSymbol` / `_recomputeActiveSymbol`，其余全主干——「给预览加大纲」当初只加了一个分支，没动主干。
- **预览用 controller 句柄而非直连**：预览是纯 React div 没有 Monaco API，`IMarkdownPreviewController` 抽象「滚到某行/顶部是第几行/聚焦/滚动事件」，让两分支对称。
- **冷启动重试**：DocumentSymbol 依赖 LS，冷启动有延迟；指数退避 + generation 作废，避免「打开文件大纲一直空」又不无限重试（e2e `smoke.outline.spec.ts` 用 `test.slow()` + 轮询的原因）。
- **偏好持久化用 GLOBAL scope**：sort/follow/filter 是跨工作区用户习惯（对标 VSCode）；折叠信号是瞬时 UI 动作，不持久化。

## 常见任务 → 改哪里

- **改排序/过滤/折叠/跟随光标行为或 UI**：`OutlineView.tsx` + `OutlineViewToolbar.tsx` + `outlineViewState.ts`（新偏好加 observable+setter）；可持久化偏好别忘 `OutlineViewStateContribution.ts` 的 hydrate/写回 + `PersistedOutlineState`。
- **改大纲项点击/回车跳转**：`OutlineService.revealSymbol`——**三个分支都要改**（file/preview/session），保持对称（尤其 focus）。
- **改活动符号判定**：`_recomputeActiveSymbol` + `symbolTree.findSymbolAtLine`（面包屑同源）。
- **新增一类编辑器的大纲支持**：仿预览/会话分支——建 Registry + controller 接口，`_attachActiveEditor`/`revealSymbol`/`_recomputeActiveSymbol` 加分支，主干不动。
- **AI 会话大纲**（`AcpSessionEditorInput`，仅整页 tab 模式）：`AcpSessionOutlineRegistry` + `IAcpSessionOutlineController`（controller 直接暴露 `session.timeline` observable，OutlineService **不注入任何 ACP service**——避开 DI 顺序问题）。纯函数 `acpTimelineOutline.ts::timelineToOutline` 合成 DocumentSymbol 树，按 DFS 分配**伪行号** + `keyByLine`/`lineByKey` 双向映射（`m:<id>`/`t:<id>`，子项 `/`-拼）。languageId `ACP_OUTLINE_LANGUAGE_ID='acp.session'`，`symbolIcon.tsx` 按 `decodeAcpOutlineKind` 画 role/tool 图标。ChatBody 挂载时 register controller，handleScroll fire onDidScroll。**sidebar 停靠模式不支持**（会话不占 activeEditor）。
- **Git/P4 图谱大纲**（`GitGraphEditorInput`/`PerforceGraphEditorInput`）：`GraphOutlineRegistry` + `IGraphOutlineController`（`services/gitGraph/graphOutline.ts`，两图谱共用）。纯函数 `graphCommitsToOutline` 合成扁平树：伪行号=序号+1，`keyByLine`/`lineByKey` 桥接；kind 哨兵 `GRAPH_COMMIT_KIND=200`/`GRAPH_PENDING_KIND=201`（git uncommitted/p4 pending），`symbolIcon.tsx` 按哨兵画 git-commit/primitive-dot。reveal：行→hash→`controller.selectCommit`（= 点击行的完整语义）；preview：`scrollToCommit` 只滚动；active：`getSelectedHash`→line→`findSymbolAtLine`。这正是 Go to Symbol（ctrl+r）在图谱编辑器列提交的机理。
- **给预览大纲加新交互**：扩 `IMarkdownPreviewController`（三处同步），见上。
- **某语言不显示大纲**：不是大纲的问题——给它加 DocumentSymbolProvider（[extend-language-plugin]）；先 e2e probe `getOutlineSymbols()` 确认 service 层有没有拿到符号，再判断 provider 缺失还是视图问题。
- **改符号图标/颜色**：`workbench/symbols/symbolIcon.tsx`。

## 易踩坑速记

1. **revealSymbol 漏 focus**（已修勿回退）：preview 分支 `scrollToLine` 后再 `focus()`，file 分支末尾 `editor.focus()`，否则回车后焦点滞留在大纲树。
2. **TreeModel 切文档不清 `_focused`**：`onTreeFocus` guard 判「焦点项仍可见」，不能只判 `focused != null`。
3. **聚焦自动选中用 Tree 的 onFocus prop**：大纲常空挂载（冷启动），手动 `containerRef.addEventListener('focus')` 会因挂载时 ref 为 null 且 effect 不重跑而永远漏挂。
4. **预览源 model 用 `peek` 不用 `acquire`**：`_attachPreview` 只读源 model，acquire 会泄漏引用；「孤立预览」（源文件从未打开）peek 拿不到 → 大纲暂空（已知限制）。
5. **data-line 0-based vs 行号 1-based**：`previewScrollMap.collectEntries` 读的 DOM `data-line` 是 0-based，映射函数对外用 1-based，跨这层别忘 ±1。
6. **加 View 三件套缺一不可**：Container/View/ViewComponentRegistry 漏一处，大纲标签页出不来或空白（apps/editor/CLAUDE.md 套路 B）。

## 验证

```bash
cd apps/editor && pnpm vitest run --project renderer \
  src/renderer/services/languageFeatures/__tests__/OutlineService.test.ts \
  src/renderer/workbench/outline/__tests__/OutlineView.test.tsx \
  src/renderer/workbench/editor/__tests__/previewScrollMap.test.ts
pnpm check
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物
cd apps/editor && pnpm exec playwright test specs/smoke.outline.spec.ts
cd extensions/markdown && pnpm e2e -- specs/markdownPreview.spec.ts    # 含「切预览后大纲仍在」（扩展自带 e2e）
```

e2e 探针（`renderer/e2e/probe.ts`）：`getOutlineSymbols()`（递归扁平符号名）/ `getOutlineUri()` / `getActiveEditorTypeId()`。

## 关键参考路径（补充）

- `services/gitGraph/graphOutline.ts`（graph 分支）/ `workbench/editor/Breadcrumbs.tsx`（同源消费者）/ `services/quickInput/providers/FileSymbolQuickAccessProvider.ts`（@/@:）
- 相关 skill：[extend-language-plugin]（符号来源/语言插件套路）；预览线② 见 `workbench/markdown/CLAUDE.md`

## 其它

- 后续用本文，发现新经验，需同步更新本文件
