# apps/editor/src/renderer/workbench/outline/CLAUDE.md

outline（大纲）子系统的视图层在本目录（OutlineView/OutlineViewToolbar/outlineViewState），服务主干 EditorOutlineTracker/OutlineService 在 `services/languageFeatures/`（语言无关，与 symbolTree 等纯函数同域）。本文是 outline 子系统的上下文地图（处理相关任务前通读）。

outline 是**语言无关**功能：从活跃编辑器的 **DocumentSymbol 树**派生侧栏树视图，并跟踪「光标/视口当前所在符号」。符号来自任意 `DocumentSymbolProvider`（TS/JSON/markdown 内置插件…），那是 [extend-language-plugin] 的事。

> ⚠️ 第一原则：先认领改动落在**抽象主干**还是**编辑器类型分支**。
> - **抽象主干**（与编辑器类型无关）：符号树 observable、排序/过滤/折叠/跟随光标、树渲染、视图状态持久化、图标——绝大多数需求在这。
> - **编辑器类型分支**：只有「**怎么定位到具体编辑器**」按输入类型分叉（file/preview/session/graph，见数据流图）。新增一类编辑器的大纲支持才碰这里。
> 通用逻辑误塞进某分支 = 另一种编辑器白改。

## 数据流一图

```
DocumentSymbolProvider(任意语言) → ILanguageFeaturesService.getDocumentSymbolProviders(lang)
  ↓
EditorOutlineTracker（**每个 editor group 一个**：outline / activeSymbol / sourceKind 三条 observable，主干）
  ↓ ① 定位编辑器（唯一类型分支：FileEditorRegistry(带 groupId 消歧) / MarkdownPreview / AcpSessionOutline / GraphOutline）
OutlineService（门面：每 group 一个 tracker，自身 observable = **活动组**那个）
OutlineView (Tree) 读 outlineViewState（排序/过滤/折叠/跟随光标）
  点击/回车 → revealSymbol → 分支回写（各分支见下）
姊妹消费者（同数据但不渲染大纲）：Breadcrumbs.tsx（`forGroup(本组 id)`）、FileSymbolQuickAccessProvider（@ / @:，走活动组）
```

## 核心服务：EditorOutlineTracker + OutlineService（`services/languageFeatures/`）

- **`EditorOutlineTracker`**：对外即 `IOutlineScope`（`outline` / `activeSymbol` / `sourceKind` 三条 observable + `revealSymbol` / `captureViewState` / `previewSymbol` / `restoreViewState`）。构造参数 `{ groupId, activeEditor, languageFeatures, logger, cache }`——`activeEditor` 是**它那一组**的，`groupId` 供 `FileEditorRegistry.get(input, groupId)` 消歧。
- **`OutlineService` 门面**：注入 `IEditorGroupsService`，每 group 一个 tracker（`onDidAddGroup`/`onDidRemoveGroup` 建销、`onDidActiveGroupChange` 切 `_activeGroupId`）；自身三条 observable = `derived(活动组 tracker)`，四个方法委托活动 tracker——**OutlineView / @ / @: / e2e 探针看到的仍是活动组**。`forGroup(groupId)` 取某组 tracker；取不到（组已移除那一帧）返回**空 scope**，绝不回退活动组。
- **`OutlineSymbolCache`（跨 tracker 共享）**：LRU 符号树（键 `uri@version`，上限 8）+ **in-flight pull 池**（同键只发一次），分屏同开一个文件只拉一次 RPC。
- **唯一类型分支** `_attachActiveEditor()`：file `FileEditorRegistry.get(input, groupId)` + cursor 事件；preview `MonacoModelRegistry.peek(sourceUri)` 拿**源文件共享 model**（预览无 Monaco）+ `controller.getTopVisibleLine()`/`onDidScroll`；session `AcpSessionOutlineRegistry`；graph `GraphOutlineRegistry.get(kind, instanceKey)`（instanceKey = input 的 `resource.toString()`，多实例按实例路由）。
- **`revealSymbol` 两分支必须对称**：file `setPosition + revealLineInCenterIfOutsideViewport + focus`；preview `scrollToLine + focus`。**漏 focus 就是「点了大纲焦点不回编辑器」的 bug**（已修勿回退）。
- **冷启动重试退避**（per-tracker）：`_attachGeneration` 计数 + 指数退避（250→2000ms，预算 180s）；切文件 generation 递增作废旧链；`onDidChangeMarkers`（诊断到达≈LS 就绪）也触发重拉；generation 各自独立，切组不打断背景组的重试链。
- DI：`renderer/main.tsx` `createInstance(OutlineService)`（注入 `IEditorGroupsService` + `ILanguageFeaturesService`）。

