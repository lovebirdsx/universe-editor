---
name: acp-rewind-fork
description: 给 ACP agent 会话加/改「回退（rewind，截断对话+可选回滚文件+回填输入框做 edit-and-retry）」或「分叉（fork，以某消息之前的历史新建独立会话）」功能时召回。核心是理解一个反直觉事实——本仓库用的是 claude-agent-sdk 的 query()（非交互 --print 一次性进程），SDK 只暴露 rewindFiles() 回滚文件、**没有对话回退落盘 API**（rewindConversation 仅类型挂名无实现），所以 rewind 必须自己三步做（回滚文件 + resumeSessionAt 重建内存态截断 + **物理截断磁盘 JSONL transcript** 才能持久化），fork 必须走 SDK 的 forkSession() 写新文件、且 upToMessageId 是 inclusive 要 key 在前驱。当任务涉及：给会话消息加悬停 rewind/fork 按钮、edit-and-retry 回填、rewind 关闭重开回弹到旧状态、fork 无历史/含多余消息、消息锚点 messageId 对不上（Unknown messageId）、按能力位隐藏按钮、或要理解 vendor(claude-agent-acp) 与 renderer 三层如何协作时使用。给出 vendor + renderer 三层文件地图、SDK 关键约束、三个已修 bug 的根因、messageId 锚点机制、测试与验证套路、易踩坑。协议层全景见 acp-session-subsystem-context，本 skill 专注 rewind/fork 这条纵切。
disable-model-invocation: true
---

# ACP 会话 rewind（回退）/ fork（分叉）功能

给外部 AI agent 会话加两个"改变对话方向"的能力：
- **rewind（回退）**：截断对话回到某条 user 消息之前，可选是否回滚 agent 改过的文件，并把该消息文本回填输入框供 edit-and-retry。首版仅 claude-code。
- **fork（分叉）**：以某消息**之前**的历史为起点新建**独立**会话，原会话不变。agent 声明支持才可用。

> ⚠️ **第一原则 —— 先认清 SDK 能力边界（决定整个架构）**：
> 本仓库通过 `@anthropic-ai/claude-agent-sdk` 的 `query()` 接入 claude，走的是**非交互 `--print` stream-json 一次性进程**。交互式 `claude` CLI 的原生 `/rewind` 是**长驻 REPL 进程内**的私有机制，我们用不上。SDK 的 `Query` **只暴露 `rewindFiles()`（回滚文件）**；对话回退 `rewindConversation` 只在 `sdk.d.ts` 类型联合里挂名、`sdk.mjs` 实现文件里根本没有。**所以"截断对话"没有官方 API，必须自己拼。**
>
> ⚠️ **第二原则 —— 分清三层**：① vendor（`vendor/claude-agent-acp`，自维护 fork，改完必 `pnpm agent:build`）做真正的 SDK 调用与磁盘操作；② renderer service（`acpSession.ts` / `acpSessionService.ts`）做 view-model 透传 + 本地 timeline reset；③ renderer 命令 + UI（`agentRewindActions.ts` / `UserMessageItem.tsx`）做按钮 + 确认框 + 回填。改错层白改。
>
> 协议层全景（双 id、applyUpdate 状态机、连接池、恢复）见 skill `acp-session-subsystem-context`，本 skill 只讲 rewind/fork 纵切，不重复。

## SDK 关键约束（一手验证，SDK 0.3.198；升级必复查）

