---
name: extend-perforce-swarm
description: 制作 / 修改 Helix Swarm（P4 Code Review）相关功能时召回——Swarm 是 Perforce 官方的代码审核系统，本集成把「发起审核 / 看审核状态 / 打分 + 评论 / 改审核状态 / 行内评论 + 任务」搬进编辑器，对标 GitHub PR 体验。技术栈横跨三层：wire 类型在 `packages/extensions-common/src/swarm.ts`、数据层（HTTP REST 客户端 + 认证 + 解析 + 命令 + 状态栏轮询）在 `extensions/perforce/src/swarm/`、renderer React UI（审核列表侧栏 + 审核详情主编辑区 + 文件 diff + 行内评论）在 `apps/editor`。当任务是「给 Swarm 加/改一个 REST 端点调用（listReviews/dashboard/getReview/vote/transition/comment…）」「改审核详情/列表/diff/行内评论 UI」「Swarm 认证（p4 ticket / API token）」「审核状态机 / 任务状态机」「Swarm 轮询通知 / 深链接」时使用。给出 Swarm 领域模型（review↔shelved changelist↔version、服务器权威状态机）、三层文件索引、认证红线、diff 数据源铁律、行内评论锚定、命令路由（renderer↔host）、注册套路、头号坑、e2e fake server 套路。区别于：extend-perforce-plugin（p4 插件通用能力：签出/提交/搁置/resolve/blame/连接登录）、extend-perforce-graph（changelist 历史图谱可视化）。
disable-model-invocation: true
---

# 制作 / 扩展 Helix Swarm（P4 Code Review）集成

**Helix Swarm** 是 Perforce 官方的 web 代码审核系统。本集成把审核流程搬进编辑器，对标 GitHub PR：**发起审核 → 看列表/状态 → 打分（vote）+ 评论 → 改状态（transition）→ 行内评论 + 任务**。它是 `extensions/perforce` 插件的一个**子模块**（`src/swarm/`），复用 p4 插件的连接 / 认证 / spawn 基础设施。

> 先读 skill `extend-perforce-plugin`（p4 插件分层架构、`P4Service`/`client`、连接红线、密钥红线、`-Mj`/`-ztag` 坑）——本 skill 只讲 **Swarm 特有**的东西：REST 客户端、审核领域模型、审核 UI、认证。

## Swarm 领域模型（先建立心智模型，别拍脑袋）

- **review ↔ shelved changelist**：一个 review 追踪一个**搁置（shelved）的 changelist**。发起审核 = 把 CL `p4 shelve` 后 `POST /reviews`。
- **version（版本）**：每次重新 shelve 到同一个 review = 新增一个 **version**。`review.versions[]` 每项有 `{ rev, change, pending, time }`——`change` 是那个版本对应的 changelist 号，**diff 就靠它取快照**（见下"diff 数据源铁律"）。
- **状态机是服务器权威的，绝不客户端计算**：state = `needsReview` / `needsRevision` / `approved` / `rejected` / `archived`。**合法的下一步永远 `GET /reviews/{id}/transitions` 问服务器**（它按当前用户 + 规则算），拿到 `{ state: label }` 映射后渲染成按钮。绝不在客户端硬编码"从 X 能到 Y"。`approved:commit`（Approve and Commit）是带 `:commit` 后缀的特殊 transition。
- **task 状态机**：评论可标记为 task（`comment` → `open` → `addressed` → `verified`），不能跳级（`open`→`verified` 必须先 `addressed`）。这是**客户端**的合法迁移集（`SwarmInlineThread.tsx` 的 `nextTaskStates()`），因为 Swarm 对 taskState 迁移不做服务器校验。
- **vote**：`up` / `down` / `clear`。

