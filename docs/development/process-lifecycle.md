# 本地子进程的 OS 级生命周期绑定

目标：窗口关闭 / main 崩溃 / main 被强杀后，**不残留**本机子进程树（extension host、ACP agent 及其孙进程、MCP server、pty shell、ripgrep、tsserver 等）。逻辑层的优雅停止（stdin EOF、`stop()`）仍是第一道，OS 级绑定是它**之后**的硬保证。

## 机制

| 平台    | 绑定方式                                                                                                                            | 窗口关闭                                                | main 崩溃 / 强杀                                                    |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------- |
| Windows | 每个被跟踪进程树一个 Job Object（`KILL_ON_JOB_CLOSE`，无 breakaway），子进程创建后 `AssignProcessToJobObject`；owner 回收时逐个终止 | 先优雅停止，再 `TerminateJobObject` 该 owner 的全部 job | main 的 job 句柄随进程关闭，OS 杀整棵树                             |
| POSIX   | 子进程 `detached: true` 自成进程组，回收时 `kill(-pgid)`                                                                            | 先优雅停止，再组杀                                      | **不保证**：靠子进程自己的 stdin-EOF 看门狗（ext host、agent 已有） |

POSIX 评估过 `PR_SET_PDEATHSIG`：它只对**直接**子进程生效、在 macOS 不存在，且 Node `spawn` 无法设置，需要额外的 launcher；收益不抵成本，未采用。

### Windows 嵌套 job：为什么必须「每进程一个 job」

`AssignProcessToJobObject` 有一条硬规则（微软文档）：**如果目标进程已经在某个 job 里，目标 job 必须为空，或者必须在该进程已有的 job 层级中**。编辑器自己经常就运行在某个 job 里——CI runner、终端/启动器、沙箱（本仓 e2e 由 Playwright 拉起，整棵进程树都在一个 job 中）——于是每个子进程出生时就继承了那个 job：

- 第一个被 assign 的进程能进入新 job（新 job 为空，合法）；
- 后续兄弟进程会收到 `ACCESS_DENIED (5)`（owner job 已非空，又不在该进程的 job 层级里），只有**新建的空 job** 才能接收它们。

所以**不能每个 owner 共用一个 job**，必须**每个被跟踪的进程树一个 job**（`ProcessLifecycleRegistry` 的 slot 持有 `jobs: Set<bigint>`）。进程退出且树已空时立刻关闭该 job；树里还有后代时先保留（关闭会立刻杀掉它们），5 秒后复查一次，仍空就释放。回收 owner 时逐个 `TerminateJobObject` + `CloseHandle`。**ACP agent 的 job 是显式例外**：它的跟踪条目带 `reapDescendantsOnRelease`，agent 退出（lease release）时立即 terminate + close，不等后代自己退出。

> 最初实现是每 owner 一个 job。上面这条规则就是本机 e2e 里 ripgrep 一直 `assign failed status=5` 的根因：编辑器在 job 内启动时，除每 owner 的第一个子进程外全部降级。对照实验：同一个 rg 进程 assign 到旧 job 返回 5，assign 到一个新建空 job 立刻返回 0。

- assign 失败（`ACCESS_DENIED=5`：已处于不兼容 job / 进程正在退出 / 受保护进程；`87`：pid 不存在）**不抛、不阻塞 spawn**，降级为「已登记但未受控」，回收时走 `taskkill /T` / 进程组兜底。
- `1067`（`ERROR_PROCESS_ABORTED`）与 `87` 是短命进程的正常竞态（ripgrep 处理小目录时寿命可能只有几十毫秒，assign 可能落在它退出前后），日志降到 debug；其余错误码打 warn。
- 绝不 assign main 自己（`assign` 在原生层拒绝并返回 -1）；不用 breakaway。

## 组成