1. **无对话回退落盘 API**：`Query` 只有 `rewindFiles(userMessageId, {dryRun})`。`rewindConversation` 类型挂名无实现。
2. **`resumeSessionAt` 只改内存不改磁盘**：它是启动 flag `--resume-session-at`，配 `--session-id`（同 id）只让重建的 in-memory Query 从该点截断，**从不物理改写** `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`（append-only）。**这是 rewind 关闭重开会回弹的根因。**
3. **`resumeSessionAt` 是 inclusive**，且文档要 **`SDKAssistantMessage.uuid`**（"up to and including"）→ 要截断到 user 轮之前，得 key 在其**前驱**（assistant）uuid。
4. **`forkSession(sid,{dir,upToMessageId})` 是唯一真写磁盘的截断原语**：把源 transcript 切片后**复制成新文件**（新 session id）。`upToMessageId` 也是 **inclusive**（"Slice transcript up to this message UUID (inclusive)"）→ fork "从消息 X"要 key 在 X 的**前驱**才能排除 X 本身。
5. **`getSessionMessages(sid,{dir})` 读完整磁盘 transcript**：沿 parentUuid 链走到 tip，**无截断参数**。返回每条的 `uuid` == 磁盘 JSONL 每行的 `uuid` 字段。
6. **transcript 磁盘格式**（物理截断依赖）：一行一个 JSON、带 `uuid` 字段、严格 append 有序（parent 恒在 child 前）、尾随 `\n`、末行空。夹杂 `file-history-snapshot`/`mode`/`custom-title`/`queue-operation` 等非消息行。cwd→目录名编码 = `replace(/[^a-zA-Z0-9]/g,'-')`（未公开、脆弱，定位文件优先试它、兜底扫描）。
7. **锚点必须走 `enableFileCheckpointing:true`**（createSession 时传）否则 `rewindFiles` 返回 `canRewind:false`。

## 消息锚点机制（rewind/fork 的地基）

client 要能指定"回到哪条消息"，需要一个贯穿两端的稳定 id：

- renderer 发 prompt 时生成 uuid → `AcpMessage.messageId`，**同时**塞进 `PromptRequest._meta.messageId`。
- **关键坑**：vendor 用的 ACP SDK（`@agentclientprotocol/sdk` 1.1.0）的 `zPromptRequest` schema **没有 `messageId` 字段，zod 默认 strip 掉未知顶层键** → 顶层 `messageId` 会被静默丢弃。**必须走 `_meta`**（passthrough bag，不被 strip）。
- vendor `prompt()` 从 `params._meta.messageId` 读，直接当 SDK message uuid（`userMessage.uuid = promptUuid`）并**eager** `session.messageIdToUuid.set(promptUuid, promptUuid)`。因 client uuid 直接 == SDK uuid，renderer 无需 echo 校正。
- replay 路径：vendor `applyMessageId()` 给 `user_message_chunk`/`agent_message_chunk`/`agent_thought_chunk` 盖 messageId；renderer `applyUpdate` 的 `user_message_chunk` case 必须 `readMessageId(update)` 传进 `_appendChunk`，否则 resume/fork 重放出来的历史 user 消息**没锚点 → 按钮不显**。

## 数据流

### rewind（三步，全在 vendor `rewindSession`）
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

### fork（vendor `unstable_forkSession`）
```
renderer forkSession(sid, messageId?) → conn.unstable_forkSession({sessionId, cwd, _meta:{rewindTo:messageId}})
  ⟨vendor⟩: resolveMessageUuid(rewindTo) → messageUuidBefore(锚点)=前驱 → sdkForkSession(sid,{dir,upToMessageId:前驱})
  → 返回新 sessionId → renderer temp lease 丢弃 → resumeSession(新id)（自开 lease 做 session/load+replay+setActive）
```

## 文件地图

### vendor `vendor/claude-agent-acp/src/acp-agent.ts`（改完必 `pnpm agent:build`）

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

### renderer service `apps/editor/src/renderer/services/acp/`

| 文件 | 相关改动 |
|---|---|
| `acpSession.ts` | `rewindTo(messageId,{dryRun?,rewindFiles?})`（reset+replay-gate+extMethod+tracker.clear 条件）；`forkSupported`（observable，从 `sessionCapabilities.fork` 设）+ `rewindSupported`（observable，从 initialize `_meta['universe-editor/capabilities'].rewind` 设）+ 私有 `_filesRolledBackByAgent`（同块设）；`_dispatchPrompt` 发 `_meta:{messageId}`；`applyUpdate` 的 `user_message_chunk` 传 `readMessageId(update)`；`_appendChunk` 加 `messageId?` 参 |
| `acpSessionModel.ts` | `IAcpSession` 接口：`rewindTo` 签名 + `forkSupported`/`rewindSupported` + `RewindFilesResult` 类型；`REWIND_SESSION_METHOD` 常量（与 vendor 同步） |
| `acpSessionService.ts` | facade `forkSession(sid,msgId?)`（temp lease → unstable_forkSession → resumeSession）+ `rewindSession(sid,msgId,{dryRun?,rewindFiles?})`（校 live+非 closed+rewindSupported 才委托）；`AcpForeignWorktreeError` 守卫 |
| `acpSessionUpdateMeta.ts` | `readMessageId(update)` reader（从 update 读 vendor 盖的 messageId） |
| `acpPromptReplaceInbox.ts` | edit-and-retry 回填收件箱：**替换语义**（map 存单值 last-wins，drain 返 string?）。区别于 `acpPromptContextInbox`（追加语义） |

