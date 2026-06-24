---
name: codex-agent-settings-context
description: >-
  当你要改动 Codex 凭据/登录/模型/审批/沙箱/高级配置,或读写 ~/.codex/config.toml /
  auth.json / credential-profiles.json 时召回。覆盖:Codex 设置在统一 Settings editor
  「Agents」组里按 agent 贡献的渲染机制(registerAgentSettings 'codex')、Codex 专属面板
  (认证库 / ChatGPT 登录 / 模型推理 / 审批沙箱 / 高级)、codexConfig 跨进程服务三层
  (wire 契约 / main 实现 / renderer hook)、config.toml 与 auth.json 双文件语义、
  resolved_mode 认证优先级、双维度 CodexAuthStatus(active/chatgpt/hasApiKey)为何能
  "API key 与 ChatGPT 登录共存不互相登出"、auth.json 的 fs.watch 实时刷新(onDidChangeAuth)、
  以及 readAuthStatus 绝不回传 token 的安全约束。Codex 与 Claude 设置共享同一外壳与贡献注册表,
  但凭据模型完全不同——看本 skill。设置页壳本身见 ai-settings-subsystem-context;
  Claude 同类子系统见 claude-agent-settings-context。
disable-model-invocation: true
---

# Codex / Agent 设置子系统

Codex 是接入统一 Settings editor「Agents」组的 acp agent 之一。它**复用** Claude 那套贡献机制(`agentSettingsRegistry` + `builtinAgentSettings`),但**凭据模型与 Claude 完全不同**:Codex 把状态摊在两个文件里,且一个 `auth.json` 同时容纳 ChatGPT OAuth token 块和 `OPENAI_API_KEY`,靠 `auth_mode` 字段决定用哪个。本 skill 只讲 **Codex 设置内容本体**。

> 🔀 **承载壳**(AI/Agents 双组导航、激活项持久化、入口命令)见 **ai-settings-subsystem-context**;**Claude 同类子系统**见 **claude-agent-settings-context**(两者共用 `agentSettingsRegistry` / `builtinAgentSettings` / `AgentSettingsEditor.module.css`)。

## 文件地图

### Renderer — 贡献注册(与 Claude 共用)
- `agentSettings/agentSettingsRegistry.ts` — `registerAgentSettings(agentId, component)` / `getAgentSettingsComponent(agentId)`。
- `agentSettings/builtinAgentSettings.ts` — 副作用聚合 hub,已有 `import './codex/CodexAgentSettings.js'`。
- `agentSettings/AgentSettingsEditor.module.css` — 面板共用样式(`agentBody`/`subNav`/`subBody`/`navItem`/认证库/状态行),`--ue-*` token。Claude / Codex 共用。

### Renderer — Codex 专属(agentSettings/codex/)
- `codex/CodexAgentSettings.tsx` — 根组件。持有单个 `useCodexConfig()`,四分类子导航(`CATEGORIES`:auth/model/safety/advanced),激活分类 + 滚动位置经 `IStorageService` 持久化(`agent.settings.codex.activeCategory`、`agent.settings.codex.scroll.<id>`)。**末行 `registerAgentSettings('codex', CodexAgentSettings)`。** 仅 `config.loaded` 后渲染面板。
- `codex/CodexAuthenticationPanel.tsx` — 认证页,**最复杂**。两块:`CredentialLibrary`(API key / gateway 档案库 + 新增表单)与 `LoginForm`(ChatGPT 登录状态 + 登录按钮)。**双维度共存**是它的核心:`authStatus.active` 决定谁在用,`authStatus.chatgpt` 只要 token 在盘上就一直显示 "Signed in"。`overridden = signedIn && active==='apiKey'` 时显示 "taking precedence" + "Use this login"(调 `switchToChatgptLogin`)。
- `codex/CodexModelPanel.tsx` — model / model_provider(free-text,blur 提交) / model_reasoning_effort(select 即时写),绑 config.toml。
- `codex/CodexSafetyPanel.tsx` — `approval_policy` + `sandbox_mode` 两个 select,绑 config.toml。
- `codex/CodexAdvancedPanel.tsx` — `cli_auth_credentials_store` 选择 + `hide_agent_reasoning` 开关 + 自由标量键编辑器。隐藏其他面板管的键(model/approval/sandbox/base URL),只编标量(嵌套表如 `[model_providers.*]` 留给原始文件)。
- `codex/useCodexConfig.ts` — 配置 hook。聚合 settings/authStatus/profiles 读取与 patch/save/delete/applyProfile/setApiKey/switchToChatgptLogin。**订阅 `onDidChangeAuth`** 实现 auth.json 落盘后实时刷新登录状态。常量 `BASE_URL = 'openai_base_url'`。
- `codex/codexLogin.ts` — `runCodexLogin()` 开集成终端跑 **`codex login`**(系统 PATH 的官方 codex CLI)。**注意:不是 codex-acp**——我们为 agent 下载的 `codex-acp` adapter 没有 `login` 子命令,OAuth 归官方 `codex` CLI。

