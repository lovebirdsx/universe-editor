# cases-session-ui

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：会话 UI 的逐案坑——标题四个写入方 + 跨工作区持久化（`set_session_title`）与跨 bucket 回填、长 timeline 滚动抖动、第一条用户消息常驻渲染、卡片折叠两层、执行时间统计、子 Agent 卡片（首行：任务标题 / 跑动区间 / 模型与 ≈¥；正文：请求）、上游故障呈现（HTTP 200 空 body）、卡片产出文档在侧边组打开。路由入口见 [CLAUDE.md](CLAUDE.md)「常见任务 → 改哪里」与「易踩坑速记」。

## 会话标题四个写入方，优先级 manual > ai > 首条 prompt 派生（`derivedTitle`）> agent 报告（`session_info_update`/hydrate 的 summary）

三个标志（`aiTitle`/`manualTitle`/`derivedTitle`）任一为真即挡住 `updateInfo` 与 hydrate merge 的标题覆盖，权威写入（AI 标题落盘、rename）走 `overwriteProtectedTitle` 显式通道（**只有 `kind === 'ai' | 'manual'` 才置真**——若 derived 也走 truthy 会静默覆盖用户 rename）。**derived 只本地打标志、从不 `_pushTitleToAgent`**：30 字符截断的 prompt 一旦写成 agent 侧 `customTitle`，既冒充「用户手动命名」，又因 `customTitle` 在 SDK summary 链（`customTitle ?? aiTitle ?? lastPrompt ?? summaryHint ?? firstPrompt`）里排 `aiTitle` 之前而**永久压制 SDK 自己的后台 aiTitle**。**未配置 sessionTitle 模型时 summary 回退成 `lastPrompt`（最近一条用户消息），agent 每轮 turn 结束都推一次**（claude fork `maybeUpdateSessionTitle` 在 `session_state_changed: idle` 里调；codex fork 同理且连长度截断都没有）——所以 `session_info_update` 与 hydrate `_mergeOrReplace` 两条路径都有 `isPromptEchoTitle` 回显守卫（`acpSessionTitleEcho.ts`，规范化后精确相等或 `…` 截断前缀命中即丢弃；判定**保守**，不命中就保留 agent 的 title，SDK 真 aiTitle 仍能落地）。`session_info_update` 的候选是本会话**实时 dispatch 过**的 prompt（`_dispatchedPromptTexts`，环形 8 条，不含 replay 历史——否则旧会话 hydrate 时合法旧标题会被误判为回显），hydrate 侧的候选是 history 行的 `firstPrompt`。AI 生成跳过本地内置命令 prompt（`isLocalCommandPrompt`，/model 等，不消耗机会）且返回 undefined 自动 re-arm 下条重试，并在**首次**发现未配置模型时弹一次性引导通知（`acp.sessionTitle.noModelHintShown`，GLOBAL scope）；fork 回放自定义命令重建为 `/name args`（`stripLocalCommandMetadata`）。**排查标题问题先看 main 侧 `ai-debug.jsonl` 有无 `session-title` 请求**：没有 = renderer 在 `_resolveModelId` 静默返回（现已有 debug 日志 `acp.sessionTitle`）；有但标题没落地 = history 写入方时序/覆盖问题；标题被 agent 摘要顶掉 = 看 devtools 有无 `[acp-title] dropped session_info_update …`。注意 `createdAt` 在 upsert 重加时不重置，但 hydrate 首次导入外来行时 = 导入时刻，别拿它当会话真实创建时间。side task 的 AI 标题生成输入除首条 prompt 外还会带上 history 行的 `sideTaskQuote`（`generateTitle` 的 `context.quotedText`），否则裸问题（"为什么这里会跳？"）生成不出体现讨论对象的标题。

## 长 timeline 从底向上滚动抖动

有两条独立成因，都会让 `scrollTop` 在某个落点上下高频振荡、直到手动拖进度条才停。

