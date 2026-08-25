# apps/editor/src/renderer/workbench/agentSettings/codex/CLAUDE.md

> 本文是 `services/acp/CLAUDE.md` 的子域文档（Codex agent 设置面板），原为其「Agent 设置：Codex」章。协议层与 ACP 全景见 [`../../../../services/acp/CLAUDE.md`](../../../../services/acp/CLAUDE.md)；Claude 同类子系统见 [`../claude/CLAUDE.md`](../claude/CLAUDE.md)。

## Agent 设置：Codex

> **代码不在 `services/acp/` 下**：UI 在 `apps/editor/src/renderer/workbench/agentSettings/codex/`，main 实现在 `apps/editor/src/main/services/codexConfig/`，wire 契约在 `apps/editor/src/shared/ipc/codexConfigService.ts`；与 Claude 设置共用同一外壳与贡献注册表（见 [`../claude/CLAUDE.md`](../claude/CLAUDE.md)），但凭据模型完全不同。

Codex 是接入统一 Settings editor「Agents」组的 acp agent 之一。它**复用** Claude 那套贡献机制(`agentSettingsRegistry` + `builtinAgentSettings`),但**凭据模型与 Claude 完全不同**:Codex 把状态摊在两个文件里,且一个 `auth.json` 同时容纳 ChatGPT OAuth token 块和 `OPENAI_API_KEY`,靠 `auth_mode` 字段决定用哪个。本节只讲 **Codex 设置内容本体**。

> 🔀 **承载壳**(AI/Agents 双组导航、激活项持久化、入口命令)见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md);**Claude 同类子系统**见 [`../claude/CLAUDE.md`](../claude/CLAUDE.md)(两者共用 `agentSettingsRegistry` / `builtinAgentSettings` / `AgentSettingsEditor.module.css`)。

### 文件地图

#### Renderer — 贡献注册(与 Claude 共用)
- `agentSettings/agentSettingsRegistry.ts` — `registerAgentSettings(agentId, component)` / `getAgentSettingsComponent(agentId)`。
- `agentSettings/builtinAgentSettings.ts` — 副作用聚合 hub,已有 `import './codex/CodexAgentSettings.js'`。
- `agentSettings/AgentSettingsEditor.module.css` — 面板共用样式(`agentBody`/`subNav`/`subBody`/`navItem`/认证表单/状态行),`--ue-*` token。Claude / Codex 共用。

