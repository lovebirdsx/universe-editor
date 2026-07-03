---
name: analyze-startup-performance
description: 诊断并定位本仓库（VSCode 范式 Electron 编辑器）的启动/恢复耗时问题——「A 目录启动比 B 目录慢 X 秒」「启动变慢了 / 启动性能回归 / Startup Performance 某阶段耗时飙升 / 某工作区打开特别慢」。给出如何读 Developer: Startup Performance 报告（Phases vs Marks 的区别、并行 load 不能相邻相减）、如何按套路 G 补细粒度 perf mark 把黑盒阶段拆开、跨进程 mark 的注册与聚合机制、以及区分「代码回归 vs 工作区状态/规模差异」的隔离实验法。聚焦通用定位流程；具体是哪个 service/contribution 慢由 agent 当场插桩测量判断。
disable-model-invocation: true
---

# 分析启动 / 恢复性能

本仓库有一套 VSCode 式的启动性能计时：两个进程（main + renderer）都用 `mark()` 打点，`TimerService` 把两边的 mark 聚合成一条时间线，`Developer: Startup Performance`（命令 id `workbench.action.showStartupPerformance`，见 `renderer/actions/performanceActions.ts`）把它渲染成 **Phases 表 + Marks 表**。

> ⚠️ 第一原则：**先读报告、再隔离变量、最后才插桩**。用户常给的是「两个目录各一张 Startup Performance 截图」——大多数「变慢」不是代码回归，而是**两个工作区的持久化状态 / 目录规模不同**。在动手改代码前，先判断差异落在哪个阶段、是否与工作区相关。

## 计时机制（必须先理解，否则会读错报告）

打点与聚合（套路 G）：
- **打点常量**：`apps/editor/src/shared/perf/marks.ts` 的 `PerfMarks`。新里程碑先在这里加名字，让 emit 端和读取端锁死同一字符串。
- **打点**：`import { mark } from '@universe-editor/platform'`；`mark(PerfMarks.xxx)`。main 与 renderer 通用（底层是 `performance.mark` / node polyfill，见 `packages/platform/src/base/performance.ts`）。
- **主进程 mark 的回传**：main 侧 `PerformanceMainService`（`main/services/performance/performanceMainService.ts`）用 `getMarks()` 读本进程 mark；`TimerService`（renderer）通过 `IPerformanceMarksService` 跨 IPC 拉过来，与 renderer 自己的 `getMarks()` 合并、按 `startTime` 排序。
- **两个 `code/timeOrigin`**：main 和 renderer 各注入一个；聚合时取最早的（main 的）为 0 点。所以 renderer mark 的 offset 是相对 main 启动的绝对时刻。

报告的两张表（`renderer/services/performance/TimerService.ts`）：
- **Phases 表**：只显示 `MILESTONES` 数组里、且**实际被 emit** 的里程碑；按 startTime 排序后**相邻两个配对**成一个 phase，duration = 后 − 前。加进 `MILESTONES` 才会出现在这张表。
- **Marks 表**：显示**所有** mark 的绝对 offset（不限于 MILESTONES）。

### 读报告的两个致命陷阱

1. **Phases 的相邻配对只对「串行」里程碑有意义**。如果两个 mark 来自**并行**执行的任务（典型：`main.tsx` 里 `Promise.all([...load()])` 的几个完成点），它们的时间会重叠，相邻相减得到的是「谁比谁晚多少」而非各自耗时——会严重误导。**并行任务只能用 Marks 表的 offset 直接比大小**（谁 offset 最晚 = 谁是这组并行的瓶颈）。
2. **lazy mark 会乱序落点**。`extHostDidSpawn`、`didInitializeMonaco`、`mainDidWatchWorkspace` 等是懒触发的，可能落在 window mount **之后**。`MILESTONES` 靠「先按 startTime 排序再配对」保证 duration 非负，但也意味着它们在 Phases 表里的相邻邻居可能不是你以为的那个。跨进程的 lazy mark，优先看**成对 will→did 自身的 duration**，别信它和别的里程碑的相邻段。

## 定位流程

### 1. 逐阶段对齐，找出差异落点
把两张报告（慢的 vs 快的）按 **Phase duration** 逐行对齐（不是按 Marks 的绝对 offset——offset 会累积传导，前面慢一点后面全部顺移，看着处处都慢）。差值大的那几段就是嫌疑。

判断差异是否与工作区相关：
- **与工作区无关的早期阶段**（Main 启动、创建窗口、renderer bootstrap、IPC ready、Window shown）两边应几乎一致。如果这里就有大差异 → 才是真代码回归 / 环境问题。
- 差异集中在**恢复相关阶段**（`Ready phase` → `Services restored`、`Workbench mounted` → `Editors restored`）→ 极可能是**工作区状态/规模**差异，不是代码。

