# apps/editor/src/renderer/workbench/agentSettings/claude/CLAUDE.md

> Claude agent 设置面板内容本体（`services/acp/CLAUDE.md` 的子域）。协议层与 ACP 全景见 [`../../../services/acp/CLAUDE.md`](../../../services/acp/CLAUDE.md)；Codex 同类子系统见 [`../codex/CLAUDE.md`](../codex/CLAUDE.md)。

## Agent 设置：Claude

> 代码不在 `services/acp/` 下：UI 在 `agentSettings/claude/`（承载壳见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)），main 实现在 `main/services/claudeConfig/`，wire 契约在 `shared/ipc/claudeConfigService.ts`。

Agent 设置是多 agent 可扩展子系统：每个 agent 经**模块级贡献注册表**挂自己的设置组件。本节讲注册表 + Claude 面板 + claudeConfig 服务。

### 文件 → 职责

Renderer — 贡献注册（承载壳见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)）：
- `agentSettings/agentSettingsRegistry.ts` — `registerAgentSettings(agentId, component)` / `getAgentSettingsComponent(agentId)`。
- `agentSettings/builtinAgentSettings.ts` — 副作用 hub：`import './claude/ClaudeAgentSettings.js'`。**新增 agent 设置在这里加一行 import**。
- `agentSettings/AgentSettingsEditor.module.css` — Claude/Codex 共用样式（`--ue-*` token；壳样式用 `--color-*`，两套并存）。

Renderer — Claude 专属（agentSettings/claude/）：
- `claude/ClaudeAgentSettings.tsx` — 根组件：`useClaudeConfig()` + 三分类子导航（auth/model/env，`CATEGORIES`）；激活分类/滚动持久化（`agent.settings.claude.activeCategory` / `.scroll.<id>`）。**末行 `registerAgentSettings('claude-code', ClaudeAgentSettings)`**。
- `claude/AuthenticationPanel.tsx` — 认证页：`AuthenticationSection`（单一认证选择：provider 条目或 `@subscription`；Model + Sub Agent Model 两行 `ModelPickRow` 各带 `1m` 勾选框——**行显示有效 id，勾选框由 id 是否以 `[1m]` 结尾派生**；没选模型时勾选框不出现）+ `LoginForm`（OAuth 登录状态）。**下拉当前值是盘上生效值**（从 `activeAuth` 派生、非声明值；providerId 缺席 → 「外部凭据」）。共享 `../GatewayProviderPicker.js`（`protocol="anthropic-messages"`），派生经 `deriveClaudeAuth`。**没有 "In use" 徽章**（生效即所选，`isClaudeAuthActive` 已删）；`LoginForm.isActive` 直接读 `activeAuth.kind==='subscription'`；`mask()` 脱敏。
- `claude/ModelThinkingPanel.tsx` — 模型 / 语言 / 思考开关 / effort / availableModels，绑 settings.json。
- `claude/AdvancedEnvPanel.tsx` — env 开关（PROMPT_CACHING、AUTO_COMPACT）+ 自定义 env 编辑器。隐藏认证类 env（`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`）与 `CLAUDE_CODE_SUBAGENT_MODEL`（owner 是认证页）；`ANTHROPIC_SMALL_FAST_MODEL` 已无可视化入口，改手填（**不隐藏**）。
- `claude/useClaudeConfig.ts` — 配置 hook：聚合 settings/authStatus/**activeAuth** 读取与 patch，订阅 `onDidChangeConfig` 一次刷三样（外部 `claude auth login`、别的窗口、手改文件都能跟上）。`applyAuthentication` **只把匹配凭据 env 注入 settings.json**（互斥清掉另一种凭据）后重读 `activeAuth`——不再持久化声明值；`setModel`/`setSubagentModel` 系列共用 `applyModelPick`，两条不变量：① **每个 setter 只 patch 自己关联的那一个键**（`settings.model` 或 `env.CLAUDE_CODE_SUBAGENT_MODEL`），其余不动；② **在写队列内重新 `service.read()` 拿盘上现值再复合，绝不读 React state**（防陈旧快照盖掉外部编辑）。暴露 `subagentModelEnv`。
- `claude/claudeLogin.ts` — `runClaudeLogin()` 开终端跑 `claude auth login --claudeai|--console`。

跨进程三层：
- `shared/ipc/claudeConfigService.ts` — **wire 契约**：`IClaudeConfigService` + 类型（`ClaudeSettings`/`Patch`/`AuthStatus`；`AgentActiveAuth` 来自 `shared/ai/agentActiveAuth.ts`）。`AGENT_SUBSCRIPTION_AUTH='@subscription'` 哨兵**只是下拉值/入参，不再被持久化**。方法：`read`/`patch`/`configPath`/`readAuthStatus`/**`resolveActiveAuth(authority?)`**/`checkGatewayConnectivity` + 事件 **`onDidChangeConfig`**。`readAgentSettings`/`writeAgentSettings` 已删。
- `main/services/claudeConfig/claudeConfigMainService.ts` — main 实现：原子写 + 读容错；`resolveActiveAuth` 并行 `read`/`readAuthStatus`/`readResolvedProviders`（共享 helper `aiSettingsProviders.ts`）后交纯函数 `resolveClaudeActiveAuth`；`onDidChangeConfig` 本地直连 store，远端首次带 authority 调用时懒挂载。
- `__tests__/claudeConfigMainService.test.ts` — readAuthStatus（token 不泄漏断言）+ `resolveActiveAuth`（不 fall through、外部凭据不归属）+ 事件转发。