#### Renderer — Codex 专属(agentSettings/codex/)
- `codex/CodexAgentSettings.tsx` — 根组件。持有单个 `useCodexConfig()`,五分类子导航(`CATEGORIES`:auth/model/safety/advanced/binary),激活分类 + 滚动位置经 `IStorageService` 持久化(`agent.settings.codex.activeCategory`、`agent.settings.codex.scroll.<id>`)。**末行 `registerAgentSettings('codex', CodexAgentSettings)`。** 仅 `config.loaded` 后渲染面板。
- `codex/CodexAuthenticationPanel.tsx` — 认证页,**最复杂**。两块:`AuthenticationSection`(单一认证选择:选一个 provider 条目或 `@subscription` + model 下拉)与 `LoginForm`(ChatGPT 登录状态 + 登录按钮)。**下拉当前值不是编辑器存的声明值,而是从 `activeAuth` 反查出的盘上生效值**(`kind==='provider'` → 该 `providerId`;`kind==='subscription'` → `@subscription` 哨兵;`providerId` 缺席 → 显示「外部凭据」提示)。下拉用共享组件 `../GatewayProviderPicker.js`(`protocol="openai-responses"`),派生经 `shared/ai/providerDerivation.ts` 的 `deriveCodexGateway`。**生效判定走 main 的 `resolveActiveAuth(authority)`(见下同名一节)**:`kind==='subscription'` = ChatGPT 登录生效,`kind==='provider'` = gateway 生效。**没有 drift 警告**——盘上即真相,无从漂移。`currentModel` 读 `config.settings.model`(config.toml),并照 claude 的 `pinCurrent` 保留「不在候选中但仍生效」的置顶项(否则复刻 claude 已修过的「选项凭空消失」)。`signedIn = !!chatgpt && !chatgpt.expired`(token 过期走 "Login expired" 分支,不显示 "Signed in");`overridden = signedIn && !chatgptActive`(登录了但被 gateway 顶掉——当前面板没有官方 API key 入口)时显示 "a saved credential is currently taking precedence." + "Use this login"。**没有 "In use" 徽章**(与 claude 侧对称):下拉里选中的就是盘上生效的,徽章只是把同一件事说第二遍;`chatgptActive` 保留下来只为算 `overridden`。
- `codex/CodexModelPanel.tsx` — model / model_provider(free-text,blur 提交) / model_reasoning_effort(select 即时写),绑 config.toml。
- `codex/CodexSafetyPanel.tsx` — `approval_policy` + `sandbox_mode` 两个 select,绑 config.toml。
- `codex/CodexAdvancedPanel.tsx` — `cli_auth_credentials_store` 选择 + `hide_agent_reasoning` 开关 + 自由标量键编辑器。隐藏其他面板管的键(model/approval/sandbox/base URL),只编标量(嵌套表如 `[model_providers.*]` 留给原始文件)。
- `codex/useCodexConfig.ts` — 配置 hook。聚合 settings/authStatus/**activeAuth**(盘上生效凭据的反查结果)读取与 patch。**所有凭据切换统一走 `service.applyCredential(intent)`**(见下「三种登录方案」):`applyAuthentication` 据认证选择发 `{kind:'gateway',baseUrl,apiKey,providerName}`(gateway 的 baseUrl/apiKey/providerName 由选中的 provider 条目经 `deriveCodexGateway` 派生) 或 `{kind:'chatgpt'}`(选 `@subscription`);`setModel` **只** `patch({model}, authority)` 写 config.toml(编辑器侧不再镜像 `agentSettings.codex.model`)。**没有** `setApiKey`/`ensureCodexGatewayProvider`/`BASE_URL` 常量了(均被 `applyCredential` 取代)。`activeAuth` 来自 `resolveActiveAuth(authority)`。**订阅 `onDidChangeAuth`** 实现 auth.json / config.toml 落盘后实时刷新——回调里**三样都重读**(`read` + `readAuthStatus` + `resolveActiveAuth`),因为 watch 现在也覆盖 config.toml,settings 本身会变。
- `codex/codexLogin.ts` — `runCodexLogin()` 开集成终端跑 **`codex login`**(系统 PATH 的官方 codex CLI)。**注意:不是 codex-acp**——我们为 agent 下载的 `codex-acp` adapter 没有 `login` 子命令,OAuth 归官方 `codex` CLI。

#### 跨进程服务三层
- `shared/ipc/codexConfigService.ts` — **wire 契约**。`ICodexConfigService` 装饰器 + 全部类型(`CodexSettings`(含 `model_provider` / `model_providers?: Record<string,unknown>`)/`CodexSettingsPatch`/`CodexAuthStatus`/**`CodexCredentialIntent`** + 枚举 `CodexReasoningEffort`/`CodexApprovalPolicy`/`CodexSandboxMode`/`CodexCredentialStore`;`AgentActiveAuth` 来自 `shared/ai/agentActiveAuth.ts`)。方法:`read`/`patch`/`configPath`/`readAuthStatus`/**`applyCredential(intent)`**/**`resolveActiveAuth(authority?)`**/`checkGatewayConnectivity` + 事件 `onDidChangeAuth`。`readAgentSettings`/`writeAgentSettings` 与 `CodexAgentSettings`/`CodexActiveAuth` 已删。`CodexCredentialIntent` 是判别联合:`{kind:'gateway',baseUrl,apiKey,providerName?}` | `{kind:'apiKey',apiKey}` | `{kind:'chatgpt'}`。
- `main/services/codexConfig/codexConfigMainService.ts` — **main 服务**。`extends Disposable`。职责是**按 authority 路由**(本地 → `CodexConfigStore`,远端 → `RemoteChannels.AgentConfig`)+ `resolveActiveAuth`(并行 `read`/`readAuthStatus`/`readResolvedProviders` 后交给共享纯函数 `resolveCodexActiveAuth`;原先本文件里的 `computeCodexActiveAuth`/`computeDrift`/`matchingProviderId` 已搬进 `shared/ai/agentActiveAuth.ts` 并删除)。provider 条目读取走共享 helper `main/services/ai/aiSettingsProviders.ts` 的 `readResolvedProviders`(claude 侧同一份)。
- `packages/node-services/src/agentConfig/{codexConfigStore.ts,types.ts}` — **文件存储层**(main 与 remote server 共享)。`CodexAuthStatus`/`CodexCredentialIntent` 的类型定义、原子写(mkdir -p + temp + rename)、读容错(缺失/损坏返回空)、`applyCredential` + 内部纯函数 `reconcileGatewayProvider(current, intent)`(见下「三种登录方案」)、`_startAuthWatch()` 与 `dispose()` 关 watcher，**全在这里**,不在 main 服务文件里。
- `main/services/codexConfig/__tests__/codexConfigMainService.test.ts` — readAuthStatus(含共存 + 优先级 + "never returns the credentials themselves")+ `applyCredential`(gateway 自包含 provider 写入 / chatgpt-token 保留 / 残留 base_url 清理 / 保留用户手写 provider 如 `[model_providers.kuro]`)+ `onDidChangeAuth` 事件;文件末尾另有一个 `CodexConfigMainService — remote resolveActiveAuth` describe 覆盖远端路由下的反查。

