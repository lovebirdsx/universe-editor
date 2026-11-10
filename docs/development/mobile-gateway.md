# 手机网关（Mobile Gateway）

> 状态：**M1 已落地**（协议包、main 网关与配对、PC 设置页、手机 PWA 骨架）；
> **M2 只读镜像后端已落地**（协议 v2、每窗口会话桥、main 侧收件箱/会话聚合、`acp-view-model`
> 抽取）；**M3 交互后端已落地**（协议 v3：命令路由、审批仲裁、倒计时下沉、新建会话、高风险限制、
> 幂等与审计）；**M4 通知已落地**（协议 v4：共享 attention 信号、前台 WS 通知、Web Push / VAPID、
> PC 焦点抑制、通知偏好与深链）；**M5 打包与加固已落地**（`resources/mobile`、局域网自签
> HTTPS / 证书轮换与指纹、CSP / 审计轮转 / 连接与设备上限、Tailscale / WSL 文档与冒烟）；
> **M6 会话附件已落地**（协议 v6：图片 / 文件附件经 HTTP 上传到 PC 临时目录，图片走 ACP
> `image`、文件走 `resource_link`，时间线展示缩略图与文件卡）；**M7 Fork / Rewind / 侧边任务已落地**
> （协议 v6：非激活分叉与恢复、回退 dry-run 预览、侧边任务列表 / 打开 / 级联删除）。
> 相关阅读：远程开发见 [remote-dev.md](remote-dev.md)，WSL 下的 e2e 环境见
> [wsl-e2e.md](wsl-e2e.md)，ACP 会话层见
> [renderer/services/acp/CLAUDE.md](../../apps/editor/src/renderer/services/acp/CLAUDE.md)。

## 1. 产品定位与范围

手机是 PC 编辑器里 ACP agent 会话的**遥控器**：不跑 agent、不存会话、不做第二套 agent 运行时。
PC 编辑器关闭时手机显示离线，不接管执行。

| 维度 | 定位 |
|---|---|
| 形态 | PWA，由 PC 编辑器内置网关提供页面；手机浏览器打开后「添加到主屏幕」 |
| 数据归属 | 会话、agent 进程、工作区全部留在 PC；手机只持设备凭据与本地缓存 |
| 核心场景 | 离开工位后收到审批/提问，远程看一眼、批一下、发一句话 |
| 离线语义 | PC 编辑器不在线即整体离线，手机不做离线队列与本地执行 |

**第一期界面**

| 界面 | 内容 |
|---|---|
| 收件箱 | 按待审批 / 运行中 / 已完成 / 出错分组；显示 agent、工作区、PC 在线状态 |
| 会话页 | 摘要优先；工具调用默认折叠；diff 只读；可发 prompt、停止、切换模式与模型 |
| 审批底部卡片 | 权限请求 + elicitation；先到先得，双端只有一次生效 |
| 新建会话 | 选 agent、工作区、初始 prompt |
| 输入附件 | 会话输入框可拍照 / 选图 / 选文件；图片作为 ACP `image`，普通文件以 PC 本地 `file:` URI 交给 agent |
| 通知 | 仅「等待审批 / 提问 / 完成 / 出错」四类 |

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

| 数据 | 来源 |
|---|---|
| 会话集合与活跃会话 | `IAcpSessionService.sessions` / `activeSession` |
| 时间线、消息、工具调用 | `IAcpSession.timeline` / `messages` / `toolCalls` |
| 计划 | `IAcpSession.plan` |
| 状态与展示状态 | `status` + `computeSessionDisplayStatus`（`session/acpSessionStatus.ts`） |
| 待审批 / 待提问 | `pendingPermission` / `pendingElicitation` |
| 配置、用量、只读、路径 | `configOptions` / `usage` / `readOnly` / `cwd` / `authority` |
| 收件箱分组 | `statusBucketFor`（`session/acpSessionFilterService.ts`） |

`statusBucketFor` 已把展示状态折叠为四档，正好对应收件箱四组：
`input_needed` → 待审批，`in_progress` → 运行中，`completed` → 已完成，`failed` → 出错。

**DTO 规则**：协议 DTO 必须纯可序列化——不能携带 `resolve` / `cancel` 函数、observable、URI 类实例。
服务端在序列化前把 observable 读成值；客户端拿到的只是快照。

**增量**：

- 所有增量按 `id` 幂等 upsert；客户端重复收到同一条不产生重复行。
- 流式文本只发 `append`；当前缀不匹配（rewind、replay、终端输出头部截断）时改发 `textReplace`。
- 工具调用与消息的详情不随主列表下发，见下文「大内容裁剪」。

**节流**：

| 层级 | 节奏 | 说明 |
|---|---|---|
| 会话状态 | 已有 16ms / 64ms 批次 | 重负载流使用 64ms（`acpSession.ts` 的 `STREAM_BATCH_MS` / `STREAM_HEAVY_BATCH_MS`） |
| 桥合帧 | 约 50ms 一帧 | 重流（replay / 大量 append）放宽到约 100ms |
| 单帧体量 | < 1MB | `MAX_SERVER_FRAME_BYTES`；超限快照丢弃最早 timeline 项并标记 `truncated` |
| 出站队列 | 每连接 1MB | `ws.bufferedAmount` 超限时丢弃中间增量，回 `resync_required{scope:'session'}` |

**大内容裁剪**：