**(a) 补偿策略太宽**：`ChatBody` 的动态虚拟行从 `estimateRow` 切到真实高度时，TanStack Virtual 默认以 `item.start < scrollOffset` 判断是否补偿，会把顶部半可见行也按完整高度差反向修正 `scrollTop`，与用户向上滚动互相拉扯。修法：`shouldAdjustScrollPositionOnItemSizeChange` 必须只在整行位于视口上方（`item.end <= scrollOffset`）时返回 true（见 `timelineVirtualScroll.ts`）；虚拟模式同时设 `overflow-anchor: none` 避免 Chromium 原生锚定重复补偿；restore / bottom-pin 收敛窗口可临时设 `() => false`，结束后必须恢复自定义策略，不能恢复为 `undefined`（否则退回 TanStack 默认规则）。

**(b) 行高每次挂载不稳定（真根因，即使全表高度已重算过仍复发）**：`item.end <= offset` 只是必要条件不是充分条件——若视口上方某行每次重挂载测出的高度都不同，补偿会重挂载它、它又闪回旧高度，形成自持振荡。两个已修案例：① `TerminalOutput`（execute 卡片）首帧按全高挂载、随后 async 夹到 240px；② `UserMessageItem`（>160px 长用户消息）曾完全无 seed（`useState(false)` + `useEffect` 迟夹高），且首版估算按字符数算列宽、对 CJK 低估一半行数（中文≈2 列宽）——长中文会话 outline 跳转后向上轻滚即必现「上下闪动 + 持续上漂」。修法在高度源头，基建收敛在 `contentOverflow.ts`：CJK 宽度感知的纯函数估算同步 seed `overflows`（首帧即最终夹后高度）+ 按 contentKey 的**测量缓存**（remount 直接用上次实测，估算边缘偏差只翻转一次即被钉住），两叶子共用（见 `ToolCallOutput.tsx` / `UserMessageItem.tsx`）。**任何叶子组件在挂载后异步改变自身高度都可能复现此环**，新增此类组件时首帧高度必须可由数据同步推定（估算 + 测量缓存双保险）。回归测试：`timelineVirtualScroll.test.ts`（预测逻辑）+ `contentOverflow.test.ts`（CJK 估算/缓存）+ e2e `smoke.agentsScrollJitter.spec.ts` 两用例（真 `page.mouse.wheel` 打点 `window.__TIMELINE_SIZE_CORRECTIONS_TOTAL__` 证明静止时无自持补偿环——注意合成 `el.scrollTop=x`+dispatch scroll 会重置 `scrollAdjustments` 掩盖该环，必须用真滚轮）。

## 第一条用户消息不在 `displayTimeline` 里

`ChatBody` 把它 slice 掉改由滚动容器上方的 `StickyUserMessageBar` 常驻渲染（提交 f2d35dc3 去重）。**渲染/虚拟化索引用 `displayTimeline`，键盘导航/复制等语义操作必须用完整 `timeline`**——`handle.move` 曾因读 displayTimeline 让首条用户消息成为导航黑洞；现在 move 遍历完整 timeline，命中被 slice 的项（displayIndex === -1）时 reveal 就是 `scrollTop = 0`（sticky bar 恒可见），virtualizer `scrollToIndex` 必须换算回 displayTimeline 坐标。焦点高亮跨组件同步走 `FocusedKeyBridge`（`{key, emitter}`，ChatSessionBody 在 render 期挂到 `handleRef.current`）——**不能由 ChatScroll 的 effect 赋值**，因为 StickyUserMessageBar 先于 ChatScroll 挂载，订阅时 handle 方法还是 NOOP；emitter 沿用 activeSlotRef 的「不 dispose、GC 回收」StrictMode 模式。**焦点框（`timelineSlotFocused`）要加在内层卡片上，别加全宽 `ul.stickyUserBar`**——ul 左右贴到聊天区边缘，x≈1–2px 处的 outline 会被 workbench 分界 sash 盖掉；卡片内缩 12px，与列表内 TimelineSlot 的焦点框几何一致。

