# apps/editor/src/renderer/services/ai/CLAUDE.md

本目录承载 renderer 端 AI 域服务：inline completion / NES 双模式生成层（`InlineCompletionService` + `RecentEditsTracker` + `nesEditParser` + `nesSystemPrompt`）与 AI 模型门面客户端（`aiModelClientService`）。本文是 AI 域子系统的上下文地图（处理相关任务前通读）。四个主题的代码并不都在本目录：AI 设置页面壳在 `workbench/ai/`，AI Debug 采集主体在 `main/services/ai/`——各节内已标明真实落点。

> 子域：AI 设置页面壳见 [`workbench/ai/CLAUDE.md`](../../workbench/ai/CLAUDE.md)；AI Debug（采集主体在 main 端）见 [`main/services/ai/CLAUDE.md`](../../../main/services/ai/CLAUDE.md)。

## 内联补全（Inline Completion / ghost text）

inline completion（内联补全 / ghost text）是把 **AI 生成的代码建议**以灰字形式显示在光标处、按 **Tab** 接受的功能。它寄生在 **Monaco 的 inline completions 机制**之上：我们只注册**一个全语言 provider**，由 `IInlineCompletionService` 在被调用时去问 AI 模型；UI（ghost text 渲染、Tab/Esc 交互）全由 Monaco 内部的 `editor.contrib.inlineCompletionsController` 负责。

> ⚠️ 第一原则：动手前先认领你的改动落在哪一层——多数 bug 不在同一层。
> - **生成层**（`InlineCompletionService`）：补全文本怎么来、怎么清洗、什么时候不给。改提示/后处理/防抖/黑名单/模型选择在这。
> - **集成层**（provider 注册 + context key 镜像 + keybinding）：Monaco 怎么知道有补全、Tab 怎么接受。**「ghost text 出来了但 Tab 不接受」永远是这一层**，不是生成层。
> - **AI 模型层**（`IAiModelService`，不属于本子系统）：真正产文本的地方。模型列表、密钥、provider 在那边（见 apps/editor/CLAUDE.md 套路 I）。

### 数据流一图

```
用户 Alt+\ 手动触发  /  停顿自动触发
  │  TriggerInlineCompletionAction → editor.trigger('editor.action.inlineSuggest.trigger')
  ▼
Monaco inlineCompletionsController  ── UI 全权：ghost 渲染 / Tab / Esc，我们不碰
  │  调用我们注册的唯一 provider（InlineCompletionContribution，'*' 全语言）
  ▼
IInlineCompletionService.provide()                         ← 生成层主干
  ├─ gate：enabled? 语言黑名单? 模型已选?  任一不过 → null
  ├─ 防抖（仅自动触发，debounceDelay）
  ├─ 构 FIM 提示：<|prefix|>{prefix}<|cursor|>{suffix}<|suffix|>（裁到 maxContext*Chars）
  ├─ IAiModelService.sendRequest(messages, { modelId, maxTokens }, token)   ← AI 模型层
  ├─ 后处理 sanitizeCompletion：去 ``` 围栏 / 去与既有代码重叠的尾部 / 单行截断
  └─ 返回 { items: [{ insertText, range }] } 或 null
  ▼
Monaco 渲染 ghost text
  ▼
bridgeInlineSuggestionVisible(editorFocus.ts) ── autorun 订阅 controller 的 primaryGhostText
  │  → 全局 contextKeyService.set('inlineSuggestionVisible', true)   ← 集成层的关键一跳
  ▼
用户按 Tab
  ▼
全局 keybinding handler 命中 CommitInlineCompletionAction
  （when: inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible，权重 ExternalExtension+1 抢占）
  ▼
editor.trigger('editor.action.inlineSuggest.commit') → Monaco 把 ghost text 插入文档

旁路消费者：
  AiTitleBarButton ── 订阅 service.onDidChange → 标题栏 AI 快速设置里的 inline 开关
```

### 核心服务：InlineCompletionService（生成层主干）

`apps/editor/src/renderer/services/ai/InlineCompletionService.ts`

- **注入依赖**：`IAiModelService`（产文本）、`IConfigurationService`（读 8 个配置 + 订阅变化）、`INotificationService`（错误 toast）、`ILoggerService`。
- **暴露**（接口 `IInlineCompletionService`）：
  - `onDidChange: Event<void>`——enabled / 选中模型 / requesting 任一变化时触发（驱动状态栏）。
  - `enabled: boolean`——运行时开关；`requesting: boolean`——有在途请求（状态栏 spinner）。
  - `getModelId() / setModelId(id)`——读写补全模型（**与 chat 模型分开存**，见下）。
  - `toggleEnabled() / setEnabled(b)`——**全局持久化**：先 `update(…, undefined, Project)` 清工作区层覆盖、再写 `ConfigurationTarget.User`（顺序勿反，见易踩坑 #11），经 UserSettingsSync 落全局 settings.json；内存即时翻转 + 对外恰 fire 一次 onDidChange（配置事件回音由 `_applyEnabled` 同值守卫吞掉）。
  - `provide(model, position, context, token)`——Monaco provider 的真正入口。
- **provide() 的 gate 顺序**（任一不过返回 null，**新增 gate 加在这里**）：`!enabled` → 语言在 `disabledLanguages` → 无 `model`（modelId 空或已从模型列表删除）。
- **FIM 提示构建** `_buildPrompt`：`[system, user]`，user 体为 `<|prefix|>...{prefix}<|cursor|>{suffix}<|suffix|>`；prefix/suffix 分别裁到 `maxContextPrefixChars` / `maxContextSuffixChars`。
- **后处理** `sanitizeCompletion`（**纯函数、易单测**）：去 ```` ``` ```` 代码围栏 → 去掉「模型回复尾部与光标后既有代码开头重叠」的重复 → `multiline:false` 时截断到首个换行 → 纯空白归一为空串（空串 → 不出建议）。
- **错误处理**：失败 toast **去重**（同一 errorKey 只弹一次，成功后清零；取消 token 不弹），toast 带 Disable 按钮。
- **配置存储**：8 个 key 全走 `IConfigurationService`，写用 `ConfigurationTarget.User`；`setModelId(undefined)` 落盘为 `''`，`getModelId()` 把 `''` 读回 `undefined`。
- **DI 注册**：`renderer/main.tsx`——`createInstance(InlineCompletionService)` → `services.set(IInlineCompletionService, …)`。
- **单测**：`services/ai/__tests__/InlineCompletionService.test.ts`——覆盖 sanitizeCompletion 各分支、provide 的四种 gate、模型持久化 undefined↔'' 往返、错误 toast 去重、**enabled persistence**（toggle 写 User 层+清 Project 覆盖+恰 fire 一次+层种子恢复）。改生成层逻辑**优先在这里加用例**（用 FakeAiModel/FakeNotification + 真 `ConfigurationService`，无需起 Monaco）。

