---
name: editor-input-identity-isolation
description: 同一文件的多视图 EditorInput 必须靠覆写 id 隔离身份，否则被 openEditor/matches 去重成一个 tab
metadata: 
  node_type: memory
  type: project
---

**约定**：凡「同一文件、不同视图」的 `EditorInput`（预览/diff/merge/图片…），身份必须与 `FileEditorInput` 分开。

**根因**：基类身份 = `get id()`（默认 `resource.toString()`），去重全走 id/`matches()`（openEditor 命中即 `updateFrom?.()`+dispose 新输入）。**`matches` 只比 id**（曾有的「resource 相同即相等」短路会绕过覆写的 id，已删）。

**两派手法**：虚拟 scheme 派（diff/markdown-preview/merge，额外暴露 `sourceUri` 给视图拿真路径）vs 仅覆写 id 派（`image:${uri}`——图片走这派，因为 tab 图标/SCM 装饰/`ue-file` 加载都要真实 `file:` resource）。

**次生点**（两 tab 共存后才暴露，都是「按 resource 认 tab」不够）：`ClosedEditorsService.popMostRecent` 加比 `typeId`；`resolveTargetEditor`/tab 右键菜单/`ReopenWithAction` 优先按 `editorId` 定位、回退 resource。

**打开文件别绕 resolver**：markdown 两条打开路径曾直接 `new FileEditorInput` 绕过 `IEditorResolverService`（唯一把图片扩展名路由到 `ImageEditorInput` 的地方）→ 图片被当二进制打开成乱码。除「带 `:line` 的行链接只指文本」外都走 resolver。

**通则**：「plain div 无 Monaco 注册 + 裸字符键绑定」的 EditorInput（预览/文档/图片…）必须覆写 `focus()` 把焦点保持在自己容器内——基类默认落编辑器组 body（滚动容器外）→ `focusout` 清 context key → 裸字符键 NO-MATCH（f→Esc→f 失灵）。

**id 去重 ≠ 数量不变量**（2026-08 修 bug 得到）：`id` 隔离保证「同文件的预览与源各占一 tab」，但**管不了「同组多个不同文件的预览」**——渲染预览（markdown/html）对标 VSCode dynamic preview，同组同 kind 最多一个，须显式 retarget。唯一入口 `services/editor/openPreviewInGroup.ts`（`openPreviewInGroup` 非 toggle / `togglePreviewInGroup` Ctrl+Shift+V），故意不走它的例外只有 `toSide`、Reopen Closed Editor、工作区恢复。曾因三处同构逻辑各自只 `findEditor(同 id)` 而漏，[a 预览][a 源] 下开 b 预览堆出第三个 tab。

**dirty 是 per-input 的，dispose 前必须转移**：`FileEditorInput` 无 `updateFrom`，dirty 标志不在共享 Monaco model 上。retarget 时若 toggle 预览持有的 dirty 源要被丢弃（组内已有该文件 tab），必须先 `shown.setDirty(true)`——留下的 tab 是在编辑落地**之后**才 resolveModel 的，自认 clean，丢了标志就关闭无提示 + 不进 backup + 外部变更静默 reload，未保存编辑三条路都会没。

关联 [[path-comparison-convergence]]（同源异层：文件系统身份键 vs 编辑器身份键）、[[editor-text-focus-stuck-swallows-keys]]。e2e：`smoke.imageEditor`、`smoke.markdownPreview`。
