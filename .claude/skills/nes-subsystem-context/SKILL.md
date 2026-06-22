---
name: nes-subsystem-context
description: 处理 Next Edit Suggestions（NES / inline edit / 内联编辑建议 / 光标之外的编辑预测）相关功能时召回，提供整个 NES 子系统的上下文地图。NES 是在 inline completion（ghost text 续写）之上叠加的第二种模式：根据用户**最近的编辑历史**预测当前文件中**光标之外任意位置**的下一处改动，用 Monaco 原生的 gutter 指示器 + diff 视图呈现，按 Tab 跳过去、再按 Tab 接受。它与 inline completion **共享同一条管道**（同一个 Monaco provider、同一次 provideInlineCompletions 调用、同一个 InlineCompletionService.provide() 入口、同一套请求基建与补全模型），只在**任务语义层分叉**（不同 prompt / 输出协议 / 配置 / 接受交互）。当任务涉及：编辑历史跟踪（RecentEditsTracker）、结构化编辑输出解析（nesEditParser 的 {startLine,endLine,newText} JSON）、provide() 的 NES 分支与回退、ai.nes.* 配置、inline edit 渲染不出现、Tab 在 jump 与 accept 之间的仲裁（inlineEditIsVisible/tabShouldJumpToInlineEdit/tabShouldAcceptInlineEdit 镜像 + JumpToNextInlineEditAction）、光标之外的编辑预测、NES 系统提示词时，先读它建立全局认知。底层 ghost-text 续写的细节见 inline-completion-subsystem-context；Tab 抢不到/快捷键不触发的诊断见 fix-keybinding-not-firing；补全文本来源（AI 模型/provider）属于 AI 模型层。
disable-model-invocation: true
---

# Next Edit Suggestions (NES) 子系统 上下文地图

NES（Next Edit Suggestions / inline edit）是 **inline completion 的第二种模式**：不再只在光标处续写还不存在的文本，而是根据用户**最近的编辑**预测当前文件中**光标之外任意位置**的下一处改动（如改了函数签名 → 提示改调用处），以 Monaco 原生的 **gutter 指示器 + diff** 呈现，按 **Tab 跳转**过去、再按 **Tab 接受**。

> 🔑 第一认知：NES 不是独立子系统，是寄生在 inline completion 管道上的一条**分叉**。先读 [inline-completion-subsystem-context] 建立 ghost-text 续写的全局认知，再读本篇看 NES 在哪几处分叉出去。

> ⚠️ 第一原则：动手前先认领你的改动落在哪一层——多数 bug 不在同一层。
> - **生成层**（`InlineCompletionService._provideInlineEdit` + `RecentEditsTracker` + `nesEditParser`）：编辑建议怎么来、编辑历史怎么攒、模型返回怎么解析成 `{range, newText}`。改 prompt/解析/历史/防抖/回退在这。
> - **集成层**（context key 镜像 + bridge + jump/commit 命令）：Monaco 怎么知道有 inline edit、Tab 怎么跳转/接受。**「inline edit 渲染出来了但 Tab 不跳/不接受」永远是这一层**，不是生成层。
> - **AI 模型层**（`IAiModelService`，不属于本子系统）：真正产文本的地方。模型/密钥/provider 在那边（见 apps/editor/CLAUDE.md 套路 I）。**NES 与 ghost-text 共用同一个补全模型**（`ai.inlineCompletion.model`，经 `IAiModelService.getInlineCompletionModelId`）。

## 共享 vs 分叉（最重要的一张表）

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

## 数据流一图

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

## Monaco 0.55.1 原生支持（已源码核实，可直接依赖）

**结论：standalone monaco 0.55.1 完整支持 inline edit，我们不写 UI**——只需 provider 返回 `isInlineEdit:true` + 任意行 range 的 item。

