# apps/editor/src/renderer/services/ai/CLAUDE.md

本目录承载 renderer 端 AI 域：inline completion / NES 双模式生成层（`InlineCompletionService` + `RecentEditsTracker` + `nesEditParser` + `nesSystemPrompt`）。inline completion 把 AI 建议以灰字显示在光标处、Tab 接受，寄生 Monaco 的 inlineCompletionsController（UI 全由 Monaco 负责，我们只注册一个全语言 provider）；NES 按最近编辑预测光标外任意位置的下一处改动，gutter 指示器 + diff 呈现、Tab 跳转再 Tab 接受。AI 设置页面壳在 `workbench/ai/`，AI Debug 采集主体在 `main/services/ai/`（各见其 CLAUDE.md）。

改动先认层（多数 bug 不在同一层）：
- **生成层**（`InlineCompletionService`）：补全怎么来/怎么清洗/什么时候不给。
- **集成层**（provider 注册 + context key 镜像 + keybinding）：「Tab 不接受」「inline edit 渲染了但 Tab 不跳」永远是这一层。
- **AI 模型层**（`IAiModelService`）：模型列表/密钥/provider，见 apps/editor/CLAUDE.md 套路 I。

## 内联补全（Inline Completion / ghost text）

数据流关键跳（完整图与细节见 [cases-inline-tab.md](cases-inline-tab.md)）：
```
Alt+\ / 停顿自动 → editor.trigger('editor.action.inlineSuggest.trigger')
→ Monaco 调唯一全语言 provider（InlineCompletionContribution，'*'）
→ provide()：gate（enabled/语言/模型）→ 防抖（仅自动）
  → FIM prompt（<|prefix|>…<|cursor|>…<|suffix|>）→ IAiModelService.sendRequest → sanitizeCompletion
→ Monaco 渲染 ghost text（UI 全权）→ bridge 镜像全局 inlineSuggestionVisible → Tab 命中 commit
旁路：AiStatusBarButtons 订阅 onDidChange → 状态栏 inline 开关
```

### 文件 → 职责

- `services/ai/InlineCompletionService.ts` — 生成层主干：gate（enabled → 语言黑名单 → 模型）；`_buildPrompt`（FIM）；`sanitizeCompletion`（纯函数：去围栏 → 去尾部重叠 → 单行截断 → 空串=不出建议）；toast 去重；配置 User 层（modelId `undefined↔''`）。`'editor'`/`'session'` 两作用域独立开关，会话模型经 URI（`inmemory://prompt/<id>`）区分。
- `contributions/InlineCompletionContribution.ts` — AfterRestore 等 Monaco 就绪后注册唯一全语言 provider（`'*'`），桥接 `provide()`。
- `services/editor/editorFocus.ts` — `bridgeInlineSuggestionVisible`：autorun 订阅 controller 的 `primaryGhostText`，set 全局 key，dispose 复位。
- `contributions/ContextKeyContribution.ts` — 建全局 `inlineSuggestionVisible` key。
- `workbench/editor/FileEditor.tsx` — editor 创建后装配 bridge、cleanup dispose。
- `actions/inlineCompletionActions.ts` — 五个 Action（见下）。
- `contributions/InlineCompletionConfigurationContribution.ts` — BlockStartup 注册配置 schema（**必须早注册**，否则其它 contribution 读默认值拿不到）。
- `workbench/statusbar/AiStatusBarButtons.tsx` — 状态栏 AI 统一入口（快速设置：inline 两作用域勾选 + 四功能模型行；勾选直接 `service.setEnabled(scope, b)`，不经过命令）。
- `__tests__/InlineCompletionService.test.ts` — sanitize/gate/持久化/toast 去重。生成层改动优先加用例（FakeAiModel + 真 ConfigurationService，无需 Monaco）。
- DI：`renderer/main.tsx` `createInstance(InlineCompletionService)`。

### 五个 Action（id/快捷键/when 在代码里，注册在 `actions/index.ts`）

