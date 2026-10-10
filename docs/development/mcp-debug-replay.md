# MCP 工具调用重放调试器

会话里每个 MCP 工具调用卡片顶栏有一个重放按钮：不改对话、不惊动 Agent，把这次调用原样再发一次。这一页讲**为什么是这样实现的**、几条不能碰的红线，以及出错时从哪查。

## 为什么编辑器自己 dial 一条连接

ACP 里**客户端无法发起 tool call**——工具全部在 agent 进程内执行（两个 fork 都不再通过 ACP 回调让编辑器执行，`readTextFile` / `createTerminal` 在那两个 fork 里已是死代码）。所以"重放"只能是编辑器**自己当 MCP client**：拿会话里记下的 `mcpServer` / `mcpTool` / `rawInput`，按同一份配置连上去再调一次。

代价是明确的**第二条连接**：同一个 stdio server 会被拉起第二个进程，Agent 那条连接完全不知情。这是产品上接受的取舍（调试器本来就该独立），但要在 UI 上说清（确认框 + 面板常驻警示条）。

## 组件与数据流

```
ToolCallCard 的 <McpReplayAction>            renderer：只负责入口与门控
  → IMcpDebugService.openFromToolCall()      renderer：策略（解析 / 确认 / 页签 / 历史）
      · IAcpSessionService.resolveMcpServerConnection()   分层配置解析（唯一真相）
      · IDialogService.confirm()                          二次确认（掩码后的参数摘要）
      · McpDebugEditorInput + McpDebugPanel               独立页签
  → IMcpClientService（ProxyChannel）        main：一切副作用
      · McpStdioTransport + 独立 AcpHostService 实例      stdio：spawn / 分帧 / stderr 尾巴
      · SDK 的 StreamableHTTP / SSE transport              http(sse)
```

**配置解析刻意忽略会话白名单与默认停用覆盖**：重放一个本会话当前关掉的 server，正是调试器该做的事（`resolveMcpServerConnection` 用的是 union 视图的读法）。

## 几条红线

- **`env` / `headers` 的值绝不进日志**。stdio 只记 command + 参数**条数**，http 只记 origin（掉 path 与 query）——`mcpTargetSafety.redactTargetForLog`。server 自己的 stderr 也要过 `stripSecretLike` 才进诊断尾巴（server 启动横幅里打印配置是常态），**server 可控的其它文本**（JSON-RPC error 原文、协议违规的那一行）同样要先过它再进日志/面板/复制按钮。键名清单是唯一一份（`shared/mcp/secretKeyNames`），renderer 的确认框/历史摘要与 main 的脱敏共用——两边各存一份副本时已经漂移过（`auth` 只在一边被掩码）。
- **stdio 子进程 env 走 `buildChildEnv` denylist**：`contributes.mcpServers` 是第三方扩展也能贡献的，跟 agent 子进程同一个信任级别。副作用是**不能**用 `ELECTRON_RUN_AS_NODE` + `process.execPath` 起 MCP server（denylist 会剥掉，用户配置里写了也无效）——fixture 因此用系统 `node`。
- **不用 SDK 的 `StdioClientTransport`**：它自带白名单式 env 继承（绕过 denylist）、不登记 `processRoleRegistry`、只能 SIGTERM 无 treeKill。`mcpStdioTransport.ts` 自己按 `\n` 分帧（约 25 行），换取与 `IAcpHostService` 同一套进程管理。
- **独立 `AcpHostService` 实例**，不用单例：否则 MCP server 的 stdout 会被广播给所有窗口的 renderer，进程也会被错标成 `acp-agent`。

## 错误码

统一挂在 IPC 错误信封的 `err.code`（`ProxyChannel` 会透传），renderer 侧 `describeCallError` 翻成文案：

| code | 含义 |
|---|---|
| `MCP_SPAWN_FAILED` | 子进程压根没起来（命令不存在、无权限） |
| `MCP_CONNECT_FAILED` | 连接建不起来或中途断了（transport 构造失败、server 退出/掉线，附 stderr 尾巴） |
| `MCP_TIMEOUT` | 连接或请求超时（连接 30s、单次调用 60s） |
| `MCP_NEEDS_AUTH` | 需要交互式登录（OAuth），调试器不做登录流 |
| `MCP_SERVER_ERROR` | **server 说不行**：它正常回了 JSON-RPC error（未知工具、参数不合法）。原文透传 |
| `MCP_PROTOCOL_ERROR` | stdout 上出现了不是 MCP 的东西（非 JSON / 非 JSON-RPC 行、超长无换行），连接随即关闭 |
| `MCP_UNKNOWN_CONNECTION` | 连接已被回收 / 断开（窗口关了、空闲 TTL 到期、server 退出、被判为不可用） |

