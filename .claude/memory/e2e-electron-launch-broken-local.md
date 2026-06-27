---
name: e2e-electron-launch-broken-local
description: E2E Electron 启动修复：ELECTRON_RUN_AS_NODE=1 导致 --remote-debugging-port=0 被拒，fixture 需显式清除该变量
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 43079eb1-77cc-461e-ae11-4f13549fea53
---

**根因已找到并修复（2026-06-04）。**

Claude Code 的 shell 设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 在此模式下以纯 Node.js 运行，不认识 Chromium 的 `--remote-debugging-port` 参数，导致 Playwright 无法连接，报 `Process failed to launch! bad option: --remote-debugging-port=0`。

**修复位置**：`apps/editor/e2e/fixtures/electronApp.ts`

**修复方式**：在 `electron.launch()` 的 `env` 中，先解构去掉 `ELECTRON_RUN_AS_NODE`，再展开其余环境变量：

```ts
const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env
const app = await electron.launch({
  args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
  cwd: APP_ROOT,
  env: {
    ...inheritedEnv,
    UNIVERSE_E2E: '1',
    NODE_ENV: inheritedEnv['NODE_ENV'] ?? 'production',
  },
})
```

**Why:** Claude Code 用 `ELECTRON_RUN_AS_NODE=1` 把 Electron 二进制当 node 跑，所有从 Claude Code shell 启动的子进程都会继承这个变量。Electron GUI 测试不能继承它。

**How to apply:** E2E fixture 已包含该修复。如将来又出现 `bad option: --remote-debugging-port` 错误，优先检查该变量是否被意外继承。

**补充（2026-06-07）**：除共享 fixture 外，多个 spec 内有自己的 `launchWithState` helper 直接 `electron.launch`，它们曾用 `env: { ...process.env, ... }` 漏掉了这个清除，在 Claude Code 沙箱里同样报 `Process failed to launch!`。已统一对齐修复：`smoke.editorRestore` / `smoke.agentOnboarding` / `smoke.agentsEmptySessionRestore` / `smoke.layoutPersistence` / `smoke.outputRestore`。**凡新写自定义 `electron.launch`，务必先解构去掉 `ELECTRON_RUN_AS_NODE`**。另外本地全量 e2e 默认并发会偶发 launch 争用，`--workers=2` 可稳定。

---

**附：通知测试 count 断言问题**

Extension host 启动时可能发生崩溃通知，污染 `[data-testid="notification-center-item"]` 的精确数量断言。修复方式（`smoke.notification.spec.ts`）：
1. 在触发测试通知前调用 `clearAll` 清除启动噪声
2. 步骤 6 改为用文本过滤（`filter({ hasText: 'This is a test notification.' })`）替代 `toHaveCount(1)`，对额外后台通知有容忍性
3. 步骤 7 的 `toHaveCount(0)` 仍保留，验证 clearAll 清空全部
