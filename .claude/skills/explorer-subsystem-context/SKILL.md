---
name: explorer-subsystem-context
description: 处理 explorer（文件资源管理器侧栏）相关功能时召回，提供整个 explorer 子系统的上下文地图——ExplorerTreeService（workspace-folder 为根的懒加载树 + 选择/焦点/剪贴板状态 + 文件 CRUD/move/copy/duplicate + watcher/exclude 刷新 + compact 折叠）、ExplorerView/ExplorerTreeNode 视图层（渲染/点击选择语义/DnD）、file*Actions 命令族（create/mutate/clipboard/copy-path，及它们的目标解析套路）、上下文菜单与 context key、View 注册三件套、与 DnD/SCM/大纲/编辑器的协作边界。**核心心智**：命令的「作用目标」有两套解析——单目标（rename）vs 多选感知（cut/copy/paste/move/delete/copy-path，统一走 resolveContextOperations → getContextResourceOperations）；新增作用于文件项的命令必须认领落在哪套，否则多选只生效一个（已修 delete/copy-path 的此类 bug，勿回退）。当任务涉及 ExplorerTreeService、explorer 树的选择/多选/剪贴板/reveal/compact 折叠、新增/改文件操作命令（新建/重命名/删除/剪切/复制/粘贴/移动/复制路径）、右键菜单项、explorerResourceIsRoot/IsFolder/fileCopied/explorerResourceCut 等 context key、文件监听刷新、或要理解「explorer 怎么拼起来、命令作用目标怎么定」时，先读它建立全局认知。拖放形态见 [drag-and-drop-context]，View 容器归属见 [view-system-context]，SCM 装饰见相关 skill。
disable-model-invocation: true
---

# Explorer 子系统 上下文地图

explorer（文件资源管理器）是主侧栏的文件树视图。它把「文件系统 CRUD + 树状态」收敛到一个 **ExplorerTreeService**，视图层（ExplorerView + ExplorerTreeNode）只做渲染与交互分发，所有文件操作走 **命令**（`file*Actions`），命令再回调 service。

> ⚠️ 第一原则：新增/修改一个「作用于文件项」的命令前，先认领它的**目标解析**属于哪一套：
> - **单目标**：只作用于焦点行一个（如 rename——多选重命名无意义）。用 `resolveTarget`。
> - **多选感知**：作用于整个选区（cut / copy / paste / move / **delete** / copy-name/path）。用 `resolveContextOperations` → `tree.getContextResourceOperations(primary)`。
>
> 用错 = 多选时只有焦点那一个生效（delete、copy-path 都踩过这个坑，已修，勿回退）。规则见下「命令目标解析」。

## 数据流一图

```
IWorkspaceService.current.folder  ← 树根来源（切 workspace 整树重置，状态不持久化）
IFileService                      ← 所有磁盘 CRUD / list / stat / copy / rename / delete
IFileWatcherService               ← 递归监听 → onWatcherEvents → refresh 受影响父目录
IExcludeService                   ← files.exclude glob → 过滤 + watcher excludes
  │
  ▼
ExplorerTreeService  ── 懒加载子节点缓存(_nodes: URI→NodeState) + 委托 TreeModel 管
  │                     选择/焦点/展开/可见行扁平化/reveal；自持剪贴板 + activeEditor 标记
  │  暴露：model(给<Tree>) / selection / focused / selectedResource /
  │        getContextResources(primary) / getContextResourceOperations(primary) /
  │        CRUD: createFile/Folder rename delete duplicate copyResources moveResources /
  │        剪贴板: setToCopy clearClipboard hasClipboard clipboardIsCut isCut /
  │        reveal expand collapse collapseAll refresh
  ▼
ExplorerView (<Tree> from workbench-ui, model=tree.model)
  │  renderRow → ExplorerTreeNode（单行，React.memo，selection/focus 作为 props）
  │  onRowKeyDown: F2→rename 命令, Delete→delete 命令（传焦点行作 target）
  │  onClick(ExplorerTreeNode): shift=selectRange / ctrl=toggleInSelection / 普通=setSelection+toggle或openPreview
  │  右键 → ExplorerContextMenu（MenuId.ExplorerContext，args 带 target/resource/parent/isDirectory）
  ▼
file*Actions 命令 —— run() 里解析目标（单/多）→ 调 tree 的 CRUD → service 刷新树 + fire 事件

姊妹协作者：
  ExplorerAutoRevealContribution  编辑器切换 → setActiveEditorResource + (autoReveal) reveal 选中
  ExplorerClipboardContextContribution  onDidChangeClipboard → 同步 fileCopied/explorerResourceCut context key
  DnD（drag-and-drop-context）     ExplorerTreeNode 是拖源/落点；跨窗口/外部导入
  SCM 装饰                          ScmDecorationsService → 行颜色/字母角标/删除线
  markdown 链接更新                 onDidRunFileOperation（rename/move 后）→ 更新引用
```

