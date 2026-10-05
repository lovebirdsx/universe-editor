# cases-memory-budget

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：会话内容与持久化的**内存预算/修剪**纵切——live 与回放两条入库路径的预算、`AcpSession` 的度量与释放遍历、会话改动追踪（change tracker）的持久化与活行两套账、以及跨进程日志的字符串化红线。机制总览见 [CLAUDE.md](CLAUDE.md)，堆水位 / releaser 表见 `docs/development/memory-pressure.md`，本文只写预算族的判据、常量与坑。

## 红线：度量与释放必须是同一套遍历

- 新增一个桶纳入度量（如 `AcpSession._orphanChildren`，`acpSession.ts:764`），就必须同时纳入释放，并把 trim 循环的 guard 上界同步放大（`MAX_ORPHAN_PARENT_ENTRIES = 64` 在 `acpContentLimits.ts:281`，循环在 `acpSession.ts:4444`；度量在 `acpSession.ts:2963`、释放遍历在 `acpSession.ts:3068`）。三处任一漏掉，账与堆立刻分叉。
- **tally 与 `_measureResidentBytes()` 的等式要直接断言，别只断言 tally 本身**——tally 是共享预算读的数，遍历测了一个结构、释放了另一个结构时，会话读起来「在预算内」而堆还在涨。回归断言在 `AcpSession.liveBudget.test.ts` 的 `expectTallyMatchesMeasurement`（`:133`）。
- 判据不是「有没有预算」，而是「**每一条常驻路径是否都被某个度量覆盖**」。同一形态复发过两次：一次是「只补了度量/释放的一边」（codex 回放事故，见下「children 三件套」），一次是「整个数据结构从未进入任何一套遍历」（`_observables` 活行，见下「改动追踪」）。
- 诊断抓手：全体日志 grep 预算修剪告警**零命中**却在持续爬升 = 增长完全在记账之外（前提是 renderer console 拦截器确实落盘，本仓库装在 `main.tsx`）。

## 子代理 children：度量/释放/回写是不可拆的三件套

- 子 agent 内容以独立 update **计入** `_liveIngestedBytes`，却嵌在父卡 `AcpToolCall.children` 上，而三处都当它不存在：`toolCallHeavyBytes`（`acpSession.ts:264`）不数、`trimToolCall`（`acpSession.ts:295`）保留、`_replaceToolCall`（`acpSession.ts:3103`）又拿 slot 上**未修剪**的 children 覆盖回替换值。
- 三者叠加的两种失败形态：① 度量报 0 就 `break` → 预算永久超限、此后无界增长；② 只补度量不补释放 → `freed > 0` 恒真 → while 无限循环卡死主线程。
- 修法是一组必须同改的改动：度量递归（children 是 `AcpChildItem` 联合，message 分支走 `messageHeavyBytes`，`acpSession.ts:264-310`）+ `trimToolCall` 递归修剪 + `_replaceToolCall` 优先用 `trimmed.children`（用未修剪的 children 回填等于撤销刚记过账的释放，循环会永远挑中同一张卡）+ 循环改 `for` 加进度守卫。**改任一必同时改另两个与 `_replaceToolCall`**，回归见 `AcpSession.liveBudget.test.ts` 的 children 用例。

## live 路径：只有逐块 cap 不够，必须有累计预算

- 逐块 cap（`TERMINAL_OUTPUT_CAP` / `MESSAGE_TEXT_CAP` / `RAW_INPUT_CAP` / `MEDIA_DATA_CAP`，`acpContentLimits.ts:16-135`）只约束单块；`_messages` / `_toolCalls` / `_terminalOutput` 仍随大规模 Grep/Read 会话无界增长。**`LIVE_INGESTION_BUDGET = 256MB`**（`acpContentLimits.ts:227`）是 live 期的累计闸门：超限释放最旧的重内容，保卡片壳 + `memoryTrimmed` 标记，**新通知永远入库**。
- 释放策略（2026-09-16 修订）：**用户消息（锚点）永不释放**、按收益优先（大块先走）、被剪消息留开头预览且通知由 UI 按标记渲染而**不入 `text`**（`memoryTrimmedNotice()`，`acpSession.ts:234`）、释放量按差值记账。首版严格按 timeline 位置「最旧优先」，结果首条用户消息——最贵的锚点——第一个被牺牲，通知文案还被写进 `text` 冒充用户原文。
- **红线**：新增任何 session 内容入库路径时先问两句——「它被哪个预算覆盖？」「估算函数计到它了吗？」

## 回放路径：renderer 估算的两处欠计

