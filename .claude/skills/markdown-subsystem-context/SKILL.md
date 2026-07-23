---
name: markdown-subsystem-context
description: 处理 markdown 相关功能时召回，提供整个 markdown 子系统的上下文地图——三条线（语言特性 LSP 线 + 预览渲染线 + 粘贴成链 renderer 增强线）的文件分布、各环节职责、关键架构决策与「为什么」、与 typescript 内置插件样板的差异。当任务涉及 extensions/markdown 插件、其进程内语言服务（vscode-markdown-languageservice，extensions/markdown/src/server）、markdown 的 symbols/definition/references/workspace-symbols/hover/completion/rename/documentLink/highlight/selectionRange/codeAction/folding/诊断（坏链检测）、markdown 文档同步、拖拽/粘贴文件成 markdown 链接、markdown 预览（MarkdownPreviewInput / MarkdownView / sync scroll）、markdown fs 网关（mdFsBridge），或要理解「markdown 能力在本仓库怎么拼起来、和 TS 有什么不一样」时，先读它建立全局认知。它给上下文 + markdown 专属的「改哪里」与坑；语言插件的通用四数据流/句柄路由套路见 [extend-language-plugin]，TS 对照见 [typescript-subsystem-context]。
disable-model-invocation: true
---

# Markdown 子系统 上下文地图

markdown 已是**内置插件** `extensions/markdown`（按 `extend-language-plugin` 的「迁新语言」套路从 TS 样板迁成）。它和 TS 共用同一套**句柄路由 + 四条数据流 + renderer 句柄壳/转换层**——这些**别在这里找差异**，去 [extend-language-plugin]。本 skill 只讲 **markdown 独有的形态**：它和 TS 的不同点、两条线的地图、为什么这么设计。

> ⚠️ 第一原则：先认领你的改动落在**哪条线**——① 语言特性（symbols/定义/引用/hover/补全/诊断…，走插件+句柄路由）、② 预览渲染（MarkdownView，纯 renderer，与 LSP/插件无关），还是 ③ 粘贴成链（拖拽/粘贴文件→markdown 链接，**纯 renderer 编辑增强，不经插件/LSP**）。三条线几乎不相交，改错线白改。

## 与 typescript 样板的差异速查（最高优先级）