## 卡片折叠有两层，外加一条子 Agent 互斥例外，别混

①**外层卡片折叠**（整个 message/tool_call slot 收起）走 `timelineCollapse.ts` 的 `overrides` + `session.collapseMode`，持久化进 `AcpChatViewStateCache.collapse`；②**内层内容折叠**（长用户消息过 `COLLAPSED_MAX_PX` 夹高 / execute 终端输出过高时的 "Expand/Collapse" 按钮）是叶子组件 `UserMessageItem`/`TerminalOutput` 的展开态。内层态历史上是组件本地 `useState`，切 session/切 tab/虚拟化滚屏（卸载重挂载）即丢——修法：`chatContentExpansion.tsx`（context store `{expandedKeys, toggle}`）由 `ChatBody` 提供并折进 `AcpChatViewStateCache.contentExpandedKeys` 持久化；叶子按稳定 `contentKey` 读写（用户消息 `msg:<slotKey>`、终端 `term:<stickyKey>`），无 store/key 时退回本地 state（如 `ToolCallList` 独立用法）。context 消费者随 store 变化自动重渲染，绕过 `TimelineSlot` 的 memo，无需改 memo。

**从外部 reveal 一个（可能嵌套的）卡片前，必须先展开遮住它的祖先**：外层折叠的卡片由 `CollapsibleSlot` 只在 `!collapsed` 时渲染 body，子卡片根本没有 DOM，`querySelector('[data-sticky-key=…]')` 恒空、`scrollIntoView` 无从谈起。`timelineCollapse.ts` 的 `foldedAncestorKeys`（收集全部折叠祖先）与 `visibleFocusKey`（收敛到最近的折叠祖先）共用同一条祖先链遍历 `resolveAncestors`；`ChatBody.scrollToKey`（Outline Enter/点击、书签跳转的共同入口）先展开再滚。同族的 `moveLevel('in')` 早已内置"折叠就先展开，再按一次才进入"。**注意目标自身的折叠不展开**——折叠卡片仍渲染 header 行，reveal 落点就是那里。

**③ 子 Agent 卡片互斥：聊天区里最多一张展开**（这是**层①上的一条例外**，不是与前两层并列的第三条机制——顶层子 Agent 卡片的折叠态不走 `overrides` / `mode`，别用 ① 的机制去理解它）。顶层子 Agent 卡片（`isSubagentCard`：`subagent` 标记或带 `children` 的 tool call）的折叠态**只由 `CollapseState.openSubagent` 这一个槽位决定**（`resolveCollapsed` 里最先短路）——「任何模式下最多一张展开」因此是结构保证而非维护出来的不变量：打开第二张只是改写该槽位，之前那张自然折起。`ChatBody.openSubagentKey` 随 `AcpChatViewStateCache.collapse.openSubagent` 持久化（纯内存 LRU，无 schema），写入口只有 `handleToggleCollapse`（chevron / `Alt+F` / `Alt+L` / 粘性头）与 `scrollToKey`（Outline / 书签揭示：链上有子 Agent 卡片就改为指定它，只有其余祖先才写 `override`）。**判据必须带顶层约束**——`isSubagentSlot` 要求 key 不含 `/`：复合 key 是卡片**内部的内容**，算成卡片会让「展开嵌套子卡片」把刚打开的父卡片折掉。模式切换：进 `collapsed` 清空槽位（「全部折叠」要连它一起折）并把原值记进 state，离开 `collapsed` 时还原——**用户在这期间新点开的那张优先**（这就是「切到全展开后只留最近打开的那张」），`default ⇄ expanded` 之间直接保留。**互斥的范围是单个 `ChatBody`**：把同一会话分屏到两个编辑器组时两边各挂一个实例、各自维持一张展开（与 `overrides` / `contentExpandedKeys` 既有的每实例语义一致；指定槽位于缓存里是挂载时读一次的快照，不做跨实例同步。同理，自管折叠态的 `ToolCallList` 若重新挂回聊天，也不走这条规则）。**打开 B 会折掉视口上方的 A**，而 A 若已卸载，它在 virtualizer 里量到的旧行高要等重新挂载才刷新——滑动条长度会短暂偏大，属一次性偏差，不是上面那种自持抖动。

