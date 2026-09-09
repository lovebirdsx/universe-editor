# apps/editor/src/renderer/services/acp/CLAUDE.md

Agent Client Protocol（ACP）客户端层。基于 `@agentclientprotocol/sdk` v1.2.x（ESM-only，zod schema 校验）。协议层完全在 renderer 端，main 端只搬字节（`IAcpHostService` / `IAcpTerminalService`）。

**关键事实**：
- SDK 类型直接出现在 service / UI / 测试里——**没有 alias 层**，类型名就是 SDK 导出的名字
- 自定义 view-model（`AcpSession` / `AcpMessage` / `AcpToolCall`）带 observable 状态，**不要重命名**

## 文件归位

- **协议装配 / 网关**：`acpClientService.ts`（进程启动 + `ClientSideConnection` 装配 + refcount 连接池 + fs/terminal/permission 网关）、`acpAgentRegistry.ts`（内置预设 + `acp.agents` 合并 + PATH 探测）、`acpPathPolicy.ts`（沙盒纯函数：cwd 相对性 + 敏感前缀拒绝）、`acpPermissionHandler.ts`（自动批准 + Memory 持久化）、`acpElicitationForm.ts`（elicitation → 表单模型）、`sdkHostStream.ts`（字符串 → Uint8Array IO 适配）
- **MCP**：`acpMcpServers.ts`（配置 → wire `McpServer[]` 规范化 + 门控）、`mcpServerEnablementService.ts`（默认启停）、`agentMcpConfigService.ts`（agent 自有 MCP 配置文件路由门面）
- **输入框引用**：`promptRef.ts` / `promptRefTracker.ts` / `promptMentions.ts` / `promptContextRef.ts` / `contextSuggestions.ts`（@/# 药丸子系，见 [cases-prompt-ref-pills.md](cases-prompt-ref-pills.md)）、`promptContext.ts`（选区上下文组装）
- **其余工具**：`persistedStateBase.ts`（双桶持久化基类）、`markdownRenderer.ts` / `markdownIncremental.ts` / `mentionFileSearch.ts` / `ansi.ts` / `filePathLink.ts` / `chatFindMatcher.ts` / `commandWrapper.ts` / `agentIconData.ts` / `agentNotificationIcon.ts` / `acpProtocolTracer.ts`、`acpModelCandidateService.ts` / `acpModelCandidates.ts` / `modelOneM.ts` / `configOptionLabel.ts` / `aiFixConfig.ts` / `aiFixPrompt.ts`（职责见文件名）
- **测试**：`testing/inMemoryAcpPair.ts`（真 `ClientSideConnection` ↔ 桩 `AgentSideConnection` 对联）
- **会话子系统（37 个文件）**：见 [`session/CLAUDE.md`](session/CLAUDE.md)

## 跨进程边界

| 端 | 文件 | 职责 |
|---|---|---|
| main | `src/main/services/acpHost/` + `acpTerminal/` | spawn agent 子进程，pump stdio/exit；terminal 池（spawn / snapshot / waitForExit / kill / release） |
| shared | `src/shared/ipc/acpHostService.ts` / `acpTerminalService.ts` | 通道契约：`start / writeStdin / stop / probe` + events；`create / output / waitForExit / kill / release` |
| renderer | `main.tsx` | `ProxyChannel.toService` 绑两个跨进程服务 |

**无 `endStdin`**：流关闭只能走 `stop(handle)`。

## 数据流

**出站**：`PromptInput / ChatView` → `AcpSessionService.sendPrompt(text, mentions)` → `composePromptBlocks()` 转 resource_link → `AcpSession._appendMessage('user')` → `ClientSideConnection.prompt({sessionId, prompt})` → `sdkHostStream` → `IAcpHostService.writeStdin`。其他出站全部走 SDK 强类型方法。

**入站**：`IAcpHostService.onStdout(chunk)` → `sdkHostStream` 重编码 → `ndJsonStream` → `clientImpl` 回调：`sessionUpdate`（→ `AcpSession.applyUpdate`）、`requestPermission`（tryAutoApprove or PermissionCard）、`unstable_createElicitation`（pendingElicitation + ElicitationCard）、`readTextFile / writeTextFile`（AcpPathPolicy → IFileService）、terminal 五方法（→ IAcpTerminalService，带 ownership 检查）。**stderr 不进 SDK 流**：单独写 `OutputChannel`（喂进去会破坏 JSON 解析）。

