# apps/editor/src/renderer/workbench/scm/CLAUDE.md

本目录是 SCM 域 workbench 侧的家：SCM 视图（`ScmView.tsx`）、mergeConflict、以及 dirty-diff 的视图代码（`dirtyDiff/`，含 gutter 色条与内联 peek）；dirty-diff 的服务端在 `apps/editor/src/renderer/services/scm/`。本文收录案例「dirty-diff 内联 peek」（处理相关任务前通读）。

## 多 provider 仲裁与双格式冲突标记（SCM 可视化泛化）

gutter / peek / blame / open-changes 对 git 与 perforce 共用同一套 renderer 代码，provider 只在**数据路由层**出现：

- **🔴「resource → host path」一律走 `scmHostPath(resource, remoteAuthority)`**（`services/scm/scmHostPath.ts`）。SCM 线上契约（`ISourceControlResourceStateDto.resourceUri` / `rootUri`）携带的是**裸 host fs-path 字符串**，所以门控必须按**主机作用域**而非 scheme 白名单：远程窗口里也能打开本地 `file:` 资源，Windows 远端的 `C:\repo\a.ts` 与本机同名路径按 `fsPath` 会跨主机误命中，把别的机器的 git 状态/HEAD 画到本地文件上。**禁止**裸 `resource.scheme === 'file'` 门控（曾致远程工作区 gitignore 变暗整体失效）与裸 `scmPathKey(resource.fsPath)` 查表；装饰查表只走 `IScmDecorationsService.getFile/getFolder`（它们内部已过 `scmHostPath`）。authority 在 React 里取 `useRemoteAuthority()`（**不要** `useMemo` 裸读 `workspace.current`），非 React 取 `currentRemoteAuthority(workspace.current)`；Action2 里须在任何 `await` 之前同步取。
- **仲裁**：`resolveScmProviderId(sourceControls, fsPath, selectedRootUri?)`（`services/extensions/ScmService.ts`）——selectedRootUri 命中的归属者优先（SCM 面板当前选择的 repo），未命中回退最长前缀；同 root 多 provider 首个命中者赢。消费方从 `workbench/scm/scmViewState.ts` 的 `scmViewState.selectedRepo` 取当前选择，并挂 autorun 在切换时重触发刷新。**还要挂 `sourceControls` 的 autorun**：启动竞态——selectedRepo 从 storage 恢复时目标 provider 的 source control 可能还没注册（扩展逐个激活），仲裁回退到最长前缀归属者；provider 后注册时必须重仲裁，否则回退结果一直粘住（踩过：恢复选择 p4 时先显示 git blame，要手动切 repo 才纠正）。blame 侧另配 `_refreshSeq` 代次守卫：回退 provider 的慢 fetch 后完成时不得覆盖新仲裁结果。
- **selectedRepo 的持久化在 workbench 层**（`ScmSelectedRepoContribution`，仿 `OutlineViewStateContribution`）：恢复+写回都不依赖 ScmView 挂载——曾放在 ScmView 的 React effect 里，SCM 面板不打开就不恢复，blame/dirty-diff 仲裁一直停在最长前缀回退（git blame 粘住直到面板获得焦点，第二次踩过）。hydrate 只在当前无内存值时应用存储值（竞态窗口内的显式选择优先），写回 autorun 无 first-pass skip（竞态胜出的选择也能落盘）。ScmView 只消费 `scmViewState.selectedRepo`。
- **选中仓库仲裁的覆盖面有两类语义，别混**：**显示类**（Explorer/标签页装饰 `ScmDecorationsService.decorations`、状态栏条目、ActivityBar 徽章）**全局跟随选中仓库**——选中 p4 时 git 的颜色/字母/supplementary/状态栏条目整体消失，反之亦然。装饰侧走 `resolveSelectedSourceControl(sourceControls, selectedRootUri)`（`services/extensions/ScmService.ts`，`find(rootUri===selected) ?? [0]` 回退）在 derived 里只取选中者；状态栏侧由 `ActiveRepoSyncContribution` 对**每个** provider 广播 `<providerId>.setActiveRepo`（选中者发 rootUri、其余不传参——显式 undefined 经嵌套 args 数组跨 IPC 会变 null，接收端一律 `== null` 判定），git/p4 各自 `setVisible(false)` 全 hide 且 `_render*` 短路（可见性用 `mgr.has(root)` 独立标志，**不能**读 `mgr.active`——它有回退 main/first 语义）。**行为类**（gutter dirty-diff、blame、open-changes 命令路由）仍按 **per-path** 仲裁（`resolveScmProviderId` selectedRepo 优先、回退最长前缀）——同一文件同属两 provider 时跟随选中，但只归未选中 provider 的文件照常可用。**「有没有改动」门控与显示解耦**：`IScmDecorationsService.hasChanges(resource)` 跨**所有** provider 判定（独立 `_anyProviderChanges` derived），供 dirty-diff 门控（`dirtyDiffActions`）与 `scmActiveResourceHasChanges` context key（`useEditorGroupScopedContextKey`）用——显示可以只画选中仓库，但选中 git 时 p4 文件的「打开更改」入口不能消失。
- **缓存分槽防串扰**：`DirtyDiffContribution` / `ScmBlameContribution` 的缓存 key = `providerId + '\n' + path`。旧 provider 的在飞 Promise 落旧槽，零串扰；切 repo 时**不清缓存**，旧槽保留供切回秒显。
- **ignored 变暗同样按 `selectedRepo` 仲裁**（`services/scm/ScmIgnoredResourcesService.ts`，git 与 p4 共用一条 `<providerId>.checkIgnore` 通路）：`_flush()` 必须把 `scmViewState.selectedRepo.get()` 作第三参传进 `resolveScmProviderId`——漏传就永远按最长前缀选 git，p4 workspace 里嵌套的 git repo 让用户在面板上切到 p4 也不生效（本次踩过：dirty-diff/blame 早已传，ignored 与 working-tree hint 都曾漏传）。与上一条**刻意不同的是它不分槽**：切 repo 时整体 `_invalidate()` 重查。理由——ignored 的缓存值是布尔、一条批量命令就能重解析全部，而 dirty-diff/blame 缓存的是 HEAD 正文 / annotate（昂贵、要秒切回）；分槽只会给这个服务多引入一套失效模型。同理它也订阅 `sourceControls`（同上条的启动竞态）。
- **Explorer 的 working-tree hint 预热提示（`ScmWorkingTreeHintService`，p4 的 `<providerId>.checkWorkingTree` pull 通道 + 后台 reconcile 扫描的目录聚合）同样按 `selectedRepo` 仲裁**，两处必改：①仲裁 autorun 必须同时 read `scmViewState.selectedRepo`——SCM 源切换只改 selectedRepo 不改 sourceControls，漏读则文件 LRU 与扫描目录染色永久残留（本次踩过：切到 git 后 p4 预热提示不消失）；②`_flush()` 必须把 `scmViewState.selectedRepo.get()` 作第三参传进 `resolveScmProviderId`（同 ignored）。**缓存按 provider id 分槽**（同 dirty-diff/blame 的槽先例，这里用嵌套 `Map<providerId, Map<...>>`）：切 repo 只改读取过滤 + bump version、**不清数据**——读取时 `_ownerProviderId`（resolveScmProviderId）与 `_visibleProviderId`（resolveSelectedSourceControl；selectedRepo 未设置时不过滤、各槽合并显示）不一致即返回 undefined。全清会踩第二个坑：p4 的 reconcile 扫描是 once-per-session（`_reconcileScanArmed` 守卫），清掉 `_scanFolders` 槽后切回 p4 染色永久丢失（本次踩过）。文件事件删**全部**槽的该 key、decorations 刷新全槽标 stale、workspace/sourceControls 变化才整体 `_invalidate()`。git 无 checkWorkingTree 命令，切到 git 后重查落 clean、提示整体消失。
- **blame 状态栏点击**走内部命令 `scm.blame.openCommit` → 派生命令约定 `` `${providerId}-graph.view` ``（`git-graph.view` / `perforce-graph.view` 均为 renderer Action2）；该命令未注册时状态栏项不带 command（不可点）。
- **配置在 `scm.*` 命名空间**（`ScmConfigurationContribution` 注册）：`scm.blame.*`（6 项）+ `scm.mergeEditor` + `scm.diffDecorations`（`all|gutter|overview|minimap|none`，控制 dirty-diff 三处装饰的显隐；派生纯函数 `resolveDirtyDiffDecorationsVisibility` 在 `contributions/dirtyDiff.ts`）。扩展只读不写；git 扩展的 `git.blame.*` / `git.mergeEditor` 已删。
- **dirty-diff 装饰画三处**（gutter 色条 / 总览标尺 / minimap 色带），颜色**必须传具体 hex**：我们是 standalone monaco，它的主题色表只含 `editor*`/`diffEditor*` 前缀，传 ThemeColor `{id}` 解析不到 `minimapGutter.*` 会静默不画或错色。`DirtyDiffContribution._resolveColors()` 用 `normalizeColor(theme.getColor(id))` 归一成 6/8 位 hex。因此**主题切换必须两步走**：重算 `_colors` + 重新 `collection.set(...)`——monaco 自己的颜色缓存失效只遍历 overviewRuler 桶，纯 minimap 的 decoration 永远不会被刷新。`_render` 是唯一写 `_regions` + `_navigation.setState` 的入口，主题/配置变更只走 `_applyDecorations()`。
- **shift+alt+y 是唯一 open-changes 入口**：renderer Action2 `workbench.action.scm.openChanges`（`actions/dirtyDiffActions.ts`，「打开更改 / Open Changes」，category `Source Control`），四合一——快捷键 `Shift+Alt+Y` / 编辑器标题栏对比图标 / 命令面板 / explorer 右键（通用 `3_compare` 组，git 与 p4 文件都有）。`*.openChange` 已降级为纯 provider 能力命令（与 `getHeadContent`/`stageChange` 同级，仅作 SCM 行 `resource.command` 与统一命令委派目标），无参 fallback 已删；两扩展 manifest 不得再自建 `editor/title`/`explorer/context` 条目（各自 `__tests__/openChangeContribution.test.ts` 守护——重复条目的症状是同属两 provider 的文件出现两个一样的对比图标）。**只有「拿到基线」这一种情况归 renderer 处理**：目标 == 活动 `FileEditorInput` 且 `getHeadContent` 返回非 null 时走 buffer-aware（吃到未保存编辑），其余一律委派 `<providerId>.openChange`。`getHeadContent` 把「无基线」与「取基线失败」都塌缩成 `null`，只有 provider 分得清——p4 失败要 toast、open-for-add 要开纯文件，renderer 自作主张拼个空左侧会把两者都渲染成「整个文件新增」。
- **mergeConflict/conflictParser.ts 单状态机识别两种标记格式**：git 七字符（`<<<<<<<`/`|||||||`/`=======`/`>>>>>>>`）与 p4 四字符（`>>>> ORIGINAL`→base、`==== THEIRS`→incoming、`==== YOURS`→current、`<<<<`→结束；YOURS 可省略 = 空 current 侧）。安全依据：生成者互斥、开始标记互不前缀、块内转移只认当前格式标记、残缺块在下一个开始标记处整体丢弃。`CONFLICT_START_MARKERS` 数组供 `inlineConflictController` 预筛。
- 验证单测：`services/extensions/__tests__/ScmService.test.ts`（仲裁）、`services/scm/__tests__/ScmIgnoredResourcesService.test.ts`（含 p4 路由、嵌套 git-in-p4 按 selectedRepo 切换、ignore 规则文件变更失效）、`services/scm/__tests__/ScmWorkingTreeHintService.test.ts`（含嵌套 git-in-p4 按 selectedRepo 仲裁与切换失效）、`workbench/scm/mergeConflict/__tests__/conflictParser.test.ts`（双格式）、`contributions/__tests__/ScmBlameContribution.test.ts`（含 provider 后注册重仲裁 + 乱序守卫用例）；e2e 走 `extensions/perforce/e2e/specs/perforceDirtyDiffBlame.spec.ts`（fake p4 的 annotate/changes changeMeta 种子）与 `perforceIgnored.spec.ts`（ignored 种子）。

