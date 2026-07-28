# extensions/perforce/src/swarm/CLAUDE.md

> 本文是 `extensions/perforce/CLAUDE.md` 的子域文档（Swarm 代码审核子模块），原为其「Helix Swarm 集成」章。p4 插件基座（分层架构 / 连接红线 / 密钥红线 / `-Mj`·`-ztag` 坑）见 [`../../CLAUDE.md`](../../CLAUDE.md)。

## Helix Swarm（P4 Code Review）集成

**Helix Swarm** 是 Perforce 官方的 web 代码审核系统。本集成把审核流程搬进编辑器，对标 GitHub PR：**发起审核 → 看列表/状态 → 打分（vote）+ 评论 → 改状态（transition）→ 行内评论 + 任务**。它是 `extensions/perforce` 插件的一个**子模块**（`src/swarm/`），复用 p4 插件的连接 / 认证 / spawn 基础设施。

> 先读上文「扩展内置 Perforce（p4）插件」节（分层架构、`P4Service`/`client`、连接红线、密钥红线、`-Mj`/`-ztag` 坑）——本节只讲 **Swarm 特有**的东西：REST 客户端、审核领域模型、审核 UI、认证。

### Swarm 领域模型（先建立心智模型，别拍脑袋）

- **review ↔ shelved changelist**：一个 review 追踪一个**搁置（shelved）的 changelist**。发起审核 = 把 CL `p4 shelve` 后 `POST /reviews`。
- **version（版本）**：每次重新 shelve 到同一个 review = 新增一个 **version**。`review.versions[]` 每项有 `{ rev, change, pending, time }`——`change` 是那个版本对应的 changelist 号，**diff 就靠它取快照**（见下"diff 数据源铁律"）。⚠️ **`rev` 不唯一**：未 approve 前的多次 re-shelve 全部报同一个 rev（rev 只在 approve 时递增），版本身份必须用数组位置 / `change`，绝不能把 `rev` 当唯一键（SwarmReviewEditor 曾因此把选择器卡在最老 shelf）。
- **状态机是服务器权威的，绝不客户端计算**：state = `needsReview` / `needsRevision` / `approved` / `rejected` / `archived`。**合法的下一步永远 `GET /reviews/{id}/transitions` 问服务器**（它按当前用户 + 规则算），拿到 `{ state: label }` 映射后渲染成按钮。绝不在客户端硬编码"从 X 能到 Y"。`approved:commit`（Approve and Commit）是带 `:commit` 后缀的特殊 transition。
- **task 状态机**：评论可标记为 task（`comment` → `open` → `addressed` → `verified`），不能跳级（`open`→`verified` 必须先 `addressed`）。这是**客户端**的合法迁移集（`SwarmInlineThread.tsx` 的 `nextTaskStates()`），因为 Swarm 对 taskState 迁移不做服务器校验。
- **vote**：`up` / `down` / `clear`。

### 📋 dashboard「Needs My Action」铁律：`participants=me` 不展开 group/project

`SwarmClient._loadDashboard` 本地推导 needsAction（**故意不调 `dashboards/action`**：v9-only、此部署会 504）。但 **Swarm 的 `reviews?participants=<me>` 过滤器只匹配 individual participant（被单独指派为 reviewer、或已投票/评论的人），绝不展开 group/project 成员**。于是纯通过 Swarm project（如 `swarm-project-typescriptreview`）或 group 关联、用户还没个人参与的 review，`participants=me` **永远查不到**（实测穷尽翻 600 条不出现），从不进 needsAction——投票后才变 individual participant，但那时往往已 approved 被状态过滤掉，表现为「从来不出现」。

- **补法**：`perforce.swarm.needsActionAuthors`（发起者集合，持久化配置）非空时，`_loadDashboard` 并发多发一路 `listReviews({ author: [...authors], state: ['needsReview','needsRevision'] })`，其 open review 并入 needsAction（`deriveNeedsAction` 按 id 去重合并 authored+participating+byAuthor）。空集=仅 participants（旧行为）。dashboard command handler 从 `workspace.getConfiguration('perforce').get('swarm.needsActionAuthors')` 读配置传入；in-flight 合并 key 须纳入 authors 签名。
- **实测确认的过滤器语义**（v9，别再逐个试）：`author[]=a&author[]=b`、`state[]=needsReview&state[]=needsRevision` 都是**精确 OR**；`author=` 命中该作者全部 review。而 **`group=` 参数被服务端忽略**（不同 group 返回相同集合）；`project=<name>`（= `swarm-project-<name>` 去前缀）**真生效**但一个 project 就动辄 200+、全公司审核池并集 >500，直接并入会淹没列表——所以走 author 白名单而非 project/group 展开。

