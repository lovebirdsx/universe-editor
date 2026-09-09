> 本文从 [CLAUDE.md](CLAUDE.md) 拆出的案例细节：通知链五环 + guard silent + 日志观测点。红线结论见主文档。

### ⚠️ SwarmApi 的 fetch 必须有 per-request 超时（网关挂起卡死 poll 闩锁）

**真实 bug（前台也零通知）**：`fetch()` 自身**没有可用的默认超时**（undici 的 `headersTimeout` ≈300s）。部署里 Swarm 前面挡着一个会 504 慢端点的网关，它**接受连接但永不回包** → `SwarmApi` 的 dashboard fetch 挂起数分钟 → renderer `SwarmReviewNotificationContribution.refresh()` 的串行 `_running` 闩锁一直被占 → 之后每个 poll tick 都在 `if (this._running) return` 处丢弃 → **前台后台全静默**（侧栏不受影响：它的 dashboard 走不同 in-flight key）。

- **修复**：`SwarmApiOptions.timeoutMs`（默认 30s，`resolveSwarmRequestTimeoutMs`：显式 option > `UNIVERSE_SWARM_REQUEST_TIMEOUT_MS` env（e2e 用）> 默认）。`_once` 里 `AbortSignal.timeout(this._timeoutMs)` 与调用方 signal 经 `AbortSignal.any` 组合后**无条件**传给 fetch。
- **失败分类靠 `errorName()` 结构读 name，别用 `instanceof Error`**：fetch abort/timeout 的 reject reason 是 DOMException（不保证 `instanceof Error`）。`AbortError`（调用方主动取消）与 `TimeoutError`（超时）都包装成 `SwarmError(Network)`——**不重试**（`isTransient` 不含 Network；超时请求可能已被服务端处理，POST 重试有重复应用风险），由下一个 poll tick 自然恢复。
- **e2e 回归**：`swarmReviewNotificationHung.spec.ts`——fake server `setHang(true)` 挂起 GET /reviews 两个 poll 周期，解除后新 review 必须仍通知（修复前闩锁卡死、恒不通知）。fake-swarm.mjs 的 `/__control__/set-hang` 端点即为此加。
- 单测：`swarmApi.test.ts` 的 `SwarmApi request timeout`（挂起 mock 监听 `init.signal` abort 后 reject `signal.reason`，忠实模拟 undici）。

### ⚠️ fetch 超时不覆盖 fetch 之前：p4 凭据探针是第二卡点（44 分钟闩锁卡死）

上一节的 fetch 超时只覆盖 HTTP 层。**真实 bug（44 分钟零通知）**：挂死的 p4 进程（冻结的网络盘 / P4P 网关半开 TCP）让 `SwarmClient._auth()` 的 `login -s` + `tickets` 两个 spawn 永不返回——fetch 根本没发出，AbortSignal.timeout 从未启动。日志铁证：poll 挂 44 分钟后「**成功**」完成（无 warn、无超时）⟹ 卡点在 fetch 之前。放大器：每次 HTTP 请求都重跑 2 个 p4 spawn（无凭据缓存），一轮 poll = 2·(3+N) 次 spawn 挤 4 槽 ConcurrencyGate。修复是三层纵深：

1. **根因——`P4Service._spawn` 加超时**（`perforce.commandTimeout`，默认 600s，`0` 不限）：`SpawnWatchdog` 到点 `kill()`，close 时 resolve 成失败结果（**绝不从异步回调 throw**，见主 CLAUDE.md 的宿主崩溃红线）。凭据探针单独用 15s 紧超时（`swarmAuth.ts` 的 `CREDENTIAL_PROBE_TIMEOUT_MS`）——它们小、只读、每轮 poll 都跑，挂 10 分钟才杀毫无意义。
2. **放大器——`SwarmClient` 凭据短缓存**：`_auth()` 结果缓存 5 分钟（`CREDENTIAL_TTL_MS`）+ in-flight 合并（dashboard 并行 3 路请求共享一次探针）；失败（未登录）只缓存 30s（`CREDENTIAL_FAILURE_TTL_MS`）让重新登录快速恢复。ticket 中途失效由 **401 → `invalidateCredential()`** 兜底（guard 的 401 分支调用），缓存永不过期错认。
3. **兜底——renderer poll 闩锁加 deadline**：`SwarmReviewNotificationContribution.refresh()` 的 dashboard RPC 用 `withDeadline`（120s）、每个 `getTransitions`（60s）——RPC 层没有全局超时，任何一层再失守闩锁也会在 2 分钟内自愈（warn 日志 + 当失败 tick 处理）。**transitions 失败不得缓存 `[]`**：`filterNeedsAction` 对「未加载」乐观保留、对「已加载但无 Approve」过滤——失败时留 `undefined`（下轮重试），缓存 `[]` 会把该 review 静默移出通知范围并污染侧栏共享的 transitions 缓存。

