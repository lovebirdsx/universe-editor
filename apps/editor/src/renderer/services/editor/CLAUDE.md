# apps/editor/src/renderer/services/editor/CLAUDE.md

renderer 编辑器运行时的家：`EditorInput` 家族（本目录 27 个 `*Input.ts`）、打开/关闭/恢复路径、`EditorService`（`IEditorService` 实现）与 `EditorGroup`。本文是**身份约定 + 打开路径**的上下文地图（动手前通读）；身份碰撞的完整复盘见 [cases-editor-input-identity.md](cases-editor-input-identity.md)。

> ⚠️ 第一原则：**新增任何 `EditorInput` 一律先想 id 命名空间**。同一份内容被两种视图打开（源文件 vs 预览 / diff / merge / 图片…）时，身份必须分开，否则被 `openEditor` 去重成一个 tab。

## 🔴 EditorInput 身份红线

- 基类身份 = `get id()`（`packages/platform/src/workbench/editorService.ts:39`，默认 `resource.toString()`），**去重全走 id / `matches()`**；`matches` 只比 id——曾有的「resource 相同即相等」短路会绕过覆写的 id，已删。
- 去重命中已打开 tab 时：先 `existing.updateFrom?.(editor)` 再 dispose 新 input（`EditorService.ts:145`，机制与基类契约见 `packages/platform/CLAUDE.md`「EditorInput.updateFrom 契约」节）。
- 两派覆写手法：**虚拟 scheme 派**（`diff:` / `markdown-preview:` / `merge:`，额外暴露 `sourceUri` 给视图拿真路径）vs **仅覆写 id 派**（`image:${uri}`，`ImageEditorInput.ts:39`——图片要真实 `file:` resource 供 tab 图标 / SCM 装饰 / `ue-file` 加载）。选型与代价见 cases 文件。
- 用无歧义命名空间，别让两个不同视图撞成同一串：`swarmDiff:{reviewId}:{depotFile}:{left}-{right}`、`universe:/extension/<id>`、`inmemory://prompt/<id>`。

## 打开 / 关闭路径（唯一入口）

- **普通文件**：`IEditorResolverService.openEditor(uri, {pinned})`——**别绕过它直 `new FileEditorInput`**（它是唯一把图片扩展名路由到 `ImageEditorInput` 的地方；Ctrl+P 曾踩，见 `workbench/webview/cases-webview-pitfalls.md` 坑 5）。
- **渲染预览（markdown / html）**：唯一入口 `openPreviewInGroup.ts`（`openPreviewInGroup` 非 toggle / `togglePreviewInGroup` = Ctrl+Shift+V）。**「同一文件的预览全局唯一」这条不变量只能由它守**（不同文件的预览可同组共存），别在别处再写一份 `findEditor`。toggle 的 pin 继承与 dirty 保护见 cases 文件。
- **并排 / 恢复**：`openToSide.ts`（`ensureSideGroup`）、`editorGroupsPersistence.ts` + `EditorGroupsService.ts:454` 的 `EditorRegistry.deserialize`（恢复路径刻意不走 preview 唯一化，见 cases 文件）、`ClosedEditorsService`（Reopen Closed Editor，按 `(typeId, resource)` 认条目）。
- **聚焦**：`editorFocus.ts`（`focusEditorInput` / `bridgeInlineSuggestionVisible`）；「plain div + 裸字符键绑定」的 EditorInput **必须覆写 `focus()`** 把焦点留在自己容器内，否则基类默认落编辑器组 body → `focusout` 清 context key → 裸键 NO-MATCH（f→Esc→f 失灵）。同源教训见 skill [fix-keybinding-not-firing]。

## 文件 → 职责

- `EditorService.ts` / `EditorGroupsService.ts` / `EditorGroup.ts` —— `IEditorService` 实现、分组模型、去重（`EditorService.ts:145`）。
- `EditorResolverService.ts` + `FileEditorRegistry.ts` + `EditorComponentRegistry.ts` —— 扩展名/scheme → `EditorInput` 与挂载组件的注册表。
- `FileEditorInput.ts` / `UntitledEditorInput.ts` —— 源文件与未命名；`EditorViewStateCache.ts` / `MarkdownPreviewViewStateCache.ts` —— 每 input 的视图状态快照。
- 各视图 input：`DiffEditorInput.ts` / `MergeEditorInput.ts` / `MarkdownPreviewInput.ts` / `HtmlPreviewInput.ts` / `ImageEditorInput.ts` / `DocEditorInput.ts` / `WebviewDiffInput.ts` / `WebviewPanelInput.ts` / `CustomEditorInput.ts` / `SettingsEditorInput.ts` / `KeybindingsEditorInput.ts` / `WelcomeEditorInput.ts` / `ReleaseNotesInput.ts` / `SchemaViewerInput.ts` / `TerminalEditorInput.ts` / `GitGraphEditorInput.ts` / `PerforceGraphEditorInput.ts` / `SwarmReviewEditorInput.ts` / `SwarmDiffEditorInput.ts` / `ProcessExplorerInput.ts` / `AiSettingsEditorInput.ts` / `StartupPerformanceInput.ts` / `InteractionPerformanceInput.ts`。
- helper：`cloneEditorInput.ts` / `closeEditorWithConfirm.ts` / `activeTextEditor.ts` / `editorResourceAccessor.ts` / `revealEditorInGroups.ts` / `revealEditorPosition.ts` / `openInLockAwareGroup.ts` / `fileTextModelService.ts` / `diffModelCache.ts` / `largeFileGuard.ts` / `leadingBom.ts` / `minimalModelEdit.ts` / `selfWriteRegistry.ts` / `RecentTargetsService.ts` / `docOutline.ts` / `docRegistry.ts` / `findWordAtCursor.ts` / `imageFileTypes.ts`。
- `WebviewFocusRegistry.ts` —— 异步注册的 custom editor 的 pending-focus 队列（见 `workbench/webview/CLAUDE.md` 坑 8）。

## 案例：身份隔离的次生点与单例→多实例

[`cases-editor-input-identity.md`](cases-editor-input-identity.md) —— 两 tab 共存后才暴露的问题：`ClosedEditorsService` 比 `typeId`、`resolveTargetEditor` 按 `editorId` 定位、两派覆写手法的代价、preview 数量不变量的历史反转、toggle 的 pin/dirty 保护、单例 view state 改按 `input.id` 分桶 + `EditorGroupView.tsx` 的 keyed remount 名单（含护栏测试写法）。**改动涉及「同文件多 tab」或「单例编辑器泛化多实例」前必读。**

## 测试

`__tests__/` 与各子域同名；`renderer-node` project 默认收 `.test.ts`，依赖 DOM/Monaco 的进 `renderer-dom`（`vitest.config.ts` 的 `rendererDomTests` 名单，忘了加 fail loud）。e2e：`smoke.imageEditor`、`smoke.htmlPreview`、`smoke.explorerOpenPreview`、`smoke.editorGroupSwitch`。
