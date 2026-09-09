# cases-architecture.md

本文从 `workbench/ai/CLAUDE.md` 拆出，范围是：AI 设置页面壳的关键架构决策与「为什么」——每条决策的完整理由、历史上下文与代价权衡。一句话结论留在 CLAUDE.md 的「关键架构决策」，这里保留判断取舍时需要的完整背景。

## 完整决策清单

### AI 与 Agents 合并到同一壳（2026-06）

原 Agent Settings 是独立 editor，与 AI Settings 两套界面拼在一起、统一感弱。合并后是**一个**虚拟 editor、左侧单栏分两组（AI 静态分类 + Agents 动态列表），右侧按选中项类型分支渲染。入口也收敛——`ai.manageModels`（标题 Open AI & Agent Settings）是主入口；`workbench.action.agent.openSettings` 保留（兼容 AcpSessionEditor 齿轮等调用），改为预置 `settings.activeItem` 后打开同一编辑器并定位到 Agents 区。

### AI 分类用静态数组、Agents 用动态注册表

AI 分类数量少且固定，硬编码 `AI_CATEGORIES`；agent 数量随 `IAcpAgentRegistry` 变化，且每个 agent 的设置 UI 自包含，故走 `agentSettingsRegistry` 贡献机制（壳零改动即可加新 agent）。

### agent 项右侧不套壳的滚动容器

agent 贡献组件（如 Claude）自带 `subNav`/`subBody` 横向分栏与内部滚动，壳只在 AI 项管 scrollTop，避免双滚动条。agent 项也无帮助按钮（help 是 AI 专属文案）。

### 激活模型只在「功能模型」分类设置

chat/inline/commit/sessionTitle 的活跃模型由 `AiFeatureModelsPanel` 点击行触发对应命令统一管理。**`AiProvidersPanel` 不再有「设为活跃」入口**（曾有，已移除）——供应商面板只管「配置供应商」（baseUrl/key/参数/增删），不管「用哪个」，避免两处重复。

### 点击功能行复用命令而非自造 picker

`AiFeatureModelsPanel` 直接 `executeCommand('ai.pickModel'…)`，确保和状态栏 model picker 完全一致的体验，零重复逻辑。

### 模型知识库只写用户层，不写合并视图

`getModelKnowledge()` 返回 `mergeModelKnowledge(BUILTIN_MODEL_KNOWLEDGE, user)` 的合并结果，写回去会把全部内置知识物化进用户的 aiSettings.json，未来内置目录升级（厂商调大 token 上限）就被用户副本 pin 死。所以「Override 内置」只写空条目 `{}`，字段**物化-on-touch**（改哪个字段才写哪个）；渲染一律跟 effective（`user.field ?? builtin.field`），写盘只写自身层；清空输入 → 删 key → 输入框回显内置值 + 「Built-in: X」note，这就是可见的「恢复默认」。删除内置覆盖前会确认（Reset to built-in）。

### capabilities 必须写完整对象

`aiModelRegistry.ts` 是 `knowledge.capabilities ?? { streaming: true }`（缺席落乐观默认），且 `mergeModelKnowledge` 对嵌套对象**整体替换**——用户层写部分 capabilities 会静默丢掉内置的 vision 等。所以任何勾选都经 `toggledCapabilities` 写全四键（**streaming / vision / promptCaching / toolCalling**，权威定义 `shared/ai/protocolMapEdit.ts` 的 `AI_CAPABILITY_KEYS`）；删掉覆盖是显式动作（行内小按钮），不是取消勾选的副作用。注意「能力只能收窄不能新增」是**供应商侧 ref** 的规则（`ModelRefEditor`），知识库这边勾选就是在新增能力，两处文案别串。

### 重命名模型 key 只改显式 ref

protocolMap 里 `{id, ref}` 形态的显式 `ref` 可安全改写；对象只有 `id` 的、以及字符串简写，其「知识 key」等于 wire 名，改了就破坏端点调用——`rewriteRefsForRename` 只动前者，后者只能在 confirm 里点名警告（降级为裸模型是既有非致命行为）。`referencingProviders` 的 `explicit`/`bare` 两个标志**互不排斥**：一个 provider 同时有两种形态就两个都为 true，两句提示都出——只报「可自动更新」会把静默降级藏起来。重命名的两层（知识库 key + provider 引用）走 **`updateModelKnowledgeAndProviders` 一次原子写**，分两次写中间失败会留下悬空 ref。目标 key 的占用检查要同时查用户层**和内置层**——改成内置 key 会让这条静默变成对那个内置模型的覆盖。

### 虚拟 EditorInput 无状态

`AiSettingsEditorInput` 不存任何东西，页面所有数据 live 读 `IAiModelService` / `IClaudeConfigService`，UI 态（激活项/折叠/滚动/过滤）走 IStorageService。这样多窗口/重开行为一致。

### 帮助浮层用 FocusScopeOverlay

自带 focus trap + Esc + restoreFocus；再叠一个透明 backdrop 实现点击外部关闭。内容走共享 `MarkdownView`（不引新依赖）。

### 样式零硬编码

颜色只用 `--vscode-*` 变量（58 处，由 `renderer/services/themes/generateColorThemeCss.ts` 在运行时注入为 `:root` CSS 变量，本 CSS 文件不定义这些变量；文件里仅剩注释里一处 `--color-*` 字样）+ `tokens.css` 的 spacing/radius/font token，切主题零改动。注意：`agentSettings/AgentSettingsEditor.module.css`（Claude/Codex 面板复用）用 `--ue-*` token，两套并存。
