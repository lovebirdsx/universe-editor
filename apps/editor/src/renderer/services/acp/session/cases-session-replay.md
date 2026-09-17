# cases-session-replay

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：会话**恢复/重放路径**的逐案坑——claude compact 边界回放、并行 tool_result 掉链、codex thought chunk 分隔符、codex custom_tool_call 恢复、resume 丢 `[1m]` 模型后缀、transcriptPath（Open Session Location）。路由入口（改哪个文件）见 [CLAUDE.md](CLAUDE.md)「常见任务 → 改哪里」。

## claude 会话跨 compact 边界的历史回放在 fork 侧解决，编辑器零改动

SDK `getSessionMessages` 只沿 `parentUuid` 走「有效上下文链」，compact_boundary 的 `parentUuid` 为 null（显示序前驱存在 `logicalParentUuid`，SDK 不追），所以 loadSession 重放天然丢压缩前历史。修法在 `vendor/claude-agent-acp` 的 `replaySessionHistory`：读原始转录 jsonl，`rebuildTranscriptDisplayChain` 从最新叶子沿 `parentUuid ?? logicalParentUuid` 回溯重建显示链（**链走法而非文件序**——CLI 建的会话可能含被放弃的 rewind 分支），边界处发一条 `_universe/compaction` `phase:'success'` 通知（编辑器 `applyCompaction` 对孤立 success 走 idx===-1 分支直接落一张已完成卡片），跳过 `isCompactSummary` 消息；转录缺失/无边界时回退 `getSessionMessages`，未压缩会话路径不变。模型上下文不受影响（仍 `resume: sessionId`）；rewind 无需改（压缩前锚点 → `messageUuidBefore` undefined → 全会话 resume + 磁盘截断恰好正确）。

## 同一轮并行 tool_use 的 tool_result 会掉出显示链 → 恢复后工具卡片永远「运行中」

claude transcript 把同一轮的并行 tool_use 串成链（use1→use2→…），每个 `tool_result` 的 `parentUuid` 指向**自己的** use——链走法只会跟随**最后一个** use 的结果分支，前面每个并行 use 的 result 都不可达（如 use1→use2→result2 在链上、result1 掉链），重放只发 `tool_call` 无终态 `tool_call_update`，卡片卡在 in_progress、计时器空转。修法在 `replaySessionHistory` 尾部 `backfillForkedToolResults`：跟踪本次重放 surfaced（`tool_call`）与 settled（终态 `tool_call_update`）的 id，从 rawEntries 找回掉链的 `tool_result` 块重放（只重放 result 块、跳过已 settled 防重复闭合；transcript 里真无 result 的——进程被 kill 中断的 turn——无数据可补不强行闭合，而 cancel/interrupt 的正常中断会写 `is_error` result，掉链时补发后正确显示 failed）；uncompacted 会话的 `getSessionMessages` 有效链同样掉链，故对两条路径统一补。对照测试 `acp-agent.test.ts`「tool_results forked off the display chain」。

## side task 的基线回显：抑制期丢弃的 tool_call id 必须留档

side task 恢复时 `suppressReplayToTimeline` 把锚点之前的整段基线丢掉（含基线里所有 `tool_call`），但 fork 在回放尾部有**两条**回显通道会把它们的 result 再发一遍：`backfillForkedToolResults`（在 `session/load` 的 await 链内）与 Task 卡的 `restampReplayedSubagentStats`（fork 侧 `acp-agent.ts:6409` 是 `void` 调用，**必然越出回放窗口**，在 `endHistoryReplay()` 之后才到）。两者发的 `tool_call_update` 都不带 title/kind，`existing` 又查不到（卡片在抑制期已被丢弃），于是标题落到 `update.toolCallId`，凭空冒出十几张 `call_00_…` 标题、`kind: 'unknown'` 的孤儿卡（截图状：重启编辑器后尾部一排）。

修法在编辑器侧（fork 拿不到 anchor uuid，且要兼容旧 agent）：抑制期把丢掉的 `tool_call` id 记进 `_suppressedToolCallIds`（`beginHistoryReplay` 重置、FIFO 上限 `MAX_SUPPRESSED_TOOL_CALL_IDS`，**必须比抑制标志活得久**；淘汰数并入同一条汇总日志，否则「淘汰导致的漏网」与「压根没拦」观测上不可分），`applyUpdate` 在 `estimateUpdateCost` 之前拦掉这些 id 的 `tool_call` / `tool_call_update`。两个约束别退化：判据**只认 id 不认回放窗口**（restamp 会越窗；窗口判据还会误伤子卡暂存/合并与 codex 带 title 的孤儿 update），位置**必须在 `_agentOutputCount` 与 change-tracker 之前**（基线回显不该算作本轮 agent 输出、也不该进会话 diff）。标题另加兜底 `update.title ?? existing?.title ?? readAgentToolName(update) ?? localize('acp.session.toolCallUntitled')`——任何路径都不再把不透明协议 id 当标题。对照测试 `AcpSession.timeline.test.ts` 三个用例：回填被丢弃、越窗 restamp 被丢弃、change-tracker 不被污染（第三个是位置约束的唯一守卫，把守卫挪到 tracker 之后只有它会红）。

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
