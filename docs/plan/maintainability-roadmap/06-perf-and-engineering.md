# 计划 06 · 性能与工程化

> 配套总览：[README.md](./README.md)
> 范围：构建（turbo/tsc/vite/electron-builder）、性能基建（perf marks/TimerService）、测试体系（vitest/e2e）、CI
> 主轴：**启动可观测性 + CI 回归门禁** + **增量构建优化** + **e2e flaky 系统化**。

---

## 现状肯定

- 性能基建三层清晰：`mark()`（platform）→ `IPerformanceMarksService`（IPC 跨进程合并）→ `TimerService`（聚合 MILESTONES）。
- 大列表虚拟化已普遍（Explorer/Search/GitGraph/Chat）——**不是性能短板**。
- vitest 三 project（main / renderer-node / renderer-dom）隔离合理，renderer-node 无 React/Monaco 跑得快。
- turbo + pnpm catalog 集中版本，monorepo 协作摩擦低。
- E2E 探针白名单严格，production 天然剥除；CI ubuntu+windows 双跑、分 shard。

---

## P1 · 启动 perf 打点粒度粗，回归无法定位/无门禁

### 问题
现有 12 个 mark 集中在**大阶段边界**，缺关键子阶段细分；CI 也无启动耗时门禁，某次改动让冷启动慢 50ms 时无法自动发现。

### 证据
`apps/editor/src/shared/perf/marks.ts` 共 12 个 mark：
```
mainDidStart / mainAppReady / mainDidCreateServices / mainWillCreateWindow / mainDidShowWindow
rendererWillStartBootstrap / rendererDidCreateIpc / rendererWillRestore /
rendererDidRestoreServices / rendererDidMount / rendererDidRestoreEditors
```
缺：Monaco dynamic import 耗时、扩展宿主 spawn 耗时、单个重 service（如首次 workspace scan）耗时。`rendererWillRestore → rendererDidMount` 是一大跨度黑盒。

### 影响
启动回归只能靠用户报告；无法定位是哪个 service / 哪次 import 拖慢。

### 落地步骤
1. 按计划纪律（套路 G）补 mark：`rendererDidInitializeMonaco`、`extHostDidSpawn`、以及 bootstrap 内重 service 初始化前后点。
2. CI `bench` job 增加**启动耗时采集 + 门禁**：记录 total 与各阶段耗时，超基线阈值（如 +15%）产报告/告警（先 soft-fail 观察，稳定后再 hard-fail）。
3. `TimerService.getStartupMetrics()` 已有聚合逻辑，只需补上游 mark 输入 + 把结果在 CI 落盘对比。

### 验证
新 mark 出现在 `Developer: Startup Performance`；CI 能输出阶段耗时表。

---

## P1 · e2e flaky 缺系统化治理

### 问题
已知多类 flaky 靠零散 workaround，无统一 RUNBOOK，开发者难区分"真 bug vs 环境竞态"，PR 偶发重跑。

### 证据
- `.github/workflows/ci.yml:139-144`：`@serial` 因 `@parcel/watcher` Windows 多 worker 竞态，被迫 `--workers=1`（memory 亦记录此项及多条本机 flaky）。
- memory 记录：electron 二次启动失败、relaunch flake、markdown exthost 本机失败等多条"环境问题非回归"。

### 影响
CI 稳定性与开发者信任度受损；flaky 与真回归混淆增加排查成本。

### 落地步骤
- 写 `apps/editor/e2e/RUNBOOK.md`：登记每类已知 flaky 的**根因 + workaround + 判定标准**（直接把 memory 里的结论沉淀过去）。
- 给已知不稳定用例打 `@flaky` tag，CI 单独跑并只产报告不阻塞，与 `@p0` 严格门禁分离。
- 评估 `@parcel/watcher` Windows 竞态的根治（升级版本 / 换 watcher / 进一步隔离），而非长期 `--workers=1`。

### 验证
RUNBOOK 覆盖所有当前 workaround；`@p0` 门禁不再被环境 flaky 干扰。

---

## P2 · turbo typecheck 依赖 build，增量链可优化

### 问题
`turbo.json` 的 `typecheck` `dependsOn: ["^build", "build"]`，每次 typecheck 都要等自身和依赖 build 产物。

### 证据
`turbo.json`：
```json
"typecheck": { "dependsOn": ["^build", "build"], "outputs": [] }
```
各包 `typecheck` 实为 `tsc --build`（`composite: true` + project references）。

### 现状缓解说明
因为是 `tsc --build` + composite，TS 本身是**增量**的，痛点没有看上去那么大。但 turbo 层面把 typecheck 钉在 build 之后，仍可能造成不必要的等待。

### 落地步骤
- 评估让 `typecheck` 依赖 `^typecheck` 而非 `^build`（composite 工程的 `.d.ts` 由 references 解析，未必需要完整 build 产物）。**需实测**确认不破坏类型解析。
- 统一 `.tsbuildinfo` 位置（在 `config-ts/base.json` 设 `tsBuildInfoFile`），确保 turbo cache key 与 tsc 增量对齐。

### 验证
改动后 `pnpm typecheck` 干净缓存 / 增量两种场景计时对比；CI typecheck 时长不退化。

---

## P2 · platform/workbench-ui 的 dist 重建是 DX 暗坑

### 问题
非 dev 模式下改了 platform，apps（及 node 环境测试）看到的是旧 `dist/`，须手动 rebuild，易"改了不生效"。

### 证据
CLAUDE.md 多处提示此坑；CI integration job 显式 `pnpm build --filter=@universe-editor/platform...`。

### 落地步骤
- 提供 `pnpm dev:full`（或在 `dev` 中）自动启动 platform/workbench-ui 的 watch，减少手动 rebuild。
- 或在 vitest/node 环境把 `@universe-editor/platform` alias 指向 `src`（需确认 ESM/类型解析无副作用），消除 dist 滞后。
- 在 `DEVELOPMENT.md`（新建）写明"改了不生效"的诊断路径。

### 验证
改 platform 源码后，dev 模式下 apps 即时生效；文档可复现诊断步骤。

---

## P2 · 缺 bundle size 可观测性

### 问题
renderer 产物体积无 CI 监测，长期演进易积累死代码 / 体积膨胀（影响加载、asar 体积）。

### 落地步骤
- `bench` job 增加产物 gzip size 采集，与基线比对，超阈值（如 +10%）告警。
- 可复用项目已有的 `pngjs`/脚本能力自写采集，无需重依赖。

### 验证
CI 输出关键产物体积；人为引入大依赖能触发告警。

---

## P2 · will-quit 同步落盘可能延迟退出

### 问题
退出时 `flushSync()` 同步写状态，大工作区 / 网络盘上可能延迟进程退出。

### 证据
`apps/editor/src/main/storage.ts` 的 `flushSync()`：`writeFileSync(..., JSON.stringify(cache, null, 2))`（含 pretty-print）。

### 落地步骤
- 平时走异步写，will-quit 仅做最小同步确认；或退出时去掉 pretty-print（`JSON.stringify(cache)`）减小序列化成本。
- 低危，按需。

---

## 任务依赖与建议顺序

```
P1 启动打点细化 ──► P1 CI 启动耗时门禁（先有打点才有门禁）
P1 e2e RUNBOOK + @flaky 分离（独立、立即可做）
P2 turbo/tsc 增量优化（需实测）
P2 dev:full / bundle size / flushSync（机会型）
```

建议先做 e2e flaky 系统化（沉淀 memory 已有结论，立竿见影提升 CI 信任度）与启动打点细化（为后续所有性能优化提供度量基础）。
