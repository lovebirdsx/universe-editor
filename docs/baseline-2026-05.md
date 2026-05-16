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

---

## After 主题 2：Part 抽象 + Contribution 驱动（2026-05-16）

「主题 2」把六大部件升级为「一等公民」（`IPart` / `Part` 基类 + `ILayoutService` 注册表），同时把 `apps/editor/src/renderer/main.tsx` 里 184 行的 `registerBuiltInContributions(deps)` 巨函数拆成 5 个独立的 `IWorkbenchContribution` 类，交给 `ContributionService` 按 lifecycle phase 自动驱动。

### Part 抽象层

| 维度 | Before | After |
|---|---|---|
| `IPart` 接口 | 缺失（六大部件只是普通 React 组件） | ✅ 新增（`packages/platform/src/workbench/part.ts`） |
| `Part` 基类（`Disposable` 子类，可见性 Observable + 容器/焦点 API） | 缺失 | ✅ 新增（含 `_attachContainer` / `_setFocusTarget` internal API） |
| `IPartContainerElement` 结构类型 | 缺失 | ✅ 新增（避免 platform 包依赖 `lib.dom`） |
| 容器元素由 React 注入的桥（`usePartContainer`） | 缺失 | ✅ 新增（`apps/editor/src/renderer/workbench/usePartContainer.ts`） |
| 六个具体 Part 类（ActivityBar / SideBar / SecondarySideBar / EditorArea / Panel / StatusBar） | 缺失 | ✅ 新增（`apps/editor/src/renderer/workbench/parts/index.ts`，皆走 `@ILayoutService` DI） |
| `ILayoutService.registerPart / getPart / getParts / onDidRegisterPart` | 缺失 | ✅ 新增（4 个新 API；现有 6 个 API 零改动） |
| React 组件 ↔ Part 联动 | — | 六个组件签名追加 `part?: IPart \| undefined`，用 `useRef` + `usePartContainer` 把 DOM 推给 Part 实例 |

### Contribution 化

| 维度 | Before | After |
|---|---|---|
| `ContributionsRegistry.registerContribution` 调用方 | **0** | **5**（5 个内置 contribution） |
| 内置注册路径 | 184 行的 `registerBuiltInContributions(deps)` 函数 + 单点调用 | 5 个独立 contribution 类 + `contributions/index.ts` 单点 side-effect import |
| `main.tsx` 行数 | 282 | **136**（-146 / -52%） |
| 命令/键绑定/菜单注册位置 | `main.tsx` 内联 | `LayoutCommandsContribution` / `CommandPaletteContribution` / `MenuPlacementsContribution` |
| ViewContainer 注册位置 | `main.tsx` 内联 | `BuiltInViewContainersContribution`（Phase `BlockStartup`） |
| 默认 status bar entry 注册 | `lifecycle.when(Ready).then(...)` 内联 | `StatusBarDefaultsContribution`（Phase `AfterRestore`） |
| 命令处理函数风格 | 闭包捕获 `layoutService` 等 | VSCode 风格：使用 `ServicesAccessor` 参数 `accessor.get(IXxx)` 取服务 |

Contribution → Phase 调度表：
- `BlockStartup` (Starting)：`BuiltInViewContainersContribution`
- `BlockRestore` (Ready)：`LayoutCommandsContribution` / `CommandPaletteContribution` / `MenuPlacementsContribution`
- `AfterRestore` (Restored)：`StatusBarDefaultsContribution`

### 测试覆盖

| | Before（主题 3 完成时） | After |
|---|---|---|
| `@universe-editor/platform` 测试数 | 204 | **213**（+9：`part.test.ts`） |
| `@universe-editor/editor` 测试数 | 53 | **74**（+21） |
| 新增测试套件 | — | `part.test.ts` (9) / `LayoutService.parts.test.ts` (7) / `Parts.test.ts` (5) / `LayoutCommandsContribution.test.ts` (6) / `BuiltInViewContainersContribution.test.ts` (3) |

### 集成验证

- `pnpm check`（lint + typecheck + test + build）：✅ 全绿
- 桌面端 `electron-vite build`：✅（main 6.52 kB / preload 0.77 kB / renderer 757.14 kB）
- 既有六个 React 组件 / CSS / ViewContainer-driven 渲染逻辑零回归
- 命令保持等价：Ctrl+B / Ctrl+Alt+B / Ctrl+J / Ctrl+Shift+P 与原有 `registerBuiltInContributions` 同名同行为

### 边界（按计划保持的"不做"清单）

- **不**改造 TitleBar / MenuBar 为 Part（当前不受 LayoutService 管控，留待后续 banner / chat bar 主题）
- **不**移植 VSCode 的 `PartLayout` 嵌套（header/content/footer 子区域计算）
- **不**移植 `Themable / Component` 继承链（样式仍由 CSS Module + 全局 CSS Variables 控制）
- **不**实现 ID-based `lazy: true` Contribution 高级选项（5 个内置 contribution 都是同步小任务，足够）
- **不**做 `PartId` → `PartDescriptor` 对象迁移（`const enum` 保持，对内调用零改动）
- **不**清理 `Panel.tsx` 的 `BUILT_IN_TABS` 硬编码（主题 5 范畴）
- **不**新增可选的 `registerWorkbenchContribution(id, ctor, phase)` 包装函数（直接 `ContributionsRegistry.registerContribution` 已足够清晰）

---

## After 主题 4：Action / WhenContext 体系（2026-05-16）

「主题 4」把命令系统的「when 这条线」真正闭合：表达式从「正则手撕的 4 种语法」升级为 VSCode 全量 grammar（15 种 AST 节点 + Scanner + Parser）；`ContextKeyService` 引入强类型 `IContextKey<T>` handle；`MenuRegistry` / `KeybindingsRegistry` 在 `when` 字段上**真正过滤**；新增 `Action2` 抽象一次性声明 command + keybinding + menu；4 个内置命令全部迁移到 Action2，3 个旧 contribution 删除。

