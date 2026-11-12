# 手机网关（Mobile Gateway）

> 状态：**M1 已落地**（协议包、main 网关与配对、PC 设置页、手机 PWA 骨架）；
> **M2 只读镜像后端已落地**（协议 v2、每窗口会话桥、main 侧收件箱/会话聚合、`acp-view-model`
> 抽取）；**M3 交互后端已落地**（协议 v3：命令路由、审批仲裁、倒计时下沉、新建会话、高风险限制、
> 幂等与审计）；**M4 通知已落地**（协议 v4：共享 attention 信号、前台 WS 通知、Web Push / VAPID、
> PC 焦点抑制、通知偏好与深链）；**M5 打包与加固已落地**（`resources/mobile`、局域网自签
> HTTPS / 证书轮换与指纹、CSP / 审计轮转 / 连接与设备上限、Tailscale / WSL 文档与冒烟）；
> **M6 会话附件已落地**（协议 v6：图片 / 文件附件经 HTTP 上传到 PC 临时目录，图片走 ACP
> `image`、文件走 `resource_link`，时间线展示缩略图与文件卡）；**M7 Fork / Rewind / 侧边任务已落地**
> （协议 v6：非激活分叉与恢复、回退 dry-run 预览、侧边任务列表 / 打开 / 级联删除）；
> **M8 会话目录已落地**（协议 v7：历史会话搜索与恢复）；**M9 受信设备已落地**（协议 v9：
> PC 逐设备授权高风险操作，默认关闭）；**M10 会话目录覆盖最近工作区已落地**（协议 v10：
> 历史目录同时读取已打开窗口与最近打开工作区的落盘历史，点击未打开工作区的行会自动开窗恢复）；
> **M11 手机交付已落地**（协议 v14：手机确认后把子 worktree 的提交交付到 main——预检、提交信息
> side task、临时树 cherry-pick、冲突 agent 解决、待推送、推送与 worktree 同步、撤销）；
> **M12 手机推送分支已落地**（协议 v16：把会话分支直接发布到远端，不改 main、绝不 force，
> 远端分支名可改为 `tasks/...`）；**M13 手机会话目录删除已落地**（协议 v18：历史行可由手机删除，
> 仅限 PC 已打开窗口所属行；live 行仍走既有删除链路）。
> 相关阅读：远程开发见 [remote-dev.md](remote-dev.md)，WSL 下的 e2e 环境见
> [wsl-e2e.md](wsl-e2e.md)，ACP 会话层见
> [renderer/services/acp/CLAUDE.md](../../apps/editor/src/renderer/services/acp/CLAUDE.md)。

## 1. 产品定位与范围

手机是 PC 编辑器里 ACP agent 会话的**遥控器**：不跑 agent、不存会话、不做第二套 agent 运行时。
PC 编辑器关闭时手机显示离线，不接管执行。

| 维度     | 定位                                                                |
| -------- | ------------------------------------------------------------------- |
| 形态     | PWA，由 PC 编辑器内置网关提供页面；手机浏览器打开后「添加到主屏幕」 |
| 数据归属 | 会话、agent 进程、工作区全部留在 PC；手机只持设备凭据与本地缓存     |
| 核心场景 | 离开工位后收到审批/提问，远程看一眼、批一下、发一句话               |
| 离线语义 | PC 编辑器不在线即整体离线，手机不做离线队列与本地执行               |

**第一期界面**

| 界面         | 内容                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------- |
| 收件箱       | 按待审批 / 运行中 / 已完成 / 出错分组；显示 agent、工作区、PC 在线状态                            |
| 会话页       | 摘要优先；工具调用默认折叠；diff 只读；可发 prompt、停止、切换模式与模型                          |
| 审批底部卡片 | 权限请求 + elicitation；先到先得，双端只有一次生效                                                |
| 新建会话     | 选 agent、工作区                                                                                  |
| 输入附件     | 会话输入框可拍照 / 选图 / 选文件；图片作为 ACP `image`，普通文件以 PC 本地 `file:` URI 交给 agent |
| 通知         | 仅「等待审批 / 提问 / 完成 / 出错」四类                                                           |

**第二期**：语音输入、多台 PC 切换、中转服务器（脱离局域网/ Tailscale）。

**明确不做**：文件浏览、代码编辑、终端、agent / MCP / 供应商配置、扩展管理。

**设计依据（竞品共识）**：移动端只做监工 / 审批 / 验收 / 通知；首屏是任务收件箱而不是会话列表；
ACP 生态目前没有成熟的移动客户端，因此协议与 view-model 需要自建。

## 2. 架构

```
手机 PWA ──HTTPS / WSS──▶ main：MobileGatewayMainService
                          配对 / 设备凭据 / 审计 / 收件箱聚合 / seq 补齐 / 推送
                                │ 每窗口一条反向通道（ServiceChannels.MobileBridge）
                                ▼
                        各窗口 renderer：MobileBridgeService
                          订阅 IAcpSessionService / IAcpSession observables
                          → 快照 + 增量；命令映射到现有方法
```

**网关放 main**：

- renderer 沙箱不能监听端口；
- 需要跨窗口汇总收件箱；
- 需要调用 `IWindowMainService.getOpenWindowInfos` / `openWindowForFolder` 查窗、开窗；
- 必须跨 renderer 重载存活，设备连接与 seq 不能随页面刷新丢失。

**桥放 renderer**：会话状态与权限 Promise 只存在于 renderer（见
`apps/editor/src/renderer/services/acp/CLAUDE.md` 的跨进程边界），桥只做投影与命令转发，**不复制状态**。
main 侧不直接读 `AcpSession`。

**通道与注册**：

- 新增 `ServiceChannels.MobileBridge`（`apps/editor/src/shared/ipc/channelNames.ts`），不扩展
  `RendererSessions` / `sessionSwitcher`——后者是 Alt+S 会话切换器的窄契约
  （`apps/editor/src/shared/ipc/sessionSwitcher.ts`），语义与生命周期都不同。
- renderer 侧照 `apps/editor/src/renderer/main.tsx` 中 `RendererSessions` 的
  `ProxyChannel.fromService` 方式注册桥服务；main 侧照
  `apps/editor/src/main/ipc/registerMainServices.ts` 的 `toService` 绑定。
- 窗口创建时由 `apps/editor/src/main/services/window/windowScopeFactory.ts` 把该窗口的桥句柄交给网关，
  网关按 `windowId` 维护反向通道与 renderer epoch。

**按订阅启停**：没有手机订阅时，桥不序列化 timeline、不计算增量、不发 IPC。会话本身仍按原有
16ms / 64ms 批次更新，桥只在存在订阅者时挂接。

## 3. 会话桥：快照与增量

**数据源**（全部来自 renderer 现有 observable）：

| 数据                   | 来源                                                                        |
| ---------------------- | --------------------------------------------------------------------------- |
| 会话集合与活跃会话     | `IAcpSessionService.sessions` / `activeSession`                             |
| 时间线、消息、工具调用 | `IAcpSession.timeline` / `messages` / `toolCalls`                           |
| 计划                   | `IAcpSession.plan`                                                          |
| 状态与展示状态         | `status` + `computeSessionDisplayStatus`（`session/acpSessionStatus.ts`）   |
| 待审批 / 待提问        | `pendingPermission` / `pendingElicitation`                                  |
| 配置、用量、只读、路径 | `configOptions` / `usage` / `readOnly` / `cwd` / `authority`                |
| 斜杠指令               | `IAcpSession.availableCommands`（agent 通告的 `available_commands_update`） |
| 收件箱分组             | `statusBucketFor`（`session/acpSessionFilterService.ts`）                   |

`statusBucketFor` 已把展示状态折叠为四档，正好对应收件箱四组：
`input_needed` → 待审批，`in_progress` → 运行中，`completed` → 已完成，`failed` → 出错。

**DTO 规则**：协议 DTO 必须纯可序列化——不能携带 `resolve` / `cancel` 函数、observable、URI 类实例。
服务端在序列化前把 observable 读成值；客户端拿到的只是快照。

**增量**：

- 所有增量按 `id` 幂等 upsert；客户端重复收到同一条不产生重复行。
- 流式文本只发 `append`；当前缀不匹配（rewind、replay、终端输出头部截断）时改发 `textReplace`。
- 工具调用与消息的详情不随主列表下发，见下文「大内容裁剪」。

**节流**：

| 层级     | 节奏                  | 说明                                                                                |
| -------- | --------------------- | ----------------------------------------------------------------------------------- |
| 会话状态 | 已有 16ms / 64ms 批次 | 重负载流使用 64ms（`acpSession.ts` 的 `STREAM_BATCH_MS` / `STREAM_HEAVY_BATCH_MS`） |
| 桥合帧   | 约 50ms 一帧          | 重流（replay / 大量 append）放宽到约 100ms                                          |
| 单帧体量 | < 1MB                 | `MAX_SERVER_FRAME_BYTES`；超限快照丢弃最早 timeline 项并标记 `truncated`            |
| 出站队列 | 每连接 1MB            | `ws.bufferedAmount` 超限时丢弃中间增量，回 `resync_required{scope:'session'}`       |

**大内容裁剪**：

| 内容               | 主列表下发                                          | 详情按需                                            |
| ------------------ | --------------------------------------------------- | --------------------------------------------------- |
| 工具调用           | preview（≤1KB）+ `hasDetail` + diff 增删行数        | `getToolCallDetail`，上限复用 `acpContentLimits.ts` |
| 消息               | 正文 + `hasNonText`；`memoryTrimmed: true` 时无正文 | M2 无消息详情命令                                   |
| diff               | 统计信息                                            | M2 无 diff 详情命令                                 |
| 附件               | 元数据（id / kind / name / size）                   | 手机按 id 经 HTTP 懒加载，WS 不下发 base64          |
| 已被内存裁剪的内容 | `memoryTrimmed: true`                               | 显示「内容已释放」，不重新拉取                      |

## 4. 协议

**包位置**：新建 `packages/mobile-protocol`。运行时**零依赖**，SDK 侧只用 `import type`。

- 不放 `packages/primitives`：primitives 有零依赖红线与 URI 内核定位，塞协议会污染其职责。
- 不放 `packages/platform`：PWA 不应依赖编辑器内核，也不应把 Electron/Node 语义带进浏览器。

**版本与握手**：`MOBILE_PROTOCOL_VERSION = 18`（v2 增加会话镜像帧；v3 增加交互命令、`requestId`、
`allowedOnMobile`、`permission_cleared` 元数据与命令幂等；v4 增加 `notification` 边沿、Web Push
订阅、`client_state` 可见性与通知偏好；v5 增加工具卡的 `subagent` / `requiresUserDecision` 标记，
供手机端「仅消息」过滤对齐桌面语义；v6 增加附件（`sendPrompt.attachmentIds`、消息
`attachments`、`summary.imageSupported`、`attachment_not_found`）、fork / rewind / 侧边任务
（对应命令、agent 能力位、消息锚点与侧边任务关系字段）与 `closeSession` 命令；v7 增加会话目录
（`listSessionHistory` / `openSession`、`MobileSessionHistoryEntry` 与 `history` 能力位）；v8 增加
工作区 git 状态（`MobileWorkspaceCandidate.windowId?` / `gitDirty?`）与工具卡的 `startedAt` /
`durationMs` / `settleReason` / `syntheticDenial`（供手机端「仅消息」尾部当前进展行对齐桌面：
实时已运行时长、失败原因与上游中断判定）；v9 增加受信设备：`hello_ok.trusted` 与
`device_trust_changed` 帧；v10 让会话目录覆盖最近工作区：`MobileSessionHistoryEntry.windowId`
改为可选并新增 `folder?`，`openSession` payload 新增 `folder?` / `authority?`，网关在目标工作区
未打开时先自动开窗再恢复；v11 增加 agent 斜杠指令：快照 `availableCommands` 与
`available_commands_snapshot` 增量，供手机输入 `/` 时做内联补全；v12 增加消息图片：
`MobileTimelineMessageItem.images?` / `MobileMessageUpsertEvent.images?` 只下发
`{ index, mimeType, size, truncated? }` 元数据，字节经同源 HTTP `/api/sessions/image` 与
`/api/sessions/file` 按需读取（见 §7b）；v13 增加双端草稿同步：
`session_snapshot.draft`、`session_delta` 的 `draft_update` 事件、客户端 `draft_update` 帧与
`sendPrompt.draftImageIds` / `draftFileIds`（见 §7c）；v14 增加交付（`previewDelivery` /
`startDelivery` / `getDelivery` / `confirmDeliveryPush` / `retryDelivery` / `undoDelivery` /
`openDeliveryMainWorktree`、`MobileDeliveryPreview` / `MobileDeliverySummary` /
`MobileDeliveryDetail`、会话摘要的 `delivery?` / `deliveryAvailable?` 与四个 `delivery_*`
错误码，见 §6d）；v15 增加 `hello_ok.webBuildId`：网关从当前 `index.html` 的入口脚本名生成构建
标识，手机端与自身已加载的入口脚本名比对，不一致时提示刷新（协议版本不变时也能发现 PC 重建）。
v16 增加分支推送：`previewPushBranch` / `pushBranch`、`MobilePushBranchPreview` /
`MobilePushBranchResult` 与四个 `push_*` 错误码（只发布会话分支，不碰 main，见 §6e）；v17 让
光标 / 选区退出草稿协议：`draft_update` 删除 `baseRevision`、draft 删除 `caret`，origin 回显只作
ack（见 §7c）；v18 增加会话目录删除：`deleteHistorySession` 命令与 `{ durableId, windowId? }`
payload，只删除 PC 已打开窗口所属的历史行（未打开工作区的行无入口），live 行优先走
`deleteSession`（见 §6c）。
WS 建立后第一帧必须是
`hello { protocolVersion, token, clientVersion, capabilities }`，服务端回
`hello_ok { ..., serverTime, capabilities, webBuildId?, vapidPublicKey?, trusted }`；`trusted` 表示 PC 是否已
对该设备开启高风险操作，握手时由 main 的 hub 给出权威值；v7 起的 `hello_ok.capabilities` 为

`['inbox', 'commands', 'notifications', 'history', 'draft', 'attachments']`（`draft` 恒在；`attachments` 仅在附件服务可用时出现），旧客户端可以只看 `inbox`。
`webBuildId` 只反映静态资源构建（Vite 每次构建会改入口脚本哈希），不参与协议兼容判断；
`vapidPublicKey` 只在网关可推送
时出现，VAPID 公钥走握手而不是额外 HTTP 端点。**token 不放 URL query**，避免进入访问日志与
Referer。