### codexConfig 服务接线(6 处,加方法时无需动)

服务方法 + `onDidChange*` 事件都走 `ProxyChannel`(事件自动透传),**给 `ICodexConfigService` 加方法只改契约 + main 实现两个文件,下面 6 处接线不用动**:
1. `main/services/main-services.ts` — `SyncDescriptor<ICodexConfigService>(CodexConfigMainService, [undefined], false)`(`[undefined]` = configPath 用默认)
2. `main/window/scopedServicesFactory.ts` — `readonly codexConfig` 字段
3. `main/ipc/registerMainServices.ts` — `ProxyChannel.fromService(app.codexConfig)`
4. `shared/ipc/channelNames.ts` — `CodexConfig: 'codexConfig'`
5. `renderer/ipc/registerProxyServices.ts` — `ProxyChannel.toService<ICodexConfigService>(...)`(**Codex 在这里注册,不在 renderer/main.tsx**——与 Claude 不同)
6. (事件无需额外接线:`ProxyChannel` 自动代理 `onDidChange*` 命名的 Emitter)

### 两个配置文件 + 编辑器认证选择的语义(关键)

`$CODEX_HOME`(默认 `~/.codex`)下:

| 文件 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `config.toml` | 编辑器 + CLI 共享 | agent/CLI | model / reasoning / approval / sandbox / 顶层 `model_provider` / `[model_providers.*]` 等。smol-toml 解析,**就地编辑保留未管理键** |
| `auth.json` | `codex login`(ChatGPT) / 编辑器(API key) | agent/CLI | JSON。可**同时**含 `OPENAI_API_KEY` + `tokens`(ChatGPT OAuth 块)+ `auth_mode` 字段 |

