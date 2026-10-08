# codex-acp 行为验收矩阵

> 配套 `SKILL.md` 的「三层验证阶梯」。每条 fork **保留行为** → 它挂在哪个测试入口、是真起进程还是桩、缺口在哪。rebase 后照此逐条核验，别只看 `npm test` 是绿。
> 表内路径按本仓 fork 指向的提交核对（2026-10）；重构/移动后请同步此表。

## 三层入口

- **真进程 · 跨仓 wire 契约**：`apps/editor/integration/scenarios/acpForkContract.integration.test.ts`（fixture `apps/editor/integration/fixtures/realForkConnection.ts`）
  起真 fork dist 的 stdio 连接。由 `UNIVERSE_FORK_CONTRACT=1` 门控（CI 的 `acp-contract` 作业跑它）。**验证的是 editor↔fork 的 wire 形状**（方法能不能路由、参数解析出什么错误码、`_meta` / 通知名在不在），不验证 fork 内部实现正确性。
- **fork 自身测试（桩 + 无模型真实 app-server）**：`vendor/codex-acp/src/__tests__/`
  共用 `acp-test-utils.ts`：`createCodexMockTestFixture` 使用桩，`createTestFixture` 启动真实 CLI 并隔离 CODEX_HOME，例如 `CodexACPAgent/CodexAcpClient.test.ts`、`CodexACPAgent/mcp-session.test.ts`。不能把 e2e 目录之外一概视为 mock。主仓 `acp-contract` 执行 `RUN_E2E_TESTS=false npm --prefix vendor/codex-acp run test`。
- **联网模型 e2e（独立验收）**：`vendor/codex-acp/src/__tests__/CodexACPAgent/e2e/`
  `acp-e2e-test-utils.ts` 仅在 `RUN_E2E_TESTS === "true"` 时启用；主仓 `acp-contract` 不跑。fork 自身另有 e2e workflow，不能称所有 CI 均不运行。本地 `npm run test:e2e` 需要模型凭据及联网授权，不属于本轮无模型验收。

## 实测 wire 形状（跨仓契约已断言，2026-10）

codex 腿在**无真实 prompt、无网络模型**下测得（`apps/editor/integration/scenarios/acpForkContract.integration.test.ts` 的 codex ext-method suite）：

