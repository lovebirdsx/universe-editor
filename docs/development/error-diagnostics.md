# 错误收集与诊断机制

本文讲清编辑器「报错 → 收集 → 聚合 → 诊断导出」的完整链路：错误在哪里被捕获、怎么折叠去重、脱敏规则、落盘格式，以及崩溃与「报告问题」流程如何复用这套基础设施。对齐 VSCode 的 errorTelemetry / Issue Reporter 思路，但全部**纯本地**（无网络遥测）。

## 总览

```
renderer 未捕获异常 / 服务埋点                main 进程异常
 window.onerror / onunhandledrejection       uncaughtException / unhandledRejection
 ACP 等 publicLogError(...)                  child-process-gone / render-process-gone / 异常退出哨兵
        │                                            │
        ▼                                            ▼
 onUnexpectedError（platform errors.ts 单入口）        │
 setErrorTelemetryHook → ITelemetryService            │
        │                                            │
        ▼                                            ▼
 TelemetryClientService（renderer）          ErrorSinkMainService.recordLocal
  · computeErrorDedupKey 折叠 + count                 │
  · 同 tick 合并，一次 IPC                            │
        │                                            │
        └──────────── IPC (ErrorSink 通道) ──────────┤
                     （source 由 main 按窗口权威注入） │
                                                     ▼
                              ErrorSinkMainService（main，5s 批量 flush）
                                · redactErrorText 脱敏（piiPaths 单点）
                                · AggregationBuffer 按 fingerprint 再折叠
                                                     ▼
                        <userData>/logs/<session>/errors.jsonl（每行一条 JSON）
                                                     ▼
        IDiagnosticsService ── collectIssueReport()（markdown 摘要）
                            ├─ exportDiagnosticsZip()（诊断包 zip，弹文件管理器）
                            └─ createDiagnosticsZip()（同产物不弹，供 tracker 上传）
                                                     ▼
        IIssueReporterService（可插拔 provider：tracker / github）
          tracker：上传 zip → 拼 addPost 预填 URL（可带附件）
          github：issues/new?body=... 预填 URL
                                                     ▼
              「帮助: 报告问题…」/「帮助: 导出诊断包…」/ 异常退出启动提示
```

## errors.jsonl 格式

每个进程启动一个 session 目录（`logs/YYYYMMDDTHHmmss/`），`errors.jsonl` 在其根，一行一条 JSON：

```json
{
  "v": 1,
  "ts": 1730000000000,
  "event": "unhandledError",
  "source": "renderer:2",
  "fingerprint": "sendPrompt@session/acpSession.ts",
  "count": 7,
  "message": "ENOENT: open '<pii>/x.txt'",
  "stack": "Error: ...\n    at sendPrompt (<pii>/acpSession.ts:412:15)",
  "sessionId": "renderer-bootstrap-uuid",
  "appVersion": "0.2.0",
  "dimensions": { "sessionId": "acp-session-id", "attempt": 2 }
}
```

- `fingerprint`：稳定短指纹（首帧 `func@两段路径`，无栈时归一化消息），**跨版本聚合的主键**。
- `count`：本行折叠了多少次相同错误——同一错误不会刷文件。
- `source`：`main` 或 `renderer:<windowId>`，**由 main 侧权威注入**（per-window 包装 `createWindowScopedErrorSink`），renderer 不能伪造。
- `appVersion`：同样 main 注入，不信任 wire。
- `dimensions`：埋点方附带的标量维度（如 ACP 的 sessionId / agent 种类），最多 10 个键、字符串截 200。
- 写入语义：5s 批量 flush（VSCode `ERROR_FLUSH_TIMEOUT` 同款）、`will-quit`/dispose 时 flush、**文件只增不改**，崩溃截断的末行在读取端跳过。

## 折叠与去重（三层）

1. **renderer 端**（`TelemetryClientService`）：`computeErrorDedupKey`（归一化栈帧序列，无栈时归一化消息）为 key 的 `AggregationBuffer`，同 key 只加 `count`；同一 tick 的错误合并成一次 IPC。
2. **main 端**（`ErrorSinkMainService`）：renderer 来的记录按 `source|event|fingerprint` 再折叠一道（防多窗口/跨 tick 重复），main 自己的错误在 `recordLocal` 里先算指纹再进同一个 buffer。
3. **用户可见层**：未捕获异常的 sticky toast 按指纹 5s 冷却去重（`main.tsx` 的 `setUnexpectedErrorHandler`），并带「复制详情」action（message + stack 进剪贴板，用户反馈不再要 DevTools）。