- 单测：`swarmClient.test.ts` 的 `SwarmClient credential cache`（TTL 命中 / in-flight 合并 / 过期重探 / invalidate / 失败短缓存）、`swarmCommands.test.ts`（401 调 invalidateCredential）、renderer `SwarmReviewNotificationContribution.test.ts` 的 `a dashboard RPC that never settles`（fake timers 推过 deadline → 闩锁释放、下 tick 恢复通知；transitions 挂起 → 该 review 乐观保留仍通知）。

### ⚠️ 轮询驱动的调用用 `guard()` 的 `silent`（静默 + rethrow，绝不弹 UI 也绝不吞 fallback）

`guard()` 默认在失败时弹 UI 并返回 fallback：401 分支 `await window.showErrorMessage(..., 'Login')`（**带 item 的模态确认**，promise 等用户点击才 settle），generic 分支弹错误 toast。**窗口在后台时模态无人可点 → 永不 settle**；后台 poll 每次失败弹 toast 是纯噪音。

- **真实 bug（通宵零通知）**：`SwarmNotificationPoller` 每 tick 驱动 `dashboard`；Swarm ticket 过期后某次 tick 命中 401 → guard 在后台窗口弹出看不见的模态 → renderer 的 `_running` 闩锁永久 true → 之后每个 tick 都被丢弃。19:49 最后一次通知后 3.8 小时零通知；切回窗口手动刷新才恢复。
- **次生 bug（失败 fallback 吞错）**：guard 失败时返回**空 dashboard** fallback，renderer `_notifyNew([])` 把它当「零 review」→ `_known` 基线被清空 → 恢复后下一个健康 tick 把**所有**已知 review 当新的重发一遍（幻影爆发）。
- **修复**：`guard(label, op, fallback, { silent: true })`——poll 驱动的 `dashboard` 传 true，**任何**失败只记日志并 **rethrow**（renderer poll 的 catch 本就静默吞掉，`_known` 不动；侧栏 `load()` 的 catch 显示错误状态，比假空列表更真实）。交互命令（vote/transition/createReview 等用户当场能点确认的）保持默认弹 UI + 返回 fallback。
- **判别准则**：凡是「定时器 / 后台 tick / 无用户在场」驱动的 Swarm 调用都传 `silent: true`；只有用户主动点按钮触发的才走默认。给新的 poll/后台数据命令接线时照此办。
- 回归单测：`__tests__/swarmCommands.test.ts`（401/Network 失败 rethrow、不弹任何 UI、立即 settle）；renderer 侧 `SwarmReviewNotificationContribution.test.ts`（dashboard reject 后 `_running` 闩锁释放、`_known` 基线保留、下一 tick 照常通知且无幻影爆发）。

### ⚠️ OS toast 的焦点门控必须考虑「人不在场」（整夜聚焦窗口零 OS 通知）

检测链路（poller → dashboard → renderer 决策）全部健康也可能颗粒无收：**真实 bug（第三环）**——renderer 日志三次 `notifying N new review(s)` 全部跟着 `OS toast gated (window focused...) → in-app fallback`，其中一次在深夜 00:07。根因在 main 侧 `MainHostService.notify()` 的门控只看 `win.isFocused()`：**Windows 在用户锁屏 / 离开后仍保持最后前台窗口的 focused 状态**，于是「焦点停在某个工作区窗口 + 人走了」= 每条新 review 的 OS toast 都被吞，只剩后台窗口里没人看的 in-app toast。多窗口更放大：只有 swarm 工作区那个窗口的焦点状态说了算。

