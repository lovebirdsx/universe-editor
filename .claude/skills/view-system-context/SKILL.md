---
name: view-system-context
description: 处理 view / view container（侧栏标签页、面板视图、视图拖拽与归属）相关功能时召回，提供整个 VSCode 范式 view 系统的上下文地图——静态注册表（ViewRegistry / ViewContainerRegistry 只声明默认归属）与运行时重映射层 IViewDescriptorService（用户拖拽/重排/折叠/尺寸/生成容器 + 按 workspace 持久化）的两层分工、version observable 驱动 UI 响应、原生 HTML5 DnD（viewDragData 单例 + VIEW_DRAG_MIME）、ActivityBar/SideBar/SecondarySideBar/Panel 三区域间移动、拖到空白生成可回收容器、MoveViewAction 命令、以及 e2e 探针与持久化往返验证。当任务涉及 IViewDescriptorService、view 在容器间拖动/重排、ViewPane/ViewPaneContainer/PaneCompositePart、ActivityBar 图标重排、生成容器（generated container）、view 折叠/尺寸持久化、moveViewsToContainer/moveViewToLocation/moveViewContainerToLocation、或要理解「一个 view 怎么从一个容器搬到另一个、怎么持久化、UI 怎么同步刷新」时，先读它建立全局认知。注册「加一个新 View / ViewContainer」的标准三件套见 apps/editor/CLAUDE.md 套路 B。
disable-model-invocation: true
---

# View 系统 上下文地图

universe-editor 仿照 VSCode，把「**一个 view 默认住在哪个容器**」和「**用户当前把它拖到了哪**」拆成两层：

- **静态注册表层**（`packages/platform`，纯声明）：`ViewContainerRegistry` / `ViewRegistry` 只记录**默认归属、默认顺序、能力位**（`canMoveView` / `generated`）。注册一个新 View/Container 时写这里（套路 B 三件套）。
- **运行时重映射层**（`apps/editor`，可变 + 持久化）：`IViewDescriptorService` 在注册表之上叠加用户定制——拖动改归属、重排序、折叠态、面板尺寸、动态生成的容器，并按 **workspace 作用域**持久化。**所有 UI 都从这一层读**，所以一个被拖走的 view 会出现在新容器里，而注册表完全不动。

> ⚠️ 第一原则：动手前先认领你的改动落在哪层。
> - **「系统里存在哪些 view/容器、默认住哪」** → 静态注册表（`viewRegistry.ts` + 三件套 contribution）。
> - **「用户能怎么搬动它们、搬完怎么记住、UI 怎么刷新」** → `ViewDescriptorService` + 消费它的 UI 组件。
> 把运行时定制逻辑塞进注册表，或反过来把默认归属硬编码进 UI，都是把两层揉死。

## 数据流一图

```
ViewRegistry / ViewContainerRegistry  ← 静态默认归属，唯一真相是「默认」
  │  （仅在 ViewDescriptorService 内部被读作 fallback）
  ▼
IViewDescriptorService  ── version: IObservable<number>（每次 mutation 自增）
  │  叠加：自定义归属 / 顺序 / 折叠 / 尺寸 / 生成容器，按 workspace 持久化
  ▼  所有查询都走这层：getViewContainerByViewId / getViewsByContainer / getViewContainersByLocation …
UI 层（全部经 useViewDescriptors() 订阅 version 后再 re-query）
  ├─ ActivityBar.tsx          SideBar 区的容器图标：点选激活 + 拖拽重排容器 + 接收 view 投放
  ├─ PaneCompositePart.tsx    某 location 的活跃容器内容宿主（stack→ViewPaneContainer / tiled→TiledViews）
  ├─ PaneCompositeHeader.tsx  SecondarySideBar/Panel 区的容器标签条
  ├─ ViewPaneContainer.tsx    一个容器内的多 view 纵向 Allotment：折叠/尺寸/容器内重排/跨容器投放/空容器放置区
  └─ ViewPane.tsx             单个 view 面板：拖源（draggable）+ 放置目标（before/after 边缘）

拖拽载荷（原生 HTML5 DnD 在 dragover 阶段读不到 payload，故用内存单例兜底）：
  workbench/dnd/viewDragData.ts —— viewDragData 单例 + VIEW_DRAG_MIME + dragContainsView()
```

