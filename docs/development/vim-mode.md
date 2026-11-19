# 全局 Vim 模式

> 用户可见键位与配置见 [用户文档 · 全局 Vim 模式](../../docs/user/zh-CN/reference/editor-shortcuts.md#全局-vim-模式可选默认关闭)。本文面向改动分发器、新增 surface 或排查「按键被谁拿走」的开发者。

## 定位

Vim 模式是**工作台级**能力，不在 Monaco 内注册原生命令，也不依赖扩展。所有第一方界面以「surface」接入同一套状态与分发：

- `vim.enabled` 是总开关；`vim.surfaces.*` 按界面组关闭。
- Normal 模式的按键映射为**命令 id**，经 `ICommandService.executeCommand` 执行，因此命令面板、用户键位与扩展看到的是同一套命令。
- 唯一入口是 `packages/workbench-ui/src/keybinding/ctrlNavigationRegistry.ts` 的 window-capture 监听；各 surface 只注册声明，不自行安装监听。

## 分层与文件

| 文件 | 职责 |
| --- | --- |
| `packages/workbench-ui/src/keybinding/vim/vimTypes.ts` | surface kind / mode、`IVimKeymapEntry`、`IVimSurfaceActions`、`vimKeyToken()`（Vim 键 token 规范化） |
| `packages/workbench-ui/src/keybinding/vim/vimSequence.ts` | 纯序列引擎：计数、多段前缀、`Esc` 取消、歧义前缀延迟执行；无计时器 |
| `packages/workbench-ui/src/keybinding/vim/vimSurfaceRegistry.ts` | surface 注册表、`useVimSurface` / `registerVimSurface` / `getActiveVimSurface`、每 surface 一个序列引擎 |
| `packages/workbench-ui/src/keybinding/vim/vimSurfaceId.ts` | `useVimSurfaceKey`：稳定 / 自动 surfaceKey |
| `packages/workbench-ui/src/keybinding/vim/navigationLayers.ts` | Ctrl 别名与 Vim 共用的「谁拥有这一击」仲裁（激活判断、嵌套优先、后挂载优先） |
| `packages/workbench-ui/src/keybinding/vim/vimDefaultKeymap.ts` | 内置键位表（只写命令 id，不写实现） |
| `packages/workbench-ui/src/keybinding/ctrlNavigationRegistry.ts` | 每 Document 唯一 window-capture 监听；先仲裁 `Ctrl+J/K/H/L` 别名，再调用 Vim provider |
| `apps/editor/src/renderer/services/vim/vimModeService.ts` | 配置读取、per-surface 模式记忆、context key、状态栏条目、有效 keymap 合并、保留集 |
| `apps/editor/src/renderer/workbench/vim/vimDispatcher.ts` | 纯决策类：这一击是否归 Vim、归哪个 surface、执行哪条命令 |
| `apps/editor/src/renderer/workbench/vim/useVimDispatcher.ts` | 把 dispatcher 装成 provider，按 Document 隔离并维护 focus 事件 |
| `apps/editor/src/renderer/workbench/vim/vimDebugFormat.ts` | Keyboard Shortcuts Troubleshooting 的 Vim trace 格式 |
| `apps/editor/src/renderer/actions/vimActions.ts` | `workbench.action.toggleVimMode`、`workbench.action.vim.showActiveKeymap` |
| `apps/editor/src/renderer/actions/vimSurfaceActions.ts` | `list.*` / `surface.*` 通用命令，转发到活跃 surface 的 actions |
| `apps/editor/src/renderer/actions/focusSurfaceActions.ts` | 聚焦侧栏 / 底栏 / 辅助侧栏 / ActivityBar / 标签栏 / 容器标题 |
| `apps/editor/src/renderer/actions/terminalNormalActions.ts` | 终端 Normal 的进入 / 退出 / 滚动 / 选择 / 复制命令 |
| `apps/editor/src/renderer/workbench/panel/terminal/terminalNormalMode.ts` | 终端 Normal 状态机（视口滚动 + 按行选择） |
| `apps/editor/src/renderer/services/terminal/terminalNormalModeRegistry.ts` | 当前持有焦点的终端 controller 注册表 |

## 唯一入口与分发顺序

`ctrlNavigationRegistry` 在 `window` 的 **capture** 阶段收键。顺序固定：

1. `event.defaultPrevented`、IME 组合（`isComposing || keyCode === 229`）、`keybindingChordPending(doc)` 为真 → 直接放行。
2. `ctrlNavigationDirection(event)` 命中 `Ctrl+J/K/H/L` → 按 `menu > dialog > overlay > list` 选出唯一一层并消费；**不再进入 Vim**。这四键永不归 Vim。
3. 否则调用 `setVimKeyHandlerProvider` 注入的 provider（由 `useVimDispatcher` 安装）。provider 返回 `true` 时，注册表执行 `preventDefault + stopPropagation + stopImmediatePropagation`。

`VimDispatcher.dispatch` 的判断顺序（改代码时不要随意换序）：

1. `defaultPrevented` / IME / chord pending → 放行。
2. `vim.enabled` 关闭 → 放行。
3. Webview：`activeElement` 是 `IFRAME`，或位于 `[data-vim-surface="webview"]` 内 → 放行。
4. `[data-renderer-dialog]` 存在 → 放行。
5. `quickInputVisible` 为真 → 放行。
6. `getActiveVimSurface(doc)` 解析当前 surface；`isSurfaceEnabled(kind)` 为假 → 放行。
7. 读取该 surface 的模式并上报 `IVimModeService.activateSurface`（写 context key、状态栏）。
8. 终端且模式不是 `terminal-normal` → 放行（终端默认 Insert，按键属于 shell）。
9. Insert：编辑器只处理 `Esc`（交给编辑器 Vim 内核）；其它 surface 的 `Esc` 写回 `normal` 并消费，其余放行。
10. 非 editor / terminal 的 surface：焦点在可编辑元素上 → 放行（搜索框、行内输入框保留按键）。
11. **User 让行**：非保留键且 `KeybindingsRegistry.hasBindingAtOrAbove(key, KeybindingWeight.User, ctx)` 为真 → 放行，并写 trace。
12. 编辑器：leader 或已有待定序列走共享序列引擎；其余 Normal 键交给 `handleStroke`（编辑器 Vim 内核）。
13. 其它 surface：用有效 keymap 喂该 surface 的序列引擎 → `cancel` / `pending` / `execute` / `none`；`execute` 时执行 `command` 并带 `{ count }`，`none` 时按 `vim.passThroughUnmappedKeys` 与 surface kind 决定吞键或放行。

surface 仲裁优先级（`vimSurfaceRegistry.ts` 的 `KIND_PRIORITY`）：`menu(8) > overlay(7) > list(6) > terminal(5) > editor(4) > tabs/activityBar/viewContainerTabs(3)`。同 kind 取嵌套更深者，再取后挂载者。菜单以虚拟焦点工作，注册后**始终 active**，因此零行菜单必须用 `enabled: false` 卸下。

## Surface 注册 API

```ts
import { useVimSurface, useVimSurfaceKey } from '@universe-editor/workbench-ui'

const surfaceKey = useVimSurfaceKey('list', 'my-view')
useVimSurface({
  id: surfaceKey,
  kind: 'list',
  focus: 'within',
  getElement: () => containerRef.current,
  getSurfaceKey: () => surfaceKey,
  defaultMode: 'normal',
  actions: {
    move: (direction, count) => { /* ... */ },
    first: (count) => { /* ... */ },
    activate: (count, preview) => { /* ... */ },
  },
})
```

`IVimSurfaceRegistration`：

| 字段 | 说明 |
| --- | --- |
| `id` | 诊断 / context key 用的 id；常与 surfaceKey 相同 |
| `kind` | `editor` / `list` / `menu` / `overlay` / `tabs` / `activityBar` / `viewContainerTabs` / `terminal` / `webview` |
| `getElement` | 在**击键时**读取宿主元素；callback ref 后挂载也能生效 |
| `focus` | `self`（默认给 list/tabs/activityBar/viewContainerTabs）要求容器自身是 `activeElement`；`within` 接受后代焦点 |
| `getSurfaceKey` | 在击键时解析实例键，用于模式记忆与 trace |
| `enabled` | 为 `false` 时保持注册但不参与仲裁（菜单零行、关闭的标题栏） |
| `defaultMode` | `normal` / `insert` / `terminal-normal`；无记忆时的初始值 |
| `actions` | 可选操作集合；未实现的命令会静默 no-op（但仍被消费） |

`registerVimSurface` 是给非 React 调用方的同义入口（如终端实例）；React 侧一律用 `useVimSurface`，它会通过 ref 读取最新注册，避免每次渲染重注册。

`IVimSurfaceActions` 字段：`move(direction,count)`、`first(count)`、`last(count)`、`page(direction,count)`、`expand/collapse/toggle(count)`、`activate(count,preview)`、`contextMenu/copy/remove(c)`、`next/previous(count)`、`escape(count)`，以及编辑器专用的 `handleStroke(event)`。

### 新增 surface 的步骤

1. **选 kind**：能复用 `list` / `menu` / `overlay` 就不要新增 kind。新增 kind 需要同时改 `VimSurfaceKind`、`KIND_PRIORITY`、`defaultFocus`、`IVimModeService.isSurfaceEnabled`（以及是否暴露 `vim.surfaces.*` 开关）。
2. **定 surfaceKey**：有稳定视图 id 用 `useVimSurfaceKey(kind, id)`；实例级用 `useVimSurfaceKey(kind)`（自动键）。关闭 / 销毁后需要重新从默认模式开始时才调用 `vimModeService.forgetSurface(key)`。
3. **实现 actions**：只实现该 surface 真正支持的操作。`left/right` 在树里表示折叠 / 展开进子级，在标签栏表示前后切换，在浮层由宿主定义。
4. **注册**：`useVimSurface` 的 `focus` 按「容器是否自己持有 tabIndex」选择；可编辑控件要留在里面的列表用 `within`。仲裁对非 editor / terminal surface 默认拒绝 editable 焦点，dispatcher 的 editable guard 是第二道防线。
5. **补 keymap**：通用键位加进 `vimDefaultKeymap.ts`；只对某视图生效的键用 `when: "vimSurfaceId == 'list:my-view'"`（设置页的 `/`、Chat 的 `i/a/e` 是范例）。
6. **补命令**：新的 action 需要命令 id 时，在 `vimSurfaceActions.ts` 或对应域 actions 中注册，命令体里从活跃 surface 的 `actions` 转发。
7. **测试**：workbench-ui 适配器测试 + 对应界面测试；涉及跨进程状态时补 e2e。

## Keymap 结构与 `when` 优先级

`IVimKeymapEntry`：`{ id, keys, command, args?, when?, surfaces? }`。

- `keys` 是 **Vim token**，由 `vimKeyToken()` 生成：可打印键保留大小写（`g` 与 `G`）、特殊键转小写名（`escape` / `enter` / `ctrl+d`），带修饰键时拼成 `ctrl+alt+...`。不要用 keybindings.json 的写法（`shift+g`）写 Vim 键位。
- 多段 token 即序列：`['g','g']`、`['<leader>','e']`。`<leader>` 在 `VimModeService.getEffectiveKeymap` 里替换为 `vim.leader`（默认 `space`）。
- `surfaces` 省略时条目在所有 kind 可见。编辑器实际只把 leader 与已开始的序列送进共享引擎，所以裸编辑器键仍由 `vimEditorController` 的内核处理。
- 序列引擎接受 `1`–`9` 起头的计数、`0` 续接计数；`Esc` 取消待定状态。`z` 等「既完整又是更长前缀」的键延迟到下一击或 `vim.sequenceTimeoutMs` 超时再执行。
- **三段及以上的歧义序列**：`a` / `ab` / `abc` 同时存在时，引擎只保留**最近一层**的完整匹配作为超时回退。依次按 `a`、`b` 后停在 `ab`：此时超时（或下一个不延续前缀的键）执行 **`ab` 的命令**；若继续按 `c` 则执行 `abc`。更早的 `a` 不会在超时后补发——待定分支始终是当前最长前缀，回退目标是这条分支上最后一个既完整又是前缀的条目。
- `runMatches` 会先尝试带 `when` 的条目，再尝试默认条目，取第一条匹配；因此同一键的「视图专用含义」不会被注册顺序遮蔽。所有候选都不匹配时**消费但不执行**。
- 用户 `vim.keymap` 在服务里按 `id` 覆盖内置条目、其余追加；编辑器内核的 Normal 键不受该表覆盖。

## User 让行与保留集

`VimDispatcher` 用 `buildKeyString(event)` 得到 keybindings.json 形态的键串，然后调用：

```ts
KeybindingsRegistry.hasBindingAtOrAbove(
  keyString,
  KeybindingWeight.User,
  contextKeyService,
)
```

该函数按首键做桶索引（热路径不扫全表），忽略 negated 条目，检查 `when` 与二段 chord；weight ≥ 1000（`User`）才让行。保留集来自 `vim.reservedKeys`：多字符 token 转小写、`<leader>` 先替换，编辑器与 surface 共用。默认保留 `escape`、`ctrl+[`、`i`、`a`、`:`、`/`、`?`、`<leader>`。

排查工具：`workbench.action.vim.showActiveKeymap`（**Vim：显示当前键位映射**）把当前 surface 的有效 keymap、用户覆盖、保留集、被 User 遮蔽的键写入 Output 的 **Vim Keymap** 通道。

## 上下文键

| key | 写入方 | 含义 |
| --- | --- | --- |
| `vimEnabled` | `IVimModeService` | 全局开关 |
| `vimMode` | `IVimModeService` | 活跃 surface 的 `normal` / `insert` / `''` |
| `vimNormalMode` | `IVimModeService` | 活跃 surface 是否处于普通 Normal（终端 Normal 为 false，由 `vimTerminalNormalMode` 表示） |
| `vimSurface` | `IVimModeService` | 活跃 surface 的 kind |
| `vimSurfaceId` | `IVimModeService` | 活跃 surface 的 id（用于 `when`） |
| `vimTerminalNormalMode` | `IVimModeService` | 活跃终端是否 Normal |
| `vimSearchFocused` | `vimEditorController` | 编辑器 Vim 搜索框聚焦，Find 家族快捷键据此让行 |
| `webviewFocus` | `FocusContextKeyContribution` | 焦点在 iframe / webview 标记内 |

这些 key 在 `ContextKeyContribution` 预建、在 `knownContextKeys.ts` 登记，供 Keyboard Shortcuts 编辑器补全。`vimNormalMode` 同时是全局分发器 paging 安全网的放行条件。

## 模式记忆与 surfaceKey 约定

`IVimModeService` 用 `Map<surfaceKey, mode>` 保存**内存态**模式；`getMode(key, defaultMode)` 在无记录时返回默认值，`setMode` 触发 `onDidChangeMode` 并刷新活跃 surface 的 context key / 状态栏，`forgetSurface` 删除记录。焦点切换时 `useVimDispatcher` 调 `dispatcher.resetAll(doc)`：清掉待定计时器并把该文档所有 surface 的序列引擎归零，避免 `5` 或未完成的 leader 从列表带进编辑器。

约定：

| surface | surfaceKey |
| --- | --- |
| 编辑器 | `editor:${groupId ?? 0}:${inputId}`；同一文件两个分屏互不影响，关闭输入时 forget |
| 终端 | `terminal:${terminalId}`；默认 `insert`，终端在 panel / editor 间移动不重建键 |
| 列表 / 树 / 图谱 | `list:${viewId}`；无 id 时 `list:auto:<n>` |
| 菜单 | `menu:auto:<n>`（菜单短暂，通常无需记忆） |
| 浮层 | `overlay:${id}`，如 `overlay:notifications` |
| 编辑器标签栏 | `tabs:${groupId}` |
| ActivityBar | `activityBar` |
| 视图容器标题 | `viewContainerTabs:${location}` |

## 终端 Normal Mode

终端 surface 每个实例注册 `kind: 'terminal'`、`defaultMode: 'insert'`、`actions: {}`；实际行为由 `TerminalNormalModeController` 实现，controller 注册到 `terminalNormalModeRegistry`，命令按「当前 DOM 焦点所在的终端」找到它。

- 进入：`workbench.action.terminal.enterNormalMode`，默认 `ctrl+shift+space`，`when: 'terminalFocus'`。
- 状态：模式写进 `IVimModeService`（`terminal-normal`）；组件同步 `data-vim-normal`。
- 操作：`j/k` 行滚动、`Ctrl+D/U` 半页、`Ctrl+F/B` 整页、`gg/G` 边界、`v` 开始按行选择（`j/k` 扩展）、`y` 复制并退出。
- 退出：`i` / `a` / `q` / `Esc`。有选区时先清除选区并保持 Normal（`i/a/q/Esc` 都走同一个 `exitNormalMode`），再按一次才回到 shell；`dispose()` / 终端销毁时强制回 `insert` 并恢复输入法。
- 输入法：进入时按 `vim.autoSwitchInputMethod` 切英文；与恢复操作串行化，避免快速 `i` → 再进入时乱序。

## Webview

不做承诺：焦点在 iframe 内时，surface 仲裁不会命中工作台 surface；dispatcher 还会在 `activeElement` 为 `IFRAME` 或位于 `[data-vim-surface="webview"]` 子树时直接放行。`WebviewElement` / `HtmlPreviewEditor` 已加标记。不要再为 iframe 注入按键桥。

## 测试与 e2e

| 层 | 位置 |
| --- | --- |
| workbench-ui | `src/__tests__/vimSequence.test.ts`、`vimSurfaceRegistry.test.tsx`、`vimSurfaceAdapters.test.tsx`、`vimDefaultKeymap.test.ts`、`ctrlNavigationRegistry.test.tsx` |
| platform | `src/__tests__/command/keybindingRegistry.test.ts`（含 User 覆盖 / `hasBindingAtOrAbove`） |
| 服务 / 分发 | `services/vim/__tests__/vimModeService.test.ts`、`workbench/vim/__tests__/vimDispatcher.test.ts` |
| surface 适配 | `workbench/editor/__tests__/useEditorTabsVim.test.tsx`、`activitybar/__tests__/ActivityBar.vim.test.tsx`、`paneComposite/__tests__/PaneCompositeHeader.vim.test.tsx`、`preferences/__tests__/SettingsEditor.vim.test.tsx`、`gitGraph/__tests__/useGraphKeyboardNav.vim.test.tsx`、`terminal/__tests__/terminalNormalMode.test.ts` |
| 编辑器内核 | `workbench/editor/vim/__tests__/*` |
| e2e | `smoke.vimGlobal.spec.ts` / `smoke.vimPriority.spec.ts`（@p0）、`smoke.vimMode` / `smoke.vimTabs` / `smoke.vimTerminalNormal` / `smoke.vimSettings` / `smoke.vimWebview` / `smoke.vimChat`（@p1） |

e2e 通过 `window.__E2E__.runCommand('_workbench.updateConfiguration', 'vim.enabled', value)` 开关，并用 `getContextKey` / `getStatusBarEntries` / `getActiveEditorUri` 断言，不戳 Monaco 内部 DOM。

## 常见坑

- **xterm 的 textarea 是 editable**：终端默认 Insert；surface 仲裁对 `editor` / `terminal` 设了 `allowEditableFocus`，dispatcher 又在 editable guard **之前**处理终端分支。把终端分支挪到后面会让 Normal 完全不生效。
- **带 `when` 的普通键位同键要加 weight**：这是 keybinding 注册表的通用规则（weight 高者优先，`when` 只过滤）。Vim keymap 的 `when` 排序是 dispatcher 内部逻辑，两者不要混为一谈。
- **`Action2.run(accessor)` 不能跨 await**：Vim 命令大多通过 `getActiveVimSurface(...)` 直接取 action，或在首个 await 前把 service 快照取完；新增异步命令照此办理。
- **浮层宿主必须提供 `onEscape`**：`surface.escape` 会被 dispatcher 消费；`useOverlayListNavigation` 只把 Escape 转给宿主的 `onEscape`，没给就等于「按 Esc 什么都没发生」。
- **菜单零行必须 `enabled: false`**：菜单以虚拟焦点常驻，否则空菜单也会抢走方向键 / Vim 键。
- **不要新增 window 监听**：同一表面注册多个 capture 监听会让一次按键移动两次（`stopPropagation` 挡不住同 target 的其它监听）。只注册 surface。
- **编辑器不要用 `editor.addCommand`**：standalone Monaco 的 keybinding service 跨实例共享，会吞掉其它编辑器的键；编辑器 Vim 内核走 `handleStroke`。
- **editable guard 是刻意让行**：树 / 列表里的搜索框、行内输入框必须能正常打字；只有 `editor` / `terminal` 例外。
- **surfaceKey 必须稳定**：使用自动键的组件每次挂载都是新实例；需要跨卸载记忆的视图必须传稳定 id，并在真正该重置时 `forgetSurface`。
- **Ctrl 别名优先级**：`Ctrl+J/K/H/L` 在到达 Vim 前已被 `ctrlNavigationRegistry` 消费；因此 surface 聚焦期间 `Ctrl+K` 和弦不可用，这是设计代价。
- **模式是内存态**：重启不保留；不要把它当用户设置持久化。
- **多窗口**：provider 按 Document 隔离，`Workbench.tsx` 与 `AuxiliaryWindowHost.tsx` 各装一份 `useVimDispatcher`；新增窗口宿主也要装。

## 相关

- [命令、快捷键与上下文键](commands-and-context-keys.md)
- [浮层层级与裁剪](overlay-layers.md)
- [嵌入 Monaco](monaco-embedding.md)