### Activity Bar 角标 + 状态栏计数（Needs My Action 计数）

`swarmViewState.ts` 的 `swarmNeedsActionCount`（模块单例 observable）是唯一计数源，两个写入方、两个读取方：

- **写入①`SwarmReviewNotificationContribution.refresh()`**（后台轮询，view 关闭也在跑）：`_computeDisplayed` 算出**侧栏分组口径**的列表（filterNeedsAction + ignore split，**不排除自己 authored 的、不含关键词**），`.set(displayed.length)`；通知集再从中排除 authored（两种口径一处算，别分叉）。
- **写入②`SwarmReviewsView` 的 effect**（view 挂载期间）：`needsActionActive.length` 变更即写回（vote/ignore/过滤后即时更新）。
- **读取①`SwarmActivityContribution`**（`ActivityBarBadgeContributions.ts`，AfterRestore 注册）：autorun 读计数 → `IActivityService.showActivity('workbench.view.swarm', {count})`，0 时撤角标。ActivityBar 已按容器通用渲染 `activitybar-badge-<containerId>` testid，无需改渲染层。
- **读取②底部状态栏**（`swarmStatusBar.ts`）：**被动显示 renderer 推送值**——同一 autorun 里 `executeCommand(SwarmCommands.setStatusCount, count)` 推给 host（先 `CommandsRegistry.getCommand` 判存在，perforce 缺席不刷 warn）。**host 绝不自己从 dashboard 推计数**：author 白名单/approvable/ignore 全在 renderer，host 自算必然分叉（真实 bug：侧栏 0、状态栏 30）。`SwarmStatusBarController` 只剩 `setCount` + `refresh()`（可用性 show/hide），不再有 startPolling；`perforce.swarm.pollInterval`（>0 秒，floor 10s）改作 `SwarmNotificationPoller` 的 tick 间隔，一条管线同时驱动通知/角标/状态栏。

**后台轮询总开关 `perforce.swarm.backgroundPoll.enabled`（默认关）**：整条轮询管线（host `SwarmNotificationPoller` tick + renderer `SwarmReviewNotificationContribution` 的 60s backstop/初始 prime）都受它门控。renderer 侧 `_syncPolling()` 读配置即时启停并订阅变更；host 无 config-change 事件，故 renderer 在启动与每次变更时经 `SwarmCommands.setBackgroundPoll` 把开关推给 host（host 激活时也自读一次配置兜底）。关闭瞬间 `swarmNeedsActionCount.set(0)` 清掉残留角标。两个相关 e2e spec（swarmReviewNotification*/）必须用 `swarmExtraSettings` 显式开启。

**泄漏测试坑**：该计数 observable 是模块单例，前一个测试未 dispose 的 contribution 会在后一个（装 DisposableTracker 的）测试里继续响应 `.set()` 产生无父链 badge handle → 误报泄漏。非泄漏断言的测试用完必须 `store.dispose()`。

### Ignore / Unignore + 按 ID 打开（纯渲染层，不碰 host/API）

- **ignore 是纯客户端概念**：`services/swarm/swarmIgnoreStore.ts` 模块级单例（Emitter 永不 dispose，对标 `swarmViewState`）。持 `Set<id>` + `Map<id, SwarmReviewDto 快照>`，`attach(storage)` 惰性加载（幂等，view 与 editor 都 mount 时只load一次），GLOBAL 持久化 key `swarm.ignoredReviews`/`swarm.ignoredReviewMeta`。dashboard 数据源不变（host 不感知 ignore），**渲染时**用纯函数 `splitIgnored(reviews, ignoredIds)` 把 needsAction 分流出 IGNORED 组。
- **meta 快照是必需兜底**：被 ignore 的 review 若某次 dashboard 不再返回（作者移出 needsActionAuthors 白名单等），IGNORED 组靠 `getMeta(id)` 仍能渲染 + 提供 unignore。IGNORED 组空时不显示组头。
- **侧栏 + 详情页双向同步**：都订阅 `swarmIgnoreStore.onDidChange`；侧栏右键菜单据 `isIgnored` 显示 Ignore/Unignore，详情页 header 同理。ignore 时详情页用 `detail`（DetailDto）拼一份精简 `SwarmReviewDto` 传入（DetailDto 无 upVotes/downVotes，从 participants 现算）。
- **按 ID 打开**：`OpenSwarmReviewByIdAction`（`swarm.openReviewById`，renderer Action2）——`f1:true` + `MenuId.ViewTitle`(`when: view == workbench.view.swarm.reviews`, icon `go-to-file`)，`IQuickInputService.input({validateInput})` 取数字 id → `openEditor(new SwarmReviewEditorInput(id))`。命令 id **不进**扩展 package.json（renderer Action2 遮蔽护栏）。
- **IGNORED 受 reviewWindowDays 约束自动清理**：`SwarmViewContribution` 在 store hydrate 后 + 配置变更时调 `swarmIgnoreStore.pruneExpired(windowDays)`，按 meta 快照的 `updated` 删过期项（`updated===0` 缺失永不删、`windowDays<=0` 不删，对齐 dashboard 窗口语义；判定纯函数 `expiredIgnoredIds`）。删除走 store 的 delete+persist+fire，所有消费方（侧栏/详情页/角标/通知）经 onDidChange 收敛。被清理的 review 理论上回到 Needs My Action，但 dashboard 同样按窗口过滤，故实际不可见。
- **测试坑**：给 `SwarmReviewsView` 加了 `useService(IStorageService)`，其组件测试的 `createServices` 必须补注册 IStorageService（否则 useService 抛错，整个测试文件挂）。store 单测用 `vi.resetModules()` + 普通 `import` 隔离单例，**不能**用 `import(url?t=random)`（vitest 报 "Unknown variable dynamic import"）。

