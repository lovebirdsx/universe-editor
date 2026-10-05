# packages/platform/CLAUDE.md

仿 VSCode 内核：`apps/editor` 通过本包拿到 DI / Lifecycle / Command / Configuration / Event / IPC / Workbench services。**纯 Node 测试，与 React/Electron/DOM 解耦**。

## 强约束：barrel re-export

**所有对外类型/服务/常量必须能从 `src/index.ts` 链路可达，否则 apps 编译报错**。约定为**分组 barrel**：

- 每个子目录有自己的 `index.ts`（`base/index.ts`、`command/index.ts`…）。新增模块文件后，只需在**所在组**的 `index.ts` 加一行 `export * from './yyy.js'`。
- 根 `src/index.ts` 只 re-export 各组 barrel，**不要**在根里逐文件加导出。
- 有意不对外的内部文件（如 `command/contextKeyParser.ts`）不进 barrel；`base/observable/` 用自带的 `observable/index.ts` 公共面，其内部文件不单独导出。
- `src/__tests__/index.test.ts` 的 `barrel coverage` 用例兜底：扫描出"导出了符号但未被任何 barrel 收纳"的文件即报错（新增此类内部文件需加进该用例的 `INTERNAL` 白名单）。

`packages/platform` 是其他子包的依赖，apps 看到的是 `dist/`。改完后 `pnpm dev` 下 watcher 自动重建；离开 dev 模式手动 `pnpm --filter @universe-editor/platform build`。

**唯一的 workspace 依赖是 `@universe-editor/primitives`**（零依赖叶子包，与扩展 SDK 共享 URI 编解码与路径助手）：`base/uri.ts` / `base/path.ts` 现在是「re-export + 本地扩展」——URI/路径的**机制**（编解码、归一化）在叶子里，「策略」（`$mid`、`getResourceComparisonKey`、`fsPath` 不判平台）留在本包。`eslint.config.js` 的零依赖块对 primitives 单独放行；别把它当成可以再引别的 `@universe-editor/*` 的口子。

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
  ai/           IAiModelService / IAiModelProvider / AiModelRegistry（模型层机制见 docs/development/ai-model-layer.md）
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

**`createInstance` 类型重载的红线**：重载只在「尾随参数全是 `BrandedService`」时能剥离（`GetLeadingNonServiceArgs`）。尾随出现**带默认值的普通参数**使递归失败 → `createInstance(Class)` 匹配不上任何重载（tsc 与 tsgo 一致），测试只能直接 `new`，生产靠 `descriptor.ctor` 运行时拼参、尾随位收 `undefined` 被默认值吃掉。**该位置之后不得再追加任何 `@I...` 注入参数**——参数整体错位且无报错。现场见 `apps/editor/src/renderer/contributions/WorkspaceFileListingContribution.ts:52-57`。

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

### Command / Keybinding / ContextKey 语义（三条静默陷阱）