**客户端 → 服务端**

| 消息                                        | 作用                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `hello`                                     | 协议版本、设备 token、客户端版本、能力                                                    |
| `subscribe_inbox` / `unsubscribe_inbox`     | 订阅或退订收件箱                                                                          |
| `subscribe_session` / `unsubscribe_session` | `{ ref, afterSeq? }`，订阅单个会话                                                        |
| `command`                                   | `{ requestId, kind, payload, idempotencyKey? }`                                           |
| `push_subscribe`                            | `{ subscription:{endpoint,keys}, prefs? }`，注册 Web Push（端点必须命中推送服务允许列表） |
| `push_unsubscribe`                          | 注销本设备的 Web Push 订阅                                                                |
| `set_notification_prefs`                    | `{ enabled, kinds?, alwaysNotify? }`，按设备保存通知偏好                                  |
| `client_state`                              | `{ visible }`，前台 / 后台声明；前台连接优先收 WS 通知                                    |
| `draft_update`                              | `{ ref, clientUpdateId, draft }`，draft 只含共享文档字段；origin 以回显作 ack（不做 command 应答） |
| `ping`                                      | 心跳，服务端回 `pong`                                                                     |

**命令 kind（v3 已实现）**：

| 分类        | kind                                     | payload                                                        | 说明                                                                                                              |
| ----------- | ---------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 详情        | `getToolCallDetail`                      | `{ ref, toolCallId }`                                          | 工具调用详情按需拉取                                                                                              |
| 会话        | `sendPrompt`                             | `{ ref, text, attachmentIds?, draftImageIds?, draftFileIds? }` | 空文本 + 附件合法；`draftImageIds` / `draftFileIds` 指向已物化在 PC 草稿中的附件；桥在 prompt 被接受后立即返回    |
| 会话        | `cancelTurn`                             | `{ ref }`                                                      | 停止当前 turn                                                                                                     |
| 审批        | `resolvePermission`                      | `{ ref, requestId, optionId, feedback? }`                      | 高风险选项被拒                                                                                                    |
| 审批        | `cancelPermission`                       | `{ ref, requestId }`                                           | 取消/关闭待审批卡片                                                                                               |
| 审批        | `resolveElicitation`                     | `{ ref, requestId, action, content? }`                         | `accept` / `decline` / `cancel`                                                                                   |
| 配置        | `setConfigOption`                        | `{ ref, configId, value }`                                     | `string`（select）或 `boolean`                                                                                    |
| 自动执行    | `pauseAutoResolve` / `resumeAutoResolve` | `{ ref, requestId }`                                           | 暂停 / 继续 plan 倒计时                                                                                           |
| 会话管理    | `newSession`                             | `{ agentId, workspace, initialPrompt? }`                       | 见 §6                                                                                                             |
| 会话管理    | `renameSession`                          | `{ ref, title }`                                               | 会话标题                                                                                                          |
| 会话管理    | `closeSession`                           | `{ ref }`                                                      | 结束活跃会话并关闭 PC 标签页，保留历史（等价 PC 关标签页）                                                        |
| 会话管理    | `deleteSession`                          | `{ ref }`                                                      | 复用 PC「Delete Agent Session」的 plan → 执行链路                                                                 |
| 分叉 / 回退 | `forkSession`                            | `{ ref, messageId? }`                                          | 从锚点之前或末尾创建新会话；**不激活 PC**                                                                         |
| 分叉 / 回退 | `previewRewind`                          | `{ ref, messageId }`                                           | 回退 dry-run：只返回文件影响，不修改会话                                                                          |
| 分叉 / 回退 | `rewindSession`                          | `{ ref, messageId, rewindFiles? }`                             | 截断到锚点之前；`rewindFiles:false` 保留文件                                                                      |
| 侧边任务    | `createSideTask`                         | `{ ref, quote? }`                                              | 以父会话历史为上下文创建只读侧边任务                                                                              |
| 侧边任务    | `listSideTasks`                          | `{ ref }`                                                      | 直接子任务（含历史行），只读                                                                                      |
| 侧边任务    | `openSideTask`                           | `{ ref, sideTaskId }`                                          | 非激活恢复；历史行也可打开                                                                                        |
| 侧边任务    | `deleteSideTask`                         | `{ ref, sideTaskId }`                                          | 级联删除该任务及其子树（含历史行）                                                                                |
| 枚举        | `listWorkspaces`                         | `{}`                                                           | 打开窗口 ∪ 最近工作区，带 `isOpen`；打开候选带 `windowId`，前 20 个候选尽力探测 `gitDirty`（见 §6）               |
| 枚举        | `listAgents`                             | `{}`                                                           | 由第一个已注册窗口桥返回                                                                                          |
| 会话目录    | `listSessionHistory`                     | `{}`                                                           | 已打开窗口 + 最近工作区（前 N 个，N 可配、默认 20）的可恢复历史行，只读；已排除侧边任务、归档、无消息与跨工作区行 |
| 会话目录    | `openSession`                            | `{ durableId, windowId?, folder?, authority? }`                | 按 durable id 非激活恢复历史会话；目标工作区未打开时先自动开窗再恢复；带幂等键                                    |
| 会话目录    | `deleteHistorySession`                   | `{ durableId, windowId? }`                                     | 删除 PC 已打开窗口所属的历史行；live 竞态走 `deleteSession`；无 owner 回 `session_not_found`；带幂等键            |
| 交付        | `previewDelivery`                        | `{ ref }`                                                      | 交付 dry-run：源 / 目标 / 提交列表 / blocker / 期望 heads；不改 git                                               |
| 交付        | `startDelivery`                          | `{ ref, expectation }`                                         | 重新校验 preview 的 heads 后执行；成功先停在「待推送」                                                            |
| 交付        | `getDelivery`                            | `{ ref, deliveryId }`                                          | 详情：阶段、错误、commit 列表、冲突文件、worktree 同步结果                                                        |
| 交付        | `confirmDeliveryPush`                    | `{ ref, deliveryId }`                                          | 用户确认后前移 main、push、同步 worktree                                                                          |
| 交付        | `retryDelivery`                          | `{ ref, deliveryId }`                                          | 失败后重新走 preview + start（旧的临时树与锁会先清理）                                                            |
| 交付        | `undoDelivery`                           | `{ ref, deliveryId }`                                          | 撤销最近一次交付：未推送回滚 main；已推送 revert + 非 force push + 同步                                           |
| 交付        | `openDeliveryMainWorktree`               | `{ ref, deliveryId }`                                          | 在 PC 打开 main worktree（复用已开窗口）                                                                          |
| 分支推送    | `previewPushBranch`                      | `{ ref }`                                                      | 推送 dry-run：源分支 / 远端分支 / 分叉状态 / blocker / 期望 heads；不改 git                                       |
| 分支推送    | `pushBranch`                             | `{ ref, expectation }`                                         | 重新校验后 `git push`（绝不 force）；远端分支名由客户端传入，可改名为 `tasks/...`                                 |

`forkSession` / `previewRewind` / `rewindSession` 的 `messageId` 是 **SDK 消息锚点**
（`AcpMessage.messageId`，仅 user 消息会有），不是本地的 `AcpMessage.id`；首条用户消息可回退、
但不可用于 fork。`forkSession` 省略 `messageId` 表示从末尾分叉。

未知 kind 仍回 `command_result { ok: false, error: 'not_supported' }`，不会导致解析错误。

**幂等**：会修改状态的命令可带 `idempotencyKey`。网关在内存中缓存首个结果 5 分钟
（`COMMAND_IDEMPOTENCY_TTL_MS`），并对同时到达的同 key 请求共享同一个 in-flight Promise；
只读命令（如 `getToolCallDetail`、`previewRewind`、`listSideTasks`、`listSessionHistory`）不缓存。客户端重试不会重复发
prompt、重复建会话或重复分叉。`forkSession` / `rewindSession` / `createSideTask` / `openSideTask` /
`deleteSideTask` / `openSession` / `deleteHistorySession` 都按可修改状态命令处理；交付中的 `startDelivery` /
`confirmDeliveryPush` / `retryDelivery` / `undoDelivery` / `openDeliveryMainWorktree` 同样处理
（`previewDelivery` / `getDelivery` 只读，不缓存）。

**超时**：网关对每条命令设上限，避免坏桥挂死连接：`sendPrompt` 15s（附件读盘 + 桥转发），
`cancelTurn` 5s；审批、配置、自动执行、重命名、`closeSession` 10s；`deleteSession` /
`deleteHistorySession` / `newSession` / `previewRewind` 30s；`forkSession` / `rewindSession` /
`createSideTask` / `openSideTask` / `deleteSideTask` 120s（要等 agent fork RPC 与 resume），
`listSideTasks` 10s；
`listSessionHistory` 8s（逐窗口等桥就绪最多 5s + 桥读取；每个关闭工作区读盘额外 2s 上限），
手机端 20s 覆盖网关最坏耗时；
`openSession` 从入口起共用一份 100s 总预算：live 查找、owner 扫描、开窗、等桥、历史轮询与恢复都
只花剩余时间，只有 owner 立即回 `session_not_found` / `forbidden_operation` 才换下一个 owner，
不会把多个 100s 串联。无 owner 时先按 payload `folder` 或磁盘反查定位工作区，再开窗、等桥、
轮询新窗口的 history 就绪后恢复；超时回 `session_not_found` 或 `workspace_not_open`。手机端
120s + 5s 宽限仍等得到。交付命令的网关超时：`previewDelivery` / `startDelivery` /
`confirmDeliveryPush` / `retryDelivery` / `undoDelivery` 110s（手机端 120s），
`getDelivery` / `openDeliveryMainWorktree` 10s；跨窗口 busy 探测每窗口 5s。超时回
`command_result { ok: false, error: 'internal' }`。手机端 `sendPrompt` 同样是 15s，避免手机先超时重发。

**服务端 → 客户端**

| 消息                                 | 作用                                                 |
| ------------------------------------ | ---------------------------------------------------- |
| `hello_ok`                           | 握手成功                                             |
| `inbox_snapshot` / `inbox_delta`     | 收件箱全量 / 增量                                    |
| `session_snapshot` / `session_delta` | 单会话全量 / 增量                                    |
| `command_result`                     | 按 `requestId` 返回成功或错误码                      |
| `notification`                       | 前台通知                                             |
| `resync_required`                    | 队列溢出、seq 缺口或设备受信状态变化，客户端重拉快照 |
| `device_trust_changed`               | PC 授予 / 收回了该设备的高风险操作权限               |
| `server_error`                       | 服务端内部错误                                       |
| `device_revoked`                     | 设备被吊销，客户端清凭据并断开                       |
| `pong`                               | 心跳响应                                             |

**seq 与会话 key**：

- 每个 scope（收件箱 / 每个会话订阅）各自单调递增 `seq`；快照带当前 seq。
- **M2 不留环形缓冲**：订阅/重连一律回全量快照，`afterSeq` 被忽略；增量只在订阅建立后转发。
  订阅时若快照生成期间已有增量，网关先暂存、快照发出后再补发。
- 连接 `bufferedAmount` 超过 1MB 时丢弃中间增量并回 `resync_required{scope:'session', ref}`；
  该订阅随后停止转发，客户端重新 `subscribe_session` 即恢复。
- 会话 key 优先 `durableId`（`sessionIdOnAgent`）；`ref` 始终带 `windowId + localId`，
  `durableId` 可选。**没有 `session_rekeyed` 帧**；会话消失时发 `session_removed`。
- 快照超 1MB 时从最早 timeline 项开始丢弃，并带 `truncated: true`。

**M2 快照与增量事件**：

- `MobileSessionSnapshot { seq, summary, timeline, plan, configOptions, availableCommands,
usage?, pendingPermission?, pendingElicitation?, isReplayingHistory, truncated? }`。
- `summary` 含 `ref / agentId / agentName? / title / status / displayStatus / bucket /
workspaceName / cwd? / authority? / readOnly / hasPendingPermission /
hasPendingElicitation / backgroundTaskCount / imageSupported? / updatedAt`（会话最近活动时间，
  取会话历史的 `lastUsedAt`，不是快照生成时刻）；v6 增加可选
  `forkSupported / rewindSupported`（agent 能力位）与 `sideTaskOf`（父会话 durable id）/
  `sideTaskChildCount`（直接子任务数）。
- `timeline` 为判别联合：`message`（正文、`streaming`、`hasNonText`、`attachments?`、
  `images?`；v6 对 user 消息额外带 SDK 锚点 `messageId` 与 `canFork`）/ `toolCall`
  （`toolKind`、`status`、preview、diff 增删行数；可带 `subagent` / `requiresUserDecision`
  标记，手机端「仅消息」据此保留子 Agent、计划确认与需决策卡片；v8 另带可选的
  `startedAt` / `durationMs` / `settleReason` / `syntheticDenial`，用于底部当前进展行的
  秒表与失败原因）/ `notice`
  （compaction / resurrection）。`canFork` 在首条用户消息、只读会话或 agent 不支持 fork 时为
  false；`messageId` 只在 user 且非 autoRetry 时出现。
- `session_delta.events`：`message_upsert`（`textAppend` 后缀或 `textReplace` 全量）、
  `tool_call_upsert`、`timeline_item_added/removed`、`plan_snapshot`、
  `config_options_snapshot`、`available_commands_snapshot`、`summary_changed`、
  `permission_upsert/cleared`、`elicitation_upsert/cleared`。
- `availableCommands` 只含展示所需字段：`{ name, description, inputHint? }`。`name` 由桥在投影时
  去掉前导 `/` 并按小写去重；空名或含空白的条目直接丢弃（否则网关的整帧自校验会失败）。
  上限 100 条，name ≤128、description ≤256、inputHint ≤128 字符；快照与增量都发全量列表。
- v3 的 `MobilePendingPermission` 带 `requestId`、每个选项带 `allowedOnMobile`，并可能带
  `autoResolve { optionId, deadlineAt?, paused }`；`permission_cleared` 带
  `{ requestId, reason, source }`，让手机区分 PC / 手机 / 自动执行与「被新请求取代」。
- `message_upsert.attachments` / `images` 缺省表示不变、`[]` 表示清空；`hasNonText` 只表示未被
  `attachments` / `images` 表达的非 text block（避免缩略图与「[包含附件]」占位重复）。
- `summary_changed` 比较时忽略 `updatedAt`，避免每次合帧都发；`usage` 只在快照下发。

**错误码**

