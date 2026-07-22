---
name: claude-agent-settings-context
description: >-
  当你要改动 Claude 凭据/登录/模型/环境变量配置，或读写
  ~/.claude/settings.json / .credentials.json / aiSettings.json 时召回。
  覆盖：Claude 设置在统一 Settings editor「Agents」组里的渲染方式与按 agent 贡献机制
  （registerAgentSettings）、Claude 专属面板（认证库 / 登录状态 / 模型思考 / 高级环境）、
  claudeConfig 跨进程服务三层（wire 契约 / main 实现 / renderer hook）、三个配置文件的语义
  与凭据明文落盘的刻意决策、以及 readAuthStatus 绝不回传 token 的安全约束。涉及「再加一个
  acp agent 的设置页」也看这里。设置页壳本身（AI/Agents 双组导航）见 ai-settings-subsystem-context。
disable-model-invocation: true
---

# Claude / Agent 设置子系统

agent 设置是**多 agent 的可扩展子系统**：统一 Settings editor 的左侧「Agents」组按 `IAcpAgentRegistry` 列出所有 acp agent（claude-code、codex、用户自定义），每个 agent 通过**模块级贡献注册表**挂自己的设置组件。Claude 的设置内容全部收敛在 `agentSettings/claude/` 命名空间下。

> 🔀 **2026-06 合并**：agent 设置原是独立的 Agent Settings editor，现已并入 AI Settings 的统一壳（`workbench/ai/AiSettingsEditor.tsx`）。本 skill 讲 **agent 设置内容本体**（注册表 + Claude 面板 + claudeConfig 服务）；**承载它的壳**（AI/Agents 双组导航、激活项持久化、入口命令）见 **ai-settings-subsystem-context**。

## 文件地图

### Renderer — 承载壳（见 ai-settings-subsystem-context）
- `renderer/workbench/ai/AiSettingsEditor.tsx` — 统一 Settings editor 壳。左侧「Agents」组动态列出 `IAcpAgentRegistry.list()`，选中 agent 后右侧 `getAgentSettingsComponent(id)` 渲染其贡献组件，无注册则占位。激活项持久化用 `settings.activeItem`（值 `agent:<id>`）。壳顶部 `import '../agentSettings/builtinAgentSettings.js'` 触发副作用注册。
- `agentSettings/agentSettingsRegistry.ts` — 贡献注册表。`registerAgentSettings(agentId, component)` / `getAgentSettingsComponent(agentId)`，`AgentSettingsComponentProps { agentId }`。
- `agentSettings/builtinAgentSettings.ts` — 内置 agent 设置的副作用聚合 hub：`import './claude/ClaudeAgentSettings.js'`。**新增 agent 设置时在这里加一行 import。**
- `agentSettings/AgentSettingsEditor.module.css` — Claude 面板共用样式（`agentBody`/`subNav`/`subBody`/认证库/状态行等，用 `--ue-*` token）。注意：壳本身的样式在 `ai/AiSettingsEditor.module.css`（用 `--color-*` token），两套并存。

### Renderer — Claude 专属（agentSettings/claude/）
- `claude/ClaudeAgentSettings.tsx` — Claude 设置根组件。持有 `useClaudeConfig()`，三分类子导航（auth/model/env，`CATEGORIES` 数组），滚动位置 + 激活分类经 `IStorageService` 持久化（`agent.settings.claude.activeCategory`、`agent.settings.claude.scroll.<id>`）。**末行 `registerAgentSettings('claude-code', ClaudeAgentSettings)`。**
- `claude/AuthenticationPanel.tsx` — 认证页。两块：`CredentialLibrary`（已存凭据档案列表 + 新增表单）与 `LoginForm`（OAuth 登录状态 + 登录按钮）。算激活态：`isProfileActive` / `isLoginActive`（由 env + auth 状态推导，不是 UI 展开态）；`mask()` 脱敏显示。
- `claude/ModelThinkingPanel.tsx` — 模型 / 语言 / 思考开关 / effort / availableModels，绑 settings.json。
- `claude/AdvancedEnvPanel.tsx` — env 开关（PROMPT_CACHING、AUTO_COMPACT）+ 自定义 env 编辑器，隐藏 `AUTH_ENV_KEYS`（认证类 env 归 AuthenticationPanel 管）。
- `claude/useClaudeConfig.ts` — Claude 配置 hook。聚合 settings/authStatus/profiles 的读取与 patch/save/delete/apply。`applyProfile` 把某档案注入 settings.json 的 env（互斥清掉另一种凭据，见下）。常量 `API_KEY`/`AUTH_TOKEN`/`BASE_URL`。
- `claude/claudeLogin.ts` — `runClaudeLogin()` 开终端跑 `claude auth login --claudeai|--console`。

