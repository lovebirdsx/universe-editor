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

## 用户数据目录

main 进程入口（`src/main/index.ts`）在所有 service 实例化前调用 `applyProductIdentity()`（`src/main/productPaths.ts`），按运行模式切换 `app.setName` / `app.setPath('userData', ...)` / `app.setAppUserModelId`：

| 模式 | 判定 | userData 目录（Win） | AppUserModelId |
|---|---|---|---|
| 发布版 | `import.meta.env.DEV === false` 且无环境变量 | `%APPDATA%/Universe Editor` | `io.universe.editor` |
| dev | `import.meta.env.DEV === true` | `%APPDATA%/Universe Editor - Dev` | `io.universe.editor.dev` |
| E2E | `UNIVERSE_E2E=1` | `%APPDATA%/Universe Editor - E2E` | `io.universe.editor.e2e` |

任何模式都可用 `UNIVERSE_USER_DATA_DIR=<absolute>` 或 Electron 原生 `--user-data-dir=<absolute>` CLI 参数覆盖 userData 目录（CLI 优先；productName 仍按 dev/e2e 决定）。E2E fixture 给每个 Playwright worker 分配 tmp 目录即依赖此机制。darwin/linux 走平台标准目录（`~/Library/Application Support` 或 `XDG_CONFIG_HOME || ~/.config`）。

CLI 参数 / 环境变量 / 部署配置文件的读取统一收口到 `EnvironmentMainService`（`src/main/environment/`），它在 `index.ts` 最顶部构造（早于任何 `app.getPath('userData')`），基于 platform 的 `ConfigResolver` + cli/env/file 可插拔来源（机制见 `packages/platform/src/configuration/sources/`），优先级 `cli > env > file > default`。声明表在 `environment/configItems.ts`。新增"既能命令行又能环境变量配"的启动期配置时加一条声明项，不要再散落 `process.env[...]`。

**`--help` / `--version`**：在 `index.ts` 构造完 `environmentService` 后、任何初始化（console 拦截器、单实例锁）之前命中即 `app.exit(0)`，输出走真实 stdout（GUI 打包版双击启动无控制台时不可见，dev/重定向场景可见）。`--help` 文本由 `environment/configItems.ts` 的 `CLI_OPTIONS` 自动生成；让某个 flag 出现在帮助里，给它的 `ConfigItem` 补 `description`（可选 `cliAlias` 短选项、`args` 值占位符）即可，无需改渲染代码。

**自动更新服务器（发布版可配置）**：feed url 打包默认在 `electron-builder.yml` 的 `publish.url`；发布版（`app.isPackaged`）可在运行时覆盖而不必重新打包——`--update-url=<url>` / `UNIVERSE_UPDATE_URL` / `<userData>/update-config.json` 的 `updateUrl` 字段（仅覆盖 url，channel 仍打包默认）。dev/E2E 不应用 override，仍走 `dev-app-update.yml`。

所有 `app.getPath('userData')` 调用点自动跟随，不需要单独传路径。E2E 用专用目录避免污染本地开发数据。

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

### 通用 UI 走 workbench-ui

原子控件（Button/IconButton/Input/Checkbox/Badge/Spinner）、布局件（Sash/GridLayout/CollapsibleSlot）、浮层（FocusScopeOverlay/PopoverList/ContextMenu）、反馈类（Notifications/QuickInput/ProgressDialog/Confirm·PromptDialog）的**展示部分都在 `packages/workbench-ui`**（纯组件，吃数据 + 回调，无 DI、无 Portal）。`workbench/<feature>/` 下只保留**薄 wrapper**：`useService`/`useObservable` 订阅 → `createPortal` → 拍平成 props，并注入图标解析等应用细节（如 `QuickInputPortal`/`DialogHost`/`ProgressDialogHost`/`NotificationsToast`）。wrapper 文件名/导出名/`data-testid` 保持不变，e2e 选择器零改动。

新增通用控件时优先在 workbench-ui 沉淀，不要在 feature 目录里再写一份 `<button>`+`.module.css`。设计 token（间距/圆角/字号/阴影）来自 `@universe-editor/workbench-ui/tokens.css`（已在 `main.tsx` 入口引入）。**渐进迁移项**（尚未收编、属技术债）：Diff/Terminal/SCM/Config/Search 的 `.iconBtn` 等局部按钮、SessionsPopover/ConfigOptionsBar 等交互模型不同的弹窗、未触及旧 css 的 token 化——动到相关文件时顺手迁移即可。

## bootstrap 链路（renderer 端）

`src/renderer/main.tsx` 顺序：
1. 建 `ServiceCollection`，塞 `LifecycleService`、`ContextKeyService`、`IIpcService`
2. **每个跨进程服务**通过 `ProxyChannel.toService<IFoo>(ipc.getChannel('foo'))` 绑接口
3. 创建 `InstantiationService`（同时自注册为 `IInstantiationService`）
4. 纯 renderer 服务直 `new`，依赖其他服务的走 `instantiation.createInstance(...)`
5. `import './contributions/index.js'`（副作用：注册到 `ContributionsRegistry`）
6. `instantiation.createInstance(ContributionService)`——按 `WorkbenchPhase` 实例化贡献
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

