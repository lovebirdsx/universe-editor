---
name: markdown-subsystem-context
description: 处理 markdown 相关功能时召回，提供整个 markdown 子系统的上下文地图——两条线（语言特性 LSP 线 + 预览渲染线）的文件分布、各环节职责、关键架构决策与「为什么」、与 typescript 内置插件样板的差异。当任务涉及 extensions/markdown 插件、其进程内语言服务（vscode-markdown-languageservice，extensions/markdown/src/server）、markdown 的 symbols/definition/references/workspace-symbols/诊断（坏链检测）、markdown 文档同步、markdown 预览（MarkdownPreviewInput / MarkdownView / sync scroll）、markdown fs 网关（mdFsBridge），或要理解「markdown 能力在本仓库怎么拼起来、和 TS 有什么不一样」时，先读它建立全局认知。它给上下文 + markdown 专属的「改哪里」与坑；语言插件的通用四数据流/句柄路由套路见 [extend-language-plugin]，TS 对照见 [typescript-subsystem-context]。
disable-model-invocation: true
---

# Markdown 子系统 上下文地图

markdown 已是**内置插件** `extensions/markdown`（按 `extend-language-plugin` 的「迁新语言」套路从 TS 样板迁成）。它和 TS 共用同一套**句柄路由 + 四条数据流 + renderer 句柄壳/转换层**——这些**别在这里找差异**，去 [extend-language-plugin]。本 skill 只讲 **markdown 独有的形态**：它和 TS 的不同点、两条线的地图、为什么这么设计。

> ⚠️ 第一原则：先认领你的改动落在**哪条线**——① 语言特性（symbols/定义/引用/诊断，走插件+句柄路由）还是 ② 预览渲染（MarkdownView，纯 renderer，与 LSP/插件无关）。两条线几乎不相交，改错线白改。

## 与 typescript 样板的差异速查（最高优先级）

| 维度 | typescript 插件 | **markdown 插件** |
|---|---|---|
| 语言服务运行方式 | 插件内 **spawn 子进程** `typescript-language-server`（LSP over stdio） | **进程内库调用**：host 是纯 Node，`createMdServer()` 直接在 host 进程里跑 `vscode-markdown-languageservice` + markdown-it，**无子进程、无 stdio** |
| Electron 路径耦合 | 主进程 `tsServerPaths.ts` 解析 cli/tsserver，env 注入 `UNIVERSE_TSLS_*` | **无**。不需要任何主进程路径解析 / env 注入（没有外部二进制） |
| 文件读取 | tsserver 自己读盘 | 经 host 的 **`workspace.fs` 网关**（`mdFsBridge`），受 **path policy** 约束（`.ssh`/`.aws`/`.env` 拒、不得越出 workspace root） |
| 诊断触发 | tsserver PUSH（server 主动推 `publishDiagnostics`） | **debounce-then-pull-then-push**：renderer 文档变 → 插件 200ms 防抖 → `server.$computeDiagnostics(uri)` 主动算 → `diagnosticCollection.set()` 推 |
| wire 类型 | 直接复用 `vscode-languageserver-types`，verbatim 透传 | **同样直接复用 `vscode-languageserver-types`**：进程内 `createMdServer` 直接返回原生 LSP 类型，插件零转换透传给句柄路由（fs 回调端口 `IMdClient` 仍是自定义小接口） |
| 崩溃恢复 | 子进程崩溃要 `_resyncAll` 重推所有 open doc | **不存在**（无子进程，进程内调用不会崩） |
| 额外特性 | 无 | **预览**（VSCode 风 `Open Preview` / `to Side`），TS 没有 |
| 打包 | 插件 dist + tsls node_modules（runtime-resources 带入） | 插件 **dist 自包含**（esbuild bundle 了 `vscode-markdown-languageservice`），无额外 node_modules |

## 线 ①：语言特性（LSP 能力）

数据流完全走 [extend-language-plugin] 的 A/B/C/D 四条，markdown 端的落点：

```
extensions/markdown/src/
  extension.ts     activate：createMdServer(createMdFsBridge(root), root) → 注册 4 类 provider
                   （documentSymbol/definition/references/workspaceSymbol，selector=['markdown']）
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

renderer 侧**完全复用** TS 的句柄路由壳：`MainThreadLanguages`（句柄→Monaco provider、诊断落 marker）、`languageProviderProxy`、`lspMonacoConvert`、通用 `DocumentSyncContribution`（已广播所有语言）。**markdown 不在 renderer 加任何语言特性代码**。

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
services/acp/markdownRenderer.ts     parseMarkdown / MdInline / MdNode —— 与 ACP 聊天共享的 markdown AST
```

