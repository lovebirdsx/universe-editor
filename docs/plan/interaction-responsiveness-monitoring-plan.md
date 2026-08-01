# 编辑器交互响应性监控（Interaction Responsiveness Monitoring）实施计划

> **目标**：为日常编辑器操作（切标签页、输入字符、光标移动、点击等）提供**常驻、近零开销**的响应性监控保底——任何交互变慢时自动留下"哪个交互慢 + 慢在哪三段 + 当时主线程在跑哪段代码"的可归因记录，用户现场无需复现即可事后定位。
>
> **已确认决策**（2026-08-01 与用户对齐）：
> 1. 范围 = P1 保底采集 + P2 归因增强 + P3 可视化报告，全量落地；
> 2. 默认**开启**（含发布版）——被动 observer 开销近零，"保底"要常驻才有意义，提供配置项可关；
> 3. 与现有切 tab 看门狗（`TabSwitchPerfContribution`）**并存 + 共享底座**：不重构其场景语义（观察窗/首帧延迟定义），只把相位缓冲等通用件下沉共享。
>
> **技术选型**：Electron 33 = Chromium 130，三个原生能力全部可用——
> - **Event Timing API**（`PerformanceObserver` type `'event'`，Chromium 76+；`interactionId` 96+）：每个离散交互事件原生给出 `startTime`（事件发生）/ `processingStart` / `processingEnd` / `duration`（到帧上屏），可分解为 inputDelay / processing / presentationDelay 三段；浏览器层按 `durationThreshold` 过滤，阈值下事件连回调都不触发。键入（含 IME composition / beforeinput）、方向键移光标、点击 tab 全部天然覆盖，**无需逐场景插桩**。
> - **Long Animation Frames（LoAF）**（type `'long-animation-frame'`，Chromium 123+）：长帧（>50ms）自带**脚本级归因**（`scripts[]`：invoker / sourceURL / sourceFunctionName / duration），替代旧 `longtask` 的"只知道卡了、不知道卡在哪"。
> - **`webContents` 'unresponsive'/'responsive'**（main 侧）：renderer 冻死连日志都写不出的极端场景，由 main 独立记录。
>
> 监控光谱：小卡顿（Event Timing）→ 长帧归因（LoAF）→ 彻底冻结（main 侧兜底）。
>
> **通用纪律**：
> - 每个阶段结束跑 `pnpm check`（仅截取错误输出）；涉及交互链路的阶段末尾跑 `pnpm e2e:smoke`；全部完成后跑定向 spec + `pnpm e2e:smoke`。
> - 监控代码自身的**开销红线**：observer 回调只做 O(entries) 轻量聚合；日志格式化/上下文快照只在慢交互时做且全部 O(1)（memory 教训：挂在热路径上的反应**不得携带/构造全文**，`getValue()`/正则扫全文都算）。
> - 提交粒度按阶段，conventional commits。

---

## 现状梳理（先读懂，再动手）

**已有资产（直接复用/共享）**：

| 资产 | 位置 | 复用方式 |
|---|---|---|
| 切 tab 看门狗 | `apps/editor/src/renderer/contributions/TabSwitchPerfContribution.ts` | 保留不动其语义；参考其 observer 装配/降级写法 |
| 相位归因纯函数 | `apps/editor/src/renderer/services/performance/tabSwitchPerf.ts`（`recordTabSwitchPhase` + 模块级环形缓冲 256 + `samplesInWindow` 时间窗交集） | **泛化下沉**为通用 perf 工具（阶段 1） |
| 窗口私有日志 | `createNamedLogger(loggerService, {id, name})` 一行接入，落 `<userData>/logs/<session>/window-<id>/<channelId>.log` | 新通道 `interactionPerf` |
| 配置注册 | `apps/editor/src/renderer/contributions/SettingsContribution.ts:626-659` 已有 `id: 'performance'` 组（startupWarning 三键为模板） | 同组追加 responsiveness 键 |
| 配置读取 helper | `apps/editor/src/renderer/services/performance/startupPerformanceSettings.ts` | 照抄成 `interactionPerfSettings.ts` |
| 只读报告页三件套 | `StartupPerformanceInput.ts`（虚拟单例 input）+ `workbench/editor/StartupPerformanceEditor.tsx` + `BuiltInEditorProvidersContribution.ts:215-223` 注册 + `actions/performanceActions.ts` 命令 | 照抄成 Interaction 版（阶段 5） |
| 状态栏警示 | `StartupPerformanceStatusContribution.ts`（配置变更重渲染 + command 跳转） | 照抄（阶段 5） |
| contribution 注册 | `contributions/registration/afterRestore.ts:534-538`（TabSwitchPerf 即在此，`WorkbenchPhase.AfterRestore`） | 新监控同相位同文件注册 |
| e2e 探针 | 契约在独立包 `@universe-editor/e2e-contract`（app 侧 barrel `src/shared/e2e/contract.ts`），实现 `src/renderer/e2e/probe.ts` | 扩 `getInteractionPerfSummary()`（阶段 5） |
| main 崩溃处理 | `apps/editor/src/main/services/window/windowMainService.ts:202`（`render-process-gone`，有现成 per-window logger） | unresponsive 兜底挂同处（阶段 4） |

