---
name: typescript-subsystem-context
description: 处理 TypeScript / 语言特性子系统相关功能时自动召回，提供整个子系统的上下文地图——文件分布、各环节职责、关键架构决策与「为什么」、子系统边界、历史演进。当任务涉及 extensions/typescript 插件、typescript-language-server、语言 provider（definition/hover/completion/诊断/rename/outline 等）、文档同步、LSP↔Monaco 转换、句柄路由、tsserver 路径/env 注入，或要理解「TS 语言能力在本仓库怎么拼起来」时，先读它建立全局认知。它只给上下文与导航；具体改动操作步骤见 extend-language-plugin skill。
disable-model-invocation: true
---

# TypeScript / 语言子系统 上下文地图

> 这是**导航与背景**，不是操作手册。先用它建立全局认知（子系统由哪些部分组成、各自职责、为什么这么设计、边界在哪），再决定动哪里。**具体怎么改**（加 provider 的七步、改 LSP、迁新语言）走 `extend-language-plugin` skill。

## 一句话定位

TypeScript 语言能力 = 一个**内置插件 `extensions/typescript`**（VSCode 原汁原味的「选项 B 真 VSCode 形态」）：插件进程内自 spawn `typescript-language-server`、持有 LSP 客户端，通过 `languages.register*Provider` / `createDiagnosticCollection` / `workspace.onDid*TextDocument` 接入编辑器。**不再有** renderer core 硬编码的 TS provider，也**不再有**主进程 LSP 服务。它是 Git 之外的第二个真插件，跑在 trusted host（无沙箱 Node，可 spawn）。

## 全景文件地图（按位置分组，每行＝职责）

### 插件本体 `extensions/typescript/`
- `src/extension.ts` —— activate 入口：读 env → new LspClient → 注册 10 类 provider + `createDiagnosticCollection('typescript')` + 文档同步（`workspace.onDidOpen/Change/Close` + 激活时遍历 `workspace.textDocuments` 补 didOpen）。`TS_JS_LANGUAGES` 4 个、补全/签名触发字符常量也在这。
- `src/lspClient.ts` —— 插件内 LSP 客户端：`spawn(process.execPath, [cli,'--stdio'])`（`ELECTRON_RUN_AS_NODE=1` + `ENV_DENYLIST` sanitize）、`vscode-jsonrpc/node.js` connection、initialize 握手（`initializationOptions.tsserver.path`）、10 类 `sendRequest`、`onNotification` publishDiagnostics、didOpen/Change/Close、崩溃重启 + 重推 open docs。**唯一与 tsserver 直接对话的地方**。
- `package.json` / `esbuild.config.mjs` / `tsconfig.json` —— activationEvents `onLanguage:*`；esbuild bundle `vscode-jsonrpc` + `vscode-languageserver-types`。

### wire 协议 `packages/extensions-common/`
- `src/rpc.ts` —— 三向通道契约：`ExtHostChannels`（`extHostLanguages` / `extHostDocuments` / `mainThreadLanguages`）+ `IExtHostLanguages`（10 类 `$provideXxx(handle,…)`，`:247+`）+ `IExtHostDocuments`（`$acceptDocument{Open,Change,Close}`）+ `IMainThreadLanguages`（`$registerProvider` / `$unregisterProvider` / `$publishDiagnostics` / `$clearDiagnostics`）+ `LanguageProviderType` 枚举（10 种，`:199`）。
- `src/activation.ts` —— `onLanguage:<id>` 激活事件匹配。

### 对外 API `packages/extension-api/`
- `src/index.ts` —— 插件能 import 的 `@universe-editor/extension-api`：`languages`（10 类 `registerXxxProvider` + `createDiagnosticCollection`）、`workspace`（`textDocuments` / `onDidOpen/Change/CloseTextDocument` + `TextDocument` 接口，`:157+`）、provider 类型（吃 `TextDocument`+`Position`、返回 LSP 类型）。含 **KEEP IN SYNC 之一** 的 `IExtensionHostBridge`。