- 用户打字后 controller 在 `onDidType`/`onDidPaste` 自动 `model.trigger()`，**NES 与 ghost-text 共用同一次 provider 调用**，靠 `context.includeInlineEdits`（= `inlineSuggest.edits.enabled`，**默认 true**）区分 → **不需要监听编辑后主动 `editor.trigger`**。
- 公开类型已暴露 `context.includeInlineEdits`、`InlineCompletion.isInlineEdit` / `showInlineEditMenu`；range 可指向光标外任意行。**但 `IInlineSuggestOptions` 不含 `edits` 字段**——若哪天需要显式开 `inlineSuggest.edits.enabled` 要 cast（默认既为 true，目前不设）。
- controller id：`editor.contrib.inlineCompletionsController`。可订阅的 model observable（controller 自身就这样 bind scoped context key）：`model.inlineEditState`（undefined = 非 inline-edit 态）、`inlineEditState.cursorAtInlineEdit`、`model.tabShouldJumpToInlineEdit`、`model.tabShouldAcceptInlineEdit`。
- Monaco scoped raw context key 名：`inlineEditIsVisible`、`cursorAtInlineEdit`、`tabShouldJumpToInlineEdit`、`tabShouldAcceptInlineEdit`（**全局看不到，必须镜像**）。
- standalone 已注册命令：`editor.action.inlineSuggest.jump`(Tab,201) / `...commit`(Tab,200) / `...hide`(Esc)。
- `inlineEditState.inlineEdit.edit.text` 可读出当前 inline edit 的替换文本（probe 用；注意 model 会做 `singleTextRemoveCommonPrefix`，文本可能被去掉公共前缀）。
- **多处编辑（重命名一次改完）= 一个大 range + 完整新文本，不是多 item / 不是 `additionalTextEdits`**（已源码核实）。`InlineEditItem`（`isInlineEdit:true` 路径）把 `additionalTextEdits` 硬编码为 `[]`（`inlineSuggestionItem.js:263`），那条路禁用。真正机制：`InlineEditItem.create`（L241）→ `getStringEdit`（L313）用 `linesDiffComputers` 行/子词 diff 把单个 `(range, insertText)` **自动拆成多个细粒度变更点**渲染、Tab 一次全应用。我们因此把多处离散编辑用 `composeNesEdits` 合并成「跨首末的单 range + 重建的完整文本（中间未改行原样保留）」，剩下的拆分交 Monaco。

## 生成层

### 编辑历史跟踪 `RecentEditsTracker`
`services/ai/RecentEditsTracker.ts`（`IRecentEditsTracker`）

NES 的预测信号。**不直接订阅 Monaco**（保持 node 可测）——只暴露纯数据入口 `record(uri, changes)`，由 `FileEditor.tsx` 已有的 `model.onDidChangeContent` 回调喂入。
- 每 uri 一个 **ring buffer**（上限 `ai.nes.recentEditsCount` 默认 10），按文件隔离。
- 记录单元只存增量 `{ lineNumber, inserted, deletedLength, at }`（`onDidChangeContent` 无旧文本，用 `rangeLength` 作 `deletedLength`）。
- **同行 + 2s 窗内** coalesce 合并，避免逐字符塞满 buffer。
- `getRecentEdits(uri)` 最旧在前；`clear(uri)` 在接口里但 **FileEditor 当前不调用**（ring buffer 自滚动；切 tab 误清的代价大于收益）。
- DI：`main.tsx` 里 **必须在 `InlineCompletionService` 之前** `createInstance` 并 `services.set`（service 注入它）。

### 结构化输出解析 `nesEditParser`
`services/ai/nesEditParser.ts`（`parseNesEdits` + `composeNesEdits`，纯函数，类比 `sanitizeCompletion`）

模型协议：**多处编辑数组** `{ "edits": [ {startLine,endLine,newText}, … ] }`，每条语义为**整行替换** `[startLine,endLine]`（1-based 闭区间，**忽略列号**以规避模型列号不可靠）。无修改回 `{ "noEdit": true }`。
- `parseNesEdits(raw, lineCount)`：`stripCodeFence` → `extractFirstJsonValue`（首个平衡 `{}` **或** `[]`，跳过字符串内括号防 newText 截断）→ `JSON.parse` → 归一为列表（兼容三形态：`{edits:[…]}` 首选 / 顶层裸数组 / 单对象裹成一元，`noEdit`/空数组→null）→ 逐条校验（`newText` 是 string、行号是整数、`1<=startLine<=endLine<=lineCount`）→ **排序 + 校验互不重叠**（重叠→null）。**任何失败/越界/重叠一律 null（不出建议）**。
- `composeNesEdits(edits, getLineContent)`：把已排序非重叠的多处编辑合并成单个跨度 `{startLine:spanStart, endLine:spanEnd, newText}`——逐条按序，edit 前未改的行用 `getLineContent` 原样保留、推入 `edit.newText`、跳到 `endLine+1`，末尾补齐到 spanEnd。service 用合并结果构造**单个** inline-edit item，多处高亮由 Monaco 内部 diff 拆（见上「Monaco 原生支持」末条）。

### provide() 双模式 + prompt
`services/ai/InlineCompletionService.ts`

