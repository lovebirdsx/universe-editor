# VSCode 与 universe-editor：command / keybinding 同 monaco 的适配对比

> 调研基于 VSCode 源码（`D:\git_project\vscode`）与本项目 universe-editor（`D:\git_project\universe-editor`）。本项目关键桥接代码（`monacoActionsBridge.ts`、`useGlobalKeybindingHandler.ts`、`MonacoLoader.ts`、`MonacoOverrideServicesContribution.ts`）已逐一核实。

---

## 1. 背景与问题定义

理解这两套适配方式，必须先抓住一个决定性事实：

- **monaco 与 vscode 是同源的**——monaco editor 本身就是从 vscode 源码里裁剪、抽取出来的「编辑器子集」。它内部的命令系统、快捷键系统、依赖注入容器，和 vscode workbench 用的是同一套代码的不同打包形态。
- VSCode workbench 直接编译**全量 vscode 源码**，因此天然与 monaco 共享同一份 registry 与 service 容器，「适配」几乎是免费的——它根本不需要桥接，只需要在统一调度里多挂一个「编辑器是否聚焦」的判断。
- universe-editor 走的是另一条路：它通过 npm 安装 **`monaco-editor` 的 standalone 发行版**作为一个黑盒依赖。这个发行版自带一套**外部无法直接复用**的 `StandaloneCommandService` / `StandaloneKeybindingService`。项目自己另有一套基于 `@universe-editor/platform` 的命令/快捷键内核。于是问题变成：**两套独立的命令/快捷键系统如何协同**。

一句话概括：

| | 前提 | 适配范式 |
|---|---|---|
| **VSCode** | monaco 与 workbench **同源**，共享 registry/容器 | **统一调度**——一套服务接管全部 |
| **universe-editor** | monaco 是**异源**的 standalone 黑盒包 | **分治协调**——桥接 + 服务覆盖 + 焦点门控双路由 |

---

## 2. VSCode 侧：command 如何与 monaco 适配

### 2.1 单一全局 CommandsRegistry 是中枢

`src/vs/platform/commands/common/commands.ts` 里的 `CommandsRegistry` 是一个进程级单例注册表（`Map<commandId, LinkedList<ICommand>>`）。无论 standalone monaco、完整 workbench、还是扩展宿主，注册命令都落到**同一张表**。`StandaloneCommandService`（`src/vs/editor/standalone/browser/standaloneServices.ts`）与 workbench 的 `CommandService`（`src/vs/workbench/services/commands/common/commandService.ts`）只是 `ICommandService` 的不同实现，但查询的都是这同一个 `CommandsRegistry`。两者主要差异是 workbench 版会在执行前等待相关扩展激活（`onCommand:xxx`）。

### 2.2 editor action 的三层模型

```
monaco 内部 IEditorAction / InternalEditorAction      (editor/common/editorAction.ts)
   ↑ 封装
EditorCommand / EditorAction / EditorAction2          (editor/browser/editorExtensions.ts)
   ↑ 桥接到现代 action 体系
workbench Action2 + registerAction2                   (platform/actions/common/actions.ts)
```

### 2.3 「三元注册」：一次注册，三处生效

`EditorAction`/`EditorCommand` 的 `register()`（`editorExtensions.ts`）与 `registerAction2()`（`actions.ts`）都会把同一个命令**同时**注册到三个地方：

1. `CommandsRegistry` —— 让命令可被 `executeCommand` 调用；
2. `MenuRegistry` —— 让命令出现在菜单 / 命令面板；
3. `KeybindingsRegistry` —— 绑定默认快捷键。

这是 VSCode 的核心便利：命令、菜单、快捷键三件套来自单一声明。

### 2.4 命令如何路由到「当前聚焦的编辑器」

editor 命令不属于某个具体编辑器实例，它需要在运行时找到目标编辑器。枢纽是 `ICodeEditorService`（`editor/browser/services/codeEditorService.ts`，workbench 实现 `codeEditorService.ts`）：