| 内容 | 主列表下发 | 详情按需 |
|---|---|---|
| 工具调用 | preview（≤1KB）+ `hasDetail` + diff 增删行数 | `getToolCallDetail`，上限复用 `acpContentLimits.ts` |
| 消息 | 正文 + `hasNonText`；`memoryTrimmed: true` 时无正文 | M2 无消息详情命令 |
| diff | 统计信息 | M2 无 diff 详情命令 |
| 附件 | 元数据（id / kind / name / size） | 手机按 id 经 HTTP 懒加载，WS 不下发 base64 |
| 已被内存裁剪的内容 | `memoryTrimmed: true` | 显示「内容已释放」，不重新拉取 |

## 4. 协议

**包位置**：新建 `packages/mobile-protocol`。运行时**零依赖**，SDK 侧只用 `import type`。

- 不放 `packages/primitives`：primitives 有零依赖红线与 URI 内核定位，塞协议会污染其职责。
- 不放 `packages/platform`：PWA 不应依赖编辑器内核，也不应把 Electron/Node 语义带进浏览器。

**版本与握手**：`MOBILE_PROTOCOL_VERSION = 8`（v2 增加会话镜像帧；v3 增加交互命令、`requestId`、
`allowedOnMobile`、`permission_cleared` 元数据与命令幂等；v4 增加 `notification` 边沿、Web Push
订阅、`client_state` 可见性与通知偏好；v5 增加工具卡的 `subagent` / `requiresUserDecision` 标记，
供手机端「仅消息」过滤对齐桌面语义；v6 增加附件（`sendPrompt.attachmentIds`、消息
`attachments`、`summary.imageSupported`、`attachment_not_found`）、fork / rewind / 侧边任务
（对应命令、agent 能力位、消息锚点与侧边任务关系字段）与 `closeSession` 命令；v7 增加会话目录
（`listSessionHistory` / `openSession`、`MobileSessionHistoryEntry` 与 `history` 能力位）；v8 增加
工作区 git 状态（`MobileWorkspaceCandidate.windowId?` / `gitDirty?`））。
WS 建立后第一帧必须是
`hello { protocolVersion, token, clientVersion, capabilities }`，服务端回
`hello_ok { ..., serverTime, capabilities, vapidPublicKey? }`；v7 起的 `hello_ok.capabilities` 为
`['inbox', 'commands', 'notifications', 'history', 'attachments']`（`attachments` 仅在附件服务可用时出现），旧客户端可以只看 `inbox`。
`vapidPublicKey` 只在网关可推送
时出现，VAPID 公钥走握手而不是额外 HTTP 端点。**token 不放 URL query**，避免进入访问日志与
Referer。

**客户端 → 服务端**

| 消息 | 作用 |
|---|---|
| `hello` | 协议版本、设备 token、客户端版本、能力 |
| `subscribe_inbox` / `unsubscribe_inbox` | 订阅或退订收件箱 |
| `subscribe_session` / `unsubscribe_session` | `{ ref, afterSeq? }`，订阅单个会话 |
| `command` | `{ requestId, kind, payload, idempotencyKey? }` |
| `push_subscribe` | `{ subscription:{endpoint,keys}, prefs? }`，注册 Web Push（端点必须命中推送服务允许列表） |
| `push_unsubscribe` | 注销本设备的 Web Push 订阅 |
| `set_notification_prefs` | `{ enabled, kinds?, alwaysNotify? }`，按设备保存通知偏好 |
| `client_state` | `{ visible }`，前台 / 后台声明；前台连接优先收 WS 通知 |
| `ping` | 心跳，服务端回 `pong` |

**命令 kind（v3 已实现）**：

| 分类 | kind | payload | 说明 |
|---|---|---|---|
| 详情 | `getToolCallDetail` | `{ ref, toolCallId }` | 工具调用详情按需拉取 |
| 会话 | `sendPrompt` | `{ ref, text, attachmentIds? }` | 空文本 + 附件合法；桥在 prompt 被接受后立即返回 |
| 会话 | `cancelTurn` | `{ ref }` | 停止当前 turn |
| 审批 | `resolvePermission` | `{ ref, requestId, optionId, feedback? }` | 高风险选项被拒 |
| 审批 | `cancelPermission` | `{ ref, requestId }` | 取消/关闭待审批卡片 |
| 审批 | `resolveElicitation` | `{ ref, requestId, action, content? }` | `accept` / `decline` / `cancel` |
| 配置 | `setConfigOption` | `{ ref, configId, value }` | `string`（select）或 `boolean` |
| 自动执行 | `pauseAutoResolve` / `resumeAutoResolve` | `{ ref, requestId }` | 暂停 / 继续 plan 倒计时 |
| 会话管理 | `newSession` | `{ agentId, workspace, initialPrompt? }` | 见 §6 |
| 会话管理 | `renameSession` | `{ ref, title }` | 会话标题 |
| 会话管理 | `closeSession` | `{ ref }` | 结束活跃会话并关闭 PC 标签页，保留历史（等价 PC 关标签页） |
| 会话管理 | `deleteSession` | `{ ref }` | 复用 PC「Delete Agent Session」的 plan → 执行链路 |
| 分叉 / 回退 | `forkSession` | `{ ref, messageId? }` | 从锚点之前或末尾创建新会话；**不激活 PC** |
| 分叉 / 回退 | `previewRewind` | `{ ref, messageId }` | 回退 dry-run：只返回文件影响，不修改会话 |
| 分叉 / 回退 | `rewindSession` | `{ ref, messageId, rewindFiles? }` | 截断到锚点之前；`rewindFiles:false` 保留文件 |
| 侧边任务 | `createSideTask` | `{ ref, quote? }` | 以父会话历史为上下文创建只读侧边任务 |
| 侧边任务 | `listSideTasks` | `{ ref }` | 直接子任务（含历史行），只读 |
| 侧边任务 | `openSideTask` | `{ ref, sideTaskId }` | 非激活恢复；历史行也可打开 |
| 侧边任务 | `deleteSideTask` | `{ ref, sideTaskId }` | 级联删除该任务及其子树（含历史行） |
| 枚举 | `listWorkspaces` | `{}` | 打开窗口 ∪ 最近工作区，带 `isOpen`；打开候选带 `windowId`，前 20 个候选尽力探测 `gitDirty`（见 §6） |
| 枚举 | `listAgents` | `{}` | 由第一个已注册窗口桥返回 |
| 会话目录 | `listSessionHistory` | `{}` | 所有已打开窗口的可恢复历史行，只读；已排除侧边任务、归档、无消息与跨工作区行 |
| 会话目录 | `openSession` | `{ durableId, windowId? }` | 按 durable id 非激活恢复历史会话；带幂等键 |

