# 本文从 apps/editor/CLAUDE.md 拆出，范围是运行时响应性监控与交互卡顿排查（套路 G 的展开）。

## 运行时响应性监控（常驻保底）

`IInteractionPerfService`（`services/performance/InteractionPerfService.ts`）用 Event Timing + LoAF 双 observer 常驻采集，慢交互（≥ `performance.responsiveness.warnThresholdMs`，默认 200ms）写单行 warn 到窗口日志 `interactionPerf.log`（三段分解 + 相位/脚本归因 + O(1) 上下文）；`recordPerfPhase(name, fn)`（`services/performance/perfPhases.ts`）是给热路径反应加相位归因的统一入口——包上即自动进入慢交互与切 tab 两份报告。会话聚合经命令 Developer: Interaction Performance 查看；配置门控见 `InteractionPerfContribution`。

## 交互卡顿排查（agent 自助采集）

`e2e/specs/smoke.interactionPerfReport.spec.ts`（@perf）用真实键鼠把典型编辑手势跑一遍（quick open/打字/大文件滚动/切 tab/搜索/资源管理器点击/保存等），产出 `e2e/test-results/interaction-perf-report.{json,md}`——慢交互按场景窗口归桶，含三段分解与相位/LoAF 归因，直接喂给 agent 定位卡顿。跑法：`pnpm --filter @universe-editor/editor e2eg "drives an editing tour"`。

要对着**用户指定的真实文件夹**采集（真实 watcher/索引/搜索负载），用 `smoke.interactionPerfCollect.spec.ts`：`UNIVERSE_PERF_WORKSPACE=<目录> [UNIVERSE_PERF_THRESHOLD_MS=50] pnpm --filter @universe-editor/editor e2eg "drives the editing tour against a user-picked folder"`（写操作只落自清理的探针文件，报告为 `interaction-perf-collect.{json,md}`）。

完整排查流程（定性 JS 瓶颈 vs 渲染管线 vs 环境噪音）见 skill `analyze-interaction-performance`。

## 归因 wrapper 提到模块级

`slowPhaseInstrument(name, minMs, detail?)`（`services/performance/perfPhases.ts:63`）给「每次调用都要新建」的热路径造相位 wrapper：`detail` 惰性求值（只在超阈值时才计算，帧体量等描述由这个闭包捕获），wrapper 本身也应在**模块级**建一次——热路径里每帧新建一个闭包是纯浪费。范例是 `renderer/ipc/bootstrap.ts:119` 的 `setIpcEncodeInstrument(slowPhaseInstrument('ipc.encode'))`（慢解码那一半由 decode observation 归因，见 `docs/development/memory-pressure.md`）。

## 大文件三类必守（reveal / dirty-diff / 文档同步）

- **「打开后定位/聚焦」一律走 `revealSelectionInInput` / `waitForFileEditor`**：打开 `FileEditorInput` 不同步挂载 Monaco，reveal 是「编辑器就绪」的后继动作——事件驱动（`FileEditorRegistry.onDidChange` + 30s 安全超时），**禁止再写 rAF+setTimeout 轮询**：定时轮询在大文件上必然超窗（340K 行的 `index.d.ts` 曾超出旧 rAF+50ms 窗口而**静默丢掉跳转**）。计时舞蹈的唯一归属是 `apps/editor/src/renderer/services/editor/revealEditorPosition.ts`（头注释即此判据）。
- **dirty-diff 的三件套**：`ThrottledDelayer` 200ms（`DIFF_DELAY_MS`）+ 任一侧模型超 50MB 同步上限**整体跳过**（`MODEL_SYNC_LIMIT`，VSCode `isTooLargeForSyncing` parity）+ 行级 Myers diff（`computeLineDiffFromLines`，`MAX_EDIT_DISTANCE = 2000` 上限 + `MAX_DIFF_BUDGET_MS = 100` 墙钟 deadline，超时回退粗粒度整块替换）。锚：`contributions/DirtyDiffContribution.ts:88-96`、`workbench/agents/lineDiff.ts:20-30`。
- **全文文档同步每键都是灾难**：Monaco deltas 必须转成 LSP 增量 `contentChanges`——按 `rangeOffset` **降序**（`end-of-document-first`）排序后逐条应用，前面的 change 才不会让后面已算好的 offset 失效（`services/extensions/documentSyncChanges.ts` 的 `monacoChangesToContentChanges`）。
