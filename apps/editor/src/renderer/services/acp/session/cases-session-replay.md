# cases-session-replay

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：会话**恢复/重放路径**的逐案坑——claude compact 边界回放、并行 tool_result 掉链、codex thought chunk 分隔符、codex custom_tool_call 恢复、resume 丢 `[1m]` 模型后缀、transcriptPath（Open Session Location）。路由入口（改哪个文件）见 [CLAUDE.md](CLAUDE.md)「常见任务 → 改哪里」。

## claude 会话跨 compact 边界的历史回放在 fork 侧解决，编辑器零改动

SDK `getSessionMessages` 只沿 `parentUuid` 走「有效上下文链」，compact_boundary 的 `parentUuid` 为 null（显示序前驱存在 `logicalParentUuid`，SDK 不追），所以 loadSession 重放天然丢压缩前历史。修法在 `vendor/claude-agent-acp` 的 `replaySessionHistory`：读原始转录 jsonl，`rebuildTranscriptDisplayChain` 从最新叶子沿 `parentUuid` → `logicalParentUuid` → `compactMetadata.preservedSegment.tailUuid` 取**首个在文件里能解析**者回溯重建显示链（CLI 会把 `logicalParentUuid` 写成 `null` 或指向不存在的 uuid，此时退到压缩记录的段尾，否则回溯会静默断在 boundary、只剩最后一次压缩之后的历史）（**链走法而非文件序**——CLI 建的会话可能含被放弃的 rewind 分支），边界处发一条 `_universe/compaction` `phase:'success'` 通知（编辑器 `applyCompaction` 对孤立 success 走 idx===-1 分支直接落一张已完成卡片），跳过 `isCompactSummary` 消息；转录缺失/无边界时回退 `getSessionMessages`，未压缩会话路径不变。模型上下文不受影响（仍 `resume: sessionId`）；rewind 无需改（压缩前锚点 → `messageUuidBefore` undefined → 全会话 resume + 磁盘截断恰好正确）。

## 同一轮并行 tool_use 的 tool_result 会掉出显示链 → 恢复后工具卡片永远「运行中」

claude transcript 把同一轮的并行 tool_use 串成链（use1→use2→…），每个 `tool_result` 的 `parentUuid` 指向**自己的** use——链走法只会跟随**最后一个** use 的结果分支，前面每个并行 use 的 result 都不可达（如 use1→use2→result2 在链上、result1 掉链），重放只发 `tool_call` 无终态 `tool_call_update`，卡片卡在 in_progress、计时器空转。修法在 `replaySessionHistory` 尾部 `backfillForkedToolResults`：跟踪本次重放 surfaced（`tool_call`）与 settled（终态 `tool_call_update`）的 id，从 rawEntries 找回掉链的 `tool_result` 块重放（只重放 result 块、跳过已 settled 防重复闭合；transcript 里真无 result 的——进程被 kill 中断的 turn——无数据可补不强行闭合，而 cancel/interrupt 的正常中断会写 `is_error` result，掉链时补发后正确显示 failed）；uncompacted 会话的 `getSessionMessages` 有效链同样掉链，故对两条路径统一补。对照测试 `acp-agent.test.ts`「tool_results forked off the display chain」。

## side task 的基线回显：抑制期丢弃的 tool_call id 必须留档

