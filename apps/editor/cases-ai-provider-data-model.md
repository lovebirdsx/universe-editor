# 本文从 apps/editor/CLAUDE.md 拆出，范围是套路 I（AI provider）的数据模型与配置细节——providers[] 条目语义、协议枚举、aiSettings.json 合并管线、费率/用量来源、密钥策略、官方 vs 网关判定、生效凭据反查。

## 数据模型：单层 `providers[]`（`packages/platform/src/ai/aiProviderEntry.ts`）

每个条目是一个网关端点 `AiProviderEntry`：

- `{ id, extends?, baseUrl?, apiKey?, defaultProtocol?, protocolMap?, pricingSource?, usageSource? }`。`id` 全局唯一、不能含 `/`，也是它名下所有模型 id 的第一段。
- **`extends`**：继承另一个条目（同一网关的多个入口）。`protocolMap` **整体替换**，其余标量字段（baseUrl/apiKey/defaultProtocol/pricingSource/usageSource）覆盖。环引用 / 指向不存在的 id / 继承深度 >8 都会产出 `AiProviderIssue` 并**跳过该 provider**（不静默丢弃），问题经 `IAiModelService.getProviderIssues()` 暴露，管理页卡片上显示徽标。
- **`protocolMap`**：`协议 → 模型列表`。**空数组 `[]` = 从该 provider 的端点拉模型（discover）；非空数组 = 直接就是这些模型，完全不碰网络**。元素是字符串（简写，按同名查顶层 `models` 知识库；查不到即裸模型，降级不报错）或对象 `{ id, ref, capabilities?, … }`（`id` 是线上真实模型名，`ref` 指向知识库 key，自身字段覆盖知识库；**能力只能置 false 不能加 true**，翻译链路有损）。
- 模型 id 三段 = `providerId/protocol/channelModel`（例：`acme-gbl/anthropic-messages/acme-chat-pro`，第三段保留剩余 `/`）。helper 在 `packages/platform/src/ai/aiModelConfiguration.ts`（`composeModelId` / `parseModelRef` / `bareModelName`）。
- 协议枚举 `AiWireProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'ollama'`（`aiModelTypes.ts`）。`openai-responses` 是 agent-only 桩：管理页可见并打「Agent-only」徽标，但模型 picker 与 schema enum 里不可选（`isEditorSelectable` 排除）。
- **8 个字段全部有图形入口**，在 `renderer/workbench/ai/providerCard/`（三态 protocolMap / extends / pricing·usage source / 模板化新建）。改 UI 前先读 `renderer/workbench/ai/CLAUDE.md` 的文件地图；`protocolMap` 三态语法与 ref 归一化的纯函数在 `shared/ai/protocolMapEdit.ts`。

## 配置来源 `aiSettings.json`

位于 `<configDir>/aiSettings.json`（configDir 默认 = userData），顶层 `{ models?, providers[], modelSettings?, activeModels?, agentSettings? }`（`AiSettingsFile`，`aiModelConfiguration.ts`；`agentSettings` 不再被读取，只为存量文件不报 schema 错而保留声明）。main 读文件 → `parseSettings`（jsonc）→ `mergeModelKnowledge(BUILTIN_MODEL_KNOWLEDGE, models)` → `resolveProviderEntries(providers, knowledge)` → `registry.setProviders(...)`，监听文件变更热重载。