**空白（本计划要填的）**：输入字符、光标移动、点击等**除切 tab 外全部交互零监控**；无常驻主线程健康度监控（longtask 只在切 tab 的 1500ms 观察窗内开）；全仓库无 Event Timing / LoAF 使用。

**数据流总览（目标态）**：

```
用户交互（keydown/click/pointerdown/composition…）
  └─ Chromium Event Timing（durationThreshold=16ms 观察下限）
       └─ InteractionPerfService（renderer 纯服务）
            ├─ 全量样本 → 内存直方图/分组聚合（O(1) per entry，不落盘）
            └─ duration ≥ warnThresholdMs（默认 200）→ 慢交互报告
                 ├─ 三段分解 inputDelay / processing / presentationDelay
                 ├─ 时间窗交集关联：LoAF scripts 归因 + recordPerfPhase 相位
                 ├─ O(1) 上下文快照（activeEditor URI / 语言 / 行数 / target 摘要）
                 └─ warn 一行 → 窗口私有日志 interactionPerf.log（1s/类型节流防刷屏）
主线程长帧 ──── LoAF observer → 环形缓冲 64 条（供上面交集；独立超长帧也记日志）
renderer 冻死 ── main: webContents 'unresponsive'/'responsive' → main 窗口日志
```

---

## 阶段 0 · API spike 验证（不产正式代码）

**目标**：确认 Electron 33 renderer 里三个 API 的实际行为，避免后续阶段建立在错误假设上。

- [ ] 0.1 `pnpm dev` 起编辑器，DevTools console 里临时验证：
  - `new PerformanceObserver(...).observe({ type: 'event', durationThreshold: 16, buffered: true })` 能产 entry；键入/点击后 entry 带非零 `interactionId`、`processingStart/End`、`target`。
  - `observe({ type: 'long-animation-frame', buffered: true })` 能产 entry；人为忙等（console 里跑 300ms while 循环后点击）能看到 `scripts[]` 带 `invoker`/`sourceURL`。
  - `performance.interactionCount` 是否可用（可用则做聚合分母，不可用则降级为"仅 ≥16ms 样本数"）。
- [ ] 0.2 把观察到的字段形状（尤其 `duration` 8ms 取整、entry 派发时机在 present 之后）记入本文件"验证记录"。

**验证**：验证记录里有一段真实 entry JSON 样例。

---

## 阶段 1 · 共享底座：把 tabSwitchPerf 的通用件泛化下沉

**目标**：相位记录与时间窗交集从"切 tab 专用"变为通用 perf 工具；不引入任何新行为，纯重构，e2e 无感。

### 1.1 新建 `services/performance/perfPhases.ts`
- [ ] 从 `tabSwitchPerf.ts` 迁出通用件并改名：`TabSwitchSample` → `PerfSample`、`recordTabSwitchPhase` → `recordPerfPhase`、`getRecordedPhases`、`samplesInWindow`、`_resetTabSwitchPerfForTests` → `_resetPerfPhasesForTests`。模块级环形缓冲（256 条）与 `MIN_REPORTED_PHASE_MS` 语义原样保留。
- [ ] `tabSwitchPerf.ts` 只留切 tab 专属逻辑（`TAB_SWITCH_WARN_MS` / `TAB_SWITCH_OBSERVE_WINDOW_MS` / `buildTabSwitchReport` / `shouldWarnTabSwitch` / `formatTabSwitchReport`），从 `perfPhases.ts` import 通用件。**不留兼容 re-export**（项目不考虑向后兼容），直接迁移调用点。