| 错误码                 | 语义                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `unauthorized`         | token 缺失/无效/已吊销                                                           |
| `forbidden_operation`  | 高风险操作被策略拒绝                                                             |
| `session_not_found`    | 会话不存在或已关闭                                                               |
| `session_read_only`    | 只读预览会话不能写                                                               |
| `stale_request`        | `requestId` 已不在等待中（重复点击 / 另一端先处理）                              |
| `workspace_not_open`   | 目标工作区没有打开窗口且不能自动开窗（会话目录开窗恢复同样用此码）               |
| `not_supported`        | 当前档位/版本不支持该命令                                                        |
| `unsupported_by_agent` | 当前 agent 未声明 fork / rewind 能力                                             |
| `invalid_anchor`       | 消息锚点不存在、已回退，或不能用于该操作（如首条用户消息用于 fork）              |
| `session_busy`         | 会话正在运行，fork 被拒绝                                                        |
| `rate_limited`         | 触发速率限制（含附件配额已满）                                                   |
| `attachment_not_found` | 附件不存在、已过期或属于其他设备                                                 |
| `delivery_busy`        | 同一仓库已有交付在运行（含其它窗口），或交付期间该 worktree 被占用、其会话被删除 |
| `delivery_not_found`   | 交付 id 不存在、已被清理，或不属于该会话                                         |
| `delivery_conflict`    | main / 远端已移动、push 被拒或冲突无法自动解决，需要人工处理                     |
| `delivery_unsupported` | 仓库形态不满足交付条件（bare / detached main / 无唯一 upstream / 合并提交等）    |
| `push_busy`            | 同仓库正在交付 / 推送，或会话仍在运行                                            |
| `push_conflict`        | 远端分支已移动或分叉，需要先在 PC 上同步                                         |
| `push_unsupported`     | 分支不可推送（detached / 无远端 / 无可推送提交 / 分支名非法等）                  |
| `push_failed`          | push 本身失败（网络、鉴权、远端拒绝）                                            |
| `internal`             | 未分类的服务端错误                                                               |

`stale_request` 表示这次点击基于过期卡片：请求可能已被 PC 或另一端处理。客户端应直接按
快照/增量收敛 UI（卡片消失），不要把它显示成操作失败，也不要自动重发。

`canRewind:false` 不是错误：`previewRewind` / `rewindSession` 正常返回 `ok:true` 并带 agent 的
`error` 说明，手机只展示原因、不提供应用按钮。

## 5. 审批仲裁

**已实现**：`onRequestPermission` / `onCreateElicitation`
（`apps/editor/src/renderer/services/acp/session/acpSessionService.ts`）都带 `settled` 守卫，
**首个 resolve / cancel 生效，后续调用整体 no-op**。重复点击、PC 与手机竞速、手动与自动同刻
都只结算一次，`persistAllow` 与 telemetry 不会重复落。

**DTO 与事件**：

- `AcpPendingPermission` / `AcpPendingElicitation` 带稳定 `requestId`。
- 结算 API 记录来源：`resolveWithSource(optionId, 'pc' | 'mobile' | 'auto', feedback?)`、
  `cancelWithSource(source, reason?)`；旧的 `resolve` / `cancel` 等价于 `'pc'`。
- service 发出 `onDidSettlePermission { requestId, outcome, optionId?, source, reason }` 与
  `onDidSettleElicitation`；被新请求取代时 `reason: 'superseded'`。
- 桥把结算元数据附到 `permission_cleared { requestId, reason, source }` 广播；手机据此区分
  「自己在另一端点过」「PC 处理」「自动执行」。

**双端行为**：

- PC 与手机订阅同一个 observable；任一端处理后，另一端卡片自然消失。
- 手机重连靠快照恢复待审批卡片；不在内存里重放旧请求。
- renderer 重载导致的取消显示「请求已失效」，不显示为用户取消。
- 手机通过未匹配当前 `requestId` 的请求时回 `stale_request`（见 §4 错误码）。

**plan 自动执行倒计时已下沉到 service**：

- `AcpPendingPermission.autoResolve` 由 `AcpSessionService` 创建并持有定时器，状态为
  observable：`{ deadlineAt?, paused, remainingMs, cancelled }`。
- 暴露 `pause()` / `resume()` / `cancel()`；`resume()` 从剩余时间重新计时。
- `PermissionCard` 不再自己 `setTimeout`，只读状态并在 hover / focus 时暂停、离开时恢复，
  取消勾选调用 `cancel()`。
- 到点由 service 以 source `'auto'` 结算；**会话 tab / 卡片未挂载时也照常执行**。
- 手动选择与自动到点的竞速由 §5 的 `settled` 守卫收敛为一次结算。
- 倒计时相关逻辑有单测覆盖（service 层，不依赖 UI）；行为变更已同步到
  `docs/user/zh-CN/ai-agent/modes-and-thinking.md`。

**通知抑制**：带 `autoResolve` 的审批不产生手机通知，与现有
`apps/editor/src/renderer/contributions/AgentNotificationContribution.ts` 的边沿保持一致。

## 6. 新建会话

**工作区候选**：已打开窗口（`IWindowMainService.getOpenWindowInfos`）∪ 最近工作区
（`IRecentWorkspacesService`，`apps/editor/src/main/services/workspace/recentWorkspacesMainService.ts`）。
按 canonical folder 去重，路径身份走 `hub` 的 `isSameWorkspace`（scheme / authority 相等 +
`arePathsEqual(fsPath, fsPath, normalizePlatform(process.platform))`），**不手写
`fsPath.toLowerCase()` / 反斜杠折叠**。远程工作区标记 authority。

**顺序即契约**：响应里已打开窗口在前、最近工作区随后；两组都按 `lastOpened` 倒序
（已打开工作区用其在最近列表中的位置排名，不在最近列表里的排在组尾并保留窗口顺序）。手机端只按
`isOpen` 稳定分组（已打开 / 最近），不再按名称重排——字母序会覆盖最近打开时间。

**工作区 git 状态**：`listWorkspaces` 尽力为候选附带 `gitDirty`（`true` 有未提交修改、`false`
干净、省略为未知）。本地 `file:` 工作区（含 UNC）由 main 的 `WorkspaceGitStatusService` 直接执行
`git status --porcelain -z`（`GIT_OPTIONAL_LOCKS=0`、`buildChildEnv` 清洗环境、单次 1.5s 超时、
8MB 输出上限），结果按路径身份键缓存 5s，并合并同路径的在途请求；已打开的远程工作区走该窗口
renderer 桥的 `getWorkspaceGitDirty`——git 扩展跑在远端 extension host，桥读取本地
`IScmService` 中 `id === 'git'` 的 `count > 0`（含未跟踪文件），1.5s 超时；仅最近、未打开的远程
工作区返回未知（手机也不能从它创建会话）。探测覆盖所有已打开候选（收件箱依赖），其余用较新的
最近候选补足到 20 个，4 并发、总预算 2.5s；非 git 仓库、git 不可用、超时、renderer 未就绪
（冷启动 git 扩展尚未报数）都静默省略字段，UI 不显示任何标记。收件箱用候选的 `windowId` 与
`session.ref.windowId` 关联，因此不给会话摘要新增路径字段。

**三种路径**（`MobileGatewayHub._newSession`）：

| 目标工作区状态                        | 行为                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 已有匹配窗口                          | ping 探活通过后调用该窗口桥的 `newSession`（覆盖 renderer reload）                                                                     |
| 仅在最近列表                          | `openWindowForFolder` 自动开窗（会把窗口带到前台，已接受），等 main 侧桥注册，再 ping 到 renderer 的 `MobileBridge` 通道应答后才发命令 |
| 都不在 / 等待桥超时 / ping 始终无应答 | 返回 `workspace_not_open`                                                                                                              |

**为什么必须 ping**：`createWindowScopedServices` 在 `loadURL` **之前**就调用了
`mobileGateway.registerWindowBridge(...)`，`waitForBridge` 只能证明 main 侧反向代理存在；
renderer 的 `ServiceChannels.MobileBridge` 要等 bundle 启动到 `main.tsx` 才注册。此前直接发
`newSession` 会撞上这个窗口期：帧被 `ElectronProtocol.send` 静默丢弃（或命中未注册通道），
RPC 永不返回，手机端只看到工作区被打开、会话没创建。

**就绪门覆盖所有跨进程调用**：`_ensureWindowReady` 不只用于 `newSession`——inbox 快照与
`listSessions`（每窗口 5s）、会话快照（就绪 + `getSnapshot` 共用 10s）、`listAgents`（就绪 +
调用共用 10s，低于手机端命令超时）都会先等 ping 应答；renderer 未就绪时 `_syncWindow` 完全
不发送 `startStreaming` / `startAttention` 帧，探活成功后再一次性建立事件订阅与 streaming 接线。
探测失败会清掉旧的事件订阅并把 streaming/attention 标志归零（不向可能已消失的旧 renderer 发
stop），下一次成功探测重新订阅并重发幂等开关，因此 renderer reload 后事件流能自愈。

**参数槽位陷阱**：`newSession` 的 `initialPrompt` 用 `string | null` 而非可选参数。代理在发送前
会剥掉参数数组尾部的 `undefined`，若省略 prompt，取消 token 会被前移进 prompt 槽位（renderer
把 token 当 prompt、真正的 token 变成 `undefined`），超时取消随之失效。`null` 原样过线，槽位稳定。

**预算**：打开窗口、等通道就绪、创建会话共用一个 25s deadline（低于手机端 30s 命令超时），
超时返回 `workspace_not_open` / `internal` 而不是让手机先超时。每次 ping 带 500ms 超时 +
100ms 间隔，并用 `CancellationToken` 取消，避免被丢弃的 RPC 在 channel client 里堆积。
`newSession` 超时会取消底层请求，避免手机已收到超时后 renderer 又创建出「幽灵会话」。

**远程**：已有远程会话可以镜像到手机；最近列表里的远程工作区与本地工作区一样，由手机请求自动开窗。
远程连接随后由新窗口 renderer（`RemoteStatusContribution`）与 ACP host 的
`getConnection(authority)` 异步建立，连接失败体现为会话自身的连接错误，而不是
`workspace_not_open`。后者只用于工作区既不在打开列表也不在最近列表、开窗失败、等桥超时或
renderer ping 无应答。

**时序**：`createSession` 同步返回；桥立即回 `{ localId, durableId? }`，初始 prompt 先入队，
客户端可以立即 `sendPrompt`，由会话保证在 ready 后按顺序投递。`listWorkspaces` 返回
`{ folder, name, authority?, isOpen }`；`listAgents` 返回 `{ id, name, isDefault }`。
新窗口的 renderer 在创建会话 / 列出 agent 前会等 `IUserSettingsSyncService.whenInitialized`
（`ConfigInitContribution` 的 hydration 是 fire-and-forget），否则自定义 `acp.agents` 可能还没进内存。

## 6b. Fork / Rewind / 侧边任务（v6）

三项能力都复用桌面 `IAcpSessionService` 的既有实现，桥只做守卫、参数归一与结果裁剪，不复制算法。

| 命令             | 关键行为                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `forkSession`    | `sessions.forkSession(id, messageId, { activate:false })`；运行中回 `session_busy`；首条用户消息回 `invalid_anchor`；手机分叉不抢 PC 焦点 |
| `previewRewind`  | `rewindSession(..., { dryRun:true })`；只回 `canRewind / error / filesChanged 数量 / insertions / deletions`，**不把文件路径发给手机**    |
| `rewindSession`  | 默认回滚文件，`rewindFiles:false` 保留文件；成功后把锚点原文放进响应 `text`，只用于手机输入框回填，**不写 PC 的 `AcpPromptReplaceInbox`** |
| `createSideTask` | `forkSideTask` 以父会话完整历史为上下文、抑制 replay 基线、强制只读；quote trim 后截到 8000 字符，标题取折叠空白后的前 60 字符            |
| `listSideTasks`  | 按父会话 durable id 列直接子任务；含历史行；`live` 只表示当前窗口已 resident，不是正确性信号                                              |
| `openSideTask`   | 历史行走 `resumeSession(id, { activate:false })`；已 resident 直接返回 ref；只允许直接子任务                                              |
| `deleteSideTask` | `collectSideTaskDescendants` + `deleteSideTasks` 级联删除子树（含历史行）                                                                 |

**焦点**：`resumeSession` / `forkSession` 增加可选 `activate`，手机一律传 `false`。`resumeSession`
的 in-flight 去重（`_resumingBySessionId`）在 await 之后按 `wantActive` 补 `setActive`，否则手机先发起的
非激活 resume 会让 PC 后到的主动 resume 无法成为 active。

**history 初始化**：所有新命令（以及 `startStreaming` / `listSessions` / `getSnapshot`）先
`await _ensureHistory()`；`IAcpSessionHistoryService.initialize()` 失败只 warn，不阻塞 live 操作。
side task 字段与列表依赖 history，未初始化时表现为字段缺失 / 空列表。

**失败映射**：`AcpForeignWorktreeError` → `forbidden_operation`；能力位缺失 →
`unsupported_by_agent`；锚点不存在 / 非 user / autoRetry / 首条用户消息用于 fork → `invalid_anchor`；
运行中 fork → `session_busy`；其他 → `internal`（日志只记错误消息，不记 prompt / quote / 正文）。

## 6c. 会话目录与恢复（v7，v10 扩展范围）

**范围**：手机目录 = 已打开窗口的历史（renderer 内存镜像，最实时）∪ 最近打开工作区中未被打开
窗口覆盖的前 N 个（main 只读读取各自的落盘历史）。`N = gateway.json` 的
`sessionHistoryWorkspaceLimit`，默认 20、范围 1–100；已打开窗口不受 N 限制。收件箱仍只显示
live 会话，不读盘。没有新增 main 侧历史存储，也不改变「PC 是唯一真相」的边界。

**落盘位置**：历史仍由 renderer 的 `AcpSessionHistoryService` 通过 `PersistedStateBase` 写入
WORKSPACE 桶 `<userData>/workspaces/<id>.json`，键 `acp.sessionHistory`，payload 为
`{ schemaVersion, entries, deleted }`。桶 id 与 `WorkspaceMainService` 完全一致：
`sha1(folderUri.toString()).slice(0,16)`。`folderUri` 来自最近工作区列表的 canonical URI 字符串，
因此远程工作区（`remote-ssh://authority/...`）也能算出正确桶，无需额外映射。

