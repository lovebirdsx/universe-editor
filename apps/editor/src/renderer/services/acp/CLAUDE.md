# apps/editor/src/renderer/services/acp/CLAUDE.md

Agent Client Protocol（ACP）客户端层。基于 `@agentclientprotocol/sdk` v1.2.x（ESM-only，zod schema 校验）。

**关键事实**：
- 协议层完全在 renderer 端，main 端只搬字节（`IAcpHostService` / `IAcpTerminalService`）
- SDK 类型直接出现在 service / UI / 测试里——**没有 alias 层**，类型名就是 SDK 导出的名字（`ContentBlock` / `SessionUpdate` / `ToolCallContent` / `RequestPermissionRequest` / …）
- 自定义 view-model（`AcpSession` / `AcpMessage` / `AcpToolCall`）带 observable 状态，是本仓库特有封装，**不要重命名**

## 文件归位

| 文件 | 职责 |
|---|---|
| `acpSessionService.ts` | 多会话 facade：注册 / 查找 + `sessions` observable + IAcpClientNotificationSink 分发 + createSession/resumeSession |
| `acpSession.ts` | `AcpSession` view-model：messages / toolCalls / plan / pendingPermission / availableCommands observable + `applyUpdate` 状态机 |
| `acpSessionConfigOptions.ts` | `ConfigOptionStateMachine`：configOptions observable + echo 抑制 + `setSessionConfigOption` 推送（注入到 `AcpSession`） |
| `acpSessionRestoreCoordinator.ts` | 启动 / workspace-swap 恢复协议 + `session/list` 扫描 + `session/delete` 转发 |
| `acpClientService.ts` | 进程启动 + SDK `ClientSideConnection` 装配 + fs/terminal/permission 网关 |
| `acpAgentRegistry.ts` | 内置 agent 预设 + 用户 `acp.agents` 配置合并 + PATH 探测 |
| `acpPathPolicy.ts` | 沙盒纯函数：cwd 相对性 + 敏感前缀拒绝（`.ssh` / `.aws` / `.env`） |
| `acpMcpServers.ts` | 纯函数：`acp.mcpServers` 配置（Record/旧数组）→ ACP wire `McpServer[]` 规范化 + 按 agent `mcpCapabilities` 门控 http/sse |
| `acpPermissionHandler.ts` | `acp.permissions.autoApprove` 自动批准 + Memory 层持久化 |
| `acpElicitationForm.ts` | 纯函数：elicitation JSON Schema → 表单字段模型规范化 + 提交前校验（localize 错误文案） |
| `acpElicitationDraftCache.ts` | ElicitationCard 未提交输入的内存草稿（sessionId + toolCallId/消息 hash 键） |
| `persistedStateBase.ts` | 双桶持久化基类（WORKSPACE + GLOBAL fallback），共享 `_reload` / `_writeNow` / debounce 框架 |
| `acpSessionHistory.ts` | 会话元数据落盘（继承 `PersistedStateBase`，`MAX_ENTRIES=100`） |
| `acpAgentDefaultsService.ts` | 每 agent configOption 默认值（继承 `PersistedStateBase`） |
| `acpSessionEditorInput.ts` | `EditorInput` 子类——会话即编辑器输入，可序列化恢复 |
| `sdkHostStream.ts` | `IAcpHostService`（字符串 IO）→ SDK `Stream<AnyMessage>`（Uint8Array IO）适配 |
| `promptMentions.ts` | `@文件` 提及解析 → `resource_link` ContentBlock |
| `markdownRenderer.ts` | ContentBlock → 简易 markdown AST（被 UI 消费） |
| `mentionFileSearch.ts` | workspace 文件搜索（mention popover 用） |
| `testing/inMemoryAcpPair.ts` | 测试用真 `ClientSideConnection` ↔ 桩 `AgentSideConnection` 对联 |

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

新增类型在 `acpSession.ts` 的 `AcpSession.applyUpdate()` switch 加 case；observable 更新走 `transaction()` 进 **16ms 防抖事务**（参见 `_batchedTx` / `_commitBatchedTx`），避免每个 chunk 触发一次 React 重渲染。`config_option_update` 单独 delegate 到 `ConfigOptionStateMachine.ingestUpdate`，因为它需要 echo 抑制。

## 套路 ACP-A：加一个内置 agent 预设

`acpAgentRegistry.ts` 的 `BUILTIN_AGENTS` 数组加项。用户自定义走 `acp.agents` 配置，merge 时按 `id` 同键覆盖。`resolve(agentId, cwd?)` 返回的 LaunchSpec 自动应用 env denylist（`ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` 必剥）。

内置 `claude-code` 用我们自维护的 fork（git submodule `vendor/claude-agent-acp`），通过 `runAsNode: true` 启动：main 端 `acpHostMainService` 把它解析成 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑打包进来的 `dist/index.js`（dev 在仓库 `vendor/`，prod 在 `resourcesPath`），**不依赖系统 node/npx**。`runAsNode` 是可信标志，**只允许内置预设**设置——`_readUserAgents` 不读它，用户配置无法注入。这类 agent 的 `health()` 不走 PATH 探测，直接 `available: true`（产物随包）。改 fork 后记得 `pnpm agent:build`。

## 套路 ACP-B：处理一个新的 SessionUpdate 类型

1. `acpSession.ts` 的 `AcpSession.applyUpdate()` switch 加 case
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

## 套路 ACP-E：扩展会话历史持久化字段

`acpSessionHistory.ts` 继承 `PersistedStateBase`：
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

**未做（按需扩展）**：读项目根 `.mcp.json`、实验性 `type:'acp'` transport、MCP 状态/工具可观测 UI（ACP 无标准状态推送，MCP 工具以普通 `tool_call` 出现）。

## 测试模式

| 文件 | 焦点 |
|---|---|
| `AcpSessionService.test.ts` | 会话生命周期 / 消息聚合 / 工具调用 / 计划 / 权限分发 |
| `AcpSessionService.configOptions.test.ts` | configOption 同步（facade 集成） |
| `acpSessionConfigOptions.test.ts` | `ConfigOptionStateMachine` 单独单测：echo 抑制 + 持久化分支 |
| `AcpSessionService.resume.test.ts` | `loadSession` 恢复路径 |
| `acpSessionRestoreCoordinator.test.ts` | 启动期 hydrate + `_pendingRestoreHistoryId` + workspace-swap |
| `AcpClientService.terminal.test.ts` | terminal 所有权 + 跨连接拒绝 + 连接退出回收 |
| `AcpAgentRegistry.test.ts` | 预设合并 / PATH 探测 |
| `acpPathPolicy.test.ts` | 沙盒边界（各 OS 路径标准化） |
| `acpMcpServers.test.ts` | MCP 配置规范化（Record/数组、stdio 无 type、坏条目跳过、`type:'acp'` 跳过）+ 能力门控 |
| `acpSessionHistory.test.ts` | 持久化 / schemaVersion 迁移 / MAX_ENTRIES 溢出 |
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

## 会话子系统（acp-session）

> 范围：制作或修改 ACP agent 会话相关功能——多会话 facade + 单会话 view-model + 异步化双 id 架构 + 连接池/恢复协调器 + 双渲染模式 + 持久化 + 会话级 diff/计时/开销等附加能力 + 命令层 + 测试套路。本节做导航与路由（「改哪里 + 为什么 + 坑」）；协议层细节（SDK 约定/入站方法/MCP/沙盒）即本文上半部分，不重复。

把外部 AI agent（claude-code / codex / …）经 Agent Client Protocol 接入编辑器：多会话管理、流式消息/工具调用/计划渲染、权限交互、配置项、会话恢复、两种渲染布局、以及会话级 diff/计时/开销等增值能力。

> ⚠️ **第一原则**：先认领改动落在**哪一层**——
> ① 多会话 facade（`AcpSessionService`：注册/查找/分发/createSession/resumeSession）
> ② 单会话 view-model（`AcpSession`：observable 状态 + `applyUpdate` 状态机 + prompt 队列）
> ③ 连接/进程层（`AcpClientService` 连接池 + SDK 装配 + fs/terminal/permission 网关）
> ④ 恢复协调（`AcpSessionRestoreCoordinator`：启动/workspace-swap 重连）
> ⑤ 持久化（`acpSessionHistory` / `acpAgentDefaults`，双桶 `PersistedStateBase`）
> ⑥ UI（`workbench/agents/*`：双模式布局 + timeline 渲染 + 输入框 + 各种卡片）
> ⑦ 命令层（`actions/agentActions.ts`，42 个 Action2）
>
> **协议层（SDK 类型约定、入站方法、MCP、沙盒路径策略、agent 预设）见本文上半部分（套路 ACP-A~F + 「SDK 关键约定」10 条易踩坑），本节不重复。**

### 核心事实（务必先懂）

- 协议层全在 renderer、SDK 类型无 alias 层——见上文「关键事实」，不重复。
- **双 id 架构（异步化后的关键）**：见 [[async-session-create]] 记忆。
  - `AcpSession.id` = 构造时生成的**本地稳定 uuid**（`generateUuid()`），UI 立即拿到——React key / `activeSessionId` / 运行期缓存（draft cache / widget registry / chat view state）全用它。
  - `AcpSession.sessionIdOnAgent: IObservable<string|undefined>` = **agent 颁发的 durable id**，连接 attach 后才有。history 条目、change tracker（record/changesFor）、active-session 持久化、editor tab serialize、**协议通知路由的源 id** 全用它。
  - `AcpSessionService._findSession(id)` **同时匹配本地 id 与 agent id**，所以 getById/setActive/closeSession/通知分发对调用方透明，传哪个都行。
  - **resume 出来的会话**：`id === entry.sessionIdOnAgent`（两者相等，因为 resume 直接用 durable id 当 id）。
- **createSession 异步、立即返回**：同步建好 `AcpSession` + 发布 observable → UI 立即可输入；spawn+initialize+session/new 在后台 `_connectSession` 跑，完成后 `session.attachConnection(conn, agentId)`。连接前用户发的 prompt 入 `_queuedPrompts`，attach 后自动 flush。失败走 `failConnection`（status `errored` + `[error]` 消息，**不再 reject**）。状态机：`connecting`→attach→`idle`，或→`errored`。
- **16ms 防抖事务**——见上文「数据流」末段与「SDK 关键约定」#9，不重复。
- **timeline 是 UI 的唯一真相**：`timeline` observable 按到达顺序交织 message/tool_call slot（plan 不进 timeline，单列 `plan` observable）。三个 lane observable（messages/toolCalls/plan）保留作 selector 读。

### 文件地图

#### Service 层 `apps/editor/src/renderer/services/acp/`

| 文件 | 职责 | 何时改 |
|---|---|---|
| `acpSessionService.ts` | 多会话 facade：`sessions`/`activeSession`/`activeSessionId` observable + `IAcpClientNotificationSink` 分发（onSessionUpdate/onRequestPermission/onAskUserQuestion/onExtNotification）+ createSession/`_connectSession`/resumeSession/closeSession + `_findSession` | 会话生命周期、路由、active 切换、持久化 active id |
| `acpSession.ts` | `AcpSession` view-model：全部 observable + `applyUpdate` 状态机 + 双 id + prompt 队列 + `attachConnection`/`failConnection`/`whenConnected` + 标题派生 + usage/cost 提取 + 计时段累计 | 消息/工具/计划/状态/usage 行为、连接生命周期 |
| `acpSessionConfigOptions.ts` | `ConfigOptionStateMachine`：configOptions observable + echo 抑制 + `setConfigOption` 推送 + 持久化分支（注入 `AcpSession`，连接前 `getConn()` 返回 undefined 时静默 no-op） | 配置项（model/mode/thought-level）同步 |
| `acpSessionRestoreCoordinator.ts` | 启动/workspace-swap 恢复 + `session/list` 扫描 + `session/delete` 转发 + `_pendingRestoreHistoryId` | 恢复时序、跨 workspace 重连 |
| `acpClientService.ts` | 进程启动 + SDK `ClientSideConnection` 装配 + **refcount 连接池**（按 agentId+cwd 租用）+ fs/terminal/permission 网关 | 连接建立、池化、入站方法（见上文「套路 ACP-C」） |
| `acpAgentRegistry.ts` | 内置 agent 预设 + `acp.agents` 合并 + PATH 探测 + `runAsNode` 可信标志 | 加 agent（见上文「套路 ACP-A」） |
| `acpSessionHistory.ts` | 会话元数据落盘（`PersistedStateBase`，`MAX_ENTRIES=100`，键 `sessionIdOnAgent`） | 历史字段（见上文「套路 ACP-E」） |
| `acpAgentDefaultsService.ts` | 每 agent configOption 默认值（`PersistedStateBase`） | 配置项默认值持久化 |
| `acpSessionEditorInput.ts` | `EditorInput` 子类——会话即编辑器 tab，可序列化恢复（serialize 写 `sessionIdOnAgent ?? 本地id`） | 全屏 tab 行为、重启恢复 |
| `acpSessionTitleService.ts` / `acpSessionTitle.ts` / `sessionTitleFormat.ts` | 标题自动生成（AI purpose `session-title`）+ 解析/截断/格式化 | 标题逻辑 |
| `acpChatLocationService.ts` | **单一真相**：Chat 渲染在 EditorArea（全屏 tab）还是 SecondarySideBar（停靠面板）。三向同步 + ContextKey | 双模式切换 |
| `acpChatWidgetService.ts` | 已挂载 ChatBody 的 registry：DOM 容器 + moveTimeline/focusInput 回调 + `lastFocusedWidget`（命令定向） | 多实例聚焦/定向命令 |
| `sessionChangeTracker.ts` | 每会话整文件改动追踪（逆推 baseline，键 `sessionIdOnAgent`） | 会话级 diff（见 [[session-diff-feature]]） |
| `acpPermissionHandler.ts` | 自动批准 + Memory 持久化（见上文「套路 ACP-D」） | 权限策略 |
| `acpPathPolicy.ts` / `acpMcpServers.ts` / `sdkHostStream.ts` / `promptMentions.ts` / `markdownRenderer.ts` / `mentionFileSearch.ts` / `persistedStateBase.ts` / `acpProtocolTracer.ts` / `ansi.ts` / `filePathLink.ts` / `chatFindMatcher.ts` / `commandWrapper.ts` | 沙盒/MCP/流适配/@提及/markdown/文件搜索/持久化基类/协议 trace/ANSI/文件链接/查找/命令包裹 | 见各自头注释或上文 |
| `acpPromptDraftCache.ts` / `acpQuestionDraftCache.ts` / `acpChatViewStateCache.ts` | 草稿/问题答案/视图态缓存（按**本地 id** 缓存） | 草稿持久、折叠态 |
| `acpSessionFilterService.ts` / `acpSessionStatus.ts` / `acpAuthError.ts` / `agentIconData.ts` / `agentNotificationIcon.ts` | 列表过滤/状态枚举/auth 错误判定/图标 | — |
| `testing/inMemoryAcpPair.ts` | 测试用真 `ClientSideConnection` ↔ 桩 `Agent` 对联 | 写协议级测试 |

