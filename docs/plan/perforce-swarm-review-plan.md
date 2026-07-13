# Perforce Swarm 代码审核集成设计方案

> 目标:在现有 `extensions/perforce` 插件之上,增加 **Helix Swarm(新名 P4 Code Review)** 的代码审核支持,让「发起审核 / 查看审核状态 / review 打分评论 / 修改审核状态」在编辑器内闭环,体验对标 GitHub PR。本方案**只做设计,聚焦整体架构与交互逻辑,不涉及编码**。
>
> 范围裁定(已与用户确认):
> - **深度 = 全量规划 P0–P5**:连接/配置/认证、审核列表、状态栏、审核详情、发起审核、投票、状态迁移、文件 diff、review 级评论、**行内评论 + 任务状态机**、轮询通知、深链接、打回闭环。完整对标 GitHub PR / Swarm Web 体验。
> - **认证 = 双路并存**:默认**复用 p4 login ticket**(零新基础设施);预留**独立 Swarm token / SSO** 扩展点(补 `mainThreadSecret` 通道)。实现时优先 ticket。
>
> 前置阅读:`docs/plan/perforce-scm-plugin-plan.md`(p4 插件整体架构、密钥红线)、`docs/plan/perforce-collect-changes-ux-plan.md`(收集修改体验)、skill `extend-perforce-plugin`(p4 分层与红线)、skill `extend-perforce-graph`(renderer 内置视图 + 命令桥套路)。本方案不重复其结论。

---

## 1. 背景与定位

### 1.1 Swarm 是什么

Swarm 是架在 Helix Core 之上的 **Web 审核层**,不是新的版本控制系统,而是给 p4 的 changelist 附加「审核工作流」。三个关键事实决定整个设计:

1. **审核对象 = shelved changelist**。发起审核的标准动作:把改动 shelve 后让 Swarm 追踪该 CL(描述加 `#review` 标签,或调 `POST /reviews {change}`)。作者每次修订 = 重新 shelve → 产生新 **version**。
2. **状态机固定且简单**(§2.2),权限由服务器端的 moderation 规则裁定,客户端不自行计算。
3. **认证与 Helix Core 同源**:Swarm REST API(HTTP Basic Auth)接受 **p4 login ticket** 当密码(2017.1+ 不再要求 host-unlocked)——可零成本复用现有 p4 登录态。

### 1.2 与现有 p4 插件的关系:子模块,不是独立插件

Swarm 与 changelist / shelve / ticket / 连接态强耦合,应作为 **perforce 插件的子模块**(`extensions/perforce/src/swarm/`),复用 `ClientManager` / `P4Service` / 连接发现 / ticket,而非独立插件。理由:

- 发起审核要读 `client.ts` 的 pending/shelved changelist 数据;
- 认证要复用 p4 ticket;
- 审核 diff 要复用 `baselineProvider` 的 `p4 print` 能力;
- UI 上「请求审核」是 changelist 组的一个动作,天然长在 SCM 视图里。

### 1.3 既有资产盘点(调研结论)

| 能力 | 状态 | 落点 / 复用对象 |
|---|---|---|
| HTTP 请求 | ✅ 就绪 | extension-host = Node 20,**全局 `fetch` 原生可用**;重试/取消/错误映射参考 `apps/editor/src/main/services/ai/providers/openAiProvider.ts`(`retryWithBackoff`/`AbortSignal`/`mapHttpError`)。Swarm 会是**首个发真实 HTTP 的插件** |
| changelist/shelve 数据 | ✅ 就绪 | `client.ts`:`shelve`/`unshelveByNumber`/`_fetchShelved`/`getPendingCount`/`changelistPicks`/`pathsInChangelist`/`getGraphChangeDetails` |
| 命令注册 + 跨进程 | ✅ 就绪 | `commands.registerCommand`;renderer→插件走命令路由;插件→renderer 限 `_workbench.*` 前缀 |
| 配置项 | ✅ 就绪 | `contributes.configuration` + `getConfiguration('perforce').get()` |
| 轮询 / 通知 / 状态栏 | ✅ 就绪 | `client.ts` `startPolling` 模式;`window.show*Message`;`p4StatusBar.ts` 样板 |
| renderer 富 UI(列表/详情/diff overlay) | ✅ 就绪 | 见 §3.2,照抄 Perforce Graph + `InlineDirtyDiffController` |
| 密钥存储(插件侧访问) | ⚠️ **缺口** | `ISecretStorageService` 仅在 main,插件侧无 RPC 通道。**默认走 ticket 规避**;独立 token 才需补通道(§4) |

