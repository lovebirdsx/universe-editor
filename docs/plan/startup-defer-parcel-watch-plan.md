# 启动优化 · 推迟 parcel 递归订阅 实施计划

> 背景来源：`/analyze-startup-performance` 对比 `F:/cloud-storage/work`（1.10s，非 git）与 `D:/git_project/universe-editor`（1.47s，git 仓库、9826 文件、48M `.git`）两个工作区的启动报告。
>
> **诊断结论**：慢出来的 ≈350ms 集中在 renderer 恢复窗口（Ready phase / 四个并行 load / Monaco init / React mount）。四个并行 `load()` 精确同刻返回，说明它们共同被 main 进程阻塞。main 在这段时间的主要竞争者之一，就是 `fileWatcherMainService` 对大工作区根做 **parcel native 递归订阅** + Explorer 树首读，与 renderer 恢复抢同一段 main CPU。
>
> **本计划范围**：把 parcel 递归订阅从"首屏恢复窗口内触发"推迟到"首屏 mount 之后（idle / Eventually）"，让它不再和 renderer 恢复争抢。**低风险、改动小**，是两个优化方案里应先落地的一个。另一个方案（workspace hydration 不阻塞首屏）见 `startup-nonblocking-workspace-hydration-plan.md`，可独立执行。
>
> 通用纪律：
> - 每个阶段结束跑 `pnpm check`（仅截取错误输出）；本改动涉及编辑器交互链路，末尾必须跑 `pnpm e2e`。
> - 诊断/验证性能前先 `pnpm build`（apps 看到的是 platform 的 dist；性能数据须在构建产物上采集）。
> - 提交粒度按阶段，commit 信息遵循 conventional commits。

---

## 现状梳理（先读懂，再动手）

触发链（当前，全部在首屏恢复窗口内同步发生）：

```
ExplorerTreeService 构造 (main.tsx:513, BlockStartup 期由 DI materialize)
  └─ constructor 末尾同步调用 _setRoot(workspace.current?.folder)   (ExplorerTreeService.ts:180)
       └─ _setRoot 内 void this._watcher.watch(root, { excludes })   (ExplorerTreeService.ts:610)
            └─ 经 ProxyChannel → main FileWatcherMainService.watch()
                 └─ _subscribe(): parcel watcher.subscribe(target, ...)  ← 大树冷订阅吃 main CPU
                    打点 mainWillWatchWorkspace / mainDidWatchWorkspace
```

关键约束与事实：
- `_setRoot` 同时做两件事：① `this._model.expand(rootEntry)`（Explorer 根目录首读，UI 首屏需要）② `this._watcher.watch(...)`（parcel 递归订阅，**首屏不需要**，只为后续自动刷新）。**只需推迟 ②，保留 ①**，否则 Explorer 首屏会空。
- watch 已是 `void ...catch()` 的 fire-and-forget，不阻塞构造；问题在于它**发起的时机**落在 main 最忙的窗口，抢占 CPU。
- `FileWatcherMainService` 已有 `_didMarkFirstWatch` 只打首次 mark 的机制；推迟后 `mainWillWatchWorkspace` 的 offset 会自然后移到首屏之后，这是预期现象，不是回归。
- 工作区切换（`onDidChangeWorkspace`）走的是**运行时**路径，不在冷启动窗口，不应被推迟逻辑影响 —— 推迟只针对**冷启动首次** setRoot。

---

## 阶段 0 · 基线采集（不产代码）

**目标**：留一份改动前的可复现基线，改完能对拍。

- [x] 0.1 `pnpm build` 后采集基线报告。**实际用法有替换**：未走 `Developer: Startup Performance` UI 命令，改用一次性脚本 `apps/editor/scripts/measure-startup.mjs`（Playwright `_electron` 启动构建产物 + 读 `window.__E2E__.getStartupMetrics()`），效果等价、可重复跑多次取均值，见"验证记录"。
- [ ] 0.2（可选但推荐）隔离验证根因：临时把 `.git` 改名 `.git_bak` 重启采一次。**未执行**（可选项，0.1 的对拍已经确认推迟生效且总耗时下降，未额外做这一步隔离）。

**验证**：得到一张基线均值表，写入本文件末尾"验证记录"。

---

## 阶段 1 · 让 Explorer 首读与 watch 订阅解耦

**目标**：`_setRoot` 冷启动时只做根目录展开（首屏需要），把 parcel 订阅拆成一个可延迟触发的独立步骤。

### 1.1 拆分 `_setRoot`（`ExplorerTreeService.ts`）
- [x] 把 `_setRoot` 里的 `this._watcher.watch(...)` / `this._watcher.unwatch()` 抽到独立私有方法 `_syncWatch(root: URI | null)`。
- [x] `_setRoot` 仍同步做：normalize、清空 nodes、`_model.expand(rootEntry)`（保证 Explorer 首屏可见）。
- [x] 新增标志区分冷启动首次 vs 运行时切换。**实际实现比原设想复杂一层**：光靠"是否首次 setRoot"不够——renderer 的 `IWorkspaceService.current` 是异步 IPC hydrate 的，冷启动的第一次 `onDidChangeWorkspace` 触发和"运行时真实切换工作区"走的是同一个事件、无法用"是否首次"区分。改用 `_watchStarted`（watch 是否已真正 arm）+ `_coldStartSettled`（`IWorkspaceService.whenReady` 是否已 resolve）双标志：`whenReady` resolve 之前发生的 `_setRoot` 一律视为冷启动（推迟），之后的一律视为运行时动作（立即同步）。

