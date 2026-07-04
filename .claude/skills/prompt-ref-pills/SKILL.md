---
name: prompt-ref-pills
description: 制作或修改 ACP 输入框「@/# by-range 药丸引用」相关功能时召回——@ 文件提及 + # 结构化上下文（工作区符号/Git修改/打开编辑器+选区/文档）统一成 VSCode Copilot 式的、按字符区间（Monaco decoration）追踪的可编辑药丸；提交时读追踪的 range 列表产出 ContentBlock，不分词。当任务涉及 apps/editor/src/renderer/services/acp/{promptRef,promptRefTracker,promptMentions,promptContextRef,contextSuggestions}.ts 或 workbench/agents/{PromptMonacoEditor,PromptInput,ContextPopover,MentionPopover}.tsx，需要新增引用类型（kind）、改药丸渲染/追踪/失效、改发给 agent 的引用序列化、加 popover 数据源、排查「引用发给 agent 后退化成整文件 / 药丸被误删 / 药丸渲染异常」时使用。给出五文件分层地图、加一个新 kind 的清单、序列化的协议边界红线、三条易踩坑。区别于 acp-session-subsystem-context（会话全局导航）：本 skill 只管输入框的引用子系统。
disable-model-invocation: true
---

# ACP 输入框 @/# by-range 药丸引用系统

把用户在输入框里的 `@文件` / `#符号|Git改动|打开的编辑器|文档` 引用，做成 **VSCode Copilot 式的药丸**：引用是文本流里一段**可编辑文本 token**（`@src/a.ts` / `#foo bar`），用 Monaco decoration 染成药丸，**按字符区间（range）追踪**——Monaco 自动随编辑平移 range，含空格的 label 天然安全；提交时读追踪的 range 列表切片产出 `ContentBlock`，**绝不对文本分词/by-name 匹配**（旧机制的致命缺陷，已删）。

> ⚠️ **第一原则**：引用不是 React state，**真身活在 Monaco 上**——文本在 model 里、range 在 decoration 里、追踪表在 `PromptRefTracker` 里。`PromptInput` 只通过 `PromptEditorHandle`（`insertRef/listRefs/restoreRefs/clearRefs`）操作它们，不再持有 `mentions`/`contextRefs` 数组。改任何引用行为前先认清落在哪一层。

## 五文件分层地图

| 文件 | 层 | 职责 |
|---|---|---|
| `services/acp/promptRef.ts` | 纯逻辑（模型 + 序列化） | `PromptRef{id,kind,label,uri,meta?}` + `PlacedRef{ref,start,end}`；`extractActiveToken`（识别 @/# token）、`refDisplay`（`@`/`#` 前缀并入显示文本）、`composeRefBlock`（**一个 ref → 一个 wire block**，按 kind）、`composePromptBlocksFromRefs`（按 range 切片交织 text/block）、`suggestionItemToRef`/`mentionEntryToRef`（popover item → PromptRef） |
| `services/acp/promptRefTracker.ts` | 追踪（纯逻辑 + monaco 句柄） | `PromptRefTracker` 挂 model：`insert`（applyEdits 换文本 + 建 decoration + 存 snapshot）/`restore`（草稿恢复，只建 decoration 不改文本）/`list`（回读 decoration range → PlacedRef）/`reconcile`（range 内文本≠snapshot 则删该引用 + 清残余）/`clear`/`dispose` |
| `workbench/agents/PromptMonacoEditor.tsx` | 编辑器句柄 | 内嵌 standalone Monaco，暴露 `PromptEditorHandle`；`insertRef` 调 tracker + 追加尾随空格；`onChange(text,caret,source)` 用 `runProgrammatic` 计数器分 `'user'|'program'` |
| `workbench/agents/PromptInput.tsx` | UI 编排 | `acceptMention`/`acceptContextRef`/`openFilePicker`/`onPromptDrop` → `editorHandleRef.insertRef(...)`；提交读 `listRefs()` → `session.sendPrompt(text, refs, ...)` |
| `services/acp/contextSuggestions.ts` | `#` 数据源 | 四个 provider（`WorkspaceSymbol`/`ScmChange`/`OpenEditor`/`Docs`）headless `query()` → `ContextSuggestionItem[]`；`toItem` 把 line/column 塞进 `meta` |

> `promptMentions.ts`（`extractMentionQuery`/`detectFilePickerTrigger`）与 `promptContextRef.ts`（`extractHashQuery` + `PromptContextRefKind`）只剩 **token 探测**；旧 by-name 序列化（applyMentionPick/composePromptBlocks/mergeRef/composeContextRefBlock/PromptMention/PromptContextRef）**已全删，别复活**。

## 数据流（一次引用的生命）

```
键入 @q / #q → onChange(source:'user') → extractActiveToken → popover 拉候选
选中 → acceptXxx → handle.insertRef(ref, tokenStart, tokenEnd)
        → tracker.insert：applyEdits 换 token 为 refDisplay(ref)（如 "#foo bar"）
        → 建 decoration（inlineClassName:acp-prompt-ref-pill + NeverGrowsWhenTypingAtEdges）
        → 存 snapshot = display；追加尾随空格（不带 forceMoveMarkers！见坑②）
用户编辑 → onChange(source:'user') → tracker.reconcile()：range 内文本漂移出 snapshot → 删引用
提交 → handle.listRefs() → composePromptBlocksFromRefs(text, refs)
        → 按 ref.range 切文本，每个 ref 走 composeRefBlock（按 kind 产 block）
        → session.sendPrompt(text, refs, contexts, images) → _dispatchPrompt 发出
```

## 加一个新引用 kind 的清单

