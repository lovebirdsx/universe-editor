# 命令、快捷键与上下文键

`Action2` 的 `menu` 字段同时供给右键菜单和命令面板，但两者的**求值时机**与**可用上下文键**并不一样；快捷键则走另一套解析（只认 weight 与 when，见下）。本文收的是这几条链路上**会静默失效**的判据——「菜单行消失」「搜不到」「按了没反应」的共同根因。

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

## 快捷键解析：weight 优先、when 只过滤

`packages/platform/src/command/keybindingRegistry.ts` 的解析**不是** VSCode 的「when 匹配优先」：排序只看 **weight（高者优先）→ 同 weight 后注册者优先**；`when` 仅做过滤，**不提权**。缺省 weight 是 `KeybindingWeight.WorkbenchContrib`(200)，用户自定义层是 `User`(1000)。

**同名同键的 scoped 绑定不会像 VSCode 那样自动赢**。真实踩坑：给提交图加 `ctrl+r` 刷新（`when: activeEditorId == 'universe:/gitGraph'`）被全局无 when 的 Open Recent（同键、同缺省 weight）抢走。**做法**：带 `when` 的快捷键若与无 when 的全局绑定同键，必须显式加 `weight: KeybindingWeight.WorkbenchContrib + 50`——对照范例 `CloseDirtyDiffPeekAction`（`apps/editor/src/renderer/actions/dirtyDiffActions.ts`）的 Esc（`dirtyDiffPeekVisible` + 250）。用户自定义（User=1000）按设计仍可覆盖，不受影响。

排查读 `KeybindingsRegistry.traceKeystroke` 的 candidates（`selected` / `outcomeReason`）；完整决策树见 skill `fix-keybinding-not-firing`。

## 焦点类上下文键：一律 DOM 派生

**全局键盘守卫**：`apps/editor/src/renderer/workbench/useGlobalKeybindingHandler.ts` 有一道「无 ctrl/alt/meta 的裸字符键与 Delete/Backspace 保留给文本面」的守卫，判据 `isEditableTarget(target) || editorTextFocus === true || acpPromptInputFocused === true`（inTextSurface / isPrintableTyping / isNativeEditing 三处，紧挨 chord 分支）。任一 key 残留 true，即便 registry 已解析出 `EXECUTE` 也会被吞。**签名症状**：`Ctrl+F` 正常、`runCommand` 正常、裸字母（如 markdown 预览 link hints 的 `f`）无反应。

**残留根因（记账型焦点键的通病）**：早期 `editorTextFocus` 只由 Monaco 的 `onDidFocusEditorText` / `onDidBlurEditorText` 维护，FileEditor 卸载时 cleanup **先 dispose blur 订阅、再 dispose 编辑器** → blur 永不触发 → key 永久 true。修法是 `services/editor/editorFocus.ts` 的 `syncEditorFocusContext`：焦点不在任何 `.monaco-editor` 内时 `editorTextFocus` 定义上不可能为 true，顺手 `set(false)`——**只清不设**，text/widget 区分仍归 Monaco。**通则**：任何非 Monaco 编辑器（含 `EditorInput` 覆写的 `focus()`）落地后都必须 sync 焦点 context key，否则从 Monaco 切过来会带着 stale 值。

**设计定论：焦点类 context key 一律从 DOM 派生，禁止任何「由事件记账」的布尔键。** `editorFocus`（`installEditorFocusDerivation`）与逐 Part 布尔键 + `focusedPart` / `focusedView` / `terminalFocus`（`services/focus/documentFocusReconcile.ts` 的 `installDocumentFocusReconcile`：`focusin` 同步重算 / `focusout` 合并成一次 `setTimeout(0)`）皆然——新增嵌入 Monaco **不要再补 `editorFocus` bridge**。唯一保留的记账是 `part.onDidFocus` 作 intent：editor-area / activity-bar / status-bar 三个 Part 根没有 `tabIndex`，`Part.focus()` 的 `container.focus()` 在真实浏览器里是 DOM no-op，F6 / 启动恢复 / `focusPart` 兜底全靠它；**新增 Part 根若指望 `Part.focus()` 真把 DOM 焦点搬过去，必须补 `tabIndex={-1}`**。`focusedPart` 取值是 `PartId`（如 `sideBar`），不是 testid 后缀。挂载在 `contributions/FocusContextKeyContribution.ts`，回归见 `FocusContextKeyContribution.test.ts`。

**嵌入 Monaco 的键要选对**：可编辑 standalone Monaco（Monaco 0.55 起 `editContext` **默认 true**，没显式设也命中）必须把焦点桥到文本面 key，否则全局 Delete/Backspace/裸字符绑定会被守卫吞——MergeEditor 的 Result 面板曾按 Delete 弹删文件确认框，ACP 输入框（`PromptMonacoEditor.tsx`）曾 Delete 无反应。但**文件编辑器 / MergeResult 用 `editorTextFocus`，嵌入输入框一律用专用键**（ACP prompt = `acpPromptInputFocused`，**绝不冒充 `editorTextFocus`**，否则 VSCode 导入的 User 级绑定会偷键）。只读实例（DiffEditor / LogOutputView / InlineDirtyDiff）不受影响。详见 `docs/development/monaco-embedding.md`。

