---
name: ai-debug-subsystem-context
description: 制作或修改 AI 调用调试记录 / 离线回放（AI Debug）相关功能时召回，提供该子系统的上下文地图——「直接 provider 路径」的唯一收口挂钩点、记录形态（platform 类型 + 内存环形缓冲 + JSONL 落盘 + 人类可读日志三写）、跨进程 IAiDebugService、侧栏 AI Debug 面板、离线 mock 回放管道、purpose 穿透的四条调用路径、E2E 探针。当任务涉及 apps/editor/src/main/services/ai/aiDebugRecorder.ts / aiDebugService.ts、IAiDebugService、AiDebugView、给 AI 调用加调试记录字段 / 新 purpose / 新回放能力、或排查「某条 AI 调用没被记录 / 没法回放」时，先读它建立全局认知。它给「改哪里 + 为什么 + 坑」；新增 AI provider / 底层模型服务契约不在此（见 apps/editor/CLAUDE.md 套路 I），AI 设置页面见 ai-settings-subsystem-context。
disable-model-invocation: true
---

# AI Debug（调用调试记录 + 离线回放）子系统 上下文地图

把每次「直接 provider 路径」的 AI 调用（行内补全 / 会话标题 / commit message / 扩展 AI）以**利于人为阅读**的方式记录下来：实时人类可读流（Output 面板 + 落盘 log）、结构化 JSONL（grep/分析）、侧栏调试面板；并支持用记录的响应**离线 mock 回放**（不调真实模型，无 key 也能复现 UI 流式行为）。**始终开启**，靠复用 logs 的 session 目录清理自动回收磁盘。

> ⚠️ 第一原则：先认领改动落在**哪一层**——① 记录采集（`AiDebugRecorder` + `AiModelMainService` 挂钩）② 记录形态（platform `aiDebugTypes.ts`）③ 跨进程服务（`IAiDebugService` / `AiDebugMainService`）④ 面板 UI（`AiDebugView.tsx`）⑤ purpose 标注（4 处调用点）。底层 AI 模型服务三层架构 / 加 vendor / 密钥红线见 `apps/editor/CLAUDE.md` **套路 I**——别在这找。

## 核心事实（务必先懂）

- **唯一收口点 = `AiModelMainService`**。所有 4 条消费路径都经 renderer `AiModelClientService.sendRequest` → IPC `startRequest` 汇入这里，所以**记录挂钩只在这一个类**，不在每个调用点。
- **记录天然无 API key**：`AiRequestOptions` 不含密钥（key 只在 provider 内经 `group.getApiKey()` 经 `ISecretStorageService` 取）。记录的是 options（去掉 modelId/purpose/debugLabel）+ prompt + response，绝无密钥。
- **purpose 靠一个字段穿透**：`AiRequestOptions.purpose`（platform `aiModelTypes.ts`）本身是 IPC 传输类型，每条路径原样透传 options 到 `startRequest`。给某调用打标签 = 在调用点 options 里加 `purpose`，自动到达 recorder，**无需改 IPC DTO**。
- **回放不碰 provider**：`AiDebugMainService` 自己把记录的历史 chunk 重新 fire 成 replayId 维度的事件，不经 `AiModelMainService`、不发网络。DI 单向：`aiModel → recorder`；`aiDebugService → recorder`（**recorder 不反向依赖 aiModel**，回放自包含在 aiDebugService 内）。

## 文件地图

