---
name: editor-text-focus-stuck-swallows-keys
description: editorTextFocus 残留 true 致全局键盘守卫吞裸字符键(如 markdown 预览 link hints 的 f)
metadata: 
  node_type: memory
  type: project
  originSessionId: d7080423-794f-4974-8916-b46829d36e07
---

markdown 预览 link hints 的裸 `f` 键退化(按 f 无反应)真因:context key `editorTextFocus` 残留为 true。

**链路**:全局键盘派发器 `apps/editor/src/renderer/workbench/useGlobalKeybindingHandler.ts:379-399` 有一道"裸单字符键(无 ctrl/alt/meta)保留给文本输入"的守卫,它用 `editorTextFocus === true`(或 editable target)判定当前是否文本输入面。一旦该 key 卡 true,即便预览已聚焦、`f` 的 keybinding 已解析为 EXECUTE,守卫仍把 `f` 当打字吞掉 → 命令不执行。

**为何残留**:`editorTextFocus` 仅由 Monaco 的 `onDidFocusEditorText`/`onDidBlurEditorText` 维护(`FileEditor.tsx:195-200`)。用 Ctrl+Shift+V 把 markdown 源就地替换成预览时 FileEditor 卸载,cleanup **先 dispose blur 订阅、再 dispose 编辑器**(`FileEditor.tsx:223-235`),blur 永不触发 → key 永久 true。

**现象自洽**:`Ctrl+F` 正常(带功能修饰符不被守卫拦)、`runCommand` 正常(不经 keydown 守卫)、唯独裸字母被吞。也是为什么 e2e 用 command 触发能"通过"却掩盖真 bug——测裸字符键绑定必须用真实键盘,别用 runCommand 绕过。

**修复**(已实施,`apps/editor/src/renderer/services/editor/editorFocus.ts` 的 `syncEditorFocusContext`):焦点不在任何 `.monaco-editor` 内时,`editorTextFocus` 定义上不可能为 true,顺手 `set('editorTextFocus', false)`。只清不设(text/widget 区分仍归 Monaco);焦点仍在另一 Monaco 时不动它。该函数已在 FileEditor 卸载的 queueMicrotask + focusStandaloneEditor 等处调用,自动复位。回归单测在 `editorFocus.test.ts`。

**Why**:隐蔽,对今后任何"非 Monaco 编辑器 + 裸字母/Delete/Backspace 键绑定"都适用(如预览滚动 j/k、前进后退)。
**How to apply**:给非 Monaco 编辑器加裸字符键绑定时,确认 `editorTextFocus` 在焦点进入该编辑器时为 false;e2e 必用真实 `page.keyboard.press`,辅以 bringToFront + 仅在未生效时重按的自愈轮询。关联 [[markdown-preview-link-hints]]。

**2026-07 追加(切走再切回同类失效 + `focusEditorInput` 非 Monaco 分支漏 sync)**:文档中心(DocEditor,复用 `useMarkdownReaderNav`)「切到 Monaco 文件编辑器→再切回 doc→按 f 无反应」,同一 `editorTextFocus` 残留链的另一触发路径。根因:切到 Monaco 时 `onDidFocusEditorText` 置 true;切回 doc 走 `focusEditorInput()`(`editorFocus.ts`)的 `input.focus?.()` 非 Monaco 分支——该分支**当时只 return true,没调 `syncEditorFocusContext`**(Monaco / diff 分支都调了,唯独它漏了)→ 残留的 true 没被清 → 裸 f 被守卫吞。修法:`input.focus()` 成功后补 `syncEditorFocusContext` + `queueMicrotask(...)`(对齐 Monaco/diff 分支写法)。前置条件是 EditorInput 覆写了 `focus()`(见 [[editor-input-identity-isolation]] 的 DocEditorInput 补 focus)。e2e 回归 `smoke.markdownPreview.spec.ts` 的 `doc center keeps link hints working after switching editors and back`。**通则**:任何非 Monaco 编辑器的 `focus()` 落地后都要 sync 焦点 context key,否则从 Monaco 切过来会带着 stale 的 `editorTextFocus`/`editorFocus`。