`MCP_SERVER_ERROR` 与 `MCP_PROTOCOL_ERROR` 的分界是「server 听懂了并拒绝」与「回来的根本不是 MCP」——混在一起会把 `Unknown tool: x` 说成「服务器破坏了协议」，把人引向错误的排查方向。`isError: true` 的 **正常回复**两条都不走：那是 server 说的话，面板按回复渲染并注明「不是编辑器故障」。

## 连接生命周期

- **一个页签一条连接**（`connectionId`，key = `${sessionId}::${serverName}`）。`_connect` 见到活连接直接返回；**握手也是共享的**（`TabEntry.connecting`）——面板在页签一打开就已可点，第一次握手还没落地时的第二次 Run 不能再 spawn 一份。重开时若 target 变了（两次重放之间改了配置）旧连接会被丢掉，以免面板显示的 target 与实际连的不是一回事。
- **连接在握手开始前就登记**（`_conns` / `_byWindow`）：只在成功时记账的话，窗口关闭 / 关页签时正在建立的连接对任何回收路径都不可见，子进程会活到空闲 TTL。
- 空闲 10 分钟回收；窗口关闭 / renderer 崩溃走 `stopAllForWindow`（与 `IAcpHostMainService` 同形）。
- 连接自行结束时 main 发 `onDidCloseConnection{reason}`，面板据此回到 idle 并提示；下一次 Run 自动重连一次（"把 server 修好再按 Run"）。调用中途发现连接不可用（`MCP_CONNECT_FAILED` / `MCP_PROTOCOL_ERROR`）时 main 会**主动回收**并发 `reason: 'transport-error'`——SDK 的 http/sse 传输在流断掉时不发 `onclose`，不这样做面板会一直显示"已连接"、每次 Run 都失败。
- 页签关闭 → `releaseKey`：断开连接、清掉状态订阅。订阅挂在服务自己的 `DisposableStore` 下（漏挂会在 e2e 的 teardown 泄漏门禁上被抓）；握手期间关页签的清理在 `_doConnect` 落地时补做。

## remote 接缝

`session.authority !== undefined` 时不做任何事：配置分层是按**本地**工作区读的，cwd 也是本地路径，连出去会打到错误的地方。卡片上的按钮保留可见但禁用（静默隐藏会让用户以为功能坏了），点击发一条说明性通知。只读会话预览（其它 worktree）同理——重放会在别人的 worktree 里起进程，正是 readOnly 要防的副作用。

## 测试布局

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯函数 | `renderer/services/acp/mcp/__tests__/mcpDebugModel.test.ts` | 掩码矩阵、骨架、JSON 解析、错误码文案 |
| 编排 | `renderer/services/acp/mcp/__tests__/mcpDebugService.test.ts` | 确认前后顺序、重开复用、重连一次、历史/回填 |
| main | `main/services/mcpClient/__tests__/` | 分帧、脱敏、真 fixture 子进程全链路（SDK `InMemoryTransport` 当 mock） |
| UI | `workbench/agents/__tests__/{McpDebugPanel,ToolCallCard.mcpReplay}.test.tsx` | 面板渲染与回调、按钮显隐矩阵 |
| e2e | `e2e/specs/smoke.mcpReplay.spec.ts` | 卡片 → 确认 → 面板 → 改参数重发 → isError |

fixture：`src/test-fixtures/mcpDebugServer.cjs`（零依赖 stdio server，`echo` / `fail`，env 开关模拟 stderr、崩溃、超时）。

## 排查

- **按钮不出现**：卡片没有 `mcpServer`/`mcpTool`（codex 会话的卡片没有 MCP 归因），或参数被内存预算释放了（`memoryTrimmed`）。这两条都在 `McpReplayAction` 里收敛。
- **面板一直 connecting**：看面板上的 target 摘要是否是预期的 command；main 侧日志有脱敏后的 spawn 记录。
- **"Unknown tool" 之类的报错**：那是 server 的拒绝，检查面板里的工具列表，确认工具名拼写（卡片上的工具名来自 Agent 的命名，未必等于 server 实际暴露的名字）。
- **改完 `platform` 后行为不生效**：apps 用的是 `dist/`，跑一次 `pnpm build`。