- **三种登录方案落地到不同位置**(见下「三种登录方案」):ChatGPT/官方 API key → auth.json + 顶层 `model_provider` 留空;gateway → 自包含写进 `[model_providers.codex-gateway]` + 顶层 `model_provider='codex-gateway'`,**不碰 auth.json 里的 ChatGPT token 块**(它仍会删掉 `OPENAI_API_KEY` 并相应调整 `auth_mode`)。gateway 块的 `base_url` / `experimental_bearer_token` 由选中的 provider 条目经 `deriveCodexGateway` 派生,不再内联在配置里。
- **ChatGPT 登录不是 provider 条目**:它是 `codex login` 管的单一共享登录,与认证选择平行。
- `patch` 里把某键设 `null` = 删除该键(清除残留 `openai_base_url` 的唯一办法)。
- **编辑器只靠改这两个文件控制 codex**:绝不调 ACP `authenticate`、绝不注入 `MODEL_PROVIDER`/`CODEX_CONFIG` 环境变量(那些只被 codex-acp 的 `index.ts` 读;编辑器不设)。

### 三种登录方案(核心——理解所有 auth 行为的钥匙)

| 方案 | 凭据存哪 | 用哪个 provider | 机制 |
|---|---|---|---|
| ChatGPT 登录(Plus/Pro) | `auth.json` 的 `tokens` 块 + `auth_mode:"chatgpt"` | 内置 `openai` | OAuth token,codex 自己刷新 |
| 官方 OpenAI API Key | `auth.json` 的 `OPENAI_API_KEY` + `auth_mode:"apikey"` | 内置 `openai` | key 作 Bearer 发往 api.openai.com |
| 自定义 gateway(kurogames) | provider 自己的 `experimental_bearer_token` | 独立命名的 provider | 与 OpenAI auth 无关 |

> 表格是 **main 层契约(`CodexCredentialIntent` 三 kind)支持的机制**。当前面板只提供其中两条:`AuthenticationSection` 选 provider 条目(gateway)或 `@subscription`(ChatGPT),**没有官方 OpenAI API Key 的输入框**——`{kind:'apiKey'}` 是保留能力,renderer 从不发它。

**最关键的解析规则**:ChatGPT 与 API Key **都走内置 `openai` provider**,而内置 `openai` **仅在 config.toml 顶层 `model_provider` 为空/未设时才生效**。一旦 `model_provider` 指向某自定义 provider(如 `codex-gateway`/`kuro`),auth.json 里的登录就被绕过——即便 `auth_mode`/resolved 仍报 chatgpt/apikey 也没用(这就是"误显 In Use"的根因)。

**gateway = 完全自包含的独立 provider**(镜像用户手写的 `[model_providers.kuro]`)。下方 TOML 块由选中的 provider 条目经 `deriveCodexGateway`(派生 base_url/key/name)后落盘:
```toml
model_provider = "codex-gateway"
[model_providers.codex-gateway]
name = "..."                          # = provider.id
base_url = "https://..."
wire_api = "responses"
supports_websockets = false           # 关掉 wss 探测,避免 403
experimental_bearer_token = "sk-..."  # key 直接落 config.toml(用户明确选择)
```
**绝不**碰 `auth.json`、**绝不**写顶层 `openai_base_url`、**绝不**用 `requires_openai_auth`——这三个都会把 gateway 跟 OpenAI auth 错误耦合。

**两个已修复的历史设计错误**(勿重蹈):① 用顶层 `openai_base_url` 重定向内置 `openai` → 把 ChatGPT token 发去 gateway → `access token could not be refreshed... another account`;② gateway 用 `requires_openai_auth = true` 复用 auth.json 的 key → 强行把 gateway auth 跟 ChatGPT/官方 auth 绑死。

### 统一入口 applyCredential(intent)

三种凭据切换全部走 main 的 `applyCredential(intent: CodexCredentialIntent)`,**一次原子写齐 auth.json + config.toml**,返回最新 `CodexAuthStatus`:

