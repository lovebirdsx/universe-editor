# cases-session-ui

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：会话 UI 的逐案坑——标题四个写入方、长 timeline 滚动抖动、第一条用户消息常驻渲染、卡片折叠两层。路由入口见 [CLAUDE.md](CLAUDE.md)「常见任务 → 改哪里」与「易踩坑速记」。

## 会话标题四个写入方，优先级 manual > ai > 首条 prompt 派生（`derivedTitle`）> agent 报告（`session_info_update`/hydrate 的 summary）

三个标志（`aiTitle`/`manualTitle`/`derivedTitle`）任一为真即挡住 `updateInfo` 与 hydrate merge 的标题覆盖，权威写入（AI 标题落盘、rename）走 `overwriteProtectedTitle` 显式通道（**只有 `kind === 'ai' | 'manual'` 才置真**——若 derived 也走 truthy 会静默覆盖用户 rename）。**derived 只本地打标志、从不 `_pushTitleToAgent`**：30 字符截断的 prompt 一旦写成 agent 侧 `customTitle`，既冒充「用户手动命名」，又因 `customTitle` 在 SDK summary 链（`customTitle ?? aiTitle ?? lastPrompt ?? summaryHint ?? firstPrompt`）里排 `aiTitle` 之前而**永久压制 SDK 自己的后台 aiTitle**。**未配置 sessionTitle 模型时 summary 回退成 `lastPrompt`（最近一条用户消息），agent 每轮 turn 结束都推一次**（claude fork `maybeUpdateSessionTitle` 在 `session_state_changed: idle` 里调；codex fork 同理且连长度截断都没有）——所以 `session_info_update` 与 hydrate `_mergeOrReplace` 两条路径都有 `isPromptEchoTitle` 回显守卫（`acpSessionTitleEcho.ts`，规范化后精确相等或 `…` 截断前缀命中即丢弃；判定**保守**，不命中就保留 agent 的 title，SDK 真 aiTitle 仍能落地）。`session_info_update` 的候选是本会话**实时 dispatch 过**的 prompt（`_dispatchedPromptTexts`，环形 8 条，不含 replay 历史——否则旧会话 hydrate 时合法旧标题会被误判为回显），hydrate 侧的候选是 history 行的 `firstPrompt`。AI 生成跳过本地内置命令 prompt（`isLocalCommandPrompt`，/model 等，不消耗机会）且返回 undefined 自动 re-arm 下条重试，并在**首次**发现未配置模型时弹一次性引导通知（`acp.sessionTitle.noModelHintShown`，GLOBAL scope）；fork 回放自定义命令重建为 `/name args`（`stripLocalCommandMetadata`）。**排查标题问题先看 main 侧 `ai-debug.jsonl` 有无 `session-title` 请求**：没有 = renderer 在 `_resolveModelId` 静默返回（现已有 debug 日志 `acp.sessionTitle`）；有但标题没落地 = history 写入方时序/覆盖问题；标题被 agent 摘要顶掉 = 看 devtools 有无 `[acp-title] dropped session_info_update …`。注意 `createdAt` 在 upsert 重加时不重置，但 hydrate 首次导入外来行时 = 导入时刻，别拿它当会话真实创建时间。side task 的 AI 标题生成输入除首条 prompt 外还会带上 history 行的 `sideTaskQuote`（`generateTitle` 的 `context.quotedText`），否则裸问题（"为什么这里会跳？"）生成不出体现讨论对象的标题。

## 长 timeline 从底向上滚动抖动

有两条独立成因，都会让 `scrollTop` 在某个落点上下高频振荡、直到手动拖进度条才停。

**(a) 补偿策略太宽**：`ChatBody` 的动态虚拟行从 `estimateRow` 切到真实高度时，TanStack Virtual 默认以 `item.start < scrollOffset` 判断是否补偿，会把顶部半可见行也按完整高度差反向修正 `scrollTop`，与用户向上滚动互相拉扯。修法：`shouldAdjustScrollPositionOnItemSizeChange` 必须只在整行位于视口上方（`item.end <= scrollOffset`）时返回 true（见 `timelineVirtualScroll.ts`）；虚拟模式同时设 `overflow-anchor: none` 避免 Chromium 原生锚定重复补偿；restore / bottom-pin 收敛窗口可临时设 `() => false`，结束后必须恢复自定义策略，不能恢复为 `undefined`（否则退回 TanStack 默认规则）。

