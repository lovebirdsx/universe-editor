---
name: session-timer-feature
description: Session 执行时间统计功能 — 只计 running 状态的时间，两处显示
metadata: 
  node_type: memory
  type: project
  originSessionId: 7df8458e-7021-459b-8343-238a6a4f834f
---

实现了 Session 执行时间统计，只算 `status === 'running'` 的净时长，支持多段累积、持久化恢复。

**Why:** 帮助用户了解 Agent 实际消耗的工作时长，区别于挂起/等待时间。

**How to apply:** 时间追踪逻辑在 `acpSession.ts` 的 `_recomputeStatus`/`_finalizeRunningSegment`；UI 展示分两处：输入框下方 (`PromptInput.tsx`) 和 AGENTS 面板 session 行 (`SessionListBody.tsx`)。新增公共 hook `useSessionTimer` + `formatRunningTime`。历史持久化通过 `AcpSessionHistoryEntry.accumulatedRunningMs`（可选字段，无需版本迁移）。
