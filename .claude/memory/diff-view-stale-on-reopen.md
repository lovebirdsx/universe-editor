---
name: diff-view-stale-on-reopen
description: session diff 视图文件二次修改后重新点开仍显示旧内容的根因与修复（openEditor 去重 dispose 新 input）
metadata: 
  node_type: memory
  type: project
  originSessionId: a22877a8-e388-45bf-ad10-18d57f6fc5c3
---

会话级 diff（[[session-diff-feature]]）文件被 agent 二次修改后 diff 视图不同步。有**两条独立路径**，必须都修：

**路径1（重新点击列表行）**：`EditorService.openEditor`（`apps/editor/src/renderer/services/editor/EditorService.ts`）用 `input.id` 去重（DiffEditorInput id 是 `diff:${uri}`）。命中已打开 tab 时直接 `input.dispose()` 丢弃携带新内容的新 input、复用旧实例，旧实例持有上一次的 baseline/current 快照——`SessionChangesView` 每次点行都 `new DiffEditorInput(...)` 但从不更新已存在实例。
修复：platform 的 `EditorInput` 基类加可选钩子 `updateFrom?(other)`；`openEditor` 命中已存在实例时先 `existing.updateFrom?.(input)` 再 dispose。`DiffEditorInput.updateFrom` 调 `update()`。测试 `EditorService.diffReuse.test.ts`。

**路径2（diff tab 一直开着，agent 又改文件——真正的主场景）**：已打开的 `DiffEditorInput` 实例不订阅 tracker，只有 `SessionChangesView` 列表订阅了 `changesFor` observable。所以列表刷新但开着的 tab 纹丝不动，且不重新点行就永远不刷新。
修复：新增常驻 contribution `SessionChangesDiffSyncContribution`（AfterRestore 注册），autorun 订阅所有 session 的 `changesFor`（遍历 `sessions.sessions` 读各自 `sessionIdOnAgent`，diff tab 可属任意 session 非仅 active），变化时遍历 `groups.groups→group.editors` 命中同 `originalUri` 的 DiffEditorInput 调 `update(baseline,current)`。测试 `SessionChangesDiffSyncContribution.test.ts`。

下游链路 `update()`→`onDidChangeContent`→`DiffEditor.tsx` 就地 setValue 双侧 model 本就齐全，两处缺口都在"谁来触发 update"。两条路径互补兜底（tracker `_recompute` 是异步的，点行那刻 `c` 可能仍是旧值，contribution 会在重算完后再刷一次）。

**路径3（用户在编辑器里改源文件，diff 要 live 跟随——后续 commit「diff 视图跟随修改自动更新」）**：DiffEditor 的 modified 侧是**独立临时 model**（synthetic URI），与源文件共享 model 脱钩。用户切回源文件编辑（含未保存脏编辑），diff 不动。修复：新增 `DiffLiveContentSyncContribution`（AfterRestore），为每个开着的 DiffEditorInput 订阅其 `originalUri` 的**共享 Monaco model**（`MonacoModelRegistry.peek`），`onDidChangeContent` 时把 live 文本推进 diff 的 modified 侧。

**这层引入一个真产品竞态（务必记住）**：文件写盘会触发**迟到的 fs 事件**，`ExternalChangeWatcher._refreshChangedDiffEditors` 原本无条件 `readFileText`→`diff.update(_, 磁盘值)`，会**盖掉用户未保存的 live 编辑**（磁盘还是旧内容）。同理 `SessionChangesDiffSyncContribution._sync` 用 tracker 读盘的 `current` 也会盖。**统一修法：这两处刷 diff modified 侧时都改成 live-model 优先**——`MonacoModelRegistry.peek(uri)` 有值就用 `model.getValue()`（编辑器缓冲才是真相；clean 时它=磁盘，含 SCM discard 后 revert 的情况），无 live model 才 fallback 读盘。**别用 `isDirty` 判断**（React effect 异步更新，fs 事件到达时可能还没翻 true，留竞态窗口）。回归单测 `ExternalChangeWatcher.test.ts`（`vi.mock` MonacoModelRegistry 注入 live model 验不被 disk-stale 覆盖）。E2E 排障详见 skill `fix-ci-e2e-flake` 案例 19。

**How to apply**：任何"内容随时间变、id 稳定复用同一 tab"的 EditorInput 都应实现 `updateFrom`；若还存在"tab 开着时数据源在后台变"的场景，仅 `updateFrom` 不够，还需一个订阅数据源 observable 的 contribution 主动把新内容推给已打开实例。**凡"响应 fs/tracker 变更去刷新可能同时有 live 编辑缓冲的 diff"的代码，一律 live-model 优先、读盘兜底**，否则会盖掉未保存编辑。改了 platform 后要 `pnpm --filter @universe-editor/platform build`。`IAcpSession` 类型在 `acpSessionModel.ts` 不在 platform。
