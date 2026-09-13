# apps/editor/CLAUDE.md

Electron 43 桌面应用，VSCode 范式的 workbench。「套路 A~I」可直接抄；细节拆在 `cases-*.md`。

## 三端边界（electron-vite）

main `src/main/`（Node，业务逻辑抽独立类，经 `bootstrapWindowIpc` 注册 IPC）/ preload `src/preload/`（`contextBridge` 白名单）/ renderer `src/renderer/`（React，`main.tsx` 启动，`ProxyChannel.toService` 拿服务）/ shared `src/shared/`（`ipc/channelNames.ts`）。产物 `out/`（勿改）。

## 用户数据目录与启动配置

main 入口（`index.ts`）在 service 实例化前调 `applyProductIdentity()` 切 `userData`：

- 任何模式可用 `UNIVERSE_USER_DATA_DIR=<absolute>` 或原生 `--user-data-dir=<absolute>` 覆盖（**CLI 优先**）。
- CLI/env/配置读取收口 `EnvironmentMainService`（`src/main/environment/`），优先级 `cli > env > file > default`；新增启动期配置加声明项。
- **构建期注入 settings 默认值**：内网地址不进仓库，打包期经 `product.json` 注入出厂默认值。

模式判定表、`--help` 生成、构建期注入出厂默认值的优先级与链路、自动更新 feed url 覆盖见 [cases-user-data-dir.md](cases-user-data-dir.md)。

## renderer 目录归类规则

| 目录 | 收什么 |
|---|---|
| `services/<feature>/` | `*Service.ts` / `*Registry.ts` / `*Input.ts` / helper / 纯函数 |
| `contributions/` | 所有 `implements IWorkbenchContribution` 的类（文件名不带 Contribution 也算） |
| `actions/` | 所有 `Action2`，**文件名必须复数** `*Actions.ts` 按业务域聚合 |
| `workbench/<feature>/` | `.tsx` 视图、`.module.css`、Hook、Context |
| `ipc/` | renderer 端 IPC bootstrap |

同级 `__tests__/` 放测试。**通用 UI 走 workbench-ui**（`packages/workbench-ui` 纯组件、无 DI），`workbench/<feature>/` 只留薄 wrapper（文件名/导出名/`data-testid` 不变）。

## 嵌套知识地图

各子系统 CLAUDE.md 是「处理该域任务前通读」的上下文地图：

- [services/acp](src/renderer/services/acp/CLAUDE.md) — ACP 协议客户端
- [services/acp/session](src/renderer/services/acp/session/CLAUDE.md) — 会话生命周期
- [workbench/agentSettings/claude](src/renderer/workbench/agentSettings/claude/CLAUDE.md) — Claude agent 面板
- [workbench/agentSettings/codex](src/renderer/workbench/agentSettings/codex/CLAUDE.md) — Codex agent 面板
- [services/ai](src/renderer/services/ai/CLAUDE.md) — 内联补全/NES/门面
- [workbench/ai](src/renderer/workbench/ai/CLAUDE.md) — AI 设置页面壳
- [main/services/ai](src/main/services/ai/CLAUDE.md) — AI Debug + 回放
- [main/services/extensionManagement](src/main/services/extensionManagement/CLAUDE.md) — 扩展管理分发
- [main/services/clipboard](src/main/services/clipboard/CLAUDE.md) — 文件剪贴板 main 侧
- [services/explorer](src/renderer/services/explorer/CLAUDE.md) — explorer 状态源
- [services/opener](src/renderer/services/opener/CLAUDE.md) — IOpenerService 三档
- [services/views](src/renderer/services/views/CLAUDE.md) — View/ViewContainer 运行时
- [services/configurationResolver](src/renderer/services/configurationResolver/CLAUDE.md) — 配置变量替换
- [services/dialogs](src/renderer/services/dialogs/CLAUDE.md) — SimpleFileDialog
- [services/dnd](src/renderer/services/dnd/CLAUDE.md) — 资源拖放
- [services/themes](src/renderer/services/themes/CLAUDE.md) — 主题系统
- [workbench/files](src/renderer/workbench/files/CLAUDE.md) — 文件图标 + 语言解析
- [shared/i18n](src/shared/i18n/CLAUDE.md) — 本地化消息表与解析序
- [workbench/markdown](src/renderer/workbench/markdown/CLAUDE.md) — markdown 渲染/预览
- [workbench/outline](src/renderer/workbench/outline/CLAUDE.md) — outline 视图
- [workbench/scm](src/renderer/workbench/scm/CLAUDE.md) — SCM 视图 + dirty-diff
- [workbench/webview](src/renderer/workbench/webview/CLAUDE.md) — webview 基建五层
- [e2e](e2e/CLAUDE.md) — Playwright 冒烟栈