## 脱敏（统一在 main 落盘前）

`redactErrorText`（`packages/platform/src/telemetry/errorRedaction.ts`）：

- **piiPaths 精确替换**（长路径优先）：`userData` / `userHome` / `appRoot` / `temp` / `logs` 根 → `<pii>`。
- **可归因路径保留尾部**：含 `node_modules` / `extensions` 的路径遮蔽头部、保留包名尾部（`<path>/node_modules/some-pkg/...`），便于归因到第三方。
- **OS 用户目录**：`C:\Users\x` / `/Users/x` / `/home/x` → `<user>`；其余绝对路径 → `<path>`。
- **凭据逐行清洗**：JWT、`sk-*`、GitHub token（`ghp_`/`github_pat_` 等）、`Bearer ...`、`apiKey=...` 等 key=value 形态 → `<secret>`；逐行处理保证一条密钥不吃掉整段栈。
- **长度**：默认 8192 截断（VSCode 遥测值上限）。

指纹在去敏**之前**计算（`shortStackPath` 只留两段路径，天然安全）；落盘的 message/stack 全部过脱敏。renderer 发原文经 IPC 到 main（同机，无网络），**脱敏单点收口在 main**。

## 配置门控

`telemetry.errorCollection.enabled`（默认 `true`，SettingsContribution 注册）：关闭后 renderer 端 `publicLogError` 直接丢弃且清空待发 buffer。main 侧错误记录不门控——内容与 `main.log` 本就写的文本日志等价，只是结构化副本。全程无网络发送。

## 崩溃闭环

