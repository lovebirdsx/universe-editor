# cases-session-recovery

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：会话**断连/空闲回收/休眠唤醒/取消恢复/空会话热重连重建**的逐案细节——空闲进程回收、唤醒两档策略、lastActivityAt 防抖动、关窗停 agent、`isDormant` 三符号判定、断连时挂起卡、cancel 恢复三连、`_sendWithRecovery` retrying 残留、CLI usage 记账崩溃的 transient 归类。路由入口见 [CLAUDE.md](CLAUDE.md)「关键架构决策」与「易踩坑速记」。

## 空闲进程回收

`acp.idleProcessTimeoutMs`（默认 5min，<=0 禁用）：与 stall watchdog 同 tick 的 `_reclaimIdleConnections` 按 (agentId,cwd) 分组，**组内全部** session 满足 status∈{idle,errored,closed} + 无进行中的 recovery（`retrying`/`reconnecting`；`exhausted` 是终态、不阻止回收）/pendingElicitation/pendingPermission/compaction/background（`backgroundTaskCount>0`，它独立于 status）+ 静音超时才 `killConnectionFor` 停进程释放内存；但**全 closed 的组跳过**（无活 lease——用户关的交给池 30s 宽限驱逐，已 seal 的池条目已 evict，跳过同时防止静默 seal 组每 tick 重复打点）；可复活约束：非 readOnly 且非 closed 的 session 须 `hasMessages !== false`（否则 `session/resume` 没有可恢复的 transcript）。杀后不碰任何 session 状态——走坑 #11 的静默 seal + 统一唤醒抽象复活，集成测试 `AcpSession.recovery.integration.test.ts` 已覆盖该路径。拿不到 cwd 的 session（未 attach/历史行无 cwd）让**整个 agentId** 本轮跳过——池 key 不能猜。

## 休眠会话的唤醒策略分两档

明确区分「必须唤醒」与「不该唤醒」——为改个标题拉起一个进程会抵消回收本身的意义：

| 档 | 操作 | 为什么 |
|---|---|---|
| **必须唤醒**（用户显式动作，数秒等待可接受） | 列表点击激活/打开、`forkSideTask`、`rewindSession`（含 dryRun）、切 model/mode/thought-level、`requestProcessRestart`、`consumeResetCredit` 兑换额度、`setSessionMcpServers` | 结果依赖 agent 存活：fork 读当前 tip、rewind 走 extMethod、config 是 RPC、restart 要新 spawn env、兑换是用户按了按钮、MCP 生效要 `session/load` |
| **不唤醒** | 订阅用量轮询（`refresh`/`_fetch`/`_tick`）、`renameSession` 的 agent 侧 push、`requestExtMethod` 本体、`resumeSessionReadOnly` 只读预览 | 轮询是心跳不是用户意图；标题走**延迟补推**（`_setHistoryTitle` 无条件写 `_pendingTitle`，`_pushTitleToAgent` 对死 lease 短路，下次 attach 由 `_applyHistoryTitle` 重放）；`requestExtMethod` 的契约注释明确「永不建连」 |

**`forkSession` 是「不唤醒」档的隐藏成员**：它没列进上表，因为它压根不碰源会话的连接——`_forkOnAgent` 自取一把临时租约打 `session/fork`（读磁盘 transcript 切片），源会话保持沉睡。**别给 `forkSession` 加 `_awakeSession`**：`AcpSessionService.test.ts` 的 `forkSession forks a dormant source and leaves it asleep` 守住这条不变量，而时间线末尾的 `ForkTipFooter` 在休眠会话上保持可见正是依赖它（见下节收口点）。

## `lastActivityAt` 防抖动

`_handleConnectionLost` 内 bump `_lastActivityAt`——唤醒是用户活动，成功唤醒的 session 因此拿到完整 idleMs 宽限。若不 bump：唤醒耗时十几秒且期间无 wire 流量 → `lastActivityAt` 陈旧 → 下一 tick（≤60s）就被再杀，用户观感是「点开又睡回去」。不会无限续命（唤醒后无交互，idleMs 后照常回收）；唤醒全程 status 是 `connecting`（recovery.phase 为 `reconnecting`），在 `_isIdleReclaimable` 的 status 过滤处就已排除，reaper 本身无需改。

