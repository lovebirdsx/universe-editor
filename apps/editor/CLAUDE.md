# apps/editor/CLAUDE.md

Electron 33 桌面应用，VSCode 范式的 workbench。本目录是项目核心，套路最多——下面 5 个"我想做 X"段落直接抄就行。

## 三端边界（electron-vite）

| 端 | 目录 | 职责 |
|---|---|---|
| main | `src/main/` | Node 进程；业务逻辑抽到独立类（如 `FileSystemMainService`），便于不依赖 Electron 单测；通过 `bootstrapWindowIpc` 把服务注册为 IPC channel |
| preload | `src/preload/` | 只通过 `contextBridge.exposeInMainWorld` 暴露白名单 API（一般只暴露 IPC 桥） |
| renderer | `src/renderer/` | React 19 UI；从 `main.tsx` 启动；通过 `ProxyChannel.toService` 拿到 main 端服务 |
| shared | `src/shared/` | 跨端常量：`ipc/channelNames.ts`、消息类型 |

产物在 `out/{main,preload,renderer}`（electron-vite 约定，勿改）。

## renderer 目录归类规则

`src/renderer/` 下五个一级目录承载不同性质的代码，**新文件务必按下表归位**：

| 目录 | 收什么 | 不收什么 |
|---|---|---|
| `services/<feature>/` | 所有 `*Service.ts` / `*Registry.ts` / `*Input.ts` / 业务 helper / 与平台无关的纯函数；同级 `__tests__/` 放测试 | React 组件、React Hook、`.module.css` |
| `contributions/` | 所有 `implements IWorkbenchContribution` 的类（即便文件名不带 Contribution，例如 `ExternalChangeWatcher.ts`）；同级 `__tests__/` 放测试 | 服务、Action、视图 |
| `actions/` | 所有 `Action2` 子类，**文件名必须复数** `*Actions.ts` 并按业务域聚合（`fileSaveActions.ts` / `fileOpenActions.ts` / `layoutActions.ts` …），不要为单个 Action 起独立文件；同级 `__tests__/` 放测试 | Action 之外的服务/视图 |
| `workbench/<feature>/` | `.tsx` 视图组件、`.module.css` 样式、React Hook（`useXxx.ts(x)`）、React Context；同级 `__tests__/` 放测试 | `*Service.ts` / `*Input.ts` / Contribution |
| `ipc/` | renderer 端 IPC bootstrap | — |

应用入口位于 `main.tsx`，应用级 helper（`errors.ts` / `global.d.ts`）放在 `renderer/` 根。E2E 探针在 `renderer/e2e/`。

新增模块时先问"它是不是 IWorkbenchContribution"，是 → `contributions/`；否则问"它是不是 Service/Registry/Input"，是 → `services/`；否则问"它是不是 Action2"，是 → `actions/`；都不是就是视图层 → `workbench/`。

## bootstrap 链路（renderer 端）

`src/renderer/main.tsx` 顺序：
1. 建 `ServiceCollection`，塞 `LifecycleService`、`ContextKeyService`、`IIpcService`
2. **每个跨进程服务**通过 `ProxyChannel.toService<IFoo>(ipc.getChannel('foo'))` 绑接口
3. 创建 `InstantiationService`（同时自注册为 `IInstantiationService`）
4. 纯 renderer 服务直 `new`，依赖其他服务的走 `instantiation.createInstance(...)`
5. `import './contributions/index.js'`（副作用：注册到 `ContributionsRegistry`）
6. `new ContributionService(lifecycle, instantiation)`——按 `WorkbenchPhase` 实例化贡献
7. `lifecycle.setPhase(LifecyclePhase.Ready)` → 触发 `BlockRestore`
8. `createRoot(...).render(<Workbench />)`

## 套路 A：加一个 Action2（命令 + 快捷键）

**文件归位**：`src/renderer/actions/<domain>Actions.ts`（**复数**，按业务域归类，如 `fileSaveActions.ts` / `fileOpenActions.ts` / `layoutActions.ts` / `editorActions.ts`）。同一域内可放多个 Action 类；不要为单个 Action 新建独立文件。

```ts
import { Action2, ILayoutService, PartId, type ServicesAccessor } from '@universe-editor/platform'

export class MyAction extends Action2 {
  static readonly ID = 'workbench.action.doMyThing'
  constructor() {
    super({
      id: MyAction.ID,
      title: '做我的事',
      category: 'View',
      keybinding: { primary: 'ctrl+shift+m' },
      precondition: 'hasActiveEditor',   // 可选，ContextKey 表达式
      f1: true,                          // 命令面板可见
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(ILayoutService).toggleVisible(PartId.SideBar)
  }
}
```

**注册**：在 `src/renderer/actions/index.ts` 对应分组里加 `registerAction2(MyAction)`。