### extension host 运行时 `packages/extension-host/`
- `src/extensionService.ts` —— provider 句柄路由核心：`_providers: Map<handle,{type,provider}>` + `_nextHandle`，每个 `registerXxxProvider` 分配 handle 调 `mainThreadLanguages.$registerProvider`；RPC `provideXxx(handle,…)` 查表调 provider；`createDiagnosticCollection` 实现。**KEEP IN SYNC 之三**（实现）。
- `src/apiFactory.ts` —— 造 `@universe-editor/extension-api` 对象喂给插件。**KEEP IN SYNC 之二** 的 `IExtensionHostBridge`。
- `src/hostDocuments.ts` —— `ExtHostDocuments`：TextDocument 镜像 + `onDidOpen/Change/Close` 事件（`workspace.textDocuments/onDid*` 接它）。
- `src/bootstrap.ts` —— 接线：`mainThreadLanguages` client + 注册 `extHostLanguages` / `extHostDocuments` channel + 注入 ExtHostDocuments。

### renderer 基建 `apps/editor/src/renderer/`
- `services/extensions/MainThreadLanguages.ts` —— host→renderer 落点：`$registerProvider` 按 `LanguageProviderType` 选工厂造 Monaco provider → 注册 `ILanguageFeaturesService` → 存 handle→IDisposable；`$publishDiagnostics` → `diagnosticToMarker` + `setModelMarkers(model, owner, …)`。
- `services/languageFeatures/languageProviderProxy.ts` —— 一组 `createXxxProxy(handle, extHost)` 工厂，每个 = `monacoPositionToLsp` → `extHostLanguages.$provideXxx` → `xxxToMonaco`。
- `services/languageFeatures/typescript/lspMonacoConvert.ts` —— **唯一** LSP↔Monaco 转换层（0-based↔1-based、enum 重映射、completion/workspace-edit/diagnostic 整形）。同目录 `__tests__` 是改转换必补的单测。
- `services/languageFeatures/typescript/fileBulkEditService.ts` —— 跨文件 rename 写入（被 `MonacoOverrideServicesContribution` 用，**不在** TS 服务链路，但同目录、易混）。
- `contributions/DocumentSyncContribution.ts` —— 通用文档广播：监听**所有文本 model** open/change/close（debounce 200ms + 全文），`activateByEvent('onLanguage:<lang>')` 去重，`extHostDocuments.$acceptDocument*`。
- `services/extensions/HostConnection.ts` —— trusted host 连接：建 `languages`/`documents` extHost 代理 + `new MainThreadLanguages(languages, languageFeatures)` + 注册 channel。
- `services/extensions/ExtensionHostClientService.ts` —— host 生命周期管理（连带回归测试 `__tests__/`）。
- `workbench/editor/monaco/MonacoLoader.ts` —— `disableLanguageDiagnostics()` 关掉 Monaco 自带 ts-worker 的 diagnostics/completion/hover/… 防与插件 provider 双注册。
- `actions/gotoLocationActions.ts` —— F12/Shift+F12 等导航命令（属 workbench，靠 provider 已注册即可工作；详见 `register-monaco-command` skill）。

### 主进程（唯一 Electron 耦合）`apps/editor/src/main/`
- `services/extensionHost/tsServerPaths.ts` —— `resolveTsServerPaths()`：dev 从 `app.getAppPath()` walk-up、packaged 从 `process.resourcesPath` 算 `{cli, tsserver}`。
- `services/extensionHost/extensionHostMainService.ts` —— 启动 trusted host 时注入 `env.UNIVERSE_TSLS_CLI` / `UNIVERSE_TSLS_TSSERVER`（`:180` 附近）。
- `vendor/typescript-language-server`（submodule）+ `scripts/release/runtime-resources.mjs` —— server 二进制/依赖，打包带入 `.runtime-resources`。

## 四条数据流（一句话版，细节见 extend-language-plugin）
- **A provider 调用**：Monaco → proxy → `extHostLanguages.$provideXxx` → host 按 handle 调 provider → 插件 client → tsserver → 原路回 → `xxxToMonaco`。
- **B 文档同步**：Monaco model 变化 → `DocumentSyncContribution` → `extHostDocuments.$acceptDocument*` → `ExtHostDocuments` fire → 插件 `workspace.onDid*` → client did*。
- **C 诊断**（server PUSH）：tsserver → 插件 `client.onDiagnostics` → `diagnosticCollection.set` → `mainThreadLanguages.$publishDiagnostics` → renderer marker。
- **D provider 注册**（句柄路由，仿 SCM）：插件 `register*Provider` → host 分配 handle → `mainThreadLanguages.$registerProvider(handle,type,selector)` → renderer 按 type 造 Monaco proxy。

