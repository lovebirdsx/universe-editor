# Bug 录制（bug recording）

本文讲清「用户复现 bug 的过程 → 结构化事件流 + 关键截图 → 证据包 zip」的完整链路：为什么只录命令流不够、事件在哪几个挂点采集、main 状态机如何落盘与组装、脱敏与崩溃兜底的取舍。证据包的首要消费者是 **AI**（喂给模型做根因分析），因此刻意不做回放 UI，重心放在结构化事件流与便于 LLM 阅读的交织时间线。

## 解决什么问题

「导出诊断包」（[error-diagnostics.md](error-diagnostics.md)）是**事后快照**：errors.jsonl、日志尾部、crash dump——能回答「系统当时处于什么状态」，但回答不了「用户当时做了什么」。很多 bug 只在用户环境出现（特定操作序列、特定工作区布局），开发者拿到快照也复现不出来。

Bug 录制补的正是这一环：用户开始录制 → 复现问题 → 停止导出，得到一段按时间排序的**操作步骤流**（命令执行、编辑、编辑器切换、通知、ACP 对话……）加关键节点的**截图**，再配上本 session 的日志与错误记录。AI 拿到包后先读 `timeline.md` 建立时间轴，再按需翻 `events.jsonl` / 截图 / 日志细节——没有回放 UI，也不为人类读者压缩事件流。

## 总览

```
各 renderer 窗口（生产者，每窗口一份）                  main 进程（单一真相）
────────────────────────────────────────────       ─────────────────────────────
CommandService.executeCommand ─失败→ ICommandFailureRecorder
TelemetryClientService.publicLog ─bindRecorder→（30 余处既有埋点零改动入账）
BugRecordingContribution（AfterRestore 挂点）
  · MonacoModelRegistry.onDidAddModel → EditAggregator（1500ms 滑窗聚合）
  · editorService.activeEditor autorun（editorSwitch）
  · notificationService.notifications autorun（error/warning）
  · acpSessionService.sessions → session.timeline（acpMessage/acpToolCall）
      │  BugRecorderClient.recordEvent（fire-and-forget；idle 时静默丢弃）
      ▼
BugRecorderClient（IBugRecorderClient）· status observable 镜像
      │
      ▼  IPC：ServiceChannels.BugRecorder（ProxyChannel）
BugRecordingMainService（单实例状态机，唯一写点）
  · events.jsonl 追加（_writeChain 串行化；落盘时 t = ts − startedAt）
  · 截图：_scheduleScreenshot（触发集 → capturePage → 环形缓冲 25 张 / 1500ms 节流）
      │
      ▼
raw 目录：<logs>/<session>/bug-recording-<stamp>/
      │  stopRecording / exportOrphanRecording（interrupted 标记）
      ▼
buildBugRecordingArchive（纯 fs + adm-zip，无 Electron）
  · 可选逐行脱敏 redactLines · log tails · errors.jsonl · transcripts · environment
  · buildBugRecordingTimeline → timeline.md · redaction.md
      ▼
<userData>/bug-recordings/universe-bug-recording-<stamp>.zip
```

## 架构：单一真相在 main

- **截图必须 main**：`webContents.capturePage()` 只有持 BrowserWindow 的 main 进程能调。
- **zip 组装必须 main**：文件系统、adm-zip、日志 session 目录都在 main 侧。
- **多窗口天然汇聚**：录制全局唯一（一个 main 状态机），所有窗口的事件经 IPC 汇入同一个 JSONL。renderer 侧 `BugRecorderClient` 只是每窗口一份的生产者，`isRecording` 为 false 时 `recordEvent` 直接返回——**不录制时零开销**；录制自身的失败全部吞掉（旁路通道，绝不打扰主流程）。
- **时钟换算在 main**：事件带产生窗口的墙钟 `ts`，落盘时 main 换成相对录制起点的偏移 `t`（`PersistedBugRecordEvent`）——只有 main 知道 `startedAt`。
- **写链与在飞截图**：`_writeChain` 串行化所有 append（失败前的最后几个事件正是包存在的意义，不能丢）；截图 fire-and-forget 进 `_pendingCaptures`，`stopRecording` 先 `_settlePendingWork()` 排干二者，防止 zip 建好后还有文件写入。

