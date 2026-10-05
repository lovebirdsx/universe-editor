# 案例库（diagnose-renderer-oom）

> 单编号自包含：每条 = **信号**（判别特征，一行）+ 现象 → 根因 → 修法+锚点。
> `../SKILL.md` 的「案例索引」是按信号速查的一行索引；命中后按案例号来本文件查阅。
> 新经验：本文件追加一条案例（信号行必填）+ SKILL.md 索引补一行。

**案例 1 — 子 agent 回放 fire-and-forget 绕过预算窗口（claude，2026-08-15）**
信号：`acpSessionRestore.log` 的 `skipping auto-restore` + 曲线 0.5GB→5.5GB/**40s** + 会话含多个子 agent（实测 3 个、112 Read+74 Grep、23 万 token）。
现象：用户机连续 3 次 OOM（`reason=oom`），触发 `Automatic resume is paused` 保护。
根因：`d113680d` 把子 agent 完整执行过程加进 claude session 回放，但 `replaySubagentTranscripts` 是 `void` fire-and-forget——renderer 的 256MB 回放预算断路器（`acpContentLimits.ts` 的 `REPLAY_INGESTION_BUDGET` + `isReplayingHistory` 门）以 **`session/load` RPC 响应**为窗口边界（`acpSessionService.ts` 的 `beginHistoryReplay`/`endHistoryReplay`，`:1383/:1443`），load resolve 之后到达的子 agent 嵌套通知**全部落在窗口外**、无界入库。任何「在 RPC 响应之后异步补发的回放数据」天然绕过这个时序窗口。
修法：改成 await 覆盖（`vendor/claude-agent-acp/src/acp-agent.ts` 的 `replaySubagentTranscripts` 调用点，`:10035`）+ sidecar 源头预算（单文件 16MB / 累计 48MB，超限跳卡/停发）。**红线：回放类下发必须被 `session/load` await 覆盖；fire-and-forget 下发回放内容是红线。**

**案例 2 — 0.1.69 三缺口叠加：live 无累计预算 + 主 transcript 无源头 cap + 崩溃不回收孤儿（2026-08-19）**
信号：`processes.txt` 里 3 个 `claude.exe --resume=<同一 session>`；曲线「分钟级从 0.4GB 爬到 3.6~5GB」；第二台机器复核确认同三缺口（Bash 密集构建型会话，A 主因 2.7~5.1GB）。
根因（三个独立缺口，任一都足以 OOM）：① live 路径只有逐块 cap、无累计预算；② fork 主 transcript 回放无源头上限（仅子 agent sidecar 有 cap），且 renderer 回放估算欠计；③ renderer 崩溃后旧 agent 进程无人回收（`render-process-gone` 只弹对话框，crash reload 再 spawn）。
修法：`LIVE_INGESTION_BUDGET = 256MB`（`apps/editor/src/renderer/services/acp/session/acpContentLimits.ts:227`，超限释放最旧重内容、保卡片壳 + `memoryTrimmed`）＋ `MAIN_REPLAY_TOTAL_CAP_BYTES = 96MB` + 单条 1MB 截断（超限发说明性 chunk 后停发，不 fail resume）＋ `AcpHostMainService` 维护 `_windowByHandle`（`createWindowScopedAcpHost`，remote handle 不登记不误杀），崩溃 / 主 frame 导航时 `stopAllForWindow`（`apps/editor/src/main/services/acpHost/acpHostMainService.ts:79-183`；接线在 `apps/editor/src/main/services/window/windowMainService.ts:341/444`）。
**同族复发点**：每次 crash reload 还遗留一整套 extension-host + typescript-language-server + 3×tsserver 孤儿（约 0.5GB/套）——`ExtensionHostMainService` 镜像同一套（`_windowByHandle`/`startForWindow`/`stopAllForWindow`/`createWindowScopedExtensionHost`，`extensionHostMainService.ts:150-557`），与 ACP 在 windowMainService 的两处并联回收。

**案例 3 — codex 回放无源头 cap + children 度量空转（2026-08-21，0.13.1）**
信号：**切 tab 后 20s 内** Tab 0.4GB→3.4GB、峰值 4.4GB，main heap 同期 58MB→1016MB；重启后 2s 重放 459 条 `session/update`、1 分钟又涨回 3.9GB。`acpProtocol.log` 尾部窗口不足（只留 512KB）→ 靠 **processMetrics 曲线 + `tabSwitchPerf.log` 的 `ipc.decode` 连发 + `sessionWatchedChanges.log` storm** 三份交叉还原。
根因：claude fork 的三修**只覆盖 claude fork**；codex 侧四个缺口——① `streamThreadHistory` 把整条 thread（`thread/read includeTurns:true`）+ 整份 rollout 全量物化成 `UpdateSessionEvent[]` 逐条下发，无累计预算、无单条截断；② 回放重读文件全文无上限（`createPatchContent`→`readFileContent` 裸 `readFile`）；③ renderer live 预算对 `children` 空转（度量报 0 就 break = 永久超限；只补度量则为死循环，见案例 2 同族）；④ `estimateUpdateResidentBytes` 漏 `rawOutput`/`locations`（codex 终态 `tool_call_update` 恒把输出发两份，欠计约一半）。
修法：`ReplayBudget.ts` 的 `capReplayUpdate`（**递归遍历所有字符串字段**、刻意不按 item 类型 switch，新重字段自动覆盖）+ `REPLAY_TOTAL_CAP_BYTES = 96MB` + 超限发说明后停发；`ReplayFileRead.ts` 的 `readFileWithinCap`（stat 先判、超限不 materialise）；递归度量 + 递归修剪 children。**教训：多 fork 架构下修了一个 fork ≠ 修了能力对等的另一个，移植清单要显式核对。**

**案例 4 — 会话改动 observable 持双份全文、不在任何预算内（0.13.6）**
信号：renderer 从 0.7GB **慢爬**到 5.4GB 后 OOM；`holders` 与 `used` 的缺口以 GB 计；**全体日志 grep 预算修剪告警零命中却在持续爬升**。
根因：`SessionChangeTrackerService._recompute` 把 `SessionFileChange[]` 灌进 `_observables` 常驻，每条同时持 `baseline` + `current` **两份全文**（单文件读取上限 16MB），而既有预算的度量函数 `recordBytes` 只统计持久化的 `FileRecord`——**整个数据结构从未进入任何一套遍历**。
修法：活行闸门 `MAX_LIVE_CHANGE_BYTES = 32MB` / `MAX_LIVE_CHANGE_TOTAL_BYTES = 64MB`（`apps/editor/src/renderer/services/acp/session/sessionChangeTracker.ts:186-197`）；跨会话释放按 `_state` 的 `_touchLru` LRU 序（`_observables` 插入序是「谁先打开过面板」，不是冷热）。
**判据**（本案例的通用结论）：判断一个预算是否可信，问的不是「有没有预算」，而是「**每一条常驻路径是否都被某个度量覆盖**」；零修剪告警 + 持续爬升 = 增长完全在记账之外。