### 跨进程服务三层
- `shared/ipc/codexConfigService.ts` — **wire 契约**。`ICodexConfigService` 装饰器 + 全部类型(`CodexSettings`/`CodexSettingsPatch`/`CodexAuthStatus`/`CodexCredentialKind`/`CodexCredentialProfile` + 枚举 `CodexReasoningEffort`/`CodexApprovalPolicy`/`CodexSandboxMode`/`CodexCredentialStore`)。方法:`read`/`patch`/`configPath`/`readAuthStatus`/`setApiKey`/`readProfiles`/`writeProfiles` + 事件 `onDidChangeAuth`。
- `main/services/codexConfig/codexConfigMainService.ts` — **main 实现**。`extends Disposable`。原子写(mkdir -p + temp + rename),读容错(缺失/损坏返回空)。构造里 `_startAuthWatch()`,`override dispose()` 关 watcher。
- `main/services/codexConfig/__tests__/codexConfigMainService.test.ts` — readAuthStatus(含共存 + 优先级用例)+ setApiKey(`auth_mode` 锁定)+ profiles + `onDidChangeAuth` 事件。

## codexConfig 服务接线(6 处,加方法时无需动)

服务方法 + `onDidChange*` 事件都走 `ProxyChannel`(事件自动透传),**给 `ICodexConfigService` 加方法只改契约 + main 实现两个文件,下面 6 处接线不用动**:
1. `main/services/main-services.ts` — `SyncDescriptor<ICodexConfigService>(CodexConfigMainService, [undefined], false)`(`[undefined]` = configPath 用默认)
2. `main/window/scopedServicesFactory.ts` — `readonly codexConfig` 字段
3. `main/ipc/registerMainServices.ts` — `ProxyChannel.fromService(app.codexConfig)`
4. `shared/ipc/channelNames.ts` — `CodexConfig: 'codexConfig'`
5. `renderer/ipc/registerProxyServices.ts` — `ProxyChannel.toService<ICodexConfigService>(...)`(**Codex 在这里注册,不在 renderer/main.tsx**——与 Claude 不同)
6. (事件无需额外接线:`ProxyChannel` 自动代理 `onDidChange*` 命名的 Emitter)

## 两个配置文件 + 一个档案库的语义(关键)

`$CODEX_HOME`(默认 `~/.codex`)下:

| 文件 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `config.toml` | 编辑器 + CLI 共享 | agent/CLI | model / reasoning / approval / sandbox / `openai_base_url` / provider 等。smol-toml 解析,**就地编辑保留未管理键** |
| `auth.json` | `codex login`(ChatGPT) / 编辑器(API key) | agent/CLI | JSON。可**同时**含 `OPENAI_API_KEY` + `tokens`(ChatGPT OAuth 块)+ `auth_mode` 字段 |
| `.universe-editor/credential-profiles.json` | **仅编辑器** | 仅编辑器 | API key / gateway **档案库**(候选),不是生效配置 |

