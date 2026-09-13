# apps/editor/src/renderer/services/acp/session/CLAUDE.md

> 本文是 `services/acp/CLAUDE.md` 的子域文档（会话子系统导航 + 案例索引）。协议层全景（SDK 约定 / 入站方法 / MCP / 沙盒 / 跨进程边界 / 套路 ACP-A~F）见 [`../CLAUDE.md`](../CLAUDE.md)，本文引用其章节不再重复。

## 会话子系统（acp-session）

把外部 AI agent（claude-code / codex / …）经 ACP 接入编辑器：多会话管理、流式消息/工具调用/计划渲染、权限交互、配置项、会话恢复、两种渲染布局、会话级 diff/计时/开销。案例拆在 `cases-*.md`（文末索引）。

> ⚠️ **第一原则**：先认领改动落在**哪一层**——① 多会话 facade `AcpSessionService` ② 单会话 view-model `AcpSession` ③ 连接/进程 `AcpClientService` ④ 恢复协调 `AcpSessionRestoreCoordinator` ⑤ 持久化（双桶服务）⑥ UI `workbench/agents/*` ⑦ 命令 `actions/agentActions.ts`。**协议层见 [`../CLAUDE.md`](../CLAUDE.md)。**

### 核心事实（务必先懂）

- **双 id 架构**（见 [[async-session-create]]）：`AcpSession.id` = 构造时生成的**本地稳定 uuid**，UI 立即拿到（React key / `activeSessionId` / 运行期缓存）；`sessionIdOnAgent` = **agent 颁发的 durable id**，attach 后才有（history / change tracker / active 持久化 / tab serialize / 协议通知路由）。解耦目的：UI 在握手（1-5s）完成前就渲染并接受输入。`_findSession(id)` **同时匹配两个 id**；**resume 出来的会话 `id === entry.sessionIdOnAgent`**。
- **createSession 异步、立即返回**：同步建好 `AcpSession` + 发布 observable → UI 立即可输入；spawn+initialize 后台 `_connectSession`，完成后 `attachConnection`。连接前 prompt 入 `_queuedPrompts`，attach 后 flush。失败走 `failConnection`（status `errored` + `[error]` 消息，**不再 reject**）。
- **timeline 是 UI 的唯一真相**：按到达顺序交织 message/tool_call slot（plan 单列）。lane observable（messages/toolCalls/plan）留作 selector 读。
- 16ms 防抖事务、`T | null` ≠ `T | undefined` 等 SDK 约定 → `../CLAUDE.md`。

### 文件地图

#### Service 层（本目录）

- **核心三件套**：`acpSessionService.ts`（多会话 facade：observables + `IAcpClientNotificationSink` 分发 + create/`_connectSession`/resume/close + `_findSession`）、`acpSession.ts`（单会话 view-model：observable 全集 + `applyUpdate` 状态机 + 双 id + prompt 队列 + `attachConnection`/`failConnection`/`whenConnected` + 标题派生 + usage/cost）、`acpSessionConfigOptions.ts`（`ConfigOptionStateMachine`：echo 抑制 + 推送 + 持久化分支）
- **恢复/历史/定位**：`acpSessionRestoreCoordinator.ts`（启动/workspace-swap 恢复 + `session/list` 扫描）、`acpSessionHistory.ts`（`MAX_ENTRIES=100`，键 `sessionIdOnAgent`）、`acpSessionEditorInput.ts`（会话即 editor tab）、`acpChatLocationService.ts`（**单一真相**：Chat 位置）、`acpChatWidgetService.ts`（ChatBody registry + `lastFocusedWidget`）
- **标题/状态**：`acpSessionTitleService.ts` / `acpSessionTitle.ts` / `acpSessionTitleEcho.ts` / `sessionTitleFormat.ts`、`acpSessionStatus.ts` / `acpSessionFilterService.ts` / `acpAuthError.ts`（含共享判定 **`isResidentLive`**——「这实例还该被当成活会话用吗」的唯一真相）
- **改动追踪/附件/草稿**：`sessionChangeTracker.ts`（键 `sessionIdOnAgent`，[[session-diff-feature]]）、`acpMessageAttachmentStore.ts`（已发送消息选区快照）、`acpPromptDraftCache.ts` / `acpQuestionDraftCache.ts` / `acpChatViewStateCache.ts` / `acpPromptCancelledDraftStash.ts`（按**本地 id** 缓存）、`acpPromptHistoryService.ts` / `acpPromptContextInbox.ts` / `acpPromptReplaceInbox.ts` / `acpPromptTextInbox.ts` / `acpElicitationDraftCache.ts`
- **杂项**：`acpSessionConnection` / `acpSessionContent` / `acpSessionCost` / `acpSessionModel` / `acpSessionFactory` / `acpSessionRecovery` / `acpSessionRegistry` / `acpSessionOutlineRegistry` / `acpSessionUpdateMeta` / `acpTimelineOutline` / `acpAgentDefaultsService` / `acpLastSessionCwdService` / `sessionBookmarks` / `sessionBookmarkService` / `acpCompactionStats` / `acpConfigOptionsCache` / `acpAgentCostStrategy` / `acpAuthGuidanceService` / `acpErrors` / `acpErrorClassify` / `acpExtMethods` / `acpAutoResumeGuard` / `acpResidentBudget` / `acpContentLimits` / `modelSwitchContextGuard` / `sessionDiffReconstruct` / `acpSessionProviderContext`（费率归属：`agentId + authority` 复合键，**反查 agent 自己的配置文件**）

