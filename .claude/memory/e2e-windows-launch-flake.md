---
name: e2e-windows-launch-flake
description: "本机 Windows 裸 electron.launch 的 restore/relaunch 类 @p1 偶发 \"Process failed to launch!\" 是环境问题非回归；含 ELECTRON_RUN_AS_NODE fixture 修复与判别要点"
metadata: 
  node_type: memory
  type: project
  originSessionId: 83c75ed7-76d6-4fa0-ad02-023840d265e5
---

本机（Windows 10）跑 `pnpm e2e` 时，凡是用**裸 `electron.launch`**（自带 `launchWithState`，带 `--inspect=0 --remote-debugging-port=0` 二次启动 Electron）的 restore/persistence/relaunch 类 `@p1` 用例会偶发/稳定失败，报 `electron.launch: Process failed to launch!`（常 `<launched> pid=...` 后仍判失败，exitCode=9）。涉及：`smoke.editorRestore` / `smoke.outputRestore` / `smoke.layoutPersistence` / `smoke.agentOnboarding` / `smoke.agentsEmptySessionRestore`。

**判别（核心价值）**：已用 `git stash` 清空本地改动 + 原始源码复跑验证——未改任何代码时这些 spec 同样失败，根因是本机环境对 Electron 二次启动 + CDP 连接的限制，与被测业务无关。`@p0`（走 `fixtures/electronApp.ts` 的 fixture 启动）不受影响、全过。**若失败集合 ⊆ 上述裸启动 `@p1` 且报 "Process failed to launch!"，判定与改动无关，别当回归追**。验证改动是否引入回归时，单独跑相关 `@p0` spec 或在 stash 基线上对照；这类 seed/restart e2e 最终以 CI（ubuntu+windows runner）为准。

**已修的真 bug（ELECTRON_RUN_AS_NODE）**：Claude Code 的 shell 设了 `ELECTRON_RUN_AS_NODE=1`，Electron 在此模式下当纯 Node 跑、不认 `--remote-debugging-port`，所有子进程继承后都报 `bad option: --remote-debugging-port=0`。修复：`apps/editor/e2e/fixtures/electronApp.ts` 在 `electron.launch()` 的 `env` 里先解构去掉该变量再展开其余：`const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env`。各 spec 内自带的 `launchWithState` 也已统一对齐。**凡新写自定义 `electron.launch`，务必先解构去掉 `ELECTRON_RUN_AS_NODE`**；本地全量 e2e 偶发 launch 争用时 `--workers=2` 可稳定。

**附：通知 count 断言**——extension host 启动崩溃通知会污染精确数量断言。`smoke.notification.spec.ts` 的修法：触发测试通知前先 `clearAll` 清启动噪声；用文本过滤（`filter({ hasText: '...' })`）替代 `toHaveCount(1)`。

相关 native 崩溃范本：[[e2e-parcel-watcher-multiworker-crash]]。