- **`Action2` 的 accessor 寿命**：`run(accessor)` 拿到的 `ServicesAccessor` **只在同步执行期有效**，命中第一个 `await` 即失效（之后 `accessor.get()` 抛 `service accessor is only valid during the invocation of its target method`，守卫在 `src/di/instantiationService.ts` 的 `Object.get`）。async 的 run 必须在任何 await **之前**同步取完 service 并打包成快照。
- **键位解析只看 weight**：`src/command/keybindingRegistry.ts` 升序插入 + 逆序 resolve ⇒ **weight 高者优先，同 weight 后注册者优先**；`when` 仅过滤、**不提权**。所以带 `when` 的 scoped 绑定**不会**像 VSCode 那样自动压过全局同键——必须显式 `weight: KeybindingWeight.WorkbenchContrib + 50`（缺省 weight 即 `WorkbenchContrib`=200；`MonacoDefault`=50、`User`=1000）。诊断读 `traceKeystroke` 的 candidates（`selected` / `outcomeReason`）。
- **`ScopedContextKeyService.dispose()` 是静默清空**：`src/command/contextKey.ts` 的 dispose 只 `_keys.clear()` + `super.dispose()`——不抛错、不置 disposed 标志；dispose 后 `get()` 静默透传父级，查不到的 key 全判 `undefined`（菜单 `when` 全线判 false，无异常无日志）。React 侧持有它的 wrapper 必须走 recreate-if-disposed 守卫，别用裸 `useMemo`。

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
- **尾部可选参数约定**：`toService` 序列化前剥掉参数数组尾部的 `undefined`（否则 JSON 把它变 `null`，远端 `=== undefined` 判定失效）；显式 `null` 原样穿越。夹在实参中间的 `undefined` 仍按 JSON 数组语义变 `null`——中段可选参数须声明 `| null` 并用 `== null` 判定。
- **wire 上的 URI 自动 revive**：`src/ipc/ipc.ts:197-232` 的 reviver 解 `$u8`（base64 tag → `Uint8Array`），并解 `$mid:1` + `scheme` 为字符串的对象 → `URI.revive`。所以**跨 IPC 返回 `URI` 实例的方法（`IFileService.realpath` 是其一）到消费端已是真 `URI`**，不需要也不应依赖手动 `URI.revive`（幂等，旧调用无害）；写自定义 channel / 字节载荷时改走同一 envelope，别自造序列化。

参考：`src/ipc/proxyChannel.ts`、`apps/editor/src/main/ipc/registerMainServices.ts`

## glob 引擎：两套语义共用一套 fragment 编译器

`packages/platform/src/glob/glob.ts` 一个文件两个入口，语义**刻意不同**：

- `compileGlobMatcher`（**扩展面**，ripgrep `-g` 风格）：先经 `normalizeExtensionGlobPattern` 归一——反斜杠转斜杠、去首尾斜杠，**slashless 模式补双星号+斜杠前缀 → 匹配任意深度的 basename**。驱动 `workspace.findFiles` 与 `createFileSystemWatcher`（经 `packages/extensions-common` re-export）。
- `makeGlobMatcher`（**settings / 关联字面编译**）：模式**原样**编译，无斜杠的模式只匹配根层。`editorAssociations`、JSON schema `fileMatch`、以及（经 `makeExcludeMatcher`）`files.exclude` / `search.exclude` / `watcherExclude` 走它。

**收敛前先逐条列语义差异**：差异由 `normalizeExtensionGlobPattern` 在**入口层**显式表达，不藏进编译器——硬统一 slashless-basename 一处就会**静默改变 `files.exclude` / `search.exclude` 的用户可见行为**。两侧匹配串都按「反斜杠→斜杠 + 去首部斜杠」归一；匹配全平台大小写敏感，watcher 兴趣键的大小写折叠在路径比较层而非此处。

**写 glob 文档的红线**：JSDoc / 块注释里禁止字面写「双星号紧接斜杠」（double-star-slash）——会提前闭合块注释，tsgo 报 TS1161/TS1109；一律改写「double-star-slash / 斜杠后缀形态」（`glob.ts` 头注释即此写法）。

## 路径 / URI 身份比较（单一入口）

**路径/URI 身份比较走 `IUriIdentityService`**（`src/uriIdentity/`，已 re-export；方法面见接口，常用的有 `isEqual` / `isEqualOrParent` / `getComparisonKey` / `getPathComparisonKey` / `arePathsEqual` / `relativePathUnder` / `createResourceMap`）。消费端经 DI 取，**不手写比较、不手动传 platform**；新增比较逻辑前先查它有没有现成方法。