### 集成层：provider 注册 + context key 镜像 + Tab 接受

这一层是「ghost text 出来了但 Tab 不接受 / 根本不出 ghost text」类 bug 的战场。

#### provider 注册（让 Monaco 知道有补全）

`contributions/InlineCompletionContribution.ts`（`WorkbenchPhase.AfterRestore`，Monaco 已就绪后）：等 `MonacoLoader.ensureInitialized()`，用 `ILanguageFeaturesService.registerInlineCompletionsProvider('*', provider)` 注册**唯一一个全语言 provider**，其 `provideInlineCompletions` 桥接到 `IInlineCompletionService.provide()`。在 `contributions/index.ts` 注册。

#### inlineSuggestionVisible 镜像（集成层关键一跳）

Monaco 把 ghost-text 可见性放在 editor **自己 scoped 的** context-key service 上，全局 keybinding handler 看不到。所以：

- `services/editor/editorFocus.ts` → `bridgeInlineSuggestionVisible(editor, contextKeyService)`：取 `editor.getContribution('editor.contrib.inlineCompletionsController')`，用 `autorun` 订阅 `controller.model.read(r)?.inlineCompletionState.read(r)?.primaryGhostText`，当 `ghost && !ghost.isEmpty()` 时 `contextKeyService.set('inlineSuggestionVisible', true)`，dispose 时复位 false。**与同文件的 `bridgeSuggestWidgetVisible`（镜像 `suggestWidgetVisible`）是同一套路**。
- `contributions/ContextKeyContribution.ts`：`createKey<boolean>('inlineSuggestionVisible', false)` 建全局 key（紧挨 `suggestWidgetVisible`）。
- `workbench/editor/FileEditor.tsx`：editor 实例创建后装配 `inlineSuggestSub = bridgeInlineSuggestionVisible(ed, contextKeyService)`，cleanup 时 dispose（与 `suggestSub` 成对）。

#### Tab 抢占（CommitInlineCompletionAction）

`actions/inlineCompletionActions.ts` → `CommitInlineCompletionAction`（id `ai.inlineCompletion.commit`，**primary `tab`**，when `inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible`）：run 时 `editor.trigger('keyboard', 'editor.action.inlineSuggest.commit', undefined)`。其 keybinding 显式设 **`weight: KeybindingWeight.ExternalExtension + 1`（=401）**，于是全局 handler **CLAIM** Tab（preventDefault + 执行）而非 defer。**权重必须压过的不只是 Monaco 桥接命令（MonacoDefault 50），还有扩展贡献的 Tab 绑定**（如 markdown 扩展的 `markdown.editing.onTab`，经 `ExtensionPointTranslator` 统一赋 `ExternalExtension`=400）——这正是早期只用默认 WorkbenchContrib(200) 导致「markdown 文件里 Tab 走缩进而非接受补全」的根因。仍低于 `User`(1000)，用户自定义键位优先。

> 🔑 **为什么不能靠 Monaco 自己的 Tab**：本编辑器开 `editContext: true`，焦点元素是 `DIV.native-edit-context`，其异步 keydown 路径下 Monaco 内置的 `AcceptInlineCompletion`（id `inlineSuggestCommitId`，Tab，weight 200）**不可靠地被缩进抢走**——即使其 scoped context 满足 commit 的全部 kbExpr。修法就是上面三件套：**镜像可见性到全局 + 自己用高权重命令抢 Tab 直接调 commit**。这是已修 bug，**勿回退**。Tab 抢不到的逐步诊断见 [fix-keybinding-not-firing]。

### 四个 Action

`apps/editor/src/renderer/actions/inlineCompletionActions.ts`（`CATEGORY = AI`，全在 `actions/index.ts` `registerAction2`）：