- `packages/process-job/`：极小的 Windows-only N-API addon（`createJob/assign/terminate/close/listPids`，句柄走 BigInt）。`install` 即 node-gyp 构建，非 win32 跳过；`CI=true` 或 `--require` 时构建失败直接报错，`UNIVERSE_SKIP_NATIVE_BUILD=1` 跳过。`listProcesses`（全量 pid→ppid 快照）是**可选导出**：旧 addon 缺失时只禁用孤儿清扫，job containment 不受影响。`waitForProcessExit(pid)`（异步，线程池里 `WaitForSingleObject`）供退出码 watchdog 使用，**不参与** job containment；watchdog 自身 `detached` spawn 以逃出 libuv 全局 job，也从不登记进 registry；干净退出时由 main 在 `before-quit` 里 `stop()` 并等待回收（存活的子进程会让 Electron 原生 teardown 永远等下去），崩溃/强杀则走不到这里，记录仍由 watchdog 完成。
- `packages/node-services/src/process/processLifecycle.ts`：`ProcessLifecycleRegistry`。owner = `{window,id}` 或 `app`，role 是字符串标签；slot 按 owner 聚合条目与 job 句柄（Windows 上每个进程树一个 job，见上）。`startOrphanSweep()` 启动 P1 的定时清扫（见下）。
- `jobBackend.ts`：加载 addon，缺失 / 形状不对 / `UNIVERSE_DISABLE_PROCESS_JOB=1` 时返回 `undefined`（全部降级，行为等同改动前）。
- `ManagedChildProcess` 的 `lifecycle: { registry, owner, role, stop, reapDescendantsOnRelease }` 选项：构造即登记、退出即释放；`stop: 'stdin-eof'`（ext host）回收时先关 stdin，宽限后升级为 kill；`reapDescendantsOnRelease` 透传为跟踪条目的释放语义。
- `apps/editor/src/main/services/process/processLifecycle.ts`：进程单例 + `initProcessLifecycle()`（main 启动时调用一次，`will-quit` 里 `dispose()`）。

各服务**不再自己维护 `_windowByHandle`**：spawn 时传 `owner`，`windowMainService` 只调 `processLifecycle.reclaimOwner(windowOwner(id), { reason, retire })`。

## 回收顺序（`reclaimOwner`）

1. 同步摘下 owner 槽位（reload 后同 id 新一代进程不会被误杀）。
2. 对每个有 `target` 的条目 `requestStop()`（stdin EOF / SIGTERM / pty.kill），等待至多 `graceMs`（默认 2500ms）。
3. 仍存活的：Windows 对该 owner 的每个 job `TerminateJobObject` + `CloseHandle`；POSIX 组杀；未受控条目，以及 `TerminateJobObject` 失败的条目，走 `target.hardKill()` / `killPid` 兜底。job 关闭后条目上的句柄立即失效，进程稍后的退出回调不会再去操作可能已被复用的句柄。
4. `retire: true`（窗口真正关闭）之后该 owner 的 `track` 返回 `rejected`，在途 spawn 自行杀掉自己。
5. 回收在宽限期内就可能与应用退出重叠：`dispose()` 会同时硬杀已从 `_slots` 摘除、仍在等待宽限的 slot（POSIX 上没有 OS 兜底）。

## ACP agent 释放即回收（P0）

ACP agent 的跟踪条目带 `reapDescendantsOnRelease`（`acpHostMainService.ts` 的 lifecycle 配置，唯一开启点）。agent 进程退出（无论是正常退出、崩溃还是会话关闭）触发 lease release 时，registry **无条件** `TerminateJobObject` + `CloseHandle`，把 agent 树上所有后代（bash、grep、后台任务进程）一并回收，而不是等 owner 回收或应用退出。

为什么需要它：CLI 的 `TaskStop` 在 Windows 上只杀 bash 包装层，grep/head 等后代继续跑；旧行为见 job 里还有后代就保留，这些孤儿能活到窗口关闭。2026-11-05 的残留进程事故（两个进程跑了近 4 小时、读了 805 GB）就是这条链路。

POSIX 不改为立即组杀：已有 5 秒有界组杀兜底，立即杀可能打断子进程收尾；Windows 才是永久残留问题。标志默认 `false`，只有 ACP agent 开启，MCP / ext host / pty / ripgrep / remote / ACP terminal 语义不变。

## 孤儿清扫（P1）

即使有 P0，agent 存活期间仍可能产生孤儿：`TaskStop` 杀掉 bash 后，grep/head 的父进程已死，但它们还在 agent 的 job 里活着（P0 要等 agent 退出才触发）。`startOrphanSweep()` 在 main 启动时注册一个 unref 的定时器（默认 30s），只检查带 `reapDescendantsOnRelease` 的 job：

