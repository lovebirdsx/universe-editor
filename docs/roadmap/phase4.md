## 阶段四：EditorResolverService（URI → typeId 解析）

### 目标

为未来 Tree/Graph 编辑器（用户明确要留 hook 的方向）补齐"按 URI/语言决定打开哪个 EditorInput"的解析层。当前所有 `FileEditorInput` 都是写死创建的，没有 "open with..." 抉择。

**重要**：`EditorRegistry.registerEditorProvider`（`packages/platform/src/workbench/editorService.ts:160-181`）已经是 hook 点。本阶段补的是"URI → typeId 决策"和 UX，而不是注册扩展点本身。

### 关键文件

**新建**：
- `packages/platform/src/workbench/editorResolverService.ts` —— `IEditorResolverService.registerEditor(globPattern, info, factory)` / `resolveEditor(uri, language?): IEditorInput | null` / `openEditor(uri, preferredTypeId?): Promise<void>`。Factory 签名 `(uri, accessor) => EditorInput`
- `apps/editor/src/renderer/workbench/editor/EditorResolverService.ts` —— renderer 端实现，glob 复用 `apps/editor/src/renderer/workbench/search/glob.ts`（已存在，handles include/exclude pattern；不够强则扩它，不引 minimatch）
- `apps/editor/src/renderer/actions/editorResolverActions.ts` —— `workbench.action.reopenWith`：弹 QuickPick 列出该 URI 可用的 typeId，用户选 → close + reopen
- `apps/editor/src/renderer/contributions/BuiltInEditorBindingsContribution.ts` —— 默认绑定：`*.json/*.ts/*.md/...` → FileEditorInput（套路 D，BlockStartup）

**修改**：
- `apps/editor/src/renderer/workbench/explorer/ExplorerView.tsx` —— `openFile` 改走 `editorResolverService.openEditor(uri)` 而非 `new FileEditorInput(uri)`
- `apps/editor/src/renderer/services/recentFiles/recentFilesService.ts` —— 同上
- `apps/editor/src/renderer/workbench/editor/EditorTabContextMenu.tsx` —— 扩 "Reopen With..." 菜单项（通过 MenuRegistry）
- `packages/platform/src/index.ts` —— re-export `editorResolverService`

### 设计要点

1. **API 对齐 VSCode `IEditorResolverService.registerEditor(globPattern, info, options, factory)`** 但简化：只保留 `pattern` / `typeId` / `displayName` / `priority` / `factory` / `canHandleDiff?: false`。不做 RegisterPattern 的 typeId 复杂协商（VSCode 为对接扩展才需要）。
2. **不引入"插件激活点"** —— 所有 contributor 仍是 BlockStartup contribution 静态注册。"留 hook 点" = Registry 接口公开 + index.ts re-export，外部调即可。
3. **Glob 复用 `search/glob.ts`**；priority 数值建议 `builtin = 1, registered = 100, override = 1000`（高优胜出）+ 注册顺序破平。
4. **"Reopen With..." UX**：QuickPick 列匹配该 URI 的所有 typeId（含当前），用户选 → `closeEditor` + `openEditor`（用 `EditorGroupsService` 现有接口，无需新 API）。
5. **未来 Tree/Graph 编辑器扩展只需**：(a) `class TreeEditorInput extends EditorInput`；(b) 注册到 `EditorRegistry.registerEditorProvider`；(c) 注册到 `EditorResolverService` 把某 glob 绑过去。**无需改 platform**。

### 验收

- 单测新增 ~8：EditorResolverService 注册 / glob 匹配 / priority / factory 调用 / 未匹配回退 / 重复 typeId 报错 / disposable removal / reopenWith 路径
- E2E 新增：`smoke.editorResolver.spec.ts` @p1（通过 `__E2E__` 注册一个 dummy editor provider+resolver，打开 `.dummy` 文件断言走 dummy provider；reopenWith 切到 FileEditorInput）。需扩 `apps/editor/src/shared/e2e/contract.ts` 加 `registerDummyEditor()` 探针

### 工作量

**M（3–4 天）**

---
