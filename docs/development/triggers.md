# Agent 触发器（Triggers）

Agent 触发器的实现说明：主进程单例调度器 + 每窗口反向运行宿主，把「定时 / 轮询 / Swarm 审核 / 手动」事件变成受预算与权限策略约束的自动化 ACP 会话，并把会话产出的结构化判决收敛成白名单动作。

用户向说明见 [`docs/user/zh-CN/ai-agent/triggers.md`](../user/zh-CN/ai-agent/triggers.md)；原始设计稿见 [triggers-design.md](triggers-design.md)（已实现，本文是权威说明）。

## 1. 定位与边界

- **配置只在用户级**：`<userData>/triggers/triggers.json`，不读工作区级配置。工作区信任（Workspace Trust）在运行前校验。
- **默认关闭**：`enabled` 缺省 `false`；全部关闭时不创建调度 / 轮询定时器（仅保留启动门控那一个定时器）。
- **主进程单例**：调度、去重、状态、审计都在 main。renderer 只负责建会话、跑 Agent、收结果、执行动作。
- **自动化会话是普通会话**：持久化、进历史、出现在 Sessions 列表与手机收件箱；不是 `internal` 会话。
- **动作由编辑器执行**：Agent 只产出 `result.json`，不直接调用 Swarm 写命令。

## 2. 架构

```
main（应用级单例）                                    renderer（每窗口）
┌──────────────────── TriggerMainService ────────────────────┐
│ JsonConfigFileStore<TriggersConfig>  ← triggers.json       │
│ TriggerStateStore                    ← state.json          │
│ RunQueue  (全局 / 每触发器并发)                             │
│ 调度：单个 wake 定时器 + 启动门控                            │
│ 源：manual / schedule / poll / swarm-review                 │
│ PollCommandFetcher (spawn + 超时/超限杀进程树 + 1MB 上限)  │
│ AuditLog → audit.jsonl                                      │
│ 窗口路由：findWorkspaceHost / waitForWorkspaceHost          │
└───────────────┬─────────────────────────────────────────────┘
                │ ITriggerRunHost（main → renderer 反向通道）
                ▼
┌──────────────────────── 窗口内 ─────────────────────────────┐
│ TriggerRunHost                                              │
│   ├─ isWorkspaceTrusted()                                   │
│   ├─ startRun(request) ──► AutomatedSessionService          │
│   │                          createSession(activate:false)  │
│   │                          校验 mode 落定                  │
│   │                          sendPrompt(rendered)           │
│   │                          AutomatedRunWatcher             │
│   └─ cancelRun(runId)                                       │
│ AutomatedRunWatcher：费用 / 活跃时间 / 审批卡超时 / 结束检测  │
│ TriggerVerdictContribution：安装判决解析 + 动作执行 resolver  │
│ TriggerRunNotificationContribution：运行结束通知              │
│ SwarmReviewNotificationContribution：上报待处理审核           │
└─────────────────────────────────────────────────────────────┘
```

### IPC 通道

| 通道 | 方向 | 契约 |
| --- | --- | --- |
| `ServiceChannels.Triggers`（`'triggers'`） | renderer → main | `ITriggerMainService`：列表 / 手动运行 / 暂停 / 确认 / 打开配置 / 运行结束上报 / Swarm 审核上报 / `readRunReport`（PC 按 runId 读 `report.md`） / `onDidChangeTriggers` |
| `ServiceChannels.TriggerRunHost`（`'triggerRunHost'`） | main → renderer | `ITriggerRunHost`：`startRun` / `cancelRun` / `isWorkspaceTrusted` |

- main 侧：`registerMainServices.ts` 注册 `ProxyChannel.fromService(app.triggers)`，并 `toService` 得到每个窗口的 `rendererTriggerRunHost`；`windowScopeFactory.ts` 在窗口创建后调用 `appServices.triggers.registerWindowHost(win.id, host)`，窗口销毁时 `windowMainService` 调 `unregisterWindowHost`。
- renderer 侧：`main.tsx` 绑定 `ITriggerMainService` 代理；在 ACP 会话服务就绪后注册 `TriggerRunHost` 反向通道。
- 主进程所有定时 / 时间判断走可注入的 `TriggerClock`，测试用假时钟。

### 文件布局

| 位置 | 内容 |
| --- | --- |
| `apps/editor/src/shared/triggers/` | 纯逻辑（无 node / electron 依赖）：`types.ts`（契约与默认值）、`configParse.ts`（校验 + 指纹）、`cron.ts`、`scheduler.ts`、`dedupe.ts`、`runQueue.ts`、`backoff.ts`、`promptTemplate.ts`、`verdict.ts` |
| `apps/editor/src/shared/ipc/triggerService.ts` | `ITriggerMainService` / `ITriggerRunHost` 契约、`SwarmNeedsActionReview`、`swarmReviewEvent` |
| `apps/editor/src/main/services/triggers/` | `triggerMainService.ts`（调度器）、`triggersConfigFile.ts`（JSONC 读写 + 示例）、`triggerStateStore.ts`、`pollCommandFetcher.ts`、`electronNotifier.ts`、`runReportReader.ts`（`SessionReportReader`：UUID / realpath / 符号链接 / 512 KB / 10s 超时安全读取，手机网关与 PC 共用） |
| `apps/editor/src/renderer/services/triggers/` | `TriggerRunHost.ts`、`automatedSessionService.ts`、`automatedPermissionPolicy.ts`、`automatedRunWatcher.ts`、`triggerActionExecutor.ts`、`triggerReportEditorInput.ts`（报告标签页的虚拟 EditorInput） |
| `apps/editor/src/renderer/workbench/triggers/` | `TriggerReportEditor.tsx` + module.css（报告标签页：摘要条、状态页、Markdown 正文） |
| `apps/editor/src/renderer/actions/triggerActions.ts` + `triggerPickItems.ts` | 命令面板与 QuickPick 文案 |
| `apps/editor/src/renderer/contributions/` | `TriggersConfigurationContribution.ts`（JSON schema）、`TriggerVerdictContribution.ts`（安装 resolver）、`TriggerRunNotificationContribution.ts`（结束通知） |
| `apps/editor/src/renderer/services/swarm/swarmTriggerReporter.ts` | Swarm 列表 → 触发器上报（同一过滤口径） |