`forkSession` / `previewRewind` / `rewindSession` 的 `messageId` 是 **SDK 消息锚点**
（`AcpMessage.messageId`，仅 user 消息会有），不是本地的 `AcpMessage.id`；首条用户消息可回退、
但不可用于 fork。`forkSession` 省略 `messageId` 表示从末尾分叉。

未知 kind 仍回 `command_result { ok: false, error: 'not_supported' }`，不会导致解析错误。

**幂等**：会修改状态的命令可带 `idempotencyKey`。网关在内存中缓存首个结果 5 分钟
（`COMMAND_IDEMPOTENCY_TTL_MS`），并对同时到达的同 key 请求共享同一个 in-flight Promise；
只读命令（如 `getToolCallDetail`、`previewRewind`、`listSideTasks`、`listSessionHistory`）不缓存。客户端重试不会重复发
prompt、重复建会话或重复分叉。`forkSession` / `rewindSession` / `createSideTask` / `openSideTask` /
`deleteSideTask` / `openSession` 都按可修改状态命令处理。

**超时**：网关对每条命令设上限，避免坏桥挂死连接：`sendPrompt` 15s（附件读盘 + 桥转发），
`cancelTurn` 5s；审批、配置、自动执行、重命名、`closeSession` 10s；`deleteSession` / `newSession` /
`previewRewind` 30s；`forkSession` / `rewindSession` / `createSideTask` / `openSideTask` /
`deleteSideTask` 120s（要等 agent fork RPC 与 resume），`listSideTasks` 10s；
`listSessionHistory` 8s（逐窗口等桥就绪最多 5s + 桥读取），手机端 20s 覆盖网关最坏耗时；
`openSession` 每窗口 100s，只有 owner 立即回 `session_not_found` / `forbidden_operation` 才换下一个
owner，不会把多个 100s 串联，手机端 120s + 5s 宽限仍等得到。超时回
`command_result { ok: false, error: 'internal' }`。手机端 `sendPrompt` 同样是 15s，避免手机先超时重发。

**服务端 → 客户端**

| 消息 | 作用 |
|---|---|
| `hello_ok` | 握手成功 |
| `inbox_snapshot` / `inbox_delta` | 收件箱全量 / 增量 |
| `session_snapshot` / `session_delta` | 单会话全量 / 增量 |
| `command_result` | 按 `requestId` 返回成功或错误码 |
| `notification` | 前台通知 |
| `resync_required` | 队列溢出或 seq 缺口，客户端重拉快照 |
| `server_error` | 服务端内部错误 |
| `device_revoked` | 设备被吊销，客户端清凭据并断开 |
| `pong` | 心跳响应 |

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

- `MobileSessionSnapshot { seq, summary, timeline, plan, configOptions, usage?,
  pendingPermission?, pendingElicitation?, isReplayingHistory, truncated? }`。
- `summary` 含 `ref / agentId / agentName? / title / status / displayStatus / bucket /
  workspaceName / cwd? / authority? / readOnly / hasPendingPermission /
  hasPendingElicitation / backgroundTaskCount / imageSupported? / updatedAt`（会话最近活动时间，
  取会话历史的 `lastUsedAt`，不是快照生成时刻）；v6 增加可选
  `forkSupported / rewindSupported`（agent 能力位）与 `sideTaskOf`（父会话 durable id）/
  `sideTaskChildCount`（直接子任务数）。
- `timeline` 为判别联合：`message`（正文、`streaming`、`hasNonText`、`attachments?`；v6 对 user
  消息额外带 SDK 锚点 `messageId` 与 `canFork`）/ `toolCall`
  （`toolKind`、`status`、preview、diff 增删行数；可带 `subagent` / `requiresUserDecision`
  标记，手机端「仅消息」据此保留子 Agent、计划确认与需决策卡片）/ `notice`
  （compaction / resurrection）。`canFork` 在首条用户消息、只读会话或 agent 不支持 fork 时为
  false；`messageId` 只在 user 且非 autoRetry 时出现。
- `session_delta.events`：`message_upsert`（`textAppend` 后缀或 `textReplace` 全量）、
  `tool_call_upsert`、`timeline_item_added/removed`、`plan_snapshot`、
  `config_options_snapshot`、`summary_changed`、`permission_upsert/cleared`、
  `elicitation_upsert/cleared`。
- v3 的 `MobilePendingPermission` 带 `requestId`、每个选项带 `allowedOnMobile`，并可能带
  `autoResolve { optionId, deadlineAt?, paused }`；`permission_cleared` 带
  `{ requestId, reason, source }`，让手机区分 PC / 手机 / 自动执行与「被新请求取代」。
