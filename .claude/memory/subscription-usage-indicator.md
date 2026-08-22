---
name: subscription-usage-indicator
description: 官方订阅额度用量指示器（Claude plan windows / Codex rate limits）的架构约束与三个坑
metadata:
  type: project
---

`UsageIndicator`（ACP 输入框右下角）按会话 agent 的认证形态三分：官方订阅 → 最紧窗口已用百分比 + 弹窗窗口条（Codex 另有「重置限额」消耗一张 reset credit）；claude-code 走内部网关 → 保留 ¥ 月度开销；其余隐藏。**Codex 会话永远不显示 ¥**（那是 Claude 网关 account 级数据，原先全局单例的既存 bug）。

数据只走 ACP ext-method（`universe-editor/subscription_usage` / `universe-editor/consume_reset_credit`），两个 fork 只做 sanitize、归一化在 renderer 纯函数（避免两 fork 各写一份漂移）。

三条踩过的红线：

1. **绝不为读用量而 `connect()`**：ACP 连接是租约池，`POOL_GRACE_MS=30s` 后停 agent 子进程；只能搭已有 session 便车（`IAcpSession.requestExtMethod`，无连接返回 `undefined` 而非抛错）。无活连接 = 显示缓存值 + 弱化 + tooltip 标数据截止时间。
2. **bigint 不能跨 JSON-RPC**：codex `RateLimitResetCreditsSummary.availableCount` 是 Rust u64 → `JSON.stringify` 直接抛 `TypeError` 带崩整条响应。fork 侧 `String()`，renderer `Number()` 还原。
3. **「不支持」的判定别做成永久粘性**：`supported:false` 属于**当时那个账户**，不属于 agent。用户中途登录 claude.ai/ChatGPT 后指示器会永久隐藏——而唯一的 force 重探通道恰好长在已不渲染的弹窗里。修法=订阅 sessions observable，出现新 session id 就清掉该 agent 的 unsupported 并重探一次。

`idempotencyKey` 语义：一次用户确认 = 一个 key，重试复用同一 key；`alreadyRedeemed` 视作成功，绝不换新 key 重试（会二次扣额度）。

相关：[[async-session-create]]（双 id）、[[session-cost-subagent-inclusion]]（会话费用是另一件事）。
