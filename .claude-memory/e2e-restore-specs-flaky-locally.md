---
name: e2e-restore-specs-flaky-locally
description: 本机跑 pnpm e2e 时 restore/persistence 类 @p1 spec 因 electron 二次启动失败，属环境问题非回归
metadata: 
  node_type: memory
  type: project
  originSessionId: 979d77ed-2438-4c0f-a07e-eef7aa3f90c5
---

本机（Windows）跑完整 `pnpm e2e` 时，约 8 个 @p1 spec 会失败，报 `electron.launch: Process failed to launch!`（常 `<launched> pid=...` 后仍判失败）。集中在需要在测试内**二次启动 Electron** 的 restore/persistence 类：`smoke.editorRestore` / `smoke.outputRestore` / `smoke.layoutPersistence` / `smoke.agentOnboarding` / `smoke.agentsEmptySessionRestore`（它们调用 `launchWithState()` → `electron.launch({ ...inspect/remote-debugging-port })`）。

**Why:** 已用 `git stash`（清空所有本地改动）+ 原始源码复跑验证：未改任何代码时这些 spec 同样失败。根因是本机环境对 Electron 二次启动 + `--inspect=0 --remote-debugging-port=0` 的 CDP 连接限制，与被测改动无关。@p0 spec 不受影响、全过。

**How to apply:** 跑 `pnpm e2e` 后若只有这些 restore 类 @p1 失败且错误是 "Process failed to launch"，判定为环境 flaky，不要当回归追。验证某改动是否引入回归时，优先单独跑相关 @p0 spec（如 `npx playwright test -c e2e/playwright.config.ts specs/<name>.spec.ts`），而非依赖完整 e2e 绿。