### renderer 命令 + UI

| 文件 | 职责 |
|---|---|
| `actions/agentRewindActions.ts` | `RewindAgentSessionAction`（dryRun 预览→三/单按钮确认→rewind→回填）+ `ForkAgentSessionAction`（fork→开 editor tab 或 setActive）。都 `f1:false`、arg=`{sessionId,messageId}` |
| `actions/index.ts` | `registerAction2` 两个 action；`agentActions.ts` barrel re-export |
| `workbench/agents/UserMessageItem.tsx` | hover 显 Rewind（`Undo2`）/Fork（`GitBranch`）按钮，`useObservable(rewindSupported)`+`useObservable(forkSupported)` 各自门控；抽 `UserMessageActions` 子组件避免条件 hooks |
| `workbench/agents/ChatBody.tsx` | `TimelineSlot` memo 加 `session` prop 透传给 UserMessageItem，带 `messageId` |
| `PromptInput.tsx` | drain `AcpPromptReplaceInbox`：`setText(replace)`+清 contexts/images+focus |
| `workbench/agents/agents.module.css` | `.userMessageWrap`(relative)+`.userMessageActions`(hover 才 opacity:1) |

## 三个已修 bug 的根因（复用时对照自查）

1. **rewind 报 `Unknown messageId`**：SDK 1.1.0 zod strip 顶层 messageId。→ 走 `_meta.messageId`。
2. **fork 无历史（显示空会话）**：旧实现用内存态 resumeSessionAt fork **不落盘**，session/load replay 读磁盘=空。→ 用 `sdkForkSession()` 写新文件。
3. **fork 含被点消息本身 / rewind 消息列表不变 / rewind 关闭重开回弹**：三个都源于 **inclusive 语义 + 只改内存不改磁盘**。→ fork/rewind 都 key 在**前驱**；rewind 加 `replaySessionHistory({stopBeforeUuid})`（内存）**和** `truncateTranscriptBefore`（磁盘物理截断，持久化）。
4. **rewind/fork 后运行期 model/effort 丢失回落默认**（claude 专属，codex 无因 thread 存活）：claude rewind teardown+`createSession` 重建 Query 时用的是**最初** `newSessionParams`，effort 又从 settings.json 重新 seed——运行期 `setConfigOption` 改的 model/effort/fast/agent 从未写回。→ vendor `rewindSession` teardown **前** `snapshotRuntimeConfig(session)`（从 live `configOptions` 读 model/effort/fast/agent，model 优先序），重建后 `reapplyRuntimeConfig` 按序走 `setSessionConfigOption`（复用 model→effort 级联），逐项 best-effort（失败只 log）。fork 侧不重建进程但**新 history 行没继承源配置**→ renderer `forkSession` 注册行时带 `snapshotConfigSelections(live.configOptions.get())` 的 `configOptions`/`configLabels`，resume 的 `setConfigDesired` 借现成 flush 机制 push 回 fork 线程（fork 侧零新增 push 逻辑）。

## 常见任务 → 改哪里

- **加 rewind/fork 到新的 agent**：能力位——fork 读 `sessionCapabilities.fork`，rewind 首版硬编 `agentId==='claude-code'`（因依赖 claude SDK 的 rewindFiles + checkpointing）。别的 agent 要支持 rewind 得确认其 fork 也提供等价原语。
- **改回退语义（保留/撤销文件）**：`RewindSessionRequest.rewindFiles` 贯穿 vendor→`acpSession.rewindTo`→`acpSessionService.rewindSession`→命令三按钮。tracker.clear 只在真回滚时。
- **改 edit-and-retry 回填**：`acpPromptReplaceInbox.ts`（替换语义）+ `PromptInput` drain effect。命令捕获文本要**趁 rewind 清空 timeline 前** `session.messages.get().find(m=>m.messageId===)`。
- **锚点对不上/按钮不显**：查 `_meta.messageId` 是否发/读；replay 路径 `readMessageId`→`_appendChunk` 是否传；vendor `applyMessageId` 是否盖到 `user_message_chunk`。
- **rewind 关闭重开回弹**：确认 `truncateTranscriptBefore` 被调（teardown 前，趁有 cwd）+ 物理截断成功（看日志 `rewind persist:`）。
- **改磁盘截断逻辑**：`truncateTranscriptBefore`/`findTranscriptFile`，注意 format 假设（见 SDK 约束 #6）+ 原子写 + best-effort 不抛。