## 视图层（本目录）

```
OutlineView.tsx          树视图主体。通用 Tree（@universe-editor/workbench-ui）+ useOwnedTreeModel；读 outlineViewState 驱动；点击/onActivate → revealSymbol；onTreeFocus：无「仍可见」焦点项时自动选 activeSymbol→首行；useViewFocusable('workbench.view.outline.main') 注册容器
OutlineViewToolbar.tsx   标题栏：折叠/展开 + 溢出菜单（Follow Cursor / Filter on Type / Sort By position·name·kind），全读写 outlineViewState
outlineViewState.ts      模块级 observable 单例：followCursor / filterOnType / sortBy（持久化）+ allCollapsed（视图回写）+ collapseAll/expandAll（信号，不持久化）
```

- **Tree 契约**：`TreeModel.refresh()` 不清 `_focused`（只有 `reset()` 清），切文档后旧焦点 id 残留——`onTreeFocus` 的 guard 必须判「焦点项**仍在可见列表里**」，不能只判非空。
- **聚焦自动选中走 Tree 的 `onFocus` prop**（容器生命周期由 Tree 托管），勿改回手动 `addEventListener('focus')`：大纲常冷启动空挂载，手动监听会因挂载时 ref 为 null 而永远漏挂。

## 注册接入点（加 View 两步 + 状态持久化）

- 两步：`BuiltInViewContainersContribution.ts`（Container `workbench.view.outline` 在 SecondarySideBar）+ `BuiltInViewsContribution.ts`（`registerViewWithComponent` 绑 View `workbench.view.outline.main` ↔ OutlineView）——即 apps/editor/CLAUDE.md 套路 B。
- 持久化：`contributions/OutlineViewStateContribution.ts` 存 GLOBAL storage（key `outline.viewState`，只存 followCursor/filterOnType/sortBy），启动 hydrate。

## 命令 / 快捷键

`actions/layoutActions.ts` → `FocusOutlineAction`（`outline.focus`，`ctrl+shift+q`）：`ILayoutService.focusView('workbench.view.outline.main', …)` → 触发 `onTreeFocus` 自动选中。`actions/index.ts` 注册。

## 与预览协作的句柄（编辑器类型分支用到）

```
services/editor/FileEditorRegistry.ts           FileEditorInput → 活的 Monaco editor（按 groupId 消歧）
workbench/editor/monaco/MonacoModelRegistry.ts  URI↔TextModel 引用计数表；peek() 只读不改计数（预览分支拿源文件 model）
services/editor/MarkdownPreviewRegistry.ts      source URI → IMarkdownPreviewController：scrollToLine / getTopVisibleLine / focus / onDidScroll（预览是 React div 没有 Monaco，这是大纲够到它的唯一句柄）
workbench/editor/previewScrollMap.ts            纯函数：源行号↔预览像素（读 DOM data-line；data-line 0-based，对外统一 1-based）
```

> 预览这条线属于 markdown 子系统（`workbench/markdown/CLAUDE.md` 线②）。**给预览加新交互优先扩 `IMarkdownPreviewController`**，三处同步：接口（MarkdownPreviewRegistry.ts）/ 实现（MarkdownPreviewEditor.tsx 的 controller 对象）/ 调用（EditorOutlineTracker.revealSymbol / _recomputeActiveSymbol）。

## 符号数据来源 & 图标 & 同源消费者

