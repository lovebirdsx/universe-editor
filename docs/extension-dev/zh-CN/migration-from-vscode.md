# 从 VSCode 移植

> 已有一个 VSCode 扩展，想让它跑在 Universe Editor 上：哪些只要机械替换、哪些要换写法、哪些能力根本没有。以 **API 0.7.1** 为准。

## 决策背景：不 shim，但对齐

Universe Editor **不提供 `vscode` 模块的兼容层（shim），也不承诺 API 兼容**——`import * as vscode from 'vscode'` 在扩展宿主里直接失败，没有运行时兜底。但移植不是重写：扩展 API 的命名与语义持续对齐 VSCode，`commands.registerCommand`、`window.showInformationMessage`、`languages.register*Provider` 你都认识，大多数代码的移植是**改 import、改写法，而不是改设计**。不做 shim 是有意为之：shim 会把「哪里对齐、哪里有差异」藏进运行时，让扩展激活后才撞上缺失能力；显式改代码把成本暴露在编译期——TypeScript 报错的地方，就是你要动手的地方。

## 机械替换

先把不用动脑的部分一次换掉：

| VSCode | Universe | 说明 |
|---|---|---|
| `import * as vscode from 'vscode'` | `import { commands, window, workspace } from '@universe-editor/extension-api'` | 具名导入各 namespace；类型用 `type` 导入（`ExtensionContext`、`Disposable` 等） |
| devDependencies `@types/vscode` | dependencies `@universe-editor/extension-api` | API 包即类型定义与版本锚点；esbuild 打包时内联，运行时调用委托给宿主 |
| 产物 CommonJS | 产物 ESM | `"type": "module"`，相对导入带 `.js` 后缀；脚手架模板已配好 |
| `"engines": { "vscode": "^1.85.0" }` | `"engines": { "universe": ">=0.7.0 <1.0.0" }` | 语义变了：声明的是**扩展 API 版本**（= API 包版本），不是编辑器版本。写法与理由见 [API 版本与 `engines.universe`](./versioning.md) |
| `.vscodeignore`（黑名单） | `package.json` 的 `files` 数组（白名单） | 语义反转：从「排除不要的」变成「只带列出的」——漏列的文件进不了 `.vsix` |
| `vsce package` / `vsce publish` / `vsce login` | `uex package` / `uex publish` / `uex login` | 子命令同名 |
| `activationEvents` | 同名 | 支持 `*`、`onStartupFinished`、`onCommand:`、`onLanguage:`、`onView:`、`onCustomEditor:`；无 `workspaceContains:`、`onFileSystem:`、`onUri:` |
| `contributes.*` | 同名 | 支持 commands / menus / keybindings / configuration / jsonValidation / customEditors / themes / iconThemes / productIconThemes / grammars，逐字段见 [贡献点参考](./contribution-points.md)；未识别的贡献点静默忽略 |
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
| `commands.getCommands` | — | 缺失（暂无计划） |

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
| `window.visibleTextEditors` / `showTextDocument` | — | 缺失（暂无计划；文本编辑器的打开由工作台驱动） |
| `window.createTextEditorDecorationType` + `TextEditor.setDecorations` | 同名 | 部分对齐：装饰选项是子集（`gutterIconPath` 只收 data-URI；整行/颜色/边框/概览标尺可用） |
| `window.registerCustomEditorProvider` | 同名 | 部分对齐：仅只读 `CustomReadonlyEditorProvider`（`openCustomDocument` + `resolveCustomEditor`）；可写 custom editor（save/backup/edit）**计划中** |
| `window.createWebviewPanel`（自由面板） | — | 缺失（暂无计划；用 `registerCustomEditorProvider` + `contributes.customEditors` 绑定文件类型） |
| `window.withProgress` | — | 缺失（暂无计划。绕行：`StatusBarItem.showProgress` 或写 OutputChannel） |
| `window.createTerminal` / `Terminal` | — | 缺失（**无计划**。绕行：扩展宿主是普通 Node 进程，可 `node:child_process` 自 spawn，输出进 OutputChannel；但没有用户可见的交互终端） |
| `window.createTreeView` / `registerTreeDataProvider` | — | 缺失（**计划中**） |
| `window.registerWebviewViewProvider` | — | 缺失（暂无计划） |

### workspace