#### UI 层 `apps/editor/src/renderer/workbench/agents/`

| 文件 | 职责 |
|---|---|
| `AgentsView.tsx` | SecondarySideBar 里**唯一** AGENTS view——按 `IAcpChatLocationService` 在 `SessionListPanel`（Chat 在 EditorArea 时显列表）与 `ChatPanel`（Chat 在 sidebar 时显全功能聊天）间切换 |
| `AcpSessionEditor.tsx` | 全屏 editor 版 ChatBody——按 id 查会话，history 里有但未 live 时 auto-resume |
| `ChatPanel.tsx` / `ChatBody.tsx` | Copilot 式 sidebar 布局 / 实际渲染 timeline + 输入框的核心组件（两种模式共用 ChatBody） |
| `PromptInput.tsx` / `SendButton.tsx` / `StopButton.tsx` | 输入框（@提及/斜杠命令/草稿）+ 发送/停止 |
| `MessageList.tsx` / `MessageContent.tsx` / `UserMessageItem.tsx` / `CodeBlock.tsx` | timeline 消息渲染 |
| `ToolCallCard.tsx` / `ToolCallOutput.tsx` / `CommandInvocationBadge.tsx` / `InlineDiffPreview.tsx` / `lineDiff.ts` | 工具调用卡片 + 输出 + 命令徽章 + 内联 diff |
| `PlanView.tsx` / `StickyPlanBar.tsx` / `StickyUserMessageBar.tsx` / `StickyScrollOverlay.tsx` / `stickyScroll.ts` | 计划视图 + 各种 sticky 头 |
| `PermissionCard.tsx` / `QuestionCard.tsx` | 权限请求卡 / AskUserQuestion 轮播卡 |
| `ConfigOptionsBar.tsx` | model/mode/thought-level 配置条 |
| `SessionListPanel.tsx` / `SessionListBody.tsx` / `SessionsPopover.tsx` / `AgentsViewToolbar.tsx` / `AgentChatContextMenu.tsx` | 会话列表 + 切换 popover + 工具栏 + 右键菜单 |
| `SessionChangesView.tsx` / `SessionChangesViewToolbar.tsx` / `sessionChangesViewState.ts` | 会话级改动面板（list/tree，**用 `sessionIdOnAgent` 查 changesFor**）见 [[session-diff-feature]] |
| `useSessionTimer.ts` / `UsageIndicator.tsx` / `SessionCostIndicator.tsx` / `useExchangeRate.ts` | 计时 [[session-timer-feature]] / 上下文用量 / 人民币开销 [[session-cost-feature]] / 汇率 |
| `McpServersView.tsx` | MCP 服务器状态面板 |
| `ChatFindWidget.tsx` / `useChatFind.ts` / `chatFindHighlight.css` | 会话内查找 |
| `timelineCollapse.ts` / `timelineIcons.tsx` / `sessionStatusIcon.tsx` / `agentIcon.tsx` | timeline 折叠/图标/状态图标/agent 图标 |

#### 跨进程 / 命令 / contributions

- **main**：`src/main/services/acpHost/`（spawn + pump stdio/exit）、`src/main/services/acpTerminal/`（terminal 池）
- **shared ipc**：`src/shared/ipc/acpHostService.ts`（start/writeStdin/stop/probe）、`acpTerminalService.ts`（create/output/waitForExit/kill/release）。**无 endStdin，关流走 stop**。
- **命令**：`src/renderer/actions/agentActions.ts`——42 个 Action2（NewAgentSession / CancelAgentTurn / OpenAgentInEditor / ToggleAgentChatLocation / SelectAgent[Model|Mode|ThoughtLevel] / ResumeAgentSession / ClearAgentSessionHistory / 大量 timeline 导航/滚动/折叠 Action / ShowAcpSessionChanges …）。加命令走 `apps/editor/CLAUDE.md` 套路 A，在 `actions/index.ts` 注册。
- **contributions**：`AcpInitContribution`（启动 hydrate）/ `AgentBinaryPrefetchContribution` / `AgentFontContribution` / `AgentNotificationContribution` / `AgentsContributions`（config schema + view 注册）/ `FirstRunAgentOnboardingContribution` / `SessionShutdownParticipant`（退出时优雅关闭）。

### 数据流（速记，细节见上文「数据流」）

**出站**：`PromptInput` → `AcpSessionService.sendPrompt(text, mentions)` → `composePromptBlocks()` 转 @文件为 resource_link → `AcpSession._appendMessage('user')`（立即上屏）→ 未连接则入 `_queuedPrompts`，已连接则 `_dispatchPrompt` → `conn.prompt({ sessionId: sessionIdOnAgent, prompt })`。

**入站**：`IAcpHostService.onStdout` → `sdkHostStream` → SDK 回调 → `AcpSessionService.onSessionUpdate` → `_findSession(params.sessionId)`（用 agent id 匹配）→ `AcpSession.applyUpdate` switch（8 种 SessionUpdate，进 16ms 事务；`config_option_update` delegate 到 state machine 做 echo 抑制）。

### 常见任务 → 改哪里

- **加一种 SessionUpdate 类型**：`acpSession.ts` 的 `applyUpdate()` switch 加 case + 进 16ms `transaction` + 新 view-model 挂 `AcpSession` 上（不挂 SDK 类型）。详见上文「套路 ACP-B」。
- **改会话生命周期/连接时序**：`acpSessionService.ts` 的 `createSession`/`_connectSession`/`resumeSession`；连接绑定/队列 flush 在 `acpSession.ts` 的 `attachConnection`/`failConnection`。**任何「连接前/后」分支都要想清双 id 与队列**。
- **加附加于会话的能力**（如新 indicator / 新追踪）：view-model 字段加在 `acpSession.ts`（observable），UI 在 `workbench/agents/*` 用 `useObservable` 订阅。**注意键用 `sessionIdOnAgent` 还是本地 `id`**——跨会话持久/协议相关用前者，纯运行期 UI 缓存用后者（见下方坑 #2）。
- **改双模式布局**：`acpChatLocationService.ts`（真相 + ContextKey）+ `AgentsView.tsx`（分支）+ 命令 `ToggleAgentChatLocationAction`。
- **卡片折叠有两层，别混**：①**外层卡片折叠**（整个 message/tool_call slot 收起）走 `timelineCollapse.ts` 的 `overrides` + `session.collapseMode`，持久化进 `AcpChatViewStateCache.collapse`；②**内层内容折叠**（长用户消息过 `COLLAPSED_MAX_PX` 夹高 / execute 终端输出过高时的 "Expand/Collapse" 按钮）是叶子组件 `UserMessageItem`/`TerminalOutput` 的展开态。内层态历史上是组件本地 `useState`，切 session/切 tab/虚拟化滚屏（卸载重挂载）即丢——修法：`chatContentExpansion.tsx`（context store `{expandedKeys, toggle}`）由 `ChatBody` 提供并折进 `AcpChatViewStateCache.contentExpandedKeys` 持久化；叶子按稳定 `contentKey` 读写（用户消息 `msg:<slotKey>`、终端 `term:<stickyKey>`），无 store/key 时退回本地 state（如 `ToolCallList` 独立用法）。context 消费者随 store 变化自动重渲染，绕过 `TimelineSlot` 的 memo，无需改 memo。
- **加配置项交互**：`acpSessionConfigOptions.ts`（推送/echo）+ `ConfigOptionsBar.tsx`（UI）+ `acpAgentDefaultsService.ts`（默认值持久化）。
- **改恢复/重连**：`acpSessionRestoreCoordinator.ts` + `acpSessionEditorInput.ts`（tab 序列化）+ `acpSessionHistory.ts`（条目）。
- **claude 会话跨 compact 边界的历史回放在 fork 侧解决，编辑器零改动**：SDK `getSessionMessages` 只沿 `parentUuid` 走「有效上下文链」，compact_boundary 的 `parentUuid` 为 null（显示序前驱存在 `logicalParentUuid`，SDK 不追），所以 loadSession 重放天然丢压缩前历史。修法在 `vendor/claude-agent-acp` 的 `replaySessionHistory`：读原始转录 jsonl，`rebuildTranscriptDisplayChain` 从最新叶子沿 `parentUuid ?? logicalParentUuid` 回溯重建显示链（**链走法而非文件序**——CLI 建的会话可能含被放弃的 rewind 分支），边界处发一条 `_universe/compaction` `phase:'success'` 通知（编辑器 `applyCompaction` 对孤立 success 走 idx===-1 分支直接落一张已完成卡片），跳过 `isCompactSummary` 消息；转录缺失/无边界时回退 `getSessionMessages`，未压缩会话路径不变。模型上下文不受影响（仍 `resume: sessionId`）；rewind 无需改（压缩前锚点 → `messageUuidBefore` undefined → 全会话 resume + 磁盘截断恰好正确）。
- **codex 恢复路径的 thought chunk 必须自带 part 分隔符**：编辑器 `mergeStreamingBlock` 把同 message 的 text chunk **逐字拼接、不加任何分隔**。codex reasoning summary 每个 part 是一行 `**标题**`；流式路径 part 之间有 `summaryPartAdded` → `\n\n`（item/completed 兜底 `createCompletedReasoningEvent` 也 `join("\n\n")`），恢复路径（`CodexAcpServer.createReasoningUpdates` + `ResponseItemHistoryFallback.createReasoningUpdates`）曾逐 part 发 chunk 无分隔 → 恢复后粘连成 `**A****B**` 一坨。修法：两处恢复函数统一 `parts.filter(...).join("\n\n")` 单 chunk（对齐 live stream）。配套样式：`.messageItem/.subMessage[data-role='thought'] strong { font-weight/color: inherit }`（agents.module.css）让 thought 卡片内 markdown 强调不变成亮白粗体（`.markdown strong` 全局规则是 700 + 亮白色）。改 fork 任何「恢复重发」逻辑时，先想清楚该逻辑在流式路径靠什么分隔符，恢复侧必须复刻。
- **codex 恢复丢 shell 调用 = app-server 不重建 `custom_tool_call`，fork fallback 补**：新版 codex 的 shell/patch 调用在 rollout 里是 `custom_tool_call`(name=`exec`，input 是 JS 片段 `await tools.shell_command({...})`/`tools.apply_patch(...)`) 而非 `function_call`。live 时 app-server 实时转成 `commandExecution` item 推送；但 `thread/resume` 从 rollout 重建 turns 时**不还原**它们（apply_patch 会重建为 fileChange，shell 全丢）→ 恢复后 shell 卡片消失。排查法：用真实 codex 二进制跑 `app-server` + `thread/resume` 对比 rollout 原始记录。修法在 fork `ResponseItemHistoryFallback`：识别 exec 的 JS input，平衡括号提取 `shell_command` 的 JSON 参数合成 `shell_command` function_call 复用既有渲染管线（terminal 卡片 + commandAction 推断 + `Exit code: N` 解析，注意剥 `Script completed/failed` 包装 chunk 和 `Wall time` 头）；apply_patch 类必须 skip（thread 的 fileChange 已覆盖，且 fileChange id 是 `exec-<uuid>` ≠ rollout 的 `call_xxx`，靠 id 去重根本匹配不上）；`custom_tool_call_output` 只在 call 已 emit 时生成 update 防孤儿。改完必须 `npm --prefix vendor/codex-acp run build`（dev 入口 = `vendor/codex-acp/dist/index.js`）。
- **加 agent / 改权限 / MCP / 沙盒 / 入站方法**：见上文套路 ACP-A/D/F/C。
- **"Open Session Location"（列表右键）依赖 fork 上报 `_meta.transcriptPath`**：菜单项可用性 = history 条目 `transcriptPath` 非空，链路 = fork `session/list` 响应 `SessionInfo._meta.transcriptPath` → `acpSessionRestoreCoordinator.toBulkMergeInfo`（agent 无关通用提取）→ `acpSessionHistory` → `RevealAgentSessionInOSAction`（`host.showItemInFolder`）。claude fork 用 `findTranscriptFile` 查 `~/.claude/projects/...`；codex fork 直接映射 app-server `thread/list` 返回的 `Thread.path`（rollout JSONL，ephemeral 线程为 null 则省略）。某 agent 该项灰掉 = 其 fork 没上报，编辑器侧无需改。
- **`@@`/`@#` 触发 SimpleFileDialog 选文件/文件夹作为 @提及**：纯函数 `promptMentions.ts` 的 `detectFilePickerTrigger(text, caret)` 识别刚敲下的 `@@`(file)/`@#`(folder)，边界规则同 `extractMentionQuery`（`@` 须在行首或空白后，光标须紧跟两字符）；`PromptInput.tsx` 的 textarea `onChange` 里拦截该触发 → 剥掉两字符 → 走 `IFileDialogService.showOpenDialog`（file: canSelectFiles / folder: canSelectFolders）→ 选中后 `toMentionName(uri, workspaceRoot)` + `mergeMention` 复用既有 @提及管线（发送时 `composePromptBlocks` 序列化成 `resource_link`）。取消则只留剥除触发后的文本。测试 stub 需注册 `IFileDialogService`。
- **把 editor 选区作为上下文推给 input**（"Add Selection to Agent Chat"，Cursor Ctrl+L 式）：`promptContext.ts`（`SelectionContext` 类型 + `composeContextBlocks`：embeddedContext→`EmbeddedResource`，否则降级围栏文本块）+ `acpSession.ts`（`sendPrompt`/`_dispatchPrompt` 第三参 `contexts`，attach 时缓存 `_embeddedContextSupported`，context block 置于 prompt 前）+ `acpSessionConnection.ts`（`QueuedPrompt`/`enqueue` 带 contexts）+ 命令 `actions/agentContextActions.ts`（`FileEditorRegistry.get(activeEditor).getSelections()` 取多选区）+ UI `SelectionContextChips.tsx` + `PromptInput.tsx`（contexts state/持久化/reveal）+ 右键菜单走 Monaco `editor.addAction`（FileEditor.tsx，Monaco 自带右键菜单**不读**我们的 MenuRegistry）。draft cache 加 `contexts` 字段，按**本地 id** 缓存（未发送草稿）。
  - **路由关键坑**：命令**不能直接调** `widget.addSelectionContext`——用户在文件编辑器里选文本时，目标 session 的 ChatBody 常常**没挂载**（editor 模式 session tab 没打开，或刚 `createSession` 还没渲染），widget 为 undefined 会静默丢弃。正解：`acpPromptContextInbox.ts`（模块单例收件箱，按**本地 session id** 存 + `onDidDeposit` 事件）。命令流程：定位/创建目标 session（activeSession 否则 createSession）→ `deposit(session.id, contexts)` → 打开并聚焦该 chat（editor 模式 openEditor AcpSessionEditorInput / sidebar 模式 openViewContainer + `focusSessionInput`）。PromptInput 挂载时 `drain` + 订阅 `onDidDeposit` 即时消费，跨「未挂载→挂载」不丢。

