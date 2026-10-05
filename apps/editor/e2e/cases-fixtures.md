# 本文从 e2e/CLAUDE.md 拆出，范围是冷启/共享 fixture 的四个细节专题——自启动 spec、workspaceSeeder、scratchDir、e2e 下的背景下载门禁。

## 自启动 spec

需要完全掌控启动参数（多窗口、二次启动）的用例用 harness 导出的 `launchElectron`（`_electron.launch` 的包装，对 CI 环境瞬时的 `Process failed to launch` 自带重试，见 `smoke.editorRestore.spec.ts`；**不要**再裸调 `_electron.launch`）。此时：

- 必须先解构去掉 `ELECTRON_RUN_AS_NODE`（Claude Code shell 注入，会让 Electron 退化成纯 Node 拒绝 Chromium flag）——照抄 fixture 里的 `const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env`。
- 自己 new 出来的窗口 fixture 不管，收尾要手动对**每个活窗口** `expectNoLeaks(page)` + `closeApp(app)`（都从 `WorkbenchPO.js` / `electronApp.js` 导出）。

两套 fixture 都统一：pin `workbench.language=en-US`（断言确定性）、`update.mode=manual`（更新状态机默认 idle）、标记 `welcome.agentOnboarding.seen=true`（默认布局确定）。要覆盖首启引导，自启动一个未 seed 的实例（见 `smoke.agentOnboarding.spec.ts`）。

## workspaceSeeder：launch 时 pin workspace

**spec 需要 workspace 文件时，用 `workspaceSeeder` 在 launch 时 pin workspace，不要 boot 后 `openWorkspace`**：冷启 fixture 支持 option fixture `test.use({ workspaceSeeder: { seed(dir) { writeFileSync(join(dir, 'a.md'), ...) } } })`，fixture 在 per-test tmp 目录跑完 seed 后把目录作为位置参数随 app 一起启动（`openWindowForFolder`），测试体从 `launchWorkspace.file('a.md')` 取路径。

启动即 pin 让 extension host 保持单代——boot 后 `openWorkspace` 会同回合触发 workspace re-pin + trust-flip revoke **两次 host 重启**，2 workers 争抢时慢重启正是 LSP provider poll 超时与 dying-host Disposable 泄漏的竞态窗口（案例见 skill `fix-ci-e2e-flake`）。

注意 seeder 必须包成 `{ seed(dir) {...} }` 对象——Playwright 会把 `test.use` 里的裸函数当 fixture override 调用（类型层 `TestFixtureValue` 直接 `Exclude<R, Function>`），与 p4Seeds 的裸数组坑同类。仅冷启 fixture 支持（每 test 一个 app 才能各带各的目录）；shared fixture 传 seeder 会直接抛错。

## scratchDir：句柄被持有时的临时目录

**临时目录要被运行中的 app / remote daemon 持有句柄时，用冷启 fixture 的 `scratchDir(prefix?)` 工厂**：它返回 per-test 临时目录，清理在 `closeApp` 之后执行（`electronApp` fixture 依赖 `scratchDir`，利用 Playwright fixture 逆序 teardown，进程树已死、句柄已释放后才 rm）。

典型场景=作为 workspace 打开的根目录（remote daemon 的 watcher 在 Windows 上 pin 住根句柄）；spec 内**禁止**再在 test body 里 `rmSync` 这类目录（Windows 下 EPERM flaky）。范例见 `remote.*` spec。shared fixture 下 `scratchDir` 直接抛错（app 存活跨越测试，没有 post-close 清理点）。

## e2e 下禁背景下载（探针门禁）

`AgentBinaryPrefetchContribution`（Eventually 相位）经 `_prefetchGated()`（`apps/editor/src/renderer/contributions/AgentBinaryPrefetchContribution.ts`）读 `window[E2E_PROBE_ENABLED_KEY]`：e2e 下跳过 `_prefetchLocal()` / `_prefetchRemote()` 的**真下载**，纯本地的 `_cleanupLocal()` / `_cleanupRemote()` 保留——每个 e2e worker 都是全新 profile、无缓存二进制，几百 MB 的后台拉取会和 Playwright worker teardown 抢资源（teardown 没按这个体量设计）。**e2e 下禁一切会拉网络的背景维护任务**。