### 文件与状态

| 路径 | 写入方 | 内容 |
| --- | --- | --- |
| `<userData>/triggers/triggers.json` | 用户 / `ensureConfigFile` | JSONC 配置；外部编辑热加载（目录 watcher）。 |
| `<userData>/triggers/state.json` | `TriggerStateStore`（独占） | `pausedAll`、每触发器 `processed`（去重 key）、`paused`、`consecutiveFailures`、`backoffUntil`、`lastScheduledAt`、`lastRunAt`、`lastError`、`baselineDone`、`sourceFingerprint`、`elevatedConfirmed` / `approveConfirmed` 指纹、`pending` 记录。防抖 + 原子写（0600）。加载时丢弃 `runId` 不是 UUID 形态的 pending 记录（会拼进文件路径）。 |
| `<userData>/triggers/audit.jsonl` | `AuditLog` | `action` / `result` / `detail`（标识性文本，无 payload / prompt / 摘要）。每条执行 / 拒绝的动作单独成行。 |
| `<userData>/triggers/runs/<runId>/` | main 建目录，Agent 写文件 | `result.json`、`report.md`；启动新 run 时按 mtime 只保留最近 200 个目录，但**跳过 active / queued / pending 的 runId**。手机端可经网关按会话读取 `report.md`（见 `mobile-gateway.md` §7e），PC 端经 `readRunReport` 按 runId 读取（同一 reader），目录被清理后入口显示空状态。 |
| `<userData>/triggers/pending/<runId>.json` | `TriggerMainService` | 排队事件的临时负载；run 开始或丢弃后删除。 |

`state.json` 里的去重 key 每条最多保留 **2000** 个、**30 天**（`prune`）。

## 3. 配置解析与指纹

`parseTriggersConfig()` 的规则：

- 顶层 `version` 必须是 `1`（缺省可）；`maxConcurrentRuns` 为 1–10 整数；`triggers` 必须是数组。
- 单个触发器：`id` 匹配 `^[a-z0-9][a-z0-9-]{0,63}$` 且唯一；`workspace` 必须是本机绝对路径（含盘符或 `/` 开头，拒绝 UNC / URI）；`source` 必填；`session` 至少要给出 `skill` 或非空 `prompt`。
- `session.cwd` 必须是相对路径、不含 `..`、不含 `:`（Windows 盘符 / ADS），且没有任何段被 Windows 静默改写（trailing `.` / 空格）；`skill` 匹配 `^[A-Za-z0-9][A-Za-z0-9:_-]*$`；`mcpServers` 为非空字符串数组。
- `budget` 三个字段必须是正数（0 不合法）；`allowedActions` 只接受三个枚举值并去重；`concurrency` 1–10；`overflow` 只能是 `queue` / `drop`。
- **已知字段非法 → 整个触发器进入 `invalid`**，其它触发器不受影响；未知字段忽略。
- 顶层非法（JSON 语法、版本、`maxConcurrentRuns` 越界、`triggers` 非数组）→ 整份文件按无效处理：
  - 启动时读坏 → 用空配置；
  - 运行期外部编辑读坏 → 保留上一份有效配置（`JsonConfigFileStore.reload`）。

`triggerFingerprint()` 对触发器配置做**键序无关**的规范化 JSON，再取 FNV-1a 32 位十六进制。高权限模式与自动 approve 的确认都存这个指纹；用户改任何配置字段都会让确认自动失效。

`TriggersConfigurationContribution` 用 `JSONContributionRegistry.registerSchema` 把 schema 绑到该文件 URI，提供补全与校验。注意 schema 与运行时校验的少量差异（见 §12）。

## 4. 启动门控与调度

- `TriggerMainService` 构造即读 `state.json` 与 `triggers.json`，然后 `_armGate()`。
- 门控截止时间 = `max(启动时刻 + 60s, 第一个窗口 host 注册时刻 + 60s)`（`startupGraceMs`）。`--background` 无窗口启动时只有第一项；此时触发会按需开隐藏窗口。
- 门控开放后：
  1. `_replayPendingRuns()` 重放**尚未开始**的排队事件；
  2. `_syncTiming(now)` 计算下一次 schedule / poll；
  3. 只保留**一个** `setTimeout`，指向最近的唤醒点（`_rescheduleWake`）。没有可运行触发器时不再有调度定时器。
- **门控只管定时器，不管手动运行**：`runNow` 直接进入 `_acceptEvent(..., { ignoreBackoff: true })`，不检查 `_gateOpen`，因此启动宽限期内手动「立即运行」也会执行（e2e 依赖该行为）。`_replayPendingRuns` 仍要求门控开放。
- `_applyConfig()` 在配置热加载时清空 `_armedSchedule` / `_nextPoll` 锚点，让新的 cron / 间隔立即生效；已持久化的 `lastScheduledAt` 仍用于错过槽位计算。

### schedule

`scheduler.ts` 是纯函数：`computeDue(source, lastScheduledAt, now, graceMs)` → `{ due, next, skipped }`。

- `lastScheduledAt === undefined`（刚启用）→ 只给下一次，不补跑。
- `everyMin`：按固定间隔计算错过的次数；`cron`：从 `lastScheduledAt` 起枚举到 `now`（上限 10000 个）。
- 计划时刻后 **2 分钟**（`DEFAULT_MISSED_GRACE_MS`）内仍算按时；更早的按 `onMissed`：
  - `skip`：丢弃，只记 `skipped` 日志；
  - `catch-up-once`：只补跑**最近一次**。