- **修复（main 侧 `hostMainService.ts`）**：gate 条件 = `isFocused() && !_isUserAway()`；`_isUserAway()` 用 `powerMonitor.getSystemIdleState(120)` —— `locked` / `idle`（≥2 分钟无键鼠输入）视为不在场，照发 OS toast（进系统通知中心 + flashFrame）；`active` / `unknown` 保守视为在场维持原门控。所有 `IHostService.notify` 调用方（swarm + agent 通知）同时受益。**E2E 下探针冻结为「在场」**（无人值守 CI 恒 idle，会把聚焦窗口的 in-app fallback spec 全翻到 OS toast 路径）；`UNIVERSE_E2E_REAL_IDLE=1` 可 opt-in 真实探测。
- **诊断铁证是「缺失的日志行」**：host.log 只有 agent 的 `notify shown`、没有同时段 swarm 的 —— skipped 分支当时是 debug 级不落盘，只能反证。已把两个 skipped 分支（focused / unsupported）升为 **info**：`notify skipped (window focused, user present)`，之后排查直接看 host.log 的明示决策。
- 回归单测：`apps/editor/src/main/__tests__/services/hostMainService.test.ts` 的 `focused window with the user away`（locked / idle → shown；unknown → 保守 gate）。

### ⚠️ poller tick 链路绝不前置 await renderer（2.5 小时静默停摆，第四环）

**真实 bug（2026-08，一上午零通知）**：host poller 的 `_tick()` 先 `await this._isConfigured()`（`readSwarmConfig()` = 4 条串行 `_workbench.getConfiguration` RPC，每条都要 renderer 应答）再 `await executeCommand(TICK)`。窗口深度后台（完全遮挡 + 多窗重负载）时 renderer 迟迟不应答，**RPC 不 reject 就不进 catch**——11:40 后 2.5 小时零 poke、零 warn，host timer 与 renderer backstop 两个驱动同归于尽；14:13 手动切窗解冻，积压 RPC 一口气跑完，3 个 review 一次性通知。e2e 从未拦住：当时 `backgroundThrottling: false` 仅 e2e 开启，e2e 环境天然不经历节流，是盲区。

- **修复（三层）**：
  1. **tick 链路零前置 await**：`_isConfigured` 改**同步缓存读**（`boolean | undefined`；`undefined` = 缓存未填 **fail-open 照 poke**——poke 无害，renderer 自有 dashboard 命令存在性防御；`false` = skip）。缓存双路填充：激活兜底（原 6 条串行 RPC 并成一轮 `Promise.all`）+ renderer `setBackgroundPoll` 推送。
  2. **poke fire-and-forget + ack watchdog**：`executeCommand(TICK)` 不再裸 await——30s 无应答打 warn `poll tick not acknowledged by renderer within 30s`（每分钟至多一条，只警告不取消；reject 由 `.catch` 兜住防 host unhandled rejection），恢复后 info `poll tick ack restored`。
  3. **生产窗口全局 `backgroundThrottling: false`**（`windowMainService.ts`，对齐 VSCode `windowImpl.ts`），从机制上消灭"renderer 被节流"整类 bug；`UNIVERSE_E2E_THROTTLE=1` 语义反转为"显式 opt-in 节流场景验证"。renderer 另加 `visibilitychange` 补 tick（visible 且距上次成功 poll 超一个 interval 即 refresh），把"切窗即见"从节流解除的副作用变成显式保证。**侧栏列表本身另有一层同主题保证**：poll rising edge 发出的视图软刷新（`requestSwarmReviewsRefresh(false)`）是本 renderer 进程内的一次性信号——视图未挂载即被静默丢弃、也到不了别的窗口——故 contribution 在 window focus 时节流（5s）补发一次 soft 刷新，确保「切到窗口看到的列表就是最新」（soft 命中被 poll 保鲜的 host 侧 60s TTL 缓存，代价极低）。