## 案例：dirty-diff 内联 peek

在某行下方弹一个浮层，里面是一个**真 Monaco diff editor**。这是 VSCode `QuickDiffWidget`（基于 `PeekViewWidget`/`ZoneWidget` + `EmbeddedDiffEditorWidget`）的功能；我们是 **standalone monaco**，VSCode 那些私有 PeekView/embedded-diff 模块被 tree-shake 掉了，但 **`monaco.editor.createDiffEditor` 在 standalone 完全可用**（`DiffEditor.tsx` 已证），所以直接内嵌一个 diff editor，**双侧行号 / 语法高亮 / 内部滚动 / reveal 全部白拿**。区别于 [register-monaco-command]（接命令）/ [fix-keybinding-not-firing]（键不触发诊断）：本案例是"造一个内嵌 diff 浮层并把交互接齐"。

> ⚠️ 第一原则：**不要手写 DOM diff**。本仓库初版踩过这个坑——用 content-widget + `computeLineDiff` 渲染增删行 HTML，结果无语法高亮、宽度被内容撑不满宽、长 diff 撑爆。终版改内嵌 diff editor 后这些问题一次性消失。手写那套已全删，别回退。参考实现就是 dirty-diff peek（见末尾路径），照抄它的骨架。

### 核心渲染骨架：overlay-widget + 空 view-zone 占位

