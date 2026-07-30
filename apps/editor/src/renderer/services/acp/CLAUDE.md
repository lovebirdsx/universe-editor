# apps/editor/src/renderer/services/acp/CLAUDE.md

Agent Client Protocol（ACP）客户端层。基于 `@agentclientprotocol/sdk` v1.2.x（ESM-only，zod schema 校验）。

**关键事实**：
- 协议层完全在 renderer 端，main 端只搬字节（`IAcpHostService` / `IAcpTerminalService`）
- SDK 类型直接出现在 service / UI / 测试里——**没有 alias 层**，类型名就是 SDK 导出的名字（`ContentBlock` / `SessionUpdate` / `ToolCallContent` / `RequestPermissionRequest` / …）
- 自定义 view-model（`AcpSession` / `AcpMessage` / `AcpToolCall`）带 observable 状态，是本仓库特有封装，**不要重命名**

## 文件归位

| 文件 | 职责 |
|---|---|
| `acpClientService.ts` | 进程启动 + SDK `ClientSideConnection` 装配 + fs/terminal/permission 网关 |
| `acpAgentRegistry.ts` | 内置 agent 预设 + 用户 `acp.agents` 配置合并 + PATH 探测 |
| `acpPathPolicy.ts` | 沙盒纯函数：cwd 相对性 + 敏感前缀拒绝（`.ssh` / `.aws` / `.env`） |
| `acpMcpServers.ts` | 纯函数：`acp.mcpServers` 配置（Record/旧数组）→ ACP wire `McpServer[]` 规范化 + 按 agent `mcpCapabilities` 门控 http/sse |
| `acpPermissionHandler.ts` | `acp.permissions.autoApprove` 自动批准 + Memory 层持久化 |
| `acpElicitationForm.ts` | 纯函数：elicitation JSON Schema → 表单字段模型规范化 + 提交前校验（localize 错误文案） |
| `persistedStateBase.ts` | 双桶持久化基类（WORKSPACE + GLOBAL fallback），共享 `_reload` / `_writeNow` / debounce 框架 |
| `sdkHostStream.ts` | `IAcpHostService`（字符串 IO）→ SDK `Stream<AnyMessage>`（Uint8Array IO）适配 |
| `promptMentions.ts` | `@文件` 提及解析 → `resource_link` ContentBlock |
| `markdownRenderer.ts` | ContentBlock → 简易 markdown AST（被 UI 消费） |
| `mentionFileSearch.ts` | workspace 文件搜索（mention popover 用） |
| `testing/inMemoryAcpPair.ts` | 测试用真 `ClientSideConnection` ↔ 桩 `AgentSideConnection` 对联 |
| `session/` | **会话子系统**（`AcpSessionService` facade / `AcpSession` view-model / 恢复协调器 / 会话历史 / 配置项状态机 / 会话级 diff / 草稿缓存 / 书签 等 43 个文件）——见 [`session/CLAUDE.md`](session/CLAUDE.md) |

## 跨进程边界

| 端 | 文件 | 职责 |
|---|---|---|
| main | `src/main/services/acpHost/` | spawn agent 子进程，pump stdout/stderr/exit |
| main | `src/main/services/acpTerminal/` | terminal 池（spawn / output snapshot / waitForExit / kill / release） |
| shared | `src/shared/ipc/acpHostService.ts` | 通道契约：`start / writeStdin / stop / probe` + events |
| shared | `src/shared/ipc/acpTerminalService.ts` | 通道契约：`create / output / waitForExit / kill / release` |
| renderer | `main.tsx` | `ProxyChannel.toService` 绑两个跨进程服务 |

**无 `endStdin`**：流关闭只能走 `stop(handle)`。

## 数据流

### 出站（UI → agent）

```
PromptInput / ChatView
  → AcpSessionService.sendPrompt(text, mentions)
    → composePromptBlocks() 把 @文件转 resource_link
    → AcpSession._appendMessage('user', …)
    → ClientSideConnection.prompt({ sessionId, prompt: ContentBlock[] })
      → sdkHostStream writable → IAcpHostService.writeStdin(handle, jsonStr)
```

