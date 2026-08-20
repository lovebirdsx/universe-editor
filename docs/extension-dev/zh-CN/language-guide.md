# 语言特性

> 用 `languages` namespace 给编辑器注册语言 provider（补全、跳转、诊断……），以及进阶形态「扩展内自 spawn 语言服务器」。以 API 0.13.0 为准。

语言支持分两层：

- **provider 注册**：`languages.register*(selector, provider)` 把一个对象挂进编辑器，编辑器在需要时（用户悬停、按 F12、打字触发补全……）回调它的 `provideXxx` 方法。单文件能力（hover、补全、折叠）到这一层就够了。
- **自 spawn 语言服务器**：跨文件分析、全工作区诊断这类需求，一个无状态的单文档回调答不了——需要扩展自己拉起一个常驻进程（语言服务器），provider 只做「转发请求给服务器」的薄壳。内置 TypeScript 扩展与第一方 ESLint 扩展都是这个形态。

## provider 注册模型

所有 `register*` 方法同构：

```ts
const disposable = languages.registerHoverProvider('markdown', {
  provideHover(document, position) {
    // document: TextDocument（uri / languageId / version / getText()）
    // position: Position（0-based line/character，LSP 坐标）
    const word = document.getText().split('\n')[position.line]?.trim()
    if (!word) return undefined
    return {
      contents: { kind: 'markdown', value: `**${word}** —— 来自 my-extension` },
    }
  },
})
context.subscriptions.push(disposable)
```

四个贯穿性概念：

- **`DocumentSelector`**：provider 作用于哪些文档。当前形态是 language id 字符串或字符串数组（`'typescript'` 或 `['typescript', 'javascript']`）。
- **`ProviderResult<T>`**：`T | null | undefined | Promise<T | null | undefined>`——同步值、Promise、或「没有结果」三种返回都合法。返回 `null`/`undefined` 表示该 provider 对这次请求无话要说，编辑器继续问下一个 provider。
- **`Disposable`**：每个 `register*` 都返回一个 Disposable，惯例是 push 进 `context.subscriptions`，扩展停用时宿主统一注销。
- **`CancellationToken`**：长查询（典型是 `provideWorkspaceSymbols`，用户每敲一个键就发起一次新查询、旧查询作废）会带 token。把 token 透传给底层请求，或轮询 `token.isCancellationRequested` 及时收工——别让用户敲快一点就把语言服务器拖死。

返回的 `Hover`、`CompletionItem`、`Diagnostic` 等全部是 **LSP 类型**，直接从 `@universe-editor/extension-api` re-export（底层是 `vscode-languageserver-types`，你的扩展**不需要**单独安装它）：

```ts
import { languages, type Hover, type Diagnostic } from '@universe-editor/extension-api'
```

## provider 清单

`languages` namespace 当前（0.13.0）的全部方法：21 个 `register*` 加诊断（建集合、全源快照与变更事件）、状态上报、语言清单等工具方法。