- 入口 `provide()`：共享 gate 后 `if (ai.nes.enabled && context.includeInlineEdits) → _provideInlineEdit`，有结果即返回；否则按 `ai.nes.fallbackToCompletion` 决定回退 `_provideGhostText` 还是返回 null。
- `_provideInlineEdit`：防抖 → 取 recent（空且 automatic → null）→ `_buildNesPrompt` → `_sendText` → `parseNesEdits` → `composeNesEdits`（多处合并成单 span）→ 映射 range（`startColumn:1`、`endColumn:model.getLineMaxColumn(spanEnd)`）→ 空 diff 丢弃 → 返回**单个** `isInlineEdit:true` item。
- `_buildNesPrompt`：user message 三段 `<|recent_edits|>`（`L{n}: +{JSON.stringify(inserted)} (-{deletedLength}ch)`）+ `<|cursor_line|>{n}` + `<|document|>`（`_numberedDocument`：每行 `{n}: {内容}`，窗口由 `ai.nes.includeFullDocument` + `ai.nes.contextLines` 控制）。
- `_sendText`：**ghost-text 与 NES 共用**的请求基建（cts/requesting/错误去重）。**purpose 是唯一分叉点**——续写传 `'inline-completion'`、NES 传 `'next-edit-suggestion'`，于是两种模式在 AI Debug 面板里能各自归类（见 [ai-debug-subsystem-context] 的 purpose 穿透表）。
- **成本**：NES 与续写在单次 provide 内**串行**，仅 NES 无产出且允许回退才发第二请求——开 NES 不会无脑双倍。
- system prompt：`DEFAULT_NES_SYSTEM_PROMPT`（`services/ai/defaultSystemPrompts.ts`）。**目前不可经 aiSettings.json 覆盖**——`AiPromptKind` 是固定联合（`'commit'|'inlineCompletion'|'sessionTitle'`），加 `nes` 会牵动 platform + 设置 UI，故 NES 直接用内置常量。要做成可配：往 `AiPromptKind` 加 `'nes'` + `_provideInlineEdit` 改用 `getSystemPrompt('nes')`。

## 集成层（context key 镜像 + Tab 仲裁）

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

## 配置项（7 个，全 `ai.nes.*`）

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

## 常见任务 → 改哪里

- **改 NES 提示 / 输出协议**：`_buildNesPrompt` / `DEFAULT_NES_SYSTEM_PROMPT` + `nesEditParser.parseNesEdits`/`composeNesEdits`（配套 `__tests__/nesEditParser.test.ts`）。改协议要同步改 system prompt 里描述的格式与解析器。
- **改「攒哪些编辑历史 / 怎么 coalesce / 留几条」**：`RecentEditsTracker`（配套 `__tests__/RecentEditsTracker.test.ts`）。
- **新增「什么时候不出 NES」的条件**：`_provideInlineEdit` 的 gate 段（recent 空、空 diff 等）。
- **inline edit 出来了但 Tab 不跳/不接受**：集成层——确认 `bridgeInlineEditState` 有把全局四个 key 置对、`JumpToNextInlineEditAction` 与 commit 的 when 互斥且权重 >400、`!suggestWidgetVisible` 等子句成立。逐步诊断走 [fix-keybinding-not-firing]。
- **根本不渲染 inline edit**：先用 e2e probe `installFakeInlineEdit(s,e,'X')` 隔离 AI 层——能渲染说明问题在生成层（gate/历史/parse/sendRequest）；仍不渲染说明 provider 没返回 `isInlineEdit:true`、或 `context.includeInlineEdits` 为 false（`inlineSuggest.edits.enabled` 被关）、或 Monaco 集成断了。
- **加配置项**：schema + service 里读它（见上「改两处」）。
- **改 NES 快捷键 / when**：`inlineCompletionActions.ts` 的 `JumpToNextInlineEditAction` / `CommitInlineCompletionAction`。

## 易踩坑速记

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

## 验证

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

## 关键参考路径

生成层：
- `apps/editor/src/renderer/services/ai/RecentEditsTracker.ts` —— 编辑历史 ring buffer（+ `__tests__/RecentEditsTracker.test.ts`）
- `apps/editor/src/renderer/services/ai/nesEditParser.ts` —— 结构化编辑解析（+ `__tests__/nesEditParser.test.ts`）
- `apps/editor/src/renderer/services/ai/InlineCompletionService.ts` —— `provide()` 双模式 / `_provideInlineEdit` / `_buildNesPrompt` / `_numberedDocument` / `_sendText`（+ `__tests__/InlineCompletionService.test.ts` 的 NES describe）
- `apps/editor/src/renderer/services/ai/defaultSystemPrompts.ts` —— `DEFAULT_NES_SYSTEM_PROMPT`

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

相关 skill：[inline-completion-subsystem-context]（底层 ghost-text 续写）、[fix-keybinding-not-firing]（Tab 抢不到/快捷键不触发的诊断与权重仲裁）、[ai-debug-subsystem-context]（NES 调用以 purpose `next-edit-suggestion` 被记录/可离线回放）。
