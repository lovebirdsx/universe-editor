# apps/editor/src/renderer/services/explorer/CLAUDE.md

explorer（文件资源管理器）是主侧栏的文件树视图：把「文件系统 CRUD + 树状态」收敛到 **ExplorerTreeService**（本目录唯一状态源 + `ExplorerFileOperationService` 撤销编排层 + 纯函数工具），视图层只做渲染与交互分发（`workbench/explorer/`），所有文件操作走**命令**（`actions/file*Actions.ts`），命令再回调 service。处理相关任务前通读本文件。

> ⚠️ 第一原则：新增/修改「作用于文件项」的命令前，先认领它的**目标解析**属于哪一套：
> - **单目标**：只作用于焦点行一个（如 rename）。用 `resolveTarget`。
> - **多选感知**：作用于整个选区（cut/copy/paste/move/**delete**/copy-name/path）。用 `resolveContextOperations` → `tree.getContextResourceOperations(primary)`。
> 用错 = 多选时只有焦点那一个生效（delete、copy-path 都踩过，已修勿回退）。右击选区外行只作用那一行，靠 `getContextResources` 的 primary-in-selection 判断实现，别绕过它自取 `tree.selection`。

## 核心服务：ExplorerTreeService（唯一状态源）

`services/explorer/ExplorerTreeService.ts`，DI 注册在 `renderer/main.tsx`。

- **树状态委托 workbench-ui `TreeModel`**；懒加载：`_dataSource.loadChildren` 读目录 + 为 compact 预取一层孙目录，`getChildren` 经 `_computeCompactChildren` 把单子目录链 `a/b/c` 折成一行。本 service 只做 URI 适配 + 文件系统特化（CRUD、watcher 刷新、exclude 过滤）。
- **选择模型（命令目标解析依赖它）**：`selection`（选区）/ `focused`（焦点行）/ `selectedResource` = focused ?? selection[0]。**`getContextResources(primary?)` / `getContextResourceOperations(primary?)` 是多选语义唯一裁决点**：primary 在选区内 → 返回整个选区；否则 `[primary]`。后者每项带 `isDirectory`，命令层都用这个。
- **文件 CRUD**：createFile/createFolder/rename/delete/duplicate/copyResources/moveResources（`_dedupeOperations` + `_assertCanPlace` 防「文件夹放进自己」+ 自增名）。都会 refresh 受影响父目录；rename/move fire `onDidRunFileOperation`。
- **剪贴板**：本地镜像（权威在 main 侧 `IFileClipboardService`，见 `main/services/clipboard/CLAUDE.md`）。`adoptClipboard` 只写本地，**绝不可回写 shared**（ProxyChannel 广播含发起窗口 → 死循环）。cut 项被 rename/delete/move 时自动 `clearClipboard`（连带清 shared）。
- **展开状态持久化**：`_setRoot` 切 workspace 时 clear+reset（选择/焦点/滚动丢弃），随后从 WORKSPACE 存储（key `explorer/treeState/<root>`，实现见 `explorerTreeState.ts`）回灌展开集合。**`_setRoot` 刻意不动剪贴板**（易踩坑 8）。机制细节见 `cases-tree-state.md`。
- **watcher / exclude**：冷启动延迟 arm（idle phase `startWatching()`；漏报由 `_refreshLoadedNodes` 补全量重读）。`_onWatcherEvents` 只刷新已加载的受影响父目录；`_onExcludeChange` 重读 + 重设 watcher globs。

## 撤销编排层：ExplorerFileOperationService

`services/explorer/ExplorerFileOperationService.ts`（对标 VSCode bulkFileEdits，直驱 IFileService）。**职责边界**：tree 只做 fs 原子操作 + 树刷新；op-service 做撤销编排——每个写操作包成可逆操作 push 到 `IUndoRedoService`。命令层只调 op-service（createFile/createFolder/rename/delete(targets, useTrash)/duplicate/copyResources/moveResources），**不再直调 tree.CRUD**（否则拿不到 Ctrl+Z）。

