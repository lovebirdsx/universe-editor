# apps/editor/src/renderer/services/explorer/CLAUDE.md

explorer（文件资源管理器）子系统的状态与逻辑主体在本目录（ExplorerTreeService 唯一状态源 + ExplorerFileOperationService 撤销编排层 + 纯函数工具），视图层在 `workbench/explorer/`，命令族在 `actions/file*Actions.ts`。本文是 explorer 子系统的上下文地图（处理相关任务前通读）。

## Explorer 子系统 上下文地图

explorer（文件资源管理器）是主侧栏的文件树视图。它把「文件系统 CRUD + 树状态」收敛到一个 **ExplorerTreeService**，视图层（ExplorerView + ExplorerTreeNode）只做渲染与交互分发，所有文件操作走 **命令**（`file*Actions`），命令再回调 service。

> ⚠️ 第一原则：新增/修改一个「作用于文件项」的命令前，先认领它的**目标解析**属于哪一套：
> - **单目标**：只作用于焦点行一个（如 rename——多选重命名无意义）。用 `resolveTarget`。
> - **多选感知**：作用于整个选区（cut / copy / paste / move / **delete** / copy-name/path）。用 `resolveContextOperations` → `tree.getContextResourceOperations(primary)`。
>
> 用错 = 多选时只有焦点那一个生效（delete、copy-path 都踩过这个坑，已修，勿回退）。规则见下「命令目标解析」。

### 数据流一图

```
IWorkspaceService.current.folder  ← 树根来源（切 workspace 整树重置；展开状态持久化到 WORKSPACE 存储并回灌）
IFileService                      ← 所有磁盘 CRUD / list / stat / copy / rename / delete
IFileWatcherService               ← 递归监听 → onWatcherEvents → refresh 受影响父目录
IExcludeService                   ← files.exclude glob → 过滤 + watcher excludes
IStorageService                   ← 展开状态持久化（explorer/treeState/<root>，WORKSPACE 作用域）
  │
  ▼
ExplorerTreeService  ── 懒加载子节点缓存(_nodes: URI→NodeState) + 委托 TreeModel 管
  │                     选择/焦点/展开/可见行扁平化/reveal；自持剪贴板 + activeEditor 标记
  │  暴露：model(给<Tree>) / selection / focused / selectedResource /
  │        getContextResources(primary) / getContextResourceOperations(primary) /
  │        CRUD: createFile/Folder rename delete duplicate copyResources moveResources /
  │        剪贴板: adoptClipboard clearClipboard hasClipboard clipboardIsCut isCut /
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
  ExplorerClipboardContextContribution  订阅 shared onDidChangeClipboard → adoptClipboard 回灌镜像 + 同步 context key（单向，不回写；启动时读快照初始化）
  DnD（apps/editor/src/renderer/services/dnd/CLAUDE.md）  ExplorerTreeNode 是拖源/落点；跨窗口/外部导入
  SCM 装饰                          ScmDecorationsService → 行颜色/字母角标/删除线
  markdown 链接更新                 onDidRunFileOperation（rename/move 后）→ 更新引用
```

### 核心服务：ExplorerTreeService（唯一状态源）

`apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts`

- **注入**：`IWorkspaceService`（根 + 切换）、`IFileService`（CRUD）、`IFileWatcherService`（监听）、`IExcludeService`（过滤）、`ILoggerService`、`IStorageService`（可选注入 `| undefined`，展开状态持久化；测试未注册时禁用）。
- **树状态委托给 workbench-ui `TreeModel`**（`_model`）：展开/选择/焦点/可见行扁平化/reveal 全在通用 TreeModel，本 service 只做 URI 适配 + 文件系统特化（懒加载 `_nodes` 缓存、CRUD、watcher 刷新、exclude 过滤、compact 折叠）。**展开状态持久化**（仿 SCM `scmTreeState`）：`_setRoot` 仍 `_nodes.clear()` + `_model.reset()`，但随后 `_restoreExpansion` 从 WORKSPACE 存储（key `explorer/treeState/<root>`，实现见 `explorerTreeState.ts`）按深度升序重放展开集合并自愈剔除失效目录；选择/焦点/滚动仍丢弃。
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
- **剪贴板**（共享剪贴板的本地镜像，权威在 main 侧 `IFileClipboardService`，见 `apps/editor/src/shared/ipc/fileClipboardService.ts` + `apps/editor/src/main/services/clipboard/CLAUDE.md`）：`adoptClipboard(resources, isCut)`（只写本地，**绝不可**回写 shared，否则 ProxyChannel 广播含发起窗口 → 死循环）/ `clearClipboard` / `hasClipboard` / `clipboardIsCut` / `hasCutItems` / `isCut`。cut 的项被 rename/delete/move 时自动 `clearClipboard`（并连带 clear shared）。命令层写剪贴板走 `IFileClipboardService.writeResources`，本地状态经 `ExplorerClipboardContextContribution` 订阅 shared 事件回灌。`clearClipboard` 的空态早退让它对已空镜像幂等（不多打一次 IPC）。**`_setRoot`（切 workspace）刻意不动剪贴板**——剪贴板不是树的派生态，详见易踩坑 11。
- **watcher / exclude**：冷启动延迟 arm（见构造函数大段注释——`_watchStarted` / `_coldStartSettled` 双闸；`WorkspaceWatchContribution` 在 idle phase 调 `startWatching()`）。`_onWatcherEvents` 只刷新已加载的受影响父目录。`_onExcludeChange` 重读 + 重设 watcher globs。
- **DI 注册**：`renderer/main.tsx`。