### ContextKeyExpr 表达式体系

| 维度 | Before | After |
|---|---|---|
| 表达式语法 | 4 种（bare key / `==` / `!=` / `!key`），正则手撕 | **15 种 AST 节点 + 完整 Scanner + 递归下降 Parser**（VSCode 全量 grammar） |
| 节点种类 | — | False / True / Defined / Not / Equals / NotEquals / Regex / NotRegex / And / Or / In / NotIn / Greater / GreaterEquals / Smaller / SmallerEquals |
| 操作符 | `==` `!=` `!` 仅 | 加 `<` `<=` `>` `>=` `=~` `in` `not in` `&&` `\|\|` `()` |
| 字面量 | 仅 bare 值 | bare 值 / 单引号字符串（含转义）/ 正则 `/.../flags` / `true` / `false` / 数字 |
| 错误恢复 | — | Parser 遇语法错返回 undefined（VSCode 一致，不抛异常） |
| 规约 | — | And/Or 自动去重、扁平化嵌套、True/False 短路、`x && !x → false` / `x \|\| !x → true` |
| 序列化往返 | — | `deserialize(expr.serialize()).equals(expr)` |
| 模块行数 | 0 | `contextKeyExpr.ts` 970 / `contextKeyScanner.ts` 380 / `contextKeyParser.ts` 358 |

### ContextKeyService API 表面

| API | Before | After |
|---|---|---|
| `set(key, value)` | ✅ | ✅ |
| `get(key)` | ✅（含 parent fallback） | ✅ |
| `remove(key)` | ✅ | ✅ |
| `evaluate(when: string): boolean` | ✅（仅 4 种语法） | ✅（内部走 `ContextKeyExpr.deserialize(when)?.evaluate(getContext())`） |
| `onDidChangeContext` | ✅ | ✅（支持 parent → scoped 传播） |
| `createScoped(overrides?)` | ✅ | ✅（dispose 时清空本地 keys） |
| `createKey<T>(name, default)` | **缺失** | ✅ 新增（返回 `IContextKey<T>` handle，支持 `set / reset / get`） |
| `contextMatchesRules(expr \| undefined)` | **缺失** | ✅ 新增（`undefined` 视作永真，VSCode 语义） |
| `getContext()` | **缺失** | ✅ 新增（返回 `IContext` 快照视图，含 parent fallback） |

API 表面：**3 个核心方法 → 6 个**（+ `createKey` / `contextMatchesRules` / `getContext`）。旧调用方零迁移。

### MenuRegistry / KeybindingsRegistry when 过滤

| 维度 | Before | After |
|---|---|---|
| `IMenuItem.when` 字段类型 | `string \| undefined`（仅占位） | `ContextKeyExpression \| string \| undefined`（构造时反序列化） |
| `MenuRegistry.getMenuItems(menuId)` | 全量返回 | 重载 `(menuId, contextKeyService?)`：传 service 则按 `when.evaluate(ctx)` 过滤 |
| `IKeybindingItem.when` 字段类型 | `string \| undefined` | `ContextKeyExpression \| string \| undefined` |
| `KeybindingsRegistry.resolveKeybinding(key)` | 接受 `Record<string, unknown>` 做 truthy 检查 | 重载 `(key, contextKeyService?)`：传 service 则跳过 `when.evaluate(ctx) === false` 的 binding；不传则忽略 when（向后兼容） |
| TitleBar 菜单 `when` 是否生效 | ❌ `useTitleBarMenus.resolveSections()` 完全忽略 | ✅ 注入 `IContextKeyService`，订阅 `onDidChangeContext` + `onDidChangeMenu`，按 when 过滤后渲染 |
| Keybinding `when` 是否生效 | ❌ `useGlobalKeybindingHandler` 调用时不传 contextKeys | ✅ 调用 `resolveKeybinding(key, contextKeyService)` |

### Action2 一站式声明

| 维度 | Before | After |
|---|---|---|
| 命令注册路径 | **3 个 contribution 分裂**：`LayoutCommandsContribution`（command + keybinding）/ `MenuPlacementsContribution`（菜单）/ `CommandPaletteContribution`（命令面板） | **1 个 `actions/` 目录**：`layoutActions.ts`（4 个 Action2 子类）+ `actions/index.ts`（registerAction2 调用汇总） |
| `Action2` 抽象 | 缺失 | ✅ 新增（`packages/platform/src/command/action.ts`，145 行） |
| `registerAction2(ctor)` | 缺失 | ✅ 一次调用同时落 `CommandsRegistry` / `KeybindingsRegistry` / `MenuRegistry`，返回 combinedDisposable |
| `IAction2Options` 声明字段 | — | `id` / `title` / `category` / `icon` / `precondition` / `menu` / `keybinding` / `f1`（f1=true 自动追加 CommandPalette menu item） |
| precondition + menu.when 组合 | — | 内部 `combineWhen` helper：`undefined && X → X` / `X && undefined → X` / 两者都在 → `ContextKeyExpr.and(a, b)` |

迁移后 4 个内置命令的注册总入口：
- `apps/editor/src/renderer/actions/layoutActions.ts` — 4 个 `Action2` 子类（ToggleSidebarVisibility / ToggleSecondarySidebarVisibility / TogglePanel / ShowCommands）
- `apps/editor/src/renderer/actions/index.ts` — 4 行 `registerAction2(...)`
- 旧 `LayoutCommandsContribution.ts` / `CommandPaletteContribution.ts` / `MenuPlacementsContribution.ts` **全部删除**

### 默认 ContextKey（4 类，全部接入）

`ContextKeyContribution`（Phase `BlockStartup`）通过 `@IContextKeyService` `@IHostService` `@ILayoutService` `@IEditorService` `@ILifecycleService` 注入，统一管理：

