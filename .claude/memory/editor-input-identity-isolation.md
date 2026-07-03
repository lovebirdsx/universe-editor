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

**2026-07 追加（markdown 点开图片链接显示乱码）**：从 markdown 打开文件的两条路径都**直接 `new FileEditorInput` 绕过了 `IEditorResolverService`**（唯一把图片扩展名路由到 `ImageEditorInput` 的地方，`**/*.png` 等 priority 100 注册在 `BuiltInEditorBindingsContribution`）→ 图片被文本编辑器当二进制打开成乱码。修两处，都改成走 resolver（对齐资源管理器 / `openDroppedResource` 的正确姿势）：
- 线②预览/渲染视图：`useMarkdownFileLink.ts` 无 `:line` 时 `editorResolver.openEditor(uri)`；带 `:line` 仍用 `FileEditorInput`（resolver 不携带 selection，行链接只指文本）。
- 线①源码编辑器 documentLink：`EditorOpenerContribution._open` 加 `isImageResource(target)` 分支→ `editorResolver.openEditor` + `return null`（无文本光标可放，不报 monaco editor）。此即上一段"不受影响"的例外。
测试：`MarkdownView.test.tsx`(图片链接经 resolver + @ 链接改断言 resolver)。注意 `[x](./a.png)` 这类**相对**图片路径在预览里根本不解析成链接——`filePathLink.ts` 的 `EXTS` 白名单不含图片扩展名，只有绝对路径（`/…`、`D:/…`）才 `looksLikeFilePath`；源码编辑器则靠 markdown LSP 的 documentLink 认到图片。

与路径身份收敛（[[path-comparison-convergence]]）同源异层：那个治"文件系统身份键碰撞"，这个治"编辑器身份键碰撞"。测试：`imageEditor.test.ts`、`ClosedEditorsService.test.ts`、`editorActions.test.ts`；e2e `smoke.imageEditor`(含 Reopen With image→file)。

**2026-07 追加（非 Monaco 编辑器 EditorInput 必须覆写 `focus()`，否则 context-key 掉）**：`DocEditor`（内置文档中心，走共享 `useMarkdownReaderNav`）复用 markdown 预览的 vimium 键盘导航后，「按 f 弹 hints → Esc 关闭 → 再按 f 无反应」。根因同 [[markdown-preview-link-hints]] 焦点链：焦点回归路径（`FocusActiveEditorGroup`→`focusEditorInput`）调 `input.focus()`，基类默认 `focus()` 把焦点落到**编辑器组 body**（在滚动容器*外*）→ 触发容器 `focusout` → `markdownPreviewFocused` 变 false → `LINK_HINTS_WHEN` 门控不满足 → 裸 f 键 NO-MATCH。`MarkdownPreviewInput.focus()`（67-81 行注释详述）早已覆写此坑，但对称的 `DocEditorInput` 漏了。修法：`DocEditorInput` 覆写 `focus()`，经 `MarkdownPreviewRegistry.get(this.resource).focus()` 把焦点路由回滚动容器（registry key 用 `this.resource`=`universe:/doc/…`，即 DocEditor 注册时的 URI）。**通则**：任何「plain div 无 Monaco 注册 + 裸字符键绑定」的 EditorInput（预览/文档/图片…）都要覆写 `focus()` 把焦点保持在自己的容器内。e2e 回归 `smoke.markdownPreview.spec.ts` 的 `doc center Escape keeps focus so link hints keep working`（复现 f→Esc→f）。关联 [[editor-text-focus-stuck-swallows-keys]]。

**同批修的另两处 DocEditor 行为**（都对齐 markdown 预览）：
1. **doc-to-doc 链接默认原地导航**（此前每点一个链接就无条件 `openEditor(new DocEditorInput)` 堆一个新 tab——DocEditorInput 按 docId 各有不同 id 不去重）。修法照 `openMarkdownPreviewInGroup`：`DocLinkContext` 回调签名加 `opts?: {toSide}`（`MarkdownView.SafeLink` 传 `e.ctrlKey||e.metaKey`），`DocEditor.openDocLink` 默认取当前 tab 的 index → `group.openEditor(target,{index})` + `closeEditor(old)` 原地替换（单 tab 走 trail，Alt+←/→ 可用），Ctrl/Cmd+click 才新开。
2. **`EditorGroupView.renderContent` 的按-id remount 分支**从只认 `'markdown.preview'` 扩到 `|| 'doc'`：原地替换 A→B 时若复用组件实例会残留 A 的滚动位置 / useMarkdownReaderNav 注册，key 成 `active.id` 强制重挂载。
测试：`MarkdownView.test.tsx`（DocLinkContext 断言加第二参 `{toSide:false}`）；e2e `doc center link navigates in place without opening a new tab`。