## 空会话热重连走 `session/new` 原地重建，不照抄「关闭+替换」

症状：改 Sub Agent 模型后点「立即重启」（`requestProcessRestart`），会话反复 `reconnect attempt N/3 … Resource not found`，3 次耗尽 seal 成「Automatic recovery failed」。根因：`_reconnectSession` 原来**无条件** `session/resume`，而空会话（history 行 `hasMessages === false`，从未发过 prompt）在 agent 侧没有 transcript，resume 只能回 `resourceNotFound`。修法（`acpSessionService.ts` 的 `_reconnectSession`）：按共享纯谓词 `isTranscriptlessEmptyRow(entry)`（`acpSessionHistory.ts`，即 `hasMessages === false && sideTaskOf === undefined`）分派到 `session/new` **原地重建**——不照抄 MCP 变更的 `_reloadSessionForMcpChange`「关闭+替换」，后者会关掉用户的 editor tab、清 draft/viewState、换本地 uuid 让 React 重挂载。

重建会换 durable id，连带四处（漏一处就出现「幽灵会话」）：① `acpSessionHistory.rekey(old, new)` 迁行保留全部字段、同时删旧行与目标 id 上的既有行；② `acpSession._priorAgentSessionIds` 别名集合（cap `MAX_PRIOR_AGENT_SESSION_IDS = 4`）+ `reattachConnection(conn, newId)`；③ `acpSessionRegistry.find()` 别名回退、`liveIds()` 带别名（防 refresh-prune 误删）；④ rebuild 分支**不传 `leaseFor`**（否则 terminal 归属绑到即将作废的死 id）。

三条审查踩坑（harness 开关 `freshSessionIdPerConnect` / `resumeSessionError` / `attachSessionErrorOnConnect` 就是为这三条造的）：

1. **side task 是唯一 `hasMessages: false` 但 agent 侧有 transcript 的会话**——`forkSideTask` 在子会话发首条消息前就把父会话完整历史 fork 到 agent 侧了。所以判定必须带 `entry.sideTaskOf === undefined`，否则 rebuild 会静默丢掉 fork 基线，侧边追问失去讨论对象。该谓词是**三个决策的唯一真相**（`isTranscriptlessEmptyRow`），别再各自内联：① 重连分派 rebuild；② MCP 重载分派「关闭+替换」——`_reloadSessionForMcpChange` 曾漏掉 carve-out：空 side task 一改 MCP 就被换成新会话（新 durable id + 新行），丢 `sideTaskOf` / 只读 mode pin / `acp.sideTask.models` 模型 pin，并冒进会话列表；③ `_onResumeFailure` 的静默丢行策略——漏掉则重载失败会把 side task 从父会话「侧边任务」里无声抹掉（agent 权威的 `resourceNotFound` 仍照丢，不受 carve-out 影响）。
2. **重试循环持有的 `sid` 必须随 rekey 一起更新**（`let sid`，rekey 后 `sid = rebuiltSessionId`），否则 attach 抛错后重试用死 id 查 history → `entry === undefined` → 退回 resume 死 id → budget 耗尽。
3. **rekey 必须紧贴 `attachSession` 之前**，中间不能夹任何可能抛错的调用（`setConfigDesired` / `applyInitState` 都挪到 rekey 之前）——否则留下「行在新 id、session 在旧 id」的不一致窗口。

测试全在 `AcpSession.recovery.integration.test.ts`。注意既有那几条「空会话 seal」用例在修复后语义会变，须补前置 `sendPrompt` 让它们继续守护 resume 路径。谓词本身在 `acpSessionHistory.test.ts` 有契约测试；MCP 重载的空 side task 回归在 `AcpSessionService.test.ts` 的 `session MCP selection`，resume 失败策略的两条在 `AcpSessionService.resume.test.ts` 的 failure paths。

## 关窗/退出时停 agent 走 willShutdown join，不靠 beforeunload

agent 子进程 cwd=workspace（app 单例 acpHost spawn），beforeunload 的 fire-and-forget stop 在页面销毁时 IPC 会被丢弃——shell 包装的 agent（cmd.exe→node.exe）残留并把 cwd 钉在 workspace 上，Windows 下文件夹删不掉直到 app 退出。可靠路径：`RendererLifecycleService.confirmShutdown` 跑完整两阶段（veto + onWillShutdown join），`acpClientService` 在 join 里 `Promise.allSettled(liveHandles.map(stop))`，窗口活着时 IPC 通畅；beforeunload 仅作 reload/崩溃兜底。

