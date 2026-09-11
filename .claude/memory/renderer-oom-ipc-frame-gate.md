---
name: renderer-oom-ipc-frame-gate
description: renderer OOM 治理（IPC 帧闸门 / 堆水位 / EPIPE / 崩溃对话框超时 / 观测链路补强）；含 Electron send 不抛、闩锁须有截止时间、fire-and-forget 观测须有 e2e 哨兵、成功路径不记录=报告自相矛盾等非显然教训
metadata:
  type: project
---

线上 renderer OOM 崩溃诊断包（2026-09-11）落地的一整套机制：minidump 显示 `lo_space` 3807MB、`old_space` 123MB、GC 回收 0.0MB，崩在 `JSON.parse ← defaultCodec.decode` 的入站 `ue:ipc` 帧——即 renderer 长期持有巨型字符串。机制/阈值/releaser 表全在 `docs/development/memory-pressure.md`（常驻知识放文档，此处只留教训）。

跨会话教训：

**崩溃链路（第一次修复）**

1. **Electron 43 的 `webFrameMain.send` 不抛**——内部 catch 后 `console.error("Error sending from webFrameMain")`，所以那圈 `try/catch` 是死代码；判活只能 send 前主动探 `isCrashed()` / `mainFrame.isDestroyed()` / `detached`。
2. **那行失败文本不指名是哪个窗口**，`markRendererFramesUnreachable()` 只能全关——**闩锁必须带截止时间**，否则多窗口下健康窗口也会静默失聪（推送丢弃且不重放，只有它自己发消息才清）。有界的代价是真死的窗口每 30s 一次探测 send。
3. **Node：无监听者的 `'error'` 事件 = `uncaughtException`。** 于是 `dispose()` 时摘掉 `stdin.on('error')` 等于把刚补上的崩溃路径还回去；正确做法是留着并让它静音。且 `write` 的 callback **不是**可靠错误通道（可能只发流事件）——promise 要同时挂流错误，否则调用方永久挂起。
4. **窗口模态对话框无人应答 → `.then()` 永不 resolve**，reload 写在里面就是 15 分钟黑屏。退避逻辑必须**同时覆盖 `.catch()` 分支**，否则对话框 reject 会绕过退避变成无限重载循环。
5. **度量与释放必须是同一套遍历**：新桶（`_orphanChildren`）纳入 measure 就必须纳入 release + trim 循环 guard 上界同步放大；tally 与 `_measureResidentBytes()` 的等式要直接断言，别只断言 tally 本身。
6. **"最大帧"标量必须统计全部帧**：只在越线分支里更新会报 `largest=0`，读报告的人会得出与事实相反的结论。
7. **日志折叠的键要稳定**：用整行文本做键时，只要行内有可变尾部（帧 id / 路径）就一条都折不掉，而 `folded` 恒为 0 看起来像"没有洪流"。

**观测链路（第二次补强，诊断能力本身要能自证）**

8. **只记录失败路径 = 报告自相矛盾**：`ipc-frames.txt` 曾写 `warned>=32MiB=0`，而 renderer 的 `ipc.log` 同时记着 47.6MB 入站帧——因为 main 只在 encode 被拒时才记，成功发出的大帧从不记。**"没有大帧"与"没记录大帧"必须可区分**，成功路径也要记（成本=一次整数比较，不得扩成每帧记录）。
9. **`response` 帧在 wire 上没有 `channel` 字段**，`frameChannel`/`frameName` 对它恒为空，所以最关键的告警只印了个字节数。解法不是改协议，而是**由发起方回填**：`_pendingRequests` 本就每请求存一条，多存两个字符串 + 一次 Map 查找（零分配）就让告警变成 `(response fileService.readFile #42)`。
10. **fire-and-forget 的观测链路必须有一条端到端 e2e 哨兵**。方法名写错、服务没注册、`services.get` 返回 `undefined`（**它是返回 undefined 而不是抛**）三种情况都表现为"属性访问 on undefined"，被 `.catch(()=>{})` 吞掉后，产出的诊断包与"这个构建本来就没这功能"**完全同形**——单测 mock 掉了通道，永远发现不了。哨兵要 poll 真实文件（FileLogger 有 150ms 防抖 flush）。
11. **"看不见"与"被拒绝"必须可区分**：上报样本被清洗丢弃时不计数，报告里"从没有曲线"与"每条都被拒"是同一份文件，而这是两个相反的结论。丢弃要计数（`dropped=N`），不要为每条丢弃写日志（坏发送方会每 30s 复现一次）。
12. **清洗跨进程输入时，数组字段本身也要 `Array.isArray` 判**：`for…of undefined` 同步抛 → 跨 IPC 变成 rejected promise → 被吞，连一行日志都不留。这类"防御函数自己漏了最外层类型"的洞，只在真收到 `{used,limit,level}` 无 `holders` 的偏斜负载时才炸。
13. **节流的时间戳要在调用回调之前盖**：`_reportedAt = at` 若写在 `report()` 之后，一个抛错的上报器会永久卡住节流，曲线此后彻底静音。

相关：[[largefile-reveal-dirtydiff-vscode-parity]]（大对象/IPC 分片）、[[renderer-oom-triple-fix-live-budget-replay-cap-orphan]]（上一次 renderer OOM 的三修）、[[sessionchanges-unbounded-growth-main-oom-abort]]（main 侧同族预算）
