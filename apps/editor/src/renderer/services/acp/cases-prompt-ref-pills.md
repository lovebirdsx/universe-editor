# cases-prompt-ref-pills

> 本文从 `services/acp/CLAUDE.md` 拆出，范围是：ACP 输入框「@/# by-range 药丸引用」子系统——@ 文件提及 + # 结构化上下文（工作区符号/Git修改/打开编辑器+选区/文档）统一成 VSCode Copilot 式的、按字符区间（Monaco decoration）追踪的可编辑药丸；提交时读追踪的 range 列表产出 ContentBlock，不分词。涉及 `services/acp/{promptRef,promptRefTracker,promptMentions,promptContextRef,contextSuggestions}.ts` 或 `workbench/agents/{PromptMonacoEditor,PromptInput,ContextPopover,MentionPopover}.tsx`。区别于 [`session/CLAUDE.md`](session/CLAUDE.md)（会话全局导航）：本节只管输入框的引用子系统。

把用户在输入框里的 `@文件` / `#符号|Git改动|打开的编辑器|文档` 引用，做成 **VSCode Copilot 式的药丸**：引用是文本流里一段**可编辑文本 token**（`@src/a.ts` / `#foo bar`），用 Monaco decoration 染成药丸，**按字符区间（range）追踪**——Monaco 自动随编辑平移 range，含空格的 label 天然安全；提交时读追踪的 range 列表切片产出 `ContentBlock`，**绝不对文本分词/by-name 匹配**（旧机制的致命缺陷，已删）。

> ⚠️ **第一原则**：引用不是 React state，**真身活在 Monaco 上**——文本在 model 里、range 在 decoration 里、追踪表在 `PromptRefTracker` 里。`PromptInput` 只通过 `PromptEditorHandle`（`insertRef/listRefs/restoreRefs/clearRefs`）操作它们，不再持有 `mentions`/`contextRefs` 数组。改任何引用行为前先认清落在哪一层。

### 五文件分层地图

| 文件 | 层 | 职责 |
|---|---|---|
| `services/acp/promptRef.ts` | 纯逻辑（模型 + 序列化） | `PromptRef{id,kind,label,uri,meta?}` + `PlacedRef{ref,start,end}`；`extractActiveToken`（识别 @/# token）、`refDisplay`（`@`/`#` 前缀并入显示文本）、`composeRefBlock`（**一个 ref → 一个 wire block**，按 kind）、`composePromptBlocksFromRefs`（按 range 切片交织 text/block）、`suggestionItemToRef`/`mentionEntryToRef`（popover item → PromptRef） |
| `services/acp/promptRefTracker.ts` | 追踪（纯逻辑 + monaco 句柄） | `PromptRefTracker` 挂 model：`insert`（**`pushEditOperations`** 换文本 + 建 decoration + 存 snapshot，药丸与尾随空格同一次编辑）/`beginUndoGroup`/`endUndoGroup`（多次插入合成一个撤销元素）/`restore`（草稿恢复，只建 decoration 不改文本）/`list`（回读 decoration range → PlacedRef）/`reconcile`（普通编辑删漂移药丸；undo 只挂起不改文本、redo 按变更文本重建；flush 清空）/`clear`/`dispose` |
| `workbench/agents/PromptMonacoEditor.tsx` | 编辑器句柄 | 内嵌 standalone Monaco，暴露 `PromptEditorHandle`；`insertRef`/`insertRefs` 调 tracker（后者一个撤销组）；`onChange(text,caret,source,kind)` 用 `runProgrammatic` 计数器分 `'user'|'program'`，内容事件再按 `isUndoing/isRedoing` 细分 `'undo'|'redo'`；`setText` 走 `setValue` 后清 tracker 并通知 `onDidResetHistory` |
| `workbench/agents/PromptInput.tsx` | UI 编排 | `acceptMention`/`acceptContextRef`/`openFilePicker`/`onPromptDrop` → `editorHandleRef.insertRef(...)`；提交读 `listRefs()` → `session.sendPrompt(text, refs, ...)` |
| `services/acp/contextSuggestions.ts` | `#` 数据源 | 五个 provider（`WorkspaceSymbol`/`ScmChange`/`OpenEditor`/`Docs` 四个内置 + `ExtensionContextProvider` 转发扩展贡献，见下）headless `query()` → `ContextSuggestionItem[]`；`toItem` 把 line/column 塞进 `meta` |

