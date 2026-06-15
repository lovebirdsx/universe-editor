# VS Code Agent 模型配置方案调查报告

调查日期：2026-06-15  
调查范围：本仓库当前代码快照中的 VS Code Chat/Agent/Language Model 相关实现，重点关注用户如何添加自定义模型，以及如何配置模型参数。

## 结论摘要

VS Code 的模型配置不是把模型硬编码在 agent 内部，而是由 `LanguageModelsService` 提供统一的模型注册、发现、选择、分组、持久化配置和请求转发能力。Chat、Agent、Subagent、Agent Host 等上层场景都围绕“当前选中的 language model id”和“该模型的配置”工作。

用户不能凭空新增一个全新 vendor。自定义模型必须由某个已注册的 `LanguageModelChatProvider` 承接，例如 Copilot 扩展贡献的 BYOK provider：`anthropic`、`gemini`、`openai`、`openrouter`、`xai`、`ollama`、`azure`、`customoai`。用户添加自定义模型，本质上是在用户 profile 下的 `chatLanguageModels.json` 中新增一个 provider group，并由对应 provider 根据 group 配置解析出模型列表。

模型参数分两类：

1. 持久化的用户配置：存放在 `chatLanguageModels.json`。供应商级参数放在 group 顶层，例如 `url`、`models`；单模型参数放在 `settings[modelId]` 中，例如 `reasoningEffort`、`contextSize`。
2. 单次请求参数：扩展调用 `vscode.lm` 时通过 `LanguageModelChatRequestOptions.modelOptions` 传入。Copilot 当前只白名单转发 `stop`、`temperature`、`max_tokens`、`frequency_penalty`、`presence_penalty`。

Agent 场景复用这套机制。Chat service 创建 agent request 时把 `userSelectedModelId` 和 `languageModelsService.getModelConfiguration(userSelectedModelId)` 一起传给 agent 扩展或 agent host。

## 核心架构

```text
extension package.json
  contributes.languageModelChatProviders
          |
          v
LanguageModelsService 记录 vendor descriptor
          |
          | onLanguageModelChatProvider:<vendor>
          v
extension runtime 调用 vscode.lm.registerLanguageModelChatProvider(vendor, provider)
          |
          v
provider.provideLanguageModelChatInformation(...)
          |
          v
LanguageModelsService 缓存模型 metadata，供 model picker / agent request 使用
          |
          v
provider.provideLanguageModelChatResponse(...)
```

关键点：

- `languageModelChatProviders` contribution 只声明 vendor、displayName、配置 schema 和可见条件。
- 真正的模型列表由 provider 动态返回，模型字段包括 `id`、`name`、`family`、`version`、`maxInputTokens`、`maxOutputTokens`、`capabilities`、可选 `configurationSchema`。
- 内部模型 identifier 由 vendor/group/model id 组成：无 group 时类似 `copilot/gpt-4.1`，有 group 时类似 `customoai/My Group/qwen3-coder`。
- 模型选择器、模型管理页、agent request 都通过 `ILanguageModelsService` 查询和使用这些模型。

## 平台 API 与扩展接入

稳定 API 在 `src/vscode-dts/vscode.d.ts` 中定义：

- `vscode.lm.selectChatModels(selector)`：按 `vendor`、`family`、`version`、`id` 选择模型。
- `vscode.lm.registerLanguageModelChatProvider(vendor, provider)`：注册模型提供者。
- `LanguageModelChat.sendRequest(messages, options)`：向模型发起请求。
- `LanguageModelChatRequestOptions.modelOptions`：单次请求参数，语义由 provider 决定。

proposed API `src/vscode-dts/vscode.proposed.chatProvider.d.ts` 扩展了用户配置能力：

- `LanguageModelChatInformation.configurationSchema`：模型声明自己的可配置项。
- `PrepareLanguageModelChatModelOptions.configuration`：解析 provider group 时传入用户配置。
- `ProvideLanguageModelChatResponseOptions.modelConfiguration`：发请求时传入已解析的单模型配置。
- `ChatRequest.modelConfiguration`：Chat participant/agent handler 可以读取用户的单模型配置。

内部服务在 `src/vs/workbench/contrib/chat/common/languageModels.ts` 实现这些能力：