VSCode `ZoneWidget` 的精髓不是把内容塞进 view-zone 的 DOM（那层**不可交互、不满宽、不可滚**），而是：

1. **空 view-zone 占位**——只为在文本流里"撑出"垂直高度（把下方代码推开），DOM 节点是个空 div。
2. **overlay-widget 渲染真面板**——overlay 在编辑器的可交互、可滚动层，能满宽（盖住行号区）、按钮可点、滚轮可用。
3. **view-zone 的 `onDomNodeTop`/`onComputedHeight` 回调驱动 overlay 的 `top`/`height`**——让浮层随滚动贴着占位带走。

```
overlay DOM = 面板（header 动作栏 + body 容器 + 底部拖动手柄）
              position:absolute; z-index:10; 初始 top:-1000px（等回调定位，免闪烁）
  ├─ body 里 createDiffEditor(...) ← 真 diff editor
空 view-zone（afterLineNumber = 变更末行, heightInPx = 面板高, domNode = 空div）
  ├─ onDomNodeTop(top)      → node.style.top = top
  └─ onComputedHeight(h)    → node.style.height = h; 重排内嵌 diff editor
```

overlay 自身定位返回 `getPosition: () => null`（自管位置）。teardown 时务必 `removeOverlayWidget` + `changeViewZones(removeZone)` + diff editor `setModel(null)`+`dispose()` + 两个临时 model `dispose()`。