接线点：

- 线契约 `apps/editor/src/shared/ipc/bugRecorderService.ts`：`IBugRecorderService` + `BugRecordEventPayload` 判别联合；通道 `ServiceChannels.BugRecorder`。
- main 端：`BugRecordingMainService` 在 `main-services.ts` 以 `registerSingletonFactory(IBugRecorderService, …)` 注册；选项在工厂里注入——`recordingsDir`（`<userData>/bug-recordings`）、`piiPaths`（userData / home / temp / appRoot）、`collectEnvironment`（复用 `IDiagnosticsService.collectIssueReport()`）、`crashDumpsDir`；`setWindowProvider` 在 `index.ts` 晚绑定（WindowMainService 构造在其后），取**焦点窗口**，无焦点窗口返回 undefined。
- renderer 端：`main.tsx` 里 `new BugRecorderClient(ProxyChannel.toService(…))` 注册为 `IBugRecorderClient`，并 `telemetry.bindRecorder(bugRecorder)`、把 bugRecorder 作为 `ICommandFailureRecorder` 传给 `CommandService`。
- 状态同步：main 的 `onDidChangeStatus` 广播给每个窗口，client 折叠成 observable `status`——reload 的窗口会主动 `getRecordingStatus()` 重新加入进行中的录制。

## 三个命令与状态栏

均在 `apps/editor/src/renderer/actions/bugRecordingActions.ts`（Developer 类别、命令面板可见、默认无快捷键）：

| 命令 id | 名称 | 用途 |
|---|---|---|
| `workbench.action.startBugRecording` | Start Bug Recording | 开始录制，把当前工作区 folder 写进 meta；已在录制时仅提示 |
| `workbench.action.stopBugRecording` | Stop Bug Recording and Export Evidence | 三按钮脱敏对话框 → 收集本窗口 ACP transcript 引用 → stop → 通知 zip 路径 / 事件数 / 截图数 |
| `workbench.action.markBugRecordingStep` | Mark Bug Recording Step | 用户标记「就这一刻」：记一条 marker 事件并触发截图 |

状态栏条目由 `BugRecordingContribution._show/_hide` 托管：`addEntry` 的 id 为 `bugRecording`，data-testid 即 `statusbar-entry-bugRecording`（StatusBar.tsx 约定 `statusbar-entry-${entry.id}`）；文案 `$(record) MM:SS` 由 `_ticker` 每秒刷新，prominent 样式 + errorBackground；点击执行 `StopBugRecordingAction.ID`。显示/隐藏由 `BugRecorderClient.status` observable 驱动（多窗口各自订阅、天然同步）。

**去抖中的编辑事件靠 flush participant 收口，不在 `_hide()` 里 flush**：`BugRecorderClient.registerFlushParticipant` 注册的回调由 `stopRecording()` 在**通知 main 打包之前**同步执行，此时状态仍是 `recording`、`recordEvent` 才会接受事件，emit 出的编辑落进 main 的写入链，而 `stopRecording` 会 await 该链再打包。反过来若等 `_hide()`（状态已翻 idle）才 flush，`recordEvent` 会静默丢弃——所以 `_hide()` 只 `dispose()` 聚合器，不 flush。

## 采集策略：为什么只录 command 流不够

命令执行流有几大盲区：Monaco 默认权重的快捷键由 Monaco 自己 dispatch、不进 `CommandsRegistry`；Monaco 自带右键菜单不读 `MenuRegistry`；很多侧栏 UI 直连 service、不经命令系统。只挂命令执行会错过一大半用户操作。因此采集分两层：

**第一层：收口 `ITelemetryService.publicLog`**。`TelemetryClientService.bindRecorder`（`renderer/services/telemetry/telemetryClientService.ts`）把录制器挂进遥测出口——30 余处既有 `publicLog` 埋点（`commandExecuted` / `editorOpened` / `acp.prompt_sent` / `acp.session_created` / `acp.tool_call_started` 等）**零改动调用点**免费入账。`recordTelemetry` 只保留 string/number/boolean 标量值（线契约装不下其它类型）。