### UI 状态持久化（侧栏 + 详情页记忆，纯渲染层）

三条独立机制，别混：

- **侧栏折叠 + keyword（跨重启）**：`services/swarm/swarmReviewsUiStore.ts` 模块级单例（对标 `swarmIgnoreStore`：`attach(storage)` 幂等 + 同步 `isReady` + `onDidChange`，GLOBAL key `swarm.reviewsView.collapsed`/`swarm.reviewsView.keyword`）。`SwarmReviewsView` 的 collapsed/keyword 初值读它、变更写回。**筛选条件（author/approvable/hideApproved）不在这里**——那三个走 `perforce.swarm.*` config（settings.json，`SwarmConfigurationContribution`），是用户配置不是视图临时态。
- **消除 IGNORED 闪烁的根因修复**：ignore store 若在 view mount 后才异步 hydrate，dashboard 内存缓存命中时首帧 `list()` 返空 → 被 ignore 的 review 先闪现在 Needs My Action。修法两层：① `SwarmViewContribution` 注入 `IStorageService`，在 **BlockStartup** 阶段就 `swarmIgnoreStore.attach` + `swarmReviewsUiStore.attach`（app 启动即 hydrate，早于 view mount）；② store 加同步 `isReady`，view 用 `ignoreReady` gate 首帧不渲染分组作双保险。加了 store 的 `isReady` 后其单测补断言。
- **详情页版本/滚动/草稿（仅跨 tab 切换，内存）**：`swarmViewState.ts` 的 `_reviewEditorStates: Map<reviewId, {selectedVersion,compareVersion,commentDraft,filesScrollTop}>`（对标 `swarmReviewDetailCache`，**不跨重启**）。`SwarmReviewEditor` **用 useRef 读一次**初值（避免自身 scroll 写入 churn restore effect），三个 state 各一 effect 写回。文件列表滚动位置：`SwarmReviewFiles` 加 `initialScrollTop`/`onScrollTopChange` props，经 `Tree` 的 `rootRef` 拿容器、**capture 阶段** listen scroll（同时覆盖非虚拟=root 滚动与虚拟>200=内层 scroller）。Files 显示形式（list/tree）另走 GLOBAL storage（既有，未动）。测试坑：Map 是模块单例，`SwarmReviewEditor.test.tsx` 共用 reviewId '1001' 会串状态，须导出 `clearSwarmReviewEditorStates()` 在 before/afterEach 清。


