# 多窗口退出：运行中会话确认的路由与等待

File → Exit（以及 macOS `Cmd+Q`、扩展调用 `app.quit()`）是**应用级**退出，而运行中会话的确认框由各窗口的 renderer 内的 `SessionShutdownParticipant` 弹出。本文记录确认框如何落在**发起退出的窗口**、多个窗口如何只弹一次，以及确认框展示后主进程为什么不能按「renderer 无响应」超时放行。

## 链路

```
renderer: workbench.action.quit
  → IWindowsService.quit()
  → main: WindowMainService.prepareQuit(windowId)   记录发起者
  → app.quit()
  → before-quit: confirmQuitFromPendingRequest()
  → confirmQuit(requestingWindowId)
  → 发起窗口 _canProceed(Quit, { runningSessions })
  → 其它窗口 _canProceed(Quit, { skipRunningSessionPrompt: true })
  → markQuitConfirmed()
  → before-quit 第二轮：captureSessionForQuit / storage.flush / extensionHost.stopAll
  → app.quit()
```

### 为什么不在 `MainWindowsService.quit()` 里直接 `confirmQuit`

`quit()` 是窗口级 adapter，它只拿到自己的 `_windowId`，看似可以直接 `await confirmQuit(windowId)` 再 `app.quit()`。**不能**：

- `confirmQuit` 成功会调 `markQuitConfirmed()`，此后 `before-quit` 走早退分支，只执行 `captureSessionForQuit()` 就放行。
- 真正的持久化与清理在 `before-quit` 的首次确认分支里，且必须 **await**：`captureSessionForQuit()`（窗口会话快照）→ `storage.flush()`（写盘）→ `extensionHost.stopAll()`（排空 host 的 stdin-EOF 级联，避免孤儿 tsserver）。`will-quit` 是同步的，只能硬杀。
- 在 adapter 里提前确认等于绕过这些 await 清理，退出会丢窗口会话或残留进程。

因此 adapter 只**记录发起者**，确认与清理仍由 `before-quit` 单点驱动。

### 无明确发起者

macOS `Cmd+Q`、扩展/系统触发的 `app.quit()` 不会经过 `IWindowsService.quit()`，`_pendingQuitRequesterId` 为空。此时 `_resolveQuitRequester` 依次回退：

1. 显式传入且仍存活的窗口 id；
2. `getFocusedWindowId()`（焦点窗口，辅助窗口会映射回其 owner）；
3. 第一个存活窗口；
4. 一个窗口都没有 → `markQuitConfirmed()` 直接放行。

## 会话分组

`sessionSwitcherMainService.ts` 的纯函数 `summarizeRunningSessionsForPrompt(sessions, promptWindowId)` 把 `getAllSessions()` 的结果按弹框所在窗口分组：

- 运行中口径与切换器一致：`status === 'running' || status === 'background'`（`background` = turn 已 settle，但 `run_in_background` 任务仍在跑；退出会杀掉 agent 进程，这些任务同样会中断）。
- 发起窗口自己的计数进 `promptWindowCount`；其它窗口按 `windowId` 聚合为 `{ workspaceName, count }`，按工作区名稳定排序。
- renderer 侧仍做本地兜底：`promptWindowCount = max(aggregate.promptWindowCount, 本地统计)`。`getAllSessions()` 对每个窗口有 1.5 秒超时，超时窗口会少报，本地计数保证「本窗口有会话」不会被漏掉。

`skipRunningSessionPrompt` 只跳过**运行中会话**这一条 veto；其它 `onBeforeShutdown` 参与者（如未来的未保存文件）仍在各窗口各自生效，`onWillShutdown` 的 join 也不受影响。这样其它窗口不会重复弹会话确认，但不会因此跳过自己的关窗保护。

单窗口关闭（`ShutdownReason.CloseWindow`）、重启、切换工作区不经过 `confirmQuit`，仍是各窗口本地判断，不跨窗口聚合。

## 单飞与关闭闸门

同一个 `_quitConfirmation` Promise 被 `Exit`、`Cmd+Q`、更新安装（`quitAndInstall` 经 `setQuitConfirmer`）共享：

- `confirmQuit` 已有 in-flight 时直接返回同一个 Promise；`before-quit` 里先查 `isQuitConfirmationPending()`，第二次 quit 事件不再起第二条链。
- 确认期间窗口的 `close` handler 直接 `preventDefault()`：窗口集合是这次确认快照的输入，中途关窗会改变快照或触发第二次独立确认。
- `confirmQuit` 被直接调用（更新安装）时会清掉 `_pendingQuitRequesterId`，避免残留的 Exit 发起者泄漏到之后的 `before-quit`。

## 两阶段超时（`promptAckId`）

`_canProceed` 对 renderer 的 `confirmShutdown` 不是简单 `Promise.race` 一个固定超时：

1. 主进程生成 `promptAckId`，随 context 下发，并挂 `CONFIRM_SHUTDOWN_TIMEOUT_MS = 10s`。语义是「renderer 收到请求，但连确认框都没展示」的卡死兜底——到点按原行为放行（`resolve(true)`）。
2. renderer 真正展示弹框前调用 `IWindowsService.reportShutdownPromptShown(promptAckId)`；主进程校验 `promptAckId` 与 `windowId` 都匹配后，清掉 10 秒计时，改挂 `SHUTDOWN_PROMPT_DECISION_TIMEOUT_MS = 5min`。
3. `finally` 清两个计时器并删除回调表项；迟到的回执因表项已删而被忽略。

这修复了此前「10 秒超时覆盖了用户阅读/思考时间」的问题：弹框还开着，退出却已经放行。5 分钟只是无人值守的兜底，不是常规路径。

无会话、`skipRunningSessionPrompt`、E2E 三种情况 renderer 立即返回，不发自回执，也不会触发计时器。E2E 下弹框会挂住 `app.close()` 直到 SIGKILL 并遗留子进程，所以 `SessionShutdownParticipant` 在探针启用时跳过弹框与回执。

## 发起窗口中途销毁

确认过程中发起窗口被关闭（例如其它路径销毁了它）：

- 仍有其它存活窗口 → `_confirmQuit` 返回 `false`，不替已消失的窗口提交退出决定；
- 已无存活窗口 → `markQuitConfirmed()` 并返回 `true`，完成这次退出。

## 相关实现与测试

- `packages/platform/src/lifecycle/lifecycleService.ts` — `RunningSessionsShutdownInfo` / `promptAckId` 契约；`lifecycleService.test.ts` 覆盖 context 透传。
- `packages/platform/src/window/windowsService.ts` — `IWindowsService.reportShutdownPromptShown`。
- `apps/editor/src/main/services/window/windowMainService.ts` — 发起者解析、单飞、关闭闸门、两阶段超时。
- `apps/editor/src/main/services/sessionSwitcher/sessionSwitcherMainService.ts` — `summarizeRunningSessionsForPrompt`。
- `apps/editor/src/renderer/contributions/SessionShutdownParticipant.ts` — 三种文案变体、详情列表、主按钮按动作命名、回执。
- 测试：`windowMainService.test.ts`（requester 路由、单飞、闸门、ack 后等待、发起窗口销毁）、`sessionSwitcherMainService.test.ts`（分组纯函数）、`SessionShutdownParticipant.test.ts`（文案/回执/skip/E2E）。
- E2E：`apps/editor/e2e/specs/smoke.windows.spec.ts` 的 `Exit closes every window` 从第二个窗口发起退出。