## 运行时核心：IViewDescriptorService

接口 `packages/platform/src/workbench/viewDescriptorService.ts`（**改接口后必须 `pnpm --filter @universe-editor/platform build`**，apps 吃的是 `dist/`；且新 API 要在 `packages/platform/src/index.ts` re-export）。
实现 `apps/editor/src/renderer/services/views/ViewDescriptorService.ts`。

- **`version: IObservable<number>`** —— 每次 mutation（move / reorder / collapse / size / 生成容器增删）自增。**这是 UI 响应的唯一开关**：UI 不直接监听各种事件，而是订阅 version 后整体 re-query。
- **查询**：`getViewContainerById` / `getViewContainersByLocation`（按显示顺序，尊重自定义排序）/ `getViewContainerLocation` / `getViewsByContainer` / `getViewContainerByViewId` / `getViewLocationById` / `getDefaultContainerById`。
- **mutation**：
  - `moveViewsToContainer(viewIds, targetContainerId)` —— 跨容器投放（拖到另一个已存在容器）。
  - `moveViewToLocation(viewId, location)` —— 拖到某区域的空白，**生成一个新容器**装它。
  - `moveViewContainerToLocation(containerId, location)` —— 整个容器（带所有 view）换区域。
  - `moveViewInContainer(containerId, viewId, targetViewId)` —— 容器内重排（drop before/after）。
  - `moveContainerInLocation(containerId, targetContainerId)` —— 同区域内容器重排（ActivityBar 图标重排）。
- **per-view 状态**：`getViewState(viewId): IViewState`（`{collapsed?, size?, order?}`）/ `setViewCollapsed` / `setViewSizes(sizes[])`。
- **`reset()`** —— 清空所有定制回到注册表默认（`ResetViewLocationsAction` 调它）。
- **`save(): Promise<void>`** —— 强制 flush 防抖写盘，**给 e2e 探针用**（驱动改动后立即落盘再重载验证）。

### 实现要点（ViewDescriptorService.ts）

- **持久化**：`STORAGE_KEY = 'workbench.viewCustomizations'`，**`StorageScope.WORKSPACE`**（view 布局是项目级习惯，对标 VSCode 跟随工作区，不是全局）。写盘走防抖 `_saveTimer`；`save()` 立即清 timer 并同步落盘。
- **生成容器**：`GENERATED_PREFIX = 'workbench.view.generated.'`，id 形如 `workbench.view.generated.<tag>.<counter>`，`icon: 'window'`、`generated: true`。
  - **生成**：`moveViewToLocation` 把 view 移到某区域空白时，造一个新容器描述符并 `_generated` 登记。
  - **回收**：当一个生成容器里最后一个 view 被移走 → 容器自动注销（`_generated.delete` + 从注册表 deregister）。**非生成容器（内置的）即使空了也不回收**。
  - **持久化往返**：生成容器要存进 `generatedContainers[]`；`load()/_loadFromStorage()` 时**先把生成容器重新 register 回 ViewContainerRegistry**，再恢复 view 归属——否则恢复出来的 view 指向一个不存在的容器。
- **workspace 切换**：监听 workspace 变化 → `_reload()`：清掉当前生成容器（避免泄漏到新工作区）+ 重新从新 workspace 的 storage 加载。
- **eager seeding**：构造时通过 version autorun 会自动选中某 location 第一个容器（VSCode 风「自动激活首个容器」）。这是为什么 Panel 测试「无激活容器」要改成「该 location 无容器存在」才能断言空内容。

### DI 注册

`apps/editor/src/renderer/main.tsx`：`instantiation.createInstance(ViewDescriptorService)` → `services.set(IViewDescriptorService, …)`。`ViewsService` 构造注入它（`@IViewDescriptorService`），订阅 `version` 来决定每个 location 的激活容器。

## UI 层（全部经 useViewDescriptors 订阅）

**统一入口** `apps/editor/src/renderer/workbench/dnd/useViewDescriptors.ts`：