| 类 | id | 快捷键 | when | 做什么 |
|---|---|---|---|---|
| TriggerInlineCompletionAction | `ai.inlineCompletion.trigger` | `alt+\`（f1:true） | `editorTextFocus` | `editor.trigger('editor.action.inlineSuggest.trigger')`；**无模型时弹引导提示**（去 pickModel） |
| CommitInlineCompletionAction | `ai.inlineCompletion.commit` | `tab` | `inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible` | `editor.trigger('editor.action.inlineSuggest.commit')`（见集成层） |
| ToggleInlineCompletionAction | `ai.inlineCompletion.toggle` | — | — | `service.toggleEnabled()` + toast；标题栏 AI 快速设置的 inline 开关也走它 |
| PickInlineCompletionModelAction | `ai.inlineCompletion.pickModel` | — | — | QuickPick 选模型 → `setModelId()` 持久化 |

trigger/commit 都靠 `IEditorGroupsService.activeGroup.activeEditor` 拿 `FileEditorInput` → `FileEditorRegistry.get()` 拿 Monaco 实例再 `editor.trigger(...)`；activeEditor 不是 FileEditorInput 时静默返回。

### AI 入口：标题栏 Sparkle 按钮（原状态栏 Completions 条目已并入）

> 🔀 2026-06 变更：原 `InlineCompletionStatusContribution`（状态栏 Completions 条目：requesting `$(loading~spin)` / enabled `$(sparkle)` / disabled `$(circle-slash)`，点击触发 toggle）已删除，AI 入口统一为**标题栏**的 Sparkle 按钮 `workbench/titlebar/AiTitleBarButton.tsx`（data-testid `titlebar-ai-button`）。

- 点击按钮弹快速设置浮层（workbench-ui 的 `AiQuickSettingsPanel`）：inline-completion 开关（data-testid `ai-quick-settings-inline-toggle`，`aria-checked` 反映 `service.enabled`，拨动 → `inline.setEnabled(b)`）、四个功能模型行（chat / inline / commit / sessionTitle → 各自 pickModel 命令）、Open Agents / Manage AI Models 捷径。
- 数据源：订阅 `inline.onDidChange` + `IAiModelService` 的 onDidChange*Models 系列事件刷新。
- tooltip：基础文案 + 活跃会话 MCP server 摘要。

### 配置项（8 个，全 `ai.inlineCompletion.*`）

schema 定义在 `contributions/InlineCompletionConfigurationContribution.ts`（`WorkbenchPhase.BlockStartup`——schema 必须早注册，否则其它 contribution 读默认值拿不到）：

| key | type | default | 用途 |
|---|---|---|---|
| `.enabled` | boolean | true | 功能开关 |
| `.model` | string | `''` | 补全模型 id（**独立于 chat**） |
| `.debounceDelay` | number | 300 | 自动触发防抖 ms |
| `.maxContextPrefixChars` | number | 2000 | 光标前上文裁剪 |
| `.maxContextSuffixChars` | number | 500 | 光标后下文裁剪 |
| `.maxTokens` | number | 128 | 生成上限 |
| `.multiline` | boolean | true | 是否允许多行（false → sanitize 截单行） |
| `.disabledLanguages` | string[] | [] | 语言黑名单 |

**新增配置项 = 改两处**：这张表（schema）+ `InlineCompletionService` 里读取/订阅它的地方。

### 与 AI 模型层的关系

- 补全文本来自 `IAiModelService.sendRequest(messages, { modelId, maxTokens }, token)`，返回 `AiResponse`（流 + result promise），用 `getTextResponse(response)` 合并。`IAiModelService` 由 main 进程实现、经 ProxyChannel 暴露给 renderer。
- **补全模型 id 与 chat 模型 id 是两套**：补全存 `aiSettings.json` 的 `activeModels.inlineCompletion`（`pickModel` 选，经 `IAiModelService.get/setInlineCompletionModelId` 读写），chat 存同文件的 `activeModels.chat`，ACP 走自己的配置与命令。改「选模型」时别串台。
- 加新 AI provider（让模型列表多出可选项）属于 AI 模型层，见 apps/editor/CLAUDE.md **套路 I（加一个 AI provider（协议））**——密钥明文存在 `aiSettings.json` 实例的 `apiKey` 字段（renderer 经门面读同一份配置）；仍有效的红线是密钥绝不进日志 / AI Debug、UI 掩码显示。

### 常见任务 → 改哪里

- **改补全提示 / 后处理（去围栏、去重复、截断规则）**：`InlineCompletionService` 的 `_buildPrompt` / `sanitizeCompletion`，配套 `__tests__/InlineCompletionService.test.ts` 加用例。
- **新增「什么时候不给补全」的条件**：provide() 的 gate 段（enabled/语言/模型那串）。
- **ghost text 出来了但 Tab 不接受**：集成层三件套——确认 `bridgeInlineSuggestionVisible` 有把全局 `inlineSuggestionVisible` 置 true、`CommitInlineCompletionAction` 权重 > 400（ExternalExtension，压过扩展级 Tab 绑定）、when 子句成立（`!suggestWidgetVisible` 等）。逐步诊断走 [fix-keybinding-not-firing]。
- **根本不出 ghost text**：先用 e2e probe `installFakeInlineCompletion('X')` 隔离 AI 层——能出说明问题在生成层（gate/模型/sendRequest）；仍不出说明 provider 没注册或 Monaco 集成断了。
- **改 AI 入口按钮 / 快速设置浮层**：`workbench/titlebar/AiTitleBarButton.tsx`（原状态栏 `InlineCompletionStatusContribution` 已并入此统一入口）。
- **加配置项**：schema（`InlineCompletionConfigurationContribution.ts`）+ service 里读它。
- **改快捷键 / when**：`inlineCompletionActions.ts` 对应 Action 的 `keybinding`。

### 易踩坑速记

1. **Tab 接受依赖三件套缺一不可**（已修，勿回退）：全局 `inlineSuggestionVisible` 建 key（ContextKeyContribution）+ 镜像（editorFocus 的 bridge，且 FileEditor 里装配/dispose）+ 高权重 commit 命令。缺任一，editContext 模式下 Tab 会去缩进。
2. **inlineSuggestionVisible 是镜像值，不是 Monaco 原生 key**：全局 handler 只认我们 set 的这个；别误以为 Monaco 的 scoped 同名 key 会自动可见。
3. **commit 命令权重必须 > ExternalExtension(400)**：用 `KeybindingWeight.ExternalExtension + 1`。光压过 Monaco 的 MonacoDefault(50) 不够——扩展贡献的 Tab 绑定（如 `markdown.editing.onTab`）权重是 400，旧的默认 WorkbenchContrib(200) 会在 markdown 文件里被它抢走 Tab（已修 bug，勿回退到 200）。仍低于 User(1000) 保证用户键位优先。
4. **补全模型 ≠ chat 模型**：两套配置键，pickModel 各管各的，调试模型问题先确认在看哪一个。
5. **sanitize 空串 = 不出建议**：纯空白/只有围栏的回复被归一为空 → provide 返回 null，表现为「触发了但没 ghost」，这是预期不是 bug。
6. **配置 schema 要在 BlockStartup 注册**：晚于读取方注册会让默认值读不到。
7. **provide 的 activeEditor 守卫**：非 `FileEditorInput`（如 markdown 预览、设置页）时 trigger/commit/provide 都应静默 no-op，别假设永远有 Monaco 实例。
8. **toggle 写配置层必须先删 Project 再写 User**：`ConfigurationService.update` 按「写前 effective ≠ 写入值」fire（不是按写后 effective），若先写 User 再删工作区覆盖，被遮罩期间 fire 的中间态事件会把 `_enabled` 回弹（对订阅者可见一次假翻转）。顺序 = 先 `update(key, undefined, Project)` 清覆盖、再 `update(key, value, User)` 写全局，所有场景对外恰 fire 一次（有单测守护）。

### 验证

```bash
cd apps/editor && pnpm vitest run --project renderer \
  src/renderer/services/ai/__tests__/InlineCompletionService.test.ts   # 生成层单测