### 三层技术栈（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| wire 类型 | `packages/extensions-common/src/contracts/swarm.ts` | renderer↔扩展共享 DTO（`SwarmReviewDto`/`SwarmReviewDetailDto`(含 `transitions`)/`SwarmDashboardResult`/`SwarmVoteRequest`/`SwarmTransitionRequest`(含 `commit?`)/`SwarmAddCommentRequest`(含 `context?`+`content?`)/`SwarmAddChangeRequest`/`SwarmUpdateReviewRequest`…）+ `SwarmCommands` 命令 id 常量。**必须**在 `index.ts` re-export |
| HTTP 客户端 | `extensions/perforce/src/swarm/swarmApi.ts` | 薄 REST 层：`get/post/patch`，拼 `/api/v{N}/…` URL，塞 Authorization header。**认了 `UNIVERSE_SWARM_BASE_URL` env 覆盖**（e2e fake server 用）。日志只打 URL + 状态码，**绝不打 body/header** |
| 认证 | `extensions/perforce/src/swarm/swarmAuth.ts` | `resolveTicket`（`p4 login -p` 取 ticket）+ `buildBasicAuth`（`Basic base64(user:secret)`）+ `resolveSwarmCredential`。**密钥红线见下** |
| 解析 | `extensions/perforce/src/swarm/swarmParser.ts` | Swarm JSON → DTO 的**纯函数**（`parseReviewList`/`parseReviewDetail`/`parseTransitions`/`parseComments`…）。可对 fixture 单测 |
| 客户端编排 | `extensions/perforce/src/swarm/swarmClient.ts` | `SwarmClient`：每个审核操作一个方法（`dashboard`/`listReviews`/`getReview`/`vote`/`transition`/`addComment`…）。组合 api + parser。持有 `SwarmClientConfig {baseUrl, apiVersion, user}` |
| 命令注册 | `extensions/perforce/src/swarm/swarmCommands.ts` | 注册全部 `perforce.swarm.*` 命令（`commands.registerCommand`）；`guard()` 把「未配置/未授权」失败映射成安全回退值；`SwarmClient` 按 config+active-client 签名**懒重建** |
| 状态栏 + 轮询 | `extensions/perforce/src/swarm/swarmStatusBar.ts` + `swarmNotificationPoller.ts` | 状态栏**被动显示** renderer 推送的分组口径计数（见上「Activity Bar 角标 + 状态栏计数」），host 只管用性 show/hide；轮询定时器在 host（`SwarmNotificationPoller`，Chromium 不节流），每 tick poke renderer `_workbench.swarmPollTick`；**新审核通知不在这里**——由 renderer 的 `contributions/SwarmReviewNotificationContribution.ts` 自带 60s 轮询兜底（首轮只 prime 基线不通知），以侧栏**最终显示**列表（作者/仅可审批/ignore 过滤后）为准发桌面通知；**窗口聚焦时 main 侧 `hostMainService.notify` 会门控掉 OS toast（`shown:false`），此时必须回退应用内 `INotificationService` toast（带打开动作）**——上升沿在发通知前已记入 `_known` 基线只消费一次，静默丢弃会导致该审核永远不再通知（曾是真 bug） |
| 审核列表侧栏 | `apps/editor/src/renderer/workbench/swarm/SwarmReviewsView.tsx` | Swarm Reviews viewlet：分组 + 关键词过滤 + 点开详情；`getTransitions` 驱动可审批图标与右键操作，菜单含打开/网页/复制/transition/obliterate |
| 审核详情主编辑区 | `apps/editor/src/renderer/workbench/swarm/SwarmReviewEditor.tsx` | 头部（审核网页链接/状态/作者/参与者/vote/transition/Update/Obliterate）+ 描述 + 版本选择器 + 文件列表 + review 级评论面板 |
| 文件 diff 编辑区 | `apps/editor/src/renderer/workbench/swarm/SwarmDiffEditor.tsx` + `SwarmInlineCommentController.ts` + `SwarmInlineThread.tsx` | Monaco diff + 行内评论（view-zone + overlay widget 托 React，对标 `InlineDirtyDiffController`） |
| 输入/状态/动作/贡献 | `services/editor/SwarmReviewEditorInput.ts` · `services/editor/SwarmDiffEditorInput.ts` · `services/swarm/swarmViewState.ts` · `actions/swarmActions.ts` · `contributions/SwarmViewContribution.ts` | 两个 EditorInput（见"身份隔离"）· view-state 单例 · Action2 · view 容器贡献 |

### 命令清单（`SwarmCommands`，全 `perforce.swarm.*`）

`ping` / `requestReview` / `updateReviewFromChangelist` / `listReviews` / `dashboard` / `getReview` / `getTransitions` / `createReview` / `vote` / `transition` / `obliterateReview` / `addChange` / `updateReview` / `listComments` / `addComment` / `setTaskState` / `getFileContent` / `describeVersion` / `applyToLocal`。