### 1.2 冷启动推迟、运行时立即
- [x] 构造函数末尾的**首次** `_setRoot`：只展开，不立即 `_syncWatch`；`_syncWatch(root)` 交给延迟触发点（阶段 2）。
- [x] `onDidChangeWorkspace` 引发的 `_setRoot`：`_coldStartSettled` 为 true 时（真实运行时切换）**立即** `_syncWatch`，保持现有行为不变；为 false 时（冷启动异步 hydrate 的首次赋值）视同构造函数首次调用,同样推迟。

**验证**：`pnpm --filter editor typecheck` 通过；`ExplorerTreeService.test.ts` / `explorer.externalCreateIpc.test.ts` / `explorer.multiWindowWatch.test.ts` 按新时序补了显式 `startWatching()` 调用，全部通过。

---

## 阶段 2 · 选择延迟触发机制

> 二选一，2.A 更省事、2.B 更贴合仓库 Eventually 范式。建议先评估 2.A，够用就不必上 2.B。

### 2.A（首选，已评估、未采用）在 ExplorerTreeService 内用 idle 回调自触发
- [x] 评估结果：实测一个原始 `runWhenIdle`/`requestIdleCallback` 在 DI 构造期安排的回调，可能早于 Ready-phase 恢复工作真正开始就触发，达不到"卡在首屏 mount 之后"的效果——遂改用 2.B。

### 2.B（备选）挂到 Eventually 阶段 contribution
- [x] 新增 `WorkspaceWatchContribution`（`WorkbenchPhase.Eventually`），在 `contributions/registration/eventually.ts` 注册（与 `ExtensionsContribution` 同阶段）。**采用 2.B**：2.A 的 idle 回调是在 DI 构造期自行安排的，实测会在 Ready-phase 恢复工作真正开始前就触发（早于目标窗口），无法可靠卡在"首屏 mount 之后"；Eventually 阶段由 `Workbench.tsx` 在挂载后统一 `requestIdleCallback` 触发，时机更可控。
- [x] contribution 注入 `IExplorerTreeService`，调用 `explorerTreeService.startWatching()`（内部即冷启动的 `_syncWatch(this._root)`，幂等）。
- [x] `ExplorerTreeService` 暴露 `startWatching()` 公有方法；冷启动构造不再自触发 watch。

**验证**：`pnpm check`；确认无新增 disposable 泄漏报告。

---

## 阶段 3 · 验证与回归

- [x] 3.1 `pnpm build` 后重采 universe-editor 启动报告 3 次，与阶段 0 基线对拍：
  - [x] `mainWillWatchWorkspace` offset **后移到 `didMount` 之后**（推迟成功的直接证据）——`watchAfterMount` 由 `false` 变为 `true`。
  - [x] Total 下降——均值从 2176.1ms 降到 1393.3ms（见"验证记录"，具体降幅受机器负载影响，方向和量级符合预期）。
- [x] 3.2 功能回归（关键：推迟 watch 不能破坏"外部改动自动刷新"）：
  - 由 `smoke.explorerExternalWatch.spec.ts` 的两个 e2e 场景覆盖（单窗口外部创建文件自动刷新 + 双窗口各自监听不互相干扰），均通过，等价于手动验证。
  - `useSearchEngine` / `ExternalChangeWatcher` 未单独跑规回归，但它们消费的是同一条 `onDidChangeFiles` 事件流，watch 一旦 arm 后行为与改动前完全一致（改动只影响"何时 arm"，不影响 arm 之后的事件投递路径），逻辑上不受影响。
  - **验证过程中额外发现并修复一个真实回归**：`startWatching()` 只是重新 arm 了 watcher 监听*未来*事件，冷启动推迟窗口内（root 已展开、watch 尚未 arm）产生的外部文件改动会被永久漏检（parcel 不会补报订阅前已发生的变化）。修复：`startWatching()` 里 arm 完 watcher 后，额外做一次 `_refreshLoadedNodes()`（复用 `_onExcludeChange` 已有的"重读所有已加载目录 + `_model.refresh()`"逻辑），对齐推迟窗口内的漏检。这正是风险小节里预先设想的"兜底对齐"手段，只是从"可选加固"变成了"必须项"——不加会在 e2e 双窗口场景下稳定复现漏检（外部文件永远不出现，不是延迟出现）。