| 方法 | 用途 | 备注 |
|---|---|---|
| `registerDefinitionProvider` | 跳转到定义（F12） | |
| `registerReferenceProvider` | 查找所有引用（Shift+F12） | context 带 `includeDeclaration` |
| `registerImplementationProvider` | 跳转到实现 | |
| `registerTypeDefinitionProvider` | 跳转到类型定义 | |
| `registerHoverProvider` | 悬停提示 | |
| `registerCompletionItemProvider` | 补全 | **可变参 `...triggerCharacters`**；可选 `resolveCompletionItem` 两阶段惰性补详情 |
| `registerSignatureHelpProvider` | 参数签名帮助 | **带 metadata** `{ triggerCharacters, retriggerCharacters }` |
| `registerDocumentSymbolProvider` | 文档大纲 / 面包屑 | |
| `registerRenameProvider` | 符号重命名（F2） | 返回 `WorkspaceEdit`，可跨文件 |
| `registerWorkspaceSymbolProvider` | 全工作区符号搜索（Ctrl+T） | **无 selector**（全局注册）；`token` 必须响应取消 |
| `registerFoldingRangeProvider` | 代码折叠 | `FoldingRangeKind` 是值导出（`Comment`/`Imports`/`Region`） |
| `registerDocumentLinkProvider` | 文档内可点击链接 | 可选 `resolveDocumentLink` 惰性填 `target` |
| `registerDocumentHighlightProvider` | 光标处符号高亮 | |
| `registerSelectionRangeProvider` | 智能扩选（Shift+Alt+→） | |
| `registerCodeActionsProvider` | 灯泡 quick fix / 重构 | |
| `registerDocumentFormattingEditProvider` | 格式化文档 | options 带编辑器缩进设置 `tabSize`/`insertSpaces` |
| `registerDocumentRangeFormattingEditProvider` | 格式化选中范围（Format Selection） | 传入 range 是提示，provider 可扩到完整语法节点 |
| `registerOnTypeFormattingEditProvider` | 键入触发字符即格式化 | 至少一个触发字符；仅用户开启 `editor.formatOnType`（默认关）时生效 |
| `registerInlayHintsProvider` | 行内注解（参数名、推断类型） | 可选 `resolveInlayHint` 惰性解析详情（label parts 的 tooltip/location/command、hint 级 tooltip、textEdits；`InlayHint.data` 有效）；可选 `onDidChangeInlayHints` 让编辑器重取 |
| `registerDocumentSemanticTokensProvider` | 语义着色（全文档） | provider 以字段形式携带 `legend`（注册时同步返回给编辑器）；可选 `onDidChangeSemanticTokens` 事件让编辑器重取 |
| `registerDocumentRangeSemanticTokensProvider` | 语义着色（可见范围） | 与全文档版同契约，编辑器仅对可见范围懒取；`legend` 挂在 provider 上 |
| `registerCodeLensProvider` | 行上方可操作注解（"3 references"） | 两阶段 `resolveCodeLens`；可选 `onDidChangeCodeLenses` 事件让编辑器重取 |
| `createDiagnosticCollection` | 建一组诊断（编辑器里的红/黄波浪线） | 见下节 |
| `getDiagnostics` / `onDidChangeDiagnostics` | 读全源诊断快照 / 订阅诊断变更 | 见下节 |
| `setLanguageServerStatus` | 上报语言服务器生命周期状态 | 见「语言服务器状态」节 |
| `getLanguages` | 列出编辑器已知的全部语言 id | |
| `setTextDocumentLanguage` | 切换已打开文档的语言 id | 等价 close(旧语言)+open(新语言)，返回替换后的 `TextDocument`；文档未打开时 reject |
| `setLanguageConfiguration` | 动态设置语言配置（comments/brackets/wordPattern 等） | 返回 `Disposable` 撤销 |

逐方法签名与 JSDoc 以编辑器里的类型提示为准。

## 诊断

诊断不走 provider 拉取模型，而是扩展**主动推送**：

```ts
const diagnostics = languages.createDiagnosticCollection('my-linter')
context.subscriptions.push(diagnostics)

// 某文件的分析结果出来了：整组替换
diagnostics.set(document.uri, [
  {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    severity: 1, // 1=Error 2=Warning 3=Information 4=Hint（LSP DiagnosticSeverity）
    message: 'something is wrong',
    source: 'my-linter',
  },
])

// 修复后清掉该文件：diagnostics.set(uri, undefined) 或 diagnostics.delete(uri)
// 全清：diagnostics.clear()
```

`set` 是**整组替换**语义：同一 URI 再 `set` 一次，旧诊断被覆盖。collection 的 `name` 是这组诊断的 owner——多个扩展（或同一扩展的多个 collection）可以给同一文件打标记而互不干扰。

与 provider 的分工惯例：**诊断推，provider 答**。语言服务器后台分析，发现波浪线就推给 collection；用户点灯泡、按 F12 时编辑器才来调 provider。两者共用同一个底层分析结果，但走两条路。

反过来读诊断用 `languages.getDiagnostics()`（全源快照，含别的扩展推的；`getDiagnostics(resource)` 只看单个 URI）与 `languages.onDidChangeDiagnostics`（任意集合变更时触发，50ms 防抖，事件携带受影响 URI 列表）。两个与 VSCode 的差异：快照经 RPC 故返回 `Promise`（VSCode 是同步属性），且非 live 视图——变了要重取；读回的 `Diagnostic` 不含 `relatedInformation`。

## 语言服务器状态

语言服务器启动要几秒（索引、建项目），这期间用户按 F12 没反应会以为坏了。`setLanguageServerStatus` 让扩展把服务器生命周期告诉编辑器：

```ts
languages.setLanguageServerStatus('my-lang', 'starting') // 状态栏出现转圈
// …服务器握手完成…
languages.setLanguageServerStatus('my-lang', 'ready')
// 启动失败：languages.setLanguageServerStatus('my-lang', 'error')
```