```
packages/platform/src/ai/
  aiModelTypes.ts          AiRequestOptions.purpose?/debugLabel? + AiRequestPurpose 类型别名（穿透载体）
  aiDebugTypes.ts          vendor-neutral 记录形态：AiDebugStatus / AiDebugMessage{role,text} /
                           AiDebugChunk{atMs,chunk} / AiDebugRecord（全量，含 chunks 回放用）/
                           AiDebugRecordSummary（面板列表轻量投影：responsePreview/tokens）
  （改完必须在 packages/platform/src/index.ts re-export，否则 apps 编译不过）

apps/editor/src/main/services/ai/
  aiDebugRecorder.ts       采集核心。IAiDebugRecorderService = createDecorator（main 内部共享单例）。
                           注入 @ILogMainService(拿 getSessionDir) + 可选 @ILoggerService(createNamedLogger)。
                           状态：_active Map<requestId,Mutable> / _recent 环形缓冲(MAX_RECENT=200) / _enabled。
                           方法：begin / recordChunk / finish / listRecords / getRecord / clearRecords /
                                 isEnabled / setEnabled。finish 三写：内存 push + logger.info(人类可读) +
                                 appendFile JSONL(fire-and-forget 吞错)。image part → '[image mime,N bytes]'。
  aiDebugService.ts        AiDebugMainService implements IAiDebugService。注入 @IAiDebugRecorderService。
                           转发 recorder 的 onDidRecordRequest/onDidClear；自带回放：replayRecord → _runReplay
                           按 chunk fire _onDidReplayChunk 末尾 _onDidReplayEnd(含 error)；realtime 按 atMs setTimeout
                           (timers 入 _timers，dispose 清)。
  aiModelMainService.ts    收口挂钩（精确 5 处，全部 this._recorder?.，可选注入故单测 new 不传也工作）：
                           构造第 4 参 @IAiDebugRecorderService recorder?（~L112）；
                           begin 在 _inflight.set 后、resolveModel 前（~L217）；
                           recordChunk 在 _pumpResponse 的 for await 内（~L337）；
                           finish 在 await result 后（~L341）；
                           _endRequestWithError 里 finish(requestId, serialized)（~L366）。

apps/editor/src/shared/ipc/
  aiDebugService.ts        IAiDebugService 接口 + decorator。事件 onDidRecordRequest/onDidClear/
                           onDidReplayChunk(AiReplayChunkEvent{replayId,chunk})/onDidReplayEnd(AiReplayEndEvent{replayId,error?})。
                           方法 listRecords/getRecord/clearRecords/isEnabled/setEnabled/replayRecord(id,{realtime?})。
  channelNames.ts          ServiceChannels.AiDebug = 'aiDebug'

apps/editor/src/renderer/workbench/aiDebug/
  AiDebugView.tsx          侧栏面板。useService(IAiDebugService) 订阅 onDidRecordRequest/onDidClear 刷新列表。
                           RecordRow(purpose 徽章/model/preview/meta/status 徽章) + RecordDetail(getRecord →
                           分段 prompt/response/usage/error + Replay/Replay realtime/Copy JSON 按钮 + 重播窗)。
                           data-testid: ai-debug-view/-clear/-empty/-row/-detail/-replay/-replay-output。
  AiDebugView.module.css   样式（只用 --color-* 变量）
```

注册落点（改了要同步，套路见 apps/editor/CLAUDE.md 套路 C/B）：
- **跨进程服务（套路 C）**：`main-services.ts` 两条 registerSingleton（IAiDebugRecorderService + IAiDebugService）；`scopedServicesFactory.ts` 的 ApplicationServices 加 `aiDebug`；`main/index.ts` getOrCreateServices invokeFunction 表加 `aiDebug`；`registerMainServices.ts` registerChannel；`renderer/main.tsx` ProxyChannel.toService。
- **侧栏 View（套路 B）三处**：`BuiltInViewContainersContribution.ts`(container id `workbench.view.aiDebug`)、`BuiltInViewsContribution.ts`(view id `workbench.view.aiDebug.main`, componentKey `aiDebug.main`)、`ViewComponentsContribution.ts`(register `aiDebug.main` → AiDebugView)。

## purpose 穿透 —— 四条调用路径（给哪条 AI 调用打标签）

| purpose | 调用点 | 备注 |
|---|---|---|
| `inline-completion` | `renderer/services/ai/InlineCompletionService.ts` | options 加 purpose |
| `session-title` | `renderer/services/acp/acpSessionTitleService.ts` | |
| `commit` | `extensions/ai/src/commitMessage.ts` | 经扩展 API；purpose 已穿透（extension-api 与 extensions-common 的 AiRequestOptions 都带 purpose 字段） |
| `extension` | `renderer/services/extensions/MainThreadAi.ts` | 兜底 `purpose: options.purpose ?? 'extension'` |
| `chat` | （ACP agent 路径不在本子系统范围） | 类型里预留，直接 provider 路径暂未用 |

> 加新 purpose：先在 platform `aiModelTypes.ts` 的 `AiRequestPurpose` union 加成员（platform build）；扩展侧调用还要同步 `packages/extension-api` 与 `packages/extensions-common` 的 options 类型（否则序列化丢字段）；然后在调用点 options 里写上。

## 离线 mock 回放（本子系统特色）

