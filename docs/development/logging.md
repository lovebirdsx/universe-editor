# 日志：窗口私有隔离

多窗口下 renderer 日志曾广播到所有窗口的 Output（含错误自动 reveal 串窗）。修法是 VSCode「按来源进程隔离」范式的**物理文件级**分流，判据一句话：**进程边界 = 隔离边界**。

## 目录形态

`<userData>/logs/<sessionId>/`（`<sessionId>` = `YYYYMMDDTHHmmss`，`apps/editor/src/main/services/log/logMainService.ts` 的 `SESSION_DIR_RE`）：

- `<channel>.log` —— main 进程日志（`createLogger`，无 windowId），写 session 根目录，**全窗口共享**。
- `window-<id>/<channel>.log` —— 该窗口的 renderer 与 acp 日志，**窗口私有**；`<id>` 是 main 手里权威的 `BrowserWindow.id`。
- `errors.jsonl` —— 结构化错误收集，见 [错误收集与诊断机制](error-diagnostics.md)。

renderer 日志经 `MainLogChannelService` 落进 window 目录：标 `[renderer:<id>]` 前缀与路由**都用 main 权威的 id**，renderer 传来的值不参与，所以两者都无法伪造（`apps/editor/src/main/services/log/mainLogChannelService.ts` 头注释）。

## 分流是怎么接的

- `LogMainService.onDidAppendEntry` 的事件带可选 `windowId`；`LogFilesMainService` 是**每窗口一个实例**，用 `Event.filter` 只放行「无 windowId（main）或等于自身」的条目，列表侧则合并 session 根目录与自己的 `window-<id>/` 两个目录（`apps/editor/src/main/services/log/logFilesMainService.ts`）。
- channelId 在两个目录都存在时（如 `console` 被 main 与 renderer 同时写）会撞 `name`——而 renderer 的 Output 下拉按 `name` 去重，撞名会吃掉一行。共享那份加 ` (Main)` 后缀，两行都留。
- `logFiles` 从 `ApplicationServices` 移入 `WindowScopedServices`（`apps/editor/src/main/window/scopedServicesFactory.ts`），与 `MainLogChannelService` 一并在 `apps/editor/src/main/services/window/windowScopeFactory.ts` 用 `win.id` 构造。
- **renderer 侧没有 windowId 这个概念**：`ILogChannelService.append/appendBatch` 不带该参数（`apps/editor/src/shared/ipc/services.ts` 注释：源窗口由 main 权威持有、绝不走 wire），`RendererLoggerService` / `main.tsx` 的对应参数已删。新加日志通道时别把它加回来。

## 为什么 / 谁在消费

物理分流之后，window B 的错误不再污染 window A 的 Output，也不会触发 A 的错误面板自动 reveal。renderer 侧 contributions（`AggregatedLogChannelContribution` / `LogTailContribution` / `ErrorLogAutoRevealContribution`）**无需改动**——它们消费的 `logFiles` 已是 main 按窗口预过滤过的结果。

同一套目录形态被诊断链路复用：诊断包与 bug recording 按 session 目录收日志尾部，`window-<id>/` 子目录自动被一起带上（见 [Bug 录制（bug recording）](bug-recording.md)）。

## 验证

回归 e2e：`apps/editor/e2e/specs/smoke.logIsolation.spec.ts`。