1. 先做廉价预检：没有任何 reap job 时直接返回，不取快照。
2. 用 addon 的 `listProcesses()` 取一次全量 pid→ppid 快照。
3. 对每个 reap job 的 `listPids(job)` 成员，杀掉满足「不是 job 根、不是 selfPid、pid>0、在快照里有 ppid、ppid>0 且 ppid 不在快照中」的进程；成员自己不在快照里、或父 pid 被复用为其他活进程时都保守跳过（安全优先，P0/owner 回收仍是兜底）。
4. 杀完后复查 `listPids(job)`：为空且根也不在快照中时才 `CloseHandle`，避免 `listPids` 异常返回空时误关仍含活根的 job。

默认 30s，`UNIVERSE_ORPHAN_SWEEP_MS=<正整数>` 覆盖，`UNIVERSE_DISABLE_ORPHAN_SWEEP=1` 关闭；非 win32、无 backend、旧 addon（无 `listProcesses`）时自动 no-op。`dispose()` 清理定时器。

## 覆盖的 spawn 点

ext host、ACP agent、ACP terminal、MCP stdio、pty（`ptyHostService`）、ripgrep（文件/文本搜索）、file watcher utility、remote-direct / ssh-forward 的本地侧进程。remote-server 的 ext host 子进程用进程组 + `killProcessTree` 兜底（server 不带 addon）。

## 取舍与非目标

- **pty 里用户启动的 GUI 程序会随窗口一起死**：job 无 breakaway，shell 的所有后代都在 job 内。这是「不残留」的必然代价。
- **agent 自己拉起的、有意脱离的守护进程**同理会被带走。
- `hostMainService` 的 detached 启动（打开外部程序）不在范围内，它们本就应该脱离编辑器。
- POSIX main 崩溃不由本机制保证（见上表）。
- POSIX 上 leader 退出后仍有后代的进程组会保留 5 秒再回收（`ORPHAN_GROUP_REAP_MS`），避免长期持有的 pgid 被 OS 复用后误杀无关进程组；若 5 秒内该 pid 被别的 owner 重新登记，则只丢弃旧 pgid、不发信号（否则会误杀新进程组）。
- Windows 上树里仍有后代时 job 会保留到后代退出后的下一次复查，最迟 owner 回收；app owner 没有中途回收点，极端情况下保留到应用退出（仅影响句柄数量，不影响语义）。ACP agent 例外（P0）。
- **P1 会杀掉 ACP agent 树里「父进程已退出但有意常驻」的后代**：判定只看 ppid 是否还在快照中，无法区分「孤儿」和「主动脱离父进程的守护进程」。只对带 `reapDescendantsOnRelease` 的 job 生效，其他 spawn 点不受影响。
- **父 pid 被复用时会漏杀**：sweep 把「ppid 指向活进程」视为父仍存活而跳过；这类孤儿靠 P0 / owner 回收兜底。`taskkill /pid <pid> /T /F` 从判断到执行之间也存在 pid 被回收的窄窗口，与现有 `_killUncontained` 同类风险。
- **sweep 的 `taskkill /T /F` 是同步调用**：30s 一次，且只在存在 reap job 时才取快照；若日后出现主线程卡顿证据再改异步。
- 关闭终端标签会 `release()` 跟踪并随后 `pty.kill()`：Windows 上 job 里只剩 shell 时关闭 job 即结束它；若还有后台子进程则 job 保留到窗口回收（后台进程继续存活）。POSIX 上进程组在 leader 退出 5 秒后被组杀。两条路径不完全对称，别依赖「关标签」清理后台进程。
- `remote-direct` / `ssh-forward` 在 POSIX 上只做进程级登记（未建进程组），不是树级回收；Windows 由 job 覆盖。
- 故意不接入的短命 spawn：`defaultRemoteRunner`（ssh/scp/tar，自带超时）、版本探测、PowerShell 剪贴板、processList、WER、WSL 探测、`hostMainService` 的 detached 外部程序。
- reload 期间旧 renderer 的在途 spawn 可能登记进新一代槽位（registry 不做 epoch 校验），下一次回收或应用退出时才会清掉；旧实现同样存在该窗口。
- remote server 不分发 addon；server 侧靠进程组。