**唯一需要新建的基础设施是「独立 token 场景下的密钥通道」**,且默认认证路径(ticket)完全不需要它。

---

## 2. Swarm 领域模型

### 2.1 审核对象 = shelved changelist

- **发起有两条等价路径**:① p4 原生——CL 描述含 `#review` 且 shelve,Swarm 后台自动建 review;② REST——`POST /reviews {change}`。本方案 UI 主推 ②(可控、可即时拿到 review-id),但识别 ①(用户在别处已用标签发起)。
- **version 概念**:每次 re-shelve → review 增加一个 version。行内评论、diff 都绑定到具体 version。`GET /reviews/{id}` 返回 `versions[]`,每个 version 关联一个 change(shelved 或 committed)。

### 2.2 状态机

```
        ┌──────────────────────────────────────────┐
        │                                            │
   needsReview ──(reviewer 打回)──▶ needsRevision    │
        ▲                                │           │
        └────(作者重新 shelve/重新请求)◀──┘           │
        │                                            │
        ▼ (满足投票要求:必选 reviewer 全 up + 无 down)│
   approved ──(commit)──▶ closed(approved & 已提交)  │
        │                                            │
        └──────────── rejected / archived ◀──────────┘
```

- **approved 自动化**:满足投票要求时 Swarm 可自动置 approved;approved 后若文件再变化,自动回退 needsReview。
- **权限**:是否能改状态取决于服务器端 moderation。**客户端不自行判断**——一律先 `GET /reviews/{id}/transitions` 拿当前用户的合法迁移,UI 只显示合法项。

### 2.3 参与者与投票

- **reviewers**:普通 / required(必选)/ reviewerGroups(require-all 或 require-one)。
- **加入审核**:投票 / 评论 / Join review 任一动作即成为参与者。
- **投票**:`up` / `down` / `clear`,绑定 version。required reviewer 的 up 票决定能否 approve;任一 down 阻止 approve。

### 2.4 评论与任务状态机

- **评论层级**:review 级(无 context)、文件行级(context 带 file + 行号)、回复(context 带父 comment id)、针对描述(context.attribute=description)。
- **任务状态**:评论可升级为 task,状态 `comment → open → addressed → verified`(不能跳步,open→verified 须先 addressed)。作者标 addressed,reviewer 标 verified,形成「未解决任务」清单驱动打回闭环。

### 2.5 认证与 Helix Core 同源

HTTP Basic Auth,`Authorization: Basic base64(user:secret)`,`secret` 可为 **p4 ticket**(推荐)或密码(security level 3 服务器拒绝密码)。详见 §4。

### 2.6 REST API 端点全集(设计依据)

> 版本号 `vN` 占位:默认 **v11**,回退 **v9**(可配 `perforce.swarm.apiVersion`)。