## `status:'closed'` 有两义，判别式已收口成三个符号，别再自己拼

agent 进程在闲置期退出时，onClose 的 idle 分支只做**静默 seal**（`status='closed'`、无 `[error]`、无 recovery state），phase 仍是 `'connected'`、死 lease 仍绑在 `_conn` 上、session 未 dispose、history 行保留；用户主动 `close()` 则 phase 转 `'closed'` 且 session dispose，绝不该被复活。三个符号**一套判定不留两份**：

- **`isDormant: IObservable<boolean>`**（`acpSession.ts`）——「被空闲回收的可唤醒休眠态」。**刻意是显式设置观察量而非 `derived(status,phase)`**：`close()` 里 `status.set('closed')` 早于 `_connection.close()`，而 phase 不是 observable，derived 会在那一帧算出 `true` 且此后**没有任何东西能让它失效** → 永久卡 dormant。置位点只有**三处**（`onClose` 静默 seal 分支 → true；`attachConnection` open 成功 → false；`close()` → false）+ `_handleConnectionLost` 内清零，改动时务必保持齐全（有专门用例守护）。不覆盖 `phase==='failed'`（恢复耗尽时 `status==='errored'`，门槛本来就放行，UI 已有 RecoveryBar + Retry）。**`onClose` 的 `deadOnArrival` 参数不可省**：`attachConnection` 里 `_connection.open()` 先把 phase 翻到 `'connected'`，之后才发现 lease 到手即死，所以「启动失败 vs 空闲回收」**无法**靠 phase 区分——只能由那一处同步调用显式告知，否则从未启动成功的会话会挂上月亮图标和「已休眠以节省内存」提示。该分支同时要 reject `open()` 已排空的 `drained` 队列，不然 `sendPrompt` 的 await 永久挂起。**abort 监听必须包一层 `() => onClose()`**：直接把 `onClose` 交给 `addEventListener` 会让 `Event` 对象落进 `deadOnArrival`（真值），于是**每一次真实空闲回收**都不再置 dormant。**扩展「首参会被塞 Event」这类监听签名前，须普查所有 `addEventListener` 注册点**（同类陷阱不限于 `onClose`）。
- **`_wakeIfDormant()`**（私有，命令式）——死连接检测的**唯一实现**，`sendPrompt` 原先那段守卫已重构成对它的一次调用。命令式读 phase 是安全的（调用时求值），所以它保留比 `isDormant` 更宽的 `phase==='failed'` 分支。命中即 `_handleConnectionLost('wake')`，**复用既有 `onDidLoseConnection → _wireRecovery → _reconnectSession` 通道，不开第二条重连路径**。
- **`ensureAwake(): Promise<'ready'|'connecting'|'closed'|'failed'>`**（公开，等待版）——显式用户操作的入口。四值不可合并：`'connecting'` 必须与 `'ready'` 区分，因为**初始握手期绝不能 await**（`setConfigOption` 的「连接前本地乐观应用 + 待推」是刻意路径，await 全握手会让配置栏点击阻塞十几秒）；`'failed'` 与 `'closed'` 区分是前者要抛错让调用方 notify、后者静默。facade 侧包了一层 `_awakeSession(sessionId)`（不存在/只读预览/已 close/唤醒失败一律返回 undefined）。

散落的 `status==='closed'` **语义**判定（「这实例还能用吗」）一律改读 **`isResidentLive`**（`acpSessionStatus.ts`）：`resumeSession`（根治「休眠 session 被判死 → 再建一个实例 → 双实例共存 → 通知路由打在幽灵上」）、`resumeSessionReadOnly`、`renameSession`、`setSessionMcpServers`、`SessionListBody` 的行判定与 `onActivate`。**React 侧传不了 reader**，改成并列订阅两个 observable：`SessionListBody` 的 `LiveSessionStatus`（休眠照常出月亮图标）、时间线末尾的 `ForkTipFooter`（把「回合已落定」判成 `status==='idle' || (status==='closed' && isDormant)`——fork 走自己的临时租约读磁盘 transcript，不需要源进程，所以休眠时按钮照常可点）。**只订阅 `status` 会漏掉「关闭一个休眠会话」那一次翻转**：`close()` 先清 `_dormant` 再置 `status`，而 status 本已是 `'closed'`。

