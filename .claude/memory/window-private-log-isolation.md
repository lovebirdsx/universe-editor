---
name: window-private-log-isolation
description: 窗口私有日志隔离——renderer/acp 日志按 BrowserWindow.id 分流到 window-<id>/ 子目录，main 进程日志仍共享
metadata: 
  node_type: memory
  type: project
  originSessionId: 1d135e9f-28d2-4afa-8c41-c2d1f4dd2b4d
---

多窗口下 renderer 日志曾广播到所有窗口的 Output（含错误自动 reveal 串窗）。采用 VSCode "按来源进程隔离" 范式做物理文件级分流。

**核心设计**：进程边界 = 隔离边界。
- main 进程日志（`createLogger`，无 windowId）→ 写 session 根目录，所有窗口共享。
- renderer 日志（经 `MainLogChannelService`，用权威 `BrowserWindow.id`）→ 写 `<sessionId>/window-<id>/<channel>.log`，窗口私有。
- `LogMainService.onDidAppendEntry` 事件带可选 `windowId`；`LogFilesMainService` 改为**每窗口实例**，用 `Event.filter`（windowId===undefined || ===自身）过滤，并合并两目录列表。channelId 冲突（如 console）时共享行 name 加 ` (Main)` 后缀。
- `logFiles` 从 `ApplicationServices` 移到 `WindowScopedServices`，在 `windowMainService.createWindow` 里 `new LogFilesMainService(logService, win.id)` + `new MainLogChannelService(logService, win.id)`。
- renderer 端 windowId 已彻底移除（main 用权威 win.id）：`ILogChannelService.append/appendBatch` 去掉首个 windowId 参数，`RendererLoggerService`/`main.tsx` 同步删除。

**Why**：window B 的错误不再污染 window A 的 Output / 触发 A 的 panel 自动 reveal。
**How to apply**：renderer 侧 contributions（AggregatedLogChannel/LogTail/ErrorLogAutoReveal）无需改动——它们消费的是已在 main 侧预过滤的 per-window logFiles。E2E 覆盖见 `e2e/specs/smoke.logIsolation.spec.ts`。

相关：[[scm-submodule-multirepo]]（同样的 per-window/per-root 路由思路）。