- **API key 写 auth.json,gateway base URL 写 config.toml** —— 一个 gateway 档案落地要动两个文件(`applyProfile` 同时 `setApiKey` + `patch({openai_base_url})`)。
- **ChatGPT 登录不是 profile**:它是 `codex login` 管的单一共享登录,与档案库平行。
- `patch` 里把某键设 `null` = 删除该键(清除残留 `openai_base_url` 的唯一办法)。

## 认证优先级 resolved_mode(核心——理解所有 auth 行为的钥匙)

`_resolveAuthMode()` **镜像 codex-rs `resolved_mode()`**(login/src/auth/manager.rs):

1. 显式 `auth_mode` 字段优先:`'apikey'`→apiKey;`'chatgpt'`/`'chatgptAuthTokens'`→chatgpt
2. 否则按字段存在性:`OPENAI_API_KEY` **先于** ChatGPT token 块 → apiKey
3. 否则有 `tokens.access_token` → chatgpt
4. 都没有 → none

(`personalAccessToken`/`bedrockApiKey`/`agentIdentity` 这几个 mode 本面板不展示,走第 2 步兜底。)

**`setApiKey` 据此锁定 mode**:写 key 时 `auth_mode='apikey'`(即便 ChatGPT token 还在也用 key);清 key 时若 ChatGPT token 还在则 `auth_mode='chatgpt'`,否则删掉 mode。

## 双维度 CodexAuthStatus(为何 "API key 与 ChatGPT 登录共存不互相登出")

```ts
interface CodexAuthStatus {
  active: 'apiKey' | 'chatgpt' | 'none'   // codex 实际会用谁(resolved_mode)
  chatgpt?: { expired, planType?, expiresAt? }  // 只要 token 块在盘上就有
  hasApiKey: boolean                       // auth.json 里有 OPENAI_API_KEY
}
```

**为何不是单一 `method`**:Codex 的 auth.json 本就让 token 块和 API key 共存。早先用单一 active 方式上报,导致"应用 API key"看起来像把 ChatGPT 登录**登出**了(其实 token 还在盘上,只是 UI 藏了)。改成两个独立维度后,API key 生效时面板仍显示 "Signed in" + 标注 API key "taking precedence",与 Claude 的共存行为一致。改 `readAuthStatus` 时务必保住这个"两维度"语义。

## auth.json 实时刷新(为何登录后无需手动 refresh)

`_startAuthWatch()` 用 `fs.watch` 监听 **auth.json 所在目录**(不是文件本身):codex login 用 temp-file + rename 原子写,**文件级 watch 会丢事件,目录级才稳**。150ms 去抖(合并 rename 的 create/delete 对)后 fire `onDidChangeAuth`。renderer `useCodexConfig` 订阅它 → 浏览器 OAuth 流程完成、auth.json 落盘的瞬间自动刷新登录状态。`dispose()` 里 `clearTimeout` + `watcher.close()`。

## 🔒 安全约束(刻意决策,勿擅改)

1. **凭据明文落盘是用户明确选择**:apiKey/baseUrl 明文写进 `config.toml`/`auth.json`(与 CLI 共享)和 `credential-profiles.json`,**刻意**不用加密 SecretStorage。项目 CLAUDE.md「AI provider 密钥必须走 ISecretStorageService、绝不进 settings.json」那条**只针对 AI provider 特性,不适用本 Codex/Claude 配置共享特性**。
2. **`readAuthStatus()` 绝不回传 token / API key 值**:只回 `{active, chatgpt?:{expired,planType?,expiresAt?}, hasApiKey}`。有测试("never returns the credentials themselves")断言 token / key 不泄漏到序列化结果里,改 readAuthStatus 时务必保住该测试。

## 常见任务 → 改哪里