参考：`src/renderer/actions/layoutActions.ts`、`src/renderer/actions/searchActions.ts`

## 套路 B：加一个 ViewContainer / View（侧栏标签页）

三处必改：

**1. Container 注册**：在 `src/renderer/contributions/BuiltInViewContainersContribution.ts` 构造函数里加：
```ts
this._register(
  ViewContainerRegistry.registerViewContainer({
    id: 'workbench.view.myThing',
    label: 'My Thing',
    icon: 'lightbulb',
    order: 3,
    location: ViewContainerLocation.SideBar,
  }),
)
```

**2. View 描述符**：在 `src/renderer/contributions/BuiltInViewsContribution.ts` 里加：
```ts
this._register(
  ViewRegistry.registerView({
    id: 'workbench.view.myThing.main',
    name: 'My Thing',
    containerId: 'workbench.view.myThing',
    componentKey: 'myThing.main',
    order: 1,
  }),
)
```

**3. 组件映射**：在 `src/renderer/workbench/sidebar/SideBar.tsx` 的 `viewComponentMap` 加：
```ts
viewComponentMap.set('myThing.main', MyThingView)
```

新建 `src/renderer/workbench/myThing/MyThingView.tsx` 写 React 组件，用 `useService(IFooService)` 拿服务。

参考：`src/renderer/workbench/search/SearchView.tsx`

## 套路 C：加一个跨进程 ProxyChannel 服务

**1. 通道名**：`src/shared/ipc/channelNames.ts` 的 `ServiceChannels` 加一行 `MyService: 'myService'`。

**2. 接口**：`src/shared/ipc/services.ts`（或新建文件，复杂服务建议下沉到 platform）：
```ts
export interface IMyService {
  readonly _serviceBrand: undefined
  doIt(arg: string): Promise<number>
}
export const IMyService = createDecorator<IMyService>('myService')
```

**3. main 端实现**：`src/main/services/myService/myMainService.ts` 写 `class MyMainService implements IMyService`。然后在 `src/main/ipc/registerMainServices.ts` 里：
```ts
server.registerChannel(ServiceChannels.MyService, ProxyChannel.fromService(shared.myService))
```
并在 `SharedMainServices` 与 `getSharedServices()`（`src/main/index.ts`）里挂上实例。

**4. renderer 端绑定**：`src/renderer/main.tsx`：
```ts
services.set(
  IMyService,
  ProxyChannel.toService<IMyService>(ipcService.getChannel(ServiceChannels.MyService)),
)
```

参考：`src/main/ipc/registerMainServices.ts`、`src/main/services/files/fileSystemMainService.ts`

## 套路 D：加一个 Contribution（生命周期挂钩）

```ts
export class MyContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IEditorService editorService: IEditorService) {
    super()
    this._register(autorun((r) => {
      const active = editorService.activeEditor.read(r)
      // 响应 active 变化
    }))
  }
}
```

**注册**：在 `src/renderer/contributions/index.ts` 选合适相位：
```ts
ContributionsRegistry.registerContribution(
  'workbench.contrib.myThing',
  MyContribution,
  WorkbenchPhase.AfterRestore,   // 或 BlockStartup / BlockRestore / Eventually
)
```

相位选择：
- `BlockStartup`：必须在任何 UI 渲染前跑（ContextKey 默认、ViewContainer 注册、配置 schema）
- `BlockRestore`：UI 挂载前（恢复编辑器组等会影响首屏的逻辑）
- `AfterRestore`：UI 已挂载（状态栏、外部文件 watcher 等）
- `Eventually`：空闲期（统计、预热）

参考：`src/renderer/contributions/index.ts`

## 套路 E：加一个 StatusBar 条目

`addEntry` 返回 accessor，存起来后续 `update`/`dispose`：
```ts
const entry = statusBarService.addEntry({
  text: '$(search) 搜索中…',
  tooltip: '...',
  alignment: StatusBarAlignment.Right,
  priority: 100,
})
// 后续更新
entry.update({ text: '完成', alignment: StatusBarAlignment.Right, priority: 100 })
// 不再需要时
entry.dispose()
```

要点：**生命周期由你管**。React 组件里放 `useRef` 持 accessor，`useEffect` cleanup 里 dispose；Contribution 里放成员字段，`_hide()` 时 dispose。

参考：`src/renderer/contributions/FileEditorStatusContribution.ts`、`src/renderer/workbench/search/useSearchEngine.ts`

## 套路 F：加一个 E2E 冒烟场景

冒烟栈在 `apps/editor/e2e/`：Playwright + `_electron`，spec 通过 `window.__E2E__` 探针调服务，不戳 DOM。三层安全门：`UNIVERSE_E2E=1` → main argv `--enable-e2e-probe` → preload 经 `contextBridge` 暴露——production 构建天然剥除。

