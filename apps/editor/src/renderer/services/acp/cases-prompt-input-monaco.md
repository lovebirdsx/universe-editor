# cases-prompt-input-monaco

> 本文是 `services/acp/CLAUDE.md`「输入框」的纵切案例：ACP 输入框（`PromptInput` + `PromptMonacoEditor`）从 textarea 升到**内嵌 Monaco** 之后的编排层细节——变更源分类（`source` + `kind`）、历史弹窗的方向与门控、局部键位分发（Enter 的 `addCommand` 红线）、e2e 探针与单测 stub。@/# 药丸机制见 [cases-prompt-ref-pills.md](cases-prompt-ref-pills.md)；inbox 竞态见 [session/cases-prompt-input.md](session/cases-prompt-input.md)；Monaco 通用红线（editContext / 焦点桥接 / addCommand）见 [docs/development/monaco-embedding.md](../../../../../../docs/development/monaco-embedding.md)。

## 变更源分类：`source`（program vs user）不够，还要 `kind`（content vs cursor）

- 根因链：受控 textarea 的 `onChange` 只在用户输入时触发；非受控 Monaco 每次 `model.setValue` / `applyEdits`（历史导航、接受候选、草稿恢复、tracker 自己的 insert/restore）都 fire `onDidChangeModelContent`。若把它当用户输入处理，history-nav effect 里的 `setText` 会回灌 → `if (historyOpen) setHistoryOpen(false)`，把刚开的弹窗立刻关掉。
- 第一层解（pills 坑③ 已记）：`PromptEditorHandle` 的命令式方法用 `runProgrammatic` 计数器包裹，`onChange` 带第三参 `source: 'user' | 'program'`；`program` 时只 mirror text/caret、**跳过所有用户输入副作用**（history 关闭、`@@`/`@#` 触发、popover dismiss）。
- **第二层解（计数器仍不够，必须再带 `kind`）**：真 Monaco 在 programmatic `setText`/`setPosition` 结算**之后**会**异步**再补发一个 `onDidChangeCursorPosition`，此时计数器已归零 → 该事件被判成 `source:'user'`，内容却没变（只是光标 settle）。历史弹窗打开后正是这个杂散事件触发 `setHistoryOpen(false)`——症状 = 按 ↑ 文本跳到上一条但**弹窗一闪即消**。
- 解法：`onChange` 加第四参 `kind: 'content' | 'cursor'`（`onDidChangeModelContent`→content，`onDidChangeCursorPosition`→cursor）；host 侧 `kind === 'cursor'` 时只 `setCaret`、**跳过所有内容相关副作用**。
- 测试纪律：单测 stub 的光标事件是**同步**发的（落在 `runProgrammatic` 内）→ 假绿；复现必须走真 e2e（键盘输入 → Enter 真提交 push 历史 → 真 ArrowUp 走全局键盘路由；`sendAcpPrompt` 探针直调 `sendPrompt` 绕过 submit，**不会 push 历史**）。回归：`smoke.agentsPromptHistory.spec.ts` + `PromptInput.test.tsx` 的 `keeps the history popover open when a bare cursor move fires`（stub 的 keyup→cursor 事件锁死此坑）。

## 历史弹窗：浮在输入框上沿 → 列表从下往上长

- `historyEntries` 是 newest-first（index 0 = 最新）；弹窗浮在输入框**上沿**。视觉上须最新贴底（近输入框）、最旧在顶，↑（更旧）= 高亮上移才符合终端惯例。
- 键位语义：`up` → `popoverSelectPrev`（历史里 = index+1 更旧，clamp 最旧不回绕）；`down` → `popoverSelectNext`（index-1 更新，越过最新 restore 草稿）。
- 视觉反转**只在 `PromptHistoryPopover` 内做**（`entries.slice().reverse()` + `toDisplay` 双向映射 activeIndex/onHover），`PromptInput` 的 index 语义/按键/单测全不动。

## ArrowUp 开历史的门控：用视觉行顶部，不用 `lineNumber`

