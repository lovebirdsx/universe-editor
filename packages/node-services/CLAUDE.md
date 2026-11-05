# packages/node-services/CLAUDE.md

Electron-free 的 Node 侧服务核心（main 与 remote-server 共享，勿复制）。

- **本地子进程必须登记生命周期**：新增 spawn 点时给 `ManagedChildProcess` 传 `lifecycle: { registry, owner, role }`（`src/process/processLifecycle.ts`），由 Windows Job Object / POSIX 进程组保证窗口关闭与 main 强杀后不残留；**不要**再在服务里自维护 `_windowByHandle` 之类的按窗口回收表。机制、降级矩阵与取舍见 `docs/development/process-lifecycle.md`。