其他出站方法：`initialize / newSession / loadSession / cancel / setSessionMode / setSessionConfigOption`——全部走 SDK 强类型方法。

### 入站（agent → renderer）

```
IAcpHostService.onStdout(chunk: string)
  → sdkHostStream 重编码为 Uint8Array
  → ndJsonStream 解析 → ClientSideConnection 回调 clientImpl
    ├─ sessionUpdate(SessionNotification)        → AcpSessionService.onSessionUpdate → AcpSession.applyUpdate
    ├─ requestPermission(RequestPermissionRequest) → tryAutoApprove or PermissionCard
    ├─ unstable_createElicitation(CreateElicitationRequest) → pendingElicitation + ElicitationCard
    │   （与 pendingPermission 同构的 Promise+settle 模式；form 渲染字段卡，
    │   url 渲染 consent 卡 → 用户确认才 IOpenerService.open → accept → waiting）
    ├─ unstable_completeElicitation(通知) → 按 elicitationId 把 waiting 的 url 卡翻为 done
    ├─ readTextFile / writeTextFile               → AcpPathPolicy 检查 → IFileService
    └─ createTerminal / terminalOutput /
       waitForTerminalExit / killTerminal /
       releaseTerminal                            → IAcpTerminalService（带 ownership 检查）
```

**stderr 不进 SDK 流**：单独写 `OutputChannel`（喂进去会破坏 JSON 解析）。

### `applyUpdate` 处理的八种 SessionUpdate

