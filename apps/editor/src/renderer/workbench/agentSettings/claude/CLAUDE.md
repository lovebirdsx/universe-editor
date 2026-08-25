# apps/editor/src/renderer/workbench/agentSettings/claude/CLAUDE.md

> 本文是 `services/acp/CLAUDE.md` 的子域文档（Claude agent 设置面板），原为其「Agent 设置：Claude」章。协议层与 ACP 全景见 [`../../../../services/acp/CLAUDE.md`](../../../../services/acp/CLAUDE.md)；Codex 同类子系统见 [`../codex/CLAUDE.md`](../codex/CLAUDE.md)。

## Agent 设置：Claude

> **代码不在 `services/acp/` 下**：UI 在 `apps/editor/src/renderer/workbench/agentSettings/claude/`（承载壳为 `workbench/ai/AiSettingsEditor.tsx`），main 实现在 `apps/editor/src/main/services/claudeConfig/`，wire 契约在 `apps/editor/src/shared/ipc/claudeConfigService.ts`；因设置面板按 acp agent 贡献注册、与 ACP 子系统强相关，故并入本文。

agent 设置是**多 agent 的可扩展子系统**：统一 Settings editor 的左侧「Agents」组按 `IAcpAgentRegistry` 列出所有 acp agent（claude-code、codex、用户自定义），每个 agent 通过**模块级贡献注册表**挂自己的设置组件。Claude 的设置内容全部收敛在 `agentSettings/claude/` 命名空间下。

> 🔀 **2026-06 合并**：agent 设置原是独立的 Agent Settings editor，现已并入 AI Settings 的统一壳（`workbench/ai/AiSettingsEditor.tsx`）。本节讲 **agent 设置内容本体**（注册表 + Claude 面板 + claudeConfig 服务）；**承载它的壳**（AI/Agents 双组导航、激活项持久化、入口命令）见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)。

### 文件地图

#### Renderer — 承载壳（见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)）
- `renderer/workbench/ai/AiSettingsEditor.tsx` — 统一 Settings editor 壳。左侧「Agents」组动态列出 `IAcpAgentRegistry.list()`，选中 agent 后右侧 `getAgentSettingsComponent(id)` 渲染其贡献组件，无注册则占位。激活项持久化用 `settings.activeItem`（值 `agent:<id>`）。壳顶部 `import '../agentSettings/builtinAgentSettings.js'` 触发副作用注册。
- `agentSettings/agentSettingsRegistry.ts` — 贡献注册表。`registerAgentSettings(agentId, component)` / `getAgentSettingsComponent(agentId)`，`AgentSettingsComponentProps { agentId }`。
- `agentSettings/builtinAgentSettings.ts` — 内置 agent 设置的副作用聚合 hub：`import './claude/ClaudeAgentSettings.js'`。**新增 agent 设置时在这里加一行 import。**
- `agentSettings/AgentSettingsEditor.module.css` — Claude 面板共用样式（`agentBody`/`subNav`/`subBody`/认证表单/状态行等，用 `--ue-*` token）。注意：壳本身的样式在 `ai/AiSettingsEditor.module.css`（用 `--color-*` token），两套并存。