| 维度 | typescript 插件 | **markdown 插件** |
|---|---|---|
| 语言服务运行方式 | 插件内 **spawn 子进程** `typescript-language-server`（LSP over stdio） | **进程内库调用**：host 是纯 Node，`createMdServer()` 直接在 host 进程里跑 `vscode-markdown-languageservice` + markdown-it，**无子进程、无 stdio** |
| Electron 路径耦合 | 主进程 `tsServerPaths.ts` 解析 cli/tsserver，env 注入 `UNIVERSE_TSLS_*` | **无**。不需要任何主进程路径解析 / env 注入（没有外部二进制） |
| 文件读取 | tsserver 自己读盘 | 经 host 的 **`workspace.fs` 网关**（`mdFsBridge`），受 **path policy** 约束（`.ssh`/`.aws`/`.env` 拒、不得越出 workspace root） |
| 诊断触发 | tsserver PUSH（server 主动推 `publishDiagnostics`） | **debounce-then-pull-then-push**：renderer 文档变 → 插件 200ms 防抖 → `server.$computeDiagnostics(uri)` 主动算 → `diagnosticCollection.set()` 推 |
| wire 类型 | 直接复用 `vscode-languageserver-types`，verbatim 透传 | **同样直接复用 `vscode-languageserver-types`**：进程内 `createMdServer` 直接返回原生 LSP 类型，插件零转换透传给句柄路由（fs 回调端口 `IMdClient` 仍是自定义小接口） |
| 崩溃恢复 | 子进程崩溃要 `_resyncAll` 重推所有 open doc | **不存在**（无子进程，进程内调用不会崩） |
| 额外特性 | 无 | **预览**（VSCode 风 `Open Preview` / `to Side`）+ **粘贴/拖拽文件成链 + 二进制图片落盘 assets/**（Monaco documentPasteEditProvider / documentDropEditProvider），TS 都没有 |
| 打包 | 插件 dist + tsls node_modules（runtime-resources 带入） | 插件 **dist 自包含**（esbuild bundle 了 `vscode-markdown-languageservice`），无额外 node_modules |

## 线 ①：语言特性（LSP 能力）

数据流完全走 [extend-language-plugin] 的 A/B/C/D 四条，markdown 端的落点：

```
extensions/markdown/src/
  extension.ts     activate：createMdServer(createMdFsBridge(root), root) → 注册全套 provider
                   （documentSymbol/definition/references/workspaceSymbol/folding/hover/
                    completion/rename/documentLink/documentHighlight/selectionRange/codeAction，
                    selector=['markdown']；completion 触发字符 ['[','(','#','/']）
                   + 两条 server 命令（organizeLinkDefinitions / getFileReferences）
                   + createDiagnosticCollection('markdown') + 文档同步（onDidOpen/Change/Close）
                   诊断：DIDCHANGE_DEBOUNCE_MS=200 防抖 → $computeDiagnostics → diagnostics.set
                   provider 回调零转换：$provideXxx 直接返回原生 LSP 类型透传
  mdFsBridge.ts    IMdClient 实现：$readFile/$stat/$readDirectory/$findMarkdownFiles
                   全部经 workspace.fs（网关 + path policy）；扫描忽略 node_modules/.git/dist/out/.turbo

extensions/markdown/src/server/  （进程内库，不是子进程！）
  mdServer.ts      createMdServer(client, root)：markdown-it parser + createLanguageService
                   + IMdServer 实现（$didOpen/Change/Close + $provide* + $computeDiagnostics）
                   直接返回 vscode-languageserver-types 原生类型。DIAGNOSTIC_OPTIONS 在这
  documentStore.ts renderer 已打开文档的 overlay（编辑器内容盖过磁盘）
  lspWorkspace.ts  vscode-markdown-languageservice 的 IWorkspace 适配：overlay 命中走 store，
                   未打开的链接目标/扫描走 client（即 mdFsBridge）
  types.ts         IMdServer（返回原生 LSP 类型）+ IMdClient/MdFileStat/MdFileType（fs 端口）
                   + MdTextDocumentDto（$did* 入参）
  __tests__/mdServer.test.ts  用 stub IMdClient 驱动真实 language service 的单测（symbols/诊断/workspace）
```

renderer 侧**完全复用** TS 的句柄路由壳：`MainThreadLanguages`（句柄→Monaco provider、诊断落 marker）、`languageProviderProxy`、`lspMonacoConvert`、通用 `DocumentSyncContribution`（已广播所有语言）。**LSP 语言特性不在 renderer 加任何 markdown 专属代码**——唯一的 renderer 专属是线 ③「粘贴成链」（编辑增强，不是 LSP）。

诊断 owner = `'markdown'`（`createDiagnosticCollection('markdown')`），必须与 `setModelMarkers` 的 owner 一致。

## 线 ②：预览渲染（与 LSP 无关）

纯 renderer，不经插件/host：

```
actions/markdownActions.ts          Open Preview (ctrl+shift+v) / to Side (ctrl+k ctrl+v)
                                     precondition: activeEditorLanguageId == markdown；EditorTitle 菜单
services/editor/MarkdownPreviewInput 虚拟 EditorInput，scheme 'markdown-preview'，typeId 'markdown.preview'
                                     可序列化恢复；id 按 sourceUri 去重（同文件不开两个预览）
workbench/editor/MarkdownPreviewEditor.tsx  组件：源文件 open 时跟 Monaco model 实时刷新，
                                     未 open 时 fileService.readFileText 读盘
workbench/editor/useMarkdownSyncScroll.ts   预览↔源编辑器 同步滚动
workbench/markdown/MarkdownView.tsx  渲染核心：parseMarkdown AST → React 元素，
                                     **不输出 raw HTML**（React 转义，SafeLink 防护），代码块走 CodeBlock（Monaco 着色）
services/acp/markdownRenderer.ts     parseMarkdown / MdInline / MdNode —— 与 ACP 聊天共享的 markdown AST；
                                     blockquote 是容器块（children 递归 MdNode，剥一层 > 前缀后递归 parseMarkdown，
                                     子节点 line 为相对行号，与列表 children 一致）；增量切分安全依赖
                                     「blockquote 内每行都以 > 开头、无真空行」这一不变量
```

input→组件 两处注册（套路见 apps/editor/CLAUDE.md 编辑器输入）：
- `workbench/editor/EditorArea.tsx`：`editorComponentMap.set('markdown.preview', MarkdownPreviewEditor)`
- `contributions/BuiltInEditorProvidersContribution.ts`：注册 `typeId / componentKey:'markdown.preview' / deserialize`

> MarkdownView 是**共享渲染器**（ACP 聊天 + 文档预览都用它）。改它要同时顾及两个消费方；样式靠容器继承字号/色，组件本身不写死。

## 线 ③：粘贴/拖拽成链（renderer 编辑增强，不经插件/LSP）

**按住 `Shift` 拖进**（VSCode 同款门控，见下文冲突小节）或**粘贴进**（粘贴不需 Shift）markdown 编辑器时自动生成链接：文件→`[${1:text}](相对路径)`、图片→`![${1:alt text}](相对路径)`、URL→`[选中文本](url)`；**无磁盘路径的二进制图片**（截图工具/网页拖来）→落盘到当前 md 同目录 `assets/`（时间戳命名）再 `![${1:alt text}](assets/…)`。**产出的是 snippet**（链接文字是选中占位符 `${n:…}`，多文件序号递增；对齐 VSCode `copyFiles/shared.ts`），落地后方括号内文字自动选中可直接改名。这是 **Monaco 内置 `documentPasteEditProvider` / `documentDropEditProvider`** 两个对称 registry 的能力，VSCode 同款，**与 LSP/插件完全无关**，纯 renderer：

```
contributions/markdownPasteLinks.ts        纯函数：markdownLinksFromUriList（text/uri-list→链接，
                                            图片 ! 前缀 / workspace 相对路径 / 空格 <...> 包裹）、
                                            markdownLinkFromUrl（URL→[sel](url) snippet）、
                                            导出共享原语 isImagePath / encodeLinkTarget
contributions/markdownAssetLinks.ts        纯函数：imageExtensionForMime（mime→ext）、
                                            formatAssetStamp(Date)→yyyyMMdd-HHmmss、
                                            assetFileName(ext,stamp,index)、markdownLinkForPath
contributions/markdownAssetDropper.ts      saveDroppedImageAsset(fileService,mdUri,bytes,mime,stamp)：
                                            dirname→assets/ createDirectory(recursive)+writeFile(Uint8Array)
                                            +同秒 index 去重，返回相对 md 的 assets/xxx。注入 @IFileService
contributions/markdownLinkProviderShared.ts computeMarkdownLinkInsert：drop/paste 共享内核——先 uri-list→链接，
                                            否则找 image/* file 项→落盘成链。findImageFileEntry 迭代 VSDataTransfer
                                            （守卫非可迭代 stub）。IVSDataTransfer 类型（get + 可选 Symbol.iterator）
contributions/MarkdownPasteContribution.ts  注册 documentPasteEditProvider，pasteMimeTypes
                                            ['text/uri-list','image/*','files','text/plain']，注入
                                            @IWorkspaceService/@IHostService/@IFileService，调共享内核
contributions/MarkdownDropContribution.ts   注册 documentDropEditProvider（drop 对称版），
                                            dropMimeTypes ['text/uri-list','image/*','files']，同注入同内核
```

注册两处：`contributions/registration/afterRestore.ts`（`workbench.contrib.markdownPaste` + `workbench.contrib.markdownDrop`）。

**⚠️ drop 与「拖文件到编辑区打开」的双触发冲突 + Shift 门控（本功能核心）**：编辑区 body（`EditorGroupView`）的 drop 默认走 `openDroppedResources`＝**打开文件**（原逻辑）。为**不冲击原习惯**，成链改成 **VSCode 同款 `Shift` 门控**：不按 Shift＝拖入正文仍打开文件；**按住 Shift** 才在光标处插链接。`FileEditor` 各语言的 `dropIntoEditor` **静止基线一律 `{enabled:false}`**。四点联动，缺一即冲突或漏门控：
1. `FileEditor.tsx`：基线 `DROP_INTO_EDITOR_OFF`（create 时设 + model-swap effect 复位，因编辑器实例跨 tab 复用）。在编辑器容器 `getContainerDomNode()` 上 **capture 阶段**挂 `dragover` 监听，按 `e.shiftKey && 当前 model 是 markdown` 实时 `updateOptions({dropIntoEditor: 开/关})`。
2. 为何 capture + dragover 实时切：Monaco 的 `isDropIntoEnabled()`（`codeEditorWidget.js`）**只看 `readOnly + dropIntoEditor.enabled`，不看 shiftKey**，且其 `onDragOver`/`onDrop` 在**触发时实时读** enabled。`DragAndDropObserver` 用 **bubble** 阶段监听同一 `_domElement`（==`getContainerDomNode()`），故我在 capture 阶段先跑、先把 enabled 按 Shift 就位；HTML5 保证 drop 前必有 dragover，drop 时状态必正确。**切勿在 capture 的 drop 阶段复位 enabled**——会抢在 Monaco 的 bubble drop 前关掉，导致 Shift 拖放失效；靠下一次 dragover / model-swap 自然回基线即可。
3. Monaco 的 drop 监听 `DragAndDropObserver` **既不 preventDefault 也不 stopPropagation**（`base/browser/dom.js`），drop 会先被 Monaco 处理（插链接）再**冒泡**到 body → 若不拦就双触发（既插链接又打开文件）。
4. `EditorGroupView.tsx` `shouldDeferDropToMarkdownEditor(target, activeEditor, shiftKey)`（已导出可单测）：**`shiftKey` 为真** 且活动编辑器是 markdown `FileEditorInput` 且 drop 落点在 `.monaco-editor` 内 → `handleBodyDrop` return 不 openDroppedResources、`handleBodyDragOver` 抑制 overlay。**不按 Shift → 返回 false → 走原打开文件逻辑**。**拖到标签栏仍打开文件**（tab-bar drop 不受守卫影响）。粘贴（`documentPasteEditProvider`）**不受 Shift 门控**，一律成链。

**⚠️ snippet 占位符必须靠自定义 bulkEdit 执行（否则 `$0` 字面显示、方括号内无选中）**：provider 的 edit 必须返回 `{ snippet }`（不是纯字符串 `insertText`）。Monaco `dropOrPasteInto/edit.js` 对**字符串** insertText 会包成 `escape(text)+'$0'`、对 `{snippet}` 直接用其值，二者都以 `insertAsSnippet:true` 走 `IBulkEditService.apply`。但本仓库**用 `services/languageFeatures/typescript/fileBulkEditService.ts` 覆盖了 `IBulkEditService`**（为跨文件 F2 rename），standalone 默认实现和它**都不解释 snippet** → `${1:text}`/`$0` 被当字面文本写入（用户就会看到 `[](x)$0`）。修复两层：① 纯函数产出带 `${n:占位}` 的 snippet（`markdownLinkSnippet` in `markdownPasteLinks.ts`，`markdownLinkForPath`/`markdownLinksFromUriList`/asset 落盘都用它；provider 返回 `{snippet}`）；② `FileBulkEditService.apply(edits, {editor})` 接住 monaco 传的第二参 `{editor}`，`insertAsSnippet===true` 且目标是该 editor 当前 model 时走 `SnippetController2.get(editor).insert(text)`（解析并选中占位符），否则维持原 `pushEditOperations`/读盘改写（**严格以 `insertAsSnippet` 门控，rename 零影响**）；无 editor 的兜底用 `stripSnippet()` 剥语法防字面落地。drop 前 monaco 已 `editor.setPosition(dropPosition)`，落点正确。

> ⚠️ Monaco 的 `documentPasteEditProvider`/`linkProvider`/`hoverProvider`/`completionProvider`/`referenceProvider` 这些内部 registry **没有公开 `monaco.languages.*` API**，只能经 `StandaloneServices.get(ILanguageFeaturesService)` 拿——封装在 `MonacoLoader.getLanguageFeaturesService()`（类型 `MonacoLanguageFeaturesService`），shim 声明在 `renderer/monaco-shims.d.ts`。e2e 探针读这些 registry 也走它。

## 关键架构决策与「为什么」

- **进程内库而非子进程**：markdown language service 是纯 JS（markdown-it + vscode-markdown-languageservice），host 又是纯 Node，spawn 子进程纯属浪费——直接 `createMdServer()` 在 host 进程内跑。代价：放弃了崩溃隔离，但 JS 库崩溃风险极低，换来零 IPC/零路径解析。
- **fs 必须走 `workspace.fs` 网关**：language service 要读用户没打开的文件（链接目标、workspace 扫描算 workspace symbols / 坏链）。这些读**不能**让插件直接碰盘——统一经 host 的 `workspace.fs`，由 path policy 把关（拒敏感目录、禁越界）。`mdFsBridge` 就是这层适配。renderer 已打开的文档不到这来（DocumentStore overlay 先答）。
- **坏链诊断是头牌特性**：`DIAGNOSTIC_OPTIONS` 把 fragment/file/reference 链接校验默认开到 warning，definition-hygiene 类降到 hint，避免噪音。
- **预览不复用 markdown-it 直出 HTML**：走自家 `parseMarkdown` AST + React 渲染，杜绝 untrusted 文本注入 raw HTML（安全），且能跟 ACP 聊天共用一套渲染。

## 常见任务 → 改哪里

- **给 markdown 加一类新 provider**（hover / folding / 格式化 / code action…）：走 [extend-language-plugin] 任务 1 的全套（rpc 枚举 + KEEP IN SYNC 三处 + renderer 句柄壳）；markdown 端只加两处：`server/mdServer.ts` 的 `IMdServer` 加 `$provideXxx`（调 `ls.getXxx`，直接返回原生 LSP 类型）、`extension.ts` 的 `registerProviders` 加一行 `languages.registerXxxProvider(['markdown'], …)`（零转换透传）；`server/types.ts` 的 `IMdServer` 接口加对应签名。
- **调诊断规则/级别**：`server/mdServer.ts` 的 `DIAGNOSTIC_OPTIONS`。诊断不出/调链路：[extend-language-plugin] 任务 4 + 注意下面盘符坑。
- **诊断防抖时长**：`extension.ts` 的 `DIDCHANGE_DEBOUNCE_MS`。
- **fs 行为**（扫描忽略目录、读取容错、新增 client 方法）：`mdFsBridge.ts`（+ `server/types.ts` 的 `IMdClient` + `server/lspWorkspace.ts` 调用方）。
- **预览渲染/样式/同步滚动**：线 ② 对应文件，**完全不碰插件**。
- **预览命令/键位/菜单**：`actions/markdownActions.ts`（对标 VSCode：`ctrl+shift+v` / `ctrl+k ctrl+v`）。
- **粘贴/拖拽成链行为**（图片前缀、相对路径、URL 处理、二进制图片落盘、支持的 mime、snippet 占位符）：线 ③ 纯函数在 `markdownPasteLinks.ts`（含 `markdownLinkSnippet` 产 snippet）/ `markdownAssetLinks.ts` / `markdownAssetDropper.ts`（优先在这里加单测），drop/paste 共享内核在 `markdownLinkProviderShared.ts`，注册/注入在 `MarkdownPasteContribution.ts`（粘贴）/ `MarkdownDropContribution.ts`（拖拽）。**snippet 的实际插入+占位符选中**在 `services/languageFeatures/typescript/fileBulkEditService.ts`（`insertAsSnippet` 分支走 `SnippetController2`；改成链渲染效果看这里）。改「拖入编辑器 vs 打开文件」的分流 + Shift 门控看 `FileEditor.tsx` 的 capture-dragover 监听（按 `e.shiftKey` 切 `dropIntoEditor.enabled`）+ `EditorGroupView.tsx` 的 `shouldDeferDropToMarkdownEditor(…, shiftKey)`。**不碰插件**。
- **YAML frontmatter**（文首 `---…---` 块）三条线都碰，各自独立：
  - **诊断/documentLink 屏蔽**（线①）：`server/frontmatter.ts` 的 `detectFrontmatterRange` + `server/mdServer.ts` 的 `tokenizeWithFrontmatter`——在 `parser.tokenize` 里给 frontmatter 区间**注入合成 `code_block` token**（`map:[0,endLine]`）并剔除落在区间内的原始 token。**根因**：`vscode-markdown-languageservice` 无 frontmatter 感知，其 `NoLinkRanges` 只跳过 `code_block`/`fence`/`html_block`；只加 markdown-it front_matter 插件**无效**（库不认 `front_matter` 类型），实测唯有伪装成 `code_block`/`fence` 才让 `[hello]` 不报坏链、正文坏链仍报。改后必 `pnpm ext:build`。
  - **源文件高亮**（线②源码）：`renderer/workbench/editor/monaco/monacoMarkdownFrontmatter.ts`——克隆内置 markdown Monarch，加 `start:'frontmatter_start'` 状态（首行 `---` 进 `@frontmatter`：key→`type`、value→`string`、闭合 `---`→`switchTo:'@root'`；非首行 `---` 用 `@rematch`+`switchTo:'@root'` 回退，无死循环），`setMonarchTokensProvider('markdown', …)` 覆盖。**赢懒加载竞态**靠先建 markdown model 触发 `onLanguage` 再 `await` 同一模块（我们的 override 后落）。在 `MonacoLoader.ts` 建 json model 处附近调用。token 颜色规则（`type.md`/`operators.md`）在 `panel/output/monacoLogLanguage.ts` 的 `MD_TOKEN_RULES_*`（output-dark/light 全局主题）。
  - **预览渲染表格**（线②预览）：`services/acp/markdownRenderer.ts` 的 `parseMarkdown(input, {frontmatter:true})`——仅在 opts 开启时首迭代探测，产出 `{type:'frontmatter', entries}` 节点（自写极简顶层 `key: value` 解析 `parseFrontmatterEntries`，零 YAML 依赖，嵌套/多行折进上一值）；默认不开（ACP 聊天/流式不受影响）。`MarkdownView.tsx` 的 `frontmatter?:'table'|'hidden'` prop + `FrontmatterModeContext` + `FrontmatterBlock` 渲染成表格（`markdown.module.css` 的 `.frontmatterTable`）。开关配置 `markdown.preview.renderYamlFrontmatter`（默认 true）注册在 `contributions/MarkdownConfigurationContribution.ts`（blockStartup 挂载），`MarkdownPreviewEditor.tsx` 读配置传 prop。

## 易踩坑速记

1. **盘符大小写**（已修，勿回退）：platform `URI.file('C:/…')` 保留大写盘符，Monaco `Uri.parse` 小写化盘符 → 诊断 uri 回来对不上 model registry 的 key。`MainThreadLanguages._setMarkers` **用 `monacoNs.editor.getModel(monacoNs.Uri.parse(resource.toString()))`** 解析（Monaco 自身归一化），不要换回 `MonacoModelRegistry.peek`（精确字符串匹配会 miss）。
2. **二进制 IPC**（已修，全局基建）：`workspace.fs.readFile` 返回 `Uint8Array`，经 platform `ipc.ts` 的 JSON 信封会退化成 0 字节——已由 base64 tag 的 replacer/reviver 修复（`packages/platform/src/ipc/ipc.ts`）。markdown 的 `$readFile` 依赖它；动 ipc 编解码别破坏。
3. **server 直返原生 LSP 类型**：`server/mdServer.ts` 的 `$provide*` 直接返回 `vscode-languageserver-types`，插件 `extension.ts` 零转换透传（与 extension-api 同源，无需 `as`）。加 provider 别再画蛇添足造中间 DTO；唯一规整是 `$provideDefinition` 把 `Definition | undefined` 归一成 `Location[]`。
4. **path policy 会拒读**：预览/诊断读到 `.env`/`.ssh` 或越界路径时 `mdFsBridge` 静默吞成 `undefined`/`[]`（不抛）。排查「某链接诊断不报/预览空」先想是不是被网关挡了。
5. **esbuild 强制 `vscode-uri` 走 CJS**：`vscode-markdown-languageservice` 用 default import，但 vscode-uri 的 ESM 入口只有 named export，esbuild bundle 不了 ESM 版——`esbuild.config.mjs` 里 `alias` 把 `vscode-uri` 指到 CJS 入口（单测同坑，`vitest.config.ts` 里有同样 alias）。动构建/测试配置别删这个 alias。
6. **打包靠自动发现**：`scripts/release/runtime-resources.mjs` 的 `discoverBuiltinExtensions` 扫 `extensions/*` 自动带入，按 `package.json` 的 `files`(`["dist"]`)+`main`。新插件天然纳入，不用改 electron-builder.yml。
7. **预览 input→组件两处必同步**：`EditorArea.tsx` 的 `editorComponentMap` + `BuiltInEditorProvidersContribution.ts`，漏一处预览开不出或恢复不了。
8. **host stdout 就是 RPC 线，禁止任何 console.log**（已修，勿回退）：markdown LS 进程内跑在 ext host，host 的 **stdout 就是 IPC 帧通道**。`vscode-markdown-languageservice@0.5.0-alpha.13` 在 `pathCompletions.js` 残留一句 `console.log('provideCompletionItems',…)`，被 bundle 进 dist——它写 stdout 会污染帧，renderer 端报 `SyntaxError: Unexpected token 'p', "provideCom"… is not valid JSON`。根治：host bootstrap 用 `protectStdout()`（`packages/extension-host/src/stdoutProtection.ts`）把 `console` 整体重定向到 stderr（VSCode 同款），stdout 只留 framed writer。改 host bootstrap / 升级 md LS 别破坏这层。
9. **header-fragment 链接 setSelection 崩溃**（已修，勿回退）：md LS 把 `./foo.md#hello` 这类 header 链接的目标编码成 fragment `L1,1`，Monaco `extractSelection` 解出的 range **`endLineNumber`/`endColumn` 是 `undefined`**（无 `-L..` 段），既非合法 IRange 也非 ISelection，`setSelection` 抛 `Invalid arguments`。修法：`EditorOpenerContribution.ts` 的 `normalizeOpenRange(selection)` 把 end 缺省补成 start，再 setSelection/reveal。
10. **补全 vs 文档同步防抖竞态**（已修，勿回退）：补全在触发字符（如 `#`）上**立即**触发，但 `DocumentSyncContribution` 对文档变更有 200ms 防抖 → ext host 拿到的是**旧文档**，header 补全算不出新标题。修法：补全 proxy 在调 `$provideCompletion` 前先 `await PendingDocumentSync.flush(uri)`（`renderer/services/extensions/PendingDocumentSync.ts` 模块单例；`DocumentSyncContribution` attach 时 `register(key, flush)`、detach 时 `unregister`，`flush` 会清防抖定时器并立即 `_pushChange`）。任何「即时触发的 provider 依赖最新文档」都该走这个 flush。
11. **预览里的链接点击不走 LSP documentLink**：`MarkdownView`/`SafeLink` 自己判断并路由。`./foo.md#hello` 必须拆成「文件路径 + fragment」，先按文件路径打开 `MarkdownPreviewInput`，再通过 `MarkdownPreviewRegistry.revealAnchor` 定位 heading；`@path/to/file` 是显式文件 mention，解析/打开前要剥掉 `@`。别让 `#fragment` 或 `@` 进入 `markdownLinkCandidates`，否则会落到 `window.open` 或报文件不存在。
12. **vim 导览键吞掉预览内输入框字符**（已修，勿回退）：`useMarkdownKeyboardNav` 在预览容器 **冒泡阶段** 监听 keydown，而 Ctrl+F 的搜索框（`ChatFindWidget`）渲染在容器**内部**——输入框里敲 `j/k/g/G/空格/数字/h/l/d/u/H/L` 冒泡上来被 `reduceNavKey` 判为 handled 并 `preventDefault()`，字符写不进搜索框。原守卫只排除 `linkHints.active`，漏了「焦点在可编辑元素」。修法：`onKeyDown` 开头 `if (isEditableTarget(e.target)) return` 让行。`isEditableTarget`（INPUT/TEXTAREA/SELECT/contentEditable）已抽到共享 util `renderer/workbench/domUtils.ts`（原私有于 `useGlobalKeybindingHandler.ts`，两处复用）。**通则**：任何 capture/bubble 阶段接管裸字符键的容器级键盘监听，都要先让可编辑元素通过。测试 `workbench/editor/__tests__/useMarkdownKeyboardNav.test.tsx`。
13. **预览本地文件链接的 `%20` 空格路径**（已修，勿回退）：预览点击 `[x](C:/.../Universe%20Editor/foo.md)` 走 `SafeLink → splitFilePathTarget → useMarkdownFileLink → markdownLinkCandidates`，不是 LSP documentLink；`URI.file()` 吃的是 OS path，不会也不该全局 decode `%20`。修法在 `workbench/markdown/markdownLinkResolve.ts`：对文件路径候选做 `decodeURIComponent`（失败保留原串），解码候选优先、原始候选兜底并去重；`searchPatternFor` 也用解码后的 pattern。不要在 markdown parser 阶段 decode 所有 href，也不要改 `URI.file`，`file:` URL 分支继续靠 `URI.parse`。

14. **拖拽/粘贴成链曾相对工作区根算路径**（已修，勿回退）：`markdownLinksFromUriList` 早期用 `workspaceFolderFsPath`（工作区根）算 `relativePathUnder`，只要目标 Markdown 文件不在工作区根目录（如 `docs/sub/target.md`），生成的链接就照抄"相对根"的相对路径（`docs/a.md`）而非"相对文档自身目录"（`../a.md`），打开必 404。**图片二进制落盘分支从没这个问题**——`saveDroppedImageAsset` 一直用 `dirOf(mdFileUri)`（文档自身目录）算 `assets/` 路径，只有 uri-list→链接这条分支漏了。修法：`computeMarkdownLinkInsert` 里用 `dirname(mdUri.fsPath)` 算出目标文档目录，传给 `markdownLinksFromUriList`；后者改用 `relativePath`（platform `base/path.ts`，允许 `../` 向上爬）取代 `relativePathUnder`（只能处理"在根目录之下"，爬不出去返回 `null`）。`workspaceFolderFsPath` 现在只在 `mdUri` 解析失败时兜底。测试见 `markdownLinkProviderShared.test.ts`（跨目录/多级 `../` 用例）+ `markdownPasteLinks.test.ts`。

## 验证

```bash
pnpm --filter @universe-editor/markdown test      # server 单测（symbols/诊断/workspace symbols）
pnpm ext:build                                    # 重建 extensions/markdown dist（改插件/server 后必跑）
pnpm --filter @universe-editor/editor build       # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test specs/smoke.markdownLsp.spec.ts   # 语言特性 e2e（symbols/workspace/定义/documentLink/hover/补全/references/诊断/粘贴成链）
pnpm check                                         # lint+typecheck+test，仅看错误（注：vendor 的 .js.map 缺失告警非失败）
```

相关单测：`contributions/__tests__/markdownPasteLinks.test.ts`（粘贴纯函数 + snippet 占位符）、`markdownLinkProviderShared.test.ts`（drop/paste 共享内核，含目标文档目录 vs 工作区根的相对路径回归）、`markdownAssetLinks.test.ts`（mime→ext/命名/成链 snippet）、`markdownAssetDropper.test.ts`（stub fileService 验证建目录+写字节+相对路径 snippet）、`services/languageFeatures/typescript/__tests__/fileBulkEditService.test.ts`（`applyTextEditsToString` + `stripSnippet` 剥语法降级）、`workbench/editor/__tests__/shouldDeferDropToMarkdownEditor.test.tsx`（drop 双触发/Shift 守卫）、`contributions/__tests__/EditorOpenerContribution.test.ts`（normalizeOpenRange）、`services/extensions/__tests__/PendingDocumentSync.test.ts`（flush 竞态）、`packages/extension-host/src/__tests__/stdoutProtection.test.ts`（stdout 保护）、`services/languageFeatures/typescript/__tests__/lspMonacoConvert.test.ts`（documentLink/highlight/selectionRange/codeAction 转换）。

e2e 探针（`renderer/e2e/probe.ts`）：`getMarkdownDocumentSymbols` / `queryMarkdownWorkspaceSymbols` / `getMarkdownDefinition` / `getMarkdownMarkers(owner:'markdown')` / `getMarkdownDocumentLinks` / `getMarkdownHover` / `getMarkdownCompletions` / `getMarkdownReferences` / `getMarkdownPasteEdit` / `getMarkdownDropEdit`（后者接受 entries：uri-list/text 走 `text`、二进制图片走 `base64`，返回 provider 产出的 snippet 文本，验证落盘）/ `insertMarkdownSnippet`（经 `SnippetController2` 真插入，回读文本+选中文字，验证 `${1:text}` 展开且选中）（多数经 `MonacoLoader.getLanguageFeaturesService()` 读 Monaco 内部 registry）。

## 关键参考路径

- `extensions/markdown/src/extension.ts` —— 插件入口：createMdServer + 全套 provider（13 类）+ server 命令 + 文档同步 + 诊断防抖（零转换透传）
- `extensions/markdown/src/mdFsBridge.ts` —— `IMdClient`：经 workspace.fs 的 gated fs
- `extensions/markdown/esbuild.config.mjs` —— bundle（vscode-uri CJS alias 的坑）
- `extensions/markdown/src/server/mdServer.ts` —— `createMdServer` + `IMdServer`（直返原生 LSP 类型）+ `DIAGNOSTIC_OPTIONS`
- `extensions/markdown/src/server/types.ts` —— `IMdServer`（LSP 返回类型）+ `IMdClient`/`MdFileStat`/`MdFileType`（fs 端口）+ `MdTextDocumentDto`
- `extensions/markdown/src/server/{documentStore,lspWorkspace}.ts` —— overlay + IWorkspace 适配
- `extensions/markdown/src/server/__tests__/mdServer.test.ts` —— server 单测（stub IMdClient 驱动真实 language service）
- `apps/editor/src/renderer/workbench/markdown/MarkdownView.tsx` —— 预览/聊天共享渲染（parseMarkdown AST）
- `apps/editor/src/renderer/services/acp/markdownRenderer.ts` —— `parseMarkdown` 实现
- `apps/editor/src/renderer/workbench/editor/MarkdownPreviewEditor.tsx` + `useMarkdownSyncScroll.ts` —— 预览组件 + 同步滚动
- `apps/editor/src/renderer/services/editor/MarkdownPreviewInput.ts` —— 预览虚拟 input
- `apps/editor/src/renderer/actions/markdownActions.ts` —— 预览命令/键位
- `apps/editor/src/renderer/contributions/markdownPasteLinks.ts` + `markdownAssetLinks.ts` + `markdownAssetDropper.ts` + `markdownLinkProviderShared.ts` —— 线③ 成链纯函数（snippet）+ 落盘 + drop/paste 共享内核
- `apps/editor/src/renderer/services/languageFeatures/typescript/fileBulkEditService.ts` —— IBulkEditService override：跨文件 rename 写盘 + **snippet 插入（`insertAsSnippet`→SnippetController2，成链占位符选中）**
- `apps/editor/src/renderer/contributions/MarkdownPasteContribution.ts` + `MarkdownDropContribution.ts` —— documentPasteEditProvider / documentDropEditProvider 注册（对称）
- `apps/editor/src/renderer/workbench/editor/FileEditor.tsx`（capture-dragover 按 Shift 切 `dropIntoEditor`）+ `EditorGroupView.tsx`（`shouldDeferDropToMarkdownEditor(…, shiftKey)`）—— 线③「Shift 拖入插链接 vs 默认拖入/标签栏打开」的分流 + 防双触发
- `apps/editor/src/renderer/workbench/editor/monaco/MonacoLoader.ts` —— `getLanguageFeaturesService()`：取 Monaco 内部 ILanguageFeaturesService（paste/link/hover/completion/reference registry 唯一入口）
- `apps/editor/src/renderer/contributions/EditorOpenerContribution.ts` —— `normalizeOpenRange`（header-fragment 链接 setSelection 修复）
- `apps/editor/src/renderer/services/extensions/PendingDocumentSync.ts` —— 即时 provider 的「补全前 flush 文档同步防抖」竞态修复
- `packages/extension-host/src/stdoutProtection.ts` —— `protectStdout`：host console→stderr 重定向，保 stdout 纯 RPC 帧
- `apps/editor/e2e/specs/smoke.markdownLsp.spec.ts` —— 语言特性 + 粘贴成链冒烟
- 相关 skill：[extend-language-plugin]（通用语言插件套路）、[typescript-subsystem-context]（TS 子系统对照）

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件