**`applyUpdate` 处理八种 SessionUpdate**：`user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `plan` / `available_commands_update` / `config_option_update`。新增类型在 `session/acpSession.ts` 的 `applyUpdate()` switch 加 case。`config_option_update` delegate 到 `ConfigOptionStateMachine.ingestUpdate`（需 echo 抑制）。

## 套路 ACP-A：加一个内置 agent 预设

`acpAgentRegistry.ts` 的 `BUILTIN_AGENTS` 加项；用户自定义走 `acp.agents` 配置（merge 按 `id` 同键覆盖）。LaunchSpec 自动应用 env denylist。

内置 `claude-code` 用自维护 fork（submodule `vendor/claude-agent-acp`），`runAsNode: true` 启动（不依赖系统 node/npx）。`runAsNode` 是可信标志，**只允许内置预设**设置。这类 agent 的 `health()` 直接 `available: true`。改 fork 后 `pnpm agent:build`。

## 套路 ACP-B：处理一个新的 SessionUpdate 类型

1. `session/acpSession.ts` 的 `applyUpdate()` switch 加 case
2. 用 `transaction((tx) => { observable.set(value, tx) })` 包写入（16ms 批次）
3. 新 view-model 挂 `AcpSession` 上而不是 SDK 类型上
4. UI 用 `useObservable` 自动 react

## 套路 ACP-C：加一个新的入站方法（agent → renderer）

`acpClientService.ts` 的 `connect()` 闭包里构造 `clientImpl`（SDK `Client` interface 实现）。加方法时：参数校验失败抛 `RequestError.invalidParams(data, msg)`；资源所有权（如 terminal）在 `connect()` 闭包维护 `Set<string>`，跨连接访问拒绝、连接关闭遍历释放；失败路径经 `INotificationService` 上报 + telemetry 打点。

## 套路 ACP-D：调整自动批准 / 权限策略

`acpPermissionHandler.ts`：`tryAutoApprove(params)` 决策、`persistAllow(kind)` 写回 `acp.permissions.autoApprove`（Memory）。UI 端 `PermissionCard` 不动——它只展示 SDK 给的 `options[]`。`kind` 是不透明字符串，但**新代码必须用 SDK `ToolKind` 的 10 个值**（见易踩坑 #2）。

**例外：`switch_mode`（ExitPlanMode）永不走静默自动批准、也不被 `persistAllow` 记住**（守卫在 `onRequestPermission`）。它的自动化由 `acp.plan.autoExecute`（off/bypassPermissions/auto/acceptEdits/default）显式驱动：判定设置值在本次 options 里才附 `autoResolve`，卡片显示可打断倒计时。注意：静默短路会让倒计时卡永不出现，两者只能留一个。

## 套路 ACP-E：扩展会话历史持久化字段

`session/acpSessionHistory.ts` 继承 `PersistedStateBase`：`SCHEMA_VERSION++` → `AcpSessionHistoryEntry` 加字段 → `_deserialize` 的 `migrate()` 加迁移代码。不要随意提 `MAX_ENTRIES=100`（写入是全量序列化）。

新加双桶持久化服务直接继承 `PersistedStateBase<TState>`，实现 `_emptyState / _serialize / _deserialize / _onStateReplaced`（可选 `_mergeOnLoad`），框架负责时序/重读/防抖写/dispose flush。

## 套路 ACP-F：MCP servers（配置 → 透传）

用户配置 `acp.mcpServers`（schema 在 `contributions/AgentsContributions.ts`），在 `createSession`/`resumeSession` 里经两步纯函数（`acpMcpServers.ts`）后透传给 `newSession`/`loadSession`：

1. `normalizeMcpServers(raw, onWarn)`：把 **Record 风格**（key=server name，`env`/`headers` 用 Record）或**旧数组格式**统一成 ACP wire `McpServer[]`。坏条目**跳过 + warn 不抛错**。
2. `filterMcpServersByCapabilities(servers, caps)`：读 `agentCapabilities?.mcpCapabilities`，agent 不通告的 http/sse 进 `dropped`；stdio 是基线**恒留**。`_warnDroppedMcpServers` 逐条 warn + 一次汇总通知。

agent 端（`vendor/claude-agent-acp`）把 wire 的 `env`/`headers` 数组还原成 Record 喂 Claude Agent SDK——连接/工具发现全由 SDK 管，client 只做"配置→wire→门控"。命令入口：`Agents: Open MCP Settings`（`agentActions.ts`）。

**默认启用集语义（MCP 定义池 = 分层合并 + 每会话过滤，细节见 [cases-mcp-enablement.md](cases-mcp-enablement.md)）**：
- **八层优先级（低→高）**：extension → agent-user → VSCodeUser → User → VSCodeWorkspace → Project → Memory → agent-project（`.mcp.json` / `<cwd>/.codex/config.toml`）。
- **agent 自有配置文件只读导入**：编辑器只读不写；路由门面 `IAgentMcpConfigService`（`agentMcpConfigService.ts`）按 agentId 分发到 main 侧 `IClaudeConfigService` / `ICodexConfigService`。
- **per-agent 隔离（行为变更）**：agent 来源条目带 `McpAgentAffinity`；`readMcpServerDefinitionsLayered` 第 4 参省略 = union 视图（picker/设置面板），传值 = 丢弃 affinity 不匹配的 agent 层（两条 wire 路径）。**`.mcp.json` 收窄为只对 claude-code 会话生效**（不留 fallback 的行为破坏性变更）。
- **union 同名跨 agent 条目（`sharedWith`）**：`filterPoolForSession` 凭它放行，否则同名条目在另一方的 picker 里会彻底消失（尽管该方 wire 路径包含它）。
- **UI 消费 per-agent 视图统一入口 `filterPoolForSession(pool, agentId)`**（`McpServerPicker.tsx`）：picker / ConfigOptionsBar / ConfigBarOverflowMenu 三处共用。
- **扩展贡献层**（`contributes.mcpServers`）：`IExtensionMcpServersService` 从 manifest DTO 解析 raw record，**绝不写 settings.json**——卸载/禁用即消失。v1 仅 stdio。
- **默认启用集 = 池中全部非 `disabled` 条目**。`disabled` 注解来自 **`IMcpServerEnablementService`**（`acp.mcpServerEnablement`，GLOBAL/WORKSPACE 双 scope）：默认启用，定义条目里的 `disabled` 字段一律失效。UI 共用 **`McpEnablementToggles`**（工作区级开关**三态**）。坑：`setEnabled(name, true)` 恒存显式 true 记录；三态 Checkbox 的 onChange 必须忽略入参。两条 wire 路径 `await Promise.all([extensionMcp.whenReady, mcpEnablement.whenReady])` 消除冷启动竞态。
- **picker 左侧勾选只是会话级 pin**（`setSessionMcpServers`），只影响当前会话，**绝不写回默认**（sticky 机制已删）。resume/fork 选择瀑布：history 行 `mcpServerNames`（undefined=跟随默认）→ 否则 `null`（非 disabled 全集）。

**未做**：实验性 `type:'acp'` transport、MCP 状态/工具可观测 UI（ACP 无标准状态推送，MCP 工具以普通 `tool_call` 出现）。

## 测试模式

主要测试在 `__tests__/`：`AcpSessionService.test.ts`（生命周期/消息/工具/权限分发）、`acpSessionConfigOptions.test.ts`（state machine）、`AcpSessionService.resume.test.ts` + `acpSessionRestoreCoordinator.test.ts`（恢复）、`AcpClientService.terminal.test.ts`（terminal 所有权）、`acpMcpServers.test.ts`、`acpSessionHistory.test.ts`、`sdkHostStream.test.ts`。

**协议级测试一律走 `testing/inMemoryAcpPair.ts`**：真 `ClientSideConnection` ↔ 桩 `Agent` 对联。断言 **fake agent 方法被调用 + 参数对**，而不是 jsonline 字节（后者会被 SDK wire 格式变化弄碎）。E2E 在 `apps/editor/e2e/`，ACP 未在 `@p0` 冒烟里。

## 持久化

`AcpSessionHistory`（`key='acp.sessionHistory'`，`schemaVersion=1`）走 `PersistedStateBase` **双桶策略**：有 workspace → `WORKSPACE`（每区独立 100 条 LRU）；空窗口 → `GLOBAL` 兜底。workspace 切换由 `onDidChangeWorkspaceScope` 驱动基类 `_reload()` + `AcpSessionRestoreCoordinator.onWorkspaceSwap()` 从新桶尝试恢复 active id。`AcpAgentDefaults`、`AcpLastSessionCwd` 同样双桶。条目形状 `{ id, agentId, sessionIdOnAgent, title, cwd, createdAt, lastUsedAt, configOptions? }`。

**只存字符串元数据**——无 ContentBlock / SessionUpdate 落盘；恢复时拿 `sessionIdOnAgent` 调 `loadSession` 重放历史。旧版本 GLOBAL 桶数据启动时一次性 purge（不迁移）。

## SDK 关键约定（易踩坑清单）

1. **`T | null` ≠ `T | undefined`**：SDK 大量字段用 null（如 `ToolCallUpdate.content / kind`）。`exactOptionalPropertyTypes` 下 null 不能赋给 `prop?: T`——用 `!= null`（loose）。
2. **`ToolKind` 固定 10 枚举**：`read | edit | delete | move | search | execute | think | fetch | switch_mode | other`。**不能**传 `'fs'` / `'fs.read'` / `'fs.write'`（老协议遗留值已翻译）。
3. **`SetSessionConfigOptionRequest` 没有 `type: 'select'`**：union 只有 `{ type: 'boolean'; value: boolean }` 和 `{ value: SessionConfigValueId }`。字符串 ID 分支**不带 type**。
4. **void-returning client method 序列化为 `{}`**：如 `killTerminal`。断言写 `expect(resp.result).toEqual({})`，不是 `undefined`。
5. **Cancel 双步缺一不可**：(a) `conn.cancel({ sessionId })` 发 notification 给 agent；(b) 本地 `AbortController.abort()` 让 `Promise.race` 立刻 reject。少 (b) 卡死本地 UI，少 (a) agent 不知道。
6. **Terminal ownership 闭包**：`connect()` 里 `ownedTerminals = new Set<string>()`，五个 terminal 方法都闭包它。**跨连接访问抛 `RequestError.invalidParams`**；连接关闭遍历 `release(id)` 兜底。
7. **stderr 独立通道**：`IAcpHostService.onStderr` **绝不**喂给 SDK ndJsonStream——单独 `OutputChannel`。
8. **env denylist**：spawn 前剥 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`，否则 agent 怪异崩溃。main + renderer 两端都要做。**例外**：内置 `runAsNode` agent 由 `acpHostMainService` 剥离**之后有意补回** `ELECTRON_RUN_AS_NODE=1`（它用 Electron-as-node 启动，fork 以 `process.execPath` 重启自己必须继承）。只对可信内置路径开启。
9. **16ms 防抖事务**：`applyUpdate` 内 messages / toolCalls / plan 共用一个 `transaction()`，单次 observer 通知。新增更新类别也要进同一事务，否则抖动。
10. **stdio MCP 条目绝不能带 `type` 字段**：agent 端用 `!('type' in server)` 判定 stdio，带了 `type`（哪怕 `'stdio'`）会**两个分支都不匹配被静默丢弃**。`normalizeMcpServers` 的 stdio 分支刻意不写 type；http/sse 反而**必须**带。env/headers 是 `Array<{name,value}>`（不是 Record）。