### 跨进程服务三层
- `shared/ipc/claudeConfigService.ts` — **wire 契约**。`IClaudeConfigService` 装饰器 + 所有类型（`ClaudeSettings`、`ClaudeSettingsPatch`、`ClaudeAuthStatus`、`ClaudeCredentialKind`、`ClaudeCredentialProfile`）。方法：`read`/`patch`/`configPath`/`readAuthStatus`/`readProfiles`/`writeProfiles`。
- `main/services/claudeConfig/claudeConfigMainService.ts` — **main 实现**。原子写（mkdir -p + temp + rename），读容错（缺失/损坏返回空）。
- `main/services/claudeConfig/__tests__/claudeConfigMainService.test.ts` — readAuthStatus（6 例）+ credential profiles（5 例）。

## claudeConfig 服务接线（5 处，加方法时无需动）

服务方法走 `ProxyChannel`，**给 `IClaudeConfigService` 加方法只改契约 + main 实现两个文件，下面 5 处接线不用动**：
1. `main/services/main-services.ts` — `SyncDescriptor` 注册 `ClaudeConfigMainService`
2. `main/window/scopedServicesFactory.ts` — `readonly claudeConfig` 字段
3. `main/ipc/registerMainServices.ts` — `ProxyChannel.fromService(app.claudeConfig)`
4. `shared/ipc/channelNames.ts` — `ClaudeConfig: 'claudeConfig'`
5. `renderer/main.tsx` — `ProxyChannel.toService<IClaudeConfigService>(...)`

## 三个配置文件的语义（关键）

| 文件 | 谁写 | 谁读 | 内容 |
|---|---|---|---|
| `~/.claude/settings.json` | 编辑器 + CLI 共享 | agent/SDK/CLI | **当前生效**配置：model、env（含激活的凭据）、思考开关等 |
| `~/.claude/.credentials.json` | `claude auth login`（OAuth） | agent/SDK | `claudeAiOauth`：accessToken/refreshToken/expiresAt/scopes/subscriptionType/rateLimitTier |
| `<configDir>/aiSettings.json` 的 `agentSettings.claude.authentication` | **仅编辑器** | 仅编辑器 | 凭据**档案库**（多套 apiKey / token+url 候选）+ 未保存表单草稿，不是生效配置 |

- **settings.json = 当前生效菜；profiles.json = 候选菜单。** 「使用某档案」= 把它注入 settings.json 的 env。
- **登录(OAuth) 不是一个 profile**，它走 `.credentials.json`，与档案库平行。

## 认证优先级（agent/SDK 解析顺序）

`ANTHROPIC_AUTH_TOKEN`(+`ANTHROPIC_BASE_URL`) > `ANTHROPIC_API_KEY` > OAuth 登录(`.credentials.json`)。

`applyProfile` 据此**互斥注入**（保证只有一种凭据生效）：
- `apiKey` 档案 → `{API_KEY: 值, AUTH_TOKEN: null, BASE_URL: null}`
- `gateway` 档案 → `{AUTH_TOKEN: 值, BASE_URL: 值, API_KEY: null}`

`isLoginActive` 仅当 env 里既无 token 也无 apiKey（即没有更高优先级凭据覆盖）时为真。

## 🔒 安全约束（刻意决策，勿擅改）

1. **凭据明文落盘是用户明确选择**：apiKey/token/baseUrl 明文写进 `settings.json`（与 CLI 共享）和 `aiSettings.json` 的 Claude 认证区，**刻意**不用加密 SecretStorage。项目 CLAUDE.md「AI provider 密钥必须走 ISecretStorageService、绝不进 settings.json」那条**只针对 AI provider 特性，不适用本 Claude 配置共享特性**。
2. **`readAuthStatus()` 绝不回传 OAuth token**：只回 `{loggedIn, expired, subscriptionType?, expiresAt?}`。有测试断言 token 不泄漏，改 readAuthStatus 时务必保住该测试。

## 常见任务 → 改哪里

