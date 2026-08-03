# apps/editor/src/renderer/services/acp/session/CLAUDE.md

> 本文是 `services/acp/CLAUDE.md` 的子域文档（会话子系统 + rewind-fork 案例）。协议层全景（SDK 约定 / 入站方法 / MCP / 沙盒 / 跨进程边界）见 [`../CLAUDE.md`](../CLAUDE.md)；本文引用其中的章节不再重复。

## 会话子系统（acp-session）

> 范围：制作或修改 ACP agent 会话相关功能——多会话 facade + 单会话 view-model + 异步化双 id 架构 + 连接池/恢复协调器 + 双渲染模式 + 持久化 + 会话级 diff/计时/开销等附加能力 + 命令层 + 测试套路。本节做导航与路由（「改哪里 + 为什么 + 坑」）；协议层细节（SDK 约定/入站方法/MCP/沙盒）见 [`../CLAUDE.md`](../CLAUDE.md)，不重复。

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
> **协议层（SDK 类型约定、入站方法、MCP、沙盒路径策略、agent 预设）见 [`../CLAUDE.md`](../CLAUDE.md)（套路 ACP-A~F + 「SDK 关键约定」10 条易踩坑），本节不重复。**

### 核心事实（务必先懂）

- 协议层全在 renderer、SDK 类型无 alias 层——见 `../CLAUDE.md`「关键事实」，不重复。
- **双 id 架构（异步化后的关键）**：见 [[async-session-create]] 记忆。
  - `AcpSession.id` = 构造时生成的**本地稳定 uuid**（`generateUuid()`），UI 立即拿到——React key / `activeSessionId` / 运行期缓存（draft cache / widget registry / chat view state）全用它。
  - `AcpSession.sessionIdOnAgent: IObservable<string|undefined>` = **agent 颁发的 durable id**，连接 attach 后才有。history 条目、change tracker（record/changesFor）、active-session 持久化、editor tab serialize、**协议通知路由的源 id** 全用它。
  - `AcpSessionService._findSession(id)` **同时匹配本地 id 与 agent id**，所以 getById/setActive/closeSession/通知分发对调用方透明，传哪个都行。
  - **resume 出来的会话**：`id === entry.sessionIdOnAgent`（两者相等，因为 resume 直接用 durable id 当 id）。
- **createSession 异步、立即返回**：同步建好 `AcpSession` + 发布 observable → UI 立即可输入；spawn+initialize+session/new 在后台 `_connectSession` 跑，完成后 `session.attachConnection(conn, agentId)`。连接前用户发的 prompt 入 `_queuedPrompts`，attach 后自动 flush。失败走 `failConnection`（status `errored` + `[error]` 消息，**不再 reject**）。状态机：`connecting`→attach→`idle`，或→`errored`。
- **16ms 防抖事务**——见 `../CLAUDE.md`「数据流」末段与「SDK 关键约定」#9，不重复。
- **timeline 是 UI 的唯一真相**：`timeline` observable 按到达顺序交织 message/tool_call slot（plan 不进 timeline，单列 `plan` observable）。三个 lane observable（messages/toolCalls/plan）保留作 selector 读。

### 文件地图

#### Service 层 `apps/editor/src/renderer/services/acp/session/`（本目录）

