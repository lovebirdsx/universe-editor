---
name: swarm-notify-focus-gate-user-away
description: "swarm 通知第三环 bug——检测链路全绿但 OS toast 被焦点门控吞掉;Windows 锁屏/人离开后窗口 isFocused() 恒 true,门控须加\"人在场\"维度"
metadata: 
  node_type: memory
  type: project
  originSessionId: f7fe7855-0b03-47c7-a41b-c521947b4a3c
---

swarm 后台通知 bug 是三环链条,前两环(401 模态卡闩锁、p4 spawn 挂死)修完后 2026-07-29 又复发:renderer 日志三次 `notifying N new review(s)` 全部跟着 `OS toast gated (window focused...)`,其中一次在深夜 00:07——检测链路全部健康,断在最后一环发送门控。

**Why:** Windows 在用户锁屏 / 人离开后仍保持最后前台窗口的 focused 状态,`MainHostService.notify()` 只看 `win.isFocused()` 就把 OS toast 吞成后台窗口里没人看的 in-app toast。多窗口场景更放大(只有 swarm 工作区那个窗口的焦点状态说了算)。诊断铁证是"缺失的日志行":host.log 同时段只有 agent 的 `notify shown`、没有 swarm 的——skipped 分支当时是 debug 级不落盘,靠反证定位。

**How to apply:** 焦点门控必须叠加"人在场"维度:`powerMonitor.getSystemIdleState(120)` 返回 `locked`/`idle` 视为不在场照发 OS toast;`active`/`unknown` 保守维持门控。E2E 下探针冻结为"在场"(无人值守 CI 恒 idle,会翻转 in-app fallback specs),`UNIVERSE_E2E_REAL_IDLE=1` opt-in 真实探测。gate/skip 决策日志一律 info 落盘(host.log),别再用 debug。完整链路分析见 `extensions/perforce/src/swarm/CLAUDE.md`。排查"收不到通知"先看 renderer `swarmNotify` 的 notifying 决策,再看 main `host.log` 的 shown/skipped 决策。
