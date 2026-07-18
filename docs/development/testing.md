# 测试

本仓库分三层测试，全部经 `pnpm check` / CI 门禁：**单元测试**（vitest）、**集成测试**（vitest，跨窗口/多进程场景）、**E2E 冒烟**（Playwright + Electron，跑打包产物）。

> 只想跑一遍全绿：`pnpm check`（= `docs:check` + turbo `lint typecheck test`）；改了交互逻辑再跑 `pnpm e2e`。

## 一览

| 层 | 跑什么 | 环境 | 命令 |
|---|---|---|---|
| 单元 | `src/**/__tests__/*.test.ts(x)` | platform/main → node；renderer → happy-dom + `@testing-library/react` | `pnpm test`（turbo 全包）/ `pnpm --filter <pkg> test` |
| 集成 | `apps/editor/integration/scenarios/*.test.ts` | node，真实多窗口/多进程编排 | `pnpm --filter @universe-editor/editor test:integration` |
| E2E | 核心 `apps/editor/e2e/specs/`；扩展 `extensions/<ext>/e2e/specs/` | Playwright 驱动 `out/` 打包产物 | `pnpm e2e`（核心）/ `pnpm --filter <ext> e2e`（扩展） |

## 单元测试

- 测试文件放 `src/**/__tests__/`，命名 `*.test.ts(x)`。
- `apps/editor` 用 vitest `test.projects` 同时跑三档：`main`（node，`src/main/**` + `src/shared/**`）、`renderer-node`（node，`src/renderer/**/*.test.ts`，无 React/Monaco 预热）、`renderer`（happy-dom，`*.test.tsx`）。新增 renderer 纯逻辑测试默认落 `renderer-node`，需要 DOM 才写 `.tsx`。
- platform / 主进程 → node；renderer → happy-dom。
- 跑法：`pnpm test`（turbo 全量、带缓存）或 `pnpm --filter @universe-editor/editor test:unit` 单包。

## 集成测试

跨窗口 / 多进程、reload 不能复位的场景（如 per-window 文件监听），单元测试的 mock 覆盖不到。住在 `apps/editor/integration/scenarios/`，走独立 `integration/vitest.config.ts`。

```bash
pnpm --filter @universe-editor/editor test:integration
```

依赖 `platform` + `workbench-ui` 的 `dist/`（CI 会先 `pnpm build --filter=...`）。

## E2E 冒烟

Playwright + `_electron` 跑**打包产物** `out/`，通过 `window.__E2E__` 探针驱动服务，**不戳 DOM 内部、不 mock 服务**。写 spec / 加探针 / 定优先级的套路见 [`apps/editor/CLAUDE.md`](../../apps/editor/CLAUDE.md) 套路 F；选 fixture / PO 分层 / 踩坑见 [`apps/editor/e2e/CLAUDE.md`](../../apps/editor/e2e/CLAUDE.md)。

### 核心与扩展分离（模块化）

E2E 已按「内核 vs 插件」物理拆分：

- **核心** spec 住 `apps/editor/e2e/specs/`，基线**不激活任何扩展**（fixture 传 `extensions: []`）——冷启动不 spawn tsserver / markdown-LSP，消除大半 LSP-warmup flake。
- **扩展专属** spec 跟随扩展住 `extensions/<ext>/e2e/`（markdown / typescript / ai / perforce），各自带 `playwright.config.ts` + `e2e` script + scoped fixture（只激活自己：`extensions: ['@universe-editor/<ext>']`）。**删扩展即删其测试**。
- 少数核心 spec 需某扩展来**搭建**其（核心 UI 的）场景，走 `apps/editor/e2e/fixtures/core*App.ts` scoped fixture（基线 `[]` 之上只加所需扩展），如 `coreGitApp`（dirty-diff / 键位）、`coreTypescriptApp`（引用预览）、`coreMarkdownApp`（跨文件链接定义）。