> `promptMentions.ts`（`extractMentionQuery`/`detectFilePickerTrigger`）与 `promptContextRef.ts`（`extractHashQuery` + `PromptContextRefKind`）只剩 **token 探测**；旧 by-name 序列化（applyMentionPick/composePromptBlocks/mergeRef/composeContextRefBlock/PromptMention/PromptContextRef）**已全删，别复活**。

### 数据流（一次引用的生命）

```
键入 @q / #q → onChange(source:'user') → extractActiveToken → popover 拉候选
选中 → acceptXxx → handle.insertRef(ref, tokenStart, tokenEnd)（多文件 drop → insertRefs 一个撤销组）
        → tracker.insert：pushEditOperations 把 token 换成 refDisplay(ref) + 尾随空格（同一次编辑）
        → 建 decoration（inlineClassName:acp-prompt-ref-pill + NeverGrowsWhenTypingAtEdges），只覆盖药丸文本
        → 存 snapshot = display
用户编辑 → onChange(source:'user') → tracker.reconcile()：range 内文本漂移出 snapshot → 删引用
Ctrl+Z → Monaco 逆编辑 → reconcile({isUndoing})：药丸塌缩后移出 decoration、挂进 suspended（不改文本）
Ctrl+Y → Monaco 重放编辑 → reconcile({isRedoing})：按变更文本找回 snapshot → 重建 decoration
提交 → handle.listRefs() → composePromptBlocksFromRefs(text, refs)
        → 按 ref.range 切文本，每个 ref 走 composeRefBlock（按 kind 产 block）
        → session.sendPrompt(text, refs, contexts, images) → _dispatchPrompt 发出
```

### 撤销/重做：药丸是 Monaco 编辑栈的一部分

- **只能用 `pushEditOperations`**：`model.applyEdits` 明确不进撤销栈（Monaco 类型注释写死），用它插入等于告诉用户"这个引用不算编辑"。`insert()` 在 group 外时前后各 `pushStackElement()`，与相邻键入隔成独立撤销元素；`beginUndoGroup`/`endUndoGroup` 用深度计数，整组只有两个边界——一次 drop 多个文件 = 一次 Ctrl+Z。**组内不得 `await`**（组是 model 状态，异步会让边界错位）。**不要带 `forceMoveMarkers`**：插入点正好落在既有药丸边缘时它会撑大该药丸的 range，下一次 `reconcile` 会把两枚药丸的文本一起删掉。
- **undo 不能让 tracker 删文本**：Monaco 已经应用了逆编辑，`reconcile({isUndoing})` 只把 range 已漂移（塌缩）的药丸从 decoration 集合移除并记入 `suspended`，**绝不改 model**。否则会二次删除、把撤销变成乱码。
- **redo 要按文本找回药丸**：redo 不会自动把塌缩的 decoration 扩回来。`reconcile({isRedoing})` 在 `e.changes` 的文本里搜索 `snapshot`（写回 model 后再用 `getValue().slice()` 校验），命中即在绝对偏移重建 decoration。**Monaco 会把相邻编辑压缩成一个 change**（`compressConsecutiveTextChanges`），所以一次多文件 drop 的 redo 变更文本是 `@a.txt @b.txt ` 整段——必须逐 snapshot 在文本内定位，不能整串相等比较（e2e `smoke.promptUndoRef.spec.ts` 的 R2 就是这个坑）。同一偏移有多个候选时**取最长 snapshot**（`@main.ts` 是 `@main.tsx` 的前缀，否则短标签会抢走长药丸）；坐标校验失败时把候选放回 suspended 留给后续 redo 步骤，别吞掉。`contentChanges` 按偏移降序、且偏移就是最终文本坐标，各 change 可独立处理。
- **普通编辑清空 suspended**：新输入意味着 redo 分支已被丢弃，挂起的引用永远回不来；`insert()` 自己也要清（新插入同样关闭 redo，且 program 变更不经过 `reconcile`）。
- **`setValue` 是硬重置**：`PromptMonacoEditor.setText` 用 `model.setValue`（清空撤销/重做 + 销毁全部 decoration），随后 `tracker.clear()` 并调 `onDidResetHistory`；值未变化时 `setText` 是 no-op，需要强制清历史（提交）用 `handle.clearHistory()`（同样 `setValue` + 通知）。图片撤销栈也据此重置（见 [cases-prompt-images.md](cases-prompt-images.md)），两类历史都按 `alternativeVersionId` 对齐，版本来源被丢弃后不能再消费。