- **符号来源**：`ILanguageFeaturesService.registerDocumentSymbolProvider` 注册的任意 provider；大纲只**枚举消费**。markdown 由内置插件 `extensions/markdown` 提供（标题 kind=String，特例渲染成 `#`）。新语言要出现在大纲 → 加 DocumentSymbolProvider（[extend-language-plugin]）。
- **纯函数树工具**（`services/languageFeatures/`，无 Monaco 依赖）：`symbolTree.ts`——`findSymbolAtLine`（活动符号）/ `symbolAncestryPath`（展开祖先），**Breadcrumbs.tsx 也用它**；`outlineFlatten.ts`——`flattenOutline`（@ 前序）/ `groupSymbolsByKind`（@: 分组）。
- **图标**：`workbench/symbols/symbolIcon.tsx`——按 kind+languageId 映射 codicon + 语义色；markdown 标题特例。

## @ / @: 符号快速选择（复用大纲的 reveal/preview 三连）

`services/quickInput/providers/FileSymbolQuickAccessProvider.ts`：打开时 `captureViewState()` 存快照；`onDidChangeActive` → `previewSymbol`（高亮不移光标）；`onDidAccept` → `revealSymbol`；取消 → `restoreViewState`。**这三个方法只有文件编辑器分支有实质行为**（preview 分支基本 no-op；graph 分支 previewSymbol 会 scrollToCommit）。

## 关键架构决策

- **tracker per editor group，门面只做分发**：分屏时每组各渲染一个 FileEditor（各一条面包屑），**每组必须跟随自己的 activeEditor**——全局单例只跟 `IEditorService.activeEditor`（活动组镜像）时，背景组面包屑会显示聚焦组的路径。OutlineView / @ / @: 仍要活动组，故门面留活动组语义 + `forGroup(groupId)` 给面包屑。
- **分支收敛在三处**：`_attach*` / `revealSymbol` / `_recomputeActiveSymbol`（现全在 `editorOutlineTracker.ts`），其余全主干——「给预览加大纲」当初只加一个分支，没动主干。
- **预览用 controller 句柄而非直连**：预览是纯 React div 没有 Monaco API，`IMarkdownPreviewController` 抽象「滚到某行/顶部是第几行/聚焦/滚动事件」，让两分支对称。
- **冷启动重试**：DocumentSymbol 依赖 LS，冷启动有延迟；指数退避 + generation 作废，避免「打开文件大纲一直空」又不无限重试（e2e `smoke.outline.spec.ts` 用 `test.slow()` + 轮询的原因）。
- **偏好持久化用 GLOBAL scope**：sort/follow/filter 是跨工作区用户习惯（对标 VSCode）；折叠信号是瞬时 UI 动作，不持久化。

## 常见任务 → 改哪里

- **改排序/过滤/折叠/跟随光标行为或 UI**：`OutlineView.tsx` + `OutlineViewToolbar.tsx` + `outlineViewState.ts`（新偏好加 observable+setter）；可持久化偏好别忘 `OutlineViewStateContribution.ts` 的 hydrate/写回。
- **改大纲项点击/回车跳转**：`EditorOutlineTracker.revealSymbol`——**三个分支都要改**（file/preview/session），保持对称（尤其 focus）。
- **改活动符号判定**：`EditorOutlineTracker._recomputeActiveSymbol` + `symbolTree.findSymbolAtLine`（面包屑同源）。
- **改「哪个组的 outline」**：`OutlineService`（建/销 tracker、`forGroup`、活动组派生）+ `Breadcrumbs.tsx`（读 `useEditorGroup()` 的本组 scope）。
- **新增一类编辑器的大纲支持**：仿预览/会话分支——建 Registry + controller 接口，`_attachActiveEditor`/`revealSymbol`/`_recomputeActiveSymbol` 加分支，主干不动。
- **AI 会话大纲**（`AcpSessionEditorInput`）：`AcpSessionOutlineRegistry` + `IAcpSessionOutlineController`（controller 暴露 `session.timeline`；OutlineService **不注入 ACP service**——避开 DI 顺序）。纯函数 `acpTimelineOutline.ts::timelineToOutline` 按 DFS 分配**伪行号** + `keyByLine`/`lineByKey` 双向映射；languageId `acp.session`；reveal 落 `ChatBody.scrollToKey`（先展开折叠祖先），ChatBody 挂载时 register controller。细节见 `services/acp/session/CLAUDE.md`。
- **Git/P4 图谱大纲**（`GitGraphEditorInput`/`PerforceGraphEditorInput`）：`GraphOutlineRegistry` + `IGraphOutlineController`（`services/gitGraph/graphOutline.ts`，两图谱共用）。`graphCommitsToOutline` 合成扁平树：伪行号=序号+1，`keyByLine`/`lineByKey` 桥接；kind 哨兵 `GRAPH_COMMIT_KIND=200`/`GRAPH_PENDING_KIND=201`（git uncommitted/p4 pending），`symbolIcon.tsx` 按哨兵画图标。reveal：行→hash→`controller.selectCommit`；preview：`scrollToCommit` 只滚动；active：`getSelectedHash`→line→`findSymbolAtLine`。Go to Symbol（ctrl+r）在图谱里列提交即走这条。
- **给预览大纲加新交互**：扩 `IMarkdownPreviewController`（三处同步），见上。
- **某语言不显示大纲**：不是大纲的问题——给它加 DocumentSymbolProvider（[extend-language-plugin]）；先 e2e probe `getOutlineSymbols()` 确认 service 层有没有拿到符号，再判断 provider 缺失还是视图问题。
- **改符号图标/颜色**：`workbench/symbols/symbolIcon.tsx`。

