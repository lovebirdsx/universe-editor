---
name: session-diff-feature
description: 会话级 diff（Session Changes）——pinned baseline 快照制（agent 上报写前全文/watched 走 git HEAD）+ fs-watch 兜底侦测 + 推测徽标
metadata: 
  node_type: memory
  type: project
  originSessionId: f6f35c5d-d60d-486e-b6f2-8a1f136ffcfd
  modified: 2026-08-07T02:42:19.052Z
---

会话级 diff（VSCode-Copilot 式「Session Changes」），跟踪当前 ACP agent 会话改动的文件。2026-08 重构为 **pinned baseline 快照制**（替代旧「从盘上内容逆向 un-apply hunks 重建 baseline」——旧机制对 agent 未上报的改动/外部改动会误报漏报）。方案文档 `docs/plan/session-changes-baseline-snapshot-plan.md`。

核心设计（2026-08 现状）：
- **P1 baseline 快照**：写前全文已在 wire 上——claude PostToolUse `toolResponse.originalFile`（Edit=改前全文、create=null）、codex diff-content `oldText`。`readFileChanges`（acpSessionUpdateMeta.ts）提取为 `FileChangeDescriptor.baseline?: string | null`（string=写前全文、null=created、undefined=未上报）。tracker **first-touch-wins** 钉住快照；展示 diff = pinned baseline vs 现读盘；hunk batches 仅供 rewind restore。per-file cap `MAX_BASELINE_BYTES=4MB`（超限不 pin，回退 `sessionDiffReconstruct` 逆推）。
- **预算降级**：超 per-session 预算先「丢 batches 保 baseline」（diff 存活、rewind 回滚降级），baselines 单独仍超限才丢整会话。SCHEMA_VERSION=3，v1/v2 持久化直接丢弃不迁移。
- **P2 fs-watch 兜底**：`SessionWatchedChangesContribution`（AfterRestore）监听 watcher，事件时刻捕获 running 会话 → 1500ms grace（agent 自身上报先落地则仅刷新）→ stat 确认（deleted 常是 atomic rewrite；目录跳过）→ `executeCommand(dirtyDiffCommandId(providerId,'getHeadContent'), fsPath)` 取 **git HEAD baseline**（undefined=命令未注册→degraded；null=无 HEAD→created）→ `recordWatched`。self-write 排除：`selfWriteRegistry.ts` + FileEditorInput.save 写盘前 `noteSelfWrite`（3s 窗口；键用消费方注入的 IUriIdentityService.getComparisonKey，不手写 fsPath）。MAX_PATHS_PER_FLUSH=50 防整树风暴。
- **origin/baselineSource**：`SessionFileChange` 带 `origin: 'agent'|'watched'` + `baselineSource: 'reported'|'git'|'reconstructed'|'none'`。agent record 解除 dismiss、升级 origin，但保留更早 pin 的 git baseline（first-touch-wins）。
- **UI**：watched 行显「推测」徽标（`acp-changes-inferred`）+ hover EyeOff 忽略按钮（`dismissWatched` 置 ignored=true，记录保留防 watcher 重加）。用户文档 `docs/user/zh-CN/git/session-changes.md` 有对应节。
- **视图**（沿革不变）：list/tree 两模式（buildTree+单链压缩）、单击预览/双击钉住（DiffEditorInput pinned:false/true）、删除项经 stat 确认后标 deleted。

测试：`sessionChangeTracker.test.ts`（41 个，含 pinned baseline/watched/预算降级/v3 持久化）、`acpSessionUpdateMeta.test.ts`（readFileChanges claude/codex 两路）、`SessionWatchedChangesContribution.test.ts`（11 个）、`SessionChangesView.test.tsx`（15 个，含徽标/忽略）；e2e `smoke.sessionChanges.spec.ts`（@p1 全链路）。

坑：makeScm 测试桩默认参数用 `string | null`（显式传 undefined 会命中默认值）；`toolResponse.type:'create'` 与 `originalFile:null` 都是 created 信号；Bash 工具改动不上报——正是 watched 链路存在的原因。
