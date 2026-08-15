---
name: subagent-replay-bypasses-budget-renderer-oom
description: 子 agent 回放 fire-and-forget 绕过 renderer 回放预算断路器致 5.5GB OOM;回放预算窗口以 session/load 响应为界
metadata: 
  node_type: memory
  type: project
  originSessionId: 57320a0a-0453-4d77-a1d2-71a19bd8b56c
  modified: 2026-08-15T12:31:45.859Z
---

2026-08-15 用户机 renderer 连续 3 次 OOM(reason=oom, 0.5GB→5.5GB/40s),触发 "Automatic resume is paused" 保护。根因:d113680d(vendor/claude-agent-acp 9c4caee)把子 agent 完整执行过程加进 claude session 回放,但 `replaySubagentTranscripts` 是 `void` fire-and-forget —— renderer 的 256MB 回放预算断路器(见 [[sessionchanges-unbounded-growth-main-oom-abort]] 后续加的 acpContentLimits + `isReplayingHistory` 门)以 `session/load` RPC 响应为窗口边界,load resolve 后 `endHistoryReplay()`,之后到达的子 agent 嵌套通知全部绕过预算无界入库。23 万 token、含 3 个子 agent(112 Read+74 Grep)的会话直接打爆。

**Why:** 预算窗口是时序性的(begin/end 之间),任何在 RPC 响应之后异步补发的回放数据天然落在窗口外。

**How to apply:** ① 回放类下发必须被 `session/load` await 覆盖(修复=改 await + sidecar 源头预算:单文件 16MB / 累计 48MB,超限跳卡/停发);② 新增任何回放数据源时,先问"它落在客户端预算窗口内吗"——fire-and-forget 下发回放内容是红线;③ 诊断包里 processMetrics.log 的 Tab 内存曲线 + window-1/acpSessionRestore.log(skipping auto-restore: recent OOM)+ processes.txt 的 claude.exe `--resume` 命令行是定位这类问题的三件套。遗留:同会话 live 运行期 main-heap 周期性 2–3.6GB 尖峰(疑似 stream-json 大块 parse)未修,另案。