- **给 Codex 加一个 config.toml 设置项**:定字段进 `CodexSettings`(契约)→ 选对应面板(model 类→CodexModelPanel、审批/沙箱→CodexSafetyPanel、其它标量→CodexAdvancedPanel 自动出现在自由编辑器,或给它一个专属控件),经 `useCodexConfig().patch` 落盘(`null` 删键)。main 实现的 `read`/`patch` 是通用 TOML 合并,**通常无需改**。
- **给 codexConfig 加跨进程方法/事件**:只改契约 + main 实现两个文件(6 处接线不动;`onDidChange*` 事件自动透传)。
- **改认证逻辑**:先想清楚它落在 `resolved_mode` 哪一步。动 `setApiKey` 必须同时维护 `auth_mode`(否则共存语义崩)。动 `readAuthStatus` 必须保住双维度 + no-token-leak 测试。
- **加一个凭据种类**:扩 `CodexCredentialKind`,改 `applyProfile`(它怎么落到 auth.json + config.toml)+ `CredentialLibrary` 表单 + 激活态判定。
- **再加一个 acp agent 的设置页**:新建 `agentSettings/<id>/<X>AgentSettings.tsx`,末行 `registerAgentSettings('<id>', ...)`;`builtinAgentSettings.ts` 加一行 import。壳零改动。

## 易踩坑速记

- **Codex ≠ Claude 的几处差异**:① renderer proxy 注册在 `registerProxyServices.ts`(Claude 在 main.tsx);② 登录走系统 PATH 的 `codex` CLI(Claude 走自己下载的二进制);③ 单文件 auth.json 共存两种凭据(Claude 是 `.credentials.json` + `settings.json` 两文件天然分离)。
- `useService` 来自 `renderer/workbench/useService.ts`(面板里 `../../useService.js`),**不是** `@universe-editor/workbench-ui`。
- workbench-ui 的 `IconButton`:`label: string` 属性 + `children` 放图标(无 `icon`/`ariaLabel` props)。
- ESM:相对导入带 `.js` 后缀(即使源是 `.ts`)。`codex/` 比外壳深一层,到 shared 是 `../../../../shared/...`。
- 状态持久化套路:`IStorageService` + `restoredRef` 守卫防覆盖 + `requestAnimationFrame` 恢复滚动。
- NLS:`localize(key, '英文默认值', vars?)`,默认值必须英文;新增 key 补 `shared/i18n/messages/zh-CN.ts`(当前多内联文案)。
- react-hooks/rules-of-hooks:hook-library 方法**不要**用 `use` 前缀(否则在 `useCallback` 里调会被判成"在回调里调 Hook")。这就是 `switchToChatgptLogin` 不叫 `useChatgptLogin` 的原因。
- `fs.watch` 必须监听**目录**而非文件,否则 codex 的原子写(rename)会丢事件。
- 测试里验事件:`new Promise(resolve => sub = onDidChangeAuth(...))` + 先 sleep 50ms 让 watcher 挂上再写文件 + `Promise.race` 加超时。

## 验证

- `pnpm check`(lint + typecheck + test,输出长,只截错误)。codexConfig 测试单跑:`pnpm vitest run src/main/services/codexConfig`(在 apps/editor 下)。
- 改交互逻辑跑 `pnpm e2e`。已知本机 flaky(非回归):窗口拆除 `Target page... has been closed`、simpleFileDialog / multiFileDragEditor / explorerExternalWatcher / markdown* @p1(多 worker / exthost 环境问题,单跑必过)。e2e 冒烟**不覆盖 codex 登录场景**,改 codex 面板后 e2e 全绿即可。

## 关键参考路径

- 承载壳:`renderer/workbench/ai/AiSettingsEditor.tsx`(Agents 组渲染)→ 见 ai-settings-subsystem-context
- 贡献注册:`renderer/workbench/agentSettings/{agentSettingsRegistry.ts,builtinAgentSettings.ts}`
- Codex 内容:`renderer/workbench/agentSettings/codex/*` + `agentSettings/AgentSettingsEditor.module.css`
- 服务:`shared/ipc/codexConfigService.ts`、`main/services/codexConfig/codexConfigMainService.ts`
- agent 注册表:`renderer/services/acp/acpAgentRegistry.ts`(`IAcpAgentRegistry`、`BUILTIN_AGENTS`、`agentIconId()`)——`codex` 在 `IAcpAgentRegistry.list()` 里就会自动出现在 Settings 的 Agents 组
- codex 二进制(与配置无关,登录除外):`shared/ipc/codexBinaryService.ts`、`main/services/codexBinary/*`