- 注册 extension point：`languageModelChatProviderExtensionPoint`。
- 解析所有 vendor/provider 的模型：`_resolveAllLanguageModels`。
- 查询模型：`selectLanguageModels`。
- 发送请求：`sendChatRequest`。
- 读写模型配置：`getModelConfiguration`、`setModelConfiguration`、`configureModel`。
- 生成模型配置 action：`getModelConfigurationActions`。

## 用户如何添加自定义模型

### 入口

用户入口主要有两个：

1. 命令面板执行 `Manage Language Models`，打开模型管理页。
2. 命令面板执行 `Open Language Models (JSON)`，直接打开底层 JSON 配置文件。

模型选择器中的 `Manage Models...` 齿轮也会进入同一个管理页。

### 配置文件位置和格式

配置文件由 `LanguageModelsConfigurationService` 管理，路径为当前用户 profile location 下的：

```text
chatLanguageModels.json
```

文件格式是数组，每个元素是一个 provider group：

```json
[
	{
		"name": "Local Ollama",
		"vendor": "ollama",
		"url": "http://localhost:11434"
	},
	{
		"name": "My OpenAI Compatible",
		"vendor": "customoai",
		"apiKey": "${input:chat.lm.secret.xxxxx}",
		"models": [
			{
				"id": "qwen3-coder",
				"name": "Qwen3 Coder",
				"url": "http://localhost:8000/v1",
				"toolCalling": true,
				"vision": false,
				"maxInputTokens": 128000,
				"maxOutputTokens": 16000,
				"editTools": ["apply-patch", "code-rewrite"],
				"supportsReasoningEffort": ["low", "medium", "high"],
				"reasoningEffortFormat": "chat-completions",
				"requestHeaders": {
					"X-Workspace": "dev"
				}
			}
		],
		"settings": {
			"qwen3-coder": {
				"reasoningEffort": "medium"
			}
		}
	}
]
```

说明：

- `name` 是 group 名称，用于区分同一个 vendor 的多个配置，例如多个 Ollama server 或多个 OpenAI-compatible endpoint。
- `vendor` 必须是已注册 provider，例如 `ollama`、`azure`、`customoai`。
- `settings` 是单模型配置，key 使用 provider 返回的模型 `id`，不是内部 identifier。
- `apiKey` 这类 secret 字段应通过 UI 配置。代码会把真实值写入 SecretStorage，并在 JSON 中保存 `${input:chat.lm.secret...}` 占位符。直接手写明文 API key 不会按普通字符串使用。

### Copilot BYOK provider

Copilot 扩展在 `extensions/copilot/package.json` 贡献了这些 language model provider：

- `copilot`
- `copilotcli`
- `claude-code`
- `anthropic`
- `xai`
- `gemini`
- `openrouter`
- `openai`
- `ollama`
- `customoai`
- `azure`

BYOK provider 的注册逻辑在 `extensions/copilot/src/extension/byok/vscode-node/byokContribution.ts`：

- 账号发生变化时检查 BYOK 是否可用。
- 可用时创建各 provider 实例。
- 调用 `lm.registerLanguageModelChatProvider(providerId, provider)` 注册到 VS Code。

BYOK 是否启用由 `isBYOKEnabled` 判断：scenario automation 总是可用；普通场景下要求 Copilot token 是 internal、individual 或 client BYOK enabled，并且不是 GHE。

模型管理页的 `Add Models...` 按钮也有 entitlement 检查：internal 用户、支持 BYOK 的 managed entitlement、或非 managed 的有效 entitlement 才允许添加。

### OpenAI Compatible 自定义模型

`customoai` 的 schema 允许用户在 `models` 数组中声明模型：

- `id`
- `name`
- `url`
- `toolCalling`
- `vision`
- `maxInputTokens`
- `maxOutputTokens`
- 可选 `editTools`
- 可选 `thinking`
- 可选 `streaming`
- 可选 `zeroDataRetentionEnabled`
- 可选 `supportsReasoningEffort`
- 可选 `reasoningEffortFormat`
- 可选 `requestHeaders`

`customoai` 的 `when` 条件是 `productQualityType != 'stable'`，因此 stable 产品中是否可见取决于该条件。Azure provider 也支持类似的 `models` 数组配置，并且没有这个 `when` 限制。

实现见 `extensions/copilot/src/extension/byok/vscode-node/customOAIProvider.ts`：

- 如果 group 配置了 `url`，则尝试从 endpoint 的 `/models` 发现模型。
- 如果 group 配置了 `models` 数组，则直接把每个 model config 转成 `LanguageModelChatInformation`。
- URL 没有显式 `/responses` 或 `/chat/completions` 时，默认补成 `/v1/chat/completions`。
- 发请求时创建 `OpenAIEndpoint`，再复用 `CopilotLanguageModelWrapper` 发送。