- `message_upsert.attachments` 缺省表示不变、`[]` 表示清空；`hasNonText` 只表示未被
  `attachments` 表达的非 text block（避免缩略图与「[包含附件]」占位重复）。
- `summary_changed` 比较时忽略 `updatedAt`，避免每次合帧都发；`usage` 只在快照下发。

**错误码**

| 错误码 | 语义 |
|---|---|
| `unauthorized` | token 缺失/无效/已吊销 |
| `forbidden_operation` | 高风险操作被策略拒绝 |
| `session_not_found` | 会话不存在或已关闭 |
| `session_read_only` | 只读预览会话不能写 |
| `stale_request` | `requestId` 已不在等待中（重复点击 / 另一端先处理） |
| `workspace_not_open` | 目标工作区没有打开窗口且不能自动开窗 |
| `not_supported` | 当前档位/版本不支持该命令 |
| `unsupported_by_agent` | 当前 agent 未声明 fork / rewind 能力 |
| `invalid_anchor` | 消息锚点不存在、已回退，或不能用于该操作（如首条用户消息用于 fork） |
| `session_busy` | 会话正在运行，fork 被拒绝 |
| `rate_limited` | 触发速率限制（含附件配额已满） |
| `attachment_not_found` | 附件不存在、已过期或属于其他设备 |
| `internal` | 未分类的服务端错误 |

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

**顺序即契约**：响应里已打开窗口在前、最近工作区随后且按 `lastOpened` 倒序。手机端只按
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

| 目标工作区状态 | 行为 |
|---|---|
| 已有匹配窗口 | ping 探活通过后调用该窗口桥的 `newSession`（覆盖 renderer reload） |
| 仅在最近列表 | `openWindowForFolder` 自动开窗（会把窗口带到前台，已接受），等 main 侧桥注册，再 ping 到 renderer 的 `MobileBridge` 通道应答后才发命令 |
| 都不在 / 等待桥超时 / ping 始终无应答 | 返回 `workspace_not_open` |

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

**远程**：已有远程会话可以镜像到手机；新建远程会话要求对应远程窗口已打开，不因手机请求而新建远程连接
（`isRemoteWorkspace`：带 authority 或 scheme 为 `remote-ssh`）。仅最近列表里的远程工作区同样回
`workspace_not_open`。

**时序**：`createSession` 同步返回；桥立即回 `{ localId, durableId? }`，初始 prompt 先入队，
客户端可以立即 `sendPrompt`，由会话保证在 ready 后按顺序投递。`listWorkspaces` 返回
`{ folder, name, authority?, isOpen }`；`listAgents` 返回 `{ id, name, isDefault }`。
新窗口的 renderer 在创建会话 / 列出 agent 前会等 `IUserSettingsSyncService.whenInitialized`
（`ConfigInitContribution` 的 hydration 是 fire-and-forget），否则自定义 `acp.agents` 可能还没进内存。

## 6b. Fork / Rewind / 侧边任务（v6）

三项能力都复用桌面 `IAcpSessionService` 的既有实现，桥只做守卫、参数归一与结果裁剪，不复制算法。

| 命令 | 关键行为 |
|---|---|
| `forkSession` | `sessions.forkSession(id, messageId, { activate:false })`；运行中回 `session_busy`；首条用户消息回 `invalid_anchor`；手机分叉不抢 PC 焦点 |
| `previewRewind` | `rewindSession(..., { dryRun:true })`；只回 `canRewind / error / filesChanged 数量 / insertions / deletions`，**不把文件路径发给手机** |
| `rewindSession` | 默认回滚文件，`rewindFiles:false` 保留文件；成功后把锚点原文放进响应 `text`，只用于手机输入框回填，**不写 PC 的 `AcpPromptReplaceInbox`** |
| `createSideTask` | `forkSideTask` 以父会话完整历史为上下文、抑制 replay 基线、强制只读；quote trim 后截到 8000 字符，标题取折叠空白后的前 60 字符 |
| `listSideTasks` | 按父会话 durable id 列直接子任务；含历史行；`live` 只表示当前窗口已 resident，不是正确性信号 |
| `openSideTask` | 历史行走 `resumeSession(id, { activate:false })`；已 resident 直接返回 ref；只允许直接子任务 |
| `deleteSideTask` | `collectSideTaskDescendants` + `deleteSideTasks` 级联删除子树（含历史行） |

**焦点**：`resumeSession` / `forkSession` 增加可选 `activate`，手机一律传 `false`。`resumeSession`
的 in-flight 去重（`_resumingBySessionId`）在 await 之后按 `wantActive` 补 `setActive`，否则手机先发起的
非激活 resume 会让 PC 后到的主动 resume 无法成为 active。

**history 初始化**：所有新命令（以及 `startStreaming` / `listSessions` / `getSnapshot`）先
`await _ensureHistory()`；`IAcpSessionHistoryService.initialize()` 失败只 warn，不阻塞 live 操作。
side task 字段与列表依赖 history，未初始化时表现为字段缺失 / 空列表。

**失败映射**：`AcpForeignWorktreeError` → `forbidden_operation`；能力位缺失 →
`unsupported_by_agent`；锚点不存在 / 非 user / autoRetry / 首条用户消息用于 fork → `invalid_anchor`；
运行中 fork → `session_busy`；其他 → `internal`（日志只记错误消息，不记 prompt / quote / 正文）。

## 6c. 会话目录与恢复（v7）