| 用途 | 方法 & 路径 | 关键参数 |
|---|---|---|
| 我的待办 | `GET /dashboards/action` | — |
| 列表 + 过滤 | `GET /reviews` | `author[]` `participants[]` `state[]` `project[]` `keywords` `max` `after`(分页)`fields`(裁字段) |
| 详情(含 versions) | `GET /reviews/{id}` | `fields` |
| 合法迁移 | `GET /reviews/{id}/transitions` | — |
| 发起 | `POST /reviews` | `change`(必) `description` `reviewers[]` `requiredReviewers[]` `reviewerGroups[]` |
| 关联新版本 | `POST /reviews/{id}/changes` | `change` `mode=replace\|append` |
| 投票 | `POST /reviews/{id}/vote` | `vote=up\|down\|clear` `version` |
| 状态迁移 | `PATCH /reviews/{id}/state` | `state` `commit` `description` `jobs[]` |
| 改描述 | `PATCH /reviews/{id}` | `description` / `author` |
| archive | `PATCH .../state {state:archived}` 或 `POST /reviews/archive` | — |
| 评论列表 | `GET /comments/reviews/{id}` | `taskState` `tasksOnly` `max` `after` |
| 加评论 | `POST /comments/reviews/{id}` | `body` `taskState` `context{file,leftLine,rightLine,content,version}` |
| 编辑 / 改任务态 | `POST /comments/{id}/edit` | `body` `taskState` |
| 文件跨版本 diff(兜底) | `GET /files/{base64depotPath}/diff` | `from` `to` `type=file` |

---

## 3. 整体架构

### 3.1 数据层(extension-host,`extensions/perforce/src/swarm/`)

沿用 p4 插件「纯函数解析 + 编排分离」分层:

```
swarm/
  swarmApi.ts        REST 封装:全局 fetch + Basic Auth 注入 + AbortSignal 取消
                     + retryWithBackoff + HTTP 状态码→结构化错误(照 openAiProvider)
                     只做 HTTP,不含业务;日志只打 URL+状态码,绝不打 auth 头
  swarmAuth.ts       凭据解析:ticket 优先(§4),token 兜底;返回 Basic 头
  swarmClient.ts     编排:缓存 + 轮询 + onDidChange 事件 + 全部审核操作方法
                     (listReviews/getReview/getTransitions/createReview/vote/
                      transition/listComments/addComment/setTaskState/addChange)
                     从 active PerforceClient 取 port/user/ticket
  swarmParser.ts     Swarm JSON → 领域模型(纯函数,对 fixture 单测)
  swarmCommands.ts   命令注册(在 extension.ts activate 里调用)
  swarmStatusBar.ts  「我的待审核数」状态栏(照 p4StatusBar.ts)
  __tests__/         swarmParser / swarmAuth / diff 坐标映射 纯逻辑单测
```

- **SwarmClient 归属**:按 p4 连接(port+user)创建,复用 active client 的连接信息;多 client 连同一 server 时共享同一 SwarmClient(review 是 server 级资源,跨 client 无意义)。
- **缓存**:列表/详情按 `updated` 时间戳 + review-id 缓存,轮询用 `notUpdatedSince` / `fields` 增量拉取,减负载。

### 3.2 UI 层(renderer,React 内置视图 —— 不用 webview)

调研结论明确:富 UI 走**路线 A(React 内置视图)**,不走 webview(webview 只能绑文件 glob,套不进「按 review-id 打开」)。

| UI 面 | 机制 | 照抄对象 |
|---|---|---|
| **审核列表**(侧栏标签页) | ViewContainer + `registerViewWithComponent` | `contributions/ExtensionsViewContribution.ts`;列表用 workbench-ui `VirtualList`(上百条 review) |
| **审核详情**(主编辑区 tab) | `SwarmReviewEditorInput`(带 review-id)+ `registerEditorProvider` + `editorComponentMap` | Perforce Graph 三件套;EditorInput **须覆写 `id` 做身份隔离**(不同 review = 不同 tab,见 memory `editor-input-identity-isolation`) |
| **文件 diff** | `DiffEditorInput`(左=base version,右=选定 version) | Perforce Graph 的 `openFileDiff` |
| **行内评论线程** | Monaco `changeViewZones`(占位)+ `addOverlayWidget`(承载 UI) | `InlineDirtyDiffController.ts`(黄金范例,top/height 同步公式可直接搬);React UI 用 `createPortal` 挂进 overlay DOM |
| **状态栏** | `window.createStatusBarItem` | `p4StatusBar.ts` |