### 关键架构决策与「为什么」

- **双 id 解耦**：本地 uuid 让 UI 在握手（1-5s）完成前就渲染并接受输入；durable agent id 用于一切需要跨重启/跨进程稳定的引用。`_findSession` 双匹配让调用方无需关心当前是哪种。见 [[async-session-create]]。
- **prompt 队列而非禁用输入**：连接中用户照常输入，attach 后自动发——「无缝」体验的核心，用户选定的取舍。
- **timeline 单一真相 + 三 lane 副本**：UI 只读 timeline 保证顺序正确；lane observable 给需要按类型读的 selector。
- **16ms 防抖事务**：流式 chunk 高频，逐条 set 会抖到没法看；合批是性能底线。
- **连接池 refcount**：同 agentId+cwd 的多会话共享一个子进程（如同 cwd 两会话），省 spawn；池在 `acpClientService.ts`。
- **持久化只存字符串元数据**：无 ContentBlock/SessionUpdate 落盘；恢复时拿 `sessionIdOnAgent` 调 `loadSession` 让 agent 重放。双桶 scope（WORKSPACE + GLOBAL fallback）见上文「持久化」。

### 易踩坑速记

1. **混淆两个 id**：协议路由/history/change-tracker/active 持久化/tab serialize 用 `sessionIdOnAgent`；React key/运行期缓存/`activeSessionId` 用本地 `id`。用错会「消息不路由」或「重启丢会话」。
2. **连接前访问连接相关状态**：握手未完时 `sessionIdOnAgent.get()` 是 undefined、`getConn()` 是 undefined。所有读这些的代码都要 guard。测试里在注入 agent 通知/访问 `client.connected[...]`/断言 seed 状态前**必须 `await session.whenConnected()`**。
3. **`T | null` ≠ `T | undefined`**——见上文「SDK 关键约定」#1。
4. **新增更新没进 16ms 事务**：会产生抖动/中间态闪烁。
5. **FakeSession stub 漏新接口成员**：`IAcpSession` 加方法（如 `whenConnected`）后，`ConfigOptionsBar.test.tsx` / `PromptInput.test.tsx` / `SessionChangesView.test.tsx` 等的本地 stub 要同步补，否则 typecheck 红。
6. **FakeStorage 启动 fire workspace-swap**：异步 createSession 下，启动期的 `onDidChangeWorkspaceScope` 微任务会触发 `_onWorkspaceSwap` 把刚建、未 attach 的 session close 掉——测试给 service 自身的 storage 要退订该启动事件。见 [[async-session-create]]。
7. **其余 SDK 协议坑**（ToolKind 10 枚举 / setConfigOption 无 type:'select' / void 序列化为 {} / cancel 双步 / terminal ownership / stderr 独立通道 / env denylist / stdio MCP 不带 type）：全在上文「SDK 关键约定」#2-#10，改协议层前必读。
8. **会话标题四个写入方，优先级 manual > ai > agent 报告（`session_info_update`/hydrate 的 summary）> 首条 prompt 派生**：`updateInfo` 默认不覆盖 `aiTitle/manualTitle` 行，权威写入（AI 标题落盘、rename）走 `overwriteProtectedTitle` 显式通道；AI 生成跳过本地内置命令 prompt（`isLocalCommandPrompt`，/model 等，不消耗机会）且返回 undefined 自动 re-arm 下条重试；fork 回放自定义命令重建为 `/name args`（`stripLocalCommandMetadata`）。**排查标题问题先看 main 侧 `ai-debug.jsonl` 有无 `session-title` 请求**：没有 = renderer 在 `_resolveModelId` 静默返回（现已有 debug 日志 `acp.sessionTitle`）；有但标题没落地 = history 写入方时序/覆盖问题。注意 `createdAt` 在 upsert 重加时不重置，但 hydrate 首次导入外来行时 = 导入时刻，别拿它当会话真实创建时间。
9. **长 timeline 从底向上滚动抖动**：有两条独立成因，都会让 `scrollTop` 在某个落点上下高频振荡、直到手动拖进度条才停。**(a) 补偿策略太宽**：`ChatBody` 的动态虚拟行从 `estimateRow` 切到真实高度时，TanStack Virtual 默认以 `item.start < scrollOffset` 判断是否补偿，会把顶部半可见行也按完整高度差反向修正 `scrollTop`，与用户向上滚动互相拉扯。修法：`shouldAdjustScrollPositionOnItemSizeChange` 必须只在整行位于视口上方（`item.end <= scrollOffset`）时返回 true（见 `timelineVirtualScroll.ts`）；虚拟模式同时设 `overflow-anchor: none` 避免 Chromium 原生锚定重复补偿；restore / bottom-pin 收敛窗口可临时设 `() => false`，结束后必须恢复自定义策略，不能恢复为 `undefined`（否则退回 TanStack 默认规则）。**(b) 行高每次挂载不稳定（真根因，即使全表高度已重算过仍复发）**：`item.end <= offset` 只是必要条件不是充分条件——若视口上方某行每次重挂载测出的高度都不同，补偿会重挂载它、它又闪回旧高度，形成自持振荡。历史案例是 `TerminalOutput`（execute 卡片）首帧按全高挂载、随后 async 夹到 `COLLAPSED_MAX_PX`，虚拟列表滚回 overscan 时反复重挂载→高度反复翻转。修法在高度源头：用纯函数 `estimateTerminalOverflow(text)` 同步 seed `overflows`，让首帧就提交到最终夹后高度，每次挂载高度一致，不再触发补偿（见 `ToolCallOutput.tsx`）。**任何叶子组件在挂载后异步改变自身高度都可能复现此环**，新增此类组件时首帧高度必须可由数据同步推定。回归测试：`timelineVirtualScroll.test.ts`（预测逻辑）+ e2e `smoke.agentsScrollJitter.spec.ts`（真 `page.mouse.wheel` 打点 `window.__TIMELINE_SIZE_CORRECTIONS_TOTAL__` 证明静止时无自持补偿环——注意合成 `el.scrollTop=x`+dispatch scroll 会重置 `scrollAdjustments` 掩盖该环，必须用真滚轮）。
10. **第一条用户消息不在 `displayTimeline` 里**：`ChatBody` 把它 slice 掉改由滚动容器上方的 `StickyUserMessageBar` 常驻渲染（提交 f2d35dc3 去重）。**渲染/虚拟化索引用 `displayTimeline`，键盘导航/复制等语义操作必须用完整 `timeline`**——`handle.move` 曾因读 displayTimeline 让首条用户消息成为导航黑洞；现在 move 遍历完整 timeline，命中被 slice 的项（displayIndex === -1）时 reveal 就是 `scrollTop = 0`（sticky bar 恒可见），virtualizer `scrollToIndex` 必须换算回 displayTimeline 坐标。焦点高亮跨组件同步走 `FocusedKeyBridge`（`{key, emitter}`，ChatSessionBody 在 render 期挂到 `handleRef.current`）——**不能由 ChatScroll 的 effect 赋值**，因为 StickyUserMessageBar 先于 ChatScroll 挂载，订阅时 handle 方法还是 NOOP；emitter 沿用 activeSlotRef 的「不 dispose、GC 回收」StrictMode 模式。**焦点框（`timelineSlotFocused`）要加在内层卡片上，别加全宽 `ul.stickyUserBar`**——ul 左右贴到聊天区边缘，x≈1–2px 处的 outline 会被 workbench 分界 sash 盖掉；卡片内缩 12px，与列表内 TimelineSlot 的焦点框几何一致。

### 测试套路

- 协议级一律走 `testing/inMemoryAcpPair.ts`（真 `ClientSideConnection` ↔ 桩 `Agent`，断言 fake agent 方法被调 + 参数对，不断言 jsonline 字节）——见上文「测试模式」。
- **异步握手**：凡 `createSession` 后要碰连接/通知/history 的，先 `await session.whenConnected()`；resume 路径仍全程 await。
- 主要测试文件（对照扩展）：`AcpSessionService.test.ts`（生命周期/消息/工具/计划/权限分发）、`AcpSessionService.configOptions.test.ts`、`acpSessionConfigOptions.test.ts`（state machine 单测）、`AcpSessionService.resume.test.ts`、`AcpSession.timeline.test.ts`、`AcpSession.poolResume.integration.test.ts`、`acpSessionRestoreCoordinator.test.ts`、`AcpAgentRegistry.test.ts`、`acpPathPolicy.test.ts`、`acpMcpServers.test.ts`、`acpSessionHistory.test.ts`、`sdkHostStream.test.ts`；UI 侧 `workbench/agents/__tests__/*`。

### 验证

```bash
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 涉及交互逻辑改动时跑冒烟，仅截取错误
```

### 关键参考路径