**范围**：`IAcpSessionHistoryService` 是 workspace-scoped（renderer 内存 + 落盘），网关只能读到
**当前已打开窗口**的历史；未打开工作区的历史手机不可见。不新增 main 侧历史存储，也不改变
「PC 是唯一真相」的边界。

**聚合**（`MobileGatewayHub._listSessionHistory`）：逐窗口 `_ensureWindowReady` → 桥
`listSessionHistory` → 桥内过滤侧边任务、归档、`hasMessages === false` 与
`isForeignWorkspaceSession`；hub 再按 durableId 去重（pinned 优先，否则取较新 `lastUsedAt`），
pinned / `lastUsedAt` 降序，最多 200 行，并盖上 `windowId` + `workspaceName`。空 `durableId` /
`agentId` 或时间戳非有限值的坏行直接丢弃，避免手机端整份列表校验失败。行的 `durableId`
即 `AcpSessionHistoryEntry.id`（`sessionIdOnAgent`）；首条 prompt 截到 280 字符。

**打开**（`_openSession`）：同一 durable id 的并发请求共享一个 in-flight promise；先在 inbox 与各窗口
`listSessions` 中找 live ref（命中直接返回，避免二次 resume）；未命中时优先使用请求里的 `windowId`
hint，否则扫描各窗口 `hasSessionHistory` 找 owner；按 owner 顺序 `bridge.openSession` →
`sessions.resumeSession(durableId, { activate: false })`。只有 `session_not_found` /
`forbidden_operation` 会换下一个 owner，其他错误立即返回，不把多个 resume 串成超长等待。
**不切换 PC 焦点**，也不改变 PC 当前打开的会话。

**手机**：`/sessions` 独立页把目录与 inbox live 行按 durableId 合并；live 行直接订阅，历史行才发
`openSession`。搜索、全部 / 活跃 / 已关闭过滤与按天分组都在本地完成，网关不接收查询参数。
深链 `/s/<durableId>` 落到已关闭会话时，会话页提供「重新打开」按钮（同一 durable id 原地订阅，
不新增 URL）。从目录打开的会话返回时保留搜索词、过滤条件与滚动位置。

## 7. 会话附件（协议 v6）

手机输入框支持图片与文件附件。**WebSocket 只传附件 id，字节走同源 HTTP**：客户端帧上限 64KB，
base64 塞进 `sendPrompt` 会在重连重发时放大内存与耗时。