- `getTransitions` 是列表与详情共用的服务器权威能力查询；列表里的“可 Approve”蓝色勾和右键状态操作都只能由它驱动。
- `obliterateReview` 走 `POST reviews/{id}/obliterate`，与 archived transition 不同，会永久删除审核。renderer 必须先做不可逆确认，服务端仍负责最终权限校验。
- `applyToLocal`（详情页 Apply to Local 按钮）是**纯 p4 数据命令**（`p4 unshelve -s <change> -f <筛选后的 depot 文件>`），**不走 `guard()`**——guard 构造 SwarmClient、401→login、失败 toast 全是 Swarm REST 语义。入参 change 同样走 `archiveChange ?? change` 不可变快照铁律（renderer 传的是 `selectedChange`，别重新推导）。整批失败时逐文件重试，p4 拒绝的（已打开/基线过期）进 `skipped[]` 报告；renderer 侧弹确认框（含「工作区外文件」持久化开关，store 在 `services/swarm/swarmApplyStore.ts`），分类纯函数 `swarmApplyPlan.ts` 带单测。

- **数据命令全走 `commands.registerCommand`（host 侧），renderer 用 `commands.executeCommand(SwarmCommands.xxx, arg)` 跨 JSON 边界调**。这些命令 **`requestReview`/`updateReviewFromChangelist`/`ping` 之外都不进 package.json `commands` 数组**——它们是纯数据 RPC，renderer 直接按 id 执行即可，无需声明（且声明会触发头号坑，见下）。
- **只有 `perforce.swarm.ping` / `perforce.swarm.requestReview` / `perforce.swarm.updateReviewFromChangelist` 进 package.json**（`ping` 是命令面板自检；后两者贡献到 SCM changelist 组头右键菜单 `3_swarm@1/@2`，都是**扩展宿主有真 handler** 的命令）。
- **`updateReview`（详情页 Update Review 按钮驱动，请求已带 reviewId）与 `updateReviewFromChangelist`（从 changelist 组头出发、先 QuickPick 选一个 review 再重新 shelve 关联新版本）是两条路径，别混**。候选排序是纯函数 `swarm/swarmReviewPick.ts`（`buildReviewPicks`：过滤已关闭、needsRevision 置顶、newest 次序），带单测。

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

### 🔍 通知链路的日志观测点（排查「收不到通知」先看这两处）

- **host 侧（Swarm 输出频道）**：poller 启停（info）/ tick 节奏（debug）/ tick 失败（warn）；guard 的 `cmd` scope 有每次 dashboard 的 start/ok/failed（poll 静默失败带 `(silent)` 标签）；`api` scope 有每个 HTTP 请求的状态 + 耗时 + 重试；`auth` scope 有凭据解析失败与 invalidate。默认安静，开 `perforce.swarm.trace` 后 debug 全量（tick 心跳、请求/响应细节）。
- **renderer 侧（`swarmNotify` logger，窗口私有日志 `window-<id>/`）**：poll 启停 / 基线 prime / **闩锁丢弃（`poll tick dropped: previous refresh still running`——闩锁卡死的第一信号，连续出现即 bug）** / poll 失败 warn（catch 不再静默）/ **分相位计时（`poll ok in Xms (dashboard Yms, transitions Zms)`——卡 dashboard 相位指向 host 侧 p4 凭据探针，卡 transitions 相位指向逐 review 的 getTransitions；相位 >30s 升级为 `slow phase —` info）** / deadline 触发的 `did not settle within` warn / 通知决策（`notifying N new review(s): #ids`）/ OS toast 被门控走应用内 fallback。常规节奏是 debug 级，关键事件 info/warn 默认可见。
- 判读套路：先看 renderer 有没有 tick 进来（无 → host poller / RPC 问题）；有 tick 但全是 dropped（→ 上一次 refresh 卡住，看相位计时卡在哪个阶段 + host `api`/`auth` scope 是否有挂起/超时请求）；有 poll ok 但无 notifying（→ 过滤口径问题：authors 白名单 / approvable / ignore）。

### ⚠️ 头号坑：renderer Action2 命令绝不能进扩展 `commands` 数组

打开审核列表 / 打开某审核的命令（`swarm.openReviews` / `swarm.openReview`）**handler 在 renderer 的 Action2**（`swarmActions.ts`）。它们**绝不能**写进 `extensions/perforce/package.json` 的 `contributes.commands` 数组。

- **后果**：`contributes.commands` 会在扩展宿主侧注册一个同名、**无 handler** 的命令，执行时遮蔽 renderer Action2 → `executeCommand` **静默返回 undefined、不抛错、界面无反应**，极难排查。
- **host→renderer 只能走 `_workbench.*` 前缀**：状态栏 toast 要打开审核，用的是 `_workbench.openSwarmReview` / `_workbench.openSwarmReviews`（`WorkbenchOpenSwarmReview(s)Action`），因为 host 只被允许回调 `_workbench.*` 命名空间（见 `MainThreadCommands.ts` 的 `HOST_INVOKABLE_PREFIX`）。数据命令（host→自身）不受此限。