- `{kind:'apiKey',apiKey}`:auth.json 写 `OPENAI_API_KEY` + `auth_mode='apikey'`;config 经 `reconcileGatewayProvider` 拆掉 gateway provider+指针+残留 `openai_base_url`(回到内置 openai)。
- `{kind:'chatgpt'}`:auth.json 删 `OPENAI_API_KEY`,若仍有 ChatGPT token 则 `auth_mode='chatgpt'` 否则删 mode(**保留 token,不登出**);config 同样拆掉 gateway,顶层 `model_provider` 清空。
- `{kind:'gateway',baseUrl,apiKey,providerName?}`:auth.json 只删 key 不动 token;config 写自包含 provider + `model_provider='codex-gateway'`,删 `openai_base_url`。**保留**用户手写的其它 provider(如 `[model_providers.kuro]`)。

`reconcileGatewayProvider(current, intent)` 是纯函数,返回新 settings(无变化返回 `null`)。**ChatGPT + API key 可共存**:切到 chatgpt 只清 key、不删 token。

### resolved_mode(auth.json 内部:ChatGPT vs API key 选谁)

`_resolveAuthMode()` **镜像 codex-rs `resolved_mode()`**(login/src/auth/manager.rs)。注意它只决定 auth.json 内部用 token 还是 key,**与顶层 `model_provider` 是否生效是两码事**:

1. 显式 `auth_mode` 字段优先:`'apikey'`→apiKey;`'chatgpt'`/`'chatgptAuthTokens'`→chatgpt
2. 否则按字段存在性:`OPENAI_API_KEY` **先于** ChatGPT token 块 → apiKey
3. 否则有 `tokens.access_token` → chatgpt
4. 都没有 → none

(`personalAccessToken`/`bedrockApiKey`/`agentIdentity` 这几个 mode 本面板不展示,走第 2 步兜底。)

`applyCredential` 据此锁定 mode:写 key 时 `auth_mode='apikey'`;切 chatgpt 时清 key、若 token 还在则 `auth_mode='chatgpt'` 否则删 mode。

### "真正 In Use" 怎么判：main 的 resolveActiveAuth（renderer 不要自己推）

`CodexAuthStatus` 是**两个独立维度**，只反映 auth.json：

```ts
interface CodexAuthStatus {
  active: 'apiKey' | 'chatgpt' | 'none'   // auth.json 内部解析谁是凭据(resolved_mode)
  chatgpt?: { expired, planType?, expiresAt? }  // 只要 token 块在盘上就有
  hasApiKey: boolean                       // auth.json 里有 OPENAI_API_KEY
}
```

**为何不是单一 `method`**:Codex 的 auth.json 本就让 token 块和 API key 共存。早先用单一 active 方式上报,导致"应用 API key"看起来像把 ChatGPT 登录**登出**了(其实 token 还在盘上)。改成两个独立维度后,API key 生效时面板仍显示 "Signed in",与 Claude 的共存行为一致。改 `readAuthStatus` 时务必保住这两个维度的语义。

**但 `authStatus` 不足以判"真正生效"**——它看不到 config.toml 顶层 `model_provider` 的覆盖，也不知道盘上那个 gateway 对应编辑器里的哪个 provider 条目。所以判定**整体收口到 main** 的 `resolveActiveAuth(authority?)`，内部是共享纯函数 `resolveCodexActiveAuth`（`shared/ai/agentActiveAuth.ts`，claude 侧同文件），只回两个字段：

```ts
interface AgentActiveAuth {
  kind: 'subscription' | 'provider' | 'none'
  providerId?: string   // kind==='provider' 且盘上 gateway 能反查到某条目时
}
```

**没有 `drift` 字段了**：agent 自己的配置文件就是唯一真相，编辑器不再存声明值（`agentSettings.codex` 已废弃、不再被读取），所以不存在「声明与盘上不一致」这回事。