```ts
export function useViewDescriptors(): IViewDescriptorService {
  const service = useService(IViewDescriptorService)
  useObservable(service.version)   // 订阅 version → mutation 后组件 re-render 重新 query
  return service
}
```

> ⚠️ **任何要反映 view 归属/顺序/折叠的组件都必须用 `useViewDescriptors()`，不要直接读 `ViewContainerRegistry`/`ViewRegistry`**。直接读注册表 = 拿到的是默认布局，用户拖动后不刷新（这是重构时改掉的一类 bug，勿回退）。

| 组件 | 路径 | 职责 |
|---|---|---|
| `ActivityBar.tsx` | `workbench/activitybar/` | SideBar 区容器图标。点选激活；图标拖拽重排（`moveContainerInLocation`，before/after 边缘命中）；接收 view 投放（`moveViewsToContainer`）。状态 `draggingId` / `dropTarget:{id,edge}` |
| `PaneCompositePart.tsx` | `workbench/paneComposite/` | 某 location 活跃容器的内容宿主。`content==='stack'` → `ViewPaneContainer`；否则 `TiledViews`。null-guard `activeContainer` |
| `PaneCompositeHeader.tsx` | `workbench/paneComposite/` | SecondarySideBar/Panel 区的容器标签条（`getViewContainersByLocation(location)`） |
| `ViewPaneContainer.tsx` | `workbench/sidebar/` | 一个容器内多 view 的纵向 `Allotment`。折叠读写 `getViewState/setViewCollapsed`；尺寸在 `onChange` → `setViewSizes`；`moveHere` 处理跨容器+容器内重排；**空容器渲染放置区**（`data-empty-drop`）；每个 ViewPane `draggable={v.canMoveView !== false}` |
| `ViewPane.tsx` | `workbench/sidebar/` | 单 view 面板。拖源（`onDragStart` 写 `viewDragData` + `dataTransfer.setData(VIEW_DRAG_MIME, viewId)`）；放置目标（hit-test `clientY` vs 中点得 `dropEdge` 'before'/'after'，叠加 overlay） |

CSS 状态类：`ViewPane.module.css`(`.dragging` / `.dropTop::before` / `.dropBottom::after`)、`PaneComposite.module.css`(`.emptyDrop` / `.emptyDropOver`)、`ActivityBar.module.css`(`.dragging` / `.dropBefore::after` / `.dropAfter::after`)。

## 原生 DnD 套路（workbench/dnd/viewDragData.ts）

HTML5 DnD 在 **dragover 阶段读不到 `dataTransfer` 的 payload**（只在 drop 才可读），所以用内存单例兜底：

- `viewDragData`（`{set/get/clear}`）—— `onDragStart` 写入 `{kind:'view', id}`，dragover 时从这里读「正在拖什么」决定要不要高亮放置区。
- `VIEW_DRAG_MIME = 'application/vnd.universe-editor.view-drag'` —— 私有 MIME，`onDragStart` 也 `setData` 一份，用于和**资源拖拽**（拖文件）区分。
- `dragContainsView(dataTransfer)` —— 在 `onDragOver` 里判断「这是不是一个 view 拖拽」（检查 MIME types），避免把文件拖拽误当 view 投放。

## 命令

`apps/editor/src/renderer/actions/viewActions.ts`（在 `actions/index.ts` 注册）：

- **`MoveViewAction`**（id `workbench.action.moveView`，icon `move`，菜单 `MenuId.ViewTitle` group `9_move`，`f1:true`）：
  `run(accessor, viewId?)` —— 无 viewId 入参时先 QuickPick 选 view；再 QuickPick 选目标（跨三个 location 的现有容器，排除当前容器 + `canMoveView:false`）外加三个「在 X 区新建容器」选项（→ `moveViewToLocation`）。
  - **viewId 怎么传进来**：view 标题栏的 action 经 `ViewTitleActions.tsx` 读 per-view scoped context key `view`（`contextKeyService.get('view')`）作为命令第一参数传入。所以 `MoveViewAction` 既能从标题栏（带 viewId）也能从命令面板（不带，走 QuickPick）触发。
