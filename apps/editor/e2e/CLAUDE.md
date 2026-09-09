# apps/editor/e2e/CLAUDE.md

Playwright + `_electron` 冒烟栈。跑的是 `out/` 打包产物，通过 `window.__E2E__` 探针驱动服务，**不戳 DOM 内部**。

> 「怎么新建 spec / 定位优先级 / 扩探针」见 `apps/editor/CLAUDE.md` 的**套路 F**。本文件讲**本目录独有的东西**：fixture 选型、PO 分层、tag 体系、脚本矩阵、扩展 suite、踩坑。

> ⚠️ 第一原则：动 e2e 前先分清改的是哪一层——**探针契约**（`packages/e2e-contract`）、**共享 driver**（`packages/e2e-harness`）、**扩展 spec**（`extensions/<ext>/e2e`）、还是**内核 spec**（本目录）。

## 目录结构

```
fixtures/     两套 Electron 启动 fixture 的薄 shim + 扩展专属 fixture(perforce/swarm)
pages/        WorkbenchPO.js 薄 shim，re-export 自 harness
specs/        smoke.*.spec.ts(+ 1 个 visual.*.spec.ts)
baselines/    视觉回归基线截图(仅 Linux CI 生成，勿在本机更新)
test-results/ 运行产物(trace/video/screenshot)，勿提交
playwright.config.ts  timeout/retries/workers(CI vs 本地分流)
```

**基座已抽包**：通用 driver（fixture 工厂 + 6 个 PO + `expectNoLeaks`/`evaluateWhenRestored`）在 `packages/e2e-harness`；探针类型契约在零依赖包 `packages/e2e-contract`（单一事实源）。本目录的 `fixtures/electronApp.ts`、`fixtures/sharedApp.ts`、`pages/WorkbenchPO.ts` 只是把 harness 工厂**绑定到本 app 的 `out/` 产物路径**的薄 shim。改通用 driver → 改 harness；改探针接口 → 改 e2e-contract（`src/shared/e2e/contract.ts` 是它的 re-export barrel）。

**本目录只放核心 spec**：扩展专属 e2e 已迁到 `extensions/<ext>/e2e/`（perforce/markdown/typescript/ai）。**归属判据：这个测试断言的行为，随该扩展一起删掉就消失吗？是 → 归扩展。**

## 最小扩展集启动（P2 基线）

harness 启动 fixture 接收 `extensions: string[]`（allowlist），拼进 launch env `UNIVERSE_ENABLED_EXTENSIONS`，bootstrap 的纯函数 `computeActiveExtensions`（`extensionActivationFilter.ts`）据此过滤：`undefined` → 全部；`[]` → 只核心；`['@universe-editor/x']` → 该扩展 + 核心。**core fixture 基线是 `extensions: []`**——不启任何扩展，冷启动不 spawn tsserver / markdown-LSP，消除大半 LSP-warmup flake。allowlist 只门控 built-in：用户装的 vsix **始终激活**。

少数核心 spec 需要某扩展搭建测试场景，走 scoped fixture（基线 `[]` 之上只加所需扩展）：

| scoped fixture | allowlist | 用于 |
|---|---|---|
| `fixtures/coreGitApp.ts` | git | dirtyDiffPeek、vscodeKeybindings（键位 reload 哨兵） |
| `fixtures/coreTypescriptApp.ts` | typescript | peekPreview（跨文件引用预览，冷启） |
| `fixtures/coreTypescriptSharedApp.ts` | typescript | outline（跨文件切换符号） |
| `fixtures/coreMarkdownApp.ts` | markdown | peekNavigation（跨文件 md 链接定义） |

注意区分：markdown/mermaid **预览渲染是核心**、ACP/agents 亦是核心——它们的 spec 用基线 `[]` 即可。只有 LSP（符号/定义/诊断）、SCM（quick-diff/git 命令）、tsserver 语义这些**扩展提供的能力**才需 scoped fixture。

## 选哪套 fixture（关键决策）

| fixture | 启动模型 | 用于 |
|---|---|---|
| `fixtures/sharedApp.ts` | **每 worker 一个** Electron，测试间 reload window + 重写 userData 复位 | 状态只活在 renderer；**默认首选**，冷启动 ~2.5s 被摊薄 |
| `fixtures/electronApp.ts` | **每个 test 冷启一个** Electron | 触碰 main 进程状态：多 BrowserWindow、terminal PTY、ACP session、重启/恢复类 |