#### Renderer — Claude 专属（agentSettings/claude/）
- `claude/ClaudeAgentSettings.tsx` — Claude 设置根组件。持有 `useClaudeConfig()`，三分类子导航（auth/model/env，`CATEGORIES` 数组），滚动位置 + 激活分类经 `IStorageService` 持久化（`agent.settings.claude.activeCategory`、`agent.settings.claude.scroll.<id>`）。**末行 `registerAgentSettings('claude-code', ClaudeAgentSettings)`。**
- `claude/AuthenticationPanel.tsx` — 认证页。两块：`AuthenticationSection`（单一认证选择：选一个 provider 条目或 `@subscription`；结构化选择是 **Model + Sub Agent Model** 两行 `ModelPickRow`，各带一个 `1m` 勾选框——**行显示的是 settings.json 里的有效 id**，勾选框状态由该 id 是否以 `[1m]` 结尾派生，勾上/取消即改写这个 id；没选模型（空值）时勾选框不出现）与 `LoginForm`（OAuth 登录状态 + 登录按钮）。**下拉当前值不是编辑器存的声明值，而是从 `activeAuth` 派生的盘上生效值**（`kind==='provider'` → 该 `providerId`；`kind==='subscription'` → `@subscription` 哨兵；`providerId` 缺席 → 显示「外部凭据」提示）。下拉控件是共享组件 `../GatewayProviderPicker.js`（`protocol="anthropic-messages"`），派生预览经 `shared/ai/providerDerivation.ts` 的 `deriveClaudeAuth`。**没有 "In use" 徽章**——生效即所选，徽章无意义（`credentialMatch.ts` / `isClaudeAuthActive` 已随之删除）；`LoginForm.isActive` 直接读 `activeAuth.kind==='subscription'`。`mask()` 脱敏显示。
- `claude/ModelThinkingPanel.tsx` — 模型 / 语言 / 思考开关 / effort / availableModels，绑 settings.json。
- `claude/AdvancedEnvPanel.tsx` — env 开关（PROMPT_CACHING、AUTO_COMPACT）+ 自定义 env 编辑器。隐藏认证类 env（`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`）与 `CLAUDE_CODE_SUBAGENT_MODEL`（owner 是 AuthenticationPanel 的 Sub Agent Model 行）；`ANTHROPIC_SMALL_FAST_MODEL` 已不再有可视化入口，改由 Custom environment variables 手填（**不隐藏**，老用户遗留值交回手填）。
- `claude/useClaudeConfig.ts` — Claude 配置 hook。聚合 settings/authStatus/**activeAuth**（盘上生效凭据的反查结果）的读取与 patch，并订阅 `service.onDidChangeConfig` 一次刷这三样（外部 `claude auth login`、别的窗口、手改文件都能跟上）。`applyAuthentication` **只把匹配的凭据 env 注入 settings.json**（互斥清掉另一种凭据，见下）然后重读 `activeAuth`——不再持久化任何声明值；`setModel`/`setModelOneM`/`setSubagentModel`/`setSubagentModelOneM` 共用内部 `applyModelPick`，两条不变量：(1) **每个 setter 只 patch 自己关联的那一个键**（`settings.model` 或 `env.CLAUDE_CODE_SUBAGENT_MODEL`），其余配置逐字不动；(2) **`applyModelPick` 在写队列内重新 `service.read()` 拿盘上现值**再复合，绝不读 React state——否则另一个 hook 实例/外部编辑的新值会被本实例的陈旧快照盖回去。暴露 `subagentModelEnv`（= `settings.env.CLAUDE_CODE_SUBAGENT_MODEL`）给面板显示。常量 `API_KEY`/`AUTH_TOKEN`/`BASE_URL`/`SUBAGENT_MODEL`。
- `claude/claudeLogin.ts` — `runClaudeLogin()` 开终端跑 `claude auth login --claudeai|--console`。

#### 跨进程服务三层
- `shared/ipc/claudeConfigService.ts` — **wire 契约**。`IClaudeConfigService` 装饰器 + 所有类型（`ClaudeSettings`/`ClaudeSettingsPatch`/`ClaudeAuthStatus` re-export 自 node-services；`AgentActiveAuth` 来自 `shared/ai/agentActiveAuth.ts`）。`AGENT_SUBSCRIPTION_AUTH = '@subscription'` 哨兵仍在此，但**只是下拉菜单值与 `applyAuthentication` 入参，不再被持久化**。方法：`read`/`patch`/`configPath`/`readAuthStatus`/**`resolveActiveAuth(authority?)`**/`checkGatewayConnectivity` + 事件 **`onDidChangeConfig`**。`readAgentSettings`/`writeAgentSettings` 与 `ClaudeAgentSettings` 已删。
- `main/services/claudeConfig/claudeConfigMainService.ts` — **main 实现**。原子写（mkdir -p + temp + rename），读容错（缺失/损坏返回空）；`resolveActiveAuth` 并行 `read`/`readAuthStatus`/`readResolvedProviders`（共享 helper `main/services/ai/aiSettingsProviders.ts`）后交给纯函数 `resolveClaudeActiveAuth`；`onDidChangeConfig` 本地直连 store，远端照 codex 套路在**首次带 authority 调用时懒挂载**（`_remoteConfigSubscribed`）。
- `main/services/claudeConfig/__tests__/claudeConfigMainService.test.ts` — readAuthStatus（含「never returns the token」不泄漏断言）+ `resolveActiveAuth`（本地与远端、优先级不 fall through、外部凭据不归属）+ 事件转发。

