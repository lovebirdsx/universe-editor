---
name: e2e-relaunch-flake-windows
description: 本机 Windows 上若干 @p1 重启类 e2e 一直失败，是环境问题非回归
metadata: 
  node_type: memory
  type: project
  originSessionId: 1af940f1-91a4-43b0-8246-36f3662c114b
---

在本机（Windows 10）跑 `pnpm --filter @universe-editor/editor e2e` 时，凡是直接调用 Playwright `_electron.launch`（裸启动，带 `--inspect=0 --remote-debugging-port=0`）的 `@p1` 用例**稳定失败**，报错统一为 `Error: Process failed to launch!`（exitCode=9，启动瞬间退出）。涉及：`smoke.agentOnboarding`、`smoke.editorRestore`、`smoke.layoutPersistence`、`smoke.outputRestore`、`smoke.agentsEmptySessionRestore`（seed 式 bug2 复现）。

**Why:** 这些用例都用自带的 `launchWithState`（预置 userData 后裸启动 Electron），而非 `fixtures/electronApp.ts` 那套 fixture。失败发生在 OS/Electron 启动层，与被测业务无关。已验证：`@p0`（fixture 启动，29 个）全部通过；同环境下基线的 `smoke.editorRestore` 也以**完全相同**报错失败 → 预先存在的环境 flake，非代码回归。共同点是「裸 `_electron.launch`」而不是「重启」本身（单次 seed 启动也中招）。

**How to apply:** 改动后跑 e2e，若失败集合 ⊆ 上述裸启动 `@p1` 且报 `Process failed to launch!`，判定与改动无关，验证改用 fixture 式 `@p0` 或单测；这类 seed/restart e2e 只能在 CI 上验证。需确证时用 stash 基线重建对比。