- **可逆模型**：`IReversibleOperation.perform()` 返回其逆；一批包成 `FileOperationUndoRedoElement`，用共享 `EXPLORER_UNDO_SOURCE` push。
- **删除撤销靠内存备份非回收站**：删前 `_backup` 递归 walk 备份到内存；>10MB 不备份标 truncated。关 `files.enableTrash` 或远端（无回收站）仍能 Ctrl+Z。别破坏 `_backup`/`recreateFromBackup` 对称。
- **回收站**：判定 `files.enableTrash && IFileService.getCapabilities(resource).supportsTrash`。**远端（WSL/SSH）恒 false，别退回无条件 `useTrash: true`**（远端会抛错删不掉）；混选整批降级永久删除；失败弹「永久删除」重试（重试前 `exists` 过滤已删项防 ENOENT）。⚠️ **URI.fsPath 是正斜杠而 `shell.trashItem` 要反斜杠**，已 `path.normalize(uri.fsPath)`——别退回直接传 fsPath。完整论证见 `cases-trash.md`。
- **键位/配置**：`explorerUndoActions.ts` 的 Undo/Redo 叠 when `explorerEnableUndo`；`explorer.enableUndo`/`explorer.confirmDelete`/`files.enableTrash` 由 `ExplorerFileConfigurationContribution` 注册 + 建 context key。IUndoRedoService 在 `packages/platform/src/undoRedo/`。

## 视图层要点（workbench/explorer/）

- `ExplorerView.tsx`：`<Tree model={tree.model}>`；F2→rename / Delete→delete（传焦点行，多选靠命令层展开）；无 workspace 渲染 Open Folder 空态。
- `ExplorerTreeNode.tsx`：单行 React.memo。onClick：shift/ctrl|meta/普通三分支；双击=非预览打开。拖源 + 目录落点见 `services/dnd/CLAUDE.md`。compact 段独立 hover/右键/落点——用该段 URI（`data-segment-uri`），不是 leaf `resource`。
- `ExplorerContextMenu.tsx`：薄封装；scoped context key（explorerResourceIsFolder/IsRoot/explorerResourceCut/fileCopied）；args 传 {target,resource,parent,isDirectory}，多选时 args[1]=选区数组（工作区根不包含，否则 `<root>/...` 扇出整个工作区；空白区右键不加）。
- `ExplorerViewToolbar.tsx`：新建文件/文件夹、刷新、全部折叠；无 root 禁用。

## 命令族（file*Actions）与「目标解析」套路

`renderer/actions/`，全部 Action2 + 在 `actions/index.ts` 用 `registerAction2` 注册（套路 A）。

- `fileActionsCommon.ts` —— 共享 helper：`reviveUri`（IPC 的 UriComponents→URI）、`resolvePrimaryTarget`、★`resolveContextOperations`（= getContextResourceOperations(primary) + arg.isDirectory 覆盖 primary + 过滤 root）。
- `fileCreateActions.ts` —— NewFile/NewFolder（resolveParent：目录用自身，文件取父，兜底 workspace 根）+ NewUntitledFile（内存不落盘）。
- `fileMutateActions.ts` —— Rename（★单目标 resolveTarget）；Delete（★多选，逐个删，单项失败不中断末尾汇总）。
- `fileClipboardActions.ts` —— Cut/Copy/Paste/CancelCut/Duplicate/Move（全多选感知）。Cut/Copy 写 main IFileClipboardService（先 checkWriteCost 弹确认）；Paste 按来源×cut 决策（下表）；CancelCut 直接 clear shared。
- `fileCopyActions.ts` —— CopyName/CopyPath/CopyRelativePath（★多选：选区内整选区换行拼接；回退 active editor 单个）。
- `fileOpenActions.ts` —— Reveal/RefreshExplorer/RevealInOS。

**目标解析决策表（新增文件命令必读）**：

| 命令语义 | 用哪个解析 | 触发行不在选区时 |
|---|---|---|
| 作用于「一个」（rename、单项属性） | `resolveTarget`（单目标） | 就是该行 |
| 作用于「一批」（del/cut/copy/paste/move/copy-path） | `resolveContextOperations` | **只该行**（不吞整个选区） |

键盘 Delete/F2 传的是焦点行，焦点必在选区内 → Delete 自然作用全选区。

