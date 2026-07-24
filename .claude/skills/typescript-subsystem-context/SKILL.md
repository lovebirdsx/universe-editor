---
name: typescript-subsystem-context
description: 处理 TypeScript / 语言特性子系统相关功能时自动召回，提供整个子系统的上下文地图——文件分布、各环节职责、关键架构决策与「为什么」、子系统边界、历史演进。当任务涉及 extensions/typescript 插件、typescript-language-server、语言 provider（definition/hover/completion/诊断/rename/outline/codelens 等）、文档同步、LSP↔Monaco 转换、句柄路由、provider→renderer 反向推送、tsserver 路径/env 注入，或要理解「TS 语言能力在本仓库怎么拼起来」时，先读它建立全局认知。它只给上下文与导航；具体改动操作步骤见 extend-language-plugin skill。
disable-model-invocation: true
---

# TypeScript / 语言子系统 上下文地图

> 这是**导航与背景**，不是操作手册。先用它建立全局认知（子系统由哪些部分组成、各自职责、为什么这么设计、边界在哪），再决定动哪里。**具体怎么改**（加 provider 的七步、改 LSP、迁新语言）走 `extend-language-plugin` skill。

## 一句话定位

TypeScript 语言能力 = 一个**内置插件 `extensions/typescript`**（VSCode 原汁原味的「选项 B 真 VSCode 形态」）：插件进程内自 spawn `typescript-language-server`、持有 LSP 客户端，通过 `languages.register*Provider` / `createDiagnosticCollection` / `workspace.onDid*TextDocument` 接入编辑器。**不再有** renderer core 硬编码的 TS provider，也**不再有**主进程 LSP 服务。它是 Git 之外的第二个真插件，跑在 trusted host（无沙箱 Node，可 spawn）。

## 全景文件地图（按位置分组，每行＝职责）

### 插件本体 `extensions/typescript/`
- `src/extension.ts` —— activate 入口：读 env → new LspClient → 注册全部 provider（现 17 类，见 rpc.ts `LanguageProviderType`）+ `createDiagnosticCollection('typescript')` + 文档同步（`workspace.onDidOpen/Change/Close` + 激活时遍历 `workspace.textDocuments` 补 didOpen）。`TS_JS_LANGUAGES` 4 个、补全/签名触发字符常量也在这。**CodeLens 特有**：`registerCodeLensProvider` 的 `onDidChangeCodeLenses` 接一个 `Emitter<void>`（用 `vscode-jsonrpc` 的 `Emitter`，已 bundle），由 `client.onCodeLensRefresh` 驱动。
- `src/lspClient.ts` —— 插件内 LSP 客户端：`spawn(process.execPath, [cli,'--stdio'])`（`ELECTRON_RUN_AS_NODE=1` + `ENV_DENYLIST` sanitize）、`vscode-jsonrpc/node.js` connection、initialize 握手（`initializationOptions.tsserver.path`）、各类 `sendRequest`、`onNotification` publishDiagnostics、didOpen/Change/Close、崩溃重启 + 重推 open docs。**唯一与 tsserver 直接对话的地方**。**CodeLens 特有**：initialize capability 加 `textDocument.codeLens` + `workspace.codeLens.refreshSupport`；握手后发 `workspace/didChangeConfiguration` 开 `typescript/javascript.referencesCodeLens.enabled`（tsserver 默认关，implementations 保持关对齐 VSCode）；`onRequest('workspace/codeLens/refresh')` → ack null + 触发 `onCodeLensRefresh` 回调。
- `package.json` / `esbuild.config.mjs` / `tsconfig.json` —— activationEvents `onLanguage:*`；esbuild bundle `vscode-jsonrpc` + `vscode-languageserver-types`。

### wire 协议 `packages/extensions-common/`
- `src/rpc.ts` —— 三向通道契约：`ExtHostChannels`（`extHostLanguages` / `extHostDocuments` / `mainThreadLanguages`）+ `IExtHostLanguages`（各类 `$provideXxx(handle,…)`；两阶段的还有 `$resolveXxx`：completion / documentLink / **codeLens**）+ `IExtHostDocuments`（`$acceptDocument{Open,Change,Close}`）+ `IMainThreadLanguages`（`$registerProvider` / `$unregisterProvider` / `$publishDiagnostics` / `$clearDiagnostics` / **`$emitCodeLensDidChange`**）+ `LanguageProviderType` 枚举（现 17 种）。**方向注意**：`$provideXxx` 是 renderer→host（extHostLanguages）；`$publishDiagnostics` 与 `$emitCodeLensDidChange` 反向，是 host→renderer（mainThreadLanguages），即 provider PUSH。
- `src/activation.ts` —— `onLanguage:<id>` 激活事件匹配。

