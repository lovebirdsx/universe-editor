# 命令、菜单与上下文键

`Action2` 的 `menu` 字段同时供给右键菜单和命令面板，但两者的**求值时机**与**可用上下文键**并不一样。以下两条判据都来自真实踩坑（静默消失、搜不到），写在这里避免重蹈。

## `precondition` 会 AND 进该命令声明的**每一条**菜单

`registerAction2`（`packages/platform/src/command/action.ts`）对 `menu` 数组的每一项执行 `combineWhen(desc.precondition, menu.when)`——`icon` 的"撒播"行为同样适用于 `precondition`。

后果：给命令加 `precondition` 来限制**命令面板**可见性时，右键菜单行会一并被加上这个条件。而右键菜单常常在 precondition 恰好不成立的宿主上弹出（焦点不在编辑区、编辑器不是前台……），表现为**该行静默消失**，没有任何报错。

**做法**：要让命令面板按条件过滤、又不污染右键菜单行，别用 `precondition` + `f1: true`，改成显式声明面板行并保持 `f1: false`：

```ts
menu: [
  { id: MenuId.AcpChatContext, group: ACP_CHAT_CARD_GROUP, order: 9, when: 'acpChatForkSupported' },
  { id: MenuId.CommandPalette, when: ACP_SESSION_EDITOR_ACTIVE_WHEN },
],
f1: false,
```

`f1: true` 的语义就是往 `MenuId.CommandPalette` 推一行、`when` 取 `precondition`；显式声明与之逐字段等价，只是各菜单槽位的 `when` 不再互相牵连。`f1: false` 不影响 Keyboard Shortcuts 编辑器（它读 `CommandsRegistry`，与菜单无关）。

## 命令面板行不能用 `editorAreaFocus`

面板一打开，焦点就进了 quick input，`editorAreaFocus`（由 `document.activeElement` 派生）随即翻成 `false`——用它做门控的行**永远搜不到**。

`activeEditorTypeId` 则是走 `editorService.activeEditor` 的 root key，打开面板不改变前台编辑器，取值保持正确。表达"当前台是某类编辑器"用后者。

参考 `apps/editor/src/renderer/actions/_agentShared.ts` 里两个常量的分工：

| 常量 | 表达式 | 用途 |
|---|---|---|
| `ACP_EDITOR_ONLY_WHEN` | `editorAreaFocus && activeEditorTypeId == 'acp.session'` | keybinding：焦点在别处（panel / terminal）时按键不该打到身后的会话编辑器 |
| `ACP_SESSION_EDITOR_ACTIVE_WHEN` | `activeEditorTypeId == 'acp.session'` | 菜单/面板行：只关心前台编辑器是谁 |

## 为什么单测守不住

菜单 `when` 走 per-group scoped ctx、keybinding 与 `precondition` 走 root ctx，而面板的求值时刻（焦点已被抢走）在单测里无法如实复现——手搓的 `ContextKeyService` 只能证明表达式本身对不对，证明不了"那一刻真实产物的取值"。这类分裂**只有 e2e 能守住**，参考 `apps/editor/e2e/specs/smoke.acpSideTask.spec.ts`（断言面板打开时该行可见/不可见）。

相关：`apps/editor/CLAUDE.md`「常见踩坑」的 ContextKey 求值域条目；skill `fix-keybinding-not-firing`。