**上传 / 下载**（Bearer 设备 token，与 WS 握手同一凭据；token 不放 URL）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/attachments` | 原始字节 body；头 `X-Universe-Attachment-Kind: image\|file`、`X-Universe-Attachment-Name: <encodeURIComponent(name)>`；`Content-Type` 即 MIME |
| `GET` / `HEAD` | `/api/attachments/:id` | 原始字节 + `Content-Type` / `Content-Length` / `Content-Disposition: inline` / `Cache-Control: no-store` |

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

**能力门控**：`summary.imageSupported` 来自 agent handshake；为 false 时手机不显示拍照 / 相册
入口，桥层也拒绝图片。远程会话（`summary.authority` 非空）不能发文件附件（agent 读不到 PC 本地
路径），仍可发图片；桥层二次校验。`hello_ok.capabilities` 增加 `'attachments'`。

**时间线投影**：用户消息的非 text block 若带 `_meta.mobileAttachment`，投影为
`attachments: MobileMessageAttachment[]`（只下发元数据，不下发字节）；手机按 id 懒加载
`GET /api/attachments/:id` 生成 object URL 缩略图或文件卡。CSP `img-src` 因此加入 `blob:`。

**已知限制**：附件元数据只活在当前 PC 会话内存；PC 重启或会话重放后，旧消息不再有缩略图 /
文件卡（正文仍在）。附件目录随网关启动清空，不支持跨重启下载。

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
  记录 `name` / `platform` / `createdAt` / `lastSeenAt`。
- 手机存 IndexedDB；每次 WS 在 `hello` 帧携带 token。

**防护**：

- Host 与 Origin 校验（防 DNS rebinding）。
- 不发 CORS 通配。
- 每设备连接数上限与速率限制；`hello` 鉴权失败按 `remoteAddress` 滑动窗口限速，
  超限后的 upgrade 直接以 HTTP 429 拒绝，审计按窗口合并避免刷盘。
- 静态页与 WS 响应加 CSP 等安全头。
- 吊销立即断开所有该设备连接并发 `device_revoked`。

**高风险操作第一期默认禁止（v3 已实现）**：唯一的策略真相在
`packages/mobile-protocol/src/policy.ts`（`isHighRiskPermissionOption` /
`isConfigValueAllowedOnMobile`），桥与网关共用，UI 只用投影出的 `allowedOnMobile` 隐藏。

| 类别 | 判定 |
|---|---|
| 权限选项 | 任何 `kind === 'allow_always'` 一律禁止；作用域化持久规则同样禁止：`allow-with-updates`、`allow-skill-exact`、`allow-skill-prefix`、`exit-plan-bypass` |
| 配置值 | 值形如 `bypasspermissions` / `bypass` / `dangerously-skip-permissions` / `agent-full-access` / `danger-full-access` / `full-access` / `full_access` 一律禁止（大小写、连字符/下划线归一后匹配） |
| 自动批准 / 自动执行策略 | 手机没有修改入口；`setConfigOption` 命中的策略值同样被上面的配置值规则拦截 |

**双重校验**：

1. **桥**（`MobileBridgeService`）：会话只读回 `session_read_only`；`requestId` 不匹配回
   `stale_request`；未知选项/值回 `bad_request`；高风险回 `forbidden_operation`。
2. **网关**（`MobileGatewayHub`）：从 `permission_upsert` / 快照缓存每个 request 的
   `allowedOnMobile`，`resolvePermission` 只路由能证明「本次确实提供过且允许」的选项：
   缓存中没有该 `requestId`（已结算/已清除，或从未下发）回 `stale_request`；缓存存在但
   该选项未标记为允许回 `forbidden_operation`。缓存缺失不是策略拒绝——手机只可能从网关
   自己发出的 `permission_upsert` / 快照得知 `requestId`，而网关先写缓存再发帧，所以缺失
   只可能是请求已不在等待中（见 §4 错误码）。`setConfigOption` 用同一值谓词再校验一次。
   第二期可在 PC 上把设备升级为「受信设备」后放开。

**审计**：`<userData>/mobile/audit.jsonl`，按大小轮转。记录
`ts` / `device` / `remoteAddress` / `action` / `result` / `detail`。所有会修改状态的命令
（`sendPrompt`、`cancelTurn`、审批/提问、配置、自动执行控制、`newSession`、重命名、关闭、删除、
fork / rewind / 侧边任务、`openSession`）都记一条；`detail` 只含 `window=` / `local=` / `agent=` / `error=` 等
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
`certificateMode` / `vapidSubject` 存 `<userData>/mobile/gateway.json`（`0600`、原子写入），**不进
`settings.json`、不跟随 configDir 重定位**，因此多台机器共享 configDir 时各自独立。旧
`settings.json` 里的 `mobileGateway.*` 不读取、不迁移、不清理——做一次性迁移会把 A 机器的值带给首次
运行的 B 机器，正是要避免的事。main 独占读写，renderer 经 `IMobileGatewayService` 的 `getConfig` /
`updateConfig` / `onDidChangeConfig`；`UNIVERSE_MOBILE_*` 环境变量仍优先于文件。

| 场景 | 行为 |
|---|---|
| 文件缺失 | 默认配置（网关关闭）；启动不创建文件，执行「打开网关配置 (JSON)」或首次保存时才创建 |
| 空文件 | 等价于默认配置 |
| 启动时 JSON / 已知字段非法 | 默认配置 + `error`（网关保持关闭），设置页显示原因 |
| 运行中外部编辑非法 | 保留上一次有效配置并广播 `error`；文件被删除则回到默认关闭 |
| 未知字段 | 忽略（便于降级回旧版本）；已知字段类型 / 范围非法则整体拒绝 |

文件是嵌套 camelCase，支持 JSONC 注释与尾逗号；保存时整文件重写，不保留注释。补全与校验的
JSON schema 由 `MobileGatewayConfigurationContribution` 按 `getConfigFileUri()` 注册。

## 9. 传输档位与证书

| 档位 | 监听 | 证书 | 能力 |
|---|---|---|---|
| Tailscale（主推） | 网关只监听 `127.0.0.1` HTTP；由 `tailscale serve` 暴露 `https://<机器名>.ts.net` | Tailscale 自动签发与续期 | 安装 + SW + Web Push + 麦克风；iOS / Android 都完整 |
| 局域网 | 监听用户选定网卡 IP（非 `0.0.0.0` 默认），`https.createServer` | 默认自签叶证书；可选 `root-ca`（根证书 + 叶证书），SAN 含当前 LAN IP + PC 主机名，SHA-256 指纹进二维码 | 保证遥控 + 加密；安装 / 推送需手机信任证书，iOS 推送不保证 |
| 开发 / e2e | `127.0.0.1` HTTP；或显式 `UNIVERSE_MOBILE_INSECURE=1` 的局域网明文 | 无 | localhost 是安全上下文，SW 可用，无推送 |

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
- 手机 `MobileSocket` 暴露 `onReconnectAttempt`（`hello_ok` 归零）与 `retryNow()`；`MobileClient`
  在第 3 次连续重连后探测 `/api/health`（最小间隔 15s，成功连接即清空），并暴露
  `retryConnection()` / `retryDiagnosis()`。探测结果是 HTTP 层分类（`ok` / `forbidden` /
  `not-found` / `http-error` / `invalid-response` / `network-error` / `protocol-mismatch`），UI 据此
  给出可执行提示。迟到的探测结果用连接代际号丢弃，避免重连成功后又被旧结果覆盖。

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

| 场景 | 通道 |
|---|---|
| 手机有前台连接（`client_state visible`） | WS `notification` |
| 手机无前台连接 | Web Push（VAPID） |

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

| 设备通知开关 | kind 命中 | PC 有窗口聚焦 | `alwaysNotify` | 结果 |
|---|---|---|---|---|
| 关 | — | — | — | 不发 |
| 开 | 否 | — | — | 不发 |
| 开 | 是 | 是 | 否 | 不发 |
| 开 | 是 | 是 | 是 | 发（前台 WS 优先，否则推送） |
| 开 | 是 | 否 | — | 发（前台 WS 优先，否则推送） |

`notifications.enabled=false` 的设备不会让 renderer 进入 attention-only 模式；只要至少一台设备
打开通知，hub 就在没有收件箱订阅者时也保持 `startAttention()`。带 `autoResolve` 的审批不发通知
（见 §5）。

**深链**：`/s/<durableId || windowId:localId>`；审批类附加 `?focus=pending`，打开会话后定位到底部
待处理卡片。SW 收到 `notificationclick` 时优先 `focus()` 现有窗口并 `postMessage`
（`{ type:'mobile-navigate', url }`），否则 `openWindow`。