pnpm check                                          # lint+typecheck+全量 test
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts specs/smoke.inlineCompletion.spec.ts
```

e2e（`apps/editor/e2e/specs/smoke.inlineCompletion.spec.ts`，@p1，用 sharedApp 复用实例）覆盖：四命令已注册 + **`installFakeInlineCompletion('WORLD')` → 触发 → 轮询 `getActiveInlineSuggestionText()` 出现 → 按 Tab → 文档插入 → ghost 消失**、`alt+\` 解析到 trigger、标题栏 AI 按钮可见、快速设置里 inline toggle 随 toggle 命令翻转（`aria-checked`）。
探针（`renderer/e2e/probe.ts`，签名在 `shared/e2e/contract.ts`）：`installFakeInlineCompletion(text)`（在活跃 Monaco 上注册恒定返回的假 provider，绕开 AI；非 FileEditor 返回 false；幂等替换）、`getActiveInlineSuggestionText()`（读 controller `primaryGhostText` 各 part 拼接，无则 undefined）。**改 Tab 接受链路务必跑这条 e2e**。

### 关键参考路径

- `apps/editor/src/renderer/services/ai/InlineCompletionService.ts` —— 生成层主干（gate / FIM / sanitize / 错误去重）
- `apps/editor/src/renderer/services/ai/__tests__/InlineCompletionService.test.ts` —— 生成层单测
- `apps/editor/src/renderer/contributions/InlineCompletionContribution.ts` —— 唯一全语言 provider 注册
- `apps/editor/src/renderer/contributions/InlineCompletionConfigurationContribution.ts` —— 8 个配置 schema（BlockStartup）
- `apps/editor/src/renderer/workbench/titlebar/AiTitleBarButton.tsx` —— 标题栏 AI 统一入口（含 inline 开关；原状态栏 Completions 条目已并入）
- `apps/editor/src/renderer/actions/inlineCompletionActions.ts` —— trigger/commit/toggle/pickModel
- `apps/editor/src/renderer/services/editor/editorFocus.ts` —— `bridgeInlineSuggestionVisible` / `bridgeSuggestWidgetVisible`
- `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` —— 装配/dispose 两个 bridge
- `apps/editor/src/renderer/contributions/ContextKeyContribution.ts` —— 建全局 `inlineSuggestionVisible` key
- `apps/editor/src/renderer/main.tsx` —— DI 注册 InlineCompletionService
- `apps/editor/e2e/specs/smoke.inlineCompletion.spec.ts` + `renderer/e2e/probe.ts` + `shared/e2e/contract.ts` —— e2e 与探针
- 相关 skill：[fix-keybinding-not-firing]（Tab 抢不到/快捷键不触发的逐步诊断与权重仲裁）

## NES 编辑建议（Next Edit Suggestions / inline edit）

NES（Next Edit Suggestions / inline edit）是 **inline completion 的第二种模式**：不再只在光标处续写还不存在的文本，而是根据用户**最近的编辑**预测当前文件中**光标之外任意位置**的下一处改动（如改了函数签名 → 提示改调用处），以 Monaco 原生的 **gutter 指示器 + diff** 呈现，按 **Tab 跳转**过去、再按 **Tab 接受**。

> 🔑 第一认知：NES 不是独立子系统，是寄生在 inline completion 管道上的一条**分叉**。先读本文件「内联补全」一节建立 ghost-text 续写的全局认知，再看 NES 在哪几处分叉出去。

> ⚠️ 第一原则：动手前先认领你的改动落在哪一层——多数 bug 不在同一层。
> - **生成层**（`InlineCompletionService._provideInlineEdit` + `RecentEditsTracker` + `nesEditParser`）：编辑建议怎么来、编辑历史怎么攒、模型返回怎么解析成 `{range, newText}`。改 prompt/解析/历史/防抖/回退在这。
> - **集成层**（context key 镜像 + bridge + jump/commit 命令）：Monaco 怎么知道有 inline edit、Tab 怎么跳转/接受。**「inline edit 渲染出来了但 Tab 不跳/不接受」永远是这一层**，不是生成层。
> - **AI 模型层**（`IAiModelService`，不属于本子系统）：真正产文本的地方。模型/密钥/provider 在那边（见 apps/editor/CLAUDE.md 套路 I）。**NES 与 ghost-text 共用同一个补全模型**（`ai.inlineCompletion.model`，经 `IAiModelService.getInlineCompletionModelId`）。

### 共享 vs 分叉（最重要的一张表）

NES **没有**复制一套 provider/service。它和 ghost-text 续写的关系是「共享管道、分叉策略」：

| | 共享（同一份代码） | 分叉（NES 专属） |
|---|---|---|
| Monaco provider | ✅ `InlineCompletionContribution` 唯一全语言 provider | — |
| provider 调用 | ✅ 同一次 `provideInlineCompletions`，靠 `context.includeInlineEdits` 区分 | — |
| service 入口 | ✅ `InlineCompletionService.provide()` | 内部按 `ai.nes.enabled && context.includeInlineEdits` 分流到 `_provideInlineEdit` |
| 请求基建 | ✅ `_sendText`（取消 token / requesting / 错误去重 toast） | — |
| 补全模型 | ✅ `ai.inlineCompletion.model` | — |
| prompt | ❌ | `_buildNesPrompt`（最近编辑 + 带行号文档），`DEFAULT_NES_SYSTEM_PROMPT` |
| 输出协议 | ❌ 裸文本 FIM 续写 | 结构化 JSON `{edits:[{startLine,endLine,newText}, …]}`（多处），`nesEditParser.parseNesEdits` 解析 + `composeNesEdits` 合并 |
| 输入信号 | ❌ 光标周围 prefix/suffix | **最近编辑历史**（`RecentEditsTracker`） |
| 返回形状 | ❌ `{insertText, range:光标zero-width}` | `{insertText, range:任意行, isInlineEdit:true, showInlineEditMenu:true}` |
| context key | ❌ `inlineSuggestionVisible` | `inlineEditIsVisible` / `cursorAtInlineEdit` / `tabShouldJumpToInlineEdit` / `tabShouldAcceptInlineEdit` |
| 接受交互 | ❌ Tab 直接 commit | Tab 先 **jump** 再 commit |
| 配置 | ❌ `ai.inlineCompletion.*` | `ai.nes.*`（7 个） |

> 为什么分叉而非合并：续写与 NES 是**两种不同的预测任务**——输出格式没法同时是裸文本又是 JSON，输入信号也不同（光标周围 vs 最近改了什么）。强行一个 prompt 两头都做不好。这个分离不是我们发明的，**Monaco 底层就用 `isInlineEdit` 标志位区分**，走不同 view / context key / 命令。

### 数据流一图

```
用户打字 / Alt+\ 手动触发
  │  Monaco inlineCompletionsController 在 onDidType/onDidPaste 自动 model.trigger()
  ▼
