---
name: ai-settings-subsystem-context
description: 制作或修改设置页面（统一 Settings editor，AI + Agents）相关功能时召回，提供该页面子系统的上下文地图——双栏壳结构、左侧导航分「AI」组（模型配置 / 功能模型，静态）+「Agents」组（动态列出 acp agent，每个 agent 渲染其贡献的设置组件）、状态持久化套路、帮助浮层、多语言（NLS）约定、与底层 IAiModelService 的边界。当任务涉及 apps/editor/src/renderer/workbench/ai/ 下的组件、AiSettingsEditorInput、ai.* 命令（pickModel / manageModels / openSettings / setApiKey…）、provider group / 功能→模型 的图形配置、把 agent 设置并进设置页、或要给设置加新分类 / 新控件 / 新帮助时，先读它建立全局认知。它给「改哪里 + 为什么 + 坑」；新增 AI provider/底层模型服务契约不在此（见 apps/editor/CLAUDE.md 套路 I）；Claude/agent 设置内容本体见 claude-agent-settings-context。
disable-model-invocation: true
---

# AI Settings 页面 子系统 上下文地图

设置页是一个**虚拟 editor**（不是 webview、不是 view），对标 VSCode Settings Editor 的「左侧分类导航 + 右侧内容」双栏范式。左侧导航分两组：**AI**（静态分类：模型配置 / 功能模型）+ **Agents**（动态列出 `IAcpAgentRegistry.list()` 的每个 acp agent，选中后渲染该 agent 贡献的设置组件）。本 skill 只讲这个**页面壳**怎么拼起来；底层 AI 模型服务三层架构（platform 契约 / main 实现 / renderer 门面）、加 vendor、密钥红线见 `apps/editor/CLAUDE.md` **套路 I**；Claude/agent 设置内容本体（claudeConfig 服务、认证库、面板）见 **claude-agent-settings-context**。

> ⚠️ 第一原则：先认领改动落在**哪一层**——① 页面壳（导航/分组/状态/帮助，`AiSettingsEditor.tsx`）② 某个 AI 分类面板（`AiModelsPanel` / `AiFeatureModelsPanel`）③ 某个 agent 的设置组件（经 `agentSettingsRegistry` 贡献，**见 claude-agent-settings-context**）④ 选模型命令（`actions/*Actions.ts`）⑤ 底层服务（`IAiModelService`，**出本 skill**）。

> 🔀 **2026-06 合并**：原独立的 Agent Settings editor（`agentSettings/AgentSettingsEditor.tsx` + `AgentSettingsEditorInput`）已删除，其「列 agent + 渲染贡献组件」的壳职责并入本 `AiSettingsEditor`。`agentSettings/` 目录现只剩贡献注册表与 Claude 设置内容本体（仍原位）。

## 文件地图

```
apps/editor/src/renderer/workbench/ai/
  AiSettingsEditor.tsx        双栏壳：左侧 nav 两组——
                              · AI 组：AI_CATEGORIES 静态数组（id/icon/label/panel/help）
                              · Agents 组：registry.list() 动态映射（AgentIcon + 名称）
                              右侧：AI 项 → header(标题 + 帮助按钮) + body(滚动容器)；
                                    agent 项 → getAgentSettingsComponent(id) 渲染贡献组件（自带滚动），无则占位
                              统一持久化：settings.activeItem（值 `ai:<cat>` / `agent:<id>`）+ AI 项 per-item scrollTop
                              顶部 `import '../agentSettings/builtinAgentSettings.js'` 触发 Claude 自注册
  AiModelsPanel.tsx           AI 分类①「模型配置」：provider group 卡片（baseUrl / apiKey / 模型列表 / 单模型参数）
                              GroupCard（可折叠，折叠态持久化）+ ModelRow（参数配置展开）
                              模型过滤框（per-group 持久化）；自定义模型置顶 + ★ 标记
  AiFeatureModelsPanel.tsx    AI 分类②「功能模型」：chat / inline / commit 三行，数据驱动（FEATURES 数组）
                              点击行 → executeCommand 对应 pickModel 命令 → reload
  AiSettingsHelpButton.tsx    AI 分类 header 右上角「?」：点击弹 FocusScopeOverlay + MarkdownView 浮层（agent 项无帮助）
  aiSettingsHelpText.ts       两段帮助 markdown（default 英文；中文在 zh-CN.ts 同 key）
  AiSettingsEditor.module.css 壳样式（双栏 + navGroupTitle 分组标题 + 卡片 + 功能行 + 帮助浮层 + 空状态），只用 --color-* + tokens.css

apps/editor/src/renderer/workbench/agentSettings/   ← agent 设置内容本体（见 claude-agent-settings-context）
  agentSettingsRegistry.ts    registerAgentSettings / getAgentSettingsComponent（壳据此渲染 agent 项）
  builtinAgentSettings.ts     副作用 hub：import './claude/ClaudeAgentSettings.js'
  claude/*                    Claude 的认证/模型/环境面板 + useClaudeConfig

apps/editor/src/renderer/services/editor/AiSettingsEditorInput.ts
                              虚拟 EditorInput，typeId 'aiSettings'，resource universe:/aiSettings，无状态，getName 'Settings'

apps/editor/src/renderer/actions/
  aiActions.ts                PickModelAction(ai.pickModel) / ManageModelsAction(ai.manageModels，标题 Open AI & Agent Settings)
                              / OpenAiSettingsJsonAction / Set·ClearApiKeyAction + pickGroup helper
  agentActions.ts             OpenAgentSettingsAction(workbench.action.agent.openSettings)：
                              预置 settings.activeItem=`agent:<defaultAgentId>` 后打开同一 AiSettingsEditorInput（定位到 Agents 区）
  inlineCompletionActions.ts  PickInlineCompletionModelAction(ai.inlineCompletion.pickModel) 等
  commitMessageActions.ts     PickCommitModelAction(ai.commitMessage.pickModel)
  aiModelPickItems.ts         共享 buildModelPickItems(models, active)：三个 picker 统一的分组/勾选 QuickPick 项

apps/editor/src/shared/i18n/messages/zh-CN.ts   所有 ai.* / aiModels.* / aiFeatures.* / aiSettings.* / settings.group.* 中文翻译
```