- cron 为自写最小解析器：5 字段，本地时间，支持 `*`、`,`、`-`、`/`；日与周同时受限时取 OR；`0` / `7` 都归一到周日；扫描上限 4000 天，找不到返回 `undefined`（日志告警）。
- 事件 key：`schedule:<计划时刻 ISO>`。

实现细节：主进程在「第一次唤醒时 `lastScheduledAt` 还没有该槽位」的情况下，会把当次 armed 时刻补进 due（仅当误差在 grace 内），避免首次启用丢一次。

### poll

- 门控开放后立即安排一次 poll（`_nextPoll = now`），用于建立基线；之后每 `intervalSec` 一次。
- `_runPoll` 先推进 `_nextPoll`，再执行命令；若执行期间触发器被暂停 / 禁用 / 删除，结果丢弃。
- 失败：`_recordFailure`，下一次 poll 取 `max(now + interval, backoffUntil)`。
- 成功但 `baselineDone === false`：把当前所有 `poll:<key>` 记为 `started`，写 `baselineDone: true`，**不产生 run**。
- 之后对每个 item 走 `_acceptEvent`，key 为 `poll:<keyField>`。
- `pollCommandFetcher.ts`：
  - `spawn`（shell）在 `workspace` 下运行，硬超时、`windowsHide`；
  - 超时 / stdout 超过 1 MB 时**杀掉整个进程树**（Windows `taskkill /T /F`，POSIX `detached` 进程组 + `SIGKILL`），避免孙进程继续持有工作区；
  - 接受 JSON 数组或 `{ items: [] }`；
  - item 必须是对象，`keyField` 必须是字符串 / 数字且非空；
  - 其它字段经 `toPayloadValue` 归一：字符串 / 布尔 / 有限数字原样；对象 / 数组 `JSON.stringify` 后截断 4000 字符；`null` / `undefined` 丢弃；
  - 错误文本本地化，不把 stdout 写进日志。

### 失败退避门

`_recordFailure` 写入 `backoffUntil` 后，`_isRunnable` 会把退避期内的触发器视为不可运行（`manual` 事件与用户 `runNow` 除外）：

- schedule：退避中的到期槽位按 **skip** 处理并记日志（`_evaluateSchedule` 仍推进 `lastScheduledAt`，退避结束后从下一槽继续）；
- poll：退避期不执行命令，`_nextPoll` 推进到 `backoffUntil`；
- swarm-review：退避期内上报的事件**不消费**（不标记 processed），退避结束后的下一次上报再正常触发。

`runNow` 传 `ignoreBackoff: true`；`_startRun` 入口重查 `_isRunnable` 时也按 `manual:` 前缀放行退避，所以用户显式「立即运行」不会被退避门挡住。高权限未确认则是**硬阻止**：`_isRunnable` / `_acceptEvent` / `runNow` 都直接拒绝，不会降级到保守档。

### swarm-review

- renderer 的 `SwarmReviewNotificationContribution` 在每次轮询后，经 `SwarmTriggerReporter` 把**当前显示的审核列表**（与通知同一 `_computeDisplayed` 口径，含忽略集、作者过滤、可批准过滤）上报 `reportSwarmNeedsAction`。
- 仅当存在 `enabled && source.type === 'swarm-review'` 的触发器时才上报，避免无触发器时的额外 IPC。
- 上报前为每条审核查一次详情拿 `version`，并连同 `review.updated` 一起上报；按 `review.updated` 缓存。描述截断 2000 字符。
- `updated` 是 approve 的第二道 TOCTOU 守卫：Swarm 在未批准的审核被重新 shelve 时**不会** bump `version`，但会移动 `updated`，只靠 version 识别不出作者推了新改动。
- main 侧：
  - 第一次上报只把所有 `swarm:<reviewId>` 记为 `started` 并设置 `baselineDone`；
  - 之后对未处理的审核 `_acceptEvent`；
  - 多窗口重复上报由持久去重吸收。
- key：`swarm:<reviewId>`；同一审核不再触发（新版本也不重触发）。
- 后台轮询关闭且存在启用的 swarm 触发器时，contribution 弹一次 sticky 提示并提供「开启」按钮（`perforce.swarm.backgroundPoll.enabled`）。

## 5. 去重、排队与事件负载

### 去重状态

`processed: { [key]: { at, status: 'queued' | 'started' } }`：

- **先记 key 再写 pending**：`_acceptEvent` 在 `await writeJsonAtomic` **之前**同步写 `queued`（占位），并发上报不会双双通过去重检查；写盘失败则 `forget(key)` 回滚。
- 启动 / 排队失败、队列丢弃、窗口关闭 / reload 导致失败 → `forget(key)`，之后同一 key 可重新触发。
- 重启后 `pending` 里 status 仍为 `queued` 的记录会重新入队；`started` 的绝不重放。
- 事件负载不写 `state.json`，而是单独写 `pending/<runId>.json`（`TriggerEvent` 的 JSON），run 开始后删除。
- 去重 key 每触发器上限 2000、TTL 30 天。
- `baselineDone` 与 `sourceFingerprint` 绑定：配置热加载时比较 `source` 的归一指纹（poll = `keyField` | `command` | `intervalSec`；schedule = `cron` | `everyMin`；swarm-review / manual = 类型常量）。变化时清空 `baselineDone` 与该触发器 `poll:` / `swarm:` 前缀的去重 key，让新源重新建基线。旧版 state 没有 `sourceFingerprint` 时只补写指纹、不丢已有 key（避免升级即清空历史去重）。

### 队列

`RunQueue` 只做槽位与排队决策：

