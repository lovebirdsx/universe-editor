# packages/platform/CLAUDE.md

仿 VSCode 内核：`apps/editor` 通过本包拿到 DI / Lifecycle / Command / Configuration / Event / IPC / Workbench services。**纯 Node 测试，与 React/Electron/DOM 解耦**。

## 强约束：index.ts re-export

**所有对外类型/服务/常量必须在 `src/index.ts` re-export，否则 apps 编译报错**。新增模块文件后立刻去 `src/index.ts` 加 `export * from './xxx/yyy.js'`。

`packages/platform` 是其他子包的依赖，apps 看到的是 `dist/`。改完后 `pnpm dev` 下 watcher 自动重建；离开 dev 模式手动 `pnpm --filter @universe-editor/platform build`。

## 目录索引

```
src/
  base/         事件、生命周期、URI、grid、observable、async
  di/           InstantiationService + ServiceCollection + createDecorator
  command/      CommandsRegistry / MenuRegistry / KeybindingsRegistry / Action2 / ContextKey
  contribution/ ContributionsRegistry + WorkbenchPhase
  lifecycle/    LifecycleService + LifecyclePhase
  configuration/ ConfigurationRegistry + ConfigurationService（settings schema）
                 sources/ 多来源解析：cli / env / file 可插拔来源 + ConfigResolver（优先级取值）+ cliHelp（--help/--version 文本生成）
  ipc/          ChannelServer / ChannelClient / ProxyChannel
  host/         IHostService（窗口操作、打开外部链接等）
  storage/      IStorageService（key-value 持久化）
  files/        IFileService + IFileWatcherService
  dialog/       IDialogService（confirm / prompt / message）
  workspace/    IWorkspaceService（打开文件夹、recent 列表）
  workbench/    Layout / Part / View(s)Registry / Editor / EditorGroups / StatusBar / QuickInput / Output / Search 接口
  log/          ILogger
```

## 三件套套路

### DI：定义并注入服务

```ts
// 1. 定义接口和 decorator
export interface IFooService {
  readonly _serviceBrand: undefined    // 必备品牌字段（编译期类型识别）
  doIt(): void
}
export const IFooService = createDecorator<IFooService>('fooService')

// 2. 实现类——构造函数用 @IDep 参数装饰器声明依赖
export class FooService implements IFooService {
  declare readonly _serviceBrand: undefined
  constructor(@IBarService private readonly _bar: IBarService) {}
  doIt(): void { this._bar.doSomething() }
}

// 3. 调用方：instantiation.createInstance(FooService) 自动注入
//    或：services.set(IFooService, new FooService(barInstance))
```

参考：`src/di/instantiation.ts`、`apps/editor/src/renderer/services/explorer/ExplorerTreeService.ts`

### Action2：命令 + 菜单 + 快捷键三合一

```ts
export class MyAction extends Action2 {
  static readonly ID = 'workbench.action.myThing'
  constructor() {
    super({
      id: MyAction.ID,
      title: '做我的事',
      category: 'View',
      keybinding: { primary: 'ctrl+shift+m' },         // 或 ['ctrl+k', 'ctrl+s'] 二段和弦
      menu: { id: MenuId.MenubarViewMenu, group: '2_layout', order: 1 },
      precondition: 'hasActiveEditor',
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(ILayoutService).toggleVisible(PartId.SideBar)
  }
}
registerAction2(MyAction)   // 一次性挂到 CommandsRegistry / MenuRegistry / KeybindingsRegistry
```

参考：`src/command/action.ts`

### Event：Emitter 模式

```ts
class Foo {
  private readonly _onDidChange = new Emitter<string>()
  readonly onDidChange = this._onDidChange.event    // 公开 .event，私有 emitter
  doIt(): void { this._onDidChange.fire('hello') }
  dispose(): void { this._onDidChange.dispose() }
}
```

- `PauseableEmitter<T>`：可暂停的 emitter，pause 期间事件入队，resume 后批量回放（用于批处理变更）
- `Relay<T>`：转接器，可在运行时切换上游 event 源

参考：`src/base/event.ts`

## Lifecycle 相位

`LifecyclePhase`（应用级）与 `WorkbenchPhase`（贡献级，值相同）：

| Phase | 触发点 | 适用 contribution |
|---|---|---|
| `Starting` / `BlockStartup` | DI 容器构造完毕 | ContextKey 默认、ViewContainer/View 注册、配置 schema |
| `Ready` / `BlockRestore` | UI 即将挂载 | 恢复编辑器组等会影响首屏的逻辑 |
| `Restored` / `AfterRestore` | UI 已挂载 | 状态栏条目、外部 watcher、recent 菜单 |
| `Eventually` | 空闲期 | 统计、预热 |

`lifecycle.when(phase)` 返回 Promise；`lifecycle.setPhase(phase)` 单调推进。

参考：`src/lifecycle/lifecycleService.ts`、`src/contribution/contribution.ts`

## IPC

- **ChannelServer / ChannelClient**：协议无关传输层；apps/editor 在 main 用 `electronProtocol` 适配
- **`ProxyChannel.fromService(impl)`**：把 service 实例转成 channel 处理器（main 端）
- **`ProxyChannel.toService<I>(channel)`**：把 channel 反向生成 service 代理（renderer 端）
- **事件穿透**：service 上的 `Emitter.event` 属性会被自动桥接为远端可订阅事件

参考：`src/ipc/proxyChannel.ts`、`apps/editor/src/main/ipc/registerMainServices.ts`

## 测试

```bash
pnpm --filter @universe-editor/platform test
```

环境：纯 node。测试文件在 `src/__tests__/`，与源码目录结构对应。不要 import React / Electron / DOM API。

## 添加新模块的最小步骤

1. 在 `src/<group>/` 新建文件（例：`src/workbench/myService.ts`）
2. 写接口 + decorator + 实现
3. **在 `src/index.ts` 末尾加 `export * from './<group>/myService.js'`**
4. 在 `src/__tests__/<group>/myService.test.ts` 写单测
5. `pnpm --filter @universe-editor/platform check` 通过