## 易踩坑速记

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

## 测试套路

- **vendor**（`src/tests/acp-agent.test.ts`）：
  - rewind describe：dryRun 预览 / canRewind:false 短路（都在 step2 前，可不 spawn 真 Query）/ rewindFiles:false（`vi.spyOn` 隔离 teardown/createSession/replay/truncateTranscriptBefore，验证跳过 rewindFiles 仍截断）。
  - fork describe：`vi.mock` 加 `forkSession`(vi.fn) + `getSessionMessages`（默认 `vi.fn(actual.getSessionMessages)` 保真实现，新测试 `mockResolvedValueOnce` 覆盖），验证 upToMessageId=前驱。
  - truncate describe：**真实 tmp 文件**建在 `CLAUDE_CONFIG_DIR/projects/__rewind_trunc_test_<uuid>/`，afterEach 清理；验证删锚点及之后/首行清空/锚点不存在原样/文件不存在 no-throw。`CLAUDE_CONFIG_DIR` 已 export。
  - **2 个既有 Windows 反斜杠路径失败**（`toDisplayPath`/`Read src\main.ts`）与本功能无关，CI 上绿。
- **renderer**：`AcpSessionService.test.ts`（rewind 发对 messageId+clear tracker、dryRun 不 cancel、rewindFiles:false 透传+不清 tracker、非 claude no-op、fork `_meta.rewindTo`+setActive）；`agentRewindActions.test.ts`（预览+三按钮各分支+回填、无能力 no-op、fork 开 editor/foreign 提示）；`UserMessageItem.test.tsx`（按钮可见性+委托 arg）。stub 见坑 #9。

## 验证

```bash
# vendor
cd vendor/claude-agent-acp && npx vitest run src/tests/acp-agent.test.ts -t "rewind"   # rewind + truncate
cd vendor/claude-agent-acp && npx vitest run src/tests/acp-agent.test.ts -t "fork"      # fork point
pnpm agent:build          # ★改 vendor 后必重建 dist（esbuild，非 tsc）
# renderer
pnpm check                # lint+typecheck+test（含 docs:check），仅看错误
```

改了用户可见行为（按钮/确认框文案/回退语义）→ 同步 `docs/user/zh-CN/ai-agent/managing-sessions.md`「回退与分叉」节。

## 关键参考路径

- **vendor 核心**：`vendor/claude-agent-acp/src/acp-agent.ts`（`rewindSession`/`unstable_forkSession`/`truncateTranscriptBefore`/`messageUuidBefore`/`prompt`）
- **renderer service**：`acpSession.ts`（`rewindTo`/能力位/`_appendChunk`）、`acpSessionService.ts`（facade）、`acpSessionModel.ts`（接口+`REWIND_SESSION_METHOD`）、`acpSessionUpdateMeta.ts`（`readMessageId`）、`acpPromptReplaceInbox.ts`
- **命令+UI**：`actions/agentRewindActions.ts`、`workbench/agents/UserMessageItem.tsx` + `ChatBody.tsx`
- **文档**：`docs/user/zh-CN/ai-agent/managing-sessions.md`
- **SDK 类型**：`vendor/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（`forkSession`/`resumeSessionAt`/`getSessionMessages`/`ForkSessionOptions`）
- **记忆**：[[acp-rewind-fork-progress]]（完整实施进展 + 三 bug 根因 + 持久化真相）
- **相关 skill**：`acp-session-subsystem-context`（会话子系统全景，本 skill 是其纵切）、`update-claude-agent-acp`（vendor fork 构建/升级流程）、`user-docs-subsystem-context`（用户文档）

## codex 版（与 claude 架构根本不同，已实现，见 [[codex-rewind-fork-parity]]）

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

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件。
