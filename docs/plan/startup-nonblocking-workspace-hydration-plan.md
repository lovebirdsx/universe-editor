# 启动优化 · workspace hydration 不阻塞 renderer 首屏 实施计划

> 背景来源：`/analyze-startup-performance` 对比 `F:/cloud-storage/work`（1.10s，非 git）与 `D:/git_project/universe-editor`（1.47s，git 仓库、9826 文件、48M `.git`）两个工作区的启动报告。
>
> **诊断结论**：慢出来的 ≈350ms 集中在 renderer 恢复窗口。决定性证据在 Marks 表——universe-editor 的四个并行 `load()`（`layout` / `viewDescriptor` / `views` / `terminal`）**精确同刻返回**（都落在 1006.6ms），而 work 里它们分散在 744~786ms。四条线同刻收敛 = 它们共同阻塞在同一个 barrier 上：main 侧的 workspace storage hydration。
>
> **根因链**：四个 load 都读 `IStorageService` 的 **WORKSPACE scope**（`LayoutService.load` → `_storage.get(..., StorageScope.WORKSPACE)`；`ViewsService.load` 显式 `await onDidChangeWorkspaceScope`）。WORKSPACE scope 要等 main 的 `WorkspaceMainService._hydrate()` → `MainStorageService.switchWorkspace()` 完成才可用。大工作区里 main 同时在被 parcel 递归订阅 / Explorer 首读抢占，hydration 落地晚，四个 load 一起干等。
>
> **本计划范围**：让 renderer 首屏**不再硬等** workspace hydration —— 先用默认布局/视图状态把 workbench 挂起来，hydration 落地后再 reconcile（对齐 VSCode 的"先画壳、后填状态"思路）。**收益最大、但改动也最大、风险偏高**。另一个低风险方案（推迟 parcel 订阅）见 `startup-defer-parcel-watch-plan.md`，两者正交，可各自独立执行；**建议先落地那个低风险方案，观察收益后再决定是否上本方案**。
>
> 通用纪律：
> - 每个阶段结束跑 `pnpm check`（仅截取错误输出）；本改动深度触碰恢复链路，末尾必须跑 `pnpm e2e`。
> - 诊断/验证性能前先 `pnpm build`；性能数据只在构建产物上采集。
> - 提交粒度按阶段，commit 信息遵循 conventional commits。

---

## 现状梳理（先读懂，再动手）

关键时序（`apps/editor/src/renderer/main.tsx`）：

```
lifecycle.setPhase(Ready) + await when(Ready)         → BlockRestore contributions
...
mark(willLoadServices)
await Promise.all([                                    ← 首屏的硬同步 barrier
  layoutService.load(),          // 读 WORKSPACE scope
  viewDescriptorService.load(),  // 读 WORKSPACE scope
  viewsService.load(),           // 显式 await onDidChangeWorkspaceScope
  terminalManagerService.load(), // 读 WORKSPACE scope
])
mark(didRestoreServices)
... await import Workbench ...
mark(willMountReact) → reactRoot.render(<Workbench/>)  ← React 首挂载在 load 之后
```

阻塞根源：
- `MainStorageService.get(key, WORKSPACE)`：`this._workspace` 为 null 时直接返回 undefined；`_workspace` 由 `switchWorkspace()` 在 hydration 时才 set（`storageMainService.ts:113`）。
- `WorkspaceMainService._hydrate()`：`await this._storage.switchWorkspace(...)` 后 fire `onDidChangeWorkspaceScope`（`workspaceMainService.ts:88`）。
- `ViewsService.load()` 明确写了：`_workspace.current` 为 null 时 `await onDidChangeWorkspaceScope`（或 `INITIAL_LOAD_TIMEOUT_MS` 超时），把冷启动事件消费在这里——**这正是让 React 挂载被推迟的那一环**。

强约束（不能无脑异步化）：
- **Allotment 只在 mount（或 pane-show）读一次 `preferredSize`**（`main.tsx:657-658` 的注释）。若先用默认尺寸 mount、hydration 后再改 `preferredSize`，Allotment **静默忽略**，侧栏尺寸不会更新。这是本方案最大的技术障碍，方案设计必须正面解决（见阶段 2）。
- `viewsService` 的冷启动事件消费逻辑若改动，要避免 `_reload` 把运行时容器选择"回退/闪烁"。