**第二层：5 个补充挂点**（集中在 `BugRecordingContribution`，AfterRestore 注册，`renderer/contributions/bugRecordingContribution.ts`）：

1. **命令失败**——`CommandService` 的 `ICommandFailureRecorder`（构造注入，`renderer/services/command/CommandService.ts`）：命令不存在、handler 抛错/拒绝两条路径记 `commandError`。成功路径已由 `commandExecuted` 遥测覆盖，所以只挂失败。
2. **聚合编辑**——`MonacoModelRegistry.onDidAddModel` 挂 `model.onDidChangeContent` → `EditAggregator`（`renderer/services/bugRecording/editAggregator.ts`）：1500ms 滑窗去抖，按 resource 合并成一条 `edit`（count 记次数）。逐击键记录会淹没时间线——复现需要的是「改了哪个文件、改了几次」，不是键序列。
3. **编辑器切换**——`editorService.activeEditor` autorun；文件 input 用 resource，非文件 input（session/settings/webview）用 id。
4. **warning/error 通知**——`notificationService.notifications` autorun + `_seenNotifications` 去重；Info 级跳过，消息截 500 字符。
5. **ACP 对话增量**——`acpSessionService.sessions` autorun → 逐 session 订阅 `session.timeline`；`_acpBaselines` 记订阅时刻的时间线长度，只发订阅后的增量（录制只捕获新回合）。消息截 2000 字符，工具调用 input preview 截 1000（`safeStringify` 兜底不可序列化值）。

## 事件模型

线契约 `BugRecordEventPayload`（`apps/editor/src/shared/ipc/bugRecorderService.ts`）。所有事件带产生窗口的墙钟 `ts`，main 落盘时附加相对 `startedAt` 的偏移 `t`（`PersistedBugRecordEvent`）：

| kind | 字段 | 谁产生 | 时间线渲染 |
|---|---|---|---|
| `commandError` | `commandId`, `message` | CommandService（不存在 / handler 失败） | ⚠ 命令失败 |
| `telemetry` | `name`, `data?`（标量 map） | bindRecorder 镜像 | `TELEMETRY_LABELS` 中文标签，未知名字兜底「遥测 \<name\>」 |
| `edit` | `count`, `resource?` | EditAggregator 聚合 | 「\<file\> 编辑 N 次」 |
| `editorSwitch` | `resource?` | activeEditor autorun | 切换编辑器 |
| `notification` | `severity: 'error' \| 'warning'`, `message` | 通知 autorun（Info 不入） | ⚠ 通知[error] / 通知[warning] |
| `acpMessage` | `sessionId`, `role`, `text` | ACP timeline 订阅 | ACP [用户/助手/思考] … |
| `acpToolCall` | `sessionId`, `title?`, `status?`, `inputPreview?` | ACP timeline 订阅 | ACP 工具 … |
| `marker` | — | markBugRecordingStep 命令 | 📌 用户标记 |
| `screenshot` | `file`, `reason` | main 在截图成功后自行追加 | 截图 \<file\>（原因: …） |

截图事件由 main 写入 JSONL（而非 renderer 发送），时间线与画面因此可互查。`renderEventRow` 对未知 kind 有兜底分支——未来版本新增的 kind 仍能渲染出行，不会让整份报告崩掉；`parseEventsJsonl` 逐行容错，崩溃截断的末行跳过。

## 截图策略

`BugRecordingMainService._captureScreenshot` / `_scheduleScreenshot` / `_evictOldScreenshots`。

触发集（`screenshotReasonFor` + `SCREENSHOT_TRIGGERS` 映射表）：

| 触发 | reason |
|---|---|
| 录制起始（startRecording） | `start` |
| commandError 事件 | `commandError` |
| error 通知 | `errorNotification` |
| telemetry `acp.prompt_sent` | `agentPrompt` |
| marker 事件（手动标记命令） | `marker` |