- `acpSessionService.ts` / `acpSession.ts` / `acpSessionConfigOptions.ts` —— 三层核心（facade / view-model / 配置状态机）
- `acpClientService.ts` —— 连接池 + SDK 装配 + 网关
- `acpSessionRestoreCoordinator.ts` —— 恢复时序
- `workbench/agents/AgentsView.tsx` + `ChatBody.tsx` + `AcpSessionEditor.tsx` —— 双模式 UI 入口
- `actions/agentActions.ts` —— 全部会话命令
- SDK 类型源码：`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
- 配置 key：`acp.agents` / `acp.permissions.autoApprove` / `acp.startupTimeoutMs` / `acp.defaultAgentId` / `acp.mcpServers` / `acp.defaultCollapseModes`
- 相关：`apps/editor/src/renderer/services/ai/CLAUDE.md`（AI 设置页）；`apps/editor/CLAUDE.md` 套路 A/B/C（命令/View/跨进程服务注册）

## Agent 设置：Claude

> **代码不在 `services/acp/` 下**：UI 在 `apps/editor/src/renderer/workbench/agentSettings/claude/`（承载壳为 `workbench/ai/AiSettingsEditor.tsx`），main 实现在 `apps/editor/src/main/services/claudeConfig/`，wire 契约在 `apps/editor/src/shared/ipc/claudeConfigService.ts`；因设置面板按 acp agent 贡献注册、与 ACP 子系统强相关，故并入本文。

agent 设置是**多 agent 的可扩展子系统**：统一 Settings editor 的左侧「Agents」组按 `IAcpAgentRegistry` 列出所有 acp agent（claude-code、codex、用户自定义），每个 agent 通过**模块级贡献注册表**挂自己的设置组件。Claude 的设置内容全部收敛在 `agentSettings/claude/` 命名空间下。

> 🔀 **2026-06 合并**：agent 设置原是独立的 Agent Settings editor，现已并入 AI Settings 的统一壳（`workbench/ai/AiSettingsEditor.tsx`）。本节讲 **agent 设置内容本体**（注册表 + Claude 面板 + claudeConfig 服务）；**承载它的壳**（AI/Agents 双组导航、激活项持久化、入口命令）见 `apps/editor/src/renderer/services/ai/CLAUDE.md`。

### 文件地图

#### Renderer — 承载壳（见 `apps/editor/src/renderer/services/ai/CLAUDE.md`）
- `renderer/workbench/ai/AiSettingsEditor.tsx` — 统一 Settings editor 壳。左侧「Agents」组动态列出 `IAcpAgentRegistry.list()`，选中 agent 后右侧 `getAgentSettingsComponent(id)` 渲染其贡献组件，无注册则占位。激活项持久化用 `settings.activeItem`（值 `agent:<id>`）。壳顶部 `import '../agentSettings/builtinAgentSettings.js'` 触发副作用注册。
- `agentSettings/agentSettingsRegistry.ts` — 贡献注册表。`registerAgentSettings(agentId, component)` / `getAgentSettingsComponent(agentId)`，`AgentSettingsComponentProps { agentId }`。
- `agentSettings/builtinAgentSettings.ts` — 内置 agent 设置的副作用聚合 hub：`import './claude/ClaudeAgentSettings.js'`。**新增 agent 设置时在这里加一行 import。**
- `agentSettings/AgentSettingsEditor.module.css` — Claude 面板共用样式（`agentBody`/`subNav`/`subBody`/认证库/状态行等，用 `--ue-*` token）。注意：壳本身的样式在 `ai/AiSettingsEditor.module.css`（用 `--color-*` token），两套并存。

#### Renderer — Claude 专属（agentSettings/claude/）
- `claude/ClaudeAgentSettings.tsx` — Claude 设置根组件。持有 `useClaudeConfig()`，三分类子导航（auth/model/env，`CATEGORIES` 数组），滚动位置 + 激活分类经 `IStorageService` 持久化（`agent.settings.claude.activeCategory`、`agent.settings.claude.scroll.<id>`）。**末行 `registerAgentSettings('claude-code', ClaudeAgentSettings)`。**
- `claude/AuthenticationPanel.tsx` — 认证页。两块：`CredentialLibrary`（已存凭据档案列表 + 新增表单）与 `LoginForm`（OAuth 登录状态 + 登录按钮）。算激活态：`isProfileActive` / `isLoginActive`（由 env + auth 状态推导，不是 UI 展开态）；`mask()` 脱敏显示。
- `claude/ModelThinkingPanel.tsx` — 模型 / 语言 / 思考开关 / effort / availableModels，绑 settings.json。
- `claude/AdvancedEnvPanel.tsx` — env 开关（PROMPT_CACHING、AUTO_COMPACT）+ 自定义 env 编辑器，隐藏 `AUTH_ENV_KEYS`（认证类 env 归 AuthenticationPanel 管）。
- `claude/useClaudeConfig.ts` — Claude 配置 hook。聚合 settings/authStatus/profiles 的读取与 patch/save/delete/apply。`applyProfile` 把某档案注入 settings.json 的 env（互斥清掉另一种凭据，见下）。常量 `API_KEY`/`AUTH_TOKEN`/`BASE_URL`。
- `claude/claudeLogin.ts` — `runClaudeLogin()` 开终端跑 `claude auth login --claudeai|--console`。

#### 跨进程服务三层
- `shared/ipc/claudeConfigService.ts` — **wire 契约**。`IClaudeConfigService` 装饰器 + 所有类型（`ClaudeSettings`、`ClaudeSettingsPatch`、`ClaudeAuthStatus`、`ClaudeCredentialKind`、`ClaudeCredentialProfile`）。方法：`read`/`patch`/`configPath`/`readAuthStatus`/`readProfiles`/`writeProfiles`。
- `main/services/claudeConfig/claudeConfigMainService.ts` — **main 实现**。原子写（mkdir -p + temp + rename），读容错（缺失/损坏返回空）。
- `main/services/claudeConfig/__tests__/claudeConfigMainService.test.ts` — readAuthStatus（6 例）+ credential profiles（5 例）。

### claudeConfig 服务接线（5 处，加方法时无需动）

服务方法走 `ProxyChannel`，**给 `IClaudeConfigService` 加方法只改契约 + main 实现两个文件，下面 5 处接线不用动**：
1. `main/services/main-services.ts` — `SyncDescriptor` 注册 `ClaudeConfigMainService`
2. `main/window/scopedServicesFactory.ts` — `readonly claudeConfig` 字段
3. `main/ipc/registerMainServices.ts` — `ProxyChannel.fromService(app.claudeConfig)`
4. `shared/ipc/channelNames.ts` — `ClaudeConfig: 'claudeConfig'`
5. `renderer/main.tsx` — `ProxyChannel.toService<IClaudeConfigService>(...)`

### 三个配置文件的语义（关键）

| 文件 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `~/.claude/settings.json` | 编辑器 + CLI 共享 | agent/SDK/CLI | **当前生效**配置：model、env（含激活的凭据）、思考开关等 |
| `~/.claude/.credentials.json` | `claude auth login`（OAuth） | agent/SDK | `claudeAiOauth`：accessToken/refreshToken/expiresAt/scopes/subscriptionType/rateLimitTier |
| `<configDir>/aiSettings.json` 的 `agentSettings.claude.authentication` | **仅编辑器** | 仅编辑器 | 凭据**档案库**（多套 apiKey / token+url 候选），不是生效配置 |
| renderer `IStorageService` 全局键 `agentSettings.claude.credentialDraft` | **仅编辑器** | 仅编辑器 | 认证面板未保存的表单草稿（UI 状态，不进配置文件） |

- **settings.json = 当前生效菜；profiles.json = 候选菜单。** 「使用某档案」= 把它注入 settings.json 的 env。
- **登录(OAuth) 不是一个 profile**，它走 `.credentials.json`，与档案库平行。

### 认证优先级（agent/SDK 解析顺序）

`ANTHROPIC_AUTH_TOKEN`(+`ANTHROPIC_BASE_URL`) > `ANTHROPIC_API_KEY` > OAuth 登录(`.credentials.json`)。

`applyProfile` 据此**互斥注入**（保证只有一种凭据生效）：
- `apiKey` 档案 → `{API_KEY: 值, AUTH_TOKEN: null, BASE_URL: null}`
- `gateway` 档案 → `{AUTH_TOKEN: 值, BASE_URL: 值, API_KEY: null}`

`isLoginActive` 仅当 env 里既无 token 也无 apiKey（即没有更高优先级凭据覆盖）时为真。

### 🔒 安全约束（刻意决策，勿擅改）

1. **凭据明文落盘是用户明确选择**：apiKey/token/baseUrl 明文写进 `settings.json`（与 CLI 共享）和 `aiSettings.json` 的 Claude 认证区，**刻意**不用加密 SecretStorage。项目 CLAUDE.md「AI provider 密钥必须走 ISecretStorageService、绝不进 settings.json」那条**只针对 AI provider 特性，不适用本 Claude 配置共享特性**。
2. **`readAuthStatus()` 绝不回传 OAuth token**：只回 `{loggedIn, expired, subscriptionType?, expiresAt?}`。有测试断言 token 不泄漏，改 readAuthStatus 时务必保住该测试。

### 常见任务 → 改哪里

- **给 Claude 加一个新设置项**：定字段进 `ClaudeSettings`/`ClaudeSettingsPatch`（契约）→ main 实现读写 → 对应面板（model 类→ModelThinkingPanel、env 类→AdvancedEnvPanel、认证类→AuthenticationPanel + `AUTH_ENV_KEYS`）加 UI，经 `useClaudeConfig().patch` 落盘。
- **给 claudeConfig 加一个跨进程方法**：只改契约 + main 实现两个文件（5 处接线不动）。
- **再加一个 acp agent 的设置页（如 codex）**：新建 `agentSettings/codex/CodexAgentSettings.tsx`，末行 `registerAgentSettings('codex', CodexAgentSettings)`；在 `builtinAgentSettings.ts` 加一行 `import './codex/CodexAgentSettings.js'`。**壳零改动**——只要该 agent 在 `IAcpAgentRegistry.list()` 里，就会自动出现在 Settings 的 Agents 组。Codex 的设置页已存在，其凭据模型（双文件 config.toml/auth.json、resolved_mode 优先级、双维度 auth 状态、fs.watch 实时刷新）与 Claude 不同，见下文「Agent 设置：Codex」。
- **加一个凭据种类**：扩 `ClaudeCredentialKind`，改 `applyProfile` 的互斥注入逻辑 + `ProfileForm` 表单 + `isProfileActive`。
- **接入第三方模型（Kimi/GPT 等）**：无需新代码——`gateway` profile 已可带 `model`/`smallFastModel` 预设（一个凭据=一套「网关+模型」，`applyProfile` 时连同 `settings.model` + `env.ANTHROPIC_SMALL_FAST_MODEL` 一起注入；`isProfileActive` 把 model 纳入比对）。Claude Code 只说 Anthropic 协议：Kimi 有原生兼容端点直连，GPT 需 LiteLLM/claude-code-router 代理转协议。用户文档见 `docs/user/zh-CN/ai-agent/models-and-cost.md`。

### 易踩坑速记

- `useObservable` / `useService` 来自 `renderer/workbench/useService.ts`（即面板里的 `../../useService.js` / `../useService.js`），**不是** `@universe-editor/workbench-ui`。
- workbench-ui 的 `IconButton` API 是 `label: string` 属性 + `children` 放图标：`<IconButton label="编辑"><Pencil size={14}/></IconButton>`，没有 `icon`/`ariaLabel` props。
- ESM：相对导入带 `.js` 后缀（即使源是 `.ts`）。`claude/` 比外壳深一层，import 路径多一级 `../`。
- 状态持久化套路：`IStorageService` 存 key + `restoredRef` 守卫防覆盖 + `requestAnimationFrame` 恢复滚动。
- NLS：`localize(key, '英文默认值', vars?)`，默认值必须英文；中文写进 `shared/i18n/messages/zh-CN.ts`。当前该子系统多用内联文案，若新增 key 记得补 zh-CN。
- 新增 FakeSession 测试桩别忘 `onDidRequireAuth: Event.None`（认证流相关）。
- 未跟踪文件用 `git mv` 会失败（exit 128），用普通 `mv`。

### 验证

- `pnpm check`（lint + typecheck + test，输出长，只截错误）。
- 改交互逻辑跑 `pnpm e2e`。已知本机 flaky（非回归）：simpleFileDialog / multiFileDragEditor / explorerExternalWatcher / markdown* @p1（多 worker / exthost 环境问题，单跑必过）。

### 入口（打开到 Agents 区）

- 主入口：命令 `ai.manageModels`（标题 “Open AI & Agent Settings”）打开统一 Settings editor。
- agent 专用入口：命令 `workbench.action.agent.openSettings`（`actions/agentActions.ts` 的 `OpenAgentSettingsAction`）——先 `storage.set('settings.activeItem', 'agent:<defaultAgentId>')` 再打开 `AiSettingsEditorInput`，落点直接在 Agents 区。**此命令 ID 被 AcpSessionEditor 齿轮、`acpSessionService`（两处）引用，勿改 ID。**

### 关键参考路径

- 承载壳：`renderer/workbench/ai/AiSettingsEditor.tsx`（Agents 组渲染 + 激活项持久化）→ 见 `apps/editor/src/renderer/services/ai/CLAUDE.md`
- 贡献注册：`renderer/workbench/agentSettings/{agentSettingsRegistry.ts,builtinAgentSettings.ts}`
- Claude 内容：`renderer/workbench/agentSettings/claude/*` + `agentSettings/AgentSettingsEditor.module.css`
- 服务：`shared/ipc/claudeConfigService.ts`、`main/services/claudeConfig/claudeConfigMainService.ts`
- 编辑器输入：`renderer/services/editor/AiSettingsEditorInput.ts`（TYPE_ID `aiSettings`，URI `universe:/aiSettings`）— 注意 `AgentSettingsEditorInput` 已删
- 入口命令：`renderer/actions/agentActions.ts`（`OpenAgentSettingsAction`）、`renderer/actions/aiActions.ts`（`ManageModelsAction`）
- agent 注册表：`renderer/services/acp/acpAgentRegistry.ts`（`IAcpAgentRegistry`、`BUILTIN_AGENTS`、`agentIconId()`）

## Agent 设置：Codex

> **代码不在 `services/acp/` 下**：UI 在 `apps/editor/src/renderer/workbench/agentSettings/codex/`，main 实现在 `apps/editor/src/main/services/codexConfig/`，wire 契约在 `apps/editor/src/shared/ipc/codexConfigService.ts`；与 Claude 设置共用同一外壳与贡献注册表（见上文「Agent 设置：Claude」），但凭据模型完全不同。

Codex 是接入统一 Settings editor「Agents」组的 acp agent 之一。它**复用** Claude 那套贡献机制(`agentSettingsRegistry` + `builtinAgentSettings`),但**凭据模型与 Claude 完全不同**:Codex 把状态摊在两个文件里,且一个 `auth.json` 同时容纳 ChatGPT OAuth token 块和 `OPENAI_API_KEY`,靠 `auth_mode` 字段决定用哪个。本节只讲 **Codex 设置内容本体**。

> 🔀 **承载壳**(AI/Agents 双组导航、激活项持久化、入口命令)见 `apps/editor/src/renderer/services/ai/CLAUDE.md`;**Claude 同类子系统**见上文「Agent 设置：Claude」(两者共用 `agentSettingsRegistry` / `builtinAgentSettings` / `AgentSettingsEditor.module.css`)。

### 文件地图

#### Renderer — 贡献注册(与 Claude 共用)
- `agentSettings/agentSettingsRegistry.ts` — `registerAgentSettings(agentId, component)` / `getAgentSettingsComponent(agentId)`。
- `agentSettings/builtinAgentSettings.ts` — 副作用聚合 hub,已有 `import './codex/CodexAgentSettings.js'`。
- `agentSettings/AgentSettingsEditor.module.css` — 面板共用样式(`agentBody`/`subNav`/`subBody`/`navItem`/认证库/状态行),`--ue-*` token。Claude / Codex 共用。

#### Renderer — Codex 专属(agentSettings/codex/)
- `codex/CodexAgentSettings.tsx` — 根组件。持有单个 `useCodexConfig()`,四分类子导航(`CATEGORIES`:auth/model/safety/advanced),激活分类 + 滚动位置经 `IStorageService` 持久化(`agent.settings.codex.activeCategory`、`agent.settings.codex.scroll.<id>`)。**末行 `registerAgentSettings('codex', CodexAgentSettings)`。** 仅 `config.loaded` 后渲染面板。
- `codex/CodexAuthenticationPanel.tsx` — 认证页,**最复杂**。两块:`CredentialLibrary`(API key / gateway 档案库 + 新增表单)与 `LoginForm`(ChatGPT 登录状态 + 登录按钮)。**判定"真正 In Use"靠两个条件叠加**:① `authStatus`(auth.json 解析出谁是凭据)② config.toml 顶层 `model_provider` 是否为空(`builtinActive = model_provider===''`)。因为 ChatGPT/API key 都走内置 `openai` provider,**只有 `model_provider` 为空时才真生效**;一旦它指向 `codex-gateway`/`kuro` 之类自定义 provider,auth.json 里的登录被绕过。所以:`chatgptActive = authStatus.active==='chatgpt' && builtinActive`;gateway 档案的 `isActive = gatewayActive(model_provider==='codex-gateway') && base_url 匹配`;API key 档案 `isActive = apiKeyActive && builtinActive`。`authStatus.chatgpt` 只要 token 在盘上就一直显示 "Signed in";`overridden = signedIn && !chatgptActive`(登录了但被 API key 或 gateway 顶掉)时显示 "a saved credential is currently taking precedence." + "Use this login"(调 `switchToChatgptLogin`)。**踩坑历史**:早先只看 `authStatus.active` 忽略 `model_provider`,导致 ChatGPT 登录后即便 gateway 在顶层生效也误显 "In Use"(两处徽章同时亮)。
- `codex/CodexModelPanel.tsx` — model / model_provider(free-text,blur 提交) / model_reasoning_effort(select 即时写),绑 config.toml。
- `codex/CodexSafetyPanel.tsx` — `approval_policy` + `sandbox_mode` 两个 select,绑 config.toml。
- `codex/CodexAdvancedPanel.tsx` — `cli_auth_credentials_store` 选择 + `hide_agent_reasoning` 开关 + 自由标量键编辑器。隐藏其他面板管的键(model/approval/sandbox/base URL),只编标量(嵌套表如 `[model_providers.*]` 留给原始文件)。
- `codex/useCodexConfig.ts` — 配置 hook。聚合 settings/authStatus/profiles 读取与 patch/save/delete/`applyProfile`/`switchToChatgptLogin`。**所有凭据切换统一走 `service.applyCredential(intent)`**(见下「三种登录方案」):`applyProfile` 据档案 kind 发 `{kind:'gateway',baseUrl,apiKey,providerName}` 或 `{kind:'apiKey',apiKey}`;`switchToChatgptLogin` 发 `{kind:'chatgpt'}`。**没有** `setApiKey`/`ensureCodexGatewayProvider`/`BASE_URL` 常量了(均被 `applyCredential` 取代)。**订阅 `onDidChangeAuth`** 实现 auth.json 落盘后实时刷新登录状态。
- `codex/codexLogin.ts` — `runCodexLogin()` 开集成终端跑 **`codex login`**(系统 PATH 的官方 codex CLI)。**注意:不是 codex-acp**——我们为 agent 下载的 `codex-acp` adapter 没有 `login` 子命令,OAuth 归官方 `codex` CLI。

#### 跨进程服务三层
- `shared/ipc/codexConfigService.ts` — **wire 契约**。`ICodexConfigService` 装饰器 + 全部类型(`CodexSettings`(含 `model_provider` / `model_providers?: Record<string,unknown>`)/`CodexSettingsPatch`/`CodexAuthStatus`/`CodexCredentialKind`/`CodexCredentialProfile`/**`CodexCredentialIntent`** + 枚举 `CodexReasoningEffort`/`CodexApprovalPolicy`/`CodexSandboxMode`/`CodexCredentialStore`)。方法:`read`/`patch`/`configPath`/`readAuthStatus`/**`applyCredential(intent)`**/`readProfiles`/`writeProfiles` + 事件 `onDidChangeAuth`。`CodexCredentialIntent` 是判别联合:`{kind:'gateway',baseUrl,apiKey,providerName?}` | `{kind:'apiKey',apiKey}` | `{kind:'chatgpt'}`。
- `main/services/codexConfig/codexConfigMainService.ts` — **main 实现**。`extends Disposable`。原子写(mkdir -p + temp + rename),读容错(缺失/损坏返回空)。核心是 `applyCredential` + 内部纯函数 `reconcileGatewayProvider(current, intent)`(见下「三种登录方案」)。构造里 `_startAuthWatch()`,`override dispose()` 关 watcher。
- `main/services/codexConfig/__tests__/codexConfigMainService.test.ts` — readAuthStatus(含共存 + 优先级用例)+ `applyCredential`(gateway 自包含 provider 写入 / chatgpt-token 保留 / 残留 base_url 清理 / 保留用户手写 provider 如 `[model_providers.kuro]`)+ profiles + `onDidChangeAuth` 事件。共 31 个用例。