### claudeConfig 服务接线（5 处，加方法时无需动）

服务方法走 `ProxyChannel`，**给 `IClaudeConfigService` 加方法只改契约 + main 实现两个文件，下面 5 处接线不用动**：
1. `main/services/main-services.ts` — `SyncDescriptor` 注册 `ClaudeConfigMainService`
2. `main/window/scopedServicesFactory.ts` — `readonly claudeConfig` 字段
3. `main/ipc/registerMainServices.ts` — `ProxyChannel.fromService(app.claudeConfig)`
4. `shared/ipc/channelNames.ts` — `ClaudeConfig: 'claudeConfig'`
5. `renderer/main.tsx` — `ProxyChannel.toService<IClaudeConfigService>(...)`

### 三个配置文件的语义（关键）

| 文件 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `~/.claude/settings.json` | 编辑器 + CLI 共享 | agent/SDK/CLI | **当前生效**配置：model、env（含激活的凭据）、思考开关等 |
| `~/.claude/.credentials.json` | `claude auth login`（OAuth） | agent/SDK | `claudeAiOauth`：accessToken/refreshToken/expiresAt/scopes/subscriptionType/rateLimitTier |

- **🔴 agent 自己的配置文件是唯一真相**。编辑器**不存任何声明值**（`aiSettings.json` 的 `agentSettings.claude` 已废弃、不再被读取），「当前用哪个凭据」一律**反查**：`resolveActiveAuth(authority)` 读上面两个文件 + provider 条目正向派生后比对，见下节决策表。因此外部 `claude auth login`、手改 settings.json、换机器同步，编辑器都自动跟上（`onDidChangeConfig` 去抖 150ms 后刷新），不存在「声明与盘上漂移」这个概念——原先为此打的两块补丁（`credentialMatch.isClaudeAuthActive`、codex 的 drift 检测）已删。
- **🔴 模型选择同样只有一处真相：settings.json**（`model` 与 `env.CLAUDE_CODE_SUBAGENT_MODEL`）。UI 显示的就是有效 id，`1m` 勾选框由 id 后缀派生。历史教训：镜像版本 + 整块替换写入 = 陈旧快照的写入会覆盖别人刚改的选择，界面高亮 `deepseek-v4-pro` 而子 agent 实跑 `deepseek-v4-flash`（真实 bug）。新增模型类选择项一律直写 settings.json。
- **登录(OAuth) 不是一个 provider 条目**，它走 `.credentials.json`，是反查的最后一档。
- **切换 Provider 只写三个凭据 env，不连带清空 model 选择**：model/subagentModel 独立于认证；也因此下拉里「当前值不在新候选中时置顶为额外选项」（`pinCurrent`）更关键（否则陈旧值会凭空消失）。

### 认证优先级（agent/SDK 解析顺序 = 反查顺序）

`ANTHROPIC_AUTH_TOKEN`(+`ANTHROPIC_BASE_URL`) > `ANTHROPIC_API_KEY` > OAuth 登录(`.credentials.json`)。

`resolveClaudeActiveAuth`（`shared/ai/agentActiveAuth.ts`）严格按此顺序，**绝不 fall through**：