renderer 点 Replay → `IAiDebugService.replayRecord(id, {realtime?})` → main `AiDebugMainService` 取记录的 `chunks`，按序 fire `onDidReplayChunk`（每条带 replayId），末尾 fire `onDidReplayEnd`（原 error 若有）。`realtime` 按 chunk 的 `atMs` 间隔 setTimeout 还原节奏，否则瞬发。renderer `RecordDetail` 用 `replayIdRef` 过滤只收自己这次回放的 chunk，累积成文本展示。**全程不调 provider、不发网络**——无 key 也能跑通。

## 三写落盘（finish 时）

1. **内存**：push 进 `_recent`（超 200 条 shift 最旧）→ 面板列表来源（免回读 jsonl）。
2. **人类可读**：`logger.info`（begin 时 `▶ [purpose] modelId req=… <prompt 摘要>`；finish 时 `◀ ok 123ms 12→48tok` + response 摘要）→ 自动落 `<sessionDir>/aiDebug.log` + Output「AI Debug」channel。
3. **结构化 JSONL**：`appendFile(join(getSessionDir(), 'ai-debug.jsonl'), JSON.stringify(record)+'\n')`，**fire-and-forget + 吞错**（记录失败绝不影响 AI 请求）。

> 磁盘清理零额外代码：JSONL 落在 logs 的 session 目录内，跟随 `cleanupOldLogs()` 的 20-session 目录清理自动删除。

## E2E 探针

`src/shared/e2e/contract.ts` 暴露三个 AI debug 探针方法 + `E2EAiDebugRecord` 类型；`src/renderer/e2e/probe.ts` 实现（依赖注入 `aiDebugService`，在 `main.tsx` 的 `installE2EProbeIfEnabled({…})` 调用表里接线）：
- `getAiDebugRecords()` → 记录摘要（id/purpose/modelId/status/responsePreview）
- `clearAiDebugRecords()` → 清空（断言前先清，只看本次请求）
- `replayAiDebugRecord(id)` → 离线回放并返回拼接文本（未知 id → undefined）。**实现按 replayId 缓冲事件**：IPC 下 replayRecord 返回的 replayId 可能晚于首个 chunk 到达，不能假设事件来时 replayId 已知。

冒烟 `e2e/specs/smoke.aiDebug.spec.ts`（@p1）：起 mock Ollama（无 key 无网络）→ 验证 view/container 已注册 → clear → 驱动真实 commit-message 生成（经 AiModelMainService → recorder）→ 轮询记录出现且 purpose=commit/status=ok/preview 含文本 → 离线回放得同样文本 → 未知 id 回放 undefined。复用 commit 生成链做请求源，因为它是流经收口点最简单的用户可见动作。

## 常见任务 → 改哪里

- **给某 AI 调用打 purpose 标签**：调用点 options 加 `purpose`（见上表）。新 purpose 还要扩 `AiRequestPurpose` union（+ 扩展侧两个 options 类型）。
- **记录里加新字段**（如 temperature 单列、首 token 延迟）：`aiDebugTypes.ts` 的 `AiDebugRecord`/`AiDebugRecordSummary` 加字段 → `aiDebugRecorder.ts` 的 `begin`/`finish`/`toSummary` 填充（注意 `exactOptionalPropertyTypes`，可选字段用条件展开 `...(x !== undefined ? {x} : {})`）→ 面板 `AiDebugView.tsx` 展示。
- **改面板展示/加按钮**：`AiDebugView.tsx`（RecordRow/RecordDetail）+ `.module.css`；保持 data-testid 不变（e2e 选择器依赖）。
- **加回放能力**（如某 chunk 类型的还原）：`AiDebugMainService._runReplay`；renderer 侧 `RecordDetail` 的 `chunkText`/订阅。
- **加 IPC 方法**：`shared/ipc/aiDebugService.ts` 接口 → `AiDebugMainService` 实现（ProxyChannel 自动桥接，事件用 Emitter）。
- **关掉记录的逃生口**：`recorder.setEnabled(false)`（begin/recordChunk 早返回）；当前始终开启，没接配置项——要做成可配置项需自己加 ConfigItem。

## 关键架构决策与「为什么」

- **挂钩只在 AiModelMainService**：它是 4 条路径唯一收口，挂一处即全覆盖；可选注入（`recorder?`）让既有单测 `new AiModelMainService(...)` 不传也工作。
- **回放放在 AiDebugMainService 而非 AiModelMainService**：保持 DI 单向无环，且不把 raw model 事件暴露出去；回放自包含、只读记录的 chunks，天然离线。
- **内存环形缓冲做面板数据源**：避免每次列表都回读 jsonl；JSONL 仍是 session 内全量真相（面板只看最近 200 条）。
- **JSONL fire-and-forget 吞错**：记录是旁路，绝不能让落盘失败影响真实 AI 请求；写失败就丢这条记录，不抛。
- **复用 logs session 目录清理**：磁盘占用问题用现成的 20-session 清理解决，零额外清理代码。
- **vendor-neutral 记录形态**：`aiDebugTypes.ts` 不依赖任何具体 provider，commit/inline/任何 vendor 同构。