- **无 DI 的场景**（main、纯函数模块）用 `base/path.ts` 的纯函数（实现在零依赖叶子 `@universe-editor/primitives`）+ `normalizePlatform(process.platform)`——**签名必带 platform**（`isEqualResource` 即此形态）。
- **防回潮靠 ESLint**：`no-restricted-syntax` 禁手写 fsPath 小写化 / 反斜杠折叠的路径身份键，`no-restricted-imports` 禁已删的 `canonicalResourceKey`（见 `packages/config-eslint/CLAUDE.md`）。
- **刻意保留的独立身份域（勿「顺手统一」）**：`MonacoModelRegistry.monacoModelKey`、SCM 域 `scmPathKey`/`pathKey`、`acpPathPolicy.ts`（安全边界自持 platform）、`markdownPasteLinks` 等 DI-free 可单测文件、两个 vendor submodule。

**两处形态陷阱**——工作区根盘符大小写（Ctrl+P 重复行）与手写 `UriComponents` 的前导斜杠（少/多一个都坏，且只在单一 OS 暴露、易误判成 flake），外加 `FileQuickAccessProvider.scanPool` 这个刻意不走 comparison key 的热路径例外——见 [cases-path-identity.md](cases-path-identity.md)。

## Configuration 注册表的顺序语义

`ConfigurationRegistry.registerConfiguration` 是**尾部 push**、其 dispose 是 **splice**（`src/configuration/configurationRegistry.ts`）。所以「dispose + 重新 register」会把该节点挪到 `_nodes` 末尾——`ThemesContribution._updateColorThemeSchema` 在主题初始化期间连续 fire（~6 次）就是这个模式。**任何按注册顺序/下标消费注册表的代码（设置编辑器的分组顺序、按 `itemIndex` 的 TOC 导航）必须按 id/key 从最新注册表重解析，不能跨 tick 缓存下标**。

**`ConfigurationService.update` 的 fire 语义**（`src/configuration/configurationService.ts:195-232`）：fire 判断是 `oldValue !== value`——`oldValue` 是**写前 effective 值**、`value` 是写入值，不是「写前 vs 写后 effective」；且 `update(key, undefined, target)` 即使 effective 值不变也**照样 fire**（持久化同步 diff 层快照，必须观察到删除）。推论：被工作区覆盖遮罩期间 `update(User)` 仍会 fire，订阅方读到的是遮罩中的旧值——「toggle 写全局 + 清工作区覆盖」因此**必须先删 Project 再写 User**（先写 User 会在遮罩期 fire 一次假翻转，应用侧先例与单测见 `apps/editor/src/renderer/services/ai/CLAUDE.md` 坑 8）。

## EditorInput.updateFrom 契约（tab 复用时的内容刷新）

凡「**内容随时间变、id 稳定复用同一 tab**」的 `EditorInput` 都应实现可选钩子 `updateFrom?(other)`（基类定义在 `src/workbench/editorService.ts:129`）：去重命中已打开 tab 时，必须先 `existing.updateFrom?.(editor)` 再 dispose 新 input（`src/workbench/editorGroupModel.ts:219`）——不实现则携带新内容的 input 被丢弃、旧实例一直持旧快照（应用侧同理：`apps/editor/src/renderer/services/editor/EditorService.ts:145` 命中同 id 时先 `updateFrom` 再 dispose；`apps/editor/src/renderer/services/editor/DiffEditorInput.ts:308` 的 `updateFrom` 调自己的 `update()`）。回归 `src/__tests__/workbench/editorGroupModel.test.ts`（「lets the existing input absorb newer state via updateFrom before disposing the orphan」）。

## 测试

```bash
pnpm --filter @universe-editor/platform test
```

环境：纯 node。测试文件在 `src/__tests__/`，与源码目录结构对应。不要 import React / Electron / DOM API。

## 添加新模块的最小步骤

1. 在 `src/<group>/` 新建文件（例：`src/workbench/myService.ts`）
2. 写接口 + decorator + 实现
3. **在所在组的 `src/<group>/index.ts` 加 `export * from './myService.js'`**（不要动根 `src/index.ts`）
4. 在 `src/__tests__/<group>/myService.test.ts` 写单测
5. `pnpm --filter @universe-editor/platform check` 通过