## 参考路径

- SDK 类型源码：`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`；入口导出 `ClientSideConnection / AgentSideConnection / RequestError / ndJsonStream` + schema 类型
- 配置 key：`acp.agents` / `acp.permissions.autoApprove` / `acp.startupTimeoutMs` / `acp.defaultAgentId` / `acp.mcpServers` / `acp.idleProcessTimeoutMs`

## 案例：输入框 @/# 药丸引用（prompt-ref-pills）

分层地图 / 数据流 / 加新 kind 清单 / 易踩坑见 [cases-prompt-ref-pills.md](cases-prompt-ref-pills.md)。两条红线：**引用真身活在 Monaco 上，不是 React state**（旧 by-name 序列化已删，别复活）；**resource_link 的 name/description/_meta 会被 agent 丢弃**，行/列/符号名**只能进 `text` 块正文**——见 [[prompt-hash-context-references-feature]]。

## 子域导航

- 会话子系统（37 文件）：[`session/CLAUDE.md`](session/CLAUDE.md)
- Agent 设置 UI（Claude）：[`workbench/agentSettings/claude/CLAUDE.md`](../../workbench/agentSettings/claude/CLAUDE.md)
- Agent 设置 UI（Codex）：[`workbench/agentSettings/codex/CLAUDE.md`](../../workbench/agentSettings/codex/CLAUDE.md)
