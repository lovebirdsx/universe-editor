---
name: empty-session-rebuild-on-restart
description: 空会话热重连须走 session/new 重建 + history rekey，别无条件 resume；side task 是唯一例外
metadata:
  type: project
---

# 空会话 restart 重建（Sub Agent 弹窗改造附带修复）

**症状**：改 Sub Agent 模型后点「立即重启」（`requestProcessRestart`），会话反复 `reconnect attempt N/3 … Resource not found`，3 次耗尽 seal 成「Automatic recovery failed」。

**根因**：`_reconnectSession` 原来无条件 `session/resume`。空会话（history 行 `hasMessages === false`，从未发过 prompt）在 agent 侧没有 transcript，resume 只能回 `resourceNotFound`。

**修法**（`acpSessionService.ts` 的 `_reconnectSession`）：按 `entry?.hasMessages === false` 分派到 `session/new` **原地重建**，而不是照抄 MCP 变更的 `_reloadSessionForMcpChange`「关闭+替换」——后者会关掉用户 editor tab、清 draft/viewState、换本地 uuid 让 React 重挂载。重建换 durable id，连带四处：
- `acpSessionHistory.rekey(old, new)`：迁行保留全部字段，同时删旧行与目标 id 上的既有行
- `acpSession._priorAgentSessionIds`（别名集合，cap `MAX_PRIOR_AGENT_SESSION_IDS=4`）+ `reattachConnection(conn, newId)`
- `acpSessionRegistry.find()` 别名回退、`liveIds()` 带别名（防 refresh-prune 误删）
- rebuild 分支**不传 `leaseFor`**，否则 terminal 归属绑到即将作废的死 id

## 三条踩坑（代码审查逮到的）

1. **side task 是唯一 `hasMessages:false` 但 agent 侧有 transcript 的会话**——`forkSideTask` 在子会话发首条消息前就已经把父会话完整历史 fork 到 agent 侧。所以判定必须是 `entry?.hasMessages === false && entry.sideTaskOf === undefined`，否则 rebuild 会静默丢掉 fork 基线，侧边追问失去讨论对象。
2. **重试循环持有的 `sid` 必须随 rekey 一起更新**（`let sid`，rekey 后 `sid = rebuiltSessionId`）。否则 attach 抛错后重试用死 id 查 history → `entry === undefined` → 退回 resume 死 id → budget 耗尽。
3. **rekey 必须紧贴 `attachSession` 之前**，中间不能夹任何可能抛错的调用（`setConfigDesired` / `applyInitState` 都挪到 rekey 之前）——否则会留下「行在新 id、session 在旧 id」的不一致窗口。

验证测试全在 `AcpSession.recovery.integration.test.ts`（harness 的 `freshSessionIdPerConnect` / `resumeSessionError` / `attachSessionErrorOnConnect` 三个 Script 开关就是为这三条造的）。注意既有那几条「空会话 seal」的用例修复后语义会变，须补前置 `sendPrompt` 让它们继续守护 resume 路径。

相关：[[async-session-create]]（双 id）、[[prompt-monaco-input-migration]]