| 类别 | Key | 来源 |
|---|---|---|
| 平台标识 | `isWindows` / `isMac` / `isLinux` | `host.platform` 启动时一次性 set |
| 部件可见性 | `sideBarVisible` / `secondarySideBarVisible` / `panelVisible` | `autorun(layoutService.visible.<part>)` |
| 编辑器状态 | `activeEditorId`（string）/ `hasActiveEditor`（boolean） | `autorun(editorService.activeEditor)` |
| Lifecycle 阶段 | `workbenchReady` / `workbenchRestored` | `lifecycle.when(Ready/Restored).then(handle.set(true))` |

### main.tsx 行数

| 维度 | Before（主题 3） | After 主题 2 | After 主题 4 |
|---|---|---|---|
| `apps/editor/src/renderer/main.tsx` 行数 | 282 | 136 | **143**（+7：注入 ContextKeyService） |

### DI 注入

| 服务 | Before | After |
|---|---|---|
| `IContextKeyService` 注册到 InstantiationService | ❌ 零生产引用 | ✅ `main.tsx` 在 lifecycle 之后立即注入 `new ContextKeyService()` |
| `useGlobalKeybindingHandler` 注入 `IContextKeyService` | ❌ | ✅ |
| `useTitleBarMenus` 注入 `IContextKeyService` | ❌ | ✅（订阅 `onDidChangeContext` 触发重渲染） |

### 测试覆盖

| | Before（主题 2 完成时） | After 主题 4 |
|---|---|---|
| `@universe-editor/platform` 测试数 | 213 | **297**（+84） |
| `@universe-editor/editor` 测试数 | 74 | **81**（+7） |
| 新增测试套件 | — | `contextKeyExpr.test.ts`（39）/ `contextKeyService.test.ts`（16）/ `commandRegistry.test.ts` 追加 4（when 过滤）/ `action.test.ts`（6）/ `layoutActions.test.ts`（7）/ `ContextKeyContribution.test.ts`（6）/ `useGlobalKeybindingHandler.test.tsx` 改造（注入 ContextKeyService） |
| 删除测试 | — | `LayoutCommandsContribution.test.ts`（被 `layoutActions.test.ts` 取代） |

### 集成验证

- `pnpm check`（lint + typecheck + test + build）：✅ 全绿
- 桌面端 `electron-vite build`：✅（main 6.52 kB / preload 0.77 kB / renderer 806.97 kB JS + 25.27 kB CSS）
- 命令保持等价：Ctrl+B / Ctrl+Alt+B / Ctrl+J / Ctrl+Shift+P 与原有 contribution 同名同行为
- View 菜单四项条目仍在 TitleBar 显示，命令面板 `Show All Commands` 仍能开
- 表达式向后兼容：旧 `evaluate(string)` 入口保留，旧 `IMenuItem.when: string` / `IKeybindingItem.when: string` 字段保留字符串口

### 边界（按计划保持的"不做"清单）

- **不**支持表达式中的「自定义函数调用」
- **不**实现 `ContextKey` 的 priority / override 模型（保留主题 1 的 parent 链查找语义）
- **不**实现 keybinding 的 chord（双 key 组合 Ctrl+K Ctrl+S）—— 留主题 8
- **不**移植 `IKeybindingService` 解析器/上下文匹配链（KeybindingsRegistry 直接调 contextKeyService 已足够）
- **不**实现 VSCode 的 `localize` 国际化（title 仅取字符串 `.value`）
- **不**为 ActivityBar 视图切换、Tab 拖拽等动作创建 Action2（主题 5 / 主题 8）
- **不**触动 status bar 默认 entry（保留 `StatusBarDefaultsContribution`）
- **不**改 `BuiltInViewContainersContribution`（仍走纯注册）
- **不**外露 Parser 的 `errors[]` 输出通道（VSCode 有，本主题暂不暴露）
- **不**改造 `TitleBar.tsx:9` 的 `host.platform === 'darwin'` 直接比对为 ContextKey（一处常量判定不强求；isMac key 已就绪，后续按需切换）

---

## 七、After 主题 5（Editor Groups：split editor / 多分组）

### EditorService API 表面

| 维度 | Before（主题 4） | After 主题 5 |
|---|---|---|
| `IEditorService` 方法数 | 5（`openEditors` / `activeEditorId` / `activeEditor` / `openEditor` / `closeEditor` / `closeAllEditors`） | **保留全 5 个（兼容层），内部代理到 `IEditorGroupsService.activeGroup`** |
| `IEditorInput` 形态 | 结构体（5 字段：`id / type / label / isDirty / meta`） | 结构体保留；新增抽象基类 `EditorInput`（`abstract typeId / resource / getName()` + `matches()` + `onDidChangeDirty` + `onWillDispose`） |
| `IEditorGroupsService` | ❌ 不存在 | ✅ **10+ API**：`activeGroup` / `groups` / `count` / `orientation` / `addGroup` / `removeGroup` / `moveGroup` / `activateGroup` / `findGroup` / `moveEditor` / `copyEditor` / `setGroupOrientation` / `arrangeGroups` + 4 个事件 |
| `IEditorGroup` 接口 | ❌ | ✅ **10+ API**：`id / index / isActive / editors / activeEditor / count` + `openEditor` / `closeEditor` / `closeAllEditors` / `moveEditor` / `setActive` / `getEditorByIndex` / `indexOf` / `isFirst` / `isLast` + 2 个事件 |
| URI 类 | ❌ | ✅ `URI`（`scheme / authority / path / query / fragment` + `parse` / `file` / `from` / `joinPath` / `with` / `toString` / `toJSON` / `revive`） |

### Grid 容器与 UI

