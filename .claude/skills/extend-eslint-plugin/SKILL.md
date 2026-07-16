---
name: extend-eslint-plugin
description: 在 ESLint 外置插件（extensions-external/eslint，以 .vsix 经市场/本地安装，不在 pnpm workspace 内）里开发或调试 ESLint 相关功能时召回。当用户说「给 ESLint 插件加/改功能（诊断、quickfix、fixAll、disable 注释、格式化、保存时修复、规则文档链接）」「ESLint 波浪线/快速修复不出现或要调」「改 ESLint LSP server 的 spawn/协议/settings」「ESLint 用错了 eslint 版本 / 解析不到工作区 eslint」「加新的 ESLint 配置项 / 命令 / 语言支持」「让保存时自动 fix / 作为格式化器运行不生效」「打包/发布 ESLint 扩展成 vsix」时使用。区别于 extend-language-plugin（typescript 那套句柄 provider 路由 + 标准 LSP）——ESLint 用的是**自定义精简协议 + 单进程 server + code action 全走 edit-based**，且依赖两条 0.4.0 新增门面能力（onWillSaveTextDocument / registerDocumentFormattingEditProvider）。
disable-model-invocation: true
---

# 在 ESLint 外置插件里开发/调试功能

`extensions-external/eslint` 是对等 vscode-eslint 的**外置插件**（以 `.vsix` 经市场/本地安装，**不在 pnpm workspace 内**，对齐 `extensions-external/pdf`），**独立 LSP server 架构**：client 跑在扩展宿主内，server 是宿主 spawn 的 Electron-as-node 子进程，两者用**自定义精简协议**（非标准 LSP 全集）over stdio 通信。server 在运行时解析**工作区自己的 eslint**（`node_modules` 里那份，绝不打包），把 ESLint 的 offset-based 结果映射成 LSP 诊断 / TextEdit。

> ⚠️ 第一原则：ESLint 插件**不复用** typescript 的句柄 provider 路由和标准 LSP。它走 `languages.registerCodeActionsProvider` + `createDiagnosticCollection` 这类**通用门面**，加上两条 0.4.0 才有的门面能力。改之前先认清你要动的是 **client（宿主内 wiring）** 还是 **server（ESLint 交互 + 协议）**。

## 拓扑

```
extension host (client: EslintClient)  ──自定义协议 over stdio (vscode-jsonrpc)──  eslint server 子进程
   │  spawn(process.execPath, [dist/server.js], ELECTRON_RUN_AS_NODE=1)              └─ require(工作区/node_modules/eslint) 运行时解析
   │
   ├─ languages.createDiagnosticCollection('eslint')      ← server PUSH 诊断
   ├─ languages.registerCodeActionsProvider              ← quickfix/suggestion/disable/fixAll（全 edit-based）
   ├─ commands.registerCommand(eslint.executeAutofix/restart/showOutputChannel)
   ├─ languages.registerDocumentFormattingEditProvider   ← 门面能力 A（0.4.0）：格式化=fixAll，默认关
   └─ workspace.onWillSaveTextDocument                   ← 门面能力 B（0.4.0）：保存时 fixAll，默认关
```

- **两个 bundle**：`esbuild.config.mjs` 出 `dist/extension.js`（client）+ `dist/server.js`（server），server 把 `eslint` 标 `external`（运行时 require 工作区的）。
- server 是**单进程**（不像 typescript 每语言一个），按文件目录缓存不同 ESLint 构造器（monorepo 多份 eslint）。

## 文件清单（extensions-external/eslint/src/）

| 文件 | 职责 | 何时改 |
|---|---|---|
| `protocol.ts` | client↔server 全部方法名 + DTO（`EslintMethods` / `EslintSettings` / `EslintCodeAction` / `CodeActionKinds`）| 加/改跨进程消息时**第一站**，两端共享单一定义 |
| `server.ts` | LSP 传输 + `EslintServer` 类：onNotification/onRequest 分发、open-doc 存储、按目录缓存 ctor | 改分发逻辑、settings 响应、lint 触发时机 |
| `eslintRunner.ts` | **纯逻辑**（无进程/传输）：`resolveEslintConstructor` / `lintDocument` / `buildCodeActions` / `computeFixAll` / uri 工具 | 改 ESLint→LSP 映射、code action 生成、fixAll 算法（**有单测，先写测试**） |
| `textUtils.ts` | `LineIndex`：offset↔0-based position（ESLint 用 offset，LSP 用 line/char）| 改坐标换算（有单测） |
| `eslintClient.ts` | 宿主内：spawn server、崩溃重启、转发 didOpen/Change/Save/Close、发 codeAction/fixAll 请求 | 改 spawn/env、重启策略、请求方法 |
| `extension.ts` | activate：读 settings、建 client、注册诊断/codeAction/命令/格式化/保存钩子 | 改注册什么、settings 读取、语言列表 |

