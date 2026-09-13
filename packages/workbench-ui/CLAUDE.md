# packages/workbench-ui/CLAUDE.md

Workbench 风格 React UI 基础设施。**依赖 React，不依赖 Electron**，可在 happy-dom 环境单测。

## 提供的能力

| 模块 | 用途 |
|---|---|
| `ContextViewService` | Floating UI 定位 + Portal 渲染的浮层服务 |
| `ContextMenu` | MenuRegistry 驱动的右键菜单（消费 `MenuId.*` 注册的条目，`args` 透传命令参数）；键盘导航走 window capture + 虚拟焦点；传 `renderIcon` 即为每行渲染定宽图标插槽（不传则无插槽，外观不变）；传 `autoFocusFirst` 即开菜单就高亮首项（只给键盘打开的菜单用，鼠标打开保持无高亮）。菜单 armed 期间 `Ctrl+P` / `Ctrl+N` / `Ctrl+H` / `Ctrl+L` 与四个方向键一一对应，且**落空也吞**（方向键落空会放行给下层，别名不会——否则 Ctrl+H 会在菜单上方弹出替换浮层）；只在 armed 期间生效，`Ctrl+Shift+P`（命令面板）/ `Ctrl+Shift+N`（新窗口）/ `Cmd+P` 等带额外修饰键的组合一律放行，代价是 `Ctrl+K Ctrl+L` 这个弦和键的第二段会被吃掉（全仓唯一一段以别名键收尾的弦和键）。**解析出 0 行 = 菜单不打开**：渲染 null 并立即回拨 `onClose()` 让宿主清掉打开状态——空菜单绝不留存（否则 window capture 的导航监听常驻，会把 ArrowUp/Down 从唤出它的树上吞掉；左右键因 expand/collapse 落空而放行，症状是「上下死、左右活」） |
| `ListMenu` | **items 驱动**的右键菜单：菜单项在打开时由视图自己算（异步拉来的 transition、按 worktree 禁用的 rename、带快捷键提示的行……），塞不进 MenuRegistry 的静态 `when` 模型时用它。与 `ContextMenu` 共用同一套 `useMenuNavigation` + `MenuRows`，键盘行为/DOM 完全一致，不会各自漂移。item 支持 `hint`（右对齐次要文字）/ `danger` / `disabled`（可见但惰性：变暗、方向键跳过、Enter 与点击均无效）/ `kind: 'submenu'`；选中项会**先关菜单再执行** run |
| `HoverService` | delay 触发 / keyboard-accessible 的 hover popup |
| `TooltipProvider` | 全局委托 tooltip：元素挂 `data-tooltip="…"` 即得主题化气泡；普通 `title` 属性也会被接管（悬停期间暂存到 `data-tooltip-native-title` 抑制原生气泡，离开后还原；iframe/webview 除外），editor 在 `main.tsx` 根部挂载 |
| `VirtualList` | `@tanstack/react-virtual` 薄包装，固定/动态行高均支持 |
| `Tree` / `useTreeModel` / `useOwnedTreeModel` | 虚拟化树（数据源 + 选择 + 展开模型）；组件自建 TreeModel 用 `useOwnedTreeModel` |
| `tree/keyboardContextMenu` | ContextMenu 键 / Shift+F10 唤出右键菜单的共用件，Tree 与手写行列表（会话列表、快捷键表格、提交图）都走它：`isContextMenuKey(e)` 认键、`dispatchKeyboardContextMenu(row, isRow)` 在行上合成 `contextmenu`（走 DOM 的宿主）、`createKeyboardContextMenuEvent(x, y)` 造一个**不派发**的标记事件（直接调处理函数的宿主，如提交图）、`isKeyboardContextMenu(e)` 识别来源以决定 `autoFocusFirst`、`isKeyupContextMenuSupplement(e)` 吞掉 Chromium 在 keyup 补发的那个原生 contextmenu（`detail: 0` + `button: -1`、落在焦点元素上、坐标是该元素中心**不是 (0,0)**；keydown 的 `preventDefault` 取消不掉它，**自己从 keydown 开菜单的宿主必须吞**，否则同一次按键会把行级菜单换成空白区菜单）、`findRowElement` 按属性值遍历查行（**不要拼 CSS 选择器**，行 id 常含 `.` 与 `\`）。**判来源不能看 `detail`**：合成事件刻意伪装成 `detail: 1` 正是为了躲开这层守卫。反过来，浏览器**原生**由键盘触发的 contextmenu/click 是 `detail === 0`——Monaco 右键菜单与编辑器标题溢出按钮不合成任何事件，原生事件本身就是唤出路径，所以那两处直接内联判 `e.detail === 0` 当「键盘打开」，与本守卫同式反义，勿混用 |
| `useDragHandle` / `useDropTarget` / `DragSessionContext` | 原生 HTML5 DnD source/target + 跨边界 payload 传递 |
| `atoms/*` | `Button` / `IconButton` / `Input` / `Checkbox` / `Badge` / `Spinner` + `cx` 工具 |
| `layout/*` | `Sash`（拖拽分隔条）/ `GridLayout`（消费 platform `Grid<T>`）/ `CollapsibleSlot`（图标走 props 注入） |
| `overlay/*` | `FocusScopeOverlay`（focus trap + Esc）/ `PopoverList<T>`（泛型列表浮层，合并 Slash/Mention 类弹窗） |
| `feedback/notifications` | `NotificationsToast` / `NotificationsCenter`（展示组件，吃 `INotification[]` + 回调） |
| `feedback/quickInput` | `QuickInputPanel` + `QuickPickState`（图标走 `renderIcon` 注入） |
| `feedback/progress` | `ProgressDialog` + `DialogProgressState` |
| `feedback/dialog` | `ConfirmDialog` / `PromptDialog`（队列 + Portal 留在宿主） |
| `text/fuzzyMatch` | 零依赖模糊匹配纯函数（`fuzzyMatchField` / `scoreFuzzyMatch` / `wordMatchField`） |
| `theme/tokens.css` | 设计 token（间距/圆角/字号/字重/行高/阴影/z-index），走 `@universe-editor/workbench-ui/tokens.css` 子路径引入 |

## 展示组件 + 宿主 wrapper 范式

`feedback/*` 下的组件都是**纯展示**：props = 数据 + 回调，**不自带 Portal、不碰 service**。`apps/editor` 侧保留同名薄 wrapper，负责 `useService` 订阅 → `createPortal` → 拍平成 props（见 editor 的 `NotificationsToast`/`QuickInputPortal`/`DialogHost`/`ProgressDialogHost`）。新增 feedback 类组件按此分层，service 接口类型可从 platform `import type`（单向合法），但**不引入 DI**。

## 设计 token

新组件一律只用 `theme/tokens.css` 的 token（间距/圆角/字号/阴影）+ 颜色变量 `var(--vscode-<colorId 点转横线>)`，禁硬编码。颜色变量由 editor 主题系统运行时注入（注册表在 editor 的 `services/themes/universeColorIds.ts`，本包 css 只消费；fallback 值仅兜底无主题环境如单测）。**禁止再引入旧 `--color-*` / `--workbench-menu-*` 变量**——它们已无定义源，fallback 是深色值，浅色主题下必穿帮；editor 侧 `cssVarCoverage.test.ts` 会扫描本包并拦截 legacy 变量与未注册的 `--vscode-*`。

## 何时新建组件

- 需要 Floating UI 定位能力（popup / tooltip / dropdown）
- 需要跨组件 DnD 状态共享
- 需要虚拟滚动（列表 > 200 项时）
- 通用原子控件 / 反馈类浮层（多处复用、与具体业务解耦）

## Floating UI 用法

```tsx
import { useFloating, autoPlacement, offset } from '@floating-ui/react'

const { refs, floatingStyles } = useFloating({
  middleware: [offset(4), autoPlacement()],
})
```

## 关键约束

- **Floating UI 浮层放进 `FocusScopeOverlay` 有隐性契约**：浮层经 `FloatingPortal` 渲染到 `document.body`，在 `FocusScope contain` 的子树之外，键盘打开时被移进浮层的焦点会被 react-aria 拽回去——所以浮层根节点必须带 `data-react-aria-top-layer`（react-aria 官方逃生口，见其 `isElementInChildScope`；`Select` 已带）。另一半：`FocusScopeOverlay` 的 document 级 Escape 监听先于 floating-ui `useDismiss` 注册，会在关浮层时连带关掉整个 overlay——已在 `FocusScopeOverlay` 侧按「事件源在 `[data-floating-ui-portal]` 内」或「事件源的 `aria-controls` 指向 portal 内元素」（鼠标打开时焦点仍在触发器上，靠后者兜住）放行。新写浮层组件照 `Select` 抄这两点。宿主侧还有第三环（editor 的 `useGlobalKeybindingHandler`：document capture 命中全局键位就 `preventDefault + stopPropagation`，会让 Escape 根本到不了浮层——已按 `[data-floating-ui-portal]` 内的 target 放行，同 `isInsideRendererDialog` 的先例）。
- **组件内自建 `TreeModel` 必须用 `useOwnedTreeModel(() => new TreeModel(...))`**：裸 `useRef`/`useMemo` 持有 + `useEffect` cleanup 里 `dispose()` 的写法在 React StrictMode 下会被「卸载演练」dispose 掉并在重挂载时复用 dead 实例（Emitter 不再 fire，`refresh()` 成 no-op），导致树永远不再更新——**dev-only，production build 不复现**（StrictMode 双挂载只在 dev 生效）。TreeModel 由 DI service 持有时不受此影响。
- **无 Electron 依赖**：不 import `electron` / `@electron/...`
- **不依赖 platform DI**：通过 props 接收服务实例，不用 `@IFooService` 装饰器
- **图标走 props/children 注入**：不引应用图标库（如 `lucide-react`）；调用方传入图标元素或 `renderIcon` 回调
- 可选 className 类 props 声明为 `string | undefined`（兼容调用方传入的 `styles['x']`，应对 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）
- 测试文件位于 `src/__tests__/`，环境 `happy-dom`
- 相对导入带 `.js` 后缀（ESM only）
