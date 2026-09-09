# extensions/perforce/src/swarm/CLAUDE.md

> 本文是 `extensions/perforce/CLAUDE.md` 的子域文档（Swarm 代码审核子模块），原为其「Helix Swarm 集成」章。p4 插件基座（分层架构 / 连接红线 / 密钥红线 / `-Mj`·`-ztag` 坑）见 [`../../CLAUDE.md`](../../CLAUDE.md)。案例细节（真实 bug 叙事 / 修复 / 回归单测）拆在 `cases-*.md`（文末索引）。

## Helix Swarm（P4 Code Review）集成

**Helix Swarm** 是 Perforce 官方 web 代码审核系统。本集成把审核流程搬进编辑器，对标 GitHub PR：**发起审核 → 看列表/状态 → 打分 + 评论 → 改状态 → 行内评论 + 任务**；是 `extensions/perforce` 插件的**子模块**（`src/swarm/`），复用 p4 插件的连接 / 认证 / spawn 基础设施。

> 先读父文档（分层架构、`P4Service`/`client`、连接红线、密钥红线、`-Mj`/`-ztag` 坑）——本节只讲 **Swarm 特有**的东西：REST 客户端、审核领域模型、审核 UI、认证。

### Swarm 领域模型（先建立心智模型，别拍脑袋）

- **review ↔ shelved changelist**：一个 review 追踪一个**搁置（shelved）的 changelist**。发起审核 = 把 CL `p4 shelve` 后 `POST /reviews`。
- **version（版本）**：每次重新 shelve 到同一个 review = 新增一个 **version**。`versions[]` 每项 `{ rev, change, pending, time }`——`change` 是版本对应的 changelist 号，**diff 就靠它取快照**（见红线 17）。⚠️ **`rev` 不唯一**：未 approve 前多次 re-shelve 都报同一个 rev（只在 approve 时递增），版本身份必须用数组位置 / `change`，**绝不能把 `rev` 当唯一键**（曾因此把选择器卡在最老 shelf）。
- **状态机是服务器权威的，绝不客户端计算**：state = `needsReview`/`needsRevision`/`approved`/`rejected`/`archived`。**合法下一步永远 `GET /reviews/{id}/transitions` 问服务器**（按当前用户 + 规则算），拿 `{ state: label }` 映射渲染按钮，绝不客户端硬编码"从 X 能到 Y"。`approved:commit`（Approve and Commit）是带 `:commit` 后缀的特殊 transition。
- **task 状态机**：评论可标记为 task（`comment` → `open` → `addressed` → `verified`），**不能跳级**（`open`→`verified` 必须先 `addressed`）。这是**客户端**的合法迁移集（`SwarmInlineThread.tsx` 的 `nextTaskStates()`），Swarm 对 taskState 迁移不做服务器校验。
- **vote**：`up` / `down` / `clear`。

### 红线速查（每条一句话结论；完整叙事见 cases）