## 关键约定（与 typescript 插件的差异点）

### 1. code action 全走 **edit-based**，不碰 `.command`
`renderer` 的 `codeActionsToMonaco`（`lspMonacoConvert.ts`）转 `a.edit` 但**不转 `a.command`**。所以 ESLint 的 quickfix / fixAll / disable 全部返回 `edit: { changes: { [uri]: TextEdit[] } }`（`edit.changes` 形式，`workspaceEditToMonaco` 支持）。**绝不要**用 command 路由做 code action，会静默失效。

### 2. 规则文档链接走 **diagnostic.codeDescription**，不做 command
「打开规则文档」不是 code action，而是诊断带 `codeDescription.href`（LSP 3.16）。`diagnosticToMarker`（`lspMonacoConvert.ts`）已把它转成 Monaco marker 的 `code: { value, target }`，渲染成可点击链接。server 端在 `toDiagnostic` 里从 `getRulesMetaForResults()[ruleId].docs.url` 填 href。

### 3. 依赖两条门面能力（若被删/改需连带修）
- **A. `languages.registerDocumentFormattingEditProvider`**（0.4.0）：格式化=`computeFixAll` 的全文替换编辑。
- **B. `workspace.onWillSaveTextDocument`**（0.4.0）：保存前 `waitUntil(fixAllEdits)`。renderer 侧链路 = `FileEditorInput.save()` → 静态 `SaveParticipant.participate` → `WillSaveParticipantContribution`（先 flush `PendingDocumentSync` 再调受信 host `$provideWillSaveEdits`，全文编辑单 undo 步应用）。
- 这两条能力的全链路 KEEP IN SYNC 三处同 extend-language-plugin（extension-api ↔ apiFactory ↔ extensionService）+ rpc.ts + renderer proxy/MainThread。详见该 skill。

### 4. fixAll = **单个全文替换编辑**
`computeFixAll` 跑 `new ESLint({...opts, fix:true}).lintText()` 取 `results[0].output`，与原文不同则返回**一个覆盖全文的 TextEdit**（`LineIndex.fullRange()`）。映射平凡、Monaco 合成单 undo 步。别拆成多个 hunk 编辑。

### 5. 运行时解析工作区 eslint（核心！）
`resolveEslintConstructor(fileDir)` 用 `createRequire(pathToFileURL(fileDir/__resolve__.js))` + `require.resolve('eslint')` 从**被检查文件所在目录**解析。工作区没装 eslint → 返回 undefined → 该文件**安静不工作**（对齐 vscode-eslint「no ESLint library」降级），不抛错。esbuild 必须把 `eslint` 标 external。

### 6. spawn 套路照抄 typescript 的 lspClient
`process.execPath [dist/server.js]` + `ELECTRON_RUN_AS_NODE=1` + `ENV_DENYLIST` sanitize + `guardedWritable(stdin)` + 崩溃重启（`MAX_CRASH_RESTARTS`/`CRASH_WINDOW_MS`）+ 重启后重推 open docs。server 路径用 `context.extensionPath + '/dist/server.js'`（**不需要**主进程 env 注入，不像 tsserver 要 UNIVERSE_TSLS_*）。

### 7. settings 是异步读的，无 onDidChangeConfiguration
门面 `workspace.getConfiguration('eslint').get(key, default)` 返回 Promise。activate 时一次性读齐 `EslintSettings` 传给 client/server。**没有**配置变更事件——`eslint.restart` 命令重启 server 是重读 settings 的途径。

## 常见任务 → 改哪里

### 任务 1：加一类新 code action（如「disable for entire file」「fix all of this rule」）
纯逻辑，只动 `eslintRunner.ts` 的 `buildCodeActions`（+ 单测）：push 一个 `EslintCodeAction { title, kind, edits }`。`extension.ts` 已把返回的 actions 统一转成 `edit.changes`，无需改。disable 注释的缩进匹配见现成 `disableLineAction`。

### 任务 2：加/改 ESLint 配置项
1. `package.json` 的 `contributes.configuration.properties` 加项（description 走 `%eslint.config.xxx%`）。
2. `package.nls.json` + `package.nls.zh-cn.json` 加中英文案（NLS 文件必须在 `files` 数组里）。
3. `protocol.ts` 的 `EslintSettings` 加字段。
4. `extension.ts` 的 `loadSettings()` 读它。
5. server 里按需消费（`server.ts` 或透传给 `computeFixAll` 的 options）。