- **minidump**：`crashReporter.start({ uploadToServer: false })`，dump 在 `<userData>/Crashes/`（纯本地）。
- **异常退出哨兵**：`session-sentinel.json`（arm/will-quit disarm）。下次启动发现残留 → `readAbnormalExitReport` 关联该时段的 dump → 写 main.log + `errorSink.recordLocal('abnormalExit', ...)`，并把报告交给 `DiagnosticsMainService`；renderer `AbnormalExitNotificationContribution`（AfterRestore）**消费一次**弹出 sticky 警告 +「打开崩溃目录」action（多窗口只有第一个提示）。
- **连续崩溃计数与跳过恢复**：哨兵 JSON 带 `priorAbnormalExits`（arm 时写入当前 streak），残留被读出时 `consecutiveAbnormalExits = prior + 1`，正常退出删哨兵即归零——无额外状态文件。`shouldOfferRestoreSkip`（阈值 2）判定命中且会话列表有待恢复工作区时，main 在 `restoreSession` 前弹原生对话框提供「跳过恢复（打开空窗口）」，选跳过则清空 sessionList 以空窗口启动（recent 列表不动，目录仍可重进）；默认按钮为正常恢复，**E2E 下跳过弹框**（原生模态会卡死驱动）。用于打破「恢复的工作区本身导致崩溃（如海量文件目录 OOM）」的死循环。
- **renderer 崩溃**：`render-process-gone`（非 clean-exit）→ 记 errors.jsonl（`renderProcessGone`，source=`renderer:<id>`）+ 模态对话框「重新加载 / 关闭窗口」，`_crashHandled` 去抖防崩溃风暴叠弹窗；**E2E 跳过模态框**（崩溃直接挂测试，不挡驱动）。对话框是**窗口模态**，没人点就永远不 resolve（曾出现黑屏 15 分钟），因此 20s 无人应答即自动重载（`CRASH_RELOAD_TIMEOUT_MS`）；5 分钟内崩 3 次（`CRASH_STORM_THRESHOLD`）则不再自动重载、只留对话框——重载会重跑把它搞崩的恢复流程，风暴下自动重载比黑屏更难收拾。GPU/utility 进程死亡走 `child-process-gone` 同样入 sink。
- **unresponsive**：仅日志（Windows 锁屏会误报，不弹窗）。
- **内存增长曲线**：`processMetrics` 日志通道每 30s 采一行（`heapUsed` 超 512MB 或某个 renderer 工作集超 2GB 时加密到 10s）：`pid=… type=… mem=…MB cpu=…%`（`app.getAppMetrics()`，OS 工作集）+ `main-heap heapUsed=…MB heapTotal=…MB external=…MB rss=…MB`（main 自身 `process.memoryUsage()`；工作集看不到 V8 堆膨胀——main OOM 时工作集可能只有百余 MB）。`heapUsed` 超 1.5GB 时该行升级为 warn。
- **托管进程树**：`app.getAppMetrics()` **只覆盖 Electron 自己的子进程**。extension-host / acp-agent 是 `child_process.spawn` 的 Node 进程，根本不在其中——一次线上崩溃里 3.71GB 的 extension host 因此在内存曲线上完全不可见。故另有每 60s（有进程超 2GB 时 15s）一行的 `hosted-processes cnt=… name#pid=…MB/…%`，走 `processMonitor` 的进程树（含 `ProcessRoleRegistry` 角色名）。**名字在写出前过 `redactProcessName`**（`services/processMonitor/processNameSafety.ts`）：`findName` 的兜底是**完整命令行**，而 spawn 的子进程命令行带着 `--mcp-config '{"env":{"API_KEY":…}}'`——只放行角色名（`window (window-4)`）与可执行文件名（`cmd.exe`），连可执行名都提不出来时写 `unknown-process`。同一规则也用在 `formatProcessList`（剪贴板 + 诊断包 `processes.txt`）；进程管理器 UI 读 `resolveProcesses()`，展示仍保留完整命令行。
- **无 dump 时的死因取证（三态）**：`crashDumps.length === 0` 时 main **并行**取两个证人——Windows 事件日志（`wevtutil`，仅 win32）与上一会话自己的 `processMetrics.log` 尾部（全平台）——再交纯函数 `concludeAbnormalExit` 出**一条**结论行（结论放最后，读日志尾巴的人最后看到的就是判定）。三态：有 dump 或事件日志里有 crash/hang/WER 崩溃记录（1000 / 1002 / `APPCRASH` / `MoAppCrash`）→ `native-death`；事件日志**查过且无**这类记录 → `external-termination`；**没查成**（win32 上 `wevtutil` 失败）或非 win32 → `indeterminate`。故 `undefined`（没查成）与 `[]`（查过无匹配）必须分开——把「查询失败」渲染成「likely terminated externally」正是本模块要根除的错误。1001 是**容器事件不是判决**，按 `EventData[2]` 的事件名分类：`RADAR_PRE_LEAK_*` 这类内存增长预警是**信息级前兆而非崩溃证据**，单独成行标 `precursor (not crash evidence)`，既不升级成 `error`、也不会挤掉正确判定；认不出的事件名一律归 `other`（绝不把不认识的东西升级成证据）。写进 sink 的 `record` 只含分类值（`verdict=…; wer=…; scene=…`），不含时间戳/MB/路径，否则每次启动都是新指纹、永远折叠不了。`index.ts` 那句 `no crash dump found` 不再自带归因——归因只此一处。缝合进结论行的现场叙述也只在数据支持时才说 `still over its … line`——判据是**末次读数 > 阈值**，不是「曾被标记过」；真机那次末次采样已回落到 687MB，说它「仍在线之上」会把复盘引向一个数据不支持的 OOM 归因。
- **读侧回放（上一会话现场）**：`readExitScene(logsRoot, previousSessionId)` 只读 `processMetrics.log` **尾部 512KB**，0 样本时回退 `rotated/` 最新分片并标 `source`；**字节窗口与行数上限（4000 行）任一触发都置 `truncated`**——行上限静默丢头会让一个 9GB 的 renderer 整条消失、`scene` 维度回落成 `calm`，两种截断都必须可见（行尾加 `(tail only)`）。解析**独立于写侧**：阈值从警告行里自描述的 `renderer working set above 2048MB` / `above 2048MB: <name>#<pid>` 读出来，写侧改了阈值读侧自动跟随。**合并键 = (pid, 化身)**：`window (window-4)#29676=2747MB/0%` 提供 pid→窗口归属，与 `pid=29676 type=Tab mem=…` 合成同一条目，于是能直接报出「renderer pid 29676 (window-4) 峰值 2747MB、末次采样 687MB、50 个采样压在 12:02:42→12:10:48」；同一 pid 换了窗口号即判为 pid 被回收、另起条目，否则会把关掉那个窗口的峰值与超线区间算到新窗口头上。末次采样与 sentinel 心跳的 Δ 把死亡时刻从 60s 心跳粒度收紧到采样粒度（实测那次是 `+1s`；采样早于心跳时写「Nmin before the last heartbeat」而不是印一个负号）。时间戳解析顺序 ISO → `HH:mm:ss.SSS` → `HH:mm:ss`（`logging.timestampFormat` 可改），用会话目录名补日期并解跨午夜；全失败则时间字段留空、**内存事实照出**并在行尾自曝原因。spawn 的子进程不在 `app.getAppMetrics()` 里、只有进程树有，这一非对称正是「托管进程」与 Electron 自己的 GPU/utility 的分界。进程名只保留两种安全形状——角色名原样（`window (window-4)` / `tsserver`），其余压成可执行文件名（`cmd.exe /d /s /c …` → `cmd.exe`）——因为进程树对未登记的 child 写的是**完整命令行**，那些命令行带 `--mcp-config '{"env":{"API_KEY":…}}'`；连可执行名都提不出来（首 token 就是 `--api-key=…`）时宁可不命名。回归测试断言 `JSON.stringify(scene)` 不含凭据，并覆盖五种命令行形状。
- **renderer 堆水位**：见 [memory-pressure.md](memory-pressure.md)。

