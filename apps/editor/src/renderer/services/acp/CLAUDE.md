# apps/editor/src/renderer/services/acp/CLAUDE.md

Agent Client Protocol（ACP）客户端层。基于 `@agentclientprotocol/sdk` v0.22.1（ESM-only，zod schema 校验）。

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
| `acpPermissionHandler.ts` | `acp.permissions.autoApprove` 自动批准 + Memory 层持久化 |
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
8. **env denylist**：spawn 子进程前剥 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`，否则继承 Electron 的 fork 上下文，agent 会怪异崩溃。main + renderer 两端都要做。
9. **16ms 防抖事务**：`applyUpdate` 内 messages / toolCalls / plan 共用一个 `transaction()`，单次 observer 通知。新增更新类别也要进同一事务，否则会产生抖动。

## 参考路径

- SDK 类型源码：`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
- SDK 入口：`@agentclientprotocol/sdk` 导出 `ClientSideConnection / AgentSideConnection / RequestError / ndJsonStream` + 全部 schema 类型
- 配置 key：`acp.agents` / `acp.permissions.autoApprove` / `acp.startupTimeoutMs` / `acp.defaultAgentId`