判定顺序：
1. 顶层 `model_provider` 指向**任何非空且非 `openai`** 的名字 → `kind:'provider'`；读该名字的 `[model_providers.<name>]` 块，再用 `deriveCodexGateway` 逐个派生本地 provider 条目，`base_url` + `experimental_bearer_token` 全等才回 `providerId`。**放宽点**：早先只认硬编码的 `'codex-gateway'`，用户手写 `[model_providers.kuro]` + `model_provider='kuro'` 会被误报 `none`（真实盲区）。
2. 手写/外部 gateway 匹配不上任何条目 → `kind:'provider'` 但 `providerId` 缺席，**刻意不归属**（面板显示「外部凭据」，会话开销「—」，账号用量 hidden）。硬猜会把钱记到别人账上。
3. 否则（`model_provider` 为空/未设，或显式 `='openai'` 即内置）→ `authStatus.active === 'chatgpt'` ? `kind:'subscription'` : `'none'`。

baseUrl **逐字比对不做 URL 归一化**（写盘值与反查值同源）；两条目同 baseUrl+key 时按 aiSettings.json 文件序**确定性 first-match**。

**踩坑历史**：早先 renderer 自己叠 `builtinActive`，漏掉它就会在 gateway 顶层生效时把 ChatGPT 误显 "In Use"（两处徽章同时亮，徽章现已删除）。现在这个叠加是上面第 3 步的一部分——**面板消费 `activeAuth.kind`/`.providerId` 即可，不要再在 renderer 里重建这套推理**。远端场景同理：main 读远端两个文件做比对，**秘密绝不回传**。

### auth.json 实时刷新(为何登录后无需手动 refresh)

`_startAuthWatch()` 用 `fs.watch` 监听 **`~/.codex` 目录**(不是文件本身):codex login 用 temp-file + rename 原子写,**文件级 watch 会丢事件,目录级才稳**。文件名过滤是**集合 `{auth.json, config.toml}`**——config.toml 也在里面,否则手改 model/model_provider 后面板与凭据归属都不刷新;但**不能去掉过滤**,`~/.codex` 下有 sessions/rollouts 等高频写入。150ms 去抖(合并 rename 的 create/delete 对)后 fire `onDidChangeAuth`。renderer `useCodexConfig` 订阅它 → 浏览器 OAuth 流程完成、auth.json 落盘的瞬间自动刷新登录状态。`dispose()` 里 `clearTimeout` + `watcher.close()`。远端工作区下事件同样生效:remote server 侧 watch 远端 `~/.codex`,经 `onDidChangeCodexAuth` 转发回 main(main 对该事件的订阅在首次带 authority 的调用时懒挂载)。

### Remote 工作区路由(2026-08)

远端工作区下面板操作**远端主机**的 `~/.codex`:契约方法带尾部可选 `authority`(`read`/`patch`/`configPath`/`readAuthStatus`/`applyCredential`/`resolveActiveAuth`/`checkGatewayConnectivity`),main 按 authority 经 `RemoteChannels.AgentConfig` 转发(协议在 `packages/node-services/src/agentConfig/agentConfigService.ts`,改协议须 bump `REMOTE_PROTOCOL_VERSION`)。要点:
- **authority 必须来自 `useRemoteAuthority()`**(`workbench/useRemoteAuthority.ts`,订阅 `onDidChangeWorkspace`)——workspace hydration 是异步的,用 `useMemo` 读 `workspace.current` 会把 authority 冻结成 undefined(启动恢复的 tab 永远读写本地,真实踩坑)。
- `resolveActiveAuth(authority)` 比对**生效端**凭据:main 读远端 config.toml / auth.json(经 `read(authority)` / `readAuthStatus(authority)`),与本地 provider 条目派生的 baseUrl/key 比对、只回 `{kind, providerId?}`(见 `resolveCodexActiveAuth`),**远端 auth.json 的秘密绝不回传**(与 `applyCredential` 同向)。
- **凭据归属天然按主机分区**:本地用 ChatGPT 订阅、远端走网关时,会话计费与账号用量各归各位(消费方 `AcpSessionProviderContext` / `AccountUsageService` / `SubscriptionUsageService` 的缓存键都是 `agentId + authority`)。**归属看会话所在主机,不是窗口 authority**——同一窗口混合 authority 真实存在,故 `IAcpSession.authority` 一路贯通。
- `ConfigFileLink` 传 `authority` 后用 `remoteFsPathToUri` 打开远端文件;`runCodexLogin` 本就开远端终端跑 PATH 上的 `codex login`,无需改动。
- **CodexBinaryPanel 远程语义**:远端下版本信息/强制下载经 `ICodexBinaryService.getVersionInfo/forceDownload` 的尾部 `authority` 走 `RemoteChannels.AgentBinary` 作用于远端主机;面板隐藏「Binary source」区(远端固定受管下载),进度事件按 `authority` 过滤,authority 切换先清陈旧 versionInfo。`prefetch`/`cleanupStaleVersions` 同样带尾部 `authority`:空闲维护(`AgentBinaryPrefetchContribution`)在远程工作区下只作用于远端主机、不看本地 `acp.codex.source`,且门控在「已连接」状态上以免后台触发一次用户没要求的 SSH 连接/安装。