| 维度 | Before | After |
|---|---|---|
| `Grid<T>` 二叉树容器 | ❌ | ✅ `packages/platform/src/base/grid.ts`：`addView / removeView / moveView / swapViews / resizeView / serialize / deserialize` |
| `Sash.tsx` 拖拽分隔条 | ❌ | ✅ `apps/editor/src/renderer/workbench/editor/Sash.tsx`（mousedown/move/up + 全局 cursor + active 视觉态） |
| `GridLayout.tsx` 递归渲染 | ❌ | ✅ 用 `useSyncExternalStore(grid.onDidChange)` 订阅，二叉树渲染嵌套 flex + Sash |
| `EditorGroupView.tsx` | ❌（单 div tab bar 直挂 EditorArea） | ✅ 每个 group 独立 React 组件：tab bar + 内容区 + 点击激活 + isActive 视觉态 |
| `EditorArea.tsx` | 单一水平 tab bar + 单 content 区 | 用 `GridLayout` + 每个叶子渲染 `EditorGroupView` |

### 命令注册（Action2）

| 类别 | Before 主题 5 | After 主题 5 |
|---|---|---|
| Layout | 4（ToggleSidebar / ToggleSecondarySidebar / TogglePanel / ShowCommands） | 4（不变） |
| Editor — Close | 0 | **4**（CloseActiveEditor `Ctrl+W` / CloseAll / CloseOthers / CloseToTheRight） |
| Editor — Tab 导航 | 0 | **4**（Next `Ctrl+Tab` / Previous `Ctrl+Shift+Tab` / FirstInGroup / LastInGroup） |
| Editor — Split | 0 | **4**（SplitRight `Ctrl+\\` / SplitDown `Ctrl+K` / SplitLeft / SplitUp） |
| Editor — Group 焦点 | 0 | **4**（FocusNext / FocusPrevious / FocusFirst / FocusLast） |
| 总数 | 4 | **20** |

所有 16 个 Editor 命令均挂 `f1: true`（命令面板可见），并按需挂 `precondition`：
- `hasActiveEditor` — Close 单个、Tab 导航
- `editorIsOpen` — CloseAll、FirstInGroup、LastInGroup
- `hasActiveEditor && !activeEditorIsLastInGroup` — CloseEditorsToTheRight
- `editorPartMultipleEditorGroups` — Focus 系列
- `Ctrl+W / Ctrl+\\ / Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+K` 与既有 `Ctrl+B / Ctrl+Alt+B / Ctrl+J / Ctrl+Shift+P` 无冲突

### ContextKey（新增 8 个 group 级 key）

`ContextKeyContribution` 构造函数由 5 参变为 6 参（追加 `@IEditorGroupsService`），表追加：

| 类别 | Key | 来源 |
|---|---|---|
| 多分组拓扑 | `editorPartMultipleEditorGroups`（boolean） | `groups.length > 1` |
| 全局开关 | `editorIsOpen`（boolean） | 任一 group 有 editor |
| 活动组内 | `groupEditorsCount`（number） | `activeGroup.count` |
| 活动组内 | `activeEditorGroupIndex`（number） | `activeGroup.index` |
| 活动组内 | `activeEditorGroupEmpty`（boolean） | `activeGroup.count === 0` |
| 活动 editor 位置 | `activeEditorIsFirstInGroup` / `activeEditorIsLastInGroup`（boolean） | `activeGroup.isFirst/isLast(activeEditor)` |
| 活动 editor 状态 | `activeEditorIsDirty`（boolean） | `activeEditor?.isDirty === true` |

订阅策略：
- 监听 `onDidActiveGroupChange / onDidAddGroup / onDidRemoveGroup / onDidMoveGroup` 触发 `syncGroupKeys()`
- 监听当前 active group 的 `onDidChangeModel / onDidActiveEditorChange`，active 切换时重订阅

### DI 注入

| 服务 | Before | After |
|---|---|---|
| `IEditorGroupsService` | ❌ 不存在 | ✅ `main.tsx` 在 `IEditorService` **之前**注入 `new EditorGroupsService()` |
| `IEditorService` 构造 | `new EditorService()` | `new EditorService(editorGroupsService)` |
| `ContextKeyContribution` 注入 | 5 参 | 6 参（追加 `@IEditorGroupsService`） |

### 新增模块

| 路径 | 行数（≈） | 用途 |
|---|---|---|
| `packages/platform/src/base/uri.ts` | ~200 | URI 类 |
| `packages/platform/src/base/grid.ts` | ~400 | SerializableGrid 二叉树 |
| `packages/platform/src/workbench/editorGroupModel.ts` | ~250 | 单 group 数据模型 + MRU |
| `packages/platform/src/workbench/editorGroupsService.ts` | ~80（接口 + 枚举） | IEditorGroupsService / IEditorGroup / GroupDirection / GroupLocation 等 |
| `apps/editor/src/renderer/workbench/editor/EditorGroupsService.ts` | ~280 | 服务实现（Grid + 适配器） |
| `apps/editor/src/renderer/workbench/editor/EditorGroupView.tsx` | ~120 | 单 group React 组件 |
| `apps/editor/src/renderer/workbench/editor/GridLayout.tsx` | ~150 | Grid 递归渲染 |
| `apps/editor/src/renderer/workbench/editor/Sash.tsx` | ~80 | 拖拽分隔条 |
| `apps/editor/src/renderer/workbench/editor/WelcomeEditorInput.ts` | ~25 | 内置 Welcome EditorInput 子类 |
| `apps/editor/src/renderer/actions/editorActions.ts` | ~280 | 16 个 Action2 |

### 测试覆盖

| | Before（主题 4 完成时） | After 主题 5 |
|---|---|---|
| `@universe-editor/platform` 测试数 | 297 | **383**（+86） |
| `@universe-editor/editor` 测试数 | 81 | **129**（+48） |
| 总测试数 | 378 | **512** |

新增测试套件：

- platform：
  - `base/uri.test.ts`（URI 解析 / 构造 / 序列化往返）
  - `base/grid.test.ts`（grid 拓扑 + resize + serialize 往返）
  - `workbench/editorInput.test.ts`（EditorInput 基类 + matches / onDidChangeDirty / onWillDispose）
  - `workbench/editorGroupModel.test.ts`（open/close/move/setActive + MRU + 事件）