### 1.2 迁移 `recordTabSwitchPhase` 全部调用点为 `recordPerfPhase`
- [ ] `workbench/editor/FileEditor.tsx`（5 处：setModel / applyOptions / updateDirty / restoreViewState / registerAndFocus，约 :391-:452）
- [ ] `contributions/DirtyDiffContribution.ts:267` 附近
- [ ] `workbench/scm/mergeConflict/inlineConflictController.ts:46` 附近
- [ ] 全仓 grep `recordTabSwitchPhase` 清零确认。

### 1.3 单测跟随
- [ ] `services/performance/__tests__/` 下现有 tabSwitchPerf 测试拆分：通用件测试移到 `perfPhases.test.ts`，切 tab 报告构建测试留在原文件（renderer-node 环境，纯函数无 DOM）。

**验证**：`pnpm check`（重构不改行为，现有测试应全绿）；grep 确认旧符号清零。

---

## 阶段 2 · Event Timing 采集 + 慢交互日志（保底成立线）

**目标**：本阶段完成后"机制保底"即成立——任何交互超阈值都会在 `interactionPerf.log` 留下一行可读 warn。

### 2.1 纯函数层 `services/performance/interactionPerf.ts`
全部为无 DOM 依赖的纯函数（renderer-node 可测），入参用结构化 DTO 而非真 PerformanceEntry：

- [ ] `InteractionEventSample` 类型：`{ eventType, startTime, processingStart, processingEnd, duration, interactionId }`。
- [ ] `decomposeInteraction(sample)`：三段分解 `{ inputDelayMs, processingMs, presentationDelayMs }`；**presentationDelay = duration - (processingEnd - startTime) 因 duration 8ms 取整可能为负，clamp 到 0**。
- [ ] `dedupeByInteraction(samples)`：同一 `interactionId`（≠0）的多 entry（keydown+keyup 等）只取 duration 最大者；`interactionId === 0` 的 entry 单独通道（非交互事件，慢了也记但标注 `non-interaction`）。
- [ ] 直方图聚合：bucket 边界 `[16, 25, 50, 100, 200, 500, 1000, +∞)`，按 eventType 分组计数 + max；`estimateQuantile(histogram, q)` 从直方图估算 p95/p99（报告页标注"基于 ≥16ms 样本"）。
- [ ] `buildSlowInteractionReport(...)`：组装慢交互报告（分解 + 时间窗内 phases/LoAF 交集，交集复用阶段 1 的 `samplesInWindow`）+ `formatSlowInteractionLine(...)` 单行日志格式化（风格对齐 `formatTabSwitchReport`：`slow keydown 312ms (input 8 / processing 96 / present 208) target=... editor=... phases: [...] loaf: [...]`）。
- [ ] 节流器 `WarnThrottle`：同 eventType 1 秒窗口内只放行第一条 warn，窗口结束把被抑制的条数并入下一条（`suppressed N more slow keydown`）——持续卡顿的打字不能刷几百行。
- [ ] 单测：分解（含负值 clamp）、去重、直方图/分位数、节流、格式化——`__tests__/interactionPerf.test.ts`（renderer-node）。

