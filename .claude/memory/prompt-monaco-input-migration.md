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
- **⚠️ 延迟 cursor 事件绕过 runProgrammatic（source 计数器不够，还要 kind）**：上一条的 `runProgrammatic` 仍不够——真 Monaco 在programmatic `setText`/`setPosition` 结算**之后**会**异步**再补发一个 `onDidChangeCursorPosition`，此时计数器已归零 → 该事件被判成 `source:'user'`，内容却没变（只是光标 settle）。历史弹窗打开后正是这个杂散事件触发 `setHistoryOpen(false)`，症状=按 ↑ 文本跳到上一条但**弹窗一闪即消**（单测的 stub 光标事件是**同步**发的，落在 runProgrammatic 内，所以单测假绿、只有真 Monaco 复现）。解法：`onChange` 再加第四参 `kind: 'content'|'cursor'`（`onDidChangeModelContent`→content，`onDidChangeCursorPosition`→cursor），host 侧 `kind==='cursor'` 时只 `setCaret`、**跳过所有内容相关副作用**。复现必须走真 e2e（键盘输入→Enter 真提交 push 历史→真 ArrowUp 走全局键盘路由；`sendAcpPrompt` 探针直调 sendPrompt 绕过 submit 不会 push 历史）。回归测试见 `smoke.agentsPromptHistory.spec.ts` + `PromptInput.test.tsx` "keeps the history popover open when a bare cursor move fires"（stub 的 keyup→cursor 事件锁死此坑）。
- **历史弹窗方向（弹窗在输入框上方 → 列表从下往上长）**：`historyEntries` 是 newest-first（index 0=最新）；弹窗浮在输入框**上沿**，视觉上须最新贴底(近输入框)、最旧在顶，↑(更旧)=高亮上移才符合终端惯例。键位绑定：`up`→`popoverSelectPrev`(历史里=index+1 更旧，clamp 最旧不回绕)、`down`→`popoverSelectNext`(index-1 更新，越过最新 restore 草稿)。视觉反转**只在 `PromptHistoryPopover` 内做**（`entries.slice().reverse()` + `toDisplay=len-1-i` 双向映射 activeIndex/onHover），`PromptInput` 的 index 语义/按键逻辑/单测全不动。
- **弹窗在光标上方弹出 → 静止鼠标劫持选中项（PopoverList 共性坑）**：`PopoverList`(slash/mention/hash/history 四处共用)原用 `onMouseEnter` 报 hover。弹窗常常正好弹在**静止光标**下方，浏览器对"新出现在光标下的元素"派发合成 `mouseenter` → hover 把键盘选中项劫持到鼠标所在项（症状=打开历史按↑，起点不是最新而是鼠标下那条）。修法：`onMouseEnter`→`onMouseMove`（静止光标下的布局变化只发 mouseenter/mouseover，**不发 mousemove**；真移动鼠标才发 mousemove，hover 仍生效）。回归锁：PopoverList.test "does not report hover on mouseenter alone" + e2e "stationary cursor ... does not hijack"(用 `dispatchEvent('mouseenter')` 复现，Playwright 的 `mouse.move` 会真发 mousemove 复现不了)。注意 PopoverList 在 `workbench-ui` 包，改后需 `pnpm --filter @universe-editor/workbench-ui build` 否则 apps 用旧 dist。
- **ArrowUp 开历史的门控**：Monaco 软换行同一逻辑行 `lineNumber` 不变，不能用 `lineNumber===1` 判首行；改用 `getTopForPosition(caret) === getTopForPosition(1,1)`（视觉行顶部相等才算首行）。
- **e2e 探针**：Monaco 无 `<input>`，`locator.inputValue()` 失效。drop 宿主 div 挂 `data-testid="acp-prompt-drop-host"`(原叫 acp-prompt-input，因与 stub textarea 撞名致"multiple elements"改名)让拖拽事件仍落地；读文本改用新增探针 `window.__E2E__.getAcpPromptText()`（读 `AcpPromptDraftCache`，drop 使 text 非空即落草稿）。`sendAcpPrompt` 直调 `session.sendPrompt` 绕过 DOM，主发送路径不受影响。
- **测试 stub**：`test-stubs/monaco-editor.ts` 的 `editor.create()` 挂真 `<textarea data-testid="acp-prompt-input">` 桥接假 model；`fireEvent.change` 派发 `change` 事件（非 `input`），stub 须同时监听两者。`MonacoLoader.peek()` 暖时同步挂载，配 `beforeAll(ensureInitialized)` 让单测能同步查到输入框。
- **异步 splice 断言**：带尾随文本的 `@@` 触发会 fire 两次 onChange，单次 `act`+`setTimeout(0)` flush 不稳（it promise 不 settle 假超时），改 `await waitFor(() => expect(...))` 轮询。

相关记忆：[[monaco-055-editcontext-nls]]（editContext:true 修中文 IME，必设）、[[acp-prompt-image-feature]]（图片三入口需保住）、[[reload-disposable-leak-marksingleton]]（disposable 全 dispose 防 e2e 泄漏红）。