**`setConfigOption` 必须保留同步快路径**（曾在此翻车）：`_wakeIfDormant()` 后若非 `_reconnecting` 就**直接同步委托状态机**，只有真要等重连时才 `await ensureAwake()`。把整个方法体放到 await 之后会把状态机的「乐观本地应用 + 同 id echo 抑制门」推到微任务之后，同一 tick 抵达的 `config_option_update` 会覆盖用户刚选的值——`AcpSessionService.configOptions.test.ts` 的两个 echo 用例就是这条不变量的守卫。**该方法新增的 throw 必须由消费方 catch + notify**（`ConfigOptionsBar.tsx:541` 的 `pickConfigValue` try/catch → `agent.configOption.failed` 通知；`agentModelActions.ts` 同款），否则调用点的 `void pickConfigValue(...)` 会变成静默回滚。

改恢复逻辑时另外两点：① `retryRecovery` 的 `_failedPrompt` 分支有同构死连接检测（置 `_turnInterrupted=true` 必须在 `_handleConnectionLost` 调用**之后**，否则被其 `_inFlight.size>0` 覆写）；② `_reconnectingSessions` 去重会吞 reattach 收尾窗口内的二次断连事件，靠 `_reconnectSession` finally 的 `isReconnecting` 复查补跑，别删（复查时把 `'wake'` 折叠回 `'crash'` 对 wake 无害——无需 pool eviction）。UI 侧 `'wake'` 只是 `RecoveryBar` 多一条文案分支（唤醒中 `status='connecting'` + `recovery.phase='reconnecting'`，现有条自动渲染）。回归测试：`AcpSession.recovery.integration.test.ts`（8 个休眠用例）。

## 断连时挂起的提问/权限卡会改变重连衔接文案

`_handleConnectionLost` 在 `_cancelPending()` 之前把「当时有无 pending elicitation/permission」记进 `_interruptedWithPendingInteraction`（cancel 之后两个 observable 已读不出）；`continueInterruptedTurn` 的"已输出"分支据此选择文案——有挂起卡发 `recoveryContinuePromptText()`（引导语：告知 agent 提问是被中断取消、非用户跳过，请重新提问），否则发裸 `CONTINUE_PROMPT_TEXT`（'继续'）。裸"继续"在挂起卡场景会被 agent 误解为"用户跳过问题"（AskUserQuestion 被跳过后 agent 直接执行计划的事故根因）。引导语走 `localize`（调用时求值，不能做成模块顶层常量——import 时 NLS 可能未 configure）；上屏文案 = wire 文案，保持透明。卡片生命周期无需特判：agent 重新提问经 `presentElicitation` 自然顶掉旧卡。

## cancel 恢复三连（对齐 CLI：停止后输入回框、timeline 无痕、重开不复活）