input→组件注册两处（套路见 apps/editor/CLAUDE.md「编辑器输入」）：
- `workbench/editor/EditorArea.tsx`：`editorComponentMap.set('aiSettings', AiSettingsEditor)`
- `contributions/BuiltInEditorProvidersContribution.ts`：注册 typeId / componentKey / deserialize

## 状态持久化套路（本页核心）

仿 `ScmView` 的写法，**用 `IStorageService` 直接读写，不要建 service**（PersistedStateBase 是给 service 的，这里是组件态）：

```ts
const storage = useService(IStorageService)
// 恢复：挂载时 storage.get(KEY, StorageScope.GLOBAL) → setState；restoredRef 守卫避免首帧把默认值写回
// 持久化：状态变化时 storage.set(KEY, value, StorageScope.GLOBAL)（滚动/输入类 debounce ~200ms）
```

已落地的持久化项与 key：
| 状态 | key | 作用域 |
|---|---|---|
| 当前激活项（AI 分类或 agent） | `settings.activeItem`（值 `ai:<cat>` / `agent:<id>`） | GLOBAL |
| 各 AI 分类滚动位置 | `ai.settings.scroll.ai:<categoryId>` | GLOBAL |
| group 折叠态（整体一个 Record） | `ai.settings.models.collapsed` | GLOBAL |
| 各 group 模型过滤文本 | `ai.settings.models.filter.<groupKey>` | GLOBAL |
| Claude 子分类 / 滚动（agent 项内部自管） | `agent.settings.claude.activeCategory` / `…scroll.<id>` | GLOBAL |

> 全用 GLOBAL（AI/agent 配置与 workspace 无关）。滚动恢复要 `requestAnimationFrame` 等面板渲染后再设 `scrollTop`；切换项前先 flush 旧 AI 项滚动位置（agent 项不在壳里跟踪滚动）。

## 多语言（NLS）约定 —— 最容易写错

机制：`localize(key, defaultMessage, vars?)`，运行时 `messages[key] ?? fallbackMessages[key] ?? defaultMessage`（实现 `packages/platform/src/nls/nls.ts`）。

铁律：
1. **`defaultMessage` 永远写英文**（它是 fallback）。**绝不**把中文写进 default——否则英文环境显示中文。
2. 中文翻译加到 `apps/editor/src/shared/i18n/messages/zh-CN.ts`（同 key）。en-US **不用加**（命中失败回落 default 英文即可）。
3. 帮助 markdown 这类长文本：default（英文）在 `aiSettingsHelpText.ts` 用数组 `.join('\n')`；中文在 zh-CN.ts 同 key 也用 `.join('\n')`。
4. 加新 UI 文本 = 配一个 `localize('aiXxx.yyy', 'English')` + 去 zh-CN.ts 补 `'aiXxx.yyy': '中文'`。
5. 校验某 key 是否漏翻：`rg "localize\(\s*'aiXxx" workbench/ai` 列出 key，比对 zh-CN.ts。