## 关键架构决策与「为什么」
- **选项 B（LSP 进插件）而非选项 A（LSP 留主进程）**：用户要 VSCode 原汁原味——TS 就是个普通插件，第三方语言插件可复刻该模式。原型期先做过选项 A（LSP 留主进程、provider 绕回 renderer 调主进程服务），证明全链路可行后整体切到 B，删除主进程 `TypescriptLanguageClientService` 与选项 A 逃生舱。
- **句柄路由（仿 SCM `hostScm.ts`/`ScmService.ts`）**：10 类 provider 共用一套 handle 机制 + 一个 proxy 工厂，host 端统一 `_providers` Map，renderer 端按 type 工厂造壳，避免 10 份重复。
- **wire 类型直接复用 `vscode-languageserver-types`**：LSP 类型是 plain-JSON，跨 `ProxyChannel` verbatim、两端共享单一定义、零转换直返；不写中立 DTO。uri 用 `UriComponents`；position 转换只在 `lspMonacoConvert.ts`。
- **Electron 耦合只留主进程，经 env 注入**：host 是纯 Node、不碰 Electron API；唯一需要 Electron 的路径解析留主进程，结果用 `UNIVERSE_TSLS_*` env 传给插件。
- **文档同步做通用**（对标 VSCode ExtHostDocuments）：`DocumentSyncContribution` 广播所有文本 model，不只 TS。
- **KEEP IN SYNC 三处** bridge 接口：extension-api `IExtensionHostBridge` ↔ apiFactory `IExtensionHostBridge` ↔ extensionService 实现，漏一处 typecheck 报错。

## 子系统边界（别误伤）
- **markdown 仍是旧路径**：`services/languageFeatures/markdown/`（独立 LSP 文档同步 + provider，未迁入插件）与 TS 插件**两条道并存**。改 TS 不要动 markdown；若要迁 markdown 成插件，TS 是样板。
- **Git 插件**：`extensions/git/` 是另一个内置插件，但只用 commands/scm，**不碰 provider/document**——别拿它当语言特性样板，拿它当「插件结构/spawn 子进程」样板。
- **Monaco 自带 ts-worker**：已在 `MonacoLoader.disableLanguageDiagnostics` 关掉 diagnostics/completion/hover 等，避免与插件 provider 双注册。新增插件 provider 时确认对应 ts-worker 特性也关了。
- **`fileBulkEditService.ts` / `gotoLocationActions.ts`**：在 TS 目录/相关，但分别属 Monaco override 服务、workbench 命令，**不在** TS 插件服务链路。

## 历史演进（理解现状成因）
1. 最初：TS provider 是 renderer core contribution（`TypescriptLanguageFeaturesContribution` / `TypescriptDocumentSyncContribution`）+ 主进程 `TypescriptLanguageClientService`（LSP）。
2. 原型：选项 A 瘦插件，仅 definition 一类 provider 由插件注册，LSP 仍在主进程（`provideDefinitionFromLsp` 逃生舱），实测三跳延迟。
3. 现状（已完成 M1–M6）：选项 B，全部迁入 `extensions/typescript`，删除 core 硬编码 + 主进程 LSP + 逃生舱。详见 memory `typescript-builtin-plugin`。

## 验证与参考
- 验证：`pnpm check`（lint+typecheck+test，仅看错误）；改交互链路跑 `pnpm e2e`；逐包顺序 extensions-common → extension-api → extension-host → editor → `pnpm ext:build`。手测：`pnpm dev` → Output「Extension Host」打印插件+tsserver 启动 → F12/hover/补全/诊断红线。
- 配套 skill：**`extend-language-plugin`**（怎么改：加 provider 七步、改 LSP、迁新语言、踩坑速记）、`register-monaco-command`（命令/键位走 Action2）。
- 配套 memory：`typescript-builtin-plugin`（迁移完成记录与决策）、`extension-system-progress`（插件内核全貌）、`scm-submodule-multirepo`（句柄路由的 SCM 蓝本）。

## 其它
- 这是「地图」，会随子系统演进过时——引用某文件/行号前，若与现状不符以代码为准，并顺手更新本 skill。