单次 provideInlineCompletions(model, pos, context, token)   ← context.includeInlineEdits 由 inlineSuggest.edits.enabled 决定（默认 true）
  ▼
InlineCompletionService.provide()                          ← 共享入口
  ├─ 共享 gate：enabled? 语言黑名单? 模型已选?  任一不过 → null
  ├─ if (ai.nes.enabled && context.includeInlineEdits === true):
  │     _provideInlineEdit():                              ← NES 分支
  │       ├─ 防抖（automatic，ai.nes.debounceDelay 默认 400）
  │       ├─ recent = RecentEditsTracker.getRecentEdits(uri)
  │       │     若 recent 为空且 automatic → null（无近期编辑不猜）
  │       ├─ _buildNesPrompt：<|recent_edits|> + <|cursor_line|> + <|document|>(带行号)
  │       ├─ _sendText(messages, ai.nes.maxTokens, modelId, token)   ← 共享基建 → AI 模型层
  │       ├─ parseNesEdits(text, lineCount)：剥 fence → 截首个平衡 JSON（{}/[]）→ 校验每条范围 + 排序 + 互不重叠 → 失败 null
  │       ├─ composeNesEdits(list, getLineContent)：多处离散编辑合并成单跨度 span（中间未改行原样保留）
  │       ├─ range = [spanStart,1] .. [spanEnd, getLineMaxColumn]    ← 单 range，多处高亮交 Monaco 内部 diff 拆
  │       ├─ getValueInRange === newText → null（空 diff 丢弃）
  │       └─ return { items:[{ insertText:newText, range, isInlineEdit:true, showInlineEditMenu:true }] }  ← 仍单 item
  │     if (有结果) return；else if (!ai.nes.fallbackToCompletion) return null
  └─ return _provideGhostText(...)                         ← 回退/默认：原 ghost-text 续写
  ▼
Monaco 原生渲染 inline edit（gutter 指示器 + side-by-side/word/line/deletion/insertion diff，全自带，无需我们写 UI）
  ▼
bridgeInlineEditState(editorFocus.ts) ── autorun 订阅 controller.model 的 inlineEditState 等
  │  → 全局 contextKeyService.set('inlineEditIsVisible' / 'cursorAtInlineEdit' /
  │     'tabShouldJumpToInlineEdit' / 'tabShouldAcceptInlineEdit')      ← 集成层关键一跳
  ▼
用户按 Tab（光标不在 edit 处）
  ▼ 全局 keybinding 命中 JumpToNextInlineEditAction（when: tabShouldJumpToInlineEdit && …，weight ExternalExtension+1）
  → editor.trigger('editor.action.inlineSuggest.jump') → 光标跳到 edit 处
  ▼
用户再按 Tab（光标已在 edit 处）
  ▼ 全局 keybinding 命中 CommitInlineCompletionAction（when: tabShouldAcceptInlineEdit && !tabShouldJumpToInlineEdit && …）
  → editor.trigger('editor.action.inlineSuggest.commit') → Monaco 应用整行替换