```ts
// EditorCommand.runEditorCommand —— editorExtensions.ts
const editor = codeEditorService.getFocusedCodeEditor()    // 优先：有文本焦点的编辑器
            || codeEditorService.getActiveCodeEditor();     // 兜底：当前激活编辑器
if (!editor) return;
return editor.invokeWithinContext((editorAccessor) => {
  // 在「编辑器自己的服务上下文」里执行，precondition 用编辑器的 context key 评估
  if (!kbService.contextMatchesRules(precondition)) return;
  return runner(editorAccessor, editor, args);
});
```

`EditorAction2` 走的也是同样逻辑（先 `getFocusedCodeEditor() || getActiveCodeEditor()` 再 `invokeWithinContext`）。

### 2.5 命令面板触发链路

```
命令面板选中 → MenuItemAction.run() → ICommandService.executeCommand(id, ...args)
            → CommandsRegistry.getCommand(id).handler
            → EditorCommand.runEditorCommand → editor.invokeWithinContext → run()
```

---

## 3. VSCode 侧：keybinding 如何与 monaco 适配

### 3.1 两套 KeybindingService，workbench 模式只用其一

- `StandaloneKeybindingService`（`standaloneServices.ts`）：**仅用于脱离 workbench 的纯 monaco 嵌入场景**，直接在每个 editor 的 DOM 容器上挂 `KEY_DOWN`/`KEY_UP`。
- `WorkbenchKeybindingService`（`src/vs/workbench/services/keybinding/browser/keybindingService.ts`）：**完整 VSCode 用的就是它**，在 window 级监听键盘事件，支持用户 `keybindings.json`、扩展贡献的键、键盘布局映射等。

关键点：在完整 VSCode 里，**根本没有 StandaloneKeybindingService 在跑**。monaco 编辑器内的按键和编辑器外的按键，统统由同一个 `WorkbenchKeybindingService` 接管。这正是「同源 + 统一调度」的体现。

### 3.2 从 DOM 到命令执行的分发链路

```
DOM keydown
 → StandardKeyboardEvent
 → AbstractKeybindingService._dispatch / _doDispatch   (platform/keybinding/common/abstractKeybindingService.ts)
 → contextKeyService.getContext(target)                 // 抓当前焦点处的 context 快照
 → KeybindingResolver.resolve(context, currentChords, keypress)   (keybindingResolver.ts)
      ├─ 第1层：用首个 chord 查 _map 得候选
      ├─ 第2层：多键绑定按前缀匹配过滤
      └─ 第3层：用 when 子句 (context.evaluate) 过滤，后注册者优先
 → ResolutionResult:
      ├─ NoMatchingKb       无匹配
      ├─ MoreChordsNeeded   进入和弦模式，等下一键
      └─ KbFound            → commandService.executeCommand(commandId, args)
```

### 3.3 context key 联动：按键如何「只在编辑器聚焦时」生效

`CodeEditorWidget` 内的 `EditorContextKeysHandler`（`src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts`）订阅编辑器的 focus/blur 事件，实时 `set`：

- `editorTextFocus`（光标在文本里闪烁）
- `editorFocus`（编辑器或其 widget 持有焦点）
- `textInputFocus`

```ts
this._editorTextFocus.set(this._editor.hasTextFocus() && !this._editor.isSimpleWidget);
```

这些 context key 写入同一个 `IContextKeyService`。当按键分发时，`KeybindingResolver` 用最新 context 评估每条绑定的 `when` 子句（如 `editorTextFocus && !editorReadonly`），从而实现「同一个键，在编辑器内触发 editor 命令、在编辑器外触发别的命令或不触发」。**焦点路由完全靠 `when` 子句声明式表达，没有命令式的「分流监听器」。**

### 3.4 优先级与默认键声明

`KeybindingWeight`（`keybindingsRegistry.ts`）定义层级：`EditorCore=0` < `EditorContrib=100` < `WorkbenchContrib=200` < `BuiltinExtension=300` < `ExternalExtension=400`，用户 `keybindings.json` 最高。`registerEditorAction` 的 `kbOpts`（含 `primary`/`mac`/`when`/`weight`）声明默认键，注册时合并 `precondition` 进 `when` 后落入 `KeybindingsRegistry`。

