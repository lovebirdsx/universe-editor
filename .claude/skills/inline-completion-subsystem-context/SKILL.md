---
name: inline-completion-subsystem-context
description: 处理 inline completion（内联补全 / ghost text / AI 代码补全）相关功能时召回，提供整个内联补全子系统的上下文地图——InlineCompletionService（读配置 + 构 FIM 提示 + 调 IAiModelService + 后处理补全文本）、单个全语言 Monaco provider 的注册、四个 Action（trigger/commit/toggle/pickModel）、状态栏 Completions 条目、八个 ai.inlineCompletion.* 配置项、以及最容易踩坑的 **Tab 接受 ghost text** 这条链路（Monaco 在 editContext:true 下自身 Tab dispatch 不可靠，靠把 scoped 的 inlineSuggestionVisible 镜像到全局 context + 用高权重 CommitInlineCompletionAction 抢占 Tab 来修）。当任务涉及 IInlineCompletionService、ghost text 不出现/不接受、补全模型选择与持久化、补全状态栏图标、FIM 提示构建、补全文本后处理（去围栏/去重复/截断）、防抖、语言黑名单，或要理解「补全怎么从触发走到插入文档」时，先读它建立全局认知。Tab 抢不到/快捷键不触发的诊断细节见 [fix-keybinding-not-firing]；补全文本的来源（AI 模型/provider 注册）属于 AI 模型层。
disable-model-invocation: true
---

# Inline Completion 子系统 上下文地图

inline completion（内联补全 / ghost text）是把 **AI 生成的代码建议**以灰字形式显示在光标处、按 **Tab** 接受的功能。它寄生在 **Monaco 的 inline completions 机制**之上：我们只注册**一个全语言 provider**，由 `IInlineCompletionService` 在被调用时去问 AI 模型；UI（ghost text 渲染、Tab/Esc 交互）全由 Monaco 内部的 `editor.contrib.inlineCompletionsController` 负责。

> ⚠️ 第一原则：动手前先认领你的改动落在哪一层——多数 bug 不在同一层。
> - **生成层**（`InlineCompletionService`）：补全文本怎么来、怎么清洗、什么时候不给。改提示/后处理/防抖/黑名单/模型选择在这。
> - **集成层**（provider 注册 + context key 镜像 + keybinding）：Monaco 怎么知道有补全、Tab 怎么接受。**「ghost text 出来了但 Tab 不接受」永远是这一层**，不是生成层。
> - **AI 模型层**（`IAiModelService`，不属于本子系统）：真正产文本的地方。模型列表、密钥、provider 在那边（见 apps/editor/CLAUDE.md 套路 I）。

## 数据流一图

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
  InlineCompletionStatusContribution ── 订阅 service.onDidChange → 状态栏 Completions 图标
```

## 核心服务：InlineCompletionService（生成层主干）

`apps/editor/src/renderer/services/ai/InlineCompletionService.ts`

- **注入依赖**：`IAiModelService`（产文本）、`IConfigurationService`（读 8 个配置 + 订阅变化）、`INotificationService`（错误 toast）、`ILoggerService`。
- **暴露**（接口 `IInlineCompletionService`）：
  - `onDidChange: Event<void>`——enabled / 选中模型 / requesting 任一变化时触发（驱动状态栏）。
  - `enabled: boolean`——运行时开关；`requesting: boolean`——有在途请求（状态栏 spinner）。
  - `getModelId() / setModelId(id)`——读写补全模型（**与 chat 模型分开存**，见下）。
  - `toggleEnabled() / setEnabled(b)`。
  - `provide(model, position, context, token)`——Monaco provider 的真正入口。
- **provide() 的 gate 顺序**（任一不过返回 null，**新增 gate 加在这里**）：`!enabled` → 语言在 `disabledLanguages` → 无 `model`（modelId 空或已从模型列表删除）。
- **FIM 提示构建** `_buildPrompt`：`[system, user]`，user 体为 `<|prefix|>...{prefix}<|cursor|>{suffix}<|suffix|>`；prefix/suffix 分别裁到 `maxContextPrefixChars` / `maxContextSuffixChars`。
- **后处理** `sanitizeCompletion`（**纯函数、易单测**）：去 ```` ``` ```` 代码围栏 → 去掉「模型回复尾部与光标后既有代码开头重叠」的重复 → `multiline:false` 时截断到首个换行 → 纯空白归一为空串（空串 → 不出建议）。
- **错误处理**：失败 toast **去重**（同一 errorKey 只弹一次，成功后清零；取消 token 不弹），toast 带 Disable 按钮。
- **配置存储**：8 个 key 全走 `IConfigurationService`，写用 `ConfigurationTarget.User`；`setModelId(undefined)` 落盘为 `''`，`getModelId()` 把 `''` 读回 `undefined`。
- **DI 注册**：`renderer/main.tsx`——`createInstance(InlineCompletionService)` → `services.set(IInlineCompletionService, …)`。
- **单测**：`services/ai/__tests__/InlineCompletionService.test.ts`——覆盖 sanitizeCompletion 各分支、provide 的四种 gate、模型持久化 undefined↔'' 往返、错误 toast 去重。改生成层逻辑**优先在这里加用例**（用 FakeAiModel/FakeConfig/FakeNotification，无需起 Monaco）。