| 文件 | 职责 | 何时改 |
|---|---|---|
| `acpSessionService.ts` | 多会话 facade：`sessions`/`activeSession`/`activeSessionId` observable + `IAcpClientNotificationSink` 分发（onSessionUpdate/onRequestPermission/onAskUserQuestion/onExtNotification）+ createSession/`_connectSession`/resumeSession/closeSession + `_findSession` | 会话生命周期、路由、active 切换、持久化 active id |
| `acpSession.ts` | `AcpSession` view-model：全部 observable + `applyUpdate` 状态机 + 双 id + prompt 队列 + `attachConnection`/`failConnection`/`whenConnected` + 标题派生 + usage/cost 提取 + 计时段累计 | 消息/工具/计划/状态/usage 行为、连接生命周期 |
| `acpSessionConfigOptions.ts` | `ConfigOptionStateMachine`：configOptions observable + echo 抑制 + `setConfigOption` 推送 + 持久化分支（注入 `AcpSession`，连接前 `getConn()` 返回 undefined 时静默 no-op） | 配置项（model/mode/thought-level）同步 |
| `acpSessionRestoreCoordinator.ts` | 启动/workspace-swap 恢复 + `session/list` 扫描 + `session/delete` 转发 + `_pendingRestoreHistoryId` | 恢复时序、跨 workspace 重连 |
| `acpSessionHistory.ts` | 会话元数据落盘（`PersistedStateBase`，`MAX_ENTRIES=100`，键 `sessionIdOnAgent`） | 历史字段（见 `../CLAUDE.md` 套路 ACP-E） |
| `acpAgentDefaultsService.ts` | 每 agent configOption 默认值（`PersistedStateBase`） | 配置项默认值持久化 |
| `acpSessionEditorInput.ts` | `EditorInput` 子类——会话即编辑器 tab，可序列化恢复（serialize 写 `sessionIdOnAgent ?? 本地id`） | 全屏 tab 行为、重启恢复 |
| `acpSessionTitleService.ts` / `acpSessionTitle.ts` / `sessionTitleFormat.ts` | 标题自动生成（AI purpose `session-title`）+ 解析/截断/格式化 | 标题逻辑 |
| `acpChatLocationService.ts` | **单一真相**：Chat 渲染在 EditorArea（全屏 tab）还是 SecondarySideBar（停靠面板）。三向同步 + ContextKey | 双模式切换 |
| `acpChatWidgetService.ts` | 已挂载 ChatBody 的 registry：DOM 容器 + moveTimeline/focusInput 回调 + `lastFocusedWidget`（命令定向） | 多实例聚焦/定向命令 |
| `sessionChangeTracker.ts` | 每会话整文件改动追踪（逆推 baseline，键 `sessionIdOnAgent`） | 会话级 diff（见 [[session-diff-feature]]） |
| `acpPromptDraftCache.ts` / `acpQuestionDraftCache.ts` / `acpChatViewStateCache.ts` | 草稿/问题答案/视图态缓存（按**本地 id** 缓存） | 草稿持久、折叠态 |
| `acpSessionFilterService.ts` / `acpSessionStatus.ts` / `acpAuthError.ts` | 列表过滤/状态枚举/auth 错误判定 | — |
| `acpSessionConnection.ts` / `acpSessionContent.ts` / `acpSessionCost.ts` / `acpSessionModel.ts` / `acpSessionFactory.ts` / `acpSessionRecovery.ts` / `acpSessionRegistry.ts` / `acpSessionOutlineRegistry.ts` / `acpSessionUpdateMeta.ts` / `acpTimelineOutline.ts` | 连接绑定 / 内容组装 / 开销 / 接口模型 / 工厂 / 恢复 / 注册表 / outline 注册 / update `_meta` 读取 / timeline outline | 见各自头注释 |
| `acpPromptHistoryService.ts` / `acpPromptContextInbox.ts` / `acpPromptReplaceInbox.ts` / `acpPromptTextInbox.ts` / `acpElicitationDraftCache.ts` | prompt 历史 / 上下文收件箱 / 替换收件箱（rewind 回填）/ 文本收件箱 / elicitation 草稿 | — |
| `sessionBookmarks.ts` / `sessionBookmarkService.ts` | 会话书签 | — |
| `acpCompactionStats.ts` / `acpConfigOptionsCache.ts` / `acpAgentCostStrategy.ts` / `acpAuthGuidanceService.ts` / `acpErrors.ts` / `acpErrorClassify.ts` / `acpExtMethods.ts` | compaction 统计 / 配置项缓存 / 开销策略 / auth 引导 / 错误模型 / 错误分类 / ext-method 常量 | — |
| `sessionDiffReconstruct.ts` | 会话级 diff 的 baseline 逆推（原 `diff/reconstructBaseline.ts`） | diff 精度 |

