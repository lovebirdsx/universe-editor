---
name: codex-replay-oom-source-cap
description: 0.13.1 codex 会话 renderer OOM(切 tab 20s 冲 4.4GB)：codex fork 回放无源头 cap（claude fork 早有）+ children 不修剪致 live 预算空转；修=capReplayUpdate/readFileWithinCap/递归修剪
metadata:
  node_type: memory
  type: project
---

2026-08-21 分析用户机(0.13.1)诊断包：**codex** 会话（8.5h WSL cmake/ninja/单测构建型，数百次 kind=execute）切 tab 后 20s 内 Tab 0.4GB→3.4GB、峰值 4.4GB，main heap 同期 58MB→1016MB，renderer OOM；重启后 2s 重放 459 条 session/update、1 分钟又涨回 3.9GB。

根因：[[renderer-oom-triple-fix-live-budget-replay-cap-orphan]] 的三修**只覆盖 claude fork**，codex 侧四个缺口：

1. **codex fork 回放无源头 cap**（主因）：`streamThreadHistory` 把整条 thread（`thread/read includeTurns:true`）+ 整份 rollout 全量物化成 `UpdateSessionEvent[]` 逐条下发，无累计预算、无单条截断——claude fork 的 `MAIN_REPLAY_TOTAL_CAP_BYTES=96MB`/`MESSAGE_CAP=1MB` 从未移植。修=新增 `ReplayBudget.ts`（`capReplayUpdate` **递归遍历所有字符串字段**而非按 item 类型 switch，新增重字段自动覆盖；返回截断后字节供累计记账）+ `streamCappedHistoryUpdates` 超限发 `agent_message_chunk` 说明后停发。
2. **回放重读文件全文无上限**：`createPatchContent`→`readFileContent` 裸 `readFile`，每个改动文件整文件读回当 diff `oldText/newText`；rollout fallback 亦 `readFile(thread.path)` 无 stat。修=新增 `ReplayFileRead.ts` 的 `readFileWithinCap`（**stat 先判**，超限根本不 materialise；单文件 8MB / rollout 64MB）。
3. **renderer live 预算对 `children` 空转（真 bug，非仅欠计）**：子 agent 内容以独立 update **计入** `_liveIngestedBytes`，但嵌在父卡 `children` 上——`toolCallHeavyBytes` 不数、`trimToolCall` 保留、且 `_replaceToolCall` 用 slot 上**未修剪**的 children 覆盖回替换值。三者叠加 = 度量报 0 就 `break`（预算永久超限、此后无界增长），若只补度量不补释放则 `freed>0` 恒真 → **while 无限循环卡死主线程**。修=度量递归（children 是 `AcpChildItem` 联合，message 分支走 `messageHeavyBytes`）+ `trimToolCall` 递归修剪 + `_replaceToolCall` 优先用 `trimmed.children` + 循环改 `for` 加进度守卫。
4. **`estimateUpdateResidentBytes` 漏 `rawOutput`/`locations`**：codex 终态 `tool_call_update` **恒**把命令输出发两份（`_meta.terminal_output*` 保留 + `rawOutput.formatted_output` 无人读），估算只看到一份 → 构建型会话欠计约一半。修=`transientJsonBytes` 计入（不驻留但解码后待 GC）。

**Why:** ①「每条通往驻留内存的路径都要被预算覆盖」还不够——**预算的度量与释放必须是同一套遍历**，只补一边分别得到"永久超限"或"死循环"；②多 fork 架构下修了一个 fork 不等于修了能力对等的另一个，移植清单要显式核对。

**How to apply:** ① 给回放/流式类通路加 cap 时优先写**递归遍历字符串**的通用截断（`capReplayUpdate`），别按类型 switch——后者对新字段静默失效；② 改 `toolCallHeavyBytes`/`trimToolCall` 任一必同时改另一个与 `_replaceToolCall` 的 children 合并，回归见 `AcpSession.liveBudget.test.ts` 的 children 用例；③ 文件读上限一律 stat-before-read，别读完再截；④ codex fork 测试 mock `node:fs/promises` 只桩了 `readFile`，新增 `stat` 调用须同步补桩（`file-change-events.test.ts`）；⑤ 诊断法沿用三件套（processMetrics 曲线 + tabSwitchPerf 的 ipc.decode 连发 + sessionWatchedChanges storm），另 codex 侧 `acpProtocol.log` 只有 524288 字节轮转，崩溃前原文常已丢，靠这三份交叉还原；⑥ 改 vendor 后必 `node build.mjs`，且 fork 风格是 **4 空格+分号+双引号**（父项目 prettier 会污染，改完核 `git -C vendor/codex-acp diff`）。

**本机既有失败（非本次引入）**：codex fork 4 个 Windows 反斜杠/AbsolutePathBuf 测试失败，CLAUDE.md 已登记，Linux CI 绿。

相关 [[subagent-replay-bypasses-budget-renderer-oom]]、[[sessionchanges-unbounded-growth-main-oom-abort]]
