# 从 VSCode 移植

> 已有一个 VSCode 扩展，想让它跑在 Universe Editor 上：哪些只要机械替换、哪些要换写法、哪些能力根本没有。以 **API 0.13.0** 为准。

## 决策背景：不 shim，但对齐

Universe Editor **不提供 `vscode` 模块的兼容层（shim），也不承诺 API 兼容**——`import * as vscode from 'vscode'` 在扩展宿主里直接失败，没有运行时兜底。但移植不是重写：扩展 API 的命名与语义持续对齐 VSCode，`commands.registerCommand`、`window.showInformationMessage`、`languages.register*Provider` 你都认识，大多数代码的移植是**改 import、改写法，而不是改设计**。不做 shim 是有意为之：shim 会把「哪里对齐、哪里有差异」藏进运行时，让扩展激活后才撞上缺失能力；显式改代码把成本暴露在编译期——TypeScript 报错的地方，就是你要动手的地方。

## 机械替换

先把不用动脑的部分一次换掉：

| VSCode | Universe | 说明 |
|---|---|---|
| `import * as vscode from 'vscode'` | `import { commands, window, workspace } from '@universe-editor/extension-api'` | 具名导入各 namespace；类型用 `type` 导入（`ExtensionContext`、`Disposable` 等） |
| devDependencies `@types/vscode` | dependencies `@universe-editor/extension-api` | API 包即类型定义与版本锚点；esbuild 打包时内联，运行时调用委托给宿主 |
| 产物 CommonJS | 产物 ESM | `"type": "module"`，相对导入带 `.js` 后缀；脚手架模板已配好 |
| `"engines": { "vscode": "^1.85.0" }` | `"engines": { "universe": ">=0.13.0 <1.0.0" }` | 语义变了：声明的是**编辑器版本**兼容区间（0.13.0 起 API 包版本与编辑器版本同空间）。写法与理由见 [API 版本与 `engines.universe`](./versioning.md) |
| `.vscodeignore`（黑名单） | `package.json` 的 `files` 数组（白名单） | 语义反转：从「排除不要的」变成「只带列出的」——漏列的文件进不了 `.vsix` |
| `vsce package` / `vsce publish` / `vsce login` | `uex package` / `uex publish` / `uex login` | 子命令同名 |
| `activationEvents` | 同名 | 支持 `*`、`onStartupFinished`、`onCommand:`、`onLanguage:`、`onView:`、`onCustomEditor:`；无 `workspaceContains:`、`onFileSystem:`、`onUri:` |
| `contributes.*` | 同名 | 支持 commands / menus / keybindings / configuration / jsonValidation / customEditors / themes / iconThemes / productIconThemes / colors / grammars / languages，逐字段见 [贡献点参考](./contribution-points.md)；未识别的贡献点静默忽略 |
| `vscode.workspace.rootPath` 等带前缀调用 | `workspace.rootPath` 等 | 去掉 `vscode.` 前缀，具名导入后直呼 namespace |

代码层面的最小 diff：

```diff
-import * as vscode from 'vscode'
+import { commands, window, type ExtensionContext } from '@universe-editor/extension-api'

-export function activate(context: vscode.ExtensionContext) {
+export function activate(context: ExtensionContext) {
   context.subscriptions.push(
-    vscode.commands.registerCommand('my-ext.hello', () => {
-      void vscode.window.showInformationMessage('Hello')
+    commands.registerCommand('my-ext.hello', () => {
+      void window.showInformationMessage('Hello')
     }),
   )
 }
```

## API 对照表

状态四档：**对齐**（签名与语义一致）｜**语义差异**（同名但行为不同，差异点已注明）｜**部分对齐**（常用路径可用，缺的重载/选项已注明）｜**缺失**（附「计划中 / 无计划 / 绕行建议」）。

### commands

| VSCode API | Universe 等价物 | 状态 |
|---|---|---|
| `commands.registerCommand` | `commands.registerCommand` | 对齐 |
| `commands.executeCommand` | `commands.executeCommand` | 对齐 |
| `commands.getCommands` | `commands.getCommands` | 对齐（`filterInternal` 为真时排除 `_` 前缀的内部命令） |

### window

