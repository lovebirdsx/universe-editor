# API 概览

> 宿主为扩展提供的全部编程表面，按 namespace 逐个导览，每个给一个可直接粘贴的最小示例。本文以 **API 0.9.0** 为准（0.x 阶段 minor 版本可能携带破坏性变更，版本协商见 [API 版本与 `engines.universe`](../versioning.md)）。
>
> **本文的定位是导览，不是参考手册。** 逐方法、逐字段的权威说明在编辑器里的类型提示中——`@universe-editor/extension-api` 的 d.ts 带完整 JSDoc，它是唯一不会随版本漂移的真相。本文不逐方法抄写签名与注释（抄了必漂移），只告诉你「有什么、从哪进、最小怎么用」。

## 总览

| namespace | 一句话定位 |
|---|---|
| `commands` | 注册命令处理器、执行任意命令、列出已注册命令 |
| `window` | 消息提示、选择器、输入框、状态栏、输出通道、进度、文件对话框、活动编辑器、装饰、自定义编辑器 |
| `workspace` | 工作区文件夹、信任状态、受限文件系统、文件查找与监听、打开的文档、配置、timeline |
| `languages` | 21 类语言特性 provider、诊断集合、语言服务状态上报、语言清单 |
| `scm` | 源码管理集成（资源分组、提交输入框） |
| `ai` | 推理模型访问（**内置扩展专属**，外部扩展不可用） |
| `env` | 应用信息（名称/版本/语言/会话/深链 scheme）、剪贴板、打开外部目标 |
| `extensions` | 枚举与激活已安装的扩展 |

此外还有两组类型从包根直接导出、经上述 namespace 的方法注册：

- **timeline**：文件历史 provider，注册入口是 `workspace.registerTimelineProvider`。
- **webview**：自定义编辑器，注册入口是 `window.registerCustomEditorProvider`。

所有调用经宿主桥接走 RPC 到编辑器进程执行——扩展里拿到的是句柄，真实状态在宿主侧。生命周期约定贯穿全部 namespace：注册类方法一律返回 `Disposable`，惯例是 push 进 `activate` 收到的 `context.subscriptions`，扩展停用时宿主统一清理。

## commands — 命令

`registerCommand` 注册一个命令处理器（命令 id 通常同时在 `contributes.commands` 声明，见[贡献点参考](../contribution-points.md)）；`executeCommand` 执行任意命令——自己注册的、别的扩展贡献的、或宿主内置的——并 await 其返回值；`getCommands(filterInternal?)` 列出全部已注册命令的 id（`filterInternal` 为真时排除下划线前缀的内部命令）。

```ts
import { commands, window, type ExtensionContext } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    commands.registerCommand('my-ext.hello', async () => {
      await window.showInformationMessage('Hello from my-ext')
    }),
  )
  // 也可以调用别人的命令并拿到返回值
  const result = await commands.executeCommand<string>('some.other.command', 'arg1')
}
```

## window — UI 交互

与用户打交道的入口，全部经宿主渲染进程呈现：

