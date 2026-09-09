# apps/editor/src/renderer/workbench/ai/CLAUDE.md

> AI 设置页面壳（`services/ai/CLAUDE.md` 的子域）。AI 域全景见 [`../../services/ai/CLAUDE.md`](../../services/ai/CLAUDE.md)；Claude 内容本体见 [`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)，Codex 见 [`../agentSettings/codex/CLAUDE.md`](../agentSettings/codex/CLAUDE.md)。

## AI 设置页面（统一 Settings editor，AI + Agents）

设置页是一个**虚拟 editor**（非 webview/非 view），对标 VSCode Settings Editor 双栏范式。左侧两组：**AI**（静态分类：供应商配置 / 模型配置 / 功能模型 / MCP 服务器）+ **Agents**（动态列 `IAcpAgentRegistry.list()`，选中渲染该 agent 贡献的设置组件）。本文只讲**页面壳**；底层 AI 模型服务三层与密钥策略见 apps/editor/CLAUDE.md **套路 I**；agent 设置内容本体见各 agentSettings 文档。

改动先认层：① 页面壳（`AiSettingsEditor.tsx`）② AI 分类面板（AiProvidersPanel / AiModelKnowledgePanel / AiFeatureModelsPanel / AiMcpServersPanel）③ agent 设置组件（`agentSettingsRegistry`）④ 选模型命令（`actions/`）⑤ 底层服务（`IAiModelService`，出本主题）。

### 文件 → 职责

`workbench/ai/`：
- `AiSettingsEditor.tsx` — 双栏壳：AI 组 `AI_CATEGORIES` 静态数组；Agents 组 `registry.list()` 动态映射；右侧 AI 项 → header(标题+帮助) + body，agent 项 → `getAgentSettingsComponent(id)`（自带滚动）。激活项/滚动 IStorageService 持久化（`settings.activeItem`）。顶部 `import '../agentSettings/builtinAgentSettings.js'` 触发 Claude 自注册。
- `AiProvidersPanel.tsx` — 供应商配置：单层入口列表；`replaceProviderAt(index, patch)` 唯一写入口（按 index 不按 id）；**所有写盘串行化**（`providersRef.current` + `enqueueWrite` 排队，防 Tab 换字段两次提交重叠）；账号用量批量拉（Promise.allSettled 全量替换，收敛到 reload()）。
- `AiModelKnowledgePanel.tsx` — 模型配置：图形编辑顶层 `models` 知识库（**不含价格**）。Your Models + Built-in Models（Override 只写空条目 `{}`，物化-on-touch）；写入门控 + `enqueueWrite` 写时复查（见易踩坑 11）；不调 `getModels()`（慢枚举）。
- `PanelSection.tsx` — 面板顶层折叠区 + `useCollapseToggle`（折叠态整 Record 一个 key，对有效值取反）。
- `modelCard/` — 知识条目卡片：`ModelKnowledgeCard`（九字段，effective 渲染 + Built-in note + Rename/Duplicate/Remove）、`AddModelDialog`、`useEditableNumber`。
- `ProviderEntryCard.tsx` — 入口卡壳：header(徽标/ConnectivityDot/Duplicate/Remove) + 三个 CardSection（价格/用量/协议与模型）；`useAutoVerify` 自动探测连通性（缓存 5 分钟 TTL + 变更防抖重测）。
- `providerCard/` — 卡片可编辑分区（8 字段，即时保存 + 内联反馈；模型知识卡复用）：`HeaderAction` / `SettingRow` / `CardSection` / `usageState` / `useProviderField` / `useAutoVerify` / `SavedIndicator` / `IssuesSection` / `ConnectionFields` / `ExtendsField` / `ProtocolsSection` / `ProbeModelsDialog` / `ModelRefEditor` / `RemoteSourceFields`。三条关键：`CardSection` **不复用 workbench-ui 的 CollapsibleSlot**（硬编码 ACP testid、无 actions 位）；`useEditableText` 草稿聚焦期不被热重载覆盖；`RemoteSourceFields` **渲染跟 effective source（自身或祖先），写盘只 patch 自身**。
- `AddProviderDialog.tsx` — 模板选择器（预填 baseUrl/protocolMap/pricingSource，**永不填 id 与 apiKey**）。
- `AiFeatureModelsPanel.tsx` — 功能模型四行（FEATURES 数组 → executeCommand 对应 pickModel 命令）。
- `AiMcpServersPanel.tsx` — MCP 服务器列表（增删改）。
- `AiSettingsHelpButton.tsx` + `aiSettingsHelpText.ts` — 帮助浮层（FocusScopeOverlay + MarkdownView）；中文在 zh-CN.ts 同 key。
- `AiSettingsEditor.module.css` — 壳样式（`--vscode-*` 变量 + tokens.css token）。

`agentSettings/` 目录（内容本体见 [`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)）：`agentSettingsRegistry.ts`（registerAgentSettings / getAgentSettingsComponent）、`builtinAgentSettings.ts`（副作用 hub）、`claude/*`、`codex/*`。