### codexConfig 服务接线(6 处,加方法时无需动)

服务方法 + `onDidChange*` 事件都走 `ProxyChannel`(事件自动透传),**给 `ICodexConfigService` 加方法只改契约 + main 实现两个文件,下面 6 处接线不用动**:
1. `main/services/main-services.ts` — `SyncDescriptor<ICodexConfigService>(CodexConfigMainService, [undefined], false)`(`[undefined]` = configPath 用默认)
2. `main/window/scopedServicesFactory.ts` — `readonly codexConfig` 字段
3. `main/ipc/registerMainServices.ts` — `ProxyChannel.fromService(app.codexConfig)`
4. `shared/ipc/channelNames.ts` — `CodexConfig: 'codexConfig'`
5. `renderer/ipc/registerProxyServices.ts` — `ProxyChannel.toService<ICodexConfigService>(...)`(**Codex 在这里注册,不在 renderer/main.tsx**——与 Claude 不同)
6. (事件无需额外接线:`ProxyChannel` 自动代理 `onDidChange*` 命名的 Emitter)

### 两个配置文件 + 一个档案库的语义(关键)

`$CODEX_HOME`(默认 `~/.codex`)下:

| 文件 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `config.toml` | 编辑器 + CLI 共享 | agent/CLI | model / reasoning / approval / sandbox / 顶层 `model_provider` / `[model_providers.*]` 等。smol-toml 解析,**就地编辑保留未管理键** |
| `auth.json` | `codex login`(ChatGPT) / 编辑器(API key) | agent/CLI | JSON。可**同时**含 `OPENAI_API_KEY` + `tokens`(ChatGPT OAuth 块)+ `auth_mode` 字段 |
| `<configDir>/aiSettings.json` 的 `agentSettings.codex.authentication` | **仅编辑器** | 仅编辑器 | API key / gateway **档案库**(候选),不是生效配置 |
| renderer `IStorageService` 全局键 `agentSettings.codex.credentialDraft` | **仅编辑器** | 仅编辑器 | 认证面板未保存的表单草稿(UI 状态,不进配置文件) |

- **三种登录方案落地到不同位置**(见下「三种登录方案」):ChatGPT/官方 API key → auth.json + 顶层 `model_provider` 留空;gateway → 自包含写进 `[model_providers.codex-gateway]` + 顶层 `model_provider='codex-gateway'`,**不碰 auth.json**。
- **ChatGPT 登录不是 profile**:它是 `codex login` 管的单一共享登录,与档案库平行。
- `patch` 里把某键设 `null` = 删除该键(清除残留 `openai_base_url` 的唯一办法)。
- **编辑器只靠改这两个文件控制 codex**:绝不调 ACP `authenticate`、绝不注入 `MODEL_PROVIDER`/`CODEX_CONFIG` 环境变量(那些只被 codex-acp 的 `index.ts` 读;编辑器不设)。

### 三种登录方案(核心——理解所有 auth 行为的钥匙)

| 方案 | 凭据存哪 | 用哪个 provider | 机制 |
|---|---|---|---|
| ChatGPT 登录(Plus/Pro) | `auth.json` 的 `tokens` 块 + `auth_mode:"chatgpt"` | 内置 `openai` | OAuth token,codex 自己刷新 |
| 官方 OpenAI API Key | `auth.json` 的 `OPENAI_API_KEY` + `auth_mode:"apikey"` | 内置 `openai` | key 作 Bearer 发往 api.openai.com |
| 自定义 gateway(kurogames) | provider 自己的 `experimental_bearer_token` | 独立命名的 provider | 与 OpenAI auth 无关 |

**最关键的解析规则**:ChatGPT 与 API Key **都走内置 `openai` provider**,而内置 `openai` **仅在 config.toml 顶层 `model_provider` 为空/未设时才生效**。一旦 `model_provider` 指向某自定义 provider(如 `codex-gateway`/`kuro`),auth.json 里的登录就被绕过——即便 `auth_mode`/resolved 仍报 chatgpt/apikey 也没用(这就是"误显 In Use"的根因)。

**gateway = 完全自包含的独立 provider**(镜像用户手写的 `[model_providers.kuro]`):
```toml
model_provider = "codex-gateway"
[model_providers.codex-gateway]
name = "..."                          # = profile.label
base_url = "https://..."
wire_api = "responses"
supports_websockets = false           # 关掉 wss 探测,避免 403
experimental_bearer_token = "sk-..."  # key 直接落 config.toml(用户明确选择)
```
**绝不**碰 `auth.json`、**绝不**写顶层 `openai_base_url`、**绝不**用 `requires_openai_auth`——这三个都会把 gateway 跟 OpenAI auth 错误耦合。

**两个已修复的历史设计错误**(勿重蹈):① 用顶层 `openai_base_url` 重定向内置 `openai` → 把 ChatGPT token 发去 gateway → `access token could not be refreshed... another account`;② gateway 用 `requires_openai_auth = true` 复用 auth.json 的 key → 强行把 gateway auth 跟 ChatGPT/官方 auth 绑死。

### 统一入口 applyCredential(intent)

三种凭据切换全部走 main 的 `applyCredential(intent: CodexCredentialIntent)`,**一次原子写齐 auth.json + config.toml**,返回最新 `CodexAuthStatus`:

