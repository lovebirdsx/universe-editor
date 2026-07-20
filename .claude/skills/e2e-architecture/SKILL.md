---
name: e2e-architecture
description: universe-editor（VSCode 范式桌面编辑器）E2E 冒烟测试栈的整体设计地图与踩坑集。当任务涉及——新增/迁移 e2e spec、加扩展 e2e suite、改 tag 分流（@p0/@p1/@regression/@serial/@flaky/@perf/@visual）、调 turbo e2e 缓存、改 CI 的 e2e job、加 fixture/PO、动 packages/e2e-harness 或 packages/e2e-contract、最小扩展集启动（UNIVERSE_ENABLED_EXTENSIONS allowlist）、affected 选择性执行、或遇到「playwright --grep 报 No tests found / e2e build 跑多次 / 扩展改了没重跑 / editor 改了扩展 e2e 没失效」这类命令与缓存行为疑惑时召回。聚焦「架构如何组织 + 常见坑为什么」；具体某个 flake 用例的排查走 fix-ci-e2e-flake。
disable-model-invocation: true
---

# E2E 架构地图与踩坑

universe-editor 的 e2e 是**黑盒整机冒烟**：Playwright + `_electron` 跑 `apps/editor/out/` 打包产物，通过 `window.__E2E__` 探针驱动服务，**不戳 DOM 内部、不 mock 服务**。按「内核 vs 插件」物理模块化，随插件增加保持轻量。

> ⚠️ 第一原则：动 e2e 前先分清你改的是哪一层——**探针契约**（`e2e-contract`）、**共享 driver**（`e2e-harness`）、**归属某扩展的 spec**（`extensions/<ext>/e2e`）、还是**内核 spec**（`apps/editor/e2e`）。改错层会引入跨包耦合或缓存/归属漂移。

## 三层分包（依赖单向：contract ← harness ← 各 suite）

| 包 | 职责 | 关键点 |
|---|---|---|
| `packages/e2e-contract` | **零依赖** 探针类型契约：`E2EProbe` 接口、DTO 类型、`window.__E2E__` 全局 `declare global`、运行时 key 常量 | app 与 harness 的**单一事实源**。app 侧 `apps/editor/src/shared/e2e/contract.ts` 收成一行 `export * from '@universe-editor/e2e-contract'`（保留历史 import 路径 + 拉入 declare global） |
| `packages/e2e-harness` | 共享 driver：两套 fixture 工厂 + 7 个 PO（`pages/`：ActivityBar/SideBar/EditorArea/Panel/StatusBar/QuickInput/Workbench）+ 泄漏门禁 + 启动契约 + **config 工厂** | 依赖 `@playwright/test` + contract；被内核 e2e 和各扩展 e2e 以 `workspace:*` 引用 |
| `apps/editor/e2e` + `extensions/<ext>/e2e` | 实际 spec | app 侧 fixtures/PO 都是**薄 shim**，把 harness 工厂绑定到本 app 的 `out/` 路径，spec import 路径不变 |

## 归属划分（删扩展即删其测试）

判据：**这个测试断言的行为，随该扩展一起删掉就消失吗？** 是 → 归扩展。

- **内核** spec 住 `apps/editor/e2e/specs/`，基线 **不激活任何扩展**（fixture 传 `extensions: []`）——冷启动不 spawn tsserver/markdown-LSP，消除大半 LSP-warmup flake。
- **扩展专属** spec 跟随扩展住 `extensions/<ext>/e2e/`（markdown/typescript/ai/perforce），各自带 `playwright.config.ts` + `e2e`/`e2ea` script + scoped fixture（只激活自己：`extensions: ['@universe-editor/<ext>']`）。
- **少数内核 spec 需某扩展搭台**（核心 UI 场景，非扩展能力）：走 `apps/editor/e2e/fixtures/core*App.ts`（基线 `[]` 之上只加所需扩展）。已知：`coreGitApp`（dirty-diff / 键位）、`coreTypescriptApp` / `coreTypescriptSharedApp`（引用预览 / outline）、`coreMarkdownApp`（跨文件链接定义）。
- **易错归类**：markdown/mermaid **预览渲染是核心**（`src/renderer/workbench/markdown/`），ACP/agents 亦是核心——用基线 `[]`，**不需要** markdown/ai 扩展。只有 LSP（符号/定义/诊断）、SCM（quick-diff/git 命令）、tsserver 语义这类**扩展提供的能力**才需 scoped fixture 或迁扩展目录。

