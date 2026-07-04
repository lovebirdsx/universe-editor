# ACP 输入框 Monaco 化 + `@`/`#` by-range 药丸引用 实施计划

> 撰写日期：2026-07-04
> 范围：把 ACP 会话输入框（`PromptInput`）从 HTML `textarea` 升级为内嵌 **Monaco 编辑器**，
> 引用（`@` 文件提及 + `#` 结构化上下文）统一改成 **VSCode Copilot 式的 by-range 药丸（decoration）机制**：
> 引用作为可编辑文本 token 存在文本流中，用 Monaco decoration 染成药丸，按字符区间（range）追踪、
> 随文本编辑自动平移、手改药丸文本即整体失效；提交时直接读追踪的引用列表产出结构化 `ContentBlock`，
> **不再靠对文本做分词/by-name 匹配**。
> 已与需求方确认：**采用内嵌 Monaco 路线；`@` 与 `#` 统一成同一套 by-range 药丸机制**。

---

## 0. 为什么要做这件事（根因）

现状 `#` 引用直接照抄了 `@` mention 的 **by-name（按 label 名字匹配）** 管线：选中项后往 `textarea` 里
插入 `#<label>` 文本，提交时 `composePromptBlocks`（`promptMentions.ts:128`）**按空白切 token**，
再用 `byLabel.has(token)` 匹配已记录的引用。

这套机制成立的**隐含前提**是「label 是无空格的单 token」——文件相对路径通常满足，所以 `@` 勉强能用。
但 `#` 引用的 label **天然含空格**（符号名 `foo bar`、Markdown 标题 `# hello`、文档条目 `Editor User Guide`），
于是出现两个必然故障：

1. **双 `#`**：Markdown 标题符号的 `name` 本身带 `#`，`applyMentionPick(..., '#')` 再拼一个 `#` → `## hello`
   （`PromptInput.tsx:741`）。
2. **上下文静默丢失（致命）**：只要 label 含空格，提交时 walk 到 `#` 只读到下一个空白即停，`byLabel.has("#")` → false，
   **整个上下文块被丢弃**，退化成纯文本发给 agent（`promptMentions.ts:148-149`）。四类源里符号/文档/含空格路径全部失效。

**这不是转义空格能补好的小 bug**：`textarea` 是纯文本控件，既渲染不出药丸、也无法按 range 稳定追踪引用。
VSCode Copilot 的解法（经源码核实）是：输入框用 **Monaco 编辑器**，引用按 **decoration range** 追踪，
含空格天然安全，提交时读 range 列表而非分词。本计划即对标该机制。

### VSCode Copilot 机制要点（核实结论，供实现参照）

- 输入框 = 内嵌 Monaco（VSCode 用 `CodeEditorWidget`，本项目用 standalone `monaco.editor.create`，等价可用）。
- 引用插入带前缀纯文本 token（`#file:a.ts`、`#sym:foo bar`），**可含空格**。
- 药丸 = Monaco decoration 染色（前景色 + 背景色 + `borderRadius:3px` + `stickiness:NeverGrowsWhenTypingAtEdges`），
  底下仍是可编辑文本。
- 追踪 by-range：`onDidChangeModelContent` 里回读 decoration 迁移后的 range；range 内文本 ≠ 原快照 → 整段删除该引用。
- 提交序列化：读追踪的引用列表（带 URI/Location/range），按位置命中产出结构化块，**不分词**。
- 「上方 chips」与「内联引用」是两套独立模型（本项目沿用此分工：选区/图片走 chips，`@`/`#` 走内联药丁）。

---

## 1. 关键坐标（现有代码）

