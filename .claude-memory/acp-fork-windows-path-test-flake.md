---
name: acp-fork-windows-path-test-flake
description: claude-agent-acp fork 在 Windows 上 toDisplayPath 的两个测试必失败，是上游跨平台缺陷非回归
metadata: 
  node_type: memory
  type: project
  originSessionId: bf0095f9-f9ca-4861-86bc-4a85c3d3d25b
---

`vendor/claude-agent-acp` 跑 `npm test` 时，`src/tests/acp-agent.test.ts` 有两个测试在 Windows 上必失败：
- `tool conversions > should use relative path in title when cwd is provided`
- `toDisplayPath > should relativize paths inside cwd and keep absolute paths outside`

原因：上游 `src/tools.ts` 的 `toDisplayPath` 用 `path.relative` 返回平台分隔符（Windows 为 `\`），但测试硬编码期望 `/`（如 `src/main.ts`，实际得到 `src\main.ts`）。

**Why:** 这是上游自带（59a098c 即有）的跨平台测试缺陷，上游 CI 在 Linux/Mac 跑未暴露，与我们的 fork 改动无关。

**How to apply:** 每次合并上游（见 git submodule fork 维护流程）后跑 fork 测试，这两个失败可直接忽略，不要误判为合并引入的回归。不影响主仓库 `pnpm check`（vendor 不在 pnpm workspace，不跑它的测试）。类似环境性失败模式见 [[e2e-relaunch-flake-windows]]。