## 三层技术栈（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| wire 类型 | `packages/extensions-common/src/swarm.ts` | renderer↔扩展共享 DTO（`SwarmReviewDto`/`SwarmReviewDetailDto`(含 `transitions`)/`SwarmDashboardResult`/`SwarmVoteRequest`/`SwarmTransitionRequest`(含 `commit?`)/`SwarmAddCommentRequest`(含 `context?`+`content?`)/`SwarmAddChangeRequest`/`SwarmUpdateReviewRequest`…）+ `SwarmCommands` 命令 id 常量。**必须**在 `index.ts` re-export |
| HTTP 客户端 | `extensions/perforce/src/swarm/swarmApi.ts` | 薄 REST 层：`get/post/patch`，拼 `/api/v{N}/…` URL，塞 Authorization header。**认了 `UNIVERSE_SWARM_BASE_URL` env 覆盖**（e2e fake server 用）。日志只打 URL + 状态码，**绝不打 body/header** |
| 认证 | `extensions/perforce/src/swarm/swarmAuth.ts` | `resolveTicket`（`p4 login -p` 取 ticket）+ `buildBasicAuth`（`Basic base64(user:secret)`）+ `resolveSwarmCredential`。**密钥红线见下** |
| 解析 | `extensions/perforce/src/swarm/swarmParser.ts` | Swarm JSON → DTO 的**纯函数**（`parseReviewList`/`parseReviewDetail`/`parseTransitions`/`parseComments`…）。可对 fixture 单测 |
| 客户端编排 | `extensions/perforce/src/swarm/swarmClient.ts` | `SwarmClient`：每个审核操作一个方法（`dashboard`/`listReviews`/`getReview`/`vote`/`transition`/`addComment`…）。组合 api + parser。持有 `SwarmClientConfig {baseUrl, apiVersion, user}` |
| 命令注册 | `extensions/perforce/src/swarm/swarmCommands.ts` | 注册全部 `perforce.swarm.*` 命令（`commands.registerCommand`）；`guard()` 把「未配置/未授权」失败映射成安全回退值；`SwarmClient` 按 config+active-client 签名**懒重建** |
| 状态栏 + 轮询 | `extensions/perforce/src/swarm/swarmStatusBar.ts` | 定时 poll `dashboards/action`，状态栏显示"需我处理"计数；新审核变可处理时 toast（走 `_workbench.openSwarmReview(s)`，**首轮 poll 只 prime 基线不 toast**） |
| 审核列表侧栏 | `apps/editor/src/renderer/workbench/swarm/SwarmReviewsView.tsx` | Swarm Reviews viewlet：三组（needsAction/authored/participating）+ 关键词过滤 + 点开详情。只用 `ICommandService`+`IEditorService` |
| 审核详情主编辑区 | `apps/editor/src/renderer/workbench/swarm/SwarmReviewEditor.tsx` | 头部（状态徽章/作者/参与者/vote 按钮/transition 按钮/Update Review）+ 描述 + 版本选择器 + 文件列表 + review 级评论面板 |
| 文件 diff 编辑区 | `apps/editor/src/renderer/workbench/swarm/SwarmDiffEditor.tsx` + `SwarmInlineCommentController.ts` + `SwarmInlineThread.tsx` | Monaco diff + 行内评论（view-zone + overlay widget 托 React，对标 `InlineDirtyDiffController`） |
| 输入/状态/动作/贡献 | `services/editor/SwarmReviewEditorInput.ts` · `services/editor/SwarmDiffEditorInput.ts` · `services/swarm/swarmViewState.ts` · `actions/swarmActions.ts` · `contributions/SwarmViewContribution.ts` | 两个 EditorInput（见"身份隔离"）· view-state 单例 · Action2 · view 容器贡献 |

## 命令清单（`SwarmCommands`，全 `perforce.swarm.*`）

`ping` / `requestReview` / `updateReviewFromChangelist` / `listReviews` / `dashboard` / `getReview` / `createReview` / `vote` / `transition` / `addChange` / `updateReview` / `listComments` / `addComment` / `setTaskState` / `getFileContent` / `describeVersion`。