## 集成层：provider 注册 + context key 镜像 + Tab 接受

这一层是「ghost text 出来了但 Tab 不接受 / 根本不出 ghost text」类 bug 的战场。

### provider 注册（让 Monaco 知道有补全）

`contributions/InlineCompletionContribution.ts`（`WorkbenchPhase.AfterRestore`，Monaco 已就绪后）：等 `MonacoLoader.ensureInitialized()`，用 `ILanguageFeaturesService.registerInlineCompletionsProvider('*', provider)` 注册**唯一一个全语言 provider**，其 `provideInlineCompletions` 桥接到 `IInlineCompletionService.provide()`。在 `contributions/index.ts` 注册。

### inlineSuggestionVisible 镜像（集成层关键一跳）

Monaco 把 ghost-text 可见性放在 editor **自己 scoped 的** context-key service 上，全局 keybinding handler 看不到。所以：

- `services/editor/editorFocus.ts` → `bridgeInlineSuggestionVisible(editor, contextKeyService)`：取 `editor.getContribution('editor.contrib.inlineCompletionsController')`，用 `autorun` 订阅 `controller.model.read(r)?.inlineCompletionState.read(r)?.primaryGhostText`，当 `ghost && !ghost.isEmpty()` 时 `contextKeyService.set('inlineSuggestionVisible', true)`，dispose 时复位 false。**与同文件的 `bridgeSuggestWidgetVisible`（镜像 `suggestWidgetVisible`）是同一套路**。
- `contributions/ContextKeyContribution.ts`：`createKey<boolean>('inlineSuggestionVisible', false)` 建全局 key（紧挨 `suggestWidgetVisible`）。
- `workbench/editor/FileEditor.tsx`：editor 实例创建后装配 `inlineSuggestSub = bridgeInlineSuggestionVisible(ed, contextKeyService)`，cleanup 时 dispose（与 `suggestSub` 成对）。

### Tab 抢占（CommitInlineCompletionAction）

`actions/inlineCompletionActions.ts` → `CommitInlineCompletionAction`（id `ai.inlineCompletion.commit`，**primary `tab`**，when `inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible`）：run 时 `editor.trigger('keyboard', 'editor.action.inlineSuggest.commit', undefined)`。其 keybinding 显式设 **`weight: KeybindingWeight.ExternalExtension + 1`（=401）**，于是全局 handler **CLAIM** Tab（preventDefault + 执行）而非 defer。**权重必须压过的不只是 Monaco 桥接命令（MonacoDefault 50），还有扩展贡献的 Tab 绑定**（如 markdown 扩展的 `markdown.editing.onTab`，经 `ExtensionPointTranslator` 统一赋 `ExternalExtension`=400）——这正是早期只用默认 WorkbenchContrib(200) 导致「markdown 文件里 Tab 走缩进而非接受补全」的根因。仍低于 `User`(1000)，用户自定义键位优先。

> 🔑 **为什么不能靠 Monaco 自己的 Tab**：本编辑器开 `editContext: true`，焦点元素是 `DIV.native-edit-context`，其异步 keydown 路径下 Monaco 内置的 `AcceptInlineCompletion`（id `inlineSuggestCommitId`，Tab，weight 200）**不可靠地被缩进抢走**——即使其 scoped context 满足 commit 的全部 kbExpr。修法就是上面三件套：**镜像可见性到全局 + 自己用高权重命令抢 Tab 直接调 commit**。这是已修 bug，**勿回退**。Tab 抢不到的逐步诊断见 [fix-keybinding-not-firing]。