### 三套照搬 VSCode 的布局公式（别自创）

全部来自 `vscode/src/vs/editor/contrib/zoneWidget/browser/zoneWidget.ts` + `quickDiffWidget.ts`，直接抄：

1. **overlay 横向定位**（满宽、不压滚动条、盖住最左行号区）：
   ```
   left  = (minimap 在左 ? minimapWidth : 0)         // 一般 0
   width = info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth
   ```
   用 `editor.getLayoutInfo()`。订阅 `onDidLayoutChange` 重算。

2. **高度：初始限高 + 可拖动**（VSCode `showChange` + ZoneWidget `_getMaximumHeightInLines`）：
   ```
   初始 = clamp( 变更高 + 上下文(~6) + headerLines,  下限8,  floor(编辑器行数/3) )
   拖动上限 = floor(编辑器行数 * 0.8)
   编辑器行数 = getLayoutInfo().height / fontInfo.lineHeight
   ```
   拖动：底部放一条 `ns-resize` 手柄，`mousedown`→全局 `mousemove`，把 px 增量换算成**取整行增量**（`delta<0?ceil:floor`）再 clamp，改 `heightInLines` 后 `changeViewZones(accessor.layoutZone(id))` 重排。E2E 用的 `resizeByPx(deltaPx)` 走同一套数学。

3. **出视口才滚入**（VSCode `revealRange`）：
   ```
   editor.revealLineInCenterIfOutsideViewport(region.endLine)
   ```
   内嵌 diff editor 侧：`onDidUpdateDiff` 一次性回调里 `getModifiedEditor().revealLineInCenter(变更首行)`，让长 hunk 打开时滚到首个改动行。

