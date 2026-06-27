---
name: history-nav-p0-preexisting-fail
description: "smoke.historyNavigation @p0 \"no duplicate tab\" 在未提交的 markdown LSP 工作上已失败，与 go-to-symbol 改动无关"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6f4d2236-bae7-4972-bc56-dd75fd739374
---

`apps/editor/e2e/specs/smoke.historyNavigation.spec.ts` 的 @p0 用例 “GoBack after preview-replacing the previous file reuses the slot (no duplicate tab)” 在 2026-06 时**已经在工作树里失败**：GoBack 后 active editor 仍停在 b.txt（没回到 a.txt）。

经二分确认：在 commit 596c4fd（无 markdown LSP 特性）上该测试**通过**；在未提交的 markdown LSP 工作（`EditorOpenerContribution` / `LanguageFeaturesContribution` / `OutlineService` 等，均为他人/先前未提交改动）上**稳定失败 3/3**；而我的 go-to-symbol 改动（Ctrl+Shift+O 自建 quick pick + Ctrl+T 重设计）**完全移除后仍失败**。

**结论**：这是预存 markdown LSP 工作引入的回归，**不是** go-to-symbol 功能造成的。怀疑点：`EditorOpenerContribution` 的全局 `monaco.editor.registerEditorOpener` 钩子，或 OutlineService/文档同步对预览标签 pin 行为的干扰。

**How to apply**：若日后排查这个 @p0 失败，从预存 markdown LSP 的全局贡献入手，别误归因到符号导航。相关功能见 [[go-to-symbol-feature]]（如已建）。