- `models` 是**模型知识库**（跨网关不变的内在属性 name/family/vendor/nativeProtocol/maxInputTokens/maxOutputTokens/capabilities/supportsReasoningEffort，**不含 pricing**），内置部分在 `shared/ai/catalog/modelKnowledge.ts` 的 `BUILTIN_MODEL_KNOWLEDGE`，用户 `models` 按 key 逐字段合并覆盖。
- **用户层读写走专门 API，绝不经合并视图**：`IAiModelService.getUserModelKnowledge()`（返回**用户自己的 `models` 层**，不是 merge 后的视图）与 `updateModelKnowledge(models)`（**整层替换**；空 map 会 `delete` 顶层 `models` key），写盘收口在 main 的 `SettingsWrite` 的 `models` 分支。
- 重命名知识 key 要同时改 `models` 与 `providers[]`（protocolMap 里的显式 `ref`），走 `updateModelKnowledgeAndProviders(models, providers)` **一次原子写**——分两次写中间失败会留下悬空 ref。图形化编辑只物化用户改过的字段（物化-on-touch），把合并视图写回去会 pin 死未来的内置目录升级——详见 `renderer/workbench/ai/CLAUDE.md`。
- `modelSettings` 是 per-model 参数（键 = 三段 id）。`activeModels.{chat,inlineCompletion,commit,sessionTitle}` 存各功能的活跃模型 id，经门面 `get/setActiveModel(kind)` 读写，**不进 settings.json**。
- 检测到旧两层格式标志（`providerTypes` / `providers[].type` / `groups`）→ `isLegacySettingsFormat()` 返回 true，配置按空处理、管理页顶部 banner 提示手工重建，**旧文件不改写**。

## 价格 / 用量来源

远端来源接口在 `packages/platform/src/ai/aiRemoteSources.ts`（`IAiPricingSource.fetchRates` / `IAiAccountUsageSource.fetchUsage` + `AiRemoteSourceRegistry`）。实现放 `main/services/ai/remote/`：`httpJsonPricingSource.ts`（id `http-json`）/ `httpJsonUsageSource.ts`（id `http-json`）/ `catalogPricingSource.ts`（id `catalog`，**同步**读内置官方价目表、不发网络），复用纯函数 `shared/ai/parseRemoteJson.ts`（点路径取值 / 数组或对象两种形态 / unit 换算 / 坏条目跳过），在 `AiModelMainService._registerBuiltInRemoteSources` 注册一行。

两条硬约束：**热路径同步读缓存**（renderer 经 `IAiRateMirror` 镜像读本地缓存，绝不挂网络/IPC）、**远端拉取失败静默降级**（返回 `undefined`，`remoteCoordinator` 保留旧缓存，绝不影响真实 AI 请求）。缓存落 `<userData>/Cache/aiRemoteCache.json`（`remoteCache.ts`，易变数据，不随 configDir 迁移），双 TTL：费率 24h / 用量 5min。官方订阅额度（claude.ai / ChatGPT）走 ACP agent 的 `subscription_usage` 扩展方法（`renderer/services/usage/subscriptionUsage.ts` 的 `normalizeSubscriptionUsage`），**不经** `IAiAccountUsageSource`。

## 会话开销 vs 账号费用（两个概念，绝不互相兜底）

| | 会话开销 | 账号费用 / 额度 |
|---|---|---|
| 粒度 | per session | per **provider**（额度跟 key 走） |
| 性质 | 本地估算：token × 费率 | 上游权威数字 |
| 来源 | 该 provider 的 `pricingSource` | `IAiAccountUsageSource` |
| 查不到 | 显示「—」+ 引导填费率 | 显示「不可用」，绝不用估算值冒充 |

实现：`renderer/services/usage/AccountUsageService.ts`（per-agent 读账号费用）+ `renderer/services/usage/subscriptionUsage.ts` 的 `resolveUsageDisplay`（四态 `'subscription' | 'account' | 'unavailable' | 'hidden'`，优先级注释就在函数上方）+ `workbench/agents/UsageIndicator.tsx`。

## 费率解析：单一来源，绝不兜底

`src/shared/ai/resolveProviderPricing.ts` 的 `resolveModelPricing`：费率只由该 provider 的 `pricingSource` 决定——`catalog`（`options.vendor` 查内置官方价目表 `OFFICIAL_CATALOGS`）或 `http-json`（读网关价目表缓存）。**未声明 pricingSource 就是「费率未知」，绝不跨 provider 兜底套官方价**（中转网关有折扣/加价/换币种，套官方价直接记错账）——「费率未知」是 UI 的一个状态，不是编出来的数字。`AiPricingOrigin = 'catalog' | 'gateway'`（`aiModelPricing.ts`）。

## 密钥策略