判据：**window reload 能不能把状态复位干净？** 能 → `sharedApp`；碰了 main 持久态 → `electronApp`（选错会让上个测试的 main 态泄漏）。

**自启动 spec**（完全掌控启动参数：多窗口/二次启动）：用 harness 的 `launchElectron`（**不要**裸调 `_electron.launch`）；必须先解构去掉 `ELECTRON_RUN_AS_NODE`（Claude Code shell 注入会让 Electron 退化成纯 Node），收尾手动对**每个活窗口** `expectNoLeaks(page)` + `closeApp(app)`。两套 fixture 统一 pin `workbench.language=en-US` / `update.mode=manual` / `welcome.agentOnboarding.seen=true`。

**spec 需要 workspace 文件**：用 `workspaceSeeder`（`test.use({ workspaceSeeder: { seed(dir) {...} } })`）在 launch 时 pin workspace，**不要 boot 后 `openWorkspace`**（会触发两次 host 重启，竞态窗口见 skill `fix-ci-e2e-flake`）；seeder 必须包成 `{ seed(dir) {...} }` 对象（裸函数会被 Playwright 当 fixture override）。仅冷启 fixture 支持。

**临时目录被运行中的 app / remote daemon 持有句柄**：用冷启 fixture 的 `scratchDir(prefix?)` 工厂（清理在 `closeApp` 之后执行）；spec 内**禁止**在 test body 里 `rmSync` 这类目录。自启动/`workspaceSeeder`/`scratchDir` 的完整细节见 [cases-fixtures.md](cases-fixtures.md)。

## PO 分层

`WorkbenchPO`（`pages/WorkbenchPO.js`）聚合 `activityBar / sideBar / statusBar / quickInput / editor / panel` 六个子 PO，外加直通探针的快捷方法：`runCommand` / `getContextKey` / `lifecyclePhase` / `openWorkspace` / `getActiveEditorUri` / `getEditorGroupCount` / `waitForRestored` …

- 加通用交互能力 → 加到对应子 PO 或 `WorkbenchPO`，别在 spec 里散写 `page.evaluate`。
- `expectNoLeaks` / `evaluateWhenRestored` 是模块级导出，给自启动 spec 复用同一套 context-teardown 加固。
- 重启类断言用 `workbench.waitForRestartRestore()`，**不要**裸 `runCommand + waitForRestored`（重启是 IPC-async，waitForRestored 会在旧页面上提前 resolve）。

## 泄漏门禁（自动）

两套 fixture 收尾都跑 `expectNoLeaks`：卸载 React 后快照 Disposable tracker，**有泄漏就 fail 测试**（disposable 没 `this._register` 会在这里被抓）。`sharedApp` 把门禁挂在 `_leakGate`（auto fixture），只拉 `page`/`electronApp` 的 spec 也被覆盖。

## tag 体系与脚本

tag 打在**用例级** `test('... @p0')` 标题末尾（`@regression` 尤其单用例级，不打在 describe 上）。**过滤策略集中在共享 config**（`playwrightConfig.ts` 的 `grepOptions`），core 与每个扩展同一套——script/CI **不传 `--grep`**，只翻三个 env：`UNIVERSE_E2E_INCLUDE_REGRESSION=1`（@regression 并回主趟，即 `e2ea`）、`UNIVERSE_E2E_ONLY_TAG=<tag>`（只跑某 tag）、`UNIVERSE_E2E_ONLY_TAG_INVERT=<正则>`（叠加排除，`e2e:smoke` 用它把 @p0∩hazard-tag 挡在并行趟外）。加/改 tag 分流只改这一处。**加新 tag 记得同步 `turbo.json` 的 e2e/e2ea task `env` 声明**（否则 turbo strict 不透传、不入缓存 key）。

**约定：`@p0` 不与 `@serial`/`@flaky`/`@perf`/`@visual` 同标**——`e2e:smoke` 语义是「可并行的主路径冒烟」，同标用例会被 INVERT 从 smoke 排除，等于白标 @p0。

**何时打 `@serial`**：用例独占**跨 worker 的全局资源**（当前仅 OS 剪贴板：smoke.acpPasteImage / smoke.agentsMcpDraft 的粘贴图片用例）。**不要再因「打开 workspace」打 @serial**（watcher 已移入 UtilityProcess，根因已修）。