`services/editor/AiSettingsEditorInput.ts` — 虚拟 EditorInput（typeId `aiSettings`，无状态）。input→组件注册两处：`workbench/editor/EditorArea.tsx` + `contributions/BuiltInEditorProvidersContribution.ts`。

`actions/`：`aiActions.ts`（`ai.pickModel` / `ai.manageModels`（标题 Open AI & Agent Settings）/ `ai.openSettingsJson` / Set·ClearApiKey）、`agentActions.ts`（`workbench.action.agent.openSettings`，预置 `settings.activeItem=agent:<defaultAgentId>`）、`inlineCompletionActions.ts` / `commitMessageActions.ts`（对应 pickModel）、`aiModelPickItems.ts`（`buildModelPickItems`，三个 picker 共享）。

`shared/i18n/messages/zh-CN.ts` — ai.* / aiModels.* / aiKnowledge.* / aiFeatures.* / aiSettings.* / settings.group.* 中文翻译。

### 状态持久化套路

仿 `ScmView`，**用 `IStorageService` 直接读写，不要建 service**：

```ts
const storage = useService(IStorageService)
// 恢复：挂载时 storage.get(KEY, StorageScope.GLOBAL) → setState；restoredRef 守卫防首帧写回
// 持久化：变化时 storage.set(KEY, value, GLOBAL)（滚动/输入类 debounce ~200ms）
```

| 状态 | key |
|---|---|
| 当前激活项 | `settings.activeItem`（值 `ai:<cat>` / `agent:<id>`） |
| 各 AI 分类滚动 | `ai.settings.scroll.ai:<categoryId>` |
| group 折叠态（整体 Record） | `ai.settings.models.collapsed`；内部 key：`section:providers` / `provider:<id>` / `<id>:pricing` / `<id>:usage` / `<id>:protocols` / `<id>:protocol:<协议>` |
| 模型知识库折叠态（整体 Record） | `ai.settings.modelKnowledge.collapsed`；内部 key：`section:custom` / `section:builtin` / `model:<key>` |
| Claude 子分类/滚动（agent 项自管） | `agent.settings.claude.activeCategory` / `…scroll.<id>` |

全用 GLOBAL（AI/agent 配置与 workspace 无关）。滚动恢复要 `requestAnimationFrame` 等面板渲染后再设 `scrollTop`；切换项前先 flush 旧 AI 项滚动位置。

### 多语言（NLS）约定 —— 最容易写错

`localize(key, defaultMessage, vars?)`：运行时 `messages[key] ?? fallbackMessages[key] ?? defaultMessage`（实现 `packages/platform/src/nls/nls.ts`）。铁律：

1. **`defaultMessage` 永远写英文**（fallback）。**绝不**把中文写进 default。
2. 中文加到 `shared/i18n/messages/zh-CN.ts`（同 key）；en-US **不用加**（回落 default）。
3. 长文本帮助：英文在 `aiSettingsHelpText.ts` 用 `.join('\n')`；中文 zh-CN.ts 同 key。
4. 加新 UI 文本 = `localize('aiXxx.yyy', 'English')` + zh-CN.ts 补 `'aiXxx.yyy': '中文'`；校验漏翻 `rg "localize\(\s*'aiXxx" workbench/ai` 对比 zh-CN.ts。

### 常见任务 → 改哪里

