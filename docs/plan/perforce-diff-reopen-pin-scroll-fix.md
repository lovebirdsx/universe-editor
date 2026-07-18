# p4 diff 三问题修复 — session 计划

分支 `task2`。修复 SCM/p4 diff 编辑器的三个相关但独立的 bug。三者都走 p4 diff 的
`_workbench.openDiff` → `DiffEditorInput` 链路，但根因各异。

## 三个问题与根因

1. **打开 p4 changelist / reconcile 文件 diff，关闭后 Ctrl+Shift+T 无法恢复**
   - 根因：`DiffEditorInput` 没实现 `serialize()`，其 EditorProvider 也没 `deserialize` →
     `ClosedEditorsService` 记录的 `serializedData` 为 null → `ReopenClosedEditorAction`
     `EditorRegistry.deserialize` 返回 null → 放弃恢复。影响所有 diff（p4/git/session/compare）。

2. **SCM 双击文件仍是预览态，必须双击 tab 才转正**
   - 根因：`ScmView` 双击行会把 `{ pinned: true }` 作为末参传给命令；`git.openChange` 读取并
     透传，但 `perforce.openChange`（`extension.ts:295`）忽略 `args[1]`，`client.ts` 的
     `openChange` 也无 `pinned` 形参、`_workbench.openDiff` 硬编码 `pinned:false`。

3. **单个 p4 diff 在 diff↔文件切换后切回，滚动位置重置（开两个 diff 则保留）**
   - 根因：`DiffEditor.tsx` 把 editor 创建（effect A，不依赖 input）与 viewState wiring
     （effect B，依赖 diffInput）拆成两个 effect。React 按声明顺序跑 cleanup → unmount 时
     effect A 先 `ed.dispose()`，之后 effect B cleanup 的 `viewState.dispose()` flush 到
     **已 disposed 的 editor**，`saveViewState()` 返回 null → cache 为空 → remount 回顶部。
   - 对照：`SwarmDiffEditor` 把两者放同一 effect，flush 在 dispose 前，故正常。
   - 开两个 diff 时是 diff↔diff 切换（同 componentKey `'diff'` 组件复用、不 remount），走
     model swap，viewState 存取正常 → 保留。

## 已完成的改动（全部落盘）

### 问题 1 —— `apps/editor`（惠及所有 diff）
- `services/editor/DiffEditorInput.ts`：加 `serialize()`（只存结构 URI：originalUri /
  modifiedUri? / openableResource?，**不存易失的两侧文本**）；加静态 `deserialize()`：同步重建
  空内容 input + fire-and-forget 异步回填（`isDisposed` 守卫后 `update()`）。
- `services/editor/diffContentHydration.ts`（**新增**）：`hydrateDiffContent(input, accessor)`。
  开头同步取完 IFileService/ICommandService/IScmService（规避 accessor 首 await 失效坑）。
  同文件 diff：original 走 `resolveScmProviderId` + `dirtyDiffCommandId(providerId,'getHeadContent')`
  （命中扩展 baseline 缓存，即用户要的「优先扩展缓存」），modified 读本地文件；cross-file：两侧读盘。
- `contributions/BuiltInEditorProvidersContribution.ts`：diff provider 补
  `deserialize: (data, accessor) => DiffEditorInput.deserialize(data, accessor)`。
- 测试：`__tests__/DiffEditorInput.test.ts` 加 serialize/deserialize 往返 + 结构保留 +
  malformed 拒绝（9 tests 全绿）。

### 问题 2 —— `extensions/perforce`（对齐 git）
- `client.ts`：`openChange(localPath, pinned=false, preserveFocus=false)` 透传给
  `_workbench.openDiff`；`_openSpreadsheetChange` 同步加参透传 `_workbench.openWebviewDiff`。
- `extension.ts`：`perforce.openChange` 解构 `[arg, options]`，透传
  `options?.pinned/preserveFocus`（照抄 `git.openChange`）。
- 注：`perforce-graph.openWorkingTreeFile` 是图表面板打开、无 SCM 行双击语义，未改。

### 问题 3 —— `apps/editor`（DiffEditor unmount 时序）
- `workbench/editor/DiffEditor.tsx`：加 `viewStateRef`。effect A（create）cleanup 在
  `ed.dispose()` **之前** `viewStateRef.current?.dispose()`（flush 到 live editor）并置空；
  effect B（set-model）把 viewState 存进 ref，cleanup 用 `if (viewStateRef.current===viewState)`
  守卫避免 unmount 时二次 flush（覆盖成空态）。加 `type IDisposable` import。
- 测试：`__tests__/DiffEditor.viewStateUnmount.test.tsx`（**新增**）。mock 的
  `saveViewState()` 在 disposed 后返回 null 来复现；断言 unmount 后 cache 里有 live 状态
  （scrollTop 120）。修前红、修后绿。

## 追加修复（第二轮，问题 4 / 5）

复查发现第一轮问题 1 的「serialize 丢文本 + deserialize 时 hydration 重新拉取」策略有两个漏洞：

