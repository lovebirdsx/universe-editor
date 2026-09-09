# apps/editor/src/renderer/services/views/CLAUDE.md

View / ViewContainer 系统的运行时核心（`ViewDescriptorService` / `ViewsService`）在本目录；静态注册表在 `packages/platform`；UI 五件套在 `workbench/{activitybar,paneComposite,sidebar}`。本文是 view 系统的上下文地图（处理相关任务前通读）。

仿照 VSCode，把「**一个 view 默认住在哪个容器**」和「**用户当前把它拖到了哪**」拆成两层：

- **静态注册表层**（`packages/platform`，纯声明）：`ViewContainerRegistry` / `ViewRegistry` 只记录**默认归属、默认顺序、能力位**（`canMoveView` / `generated`）。注册新 View/Container 走这里（apps/editor/CLAUDE.md 套路 B 两处必改）。
- **运行时重映射层**（本目录，可变 + 持久化）：`IViewDescriptorService` 在注册表之上叠加用户定制（归属/顺序/折叠/尺寸/生成容器），按 **workspace 作用域**持久化。**所有 UI 都从这一层读**——一个被拖走的 view 出现在新容器里，注册表完全不动。

> ⚠️ 第一原则：先认领改动落在哪层。「系统里存在哪些 view/容器、默认住哪」→ 静态注册表 + 三件套 contribution；「用户能怎么搬、搬完怎么记住、UI 怎么刷新」→ `ViewDescriptorService` + 消费它的 UI。定制逻辑塞进注册表、默认归属硬编码进 UI，都是把两层揉死。

## 数据流一图

```
ViewRegistry / ViewContainerRegistry（静态默认归属，仅被 service 读作 fallback）
  ↓
IViewDescriptorService ── version: IObservable<number>（每次 mutation 自增）
  ↓ 叠加：自定义归属 / 顺序 / 折叠 / 尺寸 / 生成容器，按 workspace 持久化；所有查询走这层
UI 层（全部经 useViewDescriptors() 订阅 version 后再 re-query，五件套见下表）
```

## 运行时核心：IViewDescriptorService

接口 `packages/platform/src/workbench/viewDescriptorService.ts`，实现 `apps/editor/src/renderer/services/views/ViewDescriptorService.ts`（改接口要 rebuild + re-export，见易踩坑 1）。

- **`version: IObservable<number>`**——mutation 自增，**UI 响应的唯一开关**：订阅后整体 re-query。
- **查询**：`getViewContainerById` / `getViewContainersByLocation` / `getViewContainerLocation` / `getViewsByContainer` / `getViewContainerByViewId` / `getViewLocationById` / `getDefaultContainerById`。
- **mutation**：`moveViewsToContainer`（跨容器投放）/ `moveViewToLocation`（拖到空白→**生成新容器**）/ `moveViewContainerToLocation`（容器换区域）/ `moveViewInContainer`（容器内重排）/ `moveContainerInLocation`（同区域容器重排）。
- **per-view 状态**：`getViewState(viewId): IViewState`（`{collapsed?, size?, order?}`）/ `setViewCollapsed` / `setViewSizes(sizes[])`。
- **`reset()`** 清空定制回注册表默认（`ResetViewLocationsAction` 调它）；**`save(): Promise<void>`** 强制 flush 防抖写盘，给 e2e 探针用。

### 实现要点

- **持久化**：`STORAGE_KEY = 'workbench.viewCustomizations'`，**`StorageScope.WORKSPACE`**（项目级习惯，对标 VSCode）。写盘走防抖 `_saveTimer`；`save()` 立即清 timer 同步落盘。
- **`when` 硬门控**：`getViewsByContainer` 按 `IContextKeyService` 过滤描述符的 `when`（空/解析失败=可见）；可见性翻转才 bump version。**visible 集合只用于查询渲染**——move/reorder/生成容器回收走未过滤的 `_allViewsByContainer`，门控不影响 `_viewLocations`/`_viewStates` 的用户定制。
- **生成容器**：`GENERATED_PREFIX='workbench.view.generated.'`（id `<tag>.<counter>`，`icon:'window'`、`generated:true`）。最后一个 view 移走 → 自动注销；**非生成容器空了也不回收**。load 时先 re-register `generatedContainers` 再恢复归属（见易踩坑 4）。
- **workspace 切换**：`_reload()` 清掉当前生成容器（防泄漏到新工作区）+ 重新加载新 workspace storage。
- **eager seeding**：构造时 version autorun 自动选中某 location 首个容器（VSCode 风）——断言「无内容」须用「该 location 无容器存在」（见易踩坑 5）。