### 加一个新引用 kind 的清单

1. `promptRef.ts`：`PromptRefKind` 加 kind；`PREFIX_BY_KIND` 定 `@` 或 `#`；`composeRefBlock` 加 case（**先读下面「序列化红线」**）；`suggestionItemToRef` 加 case（若走 `#` popover）。
2. `contextSuggestions.ts`（若 `#` 类）：加 provider class（构造走 DI 装饰器）+ `ContextSuggestionItem.kind` 覆盖；`promptContextRef.ts` 的 `PromptContextRefKind` 补类型。
3. `PromptInput.tsx`：`ensureContextProviders` 注册 provider；`hashGroups` 加分组。
4. `ContextPopover.tsx`：分组渲染（若需新样式）。
5. i18n：`acp.contextRef.group.<kind>` 等键**只补 `zh-CN.ts`**（`localize()` 自带英文 default，`en-US.ts` 只收需覆盖项）。
6. 测试：`promptRef.test.ts` 加 `composeRefBlock` 该 kind 断言；provider 测试复用 `PromptInput.test.tsx` 里现成的 DI stub（stubLanguageFeatures/stubUriIdentity/…）。

### 序列化红线：resource_link 的 name/description/_meta 会被 agent 丢弃

**内置 agent 的 prompt→模型转换只读 uri，几乎不读别的字段**：
- claude-agent-acp fork `acp-agent.ts` `promptToClaude`：`resource_link` → `formatUriAsLink(uri)`，**连 name 都丢**。
- codex-acp `CodexAcpClient.ts` `buildPromptItems`：`formatUriAsLink(name, uri)`，用 name 但**丢 description + _meta**。

⇒ 任何**需要 agent 精确消费的结构化位置信息（行/列/符号名）绝不能塞进 resource_link 的 name/description/_meta——只能进 `text` 块正文**。这是本仓库真实 bug 的根因（`#Student` 发过去退化成读整个 hello.ts，因为 line 全在被丢弃的 `_meta.symbol` 里）。修法：符号类 `composeRefBlock` 产 `text` 块，把 ``（`Student` (hello.ts:12:5)）`` 写进正文（`_meta.symbol` 可留作未来 agent 用，但当前逻辑不能依赖它）。指整文件的 kind（file/folder/openEditor）无所谓，仍用 resource_link。

诊断辅助：`acpSession.ts` 的 `_dispatchPrompt` 有 `console.debug('[acp-prompt] dispatch', ...)` 打印发出块形状，复现时在 devtools 直接核对。

### `#` 的扩展贡献来源：chatContext（两步式）

扩展经 `chat.registerChatContextProvider`（`packages/extension-api/src/chat.ts`，0.16.0 起）贡献 `#` 来源；renderer 侧是 `ExtensionContextProvider` + `IChatContextService`（`services/extensions/ChatContextService.ts`，provider 注册表经 `mainThreadChat`/`extHostChat` 通道与扩展宿主同步）。

**与四个内置 provider 的关键差异——它是「触发器」不是「数据源」**：

- 面板里**一个 provider 只出一条入口项**（label/keywords 粗匹配，见 `matchesProviderQuery`），候选集永不进 renderer；用户接受后 renderer 回问扩展（`resolveItem(handle, query)`），**扩展自己弹 QuickPick** 选真正的条目，只有最终条目过河。因此 `ExtensionContextProvider.resolve` 忽略 query，也不走 `suggestionItemToRef`（那条路对它抛错，照 `commit` 的处理）。
- 回来的 `IChatContextItemDto` 由 `chatContextItemToRef` 直接建 ref：`label` 是药丸文本、`meta.text` 是发给模型的正文，`composeRefBlock` 把它**逐字**包成一个 `text` 块（没有可放结构化字段的 `_meta`——按上面「序列化红线」，正文就是全部；无 `text` 时退化成 label）。`uri` 为空串。
- 因此 `ContextPopover` 的 `entryKey` 对它按 `meta.chatContextHandle` 判身份（uri 为空会让同 provider 的行看起来一样），`PromptInput` 的 session 目录过滤对它豁免（没有落在工作区里的资源）。
- 图标 `iconId` 走 `contextIcon.tsx` 的 `resolveIcon` 回退（扩展给的是工作台图标名，不是 symbol/resource 图标），查不到退 `BookOpen`。