### 对外 API `packages/extension-api/`
- `src/index.ts` —— 插件能 import 的 `@universe-editor/extension-api`：`languages`（各类 `registerXxxProvider` + `createDiagnosticCollection`）、`workspace`（`textDocuments` / `onDidOpen/Change/CloseTextDocument` + `TextDocument` 接口，`:157+`）、provider 类型（吃 `TextDocument`+`Position`、返回 LSP 类型）。含 **KEEP IN SYNC 之一** 的 `IExtensionHostBridge`。**版本即 API 版本**：新增 provider（向后兼容）＝ minor bump，须同步 `version` 常量 + `package.json` + 契约测试快照 `__tests__/index.test.ts` 的 `languages` 方法列表（见 COMPATIBILITY.md）。**re-export LSP 类型的坑**：`Command` 与 scm.ts 的 `Command` 重名，CodeLens 无需 re-export 它（`CodeLens` 内部已含 `command` 字段）——re-export 前先查 scm.ts/webview.ts 有无同名。

### extension host 运行时 `packages/extension-host/`
- `src/languageProviderRegistry.ts` —— provider 句柄路由核心：`_providers: Map<handle,{type,provider}>` + `_languageHandle`，每个 `registerXxxProvider` 分配 handle 调 `mainThreadLanguages.$registerProvider`；RPC `provideXxx(handle,…)` 查表调 provider；`createDiagnosticCollection` 实现。**CodeLens 特有**：`registerCodeLensProvider` 不走通用 `_register`（要拿到 handle 接刷新）——内联分配 handle + 订阅 `provider.onDidChangeCodeLenses` → `$emitCodeLensDidChange(handle)`，dispose 时退订 + `$unregisterProvider`。
- `src/extensionService.ts` —— 薄 facade：把 `IExtensionHostBridge` 的 `registerXxx`/`provideXxx` 转发给 `languageProviderRegistry`（+ command/activation/host 句柄）。**KEEP IN SYNC 之三**（实现）。
- `src/apiFactory.ts` —— 造 `@universe-editor/extension-api` 对象喂给插件。**KEEP IN SYNC 之二** 的 `IExtensionHostBridge`。
- `src/bootstrap.ts` —— 接线：把 `extHostLanguages` 每个 `$provideXxx`/`$resolveXxx` 接到 serviceReady + 注册 `extHostLanguages` / `extHostDocuments` channel + 注入 ExtHostDocuments。**加两阶段 provider 时这里也要补 `$resolveXxx` 转发**（易漏，typecheck 会报缺方法）。
- `src/hostDocuments.ts` —— `ExtHostDocuments`：TextDocument 镜像 + `onDidOpen/Change/Close` 事件（`workspace.textDocuments/onDid*` 接它）。