- 输入框主体：`apps/editor/src/renderer/workbench/agents/PromptInput.tsx`（1349 行，含 slash/mention/hash/history 四套 popover + 图片 + 拖拽 + 草稿）
- `@` 纯函数：`apps/editor/src/renderer/services/acp/promptMentions.ts`（`extractMentionQuery`/`applyMentionPick`/`composePromptBlocks`/`detectFilePickerTrigger`）
- `#` 纯函数：`apps/editor/src/renderer/services/acp/promptContextRef.ts`（`extractHashQuery`/`mergeRef`/`composeContextRefBlock`）
- `#` 数据源：`apps/editor/src/renderer/services/acp/contextSuggestions.ts`（四类 provider + `contextSuggestionItemToRef`）
- popover UI：`MentionPopover.tsx` / `ContextPopover.tsx` / `SlashCommandPopover.tsx` / `PromptHistoryPopover.tsx`
- chips（保留不动）：`SelectionContextChips.tsx` / `PromptImageChips.tsx`
- 草稿持久化：`apps/editor/src/renderer/services/acp/acpPromptDraftCache.ts`（`AcpPromptDraft` 结构）
- 发送链路：`apps/editor/src/renderer/services/acp/acpSession.ts`（`sendPrompt` L498、`_dispatchPrompt` L551、`composePromptBlocks` L564）
- 键盘路由：`WidgetHandle`（`ChatBody.tsx:84`）+ 全局命令 `agentTimelineActions.ts:334-410`（gated on `acpPromptPopupVisible`）+ `acpChatWidgetService.ts`
- **Monaco 挂载最佳范例**：`apps/editor/src/renderer/workbench/panel/output/LogOutputView.tsx:47-90`（单 model、自建自 dispose、`disposed` 守卫、`editContext:true`）
- Monaco 加载器：`apps/editor/src/renderer/workbench/editor/monaco/MonacoLoader.ts`（`ensureInitialized()` → ns；`getOverrideServices()` 必传）
- decoration 范例：`inlineConflictController.ts:44/108`（`createDecorationsCollection()` + `.set([...])` + `inlineClassName`）
- 测试 stub：`apps/editor/test-stubs/monaco-editor.ts`（renderer-dom 下 alias monaco，需扩方法）；vitest 分层见 `apps/editor/vitest.config.ts:37-48`

---

## 2. 目标架构

### 2.1 统一引用模型 `PromptRef`

现有 `PromptMention`（@，`{uri,name}`）与 `PromptContextRef`（#，`{kind,label,uri,meta}`）**合并**为一个统一模型，
所有引用都带 range，都能渲染药丸、都按 range 追踪：

```ts
// 新：apps/editor/src/renderer/services/acp/promptRef.ts
export type PromptRefKind = 'file' | 'folder' | 'symbol' | 'scmChange' | 'openEditor' | 'docs'

export interface PromptRef {
  readonly id: string                 // 稳定 id（generateUuid），追踪 decoration 用
  readonly kind: PromptRefKind
  /** 药丸内显示的文本（含前缀，如 `@src/a.ts` / `#foo bar`）。也是插入文本流的内容。 */
  readonly display: string
  readonly uri: string
  readonly meta?: {                    // 合并原 PromptContextRef.meta
    readonly line?: number
    readonly column?: number
    readonly symbolKind?: number
    readonly scmStatus?: string
    readonly description?: string
  }
}
```

> `@` = kind `file`/`folder`；`#` = 其余四类。前缀（`@`/`#`）并入 `display`，序列化时按 kind 决定 block 形状（见 §2.4）。

### 2.2 追踪层 `PromptRefTracker`（新，纯逻辑 + monaco 句柄）

对标 VSCode 的 `ChatDynamicVariableModel`。挂在 Monaco editor/model 上，职责：

- `add(ref, range)`：把引用登记进列表，在 model 上建一个 decoration（`inlineClassName` 药丸 + `NeverGrowsWhenTypingAtEdges`），
  记 `decorationId` + 当时 range 内文本快照。
- 订阅 `model.onDidChangeModelContent`：遍历引用，用 `decorationsCollection.getRange(idx)`（或 `model.getDecorationRange(id)`）
  回读迁移后的 range：
  - decoration 没了 → 移除该引用；
  - range 内文本 ≠ 快照（用户手改了药丸内部）→ `model.applyEdits` 把整段删掉 + 移除引用；
  - range 变了但文本一致 → 更新引用 range（跟随平移）。
- `list()`：返回当前存活引用（供提交序列化 + 草稿持久化）。
- `dispose()`：清 decoration + 退订。

**range 追踪由 Monaco decoration 负责平移，含空格天然安全**——这是整套方案的地基。

### 2.3 数据流

```
用户键入 @query / #query
  → onDidChangeModelContent → 取 model 全文 + 光标 offset
  → extractActiveToken(text, caret)  （统一版，识别 @ 或 #，返回 {prefix, query, range}）
  → 拉取候选（@ 走 mentionFileSearch；# 走 contextSuggestions 四 provider）
  → 药丸 popover（沿用现有 ContextPopover/MentionPopover，改为定位到 Monaco 光标坐标）
  → 选中 → tracker.add(ref, tokenRange) + model.applyEdits 替换 token 为 display 文本 + 建药丸 decoration
提交
  → tracker.list() + model.getValue()
  → composePromptBlocksFromRefs(text, refs)   （按 ref.range 切文本 + 产出 block，不分词）
  → session.sendPrompt(text, refs, selectionContexts, images)
  → _dispatchPrompt → composeContextRefBlock 按 kind 映射（symbol→resource_link+_meta、file→resource_link…）
```