#### 同域核心层 `apps/editor/src/renderer/services/acp/`（上一级）

| 文件 | 职责 | 何时改 |
|---|---|---|
| `acpClientService.ts` | 进程启动 + SDK `ClientSideConnection` 装配 + **refcount 连接池**（按 agentId+cwd 租用）+ fs/terminal/permission 网关 | 连接建立、池化、入站方法（见 `../CLAUDE.md` 套路 ACP-C） |
| `acpAgentRegistry.ts` | 内置 agent 预设 + `acp.agents` 合并 + PATH 探测 + `runAsNode` 可信标志 | 加 agent（见 `../CLAUDE.md` 套路 ACP-A） |
| `acpPermissionHandler.ts` | 自动批准 + Memory 持久化（见 `../CLAUDE.md` 套路 ACP-D） | 权限策略 |
| `acpPathPolicy.ts` / `acpMcpServers.ts` / `sdkHostStream.ts` / `promptMentions.ts` / `markdownRenderer.ts` / `mentionFileSearch.ts` / `persistedStateBase.ts` / `acpProtocolTracer.ts` / `ansi.ts` / `filePathLink.ts` / `chatFindMatcher.ts` / `commandWrapper.ts` / `agentIconData.ts` / `agentNotificationIcon.ts` | 沙盒/MCP/流适配/@提及/markdown/文件搜索/持久化基类/协议 trace/ANSI/文件链接/查找/命令包裹/图标 | 见各自头注释或 `../CLAUDE.md` |
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

### 数据流（速记，细节见 `../CLAUDE.md`「数据流」）

**出站**：`PromptInput` → `AcpSessionService.sendPrompt(text, mentions)` → `composePromptBlocks()` 转 @文件为 resource_link → `AcpSession._appendMessage('user')`（立即上屏）→ 未连接则入 `_queuedPrompts`，已连接则 `_dispatchPrompt` → `conn.prompt({ sessionId: sessionIdOnAgent, prompt })`。

**入站**：`IAcpHostService.onStdout` → `sdkHostStream` → SDK 回调 → `AcpSessionService.onSessionUpdate` → `_findSession(params.sessionId)`（用 agent id 匹配）→ `AcpSession.applyUpdate` switch（8 种 SessionUpdate，进 16ms 事务；`config_option_update` delegate 到 state machine 做 echo 抑制）。

### 常见任务 → 改哪里

