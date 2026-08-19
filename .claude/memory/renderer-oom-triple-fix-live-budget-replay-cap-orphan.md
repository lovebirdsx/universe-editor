---
name: renderer-oom-triple-fix-live-budget-replay-cap-orphan
description: 0.1.69 用户机 renderer OOM 复发(resume 回放 90s 暴涨 + live 6min 爬 5GB)三缺口三修:live 累计预算+主 transcript 回放源头 cap+崩溃回收孤儿 agent 进程
metadata: 
  node_type: memory
  type: project
  originSessionId: 8d8b29b6-d769-401e-92a5-fd0900a78982
  modified: 2026-08-19T10:58:33.291Z
---

2026-08-19 分析用户诊断包(0.1.69,8/18-19 三次 renderer OOM,0.4GB→3.6~5GB 分钟级):[[subagent-replay-bypasses-budget-renderer-oom]] 的修复(01a0e7f)已在 0.1.67+ 发布且未被 03b6a5f 破坏,但 OOM 仍复发。根因是三个独立缺口叠加:

1. **live 路径完全无累计预算**(只有逐块 cap):`_messages`/`_toolCalls`/`_terminalOutput` 随大规模 Grep/Read 会话无界增长 → live 期 OOM。修=`acpSession.ts` 加 `LIVE_INGESTION_BUDGET`(256MB),超限从 timeline 头部修剪最旧 tool_call/message 的重内容(保卡片壳+`memoryTrimmed` 标记),新通知永远入库。
2. **fork 主 transcript 回放无源头上限**(仅子 agent sidecar 有 16/48MB cap),且 renderer 回放预算欠计(不计 terminal_output/rawInput/text 拷贝、按 code unit 非 UTF-16 字节)→ resume 回放期 OOM。修=fork `replaySessionHistory` 加 `MAIN_REPLAY_TOTAL_CAP_BYTES=96MB`+单条 1MB 截断(超限发说明性 chunk 停发);renderer `estimateUpdateResidentBytes` 补计三洞并按 ×2 字节估;`restampReplayedSubagentStats` readFile 前 stat 判 cap。
3. **renderer 崩溃后旧 agent 进程无人回收**:`render-process-gone` 只弹对话框,crash reload 再 spawn 新进程 → 诊断包 3 个 `claude.exe --resume=同一session` 孤儿并存后台读扫放大压力。修=`AcpHostMainService` 维护 handle→windowId(per-window 通道包装 `createWindowScopedAcpHost`),崩溃/主 frame 导航时 `stopAllForWindow`(remote handle 不登记不误杀)。

**Why:** 预算必须覆盖"每一条通往驻留内存的路径"——回放窗口内、窗口外(live)、源头(fork 下发)三层任一缺口都足以 OOM;且崩溃恢复流程若不回收旧进程,每次 OOM 都让系统压力翻倍。

**How to apply:** ① 新增任何 session 内容入库路径时,先问"它被哪个预算覆盖?估算函数计到它了吗?";② 诊断这类问题三件套(processMetrics 内存曲线+acpSessionRestore 的 skipping auto-restore+processes.txt 的 --resume 命令行)依然有效,另加 sessionWatchedChanges.log 的 watched-change storm 是大规模工具活动的旁证;③ 遗留未修:live 运行期 main-heap 周期性 2-3.6GB 尖峰(疑似 stream-json parse,本诊断包未观察到 main 侧尖峰,维持另案);子 agent 嵌套内容(`AcpToolCall.children`)未纳入 live 修剪。

2026-08-19 第二台用户机(linzhenqun,0.1.69,Bash 密集构建型会话 d7b51b31,3 次 OOM)复核确认同三缺口(A 主因分钟级爬 2.7~5.1GB、B resume 循环参与、C 孤儿 claude.exe 累积至 3 个)——升级 0.1.70 即覆盖。**新发现相邻缺口并已修(task3 分支):每次 renderer crash reload 曾遗留一整套 extension-host+typescript-language-server+3×tsserver 孤儿(约 0.5GB/套)——`stopAllForWindow` 只回收了 acp agent。修=ExtensionHostMainService 镜像 ACP 同套(_windowByHandle+startForWindow+stopAllForWindow+createWindowScopedExtensionHost 包装),windowMainService 的 render-process-gone/did-start-navigation 两处并联回收**;另 sysinfo 的 renderProcessGone 聚合会漏掉"整 app 重启型"OOM(renderer 死透没机会上报 errors.jsonl),window.log 的 render-process-gone 才是完整口径。