**读盘**（`workspaceSessionHistoryReader.ts`）：main 直接 `readFile` + `JSON.parse` 桶文件，
**不走 `createStorage`**——后者遇到坏 JSON 会把文件改名为 `.corrupt`，而手机目录读取必须是纯只读。
文件缺失、坏 JSON、超过 16MB、`schemaVersion` 不在 1–6（与 renderer 的兼容范围一致）都返回空并
打 debug 日志，绝不写盘。条目归一化与 renderer 一致（`id !== sessionIdOnAgent` 时取后者），并应用
同一套可恢复过滤：排除侧边任务、归档、`hasMessages === false`、空 id、`deleted` 墓碑，以及
`isForeignWorkspaceSession` 判定的跨工作区行。过滤规则抽在
`apps/editor/src/shared/mobileGateway/sessionHistoryFilter.ts`，renderer 桥与 main 读盘共用。

**聚合**（`MobileGatewayHub._listSessionHistory`）：已打开窗口照旧逐窗口 `_ensureWindowReady`
→ 桥 `listSessionHistory`；某个窗口无法应答（renderer 未就绪 / 超时 / 重载）时，回退只读该窗口
所属工作区的落盘桶，避免它的历史整体消失。随后对最近工作区的前 N 个关闭工作区读盘（并发 4，
每桶 2s 上限）。按 durableId 去重：**已打开窗口的行绝对优先**（窗口之间仍按 pinned / 较新
`lastUsedAt` 取一行）；磁盘行之间复用同一套 pinned / 较新规则，且只在没有同 id 的打开行时补入。
最后 pinned / `lastUsedAt` 降序，最多 200 行。打开行盖 `windowId` + `workspaceName`；磁盘行不带
`windowId`，盖 `folder` + `authority` + `workspaceName`。`folder` / `authority` 是身份而非展示
文本，不做截断：超过协议长度上限（`folder` 对齐 `openSession.folder` 的 `MAX_TEXT_LENGTH`，
`authority` 对齐 `MAX_WORKSPACE_NAME_LENGTH`）时直接省略该 hint。空 `durableId` / `agentId` 或
时间戳非有限值的坏行直接丢弃，避免手机端整份列表校验失败。行的 `durableId` 即
`AcpSessionHistoryEntry.id`（`sessionIdOnAgent`）；首条 prompt 截到 280 字符。

**打开**（`_openSession`）：入口计算一次 100s 总预算（`deadline = now + 100s`），live 查找、owner
扫描、开窗、等桥、历史轮询与 `bridge.openSession` 全部使用 `deadline - now` 的剩余预算；同一
durable id 的并发请求共享一个 in-flight promise。先在 inbox 与各窗口 `listSessions` 中找 live ref
（命中直接返回，避免二次 resume）；未命中时优先使用请求里的 `windowId` hint，否则扫描各窗口
`hasSessionHistory` 找 owner；按 owner 顺序 `bridge.openSession` →
`sessions.resumeSession(durableId, { activate: false })`。只有 `session_not_found` /
`forbidden_operation` 会换下一个 owner，其他错误立即返回，不把多个 resume 串成超长等待。

**未打开工作区**：所有窗口都没有该会话时：

- payload 带 `folder` → 直接使用；
- payload 不带 `folder`（深链 / 刷新丢失 hint）→ 在「未打开的最近工作区前 N 个」的落盘历史中按
  durableId 反查，命中则用该工作区（含远程 authority）。

随后复用 `newSession` 的开窗流程（`openWorkspace` → `waitForBridge` → renderer ping 就绪），
再以 300ms 间隔轮询 `bridge.hasSessionHistory(durableId)`，确认新窗口的 workspace 历史桶已加载
（renderer 可能仍停留在 GLOBAL 作用域）后才调用 `bridge.openSession`。轮询与开窗共用同一份 100s
预算；超时仍未命中回 `session_not_found`，开窗或等桥失败回 `workspace_not_open`。远程工作区同样
由 main 调 `openWindowForFolder`，随后由新窗口的 `RemoteStatusContribution` 与 ACP host 异步建立
远程连接，连接本身的失败仍体现为会话连接错误。**不切换 PC 焦点到某个会话**，但自动开窗会把窗口
带到前台（与新建会话一致，已接受）。

**手机**：`/sessions` 独立页把目录与 inbox live 行按 durableId 合并；live 行直接订阅，历史行才发
`openSession`。来自未打开工作区的行显示「将在 PC 上打开此工作区」，点击时把 `folder` / `authority`
随 `openSession` 发给 PC。搜索、全部 / 活跃 / 已关闭过滤与按天分组都在本地完成，网关不接收查询
参数。深链 `/s/<durableId>` 落到已关闭会话时，会话页提供「重新打开」按钮（同一 durable id 原地
订阅，不新增 URL）；此时 payload 通常没有 `folder`，由网关在前 N 个关闭工作区的落盘历史中反查
并自动开窗。从目录打开的会话返回时保留搜索词、过滤条件与滚动位置。

**删除**：每行左滑或长按可删除，均弹二次确认（可勾选「不再提醒」，与收件箱共用
`universe.mobile.sessionRemoveConfirm` 偏好）。只有 live 行与带 `windowId` 的已打开窗口历史行显示入口；
来自未打开工作区的行（只有 `folder`）不显示，网关也因找不到 owner 回 `session_not_found`。live 行发
`deleteSession(ref)`；历史行发 `deleteHistorySession { durableId, windowId? }`。网关先在 inbox 缓存中按
durableId 找 live 会话（PC 可能在手机列目录后恢复了它），命中则走 live 删除；否则用 `windowId` hint +
各窗口 `hasSessionHistory` 找 owner，对所有拥有该行的打开窗口执行桥删除（同一 durableId 可能存在于多个
窗口的历史镜像），至少一个成功即成功。桥侧复用 PC 的 `planSessionRemoval` → `deleteSessionPlan`：关闭
live 实例、尽力删除 agent transcript、写历史墓碑、关闭编辑器标签页。成功后手机立即从目录与 inbox 移除行。

**落盘滞后**：renderer 的历史写入有 100ms 防抖，且只保证退出时 flush。因此刚发生的重命名 / 新
会话 / 删除可能短暂落后于磁盘；已打开窗口永远走内存镜像，不受影响。手机目录刷新即重新读盘。

## 6d. 交付到 main（协议 v14）

手机可以就一个已完成的 ACP 会话，把它所在子 worktree 的提交交付到 main。**只手动触发**：
任务完成仍只发通知；收件箱会话行出现「交付」入口（摘要带 `deliveryAvailable:true`）后，用户
打开确认页（`previewDelivery`）再执行（`startDelivery`）。所有 git 写操作都在内置 git 扩展的
`git.agentDelivery.*` 命令里完成；renderer 的 `SessionDeliveryService` 只做状态机与编排，
main 与手机都不执行 git。

**流水线**（阶段即 `MobileDeliveryPhase`）：

1. `preflighting`：`inspect`（可 fetch）后获取跨窗口/目录锁；main 必须干净、无进行中操作且
   能从 upstream ff-only 前移；`begin` 记录 `mainHeadBefore` / `mainHeadAfter`。
2. `committing`：源 worktree 干净则跳过。脏时基于原会话 fork 一个 **internal 只读 side task**
   生成 commit message（imperative subject ≤72 字符，可带空行 + 简短 body）；renderer 把
   `changeContext` 的 status + 文件 diff 附进 prompt，发送前后校验变更指纹一致；随后由编辑器
   执行 `commitSource`（`git add -A` + `git commit`）。side task 失败 / 超时（90s）/ 空消息 /
   指纹变化一律终止交付：不落固定文案、不继续 cherry-pick。
3. `cherry_picking`：在 main worktree 同级创建 detached 临时 worktree
   （`.universe-editor-delivery-worktrees/<shortId>`），逐个 cherry-pick 源分支相对 main 的提交；
   空提交记入 `skippedEmpty`；合并提交 v1 直接 `delivery_unsupported`。
4. `resolving_conflict`：冲突时创建一个隐藏的 internal 可写 ACP 会话（cwd = 临时 worktree），
   提示只允许编辑冲突文件，最多 1 次。完成后扩展校验「修改文件集合 ⊆ 冲突文件集合」「无残留
   冲突标记」「无未合并路径」，再 `git add -A` + `cherry-pick --continue`。任一步失败则 abort
   临时树、恢复 main、阶段 `failed`。internal 会话的权限策略：只对 cwd 内的
   `read/edit/delete/move/search` 选 `allow_once`（没有一次性选项就拒绝），
   `execute/fetch/switch_mode/other` 一律拒绝，不写 `allow_always`，elicitation 直接 cancel。
5. `awaiting_push`：全部提交就绪，main 仍停在交付前。手机详情页显示 commit 列表与「确认推送」。
   **只有用户确认**才 `promoteAndPush`：写前再次校验 main 仍在该目标分支、HEAD 仍为 `baseSha`、
   干净、`baseSha` 是 `tempHead` 祖先 → `reset --hard tempHead` → `git push`（绝不 `--force`）。
   push 返回成功还不够：随后 fetch 并解析远端引用，必须等于 `tempHead`，否则按 `push_failed`
   处理（main 已前移时不自动回滚，留给重试 / 撤销判断）。push 失败且 main 仍安全时恢复 `baseSha`。
6. `syncing`：源 worktree 仅在 HEAD == `expectedSourceHead`、干净、无进行中时重置到新 main；
   其他 worktree 只在「干净 + 无进行中 + 是 newHead 祖先」时快进，其余跳过并记录原因
   （`skipped_dirty` / `skipped_in_progress` / `skipped_diverged` / `skipped_source_changed`）。
7. `synced` / `partial`：全部成功，或部分 worktree 跳过 / 失败；main 已推送不回滚。

**撤销**：`undoDelivery` 只允许最近一次交付。未推送：main 仍在期望 head 且干净时恢复到交付前；
已推送：要求 main/upstream 仍等于 `pushedSha`，按逆序 `git revert --no-edit`，冲突则
`revert --abort` 并失败，绝不 force push；成功后重新同步 worktree。撤销失败后记录
`failedAction:'undo'`，手机「重试」继续撤销而不是转成重新交付。

**失败原则**：任何一步失败都终止并清理；只有 main 仍在预期提交且干净时才 reset 恢复；绝不
stash、绝不 reset 有独立提交的 worktree、绝不 force push。失败详情写进记录，手机可「重试」。

**跨窗口互斥**：同一仓库同一时间只允许一个交付，三层防线：renderer 的
`SessionDeliveryService` 内存记录（同窗口 guard）、hub 的 `getDeliveryContext` /
`listActiveDeliveries` 跨窗口探测（路径身份比较，远程 authority 用字节前缀）、git 扩展的
`<common-dir>/universe-editor/delivery.lock/owner.json` 目录锁（10 分钟 TTL + 心跳 + 同 host
PID 存活判断，释放校验 token）。锁 owner 记录窗口实例 id：重启后的记录不复用持久化 token 直接
心跳，而是重新尝试 acquire（被活窗口持有时保持 busy）；owner 缺失但目录刚创建（初始化窗口期）
时视为占用中、不清理。交付期间，同 repo 源 / main worktree 的新 `sendPrompt` /
`newSession` 被拒绝（`delivery_busy`），避免 agent 在交付中途改写源树；删除源会话同样被拒绝。

**重启恢复**：`awaiting_push` 继续持有锁；`pushing` 只信远端状态——远端已是 `tempHead` 转同步，
本地 main 已是 `tempHead` 但远端没有则回到 `awaiting_push`（可再次确认推送），其余 `failed`
且不回滚；其它中间态 abort 临时树 + 恢复 main + `failed`。源会话不在 live 时按
durable id 非激活恢复，让收件箱行重新出现；恢复失败则直接失败并释放锁。

**手机投影**：会话摘要带 `delivery?`（阶段、commit 数、可否推送/重试/撤销、同步计数）与
`deliveryAvailable?`；收件箱行有 badge 与顶部汇总，详情页含 commit 列表、worktree 结果、
冲突文件与「确认推送」「重试」「打开 main worktree」「撤销本次交付」。`deliveryAvailable` 要求
会话可发起（idle、可写、有 cwd）**且**其 worktree 有未提交修改或存在 main worktree 当前分支
不存在的提交；后者由 git 扩展的只读命令 `git.agentDelivery.hasPendingWork` 判定（不 fetch，
main 落后 upstream 时以 upstream 为 base，避免把已在远端的提交算作待交付）。renderer 的
`SessionDeliveryService` 按 `authority + 规范化 cwd` 缓存探测结果（TTL 10s，失败/超时按不可
交付），探测异步进行：inbox snapshot 首帧可能暂缺该字段，随后经 `summary_changed` /
`inbox_delta` 补齐；会话回合结束与交付记录变化时强制刷新，另有 30s sweep 兜底 PC 上的手工
改动。已交付（`synced`）的行在手机上隐藏交付入口，改由详情页的「再次交付」重新走
`previewDelivery`。**协议绝不下发绝对路径**，只给 worktree 目录名；交付错误只带 `code` 与
裁剪后的 message，扩展侧 detail 不投影。交付变化经 `summary_changed` 增量与收件箱 upsert
同步到手机。

**刻意限制**：合并提交不支持；单次交付最多 200 个提交（preview 直接给 `unsupported` blocker）；
main worktree 必须存在且不在 detached HEAD，目标分支须有唯一 upstream；v1 不做自动交付、
自动 review 或分叉 worktree 自动 rebase。

## 6e. 推送会话分支（协议 v16）

交付把成果并进 main；推送只把**会话当前分支**发布到远端，保留原始提交、不碰 main，适合先备份或走
PR。入口在手机收件箱会话的长按菜单（**推送分支**），与「交付」是两条独立路径。

1. `previewPushBranch`：校验源 worktree 在分支上、会话 idle 且可写、没有同仓库交付在跑；fetch 远端后
   返回 `source`（worktree 目录名 / 分支 / HEAD / dirty 计数）与 `remote`（remote 名 / 远端分支 /
   是否存在 / ahead / behind），以及 `expectation`。blocker：`remote_diverged`（远端有本地没有的提交）、
   `nothing_to_push`、`source_in_progress`；脏工作区只是 warning（只推已有提交）。
2. `pushBranch`：客户端回传 `expectation`；扩展重新 fetch 并校验 branch / HEAD / 远端 HEAD 未移动，
   要求远端是 HEAD 的祖先（fast-forward），然后 `git push --set-upstream`（仅当分支没有 upstream）
   并 `ls-remote` 复核。**绝不 force push**；远端分叉时返回 blocker 让用户回 PC 处理。
3. 默认远端分支名 = 本地分支名；手机端输入框可改成别的名字（例如 `tasks/<name>`，避免一次性分支
   污染远端）。改名时客户端不再回传 `remoteHead`，由服务端重新判断。
4. 错误码 `push_busy` / `push_conflict` / `push_unsupported` / `push_failed`；协议只下发 worktree
   目录名与裁剪后的错误 message。