### 2.4 序列化（保持现有决策表，仅换驱动方式）

`composePromptBlocks` 从「walk 文本分词」改为「遍历 refs 按 range 切片」：

- 文本按每个 ref 的 `[range.start, range.end)` 切成 `text | block | text | block | …`。
- 每个 block 由 `composeContextRefBlock(ref)` 按 kind 产出（沿用 `promptContextRef.ts:85` 现有映射，扩 `file`/`folder`→`resource_link {uri,name}`）。
- 选区（`SelectionContext`）与图片继续独立走 chips → `composeContextBlocks`/`composeImageBlocks`（不变）。

> 由于 range 精确，不再有「未记录 token 留作纯文本」的歧义——文本里的字面 `@x`/`#x` 若不在 refs 列表就是纯文本，天然正确。

---

## 3. 分阶段实施

### 阶段 0 · 纯逻辑层（无 UI，单测锁定）

**目标**：统一引用模型 + 纯函数，先用 renderer-node 单测锁死，不接 Monaco。

- [ ] 0.1 新增 `promptRef.ts`：`PromptRef`/`PromptRefKind` 类型；`extractActiveToken(text, caret)`（合并 `extractMentionQuery`+`extractHashQuery`，返回 `{prefix:'@'|'#', query, startIndex, endIndex}`）。
- [ ] 0.2 `composePromptBlocksFromRefs(text, refs)`：按 range 切片产出 `ContentBlock[]`（替代旧 `composePromptBlocks` 的分词逻辑）；`composeContextRefBlock` 扩 `file`/`folder` 分支。
- [ ] 0.3 迁移映射：`contextSuggestionItemToRef` / `mentionEntryToRef` 归一到 `PromptRef`（`display` 带前缀）。
- [ ] 0.4 单测：`extractActiveToken`（@/#、词中/行首/空格后/越界）、`composePromptBlocksFromRefs`（多 ref 混排、range 切片、各 kind 映射、含空格 display）。

**验证**：`pnpm check`（仅错误）。行为零变化（未接 UI）。

### 阶段 1 · Monaco 输入框骨架（替换 textarea，无引用/无 popover）

**目标**：`PromptInput` 用 Monaco 渲染，纯文本输入/提交/中文 IME/草稿/自增高可用；popover 与引用暂缺。

- [ ] 1.1 新增 `PromptEditor.tsx`（或直接改造 `PromptInput`）：参照 `LogOutputView.tsx` 挂载 standalone editor：
  - `MonacoLoader.ensureInitialized()` + `disposed` 守卫 + `getOverrideServices()`。
  - options：`editContext:true`（**必须**，中文 IME）、`automaticLayout:true`、单行/多行自增（`wordWrap:'on'`、隐藏行号/minimap/glyph/folding、`renderLineHighlight:'none'`、`scrollBeyondLastLine:false`），字体走 `getEditorTypographyOptions`（对齐 FileEditor）。
  - **自建 model 必须自 dispose**（LogOutputView 模式，非 FileEditor 的共享 model）。
  - 高度自增：监听 `onDidContentSizeChange` → 设容器高度（min 3 行、max N 行后内部滚动）；替代旧 textarea 的 native field-sizing。
- [ ] 1.2 提交：Enter 提交、Shift+Enter 换行——用 `editor.addCommand(monaco.KeyCode.Enter, …)` 或 `onKeyDown` 拦截；popover 打开时 Enter 让位给接受命令（见阶段 4）。
- [ ] 1.3 焦点：`WidgetHandle.focus()` → `editor.focus()`；session 切换/autoFocus 逻辑迁移。
- [ ] 1.4 草稿：`AcpPromptDraft` 的 text/caret 读写改为 model.getValue/getPosition；`refs` 字段见阶段 3。
- [ ] 1.5 图片粘贴/拖拽：Monaco 有自己的 paste/drop 处理，需在 editor DOM 节点上挂 `onPaste`/`onDrop`（或用 `CopyPasteController`/`DropIntoEditorController` 已挂的 contribution 钩子），复用现有 `acceptImageFiles`/`acceptImageUris`/`onPromptDrop` 逻辑。**这是本阶段最大风险点**，需实测 Monaco 事件与现有 handler 的衔接。
- [ ] 1.6 测试 stub：扩 `test-stubs/monaco-editor.ts` 补 `createDecorationsCollection`/`onDidChangeModelContent`/`onDidContentSizeChange`/`getValue`/`setValue`/`getPosition`/`setPosition`/`getContainerDomNode`/`focus`/`addCommand`/`applyEdits` 等新输入框用到的方法。