- **`ResetViewLocationsAction`**（id `workbench.action.resetViewLocations`）：调 `viewDescriptors.reset()`。

> exactOptionalPropertyTypes 提醒：QuickPick item 的可选 `description` 要用条件展开 `...(description !== undefined ? { description } : {})`，不能 `description: string | undefined`。

## 加新 View / ViewContainer（静态层，套路 B 三件套）

这部分**不属于运行时重映射**，是声明「系统里存在这个 view」。三处必改（详见 `apps/editor/CLAUDE.md` 套路 B）：
1. `contributions/BuiltInViewContainersContribution.ts`（或对应文件）—— `ViewContainerRegistry` 注册容器 + `location`。
2. `contributions/BuiltInViewsContribution.ts` —— `ViewRegistry` 注册 view + `componentKey`。
3. `contributions/ViewComponentsContribution.ts` —— `ViewComponentRegistry.register(componentKey, Component)`。

注册描述符的能力位：`canMoveView?: boolean`（默认可移动，设 `false` 锁定不可拖走）、`order: number`（默认顺序）、容器 `generated?: boolean`（内部生成标记，业务勿手动设）。

## 关键架构决策与「为什么」

- **静态/运行时两层分离**：注册表只管「默认住哪」，定制叠在 service 层。好处：拖动布局不污染注册表、可一键 `reset()` 回默认、持久化只序列化「与默认的差异 + 生成容器」。直接对标 VSCode `IViewDescriptorService`。
- **version observable 而非细粒度事件**：mutation 种类多（移动/重排/折叠/尺寸/生成），与其为每种发事件，不如一个单调递增的 version，UI 订阅后整体 re-query。简单、不漏更新。代价是 re-query 粒度粗，但 view 数量小可接受。
- **生成容器自动回收**：拖 view 到空白生成容器、容器空了自动消失——和 VSCode 一致，避免残留空容器。**仅生成容器回收，内置容器永驻**。
- **持久化 workspace 作用域**：view 布局是「这个项目我想怎么摆」，跟随工作区而非全局（对比大纲偏好是 GLOBAL）。
- **DnD 内存单例兜底**：原生 DnD 的 dragover 阶段读不到 payload 是浏览器既定行为，`viewDragData` 单例 + 私有 MIME 是绕过它的标准手法。

## 常见任务 → 改哪里

- **改拖拽放置的判定/高亮（边缘命中、放置区样式）**：`ViewPane.tsx`（before/after hit-test + overlay）/ `ViewPaneContainer.tsx`（空容器放置区）/ `ActivityBar.tsx`（容器重排边缘）+ 对应 `.module.css`。
- **新增一种 mutation（如「克隆 view 到另一容器」）**：先在 `IViewDescriptorService` 接口加方法（platform）→ rebuild + re-export → 实现 → UI/命令调用 → 加单测。**记得自增 version**，否则 UI 不刷新。
- **改持久化内容（多存一个 per-view 字段）**：`IViewState` 加字段 → 实现里 `getViewState/set*` + `PersistedCustomizations` 序列化往返 → 单测加 round-trip。
- **改 view 移动命令的交互**：`actions/viewActions.ts`（QuickPick 流程）；要让标题栏 action 拿到 viewId 看 `ViewTitleActions.tsx` 的 context key 传参。
- **某 view 不该被拖走**：注册描述符设 `canMoveView: false`（静态层），UI 的 `draggable` 与命令的目标过滤都已尊重它。
- **加新 View/Container（让它出现在系统里）**：套路 B 三件套，**不是**这个 service 的事。
- **生成容器图标不对**：`workbench/activitybar/icon-map.ts`（`window: AppWindow`）/ `viewContainerHeader/icon-map.ts`。

## 易踩坑速记