| VSCode API | Universe 等价物 | 状态 |
|---|---|---|
| `workspace.rootPath` | 同名 | 语义差异：仅单文件夹工作区，宿主启动时固定 |
| `workspace.workspaceFolders` / `getWorkspaceFolder` | — | 缺失（暂无计划） |
| `workspace.isTrusted` / `onDidGrantWorkspaceTrust` | 同名 | 对齐（信任不会在原地撤销——撤销会重启扩展宿主，故无 revoke 事件） |
| `workspace.fs` | 同名 | 部分对齐：6 方法 `readFile/writeFile/stat/readDirectory/createDirectory/delete`；参数是**字符串路径**不是 `Uri`；无 `copy/rename`（用 read+write(+delete) 组合绕行）；`delete` 无 `useTrash`；每次调用过宿主路径策略（拒敏感目录、禁逃逸工作区根） |
| `workspace.createFileSystemWatcher` | — | 缺失（**计划中**。绕行：轮询 `workspace.fs.stat` 的 `mtime`，或给用户提供手动刷新命令） |
| `workspace.textDocuments` / `onDidOpenTextDocument` / `onDidChangeTextDocument` / `onDidCloseTextDocument` | 同名 | 对齐（`TextDocument` 更薄：仅 `uri/languageId/version/getText()`；无 `lineAt/offsetAt/lineCount/fileName/isDirty/save()`） |
| `workspace.onWillSaveTextDocument` | 同名 | 对齐（`waitUntil(Promise<TextEdit[]>)`，宿主带超时兜底） |
| `workspace.onDidSaveTextDocument` | — | 缺失（暂无计划；「保存后」逻辑多数可挪到 `onWillSaveTextDocument`） |
| `workspace.getConfiguration` | 同名 | 语义差异：`get` 返回 **Promise**（配置在 renderer 进程）；支持 `update(key, value)`；无 `has/inspect` |
| `workspace.onDidChangeConfiguration` | — | 缺失（暂无计划） |
| `workspace.openTextDocument` / `findFiles` | — | 缺失（暂无计划。`findFiles` 绕行：`workspace.fs.readDirectory` 自行遍历） |
| `workspace.applyEdit` | — | 缺失（暂无计划；编辑器内文本改动走 `TextEditor.edit`） |
| `workspace.registerTimelineProvider`（VSCode proposed API） | 同名 | 对齐（`scheme` 可单值或数组；内置 Timeline 视图消费） |

### languages

18 个 `register*Provider` + `createDiagnosticCollection` + `setLanguageServerStatus`。两处整体差异先说清：

- `DocumentSelector` 简化为 `string | string[]`（语言 id），无 `{language, scheme, pattern}` 对象形。
- provider 签名里的类型（`Hover`、`CompletionItem`、`Diagnostic`…）是 **LSP 类型**（从 `vscode-languageserver-types` 再导出），不是 `vscode.*` 类型——字段大多同形，但构造结果时按 LSP 形状写字面量。