---

## 阶段 0 · 基线与可行性确认（不产代码）

**目标**：坐实 barrier 就是 hydration，并确认 Allotment 的重设尺寸能力，决定阶段 2 走哪条路。

- [ ] 0.1 `pnpm build` 后采 universe-editor 报告 3 次，记录四个 `didLoad*` 的 offset 是否同刻收敛、`willLoadServices → didRestoreServices` 段、Total（基线）。
- [ ] 0.2 临时在 `main.tsx` 给四个 load 各加细粒度 mark（已有），确认瓶颈是 `viewsService.load` 的 `await onDidChangeWorkspaceScope`（可临时 log hydration fire 的时刻对比）。
- [ ] 0.3 **Allotment 重设尺寸可行性**：查 `WorkbenchLayout.tsx` / `ViewPaneContainer.tsx` 里 Allotment 版本与 API，确认能否用 `ref` 命令式 `resize()`、或用 `key` 强制在尺寸就绪后重挂载该 Allotment 子树。**这一步决定阶段 2 是 2.A 还是 2.B**。

**验证**：产出基线表 + 一条明确结论"Allotment 重设走 ref.resize / 走 remount / 不可行需保留 layout 同步"。

---

## 阶段 1 · 让非布局状态先行、可后置 reconcile

**目标**：先解耦"不受 Allotment 约束"的三类状态（views / viewDescriptor / terminal），让它们从"首屏硬等"变成"先默认、hydration 后 reconcile"。layout 因 Allotment 约束单列到阶段 2。

### 1.1 拆分 load 为 `loadDefaults()` + `reconcileFromStorage()`
- [ ] `ViewsService` / `ViewDescriptorService` / `TerminalManagerService` 各拆两段：
  - `loadDefaults()`：纯同步/极快，给出可立即渲染的默认状态（不读 WORKSPACE storage）。
  - `reconcileFromStorage()`：读 WORKSPACE scope，落地后用现有 observable 通知 UI 更新（这三类都是 observable 驱动，mount 后更新是安全的，不像 Allotment）。
- [ ] `ViewsService` 内现有"等 `onDidChangeWorkspaceScope` 再 `_loadFromStorage`"的逻辑挪进 `reconcileFromStorage()`，**不再卡在首屏 Promise.all 里**。

### 1.2 main.tsx 首屏只等"能立即渲染"的部分
- [ ] 首屏 `Promise.all` 改为只 await `loadDefaults()`（或直接同步），**不再 await WORKSPACE hydration**。
- [ ] 在 hydration 事件（`onDidChangeWorkspaceScope`）到达时触发三个 `reconcileFromStorage()`；用 `this._register` 管理订阅。
- [ ] 保留 `willLoadServices` / `didRestoreServices` mark 语义：`didRestoreServices` 现在标记"默认状态就绪、可挂载"，reconcile 另加新 mark（如 `didReconcileWorkspaceState`）观察后置成本。

**验证**：`pnpm check`；三类视图/终端在 hydration 后能正确恢复（不闪回默认）。

---

## 阶段 2 · 处理 layout（Allotment 约束）

> 依据阶段 0.3 的结论三选一。**优先 2.A / 2.B；若都不可行，保留 layout 的同步等待（本方案退化为只异步化 views/terminal，仍有部分收益）。**

### 2.A（首选，若 Allotment 支持命令式 resize）
- [ ] mount 时用默认 `preferredSize`；`layoutService.reconcileFromStorage()` 落地后，通过 Allotment 的 `ref.resize([...])` 命令式设定各 pane 尺寸。
- [ ] 尺寸变更走一次，避免与用户后续拖拽 persist 抢（复用 `_suspendPersist` 模式）。

### 2.B（备选，remount 子树）
- [ ] 用尺寸就绪信号作为 Allotment 子树的 `key`：hydration 前用默认 key + 默认尺寸，落地后切 key 触发该子树重挂载，让 Allotment 在重挂载时读到正确 `preferredSize`。
- [ ] 评估重挂载的视觉抖动（侧栏一次跳变）是否可接受；若抖动明显，退 2.C。