- editor：
  - `actions/__tests__/editorActions.test.ts`（17：16 个 Action2 行为 + 注册元数据）
  - `workbench/__tests__/editor/EditorGroupsService.test.ts`（14：activeGroup / addGroup / 移动 / 复制 / findGroup）
  - `workbench/__tests__/editor/EditorGroupView.test.tsx`（5：tab 渲染 + 点击切 active + 多 group active 视觉态）
  - `workbench/__tests__/editor/Sash.test.tsx`（6：mousedown/move/up + active class + 边界）
  - `workbench/__tests__/contributions/ContextKeyContribution.test.ts`（6 → **12**：追加 group 级 key 用例）
  - `workbench/__tests__/EditorService.test.ts`（沿用兼容口径，旧 7 用例通过）

测试隔离：renderer project 新增 `vitest.renderer-setup.ts`，每个测试 `afterEach(cleanup)`，避免 happy-dom 残留 DOM 跨用例污染。

### 集成验证

- `pnpm check`（lint + typecheck + test + build）：✅ 全绿
- 桌面端 `electron-vite build`：✅（main 6.52 kB / preload 0.77 kB / renderer 855.31 kB JS + 26.07 kB CSS）
- 命令保持等价：旧 4 个 layout 命令的键位 / behaviour 不变
- 新键位 `Ctrl+W` / `Ctrl+\\` / `Ctrl+Tab` / `Ctrl+Shift+Tab` 通过 `KeybindingsRegistry.resolveKeybinding` 测试断言
- 兼容层：旧 `IEditorService` 7 个 `EditorService.test.ts` 用例全部通过

### 边界（按计划保持的"不做"清单）

- **不**实现 preview 编辑器（单击预览 / 双击 pin）
- **不**实现 sticky tabs（钉在左侧）
- **不**实现 transient editors
- **不**实现 editor 标题右键菜单 / 标签拖拽重排序 UI
- **不**实现 chord 键位（`Ctrl+K Ctrl+W` 等）—— 留主题 8
- **不**实现 editor group 最大化 / 隐藏（API 占位但暂未绑 UI）
- **不**实现 `EditorResolverService`（沿用 `editorComponentMap` 单一注册）
- **不**实现 diff editor / side-by-side editor
- **不**实现 EditorInput 序列化恢复（留主题 9 workspace state）
- **不**接入文件系统（FileEditorInput 留主题 6/7）
- **不**改 StatusBar 显示 active editor 信息

---

## After 主题 6：Settings UI（2026-05-16）

主题 6 把内核里的 `IConfigurationService` + `ConfigurationRegistry` 接到消费端：注入 DI、通过 `IStorageService` 持久化 User layer、注册一组内置 schema、新增 `SettingsEditorInput` + 表单驱动的 `SettingsEditor`、`Preferences: Open Settings`（`Ctrl+,`）。

### ConfigurationService 接入路径

```
main.tsx
  └─ new ConfigurationService()              ← Default/User/Project/Memory 四层
       services.set(IConfigurationService, …)
  └─ inst.createInstance(UserSettingsSync)   ← @IConfigurationService + @IStorageService
       └─ initialize() → storage.get('workbench.userSettings') → loadLayer(User)
       └─ onDidChangeConfiguration → storage.set('workbench.userSettings', snapshot)
```

`ConfigurationService` 新增公共 API：

| API | 用途 |
|---|---|
| `loadLayer(target, data)` | 整层批量装载（如启动时反序列化）；按效应值对比仅对真正变化的 key 触发事件 |
| `getLayerSnapshot(target)` | 返回该层浅拷贝；`UserSettingsSync` 持久化时使用 |

`loadLayer` 现在比较 **effective value**（穿越层级合并后的结果），避免 User 改动被 Memory 屏蔽时误触发，或被屏蔽时漏触发。

### 内置 schema（3 节点 / 8 项）

`SettingsContribution` 在 `WorkbenchPhase.BlockStartup` 阶段注册：

| 节点 | Key | 类型 | 默认 |
|---|---|---|---|
| workbench | `workbench.colorTheme` | enum: dark / light | `dark` |
| workbench | `workbench.sideBar.location` | enum: left / right | `left` |
| editor | `editor.fontSize` | number 8–32 | `14` |
| editor | `editor.tabSize` | number 1–8 | `4` |
| editor | `editor.wordWrap` | boolean | `false` |
| editor | `editor.minimap.enabled` | boolean | `true` |
| files | `files.autoSave` | enum: off / afterDelay / onFocusChange | `off` |
| files | `files.autoSaveDelay` | number ≥ 100 | `1000` |

未来扩展直接 `ConfigurationRegistry.registerConfiguration({...})` 即可，无需改 UI。

### Settings 编辑器

| 文件 | 行数 | 说明 |
|---|---|---|
| `apps/editor/src/renderer/workbench/preferences/SettingsEditorInput.ts` | ~25 | `EditorInput` 子类，资源 `universe:/settings` |
| `apps/editor/src/renderer/workbench/preferences/SettingsEditor.tsx` | ~155 | 表单视图（顶部搜索 + 按 node 分组） |
| `apps/editor/src/renderer/workbench/preferences/SettingsEditor.module.css` | ~110 | UE5 暗色风格 |
| `apps/editor/src/renderer/workbench/configuration/UserSettingsSync.ts` | ~40 | DI wrapper：load on boot + write on change |
| `apps/editor/src/renderer/contributions/SettingsContribution.ts` | ~95 | 内置 schema 注册 |
| `apps/editor/src/renderer/actions/preferencesActions.ts` | ~40 | `OpenSettingsAction` |

控件按 schema 派发：`enum` → `<select>`；`boolean` → `<input type=checkbox>`；`number` → `<input type=number min/max>`；`string` → `<input type=text>`；其它 → `Not editable in form view`。编辑写入 `ConfigurationTarget.User`，立即被 `UserSettingsSync` 回写到 storage。

