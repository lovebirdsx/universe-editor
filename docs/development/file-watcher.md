# 文件监视：UtilityProcess 隔离与 win32 崩溃复盘

在已开窗口执行「打开目录」（切换工作区）曾导致整个应用闪退。根因是 `@parcel/watcher` 的 Windows native 后端在 `unsubscribe()` 时的 use-after-free，而 watcher 当时跑在 main 进程里——native 崩溃 = **全部窗口闪退**。VSCode 的对策一样：文件监视放独立进程，崩了只重启它。

> e2e 视角的同一根因（`Target page ... closed`、只多 worker 才崩、`@serial` 隔离的来龙去脉与后续摘除）已成文于 [fix-ci-e2e-flake 案例库](../../.claude/skills/fix-ci-e2e-flake/references/cases.md) **案例 12 / 16 / 26 / 44**——本文不复述那套叙事，只写进程架构与崩溃证据链。

## 进程架构（为什么 main 里没有 native watcher）

| 件 | 位置 | 职责 |
|---|---|---|
| `WatcherHost` | `packages/node-services/src/watcher/watcherHost.ts` | **唯一碰 `@parcel/watcher` 的代码**；跑在 utility process 里。刻意 transport-agnostic（生产接 `process.parentPort`，集成测试接 in-memory port） |
| utility process 入口 | `apps/editor/src/main/services/fileWatcher/watcherHostMain.ts` | electron-vite 独立 chunk（`electron.vite.config.ts` 的 `watcherHost` input）；只桥 `parentPort` → `WatcherHost` |
| `WatcherProcessClient` | `packages/node-services/src/watcher/watcherProcessClient.ts` | app 单例（`IWatcherProcessService`）：**desired-state 重放 + 崩溃 300ms 自动重启 + 60s / 3 次熔断**（`RESTART_DELAY_MS` / `RESTART_WINDOW_MS` / `MAX_RESTARTS`）；Electron-free（transport 注入）故可 node 单测 |
| transport | `apps/editor/src/main/services/fileWatcher/watcherUtilityTransport.ts` | 唯一 electron-coupled 的一层：`utilityProcess.fork` + pid 角色登记 |
| per-window 编排 | `.../fileWatcherMainService.ts` | root/exclude dedupe、re-subscribe 合并、event debounce、out-of-workspace 的 `node:fs.watch`（无 native addon，留进程内安全） |

**崩溃恢复链**：utility process exit → 重启 → 按 desired state 重放订阅 → `onDidRestart`（`fileWatcherMainService.ts:192` 透传 → ProxyChannel 桥到 renderer）→ `ExplorerTreeService.ts:241` 重扫已加载目录，补上崩溃窗口内漏掉的 fs 事件。

`WatcherHost` 还**显式固定 parcel backend**（`PARCEL_BACKEND`：win32=windows / darwin=fs-events / linux=inotify）：默认 backend 在 Windows 上会先 shell 出 `watchman` 探测（每次重订阅都打印一句 `'watchman' is not recognized`）再回落，点名 backend 直接跳过。

## 崩溃证据链（2026-07-29）

- 两份 dump（`<userData>/Crashes/`，09:53 与前一天）崩溃点**同一偏移** `watcher.node+0x2ab6e` → 确定性复现的 bug，不是随机损坏。
- 崩溃线程栈**全程在 `watcher.node` 内**（栈底 `BaseThreadInitThunk` → watcher 工作线程入口），Crashpad 注解 `ptype=browser` → 崩的是主进程，不是渲染进程。
- main 侧 `fileWatcher.log` **没有**打出 `unwatch <旧工作区>`——该日志在 `await sub.unsubscribe()` **之后**才写（`fileWatcherMainService.ts:1254`）→ 崩溃就落在 unsubscribe 调用窗口之内。
- 触发链：`openFolder` → `WorkspaceMainService` fire → renderer `ExplorerTreeService._syncWatch` → IPC → `FileWatcherMainService._subscribe` → `_teardown` →`sub.unsubscribe()`（旧订阅）→ native UAF。

minidump 的手工解析方法（node 脚本走 header → streams → ExceptionStream → ModuleList → Memory64List 栈扫描；Crashpad 注解读法；模块身份法=比 PE `SizeOfImage`）见 [error-diagnostics.md](error-diagnostics.md) 的「手工解析 minidump」。

## 2026-08-03 复发（2.6.0 仍存同族 race）与 re-subscribe 合并

升到 2.6.0 后 win32 native race **仍然存在**：发布版恢复 3 个窗口后 3 秒，watcher utility process 再崩 `0xC0000005`（`watcher.node+0x2c243`，与上次的 `+0x2ab6e` 不同偏移）。诱因是 **subscribe 风暴**——exclude 配置 hydrate 期间 `_onExcludeChange` 反复触发 `setExcludes`，每个窗口 2 秒内对同一路径做 3–4 次 same-id replace（main 侧 dedupe 只在 root + ignore 全同才跳过），host 内快速 unsubscribe→subscribe 命中该 race。这次**隔离+自愈按设计兜住了**（300ms 重启重放 3 个订阅，用户无感知）。

同日落地的缓解在 `fileWatcherMainService.ts:54-60`：re-subscribe 走 **500ms 滑动静默窗 + 2s 强制上限**（`RESUBSCRIBE_QUIET_MS` / `RESUBSCRIBE_MAX_WAIT_MS`；首次订阅立即 arm），`_subscribe` 用乐观占位目标状态防并发回退。两条只有踩过才知道的运维事实：

- **`watch()` 等 ack，`setExcludes` 是 fire-and-forget**（`ExplorerTreeService` 依赖 watch 的 ack）。测试里 `await setExcludes(...)` 会被静默窗口**吊住**——别把它当作同步点。
- `_teardown` 必须**无条件** `client.unwatch`（含 watch 失败、id 从未进 map 的路径）：desired 残留会在下一次崩溃重启时被重放成幽灵订阅（`fileWatcherMainService.ts:1245-1253`）。

## 测试策略

- client 层：`FakeTransport` + fake timers 测熔断 / 重放 / ack 匹配（`packages/node-services/src/watcher/__tests__/`）。
- 集成层：in-memory transport 跑**真 parcel**，含 `simulateCrash` 端到端用例（`apps/editor/src/main/services/fileWatcher/__tests__/fileWatcherMainService.test.ts:533-536`）；testing/ 下另有 `inMemoryWatcherTransport.ts` / `stubWatcherProcessClient.ts` 供上层复用。
- 真实进程链（fork 失败、真崩溃、退出码）只由 e2e 覆盖；`@serial` 相关约定见 `apps/editor/e2e/CLAUDE.md` 与上述案例 12/16/26/44。