## 用户如何配置模型参数

### 供应商级配置

供应商级配置来自 extension contribution 中的 `configuration` schema。典型字段：

- API key：Anthropic、xAI、Gemini、OpenRouter、OpenAI。
- Ollama URL：`url`，默认 `http://localhost:11434`。
- Azure 或 OpenAI-compatible 自定义模型列表：`models`。

管理页点击 `Add Models...` 或 provider group 的 `Configure...` 时，`LanguageModelsService.configureLanguageModelsProviderGroup` 会：

1. 询问 group 名称。
2. 根据 provider schema 用 QuickInput 询问可交互字段。
3. 对复杂字段打开 `chatLanguageModels.json` 并插入 snippet。
4. 保存后触发 `LanguageModelsConfigurationService.onDidChangeLanguageModelGroups`，再重新解析该 vendor 的模型。

### 单模型配置

单模型配置由每个模型 metadata 上的 `configurationSchema` 定义。平台会在模型管理页和模型选择器中生成配置入口：

- enum 类型配置会生成可勾选菜单。
- `group: "navigation"` 的配置会显示在模型选择器主描述区域，例如 `Thinking Effort`。
- 点击模型的 `Configure...` 会打开 `chatLanguageModels.json`，并在对应 group 的 `settings` 下插入该模型的配置 snippet。

当前代码中常见的单模型配置：

- `reasoningEffort`：由 Copilot endpoint 或 BYOK model capabilities 的 `supportsReasoningEffort` 生成。
- `contextSize`：Claude Opus 等大上下文模型可配置 200K 或 full context。
- Agent Host 模型可从 agent host root state 的 `ConfigSchema` 转成 `configurationSchema`，例如 `thinkingLevel` 会被标为 `group: "navigation"`。

配置解析规则：

- `LanguageModelsService.getModelConfiguration(modelId)` 会把 schema 默认值和用户 `settings[modelId]` 合并。
- 用户把某个值设回 schema 默认值时，`setModelConfiguration` 会从 JSON 中移除该显式配置。
- 发请求前，`sendChatRequest` 会把解析后的配置合并到 request options 的 `configuration`。
- Extension host 再把它作为 `modelConfiguration` 传给 provider。

### 单次请求参数

扩展代码可以通过 `LanguageModelChat.sendRequest(..., { modelOptions })` 传临时参数。稳定 API 把 `modelOptions` 描述为“模型特定参数”，但 Copilot wrapper 当前只接受以下键：

```text
stop
temperature
max_tokens
frequency_penalty
presence_penalty
```

这些字段在 `extensions/copilot/src/extension/conversation/vscode-node/languageModelAccess.ts` 的 `LanguageModelOptions` 中白名单过滤，再转换成 `OptionalChatRequestParams`。底层 `OptionalChatRequestParams` 类型还包含 `top_p`、`n`、`stream` 等字段，但当前这条 `vscode.lm` 包装路径没有放行它们。

## Agent 场景如何使用模型配置

Chat service 构造 agent request 时会携带：

- `userSelectedModelId`
- `modelConfiguration`

代码位置：`src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts`。

扩展侧转换为 `vscode.ChatRequest` 时暴露：

- `request.model`
- `request.modelConfiguration`

代码位置：`src/vs/workbench/api/common/extHostTypeConverters.ts`。

Agent Host 场景也复用 `ILanguageModelsService`：

- `AgentHostLanguageModelProvider` 把 agent host root state 中的 `AgentInfo.models` 暴露为可选 language model。
- 这些模型带有 `targetChatSessionType`，只在对应 chat session type 中出现。
- 其 `configSchema` 转换为 VS Code 的 `configurationSchema`。
- `AgentHostSessionHandler` 创建 `ModelSelection` 时把 `modelConfiguration` 转为 agent host 可消费的 `config`。

一个特殊点是：Agent Host 模型的 provider 不支持直接 `sendChatRequest`，模型选择只服务于 agent session 的模型选择。

## 数据流示意

### 添加自定义模型

```text
Manage Language Models
  -> Add Models...
  -> 选择 vendor
  -> configureLanguageModelsProviderGroup(vendor)
  -> 写入 chatLanguageModels.json
  -> onDidChangeLanguageModelGroups
  -> _resolveAllLanguageModels(vendor)
  -> provider.provideLanguageModelChatInformation({ configuration })
  -> 模型进入 picker / 管理页
```

