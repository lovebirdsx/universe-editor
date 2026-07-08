---
name: editor-group-open-orphan-leak
description: EditorGroupModel.openEditor 命中重复身份时早退但不释放调用方交出所有权的孤儿输入，导致 Disposable 泄漏；修复=早退前 existing.updateFrom?.(editor) + editor.dispose()
metadata: 
  node_type: memory
  type: project
  originSessionId: b5d2a352-85ef-4b72-adce-15788ccd02e0
---

`EditorGroupModel.openEditor`（`packages/platform/src/workbench/editorGroupModel.ts`）在 `findEditor` 命中同 `id`（`matches`）的 `existing` 时**早退**，但调用方按约定已把新建的 `editor` 交出所有权——早退路径既不 add 进 `_editorStore`、也不 dispose，于是新实例 + 其内部 `_store` 两个 Disposable 泄漏。

**触发路径**：任何「直接 `group.openEditor(新建input)` 且该 input 身份已在组内」的场景，典型是 `ReopenClosedEditorAction`（反序列化出一份仍开着的 tab 的副本）、`moveEditor` 里目标组已有同 id 分屏克隆。`EditorService.openEditor` 自己的去重分支早就正确处理了（`existing.updateFrom?.(input)` + `input.dispose()`），但绕过 service 直接打 model/group 的路径没保护。

**修复**：在 model 的早退分支内收敛为单一真源——
```
if (editor !== existing) { existing.updateFrom?.(editor); editor.dispose() }
```
`updateFrom` 对齐 [[diff-view-stale-on-reopen]] 契约（DiffEditorInput 靠它吸收新内容）。修完后 `EditorGroupsService.moveEditor` 里那句手写 `if (existing && existing !== editor) editor.dispose()` 变冗余，已删（model 兜底）。

**测试**：`packages/platform/src/__tests__/workbench/editorGroupModel.test.ts` 加两例——「disposes a duplicate-identity orphan」断言 `dup.isDisposed===true && a.isDisposed===false`；「updateFrom before disposing」断言 existing 先吸收再 dispose。移除修复行两例即挂（验证能抓 bug）。

**踩坑教训**：`smoke.reopenClosedEditor.spec.ts @regression` 的现有流程是「先关 Settings 再 reopen」，reopen 时组内已无副本 → 不走孤儿分支 → **该 e2e 用例本身抓不到这个泄漏**（无论修没修都绿）。真正定位靠 skill `fix-disposable-leak` 的**单元级 `withLeakCheck`**：`openEditor(a)`→`openEditor(同resource的dup)`→`model.dispose()` 直接报 idx 连续两条泄漏。e2e teardown gate 抓不到是因为重开的 tab 一直 rooted 开着（非泄漏），且 `@regression` tag 让它从本地 `pnpm e2e` 主趟剥离（约定见 `apps/editor/e2e/RUNBOOK.md`）。判据：想复现「交出所有权后被丢弃」的孤儿泄漏，用单元 leak 断言比 e2e 快且确定。
