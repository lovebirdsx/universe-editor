# cases-session-recovery

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：会话**断连/空闲回收/休眠唤醒/取消恢复**的逐案细节——空闲进程回收、唤醒两档策略、lastActivityAt 防抖动、关窗停 agent、`isDormant` 三符号判定、断连时挂起卡、cancel 恢复三连、`_sendWithRecovery` retrying 残留。路由入口见 [CLAUDE.md](CLAUDE.md)「关键架构决策」与「易踩坑速记」。

## 空闲进程回收

`acp.idleProcessTimeoutMs`（默认 5min，<=0 禁用）：与 stall watchdog 同 tick 的 `_reclaimIdleConnections` 按 (agentId,cwd) 分组，**组内全部** session 满足 status∈{idle,errored,closed} + 无进行中的 recovery（`retrying`/`reconnecting`；`exhausted` 是终态、不阻止回收）/pendingElicitation/pendingPermission/compaction/background（`backgroundTaskCount>0`，它独立于 status）+ 静音超时才 `killConnectionFor` 停进程释放内存；但**全 closed 的组跳过**（无活 lease——用户关的交给池 30s 宽限驱逐，已 seal 的池条目已 evict，跳过同时防止静默 seal 组每 tick 重复打点）；可复活约束：非 readOnly 且非 closed 的 session 须 `hasMessages !== false`（否则 `session/resume` 没有可恢复的 transcript）。杀后不碰任何 session 状态——走坑 #11 的静默 seal + 统一唤醒抽象复活，集成测试 `AcpSession.recovery.integration.test.ts` 已覆盖该路径。拿不到 cwd 的 session（未 attach/历史行无 cwd）让**整个 agentId** 本轮跳过——池 key 不能猜。

## 休眠会话的唤醒策略分两档

明确区分「必须唤醒」与「不该唤醒」——为改个标题拉起一个进程会抵消回收本身的意义：

| 档 | 操作 | 为什么 |
|---|---|---|
| **必须唤醒**（用户显式动作，数秒等待可接受） | 列表点击激活/打开、`forkSideTask`、`rewindSession`（含 dryRun）、切 model/mode/thought-level、`requestProcessRestart`、`consumeResetCredit` 兑换额度、`setSessionMcpServers` | 结果依赖 agent 存活：fork 读当前 tip、rewind 走 extMethod、config 是 RPC、restart 要新 spawn env、兑换是用户按了按钮、MCP 生效要 `session/load` |
| **不唤醒** | 订阅用量轮询（`refresh`/`_fetch`/`_tick`）、`renameSession` 的 agent 侧 push、`requestExtMethod` 本体、`resumeSessionReadOnly` 只读预览 | 轮询是心跳不是用户意图；标题走**延迟补推**（`_setHistoryTitle` 无条件写 `_pendingTitle`，`_pushTitleToAgent` 对死 lease 短路，下次 attach 由 `_applyHistoryTitle` 重放）；`requestExtMethod` 的契约注释明确「永不建连」 |

## `lastActivityAt` 防抖动

`_handleConnectionLost` 内 bump `_lastActivityAt`——唤醒是用户活动，成功唤醒的 session 因此拿到完整 idleMs 宽限。若不 bump：唤醒耗时十几秒且期间无 wire 流量 → `lastActivityAt` 陈旧 → 下一 tick（≤60s）就被再杀，用户观感是「点开又睡回去」。不会无限续命（唤醒后无交互，idleMs 后照常回收）；唤醒全程 status 是 `connecting`（recovery.phase 为 `reconnecting`），在 `_isIdleReclaimable` 的 status 过滤处就已排除，reaper 本身无需改。

## 关窗/退出时停 agent 走 willShutdown join，不靠 beforeunload

agent 子进程 cwd=workspace（app 单例 acpHost spawn），beforeunload 的 fire-and-forget stop 在页面销毁时 IPC 会被丢弃——shell 包装的 agent（cmd.exe→node.exe）残留并把 cwd 钉在 workspace 上，Windows 下文件夹删不掉直到 app 退出。可靠路径：`RendererLifecycleService.confirmShutdown` 跑完整两阶段（veto + onWillShutdown join），`acpClientService` 在 join 里 `Promise.allSettled(liveHandles.map(stop))`，窗口活着时 IPC 通畅；beforeunload 仅作 reload/崩溃兜底。

## `status:'closed'` 有两义，判别式已收口成三个符号，别再自己拼

agent 进程在闲置期退出时，onClose 的 idle 分支只做**静默 seal**（`status='closed'`、无 `[error]`、无 recovery state），phase 仍是 `'connected'`、死 lease 仍绑在 `_conn` 上、session 未 dispose、history 行保留；用户主动 `close()` 则 phase 转 `'closed'` 且 session dispose，绝不该被复活。三个符号**一套判定不留两份**：