## 套路 A：加一个 Action2（命令 + 快捷键）

归位：`renderer/actions/<domain>Actions.ts`（**复数**，按业务域归类）。

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
      precondition: 'hasActiveEditor', // 可选
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(ILayoutService).toggleVisible(PartId.SideBar)
  }
}
```

**注册**：`actions/index.ts` 对应分组加 `registerAction2(MyAction)`。

## 套路 B：加一个 ViewContainer / View（侧栏标签页）

两处必改：

```ts
// 1. Container：BuiltInViewContainersContribution.ts 构造函数
this._register(
  ViewContainerRegistry.registerViewContainer({
    id: 'workbench.view.myThing', label: 'My Thing', icon: 'lightbulb',
    order: 3, location: ViewContainerLocation.SideBar,
  }),
)

// 2. View + 组件单点注册：BuiltInViewsContribution.ts
//    registerViewWithComponent 一次完成描述符 + 组件绑定（componentKey 由 id 派生），
//    扩展才需用底层 ViewRegistry.registerView + ViewComponentRegistry.register
this._register(
  registerViewWithComponent(
    { id: 'workbench.view.myThing.main', name: 'My Thing',
      containerId: 'workbench.view.myThing', icon: 'lightbulb', order: 1 },
    MyThingView,
  ),
)
```

新建 `workbench/myThing/MyThingView.tsx`（`useService(IFooService)` 拿服务）。

## 套路 C：加一个跨进程 ProxyChannel 服务

**1. 通道名**：`shared/ipc/channelNames.ts` 的 `ServiceChannels` 加 `MyService: 'myService'`。

**2. 接口**：`shared/ipc/services.ts`（复杂服务下沉 platform）：
```ts
export interface IMyService {
  readonly _serviceBrand: undefined
  doIt(arg: string): Promise<number>
}
export const IMyService = createDecorator<IMyService>('myService')
```

**3. main 端实现**：`main/services/myService/myMainService.ts` 写 `class MyMainService implements IMyService`。单例：`main-services.ts` 加 `registerSingleton(IMyService, new SyncDescriptor(MyMainService, [], false))`，并把 `myService` 加进 `ApplicationServices` 与 `getOrCreateServices()` 表；`registerMainServices.ts`：
```ts
server.registerChannel(ServiceChannels.MyService, ProxyChannel.fromService(app.myService))
```
> per-window 服务由 `windowMainService.createWindow()` 构造，不走 root 容器。

**4. renderer 端绑定**：`renderer/main.tsx`：
```ts
services.set(IMyService, ProxyChannel.toService<IMyService>(ipcService.getChannel(ServiceChannels.MyService)))
```

## 套路 D：加一个 Contribution（生命周期挂钩）

```ts
export class MyContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IEditorService editorService: IEditorService) {
    super()
    this._register(autorun((r) => {
      const active = editorService.activeEditor.read(r)
    }))
  }
}
```

**注册**：`renderer/contributions/index.ts`：
```ts
ContributionsRegistry.registerContribution(
  'workbench.contrib.myThing', MyContribution, WorkbenchPhase.AfterRestore,
)
```

相位：`BlockStartup`（UI 渲染前：ContextKey 默认/ViewContainer/schema）→ `BlockRestore`（挂载前）→ `AfterRestore`（状态栏/watcher）→ `Eventually`（空闲）。

## 套路 E：加一个 StatusBar 条目

`addEntry` 返回 accessor，可 `update`/`dispose`：
```ts
const entry = statusBarService.addEntry({
  text: '$(search) 搜索中…', alignment: StatusBarAlignment.Right, priority: 100,
})
entry.update({ text: '完成' })
entry.dispose()
```

要点：**生命周期由你管**。React 组件 `useRef` 持 accessor、`useEffect` cleanup dispose；Contribution 成员字段、`_hide()` dispose。

## 右键菜单图标：新增菜单项一律写 `icon`

图标 id 经 `workbench/icons/icon-map.ts` 的 `resolveIcon` 查表——**表里没有 → 静默不渲染**；`<ContextMenu>`/`<ListMenu>` **必须传 `renderIcon={renderMenuIcon}`**（`menuIcon.tsx` 唯一共享实现）。⚠️ `registerAction2` 会把 `desc.icon` 撒到其声明的**每一个** menu 槽位——Menubar 命令加图标会整组开启图标列。

## 套路 F：加一个 E2E 冒烟场景

冒烟栈在 `apps/editor/e2e/`：Playwright + `_electron`，spec 经 `window.__E2E__` 探针调服务，不戳 DOM（`UNIVERSE_E2E=1` 开启，production 剥除）。

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

**2. 定位优先级**：ARIA role → `data-testid`（`part-<id>` / `activitybar-item-<id>` / `view-<id>` / `quick-input` / `statusbar-entry-<id>`）→ 命令 + ContextKey → CSS class。**禁止**断言 Monaco 内部 DOM（状态走 `getActiveEditorUri()`）。

**3. 探针 API 不够用**：先扩 `src/shared/e2e/contract.ts`，再实现 `src/renderer/e2e/probe.ts`；保持白名单原则。

**跑**：`pnpm e2e:smoke`（只跑 @p0）/ `pnpm e2e specs/<x>.spec.ts`。fixture 选型、tag 矩阵、踩坑见 `apps/editor/e2e/CLAUDE.md`。

## 套路 G：加一个性能打点 / 启动耗时检测

1. **加打点**：`shared/perf/marks.ts` 的 `PerfMarks` 加常量（`code/<proc>/<event>` 约定），打点处 `mark(PerfMarks.xxx)`（来自 `@universe-editor/platform`）。
2. **main 端 marks 走 IPC**：已由 `IPerformanceMarksService` + `ServiceChannels.Performance` 暴露，main 只 `mark()`。
3. **聚合/计算**：renderer `ITimerService`（`services/performance/TimerService.ts`）合并 marks，`getStartupMetrics()` 按 `MILESTONES` 算耗时；新里程碑加进 MILESTONES。
4. **展示**：Developer: Startup Performance 命令；状态栏警示由 `StartupPerformanceStatusContribution` 控制。

任何性能检测都从「往 `PerfMarks` 加常量 + 打点」起步；响应性监控/卡顿报告见 [cases-interaction-perf.md](cases-interaction-perf.md) 和 skill `analyze-interaction-performance`。

## 套路 H：加一个语言特性（DocumentSymbol / Definition / Reference / Outline）

语言特性走**薄门面 `ILanguageFeaturesService`**（`services/languageFeatures/`）：注册时一边存镜像表（供 Outline 枚举），一边转发 `monaco.languages.register*Provider`——一个 provider 即点亮 **Outline 视图** 与 **F12/Shift+F12 peek**。

1. 在 `services/languageFeatures/<lang>/` 写 provider（实现 `monaco.languages.DocumentSymbolProvider` 等）。
2. 在 `contributions/LanguageFeaturesContribution.ts` 的 `MonacoLoader.ensureInitialized().then(...)` 里 `this._register(langFeatures.registerXxxProvider('<lang>', new XxxProvider()))`。**必须等 Monaco 就绪**。

Outline 数据由 `IOutlineService` 产出，`OutlineView` 与 `Breadcrumbs` 共享；跳转走 `outlineService.revealSymbol`。

## 套路 I：加一个 AI provider（协议）

AI 服务三层：platform 契约（`IAiModelService` / `IAiModelProvider` / `AiModelRegistry` **按协议注册**）、main 实现（`AiModelMainService` 读 `aiSettings.json`）、renderer 门面（`AiModelClientService` → `AsyncIterable`）。**消费方只依赖 `IAiModelService`**。细节见 [cases-ai-provider-data-model.md](cases-ai-provider-data-model.md)；管理页 UI 改前先读 `renderer/workbench/ai/CLAUDE.md`。

**加一个新协议 provider = 一个文件 + 一行注册**：

1. 在 `main/services/ai/providers/` 写 `XxxProvider implements IAiModelProvider`（`platform/ai/aiModelProvider.ts`），三方法吃 `AiProviderRuntime`（`{ id, protocol, baseUrl?, apiKey? }`）：`listModels`（**仅 discover 时调用**）/ `sendRequest` / `provideTokenCount`。用 `AsyncIterableSource` + `DeferredPromise` 产流，`token.onCancellationRequested` 中止 fetch，HTTP 映射 `AiErrorCode`。
2. 在 `AiModelMainService._registerBuiltInProviders` 加一行 `this._register(this._registry.registerProvider('<protocol>', new XxxProvider()))`（**无构造参数**）。
3. （可选）`aiSettings.json` 的 schema 在 `renderer/contributions/AiConfigurationContribution.ts`。

**加价格/用量来源**：接口 `aiRemoteSources.ts`，实现放 `main/services/ai/remote/`，注册一行；硬约束：**热路径同步读缓存**、**远端失败静默降级**。

**红线**：
- **密钥绝不进日志、绝不进 AI Debug 记录**；明文存 `aiSettings.json` 的 `apiKey`（POSIX `chmod 0600`），UI 一律掩码。
- **费率单一来源，绝不兜底**（未声明 `pricingSource` 就是「费率未知」）；**会话开销与账号费用绝不互兜底**。
- **🔴 生效凭据是反查出来的，不是编辑器声明的**：agent 自己的配置文件是唯一真相（编辑器不持久化 `agentSettings.<agent>.authentication`）；判定走纯函数 `agentActiveAuth.ts`。


## 编辑器输入三件套

**`FileEditorInput`**（input 描述）/ **`MonacoModelRegistry`**（URI → Monaco `ITextModel`，多分屏共享）/ **`FileEditorRegistry`**（`FileEditorInput` → 挂载的 editor 实例）。打开：`editorService.openEditor(new FileEditorInput(uri))` → 挂载 → 注册进 `FileEditorRegistry`。

## 测试边界

`vitest.config.ts` 三个 project：**main**（node）、**renderer-node**（node，不依赖 DOM/Monaco 的 `*.test.ts`，**新增 renderer 测试默认进这里**）、**renderer-dom**（happy-dom，`*.test.tsx` + 依赖 DOM/Monaco 的 `*.test.ts`，`rendererDomTests` 登记；忘了加 fail loud）。

## 常见踩坑

- **ContextKey 有两个求值域，别搞混**：菜单 `when` 走 per-group scoped ctx，keybinding `when` 与 Action2 `precondition` 走 **root** ctx；`ScopedContextKeyService.set()` **只写本地不外溢**——只写 scoped 的 key 在键位解析恒为 `<unset>`，症状「标题栏能点、快捷键没反应、命令面板搜不到」。keybinding 需要的 key 必须在 root 也 seed（`isInDiffEditor` 双写范例）；这类分裂**只有 e2e 能守住**。排查见 skill [fix-keybinding-not-firing]。
- **URI 经 IPC 后**：`fm.resource` 是 `UriComponents` 而非 `URI` 实例，需 `URI.revive(fm.resource) as URI`。
- **扩展的 `window.show*Message(msg, ...items)` 走 `IConfirmOptions.buttons`**：每个 item 都是动作，取消是额外追加的那一个；回执读 `choiceIndex`。勿回退三槽按钮形态（第 4 项起静默丢弃）。

## 其它

- 对标 vscode 的功能保持默认按键和 command id 一致；用户可见文本走 `localize()`（改文案先读 [shared/i18n](src/shared/i18n/CLAUDE.md)）。