input→组件 两处注册（套路见 apps/editor/CLAUDE.md 编辑器输入）：
- `workbench/editor/EditorArea.tsx`：`editorComponentMap.set('markdown.preview', MarkdownPreviewEditor)`
- `contributions/BuiltInEditorProvidersContribution.ts`：注册 `typeId / componentKey:'markdown.preview' / deserialize`

> MarkdownView 是**共享渲染器**（ACP 聊天 + 文档预览都用它）。改它要同时顾及两个消费方；样式靠容器继承字号/色，组件本身不写死。

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

## 易踩坑速记

1. **盘符大小写**（已修，勿回退）：platform `URI.file('C:/…')` 保留大写盘符，Monaco `Uri.parse` 小写化盘符 → 诊断 uri 回来对不上 model registry 的 key。`MainThreadLanguages._setMarkers` **用 `monacoNs.editor.getModel(monacoNs.Uri.parse(resource.toString()))`** 解析（Monaco 自身归一化），不要换回 `MonacoModelRegistry.peek`（精确字符串匹配会 miss）。
2. **二进制 IPC**（已修，全局基建）：`workspace.fs.readFile` 返回 `Uint8Array`，经 platform `ipc.ts` 的 JSON 信封会退化成 0 字节——已由 base64 tag 的 replacer/reviver 修复（`packages/platform/src/ipc/ipc.ts`）。markdown 的 `$readFile` 依赖它；动 ipc 编解码别破坏。
3. **server 直返原生 LSP 类型**：`server/mdServer.ts` 的 `$provide*` 直接返回 `vscode-languageserver-types`，插件 `extension.ts` 零转换透传（与 extension-api 同源，无需 `as`）。加 provider 别再画蛇添足造中间 DTO；唯一规整是 `$provideDefinition` 把 `Definition | undefined` 归一成 `Location[]`。
4. **path policy 会拒读**：预览/诊断读到 `.env`/`.ssh` 或越界路径时 `mdFsBridge` 静默吞成 `undefined`/`[]`（不抛）。排查「某链接诊断不报/预览空」先想是不是被网关挡了。
5. **esbuild 强制 `vscode-uri` 走 CJS**：`vscode-markdown-languageservice` 用 default import，但 vscode-uri 的 ESM 入口只有 named export，esbuild bundle 不了 ESM 版——`esbuild.config.mjs` 里 `alias` 把 `vscode-uri` 指到 CJS 入口（单测同坑，`vitest.config.ts` 里有同样 alias）。动构建/测试配置别删这个 alias。
6. **打包靠自动发现**：`scripts/release/runtime-resources.mjs` 的 `discoverBuiltinExtensions` 扫 `extensions/*` 自动带入，按 `package.json` 的 `files`(`["dist"]`)+`main`。新插件天然纳入，不用改 electron-builder.yml。
7. **预览 input→组件两处必同步**：`EditorArea.tsx` 的 `editorComponentMap` + `BuiltInEditorProvidersContribution.ts`，漏一处预览开不出或恢复不了。

## 验证

```bash
pnpm --filter @universe-editor/markdown test      # server 单测（symbols/诊断/workspace symbols）
pnpm ext:build                                    # 重建 extensions/markdown dist（改插件/server 后必跑）
pnpm --filter @universe-editor/editor build       # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test specs/smoke.markdownLsp.spec.ts   # 语言特性 e2e（symbols/workspace/跨文件定义/诊断）
pnpm check                                         # lint+typecheck+test，仅看错误（注：vendor 的 .js.map 缺失告警非失败）
```

e2e 探针（`renderer/e2e/probe.ts`）：`getMarkdownDocumentSymbols` / `queryMarkdownWorkspaceSymbols` / `getMarkdownDefinition` / `getMarkdownMarkers(owner:'markdown')`。

## 关键参考路径

- `extensions/markdown/src/extension.ts` —— 插件入口：createMdServer + 4 provider + 文档同步 + 诊断防抖（零转换透传）
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
- `apps/editor/e2e/specs/smoke.markdownLsp.spec.ts` —— 语言特性冒烟
- 相关 skill：[extend-language-plugin]（通用语言插件套路）、[typescript-subsystem-context]（TS 子系统对照）

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件