### DI 注册

`apps/editor/src/renderer/main.tsx`：`instantiation.createInstance(ViewDescriptorService)` → `services.set(IViewDescriptorService, …)`。`ViewsService` 构造注入它，订阅 `version` 决定每个 location 的激活容器。

## UI 层（全部经 useViewDescriptors 订阅）

**统一入口** `apps/editor/src/renderer/workbench/dnd/useViewDescriptors.ts`：`useService(IViewDescriptorService)` + `useObservable(service.version)`，mutation 后组件 re-render 重新 query。

> ⚠️ **任何要反映 view 归属/顺序/折叠的组件都必须用 `useViewDescriptors()`，不要直接读 `ViewContainerRegistry`/`ViewRegistry`**。直接读注册表 = 拿到默认布局，用户拖动后不刷新（重构时改掉的一类 bug，勿回退）。

| 组件 | 职责 |
|---|---|
| `ActivityBar.tsx`（workbench/activitybar/） | SideBar 区容器图标：点选激活；图标拖拽重排（`moveContainerInLocation`）；接收 view 投放（`moveViewsToContainer`） |
| `PaneCompositePart.tsx`（workbench/paneComposite/） | 某 location 活跃容器的内容宿主：`content==='stack'` → `ViewPaneContainer`；否则 `TiledViews` |
| `PaneCompositeHeader.tsx`（workbench/paneComposite/） | SecondarySideBar/Panel 区容器标签条 |
| `ViewPaneContainer.tsx`（workbench/sidebar/） | 容器内多 view 纵向 `Allotment`：折叠 `getViewState/setViewCollapsed`；尺寸 `onChange`→`setViewSizes`（记账）、`onDragEnd`→`{persist:true}`；`moveHere` 跨容器+容器内重排；整容器是「合并」放置区（`data-container-drop`），单 view 精细插入留给各 ViewPane；`draggable={v.canMoveView !== false}` |
| `ViewPane.tsx`（workbench/sidebar/） | 单 view 面板：拖源（写 `viewDragData` + `setData(VIEW_DRAG_MIME)`）；放置目标（hit-test clientY vs 中点得 dropEdge 'before'/'after'） |

CSS 状态类在 `ViewPane.module.css` / `PaneComposite.module.css`（`.mergeOverlay` 容器级合并高亮）/ `ActivityBar.module.css`。

## 原生 DnD 套路（workbench/dnd/viewDragData.ts）

HTML5 DnD 的 **dragover 阶段读不到 `dataTransfer` payload**（只在 drop 可读），用内存单例兜底：`onDragStart` 写 `viewDragData.set({kind:'view', id})` + `setData(VIEW_DRAG_MIME, viewId)`；dragover 用 `viewDragData.get()` 决定是否高亮；`dragContainsView(dataTransfer)` 在 `onDragOver` 区分「view 拖拽」与**资源拖拽**。

## 命令

`apps/editor/src/renderer/actions/viewActions.ts`（`actions/index.ts` 注册）：

- **`MoveViewAction`**（id `workbench.action.moveView`，菜单 `MenuId.ViewTitle` group `9_move`）：无 viewId 入参先 QuickPick 选 view，再 QuickPick 选目标（现有容器排除当前 + `canMoveView:false`）+ 三个「在 X 区新建容器」选项（→ `moveViewToLocation`）。**viewId 来源**：标题栏 action 经 `ViewTitleActions.tsx` 读 per-view scoped context key `view` 作第一参数；命令面板触发则无参走 QuickPick。
- **`ResetViewLocationsAction`**（id `workbench.action.resetViewLocations`）：调 `viewDescriptors.reset()`。

