---
name: subscription-usage-indicator
description: 官方订阅额度用量指示器（Claude plan windows / Codex rate limits）的架构约束与四个坑
metadata:
  type: project
---

`UsageIndicator`（ACP 输入框右下角）按会话 agent 的认证形态三分：官方订阅 → 最紧窗口已用百分比 + 弹窗窗口条（Codex 另有「重置限额」消耗一张 reset credit）；provider 声明账号用量来源 → 权威账号数字（quota/balance/subscription，拉不到显示「不可用」，绝不用估算值冒充）；其余隐藏。2026-08 网关 ¥ 月度开销链路（`claudeUsage.ts` / `IUsageService` / `ApiUsageService`）已整体删除。

数据只走 ACP ext-method（`universe-editor/subscription_usage` / `universe-editor/consume_reset_credit`），两个 fork 只做 sanitize、归一化在 renderer 纯函数（避免两 fork 各写一份漂移）。

三条踩过的红线：

1. **绝不为读用量而 `connect()`**：ACP 连接是租约池，`POOL_GRACE_MS=30s` 后停 agent 子进程；只能搭已有 session 便车（`IAcpSession.requestExtMethod`，无连接返回 `undefined` 而非抛错）。无活连接 = 显示缓存值 + 弱化 + tooltip 标数据截止时间。
2. **bigint 不能跨 JSON-RPC**：codex `RateLimitResetCreditsSummary.availableCount` 是 Rust u64 → `JSON.stringify` 直接抛 `TypeError` 带崩整条响应。fork 侧 `String()`，renderer `Number()` 还原。
3. **「不支持」的判定别做成永久粘性**：`supported:false` 属于**当时那个账户**，不属于 agent。用户中途登录 claude.ai/ChatGPT 后指示器会永久隐藏——而唯一的 force 重探通道恰好长在已不渲染的弹窗里。修法=订阅 sessions observable，出现新 session id 就清掉该 agent 的 unsupported 并重探一次。
4. **`supported` 必须由认证形态决定，不能由「上游回了数字」决定**（2026-08-26 修）：codex `account/rateLimits/read` 按 `auth.json` 的账号作答，与这一轮实际计费到哪个 `model_provider` 无关——用户配了自定义网关但残留过 `codex login`，就会把 ChatGPT 套餐的窗口当成网关会话的额度显示成百分比。fork 的 `readSubscriptionUsage` 必须先 `getAuthenticationStatus()`，`type !== 'chat-gpt'`（gateway / api-key / unauthenticated）直接返回 `supported:false` 且**不发**那个 RPC。claude fork 早有等价位（`rateLimitsAvailable`），codex 侧原先只有注释声称做了门控、代码从未实现。同源提示：`resolveUsageDisplay` 让 subscription 无条件压过 account，所以**订阅侧一旦误报，网关账号数字永远没机会显示**——门控只能在源头做。

`idempotencyKey` 语义：一次用户确认 = 一个 key，重试复用同一 key；`alreadyRedeemed` 视作成功，绝不换新 key 重试（会二次扣额度）。

相关：[[async-session-create]]（双 id）、[[session-cost-subagent-inclusion]]（会话费用是另一件事）。