- **数据命令全走 `commands.registerCommand`（host 侧），renderer 用 `commands.executeCommand(SwarmCommands.xxx, arg)` 跨 JSON 边界调**。这些命令 **`requestReview`/`updateReviewFromChangelist`/`ping` 之外都不进 package.json `commands` 数组**——它们是纯数据 RPC，renderer 直接按 id 执行即可，无需声明（且声明会触发头号坑，见下）。
- **只有 `perforce.swarm.ping` / `perforce.swarm.requestReview` / `perforce.swarm.updateReviewFromChangelist` 进 package.json**（`ping` 是命令面板自检；后两者贡献到 SCM changelist 组头右键菜单 `3_swarm@1/@2`，都是**扩展宿主有真 handler** 的命令）。
- **`updateReview`（详情页 Update Review 按钮驱动，请求已带 reviewId）与 `updateReviewFromChangelist`（从 changelist 组头出发、先 QuickPick 选一个 review 再重新 shelve 关联新版本）是两条路径，别混**。候选排序是纯函数 `swarm/swarmReviewPick.ts`（`buildReviewPicks`：过滤已关闭、needsRevision 置顶、newest 次序），带单测。

## ⚠️ 头号坑：renderer Action2 命令绝不能进扩展 `commands` 数组

打开审核列表 / 打开某审核的命令（`swarm.openReviews` / `swarm.openReview`）**handler 在 renderer 的 Action2**（`swarmActions.ts`）。它们**绝不能**写进 `extensions/perforce/package.json` 的 `contributes.commands` 数组。

- **后果**：`contributes.commands` 会在扩展宿主侧注册一个同名、**无 handler** 的命令，执行时遮蔽 renderer Action2 → `executeCommand` **静默返回 undefined、不抛错、界面无反应**，极难排查。
- **host→renderer 只能走 `_workbench.*` 前缀**：状态栏 toast 要打开审核，用的是 `_workbench.openSwarmReview` / `_workbench.openSwarmReviews`（`WorkbenchOpenSwarmReview(s)Action`），因为 host 只被允许回调 `_workbench.*` 命名空间（见 `MainThreadCommands.ts` 的 `HOST_INVOKABLE_PREFIX`）。数据命令（host→自身）不受此限。

（通用护栏见 memory `renderer-action-shadowed-by-extension-command-decl`。）

## 🔒 密钥红线（比 p4 更敏感，重申）

ticket / token / password **只存在于内存 + Authorization header**，**绝不**进：`settings.json` / `perforce.*` 配置 / wire DTO / 日志。

- `resolveTicket` 走 `p4 login -p`（打印 ticket 到 stdout，**不写文件**——on-disk ticket 由 p4 CLI 自己的 P4TICKETS 管，我们不碰）。
- `swarmApi` 日志**只打 URL + HTTP 状态码**，绝不打 request/response body 或 Authorization header。
- 独立 token 路径（Swarm SSO / API token）若要做，走 `ISecretStorageService`（对标 AI provider 密钥），**绝不进 renderer/settings**——在 `swarmAuth.ts` 按 `authMode === 'token'` 分支。

## 🛣️ REST 路径铁律：comments 是 topic-based，不是嵌套资源

Swarm 的 comment 端点**不挂在 review 下**——它是独立的 topic-based 资源。写成嵌套路径会 404（`GET /api/v9/comments/reviews/8089913 → Swarm resource not found`）。

| 操作 | ✅ 正确（v9） | ❌ 错误（会 404） |
|---|---|---|
| 列评论 | `GET comments?topic=reviews/{id}` | `GET comments/reviews/{id}` |
| 加评论 | `POST comments`（body 带 `topic: reviews/{id}`） | `POST comments/reviews/{id}` |
| 改评论 / task 状态 | `PATCH comments/{id}` | `POST comments/{id}/edit` |

- **reviews 系列相反，全是嵌套路径且正确**：`reviews/{id}`、`.../transitions`、`.../vote`、`.../state`、`.../changes`。别把 comments 的心智模型套到 reviews 上。
- fake server（`fake-swarm.mjs`）也按 topic-based 匹配：`GET comments` 读 `?topic=`，`POST comments` 从 body.topic 取 id，`PATCH comments/{id}` 处理编辑。
- 路径由单测固化（`swarmClient.test.ts` 的 `SwarmClient comment endpoints`），断言完整 URL + method + body，回归在单测就挂，不用等真服务器。

## 📐 diff 数据源铁律

**diff 的两侧都用本地 `p4 print @=<version-change>` 取同一版本快照**（`getFileContent` 命令 → `client.printRevision(`${depotFile}@=${change}`)`）。