- **观测补课（本次"死无对证"的两个缺口）**：poller 生命周期行（start / re-arm / stop / ack 超时 / ack 恢复）同时按语义级别 `console.info`/`console.warn` 镜像——host 的 stdoutProtection 把所有 console.* 重定向到 stderr 并打级别标签，main 按标签路由回对应日志级别并落进会话根 `extensionHost.log`（红线：**绝不写 stdout，那是 RPC 通道**；常态行**不许用 `console.error`**，否则在日志里被误标成 error；`poll tick failed` 这类 renderer 状态噪音不镜像）；renderer tick handler 记录上次 tick 时刻，gap > 3×interval 打 info `tick gap <N>s` 到 `swarmNotify` logger。
- **红线重申**：poller tick 路径**不得引入任何对 renderer 的前置 await**（配置读取、健康探测、握手——一律不许）。需要 renderer 状态时走"renderer 推送 + host 缓存"模式。
- **回归**：poller 单测（poke 永不 settle 时 tick 不停摆 + watchdog warn + ack 恢复 + stderr 镜像断言）、`swarmCommands.test.ts` 的 setBackgroundPoll payload 套件、renderer contribution 单测（推送 retry / 粗粒度配置重推 / visibilitychange 补 tick / tick gap）、e2e `swarmReviewNotificationThrottled.spec.ts`（`UNIVERSE_E2E_THROTTLE=1` 真实节流 + minimize，通知必达）。

### ⚠️ transitions 判定缓存必须按 `updated` 失效（投票翻案永不通知，第五环）

**真实 bug（2026-08，窗口后台 7 个 review 延迟 53~193 分钟才通知）**：与前四环不同，驱动链路完全健康——三个事件时刻全部落在 60s tick 网格上、`extensionHost.log` 零 ack 超时、后台窗口成功 `notify shown` 有实锤。这次断在**数据过滤层**：`needsActionApprovableOnly: true` 时 poll 靠 `swarmReviewsViewState.transitions`（renderer 模块单例，与侧栏共享）判「可批准」，而旧逻辑 `if (cache[review.id]) return` **一旦有值就永不重拉**。该 Swarm 部署的 workflow 在投票条件满足前不开放 `approved` 转移 → 新 review 首拉 verdict =「不可批」被过滤；组员投票后服务器已可批（且 `updated` 已 bump），但缓存钉死旧 verdict → **永不通知**。只有手动刷新侧栏（`load(force)` 全量重拉进共享缓存）才翻案，而翻案时人必在窗口前 → OS toast 被焦点门控吞成 in-app → 体感「后台永远不通知」。前四环修不到它的原因：都在修驱动层，而 `poll ok: N actionable` 当时是 debug 级不落盘——**过滤发生在暗处，0 actionable 与 0 候选无从区分**。

- **修复（缓存失效协议）**：`swarmReviewsViewState.transitionsSeenUpdated` 记录每个 entry 拉取时的 `review.updated`（vote / re-shelve / 评论都会 bump 它，dashboard 每 tick 带回最新值）。stamp 移动 = stale → 重拉且 **`getTransitions(id, force=true, silent=true)` 穿透 host 侧 60s TTL 缓存**（`swarmClient.getTransitions(force)` 先 invalidate 再 wrap，否则 TTL 会把旧 verdict 原样回吐）；**首拉（无 entry）不 force**——没有旧 verdict 要冲掉，吃 TTL 缓存省服务器请求；**失败不写 seenUpdated**（cache 保留旧值防误报，下一 tick 因仍 stale 自动重试）。稳态（updated 不动）零额外请求；翻案最迟 1 个 tick 可见。侧栏 `SwarmReviewsView.loadTransitions` 同一协议（挂载/手动刷新路径也自动翻新），staleIds 清理同步清 seenUpdated。
- **观测补课**：`poll ok` 现在带**过滤明细** `N actionable (pool P, dropped: A author-filtered, B not-approvable, C ignored, D authored)`，且**计数指纹变化即升 info**（稳态仍 debug 零噪音）——下次「有 poll ok 但不通知」直接看哪个桶吃掉了 review。
- **附带修复（补推）**：`setBackgroundPoll` 推送重试预算 20×250ms=5s，冷启动 host 实测 11s+ 可能耗尽 → host 首个 tick 到达（证明命令面已活）时检测到预算曾耗尽即重置并补推一次，否则 host driver 拿着过期 enabled/interval 快照跑到下次配置变更。
- **已知权衡（不改）**：dashboard 白名单池实测数百个 open review，`max: 50` 截断——Swarm 按 id 降序返回（新的在前），新 review 不受截断影响；扩池只影响「陈年 review 突然翻案」的边角，不值得每 tick 多拉 4 页。
- **回归**：`SwarmReviewNotificationContribution.test.ts`「fifth incident」套件（updated bump + verdict 翻转 → 必须通知【修复前红】；updated 不动不重拉且首拉不 force；重拉失败保 stale 下轮重试；补推用例）；`swarmClient.test.ts` 的 `getTransitions(force)` 穿透 + re-prime 用例；`SwarmReviewsView.test.tsx` 首拉 `force=false` 断言。

