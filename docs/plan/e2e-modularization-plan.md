# e2e 模块化改造计划

> 目标:让 e2e 随插件增加而**模块化、轻量化、好维护**。参考 VSCode 的「测试就近归属 + 单扩展挂载 + 可寻址 suite」范式，落到本项目「黑盒探针整机冒烟」的实际形态。

## 背景与现状诊断

当前 99 个 spec 全部平铺在 `apps/editor/e2e/specs/`，统一 `smoke.*.spec.ts` 命名，一个 `playwright.config.ts` / 一个 `testDir`。问题随插件增加而放大：

1. **归属混乱**：扩展专属的测试（perforce / markdown / typescript / ai）与内核测试混住，删/改扩展时测试散落各处。按归属粗分，扩展专属占约 40%。
2. **整机变重**：每个 spec 冷启动都激活全套扩展（tsserver / markdown-LSP / ACP 全 spawn），既拖慢冷启动，也是 `RUNBOOK` 里大批 flake（LSP warmup 争抢）的来源。
3. **fixture 与扩展耦合**：`fixtures/fake-p4.mjs`、`fixtures/fake-swarm.mjs` 是 perforce 专属 fake，却住在通用 fixtures 目录；CI 里也已出现扩展专属准备步骤（装 tsls、build excel-diff vsix）。

**根本矛盾**：e2e 是黑盒整机冒烟（跑 `out/` 打包产物，靠 `window.__E2E__` 探针驱动，不戳 DOM 内部）。所以不能照搬 VSCode 的「白盒单扩展宿主」，但可迁移它的三个思想：测试归属扩展、最小加载被测扩展、可寻址 suite。

## VSCode 可迁移的三点

| VSCode 做法 | 本项目对应 |
|---|---|
| 扩展集成测试住在 `extensions/<ext>/src/test/`，test-workspace 跟随扩展 | spec + fake + workspace 迁 `extensions/<ext>/e2e/`，删扩展即删测试 |
| `--extensionDevelopmentPath=<单扩展>` 只加载被测扩展 | **最小扩展集启动**：复用 `UNIVERSE_DISABLED_EXTENSIONS`，e2e 传 allowlist，bootstrap 反算 disabled |
| `test-integration.sh --suite git` 可寻址单扩展 | Playwright `projects`，`--project=perforce` 只跑一组 |

## 目标架构（三层）

```
packages/e2e-harness/           ← 新增:共享测试基座包(driver + PO + 泄漏门禁 + 启动契约)
  src/fixtures/{sharedApp,electronApp}.ts
  src/pages/*PO.ts
  src/probes/{expectNoLeaks,evaluateWhenRestored}.ts
  src/launch/extensionSet.ts    ← allowlist→disabled 反算 + launch 参数契约
  src/index.ts                  ← 统一 re-export

apps/editor/e2e/                ← 只留「内核冒烟」(~55 spec)
  playwright.config.ts          ← 根 config,projects 聚合各目录
  specs/                        editor/explorer/layout/window/quickinput/search/output/terminal…

extensions/perforce/e2e/        ← 扩展就近归属(spec + fake + workspace 全跟随)
  specs/*.spec.ts
  fixtures/{fake-p4,fake-swarm}.mjs
  perforce.project.ts           ← 导出该扩展的 project 片段(testDir/allowlist)
extensions/markdown/e2e/
extensions/typescript/e2e/
extensions/ai/e2e/
```

### 归属划分（按现有 99 spec）

| 归属 | 代表 spec | 迁往 |
|---|---|---|
| 内核 | editor / explorer / layout / window / quickInput / search / output / terminal / startup / notification / opener … (~55) | 留 `apps/editor/e2e` |
| perforce（含 swarm） | perforce{Changelist,CollectChanges,Graph} / swarmReview{,Notification} / swarmSpreadsheetDiff (~6) | `extensions/perforce/e2e` |
| markdown | markdown{Editing,Lsp,MoveStaleDiagnostic,Preview,RenameLinks} (5) | `extensions/markdown/e2e` |
| typescript | tsCodeLens / tsSemanticTokens / inlineCompletion / nes / gotoSymbol(TS 部分) (~5) | `extensions/typescript/e2e` |
| ai / agent / acp | agents* / acp* / aiCommitMessage / aiDebug / askUserQuestion / mcpServers / mermaidPreviewSwitch (~20) | `extensions/ai/e2e` |