`cancelTurn`（restorePrompt 默认 on，rewind 传 false）做三件事——fire `onDidCancelForRestore`（`PromptInput` 从 `acpPromptCancelledDraftStash` 恢复草稿，stash 在 submit 时存、全部正常完成才 clear）、`_retractLastDispatchedUserMessage()` 把刚发的 user 消息撤出 `_messages`/`_timeline`（last-wins，多并发只撤最后 dispatch 的）、把撤回 id 持久化到 history 行 `retractedMessageIds`。**三连只在零输出 turn 生效**：`_agentOutputCount`（只计可见输出 agent_message/thought_chunk/tool_call(_update)/plan，usage/config 等元数据不算）对 dispatch 时的 `outputBaseline` 一不等，取消即按**正常中断**处理——user 消息与部分输出都留在 timeline，不恢复草稿、不持久化撤回（哪怕只流出了一个字符）。**撤回只改本地内存态，agent 磁盘 transcript 仍在**（SDK 上下文一致性，不能删）——所以 resume 重放靠 `_resumeSessionInner` 的 `setRetractedMessageIds(entry.retractedMessageIds)` 在 `applyUpdate` 的 `user_message_chunk` 分支按 `readMessageId` 过滤；SDK 写在撤回消息后的 `[Request interrupted by user]` 标记（独立 user 消息、另一个 uuid）由一次性 `_skipInterruptedMarker` 标志连带跳过（**只消费下一个 user chunk**）。SDK 在 resume 以中断标记结尾的会话时还会为满足 API 角色交替往 transcript 追加一条 `<synthetic>` 占位 assistant 行（text `No response requested.`，写入发生在 resume 当时、replay 之后，故 live 不见、下次重开才冒出）——claude fork `isSyntheticNoResponseMessage` 在 replay 循环过滤（同 `isSyntheticLoginMessage` 先例），编辑器零改动。正常中断场景该标记在 transcript 里位于部分输出之后、不在撤回列表里，重放时作为中断痕迹显示；live 流**不会**推送这条标记，所以 `cancelTurn` 在正常中断分支用 `_appendMessage('user', INTERRUPTED_MARKER_TEXT)` 本地补一条，保证 live 与 resume 看到的时间线一致。**codex 侧的对齐在 fork**：rollout 把中断落成 `<turn_aborted>` 合成 user response_item 但 thread/resume 不重建，fork `streamThreadHistory` 对 `status === "interrupted"` 的 turn 在 items 末尾补同款文本的 user chunk（无 messageId）；fork 不再推 `*Conversation interrupted*`（否则零输出取消后孤儿化、正常中断时与本地标记重复）。注意 codex 被中断 turn 的**部分输出不落 rollout**，resume 只能恢复「用户消息 + 中断标记」，恢复不出半截回答。**replay 合并锚点**：`_appendChunk` 的流式合并要求 `last.messageId === messageId`（双 undefined 视为相等，agent/thought chunk 恒走此路不受影响）——否则重放里相邻的两条 user 消息（如无锚点的中断标记 + 带 clientId 的重发 prompt，中间被过滤的 chunk 拿走后变成相邻）会融合成一张卡片。

## `_sendWithRecovery` 返回时 `recovery` 绝不停留在 `phase:'retrying'`

RecoveryBar 只渲染当前 state，倒计时定时器 fire 完就没人再推进它；残留的 `retrying` 会永久转圈且没有 Retry 按钮（症状指纹：状态条卡在「Agent temporarily unavailable. Retrying… (2/3)」、倒计时归零后文案不再变，只能手动点 ×）。收尾责任按出口各自负责、**刻意不用统一 finally**（`agent_crash` 分支把 recovery 交棒给 reconnect tier，统一 finally 会误标成 exhausted）：成功 → clear；abort 分支（`AcpAbortError`）→ clear；退避 sleep 被打断的 catch → clear（这两处都在 `!this._reconnecting` 守卫内——Stop/× 是取消不是失败，不给 manual-retry 条）；`agent_crash` → 交棒 `_handleConnectionLost` 覆盖成 `reconnecting`、**勿收尾**；终止分支 → `!this._reconnecting && (attempt > 1 || budget !== undefined)` 写 `exhausted` + `_failedPrompt`（`budget` 由 `retryBudgetFor(verdict.cls)` 单点求值，`reason` 走 `retryReason(verdict)`：限流固定成 `'rate_limited'` 这个稳定 token，其余用 `verdict.kind ?? verdict.cls`）——非可重试类的 fatal/quota/auth 在「重试后的下一次尝试」收场也要落 exhausted，否则残留 retrying。配套约定：**看门狗豁免只认 `recovery.hasPending`**（有真实定时器），不认「有 state」——残留 retrying 无定时器必须回落 stall watchdog；**idle reaper 只豁免进行中的 recovery**（`retrying`/`reconnecting`），`exhausted` 是终态不阻止回收，否则 fatal/quota/auth 终态会让 agent 进程永远不被空闲回收（等于用内存不释放换状态残留）。

## claude CLI usage 记账崩溃：按 message 文本归类 transient 自动续跑

**现象**：claude-code 会话在 turn 尾报 `Internal error: undefined is not an object (evaluating 'e.includes')`（2026-08 现场多次），一个几分钟到几十分钟的 turn 被整体作废。

**根因链**（本地已复现）：claude CLI 二进制（bun/JSC 编译，多个近期版本均未修，上游 issue anthropics/claude-code#74059 至今 stale）的 usage 记账路径，对**缺 `model` 字段**的上游 usage 条目做 `includes` 判定、无 undefined 守卫 → TypeError。崩点在 message_stop 记账时，**turn 的工作已全部落盘**；CLI catch 后以 is_error result 结束 turn，fork 原样转发成 internalError（`errorKind` 为 unknown 或缺失）。**编辑器与 fork 都不在数据路径上**，改不了传输内容，所以只能按症状归类恢复。

