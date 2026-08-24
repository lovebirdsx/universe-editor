# apps/editor/src/renderer/workbench/ai/CLAUDE.md

> 本文是 `services/ai/CLAUDE.md` 的子域文档（AI 设置页面壳），原为其「AI 设置页面」章。AI 域全景（内联补全 / NES / 模型门面）见 [`../../services/ai/CLAUDE.md`](../../services/ai/CLAUDE.md)；Claude agent 设置内容本体见 [`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)，Codex 见 [`../agentSettings/codex/CLAUDE.md`](../agentSettings/codex/CLAUDE.md)。

## AI 设置页面（统一 Settings editor，AI + Agents）

设置页是一个**虚拟 editor**（不是 webview、不是 view），对标 VSCode Settings Editor 的「左侧分类导航 + 右侧内容」双栏范式。左侧导航分两组：**AI**（静态分类：模型配置 / 功能模型）+ **Agents**（动态列出 `IAcpAgentRegistry.list()` 的每个 acp agent，选中后渲染该 agent 贡献的设置组件）。本节只讲这个**页面壳**怎么拼起来；底层 AI 模型服务三层架构（platform 契约 / main 实现 / renderer 门面）、加协议 provider、密钥明文策略见 `apps/editor/CLAUDE.md` **套路 I**；Claude/agent 设置内容本体（claudeConfig 服务、认证选择、面板）见 [`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)。