### 2.2 服务层 `services/performance/InteractionPerfService.ts`
- [ ] `IInteractionPerfService`（`createDecorator`）：`start()` / `stop()` / `getSummary()`（聚合快照：各类型计数/直方图/p95/p99/最慢 N 条明细/interactionCount）/ `onDidRecordSlowInteraction`（P3 状态栏用）。
- [ ] 实现：`start()` 装配 `PerformanceObserver`（`type: 'event', durationThreshold: 16, buffered: true`），回调里全量样本进直方图（O(1)），`duration ≥ warnThresholdMs` 的走慢交互报告 → `logger.warn`（`createNamedLogger` 通道 `{id: 'interactionPerf', name: 'Interaction Performance'}`）；观察不支持时（单测/happy-dom）静默降级，照 `TabSwitchPerfContribution._observeLongTasks` 的 try/catch 写法。
- [ ] 慢交互明细存环形缓冲（128 条，供 `getSummary()`/报告页）。
- [ ] **上下文快照（全 O(1)）**：activeEditor 的 `resource.toString()` + 语言 id + `model.getLineCount()`（经 `IEditorService.activeEditor.get()` + `FileEditorRegistry`；禁止 getValue/全文操作）；entry 的 `target` 取 tagName + data-testid/id 截断 64 字符（target 可能已被 GC，判空）。
- [ ] `dispose()` 时 `logger.info` 一条会话汇总（总交互数/慢交互数/各类型 p95）——常驻期间聚合**只在内存，不落盘**。
- [ ] 注册：`renderer/main.tsx` 步骤 4 区域 `instantiation.createInstance(InteractionPerfService)` + `services.set(IInteractionPerfService, ...)`。
- [ ] 单测：以假 entry DTO 直接驱动内部处理函数（observer 不可用路径），验证聚合/慢判定/日志调用次数（`__tests__/InteractionPerfService.test.ts`，renderer-node，logger 用桩）。

### 2.3 配置项 + 门控 contribution
- [ ] `services/performance/interactionPerfSettings.ts`（照抄 startupPerformanceSettings 形制）：
  - `performance.responsiveness.enabled`（boolean，**default true**）
  - `performance.responsiveness.warnThresholdMs`（number，default **200**，minimum 50——与 `TAB_SWITCH_WARN_MS`、INP "good" 上限对齐）
- [ ] `SettingsContribution.ts` 的 `id: 'performance'` 组追加两个 properties（localize description）。
- [ ] `contributions/InteractionPerfContribution.ts`：构造时按配置 `start()`，订阅 `onDidChangeConfiguration`（`affectsConfiguration` 两 key）动态 start/stop/更新阈值；注册进 `contributions/registration/afterRestore.ts`（`WorkbenchPhase.AfterRestore`，紧邻 tabSwitchPerf 注册块）。
- [ ] i18n：`shared/i18n/messages/zh-CN.ts` / `en-US.ts` 补 `settings.performance.responsiveness.*` 文案。

**验证**：`pnpm check`；`pnpm dev` 手动验证——DevTools console 忙等 300ms 后立刻打字，`Output` 面板 / `window-<id>/interactionPerf.log` 出现 warn 行且三段分解合理；正常打字**不产生任何日志行**；设置关掉后 observer 断开（无新行）。

---

## 阶段 3 · LoAF 脚本归因 + 关联进慢交互报告

**目标**：慢交互 warn 行从"卡了 312ms"升级为"卡在 `xxx.js` 的某回调 260ms"。

- [ ] 3.1 `InteractionPerfService` 增设第二个 observer（`type: 'long-animation-frame', buffered: true`），条目转 `LoafSample`（startTime / duration / blockingDuration / 提炼 `scripts[]` 为 top-3：`{invoker, sourceUrl 截尾 80 字符, durationMs}`）存环形缓冲 64 条；不支持时静默降级（等价于阶段 2 行为）。
- [ ] 3.2 慢交互报告构建时按 `samplesInWindow(loafBuffer, startTime, startTime + duration)` 取交集，top 脚本进 warn 行 `loaf: [...]` 段。
- [ ] 3.3 独立超长帧兜底：与任何交互都不相交、但 `blockingDuration ≥ warnThresholdMs` 的 LoAF，单独记一行 warn（`long frame 480ms (no interaction) scripts: [...]`）——捕获"没在交互但界面冻住"（滚动/鼠标拖动这类 Event Timing 不覆盖的连续交互也由此兜底）。同样过 `WarnThrottle`。
- [ ] 3.4 纯函数（scripts 提炼/格式化/独立长帧判定）进 `interactionPerf.ts` + 单测。

**验证**：`pnpm check`；dev 手动：忙等场景的 warn 行带 `loaf:` 归因段且 sourceURL 指向真实脚本；滚动大文件时人为卡顿能出 `long frame` 行。

---

## 阶段 4 · main 侧极端冻结兜底