- 左右两侧都是 **version 快照**（不同 version 的 changelist 号），所以**行号与 Swarm 行内评论的坐标严格对齐**。
- **绝不用工作区当前文件当右侧**——它会随本地编辑漂移，行号对不上 Swarm 评论锚点。
- 文件列表 / 版本元数据走 `describeVersion`（`p4 describe -s @=<change>`，报表型命令走 `execRecords()` 防 `-Mj` 塌陷，见 `extend-perforce-plugin`）。

## 行内评论锚定（Swarm API 要求）

- Monaco 空 view-zone 占位撑出评论条带 + overlay widget 托 React root（`createRoot`），逐锚点一套，对标 `InlineDirtyDiffController`（见 skill `dirty-diff-inline-peek`）。
- `SwarmAddCommentRequest.context` 里 `content` = **锚定行 + 前 4 行原文**：Swarm 用它在文件漂移后**重新锚定**评论（API 硬要求，不是可选优化）。
- 提交评论时 `side`（left/right）→ 映射成 `context.rightLine`/`leftLine` + `version`；review 级评论则无 `context`。
- host 侧 `addComment` handler 会把顶层 `content` 折进 `context.content`（Swarm 要的是 `context.content`）。

## 编辑器身份隔离（同类多 tab 必做）

两个 EditorInput 都覆写 `id` 让不同审核 / 不同 diff = 不同 tab（见 memory `editor-input-identity-isolation`）：

- `SwarmReviewEditorInput`：`TYPE_ID='swarmReview'`，`resource = universe:/swarmReview/{id}`，`id` 含 reviewId。
- `SwarmDiffEditorInput`：`TYPE_ID='swarmDiff'`，`id = swarmDiff:{reviewId}:{depotFile}:{left}-{right}`，`resource` scheme `swarm-diff` + query 带 `l=/r=` 版本。**transient（不 deserialize）**——审核 diff 是临时视图，重启不恢复。

## 注册套路

**主编辑区编辑器三件套**（`swarmReview` + `swarmDiff` 各一套，缺一不显示）：
1. `contributions/BuiltInEditorProvidersContribution.ts` —— `EditorRegistry.registerEditorProvider({ typeId, componentKey, deserialize })`（swarmDiff 无 deserialize、transient）
2. `workbench/editor/EditorArea.tsx` —— `editorComponentMap.set('swarmReview'/'swarmDiff', …)`
3. `services/editor/Swarm*EditorInput.ts` —— `EditorInput` 子类

**侧栏 view 容器**：`contributions/SwarmViewContribution.ts` 注册 `workbench.view.swarm` 容器 + view，`ViewComponentRegistry` 映射到 `SwarmReviewsView`。Action2 在 `actions/index.ts` `registerAction2`。

**深链接**：`universe-editor://swarm/review/<id>` → `swarm.openReview`（`shared/deepLink.ts` 解析 + `DEEP_LINK_ALLOWED_COMMANDS` 白名单，见 skill `link-opener-deeplink`）。

## e2e 套路（fake Swarm REST server）

本机 / CI 无真 Swarm 服务器，用纯 Node fake server 端到端跑：

- `apps/editor/e2e/fixtures/fake-swarm.mjs`——依赖 free 的 `node:http` server，内存审核模型 `{1001:{…}}`，把 baseUrl 写进 `UNIVERSE_SWARM_FAKE_PORTFILE`，请求逐行记进 `UNIVERSE_SWARM_FAKE_LOG`。**认证无条件放行**（凭据链路由单测覆盖）。改端点在这里加 case。
- `apps/editor/e2e/fixtures/swarmApp.ts`——Playwright fixture：拉起 fake-swarm + fake-p4，seed 配置（`swarm.enabled/url/apiVersion`），暴露 `swarm.requests()` / `swarm.waitForRequest()`。
- `apps/editor/e2e/fixtures/fake-p4.mjs`——`login` case 在 `-p` 时打印假 ticket。
- `apps/editor/e2e/specs/smoke.swarmReview.spec.ts`（`@p1`）——开 view → 载 dashboard → 开审核 → vote → transition → 断言 fake server 记录到的请求 body。

