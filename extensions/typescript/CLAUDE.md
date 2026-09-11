# extensions/typescript/CLAUDE.md

TypeScript 语言能力的内置插件（VSCode「选项 B」形态）：插件进程内自 spawn `typescript-language-server`（或 tsgo native）、持有 LSP 客户端，经 `languages.register*Provider` 接入编辑器。**不再有** renderer core 硬编码 TS provider 与主进程 LSP 服务。本文是 TypeScript / 语言特性子系统的上下文地图；**具体怎么改**（加 provider 七步、改 LSP、迁新语言）走 `extend-language-plugin` skill。

## 五条数据流（细节见 extend-language-plugin）

- **A provider 调用**：Monaco → proxy → `extHostLanguages.$provideXxx` → host 按 handle 调 provider → 插件 client → tsserver → 原路回 → `xxxToMonaco`。
- **A' 两阶段 resolve**（completion/documentLink/codeLens）：Monaco `resolveXxx` → 用挂在结果上的 `_lspXxx` → `$resolveXxx` → `xxx/resolve` → 回填 → 转换。
- **B 文档同步**：Monaco model → `DocumentSyncContribution` → `extHostDocuments.$acceptDocument*` → 插件 `workspace.onDid*` → client did*。
- **C 诊断**（server PUSH，host→renderer）：tsserver → `client.onDiagnostics` → `diagnosticCollection.set` → `mainThreadLanguages.$publishDiagnostics` → marker。
- **D provider 注册**（句柄路由，仿 SCM）：插件 register → host 分配 handle → `$registerProvider(handle,type,selector)` → renderer 按 type 造 Monaco proxy。
- **E CodeLens 刷新**（C 之外唯一反向推送）：tsserver `workspace/codeLens/refresh` → 插件 fire `onDidChangeCodeLenses` → host `$emitCodeLensDidChange(handle)` → renderer 该 handle 的 Emitter fire → Monaco 重走 A。

**反向推送样板**：`IMainThreadLanguages` 加 `$emitXxx`/`$publishXxx`（host 已持 channel），renderer 建 per-handle `Emitter` 表接住。加同类 provider（如 inlay hints 的 onDidChange）照此复刻。

## 文件地图（每行=职责 + 改哪里）

### 插件本体 `extensions/typescript/`
- `src/extension.ts` —— activate：输出通道+logger → 读 env → LspClient → 注册 17 类 provider（rpc.ts `LanguageProviderType`）+ `createDiagnosticCollection('typescript')` + 文档同步（onDidOpen/Change/Close + 激活时补 didOpen）+ 调试命令 `typescript.restartTsServer`/`openTsServerLog`。CodeLens 的 `onDidChangeCodeLenses` 接 `Emitter<void>`（`client.onCodeLensRefresh` 驱动）。**大文件门**：纯装饰性全文件请求按内容长度跳过——semanticTokens >100K（VSCode parity）、documentSymbol >2M（超大 d.ts 会把串行 tsserver 冻死，Outline 绝不能劫持 server）。
- `src/logger.ts` —— 分级日志落「TypeScript」输出通道（**禁止 console.error**，会混进共享「Extension Host」通道）。级别：`UNIVERSE_TS_LOG_LEVEL` env > `js/ts.tsserver.log` 设置；verbose 记 server stderr + 每请求耗时（查「server 被慢请求冻住」第一站）。
- `src/lspClient.ts` —— **唯一与 tsserver 直接对话处**：spawn Electron-as-node + `vscode-jsonrpc` connection + initialize 握手（`initializationOptions.tsserver.path` **Windows 必须 normalize() 成反斜杠**——正斜杠被 TLS 静默回退到工作区 node_modules/typescript，行为/性能对不上，排查史见 [cases-tsserver-investigation.md](cases-tsserver-investigation.md)）。崩溃重启 + 重推 open docs（重放前打 `replaying N open doc(s)`，openDocs 标 `(pinned, project≈X)`）。用户态 `restart()` 优雅停旧进程（stdin EOF 收割 tsserver），不占崩溃预算。**keep-alive pin**：didClose 某项目最后一个 open 文件且无 pin 时转为 pinned（不发 didClose），让崩溃重放能把项目带回来；已有 pin 的项目正常关闭。didOpen/didClose 打 `project≈<tsconfig>` 归属日志（协议拿不到项目名）。**No Project 降级**：tsserver 项目尚未加载时对语义请求回 "No Project."（预期态，非故障），全部语义 provider 统一降级为空结果而不把它抛成 renderer 错误，并在通道打 `no-project degrade <method> <uri> (didOpen/delivered/project≈/openDocs)`——三态即分诊：`didOpen=no` 是我方 document-sync 缺口、`delivered=no` 是握手/重放竞争、两者皆 yes 则是服务端扩展名/tsconfig 归属。CodeLens：initialize capability + `workspace/didChangeConfiguration` 下发 `js/ts.referencesCodeLens.*`/`implementationsCodeLens.*`（默认全关，对齐 VSCode）+ `onRequest('workspace/codeLens/refresh')` 触发刷新。
- `package.json`/`package.nls*.json`/`esbuild.config.mjs` —— activationEvents `onLanguage:*` + 2 调试命令；contributes 8 个 `js/ts.*` 配置项；esbuild bundle `vscode-jsonrpc`+`vscode-languageserver-types`。

