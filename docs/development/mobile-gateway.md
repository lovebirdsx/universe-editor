# 手机网关（Mobile Gateway）

> 状态：**设计已定稿，未实现**（定稿日期 2026-11-08）。
> 本文是实现依据，描述目标形态与已确认的取舍，不代表仓库中已有对应代码。
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
| 通知 | 仅「等待审批 / 提问 / 完成 / 出错」四类 |

**第二期**：语音输入、图片附件、多台 PC 切换、中转服务器（脱离局域网/ Tailscale）。

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
| 单帧体量 | < 1MB | IPC 帧 32MB 警告、128MB 上限（`packages/platform/src/ipc/ipcFrameGuard.ts`） |
| 出站队列 | 每连接有上限 | 超限不发快照，回 `resync_required`，让客户端重新拉取 |

**大内容裁剪**：

| 内容 | 主列表下发 | 详情按需 |
|---|---|---|
| 工具调用 | preview + `hasDetail` + diff 增删行数 | `getToolCallDetail`，上限复用 `session/acpContentLimits.ts` |
| 消息 | preview + `hasDetail` | `getMessageDetail` |
| diff | 统计信息 | `getDiffDetail` |
| 图片 | 占位符 | 第一期不下发原图 |
| 已被内存裁剪的内容 | `memoryTrimmed: true` | 显示「内容已释放」，不重新拉取 |

## 4. 协议

**包位置**：新建 `packages/mobile-protocol`。运行时**零依赖**，SDK 侧只用 `import type`。

- 不放 `packages/primitives`：primitives 有零依赖红线与 URI 内核定位，塞协议会污染其职责。
- 不放 `packages/platform`：PWA 不应依赖编辑器内核，也不应把 Electron/Node 语义带进浏览器。

**版本与握手**：`MOBILE_PROTOCOL_VERSION = 1`。WS 建立后第一帧必须是
`hello { protocolVersion, token, clientVersion, capabilities }`，服务端回
`hello_ok { ..., serverTime }`。**token 不放 URL query**，避免进入访问日志与 Referer。

**客户端 → 服务端**

| 消息 | 作用 |
|---|---|
| `hello` | 协议版本、设备 token、客户端版本、能力 |
| `subscribe_inbox` / `unsubscribe_inbox` | 订阅或退订收件箱 |
| `subscribe_session` / `unsubscribe_session` | `{ ref, afterSeq? }`，订阅单个会话 |
| `command` | `{ requestId, kind, payload, idempotencyKey? }` |
| `push_subscribe` / `push_unsubscribe` | 注册或注销 Web Push 订阅 |
| `ping` | 心跳，服务端回 `pong` |

**命令 kind**：

- 会话：`sendPrompt`（第一期仅纯文本）、`cancelTurn`
- 审批：`resolvePermission`、`cancelPermission`、`resolveElicitation`
- 配置：`setConfigOption`
- 会话管理：`newSession`、`renameSession`、`deleteSession`
- 详情：`getToolCallDetail`、`getMessageDetail`、`getDiffDetail`
- 自动执行：`pauseAutoResolve` / `resumeAutoResolve`
- 枚举：`listWorkspaces`、`listAgents`

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

- 每个 scope（收件箱 / 每个会话）各自单调递增 `seq`。
- 服务端保留环形缓冲（约 1000 条或 5 分钟，取先到者）。
- **重连一律先拉快照**，`afterSeq` 只是减少传输的优化，不是正确性前提。
- 会话 key 优先 `durableId`（`sessionIdOnAgent`）；尚未 attach 时用 `{ windowId, localId }`。
  attach 后发 `session_rekeyed`，客户端把本地状态迁移到 durable key。

**错误码**

| 错误码 | 语义 |
|---|---|
| `unauthorized` | token 缺失/无效/已吊销 |
| `forbidden_operation` | 高风险操作被策略拒绝 |
| `session_not_found` | 会话不存在或已关闭 |
| `session_read_only` | 只读预览会话不能写 |
| `stale_request` | 请求基于过期快照；审批场景按成功处理 |
| `workspace_not_open` | 目标工作区没有打开窗口且不能自动开窗 |
| `not_supported` | 当前档位/版本不支持该命令 |
| `rate_limited` | 触发速率限制 |
| `internal` | 未分类的服务端错误 |

`stale_request` 在审批场景特殊处理：客户端点的是旧卡片，但请求可能已被另一端处理。
此时按成功返回，由随后的快照/增量收敛 UI，不向用户报错。

## 5. 审批仲裁