可用语言 `en-US` / `zh-CN`（`shared/i18n/availableLocales.ts`）；NLS 在 `shared/i18n/bootstrap.ts` 用 `configureNls` 装配，跟随设置 `workbench.language`。

## 常见任务 → 改哪里

- **加一个 AI 分类**：`AiSettingsEditor.tsx` 的 `AI_CATEGORIES` 加一项（id / lucide icon / label(localize) / panel 组件 / help 函数）；新建 `XxxPanel.tsx`（用 `styles['panel']` 容器）；`aiSettingsHelpText.ts` 加一段 help（英文）+ zh-CN.ts 补中文。AI 分类是**静态数组**，不做 DI 注册表（数量少，避免过度设计）。
- **加一个 agent 的设置页**（如 codex）：**不动壳**——agent 项由 `registry.list()` 自动出现在 Agents 组。只需新建 `agentSettings/<agent>/XxxAgentSettings.tsx`（末行 `registerAgentSettings('<id>', Comp)`）+ 在 `agentSettings/builtinAgentSettings.ts` 加一行 import。详见 **claude-agent-settings-context**。
- **某 AI 分类面板加控件**：优先用 workbench-ui 原子件（`Button`/`IconButton`/`Input`/`Checkbox`/`Badge`）+ `styles` 里 token 化样式；按钮尽量图标化（`IconButton` + lucide，必带 `label`）。
- **加一个功能→模型项**：`AiFeatureModelsPanel.tsx` 的 `FEATURES` 数组加一项（icon / label / desc / command / read）；该功能的 pickModel 命令需已存在（否则先按 actions 套路加）。
- **改选模型 QuickPick 外观**（分组/勾选/描述）：只改 `aiModelPickItems.ts` 的 `buildModelPickItems`，三个 picker 同步生效。
- **加持久化状态**：起一个 `ai.settings.*` 的 GLOBAL key，按上面套路读写 + restoredRef 守卫。
- **改帮助内容/宽度**：内容 `aiSettingsHelpText.ts`(英) + zh-CN.ts(中)；浮层宽度/样式 `AiSettingsEditor.module.css` 的 `.helpPopover`。
- **改命令标题/ID**：`actions/aiActions.ts`（AI 入口）/ `actions/agentActions.ts`（`OpenAgentSettingsAction`）。注意命令 ID 不要随便改（状态栏/AcpSessionEditor 齿轮/acpSessionService 在引用 `workbench.action.agent.openSettings`）；标题改了记得 zh-CN.ts 对应 `action.*` 同步。

## 关键架构决策与「为什么」

- **AI 与 Agents 合并到同一壳（2026-06）**：原 Agent Settings 是独立 editor，与 AI Settings 两套界面拼在一起、统一感弱。合并后是**一个**虚拟 editor、左侧单栏分两组（AI 静态分类 + Agents 动态列表），右侧按选中项类型分支渲染。入口也收敛——`ai.manageModels`（标题 Open AI & Agent Settings）是主入口；`workbench.action.agent.openSettings` 保留（兼容 AcpSessionEditor 齿轮等调用），改为预置 `settings.activeItem` 后打开同一编辑器并定位到 Agents 区。
- **AI 分类用静态数组、Agents 用动态注册表**：AI 分类数量少且固定，硬编码 `AI_CATEGORIES`；agent 数量随 `IAcpAgentRegistry` 变化，且每个 agent 的设置 UI 自包含，故走 `agentSettingsRegistry` 贡献机制（壳零改动即可加新 agent）。
- **agent 项右侧不套壳的滚动容器**：agent 贡献组件（如 Claude）自带 `subNav`/`subBody` 横向分栏与内部滚动，壳只在 AI 项管 scrollTop，避免双滚动条。agent 项也无帮助按钮（help 是 AI 专属文案）。
- **激活模型只在「功能模型」分类设置**：chat/inline/commit 的活跃模型由 `AiFeatureModelsPanel` 点击行触发对应命令统一管理。**`AiModelsPanel` 不再有「设为活跃」入口**（曾有，已移除）——模型配置面板只管「配置模型」（baseUrl/key/参数/增删），不管「用哪个」，避免两处重复。
- **点击功能行复用命令而非自造 picker**：`AiFeatureModelsPanel` 直接 `executeCommand('ai.pickModel'…)`，确保和状态栏 model picker 完全一致的体验，零重复逻辑。
- **虚拟 EditorInput 无状态**：`AiSettingsEditorInput` 不存任何东西，页面所有数据 live 读 `IAiModelService` / `IClaudeConfigService`，UI 态（激活项/折叠/滚动/过滤）走 IStorageService。这样多窗口/重开行为一致。
- **帮助浮层用 FocusScopeOverlay**：自带 focus trap + Esc + restoreFocus；再叠一个透明 backdrop 实现点击外部关闭。内容走共享 `MarkdownView`（不引新依赖）。
- **样式零硬编码**：只用 `--color-*`（dark 默认 / light 在 `:root[data-theme=light]`，`workbench.css`）+ `tokens.css` 的 spacing/radius/font token，切主题零改动。注意：`ai/AiSettingsEditor.module.css` 用 `--color-*` token，而 `agentSettings/AgentSettingsEditor.module.css`（Claude 面板复用）用 `--ue-*` token，两套并存。