- TriggerInlineCompletionAction — `alt+\` 手动触发；无模型时弹引导去 pickModel
- CommitInlineCompletionAction — Tab 接受补全（高权重抢占，见下）
- ToggleInlineCompletionInEditorAction / ToggleInlineCompletionInSessionAction — 按作用域开关 + toast（共享基类 `ToggleInlineCompletionScopeAction`）
- PickInlineCompletionModelAction — QuickPick 选补全模型 → `setModelId()` 持久化

trigger/commit 经 `IEditorGroupsService.activeGroup.activeEditor` 拿 FileEditorInput → `FileEditorRegistry.get()` 拿 Monaco 实例再 `editor.trigger(...)`；activeEditor 非 FileEditorInput 时静默返回。

### Tab 接受三件套（已修 bug，勿回退）

本项目开 `editContext: true`，焦点元素是 `DIV.native-edit-context`，其异步 keydown 路径下 Monaco 内置 Tab 接受（`inlineSuggestCommitId`，weight 200）**不可靠地被缩进抢走**。修法三件套缺一不可：① 全局 contextKey `inlineSuggestionVisible`（ContextKeyContribution）+ ② bridge 镜像（editorFocus.ts，FileEditor 装配/dispose）+ ③ 高权重 commit 命令（`KeybindingWeight.ExternalExtension + 1`=401，压过扩展级 Tab 绑定如 `markdown.editing.onTab`=400，仍低于 User=1000 用户键位优先）。根因/权重仲裁/诊断见 [cases-inline-tab.md](cases-inline-tab.md) 与 skill [fix-keybinding-not-firing]。

### 配置项（9 个，全 `ai.inlineCompletion.*`，schema 在 `InlineCompletionConfigurationContribution.ts`）

`enabledInEditor`（editor 作用域开关）/ `enabledInSession`（session 作用域开关）/ `model`（补全模型 id，**独立于 chat**）/ `debounceDelay` / `maxContextPrefixChars` / `maxContextSuffixChars` / `maxTokens` / `multiline` / `disabledLanguages`（语言黑名单）。新增 = schema + `InlineCompletionService` 读取两处。

### 常见任务 → 改哪里

- 改补全提示/后处理：`_buildPrompt` / `sanitizeCompletion` + 单测加用例。
- 新增「什么时候不给补全」：provide() 的 gate 段。
- ghost text 出了但 Tab 不接受：三件套检查（bridge 置 key / 权重 >400 / when 成立）+ [fix-keybinding-not-firing]。
- 根本不出 ghost text：e2e probe `installFakeInlineCompletion('X')` 隔离 AI 层（能出=生成层问题；不出=provider 注册/Monaco 集成断）。
- 改 AI 入口按钮/快速设置：`workbench/statusbar/AiStatusBarButtons.tsx`。
- 加配置项：schema + service。
- 改快捷键/when：`inlineCompletionActions.ts` 对应 Action 的 keybinding。

### 易踩坑速记

1. Tab 接受三件套缺一不可（勿回退，见上）。
2. `inlineSuggestionVisible` 是镜像值不是 Monaco 原生 key——全局 handler 只认我们 set 的，Monaco scoped 同名 key 全局不可见。
3. commit 权重必须 > ExternalExtension(400)：旧默认 WorkbenchContrib(200) 会在 markdown 文件里被 `markdown.editing.onTab`(400) 抢走 Tab（已修，勿回退到 200）。
4. 补全模型 ≠ chat 模型：两套配置键（`activeModels.inlineCompletion` vs `activeModels.chat`），pickModel 各管各的。
5. sanitize 空串 = 不出建议：纯空白/只有围栏的回复归一为空 → provide 返回 null，表现为「触发了但没 ghost」，预期不是 bug。
6. 配置 schema 要在 BlockStartup 注册：晚于读取方注册会让默认值读不到。
7. 非 FileEditorInput（markdown 预览、设置页等）时 trigger/commit/provide 都静默 no-op。
8. toggle 写配置层必须先删 Project 再写 User：`update` 按「写前 effective ≠ 写入值」fire，先写 User 再删工作区覆盖会让中间态事件把 `_enabled` 回弹（对外可见一次假翻转）。先 `update(key, undefined, Project)` 清覆盖、再 `update(key, value, User)`，对外恰 fire 一次（单测守护）。

### 验证

```bash
cd apps/editor && pnpm vitest run --project renderer src/renderer/services/ai/__tests__/InlineCompletionService.test.ts
pnpm --filter @universe-editor/editor build   # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts specs/smoke.inlineCompletion.spec.ts
```

e2e 探针：`installFakeInlineCompletion(text)`（恒定假 provider 绕开 AI）、`getActiveInlineSuggestionText()`（读 primaryGhostText）。**改 Tab 接受链路务必跑这条 e2e。**

## NES 编辑建议（Next Edit Suggestions / inline edit）

按用户**最近编辑**预测当前文件中光标外任意位置的下一处改动，gutter 指示器 + diff 呈现，Tab 跳转过去、再 Tab 接受。**不是独立子系统**：寄生 inline completion 管道（同一 provider / 同一 provide() / 同一请求基建 / 同一补全模型 `ai.inlineCompletion.model`），靠 `context.includeInlineEdits`（= `inlineSuggest.edits.enabled`，默认 true）在 provide() 内分流到 `_provideInlineEdit`。完整细节（共享 vs 分叉全表、Monaco 源码核实、e2e）见 [cases-nes.md](cases-nes.md)。

数据流关键跳：
```
provide() 共享 gate → if (ai.nes.enabled && context.includeInlineEdits) _provideInlineEdit：
  防抖 → getRecentEdits（空且 automatic → null）→ _buildNesPrompt（recent + cursor + 带行号 document）
  → _sendText（purpose 'next-edit-suggestion'，与续写串行）→ parseNesEdits → composeNesEdits
  → 单个 {insertText, range, isInlineEdit:true} item