- **`isDormant: IObservable<boolean>`**（`acpSession.ts`）——「被空闲回收的可唤醒休眠态」。**刻意是显式设置观察量而非 `derived(status,phase)`**：`close()` 里 `status.set('closed')` 早于 `_connection.close()`，而 phase 不是 observable，derived 会在那一帧算出 `true` 且此后**没有任何东西能让它失效** → 永久卡 dormant。置位点只有**三处**（`onClose` 静默 seal 分支 → true；`attachConnection` open 成功 → false；`close()` → false）+ `_handleConnectionLost` 内清零，改动时务必保持齐全（有专门用例守护）。不覆盖 `phase==='failed'`（恢复耗尽时 `status==='errored'`，门槛本来就放行，UI 已有 RecoveryBar + Retry）。**`onClose` 的 `deadOnArrival` 参数不可省**：`attachConnection` 里 `_connection.open()` 先把 phase 翻到 `'connected'`，之后才发现 lease 到手即死，所以「启动失败 vs 空闲回收」**无法**靠 phase 区分——只能由那一处同步调用显式告知，否则从未启动成功的会话会挂上月亮图标和「已休眠以节省内存」提示。该分支同时要 reject `open()` 已排空的 `drained` 队列，不然 `sendPrompt` 的 await 永久挂起。**abort 监听必须包一层 `() => onClose()`**：直接把 `onClose` 交给 `addEventListener` 会让 `Event` 对象落进 `deadOnArrival`（真值），于是**每一次真实空闲回收**都不再置 dormant。
- **`_wakeIfDormant()`**（私有，命令式）——死连接检测的**唯一实现**，`sendPrompt` 原先那段守卫已重构成对它的一次调用。命令式读 phase 是安全的（调用时求值），所以它保留比 `isDormant` 更宽的 `phase==='failed'` 分支。命中即 `_handleConnectionLost('wake')`，**复用既有 `onDidLoseConnection → _wireRecovery → _reconnectSession` 通道，不开第二条重连路径**。
- **`ensureAwake(): Promise<'ready'|'connecting'|'closed'|'failed'>`**（公开，等待版）——显式用户操作的入口。四值不可合并：`'connecting'` 必须与 `'ready'` 区分，因为**初始握手期绝不能 await**（`setConfigOption` 的「连接前本地乐观应用 + 待推」是刻意路径，await 全握手会让配置栏点击阻塞十几秒）；`'failed'` 与 `'closed'` 区分是前者要抛错让调用方 notify、后者静默。facade 侧包了一层 `_awakeSession(sessionId)`（不存在/只读预览/已 close/唤醒失败一律返回 undefined）。

散落的 `status==='closed'` **语义**判定（「这实例还能用吗」）一律改读 **`isResidentLive`**（`acpSessionStatus.ts`）：`resumeSession`（根治「休眠 session 被判死 → 再建一个实例 → 双实例共存 → 通知路由打在幽灵上」）、`resumeSessionReadOnly`、`renameSession`、`setSessionMcpServers`、`SessionListBody` 的行判定与 `onActivate`。

**`setConfigOption` 必须保留同步快路径**（曾在此翻车）：`_wakeIfDormant()` 后若非 `_reconnecting` 就**直接同步委托状态机**，只有真要等重连时才 `await ensureAwake()`。把整个方法体放到 await 之后会把状态机的「乐观本地应用 + 同 id echo 抑制门」推到微任务之后，同一 tick 抵达的 `config_option_update` 会覆盖用户刚选的值——`AcpSessionService.configOptions.test.ts` 的两个 echo 用例就是这条不变量的守卫。

改恢复逻辑时另外两点：① `retryRecovery` 的 `_failedPrompt` 分支有同构死连接检测（置 `_turnInterrupted=true` 必须在 `_handleConnectionLost` 调用**之后**，否则被其 `_inFlight.size>0` 覆写）；② `_reconnectingSessions` 去重会吞 reattach 收尾窗口内的二次断连事件，靠 `_reconnectSession` finally 的 `isReconnecting` 复查补跑，别删（复查时把 `'wake'` 折叠回 `'crash'` 对 wake 无害——无需 pool eviction）。UI 侧 `'wake'` 只是 `RecoveryBar` 多一条文案分支（唤醒中 `status='connecting'` + `recovery.phase='reconnecting'`，现有条自动渲染）。回归测试：`AcpSession.recovery.integration.test.ts`（8 个休眠用例）。

## 断连时挂起的提问/权限卡会改变重连衔接文案

`_handleConnectionLost` 在 `_cancelPending()` 之前把「当时有无 pending elicitation/permission」记进 `_interruptedWithPendingInteraction`（cancel 之后两个 observable 已读不出）；`continueInterruptedTurn` 的"已输出"分支据此选择文案——有挂起卡发 `recoveryContinuePromptText()`（引导语：告知 agent 提问是被中断取消、非用户跳过，请重新提问），否则发裸 `CONTINUE_PROMPT_TEXT`（'继续'）。裸"继续"在挂起卡场景会被 agent 误解为"用户跳过问题"（AskUserQuestion 被跳过后 agent 直接执行计划的事故根因）。引导语走 `localize`（调用时求值，不能做成模块顶层常量——import 时 NLS 可能未 configure）；上屏文案 = wire 文案，保持透明。卡片生命周期无需特判：agent 重新提问经 `presentElicitation` 自然顶掉旧卡。