### wire 协议 `packages/extensions-common/`
- `src/rpc.ts` —— 三向契约：`extHostLanguages`（`$provideXxx`/`$resolveXxx`）/`extHostDocuments`（`$acceptDocument*`）/`mainThreadLanguages`（`$registerProvider`/`$publishDiagnostics`/`$emitCodeLensDidChange`）+ `LanguageProviderType`（17 种）。方向：provide 是 renderer→host；publish/emit 是 host→renderer（provider PUSH）。
- `src/activation.ts` —— `onLanguage:<id>` 激活事件匹配。

### 对外 API `packages/extension-api/`
- `src/index.ts` —— `languages`（register*Provider + createDiagnosticCollection）、`workspace`（textDocuments/onDid*）。**KEEP IN SYNC 之一** `IExtensionHostBridge`。**版本=App 版本**：新增 provider（向后兼容）=minor bump，同步 `version` + `package.json` + 契约测试快照 `__tests__/index.test.ts`（见 COMPATIBILITY.md）。re-export LSP 类型前先查 scm.ts/webview.ts 有无同名（`Command` 重名）。

### extension host `packages/extension-host/`
- `src/languageProviderRegistry.ts` —— 句柄路由核心：`_providers: Map<handle,{type,provider}>`，register 分配 handle → `$registerProvider`。CodeLens 不走通用 `_register`（要 handle 接刷新）：内联分配 + 订阅 `onDidChangeCodeLenses` → `$emitCodeLensDidChange`。
- `src/extensionService.ts` —— 薄 facade 转发给 registry（**KEEP IN SYNC 之三**）。
- `src/apiFactory.ts` —— 造 extension-api 对象（**KEEP IN SYNC 之二**）。
- `src/bootstrap.ts` —— `$provideXxx`/`$resolveXxx` 接线 + 注册 channels。**加两阶段 provider 时补 `$resolveXxx` 转发**（易漏，typecheck 报缺方法）。
- `src/hostDocuments.ts` —— `ExtHostDocuments`：TextDocument 镜像 + 事件（`workspace.textDocuments/onDid*` 接它）。