| VSCode API | Universe 等价物 | 状态 |
|---|---|---|
| `registerHoverProvider` / `registerDefinitionProvider` / `registerReferenceProvider` / `registerImplementationProvider` / `registerTypeDefinitionProvider` / `registerDocumentSymbolProvider` / `registerWorkspaceSymbolProvider` / `registerDocumentHighlightProvider` / `registerSelectionRangeProvider` / `registerDocumentFormattingEditProvider` | `languages.*` 同名 | 对齐 |
| `languages.registerCompletionItemProvider` | 同名 | 对齐（triggerCharacters + 可选 `resolveCompletionItem`） |
| `languages.registerSignatureHelpProvider` | 同名 | 语义差异：第三参是 metadata 对象 `{triggerCharacters, retriggerCharacters}`，不是可变参数 |
| `languages.registerRenameProvider` | 同名 | 部分对齐：无 `prepareRename` |
| `languages.registerCodeActionsProvider` | `languages.registerCodeActionsProvider` | 部分对齐：无注册 metadata（`providedCodeActionKinds`）；`CodeActionContext` 仅 `only` |
| `languages.registerDocumentSemanticTokensProvider` | 同名 | 部分对齐：仅全量文档（`legend` 挂在 provider 上）；无 range/delta provider、无 `onDidChangeSemanticTokens` |
| `languages.registerFoldingRangeProvider` | 同名 | 部分对齐：无 `onDidChangeFoldingRanges` |
| `languages.registerCodeLensProvider` | 同名 | 对齐（`resolveCodeLens` + `onDidChangeCodeLenses`） |
| `languages.registerDocumentLinkProvider` | 同名 | 对齐（`resolveDocumentLink`） |
| `languages.createDiagnosticCollection` | 同名 | 部分对齐：`set/delete/clear/dispose`；无 `get/forEach`；`Diagnostic` 是 LSP 类型 |
| —（VSCode 无对应） | `languages.setLanguageServerStatus` | Universe 扩展：上报语言服务 `starting/ready/error`，状态栏显示 spinner、导航命令等待就绪而非静默阻塞 |
| InlayHints / InlineCompletion / RangeFormatting / OnTypeFormatting / CallHierarchy / TypeHierarchy / LinkedEditing / Color / Declaration / DropEdit 等 provider | — | 缺失（暂无计划） |

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
| `vscode.Uri` 类 | 缺失（设计上以平面对象 `UriComponents` 替代——可 JSON 序列化、直接过 RPC。无 parse/join 工具函数，路径操作用字符串自理；pdf 扩展的 `joinPath/fileUri/dirUri` 可照抄） |
| `vscode.env` / `env.openExternal` | 缺失（暂无计划） |
| `ExtensionContext.extensionUri` / `storagePath` / `environmentVariableCollection` / `logPath` / `extensionMode` | 缺失（常见用途用 `extensionPath` / `globalStoragePath` 覆盖） |
| `Memento.keys()` / `setKeysForSync` | 缺失（`Memento` 仅 `get/update`；无同步漫游） |
| `contributes.keybindings[].mac` 字段 | schema 接受但**未生效**：所有平台都用 `key`（见 [贡献点参考](./contribution-points.md#keybindings)） |

## 实战案例：pdf 扩展移植记

仓库里的 [`extensions-external/pdf/`](../../../extensions-external/pdf/) 是一次真实移植——从 vscode-pdf（Apache-2.0）到 `universe-pdf`，用 Mozilla pdf.js 在 webview 里渲染 `.pdf`，`src/extension.ts` 的头注释如实标注了移植来源。相对原版，有效改动只有三处：

1. **改 import（机械）**。`import * as vscode from 'vscode'` 换成从 `@universe-editor/extension-api` 具名导入 `window` 与类型；`vscode.ExtensionContext` 等类型注解换成具名 `type` 导入。主体逻辑（`openCustomDocument` / `resolveCustomEditor` 两方法、CSP 注入、`asWebviewUri` 重写资产 URL）原样保留。
2. **砍掉自动重载（缺失能力）**。原版用 `vscode.workspace.createFileSystemWatcher` 监听文件变化自动重载；0.7.1 没有 watcher（计划中），改为打开时一次性渲染。代码里如实留了注释（`PdfDocument.dispose` 的 "auto-reload-on-change is not wired because the API has no filesystem watcher yet"），watcher 落地后可补回。
3. **`localResourceRoots` 补文档所在目录（语义差异）**。Universe 只默认放行**扩展目录**；要 `asWebviewUri(document.uri)` 能解析，必须把文档所在目录显式加进 allow-list——漏了的症状是「预览器 UI 出来了但内容空白」。

**工作量锚点**：这类纯预览扩展（一个只读 custom editor + 静态资产 + 少量 postMessage）**半天内**可移植完；大头通常在 pdf.js 这类第三方资产的打包与 CSP，而不是 API 差异。写新预览扩展可直接照抄它的骨架。

## 本表的维护约定

本对照表的唯一真相源是 `packages/extension-api` 的类型定义。`extension-api` 每次 minor 发布，本表跟着过一遍——这是仓库 [`COMPATIBILITY.md`](../../../packages/extension-api/COMPATIBILITY.md) 破坏性变更流程的一部分（契约测试快照 + version bump + 变更记录同审）。发现本表与编辑器里的类型提示不一致时，**以类型定义为准**。

## 相关阅读

- [API 版本与 `engines.universe`](./versioning.md) — `engines.universe` 的写法与 0.x 版本政策
- [API 概览](./api/README.md) — 宿主当前提供的完整能力清单
- [自定义编辑器与 Webview](./webview-guide.md) — custom editor / webview 完整指南
- [语言特性](./language-guide.md) — 语言 provider 完整指南