- Monaco 软换行下同一逻辑行 `lineNumber` 不变，不能用 `lineNumber === 1` 判首行；必须 `getTopForPosition(caret) === getTopForPosition(1, 1)`（视觉行顶部相等才算首行）。

## 局部键位分发：Enter 的 `addCommand` 红线

- 旧实现用 `ed.addCommand(m.KeyCode.Enter, …)` 绑提交：standalone Monaco 的 `addCommand` 注册在**共享的 StandaloneKeybindingService**、**没有编辑器作用域**——打开/恢复一个 session editor 后，**所有** Monaco 编辑器的 Enter 都被吞。
- 现象鉴别：`.md` 免疫是**假象**——`markdown.editing.onEnter`（weight 300）在全局键位分发器层先认领 Enter；`.ts` 依赖 Monaco 默认 Enter 才被劫持。
- 修法：Enter 处理挪到编辑器自己 DOM 节点上**作用域化的 capture keydown**（与既有 ArrowUp/Tab 处理同址：`dom = ed.getContainerDomNode()` + `addEventListener('keydown', h, true)`）；`onEnter` 返回 false 时**不 preventDefault**，自然落到 Monaco 原生 Enter 插入换行（旧代码显式 `trigger type \n`，新代码靠 fall-through）。
- 守护 e2e `apps/editor/e2e/specs/smoke.agentsPromptEnterLeak.spec.ts`（@p1/@regression）：开 .ts 按 Enter → 开 session editor → 切回 .ts 断言 Enter 仍插换行；已验证旧代码下该 spec 正确失败。
- 与全局分发器的配合：本输入框的「可编辑目标保留」（裸字符 / Delete / Backspace）靠专用 key `acpPromptInputFocused`（**不是** `editorTextFocus`），seed 与焦点桥接见 [docs/development/monaco-embedding.md](../../../../../../docs/development/monaco-embedding.md)「嵌入实例的焦点桥接」。

## e2e 探针

- Monaco 没有 `<input>`：`locator.inputValue()` 失效。读文本改用 `window.__E2E__.getAcpPromptText()`（读 `AcpPromptDraftCache`）。
- 拖拽落宿主 div 挂 `data-testid="acp-prompt-drop-host"`（原名 `acp-prompt-input`，因与 stub textarea 撞名报 multiple elements 而改名）。
- `sendAcpPrompt` 直调 `session.sendPrompt` 绕过 DOM（主发送路径不受影响）——但它**不 push 历史**，历史相关用例必须走真键盘。
- 交叉：与 skill `fix-ci-e2e-flake` 案例 73（EditContext 异步落字，`type` 后先 poll `getAcpPromptText()` 全文再 Enter）同源。

## 单测套路（`PromptInput.test.tsx`）

1. stub `editor.create()` 挂真 `<textarea data-testid="acp-prompt-input">` 桥接假 model；
2. `fireEvent.change` 派发的是 `change` 事件（非 `input`），stub 须**两者都**监听；
3. `MonacoLoader.peek()` 暖时同步挂载 → 配 `beforeAll(ensureInitialized)` 才能同步查到输入框；
4. 带尾随文本的 `@@` 触发会 fire 两次 onChange，单次 `act` + `setTimeout(0)` flush 不稳（it promise 不 settle 假超时），改 `await waitFor(...)` 轮询。

## 关键参考路径

- 编排：`workbench/agents/PromptInput.tsx`；编辑器句柄：`PromptMonacoEditor.tsx`；历史弹窗：`PromptHistoryPopover.tsx`
- 浮层键盘共性坑（`onMouseMove` vs `onMouseEnter`、`PopoverList` 契约）：`packages/workbench-ui/CLAUDE.md`（overlay 条目）
- 冷挂载 drain 竞态（inbox 被消费但 `setText` 静默丢弃）：[session/cases-prompt-input.md](session/cases-prompt-input.md)
- 药丸机制：`cases-prompt-ref-pills.md`；Monaco 通用（editContext / 焦点键 / addCommand 红线）：`docs/development/monaco-embedding.md`