## 核心服务：ExplorerTreeService（唯一状态源）

`apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts`

- **注入**：`IWorkspaceService`（根 + 切换）、`IFileService`（CRUD）、`IFileWatcherService`（监听）、`IExcludeService`（过滤）、`ILoggerService`。
- **树状态委托给 workbench-ui `TreeModel`**（`_model`）：展开/选择/焦点/可见行扁平化/reveal 全在通用 TreeModel，本 service 只做 URI 适配 + 文件系统特化（懒加载 `_nodes` 缓存、CRUD、watcher 刷新、exclude 过滤、compact 折叠）。**树状态不持久化**——切 workspace（`_setRoot`）整个 `_nodes.clear()` + `_model.reset()`。
- **懒加载**：`_dataSource.loadChildren` 读目录 + 为 compact 折叠预取一层孙目录。`getChildren` 返回经 `_computeCompactChildren` 折叠后的视图（单子目录链 `a/b/c` 合成一行）。
- **选择模型**（关键，命令目标解析依赖它）：
  - `selection: readonly URI[]`——当前选区（多选）。
  - `focused: URI | null`——焦点行。
  - `selectedResource`——back-compat 单值：focused ?? selection[0]。
  - `setSelection(resources, focus?)` / `toggleInSelection`（ctrl）/ `selectRange`（shift）。
  - **`getContextResources(primary?)`**——**命令多选语义的唯一裁决点**：若 primary（触发行）在选区内 → 返回**整个选区**；否则返回 `[primary]`（右击选区外的行只作用于那一行）；primary 为空则返回选区。
  - **`getContextResourceOperations(primary?)`**——同上，但每项带 `isDirectory`（`IExplorerResourceOperation`）。命令层都用这个。
- **文件 CRUD**（都会 `refresh` 受影响父目录 + 打日志；失败 throw 由命令层弹窗）：
  - `createFile` / `createFolder`（exists 检查）、`rename`（overwrite:false，fire `onDidRunFileOperation`）、`delete`（recursive 选项）、`duplicate` + `defaultDuplicateName`（自增名）。
  - `copyResources` / `moveResources`（批量，`_dedupeOperations` + `_assertCanPlace` 防「文件夹放进自己」+ 自增名避冲突；move fire `onDidRunFileOperation`；末尾 `_selectOperationTargets` 选中新目标）。
- **剪贴板**（in-app 权威，非系统剪贴板）：`setToCopy(resources, cut)` / `clearClipboard` / `hasClipboard` / `clipboardIsCut` / `hasCutItems` / `isCut`。cut 的项被 rename/delete/move 时自动 `clearClipboard`。
- **watcher / exclude**：冷启动延迟 arm（见构造函数大段注释——`_watchStarted` / `_coldStartSettled` 双闸；`WorkspaceWatchContribution` 在 idle phase 调 `startWatching()`）。`_onWatcherEvents` 只刷新已加载的受影响父目录。`_onExcludeChange` 重读 + 重设 watcher globs。
- **DI 注册**：`renderer/main.tsx`。

## 视图层

`apps/editor/src/renderer/workbench/explorer/`