side task 恢复时 `suppressReplayToTimeline` 把锚点之前的整段基线丢掉（含基线里所有 `tool_call`），但 fork 在回放尾部有**两条**回显通道会把它们的 result 再发一遍：`backfillForkedToolResults`（在 `session/load` 的 await 链内）与 Task 卡的 `restampReplayedSubagentStats`（fork 侧 `acp-agent.ts:7957` 是 `void` 调用，**必然越出回放窗口**，在 `endHistoryReplay()` 之后才到）。两者发的 `tool_call_update` 都不带 title/kind，`existing` 又查不到（卡片在抑制期已被丢弃），于是标题落到 `update.toolCallId`，凭空冒出十几张 `call_00_…` 标题、`kind: 'unknown'` 的孤儿卡（截图状：重启编辑器后尾部一排）。**闸门本身在三条重放路径上都生效**（resume、rewind、重开），三条都按 history 行 `sideTaskOf` 决定是否 arm：`_resumeSessionInner` 与 `AcpSession._beginRewindReplay`（后者在 `_resetForReplay()` 之前读行，锚点被截掉时改用 `undefined` arm 并清掉行上的死锚点）——所以「基线卡片落地」只可能发生在闸门未 arm 的路径上，别把它当成 rewind 专属问题。

修法在编辑器侧（fork 拿不到 anchor uuid，且要兼容旧 agent）：抑制期把丢掉的 `tool_call` id 记进 `_suppressedToolCallIds`（`beginHistoryReplay` 重置、FIFO 上限 `MAX_SUPPRESSED_TOOL_CALL_IDS`，**必须比抑制标志活得久**；淘汰数并入同一条汇总日志，否则「淘汰导致的漏网」与「压根没拦」观测上不可分），`applyUpdate` 在 `estimateUpdateCost` 之前拦掉这些 id 的 `tool_call` / `tool_call_update`。两个约束别退化：判据**只认 id 不认回放窗口**（restamp 会越窗；窗口判据还会误伤子卡暂存/合并与 codex 带 title 的孤儿 update），位置**必须在 `_agentOutputCount` 与 change-tracker 之前**（基线回显不该算作本轮 agent 输出、也不该进会话 diff）。标题另加兜底 `update.title ?? existing?.title ?? readAgentToolName(update) ?? localize('acp.session.toolCallUntitled')`——任何路径都不再把不透明协议 id 当标题。对照测试 `AcpSession.timeline.test.ts` 三个用例：回填被丢弃、越窗 restamp 被丢弃、change-tracker 不被污染（第三个是位置约束的唯一守卫，把守卫挪到 tracker 之后只有它会红）。

## side task 的首轮 plan 重发：抑制期必须留档 plan 条目签名

侧边任务顶部冒出来的「父会话计划」不走时间线，所以 `suppressReplayToTimeline` 挡不住它：fork 的 `prompt()` 在**每一轮**开头把累积的 `session.taskState` 整份重发为 `plan`（`vendor/claude-agent-acp/src/acp-agent.ts:3746`，条件是「有未完成任务」——继承来的父任务通常正是未完成），而那一刻 `endHistoryReplay()` 已经清掉抑制标志。完整链路：fork 深拷贝父转录 → 子会话 `session/load` 回放时从转录里的 `TaskCreate/TaskUpdate` 结果重建 `taskState`（本地行为清单「resume 重放恢复 Task 计划」）→ 首轮 prompt 重发 → 编辑器接受 → `session.plan` 非空 → 顶部 `StickyPlanBar` 显示父计划，并经 `setHistoryPlan` 写进子会话 history 行 → 之后每次重开由 `initState.plan` 回灌，常驻不消。

修法在编辑器侧（与上一条同构）：抑制期把丢弃的 `plan` 条目记进 `_suppressedPlanSignatures`（先归一化再取 `status\u0000content` 签名，FIFO 上限 `MAX_SUPPRESSED_PLAN_SIGNATURES`，淘汰数并入同一条汇总日志），`case 'plan'` 应用时**逐条扣除**。四条别退化：

- **判据只认签名不认回放窗口**——重发发生在窗口关闭之后。
- **台账不许随 `beginHistoryReplay()` 清空**（与 `_suppressedToolCallIds` 相反）：闸门在锚点处解除，而 fork 在**每一轮** prompt 开头重发整份 `taskState`、rewind 的重放越过锚点后也会再发一遍——清了台账，父计划会重新灌回 plan 条并重写镜像（比原 bug 更糟）。台账存活期 = 实例。arm 点共两处（`acpSessionService.ts:1478` 的 resume 与 `AcpSession._beginRewindReplay` 的 rewind），台账与它们无关。
- **逐条扣除，不能「整条与基线快照相等才丢」**：子会话一旦自建任务，快照就变成「基线 + 新任务」不再相等，父条目会整条放行。
- **每轮都过滤**，不许收窄成「首轮」。