**现状缺陷**：`onRequestPermission`（`apps/editor/src/renderer/services/acp/session/acpSessionService.ts`）
的 `resolve` / `cancel` 没有 settled 守卫；重复调用会重复触发副作用（如 `persistAllow`、telemetry）。
elicitation 侧已有 `settled` 布尔守卫，权限侧需要补齐：**首个 resolve / cancel 生效，其余 no-op**。

**DTO 变化**：

- `AcpPendingPermission` / `AcpPendingElicitation` 增加 `requestId`。
- 结算时记录来源：`pc` / `mobile` / `auto`。
- 结算后广播 `cleared { reason: selected | cancelled | superseded | auto }`。

**双端行为**：

- PC 与手机订阅同一个 observable；任一端处理后，另一端卡片自然消失。
- 手机重连靠快照恢复待审批卡片；不在内存里重放旧请求。
- renderer 重载导致的取消显示「请求已失效」，不显示为用户取消。

**已确认的行为变更：plan 自动执行倒计时下沉**：

- 现状：倒计时定时器在 `apps/editor/src/renderer/workbench/agents/PermissionCard.tsx` 组件内，
  依赖卡片挂载；会话 tab 未打开时不会自动执行。
- 目标：定时器移到 service 层持有，服务端提供 `deadlineAt` 与 `pause` / `resume`；
  PC 卡片的 hover / focus 改为调用 `pause` / `resume`。
- 后果：**会话 tab 未打开时 plan 也会按时自动执行**。这是已确认的语义修正，
  实现时需同步更新相关测试与 `docs/user/` 用户文档。

**通知抑制**：带 `autoResolve` 的审批不产生手机通知，与现有
`apps/editor/src/renderer/contributions/AgentNotificationContribution.ts` 的边沿保持一致。

## 6. 新建会话

**工作区候选**：已打开窗口（`IWindowMainService.getOpenWindowInfos`）∪ 最近工作区
（`IRecentWorkspacesService`，`apps/editor/src/main/services/workspace/recentWorkspacesMainService.ts`）。
按 canonical folder 去重，走仓库规定的路径身份比较（`IUriIdentityService` / `arePathsEqual` /
`getPathComparisonKey`），**不手写 `fsPath.toLowerCase()`**。远程工作区标记 authority。

**三种路径**：

| 目标工作区状态 | 行为 |
|---|---|
| 已有匹配窗口 | 在该窗口调用 `createSession` |
| 仅在最近列表 | `openWindowForFolder` 自动开窗（会把窗口带到前台，已接受），等桥就绪后创建 |
| 都不在 | 返回 `workspace_not_open` |

**远程**：已有远程会话可以镜像到手机；新建远程会话要求对应远程窗口已打开，不因手机请求而新建远程连接。

**时序**：`createSession` 同步返回，初始 prompt 先入队；客户端可以立即 `sendPrompt`，由桥保证在会话
ready 后按顺序投递。

## 7. 配对与安全

**开关**：网关默认关闭，必须在 PC 设置页显式开启。

**二维码**：`https://<host>/pair#<一次性码>`。

- 一次性码放在 fragment，不进服务器日志与 Referer。
- 自签证书场景附带证书指纹与 PC 名。
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

**已确认：高风险操作第一期默认禁止**：

- 手机不能选 `allow_always`；
- 手机不能切 `bypassPermissions`；
- 手机不能修改自动批准 / 自动执行策略。
- **网关与桥双重校验**，不依赖 UI 隐藏。第二期可在 PC 上把设备升级为「受信设备」后放开。

**审计**：`<userData>/mobile/audit.jsonl`，按大小轮转。记录
`ts` / `device` / `remoteAddress` / `action` / `result` / `sessionRef`；**不记 prompt 正文与 token**。

**PC 设置页**：新增 Mobile Devices 编辑器。

- 注册方式照统一 AI/Agent 设置编辑器的做法：输入 `apps/editor/src/renderer/services/editor/AiSettingsEditorInput.ts`，
  在 `apps/editor/src/renderer/contributions/BuiltInEditorProvidersContribution.ts` 里用
  `registerEditorWithComponent` 注册；动作照
  `apps/editor/src/renderer/actions/agentSettingsActions.ts` 的 `OpenAgentSettingsAction`。
- 内容：开关、监听模式、二维码、设备列表 / 吊销、能力状态（可安装 / 可推送）、最近审计、通知开关。
- 配置组：`mobileGateway.*`。

## 8. 传输档位与证书

