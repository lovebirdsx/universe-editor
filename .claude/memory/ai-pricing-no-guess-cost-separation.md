---
name: ai-pricing-no-guess-cost-separation
description: AI 费率解析不再猜家族兜底（未知即未知）+ 会话开销与账号费用两个概念绝不互相兜底
metadata:
  type: project
---

AI 费率与成本两个「不再兜底」的硬约束（2026-08 重构落地）：

1. **费率解析五级链，未知就是未知**：`shared/ai/resolveModelPricing.ts` 顺序 = 模型显式 `pricing` → 网关价目表（`pricingSource` 本地缓存）→ 类型默认 `pricing` → 内置目录精确匹配 bare 模型名 → `undefined`。旧行为「按模型名猜家族 / 未知模型兜底到 claude-sonnet、gpt-5.4」已彻底删除。UI 显示「费率未知」是一个状态，不是编出来的数字。
2. **会话开销与账号费用是两个概念，绝不互相兜底**：会话开销 = per session 本地估算（token×费率，查不到显示「—」）；账号费用 = per 实例的上游权威数字（`IAiAccountUsageSource`，查不到显示「不可用」）。`resolveUsageDisplay` 五态（subscription/account/unavailable/gateway/hidden）里，account 声明了来源但数字缺失 → `unavailable`，**绝不回落**到 gateway ¥（那是别的账号的数）；gateway ¥ 仅对 claude-code 有意义（Codex 会话永不显示 ¥，既存 bug 修复）。

**Why:** 两者一个是估算一个是权威，混用会「拿 A 账号的钱给 B 会话计费」；家族猜测会把未知模型标上一个看似可信的假价格，掩盖配置缺失。
**How to apply:** 动成本/额度口径前先分清「估算 vs 权威」与「per session vs per 实例」；给新模型加费率只改内置目录（`shared/ai/catalog/`），不要恢复任何"猜家族"的兜底。

相关：[[session-cost-subagent-inclusion]]、[[subscription-usage-indicator]]、[[ai-service-foundation-progress]]