| 盘上状态 | 反查结果 |
|---|---|
| `AUTH_TOKEN` + `BASE_URL` 都非空，且逐字命中某条目的 `deriveClaudeAuth` | `{kind:'provider', providerId}` |
| 同上但没命中任何条目 | `{kind:'provider'}` —— 外部/手写网关，**刻意不归属**（面板显示「外部凭据」，开销「—」）。**不能掉到 API_KEY 分支**：SDK 此时根本不看 `API_KEY`，生效的就是那个未知网关 |
| 无 token，`API_KEY` 非空 | 命中 → `{kind:'provider', providerId}`；否则 `{kind:'provider'}` |
| 三个 env 都空（孤立 `BASE_URL` 忽略——无 token 时 SDK 不用它） | `loggedIn && !expired` ? `{kind:'subscription'}` : `{kind:'none'}` |

baseUrl **逐字比对不做 URL 归一化**（写盘值与反查值同源，归一化只会制造「写进去反查不回来」的假不匹配）；两条目同 baseUrl+key 时按 aiSettings.json 文件序**确定性 first-match**（盘上只有 key，不可区分是信息论意义上的，但答案必须稳定而非随机；反查是纯函数、无 logger，不额外告警）。

`applyAuthentication` 是反查的逆向，据同一优先级**互斥注入**（保证只有一种凭据生效）：
- 选官方端点的 provider → `{API_KEY: 值, AUTH_TOKEN: null, BASE_URL: null}`
- 选网关 provider → `{AUTH_TOKEN: 值, BASE_URL: 值, API_KEY: null}`——这两个值不内联在配置里，而是由选中的 provider 条目经 `deriveClaudeAuth`（`shared/ai/providerDerivation.ts`）派生：官方端点 → apiKey 写 `ANTHROPIC_API_KEY`；网关 → apiKey 写 `ANTHROPIC_AUTH_TOKEN`、baseUrl 写 `ANTHROPIC_BASE_URL`。官方/网关判定靠内置「协议 → 官方 baseUrl」对照表（`shared/ai/officialEndpoints.ts`），无需用户配字段。
- 选 `@subscription` → 清掉三个 env，用 OAuth 登录。

写盘后重读 `activeAuth` 必须得到刚选的那个 id——**这条往返不变量有单测钉住**（`shared/ai/__tests__/agentActiveAuth.test.ts`）。`LoginForm.isActive` 直接读 `activeAuth.kind === 'subscription'`（不再自己推 env）。

### Remote 工作区路由（2026-08）

远端工作区下面板操作**远端主机**的 `~/.claude`：契约方法带尾部可选 `authority`（`read`/`patch`/`configPath`/`readAuthStatus`/`resolveActiveAuth`/`checkGatewayConnectivity`），main 按 authority 经 `RemoteChannels.AgentConfig` 转发到 remote server（协议在 `packages/node-services/src/agentConfig/agentConfigService.ts`，改协议须 bump `REMOTE_PROTOCOL_VERSION`）。要点：
- **authority 必须来自 `useRemoteAuthority()`**（`workbench/useRemoteAuthority.ts`，订阅 `onDidChangeWorkspace`）——workspace hydration 是异步的，用 `useMemo` 读 `workspace.current` 会把 authority 冻结成 undefined（启动恢复的 tab 永远读写本地，真实踩坑）。
- **凭据归属天然按主机分区**：`resolveActiveAuth(authority)` 读的是那台主机的 settings.json / .credentials.json，所以本地用订阅、远端走网关时会话计费与账号用量各归各位（消费方 `AcpSessionProviderContext` / `AccountUsageService` / `SubscriptionUsageService` 的缓存键都是 `agentId + authority`）。**归属看会话所在主机，不是窗口 authority**——同一窗口混合 authority 真实存在（只读预览、fork），故 `IAcpSession.authority` 一路贯通到 `UsageIndicator`。
- **`onDidChangeConfig` 也跨主机**：远端 store 的 watch 事件经 `IRemoteAgentConfigService.onDidChangeClaudeConfig` 转发；main 侧在**首次带该 authority 调用时懒挂载**订阅（`_remoteConfigSubscribed`），并**一律经 `IRemoteConnectionService.getServiceProxy` 取 channel**，勿自缓存代理（stop/reconnect 后会拿到死代理）。
- `ConfigFileLink` 传 `authority` 后用 `remoteFsPathToUri` 打开远端文件；`runClaudeLogin` remote 分支不解析本地 binary，改在远端终端跑 PATH 上的 `claude auth login`。
- **BinaryPanel 远程语义**：远端下版本信息/强制下载经 `IClaudeBinaryService.getVersionInfo/forceDownload` 的尾部 `authority` 走 `RemoteChannels.AgentBinary` 作用于远端主机；面板隐藏「Binary source」区（远端固定受管下载），进度事件按 `authority` 过滤，authority 切换先清陈旧 versionInfo。`prefetch`/`cleanupStaleVersions` 同样带尾部 `authority`：空闲维护（`AgentBinaryPrefetchContribution`）在远程工作区下只作用于远端主机、不看本地 `acp.claude.source`，且门控在「已连接」状态上以免后台触发一次用户没要求的 SSH 连接/安装。