> VSCode 的 `CommentController`/`CommentThread` 高层 API **未移植**——行内评论需在 view-zone/overlay 之上自建「线程数据模型 + 渲染 + 提交回 Swarm」,但底层原语齐全,非从零。

### 3.3 数据流与命令桥

renderer 视图**只依赖 `ICommandService`**,通过命令名跨 JSON 边界向 extension-host 取 DTO,不直接握 HTTP/p4 句柄——完全对标 Perforce Graph:

```
SwarmReviewsView.tsx
  commands.executeCommand(SwarmCommands.listReviews, {filter})
        │  (renderer CommandsRegistry → 路由到 host)
        ▼
swarm/swarmCommands.ts
  commands.registerCommand('perforce.swarm.listReviews', async (opts) => {
    return swarmClient.listReviews(opts.filter)  // fetch → Swarm
  })
        │  返回 SwarmReviewDto[](结构化克隆回 renderer)
        ▼
  渲染
```

- 打开详情 tab / 打开文件 diff 这类「插件→renderer」动作,走既有 allowlist 命令(`_workbench.openDiff` 等);若需新开审核详情 tab,新增一个 `_workbench.*` 命令或由 renderer Action2 承接。

### 3.4 wire 契约(DTO)

放 `packages/extensions-common/src/swarm.ts`,renderer 与插件共享(对标 `perforceGraph.ts`):

- `SwarmReviewDto`(列表项:id/state/stateLabel/author/description/votes/commentCount/openTaskCount/testStatus/updated)
- `SwarmReviewDetailDto`(详情:+ versions[]/participants/reviewerGroups/transitions)
- `SwarmCommentDto`(id/body/author/context/taskState/updated)
- `SwarmReviewFilter`(列表过滤参数)
- `SwarmCommands`(命令 id 常量集中定义,防散写)

---

## 4. 认证方案(双路)

### 4.1 方案 B:复用 p4 ticket(默认,零新基础设施)

Swarm 与 Helix Core 同认证。插件在 extension-host 里:

```ts
// swarmAuth.ts —— 复用 P4Service,不引入新密钥存储
const ticket = await p4Service.exec(['login', '-p'])   // 打印 ticket 到 stdout,不写文件
const basic = 'Basic ' + base64(`${user}:${ticket}`)
```

- ticket 已由 p4 CLI 管理在 `.p4tickets`(P4TICKETS 机制),插件**不自管**。
- ticket 只在内存 + Authorization 头出现,**从不落 settings / 日志 / 配置项**(日志只打 URL+状态码,照 p4Service 只打 argv 不打 stdin)。
- session 过期(HTTP 401)→ 复用 `p4Error.ts` 的 session-expired 拦截 → 触发 `perforce.login` → 重试。

### 4.2 方案 A:独立 Swarm token / SSO(扩展点,按需实现)

当 Swarm 用独立 API token 或 SSO(与 p4 登录分离)时:

- 补一条 **`mainThreadSecret` RPC 通道**(trusted-only,经 `HostConnectionDeps` 条件注册,与 AI/SCM 同款隔离手法),把 main 的 `ISecretStorageService` 桥到插件。
- keying 沿用 AI 约定风格:`swarm.secret.<host>.token`。
- token 走 safeStorage 加密,OS 加密不可用时拒绝存储、绝不明文回退(照 `secretStorageMainService.ts`)。
- UI:命令 `Perforce: Set Swarm Token` 用 `showInputBox`(password 模式)收 token → 存 SecretStorage;**绝不进 settings**。

### 4.3 认证红线(两路共同)

- token / ticket / password **绝不进** `settings.json` / `perforce.*` 配置项 / wire DTO / 日志。
- 只有 `perforce.swarm.url`(server 地址)可进配置。
- 所有 HTTP 走 `swarmApi.ts` 统一注入 auth,别在各处手拼。

---

## 5. 交互逻辑设计(核心)

### 5.1 发起审核(Create Review)