## 「报告问题」链路

命令 `workbench.action.openIssueReporter`（**帮助: 报告问题…**，VSCode 同名 ID 对齐）。上报目标是**可插拔 provider 架构**（platform 出契约 + Registry，main 出实现，renderer 走 `IIssueReporterService` 门面，对标 AI provider 三层）：

1. renderer `runReportIssueFlow`（`services/issueReporter/reportIssue.ts`）读 `issueReporter.provider`（默认 `tracker`，可切 `github`）选 provider；`IDiagnosticsService.collectIssueReport()` 生成 markdown（版本 / 系统信息 / 已装扩展 / **errors.jsonl 最近 2 个 session 的错误指纹 Top 10**）并复制进剪贴板。
2. provider 支持附件时（tracker）QuickPick 询问是否附带诊断包；随后 `buildIssueUrl(providerId, payload)` 在 **main 端**完成上传与拼 URL，renderer 只负责 `opener.open(url)`。URL 超 7500 字符时两个 provider 都降级为粘贴提示（VSCode 同款）。
3. **tracker provider**（`main/services/issueReporter/providers/trackerProvider.ts`）：附带时先 `createDiagnosticsZip()`（与 `exportDiagnosticsZip()` 同产物但不弹文件管理器），再按所配置服务的上传接口 POST 上传 zip，拼 `addPost` 预填 URL（board/category/content/attachments 参数；标题留空由用户在页面填）。端点与板块走 `issueReporter.tracker.serverUrl/appUrl/board/category` 设置（默认值见 `shared/issueReporter.ts` 的 `TrackerDefaults`；`serverUrl` / `appUrl` 默认为空 = 未配置，此时上报流程抛「not configured」错误，需先配置），由 renderer 读配置经 `providerOptions` 传给 main。上传失败 → 错误通知 +「不附带诊断包直接打开」降级 action。
4. **GitHub provider**：纯拼 `issues/new?body=...`，不支持附件。
5. `exportDiagnosticsZip()`（独立命令 `workbench.action.exportDiagnostics`）：`<userData>/diagnostics/universe-diagnostics-<ts>.zip`，含 `sysinfo.md` + 最近 2 session 的 `errors-*.jsonl` + 各日志文件**尾部 512KB** + `crash-dumps.txt`（dump 清单，行尾标注 included/skipped）+ `crashes/` 下**最新最多 2 个 dump 本体**（单文件 64MB 上限，读失败静默跳过）+ `processes.txt`（进程树）+ `memory.txt`（main 堆 + 托管进程树内存 + renderer 堆曲线尾部 32 条）+ `ipc-frames.txt`（main 侧 IPC 帧环形记录，见 [memory-pressure.md](memory-pressure.md)）。E2E 下不弹系统文件管理器（`revealInShell`）。

**加新上报目标**：实现 `IIssueReporterProvider`（platform `issueReporter/`），在 `IssueReporterMainService` 构造函数里加一行 `registerProvider`；若需要设置项，在 `shared/issueReporter.ts` 加键 + `SettingsContribution` 的 `issueReporter` 节点加 schema + `reportIssue.ts` 的 payload 组装处补 `providerOptions`。