> **坑：裸 `playwright test --grep "<标题>"` 报 `No tests found`**：config 默认 `grepInvert`（排除 @visual/@flaky/@perf/@serial/@regression）与 `--grep` **取交集**，目标用例带这些 tag 就被过滤空。调试用 `pnpm e2eg "<标题>"`（`UNIVERSE_E2E_NO_TAG_FILTER=1`，能选中任意 tag；**直接跟标题，别加 `--`**）；或前缀 `UNIVERSE_E2E_ONLY_TAG=@regression` 再 `--grep`。

| tag | 含义 | 默认 `pnpm e2e` | CI |
|---|---|---|---|
| `@p0` | 核心冒烟，失败**阻塞** CI；`e2e:smoke` 的选中集 | ✅ 跑 | 并行趟 shard×2 |
| `@p1` | 一般冒烟，阻塞 | ✅ 跑 | 并行趟 shard×2 |
| `@regression` | 守护已修复 bug（非主路径冒烟） | ❌ 排除（`e2ea` 并回） | 单独并行趟 |
| `@serial` | 独占全局资源（如 OS 剪贴板）需隔离 | 单独 `--workers=1` 串行趟 | 单独串行趟，仅 shard 1 |
| `@flaky` | headless 偶发（如 DnD） | 排除 | 单独趟 continue-on-error 不阻塞，仅 shard 1 |
| `@perf` | 启动性能观测 | 排除 | 单独趟 continue-on-error，仅 shard 1 |
| `@visual` | 视觉回归 | 排除 | 默认排除，需显式跑 |

**何时打 `@regression`**：只为守护某个已修复 bug、不是主路径冒烟。`@flaky` 是过渡状态——修好根因后应摘掉回归门禁。

脚本分两层——**根级 `pnpm e2e` 走 turbo 缓存跑全量**；子包级（`pnpm --filter @universe-editor/editor`）只跑 core，前置 build 守卫（裸跑自动刷新 `out/`，不缓存结果）：
```bash
# 根级（走 turbo 缓存，自动 build 依赖链）
pnpm e2e            # 全量：core + 所有扩展
pnpm e2ea          # 含 @regression 的全量
pnpm e2e:force     # 忽略缓存强制真跑（复跑 flaky 用）
pnpm e2e:ext @universe-editor/<ext>   # 只跑单个扩展 suite

# 子包级（只 core；前置守卫自动 build，但不缓存 e2e 结果）
pnpm --filter @universe-editor/editor e2e:smoke      # 只跑 @p0 冒烟，日常交互改动首选
pnpm --filter @universe-editor/editor e2e:regression # 只跑 @regression
pnpm --filter @universe-editor/editor e2eg "<用例标题或grep>"  # 自由 grep 调试（NO_TAG_FILTER）
pnpm --filter @universe-editor/editor e2e:ui         # 本地交互调试
pnpm --filter @universe-editor/editor test:visual    # 视觉基线（仅 Linux CI 更新）
```

> **`pnpm e2e` 走 turbo 缓存**：输入未变则命中缓存**不重跑**（缓存 key 含 `editor#build` 的 output hash）。强制真跑用 `pnpm e2e:force`。`--concurrency=1` 让 suite 串行，避免多个独立 Electron 并发的资源争抢 flake。

**改了扩展代码要跑单个 suite？** 子包脚本已前置 `scripts/e2e/ensure-e2e-build.mjs`——裸 `pnpm --filter <ext> e2e` 会先把「宿主 + 被测扩展 + 上游」refresh 到最新再跑，不会再测旧产物。**首选仍是 `pnpm e2e:ext <包>`**：走 turbo `e2e` task，连 e2e 结果都进缓存（输入未变直接返回上次结果）。core 套件的 `core*App` scoped fixture 激活 git/typescript/markdown、从其 `dist` 读产物——这三个扩展是 editor 的 devDependencies，无需单列 `#build`。

**CI affected**：PR 用 turbo affected（`--filter=...[origin/main]`）只跑受影响 suite；改 `platform`/`e2e-harness` → 依赖传递触发全量兜底；main/nightly 无条件全量。CI 的 core e2e job 直接 `pnpm exec playwright test`（tag 分流靠 env 前缀；前面有独立 `pnpm build` step）。

**Linux 环境预检与自动 Xvfb**：入口先跑 `scripts/e2e/linux-preflight.mjs` 秒级预检（`UNIVERSE_E2E_SKIP_PREFLIGHT=1` 跳过）；无 `DISPLAY` 时 globalSetup 自动起 Xvfb。**WSL 下默认离屏**（即便 WSLg 给了 DISPLAY）；`UNIVERSE_E2E_SHOW=1` 恢复真实窗口。详见 `docs/development/wsl-e2e.md`。