- **给 Claude 加一个新设置项**：定字段进 `ClaudeSettings`/`ClaudeSettingsPatch`（契约）→ main 实现读写 → 对应面板（model 类→ModelThinkingPanel、env 类→AdvancedEnvPanel、认证类→AuthenticationPanel + `AUTH_ENV_KEYS`）加 UI，经 `useClaudeConfig().patch` 落盘。
- **给 claudeConfig 加一个跨进程方法**：只改契约 + main 实现两个文件（5 处接线不动）。
- **再加一个 acp agent 的设置页（如 codex）**：新建 `agentSettings/codex/CodexAgentSettings.tsx`，末行 `registerAgentSettings('codex', CodexAgentSettings)`；在 `builtinAgentSettings.ts` 加一行 `import './codex/CodexAgentSettings.js'`。**壳零改动**——只要该 agent 在 `IAcpAgentRegistry.list()` 里，就会自动出现在 Settings 的 Agents 组。Codex 的设置页已存在，其凭据模型（双文件 config.toml/auth.json、resolved_mode 优先级、双维度 auth 状态、fs.watch 实时刷新）与 Claude 不同，见 **codex-agent-settings-context**。
- **加一个凭据种类**：扩 `ClaudeCredentialKind`，改 `applyProfile` 的互斥注入逻辑 + `ProfileForm` 表单 + `isProfileActive`。
- **接入第三方模型（Kimi/GPT 等）**：无需新代码——`gateway` profile 已可带 `model`/`smallFastModel` 预设（一个凭据=一套「网关+模型」，`applyProfile` 时连同 `settings.model` + `env.ANTHROPIC_SMALL_FAST_MODEL` 一起注入；`isProfileActive` 把 model 纳入比对）。Claude Code 只说 Anthropic 协议：Kimi 有原生兼容端点直连，GPT 需 LiteLLM/claude-code-router 代理转协议。用户文档见 `docs/user/zh-CN/ai-agent/models-and-cost.md`。

## 易踩坑速记

- `useObservable` / `useService` 来自 `renderer/workbench/useService.ts`（即面板里的 `../../useService.js` / `../useService.js`），**不是** `@universe-editor/workbench-ui`。
- workbench-ui 的 `IconButton` API 是 `label: string` 属性 + `children` 放图标：`<IconButton label="编辑"><Pencil size={14}/></IconButton>`，没有 `icon`/`ariaLabel` props。
- ESM：相对导入带 `.js` 后缀（即使源是 `.ts`）。`claude/` 比外壳深一层，import 路径多一级 `../`。
- 状态持久化套路：`IStorageService` 存 key + `restoredRef` 守卫防覆盖 + `requestAnimationFrame` 恢复滚动。
- NLS：`localize(key, '英文默认值', vars?)`，默认值必须英文；中文写进 `shared/i18n/messages/zh-CN.ts`。当前该子系统多用内联文案，若新增 key 记得补 zh-CN。
- 新增 FakeSession 测试桩别忘 `onDidRequireAuth: Event.None`（认证流相关）。
- 未跟踪文件用 `git mv` 会失败（exit 128），用普通 `mv`。

## 验证

- `pnpm check`（lint + typecheck + test，输出长，只截错误）。
- 改交互逻辑跑 `pnpm e2e`。已知本机 flaky（非回归）：simpleFileDialog / multiFileDragEditor / explorerExternalWatcher / markdown* @p1（多 worker / exthost 环境问题，单跑必过）。

## 入口（打开到 Agents 区）

- 主入口：命令 `ai.manageModels`（标题 “Open AI & Agent Settings”）打开统一 Settings editor。
- agent 专用入口：命令 `workbench.action.agent.openSettings`（`actions/agentActions.ts` 的 `OpenAgentSettingsAction`）——先 `storage.set('settings.activeItem', 'agent:<defaultAgentId>')` 再打开 `AiSettingsEditorInput`，落点直接在 Agents 区。**此命令 ID 被 AcpSessionEditor 齿轮、`acpSessionService`（两处）引用，勿改 ID。**

## 关键参考路径

- 承载壳：`renderer/workbench/ai/AiSettingsEditor.tsx`（Agents 组渲染 + 激活项持久化）→ 见 ai-settings-subsystem-context
- 贡献注册：`renderer/workbench/agentSettings/{agentSettingsRegistry.ts,builtinAgentSettings.ts}`
- Claude 内容：`renderer/workbench/agentSettings/claude/*` + `agentSettings/AgentSettingsEditor.module.css`
- 服务：`shared/ipc/claudeConfigService.ts`、`main/services/claudeConfig/claudeConfigMainService.ts`
- 编辑器输入：`renderer/services/editor/AiSettingsEditorInput.ts`（TYPE_ID `aiSettings`，URI `universe:/aiSettings`）— 注意 `AgentSettingsEditorInput` 已删
- 入口命令：`renderer/actions/agentActions.ts`（`OpenAgentSettingsAction`）、`renderer/actions/aiActions.ts`（`ManageModelsAction`）
- agent 注册表：`renderer/services/acp/acpAgentRegistry.ts`（`IAcpAgentRegistry`、`BUILTIN_AGENTS`、`agentIconId()`）

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件