## 最小扩展集启动（allowlist）

harness 的 launch fixture 收 `extensions: string[]`（扩展 id allowlist），拼进 launch env `UNIVERSE_ENABLED_EXTENSIONS`；bootstrap（`packages/extension-host`）的纯函数 `computeActiveExtensions`（`extensionActivationFilter.ts`，带单测）据此过滤。

- `undefined` → 激活全部扫描到的扩展（老行为）；`[]` → 只核心；`['@universe-editor/x']` → 只该扩展 + 核心。
- **allowlist 只门控 built-in**。用户运行时装的 vsix（如装 vsix 的核心 spec）**始终激活**，不受 allowlist 拦截——最小集是为了不启内置 LSP/SCM host，不是拦安装。

## fixture / PO

- `createColdAppTest`：每 test 冷启一个 Electron。触碰 **main 进程状态**（多窗口、terminal PTY、ACP session、重启/恢复）时用——reload 复位不了这些。
- `createSharedAppTest`：每 worker 一个 Electron，测试间 reload + 重写 userData 复位。状态只活在 renderer 时用（**默认首选**，摊薄 ~2.5s 冷启）。
- 泄漏门禁：两套 fixture 收尾都跑 `expectNoLeaks`（卸载 React 后快照 Disposable tracker，有泄漏 fail）。disposable 忘 `this._register` 会在这被抓。
- 加通用交互 → 加到 `WorkbenchPO` 或子 PO，别在 spec 散写 `page.evaluate`。

## tag 体系（分流策略集中在 config，单一事实源）

**所有 tag 过滤逻辑在 `packages/e2e-harness/src/playwrightConfig.ts` 的 `grepOptions()`**，core 与每个扩展、CI 全用它。**script/CI 不传 `--grep`/`--grep-invert`**，只翻三个环境变量：

- `UNIVERSE_E2E_INCLUDE_REGRESSION=1` → 把 `@regression` 并回主趟（即 `e2ea`）
- `UNIVERSE_E2E_ONLY_TAG=<tag>` → 只跑某 tag（serial/regression/flaky/perf/visual 的独立趟）
- `UNIVERSE_E2E_NO_TAG_FILTER=1` → 关掉默认排除（`e2eg` 调试用，让手传 `--grep` 能选中任意 tag）

| tag | 默认 `pnpm e2e` | `e2ea` | CI |
|---|---|---|---|
| `@p0` / `@p1` | ✅ | ✅ | 并行趟 shard×2 |
| `@regression` | ❌ 排除 | ✅ 并回 | 单独并行趟，阻塞 |
| `@serial` | 单独 `--workers=1` 趟 | 同左 | 单独串行趟 |
| `@flaky` | 排除 | 排除 | 单独趟 `continue-on-error`，不阻塞 |
| `@perf` | 排除 | 排除 | 单独趟，写 metrics |
| `@visual` | 排除 | 排除 | 需显式 `test:visual` |

加/改 tag 分流**只改 `grepOptions()` 一处**。加新 tag 记得同步 turbo.json 的 e2e/e2ea task `env` 声明（否则 turbo strict 模式不透传、不入缓存 key）。

## 命令与 turbo 缓存

根脚本全走 turbo（缓存 + 自动 build 依赖链），`--concurrency=1` 让 suite 串行（各 suite 冷启独立 Electron，并行易触发跨进程资源争抢 flake）：

```bash
pnpm e2e         # 全量(core+所有扩展)，默认排除 @regression 等，走 turbo 缓存
pnpm e2ea        # 含 @regression 的全量（turbo `e2ea` task，独立缓存条目）
pnpm e2e:force   # 忽略缓存强制真跑 e2e，build 仍走缓存不重复
pnpm e2ea:force  # 同上，含 @regression
pnpm e2e:ext @universe-editor/<ext>   # 只跑单个扩展 suite（turbo 自动 build 宿主+扩展）
pnpm --filter @universe-editor/editor e2eg "<用例标题>"  # 自由 grep 调试（能选中任意 tag）
```

**turbo e2e 依赖设计**（`turbo.json`）：e2e/e2ea task `dependsOn` 显式含 `@universe-editor/editor#build`——因为 e2e 跑 editor 产物，而扩展**不依赖** editor（依赖方向相反），不显式挂上则 `turbo run e2e --filter=<ext>` 会 build 扩展却留 editor 宿主过期。core 用的 git/typescript/markdown 是 editor 的 `workspace:*` devDependencies，靠 `^build` 自动带上（同时让 affected 检测感知，见 `scripts/e2e/affected-e2e-matrix.mjs` 的 `CORE_EXTRA_PACKAGES`）。