- `estimateUpdateResidentBytes` 曾不计 `terminal_output` / `rawInput` 的文本拷贝，且按 code unit 而非 UTF-16 字节计数 → 回放期低估。已补计并 ×2 估：`utf16Bytes`（`acpContentLimits.ts:293`）与 `contentBlockBytes`（`acpContentLimits.ts:298`）。
- `rawOutput` / `locations` 是同类第二处，且只在 codex 上发作：终态 `tool_call_update` **恒**把命令输出发两份（`_meta.terminal_output*` 保留 + `rawOutput.formatted_output` 无人读），只估一份则构建型会话欠计约一半。修法 = 计入 `transientJsonBytes`（`acpContentLimits.ts:326`，调用点 `:397`）——它不驻留，但解码后要等 GC。
- claude fork 侧的源头 cap 分两族，**别把主链与 sidecar 混用**：
  - **主 transcript**（用户真读的历史）：单条 `MAIN_REPLAY_MESSAGE_CAP_BYTES = 1MB`、累计 `MAIN_REPLAY_TOTAL_CAP_BYTES = 96MB`（`vendor/claude-agent-acp/src/acp-agent.ts:382`，在 `replaySessionHistory` 消费）。超限后**从头发、丢较新尾部**：单条超限截断内容，累计超限发一条说明性 `agent_message_chunk` 后停发，**不 fail resume**（主链是用户要读的历史，要显式告知截断而不是静默丢尾）。
  - **子代理 sidecar**：单文件 `SUBAGENT_REPLAY_FILE_CAP_BYTES = 16MB` / 累计 `SUBAGENT_REPLAY_TOTAL_CAP_BYTES = 48MB`（`acp-agent.ts:374-375`），超限跳卡或停发。
  - **子代理 stats restamp 读侧车 transcript 前必须 `stat` 判 cap**：`restampReplayedSubagentStats`（`acp-agent.ts:10122`，`fileCapBytes` 默认 16MB）与逐条流式的进程回放不同，**整文件读一次**，无 cap 会打爆 fork 自身 node 堆；超限/缺失都跳卡（no stats beats wrong stats）。
- 回放类下发必须被 `session/load` await 覆盖，**fire-and-forget 下发回放内容是红线**（子 agent 嵌套回放曾越窗绕过 256MB 断路器 → renderer 5.5GB OOM）。详见 [cases-session-replay.md](cases-session-replay.md)。

## 会话改动追踪：持久化与活行是两套账

- **持久化预算**（`sessionChangeTracker.ts:163-197`）：`MAX_SESSION_BYTES = 8MB` 每会话（**全有或全无**——只留部分 batch 历史会在 `restore` 时重建出错误 baseline，所以丢 batch 只降级 rewind 文件回滚，绝不降级 session diff）+ `MAX_TOTAL_BYTES = 32MB` 全局 + `MAX_TRACKED_SESSIONS = 20` 会话 LRU。`_deserialize` 加载时剪枝并回写自愈、单条畸形会话隔离不拖垮整体；预算字段（`maxSessionBytes` 等，`sessionChangeTracker.ts:381-386`）public 可测试覆写。
- **活行预算**是独立的一套：`_recompute` 把 `SessionFileChange[]` 灌进 `_observables` 常驻，每条同时持 `baseline` + `current` **两份全文**（单文件读取上限 `MAX_CURRENT_BYTES = 16MB`，`sessionChangeTracker.ts:183`），而持久化那套的 `recordBytes` 只统计 `FileRecord` → 0.7GB 慢爬到 5.4GB 直至 OOM。活行闸门 = `MAX_LIVE_CHANGE_BYTES = 32MB` / `MAX_LIVE_CHANGE_TOTAL_BYTES = 64MB`（`sessionChangeTracker.ts:186-197`）；每会话上限必须 ≤ 全局上限——正在重算的会话永不是全局清扫的候选，会上限反超会让清扫无物可释放。
- **跨会话释放按真实活跃度排序**：`_observables` 的插入序是「谁先打开过面板」不是冷热；`_state` 才是 `_touchLru`（`sessionChangeTracker.ts:806`）维护的 LRU 序 → 全局清扫遍历 `_state`（`sessionChangeTracker.ts:1134`），且跳过正在重算的会话。
- **`_buildChange` / `_restore` 必须查 `stat.isFile` 而不只查 `stat.size`**：目录进 tracker 后每轮 recompute 必爆 EISDIR（诊断里同两条路径 2920 次）→ 非普通文件直接 surface 为 degraded，而不是去读（`sessionChangeTracker.ts:1197-1204`）。

## 跨进程红线：持久化服务日志绝不 stringify 全量 state

- `PersistedStateBase._loadFromScope` 曾把**整个 state** `JSON.stringify` 进 info 日志 → 百 MB 字符串再经 logChannel 转发主进程，是「启动约 8 秒后 main abort()（exit 134）」链路里最大的放大器。已改 `_describeState()`（`persistedStateBase.ts:112`）有界摘要：Map/Array 报条数、对象截断 2KB。
- 原因是 IPC 是 JSON 信封（`packages/platform/src/ipc/ipc.ts` 的 encode = `JSON.stringify` + `TextEncoder`）：一次大 key 的读或写 = 双进程各数百 MB 的瞬时分配。
- **新 `PersistedStateBase` 子类若 state 可增长，必须自带预算**；主进程侧的写入兜底见 `docs/development/memory-pressure.md`「主进程持久化兜底」。

## 测试与验证

- `AcpSession.liveBudget.test.ts`：trim 后 `_residentBytes === _measureResidentBytes()`；trim 掉的子代理消息同时丢 `live`；children 用例守递归度量/递归修剪。
- `sessionChangeTracker.test.ts`：每会话/全局预算、加载剪枝、降级行为。
- 相关 e2e：`smoke.agentStreamMemory.spec.ts`（`mdparse`/`mdreseal`/`childchunks` 的算法形状，不断言墙钟或 MB）。