`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `available_commands_update` / `config_option_update`。

新增类型在 `session/acpSession.ts` 的 `AcpSession.applyUpdate()` switch 加 case；observable 更新走 `transaction()` 进 **16ms 防抖事务**（参见 `_batchedTx` / `_commitBatchedTx`），避免每个 chunk 触发一次 React 重渲染。`config_option_update` 单独 delegate 到 `ConfigOptionStateMachine.ingestUpdate`，因为它需要 echo 抑制。

## 套路 ACP-A：加一个内置 agent 预设

`acpAgentRegistry.ts` 的 `BUILTIN_AGENTS` 数组加项。用户自定义走 `acp.agents` 配置，merge 时按 `id` 同键覆盖。`resolve(agentId, cwd?)` 返回的 LaunchSpec 自动应用 env denylist（`ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` 必剥）。

内置 `claude-code` 用我们自维护的 fork（git submodule `vendor/claude-agent-acp`），通过 `runAsNode: true` 启动：main 端 `acpHostMainService` 把它解析成 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑打包进来的 `dist/index.js`（dev 在仓库 `vendor/`，prod 在 `resourcesPath`），**不依赖系统 node/npx**。`runAsNode` 是可信标志，**只允许内置预设**设置——`_readUserAgents` 不读它，用户配置无法注入。这类 agent 的 `health()` 不走 PATH 探测，直接 `available: true`（产物随包）。改 fork 后记得 `pnpm agent:build`。

## 套路 ACP-B：处理一个新的 SessionUpdate 类型

1. `session/acpSession.ts` 的 `AcpSession.applyUpdate()` switch 加 case
2. 用 `transaction((tx) => { observable.set(value, tx) })` 包写入（共用 16ms 批次）
3. 如需新 view-model，挂在 `AcpSession` 上而不是 SDK 类型上
4. UI 通过 `useObservable` 自动 react，无需改组件订阅

## 套路 ACP-C：加一个新的入站方法（agent → renderer）

`acpClientService.ts` 的 `connect()` 闭包里构造 `clientImpl`——SDK `Client` interface 的实现对象。加方法时：
- 参数校验失败抛 `RequestError.invalidParams(data, msg)`
- 涉及资源所有权（如 terminal）：在 `connect()` 闭包里维护 `Set<string>`，跨连接访问拒绝；连接关闭（`signal` abort 或 `.closed` resolve）时遍历释放
- 失败路径要通过 `INotificationService` 上报 + telemetry 打点

## 套路 ACP-D：调整自动批准 / 权限策略

`acpPermissionHandler.ts`：`tryAutoApprove(params)` 决策、`persistAllow(kind)` 写回 `acp.permissions.autoApprove`（`ConfigurationTarget.Memory`）。UI 端 `PermissionCard` 不动——它只展示 SDK 给的 `options[]`。`kind` 是不透明字符串，没有枚举校验，但**新代码必须用 SDK `ToolKind` 的 10 个值**（见易踩坑 #2）。

**例外：`switch_mode`（ExitPlanMode）永不走静默自动批准、也不被 `persistAllow` 记住**（守卫在 `acpSessionService.onRequestPermission`，不在 handler）。它的自动化由 `acp.plan.autoExecute`（enum：off/bypassPermissions/auto/acceptEdits/default）显式驱动：service 判定设置值在本次 options 里才给 pending 附 `autoResolve`，卡片（`PermissionCard`）在「此后自动执行计划」checkbox 行内显示可打断倒计时（hover/聚焦暂停、取消勾选作废本次），到点视同点选。改这块时注意：静默短路会让倒计时卡永不出现，两者只能留一个。

## 套路 ACP-E：扩展会话历史持久化字段

`session/acpSessionHistory.ts` 继承 `PersistedStateBase`：
1. `SCHEMA_VERSION++`
2. `AcpSessionHistoryEntry` 加字段
3. 在 `_deserialize` 的 `migrate()` 加一段从旧版本迁移的代码（老版本 entry 缺字段时给默认值）
4. 不要随意提 `MAX_ENTRIES=100`（写入是全量序列化，提高会拖慢启动）

新加双桶持久化服务时直接继承 `PersistedStateBase<TState>`，实现五个抽象钩子（`_emptyState` / `_serialize` / `_deserialize` / `_onStateReplaced`、可选 `_mergeOnLoad`），框架负责 cold-start 时序、workspace-swap 重读、100ms 防抖写、`dispose` 时同步 flush。

## 套路 ACP-F：MCP servers（配置 → 透传）

用户配置 `acp.mcpServers`（schema 注册在 `contributions/AgentsContributions.ts`，type `object`、default `{}`），在 `createSession`/`resumeSession` 里经两步纯函数（`acpMcpServers.ts`）后透传给 `newSession`/`loadSession`：

1. `normalizeMcpServers(raw, onWarn)`：把 **Record 风格**（key=server name，贴近 Claude `.mcp.json`，`env`/`headers` 用 Record）或**旧数组格式**统一成 ACP wire `McpServer[]`。坏条目 **跳过 + warn 不抛错**（对齐 `acpAgentRegistry._readUserAgents`）。
2. `filterMcpServersByCapabilities(servers, caps)`：读 `initializeResult.agentCapabilities?.mcpCapabilities`，agent 不通告的 http/sse 进 `dropped`；stdio 是基线 **恒留**。`AcpSessionService._warnDroppedMcpServers` 把 dropped 逐条 logger.warn + 一次汇总 `INotificationService` 告警。

agent 端（`vendor/claude-agent-acp`）把 wire 的 `env`/`headers` 数组 `Object.fromEntries` 还原成 Record 再喂给 Claude Agent SDK——MCP 连接/工具发现全由 SDK 管，client 只做"配置→wire→门控"。命令入口：`Agents: Open MCP Settings`（`agentActions.ts` 的 `OpenAcpMcpSettingsAction`）。

**默认启用集语义（去 sticky 后）**：
- 定义池 = `acp.mcpServers` settings 层按 server 名逐条覆盖（低→高：VSCodeUser → User → VSCodeWorkspace → Project → Memory）+ 工作区根 `.mcp.json`（最高优先、只读）。`refreshMcpServerDefinitions` 把合并结果镜像到 `mcpServerDefinitions` observable（`.mcp.json` 来源的 entry 带 `fromMcpJson: true`）。
- **新会话的默认启用集 = 池中全部非 `disabled` 条目**（`resolveMcpServerSelection(pool, null)`）。`disabled` 标志是**唯一**的默认开关，两个入口同源：AI 设置"MCP 服务器"面板的 checkbox + 会话 picker 弹窗行内的「默认」开关（`setMcpServerDefaultEnabled` 按 winning 层写回 settings；VSCode 兼容层只读则写对应可写高层覆盖；`.mcp.json` 来源返回 `false`，UI 禁用控件）。
- **picker 左侧勾选只是会话级 pin**（`setSessionMcpServers` → `session.mcpServerSelection`），只影响当前会话（pin 与 attach 快照偏离时无缝 reload），**绝不写回默认**——sticky 机制已删，`acpAgentDefaultsService` 不再存 MCP 白名单（旧数据的 `mcpDefaults` 字段反序列化时忽略、下次写入自动 purge）。
- resume/fork 的选择瀑布：history 行 `mcpServerNames`（含 undefined=跟随默认）→ 否则 `null`（= 非 disabled 全集）。

**未做（按需扩展）**：读项目根 `.mcp.json`、实验性 `type:'acp'` transport、MCP 状态/工具可观测 UI（ACP 无标准状态推送，MCP 工具以普通 `tool_call` 出现）。

## 测试模式

| 文件 | 焦点 |
|---|---|
| `AcpSessionService.test.ts` (session/) | 会话生命周期 / 消息聚合 / 工具调用 / 计划 / 权限分发 |
| `AcpSessionService.configOptions.test.ts` (session/) | configOption 同步（facade 集成） |
| `acpSessionConfigOptions.test.ts` (session/) | `ConfigOptionStateMachine` 单独单测：echo 抑制 + 持久化分支 |
| `AcpSessionService.resume.test.ts` (session/) | `loadSession` 恢复路径 |
| `acpSessionRestoreCoordinator.test.ts` (session/) | 启动期 hydrate + `_pendingRestoreHistoryId` + workspace-swap |
| `AcpClientService.terminal.test.ts` | terminal 所有权 + 跨连接拒绝 + 连接退出回收 |
| `AcpAgentRegistry.test.ts` | 预设合并 / PATH 探测 |
| `acpPathPolicy.test.ts` | 沙盒边界（各 OS 路径标准化） |
| `acpMcpServers.test.ts` | MCP 配置规范化（Record/数组、stdio 无 type、坏条目跳过、`type:'acp'` 跳过）+ 能力门控 |
| `acpSessionHistory.test.ts` (session/) | 持久化 / schemaVersion 迁移 / MAX_ENTRIES 溢出 |
| `sdkHostStream.test.ts` | UTF-8 重编码 / stream lifecycle |
| `inMemoryAcpPair.test.ts` | 测试 harness 本身 |

**协议级测试一律走 `testing/inMemoryAcpPair.ts`**：返回一对 `Stream<AnyMessage>`（基于 `TransformStream`），一端挂真 `ClientSideConnection`，另一端挂桩 `Agent` 实现。断言 **fake agent 方法被调用 + 参数对**，而不是 jsonline 字节——前者稳定，后者会被 SDK wire 格式变化弄碎。

E2E 在 `apps/editor/e2e/`，目前 ACP 未在 `@p0` 冒烟里。

## 持久化

`AcpSessionHistory` → `IStorageService`，`key='acp.sessionHistory'`，`schemaVersion=1`，**双桶 scope 策略**（基类 `PersistedStateBase` 提供）：

- 有 workspace 打开 → `StorageScope.WORKSPACE`（每个工作区独立的 100 条 LRU 历史）
- 空窗口 → `StorageScope.GLOBAL` 兜底桶
- workspace 切换由 `IStorageService.onDidChangeWorkspaceScope` 驱动：基类 `_reload()` 刷新 in-memory 状态，AcpSessionService 联动关闭所有 live sessions 并通过 `AcpSessionRestoreCoordinator.onWorkspaceSwap()` 从新桶尝试恢复 `acp.activeSessionHistoryId`

`AcpAgentDefaults`（`key='acp.agentDefaults'`）同样的双桶策略——workspace-A 选过的 `MODEL=opus` 不会污染 workspace-B 的新会话默认值。

```
{ schemaVersion: 1, entries: [{ id, agentId, sessionIdOnAgent, title, cwd, createdAt, lastUsedAt, configOptions? }] }
```

**只存字符串元数据**——无 `ContentBlock` / `SessionUpdate` 落盘。恢复时拿 `sessionIdOnAgent` 调 `loadSession` 让 agent 重放历史。

升级路径：旧版本 GLOBAL 桶里的 `acp.sessionHistory` / `acp.agentDefaults` 由 `MainStorageService._purgeLegacyWorkspaceKeys()` 启动时一次性 purge——不迁移，按用户决策直接丢弃。

## SDK 关键约定（易踩坑清单）

1. **`T | null` ≠ `T | undefined`**：SDK 大量字段用 null（如 `ToolCallUpdate.content / kind`、`ResourceLink.{name,description,mimeType}`）。`exactOptionalPropertyTypes` 下 `null` 不能赋给 `prop?: T`——用 `!= null`（loose）而不是 `!== undefined`。
2. **`ToolKind` 固定 10 枚举**：`read | edit | delete | move | search | execute | think | fetch | switch_mode | other`。**不能**传 `'fs'` / `'fs.read'` / `'fs.write'`（老协议遗留值，已全部翻译为 `read` / `edit`）。
3. **`SetSessionConfigOptionRequest` 没有 `type: 'select'`**：union 只有 `{ type: 'boolean'; value: boolean }` 和 `{ value: SessionConfigValueId }`。字符串 ID 分支**不带 type**。
4. **void-returning client method 序列化为 `{}`**：如 `killTerminal`。断言写 `expect(resp.result).toEqual({})`，不是 `undefined`。
5. **Cancel 双步缺一不可**：(a) `conn.cancel({ sessionId })` 发 notification 给 agent；(b) 本地 `AbortController.abort()` 让 `Promise.race([conn.prompt, abortPromise])` 立刻 reject。少 (b) 会卡死本地 UI 等 agent 回应；少 (a) agent 不知道。
6. **Terminal ownership 闭包**：`connect()` 里 `const ownedTerminals = new Set<string>()`，五个 terminal 方法都闭包它。**跨连接访问抛 `RequestError.invalidParams('Unknown terminal …')`**；连接关闭遍历 `release(id)` 兜底回收。
7. **stderr 独立通道**：`IAcpHostService.onStderr` **绝不**喂给 SDK ndJsonStream——单独 `OutputChannel`，便于诊断。
8. **env denylist**：spawn 子进程前剥 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`，否则继承 Electron 的 fork 上下文，agent 会怪异崩溃。main + renderer 两端都要做。**例外**：内置 `runAsNode` agent（见套路 ACP-A）由 `acpHostMainService` 在 denylist 剥离**之后有意补回** `ELECTRON_RUN_AS_NODE=1`——因为它本就用 Electron-as-node 启动，且 fork 会用 `process.execPath` 重启自己、子进程必须继承该变量。这只对可信内置路径开启，用户 `spec.env` 注入的该变量仍被拒。
9. **16ms 防抖事务**：`applyUpdate` 内 messages / toolCalls / plan 共用一个 `transaction()`，单次 observer 通知。新增更新类别也要进同一事务，否则会产生抖动。
10. **stdio MCP 条目绝不能带 `type` 字段**：agent 端用 `!('type' in server)` 判定 stdio，带了 `type`（哪怕 `'stdio'`）会**两个分支都不匹配被静默丢弃**。`normalizeMcpServers` 的 stdio 分支输出 `{ name, command, args, env }`，刻意不写 type。http/sse 反而**必须**带 `type`。env/headers 是 `Array<{name,value}>`（不是 Record），由 normalize 负责把用户的 Record 转成数组。