### e2e 必踩的三个坑（本次实测踩全）

1. **e2e 跑预构建产物**：改 renderer 必 `pnpm --filter @universe-editor/editor build`，改扩展必 `pnpm --filter @universe-editor/perforce build`，否则用旧 bundle（"view 不渲染"最常见就是这个）。
2. **`runCommand('swarm.openReviews')` 冷启动会 race `ViewsService.reconcileFromStorage`**：命令刚设的 active 容器被 storage 恢复覆盖 → view 不渲染。e2e **点 Activity Bar 项**（`[data-testid="activitybar-item-workbench.view.swarm"]`）打开，这才是健壮的用户路径。
3. **命令激活 race + 按钮文案匹配**：
   - 视图首次 mount 时扩展宿主命令可能**尚未注册**，`executeCommand` 返回 `undefined`。`SwarmReviewsView` 的 `load()` 遇 `undefined` **重试（250ms 退避，最多 20 次）**而非缓存空 dashboard——否则列表永远空。
   - 按钮内含图标 span（如 `↑Vote Up`），`getByText('Vote Up',{exact:true})` **匹配不到**；用 `getByRole('button',{name:'Vote Up'})`。

## 验证

```bash
# 改了 extensions-common 后先重建（pnpm dev 下 watcher 自动）
pnpm --filter @universe-editor/extensions-common build
pnpm --filter @universe-editor/perforce build
pnpm --filter @universe-editor/editor build   # e2e 前必做

pnpm check   # lint + typecheck + 全量单测 + docs:check
pnpm --filter @universe-editor/editor exec playwright test -c e2e/playwright.config.ts specs/smoke.swarmReview.spec.ts
```

改了用户可见文案/交互，同步 `docs/user/zh-CN/perforce/swarm-code-review.md`（`pnpm docs:check` 校验内链）。

## 关键参考路径

- `packages/extensions-common/src/swarm.ts` —— wire 类型 + `SwarmCommands` 常量（改完 re-export）
- `extensions/perforce/src/swarm/swarmApi.ts` —— HTTP 层（`UNIVERSE_SWARM_BASE_URL` 覆盖）
- `extensions/perforce/src/swarm/swarmAuth.ts` —— 认证（密钥红线）
- `extensions/perforce/src/swarm/swarmParser.ts`（+ `__tests__/swarmParser.test.ts`）—— 纯解析
- `extensions/perforce/src/swarm/swarmClient.ts` —— 审核操作编排（搜 `dashboard`）
- `extensions/perforce/src/swarm/swarmCommands.ts` —— 命令注册（搜 `guard`）
- `extensions/perforce/src/swarm/swarmStatusBar.ts` —— 轮询 + toast
- `extensions/perforce/package.json` —— 只有 `ping`/`requestReview` 进 commands（头号坑）
- `apps/editor/src/renderer/workbench/swarm/` —— 全部 React UI（列表/详情/diff/行内评论）
- `apps/editor/src/renderer/actions/swarmActions.ts` —— Action2（openReviews/openReview + `_workbench.*` 双胞胎）
- `apps/editor/src/renderer/contributions/SwarmViewContribution.ts` —— view 容器
- `apps/editor/e2e/fixtures/fake-swarm.mjs` · `swarmApp.ts` —— e2e fake server + fixture
- `apps/editor/e2e/specs/smoke.swarmReview.spec.ts` —— e2e 冒烟
- `docs/plan/perforce-swarm-review-plan.md` —— 原始分阶段计划（P0–P5）

## 其它

- **状态永远问服务器**：加任何"改状态"入口前，先 `GET transitions` 拿合法集，别自己算。
- **report 型 p4 命令走 `execRecords()`**（`describe -s` / `where` 等），防 `-Mj` 塌成 `{data:...}` blob（见 `extend-perforce-plugin`）。
- **连接 `-p` 绝不从 `p4 info` 的 serverAddress 推**；只在 `perforce.port` 显式设置才传（同 p4 通用红线）。
- 加新审核操作：wire DTO（extensions-common）→ parser 纯函数 + 单测 → client 方法 → command 注册 → renderer `executeCommand` 调用，五步走，别跳层。
