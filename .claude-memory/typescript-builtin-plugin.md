---
name: typescript-builtin-plugin
description: TypeScript 语言能力已迁为内置插件 extensions/typescript（选项 B 真 VSCode 形态），core 硬编码全删
metadata: 
  node_type: memory
  type: project
  originSessionId: eef1661c-9689-4223-8f94-18e0e7d827db
---

TypeScript 语言能力已从 renderer-core 硬编码 + 主进程 LSP，完整迁移为单个内置插件 `extensions/typescript`（**选项 B 真 VSCode 形态**：LSP server 自 spawn 在 trusted 插件进程内，10 类 provider + 文档同步 + 诊断全部插件内自洽）。Git 之外的第二个真插件。延续 [[extension-system-progress]] 的插件内核。

**最终形态**：
- `extensions/typescript/src/lspClient.ts`：插件内 `vscode-jsonrpc/node.js` + spawn `process.execPath [cli,'--stdio']`（`ELECTRON_RUN_AS_NODE=1` + sanitizeEnv）+ initialize 握手 + 10 类 sendRequest + publishDiagnostics + didOpen/Change/Close + 崩溃重启（MAX_CRASH_RESTARTS=3/60s 窗口，重启后重放 open docs）。
- `extensions/typescript/src/extension.ts`：activate 读 env → new LspClient → 注册 10 类 provider（definition/references/implementation/typeDefinition/hover/completion/signatureHelp/documentSymbol/rename/workspaceSymbol）+ `createDiagnosticCollection('typescript')` + 用 `workspace.textDocuments`/`onDidOpen/Change/Close` 做文档同步。
- **cli/tsserver 路径经 env 注入**（唯一 Electron 耦合留主进程）：`apps/editor/src/main/services/extensionHost/tsServerPaths.ts` 的 `resolveTsServerPaths()`（dev walk-up + packaged resourcesPath）→ `extensionHostMainService.start()` trusted 分支注入 `UNIVERSE_TSLS_CLI`/`UNIVERSE_TSLS_TSSERVER`。注入器作可选构造参（默认 `resolveTsServerPaths`），SyncDescriptor 5 个 leading undefined。
- **provider 注册走句柄路由**（仿 SCM）：host `_providers: Map<handle,{type,provider}>` → `mainThreadLanguages.$registerProvider(handle,type,selector)` → renderer `MainThreadLanguages` 按 `LanguageProviderType` 工厂造 monaco proxy（`languageProviderProxy.ts`）。workspaceSymbol stored-only 不转 monaco。
- wire 类型直接复用 `vscode-languageserver-types`（plain-JSON verbatim，跨 ProxyChannel 零转换）；uri 用 `UriComponents`；position LSP 0-based ↔ monaco 1-based 转换在 `lspMonacoConvert.ts`（**保留**，现由 MainThreadLanguages/proxy/gotoSymbolActions 共用）。

**M5 删除清单（已全删）**：`main/services/typescriptLanguage/` 整目录、`shared/ipc/typescriptLanguageService.ts`、`renderer/.../typescript/typescriptProviders.ts`、`contributions/Typescript{LanguageFeatures,DocumentSync}Contribution.ts` + 注册、`channelNames.ts` 的 `TypescriptLanguage`、main/renderer 各处 `ITypescriptLanguageService` 接线、`perf/marks.ts` 的原型 `tsDef*` 打点。**保留**：`lspMonacoConvert.ts`、`fileBulkEditService.ts`（被 MonacoOverrideServicesContribution 用，不在 typescript 服务链路）、`gotoLocationActions.ts`（F12/Shift+F12，属 workbench）、`vendor/typescript-language-server` + `.runtime-resources`（现由插件用）。

**非显然点**：
- `lspMonacoConvert.ts` 原从 `shared/ipc/typescriptLanguageService.js` 取 LSP 类型（该文件只是 re-export `vscode-languageserver-types`），删除后直接改指向 `vscode-languageserver-types`（含 `LocationLink`）。
- `.tsx` 的 languageId 给 tsserver 必须是 `typescriptreact`/`javascriptreact`（TS_JS_LANGUAGES 4 个）。
- MonacoLoader 里 `setModeConfiguration` 关掉 ts-worker 自带的 diagnostics/completion/hover/... 避免和插件 provider 双注册（注释已更新指向插件）。
- bridge 接口 KEEP IN SYNC 三处：extension-api `IExtensionHostBridge` ↔ apiFactory.ts ↔ ExtensionService 实现。

**验证**：`pnpm check` 全绿（修了 scopedServicesFactory.test 字段数 18→17；extension-api/host 补跑 prettier --fix）；`pnpm ext:build` 出 `extensions/typescript/dist/extension.js`；`pnpm e2e` 73 passed。git `repository.test.ts` 的 remote-state 用例**flaky**（并行高负载偶挂、单独跑全绿、未触碰 git）。`pnpm dev` 真机手测（F12/hover/补全/签名/重命名/Outline/诊断红线）未做。