**3. main 端实现**：`src/main/services/myService/myMainService.ts` 写 `class MyMainService implements IMyService`；需要 logger 时用可选 `@ILoggerService` 注入 + `createNamedLogger`（DI 物化时注入真 logger，单测手动 `new` 省略即回退 `NullLogger`，零改动）。application 单例走 root 容器：在 `src/main/services/main-services.ts` 加 `registerSingleton(IMyService, new SyncDescriptor(MyMainService, [], false))`（容器物化 + `will-quit` 统一 dispose），并把 `myService` 加进 `ApplicationServices`（`window/scopedServicesFactory.ts`）和 `getOrCreateServices()`（`index.ts`）里的 `invokeFunction` 组装表。然后在 `src/main/ipc/registerMainServices.ts` 里：
```ts
server.registerChannel(ServiceChannels.MyService, ProxyChannel.fromService(app.myService))
```
> 依赖运行时 `BrowserWindow` 的 per-window 服务仍由 `windowMainService.createWindow()` 手动构造，不走 root 容器。

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

## 套路 G：加一个性能打点 / 启动耗时检测

仿 VSCode Startup Performance 的三层基建，新增检测点时按层对号入座：

**底层打点工具**（`packages/platform/src/base/performance.ts`）：`mark(name)` / `getMarks()` / `clearMarks()`，跨进程通用，两端 `startTime` 均为 epoch 毫秒可直接合并。

**1. 加打点**：先在 `src/shared/perf/marks.ts` 的 `PerfMarks` 加一个名字常量（`code/<proc>/<event>` 约定），再在打点处 `import { mark } from '@universe-editor/platform'` + `import { PerfMarks } from '<相对>/shared/perf/marks.js'`，调用 `mark(PerfMarks.xxx)`。main 与 renderer 都可打点。

```ts
// shared/perf/marks.ts
export const PerfMarks = {
  // ...
  rendererDidMount: 'code/renderer/didMount',
} as const
// 打点处
mark(PerfMarks.rendererDidMount)
```

2. main 端 marks 走 IPC：main 进程的 marks 已通过 IPerformanceMarksService（shared/ipc/services.ts）+ ServiceChannels.Performance 暴露给 renderer。main 端只要 mark()，无需再接线。

3. 聚合 / 计算：renderer 的 ITimerService（src/renderer/services/performance/TimerService.ts）合并两端 marks，getStartupMetrics() 按 MILESTONES 列表算各阶段耗时。加新里程碑只需把它加进 MILESTONES；新增其它 metrics 计算也集中在此服务。

4. 展示：命令 Developer: Startup Performance（actions/performanceActions.ts）打开只读编辑器 StartupPerformanceEditor；状态栏警示入口由 StartupPerformanceStatusContribution 控制，默认关闭。开启 `performance.startupWarning.enabled` 后，发布模式超过 `performance.startupWarning.releaseThresholdMs`（默认 1000ms）显示，dev 模式超过 `performance.startupWarning.developmentThresholdMs`（默认 4000ms）显示。

参考：`packages/platform/src/base/performance.ts`、`src/renderer/services/performance/TimerService.ts`、`src/renderer/contributions/StartupPerformanceStatusContribution.ts`


要点：底层 `mark()` 是通用基建，未来加任何性能检测都从「往 `PerfMarks` 加常量 + 打点」起步;跨进程聚合统一走 `ITimerService`。

## 套路 H：加一个语言特性（DocumentSymbol / Definition / Reference / Outline）

语言特性走**薄门面 `ILanguageFeaturesService`**（`services/languageFeatures/`）：注册时一边存进镜像表（供 Outline 枚举），一边转发给 `monaco.languages.register*Provider`——所以注册一个 provider 即同时点亮 **Outline 视图** 和 Monaco 内置的 **F12 跳转定义 / Shift+F12 查看引用 peek**，无需自己写 UI。

**给某语言加 provider**（如已支持的 markdown）：

1. 在 `services/languageFeatures/<lang>/` 写 provider（实现 `monaco.languages.DocumentSymbolProvider` 等，纯逻辑抽成可单测纯函数）。
2. 在 `contributions/LanguageFeaturesContribution.ts` 的 `MonacoLoader.ensureInitialized().then(...)` 里 `this._register(langFeatures.registerXxxProvider('<lang>', new XxxProvider()))`。**必须等 Monaco 就绪**，否则门面转发报错。

Outline 数据由 `IOutlineService` 统一产出（`outline` / `activeSymbol` 两个 observable），`OutlineView`（侧栏，容器 `workbench.view.outline` 在第二侧栏）与 `Breadcrumbs`（`FileEditor` 顶部）共享消费。DocumentSymbol 的 `range`/`selectionRange` 用 1-based lineNumber；跳转走 `outlineService.revealSymbol`（内部 `FileEditorRegistry.get` + `setPosition` + reveal）。

参考：`services/languageFeatures/LanguageFeaturesService.ts`、`OutlineService.ts`、`markdown/markdown*Provider.ts`

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

## 其它

- 如果是对标vscode的功能，请确保默认按键和command id和其保持一致
