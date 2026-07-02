---
name: editor-input-identity-isolation
description: 同一文件的多视图 EditorInput 必须靠覆写 id 隔离身份，否则被 openEditor/matches 去重成一个 tab
metadata: 
  node_type: memory
  type: project
  originSessionId: 18ef86fa-63d0-4b47-8b18-5dfe4d6a3fe3
---

**约定**：凡"同一文件、不同视图"的 `EditorInput`（预览/diff/merge/图片…），编辑器身份必须与 `FileEditorInput` 分开，否则会被去重逻辑当成同一个 tab。

**根因**：`EditorInput` 基类身份 = `get id()`（默认 `resource.toString()`）。去重全走 id / `matches()`：`EditorService.openEditor` 用 `e.id === input.id`（命中则 `updateFrom?.()` + `dispose` 掉新输入）；`editorGroupModel.indexOf/contains/findEditor` 用 `e.matches(editor)`。若两个输入 `resource` 相同又都不覆写 id，就撞身份。

**两种隔离手法**（`apps/editor/src/renderer/services/editor/`）：
- 虚拟 scheme 派：`get resource()` 返回 `scheme: 'diff'|'markdown-preview'|'merge'` 的 URI + 覆写 `id`。适合视图不需要真实 `file:` resource 的（Markdown/Diff/Merge，各自额外暴露 `sourceUri`/`originalUri` 给视图拿真路径）。
- 仅覆写 id 派：`get resource()` 保留真实 `file:` URI，只 `override get id()` 加前缀（如 `image:${uri}`）。**图片编辑器走这派**——因为 `ImageEditor.tsx`(ue-file 加载)、`ClosedEditorsService`、tab 文件图标 + SCM 装饰（`EditorGroupView.tsx` 靠 `resource.scheme==='file'` 判定）都要真实 resource。

**2026-07 修的 bug（提交 6f7d02ed 的 ImageEditorInput 漏了这条约定）**：图片和文本视图对同一文件 id 相同 → 打不开两个 tab / Reopen With 切换异常。修复三处：
1. `ImageEditorInput` 加 `override get id() { return 'image:' + this._resource.toString() }`。
2. 基类 `EditorInput.matches` 收紧为**只比 id**（删掉"resource 相同即相等"的短路，那会绕过覆写的 id）。id 默认派生自 resource，对现有输入行为不变。
3. **次生点**（两 tab 能共存后才暴露，都是"按 resource 认 tab"不够）：
   - `ClosedEditorsService.popMostRecent` 的 alreadyOpen 判断加 `e.typeId === entry.typeId`（否则关掉图片、文本还开着时重开图片被误跳过）。
   - `resolveTargetEditor`(editorActionHelpers) + tab 右键菜单(`EditorGroupView` TabMenuState)加 `editorId`，命令优先按 id 精确定位、回退 resource；`ReopenWithAction` 同样优先 editorId 关正确的 tab。

带 `instanceof FileEditorInput` 守卫的按-resource 查找（EditorOpenerContribution/logActions/preferencesActions/extensionApiActions）不受影响，无需改。

与路径身份收敛（[[path-comparison-convergence]]）同源异层：那个治"文件系统身份键碰撞"，这个治"编辑器身份键碰撞"。测试：`imageEditor.test.ts`、`ClosedEditorsService.test.ts`、`editorActions.test.ts`；e2e `smoke.imageEditor`(含 Reopen With image→file)。