## 开发者指引

- **加错误埋点**：服务里注入 `ITelemetryService` 调 `publicLogError('<domain>.<event>', { error: message, ...标量维度 })`；未捕获异常不用手动报（`onUnexpectedError` 钩子已覆盖）。预期内的用户错误用 `ErrorNoTelemetry` 豁免（platform errors.ts），取消用 `CancellationError`。
- **让 main 侧某异常入 sink**：拿 `ApplicationServices.errorSink`（或 bootstrap 期的模块级实例）调 `recordLocal(event, error)`。
- **改脱敏规则 / 指纹算法 / flush 间隔**：platform 三件套（`errorFingerprint.ts` / `errorRedaction.ts` / `errorAggregation.ts`）均为纯函数，改完先跑 `packages/platform` 的 telemetry 测试；sink 的 `flushIntervalMs`/`filePath` 是构造注入的测试缝。
- **未来接网络遥测 sink**：实现 `ITelemetrySink` 注册进 `TelemetrySinkRegistry` 即可；本地 jsonl 链路不变。

## 测试与验证

- platform 三件套：`packages/platform/src/__tests__/telemetry/`（指纹归一化 / 脱敏 / 折叠）。
- main sink：`src/main/services/telemetry/__tests__/errorSinkMainService.test.ts`。
- renderer 客户端：`src/renderer/services/telemetry/__tests__/telemetryClientService.test.ts`。
- 崩溃恢复 / 诊断：`windowMainService.test.ts`（crash recovery 组）、`diagnosticsMainService.test.ts` / `diagnosticsReport.test.ts`、`AbnormalExitNotificationContribution.test.ts`。
- 异常退出取证三件套：`src/main/__tests__/werForensics.test.ts`（1001 按 `EventData[2]` 分类、认不出的事件名不升级、真机 23 字段 payload 的残留路径不得进 detail、`undefined` 与 `[]` 的契约）、`exitSceneForensics.test.ts`（真机形态回放 / 字节与行数两种截断 / `rotated` 回退 / 跨午夜 / pid 回收 / 阈值取首个 / 五种命令行形状脱敏）、`abnormalExitConclusion.test.ts`（三态判定；泄漏预警不得成为崩溃证据；**末次采样已回落时不得说 still over its line**；同形态不同时间戳与内存值产生**同一** `record`）。
- E2E：`e2e/specs/smoke.errorSink.spec.ts`（renderer 抛错落 jsonl + 命令导出诊断包）。

## 关键文件

- `packages/platform/src/telemetry/` — 指纹 / 脱敏 / 折叠三件套 + `ITelemetryService` 契约
- `packages/platform/src/base/errors.ts` — `onUnexpectedError` 单入口 + `setErrorTelemetryHook`
- `apps/editor/src/main/services/telemetry/errorSinkMainService.ts` — errors.jsonl 写入 + per-window source 注入
- `apps/editor/src/renderer/services/telemetry/telemetryClientService.ts` — renderer 聚合客户端 + 配置键
- `apps/editor/src/main/services/diagnostics/` — 异常退出报告 + 系统信息 + 诊断 zip（`diagnosticsReport.ts` 为纯逻辑）
- `apps/editor/src/main/services/issueReporter/` — 上报 provider（github / tracker）+ 门面服务；契约在 platform `issueReporter/`，共享常量在 `shared/issueReporter.ts`
- `apps/editor/src/renderer/services/issueReporter/reportIssue.ts` — 报告问题流程编排（provider 选择 / 附件询问 / 失败降级）
- `apps/editor/src/main/werForensics.ts` / `exitSceneForensics.ts` / `abnormalExitConclusion.ts` — 异常退出取证三件套（事件日志分类 / 上一会话现场回放 / 单一判定收口）；前两者是纯解析 + 只读 IO，不 import electron，判定收口在第三个（全平台可跑、可单测）
- `apps/editor/src/main/sessionSentinel.ts` / `crashMonitoring.ts` / `errors.ts` — 哨兵 / 进程死亡 / main 异常钩子
- `apps/editor/src/renderer/actions/helpActions.ts` — 报告问题 / 导出诊断包命令