- **消息提示**：`showInformationMessage` / `showWarningMessage` / `showErrorMessage`，可附带按钮项，resolve 用户点中的那一项（未点则为 `undefined`）。
- **`showQuickPick`**：两重重载——传 `string[]` 返回选中的字符串；传 `QuickPickItem[]`（带 `label` / `description` / `detail` / `iconId`）返回选中的那一项对象。
- **`showInputBox`**：单行文本输入。
- **`createStatusBarItem`**：状态栏条目，`text` 里写 `$(icon)` 前缀可渲染图标；设好属性后调 `show()` 生效。
- **`setStatusBarMessage`**：一次性状态栏消息，三重载——返回 `Disposable` 提前撤下、传毫秒数超时自动隐藏、传 Promise 待其 settle 后隐藏。每次调用相互独立共存，不是 VSCode 的消息栈。
- **`withProgress`**：带进度指示跑一个异步任务。`ProgressLocation` 三档（`Window` 状态栏静默转圈、`Notification` 通知条目带百分比条、`SourceControl` 当前按 `Window` 渲染）；`cancellable` 时 UI 提供取消控件并翻转 task 收到的 token；task 经 `progress.report({ message, increment })` 汇报。
- **`showOpenDialog` / `showSaveDialog`**：工作台的打开/保存对话框，返回 `Uri`（取消时 `undefined`）。当前实现为**单选**（`canSelectMany` 仅为兼容保留），`filters` 暂不过滤列出的条目。
- **`createOutputChannel`**：输出面板里的专属通道，写日志用。
- **`getActiveTextEditor` / `onDidChangeActiveTextEditor`**：当前聚焦的文本编辑器及其变化事件。拿到的是**快照**（`document` / `selections` 反映取到那一刻的状态），外部变更后应重新获取，不要长期持有；`edit` / `setSelections` / `setDecorations` 驱动的是实时编辑器。
- **`showTextDocument`**：把文档在文本编辑器里打开并返回其快照；`TextDocumentShowOptions` 支持 `preserveFocus`（不抢焦点）、`preview`（进预览槽）、`selection`（打开后选中并 reveal 该 range）。
- **`onDidChangeTextEditorSelection`**：活动编辑器选区变化事件（防抖：一波输入只投递最新选区一次；后台编辑器的变化不触发；程序化 `setSelections` 时 `kind` 为 `undefined`）。
- **`createTextEditorDecorationType`**：创建可复用的装饰样式（行背景、gutter 图标、概览标尺色条等），配合 `TextEditor.setDecorations` 给一组 range 上色。
- **`registerCustomEditorProvider`**：注册 webview 自定义编辑器，详见下文 [webview](#webview--自定义编辑器) 与 [自定义编辑器与 Webview](../webview-guide.md)。

```ts
import { window, StatusBarAlignment } from '@universe-editor/extension-api'

const color = await window.showQuickPick(['red', 'green'], { placeHolder: '选一个颜色' })
const branch = await window.showQuickPick(
  [{ label: 'main', description: '当前分支' }, { label: 'dev' }],
  { placeHolder: '切换分支' },
)
const name = await window.showInputBox({ prompt: '输入名字', value: '默认值' })

const item = window.createStatusBarItem(StatusBarAlignment.Right, 100)
item.text = '$(sync) 已连接'
item.show()

const output = window.createOutputChannel('My Extension')
output.appendLine('extension started')
```

## workspace — 工作区

当前打开的工作区文件夹及其中的状态：

- **`rootPath`**：工作区根的绝对路径，未打开文件夹时为 `undefined`；扩展宿主启动时固定（当前只支持单文件夹工作区）。
- **`workspaceFolders` / `name`**：以 `WorkspaceFolder` 列表形式看同一个工作区（单文件夹模型：未打开时 `undefined`，否则恰一项且 `index` 恒 0）；`name` 是文件夹 basename。
- **`asRelativePath(pathOrUri, includeWorkspaceFolder?)`**：工作区内的路径转成根相对形式（正斜杠、保留输入大小写）；工作区外的路径原样返回。包含性比较按 OS 大小写策略（Windows 不敏感）。
- **`isTrusted` / `onDidGrantWorkspaceTrust`**：Workspace Trust 状态。激活时固定；用户在未信任的工作区里授予信任时触发该事件（信任不会原地撤销——撤销时宿主直接重启，故无对应事件）。会执行工作区提供的代码的扩展，应用它做门控。
- **`fs`**：**受限文件系统**，8 个方法——`readFile` / `writeFile` / `stat` / `readDirectory` / `createDirectory` / `delete` / `rename` / `copy`（后两者在目标已存在且未设 `overwrite` 时 reject）。每次调用先过宿主的路径策略（拒绝敏感位置、禁止逃逸出工作区根）才落盘，这是外部扩展唯一能用的文件系统。
- **`findFiles(include, exclude?, maxResults?, token?)`**：按 glob 在工作区里找文件，返回 `Uri[]`（glob 匹配工作区相对路径；不含 `/` 的模式匹配任意深度的 basename）。当前仅支持 string 模式（无 RelativePattern）；`exclude` 省略时用配置的排除项、传 `null` 完全不排除。取消是 best-effort：跨 RPC 不中止在途搜索，token 触发后迟到的结果被丢弃、以空列表 resolve。
- **`createFileSystemWatcher(globPattern, ignoreCreate/Change/DeleteEvents?)`**：监听工作区文件变化，`onDidCreate` / `onDidChange` / `onDidDelete` 三个事件携带 `Uri`。仅观察**工作区文件夹内部**；glob 仅支持 string 模式。
- **`textDocuments`** 与 `onDidOpenTextDocument` / `onDidChangeTextDocument` / `onDidCloseTextDocument`：当前打开的文档（从渲染进程镜像）及其打开/增量变更/关闭事件。变更事件携带 LSP 语义的增量编辑（0-based）。
- **`openTextDocument(target)`**：按 `Uri` 或路径把文档读进编辑器文档模型（不显示；已打开的复用不重读磁盘）。返回的文档与编辑器共用实时镜像——跟踪后续编辑、到达时触发 `onDidOpenTextDocument`。
- **`applyEdit(edit)`**：跨文件应用 `WorkspaceEdit`（文本编辑落在实时模型上、可撤销；未打开的文件读出-打补丁-写回）。**当前仅支持文本编辑**——含文件级 create/rename/delete 的 edit 整体被拒绝（resolve `false`）。
- **`onWillSaveTextDocument`**：保存前触发；监听器调 `event.waitUntil(Promise<TextEdit[]>)` 贡献保存前要应用的编辑（宿主有超时兜底）——ESLint 的 fix-all-on-save 就靠它。
- **`onDidSaveTextDocument`**：写入磁盘后触发（当前仅文件编辑器的保存路径），镜像文档此时已持有保存后的文本。
- **`getConfiguration(section?)`**：读/写配置，`getConfiguration('git').get('autofetch', true)` 读的是 `git.autofetch`；异步（配置值在渲染进程）；`update` 写用户级配置。
- **`onDidChangeConfiguration`**：配置变更事件，`event.affectsConfiguration('git')` 做前缀匹配（`'git'` 命中 `git.autofetch` 的变更，反之亦然）。扩展宿主重启期间的变更会丢失——激活后重读。
- **`registerTimelineProvider`**：注册文件历史 provider，详见下文 [timeline](#timeline--文件历史)。

```ts
import { workspace } from '@universe-editor/extension-api'

const root = workspace.rootPath // 未打开文件夹时为 undefined
if (!workspace.isTrusted) {
  workspace.onDidGrantWorkspaceTrust(() => {
    // 用户授予信任后，再启用依赖工作区代码的能力
  })
}

const bytes = await workspace.fs.readFile(`${root}/data.json`)
const entries = await workspace.fs.readDirectory(`${root}/src`)

workspace.onDidChangeTextDocument((e) => {
  console.log('changed:', e.document.uri.path, e.contentChanges.length)
})

const autofetch = await workspace.getConfiguration('git').get('autofetch', true)
```

## languages — 语言特性

语言支持的注册中心：**21 个 `register*Provider` 方法**，各自对应一类语言特性——

定义（`registerDefinitionProvider`）、引用（`registerReferenceProvider`）、实现（`registerImplementationProvider`）、类型定义（`registerTypeDefinitionProvider`）、hover（`registerHoverProvider`）、补全（`registerCompletionItemProvider`）、签名帮助（`registerSignatureHelpProvider`）、文档符号（`registerDocumentSymbolProvider`）、重命名（`registerRenameProvider`）、工作区符号（`registerWorkspaceSymbolProvider`）、折叠（`registerFoldingRangeProvider`）、文档链接（`registerDocumentLinkProvider`）、高亮（`registerDocumentHighlightProvider`）、选区扩展（`registerSelectionRangeProvider`）、code action（`registerCodeActionsProvider`）、格式化（`registerDocumentFormattingEditProvider`）、范围格式化（`registerDocumentRangeFormattingEditProvider`，Format Selection）、键入即格式化（`registerOnTypeFormattingEditProvider`，需用户开启 `editor.formatOnType`）、inlay hints（`registerInlayHintsProvider`，一次性返回完整 hint，无惰性 resolve 阶段）、语义 token（`registerDocumentSemanticTokensProvider`）、代码透镜（`registerCodeLensProvider`）。

外加三个设施：

- **`createDiagnosticCollection(name?)`**：创建诊断集合，`set` 替换某个 URI 的诊断（传 `undefined` 清除）；集合名即 marker 归属者，多个 provider 标注同一文件互不覆盖。
- **`setLanguageServerStatus(id, status)`**：上报语言服务生命周期（`'starting' | 'ready' | 'error'`）。宿主据此在状态栏显示启动 spinner，并让「转到定义 / 查看引用」等导航命令在服务就绪前显示进度并等待，而不是静默卡住。
- **`getLanguages()`**：编辑器当前已知的全部语言 id（如 `'typescript'`）。

provider 的第一个参数是 `DocumentSelector`（语言 id 或 id 数组），返回值类型 `ProviderResult<T>`（同步/异步/可空均可）。provider 签名里的 `Position` / `Range` / `Hover` 等类型是 LSP 形状（见下文「基础类型与约定」）。完整的 provider 写法与 LSP 对接套路见[语言特性](../language-guide.md)。

```ts
import { languages, type ExtensionContext } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext) {
  const diagnostics = languages.createDiagnosticCollection('my-lint')
  context.subscriptions.push(
    languages.registerHoverProvider('markdown', {
      provideHover(document, position) {
        return { contents: { kind: 'markdown', value: '**来自 my-ext 的 hover**' } }
      },
    }),
    diagnostics,
  )
  languages.setLanguageServerStatus('my-lint', 'ready')
}
```

## scm — 源码管理

源码管理集成，对等 VSCode 的 SCM API。扩展调 `createSourceControl` 创建一个 `SourceControl`，往里填资源分组（`createResourceGroup` → `SourceControlResourceState` 列表），从 `inputBox.value` 读提交信息，用 `acceptInputCommand` 接提交动作。**视图归工作台所有**——扩展只提供数据，拿到的每个对象都是宿主侧句柄，状态经 RPC 镜像到编辑器内置的 SCM 视图（与 VSCode 的分工一致）。

```ts
import { scm, type ExtensionContext } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext) {
  const sourceControl = scm.createSourceControl('my-scm', 'My SCM')
  const changes = sourceControl.createResourceGroup('changes', 'Changes')
  changes.resourceStates = [{ resourceUri: '/repo/src/file.ts' }] // 绝对路径
  sourceControl.inputBox.placeholder = '提交说明'
  sourceControl.acceptInputCommand = { command: 'my-scm.commit', title: '提交' }
  context.subscriptions.push(sourceControl)
}
```

资源行的 `contextValue` 会以 `scmResourceState` 暴露给菜单 `when` 子句；分组支持嵌套（`parentId`）、提交按钮支持拆分多动作（`acceptInputActions`）——细节看 d.ts。

## ai — 推理模型（内置扩展专属）

推理模型访问：枚举可用模型（`getModels`）、按条件挑模型（`selectModels`）、算 token 数（`computeTokenLength`）、读用户当前选中的聊天/提交信息模型（`getActiveModelId` / `getCommitModelId`）、发请求并流式读响应（`sendRequest` 返回 `AiResponse`，迭代 `stream` 逐块收文本，可 `cancel()` 中止）。

> **红线：`ai` 是内置（trusted）扩展专属能力。外部（restricted）扩展调不到 AI 模型**——桥接上不会为该 namespace 提供实现，不要围绕它设计外部扩展。

```ts
import { ai, AiMessageRole } from '@universe-editor/extension-api'

const [modelId] = await ai.selectModels({ vendor: 'anthropic' })
if (modelId) {
  const response = ai.sendRequest(
    [{ role: AiMessageRole.User, content: '用一句话总结这个函数' }],
    { modelId, purpose: 'extension' },
  )
  for await (const chunk of response.stream) {
    if (chunk.type === 'text') console.log(chunk.value)
  }
  await response.result // 失败时在这里 reject
}
```

## env — 应用环境

扩展所在应用的信息与环境交互：`appName` / `appVersion` / `language`（如 `'zh-CN'`）/ `sessionId`（每次编辑器会话唯一，扩展宿主重启不变）/ `uriScheme`（OS 路由到本应用的深链 scheme）五个只读属性；`clipboard.readText` / `writeText` 读写纯文本剪贴板；`openExternal(target)` 打开目标——http(s) 走系统浏览器，file URI/路径在工作台内打开。

```ts
import { env, Uri } from '@universe-editor/extension-api'

await env.clipboard.writeText('copied')
const ok = await env.openExternal('https://example.com')
const ok2 = await env.openExternal(Uri.file('/path/to/notes.txt')) // 在工作台内打开
```

## extensions — 扩展集

枚举与激活已安装的扩展（内置与外部）：`extensions.all` 拿全部、`getExtension<T>('publisher.name')` 按 id 查。返回的 `Extension<T>` 句柄上 `isActive` / `exports` 是**实时视图**（每次读取反映当下状态），`activate()` 触发激活并解析其 `exports`——这是扩展间互相消费能力的入口。`onDidChange` 在当前版本不会 fire：本产品通过重启扩展宿主应用扩展的装/卸/启停，单个宿主生命周期内集合固定。

```ts
import { extensions } from '@universe-editor/extension-api'

const ts = extensions.getExtension<{ getVersion(): string }>('universe.typescript')
const api = await ts?.activate() // 未激活则先激活；已激活直接拿 exports
```

## timeline — 文件历史

文件历史 provider，喂给编辑器内置的 Timeline 视图（对等 VSCode 的 proposed `timeline` API）。扩展用 `workspace.registerTimelineProvider(scheme | scheme[], provider)` 为一个或多个 URI scheme 注册 provider；视图对活动文件**分页**拉取 `TimelineItem`（`TimelineOptions` 带 `cursor` / `limit`，返回的 `Timeline.cursor` 表示还有下一页），点击条目时执行条目的 `command`（通常是打开 diff）。条目的 `contextValue` 经 `timelineItem` context key 暴露给 `timeline/item/context` 菜单贡献点的 `when` 子句。数据变化时触发 `onDidChange`（`reset: true` 让视图丢弃全部缓存页重载）。视图归工作台所有，扩展只提供数据。

```ts
import { workspace, type ExtensionContext, type TimelineProvider } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext) {
  const provider: TimelineProvider = {
    id: 'my-history',
    label: 'My History',
    provideTimeline(uri, options) {
      return {
        items: [{
          label: 'v1',
          timestamp: Date.now(), // epoch 毫秒，跨 provider 按新到旧排序
          command: { command: 'my-ext.showVersion', title: '查看此版本', arguments: [uri] },
          contextValue: 'version',
        }],
      }
    },
  }
  context.subscriptions.push(workspace.registerTimelineProvider('file', provider))
}
```

## webview — 自定义编辑器

自定义编辑器表面（对等 VSCode 的 webview + `CustomReadonlyEditorProvider`）。扩展用 `window.registerCustomEditorProvider(viewType, provider, options?)` 注册；`viewType` 必须匹配 manifest 里 `contributes.customEditors[].viewType`，工作台才知道哪些文件路由过来。打开匹配文件时，宿主调 `openCustomDocument` 建文档模型、再调 `resolveCustomEditor(document, panel)` 让你填充面板：

- **`WebviewPanel`**：宿主创建并拥有的编辑器面板，`reveal()` 聚焦、`dispose()` 关闭、`onDidDispose` 通知销毁；以 diff 方式打开时带 `diffContext`（左右两份内容的原始字节，可能不存在于磁盘）。
- **`Webview`**：内容表面。`html` 赋值即重渲染；`options.enableScripts` 放行脚本；`options.localResourceRoots` 扩展本地资源白名单（扩展自身目录永远允许）；`cspSource` 是写 CSP meta 标签时要放行的 origin；`asWebviewUri` 把本地 `file:` 资源改写成沙箱 iframe 能加载的 URL；`postMessage` / `onDidReceiveMessage` 是与 webview 内脚本的双向消息通道。

iframe 及其生命周期归工作台所有，扩展只提供内容（与 VSCode 一致）。完整套路——本地图片、CSP、消息协议、diff 渲染——见[自定义编辑器与 Webview](../webview-guide.md)。

```ts
import { window, type ExtensionContext, type CustomReadonlyEditorProvider } from '@universe-editor/extension-api'

export function activate(context: ExtensionContext) {
  const provider: CustomReadonlyEditorProvider = {
    openCustomDocument: (uri) => ({ uri, dispose() {} }),
    resolveCustomEditor(document, panel) {
      panel.webview.options = { enableScripts: true }
      panel.webview.html = `<html><body><h1>${document.uri.path}</h1></body></html>`
    },
  }
  context.subscriptions.push(window.registerCustomEditorProvider('myExt.preview', provider))
}
```

## 基础类型与约定

跨 namespace 通用的类型与设计约定，一次说清：

- **`Disposable`**：0.9.0 起是 class——`new Disposable(() => { ... })` 包一个清理回调（dispose 幂等，回调只跑一次），`Disposable.from(...)` 把多个 disposable 合成一个。结构化兼容不变：任何带 `dispose(): void` 的对象字面量仍满足它。所有注册类方法的返回值都是它；惯例是 push 进 `context.subscriptions`，扩展停用时统一清理。
- **`Event<T>` / `EventEmitter<T>`**：可订阅信号——以监听器为参调用即订阅，返回 `Disposable`，dispose 即退订。要自建事件源就用 `EventEmitter`：`emitter.event` 对外暴露订阅口，`fire(data)` 投递（某个监听器抛错不影响其余），`dispose()` 后 `fire` 空转。
- **`CancellationToken` / `CancellationTokenSource`**：长耗时 provider 请求的协作式取消（如 `provideWorkspaceSymbols`、timeline 分页）。宿主取消过期查询时置位，provider 应把它透传给底层请求，别让过期查询白占语言服务。要自己制造 token（如配合 `findFiles` 的超时）就 `new CancellationTokenSource()`，`source.token` 外传、`source.cancel()` 置位。
- **`ExtensionContext`**：`activate` 的唯一参数。`subscriptions`（待清理数组）、`extensionPath`（扩展安装目录）、`globalStoragePath`（扩展私有的跨会话存储目录，首次写入时自建）、`globalState` / `workspaceState`（两个 `Memento` 键值存储，分别全局/按工作区持久）。
- **`Uri` 与 `UriComponents`**：0.9.0 起提供 `Uri` 类——经 `Uri.file` / `Uri.parse` / `Uri.from` / `Uri.joinPath` 构造，常用属性 `fsPath`（OS 原生路径）、`path`（规范形，Windows 盘符前带 `/`，如 `/C:/x/y`），`toString()` / `toJSON()` 序列化。新 surface（`findFiles`、`showOpenDialog`、`env.openExternal`、`workspaceFolders[].uri`、`createFileSystemWatcher` 事件）一律用它；既有 surface 里 `TextDocument.uri`、`CustomDocument.uri` 仍是平面对象 `UriComponents`（`{ scheme, authority?, path?, query?, fragment? }`，JSON 可序列化），字符串场景照旧给字符串（SCM 的 `resourceUri` 是绝对路径，`webview.asWebviewUri` 返回 URL 字符串）。
- **LSP 类型直接从包根 import**：provider 签名里的 `Position` / `Range` / `Location` / `Hover` / `CompletionItem` / `Diagnostic` / `TextEdit` / `WorkspaceEdit` / `SemanticTokens` / `InlayHint` 等全部 re-export 自 `vscode-languageserver-types`，`import type { Range } from '@universe-editor/extension-api'` 即可，不需要单独装 LSP 包；`FoldingRangeKind`、`InlayHintKind` 是值（常量集合），单独做值导出。坐标一律 LSP 风格：**0-based** 行与列。
- **enum 一律普通 enum，不是 const enum**：`StatusBarAlignment`、`TextDocumentSaveReason`、`FileType`、`AiMessageRole`、`OverviewRulerLane`、`ProgressLocation`、`TextEditorSelectionChangeKind`、`FoldingRangeKind`、`InlayHintKind` 都是普通 enum——放心当值用、当 key 遍历都行。这是 `COMPATIBILITY.md` 的硬规则：API 包在 esbuild bundle（`isolatedModules`）场景被消费，const enum 会触发 TS2748，宿主承诺永远不会把既有 enum 换成 const enum。
- **`ProviderResult<T>`**：`T | null | undefined | Promise<T | null | undefined>`——provider 可以同步返回、异步返回、或返回空表示「没有结果」。
- **`DocumentSelector`**：provider 的适用范围，`'typescript'` 或 `['typescript', 'javascript']` 这样的语言 id 字符串/数组。

## 相关阅读

- [扩展的结构](../extension-anatomy.md) — `activate` / `deactivate` 生命周期与 package.json 字段全集
- [贡献点参考](../contribution-points.md) — 命令/菜单/快捷键/设置的 manifest 声明，与本页的 API 一一对应
- [自定义编辑器与 Webview](../webview-guide.md) — webview 的完整开发套路
- [语言特性](../language-guide.md) — 21 类 provider 的写法与 LSP 对接
- [从 VSCode 移植](../migration-from-vscode.md) — 与 VSCode API 的逐项对照（含本表面刻意不提供的部分）