### 2.C（兜底，保留 layout 同步）
- [ ] layout 仍在首屏 await（仅它一个），views/viewDescriptor/terminal 按阶段 1 异步化。收益打折但零 Allotment 风险。
- [ ] 记录：此路径下 Total 改善主要来自 terminal/views 不再等 hydration，layout 仍受 hydration 牵制。

**验证**：`pnpm check`；侧栏/面板尺寸在冷启动后与上次退出一致，无残留默认尺寸、无明显跳变。

---

## 阶段 3 · 验证与回归

- [ ] 3.1 `pnpm build` 后重采报告 3 次对拍：
  - 预期四个 `didLoad*`（或新的默认就绪 mark）**不再同刻收敛于 hydration**，`willMountReact` offset 提前。
  - 预期 Total 下降；新增的 `didReconcileWorkspaceState` 落在 mount 之后（后置成本可见但不挡首屏）。
- [ ] 3.2 功能回归（关键：状态最终一致，无"闪默认→跳恢复"）：
  - 侧栏宽度 / 面板高度 / panel 最大化状态冷启动后正确恢复。
  - 活动的 ViewContainer / View 选择、终端列表冷启动后正确恢复。
  - 有工作区 / 空窗口两种场景都验证（空窗口无 hydration，reconcile 应 no-op）。
- [ ] 3.3 `pnpm e2e`（仅截取错误）：重点 layout / views / terminal 恢复相关 spec + `@p0`；关注 `WorkbenchLayout.panelResize` 类用例。
- [ ] 3.4 竞态检查：hydration 若在 mount **之前**就已就绪（小工作区/快 main），reconcile 不应重复应用或回退运行时改动（幂等 + `_suspendPersist`）。

**验证**：性能对拍表 + 状态一致性清单 + e2e 通过，写入"验证记录"。

---

## 风险与注意

- **Allotment 尺寸重设是头号风险**（阶段 0.3 必须先定论）。处理不当会出现侧栏卡默认宽度——比慢 300ms 更糟的可见 bug。若无把握，走 2.C 保守路径。
- **状态闪烁**：先默认后 reconcile 天然有"默认→恢复"的一跳。observable 驱动的 views/terminal 通常在同一帧内更新、不可见；layout 若走 remount 可能可见，需实测。
- **竞态**：hydration 与 mount 的先后不确定，reconcile 必须幂等、可在 mount 前/后任意顺序到达。
- **与推迟 parcel 订阅方案的关系**：两者正交且互补——推迟订阅让 main 更早空出来使 hydration 更快，本方案让首屏不等 hydration。**先上低风险的推迟订阅方案，可能已吃掉大部分差距，届时本方案的性价比需重新评估。**
- 性能须在 `pnpm build` 产物上测。

---

## 涉及文件速查

- `apps/editor/src/renderer/main.tsx` — 首屏 `Promise.all` barrier + mark（主战场）
- `apps/editor/src/renderer/services/layout/LayoutService.ts` — `load` 拆 defaults/reconcile；Allotment 尺寸
- `apps/editor/src/renderer/services/views/ViewsService.ts` — `load` 里 `await onDidChangeWorkspaceScope`（关键阻塞点）
- `apps/editor/src/renderer/services/views/ViewDescriptorService.ts` — 同类拆分
- `apps/editor/src/renderer/services/terminal/TerminalManagerService.ts` — 同类拆分
- `apps/editor/src/renderer/workbench/layout/WorkbenchLayout.tsx` / `workbench/sidebar/ViewPaneContainer.tsx` — Allotment 消费点（阶段 0.3 / 2 关键）
- `apps/editor/src/main/services/storage/storageMainService.ts` — `switchWorkspace` / `onDidChangeWorkspaceScope`（不改，理解 hydration 语义）
- `apps/editor/src/main/services/workspace/workspaceMainService.ts` — `_hydrate`（不改，理解触发时机）
- `apps/editor/src/shared/perf/marks.ts` — 恢复相关 mark；如新增 `didReconcileWorkspaceState` 在此加常量并进 `TimerService.MILESTONES`（若要进 Phases 表）

---

## 验证记录

（执行时填写：基线均值 / 改动后均值 / 关键 offset 变化 / Allotment 走哪条路 / e2e 结果）