**CI affected**：PR 用 turbo affected（`--filter=...[origin/main]`）只跑受影响 suite；改 `platform`/`e2e-harness`（上游）→ 依赖传递触发全量兜底；main/nightly 无条件全量。CI 的 e2e job **直接 `pnpm exec playwright test`**（不走根脚本），tag 分流靠上面的 env 前缀。

## 高频坑（动手前必读）

1. **`--grep "<标题>"` 报 `No tests found`**：config 默认 `grepInvert` 排除 @regression 等，与 CLI `--grep` **取交集**——目标用例若带被排除 tag 就被过滤空。解：`pnpm e2eg "<标题>"`（NO_TAG_FILTER）或前缀 `UNIVERSE_E2E_ONLY_TAG=@regression`。**`e2eg` 直接跟标题，别加 `--`**（`pnpm e2eg -- "x"` 会把 `--` 当 grep 值）。
2. **子包裸跑 e2e 已自动 build（守卫兜底）**：`pnpm --filter <ext> e2e`（及 `e2ea`/`e2eg`/core 的 `e2e:regression`/`e2e:ui` 等）前置 `scripts/e2e/ensure-e2e-build.mjs`——裸跑先 `turbo run build --filter=editor... --filter=<self>...` 刷新宿主+扩展+上游（缓存命中秒过）再跑，不再测旧产物；已在 turbo 上下文（`TURBO_HASH`）则跳过防嵌套。**但首选仍 `pnpm e2e:ext <包>`**：它连 e2e **结果**都进 turbo 缓存，且是 CI/affected 正道。外部扩展（`extensions-external/*`）走 `run-external-e2e.mjs`，同样内联了 editor+extension-host 的 turbo build 守卫（根 `e2e:external` 已建好时用 `UNIVERSE_E2E_EDITOR_PREBUILT` 跳过）。
3. **`--force` 会连 build 一起重跑**：`--force`= 忽略**所有**缓存。`e2e:force`/`e2ea:force` 用 `turbo run build && turbo run e2e --force --only`——`--only` 只跑 e2e 不重建 build，避免 editor build 跑多次。
4. **e2e 缓存会掩盖 flaky**：没改代码时重复 `pnpm e2e` 命中缓存**直接返回上次结果、不真跑**。想复跑确认稳定性用 `e2e:force`。
5. **只有绕开 npm 脚本才需手动 build**：npm 脚本（`e2e`/`e2ea`/`e2eg`/`e2e:ext`…）都有 build 兜底（守卫或 turbo）。唯独直接 `npx playwright test` / `pnpm exec playwright test` 绕过脚本时守卫不生效——先 `pnpm build`。CI 的 **core** job 正是走裸 `pnpm exec playwright test`（见坑 78 行），但它前面有独立 `pnpm build` step；CI 的**扩展** job 走 `pnpm --filter <suite> e2e`（脚本，守卫生效），`pnpm build` step 之后守卫的 turbo build 全缓存命中、秒过。
6. **自启动 spec 必去 `ELECTRON_RUN_AS_NODE`**：Claude Code shell 注入它会让 Electron 退化成纯 Node 拒绝 Chromium flag。照抄 fixture 的 `const { ELECTRON_RUN_AS_NODE: _ignored, ...inheritedEnv } = process.env`。收尾对每个活窗口 `expectNoLeaks(page)` + `closeApp(app)`。
7. **可见性别用 `toBeVisible()`**：Allotment.Pane 用 CSS visibility 隐藏后代，DOM 可见性会误判。走 ContextKey + `expect.poll`。
8. **URI fsPath 用正斜杠**：`URI.fsPath` 返回正斜杠，比对临时目录路径先 `.replace(/\\/g, '/')`。
9. **在 script 里设 env 要跨平台**：用 `cross-env`（catalog 已加，editor + 4 扩展 devDeps 引入）——裸 `FOO=1 cmd` 在 Windows 非 bash 下不生效。

## 新增扩展 e2e suite 的套路

