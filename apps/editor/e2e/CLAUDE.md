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

> **本目录只放核心 spec**:扩展专属的 e2e 已物理迁到各扩展目录 `extensions/<ext>/e2e/`(perforce/markdown/typescript/ai),各自带 `playwright.config.ts` + `e2e` script + scoped fixture(传自己的 `extensions: [...]` allowlist)。删扩展即删其测试。新增扩展 e2e 照抄 `extensions/markdown/e2e/` 结构。

## 最小扩展集启动（P2 基线）

harness 的启动 fixture 接收 `extensions: string[]`(扩展 id allowlist),拼进 launch env `UNIVERSE_ENABLED_EXTENSIONS`,bootstrap 只激活列表内扩展 + 核心 built-in。**本目录 core fixture 基线是 `extensions: []`**——核心 spec 默认不启任何扩展,冷启动不 spawn tsserver / markdown-LSP,消除大半 LSP-warmup flake。

少数核心 spec 需要某扩展来**搭建**其(核心 UI 的)测试场景,走 scoped fixture(基线 `[]` 之上只加所需扩展):

| scoped fixture | allowlist | 用于 |
|---|---|---|
| `fixtures/coreGitApp.ts` | git | dirtyDiffPeek(quick-diff 色条)、vscodeKeybindings(键位 reload 哨兵)。含 `launchCoreGitApp()` 供自启动 spec 用 |
| `fixtures/coreTypescriptApp.ts` | typescript | peekPreview(跨文件引用预览,冷启) |
| `fixtures/coreTypescriptSharedApp.ts` | typescript | outline(跨文件切换的符号,shared 复用) |
| `fixtures/coreMarkdownApp.ts` | markdown | peekNavigation(跨文件 md 链接定义) |

> 注意区分:markdown/mermaid **预览渲染是核心**(`src/renderer/workbench/markdown/`),ACP/agents 亦是核心——它们的 spec 用基线 `[]` 即可,**不需要** markdown/ai 扩展。只有 LSP(符号/定义/诊断)、SCM(quick-diff/git 命令)、tsserver 语义这些**扩展提供的能力**才需 scoped fixture。

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

tag 打在**用例级** `test('... @p0')` 标题末尾（`@regression` 尤其是单用例级，不打在 `describe` 上）。**过滤策略集中在共享 config**（`packages/e2e-harness/src/playwrightConfig.ts` 的 `grepOptions`），core 与**每个扩展**同一套——script/CI **不传 `--grep`**，只翻两个 env：`UNIVERSE_E2E_INCLUDE_REGRESSION=1`（把 @regression 并回主趟，即 `e2ea`）、`UNIVERSE_E2E_ONLY_TAG=<tag>`（只跑某 tag，用于 serial/regression/flaky/perf/visual 独立趟）。加/改 tag 分流只改这一处。

> **坑：裸 `playwright test --grep "<标题>"` 想跑某个用例却报 `No tests found`。** 因为 config 默认设了 `grepInvert`（排除 @visual/@flaky/@perf/@serial/@regression），你的 `--grep` 与它**取交集**——若目标用例带这些 tag（如 `@regression`）就被过滤空。要跑：① 调试用 `pnpm e2eg "<标题>"`（设 `UNIVERSE_E2E_NO_TAG_FILTER=1` 关掉默认排除，能选中任意 tag）；② 或前缀 `UNIVERSE_E2E_ONLY_TAG=@regression` 再 `--grep`。

| tag | 含义 | 默认 `pnpm e2e` | CI |
|---|---|---|---|
| `@p0` | 核心冒烟，失败**阻塞** CI | ✅ 跑 | 并行趟 shard×2 |
| `@p1` | 一般冒烟，阻塞 | ✅ 跑 | 并行趟 shard×2 |
| `@regression` | 守护已修复 bug（非主路径冒烟） | ❌ 排除（`e2ea` 并回） | 单独并行趟 |
| `@serial` | 跨进程 native 竞态需隔离 | 单独 `--workers=1` 串行趟 | 单独串行趟 |
| `@flaky` | headless 偶发（如 DnD） | 排除 | 单独趟 `continue-on-error`，不阻塞 |
| `@perf` | 启动性能观测 | 排除 | 单独趟，写 metrics 工件 |
| `@visual` | 视觉回归 | 排除 | 默认排除，需显式跑 |

**何时打 `@regression`**：该用例只为守护某个已修复 bug、不是命令主路径/协议/导航入口的冒烟。核心主路径留主趟。

脚本分两层——**根级 `pnpm e2e` 走 turbo 缓存跑全量（core + 所有扩展）**；子包级（前缀 `pnpm --filter @universe-editor/editor`）只跑 core，但也前置了 build 守卫（裸跑自动刷新 `out/`，不缓存 e2e 结果）：
```bash
# 根级（走 turbo 缓存，自动 build 依赖链）
pnpm e2e            # 全量：core（默认主趟排除特殊 tag + @serial 串行趟）+ 所有扩展，串行、缓存
pnpm e2ea          # 含 @regression 的全量（turbo `e2ea` task，独立缓存条目）
pnpm e2e:force     # 忽略缓存强制真跑（复跑 flaky 用），build 仍走缓存不重复
pnpm e2ea:force    # 同上，含 @regression
pnpm e2e:ext @universe-editor/<ext>   # 只跑单个扩展 suite（turbo 自动 build 宿主+扩展）

# 子包级（只 core；前置守卫自动 build，但不缓存 e2e 结果——诊断单 spec / 反复调用）
pnpm --filter @universe-editor/editor e2e:regression # 只跑 @regression
pnpm --filter @universe-editor/editor e2eg "<用例标题或grep>"  # 自由 grep 调试（NO_TAG_FILTER，能选中任意 tag）
pnpm --filter @universe-editor/editor e2e:ui         # 本地交互调试
pnpm --filter @universe-editor/editor test:visual    # 视觉基线（仅 Linux CI 更新，见 baselines/README.md）
```