- 全局上限 `maxConcurrentRuns`；每触发器 `concurrency`。
- 槽位从「会话创建」占到「run 结束」（含等待审批）。
- `overflow: 'queue'`：每触发器队列上限 20；满时丢最旧（`dropped-oldest`），新事件仍入队。
- `overflow: 'drop'`：并发满直接丢弃新事件。
- `setGlobalLimit` / `complete` 会 drain 队列，把可启动项返回给调用方。

## 6. 运行生命周期

```
事件 → _acceptEvent
  ├─ 已暂停 / 全局暂停 / 需确认 → 丢弃
  ├─ 退避中（manual / runNow 除外）→ 丢弃且不标记
  ├─ 去重命中 → 忽略
  ├─ 同步记 queued（占位，防并发双报）
  ├─ 写 pending/<runId>.json + 加入 state.pending（写失败则 forget 回滚）
  ├─ RunQueue.enqueue
  │    ├─ started → _startRun
  │    ├─ queued → 记录
  │    └─ dropped(-oldest) → forget key
  └─ fire onDidChangeTriggers

_startRun
  ├─ 入口再查一次 _isRunnable（暂停 / 禁用 / 待确认 → 释放槽位、forget key、不计失败）
  ├─ 读 pending 事件
  ├─ _resolveHost（找窗口 / 后台开窗 / 等 host）
  ├─ host.isWorkspaceTrusted() → false 则失败（在创建 runDir 之前）
  ├─ 建 runs/<runId>/ 目录
  ├─ _buildRunRequest（渲染 prompt、解析 elevated/approve 确认）
  ├─ host.startRun(request) → { sessionId }（超时 120s；见下）
  │    ├─ 期间 run 已被移除 → host.cancelRun
  │    └─ 成功 → 记 started、删 pending、phase=running、审计 run-start、arm watchdog
  └─ 失败 → _failActiveRun（释放槽、forget key、记失败/退避）
```

`host.startRun` 是反向 RPC，没有自带传输超时。`_startHostRun()` 用 `startRunTimeoutMs`（默认 120s）做 `Promise.race`：超时则上层按失败处理并释放槽位；如果 renderer 之后才启动成功，main 会立即 `cancelRun` 并丢弃该 sessionId，避免出现不在调度器账上的会话。

- **暂停是最终关卡**：`setPaused(id, true)` 清掉该触发器的排队项并 `forget` 其 key（不计失败）；`setAllPaused(true)` 同样清空全部排队项。`state.pending` 里尚未入队的记录不会被删除，恢复 / 全局恢复 / 确认高权限后都会再跑一次 `_replayPendingRuns`，把此前因暂停保留的 pending 记录入队。
- **窗口关闭 / reload**：`unregisterWindowHost` 与同 `windowId` 的**二次 `registerWindowHost`**（renderer reload）都会把它负责的 active run 标为失败（`The window ... closed / reloaded`），释放槽位。
- **running 看门狗**：run 启动后按 `budget.timeoutMin + budget.approvalTimeoutMin + 10 分钟宽限` 设时；到期仍未 `reportRunEnd` → 记失败、释放槽位，并调用该窗口的 `host.cancelRun`（若 host 还在）。`reportRunEnd` 会清掉定时器。
- **运行结束**：renderer `TriggerRunHost` 订阅 `AutomatedSessionService.onDidEndRun`，调 `reportRunEnd`。main：
  - `completed` → 清零失败计数、清退避、更新 `lastRunAt`；
  - `failed` → `_recordFailure`（可能自动暂停）；
  - 其它（预算 / 超时 / 审批超时 / 取消）→ 只更新 `lastRunAt`，不计失败；
  - 所有结果写审计 `run-end`（含 outcome / verdict / actions 摘要）；`end.actions` 的**每条动作再单独写一行 `action`**（trigger / key / run / session / type / target / result / reason），reason 只含校验或执行错误，不含评论正文。

### 窗口路由

`workspaceWindowRouting.ts`（与手机网关共用）：

- `findWorkspaceHost(directory, target)`：在已打开工作区里找与 `workspace` 相同、且已注册 host 的窗口。
- 没有则 `openWindowForFolderInBackground(URI.file(workspace))`（后台模式为隐藏窗口；非后台模式会开出一个不抢焦点的可见窗口）。
- `waitForWorkspaceHost` 轮询直到 host 注册，默认超时 60s；超时 / 开窗失败 / 窗口未暴露 host 都记失败。

## 7. 运行请求与提示词

`_buildRunRequest()` 组装 `TriggerRunRequest`：

- `origin`：`{ triggerId, triggerName, eventKey, runId }`（会写进会话历史）。
- `cwd`：`join(workspace, session.cwd ?? '')`。
- `mode`：配置值或 undefined（renderer 解析保守档）。
- `allowElevatedMode`：仅当 mode 是高权限类**且** `state.elevatedConfirmed === fingerprint`。
- `approveConfirmed`：`allowedActions` 含 `swarm.approve` **且** `state.approveConfirmed === fingerprint`。
- `prompt`：`renderTriggerPrompt(...)` 渲染结果。
- `runDir`：绝对路径；main 已创建。
- `payload`：原始事件负载（动作守卫需要 `reviewId` / `version`；只在 main → renderer IPC 中传递，不写日志 / 审计 / state）。
- `sourceType`：触发器源类型；renderer 只对 `swarm-review` 运行执行动作。

`promptTemplate.ts` 的输出顺序：

1. 有 `skill` 时首行 `/skill`；
2. 用户模板（`{{event.<field>}}` 只允许标量字段；缺失替换为空；值去换行、去 `<>`、截断 200）；
3. 不可信数据声明；
4. `<event-data trigger="..." key="...">` + 键排序后的 payload JSON + `</event-data>`（`</event-data` 会被转义）；
5. 结果文件契约（绝对 `runDir`、`result.json` 字段说明与示例）。

## 8. 自动化会话启动