（通用护栏见 memory `renderer-action-shadowed-by-extension-command-decl`。）

### 🔒 密钥红线（比 p4 更敏感，重申）

ticket / token / password **只存在于内存 + Authorization header**，**绝不**进：`settings.json` / `perforce.*` 配置 / wire DTO / 日志。

- `resolveTicket` 走 `p4 login -p`（打印 ticket 到 stdout，**不写文件**——on-disk ticket 由 p4 CLI 自己的 P4TICKETS 管，我们不碰）。
- `swarmApi` 日志**只打 URL + HTTP 状态码**，绝不打 request/response body 或 Authorization header。
- 独立 token 路径（Swarm SSO / API token）若要做，走 `ISecretStorageService`（对标 AI provider 密钥），**绝不进 renderer/settings**——在 `swarmAuth.ts` 按 `authMode === 'token'` 分支。

### 🛣️ REST 路径铁律：comments 是 topic-based，不是嵌套资源

Swarm 的 comment 端点**不挂在 review 下**——它是独立的 topic-based 资源。写成嵌套路径会 404（`GET /api/v9/comments/reviews/8089913 → Swarm resource not found`）。

| 操作 | ✅ 正确（v9） | ❌ 错误（会 404） |
|---|---|---|
| 列评论 | `GET comments?topic=reviews/{id}` | `GET comments/reviews/{id}` |
| 加评论 | `POST comments`（body 带 `topic: reviews/{id}`） | `POST comments/reviews/{id}` |
| 改评论 / task 状态 | `PATCH comments/{id}` | `POST comments/{id}/edit` |

- **reviews 系列相反，全是嵌套路径且正确**：`reviews/{id}`、`.../transitions`、`.../vote`、`.../state`、`.../changes`。别把 comments 的心智模型套到 reviews 上。
- fake server（`fake-swarm.mjs`）也按 topic-based 匹配：`GET comments` 读 `?topic=`，`POST comments` 从 body.topic 取 id，`PATCH comments/{id}` 处理编辑。
- 路径由单测固化（`swarmClient.test.ts` 的 `SwarmClient comment endpoints`），断言完整 URL + method + body，回归在单测就挂，不用等真服务器。

### 📐 diff 数据源铁律

**diff 两侧都从 p4 快照读取，绝不用工作区文件**（`getFileContent` 命令 → `client.printRevision(...)`）：

- 首版默认比较是 **base(0) → v1**，不是「空 → v1」：`p4 describe -S -s <change>` 的 `rev#` 是 shelved 文件的 depot 基线 revision；非新增文件左侧读 `${depotFile}#${rev}`，新增文件左侧才为空。否则所有 v1 edit 都会显示成整文件新增。
- **多 version 时默认左侧仍是 depot 基线(0)，不是「上一个 version」**：文件列表按 shelf vs 基线算，若默认拿上一 version 作左侧，一个在版本间没变、但相对基线有改动的文件会显示成空 diff（列表说改了、diff 两边一样，自相矛盾）。对标 GitHub PR 单文件默认对 base diff。用户可用 Compare 下拉显式选更早 version 做版本间比较。右侧读 `${depotFile}@=${versionChange}`；删除文件右侧为空。
- Swarm version 有 `archiveChange` 时优先用它作为不可变快照，回退 `change`。作者 changelist 会被重新 shelve，不能拿它代表旧 version。
- `#revision` 可进 immutable print cache；`@=<pending-change>` 可被 reshelve 原地替换，不能进永久缓存。
- **绝不用工作区当前文件当右侧**——它会随本地编辑漂移，行号对不上 Swarm 评论锚点。
- 文件列表 / 版本元数据走 `describeVersion`（pending shelf 用 `p4 describe -S -s <change>`，报表型命令走 `execRecords()` 防 `-Mj` 塌陷，见上文 p4 插件节）。**`describeVersion` 的入参 change 也必须走 `archiveChange ?? change`**：作者的 `version.change`（如 8105452）可能被 re-shelve/清空，直接用它会让文件列表时有时无、内容漂移成空；archive shelf（如 8105475）才是不可变快照。这条与右侧内容 `changeForVersion` 是同一铁律的两个消费点，别只修一处。
- “打开文件”目标是当前 client 的工作区副本，路径必须批量走 `p4 where <depotFile...>`；不能从 depot/display path 猜本地路径。无映射时 DTO 传 `localPath:null`，标题栏隐藏该动作。

### diff 编辑器基础能力接入