## 7. 会话附件（协议 v6）

手机输入框支持图片与文件附件。**WebSocket 只传附件 id，字节走同源 HTTP**：客户端帧上限 64KB，
base64 塞进 `sendPrompt` 会在重连重发时放大内存与耗时。

**上传 / 下载**（Bearer 设备 token，与 WS 握手同一凭据；token 不放 URL）：

| 方法           | 路径                   | 说明                                                                                                                                          |
| -------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`         | `/api/attachments`     | 原始字节 body；头 `X-Universe-Attachment-Kind: image\|file`、`X-Universe-Attachment-Name: <encodeURIComponent(name)>`；`Content-Type` 即 MIME |
| `GET` / `HEAD` | `/api/attachments/:id` | 原始字节 + `Content-Type` / `Content-Length` / `Content-Disposition: inline` / `Cache-Control: no-store`                                      |

上传返回 `MobileAttachmentUploadResult { id, kind, name, mimeType?, size, createdAt }`。错误映射：
401 `unauthorized`、400 `bad_request`、404 `attachment_not_found`、413 超过 25MB、429
`rate_limited`、500 `internal`。

**存储与生命周期**：`<userData>/mobile/attachments/<deviceId>/<attachmentId>/<sanitized-name>`。
附件是**传输缓冲区，不是会话历史**——网关启动清空整个目录；pending 1 小时、已发送（`consume`）
7 天，每 10 分钟 sweep；每设备 pending ≤ 32 个、总量 ≤ 256MB（满时拒绝新上传，不淘汰已发送
附件，避免旧缩略图随机 404）。`attachmentId` 服务端生成，文件名只用于显示与落盘且经
`sanitizeAttachmentFileName` 清洗；所有读写按 hello 认证得到的 `deviceId` 隔离，跨设备与不存在
统一 404，不泄露存在性。

**发送链路**：`sendPrompt.payload.attachmentIds`（≤8 个，其中图片 ≤5 张、单图 ≤5MB、单文件
≤25MB、单 prompt 合计 ≤50MB）→ hub 用设备身份解析 → 图片读盘转 base64（ACP `image` block），
普通文件生成 PC 本机 `file:` URI（ACP `resource_link`，与桌面 @ 文件一致）→ renderer 桥映射为
`PromptImage` / `PromptFileAttachment`。网关命令成功返回后才把附件标记 sent；网关报错 / 超时仍为
pending，手机可用同一 id 重发（幂等键保证不重复发 prompt）。

**能力门控**：`summary.imageSupported` 来自 agent handshake；为 false 时手机不产生图片附件
（照片按普通文件处理），桥层也拒绝图片。远程会话（`summary.authority` 非空）不能发文件附件（agent 读不到 PC 本地
路径），仍可发图片；桥层二次校验。`hello_ok.capabilities` 增加 `'attachments'`。

**时间线投影**：用户消息的非 text block 若带 `_meta.mobileAttachment`，投影为
`attachments: MobileMessageAttachment[]`（只下发元数据，不下发字节）；手机按 id 懒加载
`GET /api/attachments/:id` 生成 object URL 缩略图或文件卡。CSP `img-src` 因此加入 `blob:`。

**已知限制**：附件元数据只活在当前 PC 会话内存；PC 重启或会话重放后，旧消息不再有缩略图 /
文件卡（正文仍在）。附件目录随网关启动清空，不支持跨重启下载。

## 7b. 会话图片读取（协议 v12）

时间线里的**用户上传图片**仍走 `/api/attachments/:id`；v12 新增两类「本来就在 PC 会话里」的图片：
Agent 回复中的 ACP `image` block，以及 markdown 引用的 PC 工作区本地图片。它们没有附件 id，
也不该把 base64 塞进 WS，因此按需经同源 HTTP 读取：

| 方法           | 路径                                                 | 说明                                        |
| -------------- | ---------------------------------------------------- | ------------------------------------------- |
| `GET` / `HEAD` | `/api/sessions/image?windowId&localId&message&index` | 读取指定消息内第 `index` 个 ACP image block |
| `GET` / `HEAD` | `/api/sessions/file?windowId&localId&path`           | 读取会话工作区内被 markdown 引用的图片文件  |
| `GET` / `HEAD` | `/api/sessions/draft-image?windowId&localId&image`   | 读取 PC 草稿中 `image` id 对应的图片        |

这些端点都要求 Bearer 设备 token，非 `GET` / `HEAD` 返回 405；参数按严格十进制整数 / 长度上限校验，
失败 400；找不到会话、消息、文件或越界统一 404 `attachment_not_found`（不泄露路径是否存在）。
响应只允许 `image/png|jpeg|webp|gif`（SVG 明确排除），带 `Content-Type` / `Content-Length` /
`Content-Disposition: inline` / `Cache-Control: no-store`，`HEAD` 不发送 body。

**`index` 语义**：消息内所有 image block（包含 `_meta.mobileAttachment` 的手机上传图）的 0-based
序号。投影时手机上传图仍归入 `attachments`，不会重复出现；`images` 只列剩余可预览的 block，
但保留原始序号，桥按同一规则扫描定位。`data` 为空或带 `_meta['universe-editor/truncated']` 的
block 标记 `truncated: true`，手机显示占位且不发请求。单条消息最多投影 24 张，单图上限 8MB。

**路径安全**（`mobileImagePath.ts`）：相对路径以 `session.cwd` 为基准，只允许 `cwd` 与同 host 的
工作区根之下；本地会话构造 `file:`，远程会话构造 `remote-ssh://<authority>/<path>`，绝不回退本地
`file:`。拒绝 NUL、UNC（`\\` / `//`）、盘符相对路径、其他 scheme 与超长 src；带 percent 编码的
相对路径会尝试解码变体。读取前做词法越界检查，随后 `realpath` 复核（允许工作区根本身是符号链接，
按 real root 比较），再校验 `stat.isFile` 与 0 < size ≤ 16MB；MIME 以文件扩展名优先、block 声明兜底。

**CSP 与远程图片**：`img-src` 扩为 `'self' data: blob: https: http:`。markdown 的 `data:` 小图与
Agent 直接给出的 `http(s)` 外链由手机浏览器直接加载——PC 不代理远程图片（避免 SSRF），代价是手机
会向第三方地址发起请求并暴露 IP；HTTPS 页面上的 `http://` 图片还可能被混合内容策略拦截，属预期。
工作区路径不会进入 `<img src>`，必须先经 `/api/sessions/file` 换成分 blob URL。

**已知限制**：工具调用详情（`ToolCallDetail`）里的图片不在本次范围；多图画廊、保存 / 分享、
SVG 预览未提供。流式期间 `message.id` 稳定，resume 后可能重编号，正在进行的图片请求会 404，
重挂载后按新 id 重新拉取即可。

## 7c. 输入框草稿同步（协议 v17）

PC 与手机打开同一会话时，两端输入框共享一份草稿：**文本、图片、手机上传的文件、PC 的
refs/contexts**。**光标 / 选区是每个客户端自己的 UI 状态，不在 wire 上传输**。`MobileGatewayHub`
为每个 `windowId:localId` 维护一个轻量 registry，并分配单调递增的 `revision`；两端都按「最后
写入者覆盖」处理，不做字符级合并或冲突提示。

**共享文档与应用准入**

- 草稿正文由 hub 串行处理（`_enqueueDraft`）并分配 `revision`。客户端只在满足全部条件时应用远端
  正文：不是 IME 合成中、没有未发布 / 未 ack 的本端发布、本地字段自上次成功发布后未变、远端
  `revision` 高于本端已并入水位线。否则先记录，待水位线推进后再按 revision 结算。
- 应用远端文本时保存本地 selection（clamp 到新文本长度），在 React commit 后用
  `useLayoutEffect` 恢复；本地原文本为空时落到末尾。**远端 caret 不存在，任何路径都不会移动
  本端光标。**
- 自己的更新经 hub 回显时带 `clientUpdateId`：客户端只把它当 ack（推进水位线、清 pending），
  绝不回写文本。

**PC 侧（renderer）**

- `AcpPromptDraftCache` 仍是 PC 内容真身（可继续保存本地 caret）。`MobileBridgeService.startStreaming()`
  只发布 `source === 'local'` 的变更，250ms 防抖；`echo` 帧不回传。远端写入不会取消本地待发布
  定时器（那会丢掉正在输入的内容），而是进入 deferred 队列。
- `bridge.applyDraft`（hub → renderer，内部 IPC）在本地有防抖中的发布或 `awaitingLocalPublish > 0`
  时只记录 deferred；`noteDraftRevision` / `ackDraftRevision`（同样只是内部 IPC，不属于 wire
  协议）分别补全 deferred 的 revision 与推进本地已发布水位线。ack 丢失有 2s 防御超时。
- 本地删空必须按 `source:'local'` 发布；只有远端 apply 引起的保存才是 `echo`（实现用显式
  pending 标记，不做 `sameDraft(undefined, undefined)` 之类的值比较）。
- IME 合成期间缓存最新远端草稿；composition end 时仅当本地文本仍等于收到时的文本才应用。

**手机侧（PWA）**

- 客户端直接发 `draft_update`（不经 command 的请求 / 超时 / 幂等路径），payload 只允许
  `text` / `images` / `files`。hub 先调 `bridge.applyDraft` 写入 PC cache，再更新 registry 并
  fan-out；内容未变时只回发起者一个带 `clientUpdateId` 的 ack。
- `sendDraft` 返回本次 `clientUpdateId`（未连接时 `undefined`）。Composer 只在
  `draft.revision` 高于已并入水位线、且本地无未发布 / 未 ack 编辑时应用远端；方向和选区变化
  不触发发布，也不改 revision。
- 手机仍把 `{ text, caret, updatedAt }` 写到 sessionStorage（v2 key，最多 20 条 LRU；旧版纯
  文本 key 读取后自动迁移），但 caret 仅用于本机重挂载，不参与同步。
- 重连后仅当 hub 没有更新的草稿才补发本地内容。空草稿同样要发布（删光全部字符也是本地编辑）。

**hub 与快照**

- `session_snapshot.draft` 带 registry 当前草稿；订阅时先用 PC bridge 快照里的草稿播种，
  registry 优先。空草稿删除 registry 条目并广播一次空状态，避免重连后复活。
- `refs/contexts` 只活在 PC cache。投影成只读摘要随草稿下发；手机改文本时 PC 清空 refs（字符
  区间失效）、保留 contexts，文本不变时两者都保留。
- **附件**：WS 只传 id + 元数据，字节不走 WS。手机草稿里的图片 / 文件首次出现时，hub 用
  `MobileAttachmentStore.resolveForPrompt` 取字节并 `bridge.attachDraftAttachments` 物化到
  PC cache；PC 粘贴的图片经 `/api/sessions/draft-image` 给手机预览。手机发送时，本机上传的
  附件走 `attachmentIds`，草稿中已有的图片 / 文件走 `draftImageIds` / `draftFileIds`，由
  `bridge.resolveDraftAttachments` 合并进同一次 prompt。prompt 被接受后 hub 清空 registry 与
  PC cache，并广播空草稿。
- **只读 / 未订阅**：readOnly 会话拒绝 `bridge.applyDraft`，hub 丢弃该更新；未订阅的会话直接忽略。
- **收敛**：hub 按会话串行分配 revision，最后被处理的那次更新胜出。有未 ack 本地发布时远端
  更新只记录不应用；ack 到达后按 revision 决定应用还是丢弃 deferred，因此不会出现一端显示 A、
  另一端显示 B 的永久分叉。
- **敏感内容**：草稿不写日志、不进审计与推送；日志只记录长度 / revision / 附件数一类的摘要。
- **兼容**：v17 与旧 PWA 不兼容，握手会因协议版本不匹配被拒绝；升级网关后手机需刷新页面。

## 8. 配对与安全

**开关**：网关默认关闭，必须在 PC 设置页显式开启。

**二维码**：`https://<host>/pair#code=<一次性码>`。

- 一次性码放在 fragment，不进服务器日志与 Referer。
- 局域网自签证书档位附带 `&fp=<SHA-256>`（小写十六进制），与 code 同在 fragment；手机配对页
  把它格式化为大写冒号分组，仅作「期望值」参照——页面 JS 读不到实际 TLS 证书，显示值必然与二维码
  一致，不构成验证；真正的核对是用户在浏览器证书警告/详情里比对实际指纹。Tailscale 档位不附带（证书由 Tailscale 信任）。
- 一次性码 TTL 2 分钟、单次使用、限速、常量时间比较、内存只存哈希。

**设备凭据**：

- 配对成功签发每设备 token（32 字节随机）。
- token 是高熵随机值（32 字节 CSPRNG），不需要抗暴力破解的慢哈希；PC 端只存
  `SHA-256(token)`（base64url），校验时一次哈希后与记录做常量时间比较。scrypt 之类慢哈希
  只对低熵口令有意义，且会让未鉴权连接反复发 `hello` 时耗尽 CPU。
- PC 只存哈希到 `<userData>/mobile/devices.json`（权限 `0600`，当前文件版本 2；旧版记录直接丢弃），
  记录 `name` / `platform` / `createdAt` / `lastSeenAt` / `trusted?`。`trusted` 是 PC 授予的
  高风险操作开关，缺省视为 `false`；新增可选字段**不 bump `FILE_VERSION`**，否则升级会清空
  所有已配对设备。
- 手机存 IndexedDB；每次 WS 在 `hello` 帧携带 token。

**防护**：

- Host 与 Origin 校验（防 DNS rebinding）。
- 不发 CORS 通配。
- 每设备连接数上限与速率限制；`hello` 鉴权失败按 `remoteAddress` 滑动窗口限速，
  超限后的 upgrade 直接以 HTTP 429 拒绝，审计按窗口合并避免刷盘。
- 静态页与 WS 响应加 CSP 等安全头。
- 吊销立即断开所有该设备连接并发 `device_revoked`。

**高风险操作：默认禁止 + PC 逐设备受信（v9）**：唯一的策略真相仍在
`packages/mobile-protocol/src/policy.ts`（`isHighRiskPermissionOption` /
`isConfigValueAllowedOnMobile`），桥与网关共用，UI 只用投影出的 `allowedOnMobile` 隐藏。
设备默认不受信，行为与 v3 第一期一致：