## 四个 Action

`apps/editor/src/renderer/actions/inlineCompletionActions.ts`（`CATEGORY = AI`，全在 `actions/index.ts` `registerAction2`）：

| 类 | id | 快捷键 | when | 做什么 |
|---|---|---|---|---|
| TriggerInlineCompletionAction | `ai.inlineCompletion.trigger` | `alt+\`（f1:true） | `editorTextFocus` | `editor.trigger('editor.action.inlineSuggest.trigger')`；**无模型时弹引导提示**（去 pickModel） |
| CommitInlineCompletionAction | `ai.inlineCompletion.commit` | `tab` | `inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible` | `editor.trigger('editor.action.inlineSuggest.commit')`（见集成层） |
| ToggleInlineCompletionAction | `ai.inlineCompletion.toggle` | — | — | `service.toggleEnabled()` + toast；状态栏点击也走它 |
| PickInlineCompletionModelAction | `ai.inlineCompletion.pickModel` | — | — | QuickPick 选模型 → `setModelId()` 持久化 |

trigger/commit 都靠 `IEditorGroupsService.activeGroup.activeEditor` 拿 `FileEditorInput` → `FileEditorRegistry.get()` 拿 Monaco 实例再 `editor.trigger(...)`；activeEditor 不是 FileEditorInput 时静默返回。

## 状态栏：Completions 条目

`contributions/InlineCompletionStatusContribution.ts`（`WorkbenchPhase.AfterRestore`）：订阅 `service.onDidChange` → `_render()`：

- 图标：requesting → `$(loading~spin)`；enabled → `$(sparkle)`；disabled → `$(circle-slash)`。
- tooltip：解析 `getModelId()` + `IAiModelService.getModels()` 显模型名 / "no model selected" / "off"。
- 点击命令：`ToggleInlineCompletionAction.ID`。
- 用 `statusBarService.addEntry()` 拿 accessor，后续 `entry.update()`（套路 E 的标准生命周期）。

## 配置项（8 个，全 `ai.inlineCompletion.*`）

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

## 与 AI 模型层的关系

- 补全文本来自 `IAiModelService.sendRequest(messages, { modelId, maxTokens }, token)`，返回 `AiResponse`（流 + result promise），用 `getTextResponse(response)` 合并。`IAiModelService` 由 main 进程实现、经 ProxyChannel 暴露给 renderer。
- **补全模型 id 与 chat 模型 id 是两套**：补全存 `ai.inlineCompletion.model`（`pickModel` 选），chat/ACP 走自己的配置与命令。改「选模型」时别串台。
- 加新 AI provider（让模型列表多出可选项）属于 AI 模型层，见 apps/editor/CLAUDE.md **套路 I**——密钥只走 `ISecretStorageService`，绝不进 renderer/settings.json。

## 常见任务 → 改哪里

- **改补全提示 / 后处理（去围栏、去重复、截断规则）**：`InlineCompletionService` 的 `_buildPrompt` / `sanitizeCompletion`，配套 `__tests__/InlineCompletionService.test.ts` 加用例。
- **新增「什么时候不给补全」的条件**：provide() 的 gate 段（enabled/语言/模型那串）。
- **ghost text 出来了但 Tab 不接受**：集成层三件套——确认 `bridgeInlineSuggestionVisible` 有把全局 `inlineSuggestionVisible` 置 true、`CommitInlineCompletionAction` 权重 > 400（ExternalExtension，压过扩展级 Tab 绑定）、when 子句成立（`!suggestWidgetVisible` 等）。逐步诊断走 [fix-keybinding-not-firing]。
- **根本不出 ghost text**：先用 e2e probe `installFakeInlineCompletion('X')` 隔离 AI 层——能出说明问题在生成层（gate/模型/sendRequest）；仍不出说明 provider 没注册或 Monaco 集成断了。
- **改状态栏图标/tooltip/点击**：`InlineCompletionStatusContribution.ts`。
- **加配置项**：schema（`InlineCompletionConfigurationContribution.ts`）+ service 里读它。
- **改快捷键 / when**：`inlineCompletionActions.ts` 对应 Action 的 `keybinding`。

## 易踩坑速记

1. **Tab 接受依赖三件套缺一不可**（已修，勿回退）：全局 `inlineSuggestionVisible` 建 key（ContextKeyContribution）+ 镜像（editorFocus 的 bridge，且 FileEditor 里装配/dispose）+ 高权重 commit 命令。缺任一，editContext 模式下 Tab 会去缩进。
2. **inlineSuggestionVisible 是镜像值，不是 Monaco 原生 key**：全局 handler 只认我们 set 的这个；别误以为 Monaco 的 scoped 同名 key 会自动可见。
3. **commit 命令权重必须 > ExternalExtension(400)**：用 `KeybindingWeight.ExternalExtension + 1`。光压过 Monaco 的 MonacoDefault(50) 不够——扩展贡献的 Tab 绑定（如 `markdown.editing.onTab`）权重是 400，旧的默认 WorkbenchContrib(200) 会在 markdown 文件里被它抢走 Tab（已修 bug，勿回退到 200）。仍低于 User(1000) 保证用户键位优先。
4. **补全模型 ≠ chat 模型**：两套配置键，pickModel 各管各的，调试模型问题先确认在看哪一个。
5. **sanitize 空串 = 不出建议**：纯空白/只有围栏的回复被归一为空 → provide 返回 null，表现为「触发了但没 ghost」，这是预期不是 bug。
6. **配置 schema 要在 BlockStartup 注册**：晚于读取方注册会让默认值读不到。
7. **provide 的 activeEditor 守卫**：非 `FileEditorInput`（如 markdown 预览、设置页）时 trigger/commit/provide 都应静默 no-op，别假设永远有 Monaco 实例。

## 验证

```bash
cd apps/editor && pnpm vitest run --project renderer \
  src/renderer/services/ai/__tests__/InlineCompletionService.test.ts   # 生成层单测
