---
name: prompt-monaco-input-migration
description: "ACP 输入框从 textarea 升级为内嵌 Monaco + @/# by-range 药丸引用的实施进展与坑"
metadata: 
  node_type: memory
  type: project
  originSessionId: 711da5a2-5be0-4ef6-ba2d-f4a6a033faa3
---

ACP 会话输入框（`PromptInput.tsx`）从 HTML `textarea` 升级为**内嵌 Monaco 编辑器**，`@`/`#` 引用统一改成 VSCode Copilot 式的 **by-range 药丸（decoration）** 机制（按字符区间追踪，含空格天然安全，提交时读 range 列表产 `ContentBlock` 而非分词）。计划见 `docs/plan/monaco-prompt-input-context-pills-plan.md`（取代旧 [[prompt-hash-context-references-feature]] 的 by-name 部分）。

**根因**：旧 `#` 照抄 `@` 的 by-name（按 label 分词匹配）管线，label 含空格（符号名/Markdown 标题/文档条目）时提交 walk 到空白即停 → 整个上下文块被丢弃退化成纯文本；textarea 也渲染不出药丸。

**进展**：M0–M4 全部完成并全绿（`pnpm check` + 全量 e2e 151 passed + `pnpm docs:check`）。M0 统一 `PromptRef` 模型 + 纯函数 `promptRef.ts`；M1 `PromptMonacoEditor.tsx` 包装组件 + `PromptInput` 换 `editorHandleRef`；M2 `promptRefTracker.ts` by-range 药丸(insert/restore/list/reconcile/clear) + stub 扩到能模拟 decoration range 迁移；M3 四套 popover 在 Monaco 复位(定位维持贴上沿 `.promptPopover bottom:100%`，未升级光标坐标) + 草稿 refs 恢复；M4 删净旧 by-name 逻辑(promptMentions/promptContextRef 里 applyMentionPick/composePromptBlocks/mergeRef/composeContextRefBlock/PromptMention/PromptContextRef/contextSuggestionItemToRef 全删，两文件只留 token 探测)+ 测试重写 + 文档同步(药丸失效说明)。详见 [[prompt-hash-context-references-feature]]。

**How to apply / 关键坑**：
- **programmatic vs user 变更源（Monaco 迁移必踩）**：受控 textarea 的 `onChange` 只在用户输入时触发；非受控 Monaco 每次 `model.setValue`/`applyEdits`（历史导航、接受候选、草稿恢复）都会触发 `onDidChangeModelContent`。若把它当用户输入处理，history-nav effect 里的 `setText` 会回灌 `onEditorChange` → `if(historyOpen) setHistoryOpen(false)` 把刚开的弹窗立刻关掉。解法：`PromptEditorHandle` 的命令式方法用 `runProgrammatic` 计数器包裹，`onChange` 带第三参 `source: 'user'|'program'`，`program` 时只 mirror text/caret、跳过所有"用户输入副作用"（history 关闭、@@/@# 触发、popover dismiss reset）。
- **ArrowUp 开历史的门控**：Monaco 软换行同一逻辑行 `lineNumber` 不变，不能用 `lineNumber===1` 判首行；改用 `getTopForPosition(caret) === getTopForPosition(1,1)`（视觉行顶部相等才算首行）。
- **e2e 探针**：Monaco 无 `<input>`，`locator.inputValue()` 失效。drop 宿主 div 挂 `data-testid="acp-prompt-drop-host"`(原叫 acp-prompt-input，因与 stub textarea 撞名致"multiple elements"改名)让拖拽事件仍落地；读文本改用新增探针 `window.__E2E__.getAcpPromptText()`（读 `AcpPromptDraftCache`，drop 使 text 非空即落草稿）。`sendAcpPrompt` 直调 `session.sendPrompt` 绕过 DOM，主发送路径不受影响。
- **测试 stub**：`test-stubs/monaco-editor.ts` 的 `editor.create()` 挂真 `<textarea data-testid="acp-prompt-input">` 桥接假 model；`fireEvent.change` 派发 `change` 事件（非 `input`），stub 须同时监听两者。`MonacoLoader.peek()` 暖时同步挂载，配 `beforeAll(ensureInitialized)` 让单测能同步查到输入框。
- **异步 splice 断言**：带尾随文本的 `@@` 触发会 fire 两次 onChange，单次 `act`+`setTimeout(0)` flush 不稳（it promise 不 settle 假超时），改 `await waitFor(() => expect(...))` 轮询。

相关记忆：[[monaco-055-editcontext-nls]]（editContext:true 修中文 IME，必设）、[[acp-prompt-image-feature]]（图片三入口需保住）、[[reload-disposable-leak-marksingleton]]（disposable 全 dispose 防 e2e 泄漏红）。
