---
name: acp-session-dormant-wake-abstraction
description: 空闲回收后的 session 唤醒统一抽象；三个反直觉陷阱=derived 会永久卡住、Event 当参数传、await 打挂 echo 抑制
metadata:
  type: project
---

# ACP session 空闲回收后的统一唤醒（isDormant / ensureAwake）

`acp.idleProcessTimeoutMs` 停掉 claude.exe / codex.exe 后，session 走**静默 seal**（`status='closed'` 但 phase 仍 `'connected'`、死 lease 仍绑着）。原先只有 `sendPrompt` 有按需重握手守卫，其余 11 个操作（重命名 / side chat / rewind / 切模型 / 列表点击打开 / MCP 勾选 / 兑换额度 / 进程重启 …）全在休眠态失效。收敛方案与两档唤醒策略详见 `apps/editor/src/renderer/services/acp/session/CLAUDE.md`（坑 #11 + 「空闲进程回收」节）。

这里只留三个**读代码看不出来、下次改必踩**的陷阱：

1. **`isDormant` 不能写成 `derived(status, phase)`**：`close()` 里 `status.set('closed')` 早于 `_connection.close()`，而 phase 不是 observable —— derived 在那一帧算出 `true` 后**没有任何东西能让它失效**，永久卡休眠。只能用显式 `ISettableObservable` + 齐全的置位点（改动时逐点核对，有专用用例守护）。
2. **`signal.addEventListener('abort', onClose)` 会把 `Event` 塞进 `onClose` 的首个参数**。该参数是 `deadOnArrival`（区分「启动失败」与「空闲回收」，因为 `open()` 已把 phase 翻到 `'connected'`，无法靠 phase 判别），于是**每一次真实回收都不再置休眠**。必须包一层 `() => onClose()`。同类签名扩展前先查所有监听注册点。
3. **给 `setConfigOption` 前置 `await ensureAwake()` 会打挂 echo 抑制**：状态机的「乐观本地应用 + 同 id echo 门」被推到微任务之后，同 tick 抵达的 `config_option_update` 会覆盖用户刚选的值。健康连接必须走**同步快路径**（`_wakeIfDormant()` 后若 `!_reconnecting` 直接委托状态机，不 await）。反过来，该方法新增的 throw 必须在 `ConfigOptionsBar.pickValue` 里 catch + notify，否则 `void pickValue(...)` 变成静默回滚。

相关：[[empty-session-rebuild-on-restart]]（唤醒复用的正是它的 `_reconnectSession` 通道，空会话走 `session/new`）、[[async-session-create]]（双 id：本地 uuid ≠ durableId 是「列表点击打开变双实例」的根因）
