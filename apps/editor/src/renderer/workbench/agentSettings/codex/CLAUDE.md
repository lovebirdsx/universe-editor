# apps/editor/src/renderer/workbench/agentSettings/codex/CLAUDE.md

> Codex agent 设置面板内容本体（`services/acp/CLAUDE.md` 的子域）。协议层与 ACP 全景见 [`../../../services/acp/CLAUDE.md`](../../../services/acp/CLAUDE.md)；Claude 同类子系统见 [`../claude/CLAUDE.md`](../claude/CLAUDE.md)。与 Claude 共用外壳与贡献注册表，**凭据模型完全不同**。

## Agent 设置：Codex

> 代码不在 `services/acp/` 下：UI 在 `agentSettings/codex/`，main 实现在 `main/services/codexConfig/`，wire 契约在 `shared/ipc/codexConfigService.ts`。承载壳见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)。

Codex 复用 Claude 的贡献机制，但状态摊在**两个文件**（config.toml + auth.json）：一个 `auth.json` 同时容纳 ChatGPT OAuth token 块和 `OPENAI_API_KEY`，靠 `auth_mode` 决定用哪个。凭据模型演进与机制细节全文见 [cases-credential-model.md](cases-credential-model.md)。

### 文件 → 职责

Renderer — 贡献注册（与 Claude 共用，见 [`../claude/CLAUDE.md`](../claude/CLAUDE.md) §文件 → 职责）。

Renderer — Codex 专属（agentSettings/codex/）：
- `codex/CodexAgentSettings.tsx` — 根组件：`useCodexConfig()` + 五分类子导航（auth/model/safety/advanced/binary），激活分类/滚动持久化（`agent.settings.codex.activeCategory`/`.scroll.<id>`）。**末行 `registerAgentSettings('codex', CodexAgentSettings)`**；仅 `config.loaded` 后渲染。
- `codex/CodexAuthenticationPanel.tsx` — 认证页：`AuthenticationSection`（provider 条目或 `@subscription`）+ `LoginForm`。**下拉当前值是盘上生效值**（从 `activeAuth` 反查、非声明值；providerId 缺席 → 「外部凭据」）；`GatewayProviderPicker`（`protocol="openai-responses"`），派生经 `deriveCodexGateway`；**没有 drift 警告**（盘上即真相）与 "In use" 徽章；`overridden` 时显示 "a saved credential is currently taking precedence."。完整行为见 [cases-credential-model.md](cases-credential-model.md)。
- `codex/CodexModelPanel.tsx` / `CodexSafetyPanel.tsx` / `CodexAdvancedPanel.tsx` — model / model_provider（blur 提交）/ model_reasoning_effort；approval_policy + sandbox_mode；cli_auth_credentials_store + hide_agent_reasoning + 自由标量键编辑器。均绑 config.toml（Advanced 只编标量，嵌套表留给原始文件）。
- `codex/useCodexConfig.ts` — 聚合 settings/authStatus/**activeAuth**；**凭据切换统一走 `service.applyCredential(intent)`**；`setModel` 只 `patch({model}, authority)`（不镜像）；订阅 `onDidChangeAuth` 后**三样都重读**。
- `codex/codexLogin.ts` — `runCodexLogin()` 跑系统 PATH 的 **`codex login`**（官方 CLI；**不是 codex-acp**——它没有 `login` 子命令）。

跨进程三层：
- `shared/ipc/codexConfigService.ts` — **wire 契约**：`ICodexConfigService` + 类型（`CodexSettings`（含 `model_provider`/`model_providers?`）/`Patch`/`AuthStatus`/**`CodexCredentialIntent`**（三 kind 见下）+ 枚举 ReasoningEffort/ApprovalPolicy/SandboxMode/CredentialStore；`AgentActiveAuth` 来自 `shared/ai/agentActiveAuth.ts`）。方法：`read`/`patch`/`configPath`/`readAuthStatus`/**`applyCredential`**/**`resolveActiveAuth`**/`checkGatewayConnectivity` + 事件 `onDidChangeAuth`。
- `main/services/codexConfig/codexConfigMainService.ts` — 按 authority 路由（本地 → `CodexConfigStore`，远端 → `RemoteChannels.AgentConfig`）+ `resolveActiveAuth`（交纯函数 `resolveCodexActiveAuth`）；provider 条目走 `aiSettingsProviders.ts`。
- `packages/node-services/src/agentConfig/{codexConfigStore.ts,types.ts}` — **文件存储层**（main 与 remote server 共享）：`applyCredential` + `reconcileGatewayProvider` + `_startAuthWatch()`/`dispose()` 全在这里。
- `__tests__/codexConfigMainService.test.ts` — readAuthStatus（不泄漏凭据）+ applyCredential（token 保留/残留清理/保留手写 provider）+ onDidChangeAuth + remote resolveActiveAuth。