pnpm check                                          # lint+typecheck+全量 test
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts specs/smoke.inlineCompletion.spec.ts
```

e2e（`apps/editor/e2e/specs/smoke.inlineCompletion.spec.ts`，@p1，用 sharedApp 复用实例）覆盖：四命令已注册 + **`installFakeInlineCompletion('WORLD')` → 触发 → 轮询 `getActiveInlineSuggestionText()` 出现 → 按 Tab → 文档插入 → ghost 消失**、`alt+\` 解析到 trigger、状态栏有 Completions 条目、toggle 翻转图标。
探针（`renderer/e2e/probe.ts`，签名在 `shared/e2e/contract.ts`）：`installFakeInlineCompletion(text)`（在活跃 Monaco 上注册恒定返回的假 provider，绕开 AI；非 FileEditor 返回 false；幂等替换）、`getActiveInlineSuggestionText()`（读 controller `primaryGhostText` 各 part 拼接，无则 undefined）。**改 Tab 接受链路务必跑这条 e2e**。

## 关键参考路径

- `apps/editor/src/renderer/services/ai/InlineCompletionService.ts` —— 生成层主干（gate / FIM / sanitize / 错误去重）
- `apps/editor/src/renderer/services/ai/__tests__/InlineCompletionService.test.ts` —— 生成层单测
- `apps/editor/src/renderer/contributions/InlineCompletionContribution.ts` —— 唯一全语言 provider 注册
- `apps/editor/src/renderer/contributions/InlineCompletionConfigurationContribution.ts` —— 8 个配置 schema（BlockStartup）
- `apps/editor/src/renderer/contributions/InlineCompletionStatusContribution.ts` —— 状态栏 Completions 条目
- `apps/editor/src/renderer/actions/inlineCompletionActions.ts` —— trigger/commit/toggle/pickModel
- `apps/editor/src/renderer/services/editor/editorFocus.ts` —— `bridgeInlineSuggestionVisible` / `bridgeSuggestWidgetVisible`
- `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` —— 装配/dispose 两个 bridge
- `apps/editor/src/renderer/contributions/ContextKeyContribution.ts` —— 建全局 `inlineSuggestionVisible` key
- `apps/editor/src/renderer/main.tsx` —— DI 注册 InlineCompletionService
- `apps/editor/e2e/specs/smoke.inlineCompletion.spec.ts` + `renderer/e2e/probe.ts` + `shared/e2e/contract.ts` —— e2e 与探针
- 相关 skill：[fix-keybinding-not-firing]（Tab 抢不到/快捷键不触发的逐步诊断与权重仲裁）