"折叠 → 无 DOM → reveal 无从落点"还有一个**未修的同类成因**：无可渲染内容的子消息 `SubMessage` 直接 `return null`（主 timeline 的 `TimelineSlot` 同理），而 `acpTimelineOutline` 仍按模型建符号——这类行在 Outline 里以 role 名兜底显示（如 `agent`），点击只能退化到父卡片。

## 执行时间统计：只计 `status === 'running'` 的净时长

只累计 `status === 'running'` 的净时长（多段累积、持久化恢复）——设计意图是与挂起/等待时间区分，让用户了解 Agent 实际工作了多少。结算在 `acpSession.ts` 的 `_recomputeStatus` / `_finalizeRunningSegment`（`acpSession.ts:2564/2580`，**离开 running 时**结算最后一段）；历史持久化走 `AcpSessionHistoryEntry.accumulatedRunningMs`（可选字段、**无版本迁移**）。两处显示：输入框下方（`PromptInput.tsx`）+ Sessions 面板 session 行（`SessionListBody.tsx`，foreign 会话回退 `useForeignSessionStats`）；公共 hook `useSessionTimer` + `formatRunningTime` 在 `workbench/agents/`。

## 子 Agent 卡片首行：任务标题 / 跑动区间 / 模型与 ≈¥

claude 的 Task 卡首行一向有「任务描述 · 模型 · 耗时 · ↑↓token · ≈¥」，codex 的 spawn 卡原来只有裸标题 + token。三者各自的落点与坑：