### 新增命令（21 个 → 22 个）

| ID | 键位 | 来源 |
|---|---|---|
| `workbench.action.openSettings` | `Ctrl+,` | `OpenSettingsAction`（跨 group 去重：已存在则激活原 group + 原 tab） |

### EditorRegistry provider 注册

`EditorArea.tsx` 顶部统一登记，避免组件 map 与 typeId 解耦：

```ts
EditorRegistry.registerEditorProvider({ typeId: 'welcome',  componentKey: 'welcome' })
EditorRegistry.registerEditorProvider({ typeId: 'settings', componentKey: 'settings' })
editorComponentMap.set('welcome',  WelcomeEditor)
editorComponentMap.set('settings', SettingsEditor)
```

（顺手补齐了主题 5 漏注册的 welcome provider。）

### 测试覆盖

| | After 主题 5 | After 主题 6 |
|---|---|---|
| `@universe-editor/platform` 测试数 | 383 | **388**（+5：`loadLayer` 效应值比对 4 用例 + `getLayerSnapshot` 1 用例） |
| `@universe-editor/editor` 测试数 | 129 | **149**（+20） |
| 总测试数 | 512 | **537** |

editor 包新增：

- `workbench/configuration/__tests__/UserSettingsSync.test.ts`（6）：load / fallback / User-target 持久化 / Memory-target 触发但 snapshot 仍是 User 视图 / 多次更新 / dispose 解绑
- `workbench/__tests__/contributions/SettingsContribution.test.ts`（3）：3 节点注册 / 8 项默认 / dispose 全部移除
- `workbench/__tests__/preferences/SettingsEditor.test.tsx`（7）：分节 / 控件类型派发 / 搜索过滤 / number/boolean/enum 编辑回写 / 外部 update 同步
- `actions/__tests__/preferencesActions.test.ts`（4）：注册元数据 / 打开 tab / 同 group 复用 / 跨 group 复用 + 激活原 group

### 持久化流程

- key：`workbench.userSettings`（常量在 `UserSettingsSync.USER_SETTINGS_KEY`）
- 通道：`IStorageService`（ProxyChannel → 主进程 `userData/state.json`）
- payload：`config.getLayerSnapshot(User)`（仅 User 层快照；Memory / Default 不入盘）
- 触发：任意 `onDidChangeConfiguration` 均写一次。User layer 没改的事件也会写——payload 不变所以无副作用
- 加载：启动时异步读 storage → `loadLayer(User, raw)` → 触发 `onDidChangeConfiguration` → `SettingsEditor` 自动重渲染

### 集成验证

- `pnpm check`（lint + typecheck + test + build）：✅ 全绿
- 桌面端打包：main 6.52 kB / preload 0.77 kB / renderer 869.64 kB JS + 28.29 kB CSS
- 既有命令 / 键位 / EditorService 兼容层保持不变

### 边界（按计划保持的"不做"清单）

- **不**新增 IPC 通道；user settings 走 `IStorageService` 既有路径
- **不**实现 project / workspace 层 settings
- **不**实现 JSON 编辑器视图
- **不**实现 schema validation 错误展示（无效值仍写入）
- **不**支持嵌套 `object` / `array` 表单编辑（占位 readonly）
- **不**实现 reset to default 按钮
- **不**让 settings 修改即时影响 UI 主题 / fontSize 等（消费方需另行订阅 `onDidChangeConfiguration`；本主题只验证写入 + 持久化）
- **不**引入主进程独立 PreferencesService / settings.json
- **不**新增 MenubarPreferencesMenu（菜单栏接入留主题 8/9）



## 九、After 主题 8（Menubar + Chord 键位）

继主题 6 之后，渲染端在 6/2026-05-16 新增了「2 段 chord 键位 + File/Help 菜单功能贡献」。

### 改造范围

| 类别 | 文件 |
|---|---|
| Platform 内核 | `packages/platform/src/command/keybindingRegistry.ts`（chord trie + `resolveKeystroke` 状态机）<br>`packages/platform/src/command/action.ts`（`keybinding.primary` 接受 `string \| readonly [string,string]`）<br>`packages/platform/src/host/hostService.ts`（新增 `toggleDevTools()`） |
| 主进程 | `apps/editor/src/main/services/host/hostMainService.ts`（实现 `toggleDevTools` → `webContents.toggleDevTools()`） |
| 渲染端 | `apps/editor/src/renderer/workbench/useGlobalKeybindingHandler.ts`（chord 状态机 + 1.5s 超时 + status bar 反馈）<br>`apps/editor/src/renderer/workbench/titlebar/keybindingFormat.ts`（formatKey / formatChord，新文件）<br>`apps/editor/src/renderer/workbench/titlebar/useTitleBarMenus.ts`（菜单 shortcut 渲染支持 chord） |
| 命令 | `apps/editor/src/renderer/actions/preferencesActions.ts`（OpenSettings：新增 `[Ctrl+K, Ctrl+S]` chord 别名 + 进入 File 菜单 5_preferences 组）<br>`apps/editor/src/renderer/actions/windowActions.ts`（新增 CloseWindow / ToggleDevTools / About）<br>`apps/editor/src/renderer/actions/index.ts`（3 条新 `registerAction2`） |

### KeybindingsRegistry 新型

```ts
// 内部存储统一为 chords[]（1 或 2 元素）
interface IResolvedKeybindingItem {
  chords: readonly string[]
  command: string
  when: ContextKeyExpression | undefined
  isNegated: boolean
}

// 状态机式 API
type KeystrokeResolution =
  | { kind: 'execute'; command: string }
  | { kind: 'enter-chord'; pending: readonly string[] }
  | { kind: 'no-match' }

KeybindingsRegistry.resolveKeystroke(key, ctx?, pending?): KeystrokeResolution
```

