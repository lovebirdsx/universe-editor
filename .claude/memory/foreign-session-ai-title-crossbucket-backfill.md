---
name: foreign-session-ai-title-crossbucket-backfill
description: 跨 worktree 窗口看外部 session 标题卡在首条消息(非 AI 标题)的根因与渲染层修复(跨 bucket 回填 title)
metadata: 
  node_type: memory
  type: project
  originSessionId: 300a6827-73b5-419b-9186-e29a09da72f4
---

**现象**:在 worktree A(如 task1)窗口查看归属 worktree B(如 main)的 session,Side Bar 列表 + tab + 窗口标题显示的是**首条用户消息**而非设定的 AI 标题;在 B 自己窗口看则正常。

**根因(与 [[codex-ai-title-persistence-parity]] 不同,那是 agent 侧;这次是渲染层)**:
- 每个 session 的权威标题存在**归属工作区的 storage bucket**(`acp.sessionHistory` 条目,`aiTitle:true` + 正确 title),同时经 `renameSession` 推给 agent。
- 外部窗口靠 hydrate sweep(`session/list`)把外部 session 拉进**自己的 bucket**,建行时 title 取 agent 汇报的 `summary`。
- hydrate **每个 cwd 只自动跑一次**(`_hydratedForCwd` 幂等门)。若首次 hydrate 早于 AI 标题生成/推送,首条消息标题就被冻结在外部 bucket,此后不自动刷新。更糟:session JSONL 被删后 SDK `listSessions` 直接 `NOT IN LIST`,`session/list` 永远修不回来。
- SDK `summary = customTitle||aiTitle||lastPrompt||firstPrompt`;session 存 `~/.claude/projects/<把cwd非字母数字→->编码>/<id>.jsonl`,同一 repo 各 worktree 靠 `git worktree list` 交叉列出。**Windows 上盘符大小写会生成两个 project 目录**(`d--...` vs `D--...`,同一物理目录)。

**修复(纯渲染层,复用既有跨 bucket 回填链路)**:代码库已有 `useForeignSessionStats` 从**归属 bucket** 回填外部行的时长/费用/模型——标题是同类数据却漏了。
1. `useForeignSessionStats.ts`:`ForeignSessionStat` 加 `title?`,从归属 bucket 读取,**仅当该条目 `aiTitle===true`** 才回填(非权威标题不覆盖)。
2. `SessionListBody.tsx`:行标题显示 `foreignStat?.title ?? entry.title`;并加 reconcile effect 把权威标题经 `history.updateInfo(id,{title})` 写回当前 bucket(**title-only,绝不打 aiTitle** 否则冻结未来 hydrate),使 tab/窗口标题(读 `history.entries` via `resolveLiveSessionTitle`)一并自愈。

复现/验证手法:直接读 `%APPDATA%/Universe Editor/workspaces/<sha1(URI.file(cwd).toString()).slice(0,16)>.json` 的 `acp.sessionHistory.entries` 对比两 bucket 同 id 条目;用 fork 的 `@anthropic-ai/claude-agent-sdk` `listSessions({dir})` 探 agent 侧真值(须把探针放进 vendor 包目录内才能解析 node_modules)。测试:`useForeignSessionStats.test.tsx`(renderer-dom project,不是 "renderer")新增 2 例(AI 标题回填 / 非 AI 标题不回填)。
