---
name: agent-binary-silent-download-e2e-fix
description: "e2e 弹 \"Failed to start agent\" 噪音通知 + 之后修复引出的 Worker teardown timeout 回归全链路排查；根因链=misrouted binary guard→silent 通知→背景 prefetch 真下载"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3d49b0d2-fa51-4982-b374-9f7b6f7f7797
---

**症状 1（起点）**：e2e 每个 worker 全新 profile，`FirstRunAgentOnboardingContribution` 触发 hydrate，`AcpSessionRestoreCoordinator._hydrateOneAgent` 对 claude-code/codex 都 best-effort `connect()`，失败时无条件弹 `INotificationService.notify`（"All errors are swallowed" 文档注释与实现不符）。附带 bug：`_ensureClaudeBinary` 用 `spec.runAsNode` 而非 `agentId` 判断，导致 codex 也误入 Claude 二进制解析分支，报错张冠李戴（两条通知都提 `claude-binary.json`）。

**修法 1**：`AcpClientService.connect(agentId, { silent?: boolean })`，`_createEntry` catch 分支 `silent` 时跳过 notify（仍 telemetry+throw）；`_ensureClaudeBinary`/`_ensureCodexBinary` 守卫改按 `agentId`；hydrate/`deleteOnAgent` 两处背景探测调用传 `silent: true`。

**症状 2（修复 1 引出的真回归）**：`_ensureClaudeBinary` 守卫修对后，codex 的 hydrate 探测终于走到真正的 codex 二进制解析路径（此前一直被误路由到必然 ENOENT 的 claude 分支，意外掩盖了问题）。e2e 沙盒有真实网络，`acp.codex.source`/`acp.claude.source` 默认 `'download'`，于是每次 hydrate 都会真的尝试下载 ~300MB codex / ~226MB claude 二进制，导致 Playwright `Worker teardown timeout of 30000ms exceeded` 大面积复现（几乎每个 worker 都在跑到 smoke.terminal/smoke.viewMove 附近死掉）。

**修法 2a（不够）**：给 `codexBinaryMainService.ts`/`claudeBinaryMainService.ts` 的 `fetch` 加 `AbortSignal.timeout` 只挡"连接不上"阶段，body 流式下载本身故意不设上限（合理需求：真下载可能要几分钟）——但沙盒网络能连通，body 阶段照样会真下载，此修法治标不治本。

**修法 2b（真正生效）**：给 `ICodexBinaryResolveOptions`/`IClaudeBinaryResolveOptions` 加 `allowDownload?: boolean`（默认 true）。两个 main service 的 `_resolveDownload` 在 cache miss 时，`allowDownload===false` 直接快速失败而不碰网络；`resolve()` 的 `_inflight` key 按 `allowDownload===false` 单独加后缀，避免背景探测的 fast-fail promise 被并发的真实下载调用方误复用。`AcpClientService._ensureClaudeBinary`/`_ensureCodexBinary` 按 `silent` 传 `allowDownload: !silent`。

**症状 3（同一会话内独立发现的第二个真下载来源）**：`AgentBinaryPrefetchContribution`（`renderer/contributions/registration/eventually.ts` 注册于 `WorkbenchPhase.Eventually`，`runWhenIdle` 触发）与 hydrate 完全无关，**无条件**对 claude/codex 调用 `.prefetch()`——这是真实的后台下载，且 `prefetch()` 语义上就该下载，不受 `allowDownload` 网关约束。e2e 每个 worker 全新 profile + 默认 `download` source，每次启动空闲期都会触发一次真下载，是比 hydrate 更直接、更早触发的 teardown 卡死来源。此 contribution 是本会话之前就存在的代码（非本次改动引入），但从未针对 e2e 场景验证过。

**修法 3**：复用仓库已有的 e2e 探针门禁模式（`window[E2E_PROBE_ENABLED_KEY] === true`，`SessionShutdownParticipant.ts`/`windowActions.ts` 已用同样写法）：`AgentBinaryPrefetchContribution._run()` 在此标志为真时跳过 `_prefetch()`（网络下载），保留 `_cleanup()`（纯本地 `readdir`/`rm`，无网络，可以放心跑）。

**验证**：`pnpm check` 35/35 绿；`pnpm e2e` 全量跑（含 @p0+@p1 全部 151 个测试）**全部 passed**，之前必现的 smoke.terminal/smoke.viewMove 早死模式完全消失。

**残留噪音（后续证实是真 bug，已修）**：上一轮判为"已知 Windows-only 环境噪音"的偶发 `Worker teardown timeout` 其实是**真回归**，见下方症状 4。判别失误教训：`app.close()` 卡住 = 有子进程孤儿持管道不放，"所有测试 passed + 位置随机"**不足以**判定为环境噪音，必须实测残留进程（`Get-CimInstance Win32_Process | Where CommandLine -like '*tsserver.js*'`）确认是谁在挂。