- **加一种 SessionUpdate 类型**：`acpSession.ts` 的 `applyUpdate()` switch 加 case + 进 16ms `transaction` + 新 view-model 挂 `AcpSession` 上（不挂 SDK 类型）。详见 `../CLAUDE.md`「套路 ACP-B」。
- **改会话生命周期/连接时序**：`acpSessionService.ts` 的 `createSession`/`_connectSession`/`resumeSession`；连接绑定/队列 flush 在 `acpSession.ts` 的 `attachConnection`/`failConnection`。**任何「连接前/后」分支都要想清双 id 与队列**。
- **加附加于会话的能力**（如新 indicator / 新追踪）：view-model 字段加在 `acpSession.ts`（observable），UI 在 `workbench/agents/*` 用 `useObservable` 订阅。**注意键用 `sessionIdOnAgent` 还是本地 `id`**——跨会话持久/协议相关用前者，纯运行期 UI 缓存用后者（见下方坑 #2）。
- **改双模式布局**：`acpChatLocationService.ts`（真相 + ContextKey）+ `AgentsView.tsx`（分支）+ 命令 `ToggleAgentChatLocationAction`。
- **卡片折叠有两层，别混**：①**外层卡片折叠**（整个 message/tool_call slot 收起）走 `timelineCollapse.ts` 的 `overrides` + `session.collapseMode`，持久化进 `AcpChatViewStateCache.collapse`；②**内层内容折叠**（长用户消息过 `COLLAPSED_MAX_PX` 夹高 / execute 终端输出过高时的 "Expand/Collapse" 按钮）是叶子组件 `UserMessageItem`/`TerminalOutput` 的展开态。内层态历史上是组件本地 `useState`，切 session/切 tab/虚拟化滚屏（卸载重挂载）即丢——修法：`chatContentExpansion.tsx`（context store `{expandedKeys, toggle}`）由 `ChatBody` 提供并折进 `AcpChatViewStateCache.contentExpandedKeys` 持久化；叶子按稳定 `contentKey` 读写（用户消息 `msg:<slotKey>`、终端 `term:<stickyKey>`），无 store/key 时退回本地 state（如 `ToolCallList` 独立用法）。context 消费者随 store 变化自动重渲染，绕过 `TimelineSlot` 的 memo，无需改 memo。
- **加配置项交互**：`acpSessionConfigOptions.ts`（推送/echo）+ `ConfigOptionsBar.tsx`（UI）+ `acpAgentDefaultsService.ts`（默认值持久化）。
- **改恢复/重连**：`acpSessionRestoreCoordinator.ts` + `acpSessionEditorInput.ts`（tab 序列化）+ `acpSessionHistory.ts`（条目）。
- **claude 会话跨 compact 边界的历史回放在 fork 侧解决，编辑器零改动**：SDK `getSessionMessages` 只沿 `parentUuid` 走「有效上下文链」，compact_boundary 的 `parentUuid` 为 null（显示序前驱存在 `logicalParentUuid`，SDK 不追），所以 loadSession 重放天然丢压缩前历史。修法在 `vendor/claude-agent-acp` 的 `replaySessionHistory`：读原始转录 jsonl，`rebuildTranscriptDisplayChain` 从最新叶子沿 `parentUuid ?? logicalParentUuid` 回溯重建显示链（**链走法而非文件序**——CLI 建的会话可能含被放弃的 rewind 分支），边界处发一条 `_universe/compaction` `phase:'success'` 通知（编辑器 `applyCompaction` 对孤立 success 走 idx===-1 分支直接落一张已完成卡片），跳过 `isCompactSummary` 消息；转录缺失/无边界时回退 `getSessionMessages`，未压缩会话路径不变。模型上下文不受影响（仍 `resume: sessionId`）；rewind 无需改（压缩前锚点 → `messageUuidBefore` undefined → 全会话 resume + 磁盘截断恰好正确）。
- **同一轮并行 tool_use 的 tool_result 会掉出显示链 → 恢复后工具卡片永远「运行中」**：claude transcript 把同一轮的并行 tool_use 串成链（use1→use2→…），每个 `tool_result` 的 `parentUuid` 指向**自己的** use——链走法只会跟随**最后一个** use 的结果分支，前面每个并行 use 的 result 都不可达（如 use1→use2→result2 在链上、result1 掉链），重放只发 `tool_call` 无终态 `tool_call_update`，卡片卡在 in_progress、计时器空转。修法在 `replaySessionHistory` 尾部 `backfillForkedToolResults`：跟踪本次重放 surfaced（`tool_call`）与 settled（终态 `tool_call_update`）的 id，从 rawEntries 找回掉链的 `tool_result` 块重放（只重放 result 块、跳过已 settled 防重复闭合；transcript 里真无 result 的——进程被 kill 中断的 turn——无数据可补不强行闭合，而 cancel/interrupt 的正常中断会写 `is_error` result，掉链时补发后正确显示 failed）；uncompacted 会话的 `getSessionMessages` 有效链同样掉链，故对两条路径统一补。对照测试 `acp-agent.test.ts`「tool_results forked off the display chain」。
- **codex 恢复路径的 thought chunk 必须自带 part 分隔符**：编辑器 `mergeStreamingBlock` 把同 message 的 text chunk **逐字拼接、不加任何分隔**。codex reasoning summary 每个 part 是一行 `**标题**`；流式路径 part 之间有 `summaryPartAdded` → `\n\n`（item/completed 兜底 `createCompletedReasoningEvent` 也 `join("\n\n")`），恢复路径（`CodexAcpServer.createReasoningUpdates` + `ResponseItemHistoryFallback.createReasoningUpdates`）曾逐 part 发 chunk 无分隔 → 恢复后粘连成 `**A****B**` 一坨。修法：两处恢复函数统一 `parts.filter(...).join("\n\n")` 单 chunk（对齐 live stream）。配套样式：`.messageItem/.subMessage[data-role='thought'] strong { font-weight/color: inherit }`（agents.module.css）让 thought 卡片内 markdown 强调不变成亮白粗体（`.markdown strong` 全局规则是 700 + 亮白色）。改 fork 任何「恢复重发」逻辑时，先想清楚该逻辑在流式路径靠什么分隔符，恢复侧必须复刻。
- **codex 恢复丢 shell 调用 = app-server 不重建 `custom_tool_call`，fork fallback 补**：新版 codex 的 shell/patch 调用在 rollout 里是 `custom_tool_call`(name=`exec`，input 是 JS 片段 `await tools.shell_command({...})`/`tools.apply_patch(...)`) 而非 `function_call`。live 时 app-server 实时转成 `commandExecution` item 推送；但 `thread/resume` 从 rollout 重建 turns 时**不还原**它们（apply_patch 会重建为 fileChange，shell 全丢）→ 恢复后 shell 卡片消失。排查法：用真实 codex 二进制跑 `app-server` + `thread/resume` 对比 rollout 原始记录。修法在 fork `ResponseItemHistoryFallback`：识别 exec 的 JS input，平衡括号提取 `shell_command` 的 JSON 参数合成 `shell_command` function_call 复用既有渲染管线（terminal 卡片 + commandAction 推断 + `Exit code: N` 解析，注意剥 `Script completed/failed` 包装 chunk 和 `Wall time` 头）；apply_patch 类必须 skip（thread 的 fileChange 已覆盖，且 fileChange id 是 `exec-<uuid>` ≠ rollout 的 `call_xxx`，靠 id 去重根本匹配不上）；`custom_tool_call_output` 只在 call 已 emit 时生成 update 防孤儿。改完必须 `npm --prefix vendor/codex-acp run build`（dev 入口 = `vendor/codex-acp/dist/index.js`）。
- **加 agent / 改权限 / MCP / 沙盒 / 入站方法**：见 `../CLAUDE.md` 套路 ACP-A/D/F/C。
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
- **关窗/退出时停 agent 走 willShutdown join，不靠 beforeunload**：agent 子进程 cwd=workspace（app 单例 acpHost spawn），beforeunload 的 fire-and-forget stop 在页面销毁时 IPC 会被丢弃——shell 包装的 agent（cmd.exe→node.exe）残留并把 cwd 钉在 workspace 上，Windows 下文件夹删不掉直到 app 退出。可靠路径：`RendererLifecycleService.confirmShutdown` 跑完整两阶段（veto + onWillShutdown join），`acpClientService` 在 join 里 `Promise.allSettled(liveHandles.map(stop))`，窗口活着时 IPC 通畅；beforeunload 仅作 reload/崩溃兜底。
- **持久化只存字符串元数据**：无 ContentBlock/SessionUpdate 落盘；恢复时拿 `sessionIdOnAgent` 调 `loadSession` 让 agent 重放。双桶 scope（WORKSPACE + GLOBAL fallback）见 `../CLAUDE.md`「持久化」。