```
ExplorerView.tsx        容器。<Tree model={tree.model}>；renderRow→ExplorerTreeNode。
                        订阅 onDidChangeSelection/Clipboard → bump 版本重渲染（拿新 active-editor key）。
                        onRowKeyDown：F2→rename 命令、Delete→delete 命令（传【焦点行】作 target；
                        多选删除靠命令层 resolveContextOperations 展开选区，不是这里传多个）。
                        无 workspace 时渲染 "Open Folder" 空态。RootDropZone 包整个 body 收空白落点。
ExplorerTreeNode.tsx    单行，React.memo（selection/focus/active/cut 作 props 精确重渲染）。
                        onClick 选择语义：shift=selectRange / ctrl|meta=toggleInSelection /
                        普通=setSelection([this])+（目录 toggle｜文件 openPreview）。
                        双击文件=非预览打开（pinned）。拖源(useDragHandle,多选拖 selectionDragUris)
                        + 目录落点(useDropTarget：payload→move / 无 payload→外部导入)。
                        compact 折叠行每段可独立 hover/右键/落点（各段对应各自目录 URI）。
ExplorerContextMenu.tsx 薄封装 workbench-ui ContextMenu；菜单项来自 MenuRegistry(ExplorerMenuContribution)。
                        创建 scoped context key(explorerResourceIsFolder/IsRoot/fileCopied/
                        explorerResourceCut)；args 传 {target,resource,parent,isDirectory}。
ExplorerViewToolbar.tsx 标题栏：新建文件/文件夹（命令）、刷新、全部折叠。无 root 时禁用。
ExplorerView.module.css .row 的 .active(当前编辑器)/.selected/.focused/.cut(剪切变暗) + compact 段样式。
```

## 命令族（file\*Actions）与「目标解析」套路

`apps/editor/src/renderer/actions/`，全部 Action2 + 在 `actions/index.ts` 用 `registerAction2` 注册（套路 A）。

```
fileActionsCommon.ts   共享 helper（目标解析的家）：
                       - reviveUri（IPC 来的 UriComponents → URI）
                       - ITargetArg（{target?,resource?,parent?,isDirectory?}）
                       - resolvePrimaryTarget(args)：取 arg.target ?? arg.resource
                       - resolveContextOperations(tree,args)：★多选感知解析★
                         = tree.getContextResourceOperations(primary) + 用 arg.isDirectory 覆盖 primary 项
                           + 过滤掉 root。cut/copy/paste/move/delete/copy-path 全走它。
fileCreateActions.ts   NewFile / NewFolder（resolveParent：目录用自身，文件取父，兜底 workspace 根）
                       + NewUntitledFile（内存 buffer，不落盘）。
fileMutateActions.ts   Rename（★单目标 resolveTarget★，多选无意义）
                       + Delete（★多选 resolveContextOperations★，逐个删，弹窗按数量单/多文案，
                         单项失败不中断、末尾汇总报错）。
fileClipboardActions.ts Cut/Copy/Paste/CancelCut/Duplicate/Move（全多选感知；
                        Paste 用 resolveDestinationDir 定目标目录；Duplicate 取 [0]）。
fileCopyActions.ts     CopyName/CopyPath/CopyRelativePath（★多选：选区内则整选区换行拼接★；
                        同时服务编辑器标签页 → 回退 active editor 单个）。
fileOpenActions.ts     Reveal/RefreshExplorer/RevealInOS 等（见文件）。
```

### 目标解析决策表（新增文件命令必读）

| 命令语义 | 用哪个解析 | 触发行不在选区时 |
|---|---|---|
| 作用于「一个」（rename、单项属性） | `resolveTarget`（单目标） | 就是该行 |
| 作用于「一批」（del/cut/copy/paste/move/copy-path） | `resolveContextOperations` | **只该行**（不吞整个选区） |

**语义约定**：右击**选区内**的行 → 作用于整个选区；右击**选区外**的行 → 只作用于那一行（VSCode 同款，`getContextResources` 的 primary-in-selection 判断实现之）。键盘 Delete/F2 传的是焦点行，焦点必在选区内 → Delete 自然作用全选区。

## 上下文菜单与 context key

```
contributions/ExplorerMenuContribution.ts   注册 MenuId.ExplorerContext 各项（分组 2_cutcopypaste /
                                             3_modification / 4_copy / 5_open / 6_misc），when 用 context key。
contributions/ExplorerClipboardContextContribution.ts  剪贴板变化 → 同步 context key：
                                             fileCopied（有剪贴板内容）、explorerResourceCut（有剪切项）。
```

- **context key**：`explorerResourceIsRoot`、`explorerResourceIsFolder`（右键行的属性，ExplorerContextMenu 里 scoped 创建）；`fileCopied`、`explorerResourceCut`（全局，clipboard contribution 同步）。
- **键位 when**：`EXPLORER_FOCUS_WHEN = focusedView == 'workbench.view.explorer.tree' && !editorTextFocus && !terminalFocus`（cut/copy/paste 键位用它 + `fileCopied` 等叠加）。

## 注册接入点（View 三件套 + 相关 contribution）