**目标**：renderer 完全冻死（Event Timing/LoAF 自身都无法执行）时，main 进程留下记录。

- [ ] 4.1 `windowMainService.ts` createWindow 内（`render-process-gone` 处理块旁，~:202）挂：
  - `win.webContents.on('unresponsive')` → 现成 logger `error` 一行（含 window id、时间戳）；
  - `win.webContents.on('responsive')` → `warn` 一行（含距 unresponsive 的恢复耗时，自算）。
  - 仅记日志，**不弹框**（Windows 锁屏/挂起会误报 unresponsive，弹框会造成干扰——参考 memory swarm 通知焦点门控教训，日志行足够事后分析）。
- [ ] 4.2 main 侧无需单测覆盖 Electron 事件本身；恢复耗时计算若抽纯函数则顺手测。

**验证**：`pnpm check`；dev 手动（可选）：DevTools console 跑 6s 忙等，main 日志出现 unresponsive/responsive 对。

---

## 阶段 5 · 可视化报告页 + 状态栏警示 + e2e

**目标**：`Developer: Interaction Performance` 一键查看会话聚合与最慢明细；慢交互频发时状态栏可选警示；e2e 固化保底行为。

### 5.1 报告页三件套（照抄 Startup Performance 形制）
- [ ] `services/editor/InteractionPerformanceInput.ts`：虚拟单例 input（`typeId: 'interactionPerformance'`，scheme `interaction-performance`，`serialize/deserialize` 同款）。
- [ ] `workbench/editor/InteractionPerformanceEditor.tsx`：mount 时 `IInteractionPerfService.getSummary()` 渲染——总览（总交互数 / 慢交互数与占比 / p95 / p99 / 最大）、按 eventType 直方图表、最慢 N 条明细表（时间 / 类型 / 三段分解 / 归因摘要 / 上下文）+ 手动"刷新"按钮重拉 summary。文案 localize。
- [ ] `BuiltInEditorProvidersContribution.ts` 追加 `registerEditorWithComponent`（带 deserialize，参照 :215-223 的 StartupPerformance 块）。
- [ ] `actions/performanceActions.ts` 追加 `ShowInteractionPerformanceAction`（id `workbench.action.showInteractionPerformance`，title "Interaction Performance"，category Developer，f1），`actions/index.ts` 注册。

### 5.2 状态栏警示（默认关）
- [ ] 配置 `performance.responsiveness.statusWarning.enabled`（boolean，default **false**）进 performance 组 + settings helper + i18n。
- [ ] `InteractionPerfContribution` 内订阅 `onDidRecordSlowInteraction`：滑动 60s 窗口内 warn 级慢交互 ≥ 5 条时 `addEntry`（`$(pulse)` + kind 'prominent' + command 跳报告页，照 StartupPerformanceStatusContribution 形制），窗口回落后 dispose 条目。

### 5.3 e2e 探针 + spec
- [ ] `@universe-editor/e2e-contract` 契约扩 `getInteractionPerfSummary(): Promise<{ totalSampleCount, slowCount, byType: ... }>`；`renderer/e2e/probe.ts` 实现（直读 `IInteractionPerfService.getSummary()` 白名单字段）。
- [ ] `e2e/specs/smoke.interactionPerf.spec.ts`（不标 @p0）：
  1. 启动后 `page.evaluate` 安排一个 `setTimeout(() => 忙等 400ms, 50)`，随即 `page.keyboard.press`（CDP 输入 isTrusted，能产 Event Timing entry），按键落在忙等窗口内 → inputDelay 超阈值；
  2. `expect.poll(() => probe.getInteractionPerfSummary())` 断言 `slowCount ≥ 1`（探针路径，避开日志 150ms 防抖落盘时序）；
  3. （可选加固）读 `<userData>/logs/<session>/window-1/interactionPerf.log` 断言存在 `slow` warn 行——沿用"日志计数断言"手法。

### 5.4 文档与收尾
- [ ] `docs/user/` 检查：若存在设置项/命令参考文档，补 `performance.responsiveness.*` 与新命令条目；`pnpm docs:check` 无死链。
- [ ] `apps/editor/CLAUDE.md` 套路 G 末尾追加两句：运行时响应性监控入口（`InteractionPerfService` / `recordPerfPhase` / `interactionPerf.log`），新嫌疑代码包 `recordPerfPhase` 即自动进慢交互报告。