**入口(多处,复用现有菜单门控)**:
- SCM 视图:numbered pending changelist 组头 inline/右键 **「请求 Swarm 审核」**(`scm/resourceGroup/context`,`when: scmResourceGroup =~ /^cl:/`)。
- Perforce Graph:某 change 节点右键。
- 命令面板:`Perforce: Request Swarm Review`。

**流程**:
```
选中 changelist
  ├─ default 组       → 先 moveToNewChangelist(复用现有逻辑;Swarm 需 numbered CL)
  ├─ 未 shelve        → 提示/自动 shelve(复用 client.shelve)
  ├─ 轻量表单(QuickInput 或小面板):
  │     · 描述(默认取 CL description)
  │     · reviewers / required reviewers(可选,支持用户/组补全)
  └─ POST /reviews { change, description, reviewers[], requiredReviewers[] }
        └─ 成功 → toast +(可选)直接打开审核详情 tab
```

**最佳实践对齐**:识别 CL 描述里的 `#review`(已发起)/`#wip`(草稿态不通知);表单提示「建议等自动化测试通过再请求审核」。

### 5.2 查看审核状态(View Status)

**侧栏 View「Swarm Reviews」——日常主入口**:

- **智能分组**(对标 Swarm Action Dashboard):
  - `需要我处理`(我是 reviewer 且未投票 / 被打回)← `GET /dashboards/action`
  - `我发起的`(`author=me`)
  - `我参与的`(`participants=me`)
- **每行信息密度**:review-id · 描述 · **状态徽章**(needsReview/needsRevision/approved 分色)· 作者 · 投票(↑N ↓M)· 评论/未解决任务数 · 测试状态(✓/✗)。
- **顶部筛选条**:状态 / 作者 / 项目 / 关键词 → 直接映射 `GET /reviews` query;分页用 `after`+`lastSeen`,`VirtualList` 滚动加载。
- **交互**:单击预览(在详情 tab 加载)、双击 pin。
- **状态栏条目**:`$(git-pull-request) 3 待审核`,点击聚焦该 View;计数来自 dashboard,轮询驱动。

**刷新**:复用 `startPolling` 模式(独立 timer + 可配 `perforce.swarm.pollInterval` + dispose 清理)+ 手动刷新按钮。

### 5.3 针对审核 review(看 diff + 评论)

**审核详情 tab 布局**:

```
┌─ 头部 ─────────────────────────────────────────┐
│ Review #1234  [needsReview ▼]   作者:alice       │
│ reviewers: bob✓  carol↓  dave(required,未投)     │
│ 描述…                          [投票 ↑ ↓ ⊘][Join]│
├─ 版本选择 ─────────────────────────────────────┤
│ 比较:  v2 ▼  ⇄  v3 ▼       (diff from/to)       │
├─ 文件列表(左)──────┬─ 评论/任务(右)──────────┤
│ M src/a.cpp  💬2    │  review 级评论             │
│ A src/b.h          │  未解决任务清单 ☐☐☑          │
│ D old.txt          │                             │
└────────────────────┴─────────────────────────┘
```

**diff 数据源决策(关键)**:审核看的是 **shelved 快照,不是当前工作区文件**。

- **主路径 = 本地 `p4 print @=<version-change>`**:review 每个 version 关联一个 change,`p4 print //depot/file@=<change>` 取该 version 快照内容,两侧内容都取自对应 version 的 change → 喂 Monaco `DiffEditorInput` 自己算 diff。**优点**:复用 Monaco diff(语法高亮 + 交互 + 行内 overlay),且两侧同源 → 行号与 Swarm context 一致(行内评论坐标可靠)。复用 `baselineProvider` 缓存(`depotPath#rev` 键)。
- **兜底 = Swarm `/files/.../diff` API**:本地 client 无该文件映射 / 取不到内容时,用 Swarm 算好的 hunks。
- ⚠️ **行号一致性红线**:行内评论的 Swarm `context.leftLine/rightLine` 必须对应 Swarm version 的行号。只要 diff 两侧取自 version 的 change 快照(而非工作区当前文件),Monaco 行号即与 Swarm 一致;**绝不能拿工作区文件当右侧**(会漂移错位)。