1. **fetch 必须 per-request 超时**（第一环）：`SwarmApi` 无条件给 fetch 传 `AbortSignal.timeout`（默认 30s），否则网关挂起卡死 poll 闩锁、前后台全静默；失败分类用 `errorName()` 读 name，Network 不重试。
2. **fetch 超时不覆盖 fetch 之前：p4 凭据探针是第二卡点**：挂死的 p4 spawn 照样卡死 poll——`_spawn` 加超时（凭据探针 15s 紧超时）+ 凭据短缓存 + renderer 闩锁 deadline。**transitions 失败不得缓存 `[]`**：失败留 `undefined` 下轮重试，缓存 `[]` 会把该 review 静默移出通知范围并污染共享缓存。
3. **guard silent 判别准则**：定时器 / 后台 tick / 无用户在场 → `silent: true`（失败只记日志并 rethrow，绝不弹 UI 也绝不吞 fallback）；用户主动点按钮 → 默认。
4. **OS toast 焦点门控须考虑人不在场**（第三环）：gate = `isFocused() && !_isUserAway()`（powerMonitor idle/locked 判离场），否则人走后窗口仍 focused = 整夜零 OS 通知。
5. **poller tick 绝不前置 await renderer**（第四环）：`_isConfigured` 必须同步缓存读（fail-open 照 poke）、poke fire-and-forget + 30s ack watchdog；tick 路径**绝不写 stdout**（那是 RPC 通道），常态行不许 `console.error`。
6. **transitions 缓存必须按 `updated` 失效**（第五环）：stamp 移动 = stale → `getTransitions(force=true, silent=true)` 穿透 host 60s TTL 缓存；首拉不 force、失败不写 seenUpdated。
7. **收不到通知排查**：先看三处日志观测点（main `host.log` 最终决策 / host `extensionHost.log`+输出频道 / renderer `swarmNotify`），判读套路见 cases。
8. **dashboard 铁律**：`participants=me` **不展开 group/project**——纯 project/group 关联、未个人参与的 review 永远查不到；补法是 `perforce.swarm.needsActionAuthors` 白名单并发多查一路 author 过滤（精确 OR 语义，`group=` 被服务端忽略）。
9. **计数单一来源 + host 绝不自己推**：`swarmNeedsActionCount` 模块单例是唯一计数源；**host 绝不自己从 dashboard 推计数**——author 白名单/approvable/ignore 全在 renderer，自算必分叉（真实 bug：侧栏 0、状态栏 30）。
10. **ignore 是纯客户端概念**：`swarmIgnoreStore` 模块单例 + GLOBAL 持久化，dashboard 数据源不变，渲染时 `splitIgnored` 分流（meta 快照是必需兜底）。
11. **UI 状态持久化三条机制别混**：侧栏折叠/keyword（`swarmReviewsUiStore` GLOBAL，跨重启）/ 筛选条件（`perforce.swarm.*` config）/ 详情页版本/滚动/草稿（内存 Map，仅跨 tab）。
12. **版本指纹协议**：指纹 = 版本数 + 末版本 `archiveChange ?? change`，**绝不用 rev**；指纹不同即跳最新版本、compare 重置回 depot base，否则 diff 永远停在旧快照。
13. **头号坑**：renderer Action2 命令**绝不能进扩展 package.json `commands` 数组**（遮蔽 → `executeCommand` 静默返回 undefined、不抛错）；host→renderer 只能走 `_workbench.*` 前缀。memory `[[renderer-action-shadowed-by-extension-command-decl]]`。
14. **密钥红线**：ticket/token/password 只存内存 + Authorization header，**绝不**进 wire DTO / 日志（`swarmApi` 日志只打 URL+状态码）；settings.json / `perforce.*` 配置同父文档红线；独立 token 路径走 `ISecretStorageService`。
15. **REST 铁律**：comments 是 topic-based（`comments?topic=reviews/{id}`），不是嵌套资源（嵌套 404）；reviews 系列相反全是嵌套路径。对照表见下节。
16. **状态永远问服务器**：加任何「改状态」入口先 GET transitions 拿合法集，别自己算。
17. **diff 铁律**：两侧都从 p4 快照读，**绝不用工作区文件**；`describeVersion` 入参 change 必须 `archiveChange ?? change`；路径必须批量走 `p4 where`，不能从 depot/display path 猜。
18. **行内锚定**：`context.content` = 锚定行 + 前 4 行原文（Swarm API 硬要求）。
19. **测试红线**：计数 observable 模块单例，非泄漏断言测试用完必须 `store.dispose()`；store 单测用 `vi.resetModules()`+普通 import 隔离，**不能**用 `import(url?t=random)`。

### 🛣️ REST 路径铁律：comments 是 topic-based，不是嵌套资源

Swarm 的 comment 端点**不挂在 review 下**——写成嵌套路径会 404（`GET /api/v9/comments/reviews/100913 → Swarm resource not found`）。

| 操作 | ✅ 正确（v9） | ❌ 错误（会 404） |
|---|---|---|
| 列评论 | `GET comments?topic=reviews/{id}` | `GET comments/reviews/{id}` |
| 加评论 | `POST comments`（body 带 `topic: reviews/{id}`） | `POST comments/reviews/{id}` |
| 改评论 / task 状态 | `PATCH comments/{id}` | `POST comments/{id}/edit` |

- **reviews 系列相反，全是嵌套路径且正确**：`reviews/{id}`、`.../transitions`、`.../vote`、`.../state`、`.../changes`。别把 comments 的心智模型套到 reviews 上。