→ Monaco 原生渲染 inline edit（gutter + diff，零 UI）→ bridgeInlineEditState 镜像四个全局 key
→ Tab：JumpToNextInlineEditAction（jump）→ 再 Tab：CommitInlineCompletionAction（commit）
→ NES 无产出：按 ai.nes.fallbackToCompletion 回退 ghost-text 或 null
```

### 文件 → 职责

- `services/ai/RecentEditsTracker.ts` — 编辑历史 ring buffer（per-uri，上限 `ai.nes.recentEditsCount`，同行 + 2s 窗内 coalesce）。**不订阅 Monaco**（保持可测），只暴露 `record(uri, changes)`，由 FileEditor 的 `model.onDidChangeContent` 喂入。
- `services/ai/nesEditParser.ts` — `parseNesEdits`/`composeNesEdits` 纯函数。协议整行替换 `[startLine,endLine]`（1-based 闭区间，**忽略列号**）；多编辑合并成单跨度（中间未改行原样保留）。
- `services/ai/InlineCompletionService.ts` — `_provideInlineEdit` / `_buildNesPrompt` / `_numberedDocument` / `_sendText`（与续写共享，purpose 是唯一分叉点——AI Debug 里两种模式各自归类）。
- `services/ai/nesSystemPrompt.ts` — `DEFAULT_NES_SYSTEM_PROMPT`。**目前不可经 aiSettings.json 覆盖**（`AiPromptKind` 无 'nes'；要做成可配需动 platform + 设置 UI）。
- 集成层：`ContextKeyContribution.ts`（四个 key）/ `editorFocus.ts` `bridgeInlineEditState`（与 bridge 同构）/ `FileEditor.tsx`（装配 + 喂编辑历史）/ `inlineCompletionActions.ts` `JumpToNextInlineEditAction`（tab，401；jump 与 commit 靠互斥 when 决唯一胜者）。
- 单测：`__tests__/{nesEditParser,RecentEditsTracker,InlineCompletionService}.test.ts`。

Monaco 0.55.1 原生支持要点（已源码核实，我们零 UI）：provider 返回 `isInlineEdit:true` + 任意行 range 即可；**多处编辑 = 一个 item 的大 range + 完整新文本，靠 Monaco 内部 diff 拆成多高亮——不是多 item、不是 `additionalTextEdits`（inline-edit 路径禁用它）**；standalone 已注册 jump/commit/hide 命令。

### 配置项（7 个，全 `ai.nes.*`，schema 与 9 个 inlineCompletion 同处）

`enabled`（总开关，**默认 false**）/ `recentEditsCount` / `contextLines` / `includeFullDocument` / `debounceDelay` / `maxTokens` / `fallbackToCompletion`。新增 = schema + `InlineCompletionService` 的 CONFIG/DEFAULTS 与读取处。

### 常见任务 → 改哪里

- 改 NES 提示/输出协议：`_buildNesPrompt` / `DEFAULT_NES_SYSTEM_PROMPT` + `nesEditParser`（协议改了要同步改 system prompt 里描述的格式）。
- 改「攒哪些编辑历史/coalesce/留几条」：`RecentEditsTracker`。
- 新增「什么时候不出 NES」：`_provideInlineEdit` 的 gate 段（recent 空、空 diff 等）。
- inline edit 出了但 Tab 不跳/不接受：集成层——四个 key 置对 + when 互斥 + 权重 >400 + [fix-keybinding-not-firing]。
- 根本不渲染 inline edit：probe `installFakeInlineEdit(s,e,'X')` 隔离（能渲染=生成层问题；不渲染=没返回 isInlineEdit:true / includeInlineEdits 为 false / 集成断）。
- 加配置项：schema + service。
- 改 NES 快捷键/when：`JumpToNextInlineEditAction` / `CommitInlineCompletionAction`。

### 易踩坑速记

1. NES 寄生在 inline completion 上——改前先认清「共享」还是「分叉」。
2. `context.includeInlineEdits` 是分流开关（inlineSuggest.edits.enabled，默认 true），为 false 时永远走不到 NES。
3. 四个 inline-edit context key 是镜像值，Monaco scoped 同名 key 全局不可见；raw 可见性 key 是 `inlineEditIsVisible`（带 Is），不是 `inlineEditVisible`。
4. jump 与 commit 的 when 必须互斥（tabShouldJump vs tabShouldAccept + commit 显式 `!tabShouldJumpToInlineEdit`；同 401 权重），错配会导致 Tab 行为抖动（已修，勿合成单命令）。
5. 协议整行替换、忽略列号：别让模型给列号，大文本由本地文档重建（省 token）。
6. 空 diff / noEdit / 解析失败都 → null：表现为「触发了但没 inline edit」，多数是预期不是 bug。
7. NES 默认关闭（`ai.nes.enabled` 默认 false），调试先确认开了。
8. 编辑历史靠 FileEditor 喂：历史一直为空 → 检查 FileEditor 装配（automatic 触发下空历史被静默跳过）。
9. RecentEditsTracker DI 顺序：main.tsx 里必须在 InlineCompletionService 之前。
10. 改了 service 构造签名：单测 createService 与 FileEditor 测试的 DI 都要补 RecentEditsTracker（否则 fail loud）；happy-dom monaco stub 的 onDidChangeContent 传 {changes:[]}。

### 验证

```bash
cd apps/editor && pnpm vitest run --project renderer-node src/renderer/services/ai/__tests__/nesEditParser.test.ts \
  src/renderer/services/ai/__tests__/RecentEditsTracker.test.ts \
  src/renderer/services/ai/__tests__/InlineCompletionService.test.ts
pnpm --filter @universe-editor/editor build
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts specs/smoke.nes.spec.ts
```

e2e 探针：`installFakeInlineEdit(s,e,text)`（**仅 `context.includeInlineEdits===true` 才出**）、`getActiveInlineEditText()`（注意 model 会去公共前缀）、`getContextKey('inlineEditIsVisible')`。**改 Tab 跳转/接受链路务必跑这条 e2e**；别用键盘连按多个 Tab 断言 jump+accept（步数随距离变化，多余 Tab 变缩进），用 runCommand jump → poll 光标行 → commit（已踩坑）。

## 与 AI 模型层的关系

- 文本来自 `IAiModelService.sendRequest(...)`（main 实现、ProxyChannel 暴露），`getTextResponse` 合并流。
- 补全模型 id 与 chat 模型 id 是两套（`activeModels.inlineCompletion` vs `activeModels.chat`，ACP 走自己的配置），改「选模型」时别串台。
- 加新 AI provider（让模型列表多出可选项）见 apps/editor/CLAUDE.md 套路 I。红线：密钥明文存 `aiSettings.json` provider 条目 `apiKey` 字段（POSIX chmod 0600），绝不进日志 / AI Debug，UI 掩码显示。