- **标题**：`toolCallDisplay.ts` 的 `subagentTaskTitle`，唯一消费方是 `deriveToolCallDisplay` 的 default 分支。**只认 codex 协作 spawn**——判据 `call.subagent === true` **且** `rawInput` 带 `receiverThreadIds` 数组：claude 的 Task input 同样有 `prompt`，但没有「它创建的线程」这个键，而 claude 卡的首行是 agent 自己写的 description，动不得。取 `prompt` 首个非空行 → 折叠空白 → 超 80 字符截断加 `…`；无 prompt（`capRawInput` 因超 64KB 整体丢弃 rawInput 是最常见的一种）回退 wire title（`spawnAgent`）。放 UI 层而非 ingest 期的理由与 rawInput 的既有定位一致（同 Bash 的 `description` 提升）：纯函数可测，回放自动一致。
- **跑动区间**：spawn 项在 wire 上只活 30–58ms，而子 Agent 跑几十秒到数分钟，所以**卡片自身的 status/duration 不能当时钟**。fork 上报 `_meta._universe/subagentTiming`（锚点随卡首报、子线程 `turn/completed` 收口、回放按子 turn 时长求和，两半都落成父卡上的 `tool_call(_update)`——叙事见 `vendor/codex-acp/cases-session.md` 与 `cases-replay.md`），编辑器落进 `AcpToolCall.subagentRunStartedAt` / `durationMs`：`tool_call`（live 的锚点走这条）与 `tool_call_update`（live 收口与回放都走这条）两个分支都要读。**有锚点时本地 freeze 必须让位**（`durationMs` 保持 undefined）：否则卡在 wire 上落定时冻结出的那 30ms 会把徽标钉死在 `0s`，而 run-end 之前它本该走秒。`SubagentStatsBadge.useRunDuration` 据此判 running（`status === pending/in_progress` **或**「有锚点无时长」），时钟起点取 `subagentRunStartedAt ?? startedAt`；claude 无此 meta，老路径（本地 freeze）逐字不变。三条边界：① 子 Agent 在父 prompt 之外结束、或孙线程（深度只做一层）的收口到不了 → 停在走秒态；② 一次 spawn 建多个线程时共用卡片与锚点，先结束者会把时长短暂冻结在偏小值、最后一个覆盖为正确值（fork 侧刻意的自愈取舍）；③ 锚点是 **app-server 所在机器**的 epoch ms，remote authority 会话在两台机器间做减法——远端时钟超前会把时钟钉在 `0s`（收口值由 fork 算好，不受影响，run 结束即自愈），偏移大时该会话的走秒不可信。
- **模型与 ≈¥**：`_universe/subagentStats.model`（spawn 项模型 → 会话当前模型剥 `[...]` 后缀）喂既有 `_priceSubagentStats` → 该 provider 声明的费率源。ChatGPT 订阅 / 未声明费率源时整块省略 ≈¥，绝不跨厂商兜底（沿用 `_priceSubagentStats` 既有红线）；模型也取不到时连模型徽标一起省略。**新字段要进 `trimToolCall` 白名单**（内存裁剪的显式字段表）：`subagentRunStartedAt` 丢了会让正在跑的子 Agent 卡片徽标整体消失（`subagentStats` 同理，两者都已登记）。
- **请求正文（父 → 子的完整任务描述）**：`toolCallDisplay.ts` 的 `subagentRequest` → `ToolCallCard.tsx` default 分支的 body **最前**一块（`data-testid="acp-subagent-request"`，markdown 渲染**逐字全文**——含与标题相同的那一行，重复是刻意的，别加「与标题相同则隐藏」；不加标签、不折叠；body 只在展开时挂载，折叠态零成本）。两个 fork 同源、都取 `rawInput.prompt`：codex 协作 spawn 卡对非 AIR 客户端不发 `content`（正文原本整块空白，请求只活在 rawInput 里），claude 的 Task 卡跑动中正文本就是这句 prompt、结果到达后 `content` 被整体替换成报告——两边都靠这一块回看请求。**判据与标题刻意不同**：标题的 `subagentTaskTitle` 只认 codex（要 `receiverThreadIds`），正文两个 fork 都认——**别把它当漏改补上门槛**。去重规则 `call.text.trim() === prompt.trim()` 时整块不渲染，即**跑动中＝正文本身就是请求（无独立块）；完成后＝请求块 → 报告 → 子轨迹**；边界已证明不可达：`rawInput` 上限 64KB 且按 `JSON.stringify` 计（≥ prompt 本身），而文本块截断阈值 256KB——能取回 prompt 就永远不是「半截 prompt + 完整请求」同现。四条降级（静默、不报错）：① `rawInput` 超 64KB 被整条丢弃；② 内存裁剪后 `rawInput` 不在 `trimToolCall` 白名单（同标题回退一源）；③ codex 的 spawn `prompt` 可为 null；④ `syntheticDenial` 的卡 body 整体为 null。**未修**：复制「这条消息」不含请求——`acpSessionContent.ts` 的 `toolCallToText` 走模型不走 DOM，只认 title/text，要补得先把 helper 下移到 session 层（依赖方向：services 不引 workbench 的 UI helper）。

## 上游故障呈现：网关 HTTP 200 空 body（别与「假拒绝」混淆）

另一类会让会话/子 agent 停住的**独立故障**：网关返回 **HTTP 200 但空 body**——claude 侧落成 `isApiErrorMessage`（claude fork `src/session-failure-extension.ts` 有该字段的消费路径），超时量级 360s，claude-* 模型也中招（实测样本占 50%）。与「假拒绝」的症状相似（都停住）但根因完全不同：假拒绝是 CLI 把任意 tool-queue abort 兜底成 `user-rejected`，呈现侧的修复（fork `_meta.claudeCode.syntheticDenial` + 卡片「上游中断」徽标）见 `vendor/claude-agent-acp/cases-session.md`；本条是上游网关故障，编辑器侧只做呈现、无法修复。

## 卡片文档在侧边组打开（Ctrl/Cmd+点击 / 右键菜单）