1. `promptRef.ts`：`PromptRefKind` 加 kind；`PREFIX_BY_KIND` 定 `@` 或 `#`；`composeRefBlock` 加 case（**先读下面「序列化红线」**）；`suggestionItemToRef` 加 case（若走 `#` popover）。
2. `contextSuggestions.ts`（若 `#` 类）：加 provider class（构造走 DI 装饰器）+ `ContextSuggestionItem.kind` 覆盖；`promptContextRef.ts` 的 `PromptContextRefKind` 补类型。
3. `PromptInput.tsx`：`ensureContextProviders` 注册 provider；`hashGroups` 加分组。
4. `ContextPopover.tsx`：分组渲染（若需新样式）。
5. i18n：`acp.contextRef.group.<kind>` 等键**只补 `zh-CN.ts`**（`localize()` 自带英文 default，`en-US.ts` 只收需覆盖项）。
6. 测试：`promptRef.test.ts` 加 `composeRefBlock` 该 kind 断言；provider 测试复用 `PromptInput.test.tsx` 里现成的 DI stub（stubLanguageFeatures/stubUriIdentity/…）。

## 序列化红线：resource_link 的 name/description/_meta 会被 agent 丢弃

**内置 agent 的 prompt→模型转换只读 uri，几乎不读别的字段**：
- claude-agent-acp fork `acp-agent.ts` `promptToClaude`：`resource_link` → `formatUriAsLink(uri)`，**连 name 都丢**。
- codex-acp `CodexAcpClient.ts` `buildPromptItems`：`formatUriAsLink(name, uri)`，用 name 但**丢 description + _meta**。

⇒ 任何**需要 agent 精确消费的结构化位置信息（行/列/符号名）绝不能塞进 resource_link 的 name/description/_meta——只能进 `text` 块正文**。这是本仓库真实 bug 的根因（`#Student` 发过去退化成读整个 hello.ts，因为 line 全在被丢弃的 `_meta.symbol` 里）。修法：符号类 `composeRefBlock` 产 `text` 块，把 ``（`Student` (hello.ts:12:5)）`` 写进正文（`_meta.symbol` 可留作未来 agent 用，但当前逻辑不能依赖它）。指整文件的 kind（file/folder/openEditor）无所谓，仍用 resource_link。见记忆 [[prompt-hash-context-references-feature]]。

诊断辅助：`acpSession.ts` 的 `_dispatchPrompt` 有 `console.debug('[acp-prompt] dispatch', ...)` 打印发出块形状，复现时在 devtools 直接核对。

## 易踩坑

- **① 药丸贴边**：Monaco 文本贴容器边框——`.promptEditorHost`（agents.module.css）须给 `padding: 0 6px`。药丸自身样式是**全局类** `:global(.acp-prompt-ref-pill)`（Monaco 把 decoration span 渲染在 CSS-module 作用域外）。
- **② 尾随空格误删药丸（forceMoveMarkers 覆盖 stickiness）**：`insertRef` 在药丸后补空格时，若那次 `applyEdits` 带 `forceMoveMarkers: true`，会**覆盖** decoration 的 `NeverGrowsWhenTypingAtEdges`，把空格吞进追踪 range → range 文本变 `#test.md ` ≠ snapshot `#test.md` → 下次按键 `reconcile()` 误判"药丸被改"删掉整个引用。**补空格的 applyEdits 绝不能带 forceMoveMarkers**，让空格落在 range 之外。
- **③ programmatic vs user 变更源**：非受控 Monaco 每次 `setValue`/`applyEdits`（历史导航、接受候选、草稿恢复、tracker 自己的 insert/restore）都 fire `onDidChangeModelContent`。`PromptEditorHandle` 命令式方法用 `runProgrammatic` 计数器包裹，`onChange` 带 `source`，`program` 时只 mirror text/caret、**跳过所有用户副作用（reconcile / @@@# 触发 / popover dismiss / history 关闭）**。否则会出现"刚开的弹窗被自己的 setText 关掉""tracker 自插入被自己 reconcile 删掉"。详见记忆 [[prompt-monaco-input-migration]]。

## 测试套路

- 纯逻辑（`promptRef.test.ts`，renderer-node）：`extractActiveToken` / `composeRefBlock` 各 kind / `composePromptBlocksFromRefs` range 切片 + 含空格 label。
- 追踪（`promptRefTracker.test.tsx`，renderer-dom）：`monaco-editor` alias 到 `test-stubs/monaco-editor.ts`——该 stub **已模拟 decoration range 迁移 + forceMoveMarkers 语义**（`shiftOffset` 的 `force` 参数 + `applyEdits` 透传 `forceMoveMarkers`）。加"边界打字/追加空格是否保留药丸"这类回归务必确认 stub 忠实模拟了对应标志，否则假绿（坑②当初就是 stub 漏了 forceMoveMarkers）。
- UI（`PromptInput.test.tsx`，renderer-dom）：stub 的 `editor.create` 挂真 `<textarea data-testid="acp-prompt-input">` 桥接假 model；断言提交 payload 读 `sendPrompt` 第 2 参 `refs`（`refs[0].ref` `toMatchObject`）。

## 参考坐标

- 模型/序列化：`promptRef.ts`；追踪：`promptRefTracker.ts`；句柄：`PromptMonacoEditor.tsx`；编排：`PromptInput.tsx`；数据源：`contextSuggestions.ts`
- 计划：`docs/plan/monaco-prompt-input-context-pills-plan.md`
- 记忆：[[prompt-hash-context-references-feature]]（模型 + 序列化红线）、[[prompt-monaco-input-migration]]（Monaco 迁移的坑）、[[monaco-055-editcontext-nls]]（editContext:true 修中文 IME 必设）
- 会话全局上下文（协议/发送链路/双 id）：skill `acp-session-subsystem-context`