| 类别                    | 判定                                                                                                                                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 权限选项                | 任何 `kind === 'allow_always'` 一律禁止；作用域化持久规则同样禁止：`allow-with-updates`、`allow-skill-exact`、`allow-skill-prefix`、`exit-plan-bypass`                                          |
| 配置值                  | 值形如 `bypasspermissions` / `bypass` / `dangerously-skip-permissions` / `agent-full-access` / `danger-full-access` / `full-access` / `full_access` 一律禁止（大小写、连字符/下划线归一后匹配） |
| 自动批准 / 自动执行策略 | 手机没有修改入口；`setConfigOption` 命中的策略值同样被上面的配置值规则拦截                                                                                                                      |

PC 可在「手机设备设置 → 已配对设备」逐台打开 **允许高风险操作**（`devices.json` 的
`trusted`）。开关默认关闭，开启时用 warning 确认，关闭立即生效；手机端无法修改自己的信任
状态。信任是**设备级**的，同一设备的所有连接一起变化。

**按连接下发**：renderer 的会话投影是每窗口共享的一份，不能直接按设备分叉。因此
`MobileBridgeService` 与 hub 的权限缓存始终保存**保守事实**（`allowedOnMobile` /
`highRisk`），只有 main 的 hub 在发送边界按连接 `trusted` 重写：

- 快照与 delta 出口（`subscribeSession` / `_sendSessionEvents`）对受信连接把命中高风险谓词且
  原本 `allowedOnMobile:false` 的权限选项、配置值改为 `true`；其余字段原样透传。
- `resolvePermission` / `setConfigOption` 路由到桥时多传 `allowHighRisk`；桥只在它为 `true`
  时跳过高风险谓词，`session_read_only`、`stale_request`、未知选项/值等校验全部保留。
- 信任变化时，hub 把该连接的非 `snapshotPending` 订阅置为 `desynced` 并发送
  `resync_required { scope:'session', reason:'trust_changed', ref }`，再由
  `device_trust_changed` 更新手机设置页的展示；手机重订阅后拿到宽化 / 收窄后的快照。
- 幂等 key 按 `deviceId` 分域，避免不同设备复用同一 `idempotencyKey` 的放行结果。

**双重校验**：

1. **桥**（`MobileBridgeService`）：会话只读回 `session_read_only`；`requestId` 不匹配回
   `stale_request`；未知选项/值回 `bad_request`；命中高风险且 `allowHighRisk !== true` 回
   `forbidden_operation`。
2. **网关**（`MobileGatewayHub`）：从 `permission_upsert` / 快照缓存每个 request 的保守
   `allowedOnMobile` 与 `highRisk`，`resolvePermission` 只路由能证明「本次确实提供过且允许」的
   选项：缓存中没有该 `requestId`（已结算/已清除，或从未下发）回 `stale_request`；缓存存在但
   该选项既未标记允许、也未被当前受信连接放宽回 `forbidden_operation`。缓存缺失不是策略拒绝
   ——手机只可能从网关自己发出的 `permission_upsert` / 快照得知 `requestId`，而网关先写缓存
   再发帧，所以缺失只可能是请求已不在等待中（见 §4 错误码）。`setConfigOption` 用同一值谓词
   再校验一次，仅受信连接跳过高风险谓词。

**审计**：`<userData>/mobile/audit.jsonl`，按大小轮转。记录
`ts` / `device` / `remoteAddress` / `action` / `result` / `detail`。所有会修改状态的命令
（`sendPrompt`、`cancelTurn`、审批/提问、配置、自动执行控制、`newSession`、重命名、关闭、删除、
fork / rewind / 侧边任务、`openSession`、`startDelivery` / `confirmDeliveryPush` /
`retryDelivery` / `undoDelivery` / `openDeliveryMainWorktree`）都记一条；设备信任开关另记
`device_trust_granted` / `device_trust_revoked`（未知设备记 `failure`）。`detail` 只含
`window=` / `local=` / `agent=` / `error=` 等
定位信息，**绝不记 prompt 正文、feedback、提问内容、消息原文、quote、token、`messageId`、
`sideTaskId` 或文件路径**。只读命令（`getToolCallDetail` / `listWorkspaces` / `listAgents` /
`previewRewind` / `listSideTasks` / `listSessionHistory`）不审计。

**PC 设置页**：新增 Mobile Devices 编辑器。

- 注册方式照统一 AI/Agent 设置编辑器的做法：输入 `apps/editor/src/renderer/services/editor/AiSettingsEditorInput.ts`，
  在 `apps/editor/src/renderer/contributions/BuiltInEditorProvidersContribution.ts` 里用
  `registerEditorWithComponent` 注册；动作照
  `apps/editor/src/renderer/actions/agentSettingsActions.ts` 的 `OpenAgentSettingsAction`。
- 内容：开关、监听模式、二维码、设备列表 / 吊销、能力状态（可安装 / 可推送）、最近审计、通知开关。
- 本机浏览器体验入口：网关运行中时状态区提供「在电脑浏览器中打开手机版」，配对 active 时提供
  「在电脑浏览器中打开配对页」。两者都经 renderer 的
  `IOpenerService.open(url, { fromUserGesture: true })` → main `setWindowOpenHandler` →
  `shell.openExternal`，不新增 IPC，也不改网关协议 / 鉴权。手机版入口的 origin 由
  `chooseDesktopOrigin` 选择（优先回环 HTTP，其次 `https://`，最后 `origins[0]`）；配对入口直接
  使用当前选中的 `pairing.selectedUrl`，一次性码仍保留在 fragment。WSLg 下
  `shell.openExternal` 不保证拉起 Windows 浏览器，UI 与用户文档保留手动打开地址的兜底。
  **配置持久化（机器本地）**：`enabled` / `bind` / `lanAddress` / `port` / `allowedHosts` /
  `certificateMode` / `vapidSubject` / `sessionHistoryWorkspaceLimit` 存 `<userData>/mobile/gateway.json`
  （`0600`、原子写入），**不进
  `settings.json`、不跟随 configDir 重定位**，因此多台机器共享 configDir 时各自独立。旧
  `settings.json` 里的 `mobileGateway.*` 不读取、不迁移、不清理——做一次性迁移会把 A 机器的值带给首次
  运行的 B 机器，正是要避免的事。main 独占读写，renderer 经 `IMobileGatewayService` 的 `getConfig` /
  `updateConfig` / `onDidChangeConfig`；`UNIVERSE_MOBILE_*` 环境变量仍优先于文件。

| 场景                       | 行为                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- |
| 文件缺失                   | 默认配置（网关关闭）；启动不创建文件，执行「打开网关配置 (JSON)」或首次保存时才创建 |
| 空文件                     | 等价于默认配置                                                                      |
| 启动时 JSON / 已知字段非法 | 默认配置 + `error`（网关保持关闭），设置页显示原因                                  |
| 运行中外部编辑非法         | 保留上一次有效配置并广播 `error`；文件被删除则回到默认关闭                          |
| 未知字段                   | 忽略（便于降级回旧版本）；已知字段类型 / 范围非法则整体拒绝                         |

文件是嵌套 camelCase，支持 JSONC 注释与尾逗号；保存时整文件重写，不保留注释。补全与校验的
JSON schema 由 `MobileGatewayConfigurationContribution` 按 `getConfigFileUri()` 注册。
`sessionHistoryWorkspaceLimit` 控制手机会话目录读取多少个最近打开但当前关闭的工作区（默认 20，
1–100；已打开窗口不占名额）；调大意味着更多本地历史文件读取，目录刷新会更慢。

## 9. 传输档位与证书

| 档位              | 监听                                                                             | 证书                                                                                                   | 能力                                                       |
| ----------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| Tailscale（主推） | 网关只监听 `127.0.0.1` HTTP；由 `tailscale serve` 暴露 `https://<机器名>.ts.net` | Tailscale 自动签发与续期                                                                               | 安装 + SW + Web Push + 麦克风；iOS / Android 都完整        |
| 局域网            | 监听用户选定网卡 IP（非 `0.0.0.0` 默认），`https.createServer`                   | 默认自签叶证书；可选 `root-ca`（根证书 + 叶证书），SAN 含当前 LAN IP + PC 主机名，SHA-256 指纹进二维码 | 保证遥控 + 加密；安装 / 推送需手机信任证书，iOS 推送不保证 |
| 开发 / e2e        | `127.0.0.1` HTTP；或显式 `UNIVERSE_MOBILE_INSECURE=1` 的局域网明文               | 无                                                                                                     | localhost 是安全上下文，SW 可用，无推送                    |

**局域网证书（M5，两种模式）**：

- `certificateMode = 'self-signed'`（默认）：单张自签叶证书，存
  `<userData>/mobile/tls/{cert.pem,key.pem}`（`0600`，原子写入）。Node 内置 `crypto` 只能解析
  X.509、不能签发，因此用 `selfsigned`（v5，基于 WebCrypto / `@peculiar/x509`，无 native addon；
  见 catalog）。私钥为 EC P-256，签名 SHA-256。
- `certificateMode = 'root-ca'`：同目录增加 `ca-cert.pem` / `ca-key.pem`（`0600`）。根证书为
  EC P-256、`cA:true`、`keyCertSign`/`cRLSign`、`pathLenConstraint:0`、有效期 10 年；叶证书由该
  根签发（365 天）。根在有效期内复用，叶按地址 / 到期续签，续签不改变手机已安装的信任锚。切回
  `self-signed` 时检测到叶证书的签发者不是自身会重新签发；反向切换同理，因此旧模式的叶证书不会
  被另一模式复用。
- SAN = 当前监听地址 + `os.hostname()`（规范化小写、去尾点）；如果 `gateway.json` 的 `lanAddress`
  或 `UNIVERSE_MOBILE_LAN_ADDRESS` 改变，下次启动重新签发。
- 有效期 365 天；剩余不足 30 天时自动续签。证书与私钥不匹配、文件损坏或读不出时同样重签。CA
  文件损坏 / 与私钥不匹配 / 过期时重建根证书（此时手机需重新安装）。
- 指纹是 DER 证书的 SHA-256（小写十六进制）。`MobileGatewayStatus.certificate` 携带
  `{ fingerprint, addresses, expiresAt, caFingerprint?, caExpiresAt? }`；`fingerprint` 始终是叶证书，
  `caFingerprint` 仅在 root-ca 模式存在。PC 设置页分别展示两者，配对 URL 的 `fp` 仍是叶证书。
- root-ca 模式额外暴露 `GET|HEAD /api/cert`：返回根证书 DER
  （`application/x-x509-ca-cert`、`Content-Disposition: attachment`、`no-store`），无鉴权但照常
  走 Host/Origin 校验；非 root-ca 或非 TLS 时返回 404。根私钥绝不进入状态、日志或 HTTP。
  手机侧在连接诊断的「已到达 PC，但 WebSocket 握手失败」分支给出下载链接与 iOS / Android 安装步骤。
- `capabilities.installable/push` 只认 `allowedHosts` 提供的受信任 HTTPS 源；局域网源不算——
  即使 root-ca 模式下手机已安装根证书，PC 也无法探测该信任状态。
- 生产构建允许局域网档 HTTPS；仍拒绝非回环明文 HTTP。开发调试可设
  `UNIVERSE_MOBILE_INSECURE=1` 退回明文（状态与 UI 显示警告），打包版忽略该值并报错。

**主机名 Host 白名单**：局域网 + TLS 时，`os.hostname()` 会同时进入证书 SAN 与 Host 白名单。
白名单只加 `<hostname>:<port>`（`buildAllowedHosts` 的 `localHostnames`），**不加裸主机名**：
裸主机名属于 Tailscale Serve 的 443 语义，只能由 `allowedHosts` 显式配置。`buildOrigins` 在 IP
源之后追加 `https://<hostname>:<port>`，因此配对二维码默认仍是 IP；主机名可能解析到
Tailscale/WSL 等多个地址，PC 设置页会把它标为 iOS 可选备用地址并给出警告。

**连接可观测性与诊断**：

- `GET|HEAD /api/health`（无鉴权、Host/Origin 校验、`no-store`）返回
  `{ status: 'ok', serverVersion, protocolVersion }`，供手机在 WS 失败时区分「没到 PC」与
  「到了 PC 但 TLS/WS 被拒」。不 bump `MOBILE_PROTOCOL_VERSION`（无 wire 帧变化）。
- HTTPS server 监听 `tlsClientError`，升级拒绝路径（Host/Origin/path/连接数/限流）统一审计
  `tls_handshake_failed` / `upgrade_rejected`；同一 remote + 原因 60 秒内只写一条审计，其余降为
  debug 日志，避免重试刷盘。`detail` 截断到 240 字符（TLS 错误可能带证书链）。
- `onDiagnostic` 把审计事件回传给 `MobileGatewayMainService`；证书拒绝（`certificate_unknown` /
  alert 46）且来源不是本机时，`MobileGatewayStatus.tlsTrustWarning` 带上时间与来源，设置页显示
  「手机未信任当前证书」及处理建议。**这一层失败没有 HTTP 请求，只有 PC 侧能看到**；手机可能被
  旧缓存页面困住，永远显示「离线」。
- 手机 `MobileSocket` 暴露 `onReconnectAttempt`（`hello_ok` 归零）与 `retryNow()`；`MobileClient`
  在第 3 次连续重连后探测 `/api/health`（最小间隔 15s，成功连接即清空），并暴露
  `retryConnection()` / `retryDiagnosis()`。探测结果是 HTTP 层分类（`ok` / `forbidden` /
  `not-found` / `http-error` / `invalid-response` / `network-error` / `protocol-mismatch`），UI 据此
  给出可执行提示。迟到的探测结果用连接代际号丢弃，避免重连成功后又被旧结果覆盖。
  `network-error` 同时覆盖「离线」与「TLS 在 HTTP 之前被拒」两种情况，文案提示清除网站数据 /
  无痕窗口 / 根证书模式。

**WSL2**：

- WSL2 默认 NAT，Windows 侧访问不到 WSL 内的局域网监听地址。要么在 Windows 上
  `netsh interface portproxy` 转发到 WSL IP（并放行防火墙），要么改用 mirrored 网络模式。
- 推荐 Tailscale 与 Electron 都装在 Windows 宿主；WSL 内开发时同样需要 portproxy / mirrored。
- 证书 SAN 只含 WSL 内看到的地址；通过 portproxy 访问时手机连接的是 Windows 地址，需把
  `gateway.json` 的 `lanAddress` 设为该地址并确认证书 SAN 覆盖它（否则浏览器报名称不匹配）。
- e2e 环境约束见 [wsl-e2e.md](wsl-e2e.md)。

**Tailscale 注意事项**：

- `*.ts.net` 主机名会进入公开 CT 日志。
- Tailscale Serve 有 WS 空闲断连 / query 问题的报告，因此必须做心跳与自动重连，token 走首帧而非 query。
- 若 Serve 不稳定，备选 `tailscale cert` + 网关自管 HTTPS；该证书**不会自动续期**，需要定时续期任务。