> ⚠️ 第一原则：先认领改动落在**哪一层**——① 页面壳（导航/分组/状态/帮助，`AiSettingsEditor.tsx`）② 某个 AI 分类面板（`AiModelsPanel` / `AiFeatureModelsPanel`）③ 某个 agent 的设置组件（经 `agentSettingsRegistry` 贡献，见 [`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)）④ 选模型命令（`actions/*Actions.ts`）⑤ 底层服务（`IAiModelService`，**出本主题**）。

> 🔀 **2026-06 合并**：原独立的 Agent Settings editor（`agentSettings/AgentSettingsEditor.tsx` + `AgentSettingsEditorInput`）已删除，其「列 agent + 渲染贡献组件」的壳职责并入本 `AiSettingsEditor`。`agentSettings/` 目录现只剩贡献注册表与 Claude 设置内容本体（仍原位）。

### 文件地图

```
apps/editor/src/renderer/workbench/ai/
  AiSettingsEditor.tsx        双栏壳：左侧 nav 两组——
                              · AI 组：AI_CATEGORIES 静态数组（id/icon/label/panel/help）
                              · Agents 组：registry.list() 动态映射（AgentIcon + 名称）
                              右侧：AI 项 → header(标题 + 帮助按钮) + body(滚动容器)；
                                    agent 项 → getAgentSettingsComponent(id) 渲染贡献组件（自带滚动），无则占位
                              统一持久化：settings.activeItem（值 `ai:<cat>` / `agent:<id>`）+ AI 项 per-item scrollTop
                              顶部 `import '../agentSettings/builtinAgentSettings.js'` 触发 Claude 自注册
  AiModelsPanel.tsx           AI 分类①「模型配置」：单层 Provider 入口列表（每个 gateway 端点一条）
                              顶部旧格式 banner + 「添加提供方」；`replaceProviderAt(index, patch)` 是唯一写入口
                              （按 index 不按 id——手写文件可能重复 id，改一张卡不能连带改另一张）
                              **所有写盘串行化**：updateProviders 是全量替换，故写入基于 `providersRef.current`
                              而非渲染态，并经 `enqueueWrite` 排队（含 setApiKey/deleteApiKey——main 侧同样是
                              读改写）。逐字段即时保存下，Tab 换字段会让两次提交重叠，用渲染快照必丢改动
                              **账号用量在此批量拉**（按 effectiveUsageSource 过滤 id → Promise.allSettled →
                              整张 Map 全量替换 → 折算成 UsageState 下传）：徽标在卡片折叠时也要显示，而卡片
                              折叠时 body 不挂载；且所有该重拉的触发源都已收敛到 reload()
  ProviderEntryCard.tsx       入口卡**壳**：header(badges/用量徽标/ConnectivityDot/Duplicate/Remove) + 折叠 +
                              三个 CardSection 编排（价格来源/用量来源/协议与模型）；
                              连通性**自动探测**（useAutoVerify）：挂载读 IStorageService 缓存（`ai.settings.connectivity.<id>`，
                              5 分钟 TTL）、缺失/过期即探测；连接字段变更防抖重测；无手动按钮
  providerCard/               卡片内部的可编辑分区（8 个字段全覆盖，统一「即时保存 + 内联反馈」范式）
    SettingRow.tsx            紧凑行（label 左固定列宽 / 控件右 + note 下方）；窄卡片经 @container 回退成上下两行
    CardSection.tsx           带摘要的二级折叠区（标题+摘要常显 + header 右侧 actions 位），受控、折叠态由面板持久化
                              **不复用 workbench-ui 的 CollapsibleSlot**：它硬编码 ACP testid、标题/摘要二选一、无 actions 位
    usageState.ts             UsageState 三态（none / loading / ready+可能 undefined）——loading 与
                              「拉到了但没值」必须分开，后者要显示「不可用」而不是永远转圈
    useProviderField.ts       `patchField`(空值即删 key) / `useProviderField`(写盘 + 盖「已保存」戳) /
                              `useEditableText`(草稿在聚焦期不被 aiSettings.json 热重载覆盖)
    useAutoVerify.ts          卡片连通性自动探测：挂载恢复缓存（5 分钟 TTL）+ 缺失/过期自动 verify +
                              连接字段指纹变化 600ms 防抖重测（绕过 TTL）+ token 竞态防护；不可测保持「未测试」
    SavedIndicator.tsx        字段级「已保存」内联反馈（按 field 名匹配 stamp）
    IssuesSection.tsx         8 种 issue 徽章 + 「如何修复」引导；`issueReasonLabel` 从这里导出
    ConnectionFields.tsx      Base URL / API Key（内联编辑）+ `InheritanceNote`（继承 vs 覆盖标注）
    ExtendsField.tsx          extends 下拉（候选排除自己与后代）+ 写盘前用 resolveProviderEntries 预跑拦截
    ProtocolsSection.tsx      **重头戏**：protocolMap 三态编辑（未声明 / `[]` discover / 非空静态清单）+
                              协议增删 + 固化 + 探测 + 行内 ModelRow（含 configurationSchema 齿轮、RateBadge）
                              标题与 SavedIndicator 由外层 CardSection 持有，本组件只渲染 body
    ProbeModelsDialog.tsx     探测结果勾选弹窗（VirtualList + filter，默认只勾前 50，>200 提示改回 discover）
    ModelRefEditor.tsx        单条 ref 高级编辑（wire name / knowledge ref / capabilities 只能收窄）
    RemoteSourceFields.tsx    pricingSource / usageSource 两个 CardSection（默认折叠，摘要带路径/币种/模型数）：
                              None / catalog+vendor / http-json 表单 + raw JSON 逃生舱 + 刷新 + 用量明细行
                              **渲染一律跟 effective source（自身或祖先），写盘一律只 patch 自身字段**——
                              main 展平 extends 后按子条目 id 缓存，只读自身值会把已有数据显示成「无」
  AddProviderDialog.tsx       加 provider 弹窗：模板选择器（预填 baseUrl/protocolMap/pricingSource，
                              **永不填 id 与 apiKey**）+ 单层表单 → updateProviders
  AiFeatureModelsPanel.tsx    AI 分类②「功能模型」：chat / inline / commit 三行，数据驱动（FEATURES 数组）
                              点击行 → executeCommand 对应 pickModel 命令 → reload
  AiSettingsHelpButton.tsx    AI 分类 header 右上角「?」：点击弹 FocusScopeOverlay + MarkdownView 浮层（agent 项无帮助）
  aiSettingsHelpText.ts       两段帮助 markdown（default 英文；中文在 zh-CN.ts 同 key）
  AiSettingsEditor.module.css 壳样式（双栏 + navGroupTitle 分组标题 + 卡片 + 功能行 + 帮助浮层 + 空状态），颜色用 --vscode-* 变量（运行时注入）+ tokens.css 间距/字号 token

apps/editor/src/renderer/workbench/agentSettings/   ← agent 设置内容本体（见 [`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)）
  agentSettingsRegistry.ts    registerAgentSettings / getAgentSettingsComponent（壳据此渲染 agent 项）
  builtinAgentSettings.ts     副作用 hub：import './claude/ClaudeAgentSettings.js'
  claude/*                    Claude 的认证/模型/环境面板 + useClaudeConfig

apps/editor/src/renderer/services/editor/AiSettingsEditorInput.ts
                              虚拟 EditorInput，typeId 'aiSettings'，resource universe:/aiSettings，无状态，getName 'Settings'

apps/editor/src/renderer/actions/
  aiActions.ts                PickModelAction(ai.pickModel) / ManageModelsAction(ai.manageModels，标题 Open AI & Agent Settings)
                              / OpenAiSettingsJsonAction / Set·ClearApiKeyAction + pickProvider helper
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

### 状态持久化套路（本页核心）

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
| group 折叠态（整体一个 Record） | `ai.settings.models.collapsed`；内部 key：`section:providers` / `provider:<id>` / `provider:<id>:pricing` / `:usage` / `:protocols` | GLOBAL |
| Claude 子分类 / 滚动（agent 项内部自管） | `agent.settings.claude.activeCategory` / `…scroll.<id>` | GLOBAL |

> 全用 GLOBAL（AI/agent 配置与 workspace 无关）。滚动恢复要 `requestAnimationFrame` 等面板渲染后再设 `scrollTop`；切换项前先 flush 旧 AI 项滚动位置（agent 项不在壳里跟踪滚动）。

### 多语言（NLS）约定 —— 最容易写错

机制：`localize(key, defaultMessage, vars?)`，运行时 `messages[key] ?? fallbackMessages[key] ?? defaultMessage`（实现 `packages/platform/src/nls/nls.ts`）。

铁律：

1. **`defaultMessage` 永远写英文**（它是 fallback）。**绝不**把中文写进 default——否则英文环境显示中文。
2. 中文翻译加到 `apps/editor/src/shared/i18n/messages/zh-CN.ts`（同 key）。en-US **不用加**（命中失败回落 default 英文即可）。
3. 帮助 markdown 这类长文本：default（英文）在 `aiSettingsHelpText.ts` 用数组 `.join('\n')`；中文在 zh-CN.ts 同 key 也用 `.join('\n')`。
4. 加新 UI 文本 = 配一个 `localize('aiXxx.yyy', 'English')` + 去 zh-CN.ts 补 `'aiXxx.yyy': '中文'`。
5. 校验某 key 是否漏翻：`rg "localize\(\s*'aiXxx" workbench/ai` 列出 key，比对 zh-CN.ts。

可用语言 `en-US` / `zh-CN`（`shared/i18n/availableLocales.ts`）；NLS 在 `shared/i18n/bootstrap.ts` 用 `configureNls` 装配，跟随设置 `workbench.language`。

### 常见任务 → 改哪里

- **加一个 AI 分类**：`AiSettingsEditor.tsx` 的 `AI_CATEGORIES` 加一项（id / lucide icon / label(localize) / panel 组件 / help 函数）；新建 `XxxPanel.tsx`（用 `styles['panel']` 容器）；`aiSettingsHelpText.ts` 加一段 help（英文）+ zh-CN.ts 补中文。AI 分类是**静态数组**，不做 DI 注册表（数量少，避免过度设计）。
- **加一个 agent 的设置页**（如 codex）：**不动壳**——agent 项由 `registry.list()` 自动出现在 Agents 组。只需新建 `agentSettings/<agent>/XxxAgentSettings.tsx`（末行 `registerAgentSettings('<id>', Comp)`）+ 在 `agentSettings/builtinAgentSettings.ts` 加一行 import。详见 [`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)。
- **某 AI 分类面板加控件**：优先用 workbench-ui 原子件（`Button`/`IconButton`/`Input`/`Checkbox`/`Badge`/`Select`）+ `styles` 里 token 化样式；按钮尽量图标化（`IconButton` + lucide，必带 `label`）。**别再写原生 `<select>`**——`Select` 是自渲染浮层（触发器 `role="combobox"`、选项 `role="option"`），测试里 `fireEvent.change` 对它无效，要点开再点选项。
- **改 protocolMap / 模型声明编辑**：`providerCard/ProtocolsSection.tsx`（三态与协议增删）+ `providerCard/ModelRefEditor.tsx`（单条 ref）；纯函数（三态语法、ref 字符串↔对象归一化、探测结果回填 `mergeProbedSelection`）在 `shared/ai/protocolMapEdit.ts`，继承链遍历与「探测该拨哪个地址」的 `effectiveConnection` 在 `shared/ai/providerInheritance.ts`——**这两个文件是可单测的边界，逻辑优先往那儿放**。
- **动到「连通性探测 / 探测端点」**：连接信息一律走 `effectiveConnection(provider, allProviders)`，不要直接读 `provider.baseUrl/apiKey`——纯继承条目自身两者皆空，拨出去必失败。它返回的是**祖先的明文密钥**，只可用于发往 main 建连，**绝不能渲染**。
- **加一条 provider 模板**：`shared/ai/providerTemplates.ts` 加一项；官方端点的 baseUrl 必须与 `shared/ai/officialEndpoints.ts` 对齐（`providerTemplates.test.ts` pin 住了这个一致性）。
- **加一个功能→模型项**：`AiFeatureModelsPanel.tsx` 的 `FEATURES` 数组加一项（icon / label / desc / command / read）；该功能的 pickModel 命令需已存在（否则先按 actions 套路加）。
- **改选模型 QuickPick 外观**（分组/勾选/描述）：只改 `aiModelPickItems.ts` 的 `buildModelPickItems`，三个 picker 同步生效。
- **加持久化状态**：起一个 `ai.settings.*` 的 GLOBAL key，按上面套路读写 + restoredRef 守卫。
- **改帮助内容/宽度**：内容 `aiSettingsHelpText.ts`(英) + zh-CN.ts(中)；浮层宽度/样式 `AiSettingsEditor.module.css` 的 `.helpPopover`。
- **改命令标题/ID**：`actions/aiActions.ts`（AI 入口）/ `actions/agentActions.ts`（`OpenAgentSettingsAction`）。注意命令 ID 不要随便改（状态栏/AcpSessionEditor 齿轮/acpSessionService 在引用 `workbench.action.agent.openSettings`）；标题改了记得 zh-CN.ts 对应 `action.*` 同步。

### 关键架构决策与「为什么」

- **AI 与 Agents 合并到同一壳（2026-06）**：原 Agent Settings 是独立 editor，与 AI Settings 两套界面拼在一起、统一感弱。合并后是**一个**虚拟 editor、左侧单栏分两组（AI 静态分类 + Agents 动态列表），右侧按选中项类型分支渲染。入口也收敛——`ai.manageModels`（标题 Open AI & Agent Settings）是主入口；`workbench.action.agent.openSettings` 保留（兼容 AcpSessionEditor 齿轮等调用），改为预置 `settings.activeItem` 后打开同一编辑器并定位到 Agents 区。
- **AI 分类用静态数组、Agents 用动态注册表**：AI 分类数量少且固定，硬编码 `AI_CATEGORIES`；agent 数量随 `IAcpAgentRegistry` 变化，且每个 agent 的设置 UI 自包含，故走 `agentSettingsRegistry` 贡献机制（壳零改动即可加新 agent）。
- **agent 项右侧不套壳的滚动容器**：agent 贡献组件（如 Claude）自带 `subNav`/`subBody` 横向分栏与内部滚动，壳只在 AI 项管 scrollTop，避免双滚动条。agent 项也无帮助按钮（help 是 AI 专属文案）。
- **激活模型只在「功能模型」分类设置**：chat/inline/commit 的活跃模型由 `AiFeatureModelsPanel` 点击行触发对应命令统一管理。**`AiModelsPanel` 不再有「设为活跃」入口**（曾有，已移除）——模型配置面板只管「配置模型」（baseUrl/key/参数/增删），不管「用哪个」，避免两处重复。
- **点击功能行复用命令而非自造 picker**：`AiFeatureModelsPanel` 直接 `executeCommand('ai.pickModel'…)`，确保和状态栏 model picker 完全一致的体验，零重复逻辑。
- **虚拟 EditorInput 无状态**：`AiSettingsEditorInput` 不存任何东西，页面所有数据 live 读 `IAiModelService` / `IClaudeConfigService`，UI 态（激活项/折叠/滚动/过滤）走 IStorageService。这样多窗口/重开行为一致。
- **帮助浮层用 FocusScopeOverlay**：自带 focus trap + Esc + restoreFocus；再叠一个透明 backdrop 实现点击外部关闭。内容走共享 `MarkdownView`（不引新依赖）。
- **样式零硬编码**：颜色只用 `--vscode-*` 变量（58 处，由 `renderer/services/themes/generateColorThemeCss.ts` 在运行时注入为 `:root` CSS 变量，本 CSS 文件不定义这些变量；文件里仅剩注释里一处 `--color-*` 字样）+ `tokens.css` 的 spacing/radius/font token，切主题零改动。注意：`agentSettings/AgentSettingsEditor.module.css`（Claude/Codex 面板复用）用 `--ue-*` token，两套并存。

### 易踩坑速记

1. **中文写进 localize default**（最常见）：default 必须英文，中文去 zh-CN.ts。见上「NLS 约定」。
2. **`exactOptionalPropertyTypes` 下传 `styles['x']` 给可选 string prop 会报 TS2375**：`styles[...]` 类型是 `string | undefined`。给只接受 `string` 的 prop（如 `MarkdownView.className`）要 `styles['x'] ?? ''`。
3. **滚动恢复设早了不生效**：面板内容异步渲染，`scrollTop` 要在 `requestAnimationFrame` 里设；切分类前先把旧分类的 scrollTop flush 掉。
4. **折叠态是一个整体 Record 存一个 key**，不是每 group 一个 key——读写时整体覆盖。storage 里**只有用户点过的 key**，所以 `toggleCollapsed(key, defaultCollapsed)` 必须对「有效值」取反（`!(prev[key] ?? defaultCollapsed)`）：对默认折叠的区，用 `!prev[key]` 会把 undefined 翻成 true（仍折叠），表现为**首次点击没反应**。
5. **卡内区域的默认折叠态在 `ProviderEntryCard` 传入**（pricing/usage=折叠，protocols=展开），读写两侧必须传同一个默认值。
6. **渲染继承字段要用 effective 值，写盘只写自身值**：main 展平 `extends` 后按子条目自己的 id 缓存费率/用量，UI 拿到的却是未展平的原始条目。只读 `provider.usageSource` 会把「已有数据」显示成「无」（这就是曾经的 bug）。收敛函数在 `shared/ai/providerInheritance.ts` 的 `effectiveRemoteSource` 系列。
5. **加了 localize key 忘了补 zh-CN**：英文环境正常、中文环境回落英文，静默不报错。改完用 `rg` 比对一遍。
6. **input→组件注册漏一处**：`EditorArea.tsx`（`editorComponentMap.set('aiSettings', …)`）+ `BuiltInEditorProvidersContribution.ts` 两处都要有 'aiSettings'，否则页面开不出。（合并后只剩 'aiSettings' 一个 key，'agentSettings' 已删）
7. **改 agent 项渲染分支别忘 Claude 自注册**：壳顶部 `import '../agentSettings/builtinAgentSettings.js'` 是 Claude 设置组件注册的唯一触发点，删了它 Agents 区会全是占位。### 验证

```bash
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 涉及编辑器打开/交互时跑；已知多 worker flaky（folderDragNewWindow / simpleFileDialog / markdown* @p1）会在用例间漂移，单跑必过即非回归
# 手动（pnpm dev）：命令面板 "Open AI & Agent Settings" 打开 → 左侧 AI/Agents 两组切换
#   → AI 项：切分类 / 折叠 group / 过滤 / 点功能行选模型 / 点? 看帮助
#   → Agents 项：选 Claude 进 auth/model/env 三分类；从 ACP 会话编辑器点齿轮应定位到 Agents 区
#   → 切 workbench.language 为 en-US / zh-CN 验证两套文案 → 切 workbench.colorTheme 验证 dark/light
#   → 切激活项+滚动后重启 app，确认 settings.activeItem 恢复
```

### 关键参考路径

- `apps/editor/src/renderer/workbench/ai/AiSettingsEditor.tsx` —— 统一双栏壳 + AI_CATEGORIES + Agents 动态组 + 状态持久化
- `apps/editor/src/renderer/workbench/ai/AiModelsPanel.tsx` —— 模型配置面板（单层 Provider 入口列表，折叠/过滤/模型参数）
- `apps/editor/src/renderer/workbench/ai/AiFeatureModelsPanel.tsx` —— 功能→模型（FEATURES 数组）
- `apps/editor/src/renderer/workbench/ai/AiSettingsHelpButton.tsx` + `aiSettingsHelpText.ts` —— 帮助浮层 + 文案
- `apps/editor/src/renderer/workbench/ai/AiSettingsEditor.module.css` —— 壳样式（token 化，navGroupTitle 分组标题）
- `apps/editor/src/renderer/workbench/agentSettings/agentSettingsRegistry.ts` —— agent 设置贡献注册表（壳据此渲染 agent 项）
- `apps/editor/src/renderer/actions/aiModelPickItems.ts` —— 共享 QuickPick 项构建
- `apps/editor/src/renderer/actions/{aiActions,agentActions,inlineCompletionActions,commitMessageActions}.ts` —— 入口命令 + 选模型命令
- `apps/editor/src/shared/i18n/messages/zh-CN.ts` —— 中文翻译
- 相关：[`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)（Claude/agent 设置内容本体）、`apps/editor/CLAUDE.md` 套路 I（底层 AI 服务/加 vendor）、`packages/platform/src/nls/nls.ts`（localize 机制）