| VSCode API | Universe 等价物 | 状态 |
|---|---|---|
| `window.showInformationMessage` / `showWarningMessage` / `showErrorMessage` | 同名 | 对齐（仅基础重载；无 `modal` 选项与 `MessageItem` 对象） |
| `window.showQuickPick` | 同名 | 部分对齐：`string[]` 与 `QuickPickItem[]` 两重重载；`QuickPickItem` 仅 `label/description/detail/iconId`；无 `canPickMany`、无 item 按钮等复杂管道 |
| `window.createQuickPick` / `createInputBox` | — | 缺失（暂无计划；多数场景 `showQuickPick` / `showInputBox` 已够） |
| `window.showInputBox` | 同名 | 部分对齐：仅 `placeHolder/prompt/value`；无 `password/validateInput` |
| `window.createStatusBarItem` | 同名 | 对齐（另有 Universe 扩展字段 `showProgress`；无 `name/color`） |
| `window.createOutputChannel` | 同名 | 对齐（基础子集：`append/appendLine/clear/show`） |
| `window.activeTextEditor`（同步属性） | `window.getActiveTextEditor()`（异步方法） | 语义差异：返回快照句柄，外部变化后需重新取，不要长期持有 |
| `window.onDidChangeActiveTextEditor` | 同名 | 对齐 |
| `window.showTextDocument` | 同名 | 部分对齐：`TextDocumentShowOptions` 支持 `preserveFocus/preview/selection`；无 `viewColumn`（组布局由工作台管理） |
| `window.visibleTextEditors` / `onDidChangeVisibleTextEditors` | 同名 | 语义差异：快照语义——每编辑器组 active 文本编辑器一项，集合按 URI 身份去重；`version`/`selection` 变化与编辑器内部编辑不触发事件；冷文档镜像落地前有短暂缺员窗口（getter 只含已镜像成员，事件经约 0.5 秒宽限期后先报已知子集、落地后并入再报），VSCode 无此窗口 |
| `window.onDidChangeTextEditorSelection` | 同名 | 部分对齐：防抖派发（一波输入只投递最新一次）；仅活动编辑器触发；程序化 `setSelections` 时 `kind` 为 `undefined` |
| `window.createTextEditorDecorationType` + `TextEditor.setDecorations` | 同名 | 部分对齐：装饰选项是子集（`gutterIconPath` 只收 data-URI；整行/颜色/边框/概览标尺可用）；颜色字段（`backgroundColor`/`borderColor`/`overviewRulerColor`）接受 `ThemeColor`——`backgroundColor`/`borderColor` 随主题实时追新，`overviewRulerColor` 的 `ThemeColor` 在创建装饰时解析为当前主题色（Monaco 概览标尺不能画 `var()`），切换主题后需重新 `setDecorations` 才追新 |
| `window.registerCustomEditorProvider` | 同名 | 部分对齐：仅只读 `CustomReadonlyEditorProvider`（`openCustomDocument` + `resolveCustomEditor`）；可写 custom editor（save/backup/edit）**计划中** |
| `window.createWebviewPanel`（自由面板） | 同名 | 部分对齐（0.11.0 起）：无 `ViewColumn`（面板开在当前活动组），`showOptions` 仅 `{preserveFocus}`；无 `retainContextWhenHidden`（iframe 不随 tab 隐藏重建，隐藏期状态天然保留）；无 `WebviewPanelSerializer`（reload/重启不恢复）；`active/visible` 跟踪编辑器组（visible=所在组选中 tab，active=且该组为焦点组）、变化时触发 `onDidChangeViewState`；`title` 可写、`reveal()`、`onDidDispose` 均有。详见 [自定义编辑器与 Webview](./webview-guide.md)「独立 webview 面板」 |
| `window.withProgress` | 同名 | 部分对齐：`ProgressLocation` 仅 `Window/Notification/SourceControl`（SourceControl 当前按 Window 渲染）；report 载荷仅 `{message, increment}` |
| `window.setStatusBarMessage` | 同名 | 对齐（三重载；但各条消息独立共存，不是 VSCode 的后进先出消息栈） |
| `window.showOpenDialog` / `showSaveDialog` | 同名 | 部分对齐：`showOpenDialog` 的 `canSelectMany` 多选与 `filters` 过滤均生效；`showSaveDialog` 的 `filters` 不支持 |
| `window.createTerminal` / `Terminal` | — | 缺失（**无计划**。绕行：扩展宿主是普通 Node 进程，可 `node:child_process` 自 spawn，输出进 OutputChannel；但没有用户可见的交互终端） |
| `window.createTreeView` / `registerTreeDataProvider` | 同名 | 部分对齐：懒拉取真树渲染 + `view/item/context` 菜单（`view`/`viewItem` when 键；菜单与行点击命令 handler 均收到扩展返回的 tree element / 原样 `command.arguments`，活对象保留）+ `visible/selection/onDidChangeVisibility/onDidChangeSelection/onDidExpandElement/onDidCollapseElement` + 增量刷新（句柄跨刷新稳定、展开态保留、`onDidChangeTreeData(element)` 只失效该子树）；首版裁剪——无 `reveal`/拖拽/checkbox/badge、`iconPath` 仅 codicon 名 |
| `window.registerWebviewViewProvider` | — | 缺失（暂无计划） |

