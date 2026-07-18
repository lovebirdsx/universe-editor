# apps/editor/e2e/CLAUDE.md

Playwright + `_electron` 冒烟栈。跑的是 `out/` 打包产物，通过 `window.__E2E__` 探针驱动服务，**不戳 DOM 内部**。

> 「怎么新建一个 spec / 定位优先级 / 扩探针」见 `apps/editor/CLAUDE.md` 的**套路 F**——不在此重复。本文件讲**本目录独有的东西**：选哪套 fixture、PO 分层、tag 体系、脚本矩阵、踩坑。

## 目录结构

```
fixtures/     两套 Electron 启动 fixture 的**薄 shim**(见下)+ 扩展专属 fixture(perforce/swarm)
pages/        WorkbenchPO.js **薄 shim**,re-export 自 harness
specs/        smoke.*.spec.ts(+ 1 个 visual.*.spec.ts)
baselines/    视觉回归基线截图(仅 Linux CI 生成,勿在本机更新)
test-results/ 运行产物(trace/video/screenshot),勿提交
playwright.config.ts  timeout/retries/workers(CI vs 本地分流)
RUNBOOK.md    已知 flaky 登记:根因 + workaround + 判定标准
```

> **基座已抽包**:通用 driver(两套 fixture 工厂 + 6 个 PO + `expectNoLeaks`/`evaluateWhenRestored` + 启动契约)住在 `packages/e2e-harness`;探针类型契约(`E2EProbe` + `window.__E2E__` 全局 + 运行时 key 常量)住在零依赖包 `packages/e2e-contract`(app 与 harness 共享,单一事实源)。本目录的 `fixtures/electronApp.ts`、`fixtures/sharedApp.ts`、`pages/WorkbenchPO.ts` 都只是把 harness 工厂**绑定到本 app 的 `out/` 产物路径**的薄 shim,spec import 路径不变。改通用 driver → 改 `packages/e2e-harness`;改探针接口 → 改 `packages/e2e-contract`(app 的 `src/shared/e2e/contract.ts` 是它的 re-export barrel)。

## 选哪套 fixture（关键决策）

| fixture | 启动模型 | 用于 | import |
|---|---|---|---|
| `fixtures/sharedApp.ts` | **每 worker 一个** Electron，测试间 reload window + 重写 userData 复位 | 状态只活在 renderer（editor model / layout / quick input / history）；**默认首选**，冷启动 ~2.5s 被摊薄 | `from '../fixtures/sharedApp.js'` |
| `fixtures/electronApp.ts` | **每个 test 冷启一个** Electron | 触碰 main 进程状态：多 BrowserWindow、terminal PTY、ACP session、重启/恢复类；reload 不会拆 main 态 | `from '../fixtures/electronApp.js'` |

判据：**window reload 能不能把状态复位干净？** 能 → `sharedApp`；碰了 main 进程持久态 → `electronApp`。选错 `sharedApp` 会让上一个测试的 main 态（幽灵窗口/PTY/session）泄漏进下一个测试。

**自启动 spec**：需要完全掌控启动参数（多窗口、二次启动）的用例直接 `_electron.launch`（见 `smoke.windows.spec.ts`）。此时：
- 必须先解构去掉 `ELECTRON_RUN_AS_NODE`（Claude Code shell 注入，会让 Electron 退化成纯 Node 拒绝 Chromium flag）——照抄 fixture 里的 `const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env`。
- 自己 new 出来的窗口 fixture 不管，收尾要手动对**每个活窗口** `expectNoLeaks(page)` + `closeApp(app)`（都从 `WorkbenchPO.js` / `electronApp.js` 导出）。

两套 fixture 都统一：pin `workbench.language=en-US`（断言确定性）、`update.mode=manual`（更新状态机默认 idle）、标记 `welcome.agentOnboarding.seen=true`（默认布局确定）。要覆盖首启引导，自启动一个未 seed 的实例（见 `smoke.agentOnboarding.spec.ts`）。

## PO 分层

`WorkbenchPO`（`pages/WorkbenchPO.js`）是入口，聚合 `activityBar / sideBar / statusBar / quickInput / editor / panel` 六个子 PO，外加一批**直通探针的快捷方法**：`runCommand` / `getContextKey` / `lifecyclePhase` / `openWorkspace` / `getActiveEditorUri` / `getEditorGroupCount` / `waitForRestored` …。

- 加通用交互能力 → 加到对应子 PO 或 `WorkbenchPO`，别在 spec 里散写 `page.evaluate`。
- `expectNoLeaks` / `evaluateWhenRestored` 是**模块级导出**（非实例方法），给自启动 spec 复用同一套 context-teardown 加固——别自己裸写 `page.evaluate(whenRestored)`。
- 重启类断言用 `workbench.waitForRestartRestore()`，**不要**裸 `runCommand + waitForRestored`（重启是 IPC-async，waitForRestored 会在旧页面上提前 resolve）。