- 无 pending：单笔优先 `execute`，否则若有 2-chord 起始即 `enter-chord`，都无即 `no-match`
- 有 pending：仅匹配 `chords[0] === pending[0] && chords[1] === key`；失败 `no-match`，**不**回退到首笔
- `resolveKeybinding(key, ctx?)` 保留，内部退化为单笔查找；`IKeybindingItem.key`（旧）与 `IKeybindingItem.chords`（新）互斥

### 渲染端 chord 状态机

`useGlobalKeybindingHandler` 内 ref：

```ts
{ key: string; entry: IDisposable; timer: Timeout } | null
```

时序：
1. keydown → `buildKeyString`（忽略孤立 modifier）
2. `resolveKeystroke(key, ctx, pending?)`
3. `execute` → `preventDefault` + `executeCommand` + `clearChord()`
4. `enter-chord` → `preventDefault` + `clearChord()` + `statusBar.addEntry(text=...) + setTimeout(1500)` + 写入 pending
5. `no-match` 且 pending 非空 → `preventDefault` + `clearChord()`（吞键，对齐 VSCode）
6. 卸载 hook / 超时 → `clearChord()` 同时 dispose status bar entry 与 clearTimeout

status bar 文案：`(Ctrl+K) was pressed. Waiting for second key…`（左对齐、priority 10000）。

### 新增 Action2（共 3 条）

| Command ID | 键位 | 菜单 | 实现 |
|---|---|---|---|
| `workbench.action.closeWindow` | `Ctrl+Shift+W` | MenubarFileMenu / `z_window` | `IHostService.closeWindow()` |
| `workbench.action.toggleDevTools` | `Ctrl+Shift+I` | MenubarHelpMenu / `5_tools` | `IHostService.toggleDevTools()` |
| `workbench.action.about` | — | MenubarHelpMenu / `z_about` | `console.info` 占位 |

OpenSettings 同步追加：
- 第二条键位 `[Ctrl+K, Ctrl+S]`（chord）作为 VSCode 兼容别名
- MenubarFileMenu / `5_preferences` 项

> Ctrl+W 已被 `CloseActiveEditorAction` 占用（主题 5），故 CloseWindow 使用 Ctrl+Shift+W 避免冲突。

### Menubar 视觉

- 由「File / Edit / View / Help 四个空菜单 + 4 个 View 项」→「File 2 group（preferences + window） / Edit 仍空 / View 4 项 / Help 2 group（tools + about）」
- 单笔显示：`Ctrl+,`；chord 显示：`Ctrl+K Ctrl+S`（空格分隔）

### 测试覆盖

| | After 主题 6 | After 主题 8 |
|---|---|---|
| `@universe-editor/platform` 测试数 | 388 | **398**（+10：chord 注册 / 状态机 / when / 大小写 / 单笔优先 / dispose / 多 chord 共享首键） |
| `@universe-editor/editor` 测试数 | 149 | **168**（+19） |
| 总测试数 | 537 | **566** |

editor 包新增 / 扩展：

- `workbench/titlebar/__tests__/keybindingFormat.test.ts`（5）：formatKey / Cmd 映射 / 多字母 / chord / 单元素
- `workbench/__tests__/useGlobalKeybindingHandler.test.tsx`：原 7 用例 + 新 5 chord 用例（状态栏出现 / 命中 / 中止 / 超时 / 卸载清理 / 忽略孤立 modifier）
- `actions/__tests__/preferencesActions.test.ts`：+2（chord 别名 + File 菜单贡献）
- `actions/__tests__/windowActions.test.ts`（6）：CloseWindow / ToggleDevTools / About 的注册 + 触发
- `workbench/__tests__/hostProxy.test.ts`：FakeHost 增加 `toggleDevTools`；method-forward 用例增加该方法
- `main/__tests__/services/hostMainService.test.ts`：+1（`toggleDevTools` 走 `webContents`）

### 集成验证

- `pnpm check`（lint + typecheck + test + build）：✅ 全绿
- 既有命令 / 单笔键位 / 菜单 API 调用方零修改
- Settings 持久化（主题 6）、Editor Group（主题 5）、ContextKey（主题 4）等全部继续工作

### 边界（按计划保持的"不做"清单）

- **不**实现 3 段及以上 chord（VSCode 也是 2 段封顶）
- **不**实现 Edit 菜单内容（无文本编辑器，留给 FileEditor 主题）
- **不**实现 mac 平台 native menubar
- **不**实现 keybinding 用户自定义 / keybindings.json
- **不**实现真正的 About 对话框
- **不**改 `IStatusBarService` 接口；用既有 `addEntry/dispose`
- **不**新增 contextkey "inChord"；chord 反馈用 statusbar
- **不**实现菜单项的 enabled/visible 反应式更新

---

## 十、After 主题 10：FileEditor + Explorer（2026-05-16）

主题 10 把 fs 网关从「平台能力」变成「用户体验」。在它之前，editor 是个会打开文件夹但什么都看不到的壳；之后第一次真正像一个编辑器。

### 新增 / 改造（按工作包）