---

## 4. universe-editor 侧：整体架构

四层分离，从内核到分发：

| 层 | 位置 | 职责 |
|---|---|---|
| ① 平台内核 | `packages/platform/src/`（command / keybinding / contextkey / DI） | 通用 `CommandsRegistry` / `KeybindingsRegistry` / `IContextKeyService` / `Action2` 基础设施 |
| ② 自研 actions/services | `apps/editor/src/renderer/actions/`、`services/keybindings/` | `registerAction2` 注册全局命令；`UserKeybindingsService` 管用户快捷键三层加载 |
| ③ monaco 集成层 | `workbench/editor/monaco/`、`contributions/MonacoOverrideServicesContribution.ts` | 延迟加载 monaco、覆盖服务、把 monaco 命令镜像进自研 registry |
| ④ 全局分发层 | `workbench/useGlobalKeybindingHandler.ts`、`Workbench.tsx` | 顶层 keydown 监听 + 焦点感知路由 + 和弦状态机 |

### 4.1 monaco 延迟加载与服务注入入口

`MonacoLoader.loadMonaco()`（`workbench/editor/monaco/MonacoLoader.ts`）动态 `import('monaco-editor')`，并在**首个 `editor.create()` 之前**调用：

```ts
StandaloneServices.initialize(_overrideServices)   // 注入自研服务，必须早于任何 get()
```

随后触发 `bridgeAllMonacoActions()` 把 monaco 命令镜像出来。

### 4.2 服务覆盖（替换 monaco 内部少数 service）

`MonacoOverrideServicesContribution`（BlockStartup 相位，UI 挂载前）把自研实现塞进 `_overrideServices`：

- `FileBulkEditService` 替换 monaco 的 `IBulkEditService` —— 让 F2 重命名能写入**未打开**的文件；
- `FileTextModelService` 替换 `ITextModelService` —— 让 references peek 能预览未打开文件。

这就是 universe-editor 对 monaco 内部容器的「最小侵入」：不魔改源码，只通过 `StandaloneServices.initialize` 的 override 口替换确有必要的几个服务。

---

## 5. universe-editor 侧：command 桥接

核实自 `apps/editor/src/renderer/workbench/editor/monaco/monacoActionsBridge.ts`。

### 5.1 把 monaco 命令镜像进自研 CommandsRegistry

`bridgeAllMonacoActions()` 动态 import monaco 的 `EditorExtensionsRegistry`，枚举 `getEditorActions()`（find / replace / formatDocument / rename …），对每个 action：

```ts
CommandsRegistry.registerCommand({
  id: action.id,
  metadata: { description: action.label, category: 'Editor' },
  handler: makeHandler(action.id),
})
```

`makeHandler` 的执行体是关键——它不直接调 monaco API，而是经编辑器组找到当前 monaco 实例后用 `trigger` 触发：

```ts
function makeHandler(commandId: string) {
  return (accessor: ServicesAccessor): void => {
    const groups = accessor.get(IEditorGroupsService)
    const activeInput = groups.activeGroup.activeEditor
    if (!(activeInput instanceof FileEditorInput)) return
    const editor = FileEditorRegistry.get(activeInput)   // input → 当前挂载的 monaco 实例
    if (!editor) return
    editor.trigger('', commandId, {})                    // 让 monaco 自己执行该命令
  }
}
```

> 对照 VSCode：VSCode 用 `ICodeEditorService.getFocusedCodeEditor()` 找编辑器并 `invokeWithinContext` 执行；universe-editor 用 `IEditorGroupsService` + `FileEditorRegistry` 找编辑器并 `editor.trigger()` 执行。两者解决的是同一个「命令→当前编辑器」的路由问题，但走的是各自的服务/注册表。

### 5.2 核心命令手工补全

undo / redo / selectAll 是 monaco 在 `EditorAction` registry **之外**注册的，枚举循环看不到。`CORE_COMMANDS` 把它们手工列出补进自研 `CommandsRegistry`（这样 Edit 菜单、快捷键编辑器里能看到它们）。