### 撤销编排层：ExplorerFileOperationService

`apps/editor/src/renderer/services/explorer/ExplorerFileOperationService.ts`（对标 VSCode bulkFileEdits，但直驱 IFileService 无 working-copy 层）。

- **职责边界**：`tree` 只做 fs 原子操作 + 树状态刷新；**op-service 做撤销编排**——每个写操作跑完 fs 后包成可逆操作 push 到 `IUndoRedoService`。命令层现在调 op-service（`createFile/createFolder/rename/delete(targets,useTrash)/duplicate/copyResources/moveResources`），**不再直调 tree.CRUD**，否则拿不到 Ctrl+Z。
- **可逆模型**：`IReversibleOperation.perform()` 跑操作并返回其逆（Create↔Delete、Rename↔反向 Rename）；一批操作包成一个 `FileOperationUndoRedoElement`（`IWorkspaceUndoRedoElement`），用共享 `EXPLORER_UNDO_SOURCE` push，撤销/重做命令按此 source 作用域。
- **删除撤销特殊**：回收站无法程序化精确还原，故删前把内容备份到内存（`_backup` 递归 walk 目录/文件），撤销时用备份重写。单文件 `> MAX_UNDO_FILE_SIZE`（10MB）不备份、标 `truncated`（该文件删后无法撤销恢复；开回收站时仍可去回收站找）。
- **回收站**：`delete(targets, useTrash)` → `IFileService.delete(uri,{recursive,useTrash})`；main 侧 `shell.trashItem`。⚠️ **`useTrash` 不是纯配置开关**：`DeleteFileAction` 算的是 `files.enableTrash（默认 true） && provider 支持回收站`，后者经 `IFileService.getCapabilities(resource).supportsTrash` 查（能力位定义在 `platform/src/files/fileSystemProvider.ts`，对标 VSCode 的 `FileSystemProviderCapabilities.Trash`）。本地 `file:` provider 注入了 `shell.trashItem` 故为 true；**远端（WSL/SSH）恒 false**——远端 server 是 headless node 没有 shell 回收站 API，`RemoteFileSystemProvider._capabilities` 直接硬编码 false（不走握手，故未 bump 协议）。远端因此自然走确认框的「永久删除」分支文案，**别退回无条件 `useTrash: true`**（那会让远端 provider 抛 `trash is not supported on this filesystem`、文件删不掉）。混选（本地+远端）时整批降级为永久删除，不半兑现承诺。同一判定也在 `fileBulkEditService`（扩展 `workspace.applyEdit` 删文件）里做，它无 UI 可问故静默降级。**事后回退**：本地 trash 真的失败时弹框提供「永久删除」重试，重试前用 `exists` 过滤掉已删项（逐项 delete 会中断，原样重试会 ENOENT）。**能力探测本身失败（如远端断连）时保留 `useTrash`**——探测失败等于「不知道」，答「没有回收站」会把用户要的「移到回收站」静默变成永久删除；让 provider fail loud 再由回退弹框请用户明确决定。⚠️ **本仓库 URI.fsPath 是正斜杠**（移植省了 Windows `\` 转换），`shell.trashItem` 走 Windows Shell API 要反斜杠，故 node provider 回收站分支已 `path.normalize(uri.fsPath)`——别退回直接传 fsPath（会 "Failed to parse path"）。
- **键位/配置**：`explorerUndoActions.ts` 的 Undo(ctrl+z)/Redo(ctrl+y|ctrl+shift+z)，when 叠加 `explorerEnableUndo`；配置 `explorer.enableUndo`/`explorer.confirmDelete`/`files.enableTrash` 由 `ExplorerFileConfigurationContribution` 注册 + 建 context key。IUndoRedoService/UndoRedoService 移植在 `packages/platform/src/undoRedo/`。
- **DI 注册**：`renderer/main.tsx`（IUndoRedoService 之后建 op-service）。

### 视图层

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
                        explorerResourceCut)；args 传 {target,resource,parent,isDirectory}；
                        多选时 args[1] = 选区数组（getContextResourceOperations，元素
                        {resource,isDirectory}，primary 项以点击行 isDirectory 为准；
                        工作区根不包含——树在获焦时自动选中根，包含它会把
                        `<root>/...` 扇出整个工作区；空白区右键不加）。
ExplorerViewToolbar.tsx 标题栏：新建文件/文件夹（命令）、刷新、全部折叠。无 root 时禁用。
ExplorerView.module.css .row 的 .active(当前编辑器)/.selected/.focused/.cut(剪切变暗) + compact 段样式。
```