### 文件地图（文件 → 一句话职责）

| 文件 | 职责 |
|---|---|
| `packages/extensions-common/src/contracts/swarm.ts` | renderer↔扩展共享 DTO（ReviewDto/DetailDto(含 transitions)/DashboardResult/VoteRequest/TransitionRequest(含 commit?)/AddCommentRequest(含 context?+content?)/…）+ `SwarmCommands` 命令 id 常量；**必须**在 `index.ts` re-export |
| `extensions/perforce/src/swarm/swarmApi.ts` | 薄 REST 层（get/post/patch，拼 `/api/v{N}/…` URL + Authorization header）；**认了 `UNIVERSE_SWARM_BASE_URL` env 覆盖**（e2e fake server）；日志只打 URL+状态码 |
| `extensions/perforce/src/swarm/swarmAuth.ts` | `resolveTicket`（`p4 login -p` 取 ticket）+ `buildBasicAuth` + `resolveSwarmCredential`（密钥红线） |
| `extensions/perforce/src/swarm/swarmParser.ts` | Swarm JSON → DTO 的**纯函数**（`parseReviewList`/`parseReviewDetail`/`parseTransitions`/`parseComments`…），可对 fixture 单测 |
| `extensions/perforce/src/swarm/swarmClient.ts` | `SwarmClient`：每个审核操作一个方法（`dashboard`/`listReviews`/`getReview`/`vote`/`transition`/`addComment`…），组合 api + parser；持 `SwarmClientConfig {baseUrl, apiVersion, user}` |
| `extensions/perforce/src/swarm/swarmCommands.ts` | 注册全部 `perforce.swarm.*` 命令；`guard()` 把「未配置/未授权」失败映射成安全回退值；`SwarmClient` 按 config+active-client 签名懒重建 |
| `extensions/perforce/src/swarm/swarmStatusBar.ts` + `swarmNotificationPoller.ts` | 状态栏**被动显示** renderer 推送计数，host 只管用性 show/hide；轮询定时器在 host（Chromium 不节流），每 tick poke renderer（红线见速查 5）；新审核通知由 renderer `SwarmReviewNotificationContribution.ts` 60s 轮询兜底，以侧栏**最终显示**列表为准；窗口聚焦时 OS toast 被门控必须回退应用内 toast——上升沿已入 `_known` 基线只消费一次 |
| `extensions/perforce/package.json` | 只有 `ping`/`requestReview`/`updateReviewFromChangelist` 进 commands（头号坑） |
| `apps/editor/src/renderer/workbench/swarm/` | 全部 React UI：`SwarmReviewsView.tsx`（分组+关键词+详情，`getTransitions` 驱动可审批/右键操作）/ `SwarmReviewEditor.tsx`（头部+版本选择器+文件列表+评论面板）/ `SwarmDiffEditor.tsx`+`SwarmInlineCommentController.ts`+`SwarmInlineThread.tsx`（Monaco diff+行内评论，view-zone+overlay widget）/ `SwarmChangesView.tsx`（SWARM CHANGES） |
| `apps/editor/src/renderer/services/editor/SwarmReviewEditorInput.ts` · `SwarmDiffEditorInput.ts` · `services/swarm/swarmViewState.ts` | 两个 EditorInput（身份隔离，见下）/ view-state 单例 |
| `apps/editor/src/renderer/actions/swarmActions.ts` | Action2（openReviews/openReview + `_workbench.*` 双胞胎） |
| `apps/editor/src/renderer/contributions/SwarmViewContribution.ts` | view 容器注册（+ ignore store prune / BlockStartup hydrate） |
| `extensions/perforce/e2e/fixtures/fake-swarm.mjs` · `swarmApp.ts` · `fake-p4.mjs` | e2e fake server + fixture |
| `extensions/perforce/e2e/specs/swarmReview.spec.ts` | e2e 冒烟（`@p1`） |

### 命令分界（host / renderer）