**Paste 来源 × cut 决策表**：`internal`+isCut → move + overwrite 提示（成功后 clear shared）；`internal`+!isCut → copy；`os` → **一律 copy**（isCut 忽略——OS 来源剪切项属别的应用，删源即误删）。

## 上下文菜单与 context key

- `contributions/ExplorerMenuContribution.ts`：注册 MenuId.ExplorerContext 各项（分组 2_cutcopypaste/3_modification/4_copy/5_open/6_misc）。
- `contributions/ExplorerClipboardContextContribution.ts`：同步 context key `fileCopied`/`explorerResourceCut`；构造时 readResources 一次做启动快照（reload 后 cut 变暗不丢）。
- 键位 when：`EXPLORER_FOCUS_WHEN = focusedView == 'workbench.view.explorer.tree' && !editorTextFocus && !terminalFocus`。cut/copy/paste 只叠它——paste 不再门控 `fileCopied`（目录上常亮，空剪贴板粘贴静默 no-op）。
- **扩展命令的多选注入在菜单期物化**（SCM parity）：扩展命令跑在 extension-host 拿不到 renderer 选区——ExplorerContextMenu 弹出时把选区固化成 args[1] 跨进程传；renderer 自己的 Action2 忽略 args[1]、自行走 resolveContextOperations。**args[1] 已被多选选区占用**：handler 不得把它当 options 解构——若确需 options，先 `Array.isArray(args[1])` 守卫剔除选区形态。

## 注册接入点

```
contributions/BuiltInViewContainersContribution.ts  ViewContainer 'workbench.view.explorer'（Primary Side Bar）
contributions/BuiltInViewsContribution.ts            View 'workbench.view.explorer.tree'（registerViewWithComponent 直接绑组件）
contributions/ExplorerAutoRevealContribution.ts      activeEditor 标记 +（explorer.autoReveal）reveal 选中
contributions/index.ts / actions/index.ts            注册以上
```
（View 注册总套路见 apps/editor/CLAUDE.md 套路 B。）

## 协作边界

- **DnD**：ExplorerTreeNode 是拖源/落点，形态与坑全在 `services/dnd/CLAUDE.md`。
- **view 容器归属/拖动/持久化**：见 `services/views/CLAUDE.md`。
- **SCM 装饰**：`IScmDecorationsService.decorations` → 行颜色/字母/删除线。
- **markdown 链接更新**：`onDidRunFileOperation`（rename/move 后）→ markdown 子系统更新引用。
- **编辑器打开**：openFile 走 `IEditorResolverService.openEditor`（单击 preview / 双击 pinned），大文件先 `confirmLargeFile`。

## 常见任务 → 改哪里

- **新增作用于文件项的命令**：对应 `file*Actions.ts`；先查目标解析决策表；`actions/index.ts` 注册；进右键菜单则 `ExplorerMenuContribution.ts` 加 MenuRegistry.addMenuItem（分组 + when）。
- **改多选删除/剪切/复制/移动行为**：解析语义去 `getContextResources`（service）；单个操作实现去 `ExplorerFileOperationService` 或 `tree.xxx`。
- **改撤销/重做/回收站/删除备份**：`ExplorerFileOperationService`（可逆 + `_backup`/`recreateFromBackup`）；键位/开关 `explorerUndoActions.ts` + `ExplorerFileConfigurationContribution.ts`；内核 `packages/platform/src/undoRedo/`。
- **改行点击/选择语义**：`ExplorerTreeNode.tsx` 的 onClick/onDoubleClick。
- **改新建/重命名的输入交互**：对应 action + `IDialogService.prompt`。
- **改右键菜单项/顺序/可见条件**：`ExplorerMenuContribution.ts`；新 context key 在 `ExplorerContextMenu.tsx`（行属性类）或 `ExplorerClipboardContextContribution.ts`（剪贴板类）里 set。
- **改树的懒加载/刷新/watcher/exclude**：`ExplorerTreeService` 的 `_loadChildren`/`refresh`/`_onWatcherEvents`/`_onExcludeChange`/`_syncWatch`。
- **改 compact 折叠**：`_computeCompactChildren`/`_isSingleDirChild`/`_eagerLoadForCompact`（service）+ ExplorerTreeNode 的 segments。红线：补链只挂 dataSource.loadChildren/refresh/_refreshLoadedNodes 三处，**绝不下沉进 `_loadChildren`**（闭环递归）；链成形由 `_compactChainReady` 守（行 id 是链尾，晚成形静默丢焦点）。论证见 `cases-tree-state.md`。
- **改自动 reveal / active-editor 标记**：`ExplorerAutoRevealContribution.ts`。
- **rename/move 后要联动别的**：监听 `onDidRunFileOperation`。