`AutomatedSessionService.startAutomatedSession()`：

1. 验证同一 `runId` 未启动。
2. `agentId = request.agentId ?? registry.defaultAgentId()`。
3. `requestedMode = request.mode?.trim() ?? CONSERVATIVE_MODE_BY_AGENT[agentId]`（`claude-code → default`，`codex → read-only`）。
4. `requestedMode` 为空 → 抛错：未知 agent 的默认模式未知，必须由触发器显式配置 `mode`，否则无人值守会话可能继承宽松档。
5. 若 `requestedMode` 是高权限类（`isElevatedModeId`，大小写不敏感）且 `allowElevatedMode !== true` → 直接抛错（main 正常不会发这种请求）。
6. `createSession(agentId, { cwd, activate: false, title: '触发器名 · eventKey', automation: origin, automationRunDir: runDir, additionalDirectories: [runDir], mcpServerNames, configDesiredOverrides: { mode, model? } })`。
   - 非 `internal`：会话落盘、进列表、可恢复。
   - `additionalDirectories` 让 Agent 能写 `runDir`。
7. `whenConnected()` → 失败则关闭会话并抛错。
8. `whenConfigOptionsSettled()` → 用 `readSessionModeId()` 读实际 mode（按 id=`mode` 或 mode 类别），**必须与请求值一致**（大小写 / 空白差异不算不一致）；不一致关闭会话并抛错。
9. 建 `AutomatedRunWatcher`，`start()`，`sendPrompt(prompt)`；prompt RPC 结束（成功或失败）时 `notifyTurnSettled()`。

`TriggerRunHost.startRun` 只等「prompt 已发出」，不等整轮结束；结束走 `onDidEndRun`。

## 9. 权限接入点

`acpSessionService.onRequestPermission()` 里，`session.automation !== undefined` 走自动化分支：

1. 先调 `decideAutomatedPermission(params, session.automationRunDir, uriIdentity)`：
   - 只处理 `toolCall.kind === 'edit'`（只自动放行写文件；`delete` / `move` 是破坏性操作，无论指向哪里都不自动放行）；
   - 必须带非空 `locations`、任何路径段都不是 `..`，且**全部**位于 `runDir` 下（用 `IUriIdentityService.relativePathUnder`）；
   - 返回 `allow_once` 的 `optionId`，否则 `undefined`。
2. 自动化会话**不进入**个人自动批准分支（`acpPermissionHandler.tryAutoApprove` 不会被调用），也不进入 Claude 计划权限策略的 `skip` 分支。
3. `_planPolicy(sessionId)` 对自动化会话恒返回 `'manual'`。
4. 计划审批卡的 `autoResolve`（`acp.plan.autoExecute` 倒计时）对自动化会话为 `undefined`。
5. `allow_always` 不提供给卡片（`visibleAutomatedPermissionOptions`）、也没有 `persistAllow`，不会污染个人规则 Memory 层。

因此自动化会话唯一的静默批准是「写 runDir 的一次性 allow_once」；其余全部走人工卡片，等待受 `approvalTimeoutMin` 限制。

> 路径检查只做字面 `relativePathUnder`，不解析符号链接：若 `runDir` 内已有指向外部的链接，写它会被当成 runDir 内写入。当前安全性依赖「自动化会话不能无审批执行命令」——创建符号链接本身要走命令审批（见 §18）。

> 恢复（resume）自动化会话时，`automation` 会随历史字段恢复，`automationRunDir` 不持久化，因此 runDir 自动放行失效，仅保留「个人自动批准 / 计划策略 / allow_always」这些非路径限制。

## 10. 预算与生命周期 watcher

`AutomatedRunWatcher` 每轮 `autorun` 读 session 的 `status`、`usage`、`pendingPermission`、`pendingElicitation`：

- **活跃时间**：`status === 'running'` 且没有挂起卡片时累计；卡片打开期间暂停计时，关闭后继续。
- **费用**：`usage.cost.amount >= budget.maxCostUsd` → `budget-exceeded` + `cancelTurn()`。只有币种为空或 `USD` 时才比较；其它币种不中止运行（汇率换算不可靠），首次遇到时告警一次。
- **审批超时**：卡片从无到有时起一个定时器；卡片关闭即清除；超时 → `approval-timeout` + `cancelTurn()`。
- **状态**：`errored` → `failed`；`closed` → `cancelled`。
- **正常结束**：`notifyTurnSettled()` 且没有挂起卡片 → `completed`。
- `timeoutMin` 由「剩余活跃时间」定时器驱动，每次状态变化重新计算；卡片暂停时重新计时。
- `_finished` 保证每次 run **只有一个终态**；终态后读取 `runDir/result.json`（读不到传 `undefined`），调用注入的 `AutomatedVerdictResolver`，最终 `onDidEndRun`。

`cancelRun(runId)` 直接调 `watcher.cancel()`：先记 `cancelled`，再取消 turn。

## 11. 判决与动作执行

`TriggerVerdictContribution`（`AfterRestore`）把 `createTriggerActionExecutor()` 安装为 `AutomatedSessionService` 的 resolver。

`verdict.ts`：

- `parseVerdict(raw)`：去 BOM / trim；空、非法 JSON、非对象、`verdict` 非法、`summary` 非字符串、`reportPath` 非安全相对路径、`actions` 非数组或项非法 → 失败。`summary` 截断 200。
- 文件缺失 / 空 → executor 兜底 `escalate` + 「未产出结构化结果」；解析失败 → `escalate` + 「未产出结构化结果：<原因>」。
- `validateActions(verdict, options)`：
  - 非 `auto-approve` → 清空 actions，不算拒绝；
  - 逐条检查：类型在白名单、目标等于事件的 `reviewId`（仅当事件携带 `reviewId`）、`swarm.vote` 的 detail 是 `up`/`down`、`swarm.comment` 正文非空且 ≤4000、`swarm.approve` 已确认；
  - 任一拒绝 → 整份判决变 `escalate`、清空 actions，摘要列出原因（截断 200）。