**行内评论(GitHub PR 式)**:
- diff 某行 hover 出 `+` → 点击在该行**下方 view-zone 展开评论框**(overlay 承载),照抄 `InlineDirtyDiffController` 的「空 view-zone 占位 + overlay 同步 top/height」。
- 已有评论 → 该行下渲染评论线程(list + reply)。
- 提交:`POST /comments/reviews/{id} { body, context:{ file, rightLine|leftLine, content, version } }`。
- **`context.content` 必须带该行 + 前 4 行**(Swarm 用它防行漂移后错位)——API 硬要求,从 Monaco model 取。
- 评论可标 task(`taskState:open`)→ 汇入「未解决任务」清单;作者标 `addressed`,reviewer 标 `verified`(状态机见 §2.4)。

### 5.4 修改审核状态(Vote & Transition)

**投票**(头部按钮):`POST /reviews/{id}/vote { vote:up|down|clear, version }`,乐观更新 + 失败回滚。

**改状态**(状态下拉):
- **先 `GET /reviews/{id}/transitions`** 拿合法迁移,UI 只显示合法项(自动处理「作者不能自批」「moderator 才能 approve」等权限,无需插件自算)。
- `PATCH /reviews/{id}/state { state }`:
  - **needsRevision**(打回,强制/建议附一条说明评论)
  - **needsReview**(重新请求)
  - **approved**(仅投票要求满足时出现;可带 `commit:true` 直接提交 depot)
  - **rejected** / **archived**

> ⚠️ **approved + commit 直达 depot 不可撤销** → 命令层 `showWarningMessage` 二次确认,文案注明「此操作不可撤销 / This cannot be undone」(对齐 p4 submit 红线)。破坏性确认放命令层,不进 swarmClient 方法。

### 5.5 作者侧闭环(打回 → 修订)

```
状态变 needsRevision → 作者在 SCM 改代码 → 重新 shelve(复用 client.shelve)
   → POST /reviews/{id}/changes { change }(关联新 version)
   → 状态回 needsReview,产生新 version
```

详情里的评论任务状态提醒作者哪些还没 addressed;作者可逐条回复 + 标 addressed。

### 5.6 通知与深链接

- **通知**:轮询发现「需我处理」新增 / 我的审核状态变化 → `window.showInformationMessage`(带「打开」按钮跳详情)。节流,避免刷屏。
- **深链接**:复用既有 `universe-editor://` 深链机制(memory `opener-service-deeplink-feature`),支持 `universe-editor://swarm/review/1234` 从外部(邮件/IM)直接打开某 review 详情 tab。

---

## 6. 命令与菜单贡献(manifest)

### 6.1 命令清单(前缀 `perforce.swarm.`,category `Perforce`)

`requestReview` / `openReview` / `openReviewList` / `refreshReviews` / `voteUp` / `voteDown` / `clearVote` / `changeState` / `addComment` / `replyComment` / `setTaskState` / `joinReview` / `editDescription` / `setSwarmToken`(方案 A)。

### 6.2 菜单位与 when 门控

- `scm/resourceGroup/context`:`requestReview`(`when: scmProvider==perforce && scmResourceGroup =~ /^cl:/`)。
- `view/title`(Swarm Reviews View):`refreshReviews` + 筛选。
- 审核详情 / 行内评论的动作走 renderer 内组件按钮(非 SCM 菜单)。
- Perforce Graph 节点右键:`requestReview`。

### 6.3 配置项(`perforce.swarm.*`)

`enabled`(默认 false,显式开启)/ `url`(server 地址)/ `apiVersion`(默认 `v11`)/ `pollInterval`(秒,0=关,最小 10s)/ `authMode`(`ticket`(默认)| `token`)。**凭据不进配置**。

### 6.4 命令遮蔽护栏(务必遵守)