## 加新 View / ViewContainer（静态层，套路 B 两处必改）

这**不属于运行时重映射**，是声明「系统里存在这个 view」。两处必改（`apps/editor/CLAUDE.md` 套路 B）：Container（`BuiltInViewContainersContribution.ts`，location）→ View 描述符（`BuiltInViewsContribution.ts`，单点 `registerViewWithComponent`；扩展树视图等共享组件场景用底层 `ViewRegistry.registerView` + `ViewComponentRegistry.register`）。能力位：`canMoveView`（默认可移动）、`order`、容器 `generated`（内部标记勿手设）。

## 关键架构决策

- **静态/运行时两层分离**：拖动布局不污染注册表、可一键 `reset()`、持久化只序列化「与默认的差异 + 生成容器」。
- **version observable 而非细粒度事件**：mutation 种类多，单调递增 version 让 UI 订阅后整体 re-query，简单不漏更新。
- **生成容器自动回收**：拖 view 到空白生成容器、容器空了自动消失（VSCode 一致）；**仅生成容器回收，内置容器永驻**。

## 常见任务 → 改哪里

- **改拖拽放置的判定/高亮**：`ViewPane.tsx`（before/after hit-test + overlay）/ `ViewPaneContainer.tsx`（容器级合并放置区 + `.mergeOverlay`）/ `ActivityBar.tsx`、`PaneCompositeHeader.tsx`（容器重排/合并命中）。统一放置语义收口在 `workbench/dnd/applyViewDrop.ts`。
- **新增一种 mutation**：接口（platform）→ rebuild + re-export → 实现 → UI/命令 → 单测。**记得自增 version**，否则 UI 不刷新。
- **改持久化内容（多存一个 per-view 字段）**：`IViewState` 加字段 → `getViewState/set*` + `PersistedCustomizations` 序列化往返 → 单测加 round-trip。
- **改 view 移动命令交互**：`actions/viewActions.ts`（QuickPick 流程）；标题栏 action 拿 viewId 看 `ViewTitleActions.tsx` 的 context key 传参。
- **某 view 不该被拖走**：注册描述符设 `canMoveView: false`（静态层），UI 的 `draggable` 与命令目标过滤都已尊重它。
- **加新 View/Container**：套路 B 三件套，**不是**这个 service 的事。
- **生成容器图标不对**：`workbench/activitybar/icon-map.ts`（`window: AppWindow`）/ `icons/icon-map.ts`。

## 尺寸持久化与折叠语义（对标 VSCode SplitView）

多 view 容器（`ViewPaneContainer.tsx`）尺寸机制，纯函数在 `services/views/viewPaneLayout.ts`（`VIEW_HEADER_SIZE=28`/`VIEW_OPEN_MIN=88`、`computeToggleSizes`、`initialPaneSize`）：

- **落盘权收窄到用户动作**：`setViewSizes(sizes,{persist?})` 默认**只更新内存**（布局记账），`persist:true` 才落盘。`onChange` 全走记账（首布局等分/容器 resize/程序化纠正永不落盘，见案例 50b）；`onDragEnd`（sash 拖拽）与 collapse 的 remembered size 走 `persist:true`。
- **persisted/mem 双轨制**：`_persistedSizes` 是权威源（只被 reconcile/persist:true 写），`_viewStates.size` 只是记账。**所有「恢复目标」读 `getPersistedViewSize()`**（含 `save()` 序列化）——读脏 mem 会把布局噪声当真值锁死（案例 50c）。
- **reconcile 迟到的校正**：Allotment 挂载后 `preferredSize` 是 no-op（pane 构造时冻结 layoutStrategy）；`RECONCILE_GRACE_MS`(600ms) 窗口内**每次** onChange 都 `correctToStoredSizes`（贪心重分配可再次落进来），窗口外靠 `storedSizesKey` effect。防自激：`sashDraggingRef` / collapsed 跳过 / `correctingRef` 重入 / `deficit<0` 跳过（装不下会无限同步递归）。
- **挂载恢复**：`preferredSize` = 折叠→28 / 展开→持久化 `size`（clamp ≥ OPEN_MIN）/ 无存储→不传（Allotment 等分）；重挂载（重排/移入移出/切容器）同理。
- **折叠/展开**：折叠收缩到 header（min=max=28），空间全归最底部展开 pane（SplitView greedy）；展开恢复记住的尺寸，空间自底向上从其它展开 pane 扣（各扣到 OPEN_MIN 为止）。
- **折叠 pane 不持久化尺寸**：onChange/onDragEnd 必须过滤折叠 pane 的 28px 上报，否则展开尺寸被覆盖成 28。
- **expandedSizesRef 快照**：子组件 effect 先跑，Allotment 的 layout effect 先 fire onChange（clamp 到 minSize）覆盖持久化尺寸——折叠时快照进 ref，展开时优先用 ref。
- 容器总高变化走 `proportionalLayout`（默认 true）等比缩放。