```
contributions/BuiltInViewContainersContribution.ts  ViewContainer 'workbench.view.explorer'（Primary Side Bar）
contributions/BuiltInViewsContribution.ts            View 'workbench.view.explorer.tree'（registerViewWithComponent + ExplorerView）
                                                     ——注意这里直接绑组件，无独立 ViewComponentRegistry 行
contributions/ExplorerAutoRevealContribution.ts      activeEditor→activeEditor 标记 +（explorer.autoReveal）reveal 选中
contributions/index.ts                               注册以上 contribution
actions/index.ts                                     registerAction2 注册全部 file*Actions
```

（View 注册总套路见 apps/editor/CLAUDE.md 套路 B。）

## 与其它子系统的协作边界

- **DnD**：ExplorerTreeNode 既是拖源（`useDragHandle`，多选拖 `selectionDragUris(self, selection)`）又是目录落点（`useDropTarget`：有私有 payload→内部 move via `getContextResourceOperations`；无 payload→OS 外部/跨面板导入）。形态、Windows uri-list 粘连坑、payload 跨 subtree 读不到等，全在 [drag-and-drop-context]。
- **View 容器归属/拖动/持久化**：explorer 作为一个 view 怎么在容器间搬、怎么持久化，属 [view-system-context]（IViewDescriptorService）。本子系统只管树内容。
- **SCM 装饰**：`IScmDecorationsService.decorations` observable → renderRow 按 `scmPathKey(fsPath)` 查颜色/字母/删除线，作 props 给 ExplorerTreeNode。
- **markdown 链接更新**：`onDidRunFileOperation`（rename/move 后 fire `IFileRenameOperation[]`）→ markdown 子系统更新受影响引用。
- **编辑器打开**：openFile 走 `IEditorResolverService.openEditor`（单击 preview / 双击 pinned），大文件先 `confirmLargeFile`。

## 关键架构决策与「为什么」

- **命令目标解析双轨**：文件操作的「作用范围」本质分单/多两类，收敛到 `resolveTarget` vs `resolveContextOperations` 两个 helper + service 端 `getContextResources` 一个裁决点。**新命令只需认领用哪个**，多选语义（选区内→全选区 / 选区外→单行）自动一致。历史 bug（delete、copy-path 漏接多选）都是「本该多选却用了单目标」。
- **树状态委托 TreeModel、不自造**：选择/焦点/展开/虚拟化/键盘导航是通用树能力，放 workbench-ui 的 TreeModel；本 service 只加文件系统特化。所以 explorer 与 outline 等共享同一套 Tree 交互契约。
- **状态不持久化、切 workspace 全重置**：树是 workspace 的派生视图，换根即弃（对标 VSCode 的轻量策略）。
- **watcher 冷启动延迟**：递归监听是主进程 CPU 大头，冷启动时 root 展开已够首屏，watcher 推迟到 idle phase arm，避开与 renderer restore 抢 CPU。见构造函数注释。
- **in-app 剪贴板权威**：cut/copy 用 service 内部剪贴板（带 cut 状态、变暗、自动清），系统剪贴板只 best-effort 写路径文本。

## 常见任务 → 改哪里

- **新增作用于文件项的命令**：写在对应 `file*Actions.ts`；**先查目标解析决策表**选 `resolveTarget`（单）或 `resolveContextOperations`（多）；`actions/index.ts` 注册；要进右键菜单则 `ExplorerMenuContribution.ts` 加 `MenuRegistry.addMenuItem`（选分组 + when context key）。
- **改多选删除/剪切/复制/移动行为**：命令层解析已统一，改语义去 `getContextResources`（service）；改单个操作实现去对应 `tree.xxx`（如 `moveResources`）。
- **改行点击/选择语义**：`ExplorerTreeNode.tsx` 的 `onClick`/`onDoubleClick`（shift/ctrl/普通分支）。
- **改新建/重命名的输入交互**：对应 action + `IDialogService.prompt`。
- **改右键菜单项/顺序/可见条件**：`ExplorerMenuContribution.ts`（分组 + order + when）；新 context key 要在 `ExplorerContextMenu.tsx`（行属性类）或 `ExplorerClipboardContextContribution.ts`（剪贴板类）里 set。
- **改树的懒加载/刷新/watcher/exclude**：`ExplorerTreeService` 的 `_loadChildren`/`refresh`/`_onWatcherEvents`/`_onExcludeChange`/`_syncWatch`。
- **改 compact 折叠**：`_computeCompactChildren`/`_isSingleDirChild`/`_eagerLoadForCompact`（service）+ ExplorerTreeNode 的 `segments`（视图）。
- **改自动 reveal / active-editor 标记**：`ExplorerAutoRevealContribution.ts`。
- **rename/move 后要联动别的东西**：监听 `onDidRunFileOperation`。