`triggerActionExecutor.ts`：

- 只有判决为 `auto-approve` 才执行动作。
- **只有 `swarm-review` 源执行动作**：`request.sourceType !== 'swarm-review'` 时，`auto-approve` 判决里任何 `swarm.*` 动作都会让整批动作被拒绝并降级为 `escalate`（每条记 `rejected`，reason 为「仅 swarm-review 触发器可执行 Swarm 动作」）。其它判决本来就不执行动作；非 Swarm 动作类型仍只受白名单约束。
- **approve 预检先于所有动作**：`checkApproveGuard()` 在循环前检查本批 actions 里是否有 `swarm.approve`；若有，则要求事件同时带数字 `version` 与数字 `updated`，重新 `SwarmCommands.getReview`，并要求 `canApproveReview(detail.transitions)`、`latestReviewVersion(detail) === version`、`detail.updated === updated`。任一失败 → 整批动作一条都不执行，判决降级 `escalate`（审计里记一条 `swarm.approve` 的 `rejected`）。
  - 放在循环前而不是 `executeApprove` 里，是因为本批自己的 vote / comment 也会移动审核的 `updated`；如果先执行再检查，会把「我们自己的动作」误判成作者 re-shelve。
- `swarm.vote` → `SwarmCommands.vote({ reviewId, vote, version? })`，返回非 `true` 算失败。
- `swarm.comment` → `automatedCommentBody(triggerName, detail)` 加前缀，`SwarmCommands.addComment`。
- `swarm.approve` → 直接 `SwarmCommands.transition({ reviewId, state: 'approved', commit: false })`（守卫已在预检完成）。
- 每条动作结果写 `TriggerActionAudit`（`ok` / `rejected` / `failed` + reason）；预检通过后某条动作执行失败 → 立即停止后续动作并返回 `escalate`（之前的成功动作保留在 audits 里，已执行）；摘要追加「已执行：type@target,...（不可回滚）」。
- main 在 `run-end` 里记录 outcome / verdict / actions 摘要，并对 `end.actions` 的**每条动作再单独写一行 `action`**（trigger / key / run / session / type / target / result / reason）；reason 只含校验或执行错误，**不含评论正文**。

## 12. 会话历史、列表与手机

`AcpSessionHistoryEntry.automation?: { triggerId, triggerName, eventKey, runId, verdict?, summary?, outcome? }`：

- schemaVersion 8；`add()` 时 carry-over，恢复 / 合并不会丢。
- `setAutomationResult(sessionId, result)` 只更新自动化行。
- 历史上限 100；**非置顶自动化行最多 30 条**（`MAX_AUTOMATION_ENTRIES`），超额优先淘汰最旧自动化行；置顶行不受 30 限制。
- `SessionListBody`：⚡ 图标 + tooltip（`acp.sessions.automationBadge`，中文「由触发器 {name} 启动 · {key}」）、判决标签与摘要行；`acpSessionFilterService` 的 `sourceFilter: 'all' | 'manual' | 'trigger'`。
- 手机：`MobileBridgeSessionSummary.automation`（triggerName / verdict / summary / outcome），由 `mobileBridgeProjection.ts` 投影；自动化会话的 attention 事件带 `alwaysNotify: true`，忽略「PC 聚焦时不推送」。该字段属于手机协议 v24（`MOBILE_PROTOCOL_VERSION = 24`）。**手机页面由编辑器网关下发**，随编辑器一起更新，不需要单独发手机端；协议版本不匹配时手机会提示刷新页面。
- 手机「查看报告」：客户端只传 session ref，main 经 renderer 桥取 live `session.automation.runId`，读取固定路径 `<userData>/triggers/runs/<runId>/report.md`。runId / 路径 / `result.json` 不上 wire；run 目录被保留策略清理后返回 404，手机显示「未生成或已清理」。详见 `mobile-gateway.md` §7e。
- PC「查看报告」：`ViewTriggerReportAction` 打开 `TriggerReportEditorInput`（`typeId = 'trigger.report'`，`id = trigger-report:<runId>`，按 runId 去重）→ `TriggerReportEditor` 调 `ITriggerMainService.readRunReport(runId)`（renderer 只传 runId，main 复用 `SessionReportReader` 重建并校验路径），正文用 `MarkdownView` 渲染、`baseUri` 指向 run 目录。摘要优先取 live session / history 的 `automation`，缺失时回退输入快照；`not-found` 时按 `outcome` 区分「运行中」与「未生成 / 已清理」。打开期间订阅 `IAutomatedSessionService.onDidEndRun`，`runId` 匹配时自动重读；另有手动刷新。入口三处：Sessions 行右键（`entry.automation !== undefined`）、AcpSession 标签页右键（scoped context key `acpSessionHasAutomation`）、run 结束通知按钮。

## 13. 通知

- `TriggerRunNotificationContribution` 在发起运行的窗口订阅 `onDidEndRun`：
  - `cancelled` 不通知；
  - `outcome !== completed` → Warning「触发器运行未完成：{name}（{outcome}）」；
  - `verdict === 'escalate'` → Warning「需要你处理：{name} · {summary}」；
  - 其余 → Info「已完成：{name}」；
  - 统一带「打开会话」与「查看报告」两个动作（后者对所有非 `cancelled` 的 run 显示，调用 `workbench.action.triggers.viewReport` 并传 runId / sessionId / triggerName / eventKey）。
- `AgentNotificationContribution` 对自动化会话**抑制通用的 `completed` 提示**（避免与上面的运行结果通知重复）；审批 / 提问 / 错误提示仍照常发送。手机桥消费原始信号，因此手机的完成推送不受影响。
- main 侧 `electronNotifier`：自动暂停用系统 `Notification`（无窗口也能弹）。
- Swarm 后台轮询提示由 `SwarmReviewNotificationContribution` 发一次 sticky 通知。

