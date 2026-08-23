---
name: ai-pricing-no-guess-cost-separation
description: AI 费率单一来源＝provider 自己的 pricingSource（未声明即未知，绝不跨 provider 套官方价）+ 会话开销与账号费用两个概念绝不互相兜底
metadata:
  type: project
---

AI 费率与成本两个「不再兜底」的硬约束（2026-08 重构落地）：

1. **费率单一来源，未知就是未知**：`shared/ai/resolveProviderPricing.ts` 的 `resolveModelPricing`——费率只由该 provider 自己的 `pricingSource` 决定：`catalog`（按 `options.vendor` 查内置官方价目表 `OFFICIAL_CATALOGS`）或 `http-json`（读网关价目表本地缓存）。**未声明 `pricingSource` 就是「费率未知」**。两类旧兜底都已彻底删除：「按模型名猜家族 / 未知模型兜底到 claude-sonnet、gpt-5.4」，以及「跨 provider 套官方价」——中转网关有折扣/加价/换币种，套官方价直接记错账。UI 显示「费率未知」是一个状态，不是编出来的数字。
2. **会话开销与账号费用是两个概念，绝不互相兜底**：会话开销 = per session 本地估算（token×费率，查不到显示「—」）；账号费用 = per provider 的上游权威数字（额度跟 key 走；`IAiAccountUsageSource`，查不到显示「不可用」）。`resolveUsageDisplay` 五态（subscription/account/unavailable/gateway/hidden）里，account 声明了来源但数字缺失 → `unavailable`，**绝不回落**到 gateway ¥（那是别的账号的数）；gateway ¥ 仅对 claude-code 有意义（Codex 会话永不显示 ¥，既存 bug 修复）。

**Why:** 两者一个是估算一个是权威，混用会「拿 A 账号的钱给 B 会话计费」；家族猜测与跨 provider 套官方价都会把未知模型标上一个看似可信的假价格，掩盖配置缺失。
**How to apply:** 动成本/额度口径前先分清「估算 vs 权威」与「per session vs per provider」；给新模型加费率只改 `shared/ai/catalog/modelKnowledge.ts` 的 `OFFICIAL_CATALOGS`（同目录 `anthropic.ts`/`openai.ts`/`deepseek.ts`/`moonshot.ts` 是**不含 pricing** 的模型知识库，别改错文件），不要恢复任何"猜家族"或"跨 provider 兜底"。

相关：[[session-cost-subagent-inclusion]]、[[subscription-usage-indicator]]、[[ai-service-foundation-progress]]
