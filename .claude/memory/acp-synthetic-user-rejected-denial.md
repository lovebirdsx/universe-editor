---
name: acp-synthetic-user-rejected-denial
description: 子 agent 莫名「被拒绝」停住的根因=CLI 把任意 tool-queue abort 兜底成 user-rejected；判据是时间差 <100ms
metadata:
  type: project
---

子 agent 突然报「用户拒绝了工具调用」而你没点过任何东西 —— 根因在闭源 claude.exe：`getAbortReason` 把**任何**非 `interrupt`/`end_conversation` 的 tool-queue abort（`stalled`/`deadline`/`refusal-fallback-edit`/`subagent-park` 等）兜底成 `user_interrupted`，再合成 `toolDenialKind: "user-rejected"` 的 tool_result。

**诊断判据（真假拒绝文案逐字相同，只能靠时间差）**：transcript 里量「assistant 记录 → 拒绝记录」的毫秒差。**18~43ms = CLI 伪造**（人类不可能）；**>450ms = 真人点的**。本机全库实测 39 条 `user-rejected` 里 18 条是伪造的，18/18 全发生在子 agent、主 session 一次没中；permissionMode 当时是 bypassPermissions（根本无询问路径）。

**危害**：子 agent 收到「STOP and wait for the user」就静默停住，父 Task 调用既无结果也无错误地悬着，且不被判为失败/卡死 → **不触发任何自动重试**，必须手动重发。子 agent 停住时没写任何东西，重跑安全。

**已修（2026-09-03）**：fork 加 `_meta.claudeCode.syntheticDenial` 标记 + editor 卡片「上游中断」徽标与每轮一次的 Warning 通知。判据是 fork 自己有没有走过 `behavior: "deny"`。详情与两条设计约束（不改写 open-set 的 `nonExecutionKind`；replay 无 set 时不判定）见 `vendor/claude-agent-acp/CLAUDE.md` 本地改动清单首行。**效果边界：只修正呈现，改不了 CLI 内部历史 —— 子 agent 仍会被那句假拒绝骗停。**

另一个独立故障别混淆：网关返回 HTTP 200 空 body（`isApiErrorMessage`，360s 量级超时，claude-* 也中招占 50%），见 [[gateway-empty-200-long-request]]。