- **25 张环形缓冲**（`DEFAULT_MAX_SCREENSHOTS`）：超出后按文件名序号删最旧（`_evictOldScreenshots`）。
- **1500ms 最小间隔**（`DEFAULT_MIN_SCREENSHOT_INTERVAL_MS`）：间隔内**跳过截图但事件照记**——节流不能丢掉步骤。
- **尺寸与质量**：宽度 > 1600 时 resize 到 1600（`DEFAULT_SCREENSHOT_WIDTH`），JPEG 质量 80（`DEFAULT_SCREENSHOT_QUALITY`）。
- **无窗口静默跳过**：`windowProvider()` 返回 undefined（无焦点窗口）或 capturePage 失败只 warn——截图是尽力而为，绝不拖垮录制。
- 打包时（`buildBugRecordingArchive`）过滤指向已被环形缓冲淘汰的 screenshot 事件——timeline 绝不引用包里没有的文件（e2e 有此守护断言）。

## 证据包结构

停止（或孤儿导出）后产物为 `<userData>/bug-recordings/universe-bug-recording-<stamp>.zip`（stamp 为 ISO 时间；非 E2E 下 `revealInShell` 在文件管理器中定位）：

```
universe-bug-recording-<stamp>.zip
├─ events.jsonl                # 每行一条 PersistedBugRecordEvent（含 t 偏移）——机器可读的事实流
├─ timeline.md                 # 面向 AI 的报告：概览行、事件表、错误汇总 Top 10、日志摘录、ACP 清单
├─ screenshots/NNNN.jpg        # 环形缓冲保留的最后 ≤25 张截图
├─ logs/<sessionId>/...        # 本 session 各 .log 文件尾部 512KB（含 window-<id>/ 子目录，复用 collectSessionLogTails）
├─ errors-<sessionId>.jsonl    # 本 session 的 errors.jsonl（不存在则省略）
├─ transcript-<n>-<title>.jsonl # ACP 对话完整文件（≤5 个，各截尾 2MB；标题净化成安全文件名）
├─ environment.md              # 环境信息（复用 IDiagnosticsService.collectIssueReport()）
├─ crash-dumps.txt             # crash dump 清单（配置了 crashDumpsDir 时）
└─ redaction.md                # 脱敏说明（含「录制被异常中断」声明）
```

`timeline.md` 由纯函数 `buildBugRecordingTimeline`（`main/services/bugRecording/bugRecordingReport.ts`）生成：按 `t` 排序渲染每个事件；commandError / error 通知聚合出「错误汇总」（同消息 ×N + 首次/最近 t）；日志摘录取 error/warn 行去重（`extractLogExcerpt`，最多 200 行）。文案密度优先于散文——读它的是模型。

## 脱敏

**默认不脱敏**。对话框主按钮是「Save Evidence」：脱敏是有损变换，而它抹掉的恰恰是复现最常依赖的字符串（特定路径、用户名）。用户必须主动选「Redact and Save」才丢失这些线索。

停止录制弹三按钮对话框（`askRedaction`，`bugRecordingActions.ts`）：Save Evidence（primary）/ Redact and Save（secondary）/ Keep Recording（cancel；孤儿导出流程里取消按钮是 Not Now）。对话框 detail 里明说「截图无法脱敏」。

实现要点（`bugRecordingArchive.redactLines`）：

- **逐行**调 `redactErrorText(line, { piiPaths, maxLength: 64_000 })`。必须逐行：`redactErrorText` 默认 `maxLength` 是 8192（VSCode 遥测上限），**整段传入会把 JSONL 长行截断成半截 JSON，事件流变得不可解析**——这里显式传大值只约束病态单行。e2e 有断言：脱敏后 events.jsonl 每一行仍可 `JSON.parse`。
- `piiPaths` 在 `main-services.ts` 工厂里组装：userData / home / temp / appRoot。掩码规则即 [error-diagnostics.md](error-diagnostics.md) 所述（路径 → `<pii>`/`<path>`、OS 用户目录 → `<user>`、凭据 → `<secret>`）。
- **截图无法脱敏**——它们是画面快照。对话框、redaction.md 与 timeline.md 三处都明说。
- transcript / environment / log tails / errors 与 events 走同一套逐行脱敏；redaction.md 写清「脱敏可能抹掉定位 bug 的关键线索」。