1. **改了 platform 接口忘 rebuild**：apps 吃 `dist/`，`viewDescriptorService.ts` 改完要 `pnpm --filter @universe-editor/platform build` + 在 `packages/platform/src/index.ts` re-export，否则 apps 看不到新 API（编译报「不存在」）。
2. **UI 直接读注册表 = 拖动不刷新**：要反映归属/顺序的组件必须 `useViewDescriptors()` 订阅 version，别 import `ViewContainerRegistry`/`ViewRegistry` 直接读。
3. **mutation 忘自增 version**：service 加新 mutation 时若不 bump version，UI 完全不动。
4. **生成容器 load 时漏 re-register**：`_loadFromStorage` 必须先把 `generatedContainers` 重新 register 进 ViewContainerRegistry，再恢复 view 归属；否则恢复出指向「不存在容器」的 view。
5. **eager seeding 改变了空状态语义**：构造即自动选中首个容器，断言「无内容」要用「该 location 无任何容器」而非「无激活容器」（见 `Panel.test.tsx`）。
6. **dragover 读不到 payload**：别在 `onDragOver` 里 `dataTransfer.getData()`，那是空的；用 `viewDragData.get()` + `dragContainsView()`。
7. **exactOptionalPropertyTypes**：QuickPick/描述符的可选字段用条件展开，不要 `x: T | undefined`。

## 验证

```bash
cd apps/editor && pnpm vitest run --project renderer \
  src/renderer/services/views/__tests__/ViewDescriptorService.test.ts \
  src/renderer/services/views/__tests__/ViewsService.test.ts \
  src/renderer/workbench/panel/__tests__/Panel.test.tsx        # view 系统相关单测
pnpm check                                          # lint+typecheck+全量 test（platform 改了会自动 rebuild）
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物，改 renderer/接口后必重建
cd apps/editor && pnpm exec playwright test specs/smoke.viewMove.spec.ts   # @p0 移动+重载持久化往返
```

**e2e 探针**（`contract.ts` + `renderer/e2e/probe.ts`，委托 `viewDescriptorService`）：
`getViewContainerByViewId` / `getViewIdsByContainer` / `getViewContainerIdsByLocation` / `moveViewsToContainer` / `moveViewToLocation` / `moveViewContainerToLocation` / `getViewCollapsed` / `setViewCollapsed` / `flushViewCustomizationsSave` / `resetViewLocations`。
探针**绕开 DnD 鼠标几何**直接驱动 service，专测「数据模型 + 持久化」主链路；`smoke.viewMove.spec.ts` 用冷启动 + workspace 作用域 seed + 重载窗口验证往返。

> ⚠️ 本地 Windows e2e 启动可能失败（`--remote-debugging-port=0` 被拒），最终 e2e 验证以 CI 为准（见 memory `e2e-local-windows-launch-fails`）。

## 关键参考路径

- `packages/platform/src/workbench/viewDescriptorService.ts` —— 运行时重映射接口（IViewDescriptorService / IViewState）
- `packages/platform/src/workbench/viewRegistry.ts` —— 静态注册表 + 描述符字段（canMoveView / order / generated）
- `apps/editor/src/renderer/services/views/ViewDescriptorService.ts` —— 实现（持久化/生成容器/回收/workspace reload）
- `apps/editor/src/renderer/services/views/ViewsService.ts` —— 消费 version 决定每个 location 的激活容器
- `apps/editor/src/renderer/workbench/dnd/{useViewDescriptors.ts,viewDragData.ts}` —— UI 订阅入口 + DnD 载荷
- `apps/editor/src/renderer/workbench/{activitybar/ActivityBar,paneComposite/PaneCompositePart,paneComposite/PaneCompositeHeader,sidebar/ViewPaneContainer,sidebar/ViewPane}.tsx` —— UI 五件套
- `apps/editor/src/renderer/workbench/viewContainerHeader/ViewTitleActions.tsx` —— 标题栏 action 经 context key 传 viewId
- `apps/editor/src/renderer/actions/viewActions.ts` —— MoveViewAction / ResetViewLocationsAction
- `apps/editor/src/renderer/main.tsx` —— DI 注册（createInstance + services.set）
- 测试：`…/services/views/__tests__/{ViewDescriptorService,ViewsService}.test.ts`、`…/workbench/panel/__tests__/Panel.test.tsx`、`apps/editor/e2e/specs/smoke.viewMove.spec.ts`
- 加新 View/Container 的三件套：`apps/editor/CLAUDE.md` 套路 B