- Swarm 命令 handler 都在**插件内**(extension-host)→ 正常写进 `package.json` 的 `commands` + `menus`。
- **例外**:若「打开审核列表 / 打开详情」的 handler 落在 **renderer Action2**,则该命令**绝不能写进 `package.json` 的 `commands` 数组**(会被无 handler 的宿主命令静默遮蔽成 no-op),只写进 `menus`——见 memory `renderer-action-shadowed-by-extension-command-decl`(perforce-graph 踩过)。

---

## 7. 分阶段路线图 P0–P5

> 每阶段末 `pnpm check` 全绿;改 extensions-common / extension-host 后先 build 再验 apps;交互改动交 CI 跑 e2e。

### P0 — 连接 / 配置 / 认证 / API 骨架
- `perforce.swarm.url/enabled/apiVersion/authMode` 配置;`swarmApi.ts`(fetch + Basic + retry + 错误映射);`swarmAuth.ts` ticket 路径;`swarmParser.ts` + DTO(`extensions-common/swarm.ts`)。
- 连通性自检命令(`GET /reviews?max=1`)+ 401→login 拦截。
- 单测:swarmParser / swarmAuth / 错误映射。
- **验收**:配置 URL 后能拉到自己的 review 列表(命令面板打印)。

### P1 — 审核列表 + 状态栏 + 只读详情
- 侧栏 ViewContainer + `SwarmReviewsView`(VirtualList + 智能分组 + 筛选)。
- 状态栏「待审核数」(dashboard + 轮询)。
- **只读**审核详情 tab(头部 + 文件列表 + 版本选择,暂不含 diff/评论)。
- **验收**:能「查看审核状态」——列表、筛选、点开详情看元数据。

### P2 — 发起 + 投票 + 改状态
- `requestReview`(shelve → POST /reviews,含 default→numbered 处理 + reviewers 表单)。
- 投票(乐观更新);`changeState`(先 transitions 门控,approved+commit 二次确认)。
- 作者闭环:重新 shelve → `POST /reviews/{id}/changes`。
- **验收**:核心闭环——发起、打分、打回/批准、修订全走通。

### P3 — 文件 diff + review 级评论
- 文件点击 → Monaco `DiffEditorInput`(本地 `p4 print @=<version-change>`,兜底 files API)。
- 版本对比切换(vN ⇄ vM)。
- review 级评论列表 + 发表/回复(`GET/POST /comments`)。
- **验收**:能真正 review——看 diff + 留评论。

### P4 — 行内评论 + 任务状态机
- Monaco view-zone/overlay 行内评论线程(照 `InlineDirtyDiffController`);React UI 经 createPortal 挂载。
- `context` 坐标映射(file + left/rightLine + content 前 4 行 + version)。
- 任务状态机(open/addressed/verified)+ 未解决任务清单。
- **验收**:完整 GitHub PR 式行内讨论体验。

### P5 — 轮询通知 + 深链接 + 打磨
- 轮询发现 → 节流通知(带跳转按钮);深链接 `universe-editor://swarm/review/{id}`。
- 打回闭环打磨(任务提醒、re-shelve 一键关联)。
- **可选扩展点**:方案 A 独立 token(`mainThreadSecret` 通道);对接 Swarm `aiReviewSummary`(2025.3+)复用编辑器 AI 基础设施做 diff 摘要。
- 用户文档 `docs/user/zh-CN/perforce/` 新增 swarm 章节。
- **验收**:体验完善,通知/深链/文档齐备。

---

## 8. 风险与注意