| 档位 | 监听 | 证书 | 能力 |
|---|---|---|---|
| Tailscale（主推） | 网关只监听 `127.0.0.1` HTTP；由 `tailscale serve` 暴露 `https://<机器名>.ts.net` | Tailscale 自动签发与续期 | 安装 + SW + Web Push + 麦克风；iOS / Android 都完整 |
| 局域网 | 监听用户选定网卡 IP（非 `0.0.0.0` 默认） | 自签证书，SAN 含 IP，指纹进二维码 | 保证遥控 + 加密；安装 / 推送需手机信任 CA，iOS 推送不保证 |
| 开发 / e2e | `127.0.0.1` HTTP | 无 | localhost 是安全上下文，SW 可用，无推送 |

**Tailscale 注意事项**：

- `*.ts.net` 主机名会进入公开 CT 日志。
- Tailscale Serve 有 WS 空闲断连 / query 问题的报告，因此必须做心跳与自动重连，token 走首帧而非 query。
- 若 Serve 不稳定，备选 `tailscale cert` + 网关自管 HTTPS；该证书**不会自动续期**，需要定时续期任务。

**局域网档注意事项**：

- Windows 首次监听非回环地址会弹防火墙授权。
- iOS 有本地网络隐私提示。
- iOS 26 对裸 IP 的 `ws` 有失败报告，优先建议用主机名 + 受信任证书。

**WSL2**：推荐 Tailscale 与 Electron 都跑在 Windows 侧；在 WSL 内开发需要 portproxy 或 mirrored 网络，
e2e 环境约束见 [wsl-e2e.md](wsl-e2e.md)。

**生产防护**：不允许 HTTP 绑定非回环地址。开发需要时用
`UNIVERSE_MOBILE_INSECURE` 显式开启，并在 UI / 日志显示醒目警告。

## 9. 通知

**公共信号**：抽出 `AgentAttentionSignal`，取值
`permission` / `question` / `completed` / `errored`，其中 `completed` 带 250ms 防抖
（对齐 `AgentNotificationContribution.ts` 的 `COMPLETION_ANNOUNCE_DELAY_MS`）。
桌面通知与手机桥共用同一信号，保证两端边沿一致。

**投递**：

| 场景 | 通道 |
|---|---|
| 手机在前台 | WS `notification` |
| 手机在后台 | Web Push（VAPID） |

- VAPID 私钥存 `<userData>/mobile/vapid.json`（`0600`），依赖 `web-push`。
- 推送返回 404 / 410 时删除对应订阅。

**限制**：

- 推送经 Apple / FCM，PC 需能访问公网。
- iOS 需 16.4+、添加到主屏幕、由用户手势授权通知。
- iOS 通知不支持 action 按钮 → 点通知直达审批卡片。
- SW 不能在后台保持 WS；后台只能靠推送。
- 载荷约 4KB，不允许静默推送。

**焦点抑制**：PC 有窗口聚焦时，手机推送与前台 WS 通知都不发；每设备可单独设「始终通知」。
带 `autoResolve` 的审批不发通知（见 §5）。

**深链**：用 `durableId` + `workspace` 定位会话；不要在通知里放 renderer 本地 id。

## 10. 工程结构

**新包**

| 包 | 内容 |
|---|---|
| `packages/mobile-protocol` | WS 消息、命令/事件 DTO、错误码、版本常量；运行时零依赖 |
| `packages/acp-view-model` | 纯逻辑：`ansi`、diff、文件路径链接、markdown 渲染、内容上限等 |

`acp-view-model` 的源文件当前散落在：

- `apps/editor/src/renderer/services/acp/ansi.ts`
- `apps/editor/src/renderer/services/acp/filePathLink.ts`
- `apps/editor/src/renderer/services/acp/markdownRenderer.ts`
- `apps/editor/src/renderer/services/acp/session/acpContentLimits.ts`
- `apps/editor/src/renderer/workbench/agents/lineDiff.ts`（注意：在 `workbench/agents/`，不在 `services/acp/`）

迁移后 editor 原位置保留 re-export，避免大范围改 import。`acpSessionModel` 的类型拆分留到第二期；
第一期用映射函数 + 编译期检查（双方类型都引用同一 DTO，字段缺失/改名时 typecheck 报错）防漂移。

**新应用 `apps/mobile`**：Vite + React，自带 `manifest` 与 `sw`。

**构建与打包**：

1. `pnpm --filter mobile build` 产出 `apps/mobile/dist`。
2. `scripts/release/runtime-resources.mjs` 将其 stage 到 `.runtime-resources/mobile`。
3. `apps/editor/electron-builder.yml` 的 `extraResources`（`.runtime-resources` → `.`）带入
   `resources/mobile`。
4. 把 mobile 产物加入 `runtime-resources.mjs` 的 runtime verify 必需文件列表。
5. 生产从 `process.resourcesPath/mobile` 托管；开发从 `apps/mobile/dist` 或
   `UNIVERSE_MOBILE_ASSETS_DIR`。