### 任务 3：诊断不出/要调
查链路：server `_lintAndPublish`（先 `_shouldValidate` 过 `settings.validate` 语言门 → `_ctorFor` 解析 eslint → `lintDocument`）→ `_publish` → client `onNotification(publishDiagnostics)` → `diagnostics.set(uri, diags)` → renderer marker（owner='eslint'）。排查第一站：`ESLint` Output channel（`eslint.showOutputChannel`）+ server stderr（`[eslint][server]` 前缀转发到 client console）。常见原因：工作区没装 eslint、语言不在 `eslint.validate`、`eslint.run` 是 onSave 但没保存。

### 任务 4：改 client↔server 协议（加消息 / 改 DTO）
`protocol.ts` 加 `EslintMethods.xxx` + DTO → server `_conn.onRequest/onNotification` 加处理 → client 加 `sendRequest/notify` 方法。方法名走 `EslintMethods` 常量（两端不漂移）。DTO 是 plain-JSON，跨 vscode-jsonrpc verbatim。

### 任务 5：加新语言支持（如 vue/svelte）
`extension.ts` 的 `ESLINT_LANGUAGES`（provider 注册的语言）+ `package.json` 的 `activationEvents`（`onLanguage:xxx`）+ `eslint.validate` 默认值。server 仍按 `settings.validate` 二次门控。注意 ESLint 本身要能处理该语言（需工作区装对应 parser/plugin）。

### 任务 6：格式化 / 保存时 fixAll 不生效
两者默认关（`eslint.format.enable` / `eslint.codeActionsOnSave.enable`）。开了仍不行：查门面能力链路（见约定 3）。格式化走 `registerDocumentFormattingEditProvider`→`fixAllEdits`；保存走 `onWillSaveTextDocument`→`waitUntil(fixAllEdits)`。保存链路易错点：`WillSaveParticipantContribution` 必须先 `PendingDocumentSync.flush` 否则 server lint 的是旧文本；`FileEditorInput.save()` 在 await 参与者后要 `isDisposed()` 守卫。

## 验证
外置插件**脱离 pnpm workspace，不进 turbo / `pnpm check` 的 CI**——校验须在扩展目录手动跑，其 `package.json` scripts 已把 `tsc`/`eslint`/`vitest` 指向借来的 `../../extensions/typescript/node_modules/*`：
```bash
cd extensions-external/eslint
pnpm build       # 出 dist/extension.js + dist/server.js（借 extensions/typescript 的 esbuild）
pnpm test        # 纯逻辑单测（textUtils + eslintRunner，用假 ESLint）
pnpm typecheck
pnpm lint
pnpm package     # 出 universe.universe-eslint-<ver>.vsix
```
- 改 `eslintRunner.ts` / `textUtils.ts` 必补单测（`src/__tests__/`，node 环境，假 ESLint 见现成 `fakeEslint`）。
- uri 工具单测在 Windows 下 `fsPath` 是反斜杠，测试要 `norm` 归一化后比较（别硬写 POSIX 路径）。
- **手测**（无法自动化）：`pnpm dev` → 打开一个装了 eslint 的工作区里的 .ts → 出波浪线 → 灯泡 quickfix / disable → 命令面板 `ESLint: Fix all` → （开设置后）保存自动修 / 格式化。

## 外置形态 & 发布（对齐 extensions-external/pdf）
本插件不在 workspace 内，**没有本地 `node_modules`**。所有工具链 + 被 bundle 的 `vscode-*` 依赖都从 `extensions/typescript`（已装齐 esbuild/vitest/vscode-jsonrpc/vscode-languageserver-types/vscode-uri）借用解析：
- `esbuild.config.mjs`：`createRequire` 借 esbuild + `nodePaths:[extensions/typescript/node_modules]` 让打包能解析 vscode-*；`alias` extension-api → `packages/extension-api/dist/index.js`；`external:['eslint']` 不变。
- `tsconfig.json`：`extends ../../packages/config-ts/node.json`（不能用 `@universe-editor/config-ts` scope，外置解析不到）；`typeRoots` 指借来的 `@types`；`paths` 把 extension-api + 三个 vscode-* 映射到借来位置的**具体 `.d.ts`**（NodeNext ESM 下指目录会因 exports 的 types 条件失配，必须指到文件）。
- `vitest.config.ts`：`resolve.alias` 把运行时会 import 的 `vscode-uri`/`vscode-languageserver-types` 指到借来位置。
- `package.json`：无 `private`/`workspace:*`/`catalog:`；有 `publisher`/`license`/`icon`/`categories`；scripts 的 tsc/eslint/vitest 走 `node ../../extensions/typescript/node_modules/<tool>/<entry>`。
- `scripts/pack.mjs`：仿 pdf，从 `packages/extension-packaging` 借 adm-zip，把 `package.json`+`icon.svg`+`dist/`（**双 bundle**）+`package.nls*.json`+`README.md` 压成 `extension/**` 的 .vsix。
- ⚠️ **借用脆弱性**：若 `extensions/typescript` 未来删这些依赖，本插件 build/test 连带断——届时改借别的仍装有的包，或补独立 node_modules。
- **发布链路**：`pnpm build && pnpm package` → `pnpm gallery:publish -- --stage <stage> <vsix>` → `pnpm gallery:upload`（详见 `scripts/gallery/README.md`）。VSIX 内 `extension/package.json` 的 publisher/name/version/engines.universe 是市场元数据唯一真相源（防投毒校验），必须齐全。

