> 本文从 [CLAUDE.md](CLAUDE.md) 拆出的案例细节：Activity Bar 角标 + 状态栏计数 / Ignore·Unignore / UI 状态持久化。红线结论见主文档。

### Activity Bar 角标 + 状态栏计数（Needs My Action 计数）

`swarmViewState.ts` 的 `swarmNeedsActionCount`（模块单例 observable）是唯一计数源，两个写入方、两个读取方：

- **写入①`SwarmReviewNotificationContribution.refresh()`**（后台轮询，view 关闭也在跑）：`_computeDisplayed` 算出**侧栏分组口径**的列表（filterNeedsAction + ignore split，**不排除自己 authored 的、不含关键词**），`.set(displayed.length)`；通知集再从中排除 authored（两种口径一处算，别分叉）。
- **写入②`SwarmReviewsView` 的 effect**（view 挂载期间）：`needsActionActive.length` 变更即写回（vote/ignore/过滤后即时更新）。
- **读取①`SwarmActivityContribution`**（`ActivityBarBadgeContributions.ts`，AfterRestore 注册）：autorun 读计数 → `IActivityService.showActivity('workbench.view.swarm', {count})`，0 时撤角标。ActivityBar 已按容器通用渲染 `activitybar-badge-<containerId>` testid，无需改渲染层。
- **读取②底部状态栏**（`swarmStatusBar.ts`）：**被动显示 renderer 推送值**——同一 autorun 里 `executeCommand(SwarmCommands.setStatusCount, count)` 推给 host（先 `CommandsRegistry.getCommand` 判存在，perforce 缺席不刷 warn）。**host 绝不自己从 dashboard 推计数**：author 白名单/approvable/ignore 全在 renderer，host 自算必然分叉（真实 bug：侧栏 0、状态栏 30）。`SwarmStatusBarController` 只剩 `setCount` + `refresh()`（可用性 show/hide），不再有 startPolling；`perforce.swarm.pollInterval`（>0 秒，floor 10s）改作 `SwarmNotificationPoller` 的 tick 间隔，一条管线同时驱动通知/角标/状态栏。间隔解析在 `resolveSwarmPollIntervalMs`（纯函数）：`UNIVERSE_SWARM_POLL_INTERVAL_MS` env（e2e 专用，**绕过 10s floor**，host-tick 驱动的 spec 不必每相位等满一个产品间隔）> 配置秒数（floor 10s）> 默认 60s。

**后台轮询总开关 `perforce.swarm.backgroundPoll.enabled`（默认关）**：整条轮询管线（host `SwarmNotificationPoller` tick + renderer `SwarmReviewNotificationContribution` 的 60s backstop/初始 prime）都受它门控。renderer 侧 `_syncPolling()` 读配置即时启停并订阅变更（粗粒度 `affectsConfiguration('perforce.swarm')`）；host 无 config-change 事件，故 renderer 在启动与每次变更时经 `SwarmCommands.setBackgroundPoll` 把**完整轮询快照 `{enabled, pollIntervalSeconds, configured}`** 推给 host（命令未注册=host 激活竞态时 250ms 退避重试上限 20 次，不再静默跳过；interval 换算 + `UNIVERSE_SWARM_POLL_INTERVAL_MS` env 全部留在 host 侧，renderer 只推 raw seconds；host 激活时也并行自读一次配置兜底填充 configured 缓存）。关闭瞬间 `swarmNeedsActionCount.set(0)` 清掉残留角标。两个相关 e2e spec（swarmReviewNotification*/）必须用 `swarmExtraSettings` 显式开启。

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
- **详情页版本/滚动/草稿（仅跨 tab 切换，内存）**：`swarmViewState.ts` 的 `_reviewEditorStates: Map<reviewId, {selectedVersion,compareVersion,versionsFingerprint,commentDraft,filesScrollTop}>`（对标 `swarmReviewDetailCache`，**不跨重启**）。`SwarmReviewEditor` **用 useRef 读一次**初值（避免自身 scroll 写入 churn restore effect），三个 state 各一 effect 写回。文件列表滚动位置：`SwarmReviewFiles` 加 `initialScrollTop`/`onScrollTopChange` props，经 `Tree` 的 `rootRef` 拿容器、**capture 阶段** listen scroll（同时覆盖非虚拟=root 滚动与虚拟>200=内层 scroller）。Files 显示形式（list/tree）另走 GLOBAL storage（既有，未动）。测试坑：Map 是模块单例，`SwarmReviewEditor.test.tsx` 共用 reviewId '1001' 会串状态，须导出 `clearSwarmReviewEditorStates()` 在 before/afterEach 清。**版本选择的指纹失效协议**：`versionsFingerprint` 记录该选择针对的 versions 列表（指纹 = `fingerprintSwarmVersions(versions)` = 版本数 + 末版本的 `archiveChange ?? change`，**绝不用 rev**——re-shelve 同 rev）；`load()` 拿到新 detail 时指纹不同（re-shelve 追加了 version）即把选择跳到最新版本、compare 重置回 depot base 并持久化新指纹，指纹相同才保留记忆的选择——否则旧选择解析到旧版本的 archiveChange，重开/常开 tab 的 diff 永远停在旧快照。