### workspace

| VSCode API | Universe 等价物 | 状态 |
|---|---|---|
| `workspace.rootPath` | 同名 | 语义差异：仅单文件夹工作区，宿主启动时固定 |
| `workspace.workspaceFolders` / `workspace.name` | 同名 | 部分对齐：单文件夹模型——至多一项、`index` 恒 0；无 `getWorkspaceFolder` / `onDidChangeWorkspaceFolders` |
| `workspace.asRelativePath` | 同名 | 对齐（工作区外路径原样返回；包含性比较按 OS 大小写策略） |
| `workspace.isTrusted` / `onDidGrantWorkspaceTrust` | 同名 | 对齐（信任不会在原地撤销——撤销会重启扩展宿主，故无 revoke 事件） |
| `workspace.fs` | 同名 | 部分对齐：8 方法 `readFile/writeFile/stat/readDirectory/createDirectory/delete/rename/copy`；参数是**字符串路径**不是 `Uri`；`delete` 无 `useTrash`；每次调用过宿主路径策略（拒敏感目录、禁逃逸工作区根） |
| `workspace.createFileSystemWatcher` | 同名 | 部分对齐：glob 支持 string 与 `RelativePattern`；支持工作区外监听（Linux 下无效——`fs.watch` recursive 限制；工作区外事件只触发 `onDidChange`，不区分 create/delete） |
| `workspace.findFiles` | 同名 | 部分对齐：`include` 与 `exclude` 均支持 string 与 `RelativePattern`（base 需为工作区内 `file:` URI）；exclude 在枚举期按目录剪枝（命中子树不遍历、不占截断额度）；`token` 为真取消（杀底层枚举，取消 resolve `[]`）；结果超过 10 万条截断并记日志 |
| `workspace.textDocuments` / `onDidOpenTextDocument` / `onDidChangeTextDocument` / `onDidCloseTextDocument` | 同名 | 对齐（`TextDocument` 更薄：仅 `uri/languageId/version/isUntitled/getText()`；无 `lineAt/offsetAt/lineCount/fileName/isDirty/save()`；untitled 文档同样进 `textDocuments` 与事件流） |
| `workspace.openTextDocument` | 同名 | 部分对齐：`Uri`/路径、`{language?, content?}` 内存文档、无参与 `untitled:` URI 形态均支持；打开进文档模型不显示（要显示走 `window.showTextDocument`）；untitled URI 的 path 不 seed 另存对话框，纯 API 创建的 untitled 无法被扩展主动关闭 |
| `workspace.onWillSaveTextDocument` | 同名 | 对齐（`waitUntil(Promise<TextEdit[]>)`，宿主带超时兜底） |
| `workspace.onDidSaveTextDocument` | 同名 | 对齐（覆盖普通保存、Untitled 另存为（事件携带落盘 file URI）、文件另存为与 Merge 编辑器保存；Untitled 另存为不跑 `onWillSaveTextDocument` participants） |
| `workspace.applyEdit` | 同名 | 对齐（文本编辑 + create/rename/delete 文件操作按数组顺序交错执行，options 语义对齐 LSP；失败即中止 resolve `false`，不回滚；delete 默认走回收站；文件操作不进撤销栈） |
| `workspace.getConfiguration` | 同名 | 语义差异：`get` 返回 **Promise**（配置在 renderer 进程）；支持 `update(key, value)`；无 `has/inspect` |
| `workspace.onDidChangeConfiguration` | 同名 | 对齐（`affectsConfiguration` 前缀匹配；宿主重启期间的变更丢失，激活后重读） |
| `workspace.registerTimelineProvider`（VSCode proposed API） | 同名 | 对齐（`scheme` 可单值或数组；内置 Timeline 视图消费） |

### languages

21 个 `register*Provider` + `createDiagnosticCollection` + `getDiagnostics` / `onDidChangeDiagnostics` + `setLanguageServerStatus` + `getLanguages` + `setTextDocumentLanguage` + `setLanguageConfiguration`。两处整体差异先说清：

- `DocumentSelector` 简化为 `string | string[]`（语言 id），无 `{language, scheme, pattern}` 对象形。
- provider 签名里的类型（`Hover`、`CompletionItem`、`Diagnostic`…）是 **LSP 类型**（从 `vscode-languageserver-types` 再导出），不是 `vscode.*` 类型——字段大多同形，但构造结果时按 LSP 形状写字面量。