### 🔒 安全约束（刻意决策，勿擅改）

1. **凭据明文落盘是用户明确选择**：provider 条目的 key 明文写进 `aiSettings.json` 的 `providers[]`（见套路 I）；选中某 provider 时把派生的 env 写进 `settings.json`（与 CLI 共享）。**刻意**不用加密 SecretStorage。
2. **`readAuthStatus()` 绝不回传 OAuth token**：只回 `{loggedIn, expired, subscriptionType?, expiresAt?}`。有测试断言 token 不泄漏，改 readAuthStatus 时务必保住该测试。`resolveActiveAuth` 同理——只回 `{kind, providerId?}`，**远端的 token/key 绝不回传**（比对在读到文件的那一侧做完）。

### 常见任务 → 改哪里

- **给 Claude 加一个新设置项**：定字段进 `ClaudeSettings`/`ClaudeSettingsPatch`（契约）→ main 实现读写 → 对应面板（model 类→ModelThinkingPanel、env 类→AdvancedEnvPanel、认证类→AuthenticationPanel + `AUTH_ENV_KEYS`）加 UI，经 `useClaudeConfig().patch` 落盘。
- **给 Claude 加一个模型相关的结构化选择项**：直接在 `useClaudeConfig` 加走 `applyModelPick` 的 setter（只 patch 它关联的那个 settings.json 键），面板加一行 `ModelPickRow` 显示有效 id；若它对应一个 env key，记得在 `AdvancedEnvPanel` 隐藏。**不要在编辑器侧另存一份镜像。**
- **给 claudeConfig 加一个跨进程方法**：只改契约 + main 实现两个文件（5 处接线不动）。
- **再加一个 acp agent 的设置页（如 codex）**：新建 `agentSettings/codex/CodexAgentSettings.tsx`，末行 `registerAgentSettings('codex', CodexAgentSettings)`；在 `builtinAgentSettings.ts` 加一行 `import './codex/CodexAgentSettings.js'`。**壳零改动**——只要该 agent 在 `IAcpAgentRegistry.list()` 里，就会自动出现在 Settings 的 Agents 组。Codex 的设置页已存在，其凭据模型（双文件 config.toml/auth.json、resolved_mode 优先级、双维度 auth 状态、fs.watch 实时刷新）与 Claude 不同，见 [`../codex/CLAUDE.md`](../codex/CLAUDE.md)。
- **加一种认证来源**：改**反查纯函数** `resolveClaudeActiveAuth`（`shared/ai/agentActiveAuth.ts`）+ 它的逆向 `applyAuthentication` 互斥注入逻辑 + `AuthenticationSection`/`GatewayProviderPicker`。**两侧必须同时改**，并在 `agentActiveAuth.test.ts` 补一条往返用例——只改一侧就会出现「写进去反查不回来」。
- **接入第三方模型（Kimi/GPT 等）**：无需新代码——先在 AI 设置里建一个 `anthropic-messages` 协议的 provider 条目（baseUrl+key），认证选择选它；还可设 `model`/`subagentModel`（分别写 `settings.model` 与 `env.CLAUDE_CODE_SUBAGENT_MODEL`，后者解决子 agent 被 CLI 改写成 opus 的问题）。Claude Code 只说 Anthropic 协议：Kimi 有原生兼容端点直连，GPT 需 LiteLLM/claude-code-router 代理转协议。用户文档见 `docs/user/zh-CN/ai-agent/models-and-cost.md`。