- `{kind:'apiKey',apiKey}`:auth.json 写 `OPENAI_API_KEY` + `auth_mode='apikey'`;config 经 `reconcileGatewayProvider` 拆掉 gateway provider+指针+残留 `openai_base_url`(回到内置 openai)。
- `{kind:'chatgpt'}`:auth.json 删 `OPENAI_API_KEY`,若仍有 ChatGPT token 则 `auth_mode='chatgpt'` 否则删 mode(**保留 token,不登出**);config 同样拆掉 gateway,顶层 `model_provider` 清空。
- `{kind:'gateway',baseUrl,apiKey,providerName?}`:auth.json 只删 key 不动 token;config 写自包含 provider + `model_provider='codex-gateway'`,删 `openai_base_url`。**保留**用户手写的其它 provider(如 `[model_providers.kuro]`)。

`reconcileGatewayProvider(current, intent)` 是纯函数,返回新 settings(无变化返回 `null`)。**ChatGPT + API key 可共存**:切到 chatgpt 只清 key、不删 token。

### resolved_mode(auth.json 内部:ChatGPT vs API key 选谁)

`_resolveAuthMode()` **镜像 codex-rs `resolved_mode()`**(login/src/auth/manager.rs)。注意它只决定 auth.json 内部用 token 还是 key,**与顶层 `model_provider` 是否生效是两码事**:

1. 显式 `auth_mode` 字段优先:`'apikey'`→apiKey;`'chatgpt'`/`'chatgptAuthTokens'`→chatgpt
2. 否则按字段存在性:`OPENAI_API_KEY` **先于** ChatGPT token 块 → apiKey
3. 否则有 `tokens.access_token` → chatgpt
4. 都没有 → none

(`personalAccessToken`/`bedrockApiKey`/`agentIdentity` 这几个 mode 本面板不展示,走第 2 步兜底。)

`applyCredential` 据此锁定 mode:写 key 时 `auth_mode='apikey'`;切 chatgpt 时清 key、若 token 还在则 `auth_mode='chatgpt'` 否则删 mode。

### 双维度 CodexAuthStatus + builtinActive(为何能共存,以及"真正 In Use"怎么判)

```ts
interface CodexAuthStatus {
  active: 'apiKey' | 'chatgpt' | 'none'   // auth.json 内部解析谁是凭据(resolved_mode)
  chatgpt?: { expired, planType?, expiresAt? }  // 只要 token 块在盘上就有
  hasApiKey: boolean                       // auth.json 里有 OPENAI_API_KEY
}
```

**为何不是单一 `method`**:Codex 的 auth.json 本就让 token 块和 API key 共存。早先用单一 active 方式上报,导致"应用 API key"看起来像把 ChatGPT 登录**登出**了(其实 token 还在盘上)。改成两个独立维度后,API key 生效时面板仍显示 "Signed in",与 Claude 的共存行为一致。改 `readAuthStatus` 时务必保住"两维度"语义。

**但 `authStatus` 不足以判"真正 In Use"**——因为它只反映 auth.json,看不到 config.toml 顶层 `model_provider` 的覆盖。面板必须叠加 `builtinActive = (model_provider==='' )`:
- `chatgptActive = authStatus.active==='chatgpt' && builtinActive`
- API key 档案 `isActive = apiKeyActive && builtinActive`
- gateway 档案 `isActive = (model_provider==='codex-gateway') && base_url 匹配`
- `overridden = signedIn && !chatgptActive` → 显示 "Use this login"

漏掉 `builtinActive` 就会在 gateway 顶层生效时仍把 ChatGPT 误显 "In Use"(两处徽章同时亮)——这是真实踩过的坑。

### auth.json 实时刷新(为何登录后无需手动 refresh)

`_startAuthWatch()` 用 `fs.watch` 监听 **auth.json 所在目录**(不是文件本身):codex login 用 temp-file + rename 原子写,**文件级 watch 会丢事件,目录级才稳**。150ms 去抖(合并 rename 的 create/delete 对)后 fire `onDidChangeAuth`。renderer `useCodexConfig` 订阅它 → 浏览器 OAuth 流程完成、auth.json 落盘的瞬间自动刷新登录状态。`dispose()` 里 `clearTimeout` + `watcher.close()`。

### 🔒 安全约束(刻意决策,勿擅改)

1. **凭据明文落盘是用户明确选择**:apiKey/baseUrl 明文写进 `config.toml`/`auth.json`(与 CLI 共享)和 `aiSettings.json` 的 Codex 认证区,**刻意**不用加密 SecretStorage。项目 CLAUDE.md「AI provider 密钥必须走 ISecretStorageService、绝不进 settings.json」那条**只针对 AI provider 特性,不适用本 Codex/Claude 配置共享特性**。
2. **`readAuthStatus()` 绝不回传 token / API key 值**:只回 `{active, chatgpt?:{expired,planType?,expiresAt?}, hasApiKey}`。有测试("never returns the credentials themselves")断言 token / key 不泄漏到序列化结果里,改 readAuthStatus 时务必保住该测试。

### 常见任务 → 改哪里

- **给 Codex 加一个 config.toml 设置项**:定字段进 `CodexSettings`(契约)→ 选对应面板(model 类→CodexModelPanel、审批/沙箱→CodexSafetyPanel、其它标量→CodexAdvancedPanel 自动出现在自由编辑器,或给它一个专属控件),经 `useCodexConfig().patch` 落盘(`null` 删键)。main 实现的 `read`/`patch` 是通用 TOML 合并,**通常无需改**。
- **给 codexConfig 加跨进程方法/事件**:只改契约 + main 实现两个文件(6 处接线不动;`onDidChange*` 事件自动透传)。
- **改认证逻辑**:先想清楚它落在哪个登录方案 + 内部 `resolved_mode` 哪一步。动 `applyCredential`/`reconcileGatewayProvider` 必须同时维护 `auth_mode` 与顶层 `model_provider`(否则共存语义 / In-Use 判定崩)。动 `readAuthStatus` 必须保住双维度 + no-token-leak 测试。
- **加一个凭据种类**:扩 `CodexCredentialKind` + `CodexCredentialIntent`,改 `applyCredential`/`reconcileGatewayProvider`(它怎么落到 auth.json + config.toml)+ `CredentialLibrary` 表单 + 激活态判定(记得叠加 `builtinActive`/`model_provider`)。
- **再加一个 acp agent 的设置页**:新建 `agentSettings/<id>/<X>AgentSettings.tsx`,末行 `registerAgentSettings('<id>', ...)`;`builtinAgentSettings.ts` 加一行 import。壳零改动。

### 易踩坑速记

- **Codex ≠ Claude 的几处差异**:① renderer proxy 注册在 `registerProxyServices.ts`(Claude 在 main.tsx);② 登录走系统 PATH 的 `codex` CLI(Claude 走自己下载的二进制);③ 单文件 auth.json 共存两种凭据(Claude 是 `.credentials.json` + `settings.json` 两文件天然分离)。
- **gateway 必须自包含**:key 写 `experimental_bearer_token`、`supports_websockets=false`、顶层 `model_provider` 指向它。**绝不**用顶层 `openai_base_url`(会把 ChatGPT token 发去 gateway → `access token could not be refreshed`)、**绝不**用 `requires_openai_auth`、**绝不**改 auth.json。
- **"In Use" 判定必须叠加顶层 `model_provider`**:光看 `authStatus.active` 会误显——ChatGPT/API key 仅在 `model_provider` 为空时才真生效。
- `useService` 来自 `renderer/workbench/useService.ts`(面板里 `../../useService.js`),**不是** `@universe-editor/workbench-ui`。
- workbench-ui 的 `IconButton`:`label: string` 属性 + `children` 放图标(无 `icon`/`ariaLabel` props)。
- ESM:相对导入带 `.js` 后缀(即使源是 `.ts`)。`codex/` 比外壳深一层,到 shared 是 `../../../../shared/...`。
- 状态持久化套路:`IStorageService` + `restoredRef` 守卫防覆盖 + `requestAnimationFrame` 恢复滚动。
- NLS:`localize(key, '英文默认值', vars?)`,默认值必须英文;新增 key 补 `shared/i18n/messages/zh-CN.ts`(当前多内联文案)。
- react-hooks/rules-of-hooks:hook-library 方法**不要**用 `use` 前缀(否则在 `useCallback` 里调会被判成"在回调里调 Hook")。这就是 `switchToChatgptLogin` 不叫 `useChatgptLogin` 的原因。
- `fs.watch` 必须监听**目录**而非文件,否则 codex 的原子写(rename)会丢事件。
- 测试里验事件:`new Promise(resolve => sub = onDidChangeAuth(...))` + 先 sleep 50ms 让 watcher 挂上再写文件 + `Promise.race` 加超时。

### 验证

- `pnpm check`(lint + typecheck + test,输出长,只截错误)。codexConfig 测试单跑:`pnpm vitest run src/main/services/codexConfig`(在 apps/editor 下)。
- 改交互逻辑跑 `pnpm e2e`。已知本机 flaky(非回归):窗口拆除 `Target page... has been closed`、simpleFileDialog / multiFileDragEditor / explorerExternalWatcher / markdown* @p1(多 worker / exthost 环境问题,单跑必过)。e2e 冒烟**不覆盖 codex 登录场景**,改 codex 面板后 e2e 全绿即可。

### 关键参考路径

- 承载壳:`renderer/workbench/ai/AiSettingsEditor.tsx`(Agents 组渲染)→ 见 `apps/editor/src/renderer/services/ai/CLAUDE.md`
- 贡献注册:`renderer/workbench/agentSettings/{agentSettingsRegistry.ts,builtinAgentSettings.ts}`
- Codex 内容:`renderer/workbench/agentSettings/codex/*` + `agentSettings/AgentSettingsEditor.module.css`
- 服务:`shared/ipc/codexConfigService.ts`、`main/services/codexConfig/codexConfigMainService.ts`
- agent 注册表:`renderer/services/acp/acpAgentRegistry.ts`(`IAcpAgentRegistry`、`BUILTIN_AGENTS`、`agentIconId()`)——`codex` 在 `IAcpAgentRegistry.list()` 里就会自动出现在 Settings 的 Agents 组
- codex 二进制(与配置无关,登录除外):`shared/ipc/codexBinaryService.ts`、`main/services/codexBinary/*`

## 案例：# 结构化上下文引用（prompt-ref-pills）

> 本节自案例型 skill `prompt-ref-pills` 并入。范围：ACP 输入框「@/# by-range 药丸引用」——@ 文件提及 + # 结构化上下文（工作区符号/Git修改/打开编辑器+选区/文档）统一成 VSCode Copilot 式的、按字符区间（Monaco decoration）追踪的可编辑药丸；提交时读追踪的 range 列表产出 ContentBlock，不分词。涉及 `services/acp/{promptRef,promptRefTracker,promptMentions,promptContextRef,contextSuggestions}.ts` 或 `workbench/agents/{PromptMonacoEditor,PromptInput,ContextPopover,MentionPopover}.tsx`。区别于上文「会话子系统（acp-session）」（会话全局导航）：本节只管输入框的引用子系统。

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
- 会话全局上下文（协议/发送链路/双 id）：见上文「会话子系统（acp-session）」

## 案例：ACP rewind fork（acp-rewind-fork）

> 本节自案例型 skill `acp-rewind-fork` 并入。范围：ACP agent 会话的「回退（rewind，截断对话+可选回滚文件+回填输入框做 edit-and-retry）」与「分叉（fork，以某消息之前的历史新建独立会话）」。核心是一个反直觉事实——本仓库用的是 claude-agent-sdk 的 query()（非交互 --print 一次性进程），SDK 只暴露 rewindFiles() 回滚文件、**没有对话回退落盘 API**（rewindConversation 仅类型挂名无实现），所以 rewind 必须自己三步做（回滚文件 + resumeSessionAt 重建内存态截断 + **物理截断磁盘 JSONL transcript** 才能持久化），fork 必须走 SDK 的 forkSession() 写新文件、且 upToMessageId 是 inclusive 要 key 在前驱。

给外部 AI agent 会话加两个"改变对话方向"的能力：
- **rewind（回退）**：截断对话回到某条 user 消息之前，可选是否回滚 agent 改过的文件，并把该消息文本回填输入框供 edit-and-retry。首版仅 claude-code。
- **fork（分叉）**：以某消息**之前**的历史为起点新建**独立**会话，原会话不变。agent 声明支持才可用。

