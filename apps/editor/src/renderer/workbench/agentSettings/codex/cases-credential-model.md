# cases-credential-model.md

本文从 `agentSettings/codex/CLAUDE.md` 拆出，范围是：Codex 凭据模型的完整演进与每个「为什么」——两种凭据共存的 auth.json、三种登录方案的机制细节、resolved_mode 与「真正 In Use」判定的由来、两个已修复的历史设计错误。一句话结论留在 CLAUDE.md，本文保留改认证逻辑时需要的历史背景。

## 背景：Codex 为什么把状态摊在两个文件

Codex（codex-rs / codex CLI）的配置是 `$CODEX_HOME`（默认 `~/.codex`）下的 `config.toml`（配置：model / reasoning / approval / sandbox / 顶层 `model_provider` / `[model_providers.*]` 等）与 `auth.json`（凭据）。与 Claude（settings.json + .credentials.json 两文件天然分离不同功能）不同的是，**一个 auth.json 同时容纳 ChatGPT OAuth token 块和 `OPENAI_API_KEY`**，靠 `auth_mode` 字段决定用哪个。这就是 Codex 凭据模型所有复杂度的来源。

## 三种登录方案的完整机制

| 方案 | 凭据存哪 | 用哪个 provider | 机制 |
|---|---|---|---|
| ChatGPT 登录(Plus/Pro) | `auth.json` 的 `tokens` 块 + `auth_mode:"chatgpt"` | 内置 `openai` | OAuth token，codex 自己刷新 |
| 官方 OpenAI API Key | `auth.json` 的 `OPENAI_API_KEY` + `auth_mode:"apikey"` | 内置 `openai` | key 作 Bearer 发往 api.openai.com |
| 自定义 gateway | provider 自己的 `experimental_bearer_token` | 独立命名的 provider | 与 OpenAI auth 无关 |

表格是 **main 层契约（`CodexCredentialIntent` 三 kind）支持的机制**。当前面板只提供其中两条：`AuthenticationSection` 选 provider 条目（gateway）或 `@subscription`（ChatGPT），**没有官方 OpenAI API Key 的输入框**——`{kind:'apiKey'}` 是保留能力，renderer 从不发它。

### 最关键的解析规则（"误显 In Use" 的根因）

ChatGPT 与 API Key **都走内置 `openai` provider**，而内置 `openai` **仅在 config.toml 顶层 `model_provider` 为空/未设时才生效**。一旦 `model_provider` 指向某自定义 provider（如 `codex-gateway`/`acme`），auth.json 里的登录就被绕过——即便 `auth_mode`/resolved 仍报 chatgpt/apikey 也没用。

## 两个已修复的历史设计错误（勿重蹈）

① 用顶层 `openai_base_url` 重定向内置 `openai` → 把 ChatGPT token 发去 gateway → `access token could not be refreshed... another account`；
② gateway 用 `requires_openai_auth = true` 复用 auth.json 的 key → 强行把 gateway auth 跟 ChatGPT/官方 auth 绑死。

正确做法：**gateway = 完全自包含的独立 provider**（镜像用户手写的 `[model_providers.acme]`）。下方 TOML 块由选中的 provider 条目经 `deriveCodexGateway`（派生 base_url/key/name）后落盘：

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

## 演进 1：从「声明值 + drift 检测」到「配置文件即唯一真相」

早先编辑器在 `aiSettings.json` 的 `agentSettings.codex` 里持久化一份认证声明值（claude 侧同样有 `agentSettings.claude`），并在 main 侧实现 drift 检测（`computeDrift`）比对声明与盘上差异。结论：**agent 自己的配置文件就是唯一真相**——编辑器不再存声明值（该块已废弃、不再被读取），判定整体收口为纯函数反查（`resolveCodexActiveAuth`，见 CLAUDE.md「真正 In Use」节）。`computeDrift`/`matchingProviderId` 从 `codexConfigMainService.ts` 搬进 `shared/ai/agentActiveAuth.ts` 并随 drift 删除。**没有 `drift` 字段了**：不存在「声明与盘上不一致」这回事。UI 因此**没有 drift 警告**——盘上即真相，无从漂移。

## 演进 2：单一 active 维度 → 两个独立维度

