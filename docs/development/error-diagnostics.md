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
                            └─ createDiagnosticsZip()（同产物不弹，供 iLoop 上传）
                                                     ▼
        IIssueReporterService（可插拔 provider：iloop / github）
          iloop：上传 zip 到 go-fastdfs → addPost 预填 URL（可带附件）
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
- **renderer 崩溃**：`render-process-gone`（非 clean-exit）→ 记 errors.jsonl（`renderProcessGone`，source=`renderer:<id>`）+ 模态对话框「重新加载 / 关闭窗口」，`._crashHandled` 去抖防崩溃风暴叠弹窗；**E2E 跳过模态框**（崩溃直接挂测试，不挡驱动）。GPU/utility 进程死亡走 `child-process-gone` 同样入 sink。
- **unresponsive**：仅日志（Windows 锁屏会误报，不弹窗）。

## 「报告问题」链路

命令 `workbench.action.openIssueReporter`（**帮助: 报告问题…**，VSCode 同名 ID 对齐）。上报目标是**可插拔 provider 架构**（platform 出契约 + Registry，main 出实现，renderer 走 `IIssueReporterService` 门面，对标 AI provider 三层）：

1. renderer `runReportIssueFlow`（`services/issueReporter/reportIssue.ts`）读 `issueReporter.provider`（默认 `iloop`，可切 `github`）选 provider；`IDiagnosticsService.collectIssueReport()` 生成 markdown（版本 / 系统信息 / 已装扩展 / **errors.jsonl 最近 2 个 session 的错误指纹 Top 10**）并复制进剪贴板。
2. provider 支持附件时（iLoop）QuickPick 询问是否附带诊断包；随后 `buildIssueUrl(providerId, payload)` 在 **main 端**完成上传与拼 URL，renderer 只负责 `opener.open(url)`。URL 超 7500 字符时两个 provider 都降级为粘贴提示（VSCode 同款）。
3. **iLoop provider**（`main/services/issueReporter/providers/iloopProvider.ts`）：附带时先 `createDiagnosticsZip()`（与 `exportDiagnosticsZip()` 同产物但不弹文件管理器），再按 go-fastdfs 协议 POST `{serverUrl}/upload`，拼 `{appUrl}/addPost?board=&category=&content=&attachments=name@path` 预填 URL（标题留空由用户在页面填）。端点与板块走 `issueReporter.iloop.serverUrl/appUrl/board/category` 设置（默认值见 `shared/issueReporter.ts` 的 `ILoopDefaults`），由 renderer 读配置经 `providerOptions` 传给 main。上传失败 → 错误通知 +「不附带诊断包直接打开」降级 action。
4. **GitHub provider**：纯拼 `issues/new?body=...`，不支持附件。
5. `exportDiagnosticsZip()`（独立命令 `workbench.action.exportDiagnostics`）：`<userData>/diagnostics/universe-diagnostics-<ts>.zip`，含 `sysinfo.md` + 最近 2 session 的 `errors-*.jsonl` + 各日志文件**尾部 512KB** + `crash-dumps.txt`（dump 清单，不含 dump 本体）。E2E 下不弹系统文件管理器（`revealInShell`）。

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
- E2E：`e2e/specs/smoke.errorSink.spec.ts`（renderer 抛错落 jsonl + 命令导出诊断包）。

## 关键文件

- `packages/platform/src/telemetry/` — 指纹 / 脱敏 / 折叠三件套 + `ITelemetryService` 契约
- `packages/platform/src/base/errors.ts` — `onUnexpectedError` 单入口 + `setErrorTelemetryHook`
- `apps/editor/src/main/services/telemetry/errorSinkMainService.ts` — errors.jsonl 写入 + per-window source 注入
- `apps/editor/src/renderer/services/telemetry/telemetryClientService.ts` — renderer 聚合客户端 + 配置键
- `apps/editor/src/main/services/diagnostics/` — 异常退出报告 + 系统信息 + 诊断 zip（`diagnosticsReport.ts` 为纯逻辑）
- `apps/editor/src/main/services/issueReporter/` — 上报 provider（github / iloop）+ 门面服务；契约在 platform `issueReporter/`，共享常量在 `shared/issueReporter.ts`
- `apps/editor/src/renderer/services/issueReporter/reportIssue.ts` — 报告问题流程编排（provider 选择 / 附件询问 / 失败降级）
- `apps/editor/src/main/sessionSentinel.ts` / `crashMonitoring.ts` / `errors.ts` — 哨兵 / 进程死亡 / main 异常钩子
- `apps/editor/src/renderer/actions/helpActions.ts` — 报告问题 / 导出诊断包命令
