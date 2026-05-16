# 主题 3 改造基线（2026-05）

本文档记录 universe-editor 在「主题 3：Lazy Service + Event 算子 + Leak 检测」开工前的代码态势，作为改造后对比的参照。采集方式为**静态调研**——读源码计数，不插入侵入式埋点（避免污染待改文件）。

## 一、服务注册态势

### 渲染进程启动期注册的服务

入口：`apps/editor/src/renderer/main.tsx:186` 的 `bootstrapWorkbench()`

| # | ServiceIdentifier | 注册形式 | 实例化时机 |
|---|---|---|---|
| 1 | `IInstantiationService` | 容器自注册 | 立即 |
| 2 | `ILifecycleService` | `new LifecycleService()` | 立即 |
| 3 | `IIpcService` | `createRendererIpcService()` | 立即 |
| 4 | `IHostService` | `ProxyChannel.toService(...)` | 立即（实际方法调用走 IPC） |
| 5 | `IStorageService` | `ProxyChannel.toService(...)` | 立即 |
| 6 | `IPingService` | `ProxyChannel.toService(...)` | 立即 |
| 7 | `ICommandService` | `new CommandService(instantiation)` | 立即 |
| 8 | `IEditorService` | `new EditorService()` | 立即 |
| 9 | `IStatusBarService` | `new StatusBarService()` | 立即 |
| 10 | `IViewsService` | `new ViewsService()` | 立即 |
| 11 | `IOutputService` | `new OutputService()` | 立即 |
| 12 | `IQuickInputService` | `instantiation.createInstance(QuickInputService)` | 立即 |
| 13 | `ILayoutService` | `instantiation.createInstance(LayoutService)` | 立即 |
| 14 | `IContributionService` | `new ContributionService(...)` | 立即 |

**14 个服务全部立即实例化。** 包括 `IQuickInputService` 这种用户可能从不打开命令面板的冷路径服务。

### SyncDescriptor 在生产代码中的使用

```
$ grep -rn "new SyncDescriptor" --include='*.ts' (排除 __tests__/)
（无匹配）
```

`SyncDescriptor` **仅在测试文件中使用**（`packages/platform/src/__tests__/di/instantiation.test.ts:107/117/164`）。

### supportsDelayedInstantiation 标记

```
$ grep -rn "supportsDelayedInstantiation"
packages/platform/src/di/descriptors.ts:11
packages/platform/src/di/descriptors.ts:17
packages/platform/src/di/descriptors.ts:21
```

字段仅在 `SyncDescriptor` 类内部声明，**零调用方**。`packages/platform/src/di/instantiationService.ts:4` 顶部注释明确写：

> *Adapted from Microsoft VSCode for Universe Editor (Trace and **delayed instantiation removed**).*

即 lazy 分支在适配时被显式删除——`SyncDescriptor.supportsDelayedInstantiation` 当前是一个**保留接口**，没有任何运行时效果。

## 二、Event 使用面

`new Emitter` 调用点共 **16 处**：

```
packages/platform/src/ipc/ipc.ts
packages/platform/src/lifecycle/lifecycleService.ts
packages/platform/src/workbench/viewRegistry.ts
packages/platform/src/command/contextKey.ts
packages/platform/src/command/menuRegistry.ts
packages/platform/src/configuration/configurationRegistry.ts
packages/platform/src/configuration/configurationService.ts
packages/platform/src/base/event.ts
apps/editor/src/renderer/workbench/quickinput/QuickInputService.ts
apps/editor/src/renderer/ipc/electronProtocol.ts
apps/editor/src/main/ipc/electronProtocol.ts
apps/editor/src/main/services/host/hostMainService.ts
（+ 4 处测试代码）
```

现有 Event 算子（`packages/platform/src/base/event.ts`）：

| 算子 | 行号 | 状态 |
|---|---|---|
| `Event.once` | 36-61 | 已有 |
| `Event.map` | 66-69 | 已有 |
| `Event.filter` | 74-79 | 已有 |
| `Event.any` | 84-99 | 已有 |
| `Event.toPromise` | 104-106 | 已有 |
| `Event.debounce` | — | **缺失** |
| `Event.throttle` | — | **缺失** |
| `PauseableEmitter` | — | **缺失** |
| `Relay` | — | **缺失** |