### 🔒 安全约束(刻意决策,勿擅改)

1. **凭据明文落盘是用户明确选择**:provider 条目的 key 明文写进 `aiSettings.json` 的 `providers[]`(见套路 I);认证选择只存 provider id(不内联 baseUrl/key),应用时才把派生的 baseUrl + `experimental_bearer_token` 写进 `config.toml`(与 CLI 共享),官方 API key 走 `auth.json`。**刻意**不用加密 SecretStorage。
2. **`readAuthStatus()` 绝不回传 token / API key 值**:只回 `{active, chatgpt?:{expired,planType?,expiresAt?}, hasApiKey}`。有测试("never returns the credentials themselves")断言 token / key 不泄漏到序列化结果里,改 readAuthStatus 时务必保住该测试。

### 常见任务 → 改哪里

- **给 Codex 加一个 config.toml 设置项**:定字段进 `CodexSettings`(契约)→ 选对应面板(model 类→CodexModelPanel、审批/沙箱→CodexSafetyPanel、其它标量→CodexAdvancedPanel 自动出现在自由编辑器,或给它一个专属控件),经 `useCodexConfig().patch` 落盘(`null` 删键)。main 实现的 `read`/`patch` 是通用 TOML 合并,**通常无需改**。
- **给 codexConfig 加跨进程方法/事件**:只改契约 + main 实现两个文件(6 处接线不动;`onDidChange*` 事件自动透传)。
- **改认证逻辑**:先想清楚它落在哪个登录方案 + 内部 `resolved_mode` 哪一步。动 `applyCredential`/`reconcileGatewayProvider`(在 node-services 的 `codexConfigStore.ts`)必须同时维护 `auth_mode` 与顶层 `model_provider`(否则共存语义 / In-Use 判定崩)。动 `readAuthStatus` 必须保住 `active`+`chatgpt` 两个维度 + no-token-leak 测试。
- **加一种认证来源**:扩 `CodexCredentialIntent`,改 `applyCredential`/`reconcileGatewayProvider`(它怎么落到 auth.json + config.toml)+ `AuthenticationSection`/`GatewayProviderPicker` + 激活态判定(改**反查纯函数** `resolveCodexActiveAuth`,**不要**在 renderer 里加判断)。写入侧与反查侧必须同时改,并在 `shared/ai/__tests__/agentActiveAuth.test.ts` 补一条往返用例——只改一侧就会「写进去反查不回来」。
- **再加一个 acp agent 的设置页**:新建 `agentSettings/<id>/<X>AgentSettings.tsx`,末行 `registerAgentSettings('<id>', ...)`;`builtinAgentSettings.ts` 加一行 import。壳零改动。

### 易踩坑速记