### renderer `apps/editor/src/renderer/`
- `services/extensions/MainThreadLanguages.ts` —— host→renderer 落点：按 type 工厂造 Monaco provider → `ILanguageFeaturesService` → handle→IDisposable；`$publishDiagnostics` → `diagnosticToMarker` + `setModelMarkers`。CodeLens：per-handle `Emitter`（`_codeLensChange` map）+ `$emitCodeLensDidChange` fire。
- `services/languageFeatures/languageProviderProxy.ts` —— `createXxxProxy(handle, extHost)` 工厂（monacoPositionToLsp → provide → xxxToMonaco）；两阶段带 resolveXxx（结果挂 `_lspXxx` 回传）。codeLens proxy 多吃 `onDidChange: Event<void>`。
- `services/languageFeatures/typescript/lspMonacoConvert.ts` —— **唯一** LSP↔Monaco 转换层（0/1-based、enum 重映射、diagnostic/workspace-edit 整形）。CodeLens：tsserver resolve 返回 `editor.action.showReferences`，其 `arguments:[uri,position,locations]` 是 LSP 形须转 Monaco；其它命令透传。`__tests__` 是改转换必补的单测。
- `services/languageFeatures/LanguageFeaturesService.ts` —— facade：register 存镜像表（Outline/Ctrl+T 枚举）+ 转发 monaco；无枚举消费者的（codeAction/highlight/selectionRange/semanticTokens/codeLens）只转发不镜像。接口+实现两处都要加。
- `services/languageFeatures/typescript/fileBulkEditService.ts` —— 跨文件 rename 写入（**不在** TS 服务链路，同目录易混）。
- `contributions/DocumentSyncContribution.ts` —— 通用文档广播：监听所有 text model（debounce 200ms），`activateByEvent('onLanguage:<lang>')` 去重，`extHostDocuments.$acceptDocument*`。
- `services/extensions/HostConnection.ts` + `ExtensionHostClientService.ts` —— trusted host 连接：languages/documents extHost 代理 + `MainThreadLanguages` 注册。
- `workbench/editor/monaco/MonacoLoader.ts` —— `disableLanguageDiagnostics()` 关 Monaco 自带 ts-worker 防双注册。加新 provider 类型且 E2E 探针要读 registry 时补 `readonly xxxProvider` 字段。
- `actions/gotoLocationActions.ts` —— F12/Shift+F12 等导航命令（workbench，靠 provider 已注册即可工作；`register-monaco-command` skill）。
- `shared/e2e/contract.ts` + `renderer/e2e/probe.ts` —— 语言特性 `getXxxDebug(uri,…)` 探针直调 provider 演练全链路；加 provider 照抄 probe + `smoke.tsXxx.spec.ts`（@p1@regression，真起 tsserver）。**改 probe 后 e2e 跑打包产物，须先 `pnpm build`**。

### 主进程（唯一 Electron 耦合）`apps/editor/src/main/`
- `services/extensionHost/tsServerPaths.ts` —— `resolveTsServerSpec(preference, workspaceRoot?)` → `{kind:'tsls'|'native',…}`；preference 链：`UNIVERSE_TSGO_BIN` > `UNIVERSE_TS_SERVER` env > 工作区 `.universe-editor/settings.json` > `.vscode/settings.json` > 用户 `<configDir>/settings.json` > default，每次 spawn 重读、JSONC 解析。dev 下 native 来自 devDep `@typescript/native-preview`（pnpm 先 realpath 再 createRequire）；packaged 用 `runtime-resources.mjs` stage 到 `resources/tsgo/`。
- `services/extensionHost/extensionHostMainService.ts` —— spawn trusted host 时注入 env：`UNIVERSE_TS_SERVER_KIND` + tsls `UNIVERSE_TSLS_CLI/TSSERVER` 或 native `UNIVERSE_TSGO_BIN`。
- `vendor/typescript-language-server`（submodule）+ `scripts/release/runtime-resources.mjs` —— server 二进制打包带入 `.runtime-resources`。