### codexConfig 服务接线（6 处）

只改契约 + main 实现两个文件（`onDidChange*` 事件经 ProxyChannel 自动透传）：
- main 侧：`main-services.ts`（`SyncDescriptor`，`[undefined]`=configPath 默认）→ `scopedServicesFactory.ts`（readonly codexConfig）→ `registerMainServices.ts`（ProxyChannel.fromService）
- 通道 + renderer：`channelNames.ts`（`CodexConfig:'codexConfig'`）→ `renderer/ipc/registerProxyServices.ts`（**Codex 在这里注册，不在 renderer/main.tsx——与 Claude 不同**）

### 两个配置文件 + 认证选择的语义

`$CODEX_HOME`（默认 `~/.codex`）下：

| 文件 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `config.toml` | 编辑器 + CLI 共享 | agent/CLI | model / reasoning / approval / sandbox / 顶层 `model_provider` / `[model_providers.*]`；smol-toml 解析，**就地编辑保留未管理键** |
| `auth.json` | `codex login`（ChatGPT）/ 编辑器（API key） | agent/CLI | JSON。可**同时**含 `OPENAI_API_KEY` + `tokens`（ChatGPT OAuth 块）+ `auth_mode` |

- gateway 自包含写进 `[model_providers.codex-gateway]` + 顶层 `model_provider` 指向它，**不碰 auth.json 的 ChatGPT token 块**（只删 `OPENAI_API_KEY` 并调 `auth_mode`）；ChatGPT/官方 API key 走 auth.json + 顶层 `model_provider` 留空。
- ChatGPT 登录不是 provider 条目（`codex login` 管的单一共享登录，与认证选择平行）。
- `patch` 里把某键设 `null` = 删除该键（清残留 `openai_base_url` 的唯一办法）。
- **编辑器只靠改这两个文件控制 codex**：绝不调 ACP `authenticate`、绝不注入 `MODEL_PROVIDER`/`CODEX_CONFIG` 环境变量（那些只被 codex-acp 的 `index.ts` 读）。

### 三种登录方案

| 方案 | 凭据存哪 | 用哪个 provider |
|---|---|---|
| ChatGPT 登录(Plus/Pro) | auth.json `tokens` 块 + `auth_mode:"chatgpt"` | 内置 `openai` |
| 官方 OpenAI API Key | auth.json `OPENAI_API_KEY` + `auth_mode:"apikey"` | 内置 `openai` |
| 自定义 gateway | provider 自己的 `experimental_bearer_token` | 独立命名 provider |

- 契约三 kind；当前面板只提供 gateway 与 ChatGPT 两条，**没有官方 API Key 输入框**——`{kind:'apiKey'}` 是保留能力，renderer 从不发它。
- **最关键的解析规则**：ChatGPT 与 API Key 都走内置 `openai`，而内置 `openai` **仅在顶层 `model_provider` 为空/未设时才生效**——一旦指向自定义 provider，auth.json 里的登录就被绕过（`auth_mode` 仍报 chatgpt/apikey 也没用，"误显 In Use" 根因）。
- **gateway 必须自包含**（镜像手写 `[model_providers.acme]`）：`experimental_bearer_token`=key 落盘、`supports_websockets=false`、顶层 `model_provider` 指向它；三条「绝不」与历史错误见易踩坑与 cases。

### 统一入口 applyCredential(intent)

三种凭据切换全部走 main 的 `applyCredential(intent)`，**一次原子写齐 auth.json + config.toml**，返回最新 `CodexAuthStatus`。要点：chatgpt **保留 token 不登出**、gateway 只删 key 不动 token、**保留手写 provider**；**ChatGPT + API key 可共存**。三意图全文见 [cases-credential-model.md](cases-credential-model.md)。

### resolved_mode（auth.json 内部：ChatGPT vs API key 选谁）