**验证**：`pnpm check`；`pnpm e2e specs/smoke.interactionPerf.spec.ts` 定向通过；`pnpm e2e:smoke` @p0 全绿（确认监控常驻不影响既有交互冒烟）。

---

## 风险与注意

- **监控自身不能成为卡顿源**：observer 回调保持 O(entries) 轻量；上下文快照全 O(1)（`getLineCount` O(1)，禁 `getValue()`）；聚合只在内存，仅慢交互落盘。Event Timing entry 派发在帧 present 之后（不在交互关键路径上），本身安全。
- **Event Timing `duration` 是 8ms 粒度取整**（安全防指纹），presentationDelay 分解可能出负值——必须 clamp；分析时也别把 8ms 抖动当回归。
- **`interactionId === 0` 的 entry 不是用户交互**（如程序触发的 focus），主统计流要过滤，慢的单独标注 `non-interaction` 记录，不进交互分位数。
- **日志噪音**：持续卡顿场景（大文件持续打字）靠 `WarnThrottle`（1s/类型 + suppressed 计数）压制；发布版默认开启的前提就是"正常使用零输出、异常时有界输出"。
- **happy-dom / renderer-node 无 PerformanceObserver**：service 装配路径 try/catch 静默降级（照 TabSwitchPerf 先例）；单测一律以 DTO 驱动纯函数与内部处理方法，不桩 observer 本体。
- **disposable 泄漏**：两个 observer 的 disconnect、配置订阅、状态栏 accessor 全部走 `_register`；reload 有 tracker 会报红（memory `reload-disposable-leak-marksingleton`）。
- **StrictMode**：监控主体在 contribution/service（非 React），不涉 useRef Emitter 坑；报告页组件只读 summary 快照，无副作用句柄。
- **不要动 TabSwitchPerf 的行为**：阶段 1 是纯符号迁移，`tabSwitchPerf.log` 输出格式与现有插桩点语义必须逐字不变（用户已依赖该日志排障，见 memory 大文件十连修）。
- **Windows 锁屏/系统挂起可能误报 unresponsive**：阶段 4 只记日志不弹框不通知，分析日志时结合 responsive 恢复行判断。
- **e2e 的忙等注入时序**：忙等必须安排在按键之后才开始（setTimeout 延迟启动），否则 `page.keyboard.press` 的 CDP 调用本身会被忙等阻塞在派发前，测不到 inputDelay。

---

## 涉及文件速查

**新建**：
- `apps/editor/src/renderer/services/performance/perfPhases.ts` — 通用相位记录 + 时间窗交集（阶段 1）
- `apps/editor/src/renderer/services/performance/interactionPerf.ts` — 采集纯函数（分解/去重/直方图/节流/格式化）（阶段 2/3）
- `apps/editor/src/renderer/services/performance/interactionPerfSettings.ts` — 配置 key + 读取 helper（阶段 2）
- `apps/editor/src/renderer/services/performance/InteractionPerfService.ts` — 双 observer 装配 + 聚合 + 日志（阶段 2/3）
- `apps/editor/src/renderer/contributions/InteractionPerfContribution.ts` — 配置门控启停 + 状态栏警示（阶段 2/5）
- `apps/editor/src/renderer/services/editor/InteractionPerformanceInput.ts` + `workbench/editor/InteractionPerformanceEditor.tsx` — 报告页（阶段 5）
- `apps/editor/e2e/specs/smoke.interactionPerf.spec.ts`（阶段 5）

**修改**：
- `services/performance/tabSwitchPerf.ts` — 通用件迁出（阶段 1）
- `workbench/editor/FileEditor.tsx` / `contributions/DirtyDiffContribution.ts` / `workbench/scm/mergeConflict/inlineConflictController.ts` — `recordPerfPhase` 改名迁移（阶段 1）
- `renderer/main.tsx` — service 注册（阶段 2）
- `contributions/SettingsContribution.ts` — performance 组追加三键（阶段 2/5）
- `contributions/registration/afterRestore.ts` — contribution 注册（阶段 2）
- `shared/i18n/messages/{zh-CN,en-US}.ts` — 设置/界面文案（阶段 2/5）
- `main/services/window/windowMainService.ts` — unresponsive/responsive 日志（阶段 4）
- `actions/performanceActions.ts` + `actions/index.ts`、`contributions/BuiltInEditorProvidersContribution.ts` — 命令与报告页注册（阶段 5）
- `packages/e2e-contract` + `renderer/e2e/probe.ts` — 探针扩展（阶段 5）
- `apps/editor/CLAUDE.md`（套路 G 补两句）、`docs/user/`（如有设置/命令参考）（阶段 5）