## 易踩坑速记

1. **改了 platform 类型忘了 re-export**：`packages/platform/src/index.ts` 必须 `export * from './ai/aiDebugTypes.js'`，否则 apps 编译不过；改完 `pnpm --filter @universe-editor/platform build` 让 dist 更新。
2. **`exactOptionalPropertyTypes` 下可选字段**：record 里大量 `...(x !== undefined ? {x} : {})` 条件展开，别直接写 `x: maybeUndefined`。
3. **回放事件竞态**：IPC 下 `replayRecord` 返回的 replayId 可能晚于首个 chunk；renderer/probe 都要能容忍「先收到 chunk 后拿到 replayId」（probe 按 replayId 缓冲，view 用 replayIdRef 过滤）。
4. **purpose 在扩展路径丢失**：commit 等走扩展 API 的调用，purpose 字段必须在 `extension-api` + `extensions-common` 的 options 类型里都存在，否则线协议序列化丢掉。
5. **E2E 探针漏接线**：新增 probe 方法要同时改 `contract.ts`(接口+类型)、`probe.ts`(实现+E2EProbeServices)、`main.tsx`(installE2EProbeIfEnabled 调用表注入服务)三处。
6. **测试落盘竞态**：JSONL 是 fire-and-forget，单测要轮询等「文件存在**且**已写入完整一行(`includes('\n')`)」，只判 existsSync 会读到空文件 → `Unexpected end of JSON input`。
7. **View 注册三处缺一**：container/view/component 三个 contribution 都要有 aiDebug，否则面板开不出。

## 验证

```bash
pnpm check        # lint + typecheck + test，仅看错误
pnpm --filter @universe-editor/editor build && pnpm --filter @universe-editor/editor e2e -- --grep-invert "@visual|@serial"
# e2e 跑 out/ 产物，改了 renderer/main/probe 必须先 build；只看 smoke.aiDebug 那行 ok
# 手动（pnpm dev）：触发行内补全/生成 commit message/新建 ACP 会话(标题) → 侧栏 "AI Debug" 面板实时出现记录；
#   Output 面板 "AI Debug" channel 有人类可读流；<userData>/logs/<sessionId>/ai-debug.jsonl 有结构化行(确认无 apiKey)；
#   选一条点 Replay → 按记录 chunk 重放、不发真实网络(无 key 也通)。
```

## 单测覆盖（改动时对照扩展）

- `main/services/ai/__tests__/aiDebugRecorder.test.ts` —— begin/chunk/finish 生命周期、image 占位、summary 截断、duration、环形缓冲上限、error/canceled 状态、JSONL 行合法且无 apiKey。
- `main/services/ai/__tests__/aiDebugService.test.ts` —— 回放按序 fire chunk + 末尾 end（含 error / 未知 id → undefined）。
- `renderer/workbench/aiDebug/__tests__/AiDebugView.test.tsx`（renderer-dom）—— 列表/空态/详情/Replay 渲染流式 mock 输出/clear。

## 关键参考路径

- `apps/editor/src/main/services/ai/aiDebugRecorder.ts` —— 采集核心（三写 + 环形缓冲）
- `apps/editor/src/main/services/ai/aiDebugService.ts` —— 跨进程服务 + 离线回放
- `apps/editor/src/main/services/ai/aiModelMainService.ts` —— 收口挂钩（5 处 this._recorder?.）
- `apps/editor/src/shared/ipc/aiDebugService.ts` —— IAiDebugService 契约
- `apps/editor/src/renderer/workbench/aiDebug/AiDebugView.tsx` —— 侧栏面板
- `packages/platform/src/ai/aiDebugTypes.ts` / `aiModelTypes.ts` —— 记录形态 + purpose 载体
- `apps/editor/e2e/specs/smoke.aiDebug.spec.ts` + `src/renderer/e2e/probe.ts` + `src/shared/e2e/contract.ts` —— E2E 端到端
- 相关：`apps/editor/CLAUDE.md` 套路 I（底层 AI 服务/加 vendor）、套路 C/B（跨进程服务/View 注册）、`ai-settings-subsystem-context`（AI 设置页面）
```