4. **预览态 diff，Ctrl+Shift+T 无法恢复**
   - 根因：`ClosedEditorsService` 只监听 `kind === 'close'`。SCM 单击默认开在**预览槽**（pinned:false），
     再单击另一文件会把旧预览「就地替换」，触发的是 `previewReplace` 事件（旧预览被 dispose 却从不 fire
     `close`）→ 从未进 reopen 栈 → 无法恢复。
   - 修复：`packages/platform/.../editorGroupModel.ts` 的 `IEditorGroupModelChangeEvent` 加
     `replacedEditor?` 字段，`previewReplace` fire 时带上被驱逐的旧预览（dispose 之前）；
     `ClosedEditorsService` 同时记录 `close` 与 `previewReplace`（抽出 `_record` helper）。
   - 复现：单测 `ClosedEditorsService.test.ts`「records a preview editor evicted in-place」（修前红）
     + platform `editorGroupModel.preview.test.ts` 断言 `replacedEditor===a`；
     e2e `smoke.reopenClosedEditor.spec.ts`「reopens a PREVIEW diff evicted in-place…」。

5. **非预览态 diff 可恢复，但两边内容一样（未正确显示 diff）**
   - 根因：`serialize()` 故意丢弃两侧文本，靠 `deserialize` 时 `hydrateDiffContent` 重新拉取。但重建只
     对「工作区文件 vs SCM baseline」成立；当两侧是**按值传入、磁盘/SCM 无来源**的文本（p4 shelved 双 depot
     blob、agent 会话快照、直接传文本的 diff）时，重建把两侧都读成空串 → 两边相同、diff 消失。
   - 修复：**放弃「丢文本 + 重拉」策略**，`serialize()` 直接持久化 `originalContent`/`modifiedContent`
     （对标 `WebviewDiffInput` 按值持有），`deserialize` 同步用保存文本重建；**删除
     `diffContentHydration.ts`**。SCM/session 若磁盘更新，已有 `DiffLiveContentSyncContribution` /
     `ExternalChangeWatcher` / `SessionChangesDiffSyncContribution` 会在挂载后就地刷新。
   - 复现：e2e `smoke.reopenClosedEditor.spec.ts`「reopens a diff editor…」加内容断言（恢复后 modified
     侧为空 `""` → 修前红）；p4 e2e `smoke.perforceCollectChanges.spec.ts`「reopening a closed diff
     rebuilds distinct baseline/working sides」双击 reconcile 行→关→恢复→断言两侧不同。

### 第二轮验证
- `pnpm check`：**47/47 任务全绿**（editor 3767 单测、perforce 246、platform、workbench-ui 均通过）。
- e2e：`smoke.reopenClosedEditor`（3 例）+ `smoke.perforceCollectChanges`（reopen diff + phantom
  delete）**全绿**。

## 验证状态（第一轮）

- `pnpm --filter @universe-editor/editor typecheck`：**通过**。
- DiffEditorInput.test / DiffEditor.viewStateUnmount / autoReveal / leak：**全绿**。
- `pnpm --filter @universe-editor/perforce build`：**通过**。
- `pnpm --filter @universe-editor/editor build`：**通过**（e2e 产物已刷新）。
- `pnpm check`：仅 `logMainService.test.ts` 的「rotate burst 熔断器」1 例失败 →
  **单独重跑 17 tests 全绿**，是基于计时的既有 flaky，与本次改动无关。

## 剩余工作（已收尾）

1. **e2e**：问题 1 已在 `e2e/specs/smoke.reopenClosedEditor.spec.ts` 追加
   `reopens a diff editor with the correct type @regression`：`_workbench.openDiff`
   （pinned:true）→ `getActiveEditorTypeId()==='diff'` → closeActiveEditor →
   reopenClosedEditor → 再断言 `'diff'`。**本地 2 例全绿（3.9s，无 flake）**。
   - 问题 3 滚动保留 / 问题 2 双击钉住：e2e 缺对应探针（diff 滚动 / 预览态判定），
     单元测试已权威覆盖，未补 e2e。
2. **文档**：`docs/user/zh-CN/perforce/` 无涉及双击/预览/diff 恢复的通用交互描述，
   且行为是「修复到与 git 一致」而非新增功能 → **无需同步**。
3. **收尾**：editor typecheck / e2e typecheck / perforce build 全过；editor 相关
   347 单测全绿；reopenClosedEditor e2e 2 例全绿。**待用户确认后 commit**。

## 关键文件

- `apps/editor/src/renderer/services/editor/DiffEditorInput.ts`（serialize 改为持久化两侧文本）
- ~~`apps/editor/src/renderer/services/editor/diffContentHydration.ts`~~（第二轮**已删除**）
- `apps/editor/src/renderer/contributions/BuiltInEditorProvidersContribution.ts`
- `apps/editor/src/renderer/services/editor/ClosedEditorsService.ts`（第二轮：记录 previewReplace）
- `packages/platform/src/workbench/editorGroupModel.ts`（第二轮：previewReplace 事件带 replacedEditor）
- `apps/editor/src/renderer/workbench/editor/DiffEditor.tsx`
- `apps/editor/src/renderer/workbench/editor/__tests__/DiffEditor.viewStateUnmount.test.tsx`（新增）
- `apps/editor/e2e/specs/smoke.reopenClosedEditor.spec.ts`（问题 1/4/5 的 e2e 回归）
- `apps/editor/e2e/specs/smoke.perforceCollectChanges.spec.ts`（问题 5 的 p4 e2e 回归）
- `extensions/perforce/src/{client,extension}.ts`
- 参考：`extensions/git/src/extension.ts:434`（git.openChange 透传范式）、
  `apps/editor/src/renderer/workbench/swarm/SwarmDiffEditor.tsx:128`（单 effect 正确范式）