- 全部命令 id 走 `SwarmCommands` 常量（`perforce.swarm.*`）。**数据命令全走 `commands.registerCommand`（host 侧），renderer 用 `executeCommand(SwarmCommands.xxx, arg)` 跨 JSON 边界调**；**只有 `ping` / `requestReview` / `updateReviewFromChangelist` 进 package.json**（`ping` 是命令面板自检；后两者贡献到 SCM changelist 组头右键菜单，都是扩展宿主有真 handler 的命令）。其余声明会触发头号坑。
- `getTransitions` 是列表与详情共用的服务器权威能力查询；列表里的「可 Approve」蓝色勾和右键状态操作都只能由它驱动。
- `obliterateReview` 走 `POST reviews/{id}/obliterate`，永久删除审核；renderer 必须先做不可逆确认，服务端仍负责最终权限校验。
- `updateReview`（详情页按钮，请求已带 reviewId）与 `updateReviewFromChangelist`（changelist 组头出发、先 QuickPick 选 review 再重新 shelve）是两条路径，别混；候选排序纯函数 `swarm/swarmReviewPick.ts`（`buildReviewPicks`）。
- `applyToLocal`（详情页 Apply to Local 按钮）是**纯 p4 数据命令**，**不走 `guard()`**；入参 change 同样走 `archiveChange ?? change` 不可变快照铁律（renderer 传的是 `selectedChange`，别重新推导）。完整流程 → [cases-apply-to-local.md](cases-apply-to-local.md)

### 注册套路

**主编辑区编辑器三件套**（`swarmReview` + `swarmDiff` 各一套，缺一不显示）：
1. `contributions/BuiltInEditorProvidersContribution.ts` —— `EditorRegistry.registerEditorProvider({ typeId, componentKey, deserialize })`（swarmDiff 无 deserialize、transient）
2. `workbench/editor/EditorArea.tsx` —— `editorComponentMap.set('swarmReview'/'swarmDiff', …)`
3. `services/editor/Swarm*EditorInput.ts` —— review 是 `EditorInput` 子类；diff 是 `DiffEditorInput` 子类

**侧栏 view 容器**：`contributions/SwarmViewContribution.ts` 注册 `workbench.view.swarm` 容器 + view，`ViewComponentRegistry` 映射到 `SwarmReviewsView`。Action2 在 `actions/index.ts` `registerAction2`。

**深链接**：`universe-editor://swarm/review/<id>` → `swarm.openReview`（`shared/deepLink.ts` 解析 + `DEEP_LINK_ALLOWED_COMMANDS` 白名单，见 `apps/editor/src/renderer/services/opener/CLAUDE.md`）。

**编辑器身份隔离（同类多 tab 必做）**：两个 EditorInput 都覆写 `id` 让不同审核 / 不同 diff = 不同 tab（memory `[[editor-input-identity-isolation]]`）——`SwarmReviewEditorInput`（`id` 含 reviewId，`resource = universe:/swarmReview/{id}`）；`SwarmDiffEditorInput`（`id = swarmDiff:{reviewId}:{depotFile}:{left}-{right}`，**transient**——重启不恢复）。

### 验证

```bash
cd extensions/perforce && UNIVERSE_E2E_NO_TAG_FILTER=1 npx playwright test -c e2e/playwright.config.ts swarmReview.spec.ts   # Swarm 冒烟
```

改了用户可见文案/交互，同步 `docs/user/zh-CN/perforce/swarm-code-review.md`（`pnpm docs:check` 校验内链）。e2e 套路（fake Swarm server + 三坑）→ [cases-e2e.md](cases-e2e.md)；e2e 栈通用约定 → `../../e2e/CLAUDE.md`。

### 其它

- **report 型 p4 命令走 `execRecords()`**（防 `-Mj` 塌陷，见父文档）。
- 加新审核操作五步走，别跳层：wire DTO（extensions-common）→ parser 纯函数 + 单测 → client 方法 → command 注册 → renderer `executeCommand` 调用。

## 案例索引（从本文件拆出，按需读对应一份）

- **通知链五环 + guard silent + 日志观测点**：[cases-notification-chain.md](cases-notification-chain.md)
- **Activity Bar 角标 / Ignore / UI 状态持久化**：[cases-renderer-state.md](cases-renderer-state.md)
- **diff 数据源铁律 / diff 编辑器 / 行内评论锚定**：[cases-diff.md](cases-diff.md)
- **applyToLocal**：[cases-apply-to-local.md](cases-apply-to-local.md)
- **e2e 套路与三坑**：[cases-e2e.md](cases-e2e.md)
