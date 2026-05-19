# Universe Editor 下一阶段开发计划：稳健化 + 工程质量

## Context

当前 `D:\git_project\universe-editor2` 已搭建出非常完整的 VSCode 范式骨架：platform 内核覆盖 DI / Event / Observable / Command / ContextKey / Menu / Keybinding / Configuration / Lifecycle / IPC / FileService / WorkspaceService / Storage / UserData / EditorInput / EditorGroupModel / ViewRegistry / StatusBar / QuickInput / Output / Search / Logger / nls；editor 应用已有 30+ Action2、11 contributions、7 跨进程服务、EditorGroup 多分屏 / 序列化恢复 / 外部变更监听 / 热退出，单元测试 ~115、E2E 10 个 spec。

但仍存在制约长期稳健性的 7 类基础设施缺口：(1) `getSharedServices()` 硬编码单例，多窗口要重构；(2) 主进程 `process.on('uncaughtException')` 未挂、Renderer 无 ErrorBoundary、IPC 失败无统一日志；(3) Logger 接口存在但无多 channel/落盘/IPC 聚合；(4) 只有 modal Dialog，无 toast Notification；(5) `UserDataFile.ProjectSettings` 后端已就绪但 SettingsEditor UI 无 User/Workspace 切换；(6) `EditorRegistry` 是 hook 点但无"URI → typeId"resolver 和 "Reopen With…" UX；(7) 无 Floating UI / 虚拟滚动 / 统一 DnD / Telemetry hook / 集成测试 / 性能基准 / Renderer→Main HMR / 视觉回归。

用户已确认方向：**稳健化 + 工程质量优先；不做插件；不做领域模型；多窗口现在就做；接受第三方 UI 依赖**。本计划按"基础设施优先"组织 7 个阶段，前序阶段是后序阶段的依赖地基。

---

## 路线图总览

| #   | 阶段                                                      | 工作量         | 依赖 | 最关键交付                                                                               |
| --- | --------------------------------------------------------- | -------------- | ---- | ---------------------------------------------------------------------------------------- |
| 1   | 横切基础设施：多窗口 + Logger + 错误处理                  | **L** (1.5–2w) | —    | `IWindowMainService` / `ILoggerService` / `onUnexpectedError` / `WorkbenchErrorBoundary` |
| 2   | NotificationService（toast + 中心 + 进度）                | **M** (3–4d)   | 1    | `INotificationService` / `NotificationsToast` / 铃铛 badge                               |
| 3   | Settings UX：User/Workspace 切换                          | **S** (2d)     | 2    | SettingsEditor 双 tab + `getValueOrigin`                                                 |
| 4   | EditorResolverService（URI → typeId 解析）                | **M** (3–4d)   | —    | `IEditorResolverService` / `workbench.action.reopenWith`                                 |
| 5   | UI 基础设施：ContextView / Hover / VirtualList / DnD      | **L** (1.5w)   | —    | 新包 `@universe-editor/workbench-ui`                                                     |
| 6   | Telemetry hook（noop sink，留接口）                       | **S** (1.5d)   | 1    | `ITelemetryService` / `NoopTelemetryService` / 5 个埋点                                  |
| 7   | 工程质量：集成测试 + bench + 主进程 HMR + visual baseline | **L** (2w)     | 1–6  | `apps/editor/integration/` / `apps/editor/bench/` / visual baseline                      |

**总工作量**：单人 7–9 周；双线并行（1 完成后 2/4/5 并行 → 3/6 → 7）约 5–6 周。

---

## 跨阶段约束（监督执行）

所有阶段必须遵守：
1. **修改 platform 后必须在 `packages/platform/src/index.ts` re-export**（强约束，apps 看 dist/，少 export 编译报错）
2. **新 IPC 通道经 `apps/editor/src/shared/ipc/channelNames.ts`**
3. **跨进程服务必须 ProxyChannel.fromService / toService**
4. **TS strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes 不能放宽**
5. **ESM only，相对导入带 `.js` 后缀**（即使源是 `.ts`）
6. **测试位置 `src/**/__tests__/`**；integration 例外（在 `apps/editor/integration/`）
7. **新依赖统一放 `pnpm-workspace.yaml` catalog**；包内写 `"catalog:"`
8. **"留 hook 点" = Registry 接口公开 + index.ts re-export**，不实现外部加载机制（不做插件）