## 新增扩展 e2e suite 的套路

1. 建 `extensions/<ext>/e2e/`：`specs/*.spec.ts` + `playwright.config.ts`（`export default defineE2EConfig()`）+ scoped fixture（`extensions: ['@universe-editor/<ext>']`）+ `e2e/tsconfig.json`（纳入 typecheck）。结构照抄 `extensions/markdown/e2e/`。
2. `package.json`：加 `"e2e"`/`"e2ea"`/`"e2eg"` script（照抄现有扩展；`e2eg` 带 `UNIVERSE_E2E_NO_TAG_FILTER=1`）+ `@playwright/test`/`@universe-editor/e2e-harness`/`cross-env` devDep。
3. 无需改根 `e2e`/`e2ea`（`./extensions/*` glob 自动纳入，无 e2e script 的包 turbo 自动跳过）。
4. 若需额外 CI 准备（tsserver / excel-diff vsix），在 `scripts/e2e/affected-e2e-matrix.mjs` 的 `EXTENSION_SUITES` 登记 `prep`，ci.yml 加条件化步骤。

## 外部（marketplace）扩展 e2e

`extensions-external/*`（eslint / pdf / excel-diff）是独立发布的 marketplace 扩展，不在 pnpm/turbo workspace 内——从磁盘目录直接加载 unpacked 扩展跑 e2e（对齐 VSCode `--extensionDevelopmentPath`），绝不打 vsix、不重启 host。完整细节见 [cases-external-extensions.md](cases-external-extensions.md)。

## 踩坑（本目录高频）

> 排查「CI 偶发挂、本地稳过」的 flaky 有专门 skill **`fix-ci-e2e-flake`**——它的案例库是 flaky 知识的单一事实源。遇到 flaky 先查它。

- **E2E 默认静默不抢焦点**：`isE2E` 时主进程窗口 `showInactive()`、其余 `focus()` 降级（`UNIVERSE_E2E_SHOW=1` 恢复完整 show/focus）。
- **core suite 是用例级并行（`fullyParallel`）**：同一 spec 文件里的用例可能被拆到不同 worker 同时跑，**文件内用例不得共享可变资源**（module 级固定端口/路径/beforeAll 服务）——确需共享的文件加 `test.describe.configure({ mode: 'default' })` 退回文件内串行（先例 `smoke.update.spec.ts`）。扩展 suite 仍是文件级调度（每用例冷启一个 Electron）；机制见 `playwrightConfig.ts` 的 `fullyParallel` 注释。
- **产物 build 已自动兜底**：`pnpm --filter <ext> e2e`（及 `e2ea`/`e2eg`/`e2e:regression`/`e2e:ui`）前置了 `scripts/e2e/ensure-e2e-build.mjs`，裸跑也先 turbo build 宿主+扩展+上游。唯一例外：直接 `npx playwright test` 绕开 npm 脚本——先 `pnpm build` 或改走 `pnpm e2e:ext`。
- **异步 ACP 会话**：`sendAcpPrompt` 的 await **不等** echo 流式回复渲染完。依赖 timeline 高度/滚动的断言前，先 `expect.poll` 等消息数到位 + 高度收敛（见 skill `fix-ci-e2e-flake` 案例 15/34/41）。
- **可见性别用 `toBeVisible()`**：Allotment.Pane 用 CSS visibility 隐藏后代，DOM 可见性会误判。走 ContextKey + `expect.poll`。
- **长任务命令 fire-and-forget**：`showCommands` 之类内部 await 用户输入的命令必须 `void window.__E2E__!.runCommand(id)`，否则死锁。
- **URI fsPath 用正斜杠**：本代码库 `URI.fsPath` 返回正斜杠，比对临时目录路径先 `.replace(/\\/g, '/')`。
- **`page.viewportSize()` 在 Electron 下是 null**——位置/视口断言用 `page.evaluate(() => window.innerHeight)`。
- **真回归 vs 环境噪声**：失败先按 skill `fix-ci-e2e-flake` 的判定流程定性；新发现一类 flaky → 往该 skill 追加案例。
- **script 里设 env 要跨平台**：用 `cross-env`——裸 `FOO=1 cmd` 在 Windows 非 bash 下不生效。
- **禁止**在 spec 里 mock main/renderer 服务；**禁止**断言 Monaco 内部 DOM（拿状态走 `getActiveEditorUri()` 等探针）。
