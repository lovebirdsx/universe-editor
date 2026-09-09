# 本文从 apps/editor/CLAUDE.md 拆出，范围是运行时响应性监控与交互卡顿排查（套路 G 的展开）。

## 运行时响应性监控（常驻保底）

`IInteractionPerfService`（`services/performance/InteractionPerfService.ts`）用 Event Timing + LoAF 双 observer 常驻采集，慢交互（≥ `performance.responsiveness.warnThresholdMs`，默认 200ms）写单行 warn 到窗口日志 `interactionPerf.log`（三段分解 + 相位/脚本归因 + O(1) 上下文）；`recordPerfPhase(name, fn)`（`services/performance/perfPhases.ts`）是给热路径反应加相位归因的统一入口——包上即自动进入慢交互与切 tab 两份报告。会话聚合经命令 Developer: Interaction Performance 查看；配置门控见 `InteractionPerfContribution`。

## 交互卡顿排查（agent 自助采集）

`e2e/specs/smoke.interactionPerfReport.spec.ts`（@perf）用真实键鼠把典型编辑手势跑一遍（quick open/打字/大文件滚动/切 tab/搜索/资源管理器点击/保存等），产出 `e2e/test-results/interaction-perf-report.{json,md}`——慢交互按场景窗口归桶，含三段分解与相位/LoAF 归因，直接喂给 agent 定位卡顿。跑法：`pnpm --filter @universe-editor/editor e2eg "drives an editing tour"`。

要对着**用户指定的真实文件夹**采集（真实 watcher/索引/搜索负载），用 `smoke.interactionPerfCollect.spec.ts`：`UNIVERSE_PERF_WORKSPACE=<目录> [UNIVERSE_PERF_THRESHOLD_MS=50] pnpm --filter @universe-editor/editor e2eg "drives the editing tour against a user-picked folder"`（写操作只落自清理的探针文件，报告为 `interaction-perf-collect.{json,md}`）。

完整排查流程（定性 JS 瓶颈 vs 渲染管线 vs 环境噪音）见 skill `analyze-interaction-performance`。