### 命令族（file\*Actions）与「目标解析」套路

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
                        Cut/Copy 写 main 侧 IFileClipboardService（先 checkWriteCost 弹确认/拒绝），
                        Paste 读 shared 快照按「来源×cut」决策（见下表），CancelCut 直接 clear shared。
fileCopyActions.ts     CopyName/CopyPath/CopyRelativePath（★多选：选区内则整选区换行拼接★；
                        同时服务编辑器标签页 → 回退 active editor 单个）。
fileOpenActions.ts     Reveal/RefreshExplorer/RevealInOS 等（见文件）。
```

#### 目标解析决策表（新增文件命令必读）

| 命令语义 | 用哪个解析 | 触发行不在选区时 |
|---|---|---|
| 作用于「一个」（rename、单项属性） | `resolveTarget`（单目标） | 就是该行 |
| 作用于「一批」（del/cut/copy/paste/move/copy-path） | `resolveContextOperations` | **只该行**（不吞整个选区） |

**语义约定**：右击**选区内**的行 → 作用于整个选区；右击**选区外**的行 → 只作用于那一行（VSCode 同款，`getContextResources` 的 primary-in-selection 判断实现之）。键盘 Delete/F2 传的是焦点行，焦点必在选区内 → Delete 自然作用全选区。

#### Paste 来源 × cut 决策表（fileClipboardActions.ts）

Paste 读 shared 快照（`readResources`）后按此表行事：

| 快照 source | isCut | 行为 |
|---|---|---|
| `internal` | true | move + overwrite 提示；成功后 clear shared |
| `internal` | false | copy |
| `os` | 任意 | **一律 copy**（isCut 忽略） |

`os` 一律 copy 的安全理由：`source: 'internal'` 才证明剪贴板是我们自己写的（且所有权校验仍通过），只有这时的 cut 项由我们负责「搬运后删除源」；OS 来源的剪切项属于别的应用，删源就是误删别人的文件。

### 上下文菜单与 context key

```
contributions/ExplorerMenuContribution.ts   注册 MenuId.ExplorerContext 各项（分组 2_cutcopypaste /
                                             3_modification / 4_copy / 5_open / 6_misc），when 用 context key。
contributions/ExplorerClipboardContextContribution.ts  剪贴板变化 → 同步 context key：
                                             fileCopied（有剪贴板内容）、explorerResourceCut（有剪切项）。
```

- **context key**：`explorerResourceIsRoot`、`explorerResourceIsFolder`（右键行的属性，ExplorerContextMenu 里 scoped 创建）；`fileCopied`、`explorerResourceCut`（全局，clipboard contribution 同步）。
- **键位 when**：`EXPLORER_FOCUS_WHEN = focusedView == 'workbench.view.explorer.tree' && !editorTextFocus && !terminalFocus`。cut/copy/paste 键位都只叠它——paste 不再门控 `fileCopied`，右键「粘贴」项 when 也从 `fileCopied && explorerResourceIsFolder` 改为 `explorerResourceIsFolder`（目录上常亮）。取舍：OS 剪贴板可能带着别的应用复制的文件，而**不做 OS 剪贴板焦点轮询**，剪贴板空不空只有运行时（`readResources`）才知道——空剪贴板粘贴 = 静默 no-op。

### 注册接入点（View 三件套 + 相关 contribution）

```
contributions/BuiltInViewContainersContribution.ts  ViewContainer 'workbench.view.explorer'（Primary Side Bar）
contributions/BuiltInViewsContribution.ts            View 'workbench.view.explorer.tree'（registerViewWithComponent + ExplorerView）
                                                     ——注意这里直接绑组件，无独立 ViewComponentRegistry 行