- **Codex ≠ Claude 的几处差异**:① renderer proxy 注册在 `registerProxyServices.ts`(Claude 在 main.tsx);② 登录走系统 PATH 的 `codex` CLI(Claude 走自己下载的二进制);③ 单文件 auth.json 共存两种凭据(Claude 是 `.credentials.json` + `settings.json` 两文件天然分离)。
- **gateway 必须自包含**:key 写 `experimental_bearer_token`、`supports_websockets=false`、顶层 `model_provider` 指向它。**绝不**用顶层 `openai_base_url`(会把 ChatGPT token 发去 gateway → `access token could not be refreshed`)、**绝不**用 `requires_openai_auth`、**绝不**改 auth.json。
- **生效判定走 main 的 `resolveActiveAuth`**:光看 `authStatus.active` 会误显——ChatGPT/API key 仅在顶层 `model_provider` 为空(或 `='openai'`)时才真生效。这个叠加已收口进 `resolveCodexActiveAuth`,面板消费 `activeAuth.kind`/`.providerId` 即可,**不要**在 renderer 里再推一遍。
- `useService` 来自 `renderer/workbench/useService.ts`(面板里 `../../useService.js`),**不是** `@universe-editor/workbench-ui`。
- workbench-ui 的 `IconButton`:`label: string` 属性 + `children` 放图标(无 `icon`/`ariaLabel` props)。
- ESM:相对导入带 `.js` 后缀(即使源是 `.ts`)。`codex/` 比外壳深一层,到 shared 是 `../../../../shared/...`。
- 状态持久化套路:`IStorageService` + `restoredRef` 守卫防覆盖 + `requestAnimationFrame` 恢复滚动。
- NLS:`localize(key, '英文默认值', vars?)`,默认值必须英文;新增 key 补 `shared/i18n/messages/zh-CN.ts`(当前多内联文案)。
- react-hooks/rules-of-hooks:hook-library 方法**不要**用 `use` 前缀(否则在 `useCallback` 里调会被判成"在回调里调 Hook")。这就是 `applyAuthentication` 不叫 `useAuthentication` 的原因。
- `fs.watch` 必须监听**目录**而非文件,否则 codex 的原子写(rename)会丢事件。
- 测试里验事件:`new Promise(resolve => sub = onDidChangeAuth(...))` + 先 sleep 50ms 让 watcher 挂上再写文件 + `Promise.race` 加超时。

### 验证

- `pnpm check`(lint + typecheck + test,输出长,只截错误)。codexConfig 测试单跑:`pnpm vitest run src/main/services/codexConfig`(在 apps/editor 下)。
- 改交互逻辑跑 `pnpm e2e`。已知本机 flaky(非回归):窗口拆除 `Target page... has been closed`、simpleFileDialog / multiFileDragEditor / explorerExternalWatcher / markdown* @p1(多 worker / exthost 环境问题,单跑必过)。e2e 冒烟**不覆盖 codex 登录场景**,改 codex 面板后 e2e 全绿即可。

### 关键参考路径

- 承载壳:`renderer/workbench/ai/AiSettingsEditor.tsx`(Agents 组渲染)→ 见 [`../ai/CLAUDE.md`](../ai/CLAUDE.md)
- 贡献注册:`renderer/workbench/agentSettings/{agentSettingsRegistry.ts,builtinAgentSettings.ts}`
- Codex 内容:`renderer/workbench/agentSettings/codex/*` + `agentSettings/AgentSettingsEditor.module.css`
- 服务:`shared/ipc/codexConfigService.ts`、`main/services/codexConfig/codexConfigMainService.ts`
- agent 注册表:`renderer/services/acp/acpAgentRegistry.ts`(`IAcpAgentRegistry`、`BUILTIN_AGENTS`、`agentIconId()`)——`codex` 在 `IAcpAgentRegistry.list()` 里就会自动出现在 Settings 的 Agents 组
- codex 二进制(与配置无关,登录除外):`shared/ipc/codexBinaryService.ts`、`main/services/codexBinary/*`