## 参考路径

- SDK 类型源码：`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
- SDK 入口：`@agentclientprotocol/sdk` 导出 `ClientSideConnection / AgentSideConnection / RequestError / ndJsonStream` + 全部 schema 类型
- 配置 key：`acp.agents` / `acp.permissions.autoApprove` / `acp.startupTimeoutMs` / `acp.defaultAgentId` / `acp.mcpServers`

## 案例：# 结构化上下文引用（prompt-ref-pills）

> 本节自案例型 skill `prompt-ref-pills` 并入。范围：ACP 输入框「@/# by-range 药丸引用」——@ 文件提及 + # 结构化上下文（工作区符号/Git修改/打开编辑器+选区/文档）统一成 VSCode Copilot 式的、按字符区间（Monaco decoration）追踪的可编辑药丸；提交时读追踪的 range 列表产出 ContentBlock，不分词。涉及 `services/acp/{promptRef,promptRefTracker,promptMentions,promptContextRef,contextSuggestions}.ts` 或 `workbench/agents/{PromptMonacoEditor,PromptInput,ContextPopover,MentionPopover}.tsx`。区别于 [`session/CLAUDE.md`](session/CLAUDE.md)（会话全局导航）：本节只管输入框的引用子系统。

把用户在输入框里的 `@文件` / `#符号|Git改动|打开的编辑器|文档` 引用，做成 **VSCode Copilot 式的药丸**：引用是文本流里一段**可编辑文本 token**（`@src/a.ts` / `#foo bar`），用 Monaco decoration 染成药丸，**按字符区间（range）追踪**——Monaco 自动随编辑平移 range，含空格的 label 天然安全；提交时读追踪的 range 列表切片产出 `ContentBlock`，**绝不对文本分词/by-name 匹配**（旧机制的致命缺陷，已删）。