## 11. 工程结构

**新包**

| 包 | 内容 |
|---|---|
| `packages/mobile-protocol` | WS 消息、命令/事件 DTO、错误码、版本常量；运行时零依赖 |
| `packages/acp-view-model` | 纯逻辑：`ansi`、diff、文件路径链接、markdown 渲染、内容上限等 |

**M2 已抽取 `packages/acp-view-model`**（运行时零依赖，SDK 仅 `import type`）：

| 模块 | 来源 |
|---|---|
| `ansi` | `apps/editor/src/renderer/services/acp/ansi.ts` |
| `filePathLink` | `apps/editor/src/renderer/services/acp/filePathLink.ts` |
| `markdownRenderer` | `apps/editor/src/renderer/services/acp/markdownRenderer.ts` |
| `contentLimits` | `apps/editor/src/renderer/services/acp/session/acpContentLimits.ts` |
| `terminalOutput` | 从 `session/acpSessionUpdateMeta.ts` 拆出的纯函数 `readTerminalOutput` |
| `lineDiff` | `apps/editor/src/renderer/workbench/agents/lineDiff.ts` |

editor 原位置保留 re-export，import 不变。`acpSessionUpdateMeta` 其余函数仍留在 editor：
它们依赖 `DiffHunk`、`AcpModelCost`、`parseMcpToolName` 等编辑器模型类型，不属于纯 view-model。
`acpSessionModel` 的类型拆分仍留到第二期；M2 用映射函数 + 编译期检查防漂移。

**新应用 `apps/mobile`**：Vite + React，自带 `manifest` 与 `sw`。

**首屏主题**：网关 CSP 是 `default-src 'self'`，`index.html` 不能内联脚本。主题偏好在
`apps/mobile/public/theme-boot.js`（同源外部同步脚本）里于首帧前读取 localStorage 并写入
`<html data-theme>` / `meta[theme-color]`；`src/theme.ts` 负责后续切换与系统监听。该文件被
`sw.js` 预缓存（修改其内容必须 bump `CACHE_NAME`），并由网关按 `no-cache` 提供。主题与
会话显示偏好（`universe.mobile.theme` / `universe.mobile.sessionDisplay`）都是手机本地
localStorage，不走协议。

**M4 通知实现位置**：

| 位置 | 职责 |
|---|---|
| `apps/editor/src/renderer/services/acp/session/agentAttentionSignal.ts` | 四类边沿的共享信号（无配置依赖） |
| `apps/editor/src/renderer/services/mobileGateway/MobileBridgeService.ts` | `startStreaming` 内转发 attention；`startAttention` / `stopAttention` 轻量模式 |
| `apps/editor/src/main/services/mobileGateway/mobileNotificationRouter.ts` | 抑制矩阵、正文构造、WS / 推送抉择、4KB 限制、404/410 清理 |
| `apps/editor/src/main/services/mobileGateway/webPushSender.ts` | `web-push` 的可注入薄包装（测试不发网络） |
| `apps/editor/src/main/services/mobileGateway/vapidKeys.ts` | VAPID 持久化（`0600`） |
| `apps/editor/src/main/services/mobileGateway/pushEndpoint.ts` | 推送服务主机允许列表 |
| `apps/mobile/src/notifications/pushNotifications.ts` | 能力探测、用户手势授权、`PushManager.subscribe` |
| `apps/mobile/public/sw.js` | `push` 展示与 `notificationclick` 深链 |

**机器本地配置实现位置**：

| 位置 | 职责 |
|---|---|
| `apps/editor/src/shared/ipc/mobileGatewayService.ts` | 配置 DTO、默认值、patch / state / result 类型与 `IMobileGatewayService` 契约 |
| `apps/editor/src/main/services/mobileGateway/gatewayConfigFile.ts` | `gateway.json` 解析、patch 校验、合并与序列化（纯函数） |
| `apps/editor/src/main/services/mobileGateway/gatewayConfigStore.ts` | 串行读写队列、原子写、`fs.watch` 外部变更与自写抑制 |
| `apps/editor/src/main/services/mobileGateway/gatewayConfig.ts` | 运行时解析：环境变量优先级、绑定地址、allowed origins |
| `apps/editor/src/renderer/contributions/MobileGatewayContributions.ts` | `gateway.json` 的 JSON schema 注册 |
| `apps/editor/src/renderer/actions/mobileActions.ts` | `workbench.action.mobile.openGatewayConfigJson` |

**构建与打包**（M5 已落地）：

1. `runtime:stage` 先跑 `pnpm --filter @universe-editor/mobile build`，产出 `apps/mobile/dist`
   （`apps/mobile` 用 `vite build --watch` 供开发）。
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

| 变量 | 作用 |
|---|---|
| `UNIVERSE_MOBILE_GATEWAY` | 强制开启网关（开发/测试） |
| `UNIVERSE_MOBILE_PORT` | 监听端口 |
| `UNIVERSE_MOBILE_BIND` | 绑定地址 |
| `UNIVERSE_MOBILE_LAN_ADDRESS` | 局域网档绑定/证书地址（测试与开发；覆盖设置） |
| `UNIVERSE_MOBILE_INSECURE` | 允许非回环明文 HTTP（开发专用；打包版拒绝） |
| `UNIVERSE_MOBILE_ASSETS_DIR` | 覆盖静态资源目录 |
| `UNIVERSE_MOBILE_E2E_CODE` | e2e 用固定一次性码 |

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

