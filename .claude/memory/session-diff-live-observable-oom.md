---
name: session-diff-live-observable-oom
description: 会话 diff 的 observable 结果持有双份全文且不在任何预算内，是 renderer 慢速爬升型 OOM 的主因；降级行绝不能回灌进可编辑 diff
metadata:
  type: project
---

renderer 从 0.7GB 慢爬到 5.4GB 后 OOM（0.13.6 线上诊断包）。主因是 `SessionChangeTrackerService._recompute` 把 `SessionFileChange[]` 灌进 `_observables` 常驻，每条同时持有 `baseline` + `current` **两份全文**（单文件读取上限 16MB），而既有预算的度量函数 `recordBytes` **只统计持久化的 `FileRecord`**，完全不统计 observable 里的这些全文。

**Why:** 这是 [[codex-replay-oom-source-cap]] 那条红线（度量与释放必须同一套遍历）的新形态复发——上次是"只补一边遍历"，这次是"整个数据结构从未进入任何一套遍历"。判断一个预算是否可信，要问的不是"有没有预算"，而是"每一条常驻路径是否都被某个度量覆盖"。诊断上的抓手：全体日志 grep 预算修剪告警**零命中**却在持续爬升 = 增长完全在记账之外（前提是 renderer console 拦截器确实落盘，本仓库装在 `main.tsx`）。

**How to apply:**
- 新增任何"把结果 park 进 observable"的代码，先问它是否有上限；`_recompute` 这类被高频触发（150ms 节流 × 每轮 agent 工具调用）的重算尤其危险。
- 降级/释放产生的空内容行（`status:'degraded'` + 空串）**绝不能回灌进可编辑 diff**：`SessionChangesDiffSyncContribution._sync` 的 editable 分支会把 `change.current` 写进**共享 model** 并 `markModelClean`，空串会清空用户正在看的文档且标记为已保存，下次保存即写空文件。该风险原本只存在于 >16MB 的 `tooLarge` 路径，把降级推广到普通行会把触发面放大到"任意行遇内存压力"。守卫加在 `_sync` 入口。
- 跨会话释放要按真实活跃度排序：`_observables` 的插入序是"谁先打开过面板"，不是冷热；`_state` 才是 `_touchLru` 维护的 LRU 序。

同批修复的另两处：`_buildChange`/`_restore` 只查 `stat.size` 不查 `stat.isFile`，目录进 tracker 后每轮 recompute 必爆 EISDIR（诊断里同两条路径 2920 次），叠加 `nodeFileSystemProvider._logReadFailure` 无去重，把诊断导出的 512KB 尾部窗口占满；`crashMonitoring` 采集了 Tab 的 `workingSetSize` 却从不解析比较，崩溃前零告警。
