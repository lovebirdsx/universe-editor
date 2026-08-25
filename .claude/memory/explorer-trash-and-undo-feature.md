---
name: explorer-trash-and-undo-feature
description: Explorer 删除到回收站 + Ctrl+Z 撤销文件操作（移植 VSCode IUndoRedoService）
metadata: 
  node_type: memory
  type: project
  originSessionId: de7e52d9-d6d4-474f-bf7d-bb99e60c5ba0
---

Explorer 两个需求已完整实现（2026-07-07 完成，参考 D:/git_project/vscode）：

**需求1 删除到回收站**：`IFileService.delete` 加 `useTrash?: boolean`；main 侧 `fileSystemMainService` 用 Electron `shell.trashItem()`，失败包成 `FileSystemError('UNKNOWN')`。默认 `files.enableTrash=true` 走回收站。

**2026-08-26 补：`useTrash` 不是纯配置开关，必须先问 provider 能力**。原实现无条件 `useTrash = files.enableTrash !== false`，在 WSL/SSH 远程工作区删除必然失败（远端 server 是 headless node 无 `shell.trashItem`，`NodeFileSystemProvider` 抛 `trash is not supported on this filesystem`，文件删不掉）。修法对标 VSCode `FileSystemProviderCapabilities.Trash`：`IFileSystemProviderCapabilities` 加 `supportsTrash`（本地=是否注入 trash hook 推导，`RemoteFileSystemProvider` 硬编码 false——恒定值故**不 bump 远程协议**）+ `IFileService.getCapabilities?()` 让 renderer 能查（做成可选是为了不牵连几十处裸对象字面量测试桩）。`DeleteFileAction` 算 `enableTrash && supportsTrash`，远端自然走已有的「永久删除」确认框分支，无需新文案。三条设计红线：① **绝不在 `FileService.delete` 里静默把 useTrash 降级为永久删除**（对非交互调用方是数据破坏性的谎言），provider 层的 throw 保留为诚实兜底；② 混选（本地+远端）整批降级，不半兑现承诺；③ 事后回退（本地 trash 真失败→弹「永久删除」重试）前必须用 `exists` 过滤已删项，因为逐项 delete 会中断、原样重试必 ENOENT。同一判定也补在 `fileBulkEditService`（扩展 `workspace.applyEdit` 删文件，无 UI 可问故静默降级）。④ **能力探测本身失败时保留 `useTrash`（返回 true）**：探测失败=「不知道」，答「没有回收站」就是把用户要的回收站静默变成永久删除——同红线①，让 provider fail loud 再由回退弹框请用户明确决定。审查教训：注释写「别让探测决定破坏数据」而代码 `return false` 的自相矛盾，靠人工审查才抓到；桩的错误注入必须能建模「部分成功」（按目标+按 useTrash 精确抛），否则 `exists` 过滤与重试成功路径零覆盖、断言只能靠 confirm 次数间接推断（已改为直接断言 deleteCalls 序列，并用变异测试验证能捕获 ENOENT 回归）。

**需求2 Ctrl+Z 撤销**：完整保真移植 VSCode `IUndoRedoService` 到 `packages/platform/src/undoRedo/`（undoRedo.ts 接口 + undoRedoService.ts ~1400 行 resource/workspace 双型）。构造依赖 `IDialogService`+`INotificationService`。

**编排层** `apps/editor/src/renderer/services/explorer/ExplorerFileOperationService.ts`：职责分层=`ExplorerTreeService` 做 fs 原子操作+树状态，`ExplorerFileOperationService` 做撤销编排+备份/重建，命令层做目标解析。每个操作 push 一个 `FileOperationUndoRedoElement`(IWorkspaceUndoRedoElement)，用共享 `EXPLORER_UNDO_SOURCE`。删除撤销策略=删前把内容备份到内存(单文件 >10MB `MAX_UNDO_FILE_SIZE` 不备份标 truncated)，撤销用备份重写(因回收站无法程序化精确还原)。

**命令/键位**：`explorerUndoActions.ts` 的 Undo(ctrl+z)/Redo(ctrl+y, ctrl+shift+z)，when=`focusedView=='workbench.view.explorer.tree' && !editorTextFocus && !terminalFocus && explorerEnableUndo`。配置 `explorer.enableUndo`/`explorer.confirmDelete`/`files.enableTrash` 由 `ExplorerFileConfigurationContribution` 注册+建 context key。

**关键坑**：命令层所有 action 必须在第一个 `await` 前同步取完 service（见 [[action2-async-accessor-invalidation]]），否则 `accessor.get(IExplorerFileOperationService)` 报 "service accessor is only valid during..."。改造后 4 个测试文件（fileActions/ExplorerView/ExplorerView.compact/新增 ExplorerFileOperationService）需补注册 IUndoRedoService+ILoggerService+INotificationService+IExplorerFileOperationService。`pnpm check` 全绿(36 tasks)，e2e 100 passed。