### 2. 隔离变量（改代码之前必做）
用户给的「两个不同目录」通常混淆了多个变量（是否 git repo、目录规模、打开的 tab 数、恢复的终端数、ACP session 数）。挑一个做受控实验：
- **隔离 git**：临时把 `<workspace>/.git` 改名成 `.git_bak`，重启看报告，再改回。阶段几乎不变 → 病因是目录规模而非 git。
- **隔离规模**：打开一个「同样是 git repo 但很小」的目录对比。
- **隔离持久化状态**：关掉所有 tab / 面板终端后重启对比。

一次只动一个变量。

### 3. 拆黑盒：给可疑阶段补细粒度 mark
确认某个 phase 是黑盒后，按套路 G 在其内部补 mark。步骤：
1. 在 `PerfMarks`（marks.ts）加常量。
2. 在 emit 点 `mark(PerfMarks.xxx)`。**注意执行时机**：
   - `lifecycle.setPhase(Ready)` 只是同步 resolve 一个 Promise barrier；BlockRestore contributions 是 `when(Ready).then(...)` 的**微任务**里实例化的。想测 contribution 耗时，必须 `await lifecycle.when(LifecyclePhase.Ready)` 之后再打点，否则打在同步位置测到的是 ≈0 的假数据（见 `main.tsx` 现有 `didBlockRestore` 的写法）。
   - 并行的 `load()` 组：把完成点挂在**各自** promise 上（`x.load().then(() => mark(...))`），保持 `Promise.all` 并行不变，每个 load 独立计时。
3. 串行边界加进 `TimerService.MILESTONES`（进 Phases 表）；并行完成点**不要**都进 MILESTONES（会相邻误配），留在 Marks 表看 offset。
4. 只打**冷启动首次**：像 `fileWatcherMainService` 的 `_didMarkFirstWatch` 那样加标志，避免 setExcludes/切换工作区的重订阅污染启动时间线。
5. `pnpm check` 验证（`TimerService.test.ts` 会断言所有 phase duration ≥ 0）。
6. 让用户重新采集报告，回到步骤 1 对比。

## 各阶段「里面在跑什么」速查

启动主线在 `apps/editor/src/renderer/main.tsx` 的 `bootstrapWorkbench()`：

| Phase（Phases 表标签） | 代码位置 | 内容 |
|---|---|---|
| Ready phase → BlockRestore contributions | `main.tsx` setPhase(Ready) + `await when(Ready)` | BlockRestore contributions 实例化，含 `WorkspaceRestoreContribution` 从 storage 重建编辑器组（打开 tab 越多越慢） |
| BlockRestore → State restore start | `main.tsx` E2E 探针安装等 | 通常很小 |
| State restore start → Services restored | `main.tsx` `Promise.all([layout/viewDescriptor/views/terminal .load()])` | 四个并行恢复；看 `didLoad*` 各自 offset 找瓶颈（终端恢复、大 layout 常是主犯） |
| Services restored → Monaco initialized | `MonacoLoader.ts` lazy | Monaco dynamic import；会被主进程 CPU 争抢拖慢 |
| Workbench mounted → Editors restored | `Workbench.tsx` useEffect | React 挂载 + 编辑器实体恢复，tab 越多越慢 |
| Workspace watch start → ready | `fileWatcherMainService._subscribe` | 主进程对工作区根**递归** parcel 订阅；大目录冷订阅 + FS 遍历吃 CPU，和 renderer 恢复同时发生形成争抢（`.git`/`node_modules`/`dist` 已在 ignore 里，见文件头） |
| Editors restored → Extension host spawned | `Eventually` phase | SCM/git 扩展宿主在**独立进程**、首屏之后才 spawn（`eventually.ts`）。**它不在首屏恢复窗口内**——别把 git 扩展当成恢复变慢的病因 |

> 关键澄清：git repo 常被当成「启动慢」的元凶，但 SCM/git 跑在懒启动的扩展宿主进程、在 `extHostDidSpawn`（通常晚于 `didRestoreEditors`）才起。git 真正影响首屏的路径是**间接**的：git repo 往往 = 大目录 → parcel 递归订阅 + Explorer 树首读吃 CPU，拖慢同时在跑的 renderer 恢复。用步骤 2 的隔离实验区分「git 本身」vs「目录规模」。

## 参考文件

- `apps/editor/src/shared/perf/marks.ts` — mark 常量
- `apps/editor/src/renderer/services/performance/TimerService.ts` — 聚合 + MILESTONES + Phases 生成
- `apps/editor/src/renderer/main.tsx` — 启动主线，恢复窗口打点密集处
- `apps/editor/src/renderer/actions/performanceActions.ts` — Startup Performance 命令
- `apps/editor/src/main/services/performance/performanceMainService.ts` — 主进程 mark 回传
- `apps/editor/src/main/services/fileWatcher/fileWatcherMainService.ts` — 冷启动只打首次的样板
- `docs/plan/maintainability-roadmap/06-perf-and-engineering.md` — 计时体系的规划背景（套路 G）