### claudeConfig 服务接线（5 处，加方法时无需动）

给 `IClaudeConfigService` 加方法只改契约 + main 实现两个文件，下面 5 处接线不用动：
- main 侧：`main/services/main-services.ts`（SyncDescriptor）→ `main/window/scopedServicesFactory.ts`（readonly 字段）→ `main/ipc/registerMainServices.ts`（ProxyChannel.fromService）
- 通道 + renderer：`shared/ipc/channelNames.ts`（`ClaudeConfig:'claudeConfig'`）→ `renderer/main.tsx`（ProxyChannel.toService）

### 三个配置文件的语义（关键）

| 文件 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `~/.claude/settings.json` | 编辑器 + CLI 共享 | agent/SDK/CLI | **当前生效**配置：model、env（含激活凭据）、思考开关等 |
| `~/.claude/.credentials.json` | `claude auth login`（OAuth） | agent/SDK | `claudeAiOauth`：accessToken/refreshToken/expiresAt/scopes/subscriptionType/rateLimitTier |

- **🔴 agent 自己的配置文件是唯一真相**：编辑器**不存任何声明值**（`aiSettings.json` 的 `agentSettings.claude` 已废弃、不再被读取），「当前用哪个凭据」一律**反查** `resolveActiveAuth(authority)`（读上面两文件 + 条目正向派生比对）。外部登录、手改、换机器同步都自动跟上（`onDidChangeConfig` 去抖 150ms），不存在「声明与盘上漂移」——原先的 `credentialMatch.isClaudeAuthActive`、codex drift 检测已删。
- **🔴 模型选择同样只有一处真相：settings.json**（`model` 与 `env.CLAUDE_CODE_SUBAGENT_MODEL`）：UI 显示的就是有效 id，`1m` 勾选框由 id 后缀派生。历史教训：镜像版本 + 整块替换写入 = 陈旧快照盖掉别人刚改的选择（真实 bug）。新增模型类选择项一律直写 settings.json。
- 登录(OAuth) 不是一个 provider 条目，走 `.credentials.json`，是反查的最后一档。
- 切换 Provider 只写三个凭据 env、**不连带清空 model**（独立于认证）；下拉 `pinCurrent` 置顶「当前值不在新候选」的项更关键。

### 认证优先级（agent/SDK 解析顺序 = 反查顺序）

`ANTHROPIC_AUTH_TOKEN`(+`ANTHROPIC_BASE_URL`) > `ANTHROPIC_API_KEY` > OAuth 登录(`.credentials.json`)。

`resolveClaudeActiveAuth`（`shared/ai/agentActiveAuth.ts`）严格按此顺序，**绝不 fall through**：

| 盘上状态 | 反查结果 |
|---|---|
| `AUTH_TOKEN` + `BASE_URL` 都非空，且命中某条目的 `deriveClaudeAuth` | `{kind:'provider', providerId}` |
| 同上但没命中任何条目 | `{kind:'provider'}` —— 外部/手写网关，**刻意不归属**。**不能掉到 API_KEY 分支**：SDK 此时根本不看 `API_KEY` |
| 无 token，`API_KEY` 非空 | 命中 → 带 providerId；否则不带 |
| 三个 env 都空（孤立 `BASE_URL` 忽略） | `loggedIn && !expired` ? `{kind:'subscription'}` : `{kind:'none'}` |