**编辑器侧修法**：`apps/editor/src/renderer/services/acp/session/acpErrorClassify.ts` 的 `CLI_USAGE_ACCOUNTING_CRASH_TEXT` 按 message 文本识别（JSC 与 V8 两种措辞、任意 minified 标识符）→ 归类 `transient` + kind `cli_usage_accounting_crash` → `_sendWithRecovery` 自动发「继续」续跑，不再 fatal。

**最小复现**：mock Anthropic SSE 端点，让 usage 里出现缺 `model` 的条目（如 `advisor_message`）即复现一字不差的错误。须用 `CLAUDE_CONFIG_DIR` 隔离配置——`--settings '{}'` 屏蔽不了 `~/.claude/settings.json` 里的 env。

## 限流（429）走独立重试档：分钟级预算、单跳 60s 封顶

**现象**：codex 会话跑到一半被 429 打断后彻底报废。现场（rollout `01a11af8-…`，由 universe-editor 驱动）：7 个 turn 有 5 个以 `exceeded retry limit, last status: 429 Too Many Requests` 结束；turn1 跑 16 分钟被 429 打断后，编辑器 2.2 秒发出的「继续」把这一轮救了回来（说明自动重试本身有效），而 turn3 跑 31 分钟被打断后，连续 4 次重试全在 1–13 秒内再撞 429——限流窗口 ≥90 秒，10 秒的预算撑不过去。

**根因链**：codex Rust 层自己的重试（`request_max_retries` / `stream_max_retries`）退避近乎为零，**1–3 秒就耗尽** → 终态 `error` 通知（fork 先发一条错误文本 chunk，再抛 `RequestError.internalError({ message, codexErrorInfo })`）→ 编辑器 `classifyAcpError` 当时把 429 与 5xx 一起归 `transient` → `_sendWithRecovery` 的通用档只有 3 次尝试 / 2s+8s。claude 之所以稳，是因为它的 CLI 二进制内部自带分钟级重试（读 `retry-after`、指数退避、断流续写），codex 侧没有等价物——**能等的那一层只能是编辑器**。

**编辑器侧修法**（分类 / 预算 / UI 三处）：

- **分类**：新增 `rate_limited` 一类——codex 结构化 429（`httpConnectionFailed` / `responseStreamConnectionFailed` / `responseStreamDisconnected` / `responseTooManyFailedAttempts` 任一带 `httpStatusCode: 429`）、字符串 `rateLimitExceeded`、claude `errorKind: 'rate_limit'`、文本兜底 `\b429\b|\brate[ _-]?limit|too many requests`。`overloaded`（529）刻意留在 `transient`：上游忙是短时现象，长窗口语义只给限流。文本兜底**同时看 `data.message`**（见下条「错误文案」）：`codexErrorInfo` 是可选字段，省略时结构化分支什么都拿不到，只读 SDK 的 `Internal error` 会把 429 判成 fatal，一分钟预算都不会给。
- **文本正则要收紧**：限流档现在是「误判一次白等 5 分钟」，所以 `RATE_LIMIT_TEXT` 写 `\brate[ _-]?limit` 而不是 `rate.?limit`——后者的 `.` 匹配任意字符，且少了前导词界，`moderate limitation` 里就藏着 `rate limit`。前导 `\b` 是承重的，尾界则**不能**加（会连 `rate-limited`/`rate limited` 一起漏掉）。
- **QUOTA 必须排在限流之前判定**（`QUOTA_TEXT` → `RATE_LIMIT_TEXT` → `TRANSIENT_TEXT` 的顺序即优先级）：真实 429 报文常同时含 `quota`/`usage limit`/`credits`，额度耗尽不可重试，误判成限流会白等 5 分钟。结构化数据永远优先于文本，所以 codex `usageLimitExceeded`、claude `billing_error` 不受这个顺序影响。
- **预算**（`acpSessionRecovery.ts` 的 `retryBudgetFor`）：限流 8 次尝试、退避 `5/15/30/60×4`（累计 290s ≈ 5 分钟）；其余 transient 保持 3 次 / 2s+8s。**单跳封顶 60s**——状态条只有一行倒计时，两分钟不变的数会被读成卡死；限流窗口按上游自己的节奏放开，买次数比拉长单跳划算。**封顶必须在 jitter 之后**（`Math.min(jittered, base)`）：先封顶再抖动会让末档实际最长 75s，与文案承诺的「单次最多 1 分钟」不符，而表值一旦是硬上限，抖动就只能把某一跳提前——它的目的是打散重试时刻，不是拉长等待。
- **`MAX_RECOVERY_ATTEMPTS` 仍是重连档的预算**，别跟着改长（`_reconnectSession` 与 `sealRecoveryFailure` 共用它）。
- **终止分支的判定**从 `verdict.cls === 'transient'` 泛化成 `budget !== undefined`（预算由 `retryBudgetFor(cls)` 单点求值），否则限流重试耗尽后会停在 `retrying`（即本文第 15 条坑）。
- **UI**：`recovery.reason = 'rate_limited'` 是稳定 token（细粒度 kind 只进遥测），RecoveryBar 据此说「模型服务正在限流」而不是通用的「暂时不可用」，耗尽后同样保持限流文案。
- **错误文案**：`formatAcpErrorMessage` 增 `data.message` 兜底——codex 的可读文案在 `RequestError.data.message` 里，而 SDK 自己的 message 恒为 `Internal error`；不兜底的话预算耗尽后用户只看到 `[error] Internal error`。`agent_crash` 分支同样改用它：崩溃是从 `data.details` 认出来的，那行的 message 也只是 `Internal error`，改成拼接后用户才看得到真正的 TypeError。