有意语义：签名含 status，所以契约是「父计划**原样**永不显示」，不是「它的文字永久禁用」——子会话接手（或被 `activeForm` 换过 content）的条目算它自己的新状态。配套两处：`endHistoryReplay()` 末尾的 `_dropSeededBaselinePlan()` 把「历史行已镜像、且全为基线条目」的种子计划就地清掉（打开即自愈，不必等下一轮 prompt）；`_planSeen` / `sealStreamingMessages` 改成扣除后非空才做（被隐藏的 plan 不该劈开正在流式的消息）。codex 侧签名集合恒为空（其 `session/load` 回放不发 plan）→ 过滤是恒等操作，无回归。

对照测试：`AcpSession.timeline.test.ts` 三条（首轮重发被扣除、闸门解除后的重放仍扣除、被突变的基线条目按子会话自己算）+ `AcpSessionService.resume.test.ts` 两条（端到端不显示且不写镜像、旧行种子计划打开即自愈）。

## 回放预算窗口是**时序性**的：回放类下发必须被 `session/load` await 覆盖

回放断路器 `REPLAY_INGESTION_BUDGET = 256MB`（`acpContentLimits.ts:217`，已含 ×3 视图模型开销）不是按「内容是不是回放」判定的：它的窗口由 `beginHistoryReplay()` / `endHistoryReplay()` 夹住 `session/load` RPC（`acpSessionService.ts:1383` / `:1443`，load 调用在 `:1430`）。**load resolve 之后到达的通知一律按另一套账记**——回放内容晚到，就不再享受回放预算。

事故：fork 的 `replaySubagentTranscripts`（子 agent 嵌套 transcript 回放）曾是 `void` fire-and-forget，子 agent 的嵌套通知在 load resolve **之后**才到，整批绕过回放断路器 → renderer 涨到 5.5GB OOM。

- **红线**：回放类下发必须被 `session/load` **await 覆盖**——判据是「通知**到达时**还在不在窗口里」，不是「发出去时在不在」；**fire-and-forget 下发回放内容是红线**。
- 修法两面：① fork 侧 `replaySubagentTranscripts` 改 `await`（`vendor/claude-agent-acp/src/acp-agent.ts:10035`，注释写明理由——client 的 history-replay ingestion budget 以 load response 为回放终点，越窗通知会绕过 OOM 断路器）；② sidecar 源头预算（单文件 16MB / 累计 48MB，超限跳卡或停发），即便被越窗夹带也发不出巨量（常量族见 [cases-memory-budget.md](cases-memory-budget.md)）。
- **对照**：同处的 `restampReplayedSubagentStats` 保持 `void` 是**有意**的——它只回写 disjoint 的 stats 字段、不重发内容，越窗无害（其越窗产生的孤儿 update 由编辑器 `_suppressedToolCallIds` 拦，见上「side task 的基线回显」）。判据是「越窗下发的内容量级」，不是「是不是回放路径的函数」。

## codex 恢复路径的 thought chunk 必须自带 part 分隔符