```

### Monaco 0.55.1 原生支持（已源码核实，可直接依赖）

**结论：standalone monaco 0.55.1 完整支持 inline edit，我们不写 UI**——只需 provider 返回 `isInlineEdit:true` + 任意行 range 的 item。

- 用户打字后 controller 在 `onDidType`/`onDidPaste` 自动 `model.trigger()`，**NES 与 ghost-text 共用同一次 provider 调用**，靠 `context.includeInlineEdits`（= `inlineSuggest.edits.enabled`，**默认 true**）区分 → **不需要监听编辑后主动 `editor.trigger`**。
- 公开类型已暴露 `context.includeInlineEdits`、`InlineCompletion.isInlineEdit` / `showInlineEditMenu`；range 可指向光标外任意行。**但 `IInlineSuggestOptions` 不含 `edits` 字段**——若哪天需要显式开 `inlineSuggest.edits.enabled` 要 cast（默认既为 true，目前不设）。
- controller id：`editor.contrib.inlineCompletionsController`。可订阅的 model observable（controller 自身就这样 bind scoped context key）：`model.inlineEditState`（undefined = 非 inline-edit 态）、`inlineEditState.cursorAtInlineEdit`、`model.tabShouldJumpToInlineEdit`、`model.tabShouldAcceptInlineEdit`。
- Monaco scoped raw context key 名：`inlineEditIsVisible`、`cursorAtInlineEdit`、`tabShouldJumpToInlineEdit`、`tabShouldAcceptInlineEdit`（**全局看不到，必须镜像**）。
- standalone 已注册命令：`editor.action.inlineSuggest.jump`(Tab,201) / `...commit`(Tab,200) / `...hide`(Esc)。
- `inlineEditState.inlineEdit.edit.text` 可读出当前 inline edit 的替换文本（probe 用；注意 model 会做 `singleTextRemoveCommonPrefix`，文本可能被去掉公共前缀）。
- **多处编辑（重命名一次改完）= 一个大 range + 完整新文本，不是多 item / 不是 `additionalTextEdits`**（已源码核实）。`InlineEditItem`（`isInlineEdit:true` 路径）把 `additionalTextEdits` 硬编码为 `[]`（`inlineSuggestionItem.js:263`），那条路禁用。真正机制：`InlineEditItem.create`（L241）→ `getStringEdit`（L313）用 `linesDiffComputers` 行/子词 diff 把单个 `(range, insertText)` **自动拆成多个细粒度变更点**渲染、Tab 一次全应用。我们因此把多处离散编辑用 `composeNesEdits` 合并成「跨首末的单 range + 重建的完整文本（中间未改行原样保留）」，剩下的拆分交 Monaco。

### 生成层

#### 编辑历史跟踪 `RecentEditsTracker`
`services/ai/RecentEditsTracker.ts`（`IRecentEditsTracker`）

NES 的预测信号。**不直接订阅 Monaco**（保持 node 可测）——只暴露纯数据入口 `record(uri, changes)`，由 `FileEditor.tsx` 已有的 `model.onDidChangeContent` 回调喂入。
- 每 uri 一个 **ring buffer**（上限 `ai.nes.recentEditsCount` 默认 10），按文件隔离。
- 记录单元只存增量 `{ lineNumber, inserted, deletedLength, at }`（`onDidChangeContent` 无旧文本，用 `rangeLength` 作 `deletedLength`）。
- **同行 + 2s 窗内** coalesce 合并，避免逐字符塞满 buffer。
- `getRecentEdits(uri)` 最旧在前；`clear(uri)` 在接口里但 **FileEditor 当前不调用**（ring buffer 自滚动；切 tab 误清的代价大于收益）。
- DI：`main.tsx` 里 **必须在 `InlineCompletionService` 之前** `createInstance` 并 `services.set`（service 注入它）。

#### 结构化输出解析 `nesEditParser`
`services/ai/nesEditParser.ts`（`parseNesEdits` + `composeNesEdits`，纯函数，类比 `sanitizeCompletion`）

模型协议：**多处编辑数组** `{ "edits": [ {startLine,endLine,newText}, … ] }`，每条语义为**整行替换** `[startLine,endLine]`（1-based 闭区间，**忽略列号**以规避模型列号不可靠）。无修改回 `{ "noEdit": true }`。
- `parseNesEdits(raw, lineCount)`：`stripCodeFence` → `extractFirstJsonValue`（首个平衡 `{}` **或** `[]`，跳过字符串内括号防 newText 截断）→ `JSON.parse` → 归一为列表（兼容三形态：`{edits:[…]}` 首选 / 顶层裸数组 / 单对象裹成一元，`noEdit`/空数组→null）→ 逐条校验（`newText` 是 string、行号是整数、`1<=startLine<=endLine<=lineCount`）→ **排序 + 校验互不重叠**（重叠→null）。**任何失败/越界/重叠一律 null（不出建议）**。
- `composeNesEdits(edits, getLineContent)`：把已排序非重叠的多处编辑合并成单个跨度 `{startLine:spanStart, endLine:spanEnd, newText}`——逐条按序，edit 前未改的行用 `getLineContent` 原样保留、推入 `edit.newText`、跳到 `endLine+1`，末尾补齐到 spanEnd。service 用合并结果构造**单个** inline-edit item，多处高亮由 Monaco 内部 diff 拆（见上「Monaco 原生支持」末条）。

#### provide() 双模式 + prompt
`services/ai/InlineCompletionService.ts`

- 入口 `provide()`：共享 gate 后 `if (ai.nes.enabled && context.includeInlineEdits) → _provideInlineEdit`，有结果即返回；否则按 `ai.nes.fallbackToCompletion` 决定回退 `_provideGhostText` 还是返回 null。
- `_provideInlineEdit`：防抖 → 取 recent（空且 automatic → null）→ `_buildNesPrompt` → `_sendText` → `parseNesEdits` → `composeNesEdits`（多处合并成单 span）→ 映射 range（`startColumn:1`、`endColumn:model.getLineMaxColumn(spanEnd)`）→ 空 diff 丢弃 → 返回**单个** `isInlineEdit:true` item。
- `_buildNesPrompt`：user message 三段 `<|recent_edits|>`（`L{n}: +{JSON.stringify(inserted)} (-{deletedLength}ch)`）+ `<|cursor_line|>{n}` + `<|document|>`（`_numberedDocument`：每行 `{n}: {内容}`，窗口由 `ai.nes.includeFullDocument` + `ai.nes.contextLines` 控制）。
- `_sendText`：**ghost-text 与 NES 共用**的请求基建（cts/requesting/错误去重）。**purpose 是唯一分叉点**——续写传 `'inline-completion'`、NES 传 `'next-edit-suggestion'`，于是两种模式在 AI Debug 面板里能各自归类（见本文件「AI Debug」一节的 purpose 穿透表）。
- **成本**：NES 与续写在单次 provide 内**串行**，仅 NES 无产出且允许回退才发第二请求——开 NES 不会无脑双倍。
- system prompt：`DEFAULT_NES_SYSTEM_PROMPT`（`services/ai/nesSystemPrompt.ts`）。**目前不可经 aiSettings.json 覆盖**——`AiPromptKind` 是固定联合（`'commit'|'inlineCompletion'|'sessionTitle'`），加 `nes` 会牵动 platform + 设置 UI，故 NES 直接用内置常量。要做成可配：往 `AiPromptKind` 加 `'nes'` + `_provideInlineEdit` 改用 `getSystemPrompt('nes')`。

### 集成层（context key 镜像 + Tab 仲裁）

照搬 ghost-text 已验证的「镜像 scoped key 到全局 + 高权重命令抢 Tab」套路（本项目 `editContext:true`，Monaco 内置 Tab dispatch 不可靠）。

1. **全局建 key**：`contributions/ContextKeyContribution.ts`（紧挨 `inlineSuggestionVisible`）建 `inlineEditIsVisible` / `cursorAtInlineEdit` / `tabShouldJumpToInlineEdit` / `tabShouldAcceptInlineEdit`，初值 false。
2. **镜像 bridge**：`services/editor/editorFocus.ts` 的 `bridgeInlineEditState(editor, contextKeyService)`——`autorun` 订阅 `controller.model` 的 `inlineEditState` / `inlineEditState.cursorAtInlineEdit` / `tabShouldJumpToInlineEdit` / `tabShouldAcceptInlineEdit`，写到全局 key；dispose 时四 key 复位 false。**与同文件 `bridgeInlineSuggestionVisible` 同构**。
3. **FileEditor 装配**：`workbench/editor/FileEditor.tsx` editor 创建后 `bridgeInlineEditState(ed, contextKeyService)`，cleanup dispose（与 `inlineSuggestSub` 成对）。同处 `model.onDidChangeContent((e) => recentEditsTracker.record(resourceUri, e.changes))` 喂编辑历史。
4. **Tab 命令 + 仲裁**：`actions/inlineCompletionActions.ts`
   - `JumpToNextInlineEditAction`（id `ai.inlineCompletion.jump`，primary `tab`，`weight KeybindingWeight.ExternalExtension + 1`，when `tabShouldJumpToInlineEdit && editorTextFocus && !suggestWidgetVisible`）→ `editor.trigger('editor.action.inlineSuggest.jump')`。
   - `CommitInlineCompletionAction.when` 已扩成兼容 inline edit 接受：`(inlineSuggestionVisible || tabShouldAcceptInlineEdit) && !tabShouldJumpToInlineEdit && editorTextFocus && !suggestWidgetVisible`。
   - **仲裁**：Monaco 保证 `tabShouldJump` 与 `tabShouldAccept` 互斥；jump(401) 与 commit(401) 同权重靠互斥 when 决唯一胜者；均高于扩展级 Tab（如 markdown.editing.onTab=400）、低于 User(1000)。
   - 注册：`actions/index.ts` 加 `registerAction2(JumpToNextInlineEditAction)`。
   - Esc 隐藏未自建，靠 Monaco scoped Esc 冒泡（验证失效再补 hide 命令）。

### 配置项（7 个，全 `ai.nes.*`）

schema 在 `contributions/InlineCompletionConfigurationContribution.ts`（与 8 个 `ai.inlineCompletion.*` 同处，`BlockStartup` 注册）：

| key | type | default | 用途 |
|---|---|---|---|
| `ai.nes.enabled` | boolean | **false** | NES 总开关（默认关，避免无谓双请求 + 主动改别处代码需用户显式选择） |
| `ai.nes.recentEditsCount` | number | 10 | 喂模型的最近编辑条数上限 |
| `ai.nes.contextLines` | number | 80 | 光标上下取多少行（includeFullDocument=false 时） |
| `ai.nes.includeFullDocument` | boolean | false | 是否带整篇带行号文档 |
| `ai.nes.debounceDelay` | number | 400 | 自动触发 NES 防抖 ms（比续写 300 大） |
| `ai.nes.maxTokens` | number | 512 | NES 单次生成上限（比续写 128 大） |
| `ai.nes.fallbackToCompletion` | boolean | true | NES 无产出时回退 ghost-text 续写 |

**新增配置项 = 改两处**：这张 schema + `InlineCompletionService` 的 `CONFIG`/`DEFAULTS` 与读取处。

### 常见任务 → 改哪里

- **改 NES 提示 / 输出协议**：`_buildNesPrompt` / `DEFAULT_NES_SYSTEM_PROMPT` + `nesEditParser.parseNesEdits`/`composeNesEdits`（配套 `__tests__/nesEditParser.test.ts`）。改协议要同步改 system prompt 里描述的格式与解析器。
- **改「攒哪些编辑历史 / 怎么 coalesce / 留几条」**：`RecentEditsTracker`（配套 `__tests__/RecentEditsTracker.test.ts`）。
- **新增「什么时候不出 NES」的条件**：`_provideInlineEdit` 的 gate 段（recent 空、空 diff 等）。
- **inline edit 出来了但 Tab 不跳/不接受**：集成层——确认 `bridgeInlineEditState` 有把全局四个 key 置对、`JumpToNextInlineEditAction` 与 commit 的 when 互斥且权重 >400、`!suggestWidgetVisible` 等子句成立。逐步诊断走 [fix-keybinding-not-firing]。
- **根本不渲染 inline edit**：先用 e2e probe `installFakeInlineEdit(s,e,'X')` 隔离 AI 层——能渲染说明问题在生成层（gate/历史/parse/sendRequest）；仍不渲染说明 provider 没返回 `isInlineEdit:true`、或 `context.includeInlineEdits` 为 false（`inlineSuggest.edits.enabled` 被关）、或 Monaco 集成断了。
- **加配置项**：schema + service 里读它（见上「改两处」）。
- **改 NES 快捷键 / when**：`inlineCompletionActions.ts` 的 `JumpToNextInlineEditAction` / `CommitInlineCompletionAction`。

### 易踩坑速记

1. **NES 寄生在 inline completion 上，不是独立系统**：同 provider、同 provide() 入口、同请求基建、同补全模型。改动前先认清自己在改「共享」还是「分叉」（见上表）。
2. **`context.includeInlineEdits` 是分流开关**：Monaco 单次 provide 调用里靠它区分要不要 inline edit；它由 `inlineSuggest.edits.enabled`（默认 true）决定。它为 false 时永远走不到 NES。
3. **四个 inline-edit context key 是镜像值**：全局 handler 只认 `bridgeInlineEditState` set 的；别误以为 Monaco scoped 同名 key 全局可见。raw 可见性 key 是 `inlineEditIsVisible`（带 Is），不是 `inlineEditVisible`。
4. **jump 与 commit 的 when 必须互斥**：靠 `tabShouldJumpToInlineEdit` vs `tabShouldAcceptInlineEdit`（Monaco 保证互斥）+ commit 显式 `!tabShouldJumpToInlineEdit`。两命令同 401 权重，错配会导致 Tab 行为抖动（已修，勿改成单命令）。
5. **解析器多处整行替换、忽略列号**：协议是 `{edits:[{startLine,endLine,newText}, …]}` 行级；`composeNesEdits` 合并成单 span（中间未改行原样保留），range 的 `endColumn` 由 `getLineMaxColumn` 补齐。**多处编辑是一个 item 的大 range，靠 Monaco 内部 diff 拆成多高亮，不是多 item，也不是 `additionalTextEdits`（inline-edit 路径已禁用）**。别让模型给列号；模型只吐改动行，大文本由本地文档重建（省 token）。
6. **空 diff / noEdit / 解析失败都→null**：表现为「触发了但没 inline edit」，多数是预期不是 bug。
7. **NES 默认关闭**：`ai.nes.enabled` 默认 false。调试时先确认开了，且 `context.includeInlineEdits` 为 true。
8. **编辑历史靠 FileEditor 喂**：NES 不订阅 Monaco，`RecentEditsTracker.record` 来自 `FileEditor.tsx` 的 `onDidChangeContent`。若历史一直为空 → 检查 FileEditor 装配；automatic 触发下空历史会被静默跳过。
9. **RecentEditsTracker DI 顺序**：`main.tsx` 里必须在 `InlineCompletionService` 之前注册，否则 service 注入不到。
10. **改了 service 构造签名**：`InlineCompletionService` 注入了 `IRecentEditsTracker`，单测 `createService` 与 `FileEditor.*.test.tsx` 的 DI 都要提供 `RecentEditsTracker`，否则 fail loud；happy-dom 的 monaco stub（`test-stubs/monaco-editor.ts`）的 `onDidChangeContent` 现在传 `{changes:[]}` 给回调（否则 `e.changes` 崩）。

### 验证

```bash
# 生成层单测（NES 三块）
cd apps/editor && pnpm vitest run --project renderer-node \
  src/renderer/services/ai/__tests__/nesEditParser.test.ts \
  src/renderer/services/ai/__tests__/RecentEditsTracker.test.ts \
  src/renderer/services/ai/__tests__/InlineCompletionService.test.ts   # 含 NES describe