> **`pnpm e2e` 走 turbo 缓存**：core 与扩展 e2e 都是 turbo task，输入未变则命中缓存**不重跑**（缓存 key 含 `editor#build` 的 output hash，改宿主自动令全部下游 e2e 失效）。要无视缓存强制真跑用 `pnpm e2e:force`——它先 `turbo run build`（走缓存）再 `turbo run e2e --force --only`（`--only` 只跑 e2e 不重建 build，避免 `--force` 连带把 editor build 跑多次）。`--concurrency=1` 让 suite 串行，避免多个独立 Electron 并发的资源争抢 flake。

**改了扩展代码要跑单个 suite？** 子包脚本已前置 `scripts/e2e/ensure-e2e-build.mjs`——裸 `pnpm --filter <ext> e2e` 会先 `turbo run build --filter=editor... --filter=<self>...` 把「宿主 + 被测扩展 + 上游」刷新到最新（命中缓存秒过）再跑 playwright，不会再测旧产物。**但首选仍是 `pnpm e2e:ext <包>`**：它走 turbo 的 `e2e` task，连 e2e **结果**都进缓存（输入未变直接返回上次结果，不重跑），且是 CI 与 affected 选择的正道。turbo 的 `e2e` task 声明了对 `@universe-editor/editor#build` 的依赖（e2e 跑 editor 产物 + 从 `extensions/<ext>/dist` 读内置扩展，而扩展不依赖 editor，故显式挂上）：
```bash
pnpm e2e:ext @universe-editor/perforce   # = turbo run e2e --filter @universe-editor/perforce，自动 build 宿主+扩展
# 等价直呼 turbo（可用 glob 简写）：
turbo run e2e --filter '*markdown'
```
core 套件（`@universe-editor/editor#e2e`）走通用 `e2e` task 规则即可：它的 `core*App` scoped fixture 激活 git/typescript/markdown、从其 `dist` 读产物，而这三个扩展是 `@universe-editor/editor` 的 devDependencies（既让 turbo affected 在它们变更时重跑 core，也让 `^build` 自动把它们 build 到最新——见 `scripts/e2e/affected-e2e-matrix.mjs`），无需在 turbo 里为它们单列 `#build`。

## 踩坑（本目录高频）

> 排查「CI 偶发挂、本地稳过」的 flaky（区分真回归 vs 环境噪音、读 call log 失败形态、鲁棒化断言）有专门的 skill **`fix-ci-e2e-flake`**——它的案例库 + 速记是 flaky 知识的单一事实源（parcel watcher 多 worker 崩溃、异步 ACP prompt、裸 launch "Process failed to launch"、scroll 恢复过冲…都在里面)。遇到 flaky 先查它。

- **产物 build 已自动兜底**：`pnpm --filter <ext> e2e`（及 `e2ea`/`e2eg`/core 的 `e2e:regression`/`e2e:ui` 等）前置了 `scripts/e2e/ensure-e2e-build.mjs`，裸跑也会先 turbo build 宿主+扩展+上游再跑，`out/`/`dist/` 不会过期。外部扩展走 `run-external-e2e.mjs`，同样自动先建 editor+host。唯一仍需手动的场景：直接调 `npx playwright test`（绕开 npm 脚本）时守卫不生效——那时先 `pnpm build` 或改走 `pnpm e2e:ext`。
- **异步 ACP 会话**：`sendAcpPrompt` 的 await **不等** echo 流式回复渲染完。依赖 timeline 高度/虚拟化/滚动的断言前，先 `expect.poll` 等消息数到位 + 高度收敛（详见 skill `fix-ci-e2e-flake` 速记 24 / 案例 15）。
- **可见性别用 `toBeVisible()`**：Allotment.Pane 用 CSS visibility 隐藏后代，DOM 可见性会误判。走 ContextKey + `expect.poll`。
- **长任务命令 fire-and-forget**：`showCommands` 之类内部 await 用户输入的命令必须 `void window.__E2E__!.runCommand(id)`，否则死锁。
- **URI fsPath 用正斜杠**：本代码库 `URI.fsPath` 返回正斜杠，比对临时目录路径先 `.replace(/\\/g, '/')`。
- **真回归 vs 环境噪声**：失败先查 `RUNBOOK.md`——本机 Windows 裸二次启动的 `Process failed to launch!`、markdown/TS LSP 本机未就绪、parcel watcher 多 worker 崩溃都是**已登记的环境 flake**，别当回归改产品代码。深度排查流程与案例走 skill `fix-ci-e2e-flake`。新发现一类 flaky → 在 `RUNBOOK.md` 登记一行 + 往 skill `fix-ci-e2e-flake` 追加案例。
- **禁止**在 spec 里 mock main/renderer 服务；**禁止**断言 Monaco 内部 DOM（拿状态走 `getActiveEditorUri()` 等探针）。