### 易踩坑速记

- `useObservable` / `useService` 来自 `renderer/workbench/useService.ts`（即面板里的 `../../useService.js` / `../useService.js`），**不是** `@universe-editor/workbench-ui`。
- workbench-ui 的 `IconButton` API 是 `label: string` 属性 + `children` 放图标：`<IconButton label="编辑"><Pencil size={14}/></IconButton>`，没有 `icon`/`ariaLabel` props。
- ESM：相对导入带 `.js` 后缀（即使源是 `.ts`）。`claude/` 比外壳深一层，import 路径多一级 `../`。
- 状态持久化套路：`IStorageService` 存 key + `restoredRef` 守卫防覆盖 + `requestAnimationFrame` 恢复滚动。
- NLS：`localize(key, '英文默认值', vars?)`，默认值必须英文；中文写进 `shared/i18n/messages/zh-CN.ts`。当前该子系统多用内联文案，若新增 key 记得补 zh-CN。
- 新增 FakeSession 测试桩别忘 `onDidRequireAuth: Event.None`（认证流相关）。
- 未跟踪文件用 `git mv` 会失败（exit 128），用普通 `mv`。

### 验证

- `pnpm check`（lint + typecheck + test，输出长，只截错误）。
- 改交互逻辑跑 `pnpm e2e`。已知本机 flaky（非回归）：simpleFileDialog / multiFileDragEditor / explorerExternalWatcher / markdown* @p1（多 worker / exthost 环境问题，单跑必过）。

### 入口（打开到 Agents 区）

- 主入口：命令 `ai.manageModels`（标题 “Open AI & Agent Settings”）打开统一 Settings editor。
- agent 专用入口：命令 `workbench.action.agent.openSettings`（`actions/agentActions.ts` 的 `OpenAgentSettingsAction`）——先 `storage.set('settings.activeItem', 'agent:<defaultAgentId>')` 再打开 `AiSettingsEditorInput`，落点直接在 Agents 区。**此命令 ID 被 AcpSessionEditor 齿轮、`acpSessionService`（两处）引用，勿改 ID。**

### 关键参考路径

- 承载壳：`renderer/workbench/ai/AiSettingsEditor.tsx`（Agents 组渲染 + 激活项持久化）→ 见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)
- 贡献注册：`renderer/workbench/agentSettings/{agentSettingsRegistry.ts,builtinAgentSettings.ts}`
- Claude 内容：`renderer/workbench/agentSettings/claude/*` + `agentSettings/AgentSettingsEditor.module.css`
- 服务：`shared/ipc/claudeConfigService.ts`、`main/services/claudeConfig/claudeConfigMainService.ts`
- 编辑器输入：`renderer/services/editor/AiSettingsEditorInput.ts`（TYPE_ID `aiSettings`，URI `universe:/aiSettings`）— 注意 `AgentSettingsEditorInput` 已删
- 入口命令：`renderer/actions/agentActions.ts`（`OpenAgentSettingsAction`）、`renderer/actions/aiActions.ts`（`ManageModelsAction`）
- agent 注册表：`renderer/services/acp/acpAgentRegistry.ts`（`IAcpAgentRegistry`、`BUILTIN_AGENTS`、`agentIconId()`）