> ⚠️ **第一原则**：引用不是 React state，**真身活在 Monaco 上**——文本在 model 里、range 在 decoration 里、追踪表在 `PromptRefTracker` 里。`PromptInput` 只通过 `PromptEditorHandle`（`insertRef/listRefs/restoreRefs/clearRefs`）操作它们，不再持有 `mentions`/`contextRefs` 数组。改任何引用行为前先认清落在哪一层。

### 五文件分层地图

| 文件 | 层 | 职责 |
|---|---|---|
| `services/acp/promptRef.ts` | 纯逻辑（模型 + 序列化） | `PromptRef{id,kind,label,uri,meta?}` + `PlacedRef{ref,start,end}`；`extractActiveToken`（识别 @/# token）、`refDisplay`（`@`/`#` 前缀并入显示文本）、`composeRefBlock`（**一个 ref → 一个 wire block**，按 kind）、`composePromptBlocksFromRefs`（按 range 切片交织 text/block）、`suggestionItemToRef`/`mentionEntryToRef`（popover item → PromptRef） |
| `services/acp/promptRefTracker.ts` | 追踪（纯逻辑 + monaco 句柄） | `PromptRefTracker` 挂 model：`insert`（applyEdits 换文本 + 建 decoration + 存 snapshot）/`restore`（草稿恢复，只建 decoration 不改文本）/`list`（回读 decoration range → PlacedRef）/`reconcile`（range 内文本≠snapshot 则删该引用 + 清残余）/`clear`/`dispose` |
| `workbench/agents/PromptMonacoEditor.tsx` | 编辑器句柄 | 内嵌 standalone Monaco，暴露 `PromptEditorHandle`；`insertRef` 调 tracker + 追加尾随空格；`onChange(text,caret,source)` 用 `runProgrammatic` 计数器分 `'user'|'program'` |
| `workbench/agents/PromptInput.tsx` | UI 编排 | `acceptMention`/`acceptContextRef`/`openFilePicker`/`onPromptDrop` → `editorHandleRef.insertRef(...)`；提交读 `listRefs()` → `session.sendPrompt(text, refs, ...)` |
| `services/acp/contextSuggestions.ts` | `#` 数据源 | 四个 provider（`WorkspaceSymbol`/`ScmChange`/`OpenEditor`/`Docs`）headless `query()` → `ContextSuggestionItem[]`；`toItem` 把 line/column 塞进 `meta` |