`CodexAuthStatus` 早先用单一 `method` 上报 auth.json 里「谁是凭据」，结果「应用 API key」看起来像把 ChatGPT 登录**登出**了（其实 token 还在盘上）。改成两个独立维度后，API key 生效时面板仍显示 "Signed in"，与 Claude 的共存行为一致：

```ts
interface CodexAuthStatus {
  active: 'apiKey' | 'chatgpt' | 'none'   // auth.json 内部解析谁是凭据(resolved_mode)
  chatgpt?: { expired, planType?, expiresAt? }  // 只要 token 块在盘上就有
  hasApiKey: boolean                       // auth.json 里有 OPENAI_API_KEY
}
```

## 演进 3：renderer 叠 builtinActive 的历史 → 收口 main

早先 renderer 自己叠 `builtinActive`（auth.json 状态 + config.toml 顶层 model_provider 覆盖的判断），漏掉它就会在 gateway 顶层生效时把 ChatGPT 误显 "In Use"（两处徽章同时亮——「In use」徽章现已整体删除，选中即生效，徽章只是把同一件事说第二遍）。现在这个叠加是 `resolveCodexActiveAuth` 第 3 步的一部分：**面板消费 `activeAuth.kind`/`.providerId` 即可，不要再在 renderer 里重建这套推理**。远端场景同理：main 读远端两个文件做比对，**秘密绝不回传**。

## 演进 4：gateway 识别从硬编码放宽到任意非 openai 名

判定第 1 步早先只认硬编码的 `'codex-gateway'`，用户手写 `[model_providers.acme]` + `model_provider='acme'` 会被误报 `none`（真实盲区）。现放宽为「顶层 `model_provider` 指向**任何非空且非 `openai`** 的名字」，读该名字的 `[model_providers.<name>]` 块后逐个派生比对。

## 演进 5：模型镜像版本 + 整块替换的陈旧快照 bug（claude 侧教训）

codex 侧 `useCodexConfig.setModel` **只** `patch({model}, authority)` 写 config.toml，编辑器侧不再镜像 `agentSettings.codex.model`。历史教训在 claude 侧（同一机制）：镜像版本 + 整块替换写入 = 陈旧快照的写入会覆盖别人刚改的选择，界面高亮 A 模型而子 agent 实跑 B（真实 bug）。codex 侧同样遵循「配置即唯一真相」。

## 机制细节：统一入口 applyCredential(intent)

三种凭据切换全部走 main 的 `applyCredential(intent: CodexCredentialIntent)`，**一次原子写齐 auth.json + config.toml**，返回最新 `CodexAuthStatus`：

- `{kind:'apiKey',apiKey}`：auth.json 写 `OPENAI_API_KEY` + `auth_mode='apikey'`；config 经 `reconcileGatewayProvider` 拆掉 gateway provider+指针+残留 `openai_base_url`（回到内置 openai）。
- `{kind:'chatgpt'}`：auth.json 删 `OPENAI_API_KEY`，若仍有 ChatGPT token 则 `auth_mode='chatgpt'` 否则删 mode（**保留 token，不登出**）；config 同样拆掉 gateway，顶层 `model_provider` 清空。
- `{kind:'gateway',baseUrl,apiKey,providerName?}`：auth.json 只删 key 不动 token；config 写自包含 provider + `model_provider='codex-gateway'`，删 `openai_base_url`。**保留**用户手写的其它 provider（如 `[model_providers.acme]`）。

`reconcileGatewayProvider(current, intent)` 是纯函数，返回新 settings（无变化返回 `null`）。**ChatGPT + API key 可共存**：切到 chatgpt 只清 key、不删 token。

## 机制细节：resolved_mode（auth.json 内部：ChatGPT vs API key 选谁）

`_resolveAuthMode()` **镜像 codex-rs `resolved_mode()`**（login/src/auth/manager.rs）。注意它只决定 auth.json 内部用 token 还是 key，**与顶层 `model_provider` 是否生效是两码事**：

1. 显式 `auth_mode` 字段优先：`'apikey'`→apiKey；`'chatgpt'`/`'chatgptAuthTokens'`→chatgpt
2. 否则按字段存在性：`OPENAI_API_KEY` **先于** ChatGPT token 块 → apiKey
3. 否则有 `tokens.access_token` → chatgpt
4. 都没有 → none

（`personalAccessToken`/`bedrockApiKey`/`agentIdentity` 这几个 mode 本面板不展示，走第 2 步兜底。）