## 14. 命令

`triggerActions.ts` 的 Action2（category `Triggers`）：

| 类 | 命令 id | 面板名 |
| --- | --- | --- |
| `ListTriggersAction` | `workbench.action.triggers.list` | 触发器: 列出触发器 |
| `RunTriggerNowAction` | `workbench.action.triggers.runNow` | 触发器: 立即运行触发器… |
| `PauseTriggerAction` | `workbench.action.triggers.pause` | 触发器: 暂停触发器… |
| `ResumeTriggerAction` | `workbench.action.triggers.resume` | 触发器: 恢复触发器… |
| `PauseAllTriggersAction` | `workbench.action.triggers.pauseAll` | 触发器: 全部暂停 |
| `ResumeAllTriggersAction` | `workbench.action.triggers.resumeAll` | 触发器: 全部恢复 |
| `OpenTriggersConfigAction` | `workbench.action.triggers.openConfig` | 触发器: 打开配置 |
| `ShowTriggersLogAction` | `workbench.action.triggers.showLog` | 触发器: 查看日志 |
| `ConfirmTriggerElevatedModeAction` | `workbench.action.triggers.confirmElevatedMode` | 触发器: 确认高权限模式… |
| `ConfirmTriggerAutoApproveAction` | `workbench.action.triggers.confirmAutoApprove` | 触发器: 确认自动 approve… |
| `ViewTriggerReportAction` | `workbench.action.triggers.viewReport` | 触发器: 查看触发器运行报告 |

`triggerPickItems.ts` 是纯函数，集中状态 / 来源标签、运行计数、上次 / 下次运行、错误与 ⚠ 标记。`RunTriggerNowAction` 支持直接传 triggerId（供列表 / e2e 调用）。

> 异步 `run` 必须在第一个 `await` 前用 `triggerActionServices(accessor)` 取完 service 快照——`ServicesAccessor` 在 await 后失效（见根 CLAUDE.md 红线）。

## 15. 如何新增一种触发源

1. **契约**：`shared/triggers/types.ts` 的 `TriggerSourceConfig` 加联合分支（若需要新字段）；`TriggerSourceType` 自动派生。
2. **校验**：`shared/triggers/configParse.ts` 的 `parseSource()` 加 case；字段非法时返回错误列表。同步更新 `TriggersConfigurationContribution.ts` 的 `SOURCE_SCHEMA.oneOf`。
3. **事件 key**：在 `TriggerMainService` 里决定稳定 key（例如 `<type>:<唯一标识>`），并保证同一逻辑事件始终得到同一 key。
4. **产生事件**：
   - 时间驱动：在 `_syncTiming` / `_onWake` 里加调度钩子，用 `_acceptEvent(trigger, event)`；
   - 外部上报：在 `ITriggerMainService` 加一个 `reportXxx(...)` 方法（参考 `reportSwarmNeedsAction`），main 负责基线与去重；
   - renderer 采集：写一个 contribution / 服务，只在存在启用触发器时上报。
5. **基线**：若来源会一次性给出历史条目，首次上报必须只记 key、不触发（`baselineDone`）。`baselineDone` 是每触发器一个标记；换源 / 改变 key 语义时要考虑是否需要重置。
6. **失败与退避**：调用 `_recordFailure` 的路径要给出可读错误；轮询类来源把 `backoffUntil` 计入下一次调度。
7. **摘要与 UI**：`TriggerSummary.sourceType` 已用联合类型；`triggerPickItems.ts` 的 `triggerSourceLabel` 加标签，i18n 加 `triggers.source.*`。
8. **测试**：纯逻辑放 `shared/triggers/__tests__/`；调度 / 基线 / 去重放 `main/services/triggers/__tests__/triggerMainService.test.ts`（注入假时钟 + 假 host / 假 fetcher）。

## 16. 如何新增一种动作类型

1. `shared/triggers/types.ts`：`TriggerActionType` 与 `TRIGGER_ACTION_TYPES` 加值（同时用于配置校验与 schema enum）。
2. `shared/triggers/verdict.ts`：`rejectionReason()` 加动作专属守卫（目标、参数、版本、二次确认等）；`validateActions` 的通用校验已覆盖白名单与事件目标。
3. `renderer/services/triggers/triggerActionExecutor.ts`：`executeAction()` 加执行逻辑，返回 `ActionOutcome`；失败 / 拒绝要让整份判决降级。
4. 若需要新的确认机制：参照 `confirmAutoApprove`，在 `TriggerStateStore` 加指纹字段、`ITriggerMainService` 加确认方法、`TriggerRunRequest` 加布尔开关、`_buildRunRequest` 里按指纹解析，并加命令与 QuickPick 动作。
5. 若动作需要执行前重新拉取外部状态（防 TOCTOU）：在 executor 里实现，不要在 Agent 侧做。
6. i18n / 用户文档：动作是用户可见能力，更新 `docs/user/zh-CN/ai-agent/triggers.md`。
7. 测试：`shared/triggers/__tests__/verdict.test.ts` + `renderer/services/triggers/__tests__/triggerActionExecutor.test.ts`（假 `ICommandService` 断言命令 id 与参数）。

## 17. 测试位置与 e2e

单元测试（全部在 `__tests__/`）：

