# 全局 Vim 模式

> 用户可见键位与配置见 [用户文档 · 全局 Vim 模式](../user/zh-CN/reference/editor-shortcuts.md#全局-vim-模式可选默认关闭)。本文面向改动分发器、编辑器 Vim 内核、新增 surface / 键位，或排查「按键被谁拿走」的开发者。

## 定位

Vim 模式是**工作台级**能力，不在 Monaco 内注册原生命令，也不依赖扩展。所有第一方界面以「surface」接入同一套状态与分发：

- `vim.enabled` 是总开关；`vim.surfaces.*`（`lists` / `menus` / `overlays` / `tabs` / `activityBar` / `terminalNormalMode` / `editor`）按界面组关闭。`lists` 同时管 `list` 与 `reader`（Markdown 预览）。
- 工作台 surface（列表 / 菜单 / 标签栏 / 终端…）的 Normal 键映射为**命令 id**，经 `ICommandService.executeCommand` 执行，因此命令面板、用户键位与扩展看到的是同一套命令。
- **编辑器文本是例外**：裸键由编辑器 Vim 内核（reducer + controller）直接处理，不进键位表；只有 leader 与已开始的序列走工作台序列引擎。
- 唯一入口是 `packages/workbench-ui/src/keybinding/ctrlNavigationRegistry.ts` 的 window-capture 监听；各 surface 只注册声明，不自行安装监听。

## 分层与文件

### workbench-ui（`packages/workbench-ui/src/keybinding/`）

| 文件 | 职责 |
| --- | --- |
| `vim/vimTypes.ts` | surface kind（含 `reader`）/ mode、`IVimKeymapEntry`（含 `scope: 'surface'`）、`IVimSurfaceRegistration`（含自带 `keymap`）、`IVimSurfaceActions`、`vimKeyToken()`、`describeInvalidVimToken()`（`vim.keymap` 的 token 校验） |
| `vim/vimSequence.ts` | 纯序列引擎：计数、多段前缀、`Esc` 取消、歧义前缀延迟执行；无计时器 |
| `vim/vimSurfaceRegistry.ts` | surface 注册表、`useVimSurface` / `registerVimSurface` / `getActiveVimSurface`、每 surface 一个序列引擎；`useVimSurfaceKeymap` / `registerVimSurfaceKeymap`（按 surface id 挂 sidecar 键位） |
| `vim/vimSurfaceId.ts` | `useVimSurfaceKey`（稳定 / 自动 surfaceKey）、`vimSurfaceKeyFor(kind, id)` |
| `vim/navigationLayers.ts` | Ctrl 别名与 Vim 共用的「谁拥有这一击」仲裁（激活判断、嵌套优先、后挂载优先） |
| `vim/vimDefaultKeymap.ts` | **通用导航**键位表：只含 `list.*` / `surface.*` 命令（列表、菜单、浮层、reader、标签栏、ActivityBar、视图容器标题）。应用命令不在这里 |
| `vimIndexActions.ts` | `createIndexListVimActions`（纵向列表 / 树 / 浮层）、`createStripVimActions`（横向标签条）、`resolveVimGotoIndex`：统一 `first/last/move/page/scrollViewport` 与 count 语义，各适配器不再各写一份 |
| `ctrlNavigationRegistry.ts` | 每 Document 唯一 window-capture 监听；先仲裁菜单 / 浮层 / 对话框 / 配置栏的 `Ctrl+J/K/H/L` 别名，再调用 Vim provider |

### 应用侧（`apps/editor/src/renderer/`）

| 文件 | 职责 |
| --- | --- |
| `services/vim/vimAppKeymap.ts` | **应用键位表**：全局导航（`Ctrl+O/I` → `goBack/goForward`，`surfaces` 含 `editor` 在内的全部 Normal surface，菜单 / 浮层除外；编辑器位置与 view 焦点共享一条跳转栈，见[焦点位置与导航历史](#焦点位置与导航历史)）、leader 链（含 `<leader>?` 速查表、`<leader>w` 的 `h/j/k/l` 走 `workbench.action.navigate*`：先组间、到边缘再跨 part、再按屏幕方位进入该方向的辅助窗口（回主窗口时按 Part 方位落到最近的侧栏/视图）、`H/J/K/L` 标签迁移、`s/v` 拆分、`c` 关闭组）、编辑器 leader 别名（`surfaces: ['editor']`）、终端 Normal、Chat 时间线（`when: acpChatFocused`）、对比编辑器 `]c`/`[c`、编辑器 / 列表的 `Alt+J`/`Alt+K` 单和弦。键位的命令 id 一律写这里或 workbench-ui 通用表 |
| `services/vim/vimCoreKeymap.ts` | 编辑器内核 bracket 命令目录：`]d` `[d` `]c` `[c` 的 id / keys / command 单一真相。`workbench/editor/vim/vimKeymap.ts` 据此生成前缀表，`vimModeService` 据此注册可被 `vim.keymap` 覆盖的 id |
| `services/vim/vimSurfaceKeymaps.ts` | 只有某个视图自己认的键（设置页 / 快捷键编辑器 / Git 与 Perforce 图谱的 `/`），配合 `useVimSurfaceKeymap`；同时是 `vim.keymap` 校验用的「已知内置 id」目录 |
| `services/vim/vimKeymapMerge.ts` | 纯函数：`parseUserKeymap`（解析 + 校验 `vim.keymap`）、`mergeVimKeymap`（通用表 + 应用表 + surface 自带 + 用户覆盖 / 追加 / 解绑 → 某 kind 的有效键位） |
| `services/vim/vimModeService.ts` | 配置读取、per-surface 模式记忆、编辑器 Visual 子模式、context key（`vim*`）、状态栏条目（模式文字 + pending / Unsupported 反馈）、有效 keymap 缓存、保留集、which-key 状态 |
| `services/vim/vimKeyFormat.ts` | token → 显示文字（`space`→`<Space>`、`ctrl+d`→`<C-d>`），供状态栏 / which-key / 速查表 |
| `services/vim/vimCheatSheet.ts` / `vimCommandTitle.ts` | 速查表的分组与行格式化（纯函数）；命令 id → 展示标题 |
| `workbench/vim/vimDispatcher.ts` | 纯决策类：这一击是否归 Vim、归哪个 surface、执行哪条命令；计时器、which-key 调度（工作台引擎与编辑器内核共用同一浮层、延迟与归属） |
| `workbench/vim/useVimDispatcher.ts` | 把 dispatcher 装成 provider，按 Document 隔离并维护 focus 事件 |
| `workbench/vim/vimWhichKeyItems.ts` / `VimWhichKey.tsx` | which-key 的候选计算（纯函数）与浮层（`Workbench.tsx` 挂载，pointer-events none，不抢键） |
| `workbench/vim/vimImeCoordinator.ts` | 非编辑器 / 非终端 surface 的输入法自动切换（Normal→英文，离开归还）；跟踪所有工作台窗口的焦点（窗口失焦释放、回焦重新声明，多窗口）；由 `VimModeContribution` 创建 |
| `workbench/vim/webviewFocus.ts` | `isWebviewFocus` / `isWebviewElement`：dispatcher 与 `webviewFocus` context key 共用的 webview 判定 |
| `workbench/vim/vimDebugFormat.ts` | Keyboard Shortcuts Troubleshooting 的 Vim trace 格式 |
| `actions/vimActions.ts` | `workbench.action.toggleVimMode`（归「Vim」分类）、`workbench.action.vim.showActiveKeymap`、`workbench.action.vim.showKeymapCheatSheet`（无默认快捷键，`<leader>?` 走 Vim 键位表） |
| `actions/vimSurfaceActions.ts` | `list.*` / `surface.*` 通用命令，转发到活跃 surface 的 `actions`；`first/last` 把 `hasCount` 折成 `count`（无计数传 0） |
| `actions/focusSurfaceActions.ts` | 聚焦侧栏 / 底栏 / 辅助侧栏 / ActivityBar / 标签栏 / 容器标题 |
| `actions/terminalNormalActions.ts` | 终端 Normal 的进入 / 退出 / `Ctrl+F/B` 整页 / 选择 / 复制命令（其余滚动复用 `list.*`） |
| `workbench/panel/terminal/terminalNormalMode.ts` | 终端 Normal 状态机 + `createTerminalSurfaceActions`（把控制器适配成 `IVimSurfaceActions`） |
| `services/terminal/terminalNormalModeRegistry.ts` | 当前持有焦点的终端 controller 注册表 |
| `workbench/editor/useMarkdownKeyboardNav.ts` | Markdown 预览 / 文档中心注册 `reader` surface，`createReaderVimActions` 复用 `markdownNavKeys` 的命令 |

### 编辑器 Vim 内核（`workbench/editor/vim/`）

按「纯逻辑 / 绑定 Monaco」分层。**纯逻辑文件不 import Monaco 实例**，只依赖 `vimTypes.ts` 里的 `VimEditor` 结构接口，可在 node 下用 `fakeVimEditor` 单测。

| 文件 | 职责 |
| --- | --- |
| `vimTypes.ts` | `VimState` / `VimCommand`（判别联合）/ `VimMotion` / `VimOperator` / `VimTextObjectId` / `VimPending` / `VimVisualAction`、`VimEditor` 结构接口；文件头列出所有扩展点 |
| `vimKeymap.ts` | reducer `reduceVimKey`：Normal / Visual / Insert 一击一状态。表驱动：`PREFIX_TABLES` / `PREFIX_STARTERS`（`g z [ ]` 第二键）、`SIMPLE_COMMANDS`（单键命令）、`CTRL_COMMANDS`（`Ctrl+R`；工作台级的 `Ctrl+O/I` 在应用键位表里）；motion / operator / 文本对象 / Visual 键各查自己的注册表。`formatPendingKeys` 给状态栏 |
| `vimMotions.ts` | **`VIM_MOTIONS`**：每个 motion 一条 `{ id, keys, kind, resolve, resolveForOperator?, needsChar? }`；含 `f/F/t/T/;/,`、`%`、`N%`、`cw`=`ce` 特例 |
| `vimWordMotions.ts` | 词类（keyword / 标点 / 空白 / CJK 成词）与 `w/b/e` 的行走 |
| `vimOperators.ts` | **`VIM_OPERATORS`**：`d y c > < g~ gu gU`（`prefix: 'g'` 的经 `g` 前缀表到达）；范围推导（linewise / inclusive / exclusive、o_v 规则、EOF 删行）；`VimOperatorHost` 只描述效果，不碰 Monaco |
| `vimTextObjects.ts` | **`VIM_TEXT_OBJECTS`**：`w W " ' \` ( [ { < p t`（含 `b` / `B` / 闭括号别名），`i` / `a` 两种 |
| `vimVisual.ts` | `VISUAL_ACTION_KEYS` / `VISUAL_G_ACTION_KEYS`（Visual 下的 `d y c > < ~ u U J r p P…`）、anchor/cursor → Monaco 选区、块选区的逐行范围、`visualExtent`（供 `.` 重放） |
| `vimRegisters.ts` | 窗口级寄存器：`""`、`"0`、编号删除寄存器 `"1`–`"9`、小删除寄存器 `"-`、`"a`–`"z`（大写追加）、`"_`；`"+` / `"*` 只在此识别名字，读写在 controller |
| `vimSession.ts` | 跨编辑器的 `.` 重复（最近一次可重复改动）与 `;` `,` 的最近一次 find；`isRepeatableChange` / `withCount` |
| `vimEdits.ts` | 缓冲区改动：operator 的 host 实现、`x/s/r/~/p/J`、Visual 动作、`enterInsert` / `exitInsert`（**Insert 退出：关闭 undo 组并把光标左移一格**）、undo 分组（每个 Normal 命令一个 `u` 步；`cw`/`s`/`o` 与随后输入共一组） |
| `vimViewport.ts` | 折叠 / 屏幕行 motion、`zt/zz/zb`、`H/M/L`、`[z/]z`、`Ctrl+E/Y`（粘性滚动高度修正见下） |
| `vimSearch.ts` / `vimSearchController.ts` / `vimSearchWidget.ts` / `vimSearch.css` | 字面量搜索纯逻辑（smartcase、`\c`/`\C`、wrapscan）/ `/ ? n N * #` 与 hlsearch 生命周期 / 搜索框 widget（IME 组合守卫） |
| `vimInputMethod.ts` | **窗口级**输入法归属（owner 模型）：`requestInputMethod(owner, service, desired)` 只在状态迁移时发 IPC 并串行化；`releaseInputMethod(owner, service)` 仅当前持有英文的 owner 才生效。编辑器 controller / 终端 Normal / `VimImeCoordinator` 共用 |
| `vimKeyUtils.ts` | `isFunctionKeyName` / `accumulateCount` / `consumeEvent` / `toVimKeyInput`（含 AltGr / Option 产生的字符）/ `scrollViewportPayload` / `pageScrollPayload`，编辑器与 Output 共用 |
| `vimKeyHelp.ts` | 速查表里的编辑器键位说明——**从上面的注册表派生**（motion / operator / 文本对象 / 前缀表 / 简单命令 / Visual 键），加键位自动出现在速查表；`EXTRA_ROWS` 只放 reducer 内联处理的键（`.` `v` `"x` `r`…）。描述用英文，`vim.keyHelp.<slug>` 本地化；`describeVimKeyHelp()` 同时供 which-key 使用 |
| `vimPendingHints.ts` | 纯函数 `computeVimPendingHint(state)`：从同一批注册表派生编辑器内核前缀的 which-key 候选（`g` / `z` / `[` / `]`、操作符等待、`i`/`a` 文本对象、Visual `g`），静态表按类别 memo；等待字符参数（`f` / `r` / `"`）与纯计数返回 undefined |
| `vimEditorController.ts` | 把 reducer 的输出绑到 Monaco：`COMMAND_HANDLERS`（`Record` 覆盖每个 `VimCommand['type']`，缺一个编译器就报）、Visual 状态（anchor + cursor）、`.` 重放、Insert 会话记录（`3ifoo<Esc>`）、块状光标、`"+`/`"*`/`vim.useSystemClipboard` |
| `attachVim.ts` | 一次调用接好 controller + surface 注册；`FileEditor` / `DiffEditor` / `SwarmDiffEditor` / session 输入框共用。可选 `defaultMode`（默认 `normal`）与 `idleEscapeCommand`（默认聚焦编辑器标签栏）：session 输入框的 `defaultMode` 取自 `vim.prompt.defaultMode`，`idleEscapeCommand` 传 `workbench.action.agent.focusTimeline`。Swarm diff 的 modified 侧是只读快照，靠 `isReadOnly` 拒绝写命令 |
| `vimSurfaceKeys.ts` | `editorVimSurfaceKey(groupId, inputId)` |
| `workbench/panel/output/outputVimKeymap.ts` | Output 只读编辑器：**复用 `reduceVimKey`** 再 `project()` 成可执行子集（`j/k`、`gj/gk`、`Ctrl+E/Y/D/U/F/B`、`gg/G`），其余吞掉；要多支持一个 motion 就在 `project` 加 `case`，不要另写键表 |
| `workbench/panel/output/outputVimController.ts` | 把投影后的命令绑到 Output 的 Monaco 实例；只跟踪 text focus 与 blur 重置 |

## 唯一入口与分发顺序

`ctrlNavigationRegistry` 在 `window` 的 **capture** 阶段收键。顺序固定：

1. `event.defaultPrevented`、IME 组合（`isComposing || keyCode === 229`）、`keybindingChordPending(doc)` 为真 → 直接放行。
2. `ctrlNavigationDirection(event)` 命中 `Ctrl+J/K/H/L` → 按 `menu > dialog > overlay > list` 选出唯一一层并消费；**不再进入 Vim**。只有菜单 / 浮层 / 对话框 / 配置栏注册这些层，纯列表 / 树不注册（它们用裸键或方向键）。
3. 否则调用 `setVimKeyHandlerProvider` 注入的 provider（由 `useVimDispatcher` 安装）。provider 返回 `true` 时，注册表执行 `preventDefault + stopPropagation + stopImmediatePropagation`。

`VimDispatcher.dispatch` 的判断顺序（与 `vimDispatcher.ts` 一致；改代码时不要随意换序）：

1. dispatcher 已 dispose / `defaultPrevented` / IME → 放行。
2. `vim.enabled` 关闭 → 放行。
3. Webview（`isWebviewFocus`：`activeElement` 是 `IFRAME`，或在 `[data-vim-surface="webview"]` 内）→ 放行。
4. `quickInputVisible` 为真 → 放行。
5. 单独的修饰键（`Shift/Control/Alt/Meta`）→ 放行，且**不打断**待定序列。
6. `getActiveVimSurface(doc)` 解析当前 surface；无 surface 或 `isSurfaceEnabled(kind)` 为假 → 放行。
7. 编辑器 surface 且 `acpPromptPopupVisible` 为真 → 放行（session 输入框的 slash / mention / context / history 浮层由全局 suggestion 命令接管 `Up` / `Down` / `Tab` / `Enter` / `Esc`；放在 Insert 与内核之前，Normal 也不会吞掉这些键）。限定 editor kind——浮层只属于 prompt 输入框。
8. 读取该 surface 的模式并上报 `IVimModeService.activateSurface`（写 context key、状态栏）。
9. 终端且模式不是 `terminal-normal` → 放行（终端默认 Insert，按键属于 shell；**必须在 editable guard 之前**，xterm 的 textarea 是 editable）。
10. Insert：只认 `Esc` 与 `Ctrl+[`（编辑器上也一样，内核离开 Insert，不会落到 Monaco 的「减少缩进」）。`[data-renderer-dialog]` 存在时放行（设置对话框的 `Esc` 归对话框）；编辑器交给内核 `handleStroke`，其它 surface 写回 `normal` 并消费。其余键放行。
11. 非 editor / terminal 的 surface：焦点在可编辑元素上 → 放行（搜索框、行内输入框保留按键）。
12. `[data-renderer-dialog]` 存在 → 放行（这个查询每个 Normal 击键都跑，所以放在已确认要出手之后）。
13. **User 让行**：非保留键、且**没有待定序列**时，`KeybindingsRegistry.hasBindingAtOrAbove(key, KeybindingWeight.User, ctx)` 为真 → 放行，并写 trace。待定序列中的第二击不让行，否则引擎会一直 pending。
14. 编辑器：`token === leader`、该 surface 已有待定序列、或 token 是编辑器可见的**修饰键条目**首键（`Ctrl+O`）→ 共享序列引擎（`dispatchEditorSequence`，引擎对未匹配的 token 返回 false 交回内核）；其余 Normal 键交给 `handleStroke`。修饰键条目先经 `actions.takeCount()` 取走内核已敲的计数（`3<C-o>`，喂成引擎计数）；返回 undefined（Visual / Insert / 无文本焦点）则仍交内核。`isAwaitingCharArg` 为真时三者都不截。
15. 其它 surface：`setEntries(getEffectiveKeymap(kind, active.keymap))` 后喂 token → `cancel` / `pending` / `execute` / `none`。`pending` 时更新状态栏 pending 文字、安排 which-key；`execute` 时 `runMatches`，若 `replay` 则同一 token 再喂一次；`none` 时按 `vim.passThroughUnmappedKeys` 与 surface kind 决定吞键（并 `reportUnsupportedKey`）或放行。

步骤 14 / 15 喂给序列引擎的条目先经 `entriesWithActiveWhen` 过滤掉 `when` 不成立的：它们既不会执行，也不会成为 pending 前缀（例如非对比编辑器里的 `]c` 不会让 `]` 进入 pending，`]` 直接交回编辑器内核）。

`runMatches` 的候选排序：surface 自己声明的（`scope: 'surface'`）> 带 `when` > 通用默认；取第一条 `when` 成立的。全部不成立时消费并提示 `Unsupported`，不执行。

surface 仲裁优先级（`vimSurfaceRegistry.ts` 的 `KIND_PRIORITY`）：`menu(8) > overlay(7) > list(6) = reader(6) > terminal(5) > editor(4) > tabs/activityBar/viewContainerTabs(3)`。同 kind 取嵌套更深者，再取后挂载者。菜单以虚拟焦点工作，注册后**始终 active**，因此零行菜单必须用 `enabled: false` 卸下。

## Surface 注册 API

```ts
import { useVimSurface, useVimSurfaceKey, createIndexListVimActions } from '@universe-editor/workbench-ui'

const surfaceKey = useVimSurfaceKey('list', 'my-view')
useVimSurface({
  id: surfaceKey,
  kind: 'list',
  focus: 'within',
  getElement: () => containerRef.current,
  getSurfaceKey: () => surfaceKey,
  defaultMode: 'normal',
  // 纵向行：move / first / last / page / scrollViewport 一次生成
  actions: {
    ...createIndexListVimActions({ getCount, getIndex, setIndex, scroller }),
    activate: (count, preview) => { /* ... */ },
  },
})
```

`IVimSurfaceRegistration`：

| 字段 | 说明 |
| --- | --- |
| `id` | 诊断 / context key / sidecar 键位匹配用的 id；常与 surfaceKey 相同 |
| `kind` | `editor` / `list` / `reader` / `menu` / `overlay` / `tabs` / `activityBar` / `viewContainerTabs` / `terminal` / `webview` |
| `getElement` | 在**击键时**读取宿主元素；callback ref 后挂载也能生效 |
| `focus` | `self`（默认给 list/tabs/activityBar/viewContainerTabs）要求容器自身是 `activeElement`；`within` 接受后代焦点 |
| `getSurfaceKey` | 在击键时解析实例键，用于模式记忆与 trace |
| `enabled` | 为 `false` 时保持注册但不参与仲裁（菜单零行、关闭的标题栏、link hints 期间的 reader） |
| `defaultMode` | `normal` / `insert` / `terminal-normal`；无记忆时的初始值 |
| `actions` | 可选操作集合；未实现的命令会静默 no-op（但仍被消费） |
| `keymap` | 只有这个 surface 认的键（见下）。**数组引用必须稳定**（模块常量或 `useMemo`），否则有效键位缓存每击重建 |

`registerVimSurface` 是给非 React 调用方的同义入口（如终端实例、`attachVim`）；React 侧一律用 `useVimSurface`，它会通过 ref 读取最新注册，避免每次渲染重注册。

`IVimSurfaceActions` 字段：`move(direction,count)`、`first(count)`、`last(count)`、`page(direction,count)`、`scrollViewport(direction,count)`、`expand/collapse/toggle(count)`、`activate(count,preview)`、`contextMenu/copy/remove(c)`、`next/previous(count)`、`escape(count)`（返回 `false` 表示没有可退出的状态：侧栏 / 底栏视图里的 `list`（`focusedView` 非空）随后执行 `workbench.action.focusActiveEditorGroup` 回编辑器；编辑器区里的 `list`（`editorAreaFocus` 为真）执行 `workbench.action.focusEditorTabs` 回标签栏；未实现 `escape` 同理；返回 void 视为已处理）、`find()`（`/` 打开宿主自己的筛选框；树通过 `onVimFind` 暴露，Outline 是范例），以及编辑器专用的 `handleStroke(event)` / `isAwaitingCharArg()` / `takeCount()` / `getPendingHint()`。

**count 语义（全 surface 统一）**：`first(count)` / `last(count)` 的 `count` 为 0 表示没敲数字（`gg` = 首项、`G` = 末项），`n ≥ 1` 表示跳第 n 项（1 基、夹到范围内）：`3G` / `3gg` 都是第 3 项，`1G` 是首项。`vimSurfaceActions` 靠 dispatcher 额外传的 `hasCount` 区分「没敲」与「敲了 1」，直接调命令不带 `hasCount` 时只有 count > 1 才算敲了。新 surface 用 `createIndexListVimActions` / `createStripVimActions` 就自动遵守，不要手写。

各 surface 的落点：列表 / 树 / 标签栏 = 第 N 项；**菜单**的 `Ctrl+D/U` 没有页的概念，直接跳末 / 首项；**终端 Normal** 的 `NG` / `Ngg` 跳到第 N 行 buffer 行（`scrollToBufferLine`，1 基）；**Markdown 预览**的 `NG` / `Ngg` 跳到第 N 行源码（按渲染块的 `data-line` 找，无 `data-line` 的预览回退首 / 末）；**例外**：Chat 时间线（`ChatBody`）与通知中心的 `G` / `gg` 忽略 count，始终首 / 末项。

`scrollViewport` 只移动视口，不移动焦点 / 选中项（`Ctrl+E/Y`）。列表 / 树 / 浮层 / 图谱的适配器各自提供 scroller 与行高；共享实现是 workbench-ui 的 `list/scrollViewport.ts`（`findScrollableElement` 从容器向上找真正滚动的祖先，`scrollViewportByRows` 按行高改 `scrollTop`，只夹下界）。焦点容器包着 `VirtualList` 的宿主（设置页、快捷键编辑器）必须显式传 `getScrollElement`，因为 VirtualList 的 scroller 是**子孙**而不是祖先。菜单没有纵向视口，不映射 `Ctrl+E/Y`。

### 新增 surface 的步骤

1. **选 kind**：能复用 `list` / `menu` / `overlay` / `reader` 就不要新增 kind。新增 kind 需要同时改 `VimSurfaceKind` + `VIM_SURFACE_KINDS`、`KIND_PRIORITY`、`defaultFocus`、`vimModeService.ts` 的 `TOGGLE_BY_KIND`（`Record` 穷举，编译器会提醒；以及是否暴露 `vim.surfaces.*` 开关与 `VIM_SERVICE_CONFIG_KEYS`）、速查表的 `SURFACE_ORDER` / `vimSurfaceLabel`。
2. **定 surfaceKey**：有稳定视图 id 用 `useVimSurfaceKey(kind, id)`；实例级用 `useVimSurfaceKey(kind)`（自动键）。关闭 / 销毁后需要重新从默认模式开始时才调用 `vimModeService.forgetSurface(key)`。
3. **实现 actions**：只实现该 surface 真正支持的操作；纵向 / 横向索引型优先用 `createIndexListVimActions` / `createStripVimActions`。`left/right` 在树里表示折叠 / 展开进子级，在标签栏表示前后切换，在浮层由宿主定义。
4. **注册**：`useVimSurface` 的 `focus` 按「容器是否自己持有 tabIndex」选择；可编辑控件要留在里面的列表用 `within`。仲裁对非 editor / terminal surface 默认拒绝 editable 焦点，dispatcher 的 editable guard 是第二道防线。
5. **补键位**，按「谁认这个键」选落点：
   - 所有同 kind surface 通用 → `workbench-ui/vimDefaultKeymap.ts`（只写 `list.*` / `surface.*`）；
   - 要调用工作台命令（leader、`:`、聚焦某 view）→ `vimAppKeymap.ts`；
   - **只有这一个视图认**（设置页的 `/`、图谱搜索框）→ 在 `vimSurfaceKeymaps.ts` 写一个常量，视图里 `useVimSurfaceKeymap(vimSurfaceKeyFor('list', '<id>'), CONST)`（或直接放进 `useVimSurface({ keymap })`）。这些条目 `scope: 'surface'`，只在该 surface 活跃时存在，优先于 kind 通用条目，**不要再写 `when: "vimSurfaceId == …"`**（Chat 的 `acpChatFocused` 是因为 Chat 与普通列表共用同一个 surface，属于例外）。
6. **补命令**：新的 action 需要命令 id 时，在 `vimSurfaceActions.ts` 或对应域 actions 中注册，命令体里从活跃 surface 的 `actions` 转发。
7. **测试**：workbench-ui 适配器测试（`vimSurfaceAdapters.test.tsx`）+ 对应界面测试（可用 `__tests__/_helpers/vimTestHarness.ts` 搭 DI）；涉及跨进程状态时补 e2e（`e2e/pages/vimHelpers.ts`）。

## Keymap 结构、合并与 `when` 优先级

`IVimKeymapEntry`：`{ id, keys, command, args?, when?, surfaces?, scope? }`。

- `keys` 是 **Vim token**，由 `vimKeyToken()` 生成：可打印键保留大小写（`g` 与 `G`），特殊键转小写名（`escape` / `enter` / `space` / `up` / `pagedown`…），带修饰键时按 `ctrl+alt+meta+shift+key` 顺序拼，且 key 小写（`ctrl+d`，不是 `Ctrl+D` / `shift+g`）。不要用 keybindings.json 的写法。`describeInvalidVimToken` 会把写错的 token 报出来。
- 多段 token 即序列：`['g','g']`、`['<leader>','e']`。`<leader>` 在 `mergeVimKeymap` 里替换为 `vim.leader`（默认 `space`）。`vim.leader` 先过 `normalizeLeader`：`Space` / `<space>` / 单个空格都归一为 `space`，多字符 token 转小写，不合法的值（空串、`<leader>` 自身、`describeInvalidVimToken` 不通过）回退默认并 `console.warn`。
- `surfaces` 省略时：非编辑器 kind 全部可见；编辑器**只**可见以 `<leader>`（或已替换的 leader）开头的条目。显式列出 `editor` 时，leader 或**修饰键**（`ctrl+`/`alt+`/`meta+`）开头的条目对编辑器可见，裸键条目不可见（裸键归内核，`entryAppliesTo` 过滤）。跨 surface 同义的键（`Ctrl+O/I`）就这样只写一份。`scope: 'surface'` 的条目无视 `surfaces`。
- **有效键位 = 合并结果**（`vimModeService.getEffectiveKeymap(kind, surfaceKeymap)`，按 `(kind, leader, configVersion)` 缓存，surface 自带键位另按数组引用缓存）：
  1. surface 自带条目（`scope: 'surface'`，排最前；用户 `vim.keymap` 可按 `id` 覆盖或解绑它们，覆盖只在该 surface 活跃时生效——`mergeVimKeymap` 的 `surfaceCatalog` 参数让「全字段覆盖」不被误认成新增）；
  2. workbench-ui 通用表 + `vimAppKeymap`；
  3. `vim.keymap` 里的追加项。
- `vim.keymap` 三种写法（`parseUserKeymap` 解析并校验，问题只 `console.warn` 一次并出现在 `Vim: Show Active Keymap` 的 *Problems* 段，坏条目被丢弃或裁剪，不会让整表失效）：
  - **覆盖**：`id` 命中内置条目 → 只写要改的字段，其余（`surfaces` / `when` / `args`）**继承**内置；
  - **追加**：`id` 不是内置 → 必须同时有 `keys` 与 `command`；无 `id` 自动生成 `user.<index>`；
  - **解绑**：`command` 以 `-` 开头（同 keybindings.json 的 `-command`）；用 `id` 或 `keys` 指明目标，`{ "command": "-" }` 表示任意命令，可带 `surfaces` 限定 kind。找不到目标的解绑会给出告警。
- 序列引擎接受 `1`–`9` 起头的计数、`0` 续接计数；`Esc` 取消待定状态。`z` 等「既完整又是更长前缀」的键延迟到下一击或 `vim.sequenceTimeoutMs` 超时再执行。
- **三段及以上的歧义序列**：`a` / `ab` / `abc` 同时存在时，引擎只保留**最近一层**的完整匹配作为超时回退。依次按 `a`、`b` 后停在 `ab`：此时超时（或下一个不延续前缀的键）执行 **`ab` 的命令**；若继续按 `c` 则执行 `abc`。更早的 `a` 不会在超时后补发——待定分支始终是当前最长前缀，回退目标是这条分支上最后一个既完整又是前缀的条目。
- `runMatches` 先试 surface 自带条目，再试带 `when` 的，最后默认条目，取第一条 `when` 成立的；因此同一键的「视图专用含义」不会被注册顺序遮蔽。所有候选都不匹配时**消费但不执行**，并提示 `Unsupported`。
- 编辑器内核的裸键（`g` / `[` / `]` / `z` 前缀、`d y c > <` 与 `g~ gu gU` operator、文本对象、`f/t/r/"`、`.`、`v V Ctrl+V`、`K` `%` `*` `#` `H/M/L` 等）由 `vimKeymap.ts` 的 reducer 直接产出，不进 keymap 表；因此 `vim.keymap` 对编辑器只能覆盖 / 追加 leader 序列。**例外**是 bracket 表的四个命令条目 `]d` `[d` `]c` `[c`：它们由 `services/vim/vimCoreKeymap.ts` 统一定义并带稳定 id（`editor.nextDiagnostic` / `editor.previousDiagnostic` / `editor.nextChange` / `editor.previousChange`），controller 读取 `vimModeService.getUserKeymap()` 后构建本实例的 `buildPrefixTables({ disabled, remapped })`，再传给 reducer 与 which-key。覆盖语义是**替换**：`[` / `]` 开头的两段序列移动内核条目；leader / 修饰键别名先移除默认条目、再由 `mergeVimKeymap` 追加别名（`VIM_CORE_KEYMAP_ENTRIES` 同时在 `BASE_ENTRIES` 里提供 `command` 继承）；`command: "-"` 解绑。Monaco 动作走 `editor.trigger`，workbench 命令（`]c` / `[c` / 空闲 `Esc`）走 `createVimEditorController` 的 `executeCommand` 回调（`FileEditor` / `DiffEditor` / session 输入框注入 `ICommandService`）。
- **`]c` / `[c` 与单和弦 `Alt+J` / `Alt+K`**：焦点在 Explorer / Commit Changes 等列表中、且活动编辑器是对比编辑器时，`vimAppKeymap.ts` 的 `list.nextChange` / `list.previousChange` 把序列路由到 `workbench.action.compareEditor.*Change`（`when: textCompareEditorVisible`）。命令只移动 diff 光标与视口、不抢焦点，所以可以从列表里连续预览上下一个改动。单和弦走 `CHANGE_CHORD_ENTRIES`：editor 的 `editor.nextChangeChord` / `editor.previousChangeChord`（`alt+j` / `alt+k`，`when: !acpChatFocused`），list 的 `list.*ChangeChord`（额外 `textCompareEditorVisible && !inKeybindings`）；`!acpChatFocused` 保证聊天时间线的同名导航不被抢走。

## 编辑器 Vim 内核

### 一击的流水线

```
vimDispatcher.editorStroke → controller.handleKeyDown
  → dropStaleVisual（鼠标点击 / 外部选区变化结束 Visual）
  → reduceVimKey(state, key) → { state, command, handled, register, unsupported? }
  → runCommand(command, register) → COMMAND_HANDLERS[command.type]
  → syncContextKeys（模式 / 子模式 / 光标样式 / 输入法）+ reportPending（状态栏）
```

reducer 是纯函数：`VimState = { mode, count, operatorCount, pendingOperator, pending, register }`。`mode` 含 `normal / insert / visual / visual-line / visual-block`；`pending` 一次只会有一个（`g z [ ]` 前缀、`f/t` 等待字符、`r` 等待字符、`"` 等待寄存器名、`i`/`a` 等待文本对象）。`effectiveCount` 把 operator 前后的计数相乘（`2d3w` = `d6w`）。

**pending 的取消规则**：`r f t F T "` 等字符参数与 `i` / `a`、`g z [ ]` 前缀等待期间，Backspace / Delete / Enter / Tab / Insert / 方向键 / Home / End / PageUp / PageDown 这类会在 Monaco 里改动或移动的键（`EDITING_KEYS`）取消 pending 并**吞掉**，不会漏给 Monaco；F 键与修饰键不在此列，照常放行。例外是它们本身能当字符参数：`r<Space>`、`r<Enter>`（换行）、`f<Tab>` / `r<Tab>` 可用。leader 同理——编辑器正在等字符参数（`controller.isAwaitingCharArg()`，经 `IVimSurfaceActions.isAwaitingCharArg` 暴露）时，`Space` 是参数而不是 leader（`dispatchEditorSequence` 先判断它）。

### 加一个能力：该改哪里

| 想加 | 改哪里 | 要点 |
| --- | --- | --- |
| **motion**（如新的 `gj`） | `vimMotions.ts` 的 `VIM_MOTIONS` 加一条；`VimMotion` 联合加 id | `kind` 决定 operator 取范围的方式（linewise / inclusive / exclusive）；operator 下行为不同时给 `resolveForOperator`（`cw`=`ce`、`dw` 不跨行末、`d}` / `d{` 按 exclusive 终点落第 1 列的 o_v 规则收到上一行行尾）；需要再读一个字符加 `needsChar: true`；经前缀到达的 motion 的键写在 `PREFIX_TABLES`（`{ motion: 'gg' }`）而不是 `keys`；屏幕行相关设 `screenAware`；再补 `vimMotions.test.ts` |
| **operator**（如 `gq`） | `vimOperators.ts` 的 `VIM_OPERATORS` 加一条；`VimOperator` 联合加 id | `key` 即起始键，连按两次自动 linewise；`prefix: 'g'` 的会被 `g` 前缀表自动收录；`apply` 只通过 `VimOperatorHost` 产生效果（已有 `yank/deleteRange/transform/shiftLines…`，不够就扩 host 并在 `vimEdits.ts` 实现） |
| **前缀键**（如 `g` 之外的新前缀 / 现有前缀的新第二键） | `vimKeymap.ts`：新前缀要加 `VimPendingKind`、`PREFIX_STARTERS`、`PREFIX_TABLES`；只加第二键则在对应表加一项 | 表项三种形态：`{ motion }` / `{ command: count => VimCommand, description, normalOnly? }` / `{ operator }`；`allowedWithOperator: false` 表示前缀会取消待定 operator（`dz`）；`description` 会自动进速查表（别忘了 `vim.keyHelp.*` 本地化条目，`vimKeyHelp.test.ts` 会检查覆盖） |
| **单键命令**（如 `J`、`Ctrl+R`） | `vimKeymap.ts` 的 `SIMPLE_COMMANDS`（`visual: true` 表示 Visual 下也可用）或 `CTRL_COMMANDS`；`VimCommand` 联合加成员（如需）；`COMMAND_HANDLERS` 加 handler | `COMMAND_HANDLERS` 是 `Record` 覆盖全部 `type`，漏一个编译不过；会改缓冲区的命令记得同步 `vimSession.ts` 的 `isRepeatableChange` / `withCount`，否则 `.` 不会重放它 |
| **文本对象** | `vimTextObjects.ts` 的 `VIM_TEXT_OBJECTS` 加一条；`VimTextObjectId` 联合加 id | `keys` 可有多个别名（`(` / `)` / `b`）；`resolve({ lines, cursor, around, count })` 返回 `{ start, end(exclusive), linewise }` 或 null；`i` / `a` 的区别在 `around` 参数里；补 `vimTextObjects.test.ts` |
| **Visual 动作** | `vimVisual.ts` 的 `VISUAL_ACTION_KEYS`（或 `VISUAL_G_ACTION_KEYS`）加一条；`VimVisualAction` 联合加成员；`vimEdits.ts` 的 `visualAction` 加分支 | 块选区要考虑 `blocks` 逐行范围 |
| **速查表说明** | 不用手写：`vimKeyHelp.ts` 遍历注册表生成；只有 reducer 内联处理的键才加 `EXTRA_ROWS` | |

### Visual / `.` / 寄存器 / 光标

- **Visual**：controller 持有 `anchor` + `cursor` 两个**落在字符上**的位置并渲染成 Monaco 选区，从不回读 Monaco 的选区（所以 `o` 换端后选区在两个方向都是闭区间）。`v` / `V` / `Ctrl+V` 互相切换，同键再按退出；`gv` 重选上次区域；Visual 下 `i` / `a` 取文本对象并扩展选区：重复 `iw`/`ip` 扩到下一个，重复 `i(` / `a(` 等括号对象逐层向外扩展，反向选区（`o` 换端后）的 `iw` 向前扩展。`gv` 重选的区域按当前文档裁剪，越界不抛。undo / redo 后清掉残留选区（`collapseResidualSelection`）。子模式经 `onSubModeChange` → `vimModeService.setEditorSubMode`，对 context key 而言仍是 `vimNormalMode`，另有 `vimVisualMode`；状态栏文字区分 `VISUAL` / `V-LINE` / `V-BLOCK`。Visual 下的 `Esc`：有待定前缀先取消，再按才退出。
- **`.` 重复**：`runCommand` 用 `changeFor` 记录最近一次可重复改动（yank 与移动不记）；开了 Insert 会话的改动（`cw`、`o`、`A`…）在会话结束时连同输入文本一并存档（`finishInsertSession`），`.` 重放时先跑命令再重放 Insert 会话。会话记录的是**按键流**（`VimInsertReplay`：`type` / `delete-left` / `delete-right` / `tab`），重放时以 `keyboard` 来源触发 Monaco 编辑命令，所以自动缩进 / 自动闭合会重新触发；记录期间出现方向键等移动则截断（只重放移动之前的按键）；按键流不可信（IME 组合、Ctrl 组合键、程序化输入）时退回字面文本（`typeText`）。Visual operator 存 `visualExtent`，重放时在光标处造同等大小的选区。`3.` 用新计数替换并成为后续 `.` 的计数。`.` 状态在 `vimSession.ts`，**窗口级**，跨分屏共享。块 `c` 因每行一个光标无法重放，不记录。
- **寄存器**：`vimRegisters.ts` 管 `""` / `"0` / 编号 `"1`–`"9` / 小删除 `"-` / 具名（大写追加）/ 黑洞；写入总会落到 `""`，只有无寄存器名的 yank 才写 `"0`（delete 不覆盖 `"0`）。无寄存器名的 delete / change 跨行（或整行）时推入编号寄存器 `"1`–`"9`（逐级后移），不跨行的写小删除寄存器 `"-`；Vim 里 `d%` `d/` `dn` `d{` 等总用 `"1` 的例外**未实现**（host 不向寄存器层传 motion）。`"+` / `"*` 及 `vim.useSystemClipboard`（让 `""` 与系统剪贴板互通）在 controller 里经 `readClipboardText` / `writeClipboardText` 异步读写；从剪贴板读回的文本若与自己上次写入的相同，则保留 linewise / blockwise 形态。读剪贴板失败会降级到内部寄存器，只 `console.debug`。异步粘贴带 `pasteGeneration` / `contentVersion` 守卫：等待剪贴板期间光标或内容变了就放弃，不会粘到错误位置。
- **Insert 进出**：进入前 `pushUndoStop`（上一步自成一个撤销单元）；`Esc` 时 `finishInsertSession` → 重复输入（`3ifoo`）→ `exitInsert`（再 `pushUndoStop` 关闭撤销组，**光标左移一格**，块插入后收成单光标）。因此 `u` 一次撤销整个 Insert。
- **块状光标**：Normal / Visual 下 `editor.updateOptions({ cursorStyle: 'block' })`，Insert 与 deactivate 还原为用户的 `editor.cursorStyle`。「编辑器选项桥」在任意桥接配置变化时会重设 `cursorStyle`，所以 controller 在配置事件里用 `queueMicrotask` 重新夺回。
- **Normal 空闲 `Esc`**：reducer 在「没有任何待定状态」时发 `search-highlight-clear`；handler 先清 hlsearch 高亮，没有可清的才执行 `workbench.action.focusEditorTabs`（把焦点交给标签栏）。取消待定前缀 / 计数的那一次 `Esc` 不会触发它。编辑器区内的 `list` surface（Git / Perforce 图谱、Chat 时间线、设置 / 快捷键列表等）没有待退出状态时同样执行该命令（见上节 `escape` 的落点）。
- **`Ctrl+[`**：reducer 的 `isEscapeStroke` 把它视同 `Esc`（Normal / Visual / Insert 皆然）；dispatcher 的 Insert 分支同样放行 `ctrl+[` 给内核（编辑器上也会离开 Insert），保留集默认含 `ctrl+[`。
- **光标期望列（curswant）**：`j` / `k` 记住进入垂直移动前的列，穿过短行后回到原列；`$` 之后贴行尾（`END_OF_LINE_COLUMN`，下移到的每一行都停在行尾，Visual `$` 同样保留换行）；任何水平移动、或光标被别处移走，都会让记忆失效。`gj` / `gk` 单独记住**显示段内的字符偏移**，见下节。
- **折叠头行上的行级操作**：折叠闭合时，`dd` / `yy` / `>>` / `o` / `dj` 等行级命令把整个折叠当一行（作用于折叠头行到末行，`j` / `k` 计数同理）。
- **一个命令一个撤销步**：`3J` 一次 `u` 撤销；`J` 次数是 `count - 1` 次合并（`J` 单次合并两行）。
- **只读编辑器**：`isReadOnly` 为真时写命令（`isWriteCommand`）被 `refuseWrite` 拒绝——不改缓冲区、不进 Insert、Visual 的 `c` / `d` 直接退出 Visual；移动与 `y` 照常；Insert 中缓冲区变只读会被踢回 Normal。Swarm diff 两侧都是只读 depot 快照，modified 侧挂 Vim 后移动、搜索、`y` 与 `]c` / `[c` 正常，写键被忽略。
- **文本对象与 `d}`**：`}` / `{` 是 exclusive charwise motion，`d}` 套用 Vim 的 o_v 规则（终点落在第 1 列时收到上一行行尾，起点在缩进内则变整行删除；停在末行时 `}` 取末行最后一个字符、inclusive）；引号对象按 Vim `current_quote` 取（光标前最近的引号开串、不看奇偶；光标前无引号则取之后的第一个）。`v$` 包含换行。`I` 到首个非空白字符，`gI` 到第 1 列。

### 编辑器滚动命令（`vimViewport.ts` / `vimEditorController`）

三个命令在 `VimCommand` 里是独立成员，不复用 `VimMotion`，因此 `vimMotions.ts` / `vimOperators.ts` 的穷举 switch 与 operator 语义不受影响：

| 命令 | 键 | Monaco 参数 | 语义 |
| --- | --- | --- | --- |
| `scroll-viewport` | `Ctrl+E` / `Ctrl+Y`（可带计数） | `editorScroll`：`{ to, by: 'wrappedLine', value: count, revealCursor: true, select: false }` | 按屏幕行滚动；`wrappedLine` 对齐 Vim 的屏幕行语义，`revealCursor` 负责光标被顶出视口时跟随 |
| `reveal-line` | `zt` / `zz` / `zb` | `center` 用 `revealLine`；`top`/`bottom` 用 `setScrollTop`（见下） | 目标行 `target` 默认光标行；**带计数时 count 是目标行号，并把光标移到该行（保持列）**；不带计数时光标不动 |
| `goto-viewport-line` | `H` / `M` / `L`（`H`/`L` 可带计数） | 控制器内 `setPosition`，不 reveal | 从 `getVisibleRanges()` 展开可见行序列：`H = 第 count 个可见行`、`L = 倒数第 count 个`、`M = 中间一个（忽略 count，同 Vim）`；列取首个非空白字符。直接调 `editor.setPosition` 而非会 reveal 的包装，避免二次滚动 |

`zt` / `zb` **不能**直接用 `revealLine` 的 `top` / `bottom`：Monaco 会在目标侧叠加 `cursorSurroundingLines` 与粘性滚动（`stickyScroll.maxLineCount`，默认 5）的 padding（`viewLines.js` 的 `_computeScrollTopToRevealRange`），目标行距边缘 5 行。改用 `setScrollTop(editor.getTopForLineNumber(target) - stickyScrollHeight)` / `setScrollTop(editor.getBottomForLineNumber(target) - editor.getLayoutInfo().height)`；`center` 不受该 padding 影响，仍走 `revealLine`（`lineNumber` 0-based）。

粘性滚动默认开启（`editor.stickyScroll.enabled`），它是不透明 overlay，`getVisibleRanges()` 仍会算上被盖住的行。控制器通过 `getContribution('store.contrib.stickyScrollController').stickyScrollWidgetHeight` 取实际高度：`zt` 从 `scrollTop` 里减掉它，`H`/`M` 的可见行索引起点也跳过这些行。`H/M/L` 遍历可见 ranges 而不是直接做 `first + count` 算术，折叠造成的空洞不会成为目标行。

移动类 motion（`j/k`、`Enter`、`w/b/e`、`gg/G`、`{/}`、翻页）按**可见逻辑行**计数：`j/k` 保持 Vim 的 buffer-line 语义，闭合折叠只占起始行，控制器从 `getContribution('editor.contrib.folding').foldingModel` 的 `getAllRegionsAtLine()` 取 `(start, end]` 隐藏区，落点隐藏时吸附到折叠起始行（向前且从起始行出发时取 `end+1`），因此不会触发 Monaco 200ms 的自动展开。搜索、`%`、undo 不在吸附范围内——它们本就属于 Vim 默认 `'foldopen'` 的展开场景。

`gj` / `gk` 才按软换行后的**显示行**计数（Vim 的 display-line motion），支持 count、Normal / Visual / operator-pending。几何只用公开 API：`getLayoutInfo().wrappingColumn > 0` 判定 wrap 开启，`editor.getTopForPosition(line, column)` 返回该列所在显示行的顶部，`createScreenOps` 在行内按列二分找段边界；布局未就绪（方法缺失、返回 -1 / 非有限值）时退回 `j/k` 的逻辑行路径。闭合折叠整体算**一个**显示行，折叠头自身的软换行也按一行计（与 Vim 及 `advanceVisibleLines` 一致；Monaco 实际渲染仍可能展开头行）。行内没有下一段时跨到下一可见逻辑行的第一段（向上则进入上一行的最后一段）。期望屏幕列按段内**字符偏移**记忆：跨短显示段被 clamp 后，下一次 `gj/gk` 仍回到原偏移（`desiredDisplayOffset`）；tabs / 全角 / `wrappingIndent` 下与 Vim 的视觉列可能有轻微偏差，段边界本身由 Monaco 几何决定。wrap 关闭时 `gj/gk` 完全等同 `j/k`，operator 语义为 linewise；wrap 开启时是 characterwise exclusive（`dgj` 可被 o_v 规则提升为 linewise），寄存器类型与 Vim 一致。Visual 的 `v$` sticky eol 只在光标真的落在模型行尾时才把换行纳入选区，避免显示行移动把长行中间的换行算进去。

待定 operator 时按 `H/M/L/z` 会取消 operator 并吞键（`dH`、`dz*` 等组合明确不支持）。自动换行下 `H/M/L` 与 `zt/zb` 按逻辑行近似；`Ctrl+E/Y` 用 `wrappedLine` 不受影响。

### 编辑器折叠命令

`z` 前缀下的折叠开关直接映射 Monaco 编辑器动作；`[z` / `]z` 因 Monaco 没有「跳到折叠结尾」命令而由控制器自算：

| 命令 | 键 | Monaco 参数 | 语义 |
| --- | --- | --- | --- |
| `editor-command` | `zc` / `zC` / `zo` / `zO` / `za` / `zA` / `zM` / `zR` / `zj` / `zk` | `editor.fold` / `editor.foldRecursively` / `editor.unfold` / `editor.unfoldRecursively` / `editor.toggleFold` / `editor.toggleFoldRecursively` / `editor.foldAll` / `editor.unfoldAll` / `editor.gotoNextFold` / `editor.gotoPreviousFold` | 编辑器动作经 `editor.trigger` 执行 |
| `fold-goto` | `[z`（start） / `]z`（end） | 控制器内 `setPosition` | 从 `getAllRegionsAtLine()` 的「最内层 → 最外层」中取第一个该边不等于当前行的折叠，跳到它的起始/结尾行，列取首个非空白字符。**只对打开的折叠生效**（关闭折叠的内部不可见），因此不会触发 Monaco 200ms 的自动展开 |

`<leader>z` 是 `editor.gotoParentFold` 的可发现别名（Monaco 原生命令，列是第 1 列）；`[z` / `]z` 严格按 Vim 语义移到第一个非空白列。`zm` / `zr` 未实现：Monaco 只有绝对层级 `editor.foldLevel1`~`7`，与 Vim 相对增减的 foldlevel 语义不一致。

### Output 面板（受限 surface）

`LogOutputView` 以 `kind: 'editor'`、`defaultMode: 'normal'` 注册，surfaceKey 为 `editor:${viewId ?? 'output'}`，`actions.handleStroke` 转发给 `outputVimController`。它与文件编辑器**共用 reducer**、只投影可执行子集：

- 只支持滚动类命令（`j/k`、`gj/gk`、`Ctrl+E/Y`、`Ctrl+D/U`、`Ctrl+F/B`、`gg/G`），不会产生编辑 / 搜索 / Insert 命令；`v` / `V` / `Ctrl+V` 被吞掉并把共享 reducer 的状态拉回 Normal（只读缓冲区没有 Visual），不会再留下隐藏的 Visual 状态；未映射的可打印键吞掉，`Esc`（含 `Ctrl+[`）、方向键、`PageUp/PageDown` 仍交给 Monaco（查找框已打开时的 `Esc` 必须能关自己）。Normal 下 `Ctrl+F` 是整页下滚，不能用来打开查找框。
- 起了 operator 或除 `g` 外的前缀（`d`、`z`、`f` 等）会被立即丢弃，避免等待一个本 surface 永远不会执行的键。
- 翻页走 Monaco `editorScroll` 的 `by: 'halfPage' | 'page'`，按**视觉行**计量；Output 强制 `wordWrap: 'on'`，若用可见逻辑行数会把一条折成 20 行的日志算成 1 行。
- `gj/gk` 触发 Monaco `cursorMove`（`by: 'wrappedLine'`、`noHistory: true`），按视觉行移动并由 Monaco 保持期望列；它不调用 `onViewportScroll`——光标移动仍在跟随输出，只有 `Ctrl+E/Y` 这种纯视口滚动才需要释放 follow-tail。
- `Ctrl+E/Y` 不移动光标，因此控制器通过 `onViewportScroll` 回调让视图关闭 follow-tail（`setAutoScroll(false)`）；否则下一条日志 append 会把视口拽回底部。
- 控制器只跟踪 `onDidFocusEditorText/onDidBlurEditorText` 与 IME 守卫，blur 时重置计数；不写 `editorTextFocus`，避免 dirty-diff / inline completion 等命令误判。
- `Ctrl+E/Y` 与文件编辑器一样通过 window capture 的 Vim 分发消费，早于 `useGlobalKeybindingHandler` 的 document capture 安全网；后者只在 `vimNormalMode && editorTextFocus` 时兜底，Output 不满足该条件也无需满足。

### Session 输入框（prompt）

AI session 的输入框（`PromptMonacoEditor`）是内嵌 Monaco，直接接入编辑器内核：`attachVim` 的 `defaultMode` 取自 `vim.prompt.defaultMode`（`normal` / `insert`，默认 `normal`），`idleEscapeCommand: 'workbench.action.agent.focusTimeline'`，surfaceKey 为 `prompt:<sessionId>`。普通输入框仍走 dispatcher 的 editable guard 透传，prompt 是唯一例外（`vim.surfaces.editor` 同时控制两者）。

- 起始模式由 `vim.prompt.defaultMode` 决定，每次挂载时读取：默认 `normal`，聚焦后按 `i` 进 Insert 才能打字；设为 `insert` 则聚焦即可打字。切换设置后重新打开 session 输入框生效（已有模式记忆的存活输入框不受影响）。
- Insert 下 `Enter` 提交、`Tab` / `ArrowUp` 开候选或历史，都是输入框已有的本地行为，Vim 不截。Normal 的 `Enter` 是 Vim 的 `enter` motion，不发送消息。
- 浮层打开期间 dispatcher 对 editor kind 放行（分发顺序第 7 步）：方向键 / `Tab` / `Enter` 归 suggestion 命令，`Esc` 先关浮层且模式不变，再按一次才退出 Insert。
- 空闲 Normal `Esc` 执行 `workbench.action.agent.focusTimeline`，从时间线按 `i` 可回到输入框（`vimAppKeymap` 已有）。
- 焦点键仍是 `acpPromptInputFocused`，不桥接 `editorTextFocus`（见 `docs/development/monaco-embedding.md`）；因此 `useGlobalKeybindingHandler` 的 `inVimNormalSurface` 显式把 prompt 的 Normal 算进去，否则 User 键位让行后会被文本输入守卫吞掉。

## User 让行与保留集

`VimDispatcher` 用 `buildKeyString(event)` 得到 keybindings.json 形态的键串，然后调用：

```ts
KeybindingsRegistry.hasBindingAtOrAbove(
  keyString,
  KeybindingWeight.User,
  contextKeyService,
)
```

该函数按首键做桶索引（热路径不扫全表），忽略 negated 条目，检查 `when` 与二段 chord；weight ≥ 1000（`User`）才让行。保留集来自 `vim.reservedKeys`：多字符 token 转小写、`<leader>` 先替换，编辑器与 surface 共用。默认保留 `escape`、`ctrl+[`、`i`、`a`、`:`、`/`、`?`、`<leader>`。让行只在**没有待定序列**时判断。

排查工具：

- `workbench.action.vim.showActiveKeymap`（**Vim：显示当前键位映射**）把当前 surface 的有效 keymap（标注 `[this surface]` / `[kinds]` / `(user override)`）、`vim.keymap` 的覆盖与解绑、**解析问题**、保留集、被 User 遮蔽的键写入 Output 的 **Vim Keymap** 通道。
- `workbench.action.vim.showKeymapCheatSheet`（**Vim：显示键位速查表**，`<leader>?`）：QuickPick 列出每类 surface 的有效键位（已合并用户覆盖 / 解绑，当前 surface 排最前并标 `(current)`），编辑器部分另含内核键位说明（`vimKeyHelp.ts`，动态 `import` 以免拖慢首屏）。支持按键位 / 命令 id / `when` 过滤。

## 反馈：状态栏与 which-key

- 状态栏有两个条目，都由 `VimModeService` 管理：
  - `vim-mode`：图标 + 文字（`NORMAL` / `INSERT` / `VISUAL` / `V-LINE` / `V-BLOCK` / `TERMINAL`），点击切换 `vim.enabled`。受 `vim.showStatusBar` 控制。
  - `vim-feedback`（紧挨着，priority 低 1）：编辑器内核的待定键（`"a2d3`、`g`、`ci`，`formatPendingKeys`）优先，否则是工作台序列引擎的「计数 + 前缀」（`3gg`、`<Space>w`）；若有 `Unsupported: <key>`（吞掉了一个没有映射的键；**`reportUnsupportedKey` 不再自己格式化，由调用方传展示串**——dispatcher 用 `formatVimKeys(tokens)`，编辑器内核传原始键名）则先显示它，1.5s 后自动消失，同键连发按 100ms 节流。切换 active surface 时这些反馈一并清空。
- **which-key**：dispatcher 是多键提示的唯一调度者，工作台引擎与编辑器内核共用同一浮层、300ms 延迟（`WHICH_KEY_DELAY_MS`）与 `vim.whichKey` 开关。
  - 工作台引擎：前缀 pending 后调 `computeWhichKeyItems`（按有效键位 + `when` 过滤，列出下一键及其命令标题，只开新分支的显示 `+N`）。
  - 编辑器内核：每次 Normal / Visual / Insert 击键后由 surface 的 `getPendingHint()` 拉取 `computeVimPendingHint`（`vim/editor/vimPendingHints.ts`）。覆盖 `g` / `z` / `[` / `]`、操作符等待（`d`/`y`/`c`/`>`/`<`/`g~`…）、`i`/`a` 文本对象与 Visual `g`；等待字符参数（`f`/`r`/`"`）和纯计数不弹。候选标题与速查表同源（`describeVimKeyHelp`）。
  - 一旦打开，之后每次前缀推进**立即**刷新（`<Space>` → `<Space>w`、`d` → `di` 不再等 300ms），且引擎序列**暂停超时**（除非有 deferred 匹配）——只有 `Esc`、新一击或焦点切换才结束。`vim.whichKey=false` 关闭。`VimWhichKey` 组件经 portal 渲染到活动窗口 document，纯展示。
  - **补全优先**：编辑器 surface 在 `show()` 时检查全局 `suggestWidgetVisible`，为真则暂不弹（状态栏 pending 保留）；退出 Insert 时 controller 主动 `hideSuggestWidget`，避免补全残留到 Normal 后再被浮层压住。
  - `vim.keymap` 只影响工作台引擎，不改变内核前缀的候选；`vim.leader` 若与 `g`/`z`/`[`/`]` 同键，引擎先截获，提示跟随引擎键位表。

## 上下文键

| key | 写入方 | 含义 |
| --- | --- | --- |
| `vimEnabled` | `IVimModeService` | 全局开关 |
| `vimMode` | `IVimModeService` | 活跃 surface 的 `normal` / `insert` / `''` |
| `vimNormalMode` | `IVimModeService` | 活跃 surface 是否处于普通 Normal（Visual 视为 Normal；终端 Normal 为 false，由 `vimTerminalNormalMode` 表示） |
| `vimVisualMode` | `IVimModeService` | 活跃编辑器是否处于任一 Visual 子模式 |
| `vimSurface` | `IVimModeService` | 活跃 surface 的 kind |
| `vimSurfaceId` | `IVimModeService` | 活跃 surface 的 id（用于 `when`） |
| `vimTerminalNormalMode` | `IVimModeService` | 活跃终端是否 Normal |
| `vimSearchFocused` | 编辑器搜索控制器 | 编辑器 Vim 搜索框聚焦，Find 家族快捷键据此让行 |
| `webviewFocus` | `FocusContextKeyContribution` | 焦点在 iframe / webview 标记内（与 dispatcher 共用 `isWebviewElement`） |

这些 key 在 `ContextKeyContribution` 预建、在 `knownContextKeys.ts` 登记，供 Keyboard Shortcuts 编辑器补全。`vimNormalMode` 同时是全局分发器 paging 安全网的放行条件。被 `vim.surfaces.*` 关掉的 surface 视同不存在，其模式不会泄漏进这些 key。

## 模式记忆与 surfaceKey 约定

`IVimModeService` 用 `Map<surfaceKey, mode>` 保存**内存态**模式；`getMode(key, defaultMode)` 在无记录时返回默认值，`setMode` 触发 `onDidChangeMode` 并刷新活跃 surface 的 context key / 状态栏，`forgetSurface` 删除记录。编辑器的 Visual 子模式单独存（`setEditorSubMode`），换粗粒度模式时自动丢弃。焦点切换时 `useVimDispatcher` 调 `dispatcher.resetAll(doc)`：清掉待定计时器、状态栏 pending 与 which-key，并把该文档所有 surface 的序列引擎归零，避免 `5` 或未完成的 leader 从列表带进编辑器。

约定：

| surface | surfaceKey |
| --- | --- |
| 编辑器 | `editor:${groupId ?? 0}:${inputId}`（`editorVimSurfaceKey`）；同一文件两个分屏互不影响，关闭输入时 forget |
| Agent 输入框（prompt） | `prompt:${sessionId}`（`promptVimSurfaceKey`）；`kind: 'editor'`、默认取 `vim.prompt.defaultMode`（出厂 `normal`），卸载时 forget（重新打开按该默认值开始）；同 session 的两个分屏共享模式记忆 |
| 终端 | `terminal:${terminalId}`；默认 `insert`，终端在 panel / editor 间移动不重建键 |
| 列表 / 树 / 图谱 | `list:${viewId}`；无 id 时 `list:auto:<n>` |
| Markdown 预览 / 文档中心 | `reader:auto:<n>` |
| 菜单 | `menu:auto:<n>`（菜单短暂，通常无需记忆） |
| 浮层 | `overlay:${id}`，如 `overlay:notifications` |
| 编辑器标签栏 | `tabs:${groupId}` |
| ActivityBar | `activityBar` |
| 视图容器标题 | `viewContainerTabs:${location}` |

## 终端 Normal Mode

终端 surface 每个实例注册 `kind: 'terminal'`、`defaultMode: 'insert'`，`actions` 来自 `createTerminalSurfaceActions(controller)`；实际行为由 `TerminalNormalModeController` 实现，controller 注册到 `terminalNormalModeRegistry`，命令按「当前 DOM 焦点所在的终端」找到它。

- **键位走通用 `list.*`**：`vimAppKeymap.ts` 的 `TERMINAL_ENTRIES` 把 `j/k`、`Ctrl+E/Y`、`Ctrl+D/U`、`gg/G` 映射到 `list.focusDown/Up`、`list.scrollViewportDown/Up`、`list.pageDown/Up`、`list.focusFirst/Last`（所以 count 语义与列表一致）；只有 `Ctrl+F/B`（整页）、`v`、`y`、`i/a/q` 保留终端专用命令，`Esc` 走 `surface.escape` → `exitNormalMode`。
- 进入：`workbench.action.terminal.enterNormalMode`，默认 `ctrl+shift+\`，`when: 'terminalFocus'`。
- 状态：模式写进 `IVimModeService`（`terminal-normal`）；组件同步 `data-vim-normal`。
- 操作：`j/k` 行滚动、`Ctrl+E/Y` 纯视口行滚动（不移动光标）、`Ctrl+D/U` 半页、`Ctrl+F/B` 整页、`gg/G` 边界（`NG` / `Ngg` 跳到第 N 行 buffer 行）、`v` 开始按行选择（`j/k` 扩展）、`y` 复制并退出。
- 退出：`i` / `a` / `q` / `Esc`。有选区时先清除选区并保持 Normal（`i/a/q/Esc` 都走同一个 `exitNormalMode`），再按一次才回到 shell；`dispose()` 只是 **detach**（面板 ↔ 编辑器区 reparent 或卸载）：释放输入法、清选区状态，但**保留已记住的 Normal 模式**（xterm holder 与模式都比视图活得久），重新挂载后若焦点仍在则继续持有英文。模式记忆只在终端进程真正被移除时 `forgetSurface`。
- 输入法：Normal **且持有焦点**时按 `vim.autoSwitchInputMethod` 切英文，owner 是 controller 实例（见下节）；宿主通过 `handleFocusIn/Out` 与窗口 `blur` / `focus` 报告焦点，失焦即归还。

## 输入法

Normal 下切英文是**窗口级**状态（main 只存一份「保存的输入法」），所以所有请求都收口到 `vimInputMethod.ts`，且采用 **owner 模型**：

```ts
requestInputMethod(owner, service, desired) // 'english' | 'native'
releaseInputMethod(owner, service)          // 仅当 owner 正持有英文时才归还
```

- `english` 会把窗口级所有权交给调用方（后到者替换前任持有者）；`native` 只有在「调用方持有英文」或「无人持有」时才生效，所以从没切过英文的 surface 无法撤销别人的切换。
- 只在 `english` ↔ `native` 迁移时发 IPC，调用串行化（快速 `Esc` → `i` 不会乱序）；`switchToEnglish` 失败会退回 `native` 状态，下次击键重试。
- owner 是任意对象（controller / coordinator 实例本身），测试里用 `resetVimInputMethodForTests()` 清理模块级状态。

三方各管各的：

| 谁 | 管什么 |
| --- | --- |
| 编辑器 controller | 文本聚焦且非 Insert → english；Insert / 关闭 → native；**没有文本焦点的编辑器从不 request**，只在 `syncInputMethod` 里 `release`，所以后台分屏 / 后台编辑器响应配置变化或被销毁时不会把焦点编辑器的英文抢回中文 |
| 终端 controller | `terminal-normal` 且有焦点 → english，失焦 / detach / 退出 Normal → release；reparent 后重新挂载若焦点仍在则继续持有 |
| `VimImeCoordinator` | 其余所有 surface（列表 / 树 / 菜单 / 标签栏…）：活跃且 Normal → english，离开后只归还**自己拿过的**；跟踪所有工作台 document（主窗口 + 辅助窗口）的焦点，全部失焦时释放（Alt+Tab 到别的应用不带着英文走），回焦时重新声明 |

协调器看到编辑器 / 终端 surface 一律 `leave`（不插手），避免与它们各自的 controller 抢。

## 焦点位置与导航历史

`Ctrl+O` / `Ctrl+I` 在所有 surface 上都是 `goBack` / `goForward`，所以 view 焦点也进同一个 `IHistoryService` 栈，作为 `IHistoryViewEntry`（`kind: 'view'`，只有 `viewId`）与编辑器条目混排。

- **只在 `vim.enabled` 开启时记录**：`HistoryContribution` 订阅 `IFocusTrackerService.onDidFocusChange` 与精确 key `'vim.enabled'`；关闭时 `removeViewEntries()` 清掉两个栈里的 view 条目，非 Vim 行为与 VSCode 一致。开启期间 Alt+←/→、标题栏按钮、鼠标侧键走同一个栈。
- **哪些焦点算 view**：`services/history/historyLocation.ts` 的 `resolveHistoryLocation`。EditorArea（含辅助窗口）算编辑器；SideBar / Panel / SecondarySideBar 里带 `data-view-id` 且所在 Part 可见的算 view（过滤掉隐藏 Panel 里终端的瞬态焦点）；活动栏、状态栏、标题栏、quick input、菜单返回 undefined，保留上一次位置。
- **editor → view**：先 `_flushActiveEditor()` 落下失焦时的光标（同时取消待发的 debounce，否则它会压到 view 之上），再 `recordView`。**view → editor**：把编辑器当前位置 record 在 view 之上；Go Back / Go Forward 落地时这次 record 被目标的抑制窗口吞掉，forward 不受影响。
- **`recordView` 去重**：栈顶已是同一 view 时什么都不做（Ctrl+I 落地不清 forward）；否则删掉栈里旧的同 id 条目、合并因此相邻的同文件同行编辑器条目，再压栈并清 forward。所以在 view 和编辑器之间来回切换不会让栈增长。
- **提升**：在 view 里空格预览文件时焦点留在 view，预览的 record 压在 view 之上。`onWillNavigate` 先按 `document.activeElement` 现读位置（focus tracker 晚一个 task），若在 view 里就 `recordView` 把它提升到栈顶，否则 Ctrl+O 只会弹掉预览、落回当前 view。
- **count 在服务内部步进**：`goBack({ count, isStale })` 只 fire 一次 `onWillNavigate`，避免循环调用时每步都重新提升。`isStale`（`historyActions` 里用 `isViewAvailable` 判断 view 是否已注销或被 `when` 隐藏）为真的条目不消耗 count、直接丢弃；没有可落点时两个栈都不改。view 目标不设抑制窗口。
- **已知限制**：`LayoutService.focusView` 用静态默认容器，被拖到别的容器的 view 可能聚焦失败；失败时不回滚栈；view 条目不记录选中行。

## Webview

不做承诺：焦点在 iframe 内时，surface 仲裁不会命中工作台 surface；dispatcher 还会在 `isWebviewFocus` 为真时直接放行。`WebviewElement` / `HtmlPreviewEditor` 已加标记。不要再为 iframe 注入按键桥。

## 测试与 e2e

| 层 | 位置 |
| --- | --- |
| workbench-ui | `src/__tests__/vimSequence.test.ts`、`vimSurfaceRegistry.test.tsx`、`vimSurfaceAdapters.test.tsx`、`vimIndexActions.test.ts`、`vimDefaultKeymap.test.ts`、`vimSurfaceKeymap.test.tsx`、`ctrlNavigationRegistry.test.tsx` |
| platform | `src/__tests__/command/keybindingRegistry.test.ts`（含 User 覆盖 / `hasBindingAtOrAbove`） |
| 服务 / 键位 | `services/vim/__tests__/`：`vimModeService.test.ts`、`vimAppKeymap.test.ts`、`vimKeymapMerge.test.ts`、`vimKeyFormat.test.ts`、`vimCheatSheet.test.ts`、`vimCommandTitle.test.ts`；`contributions/__tests__/vimConfigKeys.test.ts`（保证 `VIM_SERVICE_CONFIG_KEYS` 覆盖 `SettingsContribution` 注册的 `vim.*`） |
| 分发 / 反馈 | `workbench/vim/__tests__/`：`vimDispatcher.test.ts`（含内核前缀的 300ms 打开、已打开时立即刷新、`suggestWidgetVisible` 抑制、engine 优先）、`useVimDispatcher.test.tsx`、`vimImeCoordinator.test.ts`、`vimWhichKeyItems.test.ts`、`VimWhichKey.test.tsx`；`actions/__tests__/vimActions.test.ts` / `vimSurfaceActions.test.ts` / `vimCheatSheetAction.test.ts` |
| surface 适配 | `workbench/editor/__tests__/useEditorTabsVim.test.tsx` / `useMarkdownKeyboardNav.test.tsx`、`activitybar/__tests__/ActivityBar.vim.test.tsx`、`paneComposite/__tests__/PaneCompositeHeader.vim.test.tsx`、`preferences/__tests__/SettingsEditor.vim.test.tsx`、`gitGraph/__tests__/useGraphKeyboardNav.vim.test.tsx`、`terminal/__tests__/terminalNormalMode.test.ts` / `terminalNormalMode.inputMethod.test.ts`（owner 模型下的焦点 / 归还）/ `TerminalInstance.vimReparent.test.tsx`（面板 ↔ 编辑器区 reparent 保持 Normal） |
| 编辑器内核（纯） | `workbench/editor/vim/__tests__/`：`vimKeymap` / `vimMotions` / `vimOperators` / `vimTextObjects` / `vimRegisters` / `vimSearch` / `vimInputMethod` / `vimKeyHelp` / `vimPendingHints`（内核 which-key 候选）/ `vimVisual` / `vimKeyUtils` / `vimViewport`（显示行几何与折叠，内联 mock `getTopForPosition`）`.test.ts` |
| 编辑器内核（绑 Monaco） | 同目录 `vimEditorController.test.tsx`（含 Insert 退出关补全、`getPendingHint`）、`vimEditorFeatures.test.tsx`（`.` / 寄存器 / Insert 分组等）、`vimEditorVisual.test.tsx`、`vimEditorRegressions.test.tsx`（审查修复的回归集：pending 取消、curswant、折叠、只读、`.` 按键流、输入法归属…），统一用 `fakeVimEditor.ts` 搭假编辑器 |
| Output | `workbench/panel/output/__tests__/outputVimKeymap.test.ts` / `outputVimController.test.ts` / `LogOutputView.test.tsx` |
| 视口滚动 | `packages/workbench-ui/src/__tests__/scrollViewport.test.ts`、`vimSurfaceAdapters.test.tsx`（Tree/FlatList/Overlay）、`gitGraph/__tests__/useGraphKeyboardNav.vim.test.tsx`、`agents/__tests__/ChatBody.test.tsx` |
| DI 脚手架 | `renderer/__tests__/_helpers/vimTestHarness.ts`（真 ContextKeyService + ViewDescriptorService，ActivityBar / 容器标题测试共用；新写 surface 测试先看它） |
| e2e | `smoke.vimGlobal.spec.ts` / `smoke.vimPriority.spec.ts`（@p0）、`smoke.vimMode` / `smoke.vimKeymapNavigation` / `smoke.vimTabs` / `smoke.vimTerminalNormal` / `smoke.vimSettings` / `smoke.vimWebview` / `smoke.vimChat` / `smoke.vimPromptInput` / `smoke.vimInteraction`（@p1；状态栏 VISUAL / V-LINE、文本对象与 `.`、leader 与内核前缀的 which-key、补全优先、速查表、空闲 `Esc`、`Unsupported:` 反馈、prompt 输入框的 Insert/Normal 与浮层让行）；公共驱动在 `e2e/pages/vimHelpers.ts`（`setVimEnabled` / `statusIcon` / `statusText` / `feedbackText` / `openTextEditor` / `setText` / `focusExplorerTree` / 光标与文本读取 / `expectStableFor`——断言「一段时间内保持不变」，用于验证按键没有副作用） |

e2e 通过 `window.__E2E__.runCommand('_workbench.updateConfiguration', 'vim.enabled', value)` 开关（先 `whenUserSettingsInitialized`，冷启动早写会丢），并用 `getContextKey` / `getStatusBarEntries` / `getActiveEditorUri` 断言，不戳 Monaco 内部 DOM。

## 常见坑

- **xterm 的 textarea 是 editable**：终端默认 Insert；surface 仲裁对 `editor` / `terminal` 设了 `allowEditableFocus`，dispatcher 又在 editable guard **之前**处理终端分支。把终端分支挪到后面会让 Normal 完全不生效。
- **带 `when` 的普通键位同键要加 weight**：这是 keybinding 注册表的通用规则（weight 高者优先，`when` 只过滤）。Vim keymap 的 `when` 排序是 dispatcher 内部逻辑，两者不要混为一谈。
- **`Action2.run(accessor)` 不能跨 await**：Vim 命令大多通过 `getActiveVimSurface(...)` 直接取 action，或在首个 await 前把 service 快照取完；新增异步命令照此办理（速查表命令先取 `IVimModeService` / `IQuickInputService` 再 `await import`）。
- **浮层宿主必须提供 `onEscape`**：`surface.escape` 会被 dispatcher 消费；`useOverlayListNavigation` 只把 Escape 转给宿主的 `onEscape`，没给就等于「按 Esc 什么都没发生」。
- **菜单零行必须 `enabled: false`**：菜单以虚拟焦点常驻，否则空菜单也会抢走方向键 / Vim 键。
- **不要新增 window 监听**：同一表面注册多个 capture 监听会让一次按键移动两次（`stopPropagation` 挡不住同 target 的其它监听）。只注册 surface。
- **编辑器不要用 `editor.addCommand`**：standalone Monaco 的 keybinding service 跨实例共享，会吞掉其它编辑器的键；编辑器 Vim 内核走 `handleStroke`。
- **editable guard 是刻意让行**：树 / 列表里的搜索框、行内输入框必须能正常打字；只有 `editor` / `terminal` 例外。
- **surfaceKey 必须稳定**：使用自动键的组件每次挂载都是新实例；需要跨卸载记忆的视图必须传稳定 id，并在真正该重置时 `forgetSurface`。
- **surface 自带键位的数组引用要稳定**：有效键位按数组引用缓存，在组件体里每次 `[...]` 新建会让每击都重新合并。
- **`vim.*` 配置订阅是精确匹配**：新增 `vim.*` 配置必须同时加进 `VIM_SERVICE_CONFIG_KEYS`（服务）或编辑器 controller 自己的 `affectsConfiguration` 分支，否则静默不生效；`vimConfigKeys.test.ts` 会兜底。
- **Ctrl 别名优先级**：菜单 / 浮层 / 对话框 / 配置栏聚焦或打开期间，`Ctrl+J/K/H/L` 在到达 Vim 前已被 `ctrlNavigationRegistry` 消费，因此这段期间 `Ctrl+K` 和弦不可用，这是设计代价。纯列表 / 树不注册 layer，这四键保持全局含义，导航走裸键或方向键。
- **模式是内存态**：重启不保留；不要把它当用户设置持久化。
- **编辑器内核命令分两路**：Monaco action（`editor.action.*`）用 `editor.trigger`；workbench 命令（`workbench.action.*`，如 `]c` / `[c`、`Ctrl+O`）必须走注入的 `executeCommand` 回调。把 workbench 命令塞给 `editor.trigger` 会静默 no-op。
- **内核键位说明是派生的**：别在速查表里手抄键位；加 motion / operator / 文本对象 / 前缀项 / Visual 键时说明自动生成，漏的是 `vim.keyHelp.*` 翻译（测试会提示）。
- **Normal 抢了 Ctrl 组合**：编辑器 Normal 下 `Ctrl+V`（块选择，不再粘贴）、`Ctrl+R`（重做）、`Ctrl+E/Y/D/U/F/B` 都归内核，`vim.keymap` 无法覆盖，只能 `vim.surfaces.editor=false` 或回 Insert；但用户可以写 `surfaces: ['editor']` 的同键修饰键条目，它会先于内核被引擎截走。`Ctrl+O` / `Ctrl+I` 在键位表里（`nav.back` / `nav.forward`），所有 Normal surface 同义、可改绑；它们会遮住列表上的全局 `Ctrl+O`（打开文件），editable 控件里不受影响。从 view 按 `Ctrl+O` 回到的是进入 view 前的编辑器位置，不是上一个编辑器条目（见[焦点位置与导航历史](#焦点位置与导航历史)）。
- **新增「到处都该生效」的键写进键位表**，不要再写进编辑器内核：内核私有键在其它 surface 落空后会掉到全局默认键（`Ctrl+O` 曾在 Explorer 里弹出打开文件对话框）。
- **多窗口**：provider 按 Document 隔离，`Workbench.tsx` 与 `AuxiliaryWindowHost.tsx` 各装一份 `useVimDispatcher`；新增窗口宿主也要装。

## 相关

- [命令、快捷键与上下文键](commands-and-context-keys.md)
- [浮层层级与裁剪](overlay-layers.md)
- [嵌入 Monaco](monaco-embedding.md)