# 全量校验
pnpm check
# e2e（改 renderer 后必重建 out/ 产物）
pnpm --filter @universe-editor/editor build
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts specs/smoke.nes.spec.ts
```

e2e（`apps/editor/e2e/specs/smoke.nes.spec.ts`，@p1）覆盖：jump 命令已注册 + **`installFakeInlineEdit(3,3,'LINE THREE')`（光标在 line1，edit 在 line3）→ 触发 → 轮询 `getContextKey('inlineEditIsVisible')` 为 true（证明 Monaco 原生渲染）→ `getActiveInlineEditText()` 读出文本 → runCommand jump 使光标到 line3 → runCommand commit → 断言整行替换生效**。
探针（`renderer/e2e/probe.ts`，签名在 `shared/e2e/contract.ts`）：`installFakeInlineEdit(startLine, endLine, text)`（在活跃 Monaco 注册返回 `isInlineEdit:true` 整行替换的假 provider，**仅当 `context.includeInlineEdits===true` 才出**，绕开 AI）、`getActiveInlineEditText()`（读 `inlineEditState.inlineEdit.edit.text`）。**改 Tab 跳转/接受链路务必跑这条 e2e**。

> e2e 里别用键盘连按多个 Tab 断言 jump+accept——jump/accept 的步数随光标距离与 margin（±1 行）变化，多按会把多余 Tab 当缩进插入。用 runCommand jump→（poll 光标行）→commit 更确定（已踩坑）。

### 关键参考路径

生成层：
- `apps/editor/src/renderer/services/ai/RecentEditsTracker.ts` —— 编辑历史 ring buffer（+ `__tests__/RecentEditsTracker.test.ts`）
- `apps/editor/src/renderer/services/ai/nesEditParser.ts` —— 结构化编辑解析（+ `__tests__/nesEditParser.test.ts`）
- `apps/editor/src/renderer/services/ai/InlineCompletionService.ts` —— `provide()` 双模式 / `_provideInlineEdit` / `_buildNesPrompt` / `_numberedDocument` / `_sendText`（+ `__tests__/InlineCompletionService.test.ts` 的 NES describe）
- `apps/editor/src/renderer/services/ai/nesSystemPrompt.ts` —— `DEFAULT_NES_SYSTEM_PROMPT`

集成层：
- `apps/editor/src/renderer/contributions/ContextKeyContribution.ts` —— 四个全局 inline-edit context key
- `apps/editor/src/renderer/services/editor/editorFocus.ts` —— `bridgeInlineEditState`
- `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` —— 装配 bridge + 喂编辑历史
- `apps/editor/src/renderer/actions/inlineCompletionActions.ts` —— `JumpToNextInlineEditAction` + commit when 仲裁
- `apps/editor/src/renderer/actions/index.ts` —— 注册

配置 / DI / 测试基建：
- `apps/editor/src/renderer/contributions/InlineCompletionConfigurationContribution.ts` —— 7 个 `ai.nes.*` schema
- `apps/editor/src/renderer/main.tsx` —— `RecentEditsTracker` DI（在 service 之前）
- `apps/editor/src/shared/e2e/contract.ts` + `renderer/e2e/probe.ts` + `e2e/specs/smoke.nes.spec.ts` —— e2e 与探针
- `apps/editor/test-stubs/monaco-editor.ts` —— happy-dom monaco stub（`onDidChangeContent` 传 `{changes:[]}`）

相关：本文件「内联补全」一节（底层 ghost-text 续写）、[fix-keybinding-not-firing]（Tab 抢不到/快捷键不触发的诊断与权重仲裁）、本文件「AI Debug」一节（NES 调用以 purpose `next-edit-suggestion` 被记录/可离线回放）。

## 其它

- 后续使用中发现新经验，需同步更新本文件