ACP 卡片写出的文档除就地打开外，还能落到聊天的**右侧相邻组**：标题行阅读按钮 Ctrl/Cmd+点击，或右键菜单「在侧边打开预览 / 在侧边打开文件」——两个 Action2 的 `when` 互斥，同一张卡只多出一行（口味由 `chatContextSlot` 的 `createdFile` 单键决定：有预览器走预览、否则走文件）。落点收口在 `apps/editor/src/renderer/services/editor/openToSide.ts` 的 `ensureSideGroup(groups, source = activeGroup)`（**「在旁边组打开」的唯一落点**，markdown/html 预览原先那 5 行重复已并入）；「预览 else resolver」收口在 `apps/editor/src/renderer/services/resourcePreview/openResourcePreview.ts` 的 `openResourceForRead`；`useMarkdownFileLink` 的 `toSide` 从死参变成生效，所以 markdown 预览正文里的链接 Ctrl+点击也走这条。调用点 `apps/editor/src/renderer/workbench/agents/ToolCallCard.tsx` 的 `openCreated`。

**红线：`ensureSideGroup` 只能在真正打开的那一帧调用，绝不 hoist 到 `await` 之前。** 新建的空组**不会**被回收（回收只在 group model 变化时触发，仅被 activate 的空组不触发任何变化），提前建组会让「文件不存在 / 多命中 / 目标是目录」这几种结局各留下一个孤儿空组。helper 内先 `activateGroup` 是承重的：打开走 `activeGroupForOpen` 路由，不先激活就落不进侧边组（同 `openToSide.ts` 头注释）。

**坑-载荷两半（写 agent fixture / 断言卡片 UI 必踩）**：卡片的阅读入口（`createdFilePath`，`ToolCallCard.tsx` 用它拿 `createdUri`）**只认 ACP 标准 `content` 里的 diff 块**——`oldText` 为空是唯一的「新建」信号，且须先排除 `memoryTrimmed`；`_meta.claudeCode.structuredPatch` 是**另一半**载荷，只喂 session change tracker。只发后者会得到一张没有阅读按钮、右键菜单也没有 Open File 行的卡，e2e 表现为 locator 静默等 30s 超时。fixture `apps/editor/src/test-fixtures/sessionDiffAgent.cjs` 的 `createmd` / `createtxt` 两半都发。

**落点语义（e2e 已锁）**：点卡片时 group body 的 `onMouseDown` 先激活卡片所在组，所以第二次 Ctrl+点击会**复用**第一次开出来的侧边组，不会一路向右裂开；只有源组本身就是最右组时才再新建（另一支由单测覆盖）。锚 `apps/editor/src/renderer/services/editor/__tests__/ensureSideGroup.test.ts`、`apps/editor/e2e/specs/smoke.acpOpenToSide.spec.ts`。

## AI 标题跨工作区：`universe-editor/set_session_title` ext-method，claude/codex 必须对称

标题的权威副本有两个：本地 history 行（打 `aiTitle`/`manualTitle` flag）与 **agent 侧 durable store**。AI/manual 标题除落本地外，还经 `acpSession.ts` 的 `_pushTitleToAgent` 发 `universe-editor/set_session_title` 持久化回 agent（claude fork 自提交 5593b63 起有，走 `renameSession`；codex 走 app-server `thread/name/set`）——**跨工作区 `session/list` 报的标题就是这条**，本地 flag 只保护本 bucket 不被 hydrate 覆盖。push 是 **best-effort + fire-and-forget**：agent 没实现就 methodNotFound 被静默吞掉；且**不唤醒 dormant 会话**（只为记标题 spawn 进程会抵消 idle reaper 省下的内存），标题缓存在 `_pendingTitle`，由 `attachConnection` 在会话自然唤醒时重放。renderer 侧**从不分 agent**——`_pushTitleToAgent` 本来就对 codex 发，无需按 agentId 分支。