- **WP1（platform）**：`EditorInput` 增可选 `save?()` / `revert?()` / `serialize?()`；`IFileService` 增 `delete(uri, {recursive?})` / `rename(src, dst, {overwrite?})`，错误码加 `ENOTEMPTY`；新增 `IDialogService`（`confirm` 三按钮 + `prompt`）；`IEditorProvider.deserialize` 加可选 `accessor`。
- **WP2（主进程）**：`FileSystemMainService` 实现 delete/rename；renderer `index.html` CSP 放行 `worker-src blob: 'self'`；`electron.vite.config.ts` 加 `renderer.worker.format = 'es'` 让 Vite `?worker` 出 ESM chunk。
- **WP3（Monaco + FileEditorInput）**：`MonacoLoader`（单例 + `editor.worker` / `json.worker` 通过 `?worker` self-host），`MonacoModelRegistry`（URI→ITextModel 引用计数，多 group 共享一个 model），`FileEditorInput`（含 `backupContent` / `language` / `save` / `revert` / `serialize`），`FileEditor.tsx`（Monaco 容器 + 输入切换只 `setModel`）。`EditorGroupsService.toJSON` 改用 `e.serialize?.() ?? null`，restore 透传 `ServicesAccessor`。
- **WP4（Explorer + Dialog）**：`ExplorerTreeService`（DI 单例 `IExplorerTreeService`，订阅 `IWorkspaceService` 重置树根，懒 list + 缓存）、`ExplorerView` / `ExplorerTreeNode` / `ExplorerContextMenu`、`RendererDialogService`（React portal，Esc 取消 / Enter 主按钮）。SideBar `viewComponentMap` 注册 `explorer.tree`；`BuiltInViewsContribution` 注册 view。
- **WP5（fileActions + close-with-confirm）**：7 个 Action2：`Save (Ctrl+S)` / `SaveAs (Ctrl+Shift+S)` / `OpenFile (Ctrl+O)` / `NewFile` / `NewFolder` / `Rename (F2)` / `Delete`。`closeEditorWithConfirm` 工具函数封装脏文件三按钮 confirm（保存 / 不保存 / 取消），EditorGroupView tab × 与 `CloseActiveEditorAction (Ctrl+W)` 都走它。Explorer 右键经 `ICommandService.executeCommand(actionId, { target | parent })` 进入 actions。
- **WP6（StatusBar + 大文件 + 文档）**：`FileEditorStatusContribution`（AfterRestore）订阅 `IEditorService.activeEditor`，typeId='file' 时注册 3 entry（cursor priority 100 / language 90 / encoding 80 "UTF-8"），非 file 类型 dispose；`IStatusBarService.addEntry` 改返回 `IStatusBarEntryAccessor`（`update(entry)` + `dispose()`），cursor 用 `update` 原地刷新。`FileEditorRegistry` 维护 FileEditorInput → Monaco editor 实例的反查表（split view 多挂载时 last-write-wins）。`largeFileGuard` 在 OpenFile + Explorer 单击前 `fs.stat`，>2MB 弹 confirm。

### 行为速写

- **打开文件**：Explorer 单击 → pinned tab 直接打开（本主题不做 preview tab）；`Ctrl+O` 经 `IHostService.showOpenFileDialog` 拿到 URI 后同样路径；大于 2MB 提示。
- **跨 group 共享 model**：split 后两个 group 打开同一文件，编辑实时同步（共享 TextModel + 引用计数）。
- **脏关闭**：tab × / `Ctrl+W` 走 `closeEditorWithConfirm` → `保存 / 不保存 / 取消`；save 返回 false 时保留 tab，不关闭。
- **保存语义**：`Ctrl+S` → `FileEditorInput.save()` 从 `MonacoModelRegistry.peek()` 取文本，`writeFile` 后重置 dirty；`Ctrl+Shift+S` 弹保存对话框，写新路径后 open 新 input + close 旧 input。
- **持久化**：editor group toJSON 调 `e.serialize?.()`，FileEditorInput 输出 `{ resource: UriComponents }`；reload 后重新构造同 URI 的 input，回到 disk 内容（不做 hot exit）。

### 测试覆盖

| | After 主题 8 | After 主题 10 |
|---|---|---|
| `@universe-editor/platform` 测试数 | 398 | **401**（+3：accessor / deserialize 信号 / 接口纯类型扩展不计入） |
| `@universe-editor/editor` 测试数 | 168 | **282**（+114：含 fs delete/rename main 测试、Monaco / FileEditorInput / ExplorerTree / Dialog / fileActions / closeEditorWithConfirm / FileEditorStatus / largeFileGuard 等） |
| 总测试数 | 566 | **683** |

新增 / 扩展的测试文件（renderer 主要）：

- `main/services/files/__tests__/fileSystemMainService.test.ts`：+8（delete 文件 / 空目录 / 非空 + recursive / 非空 → ENOTEMPTY / 不存在 → ENOENT / rename 文件 / EEXIST / 源不存在 ENOENT）
- `workbench/editor/__tests__/FileEditorInput.test.ts`（9）/ `MonacoModelRegistry.test.ts`（4）/ `EditorGroupsService.serialize.test.ts`（含 FileEditorInput round-trip）
- `workbench/explorer/__tests__/ExplorerTreeService.test.ts`（11）/ `ExplorerView.test.tsx`（3）
- `workbench/dialog/__tests__/RendererDialogService.test.tsx`（6）
- `workbench/editor/__tests__/closeEditorWithConfirm.test.ts`（5）
- `actions/__tests__/fileActions.test.ts`（13）
- `workbench/__tests__/contributions/FileEditorStatusContribution.test.ts`（4）
- `workbench/__tests__/editor/largeFileGuard.test.ts`（4）
- `workbench/__tests__/StatusBarService.test.ts`：+2（update / update-after-dispose）

### 集成验证

- `pnpm lint` + `pnpm typecheck` + `pnpm test`：✅ 全绿（401 + 282）
- 既有 Welcome / Settings input 不实现新钩子，靠 `serialize?.() ?? null` 兼容旧 group 存档
- ContextKey / Menu / Keybinding / Editor Group / Workspace 既有路径零回归

### 边界（按计划保持的"不做"清单）

- **不**实现 untitled 文件（Ctrl+N 暂缺，留主题 11）
- **不**实现 preview tab（单击即 pinned）
- **不**实现 hot exit（dirty 内容不持久化）
- **不**实现 file watcher（外部 fs 改动不感知）
- **不**实现窗口级关闭 dirty 拦截
- **不**实现多编码 / BOM 切换（UTF-8 only）
- **不**接 IntelliSense（仅 editor.worker + json.worker；TS/CSS/HTML 走 monarch 语法着色）
- **不**实现 Outline / 搜索面板 / drag-drop / git decoration / diff editor / Reveal in Explorer
- **不**实现 path-traversal 沙箱

