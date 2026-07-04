---
name: prompt-hash-context-references-feature
description: ACP 输入框 @/# 结构化引用——已重构为 Monaco 内嵌编辑器 + by-range 药丸机制
metadata: 
  node_type: memory
  type: project
  originSessionId: cdbc8e83-2043-482d-9bc7-5b45bd11d4da
---

ACP 会话输入框（`PromptInput.tsx`）从 `textarea` 升级为**内嵌 Monaco 编辑器**（`PromptMonacoEditor.tsx`），`@` 文件提及与 `#` 结构化上下文**统一成 VSCode Copilot 式 by-range 药丸**：引用作为可编辑文本 token 存在文本流，用 Monaco decoration（`inlineClassName: acp-prompt-ref-pill` + `NeverGrowsWhenTypingAtEdges`）染成药丸，按字符区间追踪、随编辑自动平移、手改药丸内部即整体失效；提交时读追踪的 range 列表产出 `ContentBlock`，**不再分词/by-name 匹配**。

**Why**：旧版 `#` 照抄 `@` 的 by-name 管线（`composePromptBlocks` 按空白切 token + `byLabel.has()`），隐含前提是「label 无空格」。`#` 引用 label 天然含空格（符号 `foo bar`、文档标题 `Editor User Guide`），导致提交时上下文块被整段静默丢弃，退化成纯文本。`textarea` 纯文本控件既渲染不出药丸也无法按 range 稳定追踪，必须换 Monaco。

**How to apply**：
- 统一模型在 `promptRef.ts`：`PromptRef {id,kind,label,uri,meta?}`（kind: file/folder/symbol/scmChange/openEditor/docs）+ `PlacedRef {ref,start,end}`。核心纯函数：`extractActiveToken`（合并 @/#，返回 prefix+query+range）、`composePromptBlocksFromRefs`（按 range 切片，不分词）、`composeRefBlock`（按 kind 映射 wire block）、`refDisplay`（`@`/`#` 前缀并入显示）、`suggestionItemToRef`/`mentionEntryToRef`。
- 追踪层 `promptRefTracker.ts`：`PromptRefTracker` 挂 model，`insert`/`restore`/`list`/`reconcile`（回读 decoration range，range 内文本≠快照则删引用）/`clear`/`dispose`。
- Monaco 句柄 `PromptEditorHandle`（PromptMonacoEditor.tsx）：`insertRef`/`listRefs`/`restoreRefs`/`clearRefs` + `onChange(text,caret,source)`（`source:'user'|'program'`，靠 `runProgrammatic` 深度计数器区分，程序化 setText 不触发用户侧副作用/reconcile）。`editContext:true` 必设（中文 IME）。
- token 探测仍拆两个文件：`promptMentions.ts`（`extractMentionQuery`/`detectFilePickerTrigger` @@/@#）、`promptContextRef.ts`（`extractHashQuery` + `PromptContextRefKind` 类型给 contextSuggestions 用）——**这两文件里旧的 by-name 序列化(applyMentionPick/composePromptBlocks/mergeRef/composeContextRefBlock/PromptMention/PromptContextRef)已全删**。
- 发送链路收敛为单一 `refs: PlacedRef[]`：`sendPrompt`/`_dispatchPrompt`/`enqueue`/`QueuedPrompt`/`AcpPromptDraft` 都从 mentions+contextRefs 两参数改成一个 refs。
- 四类 provider（`contextSuggestions.ts`）不变；新增第 5 类：加 provider class + `ContextPopover.tsx` 分组 + `promptRef.ts` 的 `composeRefBlock`/`suggestionItemToRef` 补 kind + i18n `acp.contextRef.group.<kind>`。
- 测试 stub `test-stubs/monaco-editor.ts` 已扩到能模拟 decoration range 迁移（`applyEdits`/`deltaDecorations`/`getDecorationRange`/`getValueInRange` + edge-bias shiftOffset），renderer-dom 下驱动 tracker/UI 测试无需真 Monaco。DI stub 套路（stubLanguageFeatures 等）仍在 `PromptInput.test.tsx`。
- `en-US.ts` 只放需覆盖的英文条目；`localize()` 自带英文 default，新面板文案默认只补 `zh-CN.ts`。
- popover 定位维持贴输入框上沿全宽（`.promptPopover` `bottom:100%`），未升级到光标屏幕坐标——对 3–16 行输入框够用（计划 §3.2 明确允许取简单者）。
- 计划文档：`docs/plan/monaco-prompt-input-context-pills-plan.md`（M0–M4 全完成）；旧计划 `prompt-hash-context-references-plan.md` 的 by-name 部分已被取代。

**坑：ACP `resource_link` 的 name/description/_meta 在协议边界被内置 agent 丢弃**。两个 vendor agent 的 prompt→模型转换都只读 `uri`(claude fork `acp-agent.ts:4826` `promptToClaude`→`formatUriAsLink(uri)` 连 name 都丢；codex `CodexAcpClient.ts:837` `buildPromptItems` 用 `formatUriAsLink(name,uri)` 但丢 description+_meta)。后果：符号引用 `#Student` 若序列化成 `resource_link{uri:hello.ts,_meta.symbol.line}`，agent 只收到指向整个 hello.ts 的文件链接，行/列全丢 → agent 读整个文件而非定位符号（用户实测 bug）。**修法**：`composeRefBlock` 的 symbol 分支改产 `text` 块（agent 唯一逐字透传的通道），把符号名+相对路径+行列写进文本 `` `Student` (hello.ts:12:5) ``（`_meta.symbol` 保留供未来 agent 用但当前不依赖它）。教训：任何需要 agent 精确消费的结构化位置信息，不能塞进 resource_link 的 name/description/_meta，只能进 text 块正文。file/folder/openEditor 指整文件无所谓，仍用 resource_link。`_dispatchPrompt` 加了 `console.debug('[acp-prompt] dispatch', ...)` 打印发出块形状便于诊断。