`_resolveAuthMode()` **镜像 codex-rs `resolved_mode()`**（login/src/auth/manager.rs）：显式 `auth_mode` 优先 > `OPENAI_API_KEY` 存在 > `tokens.access_token` > none。只决定 auth.json 内部用 token 还是 key，**与顶层 `model_provider` 是否生效是两码事**；`applyCredential` 据此锁 mode。

### 「真正 In Use」：main 的 resolveActiveAuth（renderer 不要自己推）

`CodexAuthStatus` 是**两个独立维度**，只反映 auth.json：`{active, chatgpt?, hasApiKey}`（token 块与 key 可共存，单一 method 曾误显成「登出」，历史见 cases）。改 `readAuthStatus` 务必保住两维度语义。

但 authStatus 看不到顶层 `model_provider` 的覆盖 → 判定收口到 main 的 `resolveActiveAuth(authority?)`（共享纯函数 `resolveCodexActiveAuth`，`shared/ai/agentActiveAuth.ts`，claude 同文件），只回 `AgentActiveAuth {kind:'subscription'|'provider'|'none', providerId?}`。**没有 `drift` 字段**（配置即唯一真相，`agentSettings.codex` 已废弃）。

判定顺序：
1. 顶层 `model_provider` 指向**任何非空且非 `openai`** 的名字 → `kind:'provider'`（读 `[model_providers.<name>]`，`deriveCodexGateway` 派生比对，`base_url`+`experimental_bearer_token` 全等回 `providerId`；早先只认硬编码名有盲区）。
2. 手写/外部 gateway 匹配不上 → `kind:'provider'` 但 providerId 缺席，**刻意不归属**（「外部凭据」，开销「—」，账号用量 hidden；硬猜把钱记到别人账上）。
3. 否则（`model_provider` 空/未设或显式 `='openai'`）→ `authStatus.active==='chatgpt'` ? `kind:'subscription'` : `'none'`。

baseUrl **逐字比对不做归一化**；同 baseUrl+key 按文件序**确定性 first-match**。**面板消费 `activeAuth.kind`/`.providerId` 即可，不要在 renderer 重建推理**（builtinActive 误显历史见 cases）。远端同理：**秘密绝不回传**。

### auth.json 实时刷新

`_startAuthWatch()` 用 `fs.watch` 监听 **`~/.codex` 目录**（不是文件）：temp+rename 原子写，**文件级 watch 会丢事件**。文件名过滤 `{auth.json, config.toml}`——config.toml 也在内（否则手改 model 不刷新）；**不能去掉过滤**（sessions/rollouts 高频写入）。150ms 去抖 fire `onDidChangeAuth`。远端经 `onDidChangeCodexAuth` 转发。

### Remote 工作区路由

与 Claude 同构（契约方法带尾部 `authority`，经 `RemoteChannels.AgentConfig` 转发，协议路径见 claude 文档，改协议须 bump `REMOTE_PROTOCOL_VERSION`；**authority 必须来自 `useRemoteAuthority()`**；归属按主机分区且**看会话所在主机**；**一律经 `IRemoteConnectionService.getServiceProxy` 取 channel，勿自缓存代理**）。共享条目与踩坑见 [`../claude/CLAUDE.md`](../claude/CLAUDE.md) §Remote 工作区路由。Codex 特有：
- `resolveActiveAuth(authority)` 比对**生效端**凭据：main 读远端 config.toml / auth.json 与本地派生的 baseUrl/key 比对，只回 `{kind, providerId?}`——**远端 auth.json 秘密绝不回传**。
- `ConfigFileLink` 传 `authority` 开远端文件；`runCodexLogin` 本就开远端终端跑 `codex login`。
- **CodexBinaryPanel 远程语义**：版本/强制下载经 `ICodexBinaryService` 尾部 `authority` 走 `RemoteChannels.AgentBinary`；远端隐藏「Binary source」区；`prefetch`/`cleanupStaleVersions` 同样带 authority。

### 🔒 安全约束（刻意决策，勿擅改）

1. **凭据明文落盘是用户明确选择**：provider 条目 key 明文进 `aiSettings.json` `providers[]`（套路 I）；认证选择只存 provider id，应用时才把派生 baseUrl + `experimental_bearer_token` 写 `config.toml`（与 CLI 共享），官方 API key 走 `auth.json`。**刻意**不用加密 SecretStorage。
2. **`readAuthStatus()` 绝不回传 token / API key 值**：只回 `{active, chatgpt?:{expired,planType?,expiresAt?}, hasApiKey}`。有测试（"never returns the credentials themselves"）断言不泄漏，改动务必保住。