baseUrl **逐字比对不做 URL 归一化**（写盘值与反查同源，归一化只会制造假不匹配）；两条目同 baseUrl+key 时按文件序**确定性 first-match**（盘上只有 key 区分不了哪条，答案必须稳定；纯函数、无 logger）。

`applyAuthentication` 是反查的逆向，按同优先级**互斥注入**（保证只有一种凭据生效）：官方端点 provider → `{API_KEY, AUTH_TOKEN:null, BASE_URL:null}`；网关 provider → `{AUTH_TOKEN, BASE_URL, API_KEY:null}`（值由条目经 `deriveClaudeAuth` 派生：官方 → apiKey 写 `ANTHROPIC_API_KEY`；网关 → apiKey 写 `ANTHROPIC_AUTH_TOKEN`、baseUrl 写 `ANTHROPIC_BASE_URL`；判定靠 `shared/ai/officialEndpoints.ts`）；`@subscription` → 清三 env 走 OAuth。写盘后重读 `activeAuth` 必须得到刚选的 id（**单测钉住** `agentActiveAuth.test.ts`）。

### Remote 工作区路由（2026-08）

远端工作区下面板操作**远端主机**的 `~/.claude`：契约方法带尾部可选 `authority`，main 按 authority 经 `RemoteChannels.AgentConfig` 转发（协议 `packages/node-services/src/agentConfig/agentConfigService.ts`，改协议须 bump `REMOTE_PROTOCOL_VERSION`）。要点：

- **authority 必须来自 `useRemoteAuthority()`**（`workbench/useRemoteAuthority.ts`，订阅 `onDidChangeWorkspace`）——workspace hydration 是异步的，用 `useMemo` 读 `workspace.current` 会把 authority 冻结成 undefined（启动恢复的 tab 永远读写本地，真实踩坑）。
- **凭据归属天然按主机分区**：`resolveActiveAuth(authority)` 读那台主机的文件；消费方（`AcpSessionProviderContext` / `AccountUsageService` / `SubscriptionUsageService`）缓存键都是 `agentId + authority`。**归属看会话所在主机，不是窗口 authority**（只读预览、fork 混合 authority），故 `IAcpSession.authority` 一路贯通。
- **`onDidChangeConfig` 也跨主机**：远端 watch 事件经 `IRemoteAgentConfigService.onDidChangeClaudeConfig` 转发；**一律经 `IRemoteConnectionService.getServiceProxy` 取 channel，勿自缓存代理**（stop/reconnect 后死代理）。
- `ConfigFileLink` 传 `authority` 用 `remoteFsPathToUri` 开远端文件；`runClaudeLogin` remote 分支在远端终端跑 `claude auth login`。
- **BinaryPanel 远程语义**：版本/强制下载经 `IClaudeBinaryService` 尾部 `authority` 走 `RemoteChannels.AgentBinary`；远端隐藏「Binary source」区；`prefetch`/`cleanupStaleVersions` 同样带 authority，门控在「已连接」。

### 🔒 安全约束（刻意决策，勿擅改）

1. **凭据明文落盘是用户明确选择**：provider 条目 key 明文进 `aiSettings.json` `providers[]`（套路 I）；选中时把派生 env 写进 `settings.json`（与 CLI 共享）。**刻意**不用加密 SecretStorage。
2. **`readAuthStatus()` 绝不回传 OAuth token**：只回 `{loggedIn, expired, subscriptionType?, expiresAt?}`，有测试断言 token 不泄漏。`resolveActiveAuth` 同理只回 `{kind, providerId?}`——**远端的 token/key 绝不回传**（比对在读文件的那一侧做完）。

### 常见任务 → 改哪里