### 内嵌 diff editor 的关键 options

```ts
createDiffEditor(bodyEl, {
  automaticLayout: false,            // 自己 layout（随 view-zone 高/编辑器宽）
  readOnly: true, originalEditable: false,
  renderSideBySide: false,           // 内联模式（VSCode quick diff 同款）
  renderOverviewRuler: false, renderMarginRevertIcon: false,
  minimap: { enabled: false }, folding: false, stickyScroll: { enabled: false },
  diffAlgorithm: 'advanced', ignoreTrimWhitespace: false,
  lineNumbers: 'on',                 // 双侧行号
  fontFamily/fontSize/lineHeight: 取宿主 editor 的 EditorOption.fontInfo,  // 字体一致
  scrollbar: { alwaysConsumeMouseWheel: true, ... },  // 滚轮不穿透到宿主编辑器
})
```
两个临时 model 用唯一 scheme（如 `dirtydiff-peek://original/<seq>`），`setModel({original, modified})`，每次重开 +seq 防撞。

### 把交互接齐（Esc / 命令 / E2E）：context-key + host-registry

浮层是命令式 DOM，不在 React 树里，命令/键位/探针够不到它——用**模块单例 registry** 暴露 host（仿 `MarkdownPreviewRegistry`）：

1. **host-registry**（`DirtyDiffPeekRegistry`）：`setHost/clearHost/getHost`，host 接口暴露 `openAtLine/closePeek/isPeekOpen/...`。承载浮层的 contribution 在绑定活动编辑器时 `setHost(this)`，dispose 时 `clearHost`。任一时刻至多一个 host。
2. **context-key**（`dirtyDiffPeekVisible`，VSCode 叫 dirtyDiffVisible）：contribution 用 `contextKeyService.createKey` 建，开/关 peek 时 set；**所有关闭路径统一走一个 `closePeek()`** 同步清 key（别散落多个 `controller.close()`，会漏清）。
3. **Esc 命令**（`CloseDirtyDiffPeekAction`）：`keybinding{ primary:'escape', when:'dirtyDiffPeekVisible', weight: WorkbenchContrib+50 }`——**weight 必须压过** Monaco 的 Esc 和工作台 `FocusActiveEditorGroupAction`（Esc @ WorkbenchContrib=200），否则编辑器没聚焦时被它抢走。run 里 `DirtyDiffPeekRegistry.getHost()?.closePeek()`。`registerAction2` 在 `actions/index.ts`。
4. 同理可加"在光标处打开 peek"命令（`ShowChangeAtCursorAction`）。

### E2E 套路

浮层在 overlay 层、命令式，**用 probe + host introspection 验，别靠 DOM 选择器**：probe 加 `openDirtyDiffPeekAtLine/getDirtyDiffPeekState(panelHeightPx,maxHeightPx,editorFirstVisibleLine)/isDirtyDiffPeekVisible/resizeDirtyDiffPeekByPx`（contract.ts 同步加类型）。spec 用真 git 仓库 + 长文件，在**远离顶部**处造一大块改动（既超 1/3 初始上限、又初始在视口外），一次断：①`panelHeightPx>0 且 ≤maxHeightPx`（封顶）②`editorFirstVisibleLine>1`（滚入视口）③`resizeByPx(大值)` 增高且不超上限 ④真 `page.keyboard.press('Escape')` 后 `isDirtyDiffPeekVisible()` 变 false。Esc 必须用**真键盘**（走 useGlobalKeybindingHandler 全链），别用 runCommand 绕过。

### 易踩坑速记