| VSCode API | Universe 等价物 | 状态 |
|---|---|---|
| `registerHoverProvider` / `registerDefinitionProvider` / `registerReferenceProvider` / `registerImplementationProvider` / `registerTypeDefinitionProvider` / `registerDocumentSymbolProvider` / `registerWorkspaceSymbolProvider` / `registerDocumentHighlightProvider` / `registerSelectionRangeProvider` / `registerDocumentFormattingEditProvider` / `registerDocumentRangeFormattingEditProvider` | `languages.*` 同名 | 对齐 |
| `languages.registerOnTypeFormattingEditProvider` | 同名 | 语义差异：仅用户开启 `editor.formatOnType`（本产品默认关）时才会被调用 |
| `languages.registerInlayHintsProvider` | 同名 | 对齐（可选 `resolveInlayHint` 惰性解析 label parts 的 tooltip/location/command 与 hint 级 tooltip、textEdits；`InlayHint.data` 有效且不出 host 进程；支持 `onDidChangeInlayHints`） |
| `languages.getLanguages` | 同名 | 对齐 |
| `languages.registerCompletionItemProvider` | 同名 | 对齐（triggerCharacters + 可选 `resolveCompletionItem`） |
| `languages.registerSignatureHelpProvider` | 同名 | 语义差异：第三参是 metadata 对象 `{triggerCharacters, retriggerCharacters}`，不是可变参数 |
| `languages.registerRenameProvider` | 同名 | 部分对齐：无 `prepareRename` |
| `languages.registerCodeActionsProvider` | `languages.registerCodeActionsProvider` | 部分对齐：无注册 metadata（`providedCodeActionKinds`）；`CodeActionContext` 仅 `only` |
| `languages.registerDocumentSemanticTokensProvider` | 同名 | 对齐（`legend` 挂在 provider 上；支持 `onDidChangeSemanticTokens`）；无 delta provider |
| `languages.registerDocumentRangeSemanticTokensProvider` | 同名 | 对齐（仅对可见范围懒取） |
| `languages.registerFoldingRangeProvider` | 同名 | 部分对齐：无 `onDidChangeFoldingRanges` |
| `languages.registerCodeLensProvider` | 同名 | 对齐（`resolveCodeLens` + `onDidChangeCodeLenses`） |
| `languages.registerDocumentLinkProvider` | 同名 | 对齐（`resolveDocumentLink`） |
| `languages.createDiagnosticCollection` | 同名 | 部分对齐：`set/delete/clear/dispose`；无 `get/forEach`；`Diagnostic` 是 LSP 类型 |
| `languages.getDiagnostics` / `onDidChangeDiagnostics` | 同名 | 语义差异：`getDiagnostics` 返回 **Promise**（全源诊断快照，非 live 视图；读回不含 `relatedInformation`；`code` 读回恒为字符串形式，数字 code 读回为字符串——与 VSCode 同款有损；含前导零的字符串 code 原样保留）；变更事件 50ms 防抖、按兴趣订阅 |
| —（VSCode 无对应） | `languages.setLanguageServerStatus` | Universe 扩展：上报语言服务 `starting/ready/error`，状态栏显示 spinner、导航命令等待就绪而非静默阻塞 |
| `languages.setTextDocumentLanguage` | 同名 | 对齐（等价 close(旧语言)+open(新语言)：触发 `onDidCloseTextDocument`/`onDidOpenTextDocument` 与 `onLanguage:<新id>` 激活，返回替换后的 `TextDocument`；文档未打开时 reject） |
| `languages.setLanguageConfiguration` | 同名 | 部分对齐：仅 `comments`/`brackets`/`autoClosingPairs`/`surroundingPairs`/`wordPattern` 生效（`indentationRules`/`onEnterRules`/`folding` 不生效）；返回 `Disposable` 撤销 |
| InlineCompletion / CallHierarchy / TypeHierarchy / LinkedEditing / Color / Declaration / DropEdit 等 provider | — | 缺失（暂无计划） |

### scm

| VSCode API | Universe 等价物 | 状态 |
|---|---|---|
| `scm.createSourceControl` | 同名 | 部分对齐：`SourceControl` / 资源组（含 `parentId` 嵌套）/ `inputBox` / `count` / `commitTemplate` / `acceptInputCommand` 对齐；`rootUri` 是字符串；无 `quickDiffProvider` / `historyProvider` |

### 整体缺失的能力域

`ExtensionContext` 的 `subscriptions/extensionPath/globalState/workspaceState/globalStoragePath` 与 VSCode 对齐；下表只列缺失项。