### 5.3 关键设计：默认键不进自研 KeybindingsRegistry

这是 universe-editor 适配的精髓。每个 monaco action 的默认快捷键**不**注册到自研 `KeybindingsRegistry`，而是被解码后存入一张 side-table `_defaults`：

```ts
const decoded = decodeMonacoKeybinding(primary)
if (decoded && !_defaults.has(action.id)) _defaults.set(action.id, decoded)
// 对外：getMonacoDefaultKeybinding(id) / getAllMonacoDefaultKeybindings()
```

`_defaults` 只用于两件事：① 快捷键编辑器展示默认键；② 供 `FileEditor` 判断「用户是否覆盖了某个 monaco 命令的键」。**默认键的实际处理留给 monaco 自身的 context-aware dispatch**——这样 find widget 内的 ESC、IntelliSense 弹窗的 ESC 等仍由 monaco 正确处理，不会被自研系统抢走。

---

## 6. universe-editor 侧：keybinding 焦点门控双路由

核实自 `apps/editor/src/renderer/workbench/useGlobalKeybindingHandler.ts`。

### 6.1 同一份解析逻辑，挂两个监听器，按 editorFocus 切换

```ts
// 编辑器未聚焦 → capture 阶段（外→内）：项目先解析，全局快捷键权威
const captureHandler = (e) => {
  if (contextKeyService.get('editorFocus') === true) return
  runResolution(e)
}
// 编辑器已聚焦 → bubble 阶段，且仅当 monaco 没消费这个键
const bubbleHandler = (e) => {
  if (contextKeyService.get('editorFocus') !== true) return
  if (e.defaultPrevented) return    // monaco 已 stopPropagation/preventDefault 的键不再处理
  runResolution(e)
}
document.addEventListener('keydown', captureHandler, true)   // capture
document.addEventListener('keydown', bubbleHandler, false)   // bubble
```

含义：

- **焦点不在编辑器**（在侧栏/面板等）：项目在 **capture 阶段**抢先解析，确保全局快捷键不被内层 `stopPropagation` 吞掉。
- **焦点在编辑器**：让 monaco 先处理（它在 bubble 阶段消费并标记 `defaultPrevented`），只有 monaco 没处理的键才冒泡到项目的 `bubbleHandler`。即**编辑器内 monaco 优先**。

> 对照 VSCode：VSCode 不需要这种「双监听器 + 阶段切换」。它用单一 resolver，焦点差异完全由 `when` 子句里的 `editorTextFocus`/`editorFocus` 声明式处理。universe-editor 因为 monaco 是异源黑盒（它有自己的 dispatch，会自行消费键），只能用**命令式的 capture/bubble 阶段 + defaultPrevented 判断**来协调两套调度器的先后顺序。

### 6.2 和弦状态机

`runResolution` 通过 `KeybindingsRegistry.resolveKeystroke(key, contextKeyService, pending)` 解析。结果为 `enter-chord` 时调 `enterChord` 进入和弦模式——状态栏提示「(ctrl+k) was pressed. Waiting for second key…」，1500ms 超时（`CHORD_TIMEOUT_MS`）自动取消。和弦第二键会被**无条件 claim**（`preventDefault + stopPropagation`），防止 monaco 也对完成/中止和弦的那一键作出反应。

### 6.3 多重守卫

- **Quick Input 打开**（`quickInputVisible === true`）：只放行 Escape 及 Quick Input 自己拥有的导航/编辑键（`isQuickInputNativeEditingKey` / `isQuickInputOwnedKey`），其余忽略。
- **模态对话框**（祖先含 `data-renderer-dialog`）：完全不拦截，让对话框自管键盘（保证 Escape 能关闭它）。
- **可编辑目标的可打印字符**：`e.key.length === 1 && 无功能修饰键 && isEditableTarget` 时保留给文本输入，即便有人把该键绑成全局快捷键也不抢。

### 6.4 用户覆盖时拦截 monaco 原始默认键