- `SwarmDiffEditorInput` 必须继承通用 `DiffEditorInput`（仍覆写自己的 `typeId/id/resource`），这样 `isInDiffEditor`、`diffEditorHasOpenableFile` 与标准标题栏 Action2 才能识别：打开文件 / 上一个差异 / 下一个差异。
- `SwarmDiffEditor` 在 `setModel` 后用 `EditorGroupContext` 的 group id 注册 `DiffEditorRegistry`，cleanup 对称 unregister；否则标准导航、焦点与 e2e diff 探针都找不到 live Monaco 实例。
- 首次 `onDidUpdateDiff` 一次性调用 `revealFirstDiff()` 并立即注销监听；不能在 `setModel` 后同步 `goToDiff()`，此时 diff/layout 尚未计算完成。

### 行内评论锚定（Swarm API 要求）

- Monaco 空 view-zone 占位撑出评论条带 + overlay widget 托 React root（`createRoot`），逐锚点一套，对标 `InlineDirtyDiffController`（见 `apps/editor/src/renderer/workbench/scm/CLAUDE.md` 的 dirty-diff 案例）。
- `SwarmAddCommentRequest.context` 里 `content` = **锚定行 + 前 4 行原文**：Swarm 用它在文件漂移后**重新锚定**评论（API 硬要求，不是可选优化）。
- 提交评论时 `side`（left/right）→ 映射成 `context.rightLine`/`leftLine` + `version`；review 级评论则无 `context`。
- host 侧 `addComment` handler 会把顶层 `content` 折进 `context.content`（Swarm 要的是 `context.content`）。

### 编辑器身份隔离（同类多 tab 必做）

两个 EditorInput 都覆写 `id` 让不同审核 / 不同 diff = 不同 tab（见 memory `editor-input-identity-isolation`）：

- `SwarmReviewEditorInput`：`TYPE_ID='swarmReview'`，`resource = universe:/swarmReview/{id}`，`id` 含 reviewId。
- `SwarmDiffEditorInput`：继承 `DiffEditorInput`；`TYPE_ID='swarmDiff'`，`id = swarmDiff:{reviewId}:{depotFile}:{left}-{right}`，`resource` scheme `swarm-diff` + query 带 `l=/r=` 版本。**transient（不 deserialize）**——审核 diff 是临时视图，重启不恢复。

### 注册套路

**主编辑区编辑器三件套**（`swarmReview` + `swarmDiff` 各一套，缺一不显示）：
1. `contributions/BuiltInEditorProvidersContribution.ts` —— `EditorRegistry.registerEditorProvider({ typeId, componentKey, deserialize })`（swarmDiff 无 deserialize、transient）
2. `workbench/editor/EditorArea.tsx` —— `editorComponentMap.set('swarmReview'/'swarmDiff', …)`
3. `services/editor/Swarm*EditorInput.ts` —— review 是 `EditorInput` 子类；diff 是 `DiffEditorInput` 子类

**侧栏 view 容器**：`contributions/SwarmViewContribution.ts` 注册 `workbench.view.swarm` 容器 + view，`ViewComponentRegistry` 映射到 `SwarmReviewsView`。Action2 在 `actions/index.ts` `registerAction2`。

**深链接**：`universe-editor://swarm/review/<id>` → `swarm.openReview`（`shared/deepLink.ts` 解析 + `DEEP_LINK_ALLOWED_COMMANDS` 白名单，见 `apps/editor/src/renderer/services/opener/CLAUDE.md`）。

### e2e 套路（fake Swarm REST server）

本机 / CI 无真 Swarm 服务器，用纯 Node fake server 端到端跑：

- `extensions/perforce/e2e/fixtures/fake-swarm.mjs`——依赖 free 的 `node:http` server，内存审核模型 `{1001:{…}}`，把 baseUrl 写进 `UNIVERSE_SWARM_FAKE_PORTFILE`，请求逐行记进 `UNIVERSE_SWARM_FAKE_LOG`。**认证无条件放行**（凭据链路由单测覆盖）。改端点在这里加 case。
- `extensions/perforce/e2e/fixtures/swarmApp.ts`——Playwright fixture：拉起 fake-swarm + fake-p4，seed 配置（`swarm.enabled/url/apiVersion`），暴露 `swarm.requests()` / `swarm.waitForRequest()`。
- `extensions/perforce/e2e/fixtures/fake-p4.mjs`——`login` case 在 `-p` 时打印假 ticket。
- `extensions/perforce/e2e/specs/swarmReview.spec.ts`（`@p1`）——开 view → 载 dashboard → 开审核 → vote → transition → 断言 fake server 记录到的请求 body。

#### e2e 必踩的四个坑（本次实测踩全）

