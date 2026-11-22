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

| 常量                             | 表达式                                                   | 用途                                                                     |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ACP_EDITOR_ONLY_WHEN`           | `editorAreaFocus && activeEditorTypeId == 'acp.session'` | keybinding：焦点在别处（panel / terminal）时按键不该打到身后的会话编辑器 |
| `ACP_SESSION_EDITOR_ACTIVE_WHEN` | `activeEditorTypeId == 'acp.session'`                    | 菜单/面板行：只关心前台编辑器是谁                                        |

## 快捷键解析：weight 优先、when 只过滤

`packages/platform/src/command/keybindingRegistry.ts` 的解析**不是** VSCode 的「when 匹配优先」：排序只看 **weight（高者优先）→ 同 weight 后注册者优先**；`when` 仅做过滤，**不提权**。缺省 weight 是 `KeybindingWeight.WorkbenchContrib`(200)，用户自定义层是 `User`(1000)。

**同名同键的 scoped 绑定不会像 VSCode 那样自动赢**。真实踩坑：给提交图加 `ctrl+r` 刷新（`when: activeEditorId == 'universe:/gitGraph'`）被全局无 when 的 Open Recent（同键、同缺省 weight）抢走。**做法**：带 `when` 的快捷键若与无 when 的全局绑定同键，必须显式加 `weight: KeybindingWeight.WorkbenchContrib + 50`——对照范例 `CloseDirtyDiffPeekAction`（`apps/editor/src/renderer/actions/dirtyDiffActions.ts`）的 Esc（`dirtyDiffPeekVisible` + 250）。用户自定义（User=1000）按设计仍可覆盖，不受影响。

排查读 `KeybindingsRegistry.traceKeystroke` 的 candidates（`selected` / `outcomeReason`）；完整决策树见 skill `fix-keybinding-not-firing`。

## 菜单 / 浮层 Ctrl 别名：window capture + 单层仲裁

菜单 / 浮层 / 对话框 / 配置栏按钮行的方向别名（`Ctrl+K` 上、`Ctrl+J` 下，`Ctrl+H`/`Ctrl+L` 左右）**不能**用普通 keybinding 实现：`resolveKeystroke` 先解析和弦前缀，`ctrl+k` 开头的弦永远先于单键命中，因此单键 `Ctrl+K` 在 picker 聚焦期间只能由 **window capture** 抢下（代价就是这段期间 `Ctrl+K` 和弦不可用）。纯列表 / 树（Explorer、Search、Scm、Outline、Timeline、图谱、Chat 时间线等）**不注册**这些别名，它们用裸键 `j/k/h/l`（开 Vim 时）或方向键，因此这四键在这些表面上保持全局含义。`Ctrl+P` / `Ctrl+N` 有意不在别名集合里——它们始终是「转到文件」/「新建文件」，在任何表面都保持全局含义。

React 列表 / 菜单 / 浮层的唯一入口是 `packages/workbench-ui/src/keybinding/ctrlNavigationRegistry.ts`：每个 `Document` 一个 window-capture 监听；注册层按 `menu > dialog > overlay > list` 优先级激活，同 kind 取嵌套更深者。一次按键只交给一层，命中即 `preventDefault + stopPropagation + stopImmediatePropagation`（边界落空也吞，否则底下的全局命令会照常执行）。

**例外：Monaco 自有的引用 peek 树**不走这个注册表（它的 DOM 由 Monaco 渲染，且 contribution 类用不了 React Hook），而是由 `apps/editor/src/renderer/contributions/PeekNavigationContribution.ts` 在每个 workbench document 的 window capture 上裁决：自行判定**裸** `h/j/k/l`（不带修饰键；Ctrl 形式不认领，回落全局含义），命中 `.ref-tree` 焦点、非可编辑元素且 `lastFocusedList` 的宿主包含该元素后，自己完成同一套三连吞键，再调树的 `focusNext/focusPrevious` / `onLeftArrow/onRightArrow` 并同步镜像 selection；和弦待定时整段放行。新增 Monaco 自有列表表面时照此办理，不要为它再造一个全局 dispatcher。

- **菜单是虚拟焦点**（`aria-activedescendant`），DOM 焦点仍在唤出它的树上，所以不能每个组件各挂一个 window 监听——`stopPropagation` 不会阻止同一 target 上的其它监听器，两层会同时移动。
- `list` 层默认 `focus: 'self'`（容器自身是 `activeElement`）且拒绝 editable 焦点；`overlay` 默认 `focus: 'within'`；`dialog` 可用 `allowEditableFocus`（复选框对话框）。层的 `directions` 每次按键从 `optionsRef` 读取，可随渲染增减，不需要重新注册。现在只有 Agent 配置栏触发器行仍以 `kind: 'list'` 注册（`left`/`right`）。
- 接入点（**只有输入框型 picker / 菜单 / 对话框 / 配置栏**）：`useOverlayListNavigation`（overlay，快速打开 / 选择器 / 弹窗列表）、`Select`（overlay）、`useMenuNavigation` 与扩展「更多」菜单（menu）、`PerforceGraphSyncDialog`（dialog，`allowEditableFocus`）、`PromptInput` 建议弹窗（overlay）、Agent 配置栏触发器行（list，仅 `left`/`right`）。**纯列表 / 树不接入**：Tree（Explorer / Search / Scm / Outline / Timeline 等）、FlatList（设置 / 快捷键 / 扩展分区 / 会话 / 触发器 / MCP / Process Explorer 等）、Git·Perforce 图谱、ChatBody 时间线都只用 `useVimSurface`（裸键）与各自的方向键处理。Outline 的方向导航只保留用户可绑定的 `outline.navigate.*` 命令，**无默认键位**。
- QuickInput 不走注册表：锁定 / readOnly / 松开修饰键即接受的语义只有面板自己知道，J/K 别名（Ctrl/Alt/裸键三种形态）在 `QuickInputPanel` 内处理，`isQuickInputOwnedKey` 负责让 dispatcher 放行。`Ctrl+P/N` 不再放行：dispatcher 的 `quickInputVisible` 分支会解析到全局命令后 `preventDefault + stopPropagation`，但只执行 Escape，因此既不移动面板，也不会打开 Quick Open / New File。
- **Esc 逃生口**：`FocusActiveEditorGroupAction` 不要加 `hasActiveEditor` precondition。焦点在侧栏 / 面板的列表或树时，用户仍要靠 `Esc` 把焦点移回编辑区；空编辑区且焦点在视图里（`focusedView` 非空）时也必须能匹配（标题栏菜单 / 下拉保留自己的 Esc）。无编辑器时直接聚焦始终渲染的 `editor-group-body`——`editor-area` Part 根没有 tabIndex，`focusPart` / `Part.focus()` 只记账、不搬 DOM 焦点。

## Vim 模式：Normal 模式的按键归属

`vim.enabled` 打开后，Normal 模式的裸键必须先于全局 dispatcher 被认领，否则 `d` 会触发删除、`p` 会打开 Quick Open 之类。机制、surface API 与排障见 [Vim 模式](vim-mode.md)，这里只列会静默失效的判据：

- **唯一 window-capture 入口**是 `packages/workbench-ui/src/keybinding/ctrlNavigationRegistry.ts`：先仲裁菜单 / 浮层 / 对话框 / 配置栏的 `Ctrl+J/K/H/L` 别名（`menu > dialog > overlay > list`），其余交给 `setVimKeyHandlerProvider` 注入的 `VimDispatcher`。不要在组件里另装 window 监听。
- **活跃 surface** 由 `getActiveVimSurface` 按 `menu > overlay > list > terminal > editor > chrome` 解析。编辑器 Normal 下把 `handleStroke` 交给 `vimEditorController`，只有 leader 与已在途的序列例外（走共享序列引擎）。**不要用 `editor.addCommand`**——standalone Monaco 的 keybinding service 跨实例共享，会吞掉其它编辑器的键。
- **必须让行的六种情况**：chord pending、模态对话框（`[data-renderer-dialog]`）、Quick Input（`quickInputVisible`）、IME 组合、Webview 焦点、普通可编辑控件（editor / terminal 除外）。非保留键存在 weight ≥ `User` 的键位时 Vim 也让行；保留集由 `vim.reservedKeys` 配置。
- **`Ctrl+H/J/K/L` 不走 Vim**：Normal 下菜单 / 浮层 / 对话框 / 配置栏仍把它们当方向别名，纯列表 / 树保持全局含义；Vim 只认领 `Ctrl+F/B/D/U`。Insert 模式完全放行。
- **上下文键**：`vimMode` / `vimNormalMode` / `vimEnabled` / `vimSurface` / `vimSurfaceId` / `vimTerminalNormalMode` 由 `IVimModeService` 写；`vimNormalMode` 同时是全局分发器 paging 安全网的放行条件。状态栏 `vim-mode` 条目只在有活跃 surface 且 `vim.showStatusBar` 开启时存在。
- **IME 与 Vim 搜索**：Normal 模式切英文输入法的实现（窗口级共享状态、`vim.autoSwitchInputMethod`）与 `/ ? n N` 搜索框的 `vimSearchFocused` / sticky scroll / 大小写优先级，见 [Vim 模式](vim-mode.md) 与 `workbench/editor/vim/` 目录内实现。

## 焦点类上下文键：一律 DOM 派生

**全局键盘守卫**：`apps/editor/src/renderer/workbench/useGlobalKeybindingHandler.ts` 有一道「无 ctrl/alt/meta 的裸字符键与 Delete/Backspace 保留给文本面」的守卫，判据 `isEditableTarget(target) || editorTextFocus === true || acpPromptInputFocused === true`（inTextSurface / isPrintableTyping / isNativeEditing 三处，紧挨 chord 分支）。任一 key 残留 true，即便 registry 已解析出 `EXECUTE` 也会被吞。**签名症状**：`Ctrl+F` 正常、`runCommand` 正常、裸字母（如 markdown 预览 link hints 的 `f`）无反应。

**残留根因（记账型焦点键的通病）**：早期 `editorTextFocus` 只由 Monaco 的 `onDidFocusEditorText` / `onDidBlurEditorText` 维护，FileEditor 卸载时 cleanup **先 dispose blur 订阅、再 dispose 编辑器** → blur 永不触发 → key 永久 true。修法是 `services/editor/editorFocus.ts` 的 `syncEditorFocusContext`：焦点不在任何 `.monaco-editor` 内时 `editorTextFocus` 定义上不可能为 true，顺手 `set(false)`——**只清不设**，text/widget 区分仍归 Monaco。**通则**：任何非 Monaco 编辑器（含 `EditorInput` 覆写的 `focus()`）落地后都必须 sync 焦点 context key，否则从 Monaco 切过来会带着 stale 值。

**设计定论：焦点类 context key 一律从 DOM 派生，禁止任何「由事件记账」的布尔键。** `editorFocus`（`installEditorFocusDerivation`）与逐 Part 布尔键 + `focusedPart` / `focusedView` / `terminalFocus`（`services/focus/documentFocusReconcile.ts` 的 `installDocumentFocusReconcile`：`focusin` 同步重算 / `focusout` 合并成一次 `setTimeout(0)`）皆然——新增嵌入 Monaco **不要再补 `editorFocus` bridge**。唯一保留的记账是 `part.onDidFocus` 作 intent：editor-area / activity-bar / status-bar 三个 Part 根没有 `tabIndex`，`Part.focus()` 的 `container.focus()` 在真实浏览器里是 DOM no-op，F6 / 启动恢复 / `focusPart` 兜底全靠它；**新增 Part 根若指望 `Part.focus()` 真把 DOM 焦点搬过去，必须补 `tabIndex={-1}`**。`focusedPart` 取值是 `PartId`（如 `sideBar`），不是 testid 后缀。挂载在 `contributions/FocusContextKeyContribution.ts`，回归见 `FocusContextKeyContribution.test.ts`。

**多窗口下的「聚焦」还要限定文档**：辅助编辑器窗口有独立 Document，而失去 OS 焦点的文档会保留最后的 `activeElement`。逐 Part 布尔键因此不能只问 `part.isFocused()`（它读容器自己的 `ownerDocument`），还必须要求该文档就是当前 active workbench document——`services/focus/partFocus.ts` 的 `isPartFocusedInActiveDocument` 是唯一入口，toggle 类命令（`Ctrl+Shift+E` 等）与 `FocusContextKeyContribution` 都走它。只读主文档或只看 `isFocused()` 都会在辅助窗口操作时把后台主窗口的侧栏误判为"仍聚焦"。

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

## 点击修饰键（调用手势）

状态栏 / 标题栏按钮 / 右键菜单 / 菜单栏这些通用入口只会 `executeCommand(id, 固定参数)`，不知道命令签名，所以点击的 Ctrl/Alt 以**环境值**传递：点击处用 platform 的 `runWithInvocationModifiers(e, () => executeCommand(...))` 包一层（目前接入：`StatusBar`、`ViewTitleActions`、SCM `ActionButton` 与标题栏溢出菜单、`TitleBarDropdown`、`TimelineView` 行内图谱按钮、workbench-ui 菜单行与通知按钮、页面内直接 `executeCommand` 的打开按钮；命令面板把 accept 时的 `picker.keyMods` 换成环境值，`command:` 链接由 `CommandOpener` 把 `openToSide` / `openInNewWindow` 换成 Ctrl / Alt；新增的点击入口要自己包），命令里用 `invocationOpenTarget()`（`apps/editor/src/renderer/services/editor/openTarget.ts`）读出落点。

**与 accessor 同一条寿命**：只在 handler 同步段有效（`CommandService` 同步调用 handler），首个 `await` 前必须读完；也**不跨扩展宿主 RPC**——经扩展转发的命令改走显式 `{ openTarget }` 尾参数约定。打开单例编辑器统一走 `openWithTarget.ts` 的 `openSingletonEditor`（已开的移动、不复制；只需 pinned 打开的用 `openPinnedSingletonEditor`），文件类（settings.json、日志等）走 `openUriEditor`（落点打开副本，需定制 input 如只读时传 `createInput`）；两者在 `default` 或落点失败时回退调用方给的原有打开逻辑。直接拿得到事件的组件（如 `ResourcePreviewButton`）不必绕环境值，`resolveOpenTarget(e)` 即可。

**菜单里的键盘手势**：`ContextMenu` / `ListMenu` 的 `useMenuNavigation` 对 `isModifiedEnter(e)`（Ctrl/Meta/Alt+Enter，永不带 Shift）做模态处理——有高亮项时用 `runWithInvocationModifiers(e, row.run)`（与点击同义，菜单先关再执行），高亮子菜单只展开，无高亮 / 行失效 / disabled / `repeat` 一律 `preventDefault + stopPropagation` 吞掉，绝不下漏到打开菜单的树/列表。`isModifiedEnter` 与 `isOpenTargetEnter` 定义在 `packages/platform/src/command/invocationModifiers.ts`，Tree / FlatList / 菜单共用；后者额外过滤 auto-repeat（长按不重复打开）。**扩展命令跨 RPC 看不到环境值**，宿主必须显式转发：SCM 行按 `SCM_TARGETED_OPEN_COMMANDS` 白名单追加 `{ openTarget }`（不能按 `1_open` 分组推导——`perforce-graph.viewFileHistory` 同组但不收 options；p4 shelved 行用 `resource.command.arguments` 而非资源 DTO），Timeline 菜单用 `executeCommand` override 把行自己的 openDiff 命令还原成 `command.arguments[0]`，其余菜单项仍收整个 item。新增扩展打开命令若要支持落点，handler 需接受 `(arg, options)`。renderer Action2 侧已收口 `ScmOpenFileAction`、`OpenChangesAction`、`FindMarkdownFileReferencesAction`（新窗口成功时跳过跨窗口不可达的 peek）、`ReopenWithAction`（fresh input + 关闭旧 tab）、`Compare with Selected` / `Compare Selected`。

## 扩展命令与 renderer Action2 的同名遮蔽

内置扩展（git / perforce）贡献到 scm/title 菜单、但 handler 在 **renderer Action2** 的命令（如 `git-graph.view` / `perforce-graph.view`），**绝不能**再写进扩展 `package.json` 的 `contributes.commands`。

**机制**：`contributes.commands` 会在扩展宿主侧注册一个**同名、无 handler** 的命令；执行时它胜出并遮蔽 renderer Action2——`executeCommand` **静默返回 undefined、不抛错**、编辑器不打开：「命令成功」却什么都没发生。

**做法**：只在 `contributes.menus`（scm / title 等）里写该命令项，菜单项自带 `icon` 即可显示图标、title/tooltip 由 Action2 提供（对照 git 扩展：`git-graph.view` 只出现在 menus）。细节与排查手法见 skill `create-extension`。

## 扩展的上下文键（`setContext`）与命令可见性三层

扩展写上下文键走 VSCode 的公开命令字面量 **`setContext`**（`SetContextAction`，`apps/editor/src/renderer/actions/extensionApiActions.ts`；同时登记在 `MainThreadCommands` 的 `HOST_INVOKABLE_BUILT_INS`，因为扩展宿主只能调 `_workbench.*` 或逐个登记的内建）。写入的域是 **root context key service**——菜单 `when` 走 per-group scoped ctx 而它继承 root，两边都能读到。

**键不会自动回收**：`setContext` 写下的值随窗口存活，下一次激活（宿主因工作区切换而重启）读到的是上一次留下的值。所以写两态是扩展自己的责任：`activate()` 里**先无条件写 `false`、再在条件满足处写 `true`**（perforce 的 `perforceHasWorkspace` 即此形态，`extensions/perforce/src/extension.ts` 顶部——写在任何提前返回之前）。

同一形态的第二个例子是 git 的 `gitHasRepository`：`activate()` 顶部无条件写 `false`，`setupRepositories()`（初始扫描或 `.git` 迟到检测）之后写 `true`。它演示的是「键在窗口生命周期内会翻转」的版本——仓库只会增加，所以只有 `false → true`；工作区切换会重启扩展宿主，而 renderer 的 root context 不随宿主重启清空，靠的仍是 `activate()` 顶部那次无条件 `false`。新增 git 命令时必须同时补 `contributes.menus.commandPalette` 显式条目（`when: gitHasRepository`；需要参数/探针的命令用 `when: false`），清单测试会直接失败。

**每个键要有一个「谁写它」的单一事实源**：同一个键被两处写就会出现「谁最后写谁赢」的静默覆盖。写入的动作本身按 VSCode 语义把 URI 值转成字符串（`when` 只能比字符串）。

命令可见性分三层，**不要混用**：

| 层       | 作用                   | 手段                                                                                                                                                                         |
| -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 引擎注册 | 命令能否被执行         | `contributes.commands` 在 renderer 注册 bootstrap proxy（宿主查不到 handler 也**不**从前端隐藏，执行时才由宿主 reject）                                                      |
| 面板可见 | 命令是否出现在命令面板 | `contributes.menus.commandPalette` 的 `when`（**显式条目**才会取代翻译期的隐式无 `when` 条目）。本仓没有实现 VSCode 的 `commands[].enablement`，面板里唯一能收窄的旋钮就是它 |
| 快捷键   | 何时触发               | `contributes.keybindings` 的 `when`                                                                                                                                          |

「这个命令在本窗口无意义」要落在**第二层**（隐藏），只在第一层拦是拦不住的——面板照列、点了报错。反例与完整叙事见 `extensions/perforce/CLAUDE.md` 的可见性红线。

## 为什么单测守不住

菜单 `when` 走 per-group scoped ctx、keybinding 与 `precondition` 走 root ctx，而面板的求值时刻（焦点已被抢走）在单测里无法如实复现——手搓的 `ContextKeyService` 只能证明表达式本身对不对，证明不了"那一刻真实产物的取值"。这类分裂**只有 e2e 能守住**，参考 `apps/editor/e2e/specs/smoke.acpSideTask.spec.ts`（断言面板打开时该行可见/不可见）。

相关：`apps/editor/CLAUDE.md`「常见踩坑」的 ContextKey 求值域条目；skill `fix-keybinding-not-firing`。