编辑器流式合并（`StreamingBlocksAccumulator`）把同 message 的 text chunk **逐字拼接、不加任何分隔**。codex reasoning summary 每个 part 是一行 `**标题**`；流式路径 part 之间有 `summaryPartAdded` → `\n\n`（item/completed 兜底 `createCompletedReasoningEvent` 也 `join("\n\n")`），恢复路径（`CodexAcpServer.createReasoningUpdates` + `ResponseItemHistoryFallback.createReasoningUpdates`）曾逐 part 发 chunk 无分隔 → 恢复后粘连成 `**A****B**` 一坨。修法：两处恢复函数统一 `parts.filter(...).join("\n\n")` 单 chunk（对齐 live stream）。配套样式：`.messageItem/.subMessage[data-role='thought'] strong { font-weight/color: inherit }`（agents.module.css）让 thought 卡片内 markdown 强调不变成亮白粗体（`.markdown strong` 全局规则是 700 + 亮白色）。改 fork 任何「恢复重发」逻辑时，先想清楚该逻辑在流式路径靠什么分隔符，恢复侧必须复刻。

## codex 恢复丢 shell 调用 = app-server 不重建 `custom_tool_call`，fork fallback 补

新版 codex 的 shell/patch 调用在 rollout 里是 `custom_tool_call`(name=`exec`，input 是 JS 片段 `await tools.shell_command({...})`/`tools.apply_patch(...)`) 而非 `function_call`。live 时 app-server 实时转成 `commandExecution` item 推送；但 `thread/resume` 从 rollout 重建 turns 时**不还原**它们（apply_patch 会重建为 fileChange，shell 全丢）→ 恢复后 shell 卡片消失。排查法：用真实 codex 二进制跑 `app-server` + `thread/resume` 对比 rollout 原始记录。修法在 fork `ResponseItemHistoryFallback`：识别 exec 的 JS input，平衡括号提取 `shell_command` 的 JSON 参数合成 `shell_command` function_call 复用既有渲染管线（terminal 卡片 + commandAction 推断 + `Exit code: N` 解析，注意剥 `Script completed/failed` 包装 chunk 和 `Wall time` 头）；apply_patch 类必须 skip（thread 的 fileChange 已覆盖，且 fileChange id 是 `exec-<uuid>` ≠ rollout 的 `call_xxx`，靠 id 去重根本匹配不上）；`custom_tool_call_output` 只在 call 已 emit 时生成 update 防孤儿。改完必须 `npm --prefix vendor/codex-acp run build`（dev 入口 = `vendor/codex-acp/dist/index.js`）。

## resume 恢复的是 transcript 里的 API 裸模型名（丢 `[1m]` 后缀 → 窗口 1M 退化 200k、auto-compact 提前到 ~168k）

CLI 从 transcript 恢复模型时拿到的是 `claude-fable-5` 而非用户选的 `claude-fable-5[1m]`，而 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 是 `min(模型有效窗口, 配置值)` 的取小语义，窗口一退化配置再大也被钳住。根治：`session/load` 与 `session/resume`（`_resumeSessionInner` / `_reconnectSession`）的 `_meta.claudeCode.resumeModel` 捎上 history 行记忆的 per-session 模型原值（`buildResumeMeta`），fork `getAvailableModels` 按 **env > resumeModel > settings.model** 优先级解析，命中走既有 `reassert-override` 后台 `setModel`（带 `[1m]` 原值）；wire key 常量在 `acpExtMethods.ts` 的 `ACP_META_KEYS.resumeModel`。**第二坑（实测踩过）**：SDK 模型列表可能没有目标 lane 行（如无 allowlist 时 fable 只有裸行），`resolveModelPreference` 的 tokenized 兜底层会把 `claude-fable-5[1m]` 模糊匹配到**裸行**，reassert 裸名 → 仍 200k；fork 的修法是 canonical 比较发现 lane 丢失时**逐字跟踪原值**（合成条目拷最近 SDK 行的能力标志），窗口播种也按逐字 id 命中 `1m` 启发式。`/model` 斜杠命令切换的值能正常进 history 并经 resumeModel 回传（CLI 落 transcript、fork 不追踪但 editor 侧从 configOption 同步学到）。**第三坑（用户手动切裸行，side task 实测踩过）**：模型列表同时有 `sonnet`（200k）与 `sonnet[1m]` 两行，172k 上下文的 fork 会话切到裸行后下一条 prompt 立即 auto-compact——机制上"正确"但用户无预警地丢上下文。守卫在 `modelSwitchContextGuard.ts`：`evaluateModelSwitchContextShrink`（仅 claude-code；`[Nm]`/`-Nm` hint → N×1M、裸行 200k 启发式；`used ≥ 目标×0.8` 且目标 < 当前 `usage.size` 才告警）+ 确认对话框，接线在 `ConfigOptionsBar.pickValue` 与 `agentModelActions.pickConfigOption` 两个切模型入口。