### tsgo（Go native LSP，实验性）
- **用法**：默认 tsls（`DEFAULT_TS_SERVER_IMPLEMENTATION` 是 main 回退与 renderer schema default 的同一事实源）；`js/ts.experimental.useTsgo` 由 **main 直读**（spawn 时 renderer ConfigurationService 不存在），分层同上，改配置 reload 生效；`UNIVERSE_TS_SERVER=native|tsls` 覆盖全部层、`UNIVERSE_TSGO_BIN` 最高优先。每次 spawn 打 `[tsServer] kind=… source=…`（source ∈ binary-env/env/workspace/vscode-workspace/user/default），排查「配置没生效」先看这行。探针 `lspParityProbe.mjs` 可脱离 app 对比两 server。
- **实现**：LspClient 吃 `TsServerSpec`；native 直接 spawn `--lsp --stdio`（无 ELECTRON_RUN_AS_NODE、无 initializationOptions.tsserver、无孤儿 tsserver）。
- **状态栏**：启动转圈，ready 后常驻 `$(bracket)`（error `$(error)`；不用 `$(pulse)`——与性能警告撞图标）；文案纯函数 `src/statusIndicator.ts`；e2e `smoke.tsStatusBar.spec.ts`。
- **实测缺口及处置**：① 诊断走 LSP 3.17 **pull**——已实现（`textDocument.diagnostic` capability + 400ms debounce + `_connGeneration` 防陈旧；push 恒空数组属正常）。② CodeLens resolve 的 command 为空——已实现（客户端用 lens.data.uri+range 发 `textDocument/references` 合成 `editor.action.showReferences`，`commandToMonaco` 零改动）。③ 无项目加载 progress——by design 不修（2s grace 兜底）。④ **自动 @types 包含与 reference lib 互相破坏**（上游 typescript-go bug）：含 reference 链的 lib → 自动包含整体失效；叶子 lib → 入口 `/// <reference lib>` 被丢（TS2318 满屏）。**workaround：tsconfig 显式写全 `types`**。另 tsgo checker 与 tsc 仍有实现差异，属上游未对齐。

### 边界（别误伤）
- **markdown 仍走旧路径**（`services/languageFeatures/markdown/`，独立 LSP 同步 + provider 未迁入插件）——两条道并存，改 TS 别动 markdown。
- **Git 插件**只用 commands/scm 不碰 provider/document——别当语言特性样板。
- **Monaco 自带 ts-worker** 已在 `MonacoLoader` 关闭，新增 provider 时确认对应特性也关了。
- `fileBulkEditService.ts` / `gotoLocationActions.ts` 在 TS 目录但属 Monaco override / workbench 命令，不在 TS 插件链路。

## 关键架构决策（为什么）

- **选项 B（LSP 进插件）非选项 A**：用户要 VSCode 原汁原味——TS 是普通插件，第三方语言插件可复刻。原型期选项 A 验证可行后整体切 B（已删主进程 `TypescriptLanguageClientService` 与逃生舱）。
- **句柄路由仿 SCM**：17 类 provider 共用一套 handle + proxy 工厂，避免 N 份重复。
- **wire 类型直接复用 `vscode-languageserver-types`**：plain-JSON 跨 ProxyChannel verbatim；uri 用 `UriComponents`；position 转换只在 `lspMonacoConvert.ts`。
- **Electron 耦合只留主进程，经 env 注入**：host 纯 Node 不碰 Electron API。
- **KEEP IN SYNC 三处**：extension-api ↔ apiFactory ↔ extensionService 的 `IExtensionHostBridge`，漏一处 typecheck 报错。

## 历史与排查

- 演进史：renderer core contribution + 主进程 LSP → 选项 A 原型 → 选项 B 全迁入 `extensions/typescript`（M1–M6），见 memory `typescript-builtin-plugin`。后续增量均「照抄套路」——**CodeLens** 是首个「两阶段 resolve + 命令参数转换 + 反向刷新」三合一的 provider，是加同类特性（inlay hints 等）的最全样板。
- 大型 depot 工程排查实录（didOpen 超大 d.ts 转圈 60-90s、正斜杠回退 bug、close 不卸载纠偏、keep-alive pin 背景）见 [cases-tsserver-investigation.md](cases-tsserver-investigation.md)。

## 验证与参考

- 验证：`pnpm check`；改交互链路跑 `pnpm e2e`；逐包顺序 extensions-common → extension-api → extension-host → editor → `pnpm ext:build`。手测：`pnpm dev` → Output「TypeScript」通道打启动日志 → F12/hover/补全/诊断红线。
- 配套 skill：`extend-language-plugin`（怎么改）、`register-monaco-command`。
- 配套 memory：`typescript-builtin-plugin`、`extension-system-progress`、`scm-submodule-multirepo`（句柄路由 SCM 蓝本）。

## 其它

- 后续发现新经验，同步更新本文件。