### 常见任务 → 改哪里

- **给 Codex 加一个 config.toml 设置项**：定字段进 `CodexSettings`（契约）→ 对应面板（model 类→CodexModelPanel、审批/沙箱→CodexSafetyPanel、其它标量→CodexAdvancedPanel）→ `useCodexConfig().patch` 落盘（`null` 删键）。main 的 `read`/`patch` 是通用 TOML 合并，**通常无需改**。
- **给 codexConfig 加跨进程方法/事件**：只改契约 + main 实现（6 处接线不动，`onDidChange*` 自动透传）。
- **改认证逻辑**：先想清楚落在哪个登录方案 + `resolved_mode` 哪一步。动 `applyCredential`/`reconcileGatewayProvider`（node-services 的 `codexConfigStore.ts`）必须同时维护 `auth_mode` 与顶层 `model_provider`；动 `readAuthStatus` 必须保住 `active`+`chatgpt` 两维度 + no-token-leak 测试。
- **加一种认证来源**：扩 `CodexCredentialIntent`，改 `applyCredential`/`reconcileGatewayProvider`（落到 auth.json + config.toml）+ `AuthenticationSection`/`GatewayProviderPicker` + 反查纯函数 `resolveCodexActiveAuth`（**不要在 renderer 加判断**）。两侧必须同时改，并在 `agentActiveAuth.test.ts` 补往返用例——只改一侧就「写进去反查不回来」。
- **再加一个 acp agent 的设置页**：见 [`../claude/CLAUDE.md`](../claude/CLAUDE.md) §常见任务（壳零改动）。

### 易踩坑速记

- **Codex ≠ Claude 差异**：proxy 注册在 `registerProxyServices.ts` 非 main.tsx；登录走系统 PATH 的 `codex` CLI（非自下载二进制）；单文件 auth.json 共存两种凭据。
- **gateway 必须自包含**：key 写 `experimental_bearer_token`、`supports_websockets=false`、顶层 `model_provider` 指向它；绝不 `openai_base_url`、绝不 `requires_openai_auth`、绝不动 auth.json。
- **生效判定走 main 的 `resolveActiveAuth`**：光看 `authStatus.active` 会误显；面板消费 `activeAuth.kind`/`.providerId`，不要再在 renderer 推。
- `useService` 来自 `renderer/workbench/useService.ts`（不是 workbench-ui）；`IconButton` 无 `icon`/`ariaLabel`；ESM 相对导入带 `.js`；持久化 `IStorageService`+`restoredRef`+`requestAnimationFrame`；NLS default 必须英文、新增补 zh-CN.ts。
- react-hooks/rules-of-hooks：hook-library 方法**不要**用 `use` 前缀（`applyAuthentication` 不叫 `useAuthentication` 的原因）。
- 测试验事件：`new Promise` 挂订阅 + sleep 50ms 等 watcher 挂上再写 + `Promise.race` 超时。

### 验证

- `pnpm check`（lint + typecheck + test，只截错误）；codexConfig 测试单跑：`pnpm vitest run src/main/services/codexConfig`。
- 改交互跑 `pnpm e2e`（本机 flaky 非回归：窗口拆除 `Target page... has been closed`、simpleFileDialog / multiFileDragEditor / explorerExternalWatcher / markdown* @p1；冒烟**不覆盖 codex 登录场景**，改面板后 e2e 全绿即可）。

### 关键参考路径

- 承载壳：`renderer/workbench/ai/AiSettingsEditor.tsx`（见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)）
- 贡献注册：`renderer/workbench/agentSettings/{agentSettingsRegistry.ts,builtinAgentSettings.ts}`
- Codex 内容：`renderer/workbench/agentSettings/codex/*` + `AgentSettingsEditor.module.css`
- 服务：`shared/ipc/codexConfigService.ts`、`main/services/codexConfig/codexConfigMainService.ts`、`packages/node-services/src/agentConfig/{codexConfigStore.ts,types.ts}`
- codex 二进制：`shared/ipc/codexBinaryService.ts`、`main/services/codexBinary/*`