## 12. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 协议包、网关骨架、配对、设备管理、PC 设置页、手机配对页 + 空收件箱 | 默认关闭；扫码配对成功；吊销即断；未授权被拒 |
| M2 | 只读镜像：收件箱聚合、会话快照/增量、摘要与详情、抽 `acp-view-model` | 多窗口会话状态与 PC 一致；流式不卡；重连一致 |
| M3 | 交互：prompt / 停止 / 模式模型、审批仲裁、倒计时下沉、新建会话（含自动开窗）、高风险限制、审计 | 双端审批只生效一次；重连恢复卡片；tab 未开倒计时照常执行 |
| M4 | 通知：`AgentAttentionSignal`、WS 通知、Web Push、PC 焦点抑制（已落地） | 两端边沿一致；不重复；点击直达会话 |
| M5 | 打包、局域网自签 HTTPS、安全加固、Tailscale / WSL 与用户文档、纳入冒烟（已落地） | 安装包含 `resources/mobile`；`check:full` 与 `e2e:smoke` 通过 |
| M6 | 会话附件：HTTP 上传/下载、设备隔离与 TTL、ACP image / resource_link、手机附件 UI 与时间线展示（已落地） | 图片与文件经手机发出后 agent 收到正确 block；时间线显示缩略图 / 文件卡；限额与越权用例覆盖 |
| M7 | Fork / Rewind / 侧边任务：协议 v6、非激活分叉与恢复、回退 dry-run、侧边任务列表 / 打开 / 级联删除（已落地） | 手机分叉与打开侧边任务不抢 PC 焦点；回退先预览再执行；首条用户消息 / 运行中 / 能力位边界正确 |
| M8 | 会话目录：协议 v7、`listSessionHistory` / `openSession`、手机 `/sessions` 页（搜索 / 状态过滤 / 按天分组）、已关闭会话重新打开（已落地） | 仅列出已打开窗口的可恢复历史；打开历史会话不抢 PC 焦点；live 行不重复 resume；跨工作区 / 归档 / 侧边任务 / 无消息行不出现 |

## 13. 已确认的决策记录

日期：第 1–7 条为 **2026-11-08**，第 8–10 条为 **2026-11-09**。

1. **局域网档接受降级**：只保证遥控 + 加密；完整 PWA / 推送能力限 Tailscale 档。
2. **手机高风险操作第一期默认禁止**：`allow_always` / `bypass` / 自动批准策略均不可用，网关与桥双重校验。
3. **plan 自动执行倒计时下沉到 service**：接受「会话 tab 未打开也会自动执行」的行为变化，并同步测试与用户文档。
   实现见 §5：`AcpPendingPermission.autoResolve` 由 service 持有，状态 observable，PC 卡片只转发
   pause / resume / cancel。
4. **手机新建会话允许自动开窗**：窗口会被带到前台，已接受。
5. **默认值**：PC 聚焦时不发任何手机通知；远程会话可镜像、新建远程会话需远程窗口已打开；详情按需拉取。
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
11. **会话目录只覆盖已打开窗口**：历史服务是 workspace-scoped，手机不新增 main 侧历史存储；
    未打开工作区的历史不可见。打开历史会话沿用 `resumeSession(..., { activate:false })`，
    与 fork / 侧边任务一致，不抢 PC 焦点。目录与 inbox 按 durable id 在手机侧合并，live 行直接
    订阅，只有历史行才发 `openSession`，避免重复 resume。

形态层决策：采用 PWA；传输先做局域网 + Tailscale；镜像已打开编辑器窗口中的会话（编辑器需开着）；
第一期范围即 §1。

## 14. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 协议与 view-model 漂移 | 字段静默错位 | DTO 单一来源 + 映射函数 + 编译期检查；详情按需接口收窄面 |
| 协议 v7 / v8 硬切换 | 未更新的 PWA 连不上（4400） | 客户端显示「版本不一致，请刷新页面」；文档提示刷新或重新打开已安装 PWA |
| renderer 重载与会话 rekey | 连接指向旧会话/旧 epoch | 网关按 windowId + renderer epoch 失效桥；客户端靠快照恢复 |
| IPC 帧成本 | 大内容卡顿/超限 | 50ms 合帧、<1MB 单帧、队列超限 `resync_required` |
| 无手机订阅时空转 | 常驻开销 | 按订阅启停，无订阅不序列化 |
| 权限 Promise 生命周期 | 审批悬挂或重复结算 | settled 守卫 + `requestId` + 广播 `cleared` |
| Tailscale Serve 的 WS 稳定性 | 断连、丢消息 | 心跳、首帧 token、自动重连、先快照后增量；备选自管 HTTPS |
| 自签证书在 iOS 上的限制 | 无法安装 PWA / 推送 | 局域网档明确只保证遥控；主推 Tailscale |
| `selfsigned` / `@peculiar/x509` 供应链 | 本地签发失败导致局域网档不可用 | 仅 main 运行时使用；固定 catalog 版本；失败回 `gateway_error` 并在 UI 显示原因；单测覆盖生成与续签 |
| 安全：DNS rebinding、token 泄漏、审计 PII | 未授权访问/隐私外泄 | Host+Origin 校验、token 只存哈希、审计脱敏、默认关闭 |
| `web-push` 新依赖 | 供应链与升级成本 | 仅网关侧使用，锁定版本，推送失败可降级为前台 WS 通知 |
| `userData` 被外部工具整体同步 | 机器相关配置再次跨机共享 | `gateway.json` 固定在 `<userData>/mobile`、不随 configDir 迁移；文档注明该边界，需要跨机共享的设置只放 configDir |