| 风险 | 说明 | 缓解 |
|---|---|---|
| 凭据泄漏 | ticket/token 误入明文 | 硬红线:只走 Authorization 头,日志只打 URL+状态码;配置/DTO/settings 无凭据 |
| 行内评论坐标漂移 | Swarm context 行号 vs 本地 diff 行号不一致 | diff 两侧取自 version 的 change 快照(非工作区),保证同源;content 带前 4 行防漂移 |
| API 版本差异 | v9/v11 端点/字段有别 | `apiVersion` 可配 + 默认 v11 回退 v9;parser 容错缺字段 |
| 大 review 负载 | review 对象大、评论多 | 列表用 `fields` 裁字段 + 分页;评论分页;缓存 + 增量轮询 |
| 无 Swarm 服务器验证 | 本机/CI 无可达 Swarm | swarmApi 认 `UNIVERSE_SWARM_BASE_URL` 覆盖 → fake-swarm(§9);纯逻辑抽纯函数单测 |
| 密钥通道(方案 A) | 补 RPC 通道有回归面 | trusted-only 条件注册;仅在确需独立 token 时做,默认 ticket 规避 |
| 权限误判 | 客户端算 approve 权限会错 | 一律 `GET /transitions` 由服务器裁定,UI 只显示合法项 |
| 巨型 diff | p4 print 超大文件撑爆 | 复用 `p4Service` 的 `DEFAULT_MAX_OUTPUT_BYTES` 上限守护(见 skill) |

---

## 9. 验证策略

- **单测(node)**:`swarmParser`(fixture)/ `swarmAuth`(ticket 组装)/ diff 坐标映射 / 错误映射 —— 全纯函数。
- **fake-swarm**:`apps/editor/e2e/fixtures/fake-swarm.mjs`(node `http` server 返回 fixture JSON),`swarmApi` 认 `UNIVERSE_SWARM_BASE_URL` 覆盖 base(照 fake-p4 的 `UNIVERSE_P4_PATH`)。e2e 无需真 Swarm。
- **e2e 冒烟**(`apps/editor/e2e/specs/`):列表加载 → 打开详情 → 发起审核 → 投票 → 改状态 → 加评论,断言 fake-swarm 收到对应请求。HTML5 拖拽类交互脚本化受限时直接 `runCommand`。
- `pnpm check`(lint+typecheck+全测+docs:check)每阶段全绿。
- 用户可见改动 → 同步 `docs/user/zh-CN/perforce/`,内部链接勿留死链。
- 红线复核(照 skill `extend-perforce-plugin`):新 spawn 走 `P4Service`;凭据只走 auth 头;路径比较走 `pathUtil.ts` `norm()`。

---

## 附:关键参考

- **Swarm 官方 API**:[Reviews](https://help.perforce.com/helix-core/helix-swarm/swarm/2024.2/Content/Swarm/swarm-apidoc_endpoint_reviews.html) · [Comments](https://help.perforce.com/helix-core/helix-swarm/swarm/2024.2/Content/Swarm/swarm-api-endpoint-comments.html) · [Files/diff](https://help.perforce.com/helix-core/helix-swarm/swarm/2024.5/Content/Swarm/swarm-api-endpoint-files.html) · [Review workflow & states](https://help.perforce.com/helix-core/helix-swarm/swarm/2025.1/Content/Swarm/code_reviews.workflow.html)
- **一手代码**:`extensions/perforce/src/{client,p4Service,baselineProvider,p4StatusBar,p4Error}.ts`;`apps/editor/src/main/services/ai/providers/openAiProvider.ts`(HTTP 模板);`apps/editor/src/renderer/workbench/scm/dirtyDiff/InlineDirtyDiffController.ts`(行内 overlay);`packages/extensions-common/src/perforceGraph.ts`(DTO 模板)。
- **skill**:`extend-perforce-plugin`(p4 分层/红线)、`extend-perforce-graph`(renderer 视图 + 命令桥)、`dirty-diff-inline-peek`(行内 overlay)、`create-extension`(插件骨架)、`extension-host-runtime`(加 RPC 通道,方案 A 需要)。
- **memory**:`editor-input-identity-isolation`、`renderer-action-shadowed-by-extension-command-decl`、`opener-service-deeplink-feature`、`ai-service-foundation-progress`。
- **前置 plan**:`perforce-scm-plugin-plan.md`、`perforce-collect-changes-ux-plan.md`。