## 崩溃兜底

录制期间崩溃或强杀，`stopRecording` 不会执行——但 raw 目录已落在当前 log session 目录（`<logs>/<session>/bug-recording-<stamp>/`），磁盘上该有的都在，还顺带享受 `LogMainService.cleanupOldLogs` 的 20-session 自动回收，不会无限堆积。

下次启动时 `BugRecordingOrphanContribution`（AfterRestore）调用 `consumeOrphanRecording()`：main 倒序扫描 log root 下各 session 找 `bug-recording-*` 前缀目录（`_findOrphan`），统计事件数与截图数。**consume-once**：扫描只做一次并缓存结果，导出后清空——多窗口启动只有第一个窗口能完成导出。

提示为 sticky warning 通知（带中断时间与事件数）+「Export Evidence Bundle」action → `askRedaction`（Not Now）→ `exportOrphanRecording`。导出与正常 stop 完全共用 `buildBugRecordingArchive`，区别只有：

- `interrupted: true`：`endedAt` 取 events.jsonl 的文件 mtime（`_lastWriteTime`）而非当前时间；
- timeline.md 顶部加「⚠ 本次录制被异常中断」横幅，redaction.md 加「录制被异常中断」声明——崩溃本身就是最值得抓的 bug，别让读包的人误以为流程完整。

## 如何扩展

**加一种新事件 kind** 需要动三处（按顺序）：

1. **线契约**：`shared/ipc/bugRecorderService.ts` 的 `BugRecordEventPayload` 判别联合加成员；若新事件需要截图，`BugScreenshotReason` 也在此。
2. **产生事件的挂点**：新挂点调 `BugRecorderClient.recordEvent`（或复用既有 `publicLog` 埋点走遥测镜像）；截图触发在 `bugRecordingMainService.ts` 的 `screenshotReasonFor` 加映射（遥测名字触发的加进 `SCREENSHOT_TRIGGERS`）。
3. **时间线渲染**：`bugRecordingReport.ts` 的 `renderEventRow` 加分支（不加也有兜底行，不会崩）；需要中文标签的加进 `TELEMETRY_LABELS`；若应计入错误汇总，改 `buildErrorSummary`。

改完在 `bugRecordingReport.test.ts` 的「renders a row per event kind」用例补一行，再跑 `pnpm check`。

## 测试与验证

- **main 单测**（vitest project main，node 环境）：
  - `src/main/services/bugRecording/__tests__/bugRecordingMainService.test.ts`——状态机（idle→recording→idle）、事件落盘与 `t` 换算、截图节流 / 环形缓冲 / 无窗口跳过、stop 组装 zip、孤儿发现与导出。`fakeCaptureTarget` 桩掉 capturePage，测试不依赖 Electron。
  - `src/main/services/bugRecording/__tests__/bugRecordingReport.test.ts`——timeline.md 每种 kind 的行渲染、错误汇总聚合、`parseEventsJsonl` 容错、`extractLogExcerpt` 去重截断。
- **renderer-node 单测**：
  - `src/renderer/services/bugRecording/__tests__/bugRecorderClient.test.ts`——状态镜像（reload 窗口重新加入进行中的录制）、idle 丢弃、telemetry 标量扁平化。
  - `src/renderer/services/bugRecording/__tests__/editAggregator.test.ts`——滑窗去抖、多 resource 合并、flush/dispose 语义。
  - `src/renderer/actions/__tests__/bugRecordingActions.test.ts`——askRedaction 三按钮映射、对话框必须写明「截图无法脱敏」、collectTranscripts 截断。