| VSCode 能力域 | 状态与绕行 |
|---|---|
| `vscode.tasks` | 缺失（**无计划**。绕行：构建类命令扩展自行 spawn 进程，进度写 OutputChannel / StatusBarItem） |
| `vscode.debug`（DAP） | 缺失（**无计划**。宿主内无替代；引导用户用外部调试器） |
| `vscode.notebooks` | 缺失（**无计划**） |
| `vscode.authentication` | 缺失（暂无计划） |
| `ExtensionContext.secrets` | 缺失（暂无计划。**不要**退而用 `globalState` 明文存密钥） |
| `vscode.Uri` 类 | 对齐（0.9.0 起：`Uri.file/parse/from/joinPath`，`fsPath/toString/toJSON`）。注意既有表面里 `TextDocument.uri` 等仍是平面对象 `UriComponents`，两类并存 |
| `vscode.env` | 部分对齐（0.9.0 起）：`appName/appVersion/language/sessionId/uriScheme`、`clipboard`（纯文本）、`openExternal`（http(s) 走浏览器，file 在工作台打开）；0.10.0 起另有 `machineId`（匿名随机 UUID 持久化，非 VSCode 的硬件指纹哈希）与 `appRoot`；无 `remoteName/uiKind` 等 |
| `vscode.extensions` | 部分对齐（0.9.0 起）：`all/getExtension/activate()`/`exports` 实时视图；`onDidChange` 不 fire（扩展集变更靠重启宿主生效） |
| `ExtensionContext.extensionUri` / `storagePath` / `environmentVariableCollection` / `logPath` / `extensionMode` | 缺失（常见用途用 `extensionPath` / `globalStoragePath` 覆盖） |
| `Memento.keys()` / `setKeysForSync` | 缺失（`Memento` 仅 `get/update`；无同步漫游） |
| `contributes.keybindings[].mac` 字段 | schema 接受但**未生效**：所有平台都用 `key`（见 [贡献点参考](./contribution-points.md#keybindings)） |

## 实战案例：pdf 扩展移植记

仓库里的 [`extensions-external/pdf/`](../../../extensions-external/pdf/) 是一次真实移植——从 vscode-pdf（Apache-2.0）到 `universe-pdf`，用 Mozilla pdf.js 在 webview 里渲染 `.pdf`，`src/extension.ts` 的头注释如实标注了移植来源。相对原版，有效改动只有三处：

1. **改 import（机械）**。`import * as vscode from 'vscode'` 换成从 `@universe-editor/extension-api` 具名导入 `window` 与类型；`vscode.ExtensionContext` 等类型注解换成具名 `type` 导入。主体逻辑（`openCustomDocument` / `resolveCustomEditor` 两方法、CSP 注入、`asWebviewUri` 重写资产 URL）原样保留。
2. **自动重载一度砍掉，现已接回**。原版用 `vscode.workspace.createFileSystemWatcher` 监听文件变化自动重载；移植时（0.8.0）没有 watcher，改为打开时一次性渲染。0.9.0 起 watcher 可用（0.10.0 起进一步支持工作区外路径与 `RelativePattern`），范例已把逐面板的 watcher 自动重载接回（见 `resolveCustomEditor` 里的 `createFileSystemWatcher`）。
3. **`localResourceRoots` 补文档所在目录（语义差异）**。Universe 只默认放行**扩展目录**；要 `asWebviewUri(document.uri)` 能解析，必须把文档所在目录显式加进 allow-list——漏了的症状是「预览器 UI 出来了但内容空白」。

**工作量锚点**：这类纯预览扩展（一个只读 custom editor + 静态资产 + 少量 postMessage）**半天内**可移植完；大头通常在 pdf.js 这类第三方资产的打包与 CSP，而不是 API 差异。写新预览扩展可直接照抄它的骨架。

## 本表的维护约定

本对照表的唯一真相源是 `packages/extension-api` 的类型定义。`extension-api` 每次 minor 发布，本表跟着过一遍——这是仓库 [`COMPATIBILITY.md`](../../../packages/extension-api/COMPATIBILITY.md) 破坏性变更流程的一部分（契约测试快照 + version bump + 变更记录同审）。发现本表与编辑器里的类型提示不一致时，**以类型定义为准**。

## 相关阅读

- [API 版本与 `engines.universe`](./versioning.md) — `engines.universe` 的写法与 0.x 版本政策
- [API 概览](./api/README.md) — 宿主当前提供的完整能力清单
- [自定义编辑器与 Webview](./webview-guide.md) — custom editor / webview 完整指南
- [语言特性](./language-guide.md) — 语言 provider 完整指南