## 易踩坑速记

1. **改了 platform 接口忘 rebuild**：apps 吃 `dist/`，须 build + re-export，否则编译报「不存在」。
2. **UI 直接读注册表 = 拖动不刷新**：要反映归属/顺序的组件必须 `useViewDescriptors()` 订阅 version。
3. **mutation 忘自增 version**：不 bump version，UI 完全不动。
4. **生成容器 load 时漏 re-register**：先 re-register `generatedContainers` 再恢复归属，否则恢复出指向「不存在容器」的 view。
5. **eager seeding 改变空状态语义**：断言「无内容」用「该 location 无任何容器」而非「无激活容器」（见 `Panel.test.tsx`）。
6. **dragover 读不到 payload**：别在 `onDragOver` 里 `dataTransfer.getData()`；用 `viewDragData.get()` + `dragContainsView()`。
7. **exactOptionalPropertyTypes**：可选字段用条件展开 `...(x !== undefined ? { x } : {})`，不要 `x: T | undefined`。
8. **折叠 pane 的尺寸别上报**：必须过滤折叠 pane 的 28px header 上报，否则展开尺寸被覆盖。
9. **Allotment 子 effect 先跑会污染尺寸**：恢复值取自折叠时快照的 `expandedSizesRef`。
10. **layout 尺寸落盘必须走 `persist:true`**：`onChange` 里带 persist 会让首布局等分值抢在 reconcile 读盘前写盘（案例 50b 的 CI flake 根因）。新写入点先想「用户动作还是 layout 噪声」。
11. **探针/断言「不落盘」别用 `save()` 验证**：`save()` 无条件写盘，断言恒 tautological；守护 debounce 自动落盘不发生（fake timers 越过 200ms）。

## 验证

```bash
cd apps/editor && pnpm vitest run --project renderer \
  src/renderer/services/views/__tests__/ViewDescriptorService.test.ts \
  src/renderer/services/views/__tests__/ViewsService.test.ts \
  src/renderer/workbench/panel/__tests__/Panel.test.tsx
pnpm check
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物
cd apps/editor && pnpm exec playwright test specs/smoke.viewMove.spec.ts   # @p0 移动+重载持久化往返
```

**e2e 探针**（`contract.ts` + `renderer/e2e/probe.ts`，委托 `viewDescriptorService`）：`getViewContainerByViewId` / `getViewIdsByContainer` / `getViewContainerIdsByLocation` / `moveViewsToContainer` / `moveViewToLocation` / `moveViewContainerToLocation` / `getViewCollapsed` / `setViewCollapsed` / `getViewSize` / `flushViewCustomizationsSave` / `resetViewLocations`——**绕开 DnD 鼠标几何**直驱 service，测「数据模型+持久化」主链路；`smoke.viewMove.spec.ts` 与 `smoke.viewSizes.spec.ts` 走此探针。

> ⚠️ 本地 Windows e2e 启动可能失败（`--remote-debugging-port=0` 被拒），最终 e2e 验证以 CI 为准（见 memory `e2e-local-windows-launch-fails`）。

## 其它

- 后续发现新经验，需同步更新本文件
