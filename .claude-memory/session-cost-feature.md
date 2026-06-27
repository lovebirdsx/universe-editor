---
name: session-cost-feature
description: Session 人民币开销显示 — agent 上报真实 USD（含子 Agent）+ 按模型拆分弹窗 + 汇率服务
metadata: 
  node_type: memory
  type: project
  originSessionId: a972bb16-a7ec-4e5f-a4d2-c65d82476ed5
---

为 claude/codex session 加了人民币开销显示，在 Session running time 旁，`¥x.x`（精确 0.1 元），点击弹窗按模型列出输入/输出 token + 各模型开销 + 总计。

**Why:** 让用户直观看到本 session 花了多少钱，子 Agent（Task）开销也要算进去。

**关键数据流（含子 Agent 的成本如何拿到）:**
- fork `vendor/claude-agent-acp/src/acp-agent.ts` 的 `usage_update` 处：`message.modelUsage`（SDK 提供的 `Record<modelId, ModelUsage>`，**session 累计且已折入子 Agent/Task 的开销**，每模型自带 `costUSD`+输入/输出/缓存 token）通过 `toModelBreakdown()` 转换后塞进 `_meta._universe/modelBreakdown`（ACP 的 `usage_update` schema 固定为 {used,size,cost}，明细只能走 `_meta`，跟 `_claude/origin` 一个套路）。`message.total_cost_usd` 是 session 累计总成本（也含子 Agent），走 `cost.amount`。改 fork 后必须 `npm run build` 重建 `dist/index.js`（renderer 实际加载 dist），有对应 vitest 测试 "carries per-model cost breakdown"。
- renderer `acpSession.ts`：`AcpUsage` 加 `models?: AcpModelCost[]`，`extractModelBreakdown(update)` 从 `_meta` 解析；持久化进 `acpSessionHistory.ts` 的 `usage.models`。

**UI:** `SessionCostIndicator.tsx`（chip + popover，outside-click 范式抄 `SessionsPopover.tsx`）接在 `PromptInput.tsx` timer 与 `UsageIndicator` 之间。USD→CNY 用 `useExchangeRate.ts`（module 级 promise 缓存，必须用 `useOptionalService` 否则单测 DI 没注册会崩）。agent 不报 cost 时 indicator 自动隐藏（codex 优雅降级）。

**运行中也要显示（关键坑）:** cost/modelUsage 只在 turn 结束的 SDK `result` 消息里有；运行期间 fork 从 `stream_event` 实时发的 `usage_update` 只带 used/size。所以 `acpSession.ts` 的 `usage_update` 处理必须让 `cost`/`models` **粘性保留**（中途 update 不带就沿用上次值），否则整个运行期间金额闪没、只在结束时出现。

**汇率:** main 进程 `IExchangeRateService`（`exchangeRate/exchangeRateMainService.ts`），fetch `https://open.er-api.com/v6/latest/USD` 取 `rates.CNY`，24h 磁盘缓存到 `<userData>/exchange-rate.json`，失败回退 stale 缓存→硬编码常量 7.2。范式抄 `RemoteSchemaMainService`。

相关：[[session-timer-feature]] [[ai-service-foundation-progress]]