#### 同域核心层（上一级）

`acpClientService.ts`（refcount 连接池）、`testing/inMemoryAcpPair.ts`（协议级测试）；其余见 `../CLAUDE.md`「文件归位」。

#### UI 层 `apps/editor/src/renderer/workbench/agents/`

- **布局**：`SessionsView`（按 `acpChatLocationService` 切双布局）、`AcpSessionEditor`、`ChatPanel` / `ChatBody`
- **输入/消息**：`PromptInput` / `SendButton` / `StopButton`、`MessageList` / `MessageContent` / `UserMessageItem` / `CodeBlock`
- **工具/计划**：`ToolCallCard` / `ToolCallOutput` / `CommandInvocationBadge` / `InlineDiffPreview` / `lineDiff`、`PlanView` / `StickyPlanBar` / `StickyUserMessageBar` / `StickyScrollOverlay` / `stickyScroll` / `CompactionCard`
- **卡片/条**：`PermissionCard` / `QuestionCard` / `ElicitationCard`、`ConfigOptionsBar` / `ConfigBarOverflowMenu`、`RecoveryBar` / `ResurrectionCard` / `ForeignSessionPreview` / `SideTasksBar`
- **列表/改动/用量**：`SessionListPanel` / `SessionListBody` / `SessionsPopover` / `SessionsViewToolbar` / `AgentChatContextMenu`、`SessionChangesView` / `sessionChangesViewState`（**用 `sessionIdOnAgent` 查 changesFor**，[[session-diff-feature]]）、`useSessionTimer` / `UsageIndicator` / `SessionCostIndicator` / `useExchangeRate`、`McpServersView` / `McpServerPicker` / `McpEnablementToggles`
- **辅助**：`ChatFindWidget` / `useChatFind`、`timelineCollapse` / `timelineIcons` / `sessionStatusIcon` / `agentIcon`、`chatContentExpansion` / `contentOverflow` / `timelineVirtualScroll`

#### 跨进程 / 命令 / contributions

- **main**：`src/main/services/acpHost/`（spawn + pump stdio/exit）、`src/main/services/acpTerminal/`（terminal 池）。**无 endStdin，关流走 stop**。
- **命令**：`actions/agentActions.ts`——42 个 Action2（NewAgentSession / CancelAgentTurn / ResumeAgentSession / ToggleAgentChatLocation / SelectAgent[Model|Mode|ThoughtLevel] …）。加命令走 `apps/editor/CLAUDE.md` 套路 A。
- **contributions**：`AcpInitContribution`（启动 hydrate）/ `AgentBinaryPrefetchContribution` / `AgentFontContribution` / `AgentNotificationContribution` / `AgentsContributions` / `FirstRunAgentOnboardingContribution` / `SessionShutdownParticipant`（退出时优雅关闭）。

### 数据流（细节见 `../CLAUDE.md`「数据流」）

**出站**：`PromptInput` → `sendPrompt` → `composePromptBlocks()` 转 resource_link → `_appendMessage('user')` → 未连接入 `_queuedPrompts`，已连接 `_dispatchPrompt` → `conn.prompt({ sessionId: sessionIdOnAgent, prompt })`。