> `promptMentions.ts`（`extractMentionQuery`/`detectFilePickerTrigger`）与 `promptContextRef.ts`（`extractHashQuery` + `PromptContextRefKind`）只剩 **token 探测**；旧 by-name 序列化（applyMentionPick/composePromptBlocks/mergeRef/composeContextRefBlock/PromptMention/PromptContextRef）**已全删，别复活**。

### 数据流（一次引用的生命）

```
键入 @q / #q → onChange(source:'user') → extractActiveToken → popover 拉候选
选中 → acceptXxx → handle.insertRef(ref, tokenStart, tokenEnd)
        → tracker.insert：applyEdits 换 token 为 refDisplay(ref)（如 "#foo bar"）
        → 建 decoration（inlineClassName:acp-prompt-ref-pill + NeverGrowsWhenTypingAtEdges）
        → 存 snapshot = display；追加尾随空格（不带 forceMoveMarkers！见坑②）
用户编辑 → onChange(source:'user') → tracker.reconcile()：range 内文本漂移出 snapshot → 删引用
提交 → handle.listRefs() → composePromptBlocksFromRefs(text, refs)
        → 按 ref.range 切文本，每个 ref 走 composeRefBlock（按 kind 产 block）
        → session.sendPrompt(text, refs, contexts, images) → _dispatchPrompt 发出
```

