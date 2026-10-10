# cases-mcp-debug

> 本文从 `services/acp/CLAUDE.md` 拆出，范围是：MCP 工具调用**重放调试器**（`services/acp/mcp/`）——页签身份、状态机、确认时机、订阅生命周期，以及排查路径。跨模块机制（为何自建 client、spawn 取舍、错误码表、敏感值策略）见 [docs/development/mcp-debug-replay.md](../../../../../../docs/development/mcp-debug-replay.md)。

## 页签身份与状态归属

- key = `` `${sessionId}::${serverName}` ``（`debugKey`），一个 (会话, 服务器) 一个调试器。`McpDebugEditorInput` 的 resource 是 `universe:/mcp/debug/<encoded key>`；打开前先跨组查重（`findMcpDebugEditor`），因为 `IEditorService.openEditor` 只在活动组内去重。
- **状态活在服务里，不在面板里**：`Map<key, TabEntry{state: ISettableObservable<McpDebugPanelState>, subs, target, connectionId}>`。面板被页签切换卸载/重挂，连接、工具列表、历史都必须撑过去。
- **不跨重启恢复**：`McpDebugEditorInput` 刻意不实现 `serialize`（持久化走到它时记 `null`，页签自然消失）。恢复它意味着重启后重连一个用户没要求的 server。
- 状态订阅（`input.onWillDispose → releaseKey`）挂在服务的 `DisposableStore` 下：**漏挂会被 e2e 的 teardown 泄漏门禁抓到**（`computeTeardownLeakReport` 只豁免能追到单例的 disposable）。重开同一调试器要先 `subs.clear()`，否则旧订阅会跟着新的一起触发。

## 确认时机

二次确认发生在**任何副作用之前**（`connect()` 就会 spawn 进程 / 发 HTTP）。确认框内容：服务器名 + transport、工具名、掩码后的参数摘要、以及"绕过 agent 权限确认"这句警示。页签里后续的 `Run Tool` 不再弹窗——那里已经有一次常驻警示条，每按一次都弹会变成噪音。

## 参数框语义（`paramsDirty`）

`paramsDirty` 的含义是"**用户编辑过**"，不是"内容来自卡片"：`_ensureTab` / 从卡片重开都播成 `false`（内容来自卡片的记录调用，仍属未编辑）。因此选中另一个工具时 `selectTool` 会按新工具的 schema 重新生成骨架；用户敲过字之后就不再覆盖。历史行回填刻意先 `selectTool` 再 `setParamsText`（前者可能重生成骨架，后者必须赢）并把 dirty 置真。

## 连接与重连

`_connect` **见到活连接直接返回**，**握手中也共享**（`TabEntry.connecting`）：重开同一调试器不能再 spawn 一份（旧连接会被孤立，直到窗口关闭/TTL 回收），而面板在页签一打开就能点 Run——第一次握手还没落地时按下的 Run 会等同一份连接，不会拉起第二个 server。Run 的 `running` 标志在 `await` 之前就置位，否则两次 Run 会在握手窗口里各发一次调用。

死连接的各条路径（`MCP_UNKNOWN_CONNECTION`、`onDidCloseConnection`、`disconnect`）都会先把 `connectionId` 清掉，所以 Run 里的"重连一次"仍然走得通。重开时若解析出的 target 与页签持有的不同（中途改了配置），旧连接会被主动断开、Run 重新拨号——否则面板显示的 target 与实际连的不是一回事。握手期间关掉页签的清理在 `_doConnect` 落地时补做（此时才拿到 connectionId）。空闲 TTL 10 分钟、窗口关闭与 renderer 崩溃走 `stopAllForWindow`，细节见开发文档。

**入口守卫三档**（`openFromToolCall`）：`authority`（远程）、`readOnly`（只读会话预览）各自发一条说明性通知并直接返回——卡片按钮只拦住了按钮本身，命令面板会绕过它，所以服务层必须再判一次。

## 排查

- **按钮不出现**：`McpReplayAction` 的四条硬条件（`mcpServer` / `mcpTool` / `rawInput` 齐备且非 `memoryTrimmed`）+ 必须有 session（脱离会话的卡片不显示）。codex 会话的卡片没有 MCP 归因，本来就不会有。
- **按钮存在但禁用**：`authority`（远程）或 `readOnly`（其它 worktree 的只读预览）。点击会发一条说明性通知，不是哑的。
- **面板显示"没有实时会话"**：服务里没有这个 key 的状态（页签被别的路径恢复、或状态已被 `releaseKey` 回收）。
- **工具列表是空的**：`toolsError` 会显示具体原因；只有连接活着才能 `refreshTools`（按钮在非 connected 时禁用）。
- **连上了但每次 Run 都失败**：连接级故障（`MCP_CONNECT_FAILED` / `MCP_PROTOCOL_ERROR`）会被 main 判定为不可用并回收，面板随即回 idle 并给出提示，下一次 Run 重连；若仍失败，说明 server 侧每次都握手失败——看错误 banner 里的 stderr 尾巴。
- **测试**：纯函数与编排在 `mcp/__tests__/`（renderer-node），面板与卡片按钮在 `workbench/agents/__tests__/`（renderer-dom），端到端 `e2e/specs/smoke.mcpReplay.spec.ts`。