### renderer 基建 `apps/editor/src/renderer/`
- `services/extensions/MainThreadLanguages.ts` —— host→renderer 落点：`$registerProvider` 按 `LanguageProviderType` 选工厂造 Monaco provider → 注册 `ILanguageFeaturesService` → 存 handle→IDisposable；`$publishDiagnostics` → `diagnosticToMarker` + `setModelMarkers(model, owner, …)`。**CodeLens 特有**：`case 'codeLens'` 为该 handle 建 `Emitter<void>`（存进 `_codeLensChange: Map<handle,Emitter>` + store，dispose 时从 map 删）；`$emitCodeLensDidChange(handle)` 查表 `.fire()` 让 Monaco 重取。**反向推送的样板就在这**。
- `services/languageFeatures/languageProviderProxy.ts` —— 一组 `createXxxProxy(handle, extHost)` 工厂，每个 = `monacoPositionToLsp` → `extHostLanguages.$provideXxx` → `xxxToMonaco`。两阶段的（completion/documentLink/**codeLens**）还带 `resolveXxx`，靠给 Monaco 结果挂 `_lspXxx` 原始引用回传给 `$resolveXxx`。**codeLens 特有**：`createCodeLensProxy` 多吃一个 `onDidChange: Event<void>`，挂到 Monaco provider 的 `onDidChange`（Monaco 类型是 `IEvent<this>`，我们的值-less Event 要 `as unknown as` 双 cast）。
- `services/languageFeatures/typescript/lspMonacoConvert.ts` —— **唯一** LSP↔Monaco 转换层（0-based↔1-based、enum 重映射、completion/workspace-edit/diagnostic 整形）。**CodeLens 特有**：`codeLensesToMonaco` / `resolvedCodeLensToMonaco` + `commandToMonaco`——tsserver 的 CodeLens resolve 返回 `editor.action.showReferences` 命令，其 `arguments:[uri,position,locations]` 是 LSP 形，须转 `monaco.Uri`/`{lineNumber,column}`/`locationsToMonaco`（复用现成 peek）；其它命令原样透传。同目录 `__tests__` 是改转换必补的单测。
- `services/languageFeatures/LanguageFeaturesService.ts` —— app 层 facade：`registerXxxProvider` 存镜像表（供 Outline/Ctrl+T 枚举）+ 转发 `monaco.languages.registerXxxProvider`。无枚举消费者的（codeAction/highlight/selectionRange/semanticTokens/**codeLens**）**只转发不镜像**（直接 `MonacoLoader.get().languages.registerCodeLensProvider`）。接口 + 实现两处都要加。
- `services/languageFeatures/typescript/fileBulkEditService.ts` —— 跨文件 rename 写入（被 `MonacoOverrideServicesContribution` 用，**不在** TS 服务链路，但同目录、易混）。
- `contributions/DocumentSyncContribution.ts` —— 通用文档广播：监听**所有文本 model** open/change/close（debounce 200ms + 全文），`activateByEvent('onLanguage:<lang>')` 去重，`extHostDocuments.$acceptDocument*`。
- `services/extensions/HostConnection.ts` —— trusted host 连接：建 `languages`/`documents` extHost 代理 + `new MainThreadLanguages(languages, languageFeatures)` + 注册 channel。
- `services/extensions/ExtensionHostClientService.ts` —— host 生命周期管理（连带回归测试 `__tests__/`）。
- `workbench/editor/monaco/MonacoLoader.ts` —— `disableLanguageDiagnostics()` 关掉 Monaco 自带 ts-worker 的 diagnostics/completion/hover/… 防与插件 provider 双注册。`MonacoLanguageFeaturesService` 窄接口（`getLanguageFeaturesService()` 读它拿 `xxxProvider.ordered(model)`）——加新 provider 类型且 E2E 探针要读其 registry 时，这里补 `readonly xxxProvider` 字段。
- `actions/gotoLocationActions.ts` —— F12/Shift+F12 等导航命令（属 workbench，靠 provider 已注册即可工作；详见 `register-monaco-command` skill）。
- `shared/e2e/contract.ts` + `renderer/e2e/probe.ts` —— E2E 探针契约与实现：语言特性各有一个 `getXxxDebug(uri,…)` 探针，直接调 `features.xxxProvider.ordered(model)[0].provideXxx(...)` 演练全链路（如 `getSemanticTokenDebug` / `getCodeLensDebug`）。加 provider 时照抄一个 probe + 一个 `smoke.tsXxx.spec.ts`（@p1@regression，真起 tsserver）。**注意**：改 probe 后 e2e 跑打包产物、不自动 build，须先 `pnpm build` 再 playwright。

### 主进程（唯一 Electron 耦合）`apps/editor/src/main/`
- `services/extensionHost/tsServerPaths.ts` —— `resolveTsServerSpec(preference, workspaceRoot?)` 返回 `TsServerSpec`（`{kind:'tsls',cli,tsserver}` | `{kind:'native',binary}`）：默认 tsls（dev 从 `app.getAppPath()` walk-up、packaged 从 `process.resourcesPath`）；preference 链（`defaultTsServerPreference`）＝ `UNIVERSE_TSGO_BIN` > `UNIVERSE_TS_SERVER` env > 工作区 `.universe-editor/settings.json` > 工作区 `.vscode/settings.json` > 用户 `<configDir>/settings.json` > 共享 default，层序对齐 renderer `ConfigurationTarget`（Project > VSCodeWorkspace > User），全部 JSONC 解析、每次 spawn 重读；workspaceRoot 由 `start(spec)` 传入（renderer 早就在 spec 里带 `workspace.current?.folder.fsPath`）。dev 下 native 二进制来自根 devDep `@typescript/native-preview` 的平台包（pnpm 下须先 realpath 主包 package.json 再 createRequire 解析兄弟平台包）；packaged 用 `runtime-resources.mjs` 整目录 stage 到 `resources/tsgo/`（exe + 同目录 lib .d.ts + 上一级 package.json 供版本读取，布局同 npm 平台包）。
- `services/extensionHost/extensionHostMainService.ts` —— 启动 trusted host 时按 spec 注入 env：`UNIVERSE_TS_SERVER_KIND` +（tsls）`UNIVERSE_TSLS_CLI`/`UNIVERSE_TSLS_TSSERVER` 或（native）`UNIVERSE_TSGO_BIN`（`:180` 附近）。
- `vendor/typescript-language-server`（submodule）+ `scripts/release/runtime-resources.mjs` —— server 二进制/依赖，打包带入 `.runtime-resources`。

### Go native LSP（tsgo，实验性，2026-07 接入）
- **用法**：默认 **tsls**（共享常量 `apps/editor/src/shared/tsServerImplementation.ts` 的 `DEFAULT_TS_SERVER_IMPLEMENTATION`，main 的回退与 renderer 的 ConfigurationRegistry schema default 同一事实源）；`typescript.server.implementation` 由 **main 直读**（host spawn 时 renderer ConfigurationService 还不存在，无通道可走），分层对齐 renderer：`<workspace>/.universe-editor/settings.json` > `<workspace>/.vscode/settings.json` > `<configDir>/settings.json`，每次 spawn 重读（改配置后 reload window 生效，切工作区各窗口各取各的）；`UNIVERSE_TS_SERVER=native|tsls` env 覆盖全部 settings 层；`UNIVERSE_TSGO_BIN` 显式指二进制最高优先。每次 spawn 打 `[tsServer] kind=… source=…`（source ∈ binary-env/env/workspace/vscode-workspace/user/default），排查"配置没生效"先看这行。packaged 构建同样带 tsgo（找不到二进制才回退 tsls）。探针脚本 `extensions/typescript/lspParityProbe.mjs`（`node lspParityProbe.mjs native|tsls`）可脱离 app 直接对比两个 server 的 LSP 面。
- **实现**：LspClient 构造吃 `TsServerSpec`；native 时直接 spawn 二进制 `--lsp --stdio`（无 ELECTRON_RUN_AS_NODE、无 `initializationOptions.tsserver`、单进程无孤儿 tsserver 问题）。spec 带 `version`（main 读 package.json，tsls=typescript 版本、native=native-preview 版本），经 `UNIVERSE_TS_SERVER_VERSION` env 传入插件。
- **状态栏**：启动中转圈（VSCode parity），ready 后**常驻** `$(pulse)` 图标（error 时 `$(error)`，icon-only 避免与 Editor Language 条目重文），tooltip 报 server 实现 + 版本；文案组装是纯函数 `src/statusIndicator.ts`（`statusBarContent(spec, state)`），e2e 走 `smoke.tsStatusBar.spec.ts`（@serial，双模式断言 tooltip）。
- **实测对等性**（7.0.0-dev.20260707.2）：hover/definition/references/completion/documentSymbol/workspaceSymbol/rename/implementation/typeDefinition/signatureHelp 全部 OK 且亚秒级；outline e2e 比 tsls 快近一倍。**三个缺口及处置**——
  1. **诊断**：不 PUSH `publishDiagnostics`（只推空数组），走 LSP 3.17 **pull**——**已实现**：client 声明 `textDocument.diagnostic` capability，握手后按 `capabilities.diagnosticProvider` 置 `_pullDiagnostics`；didOpen/didChange 后 400ms debounce 发 `textDocument/diagnostic`，报告复用同一 `onDiagnostics` 上抛（带 version），`_connGeneration` 防重启后陈旧报告。探针验证 pull 返回真实错误（"Type 'number' is not assignable..."），push 恒为空属正常。
  2. **CodeLens resolve 的 command 为空**（title 有、"N references" 无命令）——**已实现**：`resolveCodeLens` 遇空 `command.command` 时用 lens.data.uri + range.start 发 `textDocument/references`，客户端合成 `editor.action.showReferences(uri, position, locations)`，下游 `commandToMonaco` 零改动。
  3. **无项目加载 progress**（`$/progress` 不发 "Initializing…" title）——**by design 不修**：ready 状态机靠 2s grace 兜底（native 建项目极快，实际无碍）；未匹配的 progress title 已加 debug 日志便于观察。
  4. **自动 @types 包含（typeRoots 无显式 `types`）与 lib 解析互相破坏**（7.0.0-dev.20260707.2 实测，上游 typescript-go bug）：程序含带 reference 链的 lib（如 `es2021`、或 target 推导的默认 lib）→ 自动包含**整体失效**（@types 一个都不加载，报 TS2591/TS2304/TS2503）；lib 只含叶子项（如 `es2021.weakref`，无 `/// <reference lib>` 链）→ 包声明加载了但入口里的 `/// <reference lib="es2020"/>` 指令**被丢** → 缺 es5 全局类型，每个文件报 TS2318 "Cannot find global type 'Boolean'/'Object'…"。**显式 `types: [...]` 路径完全正常**（含 reference lib 处理）。源文件/`include` 里的 reference lib/path 也正常；workaround ＝ tsconfig 显式写全 `types`（与自动包含等价的包列表）。另：tsgo checker 与 tsc 仍有实现差异（如 EventDefine.ts 巨型计算键接口报 TS2300 ×48、类型打印/建议文案不同），属 dev 阶段未对齐，非本仓库问题。
- semanticTokens legend 的 tokenTypes 为空数组（客户端 `tokenTypes: []` 的应答，与 tsls 同形，解码照常工作）。

## 五条数据流（一句话版，细节见 extend-language-plugin）
- **A provider 调用**：Monaco → proxy → `extHostLanguages.$provideXxx` → host 按 handle 调 provider → 插件 client → tsserver → 原路回 → `xxxToMonaco`。
- **A' 两阶段 resolve**（completion/documentLink/codeLens）：Monaco `resolveXxx` → 用挂在结果上的 `_lspXxx` → `$resolveXxx` → tsserver `xxx/resolve` → 回填字段（如 codeLens 的 `command`）→ 转换。
- **B 文档同步**：Monaco model 变化 → `DocumentSyncContribution` → `extHostDocuments.$acceptDocument*` → `ExtHostDocuments` fire → 插件 `workspace.onDid*` → client did*。
- **C 诊断**（server PUSH，host→renderer）：tsserver → 插件 `client.onDiagnostics` → `diagnosticCollection.set` → `mainThreadLanguages.$publishDiagnostics` → renderer marker。
- **D provider 注册**（句柄路由，仿 SCM）：插件 `register*Provider` → host 分配 handle → `mainThreadLanguages.$registerProvider(handle,type,selector)` → renderer 按 type 造 Monaco proxy。
- **E CodeLens 刷新**（server PUSH，host→renderer；C 之外唯一的反向推送）：tsserver `workspace/codeLens/refresh` → 插件 client `onCodeLensRefresh` → provider `onDidChangeCodeLenses` fire → host 订阅它调 `$emitCodeLensDidChange(handle)` → renderer fire 该 handle 的 Emitter → Monaco 重新走 A。

## 关键架构决策与「为什么」
- **选项 B（LSP 进插件）而非选项 A（LSP 留主进程）**：用户要 VSCode 原汁原味——TS 就是个普通插件，第三方语言插件可复刻该模式。原型期先做过选项 A（LSP 留主进程、provider 绕回 renderer 调主进程服务），证明全链路可行后整体切到 B，删除主进程 `TypescriptLanguageClientService` 与选项 A 逃生舱。
- **句柄路由（仿 SCM `hostScm.ts`/`ScmService.ts`）**：10 类 provider 共用一套 handle 机制 + 一个 proxy 工厂，host 端统一 `_providers` Map，renderer 端按 type 工厂造壳，避免 10 份重复。
- **wire 类型直接复用 `vscode-languageserver-types`**：LSP 类型是 plain-JSON，跨 `ProxyChannel` verbatim、两端共享单一定义、零转换直返；不写中立 DTO。uri 用 `UriComponents`；position 转换只在 `lspMonacoConvert.ts`。
- **Electron 耦合只留主进程，经 env 注入**：host 是纯 Node、不碰 Electron API；唯一需要 Electron 的路径解析留主进程，结果用 `UNIVERSE_TSLS_*` env 传给插件。
- **文档同步做通用**（对标 VSCode ExtHostDocuments）：`DocumentSyncContribution` 广播所有文本 model，不只 TS。
- **KEEP IN SYNC 三处** bridge 接口：extension-api `IExtensionHostBridge` ↔ apiFactory `IExtensionHostBridge` ↔ extensionService 实现，漏一处 typecheck 报错。
- **provider→renderer 反向推送**（诊断、CodeLens 刷新）：绝大多数 provider 是 renderer 拉（flow A）；只有「server 主动说数据变了」才需反向 PUSH。样板＝在 `IMainThreadLanguages` 加一个 `$emitXxx`/`$publishXxx`（host 已持有该 channel），renderer 侧建 per-handle `Emitter` 表接住并 fire。加同类 provider（如 inlay hints 的 `onDidChangeInlayHints`）照此复刻。

## 子系统边界（别误伤）
- **markdown 仍是旧路径**：`services/languageFeatures/markdown/`（独立 LSP 文档同步 + provider，未迁入插件）与 TS 插件**两条道并存**。改 TS 不要动 markdown；若要迁 markdown 成插件，TS 是样板。
- **Git 插件**：`extensions/git/` 是另一个内置插件，但只用 commands/scm，**不碰 provider/document**——别拿它当语言特性样板，拿它当「插件结构/spawn 子进程」样板。
- **Monaco 自带 ts-worker**：已在 `MonacoLoader.disableLanguageDiagnostics` 关掉 diagnostics/completion/hover 等，避免与插件 provider 双注册。新增插件 provider 时确认对应 ts-worker 特性也关了。
- **`fileBulkEditService.ts` / `gotoLocationActions.ts`**：在 TS 目录/相关，但分别属 Monaco override 服务、workbench 命令，**不在** TS 插件服务链路。

## 历史演进（理解现状成因）
1. 最初：TS provider 是 renderer core contribution（`TypescriptLanguageFeaturesContribution` / `TypescriptDocumentSyncContribution`）+ 主进程 `TypescriptLanguageClientService`（LSP）。
2. 原型：选项 A 瘦插件，仅 definition 一类 provider 由插件注册，LSP 仍在主进程（`provideDefinitionFromLsp` 逃生舱），实测三跳延迟。
3. 现状（已完成 M1–M6）：选项 B，全部迁入 `extensions/typescript`，删除 core 硬编码 + 主进程 LSP + 逃生舱。详见 memory `typescript-builtin-plugin`。
4. 后续增量：在既有 17 类 provider 框架上加特性均属「照抄套路」——最近加的 **CodeLens**（references 计数 + 点击弹 peek）是首个引入「两阶段 resolve + 命令参数转换 + provider→renderer 反向刷新」三合一的 provider，是加同类特性（inlay hints 等）的最全样板。

## 验证与参考
- 验证：`pnpm check`（lint+typecheck+test，仅看错误）；改交互链路跑 `pnpm e2e`；逐包顺序 extensions-common → extension-api → extension-host → editor → `pnpm ext:build`。手测：`pnpm dev` → Output「Extension Host」打印插件+tsserver 启动 → F12/hover/补全/诊断红线。
- 配套 skill：**`extend-language-plugin`**（怎么改：加 provider 七步、改 LSP、迁新语言、踩坑速记）、`register-monaco-command`（命令/键位走 Action2）。
- 配套 memory：`typescript-builtin-plugin`（迁移完成记录与决策）、`extension-system-progress`（插件内核全貌）、`scm-submodule-multirepo`（句柄路由的 SCM 蓝本）。

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件