**症状 4（真根因，本会话彻底修复）**：`pnpm e2e` 全部测试 passed 但偶发（约每 2 次 1 次）`Worker teardown timeout of 30000ms exceeded`。用 System Informer / PowerShell 枚举发现残留的永远是 `electron.exe` 跑 `tsserver.js`（父进程已 DEAD），1–4 个不等，SEMANTIC/SYNTAX 都出现过。**关键背景**：tsserver 只在语言符号预热（`LanguageServicePrewarmContribution`，commit ba60c0c0/f9a770ea）落地后才会在 e2e 里真正 spawn——预热前 tsserver 根本不运行，所以这个 teardown 卡死是预热特性引入的。

**进程链**：main → extension host（`ELECTRON_RUN_AS_NODE` 的 electron-as-node）→ `typescript` 内置插件在 host 内 `spawn` 出 vendored `typescript-language-server` 的 CLI（`vendor/typescript-language-server/.../lib/cli.mjs`，同样 electron-as-node）→ CLI `fork` 出 tsserver ×2（syntax `--serverMode partialSemantic` + semantic）。

**根因（读 vendored cli.mjs 定论）**：CLI **只在优雅退出时**回收 tsserver——它在 `process.on('exit', () => this.shutdown())`（cli.mjs:23895）里 kill tsserver，并有两条优雅触发：① `input.on('end'/'close') → process.exit`（stdin EOF，cli.mjs:11619）；② watchdog 每 3s `process.kill(clientProcessId, 0)` 探父进程存活、死了就 `process.exit`（cli.mjs:11497）。而 `process.on('exit')` 在 **SIGKILL / `taskkill /F` 时根本不跑**。原实现里 extension host 用 `treeKill: true`（`taskkill /T /F`）硬杀，`/T` 会连 CLI 一起 TerminateProcess，跳过它的 exit hook，**且**把"启动较慢的 semantic tsserver"甩出 `taskkill /T` 的 PID 快照 → tsserver 变孤儿（父 CLI 已死），持有继承来的管道不放 → `app.close()` 永不 resolve → 30s teardown 超时。孤立复现验证：clean slate 下 `stdin.end()` 优雅关 CLI 100% 回收 tsserver；`taskkill /F` 硬杀则残留。

**修法（多层，各司其职）**：
- **`extensions/typescript/src/lspClient.ts` `dispose()`**：从 `taskkill /T /F` 改为 `proc.stdin.end()`——让 CLI 看到 EOF 跑自己的 exit hook 回收 tsserver（对齐 vendored CLI 的设计）。
- **`ManagedChildProcess`**：加 `endStdin()`（优雅关子进程 stdin）；`TreeKiller` 加 `sync?` 参数，`dispose()`（同步 will-quit 路径）走阻塞 `execFileSync` tree-kill 兜底。
- **extension-host `bootstrap.ts`**：`process.stdin.on('end'/'close')` + `SIGTERM` → 幂等 `shutdown()` → `liveService.dispose()`（deactivate 扩展 → 级联到 typescript 插件的 `client.dispose()`）→ `process.exit(0)`；配套 `extensionService.dispose()` + `activationService.disposeAll()`。
- **`extensionHostMainService`**：加 `stopAll()`（优雅关所有 host 并 **await** 各自 exit，供异步 `before-quit` 用）；`stop()` 也改优雅（`endStdin` + grace 定时兜底）；spawn 仍保留 `treeKill: true` 作硬兜底。`before-quit`（异步、能 await）里 `app.quit()` 前 `await extensionHost.stopAll()` 走完级联。
- **`apps/editor/src/main/index.ts` `before-quit`**：真实用户退出走 `stopAll()` 级联；`will-quit`（同步）保留 `rootInstantiation.dispose()` 硬兜底。
- **⚠️ e2e 关键**：Playwright 的 `app.close()` **直接 SIGKILL main、根本不跑 before-quit/will-quit**（实测 main.log 只到 `create application services` 就没了），所以上面所有 in-app 钩子在 e2e 里是**死代码**（只对真实用户生效）。e2e 唯一能修的地方是 fixture：`electronApp.ts` 新增 `killOrphanedLanguageServers()`——扫所有 `electron.exe` 跑 `tsserver.js|typescript-language-server` **且父进程已死**的孤儿并杀掉，在 `closeApp` 超时兜底里 `forceKillTree` 之后调用。为什么 `forceKillTree` 不够：它只按根 PID 走后代树，而优雅级联恰恰会先杀 CLI 让 race-spawn 的 semantic tsserver **脱离** main 的进程树，后代遍历扫不到它。跨 worker 安全：活着的 worker 其 tsserver 的父 CLI 还活着，不匹配"死父"过滤。

**验证**：`pnpm check` 36/36 绿；`pnpm e2e` 连跑 3 次全部 151+3 passed、**零 Worker teardown timeout、零 tsserver 残留**（修复前约每 2 次必现 1 次）。

相关：[[codex-session-skills-scan-slow]]（同样是 vendored 进程在 Windows 上的疑难，改不了 vendor 只能从外围治）、预热特性 commit ba60c0c0/f9a770ea。

相关：裸 `electron.launch` 报 "Process failed to launch!" 的 Windows-only 环境 flake（本条是 fixture 正常关闭时的 teardown 超时，两者均 Windows-only 但触发机制不同）详见 skill `fix-ci-e2e-flake` 案例 28。