**为什么不改 fork**：`vendor/codex-acp` 的红线是最小 diff（其 CLAUDE.md 明确要求优先在父项目 `apps/editor` 侧解决）；fork 内部重发同一 turn 会与编辑器重试叠成两层循环，且没有倒计时/取消的 UI 反馈。也评估过抬高 codex Rust 层的 `request_max_retries` / `stream_max_retries`：退避太快，救不了分钟级窗口。

**手动 Retry 会开一整份新预算**：`retryRecovery()` 走一遍全新的 `_sendWithRecovery`，所以限流未解除时连点 Retry 会再安静等一轮（有意为之：用户主动要求再试）。

**已知局限（本次不修）**：退避期间用户又发了一条 prompt，新 turn 会踩掉**上一条** loop 的定时器——成功分支的 `recovery.clear()`（`phase === 'retrying'` 才清）、或它自己失败时 `recovery.sleep()` 开头的 `_cancelTimer()`，两者都拒绝旧 loop 挂着的 sleep，使原来那一轮静默结束（无 `[error]`、无 Retry 条），而它对 `_settleOrphanCompactions` 的收尾还可能落到新 turn 正在跑的压缩卡上。触发条件不是「新 prompt 成功」而是「新 prompt 走到任何碰 recovery 的路径」。`SessionRecovery` 的状态与定时器都是 per-session 单例，彻底修要给 episode 加 owner token，并与重连档共用的原语一起改。**本次改动把这个窗口从 ~8 秒放大到 ~5 分钟**，撞上的概率同步放大——所以这条从「边缘情况」升级成值得排期的一项。

**待核实（未取证）**：claude 的订阅上限（5 小时 / 每周额度）如果也是以 `errorKind: 'rate_limit'` 上报，那撞硬上限的用户会从「10 秒后放弃」变成「安静等 5 分钟」。CLI 自己的文案通常带重置时间（「resets at …」），届时可考虑按文案把这类判成 `quota`；但结构化 kind 优先级高于文本，真要做得先在 `classifyClaudeKind` 里开口子。目前只在 claude CLI 实际输出里确认过 `rate_limit` 用于瞬时限流。

**调参入口**：`acpSessionRecovery.ts` 的 `BACKOFF_MS.rate_limit` 与 `RATE_LIMIT_MAX_ATTEMPTS`。刻意不做成设置项：`AcpSession` 没有 `IConfigurationService`，且一个能设成 30 分钟的旋钮会把「看起来卡住」变成用户自己造成的；将来若要加，可经 `AcpSessionService` 把值快照进 `IAcpSessionInitState`。
