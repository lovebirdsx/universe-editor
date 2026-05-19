## 阶段二：NotificationService（toast + 中心）

### 目标

补齐 toast 通知体系。Modal Dialog（`RendererDialogService`）留给"必须用户决策"，所有"信息/警告/错误/进度"走 Notification。`onUnexpectedError` 自动转发 Error toast（带 "View Logs" 操作）。

### 关键文件

**新建**：
- `packages/platform/src/notification/notificationService.ts` —— `INotificationService` / `Severity` / `INotification` / `INotificationHandle` / `IPromptChoice`（命名对齐 VSCode）
- `apps/editor/src/renderer/workbench/notification/NotificationService.ts` —— renderer 实现（per-window scope），observable 通知列表
- `apps/editor/src/renderer/workbench/notification/NotificationsToast.tsx` —— 右下角 toast 浮层（默认最多 5 条同时显示、其余进中心）
- `apps/editor/src/renderer/workbench/notification/NotificationsCenter.tsx` —— 中心面板（点击 StatusBar 铃铛展开）
- `apps/editor/src/renderer/workbench/notification/NotificationStatusContribution.ts` —— StatusBar 右下角铃铛 + 未读 badge
- `apps/editor/src/renderer/actions/notificationActions.ts` —— `workbench.action.notifications.toggleList` / `clearAll` / `focusNext`

**修改**：
- `apps/editor/src/renderer/workbench/Workbench.tsx` —— Portal 挂 `<NotificationsToast />`
- `packages/platform/src/index.ts` —— re-export `notification`
- `apps/editor/src/renderer/main.tsx` —— 注册 INotificationService（per-window）
- `apps/editor/src/renderer/contributions/index.ts` —— 注册 NotificationStatusContribution（`WorkbenchPhase.AfterRestore`，套路 D）
- 迁现有非阻塞 info 调用点（Explorer 文件操作成功提示等）从 `RendererDialogService` 到 Notification
- `packages/platform/src/base/errors.ts` —— `onUnexpectedError` 默认 handler 取 INotificationService（through DI accessor）显示 Error toast

### 设计要点

1. **Renderer-only，不跨进程**。Main 端没有主动通知用户的业务场景（FileWatcher / Workspace 已通过事件透传走 IPC）；future 若需 main 主动通知，加一个 NotificationChannel 转发到首个 focused 窗口即可。VSCode 也是这种结构。
2. **API 对齐 VSCode `INotificationService`**：`notify({ severity, message, actions, sticky })` + `prompt(severity, message, choices)` + `status(message, options)` + `notify(...).progress.report({ message, increment })`。让团队迁移有直觉。**不做** `NeverShowAgain` profile —— `IStorageService` 直接 key-value 即可。
3. **Toast 与中心共享同一队列**。Toast 自动消失后留在中心，IStorageService 持久化最近 50 条（debounce 500ms 写盘，clearAll 立刻清盘）。
4. **错误 toast 默认 sticky**：`onUnexpectedError` 转发的 severity=Error 不自动消失。
5. **Progress notification 走相同接口**，本阶段先实现 infinite spinner，determinate 留接口。FileSystemMainService 长任务通过将来的 ProgressChannel 回传。

### 验收

- 单测新增 ~14：NotificationService 8（add/dismiss/sticky/prompt resolve/cancel/progress lifecycle/MRU 持久化/severity ordering）、NotificationsToast 4、NotificationStatusContribution 2
- E2E 新增：`smoke.notification.spec.ts` @p0（命令面板触发"测试通知"，断言 toast 出现 → 3s 自动消失 → 铃铛 badge +1 → Clear All 归零）
- 性能：100 条堆叠 toast 不卡顿（实现里限同时最多 5 条）

### 工作量

**M（3–4 天）**

---