contributions/ExplorerAutoRevealContribution.ts      activeEditor→activeEditor 标记 +（explorer.autoReveal）reveal 选中
contributions/index.ts                               注册以上 contribution
actions/index.ts                                     registerAction2 注册全部 file*Actions
```

（View 注册总套路见 apps/editor/CLAUDE.md 套路 B。）

### 与其它子系统的协作边界

- **DnD**：ExplorerTreeNode 既是拖源（`useDragHandle`，多选拖 `selectionDragUris(self, selection)`）又是目录落点（`useDropTarget`：有私有 payload→内部 move via `getContextResourceOperations`；无 payload→OS 外部/跨面板导入）。形态、Windows uri-list 粘连坑、payload 跨 subtree 读不到等，全在 `apps/editor/src/renderer/services/dnd/CLAUDE.md`。
- **View 容器归属/拖动/持久化**：explorer 作为一个 view 怎么在容器间搬、怎么持久化，属 `apps/editor/src/renderer/services/views/CLAUDE.md`（IViewDescriptorService）。本子系统只管树内容。
- **SCM 装饰**：`IScmDecorationsService.decorations` observable → renderRow 按 `scmPathKey(fsPath)` 查颜色/字母/删除线，作 props 给 ExplorerTreeNode。
- **markdown 链接更新**：`onDidRunFileOperation`（rename/move 后 fire `IFileRenameOperation[]`）→ markdown 子系统更新受影响引用。
- **编辑器打开**：openFile 走 `IEditorResolverService.openEditor`（单击 preview / 双击 pinned），大文件先 `confirmLargeFile`。

### 关键架构决策与「为什么」

- **命令目标解析双轨**：文件操作的「作用范围」本质分单/多两类，收敛到 `resolveTarget` vs `resolveContextOperations` 两个 helper + service 端 `getContextResources` 一个裁决点。**新命令只需认领用哪个**，多选语义（选区内→全选区 / 选区外→单行）自动一致。历史 bug（delete、copy-path 漏接多选）都是「本该多选却用了单目标」。
- **扩展命令的多选注入在菜单期物化（SCM parity）**：扩展命令跑在 extension-host 进程，拿不到 renderer 的 tree 选区——`ExplorerContextMenu` 在菜单弹出时就把选区固化成 `args[1]`（`getContextResourceOperations`，元素 `{resource, isDirectory}`）随命令跨进程传过去。renderer 自己的 Action2 忽略 args[1]、自行走 `resolveContextOperations`（同为 `getContextResourceOperations` 派生，语义一致）。**args[1] 已被多选选区占用**：explorer/context 的命令 handler 不得再把 args[1] 当 options 对象解构——若确需 options（如 `dirtyDiffActions` 的 `{pinned, preserveFocus}`），先 `Array.isArray(args[1])` 守卫剔除选区形态。
- **树状态委托 TreeModel、不自造**：选择/焦点/展开/虚拟化/键盘导航是通用树能力，放 workbench-ui 的 TreeModel；本 service 只加文件系统特化。所以 explorer 与 outline 等共享同一套 Tree 交互契约。
- **展开状态持久化，其余切 workspace 丢弃**：树是 workspace 的派生视图，换根即弃选择/焦点/滚动（对标 VSCode 的轻量策略）；**展开集合例外**——用户手动展开的目录跨重启/换根恢复（`explorerTreeState.ts` 防抖写 + `_setRoot` 回灌 + `onDidChangeWorkspaceScope` 兜底），focusEnabled 开/关都生效。
- **watcher 冷启动延迟**：递归监听是主进程 CPU 大头，冷启动时 root 展开已够首屏，watcher 推迟到 idle phase arm，避开与 renderer restore 抢 CPU。见构造函数注释。
- **共享剪贴板权威、树是镜像**：cut/copy 命令写 main 侧 `IFileClipboardService`（main 内存 + OS 剪贴板，跨窗口共享、快照可带远端 URI）；`ExplorerClipboardContextContribution` 订阅其 `onDidChangeClipboard`（ProxyChannel 广播**含发起窗口**）→ `tree.adoptClipboard` 回灌本地状态 + 同步 context key，构造时还会 `readResources` 一次做启动快照初始化（renderer reload 后 cut 变暗与 context key 不丢）。**事件方向严格单向**：`adoptClipboard` 只进不出；回写 shared 只有「清空」方向，且**只在剪贴板内容真的失效时**——`tree.clearClipboard`（cut 项被 rename/delete/move）、CancelCut、paste-move 成功后的直接 `clear()`。切 workspace 不在此列（见易踩坑 11）。

### 常见任务 → 改哪里

- **新增作用于文件项的命令**：写在对应 `file*Actions.ts`；**先查目标解析决策表**选 `resolveTarget`（单）或 `resolveContextOperations`（多）；`actions/index.ts` 注册；要进右键菜单则 `ExplorerMenuContribution.ts` 加 `MenuRegistry.addMenuItem`（选分组 + when context key）。
- **改多选删除/剪切/复制/移动行为**：命令层解析已统一，改语义去 `getContextResources`（service）；改单个操作实现去 `ExplorerFileOperationService`（撤销编排 + 备份）或 `tree.xxx`（纯 fs+树状态）。
- **改撤销/重做/回收站/删除备份**：`ExplorerFileOperationService`（可逆操作 + `_backup`/`recreateFromBackup`）；键位/开关 `explorerUndoActions.ts` + `ExplorerFileConfigurationContribution.ts`；内核在 `packages/platform/src/undoRedo/`。
- **改行点击/选择语义**：`ExplorerTreeNode.tsx` 的 `onClick`/`onDoubleClick`（shift/ctrl/普通分支）。
- **改新建/重命名的输入交互**：对应 action + `IDialogService.prompt`。
- **改右键菜单项/顺序/可见条件**：`ExplorerMenuContribution.ts`（分组 + order + when）；新 context key 要在 `ExplorerContextMenu.tsx`（行属性类）或 `ExplorerClipboardContextContribution.ts`（剪贴板类）里 set。
- **改树的懒加载/刷新/watcher/exclude**：`ExplorerTreeService` 的 `_loadChildren`/`refresh`/`_onWatcherEvents`/`_onExcludeChange`/`_syncWatch`。
- **改 compact 折叠**：`_computeCompactChildren`/`_isSingleDirChild`/`_eagerLoadForCompact`（service）+ ExplorerTreeNode 的 `segments`（视图）。
- **改自动 reveal / active-editor 标记**：`ExplorerAutoRevealContribution.ts`。
- **rename/move 后要联动别的东西**：监听 `onDidRunFileOperation`。

### 易踩坑速记

1. **多选命令误用单目标解析**（delete、copy-path 已修，勿回退）：作用于「一批」的命令必须 `resolveContextOperations`，否则多选只生效焦点一个。判据见目标解析决策表。
2. **右击选区外的行**：应只作用那一行，不能吞整个选区——由 `getContextResources` 的「primary 是否在 selection 内」判断实现，别绕过它自己取 `tree.selection`。
3. **键盘 Delete 传的是焦点行**：ExplorerView `onRowKeyDown` 只传 `node.element.resource` 作 target，多选删除靠命令层展开选区，不要改成在视图层拼多个 target。
4. **切 workspace 只回灌展开集合**：`_setRoot` 仍 clear+reset 掉选择/焦点/滚动，但展开目录会从 WORKSPACE 存储回灌（`explorerTreeState.ts`）。要新增「记住别的树状态」得扩展同一套机制，别以为全部无持久化。**唯一例外是剪贴板**——它是 shared 镜像不是树状态，见易踩坑 11。
5. **watcher 冷启动窗口不监听**：`startWatching()` 前外部改动可能漏报，`startWatching`/`_refreshLoadedNodes` 会补一次全量重读——别把冷启动期的「没收到 watcher 事件」当 bug。
6. **cut 项被操作后要清剪贴板**：rename/delete/move 命中 cut 项时 service 已自动 `clearClipboard`；新增会移动/删除文件的路径记得保持这一点。
7. **compact 折叠行的目标是「段」不是「整行」**：右键/落点要用该段的 URI（`data-segment-uri`），不是 leaf `resource`。
8. **IPC 来的参数是 UriComponents**：命令 args 里的 URI 先 `reviveUri` 再用。
9. **命令层写操作要在第一个 await 前取完 service**：文件命令都是 async run，`accessor` 遇第一个 `await` 即失效；`accessor.get(IExplorerFileOperationService)` 必须在任何 `await`（prompt/confirm/showOpenDialog）之前同步取好，否则报 "service accessor is only valid during..."。（见 fix-disposable 无关，属 action2 async accessor 坑。）
10. **删除撤销靠内存备份，非回收站**：关了 `files.enableTrash`、或身处远端（无回收站）仍能 Ctrl+Z 找回（>10MB 除外）；改删除/备份逻辑别破坏 `_backup`/`recreateFromBackup` 的对称。
11. **`_setRoot` 不许清剪贴板**（已修，勿回退）：剪贴板是 **shared（main 进程、全窗口共享 + OS 剪贴板）** 的镜像，不是树根的派生态。在这里清会踩两个坑：① 冷启动竞态——`IWorkspaceService` hydration 会在启动快照 adopt 之后再推一次 root（对象标识比对，同一 workspace 也 refire），把 main 快照清掉；② 窗口 B 切文件夹会摧毁窗口 A 待粘贴的 cut 状态。切根后不会残留错误变暗：`isCut` 比对 URI，旧根下的项匹配不到新根任何一行。
12. **`useTrash` 必须先问 provider 能力**（已修，勿回退）：远端无回收站，无条件 `useTrash: true` 会让删除整个失败（`trash is not supported on this filesystem`）。判定见上文「回收站」段。

### 验证

```bash
cd apps/editor && pnpm vitest run \
  src/renderer/actions/__tests__/fileActions.test.ts \
  src/renderer/actions/__tests__/fileCopyActions.test.ts \
  src/renderer/services/explorer/__tests__/ExplorerTreeService.test.ts \
  src/renderer/services/explorer/__tests__/ExplorerFileOperationService.test.ts \
  src/renderer/services/explorer/__tests__/explorerTreeUtils.test.ts \
  src/main/services/files/__tests__/fileSystemMainService.test.ts \
  src/renderer/workbench/explorer/__tests__/   # explorer 相关单测