## 泄漏门禁（自动）

两套 fixture 的收尾都跑 `expectNoLeaks`：卸载 React 后快照 Disposable tracker，**有泄漏就 fail 测试**。写代码时 disposable 没 `this._register` 会在这里被抓（先例：opener-service 的 built-in opener 泄漏全红）。`sharedApp` 把门禁挂在 `_leakGate`（auto fixture），所以只拉 `page`/`electronApp` 的 spec 也被覆盖。

## tag 体系与脚本

tag 打在**用例级** `test('... @p0')` 标题末尾（`@regression` 尤其是单用例级，不打在 `describe` 上）。

| tag | 含义 | 本地 `pnpm e2e` | CI |
|---|---|---|---|
| `@p0` | 核心冒烟，失败**阻塞** CI | ✅ 跑 | 并行趟 shard×2 |
| `@p1` | 一般冒烟，阻塞 | ✅ 跑 | 并行趟 shard×2 |
| `@regression` | 守护已修复 bug（非主路径冒烟） | ❌ 排除（保持轻快） | 单独并行趟 |
| `@serial` | 跨进程 native 竞态需隔离 | ✅ 但 `--workers=1` 串行趟 | 单独串行趟 |
| `@flaky` | headless 偶发（如 DnD） | 排除 | 单独趟 `continue-on-error`，不阻塞 |
| `@perf` | 启动性能观测 | 排除 | 单独趟，写 metrics 工件 |
| `@visual` | 视觉回归 | 排除 | 默认排除，需显式跑 |

**何时打 `@regression`**：该用例只为守护某个已修复 bug、不是命令主路径/协议/导航入口的冒烟。核心主路径留主趟。

脚本（`apps/editor/package.json`，前缀 `pnpm --filter @universe-editor/editor`；**根 `pnpm e2e` 会先 `pnpm build`**，子包级不会）：
```bash
pnpm e2e            # 主门禁：并行趟(排除 visual/serial/flaky/perf/regression) + @serial 串行趟
pnpm e2ea          # 全量（含 regression），根级 `pnpm e2ea` 前置 build
pnpm e2e:regression # 只跑 @regression
pnpm e2eg -- "@p0"  # 按 grep 跑（透传 --grep 值）
pnpm e2e:ui         # 本地交互调试
pnpm test:visual / visual:update  # 视觉基线（仅 Linux CI 更新，见 baselines/README.md）
```

## 踩坑（本目录高频）

> 排查「CI 偶发挂、本地稳过」的 flaky（区分真回归 vs 环境噪音、读 call log 失败形态、鲁棒化断言）有专门的 skill **`fix-ci-e2e-flake`**——它的案例库 + 速记是 flaky 知识的单一事实源（parcel watcher 多 worker 崩溃、异步 ACP prompt、裸 launch "Process failed to launch"、scroll 恢复过冲…都在里面)。遇到 flaky 先查它。

- **诊断前先 `pnpm build`**：子包级 playwright **不 rebuild**，`out/` 可能过期。只有根 `pnpm e2e` 先 build。
- **异步 ACP 会话**：`sendAcpPrompt` 的 await **不等** echo 流式回复渲染完。依赖 timeline 高度/虚拟化/滚动的断言前，先 `expect.poll` 等消息数到位 + 高度收敛（详见 skill `fix-ci-e2e-flake` 速记 24 / 案例 15）。
- **可见性别用 `toBeVisible()`**：Allotment.Pane 用 CSS visibility 隐藏后代，DOM 可见性会误判。走 ContextKey + `expect.poll`。
- **长任务命令 fire-and-forget**：`showCommands` 之类内部 await 用户输入的命令必须 `void window.__E2E__!.runCommand(id)`，否则死锁。
- **URI fsPath 用正斜杠**：本代码库 `URI.fsPath` 返回正斜杠，比对临时目录路径先 `.replace(/\\/g, '/')`。
- **真回归 vs 环境噪声**：失败先查 `RUNBOOK.md`——本机 Windows 裸二次启动的 `Process failed to launch!`、markdown/TS LSP 本机未就绪、parcel watcher 多 worker 崩溃都是**已登记的环境 flake**，别当回归改产品代码。深度排查流程与案例走 skill `fix-ci-e2e-flake`。新发现一类 flaky → 在 `RUNBOOK.md` 登记一行 + 往 skill `fix-ci-e2e-flake` 追加案例。
- **禁止**在 spec 里 mock main/renderer 服务；**禁止**断言 Monaco 内部 DOM（拿状态走 `getActiveEditorUri()` 等探针）。