`applyCredential` 据此锁定 mode：写 key 时 `auth_mode='apikey'`；切 chatgpt 时清 key、若 token 还在则 `auth_mode='chatgpt'` 否则删 mode。

## 机制细节：CodexAuthenticationPanel 完整行为

认证页两块：`AuthenticationSection`（单一认证选择：选一个 provider 条目或 `@subscription` + model 下拉）与 `LoginForm`（ChatGPT 登录状态 + 登录按钮）。

- **下拉当前值不是编辑器存的声明值，而是从 `activeAuth` 反查出的盘上生效值**（`kind==='provider'` → 该 `providerId`；`kind==='subscription'` → `@subscription` 哨兵；`providerId` 缺席 → 显示「外部凭据」提示）。下拉用共享组件 `../GatewayProviderPicker.js`（`protocol="openai-responses"`），派生经 `shared/ai/providerDerivation.ts` 的 `deriveCodexGateway`。
- **生效判定走 main 的 `resolveActiveAuth(authority)`**：`kind==='subscription'` = ChatGPT 登录生效，`kind==='provider'` = gateway 生效。**没有 drift 警告**——盘上即真相，无从漂移。
- `currentModel` 读 `config.settings.model`（config.toml），并照 claude 的 `pinCurrent` 保留「不在候选中但仍生效」的置顶项（否则复刻 claude 已修过的「选项凭空消失」）。
- `signedIn = !!chatgpt && !chatgpt.expired`（token 过期走 "Login expired" 分支，不显示 "Signed in"）；`overridden = signedIn && !chatgptActive`（登录了但被 gateway 顶掉——当前面板没有官方 API key 入口）时显示 "a saved credential is currently taking precedence." + "Use this login"。
- **没有 "In use" 徽章**（与 claude 侧对称）：下拉里选中的就是盘上生效的，徽章只是把同一件事说第二遍；`chatgptActive` 保留下来只为算 `overridden`。

## 机制细节：useCodexConfig 与 codexLogin

- `useCodexConfig` 聚合 settings/authStatus/**activeAuth**（盘上生效凭据的反查结果）读取与 patch。**所有凭据切换统一走 `service.applyCredential(intent)`**：`applyAuthentication` 据认证选择发 `{kind:'gateway',baseUrl,apiKey,providerName}`（gateway 的 baseUrl/apiKey/providerName 由选中的 provider 条目经 `deriveCodexGateway` 派生）或 `{kind:'chatgpt'}`（选 `@subscription`）；`setModel` **只** `patch({model}, authority)` 写 config.toml（编辑器侧不再镜像 `agentSettings.codex.model`）。**没有** `setApiKey`/`ensureCodexGatewayProvider`/`BASE_URL` 常量了（均被 `applyCredential` 取代）。**订阅 `onDidChangeAuth`** 实现 auth.json / config.toml 落盘后实时刷新——回调里**三样都重读**（`read` + `readAuthStatus` + `resolveActiveAuth`），因为 watch 现在也覆盖 config.toml，settings 本身会变。
- `codexLogin.ts` — `runCodexLogin()` 开集成终端跑 **`codex login`**（系统 PATH 的官方 codex CLI）。**注意：不是 codex-acp**——我们为 agent 下载的 `codex-acp` adapter 没有 `login` 子命令，OAuth 归官方 `codex` CLI。

## 机制细节：fs.watch 实时刷新

`_startAuthWatch()` 用 `fs.watch` 监听 **`~/.codex` 目录**（不是文件本身）：codex login 用 temp-file + rename 原子写，**文件级 watch 会丢事件，目录级才稳**。文件名过滤是**集合 `{auth.json, config.toml}`**——config.toml 也在里面，否则手改 model/model_provider 后面板与凭据归属都不刷新；但**不能去掉过滤**，`~/.codex` 下有 sessions/rollouts 等高频写入。150ms 去抖（合并 rename 的 create/delete 对）后 fire `onDidChangeAuth`。renderer `useCodexConfig` 订阅它 → 浏览器 OAuth 流程完成、auth.json 落盘的瞬间自动刷新登录状态。`dispose()` 里 `clearTimeout` + `watcher.close()`。远端工作区下事件同样生效：remote server 侧 watch 远端 `~/.codex`，经 `onDidChangeCodexAuth` 转发回 main（main 对该事件的订阅在首次带 authority 的调用时懒挂载）。