pnpm check                                       # lint+typecheck+全量 test
pnpm --filter @universe-editor/editor build      # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test specs/smoke.explorerDnD.spec.ts \
  specs/smoke.explorerExternalWatch.spec.ts specs/smoke.explorerRowHeight.spec.ts
```

e2e 探针（`renderer/e2e/probe.ts`，经 `services.explorerTreeService`）：`renameExplorerResource(fsPath,newName)`、`moveExplorerResource(fsPath,destDir)`、`readWorkspaceFileText(fsPath)`。

### 关键参考路径

- `apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts` —— 唯一状态源（树 + 选择 + 剪贴板 + CRUD + watcher）
- `apps/editor/src/renderer/services/explorer/explorerTreeUtils.ts` —— 纯函数（normalizeUri/parentOf/isDescendant/relativeTo/dedupe/sameUri）
- `apps/editor/src/renderer/services/explorer/explorerFileOperations.ts` —— basenameOf/targetInDirectory/incrementFileName
- `apps/editor/src/renderer/workbench/explorer/{ExplorerView,ExplorerTreeNode,ExplorerContextMenu,ExplorerViewToolbar}.tsx`
- `apps/editor/src/renderer/actions/fileActionsCommon.ts` —— ★目标解析 helper（resolveContextOperations / resolvePrimaryTarget / reviveUri）★
- `apps/editor/src/renderer/actions/{fileCreate,fileMutate,fileClipboard,fileCopy,fileOpen}Actions.ts` —— 命令族
- `apps/editor/src/renderer/contributions/{ExplorerMenu,ExplorerClipboardContext,ExplorerAutoReveal,BuiltInViews,BuiltInViewContainers}Contribution.ts`
- 测试：`…/actions/__tests__/{fileActions,fileCopyActions}.test.ts`、`…/services/explorer/__tests__/*`、`…/workbench/explorer/__tests__/*`
- 相关：`apps/editor/src/renderer/services/dnd/CLAUDE.md`（拖放形态）、`apps/editor/src/renderer/services/views/CLAUDE.md`（view 容器归属/持久化）；大纲见 `apps/editor/src/renderer/workbench/outline/CLAUDE.md`（同享 Tree 契约的姊妹视图）

### 其它

- 后续用本文，发现新经验，需同步更新本文件。