## 易踩坑速记

1. **中文写进 localize default**（最常见）：default 必须英文，中文去 zh-CN.ts。见上「NLS 约定」。
2. **`exactOptionalPropertyTypes` 下传 `styles['x']` 给可选 string prop 会报 TS2375**：`styles[...]` 类型是 `string | undefined`。给只接受 `string` 的 prop（如 `MarkdownView.className`）要 `styles['x'] ?? ''`。
3. **滚动恢复设早了不生效**：面板内容异步渲染，`scrollTop` 要在 `requestAnimationFrame` 里设；切分类前先把旧分类的 scrollTop flush 掉。
4. **折叠态是一个整体 Record 存一个 key**，不是每 group 一个 key——读写时整体覆盖。
5. **加了 localize key 忘了补 zh-CN**：英文环境正常、中文环境回落英文，静默不报错。改完用 `rg` 比对一遍。
6. **input→组件注册漏一处**：`EditorArea.tsx`（`editorComponentMap.set('aiSettings', …)`）+ `BuiltInEditorProvidersContribution.ts` 两处都要有 'aiSettings'，否则页面开不出。（合并后只剩 'aiSettings' 一个 key，'agentSettings' 已删）
7. **改 agent 项渲染分支别忘 Claude 自注册**：壳顶部 `import '../agentSettings/builtinAgentSettings.js'` 是 Claude 设置组件注册的唯一触发点，删了它 Agents 区会全是占位。

## 验证

```bash
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 涉及编辑器打开/交互时跑；已知多 worker flaky（folderDragNewWindow / simpleFileDialog / markdown* @p1）会在用例间漂移，单跑必过即非回归
# 手动（pnpm dev）：命令面板 "Open AI & Agent Settings" 打开 → 左侧 AI/Agents 两组切换
#   → AI 项：切分类 / 折叠 group / 过滤 / 点功能行选模型 / 点? 看帮助
#   → Agents 项：选 Claude 进 auth/model/env 三分类；从 ACP 会话编辑器点齿轮应定位到 Agents 区
#   → 切 workbench.language 为 en-US / zh-CN 验证两套文案 → 切 workbench.colorTheme 验证 dark/light
#   → 切激活项+滚动后重启 app，确认 settings.activeItem 恢复
```

## 关键参考路径

- `apps/editor/src/renderer/workbench/ai/AiSettingsEditor.tsx` —— 统一双栏壳 + AI_CATEGORIES + Agents 动态组 + 状态持久化
- `apps/editor/src/renderer/workbench/ai/AiModelsPanel.tsx` —— 模型配置面板（折叠/过滤/置顶/参数）
- `apps/editor/src/renderer/workbench/ai/AiFeatureModelsPanel.tsx` —— 功能→模型（FEATURES 数组）
- `apps/editor/src/renderer/workbench/ai/AiSettingsHelpButton.tsx` + `aiSettingsHelpText.ts` —— 帮助浮层 + 文案
- `apps/editor/src/renderer/workbench/ai/AiSettingsEditor.module.css` —— 壳样式（token 化，navGroupTitle 分组标题）
- `apps/editor/src/renderer/workbench/agentSettings/agentSettingsRegistry.ts` —— agent 设置贡献注册表（壳据此渲染 agent 项）
- `apps/editor/src/renderer/actions/aiModelPickItems.ts` —— 共享 QuickPick 项构建
- `apps/editor/src/renderer/actions/{aiActions,agentActions,inlineCompletionActions,commitMessageActions}.ts` —— 入口命令 + 选模型命令
- `apps/editor/src/shared/i18n/messages/zh-CN.ts` —— 中文翻译
- 相关：`claude-agent-settings-context`（Claude/agent 设置内容本体）、`apps/editor/CLAUDE.md` 套路 I（底层 AI 服务/加 vendor）、`packages/platform/src/nls/nls.ts`（localize 机制）

## 其它

- 后续用本 skill，发现新经验，需同步更新本文件
