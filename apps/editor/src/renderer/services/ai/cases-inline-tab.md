# cases-inline-tab.md

本文从 `services/ai/CLAUDE.md` 拆出，范围是：内联补全（inline completion / ghost text）的完整细节——完整数据流一图、`InlineCompletionService` 接口细节、Tab 接受三件套的完整故事（editContext 下 Monaco 内置 Tab 为何不可靠、权重仲裁全表）、五个 Action 全表（id/快捷键/when）、AI 入口演进历史、配置项默认值与 type、e2e 探针细节。主线结论在 CLAUDE.md，本文保留修 bug 时需要的完整上下文。

## 完整数据流一图

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
  AiStatusBarButtons ── 订阅 service.onDidChange → 状态栏 AI 快速设置里的 inline 开关
```

## InlineCompletionService 接口细节（生成层主干）

`apps/editor/src/renderer/services/ai/InlineCompletionService.ts`

- **注入依赖**：`IAiModelService`（产文本）、`IConfigurationService`（读配置 + 订阅变化）、`INotificationService`（错误 toast）、`ILoggerService`。
- **暴露**（接口 `IInlineCompletionService`）：
  - `onDidChange: Event<void>`——任一作用域 enabled / 选中模型 / requesting 变化时触发（驱动状态栏）。
  - `requesting: boolean`——有在途请求（状态栏 spinner）。
  - `getModelId() / setModelId(id)`——读写补全模型（**与 chat 模型分开存**）。
  - `isEnabled(scope) / toggleEnabled(scope) / setEnabled(scope, b)`——**按作用域（`'editor'` / `'session'`）全局持久化**：先 `update(…, undefined, Project)` 清工作区层覆盖、再写 `ConfigurationTarget.User`（顺序勿反，见 CLAUDE.md 易踩坑），经 UserSettingsSync 落全局 settings.json；内存即时翻转 + 对外恰 fire 一次 onDidChange（配置事件回音由 `_applyEnabled` 同值守卫吞掉）。
  - `provide(model, position, context, token)`——Monaco provider 的真正入口。
- **作用域判定**：`isSessionPromptModel(model)`（导出纯函数）按 model URI 区分——会话 prompt 输入框的 model 由 `PromptMonacoEditor` 显式赋 `inmemory://prompt/<id>` URI（scheme `inmemory` + authority `prompt`），其余一律 editor 侧（diff 预览 / Swarm 内嵌编辑器都算 editor）。
- **provide() 的 gate 顺序**（任一不过返回 null，**新增 gate 加在这里**）：`!_enabled[scopeOf(model)]` → 语言在 `disabledLanguages` → 无 `model`（modelId 空或已从模型列表删除）。
- **FIM 提示构建** `_buildPrompt`：`[system, user]`，user 体为 `<|prefix|>...{prefix}<|cursor|>{suffix}<|suffix|>`；prefix/suffix 分别裁到 `maxContextPrefixChars` / `maxContextSuffixChars`。
- **后处理** `sanitizeCompletion`（**纯函数、易单测**）：去 ```` ``` ```` 代码围栏 → 去掉「模型回复尾部与光标后既有代码开头重叠」的重复 → `multiline:false` 时截断到首个换行 → 纯空白归一为空串（空串 → 不出建议）。
- **错误处理**：失败 toast **去重**（同一 errorKey 只弹一次，成功后清零；取消 token 不弹），toast 带 Disable 按钮（只关当前触发的作用域）。
- **配置存储**：9 个 key 全走 `IConfigurationService`，写用 `ConfigurationTarget.User`；`setModelId(undefined)` 落盘为 `''`，`getModelId()` 把 `''` 读回 `undefined`。
- **DI 注册**：`renderer/main.tsx`——`createInstance(InlineCompletionService)` → `services.set(IInlineCompletionService, …)`。
- **单测**：`services/ai/__tests__/InlineCompletionService.test.ts`——覆盖 sanitizeCompletion 各分支、provide 的四种 gate、两作用域独立 gate、模型持久化 undefined↔'' 往返、错误 toast 去重、**enabled persistence**（per-scope toggle 写 User 层+清 Project 覆盖+恰 fire 一次+层种子恢复）。改生成层逻辑**优先在这里加用例**（用 FakeAiModel/FakeNotification + 真 `ConfigurationService`，无需起 Monaco）。

## Tab 接受三件套完整故事（集成层）

这一层是「ghost text 出来了但 Tab 不接受 / 根本不出 ghost text」类 bug 的战场。

### provider 注册（让 Monaco 知道有补全）

`contributions/InlineCompletionContribution.ts`（`WorkbenchPhase.AfterRestore`，Monaco 已就绪后）：等 `MonacoLoader.ensureInitialized()`，用 `ILanguageFeaturesService.registerInlineCompletionsProvider('*', provider)` 注册**唯一一个全语言 provider**，其 `provideInlineCompletions` 桥接到 `IInlineCompletionService.provide()`。在 `contributions/index.ts` 注册。

### inlineSuggestionVisible 镜像（集成层关键一跳）

Monaco 把 ghost-text 可见性放在 editor **自己 scoped 的** context-key service 上，全局 keybinding handler 看不到。所以：

- `services/editor/editorFocus.ts` → `bridgeInlineSuggestionVisible(editor, contextKeyService)`：取 `editor.getContribution('editor.contrib.inlineCompletionsController')`，用 `autorun` 订阅 `controller.model.read(r)?.inlineCompletionState.read(r)?.primaryGhostText`，当 `ghost && !ghost.isEmpty()` 时 `contextKeyService.set('inlineSuggestionVisible', true)`，dispose 时复位 false。**与同文件的 `bridgeSuggestWidgetVisible`（镜像 `suggestWidgetVisible`）是同一套路**。
- `contributions/ContextKeyContribution.ts`：`createKey<boolean>('inlineSuggestionVisible', false)` 建全局 key（紧挨 `suggestWidgetVisible`）。
- `workbench/editor/FileEditor.tsx`：editor 实例创建后装配 `inlineSuggestSub = bridgeInlineSuggestionVisible(ed, contextKeyService)`，cleanup 时 dispose（与 `suggestSub` 成对）。

### Tab 抢占（CommitInlineCompletionAction）

`actions/inlineCompletionActions.ts` → `CommitInlineCompletionAction`（id `ai.inlineCompletion.commit`，**primary `tab`**，when `inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible`）：run 时 `editor.trigger('keyboard', 'editor.action.inlineSuggest.commit', undefined)`。其 keybinding 显式设 **`weight: KeybindingWeight.ExternalExtension + 1`（=401）**，于是全局 handler **CLAIM** Tab（preventDefault + 执行）而非 defer。

### 根因与权重仲裁（为什么不能靠 Monaco 自己的 Tab）

本编辑器开 `editContext: true`，焦点元素是 `DIV.native-edit-context`，其异步 keydown 路径下 Monaco 内置的 `AcceptInlineCompletion`（id `inlineSuggestCommitId`，Tab，weight 200）**不可靠地被缩进抢走**——即使其 scoped context 满足 commit 的全部 kbExpr。

**权重必须压过的不只是 Monaco 桥接命令（MonacoDefault 50），还有扩展贡献的 Tab 绑定**（如 markdown 扩展的 `markdown.editing.onTab`，经 `ExtensionPointTranslator` 统一赋 `ExternalExtension`=400）——这正是早期只用默认 WorkbenchContrib(200) 导致「markdown 文件里 Tab 走缩进而非接受补全」的根因。仍低于 `User`(1000)，用户自定义键位优先。

权重谱：MonacoDefault(50) < WorkbenchContrib(200) < ExternalExtension(400) < 我们的 401 < User(1000)。

修法就是上面三件套：**镜像可见性到全局 + 自己用高权重命令抢 Tab 直接调 commit**。这是已修 bug，**勿回退**。Tab 抢不到的逐步诊断见 skill [fix-keybinding-not-firing]。

## 五个 Action 全表

`apps/editor/src/renderer/actions/inlineCompletionActions.ts`（`CATEGORY = AI`，全在 `actions/index.ts` `registerAction2`）：

| 类 | id | 快捷键 | when | 做什么 |
|---|---|---|---|---|
| TriggerInlineCompletionAction | `ai.inlineCompletion.trigger` | `alt+\`（f1:true） | `editorTextFocus` | `editor.trigger('editor.action.inlineSuggest.trigger')`；**无模型时弹引导提示**（去 pickModel） |
| CommitInlineCompletionAction | `ai.inlineCompletion.commit` | `tab` | `inlineSuggestionVisible && editorTextFocus && !suggestWidgetVisible` | `editor.trigger('editor.action.inlineSuggest.commit')`（见上） |
| ToggleInlineCompletionInEditorAction | `ai.inlineCompletion.toggleInEditor` | — | — | `service.toggleEnabled('editor')` + toast |
| ToggleInlineCompletionInSessionAction | `ai.inlineCompletion.toggleInSession` | — | — | `service.toggleEnabled('session')` + toast |
| PickInlineCompletionModelAction | `ai.inlineCompletion.pickModel` | — | — | QuickPick 选模型 → `setModelId()` 持久化 |

两个 toggle 共享抽象基类 `ToggleInlineCompletionScopeAction`（`protected abstract readonly scope`）。状态栏 AI 快速设置的勾选不经过命令，直接调 `service.setEnabled(scope, b)`。

trigger/commit 都靠 `IEditorGroupsService.activeGroup.activeEditor` 拿 `FileEditorInput` → `FileEditorRegistry.get()` 拿 Monaco 实例再 `editor.trigger(...)`；activeEditor 不是 FileEditorInput 时静默返回。

## AI 入口演进历史（已并入状态栏 Sparkle 按钮）

- 🔀 2026-06 变更：原 `InlineCompletionStatusContribution`（状态栏 Completions 条目：requesting `$(loading~spin)` / enabled `$(sparkle)` / disabled `$(circle-slash)`，点击触发 toggle）已删除，AI 入口统一为 Sparkle 按钮。
- 🔀 2026-09 变更：AI 入口从标题栏迁回**状态栏右下角** `workbench/statusbar/AiStatusBarButtons.tsx`（data-testid `statusbar-ai-button`，经 `AiStatusBarContribution` 以 componentKey 挂载）；新建会话 / 选择 Agent 两个按钮留在标题栏（`workbench/titlebar/AgentSessionButtons.tsx`）。

快速设置浮层细节（workbench-ui 的 `AiQuickSettingsPanel`）：inline-completion 区按作用域两个勾选项（data-testid `ai-quick-settings-inline-toggle-editor` / `-session`，`Checkbox` 的 `checked` 反映 `service.isEnabled(scope)`，拨动 → `inline.setEnabled(scope, b)`）、四个功能模型行（chat / inline / commit / sessionTitle → 各自 pickModel 命令）、Open Sessions / Manage AI Models 捷径。数据源：订阅 `inline.onDidChange` + `IAiModelService` 的 onDidChange*Models 系列事件刷新。tooltip：基础文案 + 活跃会话 MCP server 摘要。

## 配置项全表（9 个，全 `ai.inlineCompletion.*`）

schema 定义在 `contributions/InlineCompletionConfigurationContribution.ts`（`WorkbenchPhase.BlockStartup`——schema 必须早注册，否则其它 contribution 读默认值拿不到）：

| key | type | default | 用途 |
|---|---|---|---|
| `.enabledInEditor` | boolean | true | 文本编辑器作用域开关 |
| `.enabledInSession` | boolean | false | 会话 prompt 输入框作用域开关 |
| `.model` | string | `''` | 补全模型 id（**独立于 chat**） |
| `.debounceDelay` | number | 300 | 自动触发防抖 ms |
| `.maxContextPrefixChars` | number | 2000 | 光标前上文裁剪 |
| `.maxContextSuffixChars` | number | 500 | 光标后下文裁剪 |
| `.maxTokens` | number | 128 | 生成上限 |
| `.multiline` | boolean | true | 是否允许多行（false → sanitize 截单行） |
| `.disabledLanguages` | string[] | [] | 语言黑名单 |

## e2e 与探针

e2e（`apps/editor/e2e/specs/smoke.inlineCompletion.spec.ts`，@p1，用 sharedApp 复用实例）覆盖：四命令已注册 + **`installFakeInlineCompletion('WORLD')` → 触发 → 轮询 `getActiveInlineSuggestionText()` 出现 → 按 Tab → 文档插入 → ghost 消失**、`alt+\` 解析到 trigger、标题栏 AI 按钮可见、快速设置里 inline toggle 随 toggle 命令翻转（`aria-checked`）。

探针（`renderer/e2e/probe.ts`，签名在 `shared/e2e/contract.ts`）：`installFakeInlineCompletion(text)`（在活跃 Monaco 上注册恒定返回的假 provider，绕开 AI；非 FileEditor 返回 false；幂等替换）、`getActiveInlineSuggestionText()`（读 controller `primaryGhostText` 各 part 拼接，无则 undefined）。**改 Tab 接受链路务必跑这条 e2e**。

## 关键参考路径

- `apps/editor/src/renderer/services/ai/InlineCompletionService.ts` —— 生成层主干（gate / FIM / sanitize / 错误去重）
- `apps/editor/src/renderer/services/ai/__tests__/InlineCompletionService.test.ts` —— 生成层单测
- `apps/editor/src/renderer/contributions/InlineCompletionContribution.ts` —— 唯一全语言 provider 注册
- `apps/editor/src/renderer/contributions/InlineCompletionConfigurationContribution.ts` —— 9 个配置 schema（BlockStartup）
- `apps/editor/src/renderer/workbench/statusbar/AiStatusBarButtons.tsx` —— 状态栏 AI 统一入口（含 inline 开关）
- `apps/editor/src/renderer/actions/inlineCompletionActions.ts` —— trigger/commit/toggle/pickModel
- `apps/editor/src/renderer/services/editor/editorFocus.ts` —— `bridgeInlineSuggestionVisible` / `bridgeSuggestWidgetVisible`
- `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` —— 装配/dispose 两个 bridge
- `apps/editor/src/renderer/contributions/ContextKeyContribution.ts` —— 建全局 `inlineSuggestionVisible` key
- `apps/editor/src/renderer/main.tsx` —— DI 注册 InlineCompletionService
- `apps/editor/e2e/specs/smoke.inlineCompletion.spec.ts` + `renderer/e2e/probe.ts` + `shared/e2e/contract.ts` —— e2e 与探针
