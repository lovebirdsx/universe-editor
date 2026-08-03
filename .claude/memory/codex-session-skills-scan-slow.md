---
name: codex-session-skills-scan-slow
description: codex 新建 session 慢的真因是 thread/start 内 spawn 的 git rev-parse --git-dir 子进程在 Windows 下挂起（0.141.0 实测 15.8s）；**0.146.0 已修复**（~0.9s），升级 CODEX_VERSION 即解决
metadata: 
  node_type: memory
  type: project
  originSessionId: 663aea7e-9cab-4c3a-9ab3-d9f454b6cc9f
---

内置 codex ACP agent 新建 session 慢（用户体感 >10s）的真因：codex 原生二进制在处理 `thread/start` RPC 时同步 spawn `git -c core.hooksPath=NUL -c core.fsmonitor=false rev-parse --git-dir` 子进程，该进程在 Windows 下挂起数秒。**触发条件：cwd 是 git 仓库**（仓库大小无关；非 git 目录秒开；`codex exec`/TUI 无此问题因 git 探测推迟到 turn 内）。

**版本实测（2026-08-03，profile 打点+e2e 固化，见 [[acp-optimistic-session-row-and-profiler]]）：**
- 0.141.0（曾钉版）：session/new = **15841ms**，total ~16.7s
- 0.146.0（现行钉版）：session/new = 916ms（冷）/ 264ms（温），total ~1.8s / 0.7s —— **上游已修复**
- 修复动作：`CODEX_VERSION`（`apps/editor/src/main/services/codexBinary/codexBinaryMainService.ts`）0.141.0→0.146.0 + vendor `package.json` `@openai/codex` ^0.145.0→^0.146.0 + `generate-types`（0.146 协议新增必填字段：commandExecution 的 `pluginId`/`scriptPath`、Thread 的 `isPinned`，只影响 vendor 测试 mock，adapter 源码零改动）。

**历史根因分析（36 天前，0.141.0/0.142.2 时代）：** 决定性验证=gap 期间 `Stop-Process` 杀掉挂起的 git → thread/start 立即从 5150ms 降到 1861ms。已逐一证伪：skills 扫描、shell_snapshot、git ls-remote、plugin marketplace sync、网络、目录大小、sandbox、代理 env、CPU。Node 各种 spawn 组合无法复现挂起 → 是 codex(Rust) 进程创建方式特有。

**Why:** 若未来新版本再现此慢（profile 的 newSession 段回到秒级），先怀疑上游回归——用受控实验（spawn `codex app-server` 发 initialize→thread/start）二分 codex 版本定位修复/回归区间，向 openai/codex 报 bug；**勿在 fork 源码加 workaround**（vendor CLAUDE.md 红线）。

**How to apply:** 受控实验套路：spawn `codex app-server`，按 newline-JSON-RPC 发 initialize→thread/start{cwd,config:{}} 测耗时；用 PowerShell `Get-CimInstance Win32_Process` 抓 git 子进程。codex 内部 trace 在 `~/.codex/logs_2.sqlite`；`RUST_LOG=trace` 输出到 stderr。升级流程见 `vendor/codex-acp/CLAUDE.md`「升级 Codex 原生二进制」（改 package.json → generate-types → typecheck+test → 对齐父项目 CODEX_VERSION → `pnpm agent:build`）。关联 [[codex-three-auth-modes]] [[acp-optimistic-session-row-and-profiler]]。
