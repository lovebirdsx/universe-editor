# 06 · 防回涨机制

> 依据：[05-acp-ai.md](../architecture-review-202607/05-acp-ai.md) #3、[03-main-process-ipc.md](../architecture-review-202607/03-main-process-ipc.md) P3、[04-renderer-workbench.md](../architecture-review-202607/04-renderer-workbench.md) P2 #6。
> 批次：三个任务均第二批（P2）。
> 核心认知：上一轮"拆上帝文件"做完后，acpSessionService 依赖 14→16（唯一逆行指标）、windowMainService 比路线图时还大、main.tsx 迁移半途——**单纯再拆一轮解决不了趋势，需要机制性门槛**。

## 任务 1：acpSessionService 依赖上限 + 职责外移 ✅（P2，第二批）

> ✅ 已完成（2026-07-21）：
> - **先立机制**：新增守卫单测 `AcpSessionService.depBudget.test.ts`，用 `_util.getServiceDependencies(AcpSessionService)` 断言注入数 ≤ `MAX_INJECTED`（当前 15）。抬高该值必须在测试处写 review 注释说明"为何不能挂 registry/coordinator/协作服务"；目标随外移逐步下调至 ≤12。
> - **职责外移（注入 17→15，文件 1,257→1,200 行）**：
>   - auth 冷却通知 → 新 `IAcpAuthGuidanceService`（`acpAuthGuidanceService.ts`）：接管 session 启动失败提示 + `onDidRequireAuth` 冷却节流 + 打开 Agent Settings 命令，**彻底移除 facade 的 `ICommandService` 注入**。
>   - session 构造 → 新 `IAcpSessionFactory`（`acpSessionFactory.ts`）：`_changeTracker`/`_titleService`/`_compactionStats` 此前**仅用于** `new AcpSession(...)` 两处，移入工厂后 3 个注入从 facade 消失；`withTitleService` 开关保留"resume 不重生成标题"语义。
> - **验证**：`pnpm check` 全绿（editor 3,867 例）；p0 agents + acpEditorTitle + agentsEmptySessionRestore 三个 e2e 通过。20 处测试构造点同步迁移（复用同一 history/notification 实例以保持断言）。
> - **待续（本任务后续小步）**：title 编排（`acpSessionTitleService` 桥点）与 MCP dropped 告警仍在 facade，可继续外移把注入推向 ≤12；每步动守卫断言值。

**背景**：`acpSessionService.ts:276-293` 现 16 个 @inject、1,250 行；registry/coordinator 已抽出但 facade 仍兼任通知汇聚、auth 冷却、MCP dropped 告警、title 编排。

**步骤**：

1. **先立机制再拆**：加一个守卫单测，断言 AcpSessionService 构造注入数 `<= 当前值`，每外移一个职责就下调断言值，目标 ≤12；PR 中新增依赖需在测试断言旁注释说明"为何不能挂 coordinator/registry"。
2. 职责外移（各自找 owner，逐个小步提交）：
   - title 编排 → acpSessionTitleService（本就是桥点）；
   - auth 冷却通知 → 独立小服务或并入连接层；
   - MCP dropped 告警 → 通知类 contribution 或 restore coordinator。
3. 每步外移保持外部 API 不变（facade 转发可以留，依赖必须走）；对应单测跟随迁移。

**验收**：@inject 回到 ≤12 且有测试锁住上限；后续新增依赖必须动守卫测试（强制过 review 讨论）。

## 任务 2：windowMainService 启动拆分 ✅（P2，第二批）

> ✅ 已完成（2026-07-21）：主文件 745→646 行。
> - **步骤 1（session 持久化外移）**：`_persistSessionNow`/`_scheduleSessionPersist`/timer/几何写入 → 新 `WindowSessionStore`（`windowSessionStore.ts`，纯状态读写，接受 `() => 快照` 以在写时看到活窗集合）。facade 仅保留 `_quitting` 门控转发。新增 5 例独立单测 `windowSessionStore.test.ts`（debounce 合并/destroyed 跳过/几何写入/cancel 抑制）。
> - **步骤 2（per-window 服务装配外移）**：原 `:267-314` 的 workspace/storage/userData/host/log/terminal/fileWatcher 构造 + IPC bootstrap + session-switcher 注册 → 新 `createWindowScopedServices`（`windowScopeFactory.ts`）。facade 耦合（新建窗口/查 rendererLifecycle/focus/focusForWorkspace）以 callbacks bag 传入，`MainWindowsService` 需要的 service 反引用单独作 `windowsServiceHost` 参数。
> - **步骤 3（保留）**：崩溃恢复 + close/quit veto 编排按计划留在主类（与窗口生命周期强耦合）。
> - **验证**：`pnpm check` 全绿；window 单测 25 例全过；windows/folderDragNewWindow/editorRestore 三个 e2e（共 7 例）通过。

**背景**：725 行，比上一轮路线图时还大；一个类承担窗口创建+webPreferences、per-window 服务工厂（`:267-314`）、IPC bootstrap、崩溃恢复、close/quit veto 编排、session 持久化+几何恢复（`:674-710`）。上一轮的前置条件（补测试）已完成，拆分风险已降。