**边界判据**：这个测试断言的行为，是否随该扩展一起删掉就消失？是 → 归扩展。像 `editorResolver`、`webview`、`webviewDiff` 这类内核基础设施即使被扩展消费，也留内核。`smoke.extensions.spec.ts`（测扩展系统本身）留内核，且需全量激活。

## 关键设计

### 1. 共享基座包 `packages/e2e-harness`（P0 前置）

当前 fixtures/PO 与 `apps/editor` 目录相对耦合（`../pages/WorkbenchPO.js`、`../../src/shared/e2e/contract.js`）。抽包要点：

- **不搬 `contract.ts`**：它含 app 运行时常量（`E2E_PROBE_ARGV_FLAG` 等被 main/preload/renderer 8 处引用），是 app 的一部分。harness 的 PO 只依赖它的**类型**（`E2EDisposableLeakReport` / `E2EOpenWindow` / `E2EUpdateState` …）。做法：把这些**纯类型**抽到 harness 的 `src/probeContract.ts`（或让 harness 用结构化的本地 type 镜像），app 的 `contract.ts` 保留常量并从 harness 导入类型（或各自独立、类型对齐）。二选一，倾向「harness 持类型定义，app contract.ts re-export + 加常量」，单一事实源。
- **扩展专属 fake 不进基座**：`fake-p4.mjs` / `fake-swarm.mjs` 跟随 perforce 迁移，P0 阶段暂留原位（P1 才搬）。
- harness 依赖 `@playwright/test`（catalog），被内核 e2e 和各扩展 e2e 以 `workspace:*` 引用。
- `expectNoLeaks` / `evaluateWhenRestored` 等模块级导出集中在此，泄漏门禁对所有 e2e 一视同仁。

**验证**：`apps/editor/e2e` 改 import 后 `pnpm e2e` 全绿，行为零变化。

### 2. 最小扩展集启动（P2，最大杠杆）

复用现有机制，**零侵入内核激活逻辑**：

- 现状：`bootstrap.ts:274` 已读 `UNIVERSE_DISABLED_EXTENSIONS`（逗号分隔 denylist），且此时已持有完整 scanned 扩展列表；`buildChildEnv`（`env.ts`）透传所有非 denylist 的 `UNIVERSE_*` env 到 host 子进程。
- 改造：在 `bootstrap.ts` 增加 allowlist 语义 —— 读一个新的 `UNIVERSE_ENABLED_EXTENSIONS`（e2e-only）。当它非空时，`activeExtensions = extensions.filter(允许集 ∪ 永久豁免的核心 built-in)`。allowlist 优先于 denylist。
  - 永久豁免：极少数内核不可缺的 built-in（若有，如 git 基础 SCM）。清单在 harness 的 `extensionSet.ts` 与 bootstrap 各持一份常量，或统一由 e2e 传全量豁免 id。倾向「e2e 侧算好最终 allowlist（含豁免）传入」，bootstrap 只做 filter，逻辑最简。
- e2e 侧：harness 的 launch fixture 接收 `extensions: string[]`（扩展 id，如 `['@universe-editor/perforce']`），拼进 launch env `UNIVERSE_ENABLED_EXTENSIONS`。
  - 内核 e2e：`extensions: []`（或仅核心豁免）→ 不启 tsserver/markdown-LSP/ACP → 冷启动更快、消除大半 LSP-warmup flake。
  - 扩展 e2e：只 allow 自己（+ 声明依赖）→ 测 perforce 时不背 typescript 启动成本。

契约落在 fixture 参数上，spec 侧零感知。每个扩展的 `*.project.ts` 声明自己的 allowlist。

### 3. 每扩展独立 Playwright 配置（P1 起）