### 配置单模型参数

```text
模型 metadata.configurationSchema
  -> 模型选择器/管理页生成 Configure actions
  -> setModelConfiguration 或 configureModel
  -> 写入 group.settings[modelId]
  -> getModelConfiguration 合并 defaults + user settings
  -> agent request / lm request 中传给 provider
```

### 发起 agent 请求

```text
chat widget 当前模型
  -> userSelectedModelId
  -> languageModelsService.getModelConfiguration(modelId)
  -> IChatAgentRequest.modelConfiguration
  -> vscode.ChatRequest.modelConfiguration
  -> provider / agent host 使用该配置
```

## 关键限制与注意事项

1. 用户新增模型依赖已有 provider。没有扩展贡献 `languageModelChatProviders` 并注册 provider，用户不能仅靠 JSON 新增一个 vendor。
2. `customoai` 在 package contribution 中带 `productQualityType != 'stable'` 条件，stable 是否显示要看产品质量类型。
3. API key 等 secret 字段应通过 UI 写入，因为 UI 会保存到 SecretStorage 并在 JSON 中放占位符。
4. `modelOptions` 是请求级参数，不会持久化；持久化参数应走 `configurationSchema` 和 `settings`。
5. `top_p` 虽然在底层请求类型存在，但 Copilot 的 `vscode.lm` 包装白名单当前没有转发它。
6. BYOK 可用性受账号、组织策略和产品环境影响。Business/Enterprise 场景可能由组织管理。

## 主要源码参考

- `src/vscode-dts/vscode.d.ts`：稳定 `vscode.lm` API、`LanguageModelChat`、`LanguageModelChatProvider`、`modelOptions`。
- `src/vscode-dts/vscode.proposed.chatProvider.d.ts`：`configurationSchema`、`modelConfiguration`、provider configuration。
- `src/vs/workbench/contrib/chat/common/languageModels.ts`：核心 `LanguageModelsService`、provider extension point、模型发现、配置合并、secret 处理。
- `src/vs/workbench/contrib/chat/common/languageModelsConfiguration.ts`：`chatLanguageModels.json` 的 provider group 接口。
- `src/vs/workbench/contrib/chat/browser/languageModelsConfigurationService.ts`：配置文件路径、读写、JSON schema 注册。
- `src/vs/workbench/contrib/chat/browser/chatManagement/chatManagement.contribution.ts`：`Manage Language Models`、`Open Language Models (JSON)` 命令。
- `src/vs/workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts`：模型管理页的 `Add Models...`、provider group 配置、单模型配置入口。
- `src/vs/workbench/contrib/chat/browser/widget/input/chatModelPicker.ts`：模型选择器、配置描述和 toolbar actions。
- `src/vs/workbench/api/common/extHostLanguageModels.ts`：extension host 侧 provider 注册、模型 metadata 转换、请求转发。
- `src/vs/workbench/api/browser/mainThreadLanguageModels.ts`：main thread 侧 provider 注册桥接、选择模型、转发请求。
- `extensions/copilot/package.json`：Copilot/BYOK provider contribution 和各 provider 的配置 schema。
- `extensions/copilot/src/extension/byok/vscode-node/byokContribution.ts`：BYOK provider 启用与注册。
- `extensions/copilot/src/extension/byok/vscode-node/customOAIProvider.ts`：OpenAI-compatible 自定义模型解析和 endpoint 创建。
- `extensions/copilot/src/extension/byok/vscode-node/abstractLanguageModelChatProvider.ts`：BYOK provider 配置解析、模型列表和请求复用。
- `extensions/copilot/src/extension/byok/vscode-node/byokModelInfo.ts`：BYOK 模型能力到 `LanguageModelChatInformation` 的转换，以及 `reasoningEffort` 配置 schema。
- `extensions/copilot/src/extension/conversation/vscode-node/languageModelAccess.ts`：Copilot provider 注册、模型 metadata 生成、`contextSize`/`reasoningEffort`、`modelOptions` 白名单。
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostLanguageModelProvider.ts`：Agent Host 模型作为 language model 暴露。
- `src/vs/workbench/contrib/chat/browser/agentSessions/agentHost/agentHostSessionHandler.ts`：Agent Host 将 `modelConfiguration` 转为 model selection config。