## 易踩坑速记

1. **revealSymbol 漏 focus**（已修勿回退）：preview 分支 `scrollToLine` 后再 `focus()`，file 分支末尾 `editor.focus()`，否则回车后焦点滞留在大纲树。
2. **TreeModel 切文档不清 `_focused`**：`onTreeFocus` guard 判「焦点项仍可见」，不能只判 `focused != null`。
3. **聚焦自动选中用 Tree 的 onFocus prop**：大纲常空挂载（冷启动），手动 `containerRef.addEventListener('focus')` 会因挂载时 ref 为 null 且 effect 不重跑而永远漏挂。
4. **预览源 model 用 `peek` 不用 `acquire`**：`_attachPreview` 只读源 model，acquire 会泄漏引用；「孤立预览」（源文件从未打开）peek 拿不到 → 大纲暂空（已知限制）。
5. **data-line 0-based vs 行号 1-based**：`previewScrollMap.collectEntries` 读的 `data-line` 是 0-based，映射函数对外用 1-based，跨这层别忘 ±1。
6. **加 View 三件套缺一不可**：Container/View/ViewComponentRegistry 漏一处，大纲标签页出不来或空白（apps/editor/CLAUDE.md 套路 B）。
7. **`FileEditorRegistry.get(input)` 不带 groupId = 取「最后注册」的实例**（分屏双开时是另一组的 Monaco）；tracker 内一律 `get(input, this._groupId)`。本组未挂载时它返回 undefined——活动符号暂空，挂载后 `onDidChange` 触发 re-attach 补上。
8. **`forGroup(groupId)` 必须返回稳定对象**：`useObservable` 按 observable **引用**判断是否重订阅（`useService.ts`），每次返回新对象 → 面包屑无限重订阅。
9. **别用 `observableFromEvent` 桥接 `IEditorGroup.onDidActiveEditorChange`**：它的内部订阅是无主 tracked disposable，e2e 泄漏门禁会抓（`acpSessionEditorInput.ts:99` 同款）。用 `observableValue` + `_register(事件)`。

## 验证

```bash
cd apps/editor && pnpm vitest run --project renderer-node --project renderer-dom \
  src/renderer/services/languageFeatures/__tests__/OutlineService.test.ts \
  src/renderer/workbench/outline/__tests__/OutlineView.test.tsx \
  src/renderer/workbench/editor/__tests__/Breadcrumbs.test.tsx \
  src/renderer/workbench/editor/__tests__/previewScrollMap.test.ts
pnpm check
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物
pnpm e2e specs/smoke.outline.spec.ts specs/smoke.breadcrumbs.spec.ts   # 仓库根执行
cd extensions/markdown && pnpm e2e -- specs/markdownPreview.spec.ts    # 切预览后大纲仍在
```

e2e 探针（`renderer/e2e/probe.ts`）：`getOutlineSymbols()` / `getOutlineUri()` / `getActiveEditorTypeId()`。

## 其它

- 后续用本文，发现新经验，需同步更新本文件