**入站**：`onStdout` → `sdkHostStream` → SDK 回调 → `onSessionUpdate` → `_findSession`（用 agent id 匹配）→ `applyUpdate` switch（8 种 SessionUpdate，进 16ms 事务；config_option_update 走 echo 抑制）。

### 常见任务 → 改哪里

- **加一种 SessionUpdate 类型**：`acpSession.ts` 的 `applyUpdate()` switch 加 case + 进 16ms `transaction` + 新 view-model 挂 `AcpSession` 上。详见 `../CLAUDE.md` 套路 ACP-B。
- **改会话生命周期/连接时序**：`acpSessionService.ts` 的 `createSession`/`_connectSession`/`resumeSession`；连接绑定/队列 flush 在 `acpSession.ts` 的 `attachConnection`/`failConnection`。**任何「连接前/后」分支都要想清双 id 与队列**。
- **加附加于会话的能力**（新 indicator / 新追踪）：view-model 字段加在 `acpSession.ts`（observable），UI 用 `useObservable` 订阅。**键用 `sessionIdOnAgent` 还是本地 `id`**——跨会话持久/协议相关用前者，纯运行期 UI 缓存用后者（坑 #1）。
- **改双模式布局**：`acpChatLocationService.ts` + `SessionsView.tsx` + 命令 `ToggleAgentChatLocationAction`。
- **卡片折叠有两层，别混**：外层 slot 收起走 `timelineCollapse.ts`；内层内容折叠走 `chatContentExpansion.tsx`。详见 [cases-session-ui.md](cases-session-ui.md)。
- **加配置项交互**：`acpSessionConfigOptions.ts`（推送/echo）+ `ConfigOptionsBar.tsx` + `acpAgentDefaultsService.ts`。
- **加/改内置 agent skill**（`apps/editor/resources/agent-skills/.claude/skills/<name>/SKILL.md`，**加文件即生效**；默认 `disable-model-invocation: true`）：经 `_builtinAgentDirs()` 在 new/load/resume/fork 四条 wire 路径注入；**remote authority 会话不注入**；打包 `runtime-resources.mjs` 补 `REQUIRED_SOURCE_FILES` sentinel。命名别撞本仓库开发者 skill。
- **改恢复/重连**：`acpSessionRestoreCoordinator.ts` + `acpSessionEditorInput.ts` + `acpSessionHistory.ts`。
- **恢复/回放类坑** → [cases-session-replay.md](cases-session-replay.md)。
- **输入框上下文**（`@@`/`@#` 文件选择、编辑器选区推送、发送后附件快照）→ [cases-prompt-input.md](cases-prompt-input.md)。
- **加 agent / 改权限 / MCP / 沙盒 / 入站方法**：见 `../CLAUDE.md` 套路 ACP-A/D/F/C。

### 关键架构决策与「为什么」

- **prompt 队列而非禁用输入**：连接中用户照常输入，attach 后自动发——「无缝」体验的核心。
- **连接池 refcount**：同 agentId+cwd 的多会话共享一个子进程，省 spawn；池在 `acpClientService.ts`。
- **空闲进程回收 / 休眠唤醒两档 / lastActivityAt 防抖动 / 关窗停 agent 走 willShutdown join**：见 [cases-session-recovery.md](cases-session-recovery.md)。
- **持久化只存字符串元数据**：恢复时拿 `sessionIdOnAgent` 调 `loadSession` 重放。双桶 scope 见 `../CLAUDE.md`「持久化」。

### 易踩坑速记