> ⚠️ **第一原则 —— 先认清 SDK 能力边界（决定整个架构）**：
> 本仓库通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` 接入 claude，走的是**非交互 `--print` stream-json 一次性进程**。交互式 `claude` CLI 的原生 `/rewind` 是**长驻 REPL 进程内**的私有机制，我们用不上。SDK 的 `Query` **只暴露 `rewindFiles()`（回滚文件）**；对话回退 `rewindConversation` 只在 `sdk.d.ts` 类型联合里挂名、`sdk.mjs` 实现文件里根本没有。**所以"截断对话"没有官方 API，必须自己拼。**
>
> ⚠️ **第二原则 —— 分清三层**：① vendor（`vendor/claude-agent-acp`，自维护 fork，改完必 `pnpm agent:build`）做真正的 SDK 调用与磁盘操作；② renderer service（`acpSession.ts` / `acpSessionService.ts`）做 view-model 透传 + 本地 timeline reset；③ renderer 命令 + UI（`agentRewindActions.ts` / `UserMessageItem.tsx`）做按钮 + 确认框 + 回填。改错层白改。
>
> 协议层全景（双 id、applyUpdate 状态机、连接池、恢复）见上文「会话子系统（acp-session）」，本节只讲 rewind/fork 纵切，不重复。

### SDK 关键约束（一手验证，SDK 0.3.198；升级必复查）

1. **无对话回退落盘 API**：`Query` 只有 `rewindFiles(userMessageId, {dryRun})`。`rewindConversation` 类型挂名无实现。
2. **`resumeSessionAt` 只改内存不改磁盘**：它是启动 flag `--resume-session-at`，配 `--session-id`（同 id）只让重建的 in-memory Query 从该点截断，**从不物理改写** `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`（append-only）。**这是 rewind 关闭重开会回弹的根因。**
3. **`resumeSessionAt` 是 inclusive**，且文档要 **`SDKAssistantMessage.uuid`**（"up to and including"）→ 要截断到 user 轮之前，得 key 在其**前驱**（assistant）uuid。
4. **`forkSession(sid,{dir,upToMessageId})` 是唯一真写磁盘的截断原语**：把源 transcript 切片后**复制成新文件**（新 session id）。`upToMessageId` 也是 **inclusive**（"Slice transcript up to this message UUID (inclusive)"）→ fork "从消息 X"要 key 在 X 的**前驱**才能排除 X 本身。
5. **`getSessionMessages(sid,{dir})` 读完整磁盘 transcript**：沿 parentUuid 链走到 tip，**无截断参数**。返回每条的 `uuid` == 磁盘 JSONL 每行的 `uuid` 字段。
6. **transcript 磁盘格式**（物理截断依赖）：一行一个 JSON、带 `uuid` 字段、严格 append 有序（parent 恒在 child 前）、尾随 `\n`、末行空。夹杂 `file-history-snapshot`/`mode`/`custom-title`/`queue-operation` 等非消息行。cwd→目录名编码 = `replace(/[^a-zA-Z0-9]/g,'-')`（未公开、脆弱，定位文件优先试它、兜底扫描）。
7. **锚点必须走 `enableFileCheckpointing:true`**（createSession 时传）否则 `rewindFiles` 返回 `canRewind:false`。

### 消息锚点机制（rewind/fork 的地基）

client 要能指定"回到哪条消息"，需要一个贯穿两端的稳定 id：

- renderer 发 prompt 时生成 uuid → `AcpMessage.messageId`，**同时**塞进 `PromptRequest._meta.messageId`。
- **关键坑**：vendor 用的 ACP SDK（`@agentclientprotocol/sdk` 1.1.0）的 `zPromptRequest` schema **没有 `messageId` 字段，zod 默认 strip 掉未知顶层键** → 顶层 `messageId` 会被静默丢弃。**必须走 `_meta`**（passthrough bag，不被 strip）。
- vendor `prompt()` 从 `params._meta.messageId` 读，直接当 SDK message uuid（`userMessage.uuid = promptUuid`）并**eager** `session.messageIdToUuid.set(promptUuid, promptUuid)`。因 client uuid 直接 == SDK uuid，renderer 无需 echo 校正。
- replay 路径：vendor `applyMessageId()` 给 `user_message_chunk`/`agent_message_chunk`/`agent_thought_chunk` 盖 messageId；renderer `applyUpdate` 的 `user_message_chunk` case 必须 `readMessageId(update)` 传进 `_appendChunk`，否则 resume/fork 重放出来的历史 user 消息**没锚点 → 按钮不显**。

### 数据流

#### rewind（三步，全在 vendor `rewindSession`）
```
renderer 命令 dryRun 预览 → 确认框（有文件改动=三按钮：撤销/保留/取消，无改动=单按钮）
  → session.rewindTo(messageId, {rewindFiles?})
    → 本地 _resetForReplay() + beginHistoryReplay()（清空 timeline 等 replay 重填）
    → conn.extMethod(REWIND_SESSION_METHOD, {sessionId, messageId, [dryRun], [rewindFiles:false]})
      ⟨vendor rewindSession⟩:
        1. rewindFiles(uuid) 回滚文件（rewindFiles!==false 才做；canRewind:false 短路）
        2. truncateTranscriptBefore(sid, uuid, cwd) —— 物理截断磁盘 JSONL（删锚点行及之后）★持久化关键
        3. teardown + createSession(resume, resumeSessionAt=前驱uuid) + replaySessionHistory({stopBeforeUuid:uuid})
    → tracker.clear（仅真回滚文件时；保留修改不清，diff 仍反映磁盘改动）
  → AcpPromptReplaceInbox.deposit(sessionId, 锚点文本) 回填输入框
```

#### fork（vendor `unstable_forkSession`）
```
renderer forkSession(sid, messageId?) → conn.unstable_forkSession({sessionId, cwd, _meta:{rewindTo:messageId}})
  ⟨vendor⟩: resolveMessageUuid(rewindTo) → messageUuidBefore(锚点)=前驱 → sdkForkSession(sid,{dir,upToMessageId:前驱})
  → 返回新 sessionId → renderer temp lease 丢弃 → resumeSession(新id)（自开 lease 做 session/load+replay+setActive）