## cancel 恢复三连（对齐 CLI：停止后输入回框、timeline 无痕、重开不复活）

`cancelTurn`（restorePrompt 默认 on，rewind 传 false）做三件事——fire `onDidCancelForRestore`（`PromptInput` 从 `acpPromptCancelledDraftStash` 恢复草稿，stash 在 submit 时存、全部正常完成才 clear）、`_retractLastDispatchedUserMessage()` 把刚发的 user 消息撤出 `_messages`/`_timeline`（last-wins，多并发只撤最后 dispatch 的）、把撤回 id 持久化到 history 行 `retractedMessageIds`。**三连只在零输出 turn 生效**：`_agentOutputCount`（只计可见输出 agent_message/thought_chunk/tool_call(_update)/plan，usage/config 等元数据不算）对 dispatch 时的 `outputBaseline` 一不等，取消即按**正常中断**处理——user 消息与部分输出都留在 timeline，不恢复草稿、不持久化撤回（哪怕只流出了一个字符）。**撤回只改本地内存态，agent 磁盘 transcript 仍在**（SDK 上下文一致性，不能删）——所以 resume 重放靠 `_resumeSessionInner` 的 `setRetractedMessageIds(entry.retractedMessageIds)` 在 `applyUpdate` 的 `user_message_chunk` 分支按 `readMessageId` 过滤；SDK 写在撤回消息后的 `[Request interrupted by user]` 标记（独立 user 消息、另一个 uuid）由一次性 `_skipInterruptedMarker` 标志连带跳过（**只消费下一个 user chunk**）。SDK 在 resume 以中断标记结尾的会话时还会为满足 API 角色交替往 transcript 追加一条 `<synthetic>` 占位 assistant 行（text `No response requested.`，写入发生在 resume 当时、replay 之后，故 live 不见、下次重开才冒出）——claude fork `isSyntheticNoResponseMessage` 在 replay 循环过滤（同 `isSyntheticLoginMessage` 先例），编辑器零改动。正常中断场景该标记在 transcript 里位于部分输出之后、不在撤回列表里，重放时作为中断痕迹显示；live 流**不会**推送这条标记，所以 `cancelTurn` 在正常中断分支用 `_appendMessage('user', INTERRUPTED_MARKER_TEXT)` 本地补一条，保证 live 与 resume 看到的时间线一致。**codex 侧的对齐在 fork**：rollout 把中断落成 `<turn_aborted>` 合成 user response_item 但 thread/resume 不重建，fork `streamThreadHistory` 对 `status === "interrupted"` 的 turn 在 items 末尾补同款文本的 user chunk（无 messageId）；fork 不再推 `*Conversation interrupted*`（否则零输出取消后孤儿化、正常中断时与本地标记重复）。注意 codex 被中断 turn 的**部分输出不落 rollout**，resume 只能恢复「用户消息 + 中断标记」，恢复不出半截回答。**replay 合并锚点**：`_appendChunk` 的流式合并要求 `last.messageId === messageId`（双 undefined 视为相等，agent/thought chunk 恒走此路不受影响）——否则重放里相邻的两条 user 消息（如无锚点的中断标记 + 带 clientId 的重发 prompt，中间被过滤的 chunk 拿走后变成相邻）会融合成一张卡片。

## `_sendWithRecovery` 返回时 `recovery` 绝不停留在 `phase:'retrying'`

RecoveryBar 只渲染当前 state，倒计时定时器 fire 完就没人再推进它；残留的 `retrying` 会永久转圈且没有 Retry 按钮（症状指纹：状态条卡在「Agent temporarily unavailable. Retrying… (2/3)」、倒计时归零后文案不再变，只能手动点 ×）。收尾责任按出口各自负责、**刻意不用统一 finally**（`agent_crash` 分支把 recovery 交棒给 reconnect tier，统一 finally 会误标成 exhausted）：成功 → clear；abort 分支（`AcpAbortError`）→ clear；退避 sleep 被打断的 catch → clear（这两处都在 `!this._reconnecting` 守卫内——Stop/× 是取消不是失败，不给 manual-retry 条）；`agent_crash` → 交棒 `_handleConnectionLost` 覆盖成 `reconnecting`、**勿收尾**；终止分支 → `!this._reconnecting && (attempt > 1 || verdict.cls === 'transient')` 写 `exhausted` + `_failedPrompt`，`reason: verdict.kind ?? verdict.cls`（非 transient 的 fatal/quota/auth 在「重试后的下一次尝试」收场也要落 exhausted，否则残留 retrying）。配套约定：**看门狗豁免只认 `recovery.hasPending`**（有真实定时器），不认「有 state」——残留 retrying 无定时器必须回落 stall watchdog；**idle reaper 只豁免进行中的 recovery**（`retrying`/`reconnecting`），`exhausted` 是终态不阻止回收，否则 fatal/quota/auth 终态会让 agent 进程永远不被空闲回收（等于用内存不释放换状态残留）。
