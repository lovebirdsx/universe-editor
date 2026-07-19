---
name: acp-session-subsystem-context
description: 制作或修改 ACP agent 会话（session）相关功能时召回，提供该子系统的全景上下文地图——多会话 facade（AcpSessionService）+ 单会话 view-model（AcpSession，observable 状态机）+ 异步化双 id 架构（本地 uuid id vs agent 颁发 sessionIdOnAgent）+ 连接池/恢复协调器 + 双渲染模式（EditorArea 全屏 tab vs SecondarySideBar 停靠面板）+ 持久化（history/defaults 双桶）+ 会话级 diff/计时/开销等附加能力 + 命令层 + 测试套路。当任务涉及 apps/editor/src/renderer/services/acp/* 或 src/renderer/workbench/agents/*、改会话生命周期/消息流/工具调用/计划/权限/配置项/标题/恢复/UI、加 SessionUpdate 类型、排查「会话不显示/消息没路由/恢复失败/连接没建立」时，先读它建立全局认知与「改哪里 + 为什么 + 坑」。它做导航与路由；协议层细节（SDK 约定/入站方法/MCP/沙盒）见 services/acp/CLAUDE.md，本 skill 指过去不重复。
disable-model-invocation: true
---

# ACP Agent 会话（session）子系统 全景上下文地图

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
> **协议层（SDK 类型约定、入站方法、MCP、沙盒路径策略、agent 预设）已有权威文档 `apps/editor/src/renderer/services/acp/CLAUDE.md`（含套路 ACP-A~F + 10 条易踩坑），本 skill 不重复，遇到那些主题直接去读它。**

## 核心事实（务必先懂）

- **协议层全在 renderer**，main 端只搬字节（`IAcpHostService` spawn 子进程 pump stdio / `IAcpTerminalService` terminal 池）。SDK 类型（`SessionUpdate` / `ContentBlock` / `ToolCallContent` …）直接出现在 service/UI/测试，**无 alias 层**。
- **双 id 架构（异步化后的关键）**：见 [[async-session-create]] 记忆。
  - `AcpSession.id` = 构造时生成的**本地稳定 uuid**（`generateUuid()`），UI 立即拿到——React key / `activeSessionId` / 运行期缓存（draft cache / widget registry / chat view state）全用它。
  - `AcpSession.sessionIdOnAgent: IObservable<string|undefined>` = **agent 颁发的 durable id**，连接 attach 后才有。history 条目、change tracker（record/changesFor）、active-session 持久化、editor tab serialize、**协议通知路由的源 id** 全用它。
  - `AcpSessionService._findSession(id)` **同时匹配本地 id 与 agent id**，所以 getById/setActive/closeSession/通知分发对调用方透明，传哪个都行。
  - **resume 出来的会话**：`id === entry.sessionIdOnAgent`（两者相等，因为 resume 直接用 durable id 当 id）。
- **createSession 异步、立即返回**：同步建好 `AcpSession` + 发布 observable → UI 立即可输入；spawn+initialize+session/new 在后台 `_connectSession` 跑，完成后 `session.attachConnection(conn, agentId)`。连接前用户发的 prompt 入 `_queuedPrompts`，attach 后自动 flush。失败走 `failConnection`（status `errored` + `[error]` 消息，**不再 reject**）。状态机：`connecting`→attach→`idle`，或→`errored`。
- **16ms 防抖事务**：`applyUpdate` 内 messages/toolCalls/plan/timeline 共用一个 `transaction()`，避免每个流式 chunk 触发一次 React 重渲染。新增更新类别要进同一事务。
- **timeline 是 UI 的唯一真相**：`timeline` observable 按到达顺序交织 message/tool_call slot（plan 不进 timeline，单列 `plan` observable）。三个 lane observable（messages/toolCalls/plan）保留作 selector 读。

## 文件地图

### Service 层 `apps/editor/src/renderer/services/acp/`

| 文件 | 职责 | 何时改 |
|---|---|---|
| `acpSessionService.ts` | 多会话 facade：`sessions`/`activeSession`/`activeSessionId` observable + `IAcpClientNotificationSink` 分发（onSessionUpdate/onRequestPermission/onAskUserQuestion/onExtNotification）+ createSession/`_connectSession`/resumeSession/closeSession + `_findSession` | 会话生命周期、路由、active 切换、持久化 active id |
| `acpSession.ts` | `AcpSession` view-model：全部 observable + `applyUpdate` 状态机 + 双 id + prompt 队列 + `attachConnection`/`failConnection`/`whenConnected` + 标题派生 + usage/cost 提取 + 计时段累计 | 消息/工具/计划/状态/usage 行为、连接生命周期 |
| `acpSessionConfigOptions.ts` | `ConfigOptionStateMachine`：configOptions observable + echo 抑制 + `setConfigOption` 推送 + 持久化分支（注入 `AcpSession`，连接前 `getConn()` 返回 undefined 时静默 no-op） | 配置项（model/mode/thought-level）同步 |
| `acpSessionRestoreCoordinator.ts` | 启动/workspace-swap 恢复 + `session/list` 扫描 + `session/delete` 转发 + `_pendingRestoreHistoryId` | 恢复时序、跨 workspace 重连 |
| `acpClientService.ts` | 进程启动 + SDK `ClientSideConnection` 装配 + **refcount 连接池**（按 agentId+cwd 租用）+ fs/terminal/permission 网关 | 连接建立、池化、入站方法（见 CLAUDE.md 套路 ACP-C） |
| `acpAgentRegistry.ts` | 内置 agent 预设 + `acp.agents` 合并 + PATH 探测 + `runAsNode` 可信标志 | 加 agent（见 CLAUDE.md 套路 ACP-A） |
| `acpSessionHistory.ts` | 会话元数据落盘（`PersistedStateBase`，`MAX_ENTRIES=100`，键 `sessionIdOnAgent`） | 历史字段（套路 ACP-E） |
| `acpAgentDefaultsService.ts` | 每 agent configOption 默认值（`PersistedStateBase`） | 配置项默认值持久化 |
| `acpSessionEditorInput.ts` | `EditorInput` 子类——会话即编辑器 tab，可序列化恢复（serialize 写 `sessionIdOnAgent ?? 本地id`） | 全屏 tab 行为、重启恢复 |
| `acpSessionTitleService.ts` / `acpSessionTitle.ts` / `sessionTitleFormat.ts` | 标题自动生成（AI purpose `session-title`）+ 解析/截断/格式化 | 标题逻辑 |
| `acpChatLocationService.ts` | **单一真相**：Chat 渲染在 EditorArea（全屏 tab）还是 SecondarySideBar（停靠面板）。三向同步 + ContextKey | 双模式切换 |
| `acpChatWidgetService.ts` | 已挂载 ChatBody 的 registry：DOM 容器 + moveTimeline/focusInput 回调 + `lastFocusedWidget`（命令定向） | 多实例聚焦/定向命令 |
| `sessionChangeTracker.ts` | 每会话整文件改动追踪（逆推 baseline，键 `sessionIdOnAgent`） | 会话级 diff（见 [[session-diff-feature]]） |
| `acpPermissionHandler.ts` | 自动批准 + Memory 持久化（套路 ACP-D） | 权限策略 |
| `acpPathPolicy.ts` / `acpMcpServers.ts` / `sdkHostStream.ts` / `promptMentions.ts` / `markdownRenderer.ts` / `mentionFileSearch.ts` / `persistedStateBase.ts` / `acpProtocolTracer.ts` / `ansi.ts` / `filePathLink.ts` / `chatFindMatcher.ts` / `commandWrapper.ts` | 沙盒/MCP/流适配/@提及/markdown/文件搜索/持久化基类/协议 trace/ANSI/文件链接/查找/命令包裹 | 见各自头注释或 CLAUDE.md |
| `acpPromptDraftCache.ts` / `acpQuestionDraftCache.ts` / `acpChatViewStateCache.ts` | 草稿/问题答案/视图态缓存（按**本地 id** 缓存） | 草稿持久、折叠态 |
| `acpSessionFilterService.ts` / `acpSessionStatus.ts` / `acpAuthError.ts` / `agentIconData.ts` / `agentNotificationIcon.ts` | 列表过滤/状态枚举/auth 错误判定/图标 | — |
| `testing/inMemoryAcpPair.ts` | 测试用真 `ClientSideConnection` ↔ 桩 `Agent` 对联 | 写协议级测试 |

### UI 层 `apps/editor/src/renderer/workbench/agents/`

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

### 跨进程 / 命令 / contributions

- **main**：`src/main/services/acpHost/`（spawn + pump stdio/exit）、`src/main/services/acpTerminal/`（terminal 池）
- **shared ipc**：`src/shared/ipc/acpHostService.ts`（start/writeStdin/stop/probe）、`acpTerminalService.ts`（create/output/waitForExit/kill/release）。**无 endStdin，关流走 stop**。
- **命令**：`src/renderer/actions/agentActions.ts`——42 个 Action2（NewAgentSession / CancelAgentTurn / OpenAgentInEditor / ToggleAgentChatLocation / SelectAgent[Model|Mode|ThoughtLevel] / ResumeAgentSession / ClearAgentSessionHistory / 大量 timeline 导航/滚动/折叠 Action / ShowAcpSessionChanges …）。加命令走 `apps/editor/CLAUDE.md` 套路 A，在 `actions/index.ts` 注册。
- **contributions**：`AcpInitContribution`（启动 hydrate）/ `AgentBinaryPrefetchContribution` / `AgentFontContribution` / `AgentNotificationContribution` / `AgentsContributions`（config schema + view 注册）/ `FirstRunAgentOnboardingContribution` / `SessionShutdownParticipant`（退出时优雅关闭）。

## 数据流（速记，细节见 CLAUDE.md）

**出站**：`PromptInput` → `AcpSessionService.sendPrompt(text, mentions)` → `composePromptBlocks()` 转 @文件为 resource_link → `AcpSession._appendMessage('user')`（立即上屏）→ 未连接则入 `_queuedPrompts`，已连接则 `_dispatchPrompt` → `conn.prompt({ sessionId: sessionIdOnAgent, prompt })`。

**入站**：`IAcpHostService.onStdout` → `sdkHostStream` → SDK 回调 → `AcpSessionService.onSessionUpdate` → `_findSession(params.sessionId)`（用 agent id 匹配）→ `AcpSession.applyUpdate` switch（8 种 SessionUpdate，进 16ms 事务；`config_option_update` delegate 到 state machine 做 echo 抑制）。

## 常见任务 → 改哪里

- **加一种 SessionUpdate 类型**：`acpSession.ts` 的 `applyUpdate()` switch 加 case + 进 16ms `transaction` + 新 view-model 挂 `AcpSession` 上（不挂 SDK 类型）。详见 CLAUDE.md 套路 ACP-B。
- **改会话生命周期/连接时序**：`acpSessionService.ts` 的 `createSession`/`_connectSession`/`resumeSession`；连接绑定/队列 flush 在 `acpSession.ts` 的 `attachConnection`/`failConnection`。**任何「连接前/后」分支都要想清双 id 与队列**。
- **加附加于会话的能力**（如新 indicator / 新追踪）：view-model 字段加在 `acpSession.ts`（observable），UI 在 `workbench/agents/*` 用 `useObservable` 订阅。**注意键用 `sessionIdOnAgent` 还是本地 `id`**——跨会话持久/协议相关用前者，纯运行期 UI 缓存用后者（见下方坑 #2）。
- **改双模式布局**：`acpChatLocationService.ts`（真相 + ContextKey）+ `AgentsView.tsx`（分支）+ 命令 `ToggleAgentChatLocationAction`。
- **卡片折叠有两层，别混**：①**外层卡片折叠**（整个 message/tool_call slot 收起）走 `timelineCollapse.ts` 的 `overrides` + `session.collapseMode`，持久化进 `AcpChatViewStateCache.collapse`；②**内层内容折叠**（长用户消息过 `COLLAPSED_MAX_PX` 夹高 / execute 终端输出过高时的 "Expand/Collapse" 按钮）是叶子组件 `UserMessageItem`/`TerminalOutput` 的展开态。内层态历史上是组件本地 `useState`，切 session/切 tab/虚拟化滚屏（卸载重挂载）即丢——修法：`chatContentExpansion.tsx`（context store `{expandedKeys, toggle}`）由 `ChatBody` 提供并折进 `AcpChatViewStateCache.contentExpandedKeys` 持久化；叶子按稳定 `contentKey` 读写（用户消息 `msg:<slotKey>`、终端 `term:<stickyKey>`），无 store/key 时退回本地 state（如 `ToolCallList` 独立用法）。context 消费者随 store 变化自动重渲染，绕过 `TimelineSlot` 的 memo，无需改 memo。
- **加配置项交互**：`acpSessionConfigOptions.ts`（推送/echo）+ `ConfigOptionsBar.tsx`（UI）+ `acpAgentDefaultsService.ts`（默认值持久化）。
- **改恢复/重连**：`acpSessionRestoreCoordinator.ts` + `acpSessionEditorInput.ts`（tab 序列化）+ `acpSessionHistory.ts`（条目）。
- **claude 会话跨 compact 边界的历史回放在 fork 侧解决，编辑器零改动**：SDK `getSessionMessages` 只沿 `parentUuid` 走「有效上下文链」，compact_boundary 的 `parentUuid` 为 null（显示序前驱存在 `logicalParentUuid`，SDK 不追），所以 loadSession 重放天然丢压缩前历史。修法在 `vendor/claude-agent-acp` 的 `replaySessionHistory`：读原始转录 jsonl，`rebuildTranscriptDisplayChain` 从最新叶子沿 `parentUuid ?? logicalParentUuid` 回溯重建显示链（**链走法而非文件序**——CLI 建的会话可能含被放弃的 rewind 分支），边界处发一条 `_universe/compaction` `phase:'success'` 通知（编辑器 `applyCompaction` 对孤立 success 走 idx===-1 分支直接落一张已完成卡片），跳过 `isCompactSummary` 消息；转录缺失/无边界时回退 `getSessionMessages`，未压缩会话路径不变。模型上下文不受影响（仍 `resume: sessionId`）；rewind 无需改（压缩前锚点 → `messageUuidBefore` undefined → 全会话 resume + 磁盘截断恰好正确）。
- **加 agent / 改权限 / MCP / 沙盒 / 入站方法**：直接看 CLAUDE.md 套路 ACP-A/D/F/C。
- **`@@`/`@#` 触发 SimpleFileDialog 选文件/文件夹作为 @提及**：纯函数 `promptMentions.ts` 的 `detectFilePickerTrigger(text, caret)` 识别刚敲下的 `@@`(file)/`@#`(folder)，边界规则同 `extractMentionQuery`（`@` 须在行首或空白后，光标须紧跟两字符）；`PromptInput.tsx` 的 textarea `onChange` 里拦截该触发 → 剥掉两字符 → 走 `IFileDialogService.showOpenDialog`（file: canSelectFiles / folder: canSelectFolders）→ 选中后 `toMentionName(uri, workspaceRoot)` + `mergeMention` 复用既有 @提及管线（发送时 `composePromptBlocks` 序列化成 `resource_link`）。取消则只留剥除触发后的文本。测试 stub 需注册 `IFileDialogService`。
- **把 editor 选区作为上下文推给 input**（"Add Selection to Agent Chat"，Cursor Ctrl+L 式）：`promptContext.ts`（`SelectionContext` 类型 + `composeContextBlocks`：embeddedContext→`EmbeddedResource`，否则降级围栏文本块）+ `acpSession.ts`（`sendPrompt`/`_dispatchPrompt` 第三参 `contexts`，attach 时缓存 `_embeddedContextSupported`，context block 置于 prompt 前）+ `acpSessionConnection.ts`（`QueuedPrompt`/`enqueue` 带 contexts）+ 命令 `actions/agentContextActions.ts`（`FileEditorRegistry.get(activeEditor).getSelections()` 取多选区）+ UI `SelectionContextChips.tsx` + `PromptInput.tsx`（contexts state/持久化/reveal）+ 右键菜单走 Monaco `editor.addAction`（FileEditor.tsx，Monaco 自带右键菜单**不读**我们的 MenuRegistry）。draft cache 加 `contexts` 字段，按**本地 id** 缓存（未发送草稿）。
  - **路由关键坑**：命令**不能直接调** `widget.addSelectionContext`——用户在文件编辑器里选文本时，目标 session 的 ChatBody 常常**没挂载**（editor 模式 session tab 没打开，或刚 `createSession` 还没渲染），widget 为 undefined 会静默丢弃。正解：`acpPromptContextInbox.ts`（模块单例收件箱，按**本地 session id** 存 + `onDidDeposit` 事件）。命令流程：定位/创建目标 session（activeSession 否则 createSession）→ `deposit(session.id, contexts)` → 打开并聚焦该 chat（editor 模式 openEditor AcpSessionEditorInput / sidebar 模式 openViewContainer + `focusSessionInput`）。PromptInput 挂载时 `drain` + 订阅 `onDidDeposit` 即时消费，跨「未挂载→挂载」不丢。

## 关键架构决策与「为什么」

- **双 id 解耦**：本地 uuid 让 UI 在握手（1-5s）完成前就渲染并接受输入；durable agent id 用于一切需要跨重启/跨进程稳定的引用。`_findSession` 双匹配让调用方无需关心当前是哪种。见 [[async-session-create]]。
- **prompt 队列而非禁用输入**：连接中用户照常输入，attach 后自动发——「无缝」体验的核心，用户选定的取舍。
- **timeline 单一真相 + 三 lane 副本**：UI 只读 timeline 保证顺序正确；lane observable 给需要按类型读的 selector。
- **16ms 防抖事务**：流式 chunk 高频，逐条 set 会抖到没法看；合批是性能底线。
- **连接池 refcount**：同 agentId+cwd 的多会话共享一个子进程（如同 cwd 两会话），省 spawn；池在 `acpClientService.ts`。
- **持久化只存字符串元数据**：无 ContentBlock/SessionUpdate 落盘；恢复时拿 `sessionIdOnAgent` 调 `loadSession` 让 agent 重放。双桶 scope（WORKSPACE + GLOBAL fallback）见 CLAUDE.md「持久化」。

## 易踩坑速记

1. **混淆两个 id**：协议路由/history/change-tracker/active 持久化/tab serialize 用 `sessionIdOnAgent`；React key/运行期缓存/`activeSessionId` 用本地 `id`。用错会「消息不路由」或「重启丢会话」。
2. **连接前访问连接相关状态**：握手未完时 `sessionIdOnAgent.get()` 是 undefined、`getConn()` 是 undefined。所有读这些的代码都要 guard。测试里在注入 agent 通知/访问 `client.connected[...]`/断言 seed 状态前**必须 `await session.whenConnected()`**。
3. **`T | null` ≠ `T | undefined`**：SDK 大量字段用 `null`；`exactOptionalPropertyTypes` 下 `null` 不能赋给 `prop?: T`，用 `!= null`。（CLAUDE.md 坑 #1）
4. **新增更新没进 16ms 事务**：会产生抖动/中间态闪烁。
5. **FakeSession stub 漏新接口成员**：`IAcpSession` 加方法（如 `whenConnected`）后，`ConfigOptionsBar.test.tsx` / `PromptInput.test.tsx` / `SessionChangesView.test.tsx` 等的本地 stub 要同步补，否则 typecheck 红。
6. **FakeStorage 启动 fire workspace-swap**：异步 createSession 下，启动期的 `onDidChangeWorkspaceScope` 微任务会触发 `_onWorkspaceSwap` 把刚建、未 attach 的 session close 掉——测试给 service 自身的 storage 要退订该启动事件。见 [[async-session-create]]。
7. **其余 SDK 协议坑**（ToolKind 10 枚举 / setConfigOption 无 type:'select' / void 序列化为 {} / cancel 双步 / terminal ownership / stderr 独立通道 / env denylist / stdio MCP 不带 type）：全在 CLAUDE.md 易踩坑 #2-#10，改协议层前必读。
8. **长 timeline 从底向上滚动抖动**：有两条独立成因，都会让 `scrollTop` 在某个落点上下高频振荡、直到手动拖进度条才停。**(a) 补偿策略太宽**：`ChatBody` 的动态虚拟行从 `estimateRow` 切到真实高度时，TanStack Virtual 默认以 `item.start < scrollOffset` 判断是否补偿，会把顶部半可见行也按完整高度差反向修正 `scrollTop`，与用户向上滚动互相拉扯。修法：`shouldAdjustScrollPositionOnItemSizeChange` 必须只在整行位于视口上方（`item.end <= scrollOffset`）时返回 true（见 `timelineVirtualScroll.ts`）；虚拟模式同时设 `overflow-anchor: none` 避免 Chromium 原生锚定重复补偿；restore / bottom-pin 收敛窗口可临时设 `() => false`，结束后必须恢复自定义策略，不能恢复为 `undefined`（否则退回 TanStack 默认规则）。**(b) 行高每次挂载不稳定（真根因，即使全表高度已重算过仍复发）**：`item.end <= offset` 只是必要条件不是充分条件——若视口上方某行每次重挂载测出的高度都不同，补偿会重挂载它、它又闪回旧高度，形成自持振荡。历史案例是 `TerminalOutput`（execute 卡片）首帧按全高挂载、随后 async 夹到 `COLLAPSED_MAX_PX`，虚拟列表滚回 overscan 时反复重挂载→高度反复翻转。修法在高度源头：用纯函数 `estimateTerminalOverflow(text)` 同步 seed `overflows`，让首帧就提交到最终夹后高度，每次挂载高度一致，不再触发补偿（见 `ToolCallOutput.tsx`）。**任何叶子组件在挂载后异步改变自身高度都可能复现此环**，新增此类组件时首帧高度必须可由数据同步推定。回归测试：`timelineVirtualScroll.test.ts`（预测逻辑）+ e2e `smoke.agentsScrollJitter.spec.ts`（真 `page.mouse.wheel` 打点 `window.__TIMELINE_SIZE_CORRECTIONS_TOTAL__` 证明静止时无自持补偿环——注意合成 `el.scrollTop=x`+dispatch scroll 会重置 `scrollAdjustments` 掩盖该环，必须用真滚轮）。

## 测试套路

- **协议级一律走 `testing/inMemoryAcpPair.ts`**：真 `ClientSideConnection` ↔ 桩 `Agent`，断言 fake agent 方法被调 + 参数对，**不要断言 jsonline 字节**（SDK wire 格式会变）。
- **异步握手**：凡 `createSession` 后要碰连接/通知/history 的，先 `await session.whenConnected()`；resume 路径仍全程 await。
- 主要测试文件（对照扩展）：`AcpSessionService.test.ts`（生命周期/消息/工具/计划/权限分发）、`AcpSessionService.configOptions.test.ts`、`acpSessionConfigOptions.test.ts`（state machine 单测）、`AcpSessionService.resume.test.ts`、`AcpSession.timeline.test.ts`、`AcpSession.poolResume.integration.test.ts`、`acpSessionRestoreCoordinator.test.ts`、`AcpAgentRegistry.test.ts`、`acpPathPolicy.test.ts`、`acpMcpServers.test.ts`、`acpSessionHistory.test.ts`、`sdkHostStream.test.ts`；UI 侧 `workbench/agents/__tests__/*`。

## 验证

```bash
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 涉及交互逻辑改动时跑冒烟，仅截取错误
```

## 关键参考路径

- **权威协议文档**：`apps/editor/src/renderer/services/acp/CLAUDE.md`（套路 ACP-A~F + SDK 10 坑）——协议层任何问题先看它
- `acpSessionService.ts` / `acpSession.ts` / `acpSessionConfigOptions.ts` —— 三层核心（facade / view-model / 配置状态机）
- `acpClientService.ts` —— 连接池 + SDK 装配 + 网关
- `acpSessionRestoreCoordinator.ts` —— 恢复时序
- `workbench/agents/AgentsView.tsx` + `ChatBody.tsx` + `AcpSessionEditor.tsx` —— 双模式 UI 入口
- `actions/agentActions.ts` —— 全部会话命令
- SDK 类型源码：`node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`
- 配置 key：`acp.agents` / `acp.permissions.autoApprove` / `acp.startupTimeoutMs` / `acp.defaultAgentId` / `acp.mcpServers` / `acp.defaultCollapseModes`
- 相关 skill：`ai-settings-subsystem-context`（AI 设置页）、`claude-agent-settings-context` / `codex-agent-settings-context`（各 agent 设置）；`apps/editor/CLAUDE.md` 套路 A/B/C（命令/View/跨进程服务注册）

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件