## 易踩坑速记
1. **code action 用了 `.command`** → 静默失效（renderer 不转 command）。全走 `edit.changes`。
2. **eslint 被打包进 server** → 用错版本。esbuild 必须 `external: ['eslint']`，运行时从工作区 require。
3. **规则文档链接不出** → 诊断没填 `codeDescription.href`，或 `getRulesMetaForResults` 没返回该规则 meta。
4. **保存时修复 lint 旧文本** → `WillSaveParticipantContribution` 漏了 `PendingDocumentSync.flush`。
5. **NLS 文案打包丢失** → `package.nls*.json` 没进 `package.json` 的 `files` 数组。
6. **ESLint offset ↔ LSP position 差一/错行** → 只在 `textUtils.ts` 的 `LineIndex` 换算；ESLint message 是 1-based line/column，diagnostic 要 -1。
7. **改了门面能力 A/B 却漏 KEEP IN SYNC** → 参 extend-language-plugin 三处同步。
8. **server 找不到 dist/server.js** → 用 `context.extensionPath + '/dist/server.js'`；build 必须同时出两个 bundle。
9. **单进程 server 跨 monorepo 用错 eslint** → `_ctorByDir` 按被检查文件目录缓存，别全局共享一个 ctor。
10. **settings 变了不重读** → 无 onDidChangeConfiguration；靠 `eslint.restart` 或重开工作区。
11. **外置插件 typecheck 报 TS2307 找不到 vscode-***  → `tsconfig.json` 的 `paths` 指到包目录不行（NodeNext ESM 因 exports 的 types 条件失配），必须指到具体 `.d.ts` 文件。
12. **改动后 `pnpm check` 仍绿但插件没测到** → 外置插件不进 turbo CI，须 `cd extensions-external/eslint` 手动跑 test/typecheck/lint。

## 关键参考路径
- `extensions-external/eslint/src/protocol.ts` —— client↔server 协议（加消息第一站）
- `extensions-external/eslint/src/eslintRunner.ts` —— 纯逻辑：解析/lint/code action/fixAll（+ `__tests__/eslintRunner.test.ts`）
- `extensions-external/eslint/src/textUtils.ts` —— `LineIndex` 坐标换算（+ 单测）
- `extensions-external/eslint/src/server.ts` —— server 分发 + open-doc 存储 + 按目录缓存 ctor
- `extensions-external/eslint/src/eslintClient.ts` —— 宿主内 spawn/重启/转发（骨架来自 typescript 的 lspClient）
- `extensions-external/eslint/src/extension.ts` —— activate：注册全部能力 + settings
- `extensions-external/eslint/esbuild.config.mjs` —— 双 bundle + eslint external + 借依赖（nodePaths/alias）
- `extensions-external/eslint/scripts/pack.mjs` —— 打 .vsix（双 bundle + nls + README）
- `extensions-external/eslint/README.md` —— 外置形态、借用关系、构建/打包/发布链路
- `extensions-external/pdf/` —— 外置插件参照范式（更简单：无 server、无测试、零依赖）
- `scripts/gallery/README.md` —— 市场发布运维（publish/upload/registry）
- `apps/editor/src/renderer/services/languageFeatures/typescript/lspMonacoConvert.ts` —— `diagnosticToMarker`（rule 链接）+ `codeActionsToMonaco`（只转 edit）+ `workspaceEditToMonaco`（`edit.changes`）
- `apps/editor/src/renderer/contributions/WillSaveParticipantContribution.ts` + `services/extensions/SaveParticipant.ts` —— 保存时 fixAll 的 renderer 链路（门面能力 B）
- `packages/extension-api/COMPATIBILITY.md` —— 0.4.0 变更记录（门面能力 A/B）
- 相关 skill：`extend-language-plugin`（门面能力全链路 KEEP IN SYNC + 三进程细节）、`create-extension`（起新扩展骨架）、`add-json-schema-association`（jsonValidation）

## 其它
- 对标 vscode-eslint：命令 id（`eslint.executeAutofix` 等）、配置项名（`eslint.enable`/`run`/`validate`/`format.enable`/`codeActionsOnSave.enable`）与 VSCode 原生保持一致。
- 后续用本 skill，发现新经验，需同步更新本文件。