## 易踩坑速记

1. **多选命令误用单目标解析**（delete、copy-path 已修勿回退）：作用于「一批」的命令必须 resolveContextOperations，否则多选只生效焦点一个。
2. **切 workspace 只回灌展开集合**：选择/焦点/滚动仍丢弃；要记住别的树状态得扩展 `explorerTreeState.ts` 同一套机制。
3. **watcher 冷启动窗口不监听**：startWatching() 前外部改动可能漏报，startWatching/_refreshLoadedNodes 会补全量重读——别把「没收到事件」当 bug。
4. **cut 项被操作后要清剪贴板**：rename/delete/move 命中 cut 项时已自动 clearClipboard；新增移动/删除文件路径记得保持。
5. **IPC 来的参数是 UriComponents**：先 reviveUri 再用。
6. **命令层写操作在第一个 await 前取完 service**：accessor 遇 await 即失效，`accessor.get(IExplorerFileOperationService)` 必须在任何 await（prompt/confirm/showOpenDialog）前同步取（见 [[action2-async-accessor-invalidation]]）。
7. **删除撤销靠内存备份非回收站**：关 trash 或远端仍能 Ctrl+Z（>10MB 除外）。
8. **`_setRoot` 不许清剪贴板**（已修勿回退）：剪贴板是 shared 的镜像不是树根派生态——清了会冷启动竞态清掉 main 快照 + 窗口 B 切文件夹摧毁窗口 A 待粘贴的 cut 状态。论证见 `cases-tree-state.md`。
9. **useTrash 必须先问 provider 能力**（已修勿回退）：远端无回收站，无条件 `useTrash: true` 会让删除整个失败。判定见「撤销编排层」回收站段。

## 验证

```bash
cd apps/editor && pnpm vitest run src/renderer/actions/__tests__/fileActions.test.ts \
  src/renderer/actions/__tests__/fileCopyActions.test.ts \
  src/renderer/services/explorer/__tests__/ src/renderer/workbench/explorer/__tests__/
pnpm check    # lint+typecheck+全量 test
pnpm --filter @universe-editor/editor build    # e2e 跑 out/ 产物
cd apps/editor && pnpm exec playwright test specs/smoke.explorerDnD.spec.ts \
  specs/smoke.explorerExternalWatch.spec.ts specs/smoke.explorerRowHeight.spec.ts
```

e2e 探针：`renderer/e2e/probe.ts`，经 `services.explorerTreeService`（renameExplorerResource/moveExplorerResource/readWorkspaceFileText）。

## 关键参考路径

- `services/explorer/ExplorerTreeService.ts` —— 唯一状态源；`explorerTreeUtils.ts` —— 纯函数（normalizeUri/parentOf/isDescendant/relativeTo/dedupe/sameUri）；`explorerFileOperations.ts` —— basenameOf/targetInDirectory/incrementFileName
- `workbench/explorer/{ExplorerView,ExplorerTreeNode,ExplorerContextMenu,ExplorerViewToolbar}.tsx`
- `actions/fileActionsCommon.ts` —— ★目标解析 helper★；`actions/{fileCreate,fileMutate,fileClipboard,fileCopy,fileOpen}Actions.ts` —— 命令族
- `contributions/{ExplorerMenu,ExplorerClipboardContext,ExplorerAutoReveal,BuiltInViews,BuiltInViewContainers}Contribution.ts`
- 相关：`services/dnd/CLAUDE.md`（拖放形态）、`services/views/CLAUDE.md`（view 容器）、`workbench/outline/CLAUDE.md`（同享 Tree 契约）；论证：`cases-trash.md`、`cases-tree-state.md`