> 判归属：某能力是**扩展提供**的（LSP 符号/定义/诊断、SCM quick-diff、tsserver 语义）才需 scoped fixture 或迁到扩展目录；markdown/mermaid **预览渲染**与 **ACP/agents** 是**核心**，其 spec 用基线 `[]` 即可。

共享 driver（fixture 工厂 + 6 个 PO + 启动/泄漏门禁）抽在 `packages/e2e-harness`；探针类型契约（`E2EProbe` + `window.__E2E__` 全局）抽在零依赖包 `packages/e2e-contract`（app 与 harness 单一事实源）。

### 最小扩展集启动

harness 的启动 fixture 接收 `extensions: string[]`（扩展 id allowlist），拼进 launch env `UNIVERSE_ENABLED_EXTENSIONS`，扩展宿主 bootstrap 只激活列表内的 **built-in** 扩展 + 核心。**allowlist 只门控 built-in**——用户运行时安装的 vsix（如装 vsix 的核心 spec）始终激活，不受 allowlist 拦截。

### tag 体系

tag 打在**用例级**标题末尾（`@regression` 尤其是单用例级）。**tag 分流策略集中在共享 config**（`packages/e2e-harness/src/playwrightConfig.ts` 的 `grepOptions`）——core 与**每个扩展**用同一套过滤，行为一致（此前扩展跑裸 `playwright test`，其 `@regression` 用例每次都跑，现已统一）。各 npm script 不再传 `--grep`，只翻两个环境变量：`UNIVERSE_E2E_INCLUDE_REGRESSION=1`（把 @regression 并回主趟）、`UNIVERSE_E2E_ONLY_TAG=<tag>`（只跑某 tag，用于 @serial/@regression/@flaky/@perf/@visual 的独立趟）。

| tag | 含义 | 默认 `pnpm e2e` | `pnpm e2ea` | CI |
|---|---|---|---|---|
| `@p0` | 核心冒烟，失败阻塞 | ✅ | ✅ | shard×2 |
| `@p1` | 一般冒烟，阻塞 | ✅ | ✅ | shard×2 |
| `@regression` | 守护已修复 bug | ❌ 排除（保持轻快） | ✅ 并回 | 单独并行趟，阻塞 |
| `@serial` | 跨进程竞态需隔离 | 单独 `--workers=1` 趟 | 同左 | 单独串行趟 |
| `@flaky` | headless 偶发（如 DnD） | 排除 | 排除 | `continue-on-error`，不阻塞 |
| `@perf` | 启动性能观测 | 排除 | 排除 | 写 metrics 工件 |
| `@visual` | 视觉回归 | 排除 | 排除 | 需显式跑（`test:visual`） |

### 命令

```bash
# 全量 E2E（core + 所有扩展），走 turbo 缓存、串行执行
pnpm e2e                    # 默认：排除 @regression/@serial/@flaky/@perf/@visual；core 额外跑 @serial 趟
pnpm e2ea                   # 含 @regression 的全量（turbo `e2ea` task，独立缓存条目）
pnpm e2e:force              # 忽略 turbo 缓存强制真跑 e2e（复跑 flaky 用），build 仍走缓存不重复
pnpm e2ea:force             # 同上，含 @regression
pnpm --filter @universe-editor/editor e2e:regression   # 只跑 core @regression
pnpm --filter @universe-editor/editor e2eg "<用例标题>"  # 自由 grep 调试（能选中任意 tag）
pnpm --filter @universe-editor/editor e2e:ui           # 交互调试

# 单个扩展 E2E（改了某扩展代码时，走 turbo 自动 build 宿主+扩展）
pnpm e2e:ext @universe-editor/markdown      # = turbo run e2e --filter …
pnpm e2e:ext @universe-editor/typescript
pnpm e2e:ext @universe-editor/ai
pnpm e2e:ext @universe-editor/perforce
```