- **给 Claude 加一个新设置项**：定字段进 `ClaudeSettings`/`ClaudeSettingsPatch`（契约）→ main 实现读写 → 对应面板（model 类→ModelThinkingPanel、env 类→AdvancedEnvPanel、认证类→AuthenticationPanel + `AUTH_ENV_KEYS`）加 UI，经 `useClaudeConfig().patch` 落盘。
- **加一个模型相关的结构化选择项**：在 `useClaudeConfig` 加走 `applyModelPick` 的 setter（只 patch 它关联的那个 settings.json 键），面板加一行 `ModelPickRow`；若对应 env key，记得在 `AdvancedEnvPanel` 隐藏。**不要在编辑器侧另存镜像。**
- **给 claudeConfig 加跨进程方法**：只改契约 + main 实现两个文件（5 处接线不动）。
- **再加一个 acp agent 的设置页（如 codex）**：新建 `agentSettings/codex/CodexAgentSettings.tsx`，末行 `registerAgentSettings('codex', ...)`；`builtinAgentSettings.ts` 加一行 import。**壳零改动**。Codex 已存在，凭据模型与 Claude 不同，见 [`../codex/CLAUDE.md`](../codex/CLAUDE.md)。
- **加一种认证来源**：改**反查纯函数** `resolveClaudeActiveAuth` + 逆向 `applyAuthentication` 互斥注入 + `AuthenticationSection`/`GatewayProviderPicker`。**两侧必须同时改**并在 `agentActiveAuth.test.ts` 补往返用例——只改一侧就「写进去反查不回来」。
- **接入第三方模型（Kimi/GPT 等）**：无需新代码——在 AI 设置里建一个 `anthropic-messages` 协议 provider 条目（baseUrl+key），认证选择选它；还可设 `model`/`subagentModel`（`settings.model` / `env.CLAUDE_CODE_SUBAGENT_MODEL`，后者解决子 agent 被 CLI 改写的问题）。Claude Code 只说 Anthropic 协议：Kimi 原生兼容直连，GPT 需 LiteLLM/claude-code-router 代理。用户文档见 `docs/user/zh-CN/ai-agent/models-and-cost.md`。

### 易踩坑速记

- `useObservable` / `useService` 来自 `renderer/workbench/useService.ts`（面板里的 `../../useService.js`），**不是** `@universe-editor/workbench-ui`。
- workbench-ui 的 `IconButton` 是 `label` 属性 + `children` 放图标，无 `icon`/`ariaLabel` props。
- ESM：相对导入带 `.js` 后缀（即使源是 `.ts`）。`claude/` 比外壳深一层，import 路径多一级 `../`。
- 状态持久化套路：`IStorageService` 存 key + `restoredRef` 守卫防覆盖 + `requestAnimationFrame` 恢复滚动。
- NLS：`localize(key, '英文默认值', vars?)`，默认值必须英文；中文写进 `shared/i18n/messages/zh-CN.ts`。
- 新增 FakeSession 测试桩别忘 `onDidRequireAuth: Event.None`（认证流相关）。

### 验证

- `pnpm check`（lint + typecheck + test，输出长，只截错误）；改交互逻辑跑 `pnpm e2e`。已知本机 flaky（非回归）：simpleFileDialog / multiFileDragEditor / explorerExternalWatcher / markdown* @p1。

### 入口（打开到 Agents 区）

- 主入口：命令 `ai.manageModels`（标题 “Open AI & Agent Settings”）打开统一 Settings editor。
- agent 专用入口：`workbench.action.agent.openSettings`（`actions/agentActions.ts` 的 `OpenAgentSettingsAction`）——先 `storage.set('settings.activeItem', 'agent:<defaultAgentId>')` 再打开 `AiSettingsEditorInput`，落点在 Agents 区。**此命令 ID 被 AcpSessionEditor 齿轮、`acpSessionService`（两处）引用，勿改 ID。**

### 关键参考路径

- 承载壳：`renderer/workbench/ai/AiSettingsEditor.tsx`（见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)）
- 贡献注册：`renderer/workbench/agentSettings/{agentSettingsRegistry.ts,builtinAgentSettings.ts}`
- Claude 内容：`renderer/workbench/agentSettings/claude/*` + `AgentSettingsEditor.module.css`
- 服务：`shared/ipc/claudeConfigService.ts`、`main/services/claudeConfig/claudeConfigMainService.ts`
- 编辑器输入：`renderer/services/editor/AiSettingsEditorInput.ts`（`AgentSettingsEditorInput` 已删）
- 入口命令：`renderer/actions/{agentActions.ts,aiActions.ts}`
- agent 注册表：`renderer/services/acp/acpAgentRegistry.ts`
