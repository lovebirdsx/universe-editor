---
name: session-cost-subagent-inclusion
description: session 开销与子 Agent：claude SDK 总额天然已含（勿双计）；codex 需 fork 订阅子 thread tokenUsage 聚合（已实现）
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-14T02:56:44.653Z
---

session 开销（SessionCostIndicator / `usage.cost`）对子 Agent 的计入方式，两个 agent 机制完全不同（2026-08-14 实证并修复）：

- **Claude**：SDK `result.total_cost_usd` / `modelUsage` 是进程级会话累计器（二进制反查证实，`message_stop` 记账无 subagent 门控；CLI 自带「N% 来自 subagent」统计反证总额包含），**天然已含子 Agent**。绝不要在 renderer/fork 再把 `subagentStats` 加进 session 总额——会双计。`subagentStats`（`_universe/subagentStats` meta）只用于 Task 卡片 per-subagent 徽章，SDK 不提供 per-subagent 拆分才自己累计。另注意 `result.usage` 正常成功时=对 modelUsage 求和（session 累计值，非 per-turn）。
- **Codex**：子 Agent 跑独立 thread；上游 app-server（rust-v0.145.0 核对）**会**为子 thread 发 `thread/tokenUsage/updated`（`tokenUsage.total` 为该 thread 累计快照），客户端连接被自动 attach 到新线程，但 fork 的 `CodexAppServerClient.notify()` 按 threadId 精确路由、无 handler 即丢弃。修复=fork 内 `subscribeToSubagentThread`（发现源：`subAgentActivity.agentThreadId` / `collabAgentToolCall.receiverThreadIds`；core spawn 的子线程**没有** `thread/started`）注册仅认 token-usage 的窄 handler（绝不进主 CodexEventHandler，防污染 turn 状态），快照入 `SessionState.subagentTokenUsage` 聚合进 `_meta.quota`；`used`/`size` 保持主线程上下文口径。renderer 零改动（本地估价链路自动生效）。
- 坑：子线程订阅的去重账本必须与 `closeSession` 清理同源（放 CodexAcpClient），否则同进程内 close 后重开同 session 会静默拦掉重订阅。
- 限制：codex resume 后历史子线程开销丢失（与主线程 totalTokenUsage 同为 live-only）；孙子线程（子 spawn 孙）不计。

**Why:** 「session 开销没算子 Agent」这类观察极易误诊到 claude 侧（其 fork 注释自相矛盾曾致怀疑），实际 claude 无缺口、codex 才是；反向"修" claude 会双计。
**How to apply:** 动 session 成本口径前先分 agent 看数据源：claude 信 `total_cost_usd`；codex 看 `_meta.quota` 聚合（vendor/codex-acp `subagent-token-usage.test.ts` 是行为契约）。