---

## 验证记录

**阶段 0 · API spike（2026-08-01，Electron 33 / Chromium 130，临时 e2e spec 驱动，已删）**：

- `supportedEntryTypes` 含 `'event'` 与 `'long-animation-frame'` ✓
- **`performance.interactionCount` 不可用（undefined）** → 聚合分母按预案降级为"仅 ≥16ms 样本数"，报告页标注口径 ✓
- 可信输入（`page.keyboard.type` / `mouse.click`）产 keydown/keypress/keyup、pointerdown/pointerup/click entry，带非零 `interactionId`、`processingStart/End`、`target`（Element，可读 tagName/id/className）✓
- **同一交互的多 entry 共享 interactionId**（pointerdown/pointerup/click 同 id）→ `dedupeByInteraction` 必要 ✓
- `duration` 确为 8ms 取整（144/256/336…）✓；entry 在 present 后派发（需等帧 + takeRecords 收全）
- 忙等 300ms 中点击：pointerdown `startTime→processingStart` inputDelay ≈ 79ms、processing ≈ 0、presentation ≈ 65ms（duration 144ms）；rAF 实测 click→paint 492ms——entry duration 与感知延迟正相关但口径不同 ✓
- **LoAF `scripts[]` 可为空数组**（React 调度/async 边界场景），代码必须容错 ✓；注入代码的 script invoker 为 `TimerHandler:setTimeout`、sourceURL 空，真实 bundle 代码带 url+fn（如 `index-*.js performWorkUntilDeadline`）
- 坑：`buffered: true` 装配早期有交付竞态（首轮 keydown 漏收，重试收到）——e2e 断言一律 `expect.poll`，勿一次性读取

真实 entry 样例（忙等中点击的 pointerdown）：
```json
{ "name": "pointerdown", "startTime": 1146.8, "duration": 144, "interactionId": 2834,
  "processingStart": 1225.8, "processingEnd": 1225.8,
  "target": { "tagName": "DIV", "className": "_agentActions_..." } }
```
LoAF 样例（忙等帧）：`{ duration: 301, blockingDuration: 250, scripts: [{ invoker: "TimerHandler:setTimeout", duration: 300 }] }`

**阶段 1-5 实施（2026-08-01）**：

- 全阶段落地，`pnpm check` 全绿；`pnpm e2e specs/smoke.interactionPerf.spec.ts` 定向通过；`pnpm e2e:smoke` 66 用例全绿（监控常驻 + 泄漏门禁对每个用例生效，零干扰）。
- 真实慢交互 warn 行（e2e 忙等 400ms 中按键，取自 `window-1/interactionPerf.log`）：
  ```
  slow keydown 496ms (input 36 / processing 1 / present 459) events=[keydown+keypress+keyup] target=body loaf: [frame 460ms blocking 352ms: <anonymous> (TimerHandler:setTimeout) 400ms | frame 93ms blocking 36ms: <no script attribution>]
  long frame 460ms blocking 352ms (no interaction) scripts: <anonymous> (TimerHandler:setTimeout) 400ms
  ```
- 真实环境抓到一个单测覆盖不到的 bug 并已修：observer 回调直接把 PerformanceEntry cast 成 DTO，真实 entry 的字段是 `name` 而非 `eventType`，导致 label/直方图键全为 `undefined`（单测 DTO 自带 eventType 所以全绿）。现为显式 DTO 转换 + e2e 断言 `byType` 含真实事件名防回归。
- @p0 冒烟全程（正常使用场景）`interactionPerf.log` 未产生任何慢交互行——"正常使用零输出"红线成立（仅忙等注入的 spec 目录下有行）。
