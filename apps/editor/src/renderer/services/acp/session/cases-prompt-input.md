# cases-prompt-input

> 本文从 `services/acp/session/CLAUDE.md` 拆出，范围是：输入框上下文的逐案细节——`@@`/`@#` 触发文件选择对话框、把编辑器选区作为上下文推给 input、发送后附件不能只依赖 agent transcript。路由入口见 [CLAUDE.md](CLAUDE.md)「常见任务 → 改哪里」。

## `@@`/`@#` 触发 SimpleFileDialog 选文件/文件夹作为 @提及

纯函数 `promptMentions.ts` 的 `detectFilePickerTrigger(text, caret)` 识别刚敲下的 `@@`(file)/`@#`(folder)，边界规则同 `extractMentionQuery`（`@` 须在行首或空白后，光标须紧跟两字符）；`PromptInput.tsx` 的 textarea `onChange` 里拦截该触发 → 剥掉两字符 → 走 `IFileDialogService.showOpenDialog`（file: canSelectFiles / folder: canSelectFolders）→ 选中后 `toMentionName(uri, workspaceRoot)` + `mergeMention` 复用既有 @提及管线（发送时 `composePromptBlocks` 序列化成 `resource_link`）。取消则只留剥除触发后的文本。测试 stub 需注册 `IFileDialogService`。

## 把 editor 选区作为上下文推给 input（"Add Selection to Agent Chat"，Cursor Ctrl+L 式）

`promptContext.ts`（`SelectionContext` 类型 + `composeContextBlocks`：embeddedContext→`EmbeddedResource`，否则降级围栏文本块）+ `acpSession.ts`（`sendPrompt`/`_dispatchPrompt` 第三参 `contexts`，attach 时缓存 `_embeddedContextSupported`，context block 置于 prompt 前）+ `acpSessionConnection.ts`（`QueuedPrompt`/`enqueue` 带 contexts）+ 命令 `actions/agentContextActions.ts`（`FileEditorRegistry.get(activeEditor).getSelections()` 取多选区）+ UI `SelectionContextChips.tsx` + `PromptInput.tsx`（contexts state/持久化/reveal）+ 右键菜单走 Monaco `editor.addAction`（FileEditor.tsx，Monaco 自带右键菜单**不读**我们的 MenuRegistry）。draft cache 加 `contexts` 字段，按**本地 id** 缓存（未发送草稿）。

**路由关键坑**：命令**不能直接调** `widget.addSelectionContext`——用户在文件编辑器里选文本时，目标 session 的 ChatBody 常常**没挂载**（editor 模式 session tab 没打开，或刚 `createSession` 还没渲染），widget 为 undefined 会静默丢弃。正解：`acpPromptContextInbox.ts`（模块单例收件箱，按**本地 session id** 存 + `onDidDeposit` 事件）。命令流程：定位/创建目标 session（activeSession 否则 createSession）→ `deposit(session.id, contexts)` → 打开并聚焦该 chat（editor 模式 openEditor AcpSessionEditorInput / sidebar 模式 openViewContainer + `focusSessionInput`）。PromptInput 挂载时 `drain` + 订阅 `onDidDeposit` 即时消费，跨「未挂载→挂载」不丢。

## 发送后附件不能只依赖 agent transcript

agent 回放只保留传输形态（`<context>` / 文件链接 / fallback fence），无法还原行号标签与发送时快照。`acpMessageAttachmentStore.ts` 按 **durable session id + messageId** 保存快照；恢复时 `acpSession.ts` 回填 `selectionContexts` 并严格去掉等值传输文本，避免芯片与原始上下文重复。生命周期必须联动零输出取消、rewind、普通 fork、session 删除/清空；side task 不复制隐藏基线。首条用户消息由 `StickyUserMessageBar` 单独渲染，不走普通 `UserMessageItem`，两处都要接只读芯片。
