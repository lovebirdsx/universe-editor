---
name: editor-input-identity-isolation
description: 同一文件的多视图 EditorInput 必须靠覆写 id 隔离身份，否则被 openEditor/matches 去重成一个 tab
metadata: 
  node_type: memory
  type: project
  originSessionId: 18ef86fa-63d0-4b47-8b18-5dfe4d6a3fe3
---

**约定**：凡「同一文件、不同视图」的 `EditorInput`（预览/diff/merge/图片…），身份必须与 `FileEditorInput` 分开。

**根因**：基类身份 = `get id()`（默认 `resource.toString()`），去重全走 id/`matches()`（openEditor 命中即 `updateFrom?.()`+dispose 新输入）。**`matches` 只比 id**（曾有的「resource 相同即相等」短路会绕过覆写的 id，已删）。

**两派手法**：虚拟 scheme 派（diff/markdown-preview/merge，额外暴露 `sourceUri` 给视图拿真路径）vs 仅覆写 id 派（`image:${uri}`——图片走这派，因为 tab 图标/SCM 装饰/`ue-file` 加载都要真实 `file:` resource）。

**次生点**（两 tab 共存后才暴露，都是「按 resource 认 tab」不够）：`ClosedEditorsService.popMostRecent` 加比 `typeId`；`resolveTargetEditor`/tab 右键菜单/`ReopenWithAction` 优先按 `editorId` 定位、回退 resource。

**打开文件别绕 resolver**：markdown 两条打开路径曾直接 `new FileEditorInput` 绕过 `IEditorResolverService`（唯一把图片扩展名路由到 `ImageEditorInput` 的地方）→ 图片被当二进制打开成乱码。除「带 `:line` 的行链接只指文本」外都走 resolver。

**通则**：「plain div 无 Monaco 注册 + 裸字符键绑定」的 EditorInput（预览/文档/图片…）必须覆写 `focus()` 把焦点保持在自己容器内——基类默认落编辑器组 body（滚动容器外）→ `focusout` 清 context key → 裸字符键 NO-MATCH（f→Esc→f 失灵）。

关联 [[path-comparison-convergence]]（同源异层：文件系统身份键 vs 编辑器身份键）、[[editor-text-focus-stuck-swallows-keys]]。e2e：`smoke.imageEditor`、`smoke.markdownPreview`。