当用户在 `keybindings.json` 覆盖了某个 monaco 命令的键，`FileEditor` 的 capture-phase bridge 会比对 `getAllMonacoDefaultKeybindings()`：若按下的键命中某 monaco 命令的默认键、且该命令已被用户覆盖，则 `preventDefault + stopPropagation` 拦掉，避免「旧默认键 + 新绑定键」双触发。

### 6.5 已知权衡

编辑器聚焦时，项目自己的 `Ctrl+K` 开头和弦会让位给 monaco（若 monaco 消费了 `Ctrl+K`）；在编辑器外这些和弦仍正常工作。这是「编辑器内 monaco 优先」策略的已知代价。

---

## 7. 异同对比表

| 维度 | VSCode | universe-editor |
|---|---|---|
| **monaco 来源** | 源码同源，workbench 编译全量 vscode | npm `monaco-editor` standalone 发行版（黑盒依赖） |
| **registry 是否共享** | 共享**单一** `CommandsRegistry`/`KeybindingsRegistry`/`ContextKeyService` | **各自独立**；通过 `monacoActionsBridge` 把 monaco 命令**镜像**进自研 `CommandsRegistry` |
| **谁接管编辑器内按键** | 统一 `WorkbenchKeybindingService`（standalone 服务不参与） | **monaco 自身 dispatch** 留管默认键；自研系统只管全局键/用户覆盖键 |
| **命令→编辑器路由** | `ICodeEditorService.getFocusedCodeEditor() \|\| getActiveCodeEditor()` + `editor.invokeWithinContext()` | `IEditorGroupsService.activeGroup` + `FileEditorRegistry.get()` + `editor.trigger()` |
| **编辑器内/外按键调度** | 单一 `KeybindingResolver`，焦点差异靠 `when` 子句声明式表达 | **焦点门控双监听器**：未聚焦走 capture（项目优先）、聚焦走 bubble + `defaultPrevented`（monaco 优先） |
| **默认快捷键归属** | 统一进 `KeybindingsRegistry`，按 `KeybindingWeight` 排优先级 | 默认键**不**入自研 registry，存 side-table `_defaults`，交给 monaco 自身处理 |
| **和弦** | resolver 内 `MoreChordsNeeded` + `_currentChords` | 自研状态机 `enterChord`（1500ms 超时 + 状态栏提示），第二键无条件 claim |
| **context key（焦点）** | `EditorContextKeysHandler` set `editorTextFocus`/`editorFocus`/`textInputFocus` | 同名 context key 由 `FileEditor` 的 focus/blur 同步，用于门控双路由与 `when` |
| **用户覆盖键** | `WorkbenchKeybindingService` 的 `UserKeybindings` 读 `keybindings.json`，weight 最高 | `UserKeybindingsService` 三层加载（默认快照 → `~/.vscode/keybindings.json` → userData `keybindings.json`）；覆盖时由 FileEditor 拦截 monaco 原始默认键 |
| **扩展贡献键** | `KeybindingsRegistry.setExtensionKeybindings`，weight 300-400 | —（当前命令/键以内置 `Action2` 为主） |
| **服务注入方式** | 同进程直接 DI，monaco 与 workbench 共用容器 | `StandaloneServices.initialize(overrideServices)` 仅覆盖少数服务（`IBulkEditService`/`ITextModelService`） |

---

## 8. universe-editor 方案的取舍评价

### 优点

- **命令与快捷键高度解耦**：换一份 `keybindings.json` 即可重绑全部快捷键；连 monaco 内置命令（经桥接进 registry）也可被 rebind。
- **命名空间清晰分离**：`editor.action.*`（monaco 桥接）与 `workbench.action.*`（自研）互不污染。
- **新增命令零样板**：继承 `Action2` + `registerAction2`，自动接入命令面板、菜单、快捷键三件套（与 VSCode 体验一致）。
- **升级 monaco 成本低**：不魔改 monaco 内核，只通过 override 口替换确需的少数服务；monaco 版本升级（如 0.55）时适配面小。

### 局限