每个阶段完成时跑 `pnpm check:full`（lint + typecheck + test + build），通过后再合并。

---

## 验证方法（端到端）

每个阶段交付后按下列流程验证：

1. **静态检查**：`pnpm check:full` 通过（lint + typecheck + test + build 全绿）
2. **本地交互验证**：
   - `pnpm --filter @universe-editor/editor dev` 启动应用
   - 阶段一：开新窗口（`Ctrl+Shift+N` 或新加 action）、断言 2 个窗口 layout 独立；触发 main 端错误（开发者 console 抛 `throw new Error('test')`）→ 检查日志落盘到 `<userData>/logs/<date>/main.log`；renderer 抛错 → ErrorBoundary fallback 出现
   - 阶段二：命令面板触发"通知测试"命令 → toast 出现 → 3s 消失 → 中心可见 → Clear All 归零
   - 阶段三：开 workspace → settings editor 切 Workspace tab → 改值 → 检查 `.universe-editor/settings.json` 出现且生效 → 关 workspace → 值回退
   - 阶段四：扩 `__E2E__` 注册 dummy editor → 打开 `.dummy` 文件走 dummy editor；右键 tab "Reopen With..." 切回 FileEditor
   - 阶段五：Explorer 拖文件验证；10k 节点目录滚动流畅；右键菜单显示通过 MenuRegistry 动态注入的项
   - 阶段六：开发者 console 监听 INotificationService → 执行命令 → 看到 telemetry 调用 (mock sink)
   - 阶段七：`pnpm test:integration` 全绿；`pnpm bench` 输出基准；`pnpm dev` 改 main service → 验证 < 2s 恢复；`pnpm test:visual` 生成 diff
3. **E2E 验证**：每阶段对应的 smoke spec `pnpm --filter @universe-editor/editor e2e` 通过；CI 双平台（ubuntu + windows）双过
4. **性能验证**：bench 数字与上一阶段对比，无显著退化（>20% 退化阻断合并）

---

## Critical Files (按修改频率排序)

需重点 review 的现有文件：
- `apps/editor/src/main/index.ts` —— 阶段一全量重构
- `apps/editor/src/main/ipc/registerMainServices.ts` —— 阶段一拆 ApplicationServices / WindowScopedServices
- `apps/editor/src/renderer/main.tsx` —— 阶段一 / 二 / 六 bootstrap 链路扩
- `packages/platform/src/index.ts` —— 每阶段都要 re-export 新模块
- `apps/editor/src/shared/ipc/channelNames.ts` —— 阶段一 / 二（如 NotificationChannel 真要做）
- `apps/editor/src/renderer/workbench/Workbench.tsx` —— 阶段一加 ErrorBoundary、阶段二挂 NotificationsToast Portal
- `apps/editor/src/renderer/contributions/index.ts` —— 阶段二 / 四注册新 contribution
- `apps/editor/src/renderer/workbench/preferences/SettingsEditor.tsx` —— 阶段三 UI 重构
- `apps/editor/src/renderer/workbench/explorer/ExplorerView.tsx` —— 阶段四 / 五调用点迁移
- `apps/editor/src/shared/e2e/contract.ts` —— 阶段一 / 四扩探针 API
- `pnpm-workspace.yaml` —— 阶段五加 catalog 依赖
- `.github/workflows/ci.yml` —— 阶段一 / 七加 job

新建里程碑文件（review 时核对存在性）：
- `packages/platform/src/log/loggerService.ts`、`base/errors.ts`、`notification/notificationService.ts`、`telemetry/telemetryService.ts`、`workbench/editorResolverService.ts`
- `packages/workbench-ui/` 全量
- `apps/editor/src/main/services/window/windowMainService.ts`、`services/log/logMainService.ts`、`window/scopedServicesFactory.ts`
- `apps/editor/integration/`、`apps/editor/bench/` 全量