> **`pnpm e2e` 走 turbo 缓存**：core（`@universe-editor/editor`）与全部扩展（`./extensions/*` glob，无 `e2e` script 的包自动跳过，加扩展零同步）的 e2e 都是 turbo task，输入未变则**命中缓存直接返回上次结果、不重跑**。缓存 key 已含依赖任务 `editor#build` 的 output hash——改宿主（editor/platform 等上游）会自动令下游所有 e2e 缓存失效重跑，改单个扩展只失效该扩展。`--concurrency=1` 让各 suite **串行**（每个 suite 冷启独立 Electron，并行易触发跨进程资源争抢 flake）；前置 build 命中缓存瞬时跳过，不占串行时间。

> **想无视缓存强制真跑 → `pnpm e2e:force` / `pnpm e2ea:force`**（例如复跑 flaky、或怀疑缓存掩盖问题；`e2ea:force` 含 @regression）。它分两步：先 `turbo run build`（**走缓存**，命中即秒过），再 `turbo run e2e … --force --only`——`--force` 忽略 e2e 缓存强制重跑，`--only` 只执行 e2e task 不执行父 build（否则 `--force` 会把 `editor#build` 也一起重建，造成 build 重复跑）。

> **改了扩展代码，别裸 `pnpm --filter <ext> e2e`**：子包级 `e2e` script 只执行 `playwright test`，**不 build**——既不重建该扩展 `dist/`，也不重建被测的 editor `out/` 宿主，跑的是旧产物。走 `pnpm e2e:ext <包>`（或直接 `turbo run e2e --filter …`）：turbo 的 `e2e` task 依赖 `@universe-editor/editor#build`（e2e 跑 editor 产物 + 从 `extensions/<ext>/dist` 读内置扩展，扩展却不依赖 editor），会自动把宿主 + 被测扩展 + 上游全 build 到最新再跑。core 套件的 `core*App` fixture 激活 git/typescript/markdown，这三个是 editor 的 devDependencies，故其 `^build` 已自动带上。

## CI affected 选择性执行

E2E 在 CI 里**按改动范围选择性执行**，避免插件越多 E2E 越重：

- **PR**：`scripts/e2e/affected-e2e-matrix.mjs` 用 turbo affected（`--filter=...[origin/main]`）算出受影响的 suite，只跑它们。改一个扩展只跑该扩展 E2E；改 `platform` / `e2e-harness`（上游）→ 依赖传递触发全量兜底。
- **main / nightly**：无条件全量（`--all`），防 affected 漏网。
- CI 三段式：`detect-affected` 算矩阵 → `e2e`(核心) 按 `core` 门控 → `e2e-extensions` matrix 按 `fromJson(extensions)` 展开，每 suite 按 `prep` 条件化装 vendored tsserver / excel-diff vsix。
- 核心 scoped fixture 运行时激活 git/typescript/markdown，这三个已声明为 `apps/editor` 的 devDependencies，故 turbo affected 在它们变更时会经依赖图 fanout 到 core（`@universe-editor/editor`），自动触发核心重跑——无需手工维护额外的包清单。

本地预演矩阵：

```bash
node scripts/e2e/affected-e2e-matrix.mjs --base origin/main   # 相对主干算受影响
node scripts/e2e/affected-e2e-matrix.mjs --all                # 全开（等价 main 全量）
```

## flaky 排查

「CI 偶发挂、本地稳过」的排查流程、案例库、速记收敛在 skill **`fix-ci-e2e-flake`**（按需加载）；已知环境 flake 的一句话登记见 [`apps/editor/e2e/RUNBOOK.md`](../../apps/editor/e2e/RUNBOOK.md)。遇 flaky 先查它，别当回归改产品代码。

## 设计背景

E2E 模块化（内核/插件分离 + 最小扩展集 + affected 执行）的完整设计与阶段记录见 [`docs/plan/e2e-modularization-plan.md`](../plan/e2e-modularization-plan.md)。