- **编辑器聚焦时自研和弦让位 monaco**（`Ctrl+K` 系和弦在编辑器内可能不可用）。
- **monaco 内嵌 widget 的快捷键不可 rebind**：find widget / IntelliSense / snippet 输入等内部键由 monaco 自管，不在自研 `KeybindingsRegistry` 暴露。
- **复杂度上移到分发层**：capture/bubble 双监听 + `defaultPrevented` 判断 + 多重守卫，比 VSCode 的「单 resolver + 声明式 when」心智成本更高。
- **「分治」心智模型**：默认键归 monaco、全局键归自研，两套调度并存——排查快捷键问题时需先判断「这个键归谁管」（项目内置了 `keyboardDebugService` 来缓解这一点）。

---

## 9. 关键文件索引

### VSCode（`D:\git_project\vscode`）

| 功能 | 文件 | 关键类/函数 |
|---|---|---|
| 全局命令注册表 | `src/vs/platform/commands/common/commands.ts` | `CommandsRegistry` |
| standalone 命令/快捷键服务 | `src/vs/editor/standalone/browser/standaloneServices.ts` | `StandaloneCommandService` / `StandaloneKeybindingService` |
| editor action 体系 | `src/vs/editor/browser/editorExtensions.ts` | `EditorCommand` / `EditorAction` / `EditorAction2` / `EditorContributionRegistry` |
| 现代 action 体系 | `src/vs/platform/actions/common/actions.ts` | `Action2` / `registerAction2` / `MenuRegistry` / `MenuItemAction` |
| workbench 命令服务 | `src/vs/workbench/services/commands/common/commandService.ts` | `CommandService` |
| 编辑器路由服务 | `src/vs/workbench/services/editor/browser/codeEditorService.ts` | `CodeEditorService.getFocusedCodeEditor()` |
| workbench 快捷键服务 | `src/vs/workbench/services/keybinding/browser/keybindingService.ts` | `WorkbenchKeybindingService` |
| 快捷键分发基类 | `src/vs/platform/keybinding/common/abstractKeybindingService.ts` | `_dispatch` / `_doDispatch` |
| 快捷键解析引擎 | `src/vs/platform/keybinding/common/keybindingResolver.ts` | `KeybindingResolver.resolve` |
| 快捷键注册表/权重 | `src/vs/platform/keybinding/common/keybindingsRegistry.ts` | `KeybindingsRegistry` / `KeybindingWeight` |
| 编辑器 context key | `src/vs/editor/browser/widget/codeEditor/codeEditorWidget.ts` | `EditorContextKeysHandler._updateFromFocus` |

### universe-editor（`D:\git_project\universe-editor`）

| 功能 | 文件 | 关键类/函数 |
|---|---|---|
| 平台命令/快捷键内核 | `packages/platform/src/command/` | `CommandsRegistry` / `KeybindingsRegistry` / `Action2` / `registerAction2` |
| monaco 延迟加载 + 服务注入 | `apps/editor/src/renderer/workbench/editor/monaco/MonacoLoader.ts` | `loadMonaco` / `StandaloneServices.initialize` / `setBulkEditService` |
| monaco 命令桥接 | `apps/editor/src/renderer/workbench/editor/monaco/monacoActionsBridge.ts` | `bridgeAllMonacoActions` / `makeHandler` / `_defaults` / `CORE_COMMANDS` |
| 全局快捷键分发 | `apps/editor/src/renderer/workbench/useGlobalKeybindingHandler.ts` | `useGlobalKeybindingHandler` / `runResolution` / `captureHandler` / `bubbleHandler` |
| monaco 服务覆盖 | `apps/editor/src/renderer/contributions/MonacoOverrideServicesContribution.ts` | `FileBulkEditService` / `FileTextModelService` 注入 |
| 用户快捷键三层加载 | `apps/editor/src/renderer/services/keybindings/UserKeybindingsService.ts` | `reload` / `getUserEntry` |
| editor input 三件套 | `apps/editor/src/renderer/services/editor/` | `FileEditorInput` / `FileEditorRegistry` / `MonacoModelRegistry` |
| 命令注册入口 | `apps/editor/src/renderer/actions/index.ts` | `registerAction2(...)` 批量注册 |

---

*报告完*