- [x] 3.3 `pnpm e2e`（仅截取错误）：全量 154 个场景全部通过，含 `smoke.explorerExternalWatch.spec.ts` 两个场景、`smoke.windows.spec.ts`（多窗口）等重点相关 spec。
- [x] 3.4 边界：
  - 空窗口（无工作区）不触发 watch——`_root` 为 `null` 时 `_syncWatch(null)` 只会 `unwatch()`，无副作用。
  - 打开文件夹后（运行时路径，`_coldStartSettled` 已为 true）watch **立即**生效，不被推迟逻辑波及——由 `smoke.explorerExternalWatch.spec.ts` 第一个场景（`openWorkspace` 到空窗口后立即验证外部文件被发现）实测覆盖。

**验证**：性能对拍表 + 功能回归清单 + e2e 通过，见下方"验证记录"。

---

## 风险与注意

- **推迟窗口内的外部改动会漏事件**：从首屏 mount 到 idle 触发 watch 之间（通常几十~几百 ms，但也可能更长——e2e 环境下曾观察到明显更慢的情形）的外部文件改动不会被捕获。**已实装兜底**：`startWatching()` 里 `_syncWatch` 之后追加一次 `_refreshLoadedNodes()`（重读所有已加载目录 + `_model.refresh()`），把推迟窗口内漏检的改动一次性对齐——e2e 双窗口场景验证过，这一步不是可选项，缺了会导致外部文件永久不出现（不仅仅是出现得晚）。
- **不要推迟运行时 workspace 切换的 watch**，否则切目录后 Explorer 长时间不刷新，是明显回归。
- **disposable 泄漏**：idle 句柄 / contribution 必须走 `_register`；本仓库 reload/unmount 有 tracker 会把漏网的 disposable 报红（见 memory `reload-disposable-leak-marksingleton`）。
- **性能须在 `pnpm build` 产物上测**，dev 模式数据不可比。

---

## 涉及文件速查

- `apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts` — `_setRoot` / 新 `_syncWatch` / 冷启动推迟（主战场）
- `apps/editor/src/renderer/contributions/registration/eventually.ts` — 备选 2.B 注册处
- `apps/editor/src/main/services/fileWatcher/fileWatcherMainService.ts` — parcel 订阅实现（不改，仅理解 mark 时机 + `sameSet` 幂等）
- `apps/editor/src/shared/perf/marks.ts` — `mainWillWatchWorkspace` / `mainDidWatchWorkspace`（不改，观察 offset 后移）
- `packages/platform/src/base/async.ts` — 确认 idle 工具是否已导出（2.A 用）

---

## 验证记录

**性能对拍**（`apps/editor/scripts/measure-startup.mjs`，`pnpm build` 产物，universe-editor 自身作为工作区）：

| | 改动前基线 | 改动后 |
|---|---|---|
| 均值 Total | 2176.1ms | 1393.3ms |
| `mainWillWatchWorkspace` 相对 `Workbench mounted` | 之前（`watchAfterMount=false`） | 之后（`watchAfterMount=true`） |

方向和量级符合预期：watch 订阅确认后移到首屏 mount 之后，且不再抢占 renderer 恢复窗口的 main CPU，Total 明显下降。

**功能回归**：
- `smoke.explorerExternalWatch.spec.ts` 两个场景（单窗口外部文件自动检测 / 双窗口互不干扰各自检测）均通过。
- 空窗口不触发 watch；运行时打开文件夹（`_coldStartSettled` 已 true）watch 立即生效，不受推迟逻辑影响。
- 单测/集成测试按新的"冷启动推迟，需显式 `startWatching()`"时序调整（`ExplorerTreeService.test.ts`、`explorer.externalCreateIpc.test.ts`、`explorer.multiWindowWatch.test.ts`），全部通过。

**发现并修复的额外回归**（不在原计划预期内，验证过程中暴露）：
`WorkspaceWatchContribution` 依赖 `WorkbenchPhase.Eventually` 的 `requestIdleCallback` 触发，实测触发时机会明显晚于最初预期的"几十~几百 ms"（尤其在同时存在第二个窗口、CPU 有竞争的场景）。这拉长了"root 已展开但 watch 未 arm"的窗口，而 `startWatching()` 最初的实现只是重新 arm 监听*未来*事件，不会补报窗口期内已经发生、watch 尚未生效时就已落盘的外部改动——导致 `smoke.explorerExternalWatch.spec.ts` 的双窗口场景里，第二个窗口的外部新建文件永久检测不到（8s 超时，不是延迟而是彻底漏检）。修复：给 `startWatching()` 补上一次 `_refreshLoadedNodes()`（复用 `_onExcludeChange` 已有的"重读所有已加载目录"逻辑），watch 一旦 arm 就顺带对齐一次期间的漏检。修复后该 e2e 场景稳定通过（多次重跑均 3-6s 内完成，无 flaky）。

**e2e**：`pnpm e2e` 全量 154 个场景（151 + 3 个 `@serial`）全部通过，`pnpm check`（lint + typecheck + 3225 个单测 + 23 个集成测试）全部通过，均无失败。

**结论**：本计划的推迟目标（把 parcel 递归订阅从首屏恢复窗口移到 Eventually 空闲期）已落地并验证通过；额外发现并修复了推迟机制本身引入的"漏检窗口"问题，修复方案与计划风险小节里预先设想的"兜底对齐"思路一致。