| 域 | 文件 |
| --- | --- |
| 纯逻辑 | `shared/triggers/__tests__/{cron,scheduler,dedupe,runQueue,backoff,configParse,promptTemplate,verdict}.test.ts` |
| main | `main/services/triggers/__tests__/{triggerMainService,triggerFiles,pollCommandFetcher,runReportReader}.test.ts` |
| renderer | `renderer/services/triggers/__tests__/{TriggerRunHost,automatedPermissionPolicy,automatedRunWatcher,automatedSessionService,triggerActionExecutor,triggerReportEditorInput}.test.ts` |
| UI / 集成 | `renderer/contributions/__tests__/{TriggerRunNotificationContribution,SwarmReviewNotificationContribution}.test.ts`、`renderer/workbench/triggers/__tests__/TriggerReportEditor.test.tsx`、`workbench/agents/__tests__/SessionListBody.test.tsx`、`services/acp/session/__tests__/acpSessionHistory.test.ts`、`services/mobileGateway/__tests__/MobileBridgeService.test.ts` |

要点：

- 时间相关全部注入假时钟（`TriggerClock` / watcher 的 `now`/`setTimeout`）。
- main 服务测试用假窗口 host、假 `PollCommandFetcher`、假 `AuditLog`，避免真实文件系统与 Electron。
- 会话启动测试用 `inMemoryAcpPair` 或假 session（见 `services/acp/CLAUDE.md` 测试套路）。

E2E：`apps/editor/e2e/specs/triggers.spec.ts`（`@p0` 冒烟 + 一条 `@regression`）。覆盖：

- 没有 `triggers.json` 时不列出任何触发器、不创建会话；
- manual 触发 → 用 echo agent 建一个 **inactive** 会话（不占用编辑区、不切 active），历史行带 `automation` 溯源，`firstPrompt` 含完整的 `<event-data>` 围栏；
- 高权限 mode 未确认时 `runNow` 拒绝，且不会创建会话；
- 暂停的触发器 `runNow` 拒绝（错误含 paused），且不会创建会话；
- 非法配置条目出现在列表里、带错误、`runNow` 拒绝。

探针（`window.__E2E__`，契约在 `packages/e2e-contract`）：

- `listTriggers()` → `E2ETriggerSummary[]`
- `runTriggerNow(triggerId)` → 只等到事件被接受 / 入队，不等到会话创建（用 `getAcpAutomationRows` 轮询结果）
- `setTriggerPaused(triggerId, paused)` → 从主进程暂停 / 恢复单个触发器（与列表 QuickPick 同一入口），用于验证暂停门控
- `getTriggersConfigPath()` → `<userData>/triggers/triggers.json` 的绝对路径（测试直接写文件）
- `getAcpAutomationRows()` → 带 `automation` 溯源与 `firstPrompt` 的历史行

测试通过 `workspaceSeeder` 固定工作区、`installAcpEchoAgent` 安装假 Agent，不依赖真实计时器、外部 Swarm 或轮询命令。新增场景按 `apps/editor/CLAUDE.md` 套路 F 扩探针（先改 `shared/e2e/contract.ts`，再实现 `probe.ts`）。

验证命令：

```bash
pnpm check
pnpm e2e specs/triggers.spec.ts
pnpm e2e:smoke
```

## 18. 已知限制

- **schema 与运行时校验仍有少量差异**：schema 没有校验 `workspace` 必须是本机绝对路径 / 拒绝 UNC，也不校验 `id` 唯一；两者最终仍由 `parseTriggersConfig()` 兜底（非法条目进入 `invalid`）。`session` required、`budget` 三个正数（`exclusiveMinimum: 0`）、poll 的两种输出形态已与运行时对齐。
- **配置指纹失效范围较大**：改任何字段（包括 `prompt` 文案）都会让高权限 / 自动 approve 确认失效，需要重新确认。
- **恢复自动化会话不保留 runDir 范围**：resume 后写 runDir 不再自动放行（只保留非路径限制）。
- **runDir 自动放行不解析符号链接**：路径检查只做字面 `relativePathUnder`；若 `runDir` 内已有指向外部的符号链接，写它会被当成 runDir 内写入。当前安全性依赖「自动化会话不能无审批执行命令」这一前提——创建符号链接本身要走命令审批（§9）。
- **运行目录保留 200 个**：超出按 mtime 删除，会跳过 active / queued / pending 的 runId，可能早于历史会话上限；需要长期留档请自行复制。
- **工作区级触发器未实现**：只读用户级文件；远程工作区不支持。
- **e2e 只覆盖手动事件路径**：manual / 高权限拒绝 / 非法配置 / 暂停拒绝走真实窗口；schedule / poll / swarm-review 的定时与外部依赖仍靠单测（假时钟 / 假 fetcher / 假 reporter），没有真实端到端用例。

## 19. 关键参考路径

- `apps/editor/src/main/services/triggers/triggerMainService.ts` — 调度、去重、队列、窗口路由、审计
- `apps/editor/src/main/services/triggers/runReportReader.ts` — 运行报告的受限读取（手机网关与 PC 共用）
- `apps/editor/src/shared/triggers/{types,configParse,promptTemplate,verdict}.ts` — 契约、校验、渲染、判决
- `apps/editor/src/renderer/services/triggers/{automatedSessionService,automatedRunWatcher,automatedPermissionPolicy,triggerActionExecutor,TriggerRunHost,triggerReportEditorInput}.ts`
- `apps/editor/src/renderer/workbench/triggers/TriggerReportEditor.tsx` — PC 报告标签页
- `apps/editor/src/renderer/services/acp/session/acpSessionService.ts` — `onRequestPermission` 的自动化分支
- `apps/editor/src/renderer/services/acp/session/acpSessionHistory.ts` — `automation` 字段、30 条上限
- `apps/editor/src/renderer/contributions/{TriggerVerdictContribution,TriggerRunNotificationContribution,TriggersConfigurationContribution}.ts`
- `apps/editor/src/renderer/services/swarm/swarmTriggerReporter.ts` + `SwarmReviewNotificationContribution.ts`
- `packages/extensions-common/src/contracts/swarm.ts` — `SwarmCommands`
- `docs/development/triggers-design.md` — 原始设计（状态已标注被本文取代）