**(b) 行高每次挂载不稳定（真根因，即使全表高度已重算过仍复发）**：`item.end <= offset` 只是必要条件不是充分条件——若视口上方某行每次重挂载测出的高度都不同，补偿会重挂载它、它又闪回旧高度，形成自持振荡。两个已修案例：① `TerminalOutput`（execute 卡片）首帧按全高挂载、随后 async 夹到 240px；② `UserMessageItem`（>160px 长用户消息）曾完全无 seed（`useState(false)` + `useEffect` 迟夹高），且首版估算按字符数算列宽、对 CJK 低估一半行数（中文≈2 列宽）——长中文会话 outline 跳转后向上轻滚即必现「上下闪动 + 持续上漂」。修法在高度源头，基建收敛在 `contentOverflow.ts`：CJK 宽度感知的纯函数估算同步 seed `overflows`（首帧即最终夹后高度）+ 按 contentKey 的**测量缓存**（remount 直接用上次实测，估算边缘偏差只翻转一次即被钉住），两叶子共用（见 `ToolCallOutput.tsx` / `UserMessageItem.tsx`）。**任何叶子组件在挂载后异步改变自身高度都可能复现此环**，新增此类组件时首帧高度必须可由数据同步推定（估算 + 测量缓存双保险）。回归测试：`timelineVirtualScroll.test.ts`（预测逻辑）+ `contentOverflow.test.ts`（CJK 估算/缓存）+ e2e `smoke.agentsScrollJitter.spec.ts` 两用例（真 `page.mouse.wheel` 打点 `window.__TIMELINE_SIZE_CORRECTIONS_TOTAL__` 证明静止时无自持补偿环——注意合成 `el.scrollTop=x`+dispatch scroll 会重置 `scrollAdjustments` 掩盖该环，必须用真滚轮）。

## 第一条用户消息不在 `displayTimeline` 里

`ChatBody` 把它 slice 掉改由滚动容器上方的 `StickyUserMessageBar` 常驻渲染（提交 f2d35dc3 去重）。**渲染/虚拟化索引用 `displayTimeline`，键盘导航/复制等语义操作必须用完整 `timeline`**——`handle.move` 曾因读 displayTimeline 让首条用户消息成为导航黑洞；现在 move 遍历完整 timeline，命中被 slice 的项（displayIndex === -1）时 reveal 就是 `scrollTop = 0`（sticky bar 恒可见），virtualizer `scrollToIndex` 必须换算回 displayTimeline 坐标。焦点高亮跨组件同步走 `FocusedKeyBridge`（`{key, emitter}`，ChatSessionBody 在 render 期挂到 `handleRef.current`）——**不能由 ChatScroll 的 effect 赋值**，因为 StickyUserMessageBar 先于 ChatScroll 挂载，订阅时 handle 方法还是 NOOP；emitter 沿用 activeSlotRef 的「不 dispose、GC 回收」StrictMode 模式。**焦点框（`timelineSlotFocused`）要加在内层卡片上，别加全宽 `ul.stickyUserBar`**——ul 左右贴到聊天区边缘，x≈1–2px 处的 outline 会被 workbench 分界 sash 盖掉；卡片内缩 12px，与列表内 TimelineSlot 的焦点框几何一致。

## 卡片折叠有两层，别混

①**外层卡片折叠**（整个 message/tool_call slot 收起）走 `timelineCollapse.ts` 的 `overrides` + `session.collapseMode`，持久化进 `AcpChatViewStateCache.collapse`；②**内层内容折叠**（长用户消息过 `COLLAPSED_MAX_PX` 夹高 / execute 终端输出过高时的 "Expand/Collapse" 按钮）是叶子组件 `UserMessageItem`/`TerminalOutput` 的展开态。内层态历史上是组件本地 `useState`，切 session/切 tab/虚拟化滚屏（卸载重挂载）即丢——修法：`chatContentExpansion.tsx`（context store `{expandedKeys, toggle}`）由 `ChatBody` 提供并折进 `AcpChatViewStateCache.contentExpandedKeys` 持久化；叶子按稳定 `contentKey` 读写（用户消息 `msg:<slotKey>`、终端 `term:<stickyKey>`），无 store/key 时退回本地 state（如 `ToolCallList` 独立用法）。context 消费者随 store 变化自动重渲染，绕过 `TimelineSlot` 的 memo，无需改 memo。

**从外部 reveal 一个（可能嵌套的）卡片前，必须先展开遮住它的祖先**：外层折叠的卡片由 `CollapsibleSlot` 只在 `!collapsed` 时渲染 body，子卡片根本没有 DOM，`querySelector('[data-sticky-key=…]')` 恒空、`scrollIntoView` 无从谈起。`timelineCollapse.ts` 的 `foldedAncestorKeys`（收集全部折叠祖先）与 `visibleFocusKey`（收敛到最近的折叠祖先）共用同一条祖先链遍历 `resolveAncestors`；`ChatBody.scrollToKey`（Outline Enter/点击、书签跳转的共同入口）先展开再滚。同族的 `moveLevel('in')` 早已内置"折叠就先展开，再按一次才进入"。**注意目标自身的折叠不展开**——折叠卡片仍渲染 header 行，reveal 落点就是那里。

"折叠 → 无 DOM → reveal 无从落点"还有一个**未修的同类成因**：无可渲染内容的子消息 `SubMessage` 直接 `return null`（主 timeline 的 `TimelineSlot` 同理），而 `acpTimelineOutline` 仍按模型建符号——这类行在 Outline 里以 role 名兜底显示（如 `agent`），点击只能退化到父卡片。