- **加一个 AI 分类**：`AiSettingsEditor.tsx` 的 `AI_CATEGORIES` 加一项（id / icon / label(localize) / panel / help）；新建 `XxxPanel.tsx`；`aiSettingsHelpText.ts` + zh-CN.ts 补文案。静态数组，不做 DI 注册表。
- **加一个 agent 的设置页**（如 codex）：**不动壳**——新建 `agentSettings/<agent>/XxxAgentSettings.tsx`（末行 `registerAgentSettings('<id>', Comp)`）+ `builtinAgentSettings.ts` 加一行 import。详见 [`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)。
- **面板加控件**：优先 workbench-ui 原子件 + token 化样式；按钮尽量 `IconButton` + lucide（必带 `label`）。**别再写原生 `<select>`**——`Select` 是自渲染浮层，`fireEvent.change` 无效，要点开再点选项。
- **改 protocolMap / 模型声明编辑**：`providerCard/ProtocolsSection.tsx` + `providerCard/ModelRefEditor.tsx`；纯函数（三态语法、ref 归一化、`mergeProbedSelection`）在 `shared/ai/protocolMapEdit.ts`，继承链与 `effectiveConnection` 在 `shared/ai/providerInheritance.ts`——**可单测边界，逻辑优先往那儿放**。
- **改模型知识库编辑**：编排 `AiModelKnowledgePanel.tsx` + `modelCard/*`；纯函数在 `shared/ai/modelKnowledgeEdit.ts` / `modelKnowledgeUsage.ts`。
- **动「连通性探测」**：连接信息一律走 `effectiveConnection(provider, allProviders)`，不要直读 `provider.baseUrl/apiKey`（纯继承条目自身为空，拨出去必失败）。返回的是**祖先的明文密钥**，只可发 main 建连，**绝不能渲染**。
- **加 provider 模板**：`shared/ai/providerTemplates.ts`；官方端点 baseUrl 必须与 `officialEndpoints.ts` 对齐（`providerTemplates.test.ts` pin 一致性）。
- **加功能→模型项**：`AiFeatureModelsPanel.tsx` FEATURES 数组加一项（pickModel 命令需已存在）。
- **改选模型 QuickPick 外观**：只改 `aiModelPickItems.ts` 的 `buildModelPickItems`。
- **加持久化状态**：起 `ai.settings.*` GLOBAL key + restoredRef 守卫。
- **改帮助内容/宽度**：`aiSettingsHelpText.ts`(英) + zh-CN.ts(中)；浮层样式 `AiSettingsEditor.module.css` 的 `.helpPopover`。
- **改命令标题/ID**：`actions/aiActions.ts` / `agentActions.ts`。命令 ID 勿随便改（状态栏/AcpSessionEditor 齿轮/acpSessionService 引用 `workbench.action.agent.openSettings`）；标题改完同步 zh-CN.ts 的 `action.*`。

### 关键架构决策（为什么；完整理由见 [cases-architecture.md](cases-architecture.md)）

- **AI 与 Agents 同一壳**：一个虚拟 editor 左侧两组；入口收敛 `ai.manageModels`，`workbench.action.agent.openSettings` 保留为预置定位到 Agents 区。
- **AI 分类静态数组、Agents 动态注册表**：agent 设置 UI 自包含，壳零改动加新 agent。
- **agent 项右侧不套壳滚动**（组件自带 `subNav`/`subBody`），AI 项才管 scrollTop；agent 项无帮助按钮。
- **激活模型只在「功能模型」分类设置**：`AiProvidersPanel` 不再有「设为活跃」入口——只管配置不管用哪个，避免两处重复。
- **功能行复用命令而非自造 picker**（与状态栏 model picker 一致）。
- **模型知识库只写用户层，不写合并视图**（写回合并结果会 pin 死内置目录升级）：Override 只写空条目 `{}` + **物化-on-touch**；渲染跟 effective，写盘只写自身层；清空输入 → 删 key → 回显内置值 + Built-in note。
- **capabilities 必须写完整对象**（`mergeModelKnowledge` 整体替换嵌套对象 + 乐观默认 `{streaming:true}`）：勾选经 `toggledCapabilities` 写全四键（streaming / vision / promptCaching / toolCalling，权威定义 `protocolMapEdit.ts`）。「能力只能收窄不能新增」是**供应商侧 ref** 的规则（`ModelRefEditor`），两处文案别串。
- **重命名模型 key 只改显式 ref**（`{id, ref}` 形态）；字符串简写/裸模型降级只能 confirm 警告；`explicit`/`bare` 两标志互不排斥；两层走 **`updateModelKnowledgeAndProviders` 一次原子写**；目标 key 占用同时查用户层**和内置层**。
- **虚拟 EditorInput 无状态**：数据 live 读 `IAiModelService` / `IClaudeConfigService`，UI 态走 IStorageService。
- **帮助浮层 FocusScopeOverlay** + 透明 backdrop 点外关闭；内容走共享 `MarkdownView`。
- **样式零硬编码**：颜色只用 `--vscode-*`（运行时注入）+ tokens.css token；`agentSettings/` 面板 CSS 用 `--ue-*`，两套并存。

### 易踩坑速记

1. **中文写进 localize default**（最常见）：default 必须英文，中文去 zh-CN.ts。
2. **`styles['x']` 是 `string | undefined`**（exactOptionalPropertyTypes 下传可选 string prop 报 TS2375），要 `styles['x'] ?? ''`。
3. **滚动恢复设早了不生效**：`scrollTop` 要在 `requestAnimationFrame` 里设；切分类前先 flush 旧滚动。
4. **折叠态是一个整体 Record 存一个 key**：`toggleCollapsed(key, defaultCollapsed)` 必须对「有效值」取反（`!(prev[key] ?? defaultCollapsed)`）——对默认折叠的区用 `!prev[key]` 会把 undefined 翻成 true，表现为**首次点击没反应**。
5. **卡内区域默认折叠态在 `ProviderEntryCard` 传入**（pricing/usage=折叠，protocols=展开），读写两侧必须传同一个默认值。
6. **渲染继承字段用 effective 值，写盘只写自身值**：main 展平 `extends` 后按子条目 id 缓存，UI 拿到的是未展平原条目——只读 `provider.usageSource` 会把「已有数据」显示成「无」（曾经的 bug）。
7. **加了 localize key 忘了补 zh-CN**：中文环境静默回落英文。改完 `rg` 比对。
8. **input→组件注册漏一处**：`EditorArea.tsx` + `BuiltInEditorProvidersContribution.ts` 两处都要有 `aiSettings`，否则页面开不出。
9. **改 agent 渲染分支别删壳顶部的 `import '../agentSettings/builtinAgentSettings.js'`**：Claude 自注册唯一触发点，删了 Agents 区全是占位。
10. **`aiModels.*` 前缀与 `ai.settings.models.collapsed` 是供应商面板历史遗留命名**（改名时没动 ~60 个 key）。新模型配置面板用 `aiKnowledge.*` + `ai.settings.modelKnowledge.collapsed`——两个 key 空间别混。
11. **全量替换语义的面板，「首读未落地」必须与 legacy 同等门控**：reload 前快照是空占位，任何写入 = 清空用户配置。护栏是写时复查（`enqueueWrite` 读 `loadedRef`/`legacyRef`）；reload 失败落**独立的 failed 态**而非 `loaded=true`；legacy banner 的打开按钮不能顺手 flush 写盘。

### 验证

```bash
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 涉及编辑器打开/交互时跑；已知多 worker flaky（folderDragNewWindow / simpleFileDialog / markdown* @p1）会在用例间漂移，单跑必过即非回归
# 手动（pnpm dev）：打开 Settings → 两组切换 → AI 项切分类/折叠/过滤/选模型/帮助 → Agents 项选 Claude → 重启验证恢复
```

### 关键参考路径

- `workbench/ai/AiSettingsEditor.tsx` — 双栏壳 + AI_CATEGORIES + Agents 动态组
- `workbench/ai/{AiProvidersPanel,AiModelKnowledgePanel,AiFeatureModelsPanel,AiMcpServersPanel}.tsx` — 四分类面板
- `workbench/ai/{AiSettingsHelpButton.tsx,aiSettingsHelpText.ts}` + `AiSettingsEditor.module.css` — 帮助浮层 + 壳样式
- `workbench/agentSettings/agentSettingsRegistry.ts` — agent 贡献注册表
- `actions/{aiModelPickItems,aiActions,agentActions,inlineCompletionActions,commitMessageActions}.ts` — picker + 入口命令
- `shared/i18n/messages/zh-CN.ts` — 中文翻译
- 相关：[`../agentSettings/claude/CLAUDE.md`](../agentSettings/claude/CLAUDE.md)、apps/editor/CLAUDE.md 套路 I、`packages/platform/src/nls/nls.ts`
