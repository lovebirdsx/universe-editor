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

- [ ] 0.1 `pnpm build` 后，用 `Developer: Startup Performance` 在 universe-editor 工作区采集 3 次报告，记录 `mainWillWatchWorkspace` / `mainDidWatchWorkspace` offset、`willLoadServices → didRestoreServices` 段、`didInitializeMonaco` offset、Total。
- [ ] 0.2（可选但推荐）隔离验证根因：临时把 `.git` 改名 `.git_bak` 重启采一次，确认恢复段是否明显回落。回落 → 坐实"大目录/大树"是主因，本方案对症。测完改回。

**验证**：得到一张基线均值表，写入本文件末尾"验证记录"。

---

## 阶段 1 · 让 Explorer 首读与 watch 订阅解耦

**目标**：`_setRoot` 冷启动时只做根目录展开（首屏需要），把 parcel 订阅拆成一个可延迟触发的独立步骤。

### 1.1 拆分 `_setRoot`（`ExplorerTreeService.ts`）
- [ ] 把 `_setRoot` 里的 `this._watcher.watch(...)` / `this._watcher.unwatch()` 抽到独立私有方法 `_syncWatch(root: URI | null)`。
- [ ] `_setRoot` 仍同步做：normalize、清空 nodes、`_model.expand(rootEntry)`（保证 Explorer 首屏可见）。
- [ ] 新增一个标志 `_coldWatchDeferred`（或复用"是否首次 setRoot"判断），区分冷启动首次 vs 运行时切换。

### 1.2 冷启动推迟、运行时立即
- [ ] 构造函数末尾的**首次** `_setRoot`：只展开，不立即 `_syncWatch`；把 `_syncWatch(root)` 交给延迟触发点（阶段 2）。
- [ ] `onDidChangeWorkspace` 引发的 `_setRoot`（运行时切换）：**立即** `_syncWatch`，保持现有行为不变。

**验证**：`pnpm --filter editor typecheck` 通过；单测（若 `ExplorerTreeService` 有 __tests__）中"构造即 watch"的断言按新时序调整。

---

## 阶段 2 · 选择延迟触发机制

> 二选一，2.A 更省事、2.B 更贴合仓库 Eventually 范式。建议先评估 2.A，够用就不必上 2.B。

### 2.A（首选）在 ExplorerTreeService 内用 idle 回调自触发
- [ ] 冷启动首次 `_setRoot` 后，用 platform 的 idle 工具（`runWhenIdle` / `requestIdleCallback` 等价物，确认 `packages/platform/src/base/async.ts` 是否已导出；无则用 `setTimeout(0)` 兜底）安排一次 `_syncWatch(this._root)`。
- [ ] 该延迟句柄 `this._register(...)`（或在 dispose 中 clear），避免 disposable 泄漏（本仓库 dev/E2E 有 tracker，会红）。
- [ ] 若在 idle 触发前工作区已切换，以最新 `this._root` 为准（幂等：`_syncWatch` 内部对相同 root 已由 `FileWatcherMainService.watch` 的 `sameSet` 去重）。

### 2.B（备选）挂到 Eventually 阶段 contribution
- [ ] 新增 `WorkspaceWatchContribution`（`WorkbenchPhase.Eventually`），在 `contributions/registration/eventually.ts` 注册（与 `ExtensionsContribution` 同阶段）。
- [ ] contribution 注入 `IExplorerTreeService`，在其生命周期回调里调用一个新暴露的 `explorerTreeService.startWatching()`（内部即冷启动的 `_syncWatch(this._root)`，幂等）。
- [ ] `ExplorerTreeService` 暴露 `startWatching()` 公有方法；冷启动构造不再自触发 watch。

**验证**：`pnpm check`；确认无新增 disposable 泄漏报告。

---

## 阶段 3 · 验证与回归

- [ ] 3.1 `pnpm build` 后重采 universe-editor 启动报告 3 次，与阶段 0 基线对拍：
  - 预期 `mainWillWatchWorkspace` offset **后移到 `didMount` 之后**（推迟成功的直接证据）。
  - 预期 `willLoadServices → didRestoreServices`、`didInitializeMonaco` 段**回落**（不再被 watch 抢 CPU）。
  - 预期 Total 下降（目标：吃掉方案对应的一部分 ≈350ms 差距）。
- [ ] 3.2 功能回归（关键：推迟 watch 不能破坏"外部改动自动刷新"）：
  - 手动在工作区外部（另开终端 / 编辑器）创建 / 修改 / 删除文件，确认 Explorer 树在首屏之后仍能自动刷新。
  - 确认 `useSearchEngine` / `ExternalChangeWatcher` 等其它 `onDidChangeFiles` 消费方在延迟窗口后正常收事件。
- [ ] 3.3 `pnpm e2e`（仅截取错误）：重点跑 explorer / 文件外部变更 / workspace 切换相关 spec；关注 `@p0`。
- [ ] 3.4 边界：空窗口（无工作区）不应触发 watch；打开文件夹后（运行时路径）watch 应**立即**生效，不被推迟逻辑波及。

**验证**：性能对拍表 + 功能回归清单 + e2e 通过，写入"验证记录"。

---

## 风险与注意

- **推迟窗口内的外部改动会漏事件**：从首屏 mount 到 idle 触发 watch 之间（通常几十~几百 ms）的外部文件改动不会被捕获。可接受（用户此刻刚打开窗口、极少外部并发改动）；若要更稳，可在 `_syncWatch` 生效后做一次根目录 `_model.refresh()` 兜底对齐。
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

（执行时填写：基线均值 / 改动后均值 / 关键 offset 变化 / e2e 结果）