`Emitter` 钩子已齐：`onWillAddFirstListener / onDidAddFirstListener / onDidAddListener / onWillRemoveListener / onDidRemoveLastListener / onListenerError`（event.ts:109-122）。

`Emitter.fire` 已实现 listener 快照（event.ts:204-214）以支持重入 fire；错误隔离已具备。

`packages/platform/src/base/linkedList.ts` 已存在并被 CommandsRegistry / Emitter 使用，可直接服务于 `PauseableEmitter._eventQueue` 与 lazy 服务的 `earlyListeners`。

## 三、Disposable 使用面

`new DisposableStore` 调用点共 **10 处**：

```
packages/platform/src/base/observable/reactions/autorun.ts
packages/platform/src/base/observable/reactions/autorunImpl.ts
packages/platform/src/base/observable/utils/runOnChange.ts
packages/platform/src/base/observable/utils/utils.ts
packages/platform/src/base/lifecycle.ts        (内部使用)
packages/platform/src/base/observable/observables/derived.ts
packages/platform/src/base/observable/observables/derivedImpl.ts
（+ 3 处测试代码）
```

现有 lifecycle API（`packages/platform/src/base/lifecycle.ts`）：

| API | 行号 | 状态 |
|---|---|---|
| `IDisposable` | 11-13 | 已有 |
| `isDisposable` | 18-25 | 已有 |
| `dispose` (重载) | 34-64 | 已有 |
| `combinedDisposable` | 69-71 | 已有 |
| `toDisposable` | 78-88 | 已有，含一次性保护 |
| `markAsSingleton` | 94-96 | **no-op**（注释：simplified implementation） |
| `DisposableStore` | 101-183 | 完整；含 `DISABLE_DISPOSED_WARNING` 开关 |
| `Disposable` 基类 | 188-203 | 含 `_register` 模式 |
| `MutableDisposable` | 210-244 | 含 `clearAndLeak` |
| `IDisposableTracker` | — | **缺失** |
| `setDisposableTracker` | — | **缺失** |
| `DisposableTracker` (dev) | — | **缺失** |
| `GCBasedDisposableTracker` | — | **缺失** |

**当前唯一的"泄漏检测"**：`DisposableStore.add` 在向已 dispose 的 store 添加项时打印警告（lifecycle.ts:147-152）。无创建栈、无树形分析、无全局 hook。

## 四、辅助原语

| 原语 | 状态 |
|---|---|
| `LinkedList` (`base/linkedList.ts`) | 已有 |
| `runWhenIdle` / `IdleValue` / `GlobalIdleValue` | **缺失** |
| `FinalizationRegistry` 用例 | 无 |

## 五、改造后预期对比口径

主题 3 完成后，本节将在 `## After` 区段填入对比数据。预期变化方向：

1. **服务实例化数**：服务清单本身不变（WP2 仅提供能力，不主动切换调用方），但 lazy 能力可用后，后续主题可把 `IQuickInputService / IOutputService` 等冷路径切到 `new SyncDescriptor(Foo, [], true)` 注册，启动期实例化从 14 降至 ~10
2. **Event 算子**：新增 4 个（debounce / throttle / PauseableEmitter / Relay），调用点零改动
3. **Disposable 检测**：dev 模式启用 tracker 后，关闭应用时输出未释放 Disposable 报告；vitest 测试可用 `withLeakCheck` 包装

---

## After（2026-05-16 主题 3 完成）

主题 3 全部 WP（WP1~WP5）完成，`pnpm check` 全绿。改动**新增能力为主**，不破坏既有 API。

### 服务实例化数

| 维度 | Before | After |
|---|---|---|
| 渲染进程启动期立即实例化的服务 | 14 | 14（不变） |
| 生产代码中使用 `SyncDescriptor` 的位置 | 0 | 0（不变，按计划不主动迁移） |
| `SyncDescriptor.supportsDelayedInstantiation = true` 的运行时效果 | **无**（注释明确写"removed"） | **可用**（Proxy + GlobalIdleValue 分支已就位） |

