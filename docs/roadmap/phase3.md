## 阶段三：Settings UX（User / Workspace 切换）

### 目标

让用户在 SettingsEditor 看到/编辑 Workspace 层（`<workspace>/.universe-editor/settings.json`）的覆盖值。**后端 Project 层早已就绪**（`packages/platform/src/userdata/userDataFilesService.ts:18-19` 的 `UserDataFile.ProjectSettings`、`ConfigurationTarget.Project` 已实现、`UserSettingsSync` 已监听），本阶段只动 UI + 加一个小的 layer 查询 hook。

### 关键文件

**修改**：
- `apps/editor/src/renderer/workbench/preferences/SettingsEditor.tsx` —— 顶部加 "User | Workspace" tab；每行右下加 "User: 默认" 小角标显示当前值来源层；写入按所选 tab 调 `config.update(key, value, ConfigurationTarget.Project | User)`
- `apps/editor/src/renderer/workbench/preferences/SettingsEditorInput.ts` —— URL fragment 携带 `target=user|workspace`，恢复时还原
- `apps/editor/src/renderer/workbench/configuration/UserSettingsSync.ts` —— `_syncUserLayerToFile()` 抽成参数化 `_syncLayerToFile(target, file)`，对称镜像 Project 层（注意 `UserDataMainService` 端的 SELF_WRITE_SUPPRESS_MS 已经避免回环）
- `packages/platform/src/configuration/configurationService.ts` —— `IConfigurationService` 加 `getValueOrigin(key): ConfigurationTarget | undefined`（遍历 layers 找首个 `hasOwnProperty(key)` 的层）
- `apps/editor/src/renderer/actions/preferencesActions.ts` —— `workbench.action.openWorkspaceSettings` / `openSettings` / `openSettingsJson` / `openWorkspaceSettingsJson`

**新建**：
- `apps/editor/src/renderer/workbench/preferences/__tests__/SettingsEditor.targetSwitch.test.tsx`

### 设计要点

1. **不引入新"settings target"抽象** —— 直接复用 `ConfigurationTarget.User / Project`。"Edit in settings.json" 按钮直接 `editorService.openEditor(new FileEditorInput(uri))`，uri 来自 `userDataFilesService.getFileUri(UserDataFile.ProjectSettings)`。
2. **No workspace open 时 Workspace tab 灰掉**。监听 `IWorkspaceService.onDidChangeWorkspace` 切换 disable 状态；切到 Workspace tab 但 workspace 关闭时给 Notification 提示（**依赖阶段二**）。
3. **配置值来源指示**：每行调 `getValueOrigin(key)`，按层显示。
4. **`UserSettingsSync` 双向镜像 Project 层与 User 层完全对称** —— 单一抽象，参数化。
5. **不引入 multi-root**（用户明确"不做领域模型"）。

### 验收

- 单测新增 ~12：SettingsEditor 切换 tab / origin 显示 / disable 行为 5、`getValueOrigin` 4、UserSettingsSync project sync 3
- E2E 新增：`smoke.workspaceSettings.spec.ts` @p1（打开 workspace → settings editor 写 workspace 级值 → 断言 `.universe-editor/settings.json` 出现 → 关 workspace → 生效值回退到 User 层）

### 工作量

**S（2 天）**

---