**1. 新建 spec**：`apps/editor/e2e/specs/smoke.myThing.spec.ts`
```ts
import { test, expect } from '../fixtures/electronApp.js'

test.describe('@p0 my thing', () => {
  test('does the thing', async ({ workbench }) => {
    await workbench.runCommand('workbench.action.doMyThing')
    await expect.poll(() => workbench.getContextKey<boolean>('myThingActive')).toBe(true)
  })
})
```

**2. 复用 fixture / PO**：`fixtures/electronApp.ts` 启动 Electron + 等探针装配；`pages/WorkbenchPO.ts` 聚合 ActivityBar / SideBar / StatusBar / QuickInput / EditorArea / Panel 六个 PO，外加 `runCommand` / `getContextKey` / `lifecyclePhase` 三个直通探针的快捷方法。

**3. 定位优先级**：ARIA role → `data-testid`（约定 `part-<id>` / `activitybar-item-<id>` / `view-<id>` / `quick-input` / `statusbar-entry-<id>`）→ 命令 + ContextKey（最稳定）→ CSS class（兜底）。**禁止**断言 Monaco 内部 DOM 结构；要拿编辑器状态走 `getActiveEditorUri()`。

**4. 探针 API 不够用**：先扩 `src/shared/e2e/contract.ts` 契约，再在 `src/renderer/e2e/probe.ts` 实现。保持白名单原则——不暴露 fs/exec/任意 IPC 给 spec。

**5. 跑**：
```bash
pnpm --filter @universe-editor/editor build      # e2e 跑的是 out/ 产物
pnpm --filter @universe-editor/editor e2e
pnpm --filter @universe-editor/editor e2e:ui     # 本地交互调试
pnpm --filter @universe-editor/editor e2e -- --grep "@p0"
```

**标签**：`@p0` 失败阻塞 CI；`@p1` 仅产报告。CI 在 ubuntu + windows 双跑（`.github/workflows/ci.yml` 的 `e2e` job）。

**踩坑**：
- 部件可见性走 ContextKey + `expect.poll(...)`，不要 `toBeVisible()`——Allotment.Pane 用 CSS visibility 隐藏后代，DOM 可见性会误判
- 长任务命令（如 `showCommands` 内部 await 用户输入）必须 fire-and-forget：`page.evaluate(() => { void window.__E2E__!.runCommand(id) })`，否则死锁
- spec 内**禁止** mock 任何 main/renderer 服务；单测内**禁止** spawn Electron——边界严格分开

参考：`apps/editor/e2e/specs/smoke.startup.spec.ts`、`smoke.output.spec.ts`、`smoke.commandPalette.spec.ts`

## 编辑器输入三件套

- **`FileEditorInput`**：editor input 描述（URI + 元数据），可序列化恢复
- **`MonacoModelRegistry`**：URI → Monaco `ITextModel` 的注册表；模型独立于编辑器实例（多分屏共享同一模型）
- **`FileEditorRegistry`**：`FileEditorInput` → 当前挂载的 Monaco editor 实例；状态栏/搜索高亮通过它找编辑器

打开文件流程：`editorService.openEditor(new FileEditorInput(uri))` → React `FileEditorComponent` 挂载 → 注册到 `FileEditorRegistry` → 状态栏 contribution 拿光标位置。

## 测试边界

`vitest.config.ts` 有两个 project：
- **main**（node 环境）：覆盖 `src/main/**/__tests__/`、`src/shared/**/__tests__/`
- **renderer**（happy-dom）：覆盖 `src/renderer/**/__tests__/`，Monaco 走桩（避免真实加载 worker）

`pnpm --filter @universe-editor/editor test` 跑全部；`vitest --project main` 只跑一边。

E2E 冒烟独立于 vitest，跑的是 `out/` 产物——见**套路 F**。

## 常见踩坑

- **Monaco 是 dynamic import**：测试里 mock 掉或用 `_resetForTests()` 清状态（见 `MonacoModelRegistry._resetForTests`）。
- **改了 platform 后**：renderer 看到的是 `packages/platform/dist/`；`pnpm dev` 下 watcher 自动重建，否则手动 `pnpm --filter @universe-editor/platform build`。
- **新增 platform API**：必须先在 `packages/platform/src/index.ts` re-export，否则 apps 编译不通过。
- **ContextKey 表达式**：写字符串如 `'hasActiveEditor'` 会在 Action2 内部 `ContextKeyExpr.deserialize`；先确保 key 已在 `ContextKeyContribution` 里 seed。
- **URI 经 IPC 后**：`fm.resource` 是 `UriComponents` 而非 `URI` 实例，需要 `URI.revive(fm.resource) as URI`。
