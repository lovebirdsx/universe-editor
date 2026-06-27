---
name: session-diff-feature
description: 会话级 diff（Session Changes）功能——逆推 baseline + Side Bar 列表/树视图 + 单击预览双击钉住
metadata: 
  node_type: memory
  type: project
  originSessionId: f6f35c5d-d60d-486e-b6f2-8a1f136ffcfd
---

会话级 diff（VSCode-Copilot 式「Session Changes」），跟踪当前 ACP agent 会话改动的文件，已完成（2026-06）。

核心设计：
- **逆推 baseline**：agent 直接写盘，renderer 读不到改前内容。`SessionChangeTrackerService` 按 (sessionId, path) 累积 agent 上报的 `structuredPatch` hunk 批次，读当前盘上内容后用 `reconstructBaseline` 反向重建会话前基线（见 `src/renderer/services/acp/sessionChangeTracker.ts` + `diff/reconstructBaseline.ts`）。只持久化 hunk 批次，baseline/current 每次从盘重算。
- **视图**：`SessionChangesView.tsx` 支持 list/tree 两种模式（树用 buildTree + 单子目录链压缩 compress，仿 SCM）；右上角切换按钮 `SessionChangesViewToolbar.tsx` 走 `viewToolbarMap`，模式存于 `sessionChangesViewState`（observable）+ IStorageService GLOBAL 持久化（restoredRef 防初始覆盖）。
- **单击预览/双击钉住**：行 onClick → `openEditor(DiffEditorInput, {pinned:false})`（复用 preview tab），onDoubleClick → `{pinned:true}`。
- **Activity Bar 图标**：两套独立 icon-map（`activitybar/` vs `viewContainerHeader/`），容器 `icon:'diff'` 各自解析；activitybar map 里映射 `diff: FileStack`（未映射会 fallback 到 FolderTree = Explorer 图标）。

测试：单测 `SessionChangesView.test.tsx`（预览/钉住/树分组/折叠）；e2e `smoke.sessionChanges.spec.ts`（@p1，sessionDiffAgent.cjs 真实写盘全链路 + 切换按钮）。

2026-06 修复（新建/删除/状态对齐）：
- **新建文件**：`readStructuredPatch`（acpSession.ts）现额外读 SDK 权威信号 `toolResponse.type:'create'`/`originalFile:null` → `isCreate`，**空内容 Write（零 hunks）不再被丢弃**（之前 `readStructuredPatch`+`record` 双重早退，空文件永不出现）；`DiffBatch.created` 标记 → `_buildChange` 对 created 强制 `added`+`baseline=''`。
- **删除文件**：tracker 升 `FileRecord {batches, deleted?}` + schema v2（兼容 v1）+ `markDeleted`/`unmarkDeleted`；新建 `SessionDeletedFilesWatcher` contribution 监听 `IFileWatcherService.onDidChangeFiles`，active session 存在期间 `deleted`→markDeleted（确认真删防 atomic rewrite）、`added`→unmarkDeleted（删除又恢复则剔除）。删除项**无 baseline**（baseline/current 皆空），视图禁用点击。agent 无 Delete 工具/SDK 无删除信号是根本约束，故走 fs-watch 推断。path 经 `normalizePath`（URI.file().fsPath）统一 key，避免 agent 路径与 fs 路径不一致产生重复 entry。
- **状态与 SCM 对齐**：`SessionChangesView.module.css` 用 `.row[data-status]` 给文件名上状态色（`--color-scm-*` 同源）+ deleted 删除线，对齐 `ScmView` 的 `decorationStyle`。`!existed→deleted` 优先于 degraded（顺带修「改了又删」误显示 degraded）。新单测 `__tests__/sessionChangeTracker.test.ts`。