### 🔍 通知链路的日志观测点（排查「收不到通知」先看这三处）

- **main 侧（`host.log`，会话根目录）**：每次 OS toast 的**最终决策**——`notify shown title=...`（弹了）/ `notify skipped (window focused, user present)`（焦点门控吞掉）/ `notify skipped (notifications unsupported)`，全部 info 默认可见。renderer 说 `notifying` 但系统没弹，第一站看这里。
- **host 侧（Swarm 输出频道 + `extensionHost.log` 会话根目录）**：poller 启停（info）/ tick 节奏（debug）/ tick 失败（warn）；guard 的 `cmd` scope 有每次 dashboard 的 start/ok/failed（poll 静默失败带 `(silent)` 标签）；`api` scope 有每个 HTTP 请求的状态 + 耗时 + 重试；`auth` scope 有凭据解析失败与 invalidate。默认安静，开 `perforce.swarm.trace` 后 debug 全量（tick 心跳、请求/响应细节）。**poller 的五类生命周期行同时镜像进 `extensionHost.log`**（stderr 转发，`[stderr <handle>] [swarm poll] …` 前缀）：`poll driver every Ns` / `re-armed` / `stopped` / **`poll tick not acknowledged by renderer within 30s`** / `poll tick ack restored`——输出频道重启即失，镜像行是跨重启可考的铁证。
- **renderer 侧（`swarmNotify` logger，窗口私有日志 `window-<id>/`）**：poll 启停 / 基线 prime / **闩锁丢弃（`poll tick dropped: previous refresh still running`——闩锁卡死的第一信号，连续出现即 bug）** / poll 失败 warn（catch 不再静默）/ **分相位计时 + 过滤明细（`poll ok in Xms (dashboard Yms, transitions Zms): N actionable (pool P, dropped: ...)`——卡 dashboard 相位指向 host 侧 p4 凭据探针，卡 transitions 相位指向逐 review 的 getTransitions；相位 >30s 升级为 `slow phase —` info；计数指纹变化的 tick 升 info，稳态 debug）** / deadline 触发的 `did not settle within` warn / **`tick gap <N>s (host driver stalled or renderer was throttled)`——host tick 超过 3×interval 才到达，直接给出停摆时长** / 窗口可见时的补 tick（`window visible after Ns without a successful poll → catch-up tick`）/ 通知决策（`notifying N new review(s): #ids`）/ OS toast 被门控走应用内 fallback。常规节奏是 debug 级，关键事件 info/warn 默认可见。
- 判读套路：先看 renderer 有没有 tick 进来（无 → host poller / RPC 问题，看 `extensionHost.log` 有没有 `poll driver every` 与连续的 `not acknowledged`——**连续 `not acknowledged` = renderer 被节流/挂起；`tick gap` = 停摆时长实锤**）；有 tick 但全是 dropped（→ 上一次 refresh 卡住，看相位计时卡在哪个阶段 + host `api`/`auth` scope 是否有挂起/超时请求）；有 poll ok 但无 notifying（→ 过滤口径问题：看 `dropped:` 明细哪个桶吃掉了 review——author 白名单 / not-approvable（transitions verdict，第五环）/ ignore / authored）；有 notifying 但系统没弹（→ main 侧 host.log 看 shown/skipped 决策，focused+present 被吞属焦点门控语义，见上节）。