```

### 文件地图

#### vendor `vendor/claude-agent-acp/src/acp-agent.ts`（改完必 `pnpm agent:build`）

| 符号 | 职责 |
|---|---|
| `REWIND_SESSION_METHOD = 'universe-editor/rewind_session'` | 自定义 ext-method 名，与 renderer `acpSessionModel.ts` 保持同步 |
| `prompt()` | 从 `_meta.messageId` 读 client uuid 当 SDK uuid + eager 记 `messageIdToUuid` |
| `RewindSessionRequest` | `{sessionId, messageId, dryRun?, rewindFiles?}`（rewindFiles 默认 true=回滚） |
| `rewindSession()` | 三步 rewind：rewindFiles + truncateTranscriptBefore + teardown/resume/replay |
| `unstable_forkSession()` | 读 `_meta.rewindTo` → 前驱 → `sdkForkSession({upToMessageId})` 写新文件 |
| `resolveMessageUuid(sid,msgId)` | ACP messageId → SDK uuid（查 `messageIdToUuid`） |
| `messageUuidBefore(sid,targetUuid,dir?)` | 找 target 的**前驱** uuid（inclusive API 排除锚点用）；首条返 undefined |
| `truncateTranscriptBefore(sid,anchorUuid,dir?)` | **物理截断磁盘 JSONL**：定位文件→删 `uuid===anchor` 行及之后→tmp+rename 原子写。best-effort（找不到只 log 不抛） |
| `findTranscriptFile(sid,dir?)` | 先试 encoded-cwd 路径，兜底扫 `CLAUDE_CONFIG_DIR/projects/*/<sid>.jsonl` |
| `replaySessionHistory(sid,{stopBeforeUuid?})` | replay 时遇锚点 break（磁盘读的是完整 transcript，须自己停在锚点前） |
| `messageIdForGrouping()` / `applyMessageId()` | assistant 用 API id、其余用 uuid 作 messageId；replay/live 给 chunk 盖 messageId |
| `createSession` options | 传 `enableFileCheckpointing:true`（rewindFiles 前提）；`newSessionParams` 存重建参数 |

#### renderer service `apps/editor/src/renderer/services/acp/`

| 文件 | 相关改动 |
|---|---|
| `acpSession.ts` | `rewindTo(messageId,{dryRun?,rewindFiles?})`（reset+replay-gate+extMethod+tracker.clear 条件）；`forkSupported`（observable，从 `sessionCapabilities.fork` 设）+ `rewindSupported`（observable，从 initialize `_meta['universe-editor/capabilities'].rewind` 设）+ 私有 `_filesRolledBackByAgent`（同块设）；`_dispatchPrompt` 发 `_meta:{messageId}`；`applyUpdate` 的 `user_message_chunk` 传 `readMessageId(update)`；`_appendChunk` 加 `messageId?` 参 |
| `acpSessionModel.ts` | `IAcpSession` 接口：`rewindTo` 签名 + `forkSupported`/`rewindSupported` + `RewindFilesResult` 类型；`REWIND_SESSION_METHOD` 常量（与 vendor 同步） |
| `acpSessionService.ts` | facade `forkSession(sid,msgId?)`（temp lease → unstable_forkSession → resumeSession）+ `rewindSession(sid,msgId,{dryRun?,rewindFiles?})`（校 live+非 closed+rewindSupported 才委托）；`AcpForeignWorktreeError` 守卫 |
| `acpSessionUpdateMeta.ts` | `readMessageId(update)` reader（从 update 读 vendor 盖的 messageId）+ `readChangedConfigIds(update)`（读 `_meta["universe-editor/changedConfigIds"]` 声明，见已修 bug #6） |
| `acpPromptReplaceInbox.ts` | edit-and-retry 回填收件箱：**替换语义**（map 存单值 last-wins，drain 返 string?）。区别于 `acpPromptContextInbox`（追加语义） |

#### renderer 命令 + UI

| 文件 | 职责 |
|---|---|
| `actions/agentRewindActions.ts` | `RewindAgentSessionAction`（dryRun 预览→三/单按钮确认→rewind→回填）+ `ForkAgentSessionAction`（fork→开 editor tab 或 setActive）。都 `f1:false`、arg=`{sessionId,messageId}` |
| `actions/index.ts` | `registerAction2` 两个 action；`agentActions.ts` barrel re-export |
| `workbench/agents/UserMessageItem.tsx` | hover 显 Rewind（`Undo2`）/Fork（`GitBranch`）按钮，`useObservable(rewindSupported)`+`useObservable(forkSupported)` 各自门控；抽 `UserMessageActions` 子组件避免条件 hooks |
| `workbench/agents/ChatBody.tsx` | `TimelineSlot` memo 加 `session` prop 透传给 UserMessageItem，带 `messageId` |
| `PromptInput.tsx` | drain `AcpPromptReplaceInbox`：`setText(replace)`+清 contexts/images+focus |
| `workbench/agents/agents.module.css` | `.userMessageWrap`(relative)+`.userMessageActions`(hover 才 opacity:1) |

### 已修 bug 的根因（复用时对照自查）

1. **rewind 报 `Unknown messageId`**：SDK 1.1.0 zod strip 顶层 messageId。→ 走 `_meta.messageId`。
2. **fork 无历史（显示空会话）**：旧实现用内存态 resumeSessionAt fork **不落盘**，session/load replay 读磁盘=空。→ 用 `sdkForkSession()` 写新文件。
3. **fork 含被点消息本身 / rewind 消息列表不变 / rewind 关闭重开回弹**：三个都源于 **inclusive 语义 + 只改内存不改磁盘**。→ fork/rewind 都 key 在**前驱**；rewind 加 `replaySessionHistory({stopBeforeUuid})`（内存）**和** `truncateTranscriptBefore`（磁盘物理截断，持久化）。
4. **rewind/fork 后运行期 model/effort 丢失回落默认**（claude 专属，codex 无因 thread 存活）：claude rewind teardown+`createSession` 重建 Query 时用的是**最初** `newSessionParams`，effort 又从 settings.json 重新 seed——运行期 `setConfigOption` 改的 model/effort/fast/agent 从未写回。→ vendor `rewindSession` teardown **前** `snapshotRuntimeConfig(session)`（从 live `configOptions` 读 model/mode/effort/fast/agent，model 优先序），重建后 `reapplyRuntimeConfig` 按序走 `setSessionConfigOption`（复用 model→effort 级联），逐项 best-effort（失败只 log）。fork 侧不重建进程但**新 history 行没继承源配置**→ renderer `forkSession` 注册行时带 `snapshotConfigSelections(live.configOptions.get())` 的 `configOptions`/`configLabels`，resume 的 `setConfigDesired` 借现成 flush 机制 push 回 fork 线程（fork 侧零新增 push 逻辑）。
5. **rewind 后权限模式真实回落 + UI 配置显示与 agent 脱节**（bug #4 机制的两个遗漏）：(a) `snapshotRuntimeConfig` 的 order 原本**缺 `MODE_CONFIG_ID`** → 重建 `createSession` 从 settings `permissions.defaultMode` 重新 seed，bypassPermissions 静默回落 default（transcript 里 rewind 后 prompt 的 `permissionMode:"default"` 可证）。修=order 加 MODE 且必须排在 MODEL **之后**——model 切换的 `applyConfigOptionValue` 会 clamp mode，先 push mode 会被随后的 model push 打回。(b) `reapplyRuntimeConfig` 走的 `setSessionConfigOption` 只把更新后的 bag 放在 RPC **响应**里，而 rewind 场景调用方是 vendor 自己 → client 永远收不到重放后的权威配置，UI 显示重建默认值（如 Sonnet/Manual）而 agent 实际跑快照配置（haiku）。修=reapply 末尾主动发一次 `config_option_update`（renderer `ingestUpdate` 无条件处理、replay 窗口不拦、`_pendingPushes` 此时为空不会误吞）。
6. **正常 resume 后 mode/effort 被打回默认**（被误认为 #5 的修复所致，实为既有提交 `dd49937` 的行为被 `pnpm agent:build` 重建 dist 才激活——排查此类"我改完就坏"先做日志考古+核对 dist mtime，别只看自己的 diff）：`reconcileResumedSessionModel`（issue #845 的 perf 后台任务）在每次 session/load 后读 live model（`getContextUsage`，秒级），与 reported 不一致时经 `updateConfigOption` **广播整个 configOptions bag**——但 bag 里只有 model 是权威修正值，mode/effort 仍是重建 seed（default/xhigh）；renderer `ingestUpdate` 对 known 非 provisional option verbatim 应用（设计如此，agent 主动变更必须赢），无法区分"权威修正"与"陈旧 seed"，恢复的 mode/effort 被打回。修=**声明式部分更新**：vendor `updateConfigOption` 加 `opts.declareChanged`，对比 apply 前后 bag 把真实变化的 id（目标项+连带 clamp/rebuild）写进广播 `_meta["universe-editor/changedConfigIds"]`（仅 reconcile 调用点传入）；renderer `acpSessionUpdateMeta.readChangedConfigIds` 读声明，`ingestUpdate` 把 source 过滤成声明子集、且声明时不做全量替换只 merge。无 `_meta` 的广播保持全量语义（rewind #5(b)、plan 切换、setSessionMode 均不受影响）。

### 常见任务 → 改哪里

- **加 rewind/fork 到新的 agent**：能力位——fork 读 `sessionCapabilities.fork`，rewind 首版硬编 `agentId==='claude-code'`（因依赖 claude SDK 的 rewindFiles + checkpointing）。别的 agent 要支持 rewind 得确认其 fork 也提供等价原语。
- **改回退语义（保留/撤销文件）**：`RewindSessionRequest.rewindFiles` 贯穿 vendor→`acpSession.rewindTo`→`acpSessionService.rewindSession`→命令三按钮。tracker.clear 只在真回滚时。
- **改 edit-and-retry 回填**：`acpPromptReplaceInbox.ts`（替换语义）+ `PromptInput` drain effect。命令捕获文本要**趁 rewind 清空 timeline 前** `session.messages.get().find(m=>m.messageId===)`。
- **锚点对不上/按钮不显**：查 `_meta.messageId` 是否发/读；replay 路径 `readMessageId`→`_appendChunk` 是否传；vendor `applyMessageId` 是否盖到 `user_message_chunk`。
- **rewind 关闭重开回弹**：确认 `truncateTranscriptBefore` 被调（teardown 前，趁有 cwd）+ 物理截断成功（看日志 `rewind persist:`）。
- **改磁盘截断逻辑**：`truncateTranscriptBefore`/`findTranscriptFile`，注意 format 假设（见 SDK 约束 #6）+ 原子写 + best-effort 不抛。

### 易踩坑速记

1. **顶层 messageId 被 zod strip**（血泪）：ACP SDK 1.1.0 `zPromptRequest` 无 messageId 字段，**必须走 `_meta.messageId`**。
2. **inclusive 语义**：`resumeSessionAt` / `forkSession({upToMessageId})` 都含给的那条 → 排除锚点 user 消息要 key 在**前驱**（`messageUuidBefore`）。
3. **resumeSessionAt 不落盘**：rewind 关闭重开回弹的真因，必须 `truncateTranscriptBefore` 物理截断磁盘才持久。
4. **replaySessionHistory 读完整磁盘**：`resumeSessionAt` 只截内存，replay 必须自己 `stopBeforeUuid` 停在锚点前，否则消息列表不变。
5. **settleActive 不要 echo userMessageId**（血泪，已回退过）：曾试在 `turn.resolve` 里回显 `userMessageId` → 打破 11 个 cancel/turn 测试的 `toEqual({stopReason})`。因 client uuid 直接 == SDK uuid，renderer 无需 echo。
6. **exactOptionalPropertyTypes**：`rewindFiles?`/`messageId?` 不能传 undefined，用 `...(x===false?{rewindFiles:false}:{})` 条件展开。
7. **tracker.clear 条件**：保留修改（rewindFiles:false）时**不清** change tracker，否则 session diff 丢掉磁盘上保留的改动。
8. **Edit 大小写翻文件名**（Windows）：用大写路径 Edit `acpSessionService.ts` 会让磁盘真名变大写触发 `TS1261`；该文件真名是小写，Edit 必用小写路径。
9. **FakeSession/stub 漏成员**：`IAcpSession` 加 `rewindTo`/`forkSupported`/`rewindSupported` 后，`ChatBody.test.tsx` / `ConfigOptionsBar.test.tsx` / `PromptInput.test.tsx` / `AcpSessionEditor.test.tsx` 的本地 stub 要同步补。
10. **命令三按钮读 `result.choice` 非 `confirmed`**：有文件改动走三按钮（primary=撤销/secondary=保留/cancel），测试 dialog mock 要带 `choice` 字段。
11. **accessor 首个 await 后失效**：命令 async run 里 await 前先同步取完所有 service（见 [[action2-async-accessor-invalidation]]）。

### 测试套路

- **vendor**（`src/tests/acp-agent.test.ts`）：
  - rewind describe：dryRun 预览 / canRewind:false 短路（都在 step2 前，可不 spawn 真 Query）/ rewindFiles:false（`vi.spyOn` 隔离 teardown/createSession/replay/truncateTranscriptBefore，验证跳过 rewindFiles 仍截断）/ 运行期配置 reapply（mock `createSession` 装一个 seed 成默认值的 recreated session，断言 setModel/setPermissionMode 被调 + 最终 configOptions）/ reapply 后 `config_option_update` 通知（client mock 的 `sessionUpdate` 用 `vi.fn` 捕获再过滤）。
  - fork describe：`vi.mock` 加 `forkSession`(vi.fn) + `getSessionMessages`（默认 `vi.fn(actual.getSessionMessages)` 保真实现，新测试 `mockResolvedValueOnce` 覆盖），验证 upToMessageId=前驱。
  - truncate describe：**真实 tmp 文件**建在 `CLAUDE_CONFIG_DIR/projects/__rewind_trunc_test_<uuid>/`，afterEach 清理；验证删锚点及之后/首行清空/锚点不存在原样/文件不存在 no-throw。`CLAUDE_CONFIG_DIR` 已 export。
  - **2 个既有 Windows 反斜杠路径失败**（`toDisplayPath`/`Read src\main.ts`）与本功能无关，CI 上绿。
- **renderer**：`AcpSessionService.test.ts`（rewind 发对 messageId+clear tracker、dryRun 不 cancel、rewindFiles:false 透传+不清 tracker、非 claude no-op、fork `_meta.rewindTo`+setActive）；`agentRewindActions.test.ts`（预览+三按钮各分支+回填、无能力 no-op、fork 开 editor/foreign 提示）；`UserMessageItem.test.tsx`（按钮可见性+委托 arg）。stub 见坑 #9。

### 验证

```bash
# vendor
cd vendor/claude-agent-acp && npx vitest run src/tests/acp-agent.test.ts -t "rewind"   # rewind + truncate
cd vendor/claude-agent-acp && npx vitest run src/tests/acp-agent.test.ts -t "fork"      # fork point
pnpm agent:build          # ★改 vendor 后必重建 dist（esbuild，非 tsc）
# renderer
pnpm check                # lint+typecheck+test（含 docs:check），仅看错误
```

改了用户可见行为（按钮/确认框文案/回退语义）→ 同步 `docs/user/zh-CN/ai-agent/managing-sessions.md`「回退与分叉」节。

### 关键参考路径

- **vendor 核心**：`vendor/claude-agent-acp/src/acp-agent.ts`（`rewindSession`/`unstable_forkSession`/`truncateTranscriptBefore`/`messageUuidBefore`/`prompt`）
- **renderer service**：`acpSession.ts`（`rewindTo`/能力位/`_appendChunk`）、`acpSessionService.ts`（facade）、`acpSessionModel.ts`（接口+`REWIND_SESSION_METHOD`）、`acpSessionUpdateMeta.ts`（`readMessageId`）、`acpPromptReplaceInbox.ts`
- **命令+UI**：`actions/agentRewindActions.ts`、`workbench/agents/UserMessageItem.tsx` + `ChatBody.tsx`
- **文档**：`docs/user/zh-CN/ai-agent/managing-sessions.md`
- **SDK 类型**：`vendor/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`forkSession`/`resumeSessionAt`/`getSessionMessages`/`ForkSessionOptions`）
- **记忆**：[[acp-rewind-fork-progress]]（完整实施进展 + 三 bug 根因 + 持久化真相）
- **相关**：上文「会话子系统（acp-session）」（本节是其纵切）；skill `update-claude-agent-acp`（vendor fork 构建/升级流程）、`docs/user/CLAUDE.md`（用户文档）

### codex 版（与 claude 架构根本不同，已实现，见 [[codex-rewind-fork-parity]]）

claude 靠 SDK 拼凑；**codex 走 app-server v2 JSON-RPC，原生支持 `thread/rollback` + `thread/fork`**（都自己落盘 → 无 claude 的"关闭重开回弹"，省掉 `truncateTranscriptBefore` 整块）。

| 维度 | claude | codex |
|---|---|---|
| 对话截断 | 手写物理截断磁盘 JSONL | 原生 `thread/rollback {threadId, numTurns}`（从末尾删 N 轮，自落盘，**不回滚文件**） |
| fork | SDK `forkSession({upToMessageId})` | 原生 `thread/fork`（整条复制，**无截断点**）→ fork 整条 + 对新 thread rollback 截断 |
| 锚点 | `_meta.messageId`（顶层被 zod strip） | 原生 `TurnStartParams.clientUserMessageId` → 存 `ThreadItem.userMessage.clientId`（更干净，天然持久） |
| 文件回滚 | SDK `rewindFiles()` 磁盘 checkpoint | **codex 无原生文件回滚** → renderer `SessionChangeTrackerService.restore` 逆向 unapply 磁盘 |

**codex 关键改动**：
- vendor `CodexAcpClient.sendPrompt` 读 `_meta.messageId`→`clientUserMessageId`（`readClientUserMessageId`）；`createUserMessageUpdates` replay 用 `item.clientId ?? item.id`。
- vendor `resolveRollbackTurns(thread, messageId)`（已 export 供测）：找 `clientId||id===messageId` 的 turn 下标 i → `numTurns = turns.length - i`。
- fork = **ACP 标准 `unstable_forkSession`**（`methods.agent.session.fork`）+ `initialize` 声明 `sessionCapabilities.fork:{}` → **renderer fork 侧零改**（facade 纯能力位驱动）。`CodexAppServerClient.threadFork/threadRollback` 封装 + `index.ts` 注册 handler。
- rewind 复用**同名 ext-method** `universe-editor/rewind_session`（`AcpExtensions.ts` 加常量/类型/parser/注册；`CodexAcpServer.rewindSession`：dryRun 查锚点、非 dryRun rollback + `streamThreadHistory` 重放）。
- **文件回滚在 renderer**：`acpSession.rewindTo` 按 `!_filesRolledBackByAgent.get()`（旧 `agentId==='codex'`）分派——先 `changeTracker.restore(sid, postAnchorToolCallIds)` 再 ext-method 截断；claude（agent 自己回滚文件）仍走原一体路径。`_toolCallIdsAfterMessage`（**趁 reset 清 timeline 前**从有序 timeline 取锚点及之后的 `call.id`，即 `update.toolCallId`）。
- `SessionChangeTrackerService.restore/previewRestore(sid, toolCallIds)`：对指定 batch 逆向 `reconstructBaseline` 写回（restore 写盘+删 batch，preview 只算），返 `RewindFileImpact`。**精度=整文件快照式，只恢复本会话 agent 改过的文件**。
- `rewindSupported` = `IObservable<boolean>`，**从 initialize `_meta['universe-editor/capabilities'].rewind` 读**（旧白名单 `agentId==='claude-code'||'codex'` 已删；键定义在 `acpExtMethods.ts` 的 `ACP_CAPABILITIES_META_KEY`/`AcpUniverseCapabilities`，两个 fork 字面量通告）。`filesRolledBackByAgent` 同块读（claude=true / codex=false）→ 私有 `_filesRolledBackByAgent` observable 驱动上面的文件回滚分派。门控差异：codex 走 `restore`（**从不 clear tracker**），`rewindFiles:false` 跳过 restore。自定义 agent 声明该能力块即点亮入口。

**codex 易踩坑**：
- 改 codex vendor 后必 `cd vendor/codex-acp && node build.mjs`（**esbuild，非 tsc**；或 `pnpm agent:build` 建两个 vendor）。codex vendor 是 submodule 常在 detached HEAD（正常）。
- `AcpToolCall` 字段是 `id` **不是** `toolCallId`（但值 == `update.toolCallId`）。
- `initialize.test.ts` 快照要同步加 `fork:{}`；`AcpSessionService.test.ts` 的 `FakeAgentRegistry` 要加 codex；stub tracker 补 `restore/previewRestore`。
- codex vendor **4 个既有失败**（3 Windows 反斜杠路径快照 + 1 "should map events from dump" AbsolutePathBuf 环境问题）与本功能无关，stash 可验证 CI 绿。