`id` 按你的服务器起一个稳定名（如 `'typescript'`）。`starting` 期间导航类命令（跳转/引用）会显示进度并等待就绪，而不是静默卡住。

## 进阶：扩展内自 spawn 语言服务器

### 什么时候需要

单文档 provider 模型有一个隐含边界：每个回调拿到的是**一份文档 + 一个位置**，答不了「这个符号在整个工作区被谁引用」「这次改动会不会弄坏别的文件」。出现以下需求就该上语言服务器：

- 跨文件分析（全工作区引用、类型检查、跨文件 rename）
- 全工作区诊断（没打开的文件也要报红）
- 需要增量索引 / 长驻缓存的重型分析

架构形态：扩展进程内 spawn 一个子进程（语言服务器），扩展与它用 LSP 或自定义协议通信；provider 退化成薄壳——把编辑器的 `provideXxx` 调用翻译成服务器请求，把服务器应答翻译回 LSP 类型。

### 两个真实范式

**内置 TypeScript 扩展**（仓库 `extensions/typescript`）：activate 时 spawn `typescript-language-server`，持有 LSP 客户端，一口气注册 12 类 provider，每个回调就是「取 `doc.uri` 发给 tsserver」。诊断走服务器 PUSH（`publishDiagnostics` 通知 → `diagnosticCollection.set`）；`setLanguageServerStatus` 挂在服务器状态机上；`registerDocumentSemanticTokensProvider` 的 `legend` 要等 initialize 握手拿到服务器能力后**再注册**（legend 注册时就要同步给出）。

**第一方 ESLint 扩展**（仓库 `extensions-external/eslint`，`.vsix` 外置形态）：spawn 一个 standalone ESLint server 子进程，client↔server 走自定义精简协议（不需要标准 LSP 全集就不用背它）。它演示了诊断（server PUSH → collection）、quick fix（`registerCodeActionsProvider`，全走 `edit.changes` 形式）、`registerDocumentFormattingEditProvider`（格式化 = fix-all）、`workspace.onWillSaveTextDocument` 的 `waitUntil`（保存时 fix-all）四件套。

### 要点

- **进程生命周期归扩展管**：`activate` 里拉起，把 `{ dispose: () => killServer() }` push 进 `context.subscriptions`，宿主在扩展停用时统一收割。语言服务器崩溃后自行重启并把已打开文档重放（didOpen）回去，是两个范式共同的做法。
- **LSP 类型零依赖**：provider 签名里的 `Diagnostic`/`TextEdit`/`WorkspaceEdit` 等全部从 `@universe-editor/extension-api` 导入，不必另装 `vscode-languageserver-types`。
- **Workspace Trust 红线**：语言服务器会加载并执行工作区的代码（ESLint 要 require 工作区的 eslint 配置与插件）。这类扩展必须声明：

  ```jsonc
  {
    "capabilities": {
      "untrustedWorkspaces": {
        "supported": false,
        "description": "ESLint 会加载并执行工作区的 ESLint 配置与插件代码，因此需要信任工作区。"
      }
    }
  }
  ```

  不受信任的工作区里宿主不会激活它。语义详见 [安全与信任](./security-and-trust.md)。
- **如实说明**：脚手架（`npm create @universe-editor/extension`）目前没有 language 模板——起语言扩展就从 `basic` 模板出发，照本文与上面两个范式接线。

## 本地化

`contributes` 里的用户可见文案（命令标题、配置项描述……）可以用 `%key%` 占位，文案放在扩展根目录的 `package.nls.json`（默认）与 `package.nls.<locale>.json`（如 `package.nls.zh-cn.json`）。ESLint 扩展是实例：`"title": "%eslint.command.restart.title%"` 配 `package.nls.json` 里的 `"eslint.command.restart.title": "Restart ESLint Server"`。注意 NLS 文件必须列入 `package.json` 的 `files` 白名单，否则打包时丢失。

## 相关阅读

- [API 概览](./api/README.md) — `languages` 之外的其它 namespace
- [扩展的结构](./extension-anatomy.md) — `activationEvents`（`onLanguage:<id>` 是语言扩展的标准激活事件）与 `capabilities.untrustedWorkspaces` 字段语义
- [安全与信任](./security-and-trust.md) — 语言服务器类扩展为什么必须声明 `supported: false`
