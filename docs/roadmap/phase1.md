## 阶段一：横切基础设施（多窗口 + Logger + 错误处理）

### 目标

打掉「单窗口假设、错误静默吞掉、日志无统一去处」三个跨阶段地基洞。Notification / ErrorBoundary / Settings UX 都建在它之上。

### 关键文件

**新建**：
- `packages/platform/src/log/loggerService.ts` —— `ILoggerService` 多通道 logger 工厂
- `packages/platform/src/base/errors.ts` —— `onUnexpectedError(e)` / `setUnexpectedErrorHandler` / `ErrorNoTelemetry`（对齐 VSCode 同名）
- `apps/editor/src/main/services/window/windowMainService.ts` —— `IWindowMainService`：BrowserWindow 集合管理、createWindow / disposeWindow / focusWindow / getWindowById
- `apps/editor/src/main/window/scopedServicesFactory.ts` —— 把 `getSharedServices()` 拆成两层：application-singleton（IStorageService / IUserDataFilesService / IWorkspaceService / IFileService / IFileWatcherService / IPingService）+ per-window 工厂（IHostService 已是、新增 ILogChannelService）
- `apps/editor/src/main/services/log/logMainService.ts` —— `ILoggerService` 主进程实现；按天 + 总 10MB 上限做 rotation；写 `<userData>/logs/<date>/{main,renderer-<windowId>,editor}.log`
- `apps/editor/src/main/errors.ts` —— `process.on('uncaughtException' | 'unhandledRejection')` → ILoggerService
- `apps/editor/src/renderer/errors.ts` —— `window.onerror` / `onunhandledrejection` → `onUnexpectedError`
- `apps/editor/src/renderer/workbench/errors/WorkbenchErrorBoundary.tsx` —— 顶层 ErrorBoundary（fallback UI + reload 按钮 + 写 ILogger）
- `apps/editor/src/shared/ipc/services.ts` 扩 `ILogChannelService`（renderer logs 走 IPC 汇总到 main 写盘）
- `apps/editor/src/renderer/actions/windowActions.ts` 扩 `workbench.action.newWindow`、`workbench.action.closeWindow`

**修改**：
- `apps/editor/src/main/index.ts:42-61` —— 用 `IWindowMainService` + `scopedServicesFactory` 重写 `createWindow` 与 `getSharedServices`；移除全局变量 `sharedUserData`，归 will-quit 时 `IWindowMainService.dispose()`
- `apps/editor/src/main/ipc/registerMainServices.ts` —— `SharedMainServices` 类型拆成 `ApplicationServices` + `WindowScopedServices`
- `apps/editor/src/shared/ipc/channelNames.ts` —— 新增 `Log: 'log'`、`Window: 'window'`
- `packages/platform/src/index.ts` —— re-export `errors`、`loggerService`（**必须，否则 apps 编译报错**）
- `apps/editor/src/renderer/main.tsx` —— bootstrap 装错误捕获 → 装 IWindowService renderer 代理 → ErrorBoundary 包 `<Workbench />`

### 设计要点

1. **多窗口架构 = per-window scope + application-singleton 两层（对齐 VSCode）**。**真单例**（共享盘上同一 state.json 必须单例，多窗口并发写会冲突）：`IStorageService` / `IUserDataFilesService` / `IWorkspaceService` / `IFileService` / `IFileWatcherService` / `IPingService`。**per-window**：`IHostService`（已是）/ `ILayoutService` / `IViewsService` / `IEditorGroupsService` / `INotificationService` 等"状态属于这个窗口"的服务。Renderer 端无需改动 —— 每个窗口的 renderer 各持自己的 ServiceCollection。
2. **跨窗口同步**：走 application-singleton + main 端 broadcast 事件（workspace 变更时所有 RendererWorkspaceService 都收到）。WorkspaceService 已是单例 + 事件桥接，无需变更。
3. **ErrorBoundary 边界粒度 = workbench 单层兜底**。Pane / View 不加 ErrorBoundary（防 StrictMode 双 render 难定位；防局部边界让 SideBar 变 "异常自瘫" 状态）。VSCode 也是 workbench 单层。EditorPane 崩溃由 EditorGroupView 主动 close + Notification 提示。
4. **Logger 走 IPC 而非各 renderer 独立写文件**：避免多窗口竞争同一日志文件。Renderer ILogger 通过 LogChannel 把 `{channel, level, message, args, ts, windowId}` 发给 main，main 端聚合写入。
5. **不要做 ELK / 远程上报机制**（用户明确"不做插件、不做领域"）；日志只是落盘 + OutputService 显示，外接 sink 留接口（阶段六 Telemetry 复用同一思路）。

### 验收

- 单测新增 ~15：`WindowMainService` 3、`LoggerService` 5（多 channel/级别过滤/rotation/append/flush）、`onUnexpectedError` 2、`WorkbenchErrorBoundary` 2、`scopedServicesFactory` 3
- E2E 新增：`apps/editor/e2e/specs/smoke.multiWindow.spec.ts` @p1（执行 `workbench.action.newWindow`，断言 2 个 BrowserWindow，layout 独立、workspace 共享）；`smoke.errorBoundary.spec.ts` @p1（通过 `__E2E__` 触发抛错命令，断言 fallback UI 出现且日志中能找到）
- E2E 探针扩展：`apps/editor/src/shared/e2e/contract.ts` 加 `listWindows()`、`triggerError()`

### 工作量

**L（1.5–2 周）**。可拆 2 PR：(a) logger + error 处理（M, 3–4 天）→ (b) 多窗口 + scopedServicesFactory（M+, 5–7 天）。