## 官方 Codex app 打开过的会话：writer lock + paginated thread + resume 死循环

诊断包钉死三条（不是猜测）：

1. **跨进程 writer lock**。官方 app 占 `$CODEX_HOME/thread-writer-locks/<id>.lock`，编辑器 spawn 的私有 `codex app-server` 在 `thread/resume` 上报 `already has an active writer`。不能双写，只做 UX：`formatAcpErrorMessage` 读 `data.details`，命中 writer-lock 时译成「该会话正在被另一个 Codex 客户端使用」。
2. **paginated thread 的 `session/load` 永久失败**。官方 app 打开/迁移后，0.146 `thread/read(includeTurns=true)` 拒绝。修在 fork `CodexAcpClient.loadSession`：捕获该错误、带着 resume 返回的空 `turns` thread 走 JSONL fallback（`includeAllItems`）。`mergeHistoryUpdates` 在空 turns 时会在第一条 `user_message_chunk` 丢掉整个 fallback，故 `requireHistory` 时直接用 fallback；空 fallback 大声失败，禁止打开空白会话。
3. **UI remount 死循环**。`_resumeSessionInner` 先 register 再 `session/load`，失败再 remove → `AcpSessionEditor` 在 session 有无之间切 ChatBody ↔ 新 `AcpSessionResumer`（phase idle）→ 再 auto-resume（约 71 次 / 18s）。phase 提升到不随 `getById` 卸载的一层、按 `sessionId` 隔离；成功只在 `resumeSession` resolve 时 idle。

配套测试：`AcpSessionEditor.test.tsx`（load 失败不重踢 + writer-lock 文案）；fork `load-session.test.ts`（paginated JSONL 成功 / 空 fallback 失败 / 其它 threadRead 错误仍抛）。

## "Open Session Location"（列表右键）依赖 fork 上报 `_meta.transcriptPath`

链路 = fork `session/list` 响应 `SessionInfo._meta.transcriptPath` → `acpSessionRestoreCoordinator.toBulkMergeInfo`（agent 无关通用提取）→ `acpSessionHistory` → `RevealAgentSessionInOSAction`（`host.showItemInFolder`）。claude fork 用 `findTranscriptFile` 查 `~/.claude/projects/...`；codex fork 直接映射 app-server `thread/list` 返回的 `Thread.path`（rollout JSONL，ephemeral 线程为 null 则省略）。**运行中 session 的 history 行在下次 hydrate 前没有 transcriptPath**：菜单项对 live session 保持可用，`RevealAgentSessionInOSAction` 缓存未命中时走 facade `resolveTranscriptPath` → coordinator `fetchTranscriptPath` 按需发一次 `session/list`（capability 门控、silent 连接、游标翻页）解析并经 `setHistoryTranscriptPath` 写回 history，解析不到才提示无 transcript。仅当行既非 live 又无缓存路径时菜单项才灰掉 = 其 fork 没上报，编辑器侧无需改。

同一份 `transcriptPath` 也是 `CopyAgentSessionPathAction`（"复制会话文件路径"）的数据源，两者共用 `resolveSessionTranscriptPath`。差异只在拿到路径之后：copy 复制**原始路径**、不做 WSL UNC 映射、菜单不按 authority 置灰（远端会话复制的就是宿主路径，正适合粘进远端 shell），因此它只快照 `IAcpSessionService / IAcpSessionHistoryService / IEditorService / INotificationService`，不碰 `IHostService`。