**决策修订**（相对初稿的"单根 config + projects"）:改为**每个扩展 e2e 拥有自己的 `e2e/playwright.config.ts` + turbo `e2e` task**。理由:turbo affected(P4)按**包**计算影响面并跑该包的 `e2e` task —— 只有 spec + config 都住在扩展包内、且扩展包有自己的 `e2e` script,`turbo run e2e --filter=...[changed]` 才能把"改 perforce"精确关联到"跑 perforce e2e"。单根 config+projects 做不到按包切分 affected。

- 内核:`apps/editor` 保留自己的 `e2e/playwright.config.ts`(testDir=`./specs`,即 core 套件)。
- 每扩展:`extensions/<ext>/e2e/playwright.config.ts`(testDir=`./specs`),`package.json` 加 `"e2e": "playwright test -c e2e/playwright.config.ts"` + `@playwright/test`/`@universe-editor/e2e-harness` devDep + `e2e/tsconfig.json`(纳入 `typecheck`)。
- 本地:`pnpm --filter @universe-editor/perforce e2e` 只跑该扩展;`turbo run e2e` 跑全部。
- 现有 tag 体系(`@p0/@p1/@regression/@serial/@flaky/@perf/@visual`)**完全保留**;各扩展 config 复制内核 config 的 timeout/retries/workers 分流,行为一致。spec 文件名去掉 `smoke.` 前缀(归属已由包体现)。

### 4. CI affected 执行（P4）

turbo 已有 `e2e` task（`dependsOn: ["^build","build"]`）。CI 改为：

- **PR**：`turbo run e2e --filter='...[origin/main]'` → 只有被改动的包（及下游）跑 e2e。改 perforce 只跑 perforce project；改 `platform`/`e2e-harness`（上游）→ 依赖传递天然触发全量兜底。
- **main / nightly**：无条件全量，防 affected 漏网。
- 保留 shard×2 于全量趟；扩展专属准备步骤（tsls / excel-diff vsix）按 project 条件化，减少无关 job 开销。

**依赖顺序**：affected 依赖 P1-P3 的物理迁移完成（spec 住扩展包里，turbo 才能把「改扩展」关联到「跑它的 e2e」）。

## 阶段路线图

| 阶段 | 内容 | 验证 | 依赖 |
|---|---|---|---|
| **P0** 抽基座 | 建 `packages/e2e-harness`，迁 fixtures/PO/probes + 启动契约脚手架；`apps/editor/e2e` 改 import。不搬 spec、不改行为 | `pnpm e2e` 全绿 | — |
| **P1** 试点 perforce | perforce 6 spec + 2 fake + workspace 迁 `extensions/perforce/e2e`；根 config 加 `perforce` project | `--project=perforce` 与旧结果一致 | P0 |
| **P2** 最小扩展集 | bootstrap 加 allowlist；harness launch 传 `extensions`；core project 空 allow、perforce project allow 自己 | 内核 project 冷启动变快、tsserver 不再 spawn（看 host stderr） | P0 |
| **P3** 铺开其余扩展 | markdown/typescript/ai 依样迁移 | 各 `--project` 绿 | P1/P2 |
| **P4** CI affected | 切 `turbo run e2e --filter=...[origin/main]` + 主干全量；扩展准备步骤条件化 | PR 只跑受影响 project | P3 |

## 风险与注意

- **`sharedApp` 跨扩展隔离**：`sharedApp` 是 per-worker 复用实例，不同 project 用不同 allowlist → worker 不能跨 project 复用同一 Electron。Playwright 天然按 project 分 worker，问题不大；但 `seedUserData` 不得假设固定扩展集。
- **`contract.ts` 类型单一事实源**：抽类型到 harness 后，务必让 app `contract.ts` 与 harness 类型对齐（编译期校验），避免探针接口漂移。
- **affected 上游放大**：改 `platform`/`e2e-harness` 触发全量 e2e 是**正确行为**（内核变更本就该全测），需在 CI 注释写清，避免误判为缺陷。
- **视觉基线 `baselines/`**：归属扩展的 visual spec 基线跟随扩展目录；`pnpm docs:check` 式链接校验勿留死链。
- **文档同步**：`apps/editor/e2e/CLAUDE.md`（fixture 选择、PO 分层、tag 体系）在各阶段末尾同步更新；harness 加自己的 CLAUDE.md。
