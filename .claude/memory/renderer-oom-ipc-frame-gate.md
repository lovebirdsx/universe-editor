---
name: renderer-oom-ipc-frame-gate
description: renderer OOM 治理（IPC 帧闸门 / 堆水位 / EPIPE / 崩溃对话框超时）；含 Electron send 不抛、闩锁须有截止时间、dispose 摘 stdin error 监听=还回崩溃等非显然教训
metadata:
  type: project
---

线上 renderer OOM 崩溃诊断包（2026-09-11）落地的一整套机制：minidump 显示 `lo_space` 3807MB、`old_space` 123MB、GC 回收 0.0MB，崩在 `JSON.parse ← defaultCodec.decode` 的入站 `ue:ipc` 帧——即 renderer 长期持有巨型字符串。机制/阈值/releaser 表全在 `docs/development/memory-pressure.md`（常驻知识放文档，此处只留教训）。

跨会话教训：

1. **Electron 43 的 `webFrameMain.send` 不抛**——内部 catch 后 `console.error("Error sending from webFrameMain")`，所以那圈 `try/catch` 是死代码；判活只能 send 前主动探 `isCrashed()` / `mainFrame.isDestroyed()` / `detached`。
2. **那行失败文本不指名是哪个窗口**，`markRendererFramesUnreachable()` 只能全关——**闩锁必须带截止时间**，否则多窗口下健康窗口也会静默失聪（推送丢弃且不重放，只有它自己发消息才清）。有界的代价是真死的窗口每 30s 一次探测 send。
3. **Node：无监听者的 `'error'` 事件 = `uncaughtException`。** 于是 `dispose()` 时摘掉 `stdin.on('error')` 等于把刚补上的崩溃路径还回去；正确做法是留着并让它静音。且 `write` 的 callback **不是**可靠错误通道（可能只发流事件）——promise 要同时挂流错误，否则调用方永久挂起。
4. **窗口模态对话框无人应答 → `.then()` 永不 resolve**，reload 写在里面就是 15 分钟黑屏。退避逻辑必须**同时覆盖 `.catch()` 分支**，否则对话框 reject 会绕过退避变成无限重载循环。
5. **度量与释放必须是同一套遍历**：新桶（`_orphanChildren`）纳入 measure 就必须纳入 release + trim 循环 guard 上界同步放大；tally 与 `_measureResidentBytes()` 的等式要直接断言，别只断言 tally 本身。
6. **"最大帧"标量必须统计全部帧**：只在越线分支里更新会报 `largest=0`，读报告的人会得出与事实相反的结论。
7. **日志折叠的键要稳定**：用整行文本做键时，只要行内有可变尾部（帧 id / 路径）就一条都折不掉，而 `folded` 恒为 0 看起来像"没有洪流"。

相关：[[largefile-reveal-dirtydiff-vscode-parity]]（大对象/IPC 分片）、[[renderer-oom-triple-fix-live-budget-replay-cap-orphan]]（上一次 renderer OOM 的三修）、[[sessionchanges-unbounded-growth-main-oom-abort]]（main 侧同族预算）
