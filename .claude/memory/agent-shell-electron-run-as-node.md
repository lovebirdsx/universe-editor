---
name: agent-shell-electron-run-as-node
description: agent 的 Bash 环境注入了 ELECTRON_RUN_AS_NODE=1，直接跑 electron/pnpm dev 会崩，须先 unset
metadata: 
  node_type: memory
  type: project
  originSessionId: 48d261e6-7954-4ec7-aa08-ced6557db7e3
---

在 agent（Claude Code 类 harness）的 Bash 工具环境里，`ELECTRON_RUN_AS_NODE=1` 被默认注入。此变量下 Electron 退化为纯 node 模式：ESM 主进程 `import ... from 'electron'` 直接崩 `TypeError: Cannot read properties of undefined (reading 'exports')`（cjsPreparseModuleExports），`pnpm dev` 在 "starting electron app..." 后必崩。

**Why**: 排查 electron 启动崩溃时容易误判为代码/依赖回归（我曾在 git stash 回滚后仍复现，浪费一轮排查）；实为用户真实终端无此变量，纯 agent shell artifact。

**How to apply**: 在 agent shell 里验证 electron 应用（`pnpm dev`、直接 `electron <path>`）前一律 `unset ELECTRON_RUN_AS_NODE`。e2e 不受影响——`packages/e2e-harness/src/launch.ts` 已自动 strip 该变量。相关：[[electron-builder-asarunpack-pnpm-workspace]]