API key **明文存在 `aiSettings.json` provider 条目的 `apiKey` 字段**（用户明确决策：跨机器同步），写文件后 POSIX 上 `chmod 0600`（Windows 跳过）。红线：**密钥绝不进日志、绝不进 AI Debug 记录**；UI 一律掩码显示（前 4 后 4，`src/shared/ai/maskKey.ts`）。命令 `ai.setApiKey` / `ai.clearApiKey` 提示文案为「明文存储」。

## 官方 vs 网关判定（agent 认证用）

内置「协议 → 官方 baseUrl」对照表 `shared/ai/officialEndpoints.ts`（`OFFICIAL_BASE_URLS` + `isOfficialEndpoint`），无需用户配任何字段。`shared/ai/providerDerivation.ts` 据此派生 per-CLI 凭据：`deriveClaudeAuth`（官方端点 → `ANTHROPIC_API_KEY`；网关 → `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`）、`deriveCodexGateway`（→ `{ baseUrl, apiKey, providerName }`）。

## 生效凭据是反查出来的，不是编辑器声明的

**agent 自己的配置文件即唯一真相**（claude: `settings.json` 的 env + `.credentials.json`；codex: `config.toml` + `auth.json`），编辑器**不再持久化** `agentSettings.<agent>.authentication`（该块已废弃，schema 里只留 `deprecationMessage`）。判定走纯函数 `shared/ai/agentActiveAuth.ts` 的 `resolveClaudeActiveAuth` / `resolveCodexActiveAuth`：把每个 provider 条目**正向派生**一遍再与盘上值逐字比对，产出 `AgentActiveAuth = { kind: 'subscription'|'provider'|'none', providerId? }`。

三条硬约束：
1. claude 侧严格按 SDK 的 `AUTH_TOKEN(+BASE_URL) > API_KEY > OAuth` 优先级，**匹配失败绝不 fall through**（此时生效的就是那个未知网关）。
2. baseUrl **逐字比对不做 URL 归一化**（写盘值与反查值同源，归一化只会造假不匹配）。
3. 歧义（两条目同 baseUrl+key）按 aiSettings.json 文件序**确定性 first-match**——盘上只有 key，区分哪条是信息论意义上不可能的，所以要求答案稳定而非随机。

反查是纯函数、无 logger，不额外告警。`kind:'provider'` 而 `providerId` 缺席 = 外部/手写凭据，**刻意不归属任何 provider**（开销显示「—」，账号用量 hidden）——硬猜会把钱记到别人账上。**所有读都带 `authority`**，本地与远端工作区的订阅/网关费用天然分开。模型选择从所选 provider 的候选里挑，但**只写 agent 自己的配置文件**（claude: `settings.json` 的 `model` / `env.CLAUDE_CODE_SUBAGENT_MODEL`；codex: `config.toml` 的 `model`），编辑器侧不镜像——原因见 `workbench/agentSettings/claude/CLAUDE.md`。

## 已落地 provider（按协议）

- `ollama`：本地，无需 key，`/api/chat` NDJSON 流
- `openai-chat`：baseUrl 可指向任何 OpenAI 兼容端点，`/chat/completions` SSE 流，无 key 时省略 auth 头
- `anthropic-messages`：`/v1/messages` SSE，system prompt 是顶层字段
- `openai-responses`：`sendRequest` 为桩、仅供 agent 派生；`listModels` 真实探测 `GET /models` 供 Test 按钮用

改密钥/配置后由 main 显式 `setProviders` 失效注册表缓存、重新枚举模型并 `fire onDidChangeModels`。

## 模型选择 UI

命令 `ai.pickModel`（QuickPick，状态栏 AI 快捷设置 `workbench/statusbar/AiStatusBarButtons.tsx` 的下拉里各功能行触发）、`ai.manageModels`（图形化管理页 `workbench/ai/AiSettingsEditor.tsx`，虚拟 `AiSettingsEditorInput`；AI 组四分类：供应商配置 / 模型配置（顶层 `models` 知识库，`AiModelKnowledgePanel`）/ 功能模型 / MCP 服务器）、`ai.openSettingsJson`（直接编辑 `aiSettings.json`）。