1. 建 `extensions/<ext>/e2e/`：`specs/*.spec.ts` + `playwright.config.ts`（`export default defineE2EConfig()`）+ scoped fixture（`extensions: ['@universe-editor/<ext>']`）+ `e2e/tsconfig.json`（纳入 typecheck）。
2. `package.json`：加 `"e2e"`/`"e2ea"`/`"e2eg"` script（照抄现有扩展，`e2eg` 带 `UNIVERSE_E2E_NO_TAG_FILTER=1` 供自由 grep 任意 tag，标题直接跟在后面别加 `--`）+ `@playwright/test`/`@universe-editor/e2e-harness`/`cross-env` devDep。
3. 无需改根 `e2e`/`e2ea`（`./extensions/*` glob 自动纳入，无 e2e script 的包 turbo 自动跳过）。
4. 若该 suite 需额外 CI 准备（tsserver / excel-diff vsix），在 `scripts/e2e/affected-e2e-matrix.mjs` 的 `EXTENSION_SUITES` 登记 `prep`，并在 ci.yml 加条件化步骤。

## 外部（marketplace）扩展 e2e 套路

`extensions-external/*`（eslint / pdf / excel-diff）是**独立发布的 marketplace 扩展，不在 pnpm/turbo workspace 内**。它们不能 `workspace:*` 引用 harness，turbo 也看不见它们。对齐 VSCode `--extensionDevelopmentPath`：**从磁盘目录直接加载 unpacked 扩展跑 e2e，绝不打 vsix、不重启 host**。

**加载机制**：内核认 `UNIVERSE_USER_EXTENSIONS_DIR` env（`apps/editor/src/main/services/extensionHost/userExtensionsDir.ts`）。fixture 建隔离临时目录，把扩展根 junction 进去，启动时经 `scanExtensions` 直接读 `package.json`+`dist/` 激活。用户扩展（`builtin:false`）**不受 allowlist 门控**，始终激活。

- **Windows junction 是 symlink 不是 directory**：`scanExtensions` / `hasUserExtensions` 必须 `stat` 跟随 symlink dir（`entry.isSymbolicLink() && isDir(...)`），否则跳过 junction 进来的扩展——这是内核真修复，也惠及真·dev-link 扩展。
- **解析难题**：外部扩展 bare-import 解析不到 harness / `@playwright/test`（不在 workspace）。解法（`scripts/e2e/run-external-e2e.mjs`）：① config **相对 import** `../../../packages/e2e-harness/dist/index.js`；② 从 `packages/e2e-harness/package.json` 解析出**唯一一份** `@playwright/test/cli` 物理路径来 spawn（两份 playwright 会崩）。
- **tag env seam 复用**：runner 把 `--regression`/`--no-tag-filter` 映射到 `UNIVERSE_E2E_*` 环境变量（同 core，单一事实源仍是 `grepOptions()`）。
- **诊断探针**：`getMarkers(uri, owner)`（读 Monaco marker，eslint owner=`'eslint'`）、`getOutputChannelContent(name)`（读 OutputChannel，诊断扩展内部报错的利器）。
- **flat config 坑**（eslint suite）：ESLint 9 flat config 用 `export default` 须 `eslint.config.mjs`（或 `"type":"module"`）；fixture 源文件若用 ESM `export` 须在 config 给 `languageOptions.sourceType`，否则纯脚本语法即可。

**命令 / CI**：

```bash
pnpm e2e:external    # 建 editor 一次 + 串行跑 eslint/pdf/excel-diff（run-external-e2e-all.mjs）
pnpm e2ea:external   # 同上，含 @regression
npm --prefix extensions-external/<ext> run e2e   # 单个外部 suite
```

- **CI affected 靠 git path diff**（turbo 看不见外部扩展）：`affected-e2e-matrix.mjs` 的 `computeExternalMatrix` —— 改某 suite 目录只跑它；改共享基建（editor / e2e-harness / e2e-contract / extension-host / extension-api / scripts/e2e）扇出全部。输出 `external` / `has-external`，喂 `e2e-external` matrix job。
- Windows spawn `.cmd` 需 `shell: true`（CVE-2024-27980 后 Node 拒绝裸 spawn `npm.cmd`）——见 `run-external-e2e-all.mjs` 的 `runNpm`。


## 相关文档 / skill

- 设计全貌与阶段记录：`docs/plan/e2e-modularization-plan.md`
- 命令 / tag / 缓存说明：`docs/development/testing.md`、`apps/editor/e2e/CLAUDE.md`
- 新建 spec / 加探针 / 定优先级套路：`apps/editor/CLAUDE.md` 套路 F
- **flake 排查**（真回归 vs 环境噪音、读 call log、鲁棒化断言）：skill `fix-ci-e2e-flake` + `apps/editor/e2e/RUNBOOK.md`