codex 侧曾整条缺链，症状=跨 worktree 看该 codex 会话显示**首条用户消息**：push 被 methodNotFound 吞 → 标题只留工作区作用域；外部 worktree 的行由 hydrate sweep（`session/list`）经 `CodexAcpClient.listSessions` 引入，标题取 `normalizeSessionTitle(thread.name ?? thread.preview)`——`thread.name` 为 null 即回退 `thread.preview`（首条用户消息）。修复=与 claude **对称补齐**：`AcpExtensions.ts` 的 `SET_SESSION_TITLE_METHOD` + `setSessionTitleParamsParser`（并入 `EXTENSION_METHOD_REGISTRATIONS`）、`CodexAppServerClient.threadSetName`（v2 `ThreadSetNameParams{threadId,name}`）、`CodexAcpClient.setSessionName`、`CodexAcpServer.setSessionTitle`（空标题 `RequestError.invalidParams`）。

契约锚点：单一真相表 `acpExtMethods.ts` 的 `ACP_EXT_METHODS.setSessionTitle`；跨仓契约测试 `apps/editor/integration/scenarios/acpForkContract.integration.test.ts` 对**真 fork dist** 断言该方法的路由、`{sessionId, title}` 参数形状与空标题拒绝。

## 跨 worktree 看外部 session：标题冻结在首条消息（跨 bucket 回填，纯渲染层）

**现象**：worktree A 窗口看归属 B 的 session，Side Bar 行 / tab / 窗口标题显示**首条用户消息**而非 AI 标题；在 B 自己窗口看正常。

**根因**：每个 session 的权威标题在**归属工作区的 storage bucket**（`acp.sessionHistory` 条目、`aiTitle:true`）。外部窗口靠 hydrate sweep（`session/list`）把外部 session 拉进自己的 bucket，建行时取 agent 汇报的 summary；而 **hydrate 每个 cwd 只自动跑一次**（`acpSessionRestoreCoordinator.ts` 的 `_hydratedForCwd` 幂等门，只有用户手动 `refresh()` 才绕过并切 replace 模式）→ 首次 hydrate 早于 AI 标题生成/推送时，首条消息标题就被**永久冻结**在外部 bucket。更糟：session JSONL 被删后 SDK `listSessions` 直接 `NOT IN LIST`，`session/list` 永远修不回来。

**修法**（复用既有跨 bucket 回填链路——`useForeignSessionStats` 原本就为外部行回填时长/费用/模型，标题是同类数据却漏了）：① `useForeignSessionStats.ts` 的 `ForeignSessionStat` 加 `title?`，从归属 bucket 读，**仅当该条目 `aiTitle === true`** 才回填（非权威标题不覆盖）；② `SessionListBody.tsx` 行标题取 `foreignStat?.title ?? entry.title`，并加 reconcile effect 把权威标题经 `history.updateInfo(id, { title })` 写回当前 bucket——**title-only，绝不打 `aiTitle`**（打了就挡死后续 hydrate 的更新，把冻结变成永久），使 tab / 窗口标题（读 `history.entries` 经 `resolveLiveSessionTitle`，`acpSessionTitle.ts`）一并自愈。测试 `apps/editor/src/renderer/workbench/agents/__tests__/useForeignSessionStats.test.tsx` 2 例（AI 标题回填 / 非 AI 不回填）。

## 跨 bucket 标题问题的复现与验证手法

- **直接比对两个 bucket**：workspace storage 文件 = `<userData>/workspaces/<id>.json`，`id` 由 `apps/editor/src/main/storage.ts` 的 `workspaceIdFromUri(工作区 URI 字符串)` 算出（sha1 hex 前 16 位）；读其中 `acp.sessionHistory.entries`，对比两个 bucket 里同 session id 条目的 `title`/`aiTitle`。
- **探 agent 侧真值**：用 fork 的 `@anthropic-ai/claude-agent-sdk` 的 `listSessions({ dir })`；**探针脚本必须放进 vendor 包目录内**才解析得到它的 node_modules。
- **平台坑**：Windows 盘符大小写会生成两个 project 目录（`d--…` vs `D--…`，同一物理目录），对比时别当成两个会话。