> WP2 仅恢复 lazy 能力的开关，**不动**任何调用方。后续主题在已知冷路径服务（如 `IQuickInputService / IOutputService`）上启用 `supportsDelayedInstantiation = true`，启动期实例化数才会下降。

`instantiationService.ts` 顶部注释已更新为 *(Trace removed)*——`delayed instantiation` 不再标注为缺失。

### Event 算子

| 算子 | Before | After |
|---|---|---|
| `Event.debounce` | 缺失 | ✅ 新增（`event.ts:116-174`） |
| `Event.throttle` | 缺失 | ✅ 新增（`event.ts:181-232`） |
| `PauseableEmitter` | 缺失 | ✅ 新增（`event.ts:369-410`，含 `merge` 与嵌套 pause 计数） |
| `Relay` | 缺失 | ✅ 新增（`event.ts:418-448`，无 listener 时不持订阅） |

16 处 `new Emitter` 调用点零改动。新增 16 个单测（`event.operators.test.ts`）。

### Disposable 检测

| API | Before | After |
|---|---|---|
| `IDisposableTracker` 接口 | 缺失 | ✅ 新增（`lifecycle.ts`） |
| `setDisposableTracker(t \| null)` | 缺失 | ✅ 新增 |
| `DisposableTracker` (dev 实现，含 `computeLeakingDisposables`) | 缺失 | ✅ 新增（捕获创建栈） |
| `GCBasedDisposableTracker` (prod 轻量实现) | 缺失 | ✅ 新增（基于 `FinalizationRegistry`） |
| `markAsSingleton` | no-op | ✅ 真实接入 tracker |
| 埋点位置 | 仅 `DisposableStore.add` 警告 | `toDisposable` / `combinedDisposable` / `DisposableStore.{ctor,add,dispose,deleteAndLeak}` / `Disposable.{ctor,dispose}` / `MutableDisposable.{ctor,value,dispose,clearAndLeak}` 全覆盖 |

桌面端 dev 入口（main + renderer）已挂载 tracker：
- `apps/editor/src/main/index.ts:13-22` — `process.on('exit')` 输出报告
- `apps/editor/src/renderer/main.tsx:188-200` — `beforeunload` 输出报告

测试工具：`packages/platform/src/__tests__/_helpers/leakAssert.ts` 提供 `useLeakCheck()` / `withLeakCheck()`。

### 辅助原语

| 原语 | Before | After |
|---|---|---|
| `runWhenIdle` | 缺失 | ✅ 新增（`base/async.ts`） |
| `AbstractIdleValue<T>` / `GlobalIdleValue<T>` | 缺失 | ✅ 新增 |

### 测试覆盖

| | Before | After |
|---|---|---|
| `@universe-editor/platform` 测试数 | 172 | **204** |
| 新增测试套件 | — | `async.test.ts` (10) / `event.operators.test.ts` (16) / `instantiationService.lazy.test.ts` (11) / `_helpers/leakAssert.test.ts` (5) / `lifecycle.test.ts` 中追加 8 个 tracker 用例 |

### 集成验证

- `pnpm check`（lint + typecheck + test + build）：✅ 全绿
- 桌面端构建：✅ `electron-vite build` 成功（main 6.52 kB / preload 0.77 kB / renderer 748.73 kB）
- 现有 16 处 `new Emitter` 与 10 处 `new DisposableStore` 调用点零改动；调用方零迁移
- 桌面端手工冒烟：留待后续在真实运行时观察 dev tracker 报告

### 边界（按计划保持的"不做"清单）

- 未把任何服务标记成 `supportsDelayedInstantiation = true`（交后续主题按服务冷热路径推进）
- 未引入 VSCode 的 `EventDeliveryQueue`（嵌套 fire 问题当前未观察到）
- 未实现 `MicrotaskDelay` 哨兵分支（保留可选参数预留接口）
- 未对历史代码做"清零泄漏"扫荡（tracker 启用后若发现泄漏，单独建 issue）