### 易踩坑速记

1. **混淆两个 id**：协议路由/history/change-tracker/active 持久化/tab serialize 用 `sessionIdOnAgent`；React key/运行期缓存/`activeSessionId` 用本地 `id`。用错会「消息不路由」或「重启丢会话」。
2. **连接前访问连接相关状态**：握手未完时 `sessionIdOnAgent.get()` 是 undefined、`getConn()` 是 undefined。所有读这些的代码都要 guard。测试里在注入 agent 通知/访问 `client.connected[...]`/断言 seed 状态前**必须 `await session.whenConnected()`**。
3. **`T | null` ≠ `T | undefined`**——见 `../CLAUDE.md`「SDK 关键约定」#1。
4. **新增更新没进 16ms 事务**：会产生抖动/中间态闪烁。
5. **FakeSession stub 漏新接口成员**：`IAcpSession` 加方法（如 `whenConnected`）后，`ConfigOptionsBar.test.tsx` / `PromptInput.test.tsx` / `SessionChangesView.test.tsx` 等的本地 stub 要同步补，否则 typecheck 红。
6. **FakeStorage 启动 fire workspace-swap**：异步 createSession 下，启动期的 `onDidChangeWorkspaceScope` 微任务会触发 `_onWorkspaceSwap` 把刚建、未 attach 的 session close 掉——测试给 service 自身的 storage 要退订该启动事件。见 [[async-session-create]]。
7. **其余 SDK 协议坑**（ToolKind 10 枚举 / setConfigOption 无 type:'select' / void 序列化为 {} / cancel 双步 / terminal ownership / stderr 独立通道 / env denylist / stdio MCP 不带 type）：全在 `../CLAUDE.md`「SDK 关键约定」#2-#10，改协议层前必读。
8. **会话标题四个写入方，优先级 manual > ai > agent 报告（`session_info_update`/hydrate 的 summary）> 首条 prompt 派生**：`updateInfo` 默认不覆盖 `aiTitle/manualTitle` 行，权威写入（AI 标题落盘、rename）走 `overwriteProtectedTitle` 显式通道；AI 生成跳过本地内置命令 prompt（`isLocalCommandPrompt`，/model 等，不消耗机会）且返回 undefined 自动 re-arm 下条重试；fork 回放自定义命令重建为 `/name args`（`stripLocalCommandMetadata`）。**排查标题问题先看 main 侧 `ai-debug.jsonl` 有无 `session-title` 请求**：没有 = renderer 在 `_resolveModelId` 静默返回（现已有 debug 日志 `acp.sessionTitle`）；有但标题没落地 = history 写入方时序/覆盖问题。注意 `createdAt` 在 upsert 重加时不重置，但 hydrate 首次导入外来行时 = 导入时刻，别拿它当会话真实创建时间。
9. **长 timeline 从底向上滚动抖动**：有两条独立成因，都会让 `scrollTop` 在某个落点上下高频振荡、直到手动拖进度条才停。**(a) 补偿策略太宽**：`ChatBody` 的动态虚拟行从 `estimateRow` 切到真实高度时，TanStack Virtual 默认以 `item.start < scrollOffset` 判断是否补偿，会把顶部半可见行也按完整高度差反向修正 `scrollTop`，与用户向上滚动互相拉扯。修法：`shouldAdjustScrollPositionOnItemSizeChange` 必须只在整行位于视口上方（`item.end <= scrollOffset`）时返回 true（见 `timelineVirtualScroll.ts`）；虚拟模式同时设 `overflow-anchor: none` 避免 Chromium 原生锚定重复补偿；restore / bottom-pin 收敛窗口可临时设 `() => false`，结束后必须恢复自定义策略，不能恢复为 `undefined`（否则退回 TanStack 默认规则）。**(b) 行高每次挂载不稳定（真根因，即使全表高度已重算过仍复发）**：`item.end <= offset` 只是必要条件不是充分条件——若视口上方某行每次重挂载测出的高度都不同，补偿会重挂载它、它又闪回旧高度，形成自持振荡。两个已修案例：① `TerminalOutput`（execute 卡片）首帧按全高挂载、随后 async 夹到 240px；② `UserMessageItem`（>160px 长用户消息）曾完全无 seed（`useState(false)` + `useEffect` 迟夹高），且首版估算按字符数算列宽、对 CJK 低估一半行数（中文≈2 列宽）——长中文会话 outline 跳转后向上轻滚即必现「上下闪动 + 持续上漂」。修法在高度源头，基建收敛在 `contentOverflow.ts`：CJK 宽度感知的纯函数估算同步 seed `overflows`（首帧即最终夹后高度）+ 按 contentKey 的**测量缓存**（remount 直接用上次实测，估算边缘偏差只翻转一次即被钉住），两叶子共用（见 `ToolCallOutput.tsx` / `UserMessageItem.tsx`）。**任何叶子组件在挂载后异步改变自身高度都可能复现此环**，新增此类组件时首帧高度必须可由数据同步推定（估算 + 测量缓存双保险）。回归测试：`timelineVirtualScroll.test.ts`（预测逻辑）+ `contentOverflow.test.ts`（CJK 估算/缓存）+ e2e `smoke.agentsScrollJitter.spec.ts` 两用例（真 `page.mouse.wheel` 打点 `window.__TIMELINE_SIZE_CORRECTIONS_TOTAL__` 证明静止时无自持补偿环——注意合成 `el.scrollTop=x`+dispatch scroll 会重置 `scrollAdjustments` 掩盖该环，必须用真滚轮）。
10. **第一条用户消息不在 `displayTimeline` 里**：`ChatBody` 把它 slice 掉改由滚动容器上方的 `StickyUserMessageBar` 常驻渲染（提交 f2d35dc3 去重）。**渲染/虚拟化索引用 `displayTimeline`，键盘导航/复制等语义操作必须用完整 `timeline`**——`handle.move` 曾因读 displayTimeline 让首条用户消息成为导航黑洞；现在 move 遍历完整 timeline，命中被 slice 的项（displayIndex === -1）时 reveal 就是 `scrollTop = 0`（sticky bar 恒可见），virtualizer `scrollToIndex` 必须换算回 displayTimeline 坐标。焦点高亮跨组件同步走 `FocusedKeyBridge`（`{key, emitter}`，ChatSessionBody 在 render 期挂到 `handleRef.current`）——**不能由 ChatScroll 的 effect 赋值**，因为 StickyUserMessageBar 先于 ChatScroll 挂载，订阅时 handle 方法还是 NOOP；emitter 沿用 activeSlotRef 的「不 dispose、GC 回收」StrictMode 模式。**焦点框（`timelineSlotFocused`）要加在内层卡片上，别加全宽 `ul.stickyUserBar`**——ul 左右贴到聊天区边缘，x≈1–2px 处的 outline 会被 workbench 分界 sash 盖掉；卡片内缩 12px，与列表内 TimelineSlot 的焦点框几何一致。
11. **`status:'closed'` 有两义，区别看 `_connection.phase`**：agent 进程在闲置期退出时，onClose 的 idle 分支只做**静默 seal**（`status='closed'`、无 `[error]`、无 recovery state），phase 仍是 `'connected'`、死 lease 仍绑在 `_conn` 上；恢复靠 `sendPrompt` 的**按需重握手守卫**（phase `'connected'` + `conn.signal.aborted`，或 phase `'failed'` → `_handleConnectionLost`，prompt 走现成 connecting 队列，reattach 后 flush）。用户主动 `close()` 则 phase 转 `'closed'` 且 session dispose，守卫绝不复活它。改恢复逻辑时：① `retryRecovery` 的 `_failedPrompt` 分支有同构死连接检测（置 `_turnInterrupted=true` 必须在 `_handleConnectionLost` 调用**之后**，否则被其 `_inFlight.size>0` 覆写）；② `_reconnectingSessions` 去重会吞 reattach 收尾窗口内的二次断连事件，靠 `_reconnectSession` finally 的 `isReconnecting` 复查补跑，别删。回归测试：`AcpSession.recovery.integration.test.ts`。