| 调用 | 结果 | 断言点 |
|---|---|---|
| `universe-editor/set_session_title`，缺 `title` | `-32602` | zod 解析器 `data.title._errors` 非空（参数层拒绝） |
| `universe-editor/set_session_title`，`title` 全空白 | `-32602` | handler 抛的裸 invalidParams，`data` **undefined**（与上一条同一码，用 `data` 区分） |
| `universe-editor/rewind_session`，缺 `messageId` | `-32602` | zod 解析器 `data.messageId._errors` 非空 |
| `universe-editor/rewind_session`，参数合法但 session 未知 | `-32603` | `data.details === "Session <id> not found"`（路由+解析都过了，是 handler 的会话查找失败；方法名写错/漏注册会是 `-32601`） |
| `universe-editor/rewind_session`，`dryRun` 落在一个**无 turn** 的 session | `-32603` | `data.details` 匹配 `/list_turns is not supported/`——**已知 app-server 限制**（打包的 app-server 还读不了空 thread 的 turns），**不是**「锚点不存在 → `{canRewind:false}」的语义成功。等 app-server 支持读 turns 后，改为断言非存在锚点的 `{canRewind:false}` |

> 这一层说明：契约测试**无需模型**（不 prompt、不联网模型；app-server 是本地的、由 fork 自带的二进制拉起）。别把它整体说成「完全离线」——有本地 app-server 参与，是否绝对不触网需另找证据。

## 逐行为

### 1. 方法注册 / 参数

- **桩**：`vendor/codex-acp/src/__tests__/CodexACPAgent/set-session-title.test.ts`
  注册层回归（`EXTENSION_METHOD_REGISTRATIONS` 必须含目标方法、且 `isExtMethodRequest` 接受）——**SDK 只路由显式注册过的方法**，漏注册即 `methodNotFound`、到不了 server 的 switch；再加参数 parser 校验。
- **桩**：`vendor/codex-acp/src/__tests__/ExtraModels.test.ts`（`_meta.extraModels` / `extraModelEffort` 载荷降级、去重、上限）、`vendor/codex-acp/src/__tests__/ModelConfigOption.test.ts`（模型配置项构造）。
- **真进程**：上表 5 条。名称表 + dist 文本扫描在契约里另有专测（`EXPECTED_DIST_METHODS` / `EXPECTED_METHOD_NAMES`）。
- **缺口**：claude 腿的 live 路由需真实 CLI（`CLAUDE_CODE_EXECUTABLE`），CI 自跳过；editor 侧参数契约只覆盖 fork 实际实现的两个 request 方法。

### 2. 标题持久化 / rewind

- **桩**：`vendor/codex-acp/src/__tests__/CodexACPAgent/set-session-title.test.ts`（持久化接线）、`vendor/codex-acp/src/__tests__/SessionTitle.test.ts`（`normalizeSessionTitle`：空白→null、超长截断、不切代理对）、`vendor/codex-acp/src/__tests__/TitleGenerator.test.ts`、`vendor/codex-acp/src/__tests__/CodexACPAgent/session-info-update-events.test.ts`（首条 prompt 兜底标题、thread name → session info 映射）。
- **桩**：`vendor/codex-acp/src/__tests__/resolveRollbackTurns.test.ts`（rewind 锚点→要丢的 turn 数；优先 `clientId`、回退 item id、找不到返回 undefined）、`vendor/codex-acp/src/__tests__/CodexACPAgent/thread-history.test.ts`（分页回放：完整消息、失败不空等、子会话分页）、`vendor/codex-acp/src/__tests__/CodexACPAgent/session-fork.test.ts`（fork 会话 + MCP 启动等待）。
- **真进程**：契约测试路由 `rewind_session` / `set_session_title` 并断言上表的错误码（见「实测 wire 形状」）。
- **缺口**：跨仓未覆盖 title→list 持久化往返及有历史会话的 rewind 成功路径。空会话没有 rollout，本轮不发送 prompt 制造历史。Codex 文件回滚由 editor 承担，这是职责边界，不是 fork 漏实现。

### 3. metadata（`_meta` 印章）

- **桩**：`vendor/codex-acp/src/__tests__/CodexACPAgent/token-usage-events.test.ts`（`_meta.quota` 走 **totalTokenUsage 累计**语义；快照 `vendor/codex-acp/src/__tests__/CodexACPAgent/data/token-usage-session-update.json` 等）、`vendor/codex-acp/src/__tests__/CodexACPAgent/subagent-token-usage.test.ts`（`_universe/subagentStats`；父卡片补发）。
- **桩**：`vendor/codex-acp/src/__tests__/RateLimitsMap.test.ts`、`vendor/codex-acp/src/__tests__/subscriptionUsage.test.ts`（订阅额度归一化 / `chat-gpt` auth 门控）、`vendor/codex-acp/src/__tests__/CodexACPAgent/session-config-options.test.ts`。
- **真进程**：契约测试读 `session/new` 响应的 `_meta`（`readCodexModelKnownInCatalog` 必须返回 boolean；`_meta.extraModels` 注入的模型出现在 model 选项并可切换）；dist 文本扫描断言 `_meta` key（`modelContextWindow` / `modelKnownInCatalog` / `extraModels` / `extraModelEffort`）在产物里。
- **缺口**：`_meta.quota` 的**具体数值**只在快照里（桩），无跨仓真进程断言——真值依赖真实 codex 用量。

### 4. 问答回放（`request_user_input` 窄 rollout 回放）

- **桩**：`vendor/codex-acp/src/__tests__/RequestUserInputReplay.test.ts`（共享锚点插回、rewind/边界截断守卫、未完成对延后、无可用 questions 丢弃——**不恢复旧的整份 shell 解析**）、`vendor/codex-acp/src/__tests__/CodexACPAgent/load-session.test.ts`（rollout JSONL fixture 全链路，含真实 rollout 行形态）、`vendor/codex-acp/src/__tests__/CodexACPAgent/elicitation-events.test.ts`（live 表单/降级/取消语义）。
- **真进程**：本轮跨仓契约未覆盖有历史的问答回放；空会话限制不能据此推广为所有已持久化会话均无法读取。
- **缺口**：`load-session.test.ts` 用**构造的** rollout fixture，不是真实会话产出的 rollout；真实 rollout 的形态漂移靠人眼 + 该 fixture 跟随更新。

### 5. budget（回放字节预算）

- **桩**：`vendor/codex-acp/src/__tests__/ReplayBudget.test.ts`（5 例：小 update 保持引用同一性、命令输出在 block 与 rawOutput 两处都被截断、diff 双侧截断、巨型 payload 记账受 cap 约束、循环引用不爆栈）、`vendor/codex-acp/src/__tests__/ReplayFileRead.test.ts`（`readFileWithinCap`：超限只报尺寸不读、缺文件返回 null）。
- **真进程**：无（预算是纯函数 + 单文件读上限）。
- **缺口**：`REPLAY_TOTAL_CAP_BYTES` / `MAIN_REPLAY_*` 的**总量**端点无真进程断言，只有单元级记账。

### 6. notifications（自定义 ext-notification）

- **桩**：`vendor/codex-acp/src/__tests__/liveness-probe.test.ts`（`_universe/liveness_ping`，fake timers；只有探活核心应答才转发心跳）、`vendor/codex-acp/src/__tests__/CodexACPAgent/load-session.test.ts`（MCP 启动结果 `_universe/mcp_server_status`，含 ready + failed）、`vendor/codex-acp/src/__tests__/McpStartupTracker.test.ts`、`vendor/codex-acp/src/__tests__/McpStatusMarkdown.test.ts`。
- **桩**：`vendor/codex-acp/src/__tests__/CodexACPAgent/subagent-token-usage.test.ts`（子会话 stats 通知）。
- **静态扫描**：契约测试检查 `_universe/liveness_ping` / `_universe/mcp_server_status` 字面量仍在 dist 中；这不启动进程，也不证明注册或投递成功。
- **缺口**：跨仓尚无自定义通知的运行期投递断言。联网 e2e 对这两个通知的逐项覆盖未确认，不能将存在 e2e 目录视为已覆盖。

## rebase 后怎么用

1. 先跑 fork：`npm --prefix vendor/codex-acp run typecheck` 和 `RUN_E2E_TESTS=false npm --prefix vendor/codex-acp run test`（Node 24）。
2. 再跑跨仓真进程：`UNIVERSE_FORK_CONTRACT=1 pnpm --filter @universe-editor/editor test:integration acpForkContract`（`pnpm agent:build` 之后）——重点看「实测 wire 形状」表每行的码/data 是否还在。
3. 需要时本地真跑 e2e：fork 内 `npm run test:e2e`（真起 app-server；注意它要模型/网关，别在 CI 上开）。
4. 哪条行为在表里却找不到对应测试 → 大概率是 rebase 把它连测试一起丢了（对照 `SKILL.md` 的本地改动清单）。