**局域网档注意事项**：

- `lanAddress` 留空时按「私网地址优先、物理网卡优先」排序，`169.254.0.0/16` 链路本地地址直接排除
  （Windows 会给未拿到 DHCP 租约的虚拟网卡/断开的 VPN 分配它）；候选列表随
  `MobileGatewayStatus.lanAddresses` 下发，设置页的地址下拉由它渲染。
- Windows 首次监听非回环地址会弹防火墙授权。
- iOS 有本地网络隐私提示；自签证书还需在系统里接受/信任，否则 Service Worker 与推送不可用。
- iOS 26 对裸 IP 的 `ws` 有失败报告：局域网 + TLS 时配对页额外提供 `<hostname>:<port>` 源，并可选用
  `root-ca` 模式安装受信任根证书；若手机无法解析主机名，IP 仍是默认源。失败时以手机诊断卡 +
  PC 侧 `tls_handshake_failed` / `upgrade_rejected` 审计判断卡在 TCP、TLS 还是 WS。

## 10. 通知

**公共信号**：抽出 `AgentAttentionSignal`，取值
`permission` / `question` / `completed` / `errored`，其中 `completed` 带 250ms 防抖
（对齐 `AgentNotificationContribution.ts` 的 `COMPLETION_ANNOUNCE_DELAY_MS`）。
桌面通知与手机桥共用同一信号，保证两端边沿一致。

**投递**：

| 场景                                     | 通道              |
| ---------------------------------------- | ----------------- |
| 手机有前台连接（`client_state visible`） | WS `notification` |
| 手机无前台连接                           | Web Push（VAPID） |

- 网关只对「通知开关打开且 kind 未被过滤」的设备发送；`kinds` 缺省表示四类全收。
- 有前台连接时优先走 WS；发送失败或无前台连接时回落到 Web Push。
- VAPID 密钥对存 `<userData>/mobile/vapid.json`（`0600`，原子写入），依赖 `web-push`；
  `gateway.json` 的 `vapidSubject` 缺省 `https://universe-editor.example.com`（须为 `mailto:` 或 `https:`）。
- 推送 TTL 1 小时；`permission` / `question` 用 `urgency: high`，其余 `normal`；载荷上限 4KB。
- 推送载荷只有 `{ id, kind, title, body, url, tag, at }`：标题 = 会话标题（缺失时 Agent 名），
  正文 = 固定的中文类别（`等待审批：<工具标题>` / `Agent 提问` / `已完成` / `出错`）。
  **绝不携带 prompt、工具输出或用户反馈**。
- endpoint 只接受 HTTPS 且主机命中已知推送服务允许列表（`fcm.googleapis.com`、
  `web.push.apple.com`、`*.push.apple.com`、`*.notify.windows.com` 等），否则回
  `server_error{bad_request}`；审计只记录主机名，不记录带能力 token 的完整 endpoint。
- 推送返回 404 / 410 时删除该设备的订阅；其他失败只记日志，不向调用方抛出。
- `push_subscribe` / `push_unsubscribe` 写审计；逐条推送不写审计。

**限制**：

- 推送经 Apple / FCM，PC 需能访问公网。
- iOS 需 16.4+、添加到主屏幕、由用户手势授权通知；iOS 不使用通知 action 按钮。
- SW 不能在后台保持 WS；后台只能靠推送。
- 载荷约 4KB，不允许静默推送。

**抑制矩阵**：

| 设备通知开关 | kind 命中 | PC 有窗口聚焦 | `alwaysNotify` | 结果                         |
| ------------ | --------- | ------------- | -------------- | ---------------------------- |
| 关           | —         | —             | —              | 不发                         |
| 开           | 否        | —             | —              | 不发                         |
| 开           | 是        | 是            | 否             | 不发                         |
| 开           | 是        | 是            | 是             | 发（前台 WS 优先，否则推送） |
| 开           | 是        | 否            | —              | 发（前台 WS 优先，否则推送） |

`notifications.enabled=false` 的设备不会让 renderer 进入 attention-only 模式；只要至少一台设备
打开通知，hub 就在没有收件箱订阅者时也保持 `startAttention()`。带 `autoResolve` 的审批不发通知
（见 §5）。

**深链**：`/s/<durableId || windowId:localId>`；审批类附加 `?focus=pending`，打开会话后定位到底部
待处理卡片。SW 收到 `notificationclick` 时优先 `focus()` 现有窗口并 `postMessage`
（`{ type:'mobile-navigate', url }`），否则 `openWindow`。

## 11. 工程结构

**新包**

| 包                         | 内容                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `packages/mobile-protocol` | WS 消息、命令/事件 DTO、错误码、版本常量；运行时零依赖        |
| `packages/acp-view-model`  | 纯逻辑：`ansi`、diff、文件路径链接、markdown 渲染、内容上限等 |

**M2 已抽取 `packages/acp-view-model`**（运行时零依赖，SDK 仅 `import type`）：

| 模块               | 来源                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `ansi`             | `apps/editor/src/renderer/services/acp/ansi.ts`                        |
| `filePathLink`     | `apps/editor/src/renderer/services/acp/filePathLink.ts`                |
| `markdownRenderer` | `apps/editor/src/renderer/services/acp/markdownRenderer.ts`            |
| `contentLimits`    | `apps/editor/src/renderer/services/acp/session/acpContentLimits.ts`    |
| `terminalOutput`   | 从 `session/acpSessionUpdateMeta.ts` 拆出的纯函数 `readTerminalOutput` |
| `lineDiff`         | `apps/editor/src/renderer/workbench/agents/lineDiff.ts`                |

editor 原位置保留 re-export，import 不变。`acpSessionUpdateMeta` 其余函数仍留在 editor：
它们依赖 `DiffHunk`、`AcpModelCost`、`parseMcpToolName` 等编辑器模型类型，不属于纯 view-model。
`acpSessionModel` 的类型拆分仍留到第二期；M2 用映射函数 + 编译期检查防漂移。

**新应用 `apps/mobile`**：Vite + React，自带 `manifest` 与 `sw`。

**首屏主题**：网关 CSP 是 `default-src 'self'`，`index.html` 不能内联脚本。主题偏好在
`apps/mobile/public/theme-boot.js`（同源外部同步脚本）里于首帧前读取 localStorage 并写入
`<html data-theme>` / `meta[theme-color]`；`src/theme.ts` 负责后续切换与系统监听。该文件被
`sw.js` 预缓存（修改其内容必须 bump `CACHE_NAME`），并由网关按 `no-cache` 提供。主题、会话
显示与会话操作确认偏好（`universe.mobile.theme` / `universe.mobile.sessionDisplay` /
`universe.mobile.sessionCloseConfirm` / `universe.mobile.sessionRemoveConfirm`）都是手机本地
localStorage，不走协议。后两个 key 的值为 `ask` / `never`，缺失时按 `ask`（需要确认）处理。

**M4 通知实现位置**：