**验证**：`pnpm check`；`pnpm e2e`（输入框冒烟，仅错误）。此阶段引用能力缺失，但纯文本收发/中文输入/图片必须回归通过。

### 阶段 2 · by-range 药丸引用（`PromptRefTracker` + decoration）

**目标**：引用能作为药丸插入、追踪、编辑失效；提交产出正确 block。

- [ ] 2.1 新增 `promptRefTracker.ts`（`PromptRefTracker` 类，见 §2.2）：`add`/`onDidChangeModelContent` 回读 range/`list`/`dispose`。
- [ ] 2.2 药丸 CSS：`agents.module.css` 加药丸类（背景/前景/圆角/padding），对齐主题色（复用 chat/badge 色板）；decoration `inlineClassName` 指向它。
- [ ] 2.3 接受引用：popover 选中 → `applyEdits` 把 active token range 替换成 `ref.display` + `tracker.add(ref, newRange)`。
- [ ] 2.4 提交：`tracker.list()` + `model.getValue()` → `composePromptBlocksFromRefs`；`sendPrompt` 形参从 `mentions/contextRefs` 收敛为单一 `refs: PromptRef[]`（同步改 `acpSession.ts` `sendPrompt`/`_dispatchPrompt`/`AcpSessionConnection.enqueue`/`QueuedPrompt`）。
- [ ] 2.5 单测：tracker 的 range 平移 / 编辑失效 / 删除（用扩后的 monaco stub 或抽纯逻辑测）。

**验证**：`pnpm check`；手动键 `#`/`@` 选项 → 药丸渲染、改字失效、提交带结构化块（在 `_dispatchPrompt` 加调试输出核对最终 `prompt`）。

### 阶段 3 · popover 接线 + 键盘导航 + 草稿

**目标**：四套 popover（slash/mention/hash/history）在 Monaco 上复位，键盘链路与 `acpPromptPopupVisible` 对齐。

- [ ] 3.1 token 探测：`onDidChangeModelContent`/`onDidChangeCursorPosition` → 计算 caret offset → `extractActiveToken` / `extractSlashQuery` → 驱动 popover 开关（优先级 slash > @/# > history 不变）。
- [ ] 3.2 popover 定位：从「textarea 上方固定」改为 Monaco 光标屏幕坐标（`editor.getScrolledVisiblePosition(position)` 换算），或维持贴输入框上沿的简化定位（先取简单者）。
- [ ] 3.3 `WidgetHandle` 四方法（`popoverSelectNext/Prev/Accept/Hide`）+ `popoverStateRef` 逻辑迁移（大体照搬，数据源换成 Monaco 读取）。
- [ ] 3.4 `@@`/`@#` 文件夹/文件选择器触发（`detectFilePickerTrigger`）在 Monaco `onDidChangeModelContent` 中复现；选择后走 `tracker.add` 药丸化（不再是纯文本 `@name`）。
- [ ] 3.5 草稿：`AcpPromptDraft` 增 `refs: PromptRef[]`（替代 `mentions`+`contextRefs`）；save/restore 时重建药丸 decoration（restore 后需按 refs 的 range 重新 `tracker.add`）。
- [ ] 3.6 `onPopoverOpenChange` → `acpPromptPopupVisible` 上报不变。

**验证**：`pnpm check`；`pnpm e2e`。

### 阶段 4 · 测试重写 + 文档 + 收尾

- [ ] 4.1 `PromptInput.test.tsx` 重写：现有 68+ 用例全部基于 `fireEvent.change(textarea)`，Monaco 化后失效。策略：
  - **逻辑纯函数**（token 解析/切片/tracker range）→ renderer-node 单测（已在阶段 0/2）。
  - **UI 冒烟** → 用扩后的 monaco stub 暴露 model 句柄，驱动 `onDidChangeModelContent` 断言 popover/接受/提交。
  - 保留可迁移的断言（提交 payload、popover 互斥、slash 优先、草稿隔离）。