## `ScopedContextKeyService` 的静默 dispose

`packages/platform/src/command/contextKey.ts` 的 `ScopedContextKeyService.dispose()` **只 `_keys.clear()` + `super.dispose()`**——不抛错、不置 disposed 标志。dispose 之后 `get()` 静默透传父级，查不到的 key 全判 `undefined` ⇒ 所有菜单 `when` 全线判 false，**无异常、无日志，条目「凭空消失」**。

**从潜伏变成显形要三方共谋**（症状：SCM 行右键菜单弹出后按 ↓ 整个菜单消失；dev-only，e2e/prod 跑 `out/` 不复现）：

1. dispose 静默清空（上）。
2. wrapper 用 naive `useMemo(createScoped) + useEffect(cleanup dispose)` → StrictMode 干跑提前清空。
3. `ContextMenu` 的 `args = []` **默认参数**每次函数体执行都是新数组 → `runCommand` 的 useCallback 重建 → `rows` useMemo 重算 → ArrowDown 的内部 setState 一重渲染就对着已清空的 context 重解析 → `rows.length === 0` → `return null`。

只有 ② 而没有 ③ 时不出症状（其它 wrapper 从不重算 rows）——**没触发不是反例**。

**修法双保险**：① 模块级哨兵常量 `NO_ARGS: readonly unknown[] = []`（`packages/workbench-ui/src/contextMenu/ContextMenu.tsx`）掐断无谓重算；② `apps/editor/src/renderer/workbench/useScopedContextKey.ts` 的 **recreate-if-disposed 守卫 + overrides 浅比较**（顺带取消「overrides 必须 memo」的隐性契约），已收口 Scm / Explorer / Editor / EditorTab / Remote 五处 ContextMenu；事件回调里命令式建、`closeMenu` 里 dispose 的 TimelineView / ExtensionTreeView 不经 React 生命周期，刻意不迁。

**通用教训**：静默失效的资源（dispose 后可读不报错）+ 会重算的消费方 = dev-only 幽灵 bug。React 里持有此类资源一律走 recreate-if-disposed 守卫，别用裸 `useMemo`。回归：`workbench/__tests__/useScopedContextKey.test.tsx`。

## Action2 异步 run 的 accessor 寿命

`Action2.run(accessor, ...)` 里的 `ServicesAccessor` **只在同步执行期有效**：命中第一个 `await` 即失效，之后 `accessor.get()` 抛 `service accessor is only valid during the invocation of its target method`（守卫源在 `packages/platform/src/di/instantiationService.ts` 的 `Object.get`）。

**做法**：async 的 `run` 必须在任何 `await` **之前**把所需 service 全部同步取出（打包成快照对象传给后续 helper），await 之后绝不再碰 accessor。**抽取 async helper 尤其危险**——一个无条件的 async 调用就会把后续代码推到失效边界之后。

**判例**：`apps/editor/src/renderer/actions/agentContextActions.ts` 的 `SendCommitToAgentChatAction` 等三个 action 用 `captureRevealServices(accessor)` 先把 service 同步快照成 `RevealServices`，再传给 `resolveExistingChatTarget` / `revealChat` 这些 async helper。

**测试陷阱**：自造的持久有效 accessor（`{get: id => collection.get(id)}`）或让 helper 在同步块内跑完的 `invokeFunction`，都**不会**复现此 bug——测试会假绿。要么在测试里模拟 await 后失效，要么（更好）让代码本身不依赖 accessor 存活。

## 扩展命令与 renderer Action2 的同名遮蔽

内置扩展（git / perforce）贡献到 scm/title 菜单、但 handler 在 **renderer Action2** 的命令（如 `git-graph.view` / `perforce-graph.view`），**绝不能**再写进扩展 `package.json` 的 `contributes.commands`。

**机制**：`contributes.commands` 会在扩展宿主侧注册一个**同名、无 handler** 的命令；执行时它胜出并遮蔽 renderer Action2——`executeCommand` **静默返回 undefined、不抛错**、编辑器不打开：「命令成功」却什么都没发生。

**做法**：只在 `contributes.menus`（scm / title 等）里写该命令项，菜单项自带 `icon` 即可显示图标、title/tooltip 由 Action2 提供（对照 git 扩展：`git-graph.view` 只出现在 menus）。细节与排查手法见 skill `create-extension`。

## 为什么单测守不住

菜单 `when` 走 per-group scoped ctx、keybinding 与 `precondition` 走 root ctx，而面板的求值时刻（焦点已被抢走）在单测里无法如实复现——手搓的 `ContextKeyService` 只能证明表达式本身对不对，证明不了"那一刻真实产物的取值"。这类分裂**只有 e2e 能守住**，参考 `apps/editor/e2e/specs/smoke.acpSideTask.spec.ts`（断言面板打开时该行可见/不可见）。

相关：`apps/editor/CLAUDE.md`「常见踩坑」的 ContextKey 求值域条目；skill `fix-keybinding-not-firing`。