| 位置                                                                      | 职责                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/editor/src/renderer/services/acp/session/agentAttentionSignal.ts`   | 四类边沿的共享信号（无配置依赖）                                               |
| `apps/editor/src/renderer/services/mobileGateway/MobileBridgeService.ts`  | `startStreaming` 内转发 attention；`startAttention` / `stopAttention` 轻量模式 |
| `apps/editor/src/main/services/mobileGateway/mobileNotificationRouter.ts` | 抑制矩阵、正文构造、WS / 推送抉择、4KB 限制、404/410 清理                      |
| `apps/editor/src/main/services/mobileGateway/webPushSender.ts`            | `web-push` 的可注入薄包装（测试不发网络）                                      |
| `apps/editor/src/main/services/mobileGateway/vapidKeys.ts`                | VAPID 持久化（`0600`）                                                         |
| `apps/editor/src/main/services/mobileGateway/pushEndpoint.ts`             | 推送服务主机允许列表                                                           |
| `apps/mobile/src/notifications/pushNotifications.ts`                      | 能力探测、用户手势授权、`PushManager.subscribe`                                |
| `apps/mobile/public/sw.js`                                                | `push` 展示与 `notificationclick` 深链                                         |

**Service Worker 缓存回退标记**：`sw.js` 的导航 `networkFirst` 在请求失败回退缓存时记录时间戳，
并向所有窗口广播 `mobile-shell-from-cache`；页面可用 `mobile-shell-status` 查询（`fromCache` /
`at`），`InboxPage` 据此显示「当前页面来自缓存」。这条提示解决的是「手机丢失证书信任 → 导航在
TLS 阶段失败 → SW 返回旧 shell → 页面看起来正常但永远离线，且 PC 端升级无法到达手机」的死循环。
真实案例：iPhone 的 TLS 握手被本机以 `certificate_unknown` 拒绝，浏览器清除网站数据并重新接受
证书后恢复；期间 PC 审计只有 `tls_handshake_failed`，没有 `hello`。

**机器本地配置实现位置**：

| 位置                                                                   | 职责                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `apps/editor/src/shared/ipc/mobileGatewayService.ts`                   | 配置 DTO、默认值、patch / state / result 类型与 `IMobileGatewayService` 契约 |
| `apps/editor/src/main/services/mobileGateway/gatewayConfigFile.ts`     | `gateway.json` 解析、patch 校验、合并与序列化（纯函数）                      |
| `apps/editor/src/main/services/mobileGateway/gatewayConfigStore.ts`    | 串行读写队列、原子写、`fs.watch` 外部变更与自写抑制                          |
| `apps/editor/src/main/services/mobileGateway/gatewayConfig.ts`         | 运行时解析：环境变量优先级、绑定地址、allowed origins                        |
| `apps/editor/src/renderer/contributions/MobileGatewayContributions.ts` | `gateway.json` 的 JSON schema 注册                                           |
| `apps/editor/src/renderer/actions/mobileActions.ts`                    | `workbench.action.mobile.openGatewayConfigJson`                              |

**构建与打包**（M5 已落地）：

1. `runtime:stage` 先跑 `pnpm --filter @universe-editor/mobile build`，产出 `apps/mobile/dist`
   （`apps/mobile` 用 `vite build --watch` 供开发）。`pnpm dev` / `pnpm dev:run` 启动前还会跑
   `scripts/dev/ensure-mobile-assets-build.mjs`：按输入指纹（mobile 自身 + 经 dist 解析的
   mobile-protocol / acp-view-model 源码）自检，过期时用 turbo 重建。否则 bump
   `MOBILE_PROTOCOL_VERSION` 后，网关（main 走 src alias，立即是新版）仍托管旧 PWA，
   手机握手一律 4400「版本不一致」，且刷新页面也拿不到新文件。设置了
   `UNIVERSE_MOBILE_ASSETS_DIR` 时该自检跳过（自定义资源目录由使用者负责）。
2. `scripts/release/runtime-resources.mjs` 将其 stage 到 `.runtime-resources/mobile`，
   `REQUIRED_SOURCE_FILES` 以 `mobile/index.html` 为哨兵；缺失时 `verify-source` /
   `verify-packaged` 直接失败。
3. `apps/editor/electron-builder.yml` 的 `extraResources`（`.runtime-resources` → `.`）带入
   `resources/mobile`。
4. 生产从 `process.resourcesPath/mobile` 托管；开发从 `apps/mobile/dist`；
   `UNIVERSE_MOBILE_ASSETS_DIR` 覆盖两者。
5. `apps/editor/e2e/fixtures/mobileAppTls.ts` 用 `UNIVERSE_MOBILE_BIND=lan` +
   `UNIVERSE_MOBILE_PORT=0` 在回环地址上验证自签 HTTPS、证书状态与 WSS 配对链路。

**样式**：`packages/workbench-ui` 的原子组件目前经 `Spinner` 传递依赖 `@universe-editor/platform`，
直接引主入口或 `./atoms` 都会把编辑器内核带进 PWA。M1 手机侧自写少量控件（按钮 / 输入 / 加载态）
并使用自带 `mobile.css`（触控目标 44px、正文 15–16px），**不改桌面 token**；待 atoms 剥离 platform
依赖后再评估复用。

**环境变量**

| 变量                          | 作用                                          |
| ----------------------------- | --------------------------------------------- |
| `UNIVERSE_MOBILE_GATEWAY`     | 强制开启网关（开发/测试）                     |
| `UNIVERSE_MOBILE_PORT`        | 监听端口                                      |
| `UNIVERSE_MOBILE_BIND`        | 绑定地址                                      |
| `UNIVERSE_MOBILE_LAN_ADDRESS` | 局域网档绑定/证书地址（测试与开发；覆盖设置） |
| `UNIVERSE_MOBILE_INSECURE`    | 允许非回环明文 HTTP（开发专用；打包版拒绝）   |
| `UNIVERSE_MOBILE_ASSETS_DIR`  | 覆盖静态资源目录                              |
| `UNIVERSE_MOBILE_E2E_CODE`    | e2e 用固定一次性码                            |

`UNIVERSE_MOBILE_PORT=0` 仅从环境变量接受（测试用临时端口）；设置文件里的端口仍要求 1–65535。

**加固（M5）**：

- CSP 加 `base-uri 'self'` / `form-action 'self'` / `frame-ancestors 'none'`；补
  `X-Frame-Options: DENY`；HTTPS 档位加 `Strict-Transport-Security`。
- 页面上限复用协议常量：客户端帧 64KB、服务端帧 1MB、会话出站队列 1MB、prompt 32KB。
- 连接上限：每设备 4 条、全局 64 条；配对设备上限 32 台；配对码同时只有一个、2 分钟过期、
  每 IP 每分钟 5 次尝试、连续 10 次失败作废。
- 审计 `audit.jsonl` 按大小轮转，保留 3 份历史（`audit.jsonl.1..3`），读取时按旧→新拼接。

**测试**：

- `apps/mobile`：Playwright 移动视口，对假网关测 UI；推送能力 / SW handler 用 happy-dom + `node:vm` 假 `self`。
- `apps/editor` e2e：冷启动 Electron + 第二个移动视口 context，走通
  配对 → 收件箱 → prompt → 审批全链路；前台通知用例经第二条同设备 WS 打开通知偏好，断言
  `notification` 帧落到 toast 并可跳转。**Web Push 不在 e2e 覆盖**（headless Chromium 无可用推送服务），
  由 `mobileNotificationRouter` / `webPushSender` / `vapidKeys` 单测兜底。
- 局域网 HTTPS：`mobile.gateway.spec.ts` 的 TLS 用例用独立冷启 fixture（`mobileAppTls.ts`）验证
  `https` 源、证书指纹、HSTS、配对与 WSS 收件箱；证书续签判定、指纹、审计轮转、设备/连接上限
  由单测覆盖。
- 冒烟：`@p0` 覆盖网关启动、原生 WS「配对 → hello → 收件箱快照」与手机 PWA 配对路径，纳入
  `pnpm e2e:smoke`。
- 协议负向测试：未授权、超长帧、坏 JSON、越权命令、非允许列表的 push endpoint。
- 附件：`mobileAttachmentStore` / `attachmentNames` / 网关 HTTP API 单测覆盖配额、TTL、设备隔离、
  越权与 413；`mobile.gateway.spec.ts` 的 `@p0` 用例从手机 UI 上传图片 + 文件，断言 PC 收到
  image / resource_link block 且手机时间线出现缩略图与文件卡。
- 会话图片：`mobileImagePath` 纯函数单测覆盖相对 / 绝对 / `file:` / UNC / 越界 / remote-ssh 映射；
  `MobileBridgeService` 覆盖 image ordinal、mobileAttachment 跳过、truncated、MIME 白名单、realpath
  与符号链接根；网关 HTTP 单测覆盖鉴权、参数校验、HEAD、响应头与 CSP；`mobile.gateway.spec.ts`
  另断言用户附件缩略图与 Agent ACP / markdown `data:` 图片都能打开全屏预览（含滚动锁与关闭）。
- 交付：`extensions/git/src/__tests__/deliveryGit.test.ts` 用真实 git + bare remote 覆盖 inspect /
  ff-only / 分叉 / 脏树 / 临时 worktree / 空提交 / 合并提交 / 冲突 / 冲突解决的越界修改与残留
  标记 / push / sync 分桶 / undo / 锁；`sessionDeliveryService.test.ts` 覆盖 preview 期望、
  side task 失败与空消息、冲突 resolver、确认推送、撤销守卫与重启恢复；`MobileBridgeService` /
  `mobileGatewayHub` 覆盖 delivery 投影、命令路由、跨窗口 busy 与 `delivery_busy` guard；
  协议包测试覆盖 v18（含 `deleteHistorySession` payload）与四个交付错误码。

## 12. 里程碑

| 里程碑 | 内容                                                                                                                                                       | 验收                                                                                                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1     | 协议包、网关骨架、配对、设备管理、PC 设置页、手机配对页 + 空收件箱                                                                                         | 默认关闭；扫码配对成功；吊销即断；未授权被拒                                                                                                                                                 |
| M2     | 只读镜像：收件箱聚合、会话快照/增量、摘要与详情、抽 `acp-view-model`                                                                                       | 多窗口会话状态与 PC 一致；流式不卡；重连一致                                                                                                                                                 |
| M3     | 交互：prompt / 停止 / 模式模型、审批仲裁、倒计时下沉、新建会话（含自动开窗）、高风险限制、审计                                                             | 双端审批只生效一次；重连恢复卡片；tab 未开倒计时照常执行                                                                                                                                     |
| M4     | 通知：`AgentAttentionSignal`、WS 通知、Web Push、PC 焦点抑制（已落地）                                                                                     | 两端边沿一致；不重复；点击直达会话                                                                                                                                                           |
| M5     | 打包、局域网自签 HTTPS、安全加固、Tailscale / WSL 与用户文档、纳入冒烟（已落地）                                                                           | 安装包含 `resources/mobile`；`check:full` 与 `e2e:smoke` 通过                                                                                                                                |
| M6     | 会话附件：HTTP 上传/下载、设备隔离与 TTL、ACP image / resource_link、手机附件 UI 与时间线展示（已落地）                                                    | 图片与文件经手机发出后 agent 收到正确 block；时间线显示缩略图 / 文件卡；限额与越权用例覆盖                                                                                                   |
| M7     | Fork / Rewind / 侧边任务：协议 v6、非激活分叉与恢复、回退 dry-run、侧边任务列表 / 打开 / 级联删除（已落地）                                                | 手机分叉与打开侧边任务不抢 PC 焦点；回退先预览再执行；首条用户消息 / 运行中 / 能力位边界正确                                                                                                 |
| M8     | 会话目录：协议 v7、`listSessionHistory` / `openSession`、手机 `/sessions` 页（搜索 / 状态过滤 / 按天分组）、已关闭会话重新打开（已落地；v10 扩展见 M10）   | 打开历史会话不抢 PC 焦点；live 行不重复 resume；跨工作区 / 归档 / 侧边任务 / 无消息行不出现                                                                                                  |
| M9     | 受信设备：协议 v9、PC 逐设备开关、按连接宽化投影、审计与手机设置状态展示（已落地）                                                                         | 默认不受信；开启后手机可切 bypass / 持久授权；关闭后恢复 `forbidden_operation`；grant / revoke 有审计                                                                                        |
| M10    | 会话目录覆盖最近工作区：协议 v10、main 只读读盘、已打开优先去重、N 可配（默认 20）、未打开工作区点击后自动开窗恢复、远程工作区同链路、手机提示（已落地）   | 目录列出已打开 ∪ 最近 N 个关闭工作区；同 durable id 只出现一次且打开窗口优先；点未打开工作区的行会自动开窗并恢复；远程工作区可列出并在开窗失败时回 `workspace_not_open`；收件箱仍只显示 live |
| M11    | 手机交付：协议 v14、git 扩展交付原语、renderer 交付状态机与提交信息 side task、冲突 agent 解决、待推送确认、推送与 worktree 同步、撤销与重启恢复（已落地） | 干净 / 脏源交付到「待推送」；确认后 push 并同步；冲突自动解决或安全失败且 main 不动；main / 远端移动时拒绝撤销；绝对路径不下发手机                                                           |
| M12    | 手机推送分支：协议 v16、git 扩展 `inspectPushBranch` / `pushBranch`、远端分支名可改、分叉阻断、绝不 force push（已落地）                                   | 会话分支可 publish 到远端；分叉 / 已推送 / 进行中操作给出 blocker；临时分支可改名到 `tasks/...`；不改 main、不设已有 upstream                                                                |
| M13    | 手机会话目录删除：协议 v18、`deleteHistorySession`、左滑 / 长按 + 二次确认、多窗口历史镜像同删（已落地）                                                    | 打开窗口的历史行可删且 PC 标签页关闭；未打开工作区行无删除入口；删除后目录刷新不复活；live 竞态仍走既有删除守卫                                                                              |

## 13. 已确认的决策记录

日期：第 1–7 条为 **2026-11-08**，第 8–11 条为 **2026-11-09**，第 12 条为 **2026-11-10**，
第 13 条为 **2026-11-11**。

1. **局域网档接受降级**：只保证遥控 + 加密；完整 PWA / 推送能力限 Tailscale 档。
2. **手机高风险操作默认禁止**：`allow_always` / `bypass` / 自动批准策略均不可用，网关与桥双重校验；v9 起由 PC 逐设备开启「受信设备」后放开（见决策 12）。
3. **plan 自动执行倒计时下沉到 service**：接受「会话 tab 未打开也会自动执行」的行为变化，并同步测试与用户文档。
   实现见 §5：`AcpPendingPermission.autoResolve` 由 service 持有，状态 observable，PC 卡片只转发
   pause / resume / cancel。
4. **手机新建会话允许自动开窗**：窗口会被带到前台，已接受。
5. **默认值**：PC 聚焦时不发任何手机通知；远程会话可镜像；手机新建会话与本地一致，可自动打开最近列表里的远程工作区（远程连接异步建立）；详情按需拉取。
6. **协议 v3 的幂等与超时**：会修改状态的命令支持 `idempotencyKey`（结果缓存 5 分钟、并发去重）；
   网关按命令设 5s / 10s / 30s 三档超时，超时回 `internal`，不让一次坏调用挂住连接。
7. **局域网档用自签 HTTPS + 指纹核对**：证书由网关本地签发（`selfsigned` 5.x，基于 WebCrypto），
   有效期 365 天、剩余 30 天或 SAN/IP 变化时轮换，存 `userData/mobile/tls`（`0600`）；
   完整 PWA 安装与推送仍限 Tailscale 档，自签证书下 SW 不可用属预期。
8. **网关配置存机器本地**：六个 `mobileGateway.*` 键迁到 `<userData>/mobile/gateway.json`，
   `settings.json` 旧键不再读取、不迁移、不清理。原因是 configDir 常被重定位到云盘做多机共享，
   机器相关配置会互相覆盖；不一次性迁移，避免把 A 机器的值带到首次运行的 B 机器。文件非法时
   启动用默认值、运行中保留上一次有效配置，并在设置页显示错误。
9. **会话附件走 HTTP、只传 id**：避免 64KB 客户端帧上限与重连重发大帧；附件按设备隔离存
   PC 临时目录，网关启动清空，pending 1 小时 / sent 7 天。图片走 ACP `image`，普通文件走
   `resource_link`（PC 本机 `file:` URI）；远程会话不能发文件。时间线只下发附件元数据，手机按 id
   懒加载。
10. **手机 fork / rewind / 侧边任务的边界**：协议 v6 同时纳入这批能力（旧 PWA 以 4400 断开，
    需刷新页面）；手机 fork 与打开侧边任务一律 `activate:false`，不抢 PC 焦点；rewind 原文只回填
    手机输入框，不写 PC 的 `AcpPromptReplaceInbox`；回退先 dry-run 预览，再给「丢弃 / 保留文件改动」
    两个执行按钮；侧边任务列表包含历史行，删除级联子树。
11. **会话目录覆盖最近工作区（v10，2026-11-10 修订）**：历史服务是 workspace-scoped，但每个
    工作区的历史会独立落盘。网关在读取已打开窗口（renderer 内存镜像）之外，再由 main 只读读取
    最近打开工作区中未被窗口覆盖的前 N 个（`sessionHistoryWorkspaceLimit`，默认 20），按 durable id
    去重且已打开优先。未打开工作区的行带 `folder`；打开时复用 `newSession` 的开窗流程先开窗，等
    新窗口的 workspace 历史桶加载（轮询 `hasSessionHistory`）后再
    `resumeSession(..., { activate:false })`，不抢 PC 会话焦点（开窗本身会带到前台，与决策 4 一致）。
    payload 缺 `folder` 时（深链 / 刷新）按 durable id 在前 N 个关闭工作区的落盘历史中反查。
    远程工作区沿用同一链路，开窗失败回 `workspace_not_open`。落盘有 100ms 防抖，目录可能短暂滞后，
    已打开窗口不受影响。收件箱仍只显示 live 会话。
12. **受信设备是 PC 独占的逐设备开关**：配对照样只证明「连过」，不自动授予高风险能力；默认
    关闭，开启需 warning 确认，关闭立即生效。信任状态只存 main 的 `devices.json` 并在 hub
    按连接宽化投影，手机不能自我提权。共享的 renderer 会话投影保持保守，避免同一会话被多台
    设备查看时互相污染；信任变化用 `resync_required{reason:'trust_changed'}` 让手机重拉快照，
    而不是在客户端自行推导。`devices.json` 新增可选 `trusted` 不 bump `FILE_VERSION`，防止
    升级清空已配对设备。撤销对之后到达的命令立即生效；撤销瞬间已进入桥的在途命令可能完成，
    属于毫秒级窗口并接受。
13. **交付只在手机手动确认，main 直到推送前不动**：preview → start 先把提交 cherry-pick 到临时
    detached worktree，冲突由 internal agent 解决（最多 1 次）；只有用户点「确认推送」才
    `reset --hard` main 并 push。提交信息由基于原会话的只读 side task 生成，失败即终止（不落
    固定文案）；绝不 force push / stash / reset 有独立提交的 worktree。跨窗口用 renderer 记录 +
    hub 探测 + git 目录锁三层互斥；交付期间拒绝同 worktree 的新 prompt / newSession。

形态层决策：采用 PWA；传输先做局域网 + Tailscale；镜像已打开编辑器窗口中的会话（编辑器需开着）；
第一期范围即 §1。

## 14. 风险

| 风险                                      | 影响                           | 缓解                                                                                                             |
| ----------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 协议与 view-model 漂移                    | 字段静默错位                   | DTO 单一来源 + 映射函数 + 编译期检查；详情按需接口收窄面                                                         |
| 协议 v7–v10 硬切换                        | 未更新的 PWA 连不上（4400）    | 客户端显示「版本不一致，请刷新页面」；文档提示刷新或重新打开已安装 PWA                                           |
| renderer 重载与会话 rekey                 | 连接指向旧会话/旧 epoch        | 网关按 windowId + renderer epoch 失效桥；客户端靠快照恢复                                                        |
| IPC 帧成本                                | 大内容卡顿/超限                | 50ms 合帧、<1MB 单帧、队列超限 `resync_required`                                                                 |
| 无手机订阅时空转                          | 常驻开销                       | 按订阅启停，无订阅不序列化                                                                                       |
| 权限 Promise 生命周期                     | 审批悬挂或重复结算             | settled 守卫 + `requestId` + 广播 `cleared`                                                                      |
| Tailscale Serve 的 WS 稳定性              | 断连、丢消息                   | 心跳、首帧 token、自动重连、先快照后增量；备选自管 HTTPS                                                         |
| 自签证书在 iOS 上的限制                   | 无法安装 PWA / 推送            | 局域网档明确只保证遥控；主推 Tailscale                                                                           |
| `selfsigned` / `@peculiar/x509` 供应链    | 本地签发失败导致局域网档不可用 | 仅 main 运行时使用；固定 catalog 版本；失败回 `gateway_error` 并在 UI 显示原因；单测覆盖生成与续签               |
| 安全：DNS rebinding、token 泄漏、审计 PII | 未授权访问/隐私外泄            | Host+Origin 校验、token 只存哈希、审计脱敏、默认关闭                                                             |
| 受信设备被滥用或手机丢失                  | 任意命令执行、持久放权         | 默认关闭；开启需 PC 确认；随时关闭信任或吊销设备；grant / revoke 写审计；手机不能自我提权                        |
| 撤销信任瞬间的在途命令                    | 撤销后仍完成一次高风险操作     | hub 在 dispatch 时读取当次 trust；撤销对之后到达的命令立即生效；毫秒级窗口已接受并记录在决策 12                  |
| `web-push` 新依赖                         | 供应链与升级成本               | 仅网关侧使用，锁定版本，推送失败可降级为前台 WS 通知                                                             |
| `userData` 被外部工具整体同步             | 机器相关配置再次跨机共享       | `gateway.json` 固定在 `<userData>/mobile`、不随 configDir 迁移；文档注明该边界，需要跨机共享的设置只放 configDir |