- **e2e**（`apps/editor/e2e/specs/smoke.bugRecording.spec.ts`，@p1，冷启 fixture）：两条用例——① 全链路：开始录制 → 状态栏条目出现 → 失败命令 + 手动 marker（顺带触发截图）→ stop(不脱敏) → zip 含 timeline.md / events.jsonl / environment.md / redaction.md，事件流含 commandError / marker，且 timeline 引用的截图文件都在包里（计数一致）；② 脱敏：stop(脱敏) 后 userData 路径被掩码、**events.jsonl 每行仍可 JSON.parse**（守护「整行截断」这个坑）。

跑法：

```bash
pnpm --filter @universe-editor/editor test:unit                   # 全部单测（聚合 3 project）
pnpm --filter @universe-editor/editor exec vitest --project main    # 只跑 main 侧
pnpm --filter @universe-editor/editor exec vitest --project renderer-node
pnpm e2e specs/smoke.bugRecording.spec.ts                           # e2e（自动先 build）
```

## 已知限制

- **多窗口时 transcript 只收集停止所在窗口的 ACP 历史**：`StopBugRecordingAction` 用本窗口 `IAcpSessionHistoryService.list()`，其它窗口的对话不打包（其增量事件仍照常入流）。
- **脱敏是 best-effort**：`piiPaths` 只含本机 userData / home / temp / appRoot，远端工作区（remote authority）的 home 路径不会被掩码。
- **脱敏会误伤形似绝对路径的字符串**（如 `X:/workspace` 形态的普通文本），选择脱敏即接受这一有损变换。
- **裸凭据串可能漏网**：`redactErrorText` 靠「键名 + 形状」两类特征识别密钥——`apiKey=` / `"apiKey":` / `*_AUTH_TOKEN=` / `x-api-key:` 这类带键名的会被掩码，`sk-*` / JWT / GitHub token 这类有公认前缀的按形状掩码；但一个**自定义前缀、且不带任何键名**的裸 token（例如日志里孤零零一行 `ak-1abc…`）与普通标识符在正则层面无法区分，不会被掩码。这是「宁可漏掩码也不要把正常文本掩成 `<secret>`」的取舍——真正的红线（密钥绝不进日志、绝不进 AI Debug）在产生端就已守住，脱敏只是二道防线。
- **只打包当前 session 的日志**：log tails 与 errors.jsonl 都取自录制所属的 session 目录，跨 session 的历史日志不在包内。
- **截图尽力而为**：`stopRecording` 最多等在途截图 `settleCapturesTimeoutMs`（默认 5s），超时即放弃它们并照常打包——卡死的 GPU 进程不该把整份证据包一起拖死。

## 关键文件

- `apps/editor/src/shared/ipc/bugRecorderService.ts` — 线契约：`IBugRecorderService` + `BugRecordEventPayload` 事件模型
- `apps/editor/src/main/services/bugRecording/bugRecordingMainService.ts` — main 单一真相：状态机、JSONL 追加、截图触发/节流/环形缓冲、孤儿发现
- `apps/editor/src/main/services/bugRecording/bugRecordingArchive.ts` — zip 组装、逐行脱敏管线、redaction.md 文案
- `apps/editor/src/main/services/bugRecording/bugRecordingReport.ts` — timeline.md 生成、`parseEventsJsonl`、日志摘录（纯函数）
- `apps/editor/src/main/services/log/logTails.ts` — session 日志尾部收集（与诊断包共享）
- `apps/editor/src/renderer/services/bugRecording/bugRecorderClient.ts` — renderer 生产者：状态镜像 + idle 丢弃
- `apps/editor/src/renderer/services/bugRecording/editAggregator.ts` — 编辑聚合（滑窗去抖）
- `apps/editor/src/renderer/contributions/bugRecordingContribution.ts` — 挂点 + 状态栏条目
- `apps/editor/src/renderer/contributions/BugRecordingOrphanContribution.ts` — 崩溃兜底提示
- `apps/editor/src/renderer/actions/bugRecordingActions.ts` — 三个命令 + 脱敏对话框 + 导出通知
- `apps/editor/src/renderer/services/telemetry/telemetryClientService.ts` — `bindRecorder`（遥测收口）
- `apps/editor/src/renderer/services/command/CommandService.ts` — `ICommandFailureRecorder`（命令失败挂点）