### 加一个新引用 kind 的清单

1. `promptRef.ts`：`PromptRefKind` 加 kind；`PREFIX_BY_KIND` 定 `@` 或 `#`；`composeRefBlock` 加 case（**先读下面「序列化红线」**）；`suggestionItemToRef` 加 case（若走 `#` popover）。
2. `contextSuggestions.ts`（若 `#` 类）：加 provider class（构造走 DI 装饰器）+ `ContextSuggestionItem.kind` 覆盖；`promptContextRef.ts` 的 `PromptContextRefKind` 补类型。
3. `PromptInput.tsx`：`ensureContextProviders` 注册 provider；`hashGroups` 加分组。
4. `ContextPopover.tsx`：分组渲染（若需新样式）。
5. i18n：`acp.contextRef.group.<kind>` 等键**只补 `zh-CN.ts`**（`localize()` 自带英文 default，`en-US.ts` 只收需覆盖项）。
6. 测试：`promptRef.test.ts` 加 `composeRefBlock` 该 kind 断言；provider 测试复用 `PromptInput.test.tsx` 里现成的 DI stub（stubLanguageFeatures/stubUriIdentity/…）。

### 序列化红线：resource_link 的 name/description/_meta 会被 agent 丢弃

**内置 agent 的 prompt→模型转换只读 uri，几乎不读别的字段**：
- claude-agent-acp fork `acp-agent.ts` `promptToClaude`：`resource_link` → `formatUriAsLink(uri)`，**连 name 都丢**。
- codex-acp `CodexAcpClient.ts` `buildPromptItems`：`formatUriAsLink(name, uri)`，用 name 但**丢 description + _meta**。

⇒ 任何**需要 agent 精确消费的结构化位置信息（行/列/符号名）绝不能塞进 resource_link 的 name/description/_meta——只能进 `text` 块正文**。这是本仓库真实 bug 的根因（`#Student` 发过去退化成读整个 hello.ts，因为 line 全在被丢弃的 `_meta.symbol` 里）。修法：符号类 `composeRefBlock` 产 `text` 块，把 ``（`Student` (hello.ts:12:5)）`` 写进正文（`_meta.symbol` 可留作未来 agent 用，但当前逻辑不能依赖它）。指整文件的 kind（file/folder/openEditor）无所谓，仍用 resource_link。见记忆 [[prompt-hash-context-references-feature]]。