1. **别手写 DOM diff**（头号）：standalone 能 `createDiffEditor`，内嵌它，白拿行号/高亮/滚动。手写无高亮、不满宽、长 diff 撑爆。
2. **overlay 而非 content-widget**：content-widget 宽度被内容撑、不满宽、且不在可滚层；必须 overlay-widget + 空 view-zone 占位。
3. **滚轮穿透**：内嵌 diff editor 不设 `scrollbar.alwaysConsumeMouseWheel:true`，滚轮会穿到宿主编辑器，浮层内滚不动。
4. **Esc 抢不到**：weight 不够会被工作台/Monaco 的 Esc 截胡；用 `WorkbenchContrib+50`、`when` 挂 context-key。
5. **context-key 漏清**：多条关闭路径各自 `close()` 会漏 set false，下次 Esc 失灵；收敛到单一 `closePeek()`。
6. **布局随变化重算**：订阅 `onDidLayoutChange` 重算 left/width 并 `layout()` 内嵌 editor；拖动后 `layoutZone`。
7. **临时 model/editor 泄漏**：teardown 必须 dispose diff editor + 两个 model + 移除 overlay/zone。盯 disposable-leak（见 [fix-disposable-leak]）。
8. **E2E 跑 `out/` 产物**：改 renderer 后必 `pnpm --filter @universe-editor/editor build` 再跑 spec，否则 probe 新方法 `is not a function`。
9. **gutter 点击区**：色条只有 3px 难点中——加透明 `::before` 命中区 + hover 加宽（VSCode 6px hover glyph 同款）。
10. **region↔HEAD 行映射**：peek 要 HEAD 侧文本/Revert/Stage，靠 `DirtyDiffRegion.originalStartLine/originalEndLine`；added 的 original 范围为空（end<start），`originalStartLine`=插入点前 HEAD 行（0=文件头），deleted 文件头特例 `originalStartLine===1`。

### 验证

```bash
pnpm check                                          # lint+typecheck+test，仅看错误
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts smoke.dirtyDiffPeek
pnpm --filter @universe-editor/git build            # 若动了 Stage 后端（git 扩展 dist）
```

### 关键参考路径（dirty-diff peek 就是范例实现）

- `apps/editor/src/renderer/workbench/scm/dirtyDiff/InlineDirtyDiffController.ts` —— 渲染骨架 + 三套布局公式 + 拖动手柄 + 内嵌 diff editor（**抄这个**）
- `apps/editor/src/renderer/workbench/scm/dirtyDiff/DirtyDiffPeekRegistry.ts` —— host-registry 模块单例范式
- `apps/editor/src/renderer/contributions/DirtyDiffContribution.ts` —— 注册 host + context-key 维护 + 鼠标命中开关 + Revert/Stage/OpenChanges
- `apps/editor/src/renderer/contributions/dirtyDiff.ts` —— `DirtyDiffRegion`（含 original 行范围语义）+ `computeDirtyDiffRegions`
- `apps/editor/src/renderer/actions/dirtyDiffActions.ts` —— `CloseDirtyDiffPeekAction`(Esc)/`ShowChangeAtCursorAction`/导航命令；`actions/index.ts` 注册
- `apps/editor/src/renderer/workbench.css` —— `.inline-dirty-diff*`（overlay 定位/手柄）+ `.dirty-diff-gutter`（点击区放大）
- `apps/editor/src/renderer/workbench/editor/DiffEditor.tsx` —— standalone `createDiffEditor` 用法参照（model 生命周期/viewState）
- `apps/editor/src/renderer/e2e/probe.ts` + `apps/editor/src/shared/e2e/contract.ts` —— peek 探针四方法 + 类型
- `apps/editor/e2e/specs/smoke.dirtyDiffPeek.spec.ts` —— 封顶/滚入视口/拖动/Esc 冒烟
- Stage 后端：`extensions/git/src/hunkPatch.ts`(`selectHunkPatch`)/`repository.ts`(`stageChange`)/`gitService.ts`(`gitExec` stdin)/`packages/extensions-common/src/contracts/dirtyDiff.ts`(命令常量)
- VSCode 对照源：`vscode/src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts` + `vscode/src/vs/editor/contrib/zoneWidget/browser/zoneWidget.ts`
- 相关 memory：[[dirty-diff-inline-peek-feature]]（功能状态/索引）、[[linediff-myers-perf]]（region 计算的 Myers 约束，**仅 gutter region 用，peek 面板不用**）
- 相关 skill：[fix-disposable-leak]（peek 的 model/editor 生命周期）、[register-monaco-command]（接命令）、[fix-keybinding-not-firing]（Esc 不触发时诊断）