**步骤**（按独立度排序，小步提交）：

1. 先抽最独立的 session 持久化：`_persistSessionNow` / geometry 一族 → `WindowSessionStore`（window/ 目录内新文件，纯状态读写无窗口生命周期耦合）。
2. 再抽 per-window 服务装配：`:267-314` 与 `scopedServicesFactory` 合并归位。
3. 崩溃恢复（`:217-254`）与 close/quit veto 编排暂留主类（与窗口生命周期强耦合，拆出去反而绕）；若 02·任务 2 的反向 RPC 超时改动先落地，veto 编排顺手收敛。
4. 现有 `window/__tests__/` 4 个测试跟随迁移，每步 `pnpm check` + 窗口相关 e2e（多窗口、reload、退出路径）。

**验收**：windowMainService 主文件降到 ~450 行以下且职责表清晰；session 持久化可独立单测。

## 任务 3：main.tsx registerSingleton 迁移收尾 ✅（P2，第二批）

> ✅ 已完成（2026-07-21）：main.tsx 845→807 行。
> - **迁移 7 个被动服务**（无启动期构造副作用、由 eager 注入方/贡献物化）→ `registerSingleton`：`CompareService`/`HistoryService`/`RecentEditsTracker`/`LanguageFeaturesService`/`ActivityService`/`WebviewService`/`StatusBarService`。各文件尾部加 `registerSingleton(...)`，并在 `services/index.ts` 侧效聚合器登记一行。
> - **刻意保留 eager 手工装配的清单**（`services.set`）：凡构造函数跑启动期副作用（`RecentEditorsService` 播种 MRU、`ClosedEditorsService`/`FocusStackService` watch 分组、`ApiUsageService` 轮询、`ExtensionsWorkbenchService`/`ExplorerTreeService` 启动订阅），或需精确装配时序（Lifecycle/ContextKey/Storage/IPC 引导），一律留在手工路径——**内核无 eager 物化 pass**（连 `InstantiationType.Eager` 也只是"首次注入不套 Proxy"），若迁 `Delayed` 会把这些副作用静默推迟到首次访问，属回归。
> - **关键坑（e2e 抓到）**：7 个服务初版用 `Delayed`，`ai` 包 e2e 报 `LanguageFeaturesService.onDidChangeDocumentSymbolProviders` 泄漏——`Delayed` 的 Proxy 用 `earlyListeners` 缓冲事件订阅，其缓冲机制在 teardown 泄漏。这些服务原本就 eager 构造，改 `Eager` 后（首次注入即真对象、无 Proxy、`markAsSingleton` + 入容器 disposeBucket，等价旧 `workbenchStore.add`）泄漏消失。
> - **注释收敛**：删 `getSingletonServiceDescriptors` 循环处的 "incremental migration" 注释，改为说明"默认走 registerSingleton；手工 `services.set` 是需精确装配时序的引导豁免"。
> - **验证**：`pnpm check` 全绿（editor 3,872 例 + 全部包）；`pnpm e2e` 20/20 task 全过（含此前失败的 ai 包 + `@p0` disposable-leak 检测）。
> - **未达 ~500 行目标（诚实说明）**：main.tsx 主体是引导逻辑（错误处理、leak 追踪、reconcile、mount），非注册代码；进一步压行需迁移带启动副作用的服务，与"装配顺序是正确性"直接冲突，遂止步。注册路径已收敛为"registerSingleton 默认 + 显式引导豁免清单"两条，达成验收核心。

**背景**：`main.tsx` 845 行，`services.set` 与 `getSingletonServiceDescriptors` 两条注册路径共存，注释自称 "incremental migration"（`:407-410,537,606-607,630`）未完成；依赖顺序靠 "Must exist before X" 注释维系（`:145-151`）。

**步骤**：

1. 盘点手工 `new` 的 32 处：确需精确时序的（Lifecycle/ContextKey/Storage 等 bootstrap 硬核心）留下并注释"为何必须手工"；其余迁 `registerSingleton` 描述符懒解析。
2. 迁移分批按 LifecyclePhase 分组进行，每批全量 e2e（装配顺序是正确性，这里不省）。
3. 收尾后删 "incremental migration" 注释，main.tsx 目标 ~500 行以下；"Must exist before X" 类顺序约束能转为描述符依赖表达的转掉，转不掉的保留注释但集中到一处。

**验收**：注册路径只剩一条（+ 显式登记的 bootstrap 豁免清单）；新增服务默认走 registerSingleton，不再触碰装配顺序。

---

## 机会型任务（P3，随迭代顺手做）

- ⬜ acpSession.ts（1,640 行）继续按"模型投影"渐进拆：plan/usage/权限/提问/MCP/折叠/计时等"会话外围状态"各自是独立 observable 簇，拆成组合进 session 的小对象；applyUpdate 大 switch + 三套派生模型 + 批处理事务是内聚核心，保留。随功能改动推进，不单独排期。
- ⬜ 持久化小服务增生观察（10+ 个 persistedStateBase 派生）：暂不合并，若继续增生考虑收敛注册表。