**样式**：`packages/workbench-ui` 增加 `./atoms` 子路径导出（`src/atoms/`），手机只引原子组件，
避免把带 `platform` 依赖的主入口带进 PWA。手机侧自带 `mobile.css`（触控目标 44px、正文 15–16px），
**不改桌面 token**。

**环境变量**

| 变量 | 作用 |
|---|---|
| `UNIVERSE_MOBILE_GATEWAY` | 强制开启网关（开发/测试） |
| `UNIVERSE_MOBILE_PORT` | 监听端口 |
| `UNIVERSE_MOBILE_BIND` | 绑定地址 |
| `UNIVERSE_MOBILE_INSECURE` | 允许非回环 HTTP（开发专用） |
| `UNIVERSE_MOBILE_ASSETS_DIR` | 覆盖静态资源目录 |
| `UNIVERSE_MOBILE_E2E_CODE` | e2e 用固定一次性码 |

**测试**：

- `apps/mobile`：Playwright 移动视口，对假网关测 UI。
- `apps/editor` e2e：冷启动 Electron + 第二个移动视口 context，走通
  配对 → 收件箱 → prompt → 审批全链路。
- Web Push / SW handler / VAPID 用单测。
- 协议负向测试：未授权、超长帧、坏 JSON、越权命令。

## 11. 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 | 协议包、网关骨架、配对、设备管理、PC 设置页、手机配对页 + 空收件箱 | 默认关闭；扫码配对成功；吊销即断；未授权被拒 |
| M2 | 只读镜像：收件箱聚合、会话快照/增量、摘要与详情、抽 `acp-view-model` | 多窗口会话状态与 PC 一致；流式不卡；重连一致 |
| M3 | 交互：prompt / 停止 / 模式模型、审批仲裁、倒计时下沉、新建会话（含自动开窗）、高风险限制、审计 | 双端审批只生效一次；重连恢复卡片；tab 未开倒计时照常执行 |
| M4 | 通知：`AgentAttentionSignal`、WS 通知、Web Push、PC 焦点抑制 | 两端边沿一致；不重复；点击直达会话 |
| M5 | 打包、Tailscale / WSL 文档、安全加固、用户文档（`docs/user/zh-CN` 新页）与开发文档、纳入冒烟 | 安装包含 `resources/mobile`；`check:full` 与 `e2e:smoke` 通过 |

## 12. 已确认的决策记录

日期均为 **2026-11-08**。

1. **局域网档接受降级**：只保证遥控 + 加密；完整 PWA / 推送能力限 Tailscale 档。
2. **手机高风险操作第一期默认禁止**：`allow_always` / `bypass` / 自动批准策略均不可用，网关与桥双重校验。
3. **plan 自动执行倒计时下沉到 service**：接受「会话 tab 未打开也会自动执行」的行为变化，并同步测试与用户文档。
4. **手机新建会话允许自动开窗**：窗口会被带到前台，已接受。
5. **默认值**：PC 聚焦时不发任何手机通知；远程会话可镜像、新建远程会话需远程窗口已打开；详情按需拉取。

形态层决策：采用 PWA；传输先做局域网 + Tailscale；镜像已打开编辑器窗口中的会话（编辑器需开着）；
第一期范围即 §1。

## 13. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 协议与 view-model 漂移 | 字段静默错位 | DTO 单一来源 + 映射函数 + 编译期检查；详情按需接口收窄面 |
| renderer 重载与会话 rekey | 连接指向旧会话/旧 epoch | 网关按 windowId + renderer epoch 失效桥；客户端靠快照恢复 |
| IPC 帧成本 | 大内容卡顿/超限 | 50ms 合帧、<1MB 单帧、队列超限 `resync_required` |
| 无手机订阅时空转 | 常驻开销 | 按订阅启停，无订阅不序列化 |
| 权限 Promise 生命周期 | 审批悬挂或重复结算 | settled 守卫 + `requestId` + 广播 `cleared` |
| Tailscale Serve 的 WS 稳定性 | 断连、丢消息 | 心跳、首帧 token、自动重连、先快照后增量；备选自管 HTTPS |
| 自签证书在 iOS 上的限制 | 无法安装 PWA / 推送 | 局域网档明确只保证遥控；主推 Tailscale |
| 安全：DNS rebinding、token 泄漏、审计 PII | 未授权访问/隐私外泄 | Host+Origin 校验、token 只存哈希、审计脱敏、默认关闭 |
| `web-push` 新依赖 | 供应链与升级成本 | 仅网关侧使用，锁定版本，推送失败可降级为前台 WS 通知 |