## 排障

- 日志频道 `Process Lifecycle`：`process lifecycle ready jobBackend=true|false`、`job assign failed ... status=N`（debug 级有 `job assign ok`）。
- `status=5` 偶发出现在短命进程（正在退出）上属正常；**大量/持续**出现说明目标进程已被某个不兼容的 job 收编（例如老版本每 owner 共用一个 job 时，编辑器自身在 job 内启动的场景），检查 `docs/development/process-lifecycle.md` 的嵌套 job 规则。
- 关掉机制对照：`UNIVERSE_DISABLE_PROCESS_JOB=1`。
- 孤儿清扫：`job terminate on release ...` 是 P0 的释放回收；`orphan sweep ...` 是 P1 的清理日志。`UNIVERSE_ORPHAN_SWEEP_MS=<ms>` 缩短间隔便于复现，`UNIVERSE_DISABLE_ORPHAN_SWEEP=1` 关闭。旧 addon（无 `listProcesses`）启动时会有一条 warn，P1 自动禁用而 P0 仍生效。
- addon 路径：dev `packages/process-job/build/Release/process_job.node`；打包 `resources/process-job/process_job.node`（`runtime-resources.mjs` 在 win32 上 stage 并校验，缺失即打包失败）。

## 测试

- 单测：`packages/node-services/src/process/__tests__/processLifecycle.test.ts`（mock backend）；`packages/process-job/test/processJob.test.mjs`（真 OS，Windows-only，CI 在 E2E Windows 作业里跑 `pnpm --filter @universe-editor/process-job test` 作门禁——Linux 的 `ci` 作业里这些用例全部 skip）。
- e2e：`apps/editor/e2e/specs/smoke.processLifecycle.spec.ts`。关窗用例跨平台，但 Windows 上它**不区分有无 job**（`treeKill` 的 `taskkill /T` 也能杀净），守的是整体回收链路；POSIX 上它验证进程组。**强杀 main 用例仅 Windows**，agent 夹具用 `ECHO_AGENT_IGNORE_STDIN_EOF=1` 屏蔽 stdin-EOF 看门狗，所以只有 job 能让它通过（`UNIVERSE_DISABLE_PROCESS_JOB=1` 时该用例失败，作为对照）。注意取 main pid 要用 `electronApp.evaluate(() => process.pid)`。
- **P0 用例**（`an agent exiting on its own reaps its tree at release`，Windows-only，fixture `UNIVERSE_DISABLE_ORPHAN_SWEEP=1`）：agent 用 `ECHO_AGENT_EXIT_AFTER_MS` 自行退出，孙进程用 `ECHO_AGENT_TREE_VIA_WRAPPER=1` 经 PowerShell 启动。必须走 wrapper——每个 Node 进程有一个 libuv 全局 job（`SILENT_BREAKAWAY_OK`，只显式收编它直接 spawn 的子进程），agent 退出会级联清理直接 spawn 的孙进程并造成假阳性；wrapper 孙进程只挂在编辑器的 job 下，只有释放回收能杀掉它。关掉 sweep 是为了让这 12s 断言只归因于 P0（否则慢速 CI 上 30s 的 sweep tick 可能抢先清掉孤儿）。去掉 `reapDescendantsOnRelease` 时该用例失败，作为对照。
- **P1 用例**（`smoke.processLifecycleOrphan.spec.ts`，Windows-only，scoped fixture `UNIVERSE_ORPHAN_SWEEP_MS=400`）：`ECHO_AGENT_ORPHAN_FILE` 让 agent 经 PowerShell 中间进程启动 sleeper，中间进程保持 3 秒再退出（给 spec 留出「父还活着、sweep 不杀」的观察窗口），随后 sleeper 成为「父已死但仍在 job 内」的孤儿；同时 `ECHO_AGENT_PID_FILE` 的直接孙进程（父 agent 存活）必须保留。`pnpm` 侧可用 `UNIVERSE_DISABLE_ORPHAN_SWEEP=1` 做失败对照。
- 手工遗留检查：强杀失败时用例会留下 `echoAgent.cjs` 的 node 进程，需手动清理。