### 测试套路

- 协议级一律走 `testing/inMemoryAcpPair.ts`（真 `ClientSideConnection` ↔ 桩 `Agent`，断言 fake agent 方法被调 + 参数对，不断言 jsonline 字节）——见 `../CLAUDE.md`「测试模式」。
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

#### renderer service `apps/editor/src/renderer/services/acp/session/`（本目录）

| 文件 | 相关改动 |
|---|---|
| `acpSession.ts` | `rewindTo(messageId,{dryRun?,rewindFiles?})`（reset+replay-gate+extMethod+tracker.clear 条件）；`forkSupported`（observable，从 `sessionCapabilities.fork` 设）+ `rewindSupported`（observable，从 initialize `_meta['universe-editor/capabilities'].rewind` 设）+ 私有 `_filesRolledBackByAgent`（同块设）；`_dispatchPrompt` 发 `_meta:{messageId}`；`applyUpdate` 的 `user_message_chunk` 传 `readMessageId(update)`；`_appendChunk` 加 `messageId?` 参 |
| `acpSessionModel.ts` | `IAcpSession` 接口：`rewindTo` 签名 + `forkSupported`/`rewindSupported` + `RewindFilesResult` 类型；`REWIND_SESSION_METHOD` 常量（与 vendor 同步） |
| `acpSessionService.ts` | facade `forkSession(sid,msgId?)`（temp lease → unstable_forkSession → resumeSession）+ `rewindSession(sid,msgId,{dryRun?,rewindFiles?})`（校 live+非 closed+rewindSupported 才委托）；`AcpForeignWorktreeError` 守卫；`forkSideTask(parentSid,{text,label})`（侧边任务：共用 `_forkOnAgent`，history 行写 `sideTaskOf`/`sideTaskQuote` + mode 覆盖只读值（claude=`dontAsk` 不写计划、codex=`read-only`），resume 带 `activate:false`；**基线回放抑制由 `_resumeSessionInner` 按 history 行的 `sideTaskOf` 标记驱动**——所以 fork 时与重启/重开后的普通 `resumeSession` 都不落基线到 timeline；边界锚点 = history 行 `sideTaskAnchorMessageId`（sendPrompt 首次发送时写入，write-once），replay 命中该 user chunk 解除抑制，**side task 自己的 turn 落盘、只抑制基线**；首轮 wire prompt 由 `sendPrompt` 经 `_dispatchPrompt` 的 `hiddenLeadBlock` 参在最前插隐藏角色 text block（`SIDE_TASK_ROLE_PROMPT`，只进 wire 不进 UI、仅首轮注入一次），让 agent 自知"侧边追问"身份） |
| `acpSessionUpdateMeta.ts` | `readMessageId(update)` reader（从 update 读 vendor 盖的 messageId）+ `readChangedConfigIds(update)`（读 `_meta["universe-editor/changedConfigIds"]` 声明，见已修 bug #6） |
| `acpPromptReplaceInbox.ts` | edit-and-retry 回填收件箱：**替换语义**（map 存单值 last-wins，drain 返 string?）。区别于 `acpPromptContextInbox`（追加语义） |

#### renderer 命令 + UI

| 文件 | 职责 |
|---|---|
| `actions/agentRewindActions.ts` | `RewindAgentSessionAction`（dryRun 预览→三/单按钮确认→rewind→回填）+ `ForkAgentSessionAction`（fork→开 editor tab 或 setActive）。rewind `f1:false`、arg 须带 `{sessionId,messageId}`；fork 的 messageId 可省（=从 tip 分叉完整对话），`f1:true` 无参时回退 active session，running 中拒绝 |
| `actions/index.ts` | `registerAction2` 两个 action；`agentActions.ts` barrel re-export |
| `workbench/agents/UserMessageItem.tsx` | hover 显 Rewind（`Undo2`）/Fork（`GitBranch`）按钮，`useObservable(rewindSupported)`+`useObservable(forkSupported)` 各自门控；抽 `UserMessageActions` 子组件避免条件 hooks |
| `workbench/agents/ForkTipFooter.tsx` | 时间线末尾「从此处分叉」footer：idle + forkSupported + 非 readOnly 才显示（running 隐藏防半截 turn），arg 只带 `{sessionId}` |
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