1. **e2e 跑预构建产物**：改 renderer 必 `pnpm --filter @universe-editor/editor build`，改扩展必 `pnpm --filter @universe-editor/perforce build`，否则用旧 bundle（"view 不渲染"最常见就是这个）。
2. **`runCommand('swarm.openReviews')` 冷启动会 race `ViewsService.reconcileFromStorage`**：命令刚设的 active 容器被 storage 恢复覆盖 → view 不渲染。e2e **点 Activity Bar 项**（`[data-testid="activitybar-item-workbench.view.swarm"]`）打开，这才是健壮的用户路径。
3. **命令激活 race + 按钮文案匹配**：
   - 视图首次 mount 时扩展宿主命令可能**尚未注册**，`executeCommand` 返回 `undefined`。`SwarmReviewsView` 的 `load()` 遇 `undefined` **重试（250ms 退避，最多 20 次）**而非缓存空 dashboard——否则列表永远空。
   - 按钮内含图标 span（如 `↑Vote Up`），`getByText('Vote Up',{exact:true})` **匹配不到**；用 `getByRole('button',{name:'Vote Up'})`。
4. **别在 `expect.poll` 的驱动循环里断言尚未渲染的 locator**：`locator.textContent()` 会自动等待元素出现，把 poll 的第一轮卡死在自己的超时上（轮询还没成功、元素还不存在的死锁）。先沿用"快速 probe（如 `getSwarmNotifyDiag().lastActionable`）驱动轮询直到成功"，再用 `await expect(badge).toHaveText(...)` 断言。

### 验证

```bash
## 改了 extensions-common 后先重建（pnpm dev 下 watcher 自动）
pnpm --filter @universe-editor/extensions-common build
pnpm --filter @universe-editor/perforce build
pnpm --filter @universe-editor/editor build   # e2e 前必做

pnpm check   # lint + typecheck + 全量单测 + docs:check
pnpm --filter @universe-editor/editor exec playwright test -c e2e/playwright.config.ts specs/smoke.swarmReview.spec.ts
```

改了用户可见文案/交互，同步 `docs/user/zh-CN/perforce/swarm-code-review.md`（`pnpm docs:check` 校验内链）。

### 关键参考路径

- `packages/extensions-common/src/contracts/swarm.ts` —— wire 类型 + `SwarmCommands` 常量（改完 re-export）
- `extensions/perforce/src/swarm/swarmApi.ts` —— HTTP 层（`UNIVERSE_SWARM_BASE_URL` 覆盖）
- `extensions/perforce/src/swarm/swarmAuth.ts` —— 认证（密钥红线）
- `extensions/perforce/src/swarm/swarmParser.ts`（+ `__tests__/swarmParser.test.ts`）—— 纯解析
- `extensions/perforce/src/swarm/swarmClient.ts` —— 审核操作编排（搜 `dashboard`）
- `extensions/perforce/src/swarm/swarmCommands.ts` —— 命令注册（搜 `guard`）
- `extensions/perforce/src/swarm/swarmStatusBar.ts` —— 状态栏被动显示 renderer 推送计数（通知在 renderer `SwarmReviewNotificationContribution.ts`）
- `extensions/perforce/package.json` —— 只有 `ping`/`requestReview` 进 commands（头号坑）
- `apps/editor/src/renderer/workbench/swarm/` —— 全部 React UI（列表/详情/diff/行内评论）
- `apps/editor/src/renderer/actions/swarmActions.ts` —— Action2（openReviews/openReview + `_workbench.*` 双胞胎）
- `apps/editor/src/renderer/contributions/SwarmViewContribution.ts` —— view 容器
- `extensions/perforce/e2e/fixtures/fake-swarm.mjs` · `swarmApp.ts` —— e2e fake server + fixture
- `extensions/perforce/e2e/specs/swarmReview.spec.ts` —— e2e 冒烟
- `docs/plan/perforce-swarm-review-plan.md` —— 原始分阶段计划（P0–P5）

### 其它

- **状态永远问服务器**：加任何"改状态"入口前，先 `GET transitions` 拿合法集，别自己算。
- **report 型 p4 命令走 `execRecords()`**（`describe -s` / `where` 等），防 `-Mj` 塌成 `{data:...}` blob（见上文 p4 插件节）。
- **连接 `-p` 绝不从 `p4 info` 的 serverAddress 推**；只在 `perforce.port` 显式设置才传（同 p4 通用红线）。
- 加新审核操作：wire DTO（extensions-common）→ parser 纯函数 + 单测 → client 方法 → command 注册 → renderer `executeCommand` 调用，五步走，别跳层。