给 p4 的两个 provider（changelist / Swarm review）与三个右键入口的对照见 `extensions/perforce/docs/chat-context.md`。

### 易踩坑

- **① 药丸贴边**：Monaco 文本贴容器边框——`.promptEditorHost`（agents.module.css）须给 `padding: 0 6px`。药丸自身样式是**全局类** `:global(.acp-prompt-ref-pill)`（Monaco 把 decoration span 渲染在 CSS-module 作用域外）。
- **② 尾随空格不能事后补**：空格必须和药丸文本进**同一次** `pushEditOperations`（否则撤销只撤一半），且 decoration 必须在编辑**之后**按 `[start, start + display.length)` 建。若先建 decoration、再单独插入空格且带 `forceMoveMarkers`，会覆盖 `NeverGrowsWhenTypingAtEdges` 把空格吞进 range → range 文本变 `#test.md ` ≠ snapshot `#test.md` → 下次按键 `reconcile()` 误判"药丸被改"删掉整个引用。现行实现把空格折进 edit 并在挂 decoration 时显式排除它。
- **③ programmatic vs user 变更源**：非受控 Monaco 每次 `setValue`/`applyEdits`（历史导航、接受候选、草稿恢复、tracker 自己的 insert/restore）都 fire `onDidChangeModelContent`。`PromptEditorHandle` 命令式方法用 `runProgrammatic` 计数器包裹，`onChange` 带 `source`，`program` 时只 mirror text/caret、**跳过所有用户副作用（reconcile / @@@# 触发 / popover dismiss / history 关闭）**。否则会出现"刚开的弹窗被自己的 setText 关掉""tracker 自插入被自己 reconcile 删掉"。`source` 之上还有 `kind`（content/cursor）一层、以及四类 popover 的方向与键位分发，详见 [cases-prompt-input-monaco.md](cases-prompt-input-monaco.md)。

### 测试套路

- 纯逻辑（`promptRef.test.ts`，renderer-node）：`extractActiveToken` / `composeRefBlock` 各 kind / `composePromptBlocksFromRefs` range 切片 + 含空格 label。
- 追踪（`promptRefTracker.test.tsx`，renderer-dom）：`monaco-editor` alias 到 `test-stubs/monaco-editor.ts`——该 stub **已模拟 decoration range 迁移 + forceMoveMarkers 语义**（`shiftOffset` 的 `force` 参数 + `applyEdits` 透传 `forceMoveMarkers`），`pushEditOperations` 与 `applyEdits` 共用内部 `applyEditList` 但**不互相调用**（spy `applyEdits` 必须只看到真正的不可撤销写入）。加"边界打字/追加空格是否保留药丸"这类回归务必确认 stub 忠实模拟了对应标志，否则假绿（坑②当初就是 stub 漏了 forceMoveMarkers）。
- 撤销语义（e2e `smoke.promptUndoRef.spec.ts`）：真实 Monaco 的撤销栈/decoration 塌缩**不在 stub 里伪造**（stub 无 undo 栈）；单测只用手工模拟的编辑 + `reconcile({isUndoing/isRedoing})` 验证挂起/重建契约，真实按键路径由 e2e 兜底：R1 单文件、R2 多文件一次撤销/重做、R3 先键入后 drop 的两步撤销、I4 纯文本回归。
- UI（`PromptInput.test.tsx`，renderer-dom）：stub 的 `editor.create` 挂真 `<textarea data-testid="acp-prompt-input">` 桥接假 model；断言提交 payload 读 `sendPrompt` 第 2 参 `refs`（`refs[0].ref` `toMatchObject`）。

### 参考坐标

- 模型/序列化：`promptRef.ts`；追踪：`promptRefTracker.ts`；句柄：`PromptMonacoEditor.tsx`；编排：`PromptInput.tsx`；数据源：`contextSuggestions.ts`
- 相关：[cases-prompt-input-monaco.md](cases-prompt-input-monaco.md)（Monaco 迁移的坑）、[cases-prompt-images.md](cases-prompt-images.md)（图片输入）、[docs/development/monaco-embedding.md](../../../../../../docs/development/monaco-embedding.md)（editContext 与嵌入实例焦点键）
- 会话全局上下文（协议/发送链路/双 id）：见 [`session/CLAUDE.md`](session/CLAUDE.md)