诊断辅助：`acpSession.ts` 的 `_dispatchPrompt` 有 `console.debug('[acp-prompt] dispatch', ...)` 打印发出块形状，复现时在 devtools 直接核对。

### 易踩坑

- **① 药丸贴边**：Monaco 文本贴容器边框——`.promptEditorHost`（agents.module.css）须给 `padding: 0 6px`。药丸自身样式是**全局类** `:global(.acp-prompt-ref-pill)`（Monaco 把 decoration span 渲染在 CSS-module 作用域外）。
- **② 尾随空格误删药丸（forceMoveMarkers 覆盖 stickiness）**：`insertRef` 在药丸后补空格时，若那次 `applyEdits` 带 `forceMoveMarkers: true`，会**覆盖** decoration 的 `NeverGrowsWhenTypingAtEdges`，把空格吞进追踪 range → range 文本变 `#test.md ` ≠ snapshot `#test.md` → 下次按键 `reconcile()` 误判"药丸被改"删掉整个引用。**补空格的 applyEdits 绝不能带 forceMoveMarkers**，让空格落在 range 之外。
- **③ programmatic vs user 变更源**：非受控 Monaco 每次 `setValue`/`applyEdits`（历史导航、接受候选、草稿恢复、tracker 自己的 insert/restore）都 fire `onDidChangeModelContent`。`PromptEditorHandle` 命令式方法用 `runProgrammatic` 计数器包裹，`onChange` 带 `source`，`program` 时只 mirror text/caret、**跳过所有用户副作用（reconcile / @@@# 触发 / popover dismiss / history 关闭）**。否则会出现"刚开的弹窗被自己的 setText 关掉""tracker 自插入被自己 reconcile 删掉"。详见记忆 [[prompt-monaco-input-migration]]。

### 测试套路

- 纯逻辑（`promptRef.test.ts`，renderer-node）：`extractActiveToken` / `composeRefBlock` 各 kind / `composePromptBlocksFromRefs` range 切片 + 含空格 label。
- 追踪（`promptRefTracker.test.tsx`，renderer-dom）：`monaco-editor` alias 到 `test-stubs/monaco-editor.ts`——该 stub **已模拟 decoration range 迁移 + forceMoveMarkers 语义**（`shiftOffset` 的 `force` 参数 + `applyEdits` 透传 `forceMoveMarkers`）。加"边界打字/追加空格是否保留药丸"这类回归务必确认 stub 忠实模拟了对应标志，否则假绿（坑②当初就是 stub 漏了 forceMoveMarkers）。
- UI（`PromptInput.test.tsx`，renderer-dom）：stub 的 `editor.create` 挂真 `<textarea data-testid="acp-prompt-input">` 桥接假 model；断言提交 payload 读 `sendPrompt` 第 2 参 `refs`（`refs[0].ref` `toMatchObject`）。

### 参考坐标

- 模型/序列化：`promptRef.ts`；追踪：`promptRefTracker.ts`；句柄：`PromptMonacoEditor.tsx`；编排：`PromptInput.tsx`；数据源：`contextSuggestions.ts`
- 计划：`docs/plan/monaco-prompt-input-context-pills-plan.md`
- 记忆：[[prompt-hash-context-references-feature]]（模型 + 序列化红线）、[[prompt-monaco-input-migration]]（Monaco 迁移的坑）、[[monaco-055-editcontext-nls]]（editContext:true 修中文 IME 必设）
- 会话全局上下文（协议/发送链路/双 id）：见 [`session/CLAUDE.md`](session/CLAUDE.md)

## 子域导航

- 会话子系统（会话生命周期 / view-model / 历史 / 恢复 / 书签等 43 文件）：[`session/CLAUDE.md`](session/CLAUDE.md)
- Agent 设置 UI（Claude）：[`workbench/agentSettings/claude/CLAUDE.md`](../../workbench/agentSettings/claude/CLAUDE.md)
- Agent 设置 UI（Codex）：[`workbench/agentSettings/codex/CLAUDE.md`](../../workbench/agentSettings/codex/CLAUDE.md)