## 易踩坑速记

1. **多选命令误用单目标解析**（delete、copy-path 已修，勿回退）：作用于「一批」的命令必须 `resolveContextOperations`，否则多选只生效焦点一个。判据见目标解析决策表。
2. **右击选区外的行**：应只作用那一行，不能吞整个选区——由 `getContextResources` 的「primary 是否在 selection 内」判断实现，别绕过它自己取 `tree.selection`。
3. **键盘 Delete 传的是焦点行**：ExplorerView `onRowKeyDown` 只传 `node.element.resource` 作 target，多选删除靠命令层展开选区，不要改成在视图层拼多个 target。
4. **切 workspace 树状态全丢**：`_setRoot` 会 clear+reset，任何「记住展开/选择」的需求都要另做持久化（默认没有）。
5. **watcher 冷启动窗口不监听**：`startWatching()` 前外部改动可能漏报，`startWatching`/`_refreshLoadedNodes` 会补一次全量重读——别把冷启动期的「没收到 watcher 事件」当 bug。
6. **cut 项被操作后要清剪贴板**：rename/delete/move 命中 cut 项时 service 已自动 `clearClipboard`；新增会移动/删除文件的路径记得保持这一点。
7. **compact 折叠行的目标是「段」不是「整行」**：右键/落点要用该段的 URI（`data-segment-uri`），不是 leaf `resource`。
8. **IPC 来的参数是 UriComponents**：命令 args 里的 URI 先 `reviveUri` 再用。

## 验证

```bash
cd apps/editor && pnpm vitest run \
  src/renderer/actions/__tests__/fileActions.test.ts \
  src/renderer/actions/__tests__/fileCopyActions.test.ts \
  src/renderer/services/explorer/__tests__/ExplorerTreeService.test.ts \
  src/renderer/services/explorer/__tests__/explorerTreeUtils.test.ts \
  src/renderer/workbench/explorer/__tests__/   # explorer 相关单测
pnpm check                                       # lint+typecheck+全量 test
pnpm --filter @universe-editor/editor build      # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test specs/smoke.explorerDnD.spec.ts \
  specs/smoke.explorerExternalWatch.spec.ts specs/smoke.explorerRowHeight.spec.ts
```

e2e 探针（`renderer/e2e/probe.ts`，经 `services.explorerTreeService`）：`renameExplorerResource(fsPath,newName)`、`moveExplorerResource(fsPath,destDir)`、`readWorkspaceFileText(fsPath)`。

## 关键参考路径

- `apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts` —— 唯一状态源（树 + 选择 + 剪贴板 + CRUD + watcher）
- `apps/editor/src/renderer/services/explorer/explorerTreeUtils.ts` —— 纯函数（normalizeUri/parentOf/isDescendant/relativeTo/dedupe/sameUri）
- `apps/editor/src/renderer/services/explorer/explorerFileOperations.ts` —— basenameOf/targetInDirectory/incrementFileName
- `apps/editor/src/renderer/workbench/explorer/{ExplorerView,ExplorerTreeNode,ExplorerContextMenu,ExplorerViewToolbar}.tsx`
- `apps/editor/src/renderer/actions/fileActionsCommon.ts` —— ★目标解析 helper（resolveContextOperations / resolvePrimaryTarget / reviveUri）★
- `apps/editor/src/renderer/actions/{fileCreate,fileMutate,fileClipboard,fileCopy,fileOpen}Actions.ts` —— 命令族
- `apps/editor/src/renderer/contributions/{ExplorerMenu,ExplorerClipboardContext,ExplorerAutoReveal,BuiltInViews,BuiltInViewContainers}Contribution.ts`
- 测试：`…/actions/__tests__/{fileActions,fileCopyActions}.test.ts`、`…/services/explorer/__tests__/*`、`…/workbench/explorer/__tests__/*`
- 相关 skill：[drag-and-drop-context]（拖放形态）、[view-system-context]（view 容器归属/持久化）、[outline-subsystem-context]（同享 Tree 契约的姊妹视图）

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件。
