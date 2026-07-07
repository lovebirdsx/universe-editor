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

**需求2 Ctrl+Z 撤销**：完整保真移植 VSCode `IUndoRedoService` 到 `packages/platform/src/undoRedo/`（undoRedo.ts 接口 + undoRedoService.ts ~1400 行 resource/workspace 双型）。构造依赖 `IDialogService`+`INotificationService`。

**编排层** `apps/editor/src/renderer/services/explorer/ExplorerFileOperationService.ts`：职责分层=`ExplorerTreeService` 做 fs 原子操作+树状态，`ExplorerFileOperationService` 做撤销编排+备份/重建，命令层做目标解析。每个操作 push 一个 `FileOperationUndoRedoElement`(IWorkspaceUndoRedoElement)，用共享 `EXPLORER_UNDO_SOURCE`。删除撤销策略=删前把内容备份到内存(单文件 >10MB `MAX_UNDO_FILE_SIZE` 不备份标 truncated)，撤销用备份重写(因回收站无法程序化精确还原)。

**命令/键位**：`explorerUndoActions.ts` 的 Undo(ctrl+z)/Redo(ctrl+y, ctrl+shift+z)，when=`focusedView=='workbench.view.explorer.tree' && !editorTextFocus && !terminalFocus && explorerEnableUndo`。配置 `explorer.enableUndo`/`explorer.confirmDelete`/`files.enableTrash` 由 `ExplorerFileConfigurationContribution` 注册+建 context key。

**关键坑**：命令层所有 action 必须在第一个 `await` 前同步取完 service（见 [[action2-async-accessor-invalidation]]），否则 `accessor.get(IExplorerFileOperationService)` 报 "service accessor is only valid during..."。改造后 4 个测试文件（fileActions/ExplorerView/ExplorerView.compact/新增 ExplorerFileOperationService）需补注册 IUndoRedoService+ILoggerService+INotificationService+IExplorerFileOperationService。`pnpm check` 全绿(36 tasks)，e2e 100 passed。