1. **混淆两个 id**：协议路由/history/change-tracker/active 持久化/tab serialize 用 `sessionIdOnAgent`；React key/运行期缓存用本地 `id`。用错会「消息不路由」或「重启丢会话」。
2. **连接前访问连接相关状态**：握手未完时 `sessionIdOnAgent.get()`/`getConn()` 是 undefined 要 guard；测试 seed/断言前**必须 `await session.whenConnected()`**。
3. **`T | null` ≠ `T | undefined`**——见 `../CLAUDE.md`「SDK 关键约定」#1。
4. **新增更新没进 16ms 事务**：会抖动/中间态闪烁（`../CLAUDE.md` #9）。
5. **FakeSession stub 漏新接口成员**：`IAcpSession` 加方法后各 test 本地 stub 同步补。**加数据字段**（如 `authority`）：`as unknown as` 的 stub 静默读 `undefined`、显式 `implements` 的 typecheck 红；**断言分区行为的测试必须显式给 authority**。
6. **FakeStorage 启动 fire workspace-swap**：启动期 `onDidChangeWorkspaceScope` 微任务会 close 掉刚建未 attach 的 session——测试给 service 自身的 storage 要退订该启动事件。见 [[async-session-create]]。
7. **其余 SDK 协议坑**（ToolKind 枚举 / cancel 双步 / terminal ownership / stderr 独立通道 / env denylist / stdio MCP 不带 type 等）：全在 `../CLAUDE.md`「SDK 关键约定」#2-#10。
8. **会话标题四个写入方，优先级 manual > ai > 首条 prompt 派生 > agent 报告** → [cases-session-ui.md](cases-session-ui.md)。
9. **长 timeline 从底向上滚动抖动**两条成因（补偿策略太宽 + 行高挂载不稳）→ [cases-session-ui.md](cases-session-ui.md)。
10. **第一条用户消息不在 `displayTimeline`**：语义操作用完整 `timeline` → [cases-session-ui.md](cases-session-ui.md)。
11. **`status:'closed'` 有两义**：空闲回收=静默 seal 可唤醒；用户 close=真关闭。判别式收口 `isDormant`/`_wakeIfDormant()`/`ensureAwake()` + `isResidentLive`，**别再自己拼** → [cases-session-recovery.md](cases-session-recovery.md)。
12. **断连时挂起的提问/权限卡会改变重连衔接文案**（有挂起卡发引导语，否则裸「继续」会被 agent 误解为跳过问题）→ [cases-session-recovery.md](cases-session-recovery.md)。
13. **cancel 恢复三连**（输入回框/timeline 无痕/重开不复活）**只在零输出 turn 生效**；撤回只改本地内存，磁盘 transcript 仍在 → [cases-session-recovery.md](cases-session-recovery.md)。
14. **resume 恢复的是 API 裸模型名（丢 `[1m]` → 窗口 1M 退化 200k）**：`resumeModel` 捎原值；切裸行守卫在 `modelSwitchContextGuard.ts` → [cases-session-replay.md](cases-session-replay.md)。
15. **`_sendWithRecovery` 返回时 `recovery` 绝不停留在 `retrying`**（永久转圈无 Retry 按钮）→ [cases-session-recovery.md](cases-session-recovery.md)。

### 测试套路

协议级一律走 `testing/inMemoryAcpPair.ts`（见 `../CLAUDE.md`「测试模式」）。**异步握手**：凡 `createSession` 后要碰连接/通知/history 的，先 `await session.whenConnected()`；resume 路径仍全程 await。主要测试：`AcpSessionService.test.ts`、`acpSessionConfigOptions.test.ts`、`AcpSessionService.resume.test.ts`、`acpSessionRestoreCoordinator.test.ts`；UI 侧 `workbench/agents/__tests__/*`。

### 验证

`pnpm check`（lint + typecheck + test）；涉及交互逻辑改动时 `pnpm e2e`。均只截取错误。

### 关键参考路径

- `acpSessionService.ts` / `acpSession.ts` / `acpSessionConfigOptions.ts`（三层核心）、`acpClientService.ts`（连接池）、`acpSessionRestoreCoordinator.ts`（恢复时序）、`workbench/agents/` + `actions/agentActions.ts`
- SDK 类型源码与配置 key 见 `../CLAUDE.md`；session 特有配置 key：`acp.defaultCollapseModes`

## 案例（从本文件拆出，按需读对应一份）

- **rewind/fork 纵切**：[cases-rewind-fork.md](cases-rewind-fork.md)——SDK 无回退落盘 API 须物理截断磁盘 JSONL、消息锚点、claude/codex 双实现、已修 bug 根因。
- **恢复/回放**：[cases-session-replay.md](cases-session-replay.md)——compact 边界回放、并行 tool_result 掉链、codex thought 分隔符、custom_tool_call、`[1m]` resumeModel、transcriptPath。
- **断连/回收/唤醒/cancel**：[cases-session-recovery.md](cases-session-recovery.md)——空闲回收、唤醒两档、isDormant 三符号、挂起卡衔接文案、cancel 三连、retrying 残留。
- **标题/timeline UI**：[cases-session-ui.md](cases-session-ui.md)。
- **输入框上下文**：[cases-prompt-input.md](cases-prompt-input.md)。