- [ ] 4.2 `contextSuggestions.test.ts` / `promptContextRef.test.ts`（现名可能改为 `promptRef.test.ts`）随类型合并调整。
- [ ] 4.3 `@p1` E2E（可选）：键 `#`、选符号、发送、断言 timeline 用户消息携带引用 + 药丸渲染。
- [ ] 4.4 用户文档：`docs/user/zh-CN/ai-agent/first-session.md` 的 `#`/`@` 说明按新交互（药丸）同步；`pnpm docs:check` 通过。
- [ ] 4.5 i18n：新增文案走 `localize`；`en-US.ts` 仅收需覆盖项。
- [ ] 4.6 清理：删除 `promptMentions.ts`/`promptContextRef.ts` 中被 `promptRef.ts` 取代的旧逻辑（by-name walk / `applyMentionPick` 文本拼接 / `mergeMention`/`mergeRef`）。

**验证**：`pnpm check`（全绿）+ `pnpm e2e`（仅错误）+ `pnpm docs:check`。

---

## 4. 建议里程碑

```
M0 逻辑层     → 阶段 0（统一模型 + 纯函数 + 单测，零行为变化）
M1 编辑器骨架 → 阶段 1（Monaco 替换 textarea，纯文本/IME/图片/草稿回归）★最大风险，先打通
M2 药丸引用   → 阶段 2（tracker + decoration + 序列化）
M3 交互复位   → 阶段 3（popover/键盘/草稿）+ 阶段 4（测试/文档）
```

**M1 是成败关键**：Monaco 替换 textarea 会牵动焦点、IME、图片粘贴/拖拽、自增高、E2E 探针。先只做纯文本骨架并让现有收发/IME/图片 E2E 回归通过，再叠引用，避免混淆回归来源。

---

## 5. 风险与注意

- **单测大面积重写**：`PromptInput.test.tsx` 全部依赖 textarea `fireEvent`，Monaco 化后需换驱动方式（stub 句柄 + 逻辑纯函数化）。这是本计划最大的一次性成本，务必先扩 `test-stubs/monaco-editor.ts`。
- **中文 IME**：`editContext:true` 必设（记忆 [[monaco-055-editcontext-nls]]），否则组合输入行加粗——上线前务必人工验中文输入。
- **图片粘贴/拖拽**：Monaco 自带 paste/drop 处理，需确认现有 `acceptImageFiles`/`onPromptDrop` 能在 editor DOM 上正确接管（阻止 Monaco 默认粘贴文本 / 编辑器组打开文件），是 M1 的实测重点。
- **E2E 探针**：现有输入框 E2E 通过 `data-testid="acp-prompt-input"`（textarea）交互；Monaco 无同名 textarea，需给容器补探针或改用 `window.__E2E__` 服务注入文本（记忆 [[e2e-async-session-prompt-not-settled]]）。
- **药丸 range 边界**：`stickiness: NeverGrowsWhenTypingAtEdges` 必设，否则药丸边缘打字会吞进引用范围。
- **disposable 生命周期**：editor / model / decorationsCollection / 所有 `onDid*` 订阅务必在 cleanup 全 dispose（`disposed` 守卫 + LogOutputView 模式），否则 e2e 泄漏红（记忆 [[reload-disposable-leak-marksingleton]]、[[opener-service-deeplink-feature]]）。
- **性能/懒加载**：Monaco 是重资源，`ensureInitialized()` 已懒加载；输入框首次挂载即需 editor（不像 `#` 那样可延后），确认对 ChatPanel 首开耗时影响可接受（必要时保留骨架占位）。
- **`@`/`#` 统一后的兼容**：`AcpPromptDraft` 的 `mentions`/`contextRefs` 合并为 `refs`——项目开发期不需向后兼容，直接改；但 draft 是内存态，改类型即可。
- **exactOptionalPropertyTypes**：`PromptRef.meta` 及其字段为可选，构造时按现有 `...(x !== undefined ? {x} : {})` 套路（见 `contextSuggestions.ts:324`）避免 `undefined` 显式赋值报错。

---

## 6. 验证命令

```bash
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 输入框交互链路冒烟，仅截错误（重点：收发/中文IME/图片/引用）
pnpm docs:check   # 用户文档死链校验
```

---

## 7. 相关记忆

- [[monaco-055-editcontext-nls]]（EditContext 修中文 IME；0.55 NLS 索引制）
- [[acp-prompt-image-feature]]（图片三入口 + chips 范式，M1 需保住）
- [[reload-disposable-leak-marksingleton]] / [[opener-service-deeplink-feature]]（disposable 泄漏红线）
- [[e2e-async-session-prompt-not-settled]]（ACP 输入框 E2E 断言前需 poll 到位）
- [[editor-text-focus-stuck-swallows-keys]]（Monaco blur/focus contextKey 与全局键盘守卫的坑）
- 旧计划（本计划取代其 by-name 部分）：`docs/plan/prompt-hash-context-references-plan.md`
```
