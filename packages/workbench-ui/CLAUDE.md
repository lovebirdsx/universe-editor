# packages/workbench-ui/CLAUDE.md

Workbench 风格 React UI 基础设施。**依赖 React，不依赖 Electron**，可在 happy-dom 环境单测。

## 提供的能力

| 模块 | 用途 |
|---|---|
| `ContextViewService` | Floating UI 定位 + Portal 渲染的浮层服务 |
| `ContextMenu` | MenuRegistry 驱动的右键菜单（消费 `MenuId.*` 注册的条目，`args` 透传命令参数） |
| `HoverService` | delay 触发 / keyboard-accessible 的 hover popup |
| `TooltipProvider` | 全局委托 tooltip：元素挂 `data-tooltip="…"` 即得主题化气泡（替代原生 `title`）；editor 在 `main.tsx` 根部挂载 |
| `VirtualList` | `@tanstack/react-virtual` 薄包装，固定/动态行高均支持 |
| `Tree` / `useTreeModel` / `useOwnedTreeModel` | 虚拟化树（数据源 + 选择 + 展开模型）；组件自建 TreeModel 用 `useOwnedTreeModel` |
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

- **组件内自建 `TreeModel` 必须用 `useOwnedTreeModel(() => new TreeModel(...))`**：裸 `useRef`/`useMemo` 持有 + `useEffect` cleanup 里 `dispose()` 的写法在 React StrictMode 下会被「卸载演练」dispose 掉并在重挂载时复用 dead 实例（Emitter 不再 fire，`refresh()` 成 no-op），导致树永远不再更新——**dev-only，production build 不复现**（StrictMode 双挂载只在 dev 生效）。TreeModel 由 DI service 持有时不受此影响。
- **无 Electron 依赖**：不 import `electron` / `@electron/...`
- **不依赖 platform DI**：通过 props 接收服务实例，不用 `@IFooService` 装饰器
- **图标走 props/children 注入**：不引应用图标库（如 `lucide-react`）；调用方传入图标元素或 `renderIcon` 回调
- 可选 className 类 props 声明为 `string | undefined`（兼容调用方传入的 `styles['x']`，应对 `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）
- 测试文件位于 `src/__tests__/`，环境 `happy-dom`
- 相对导入带 `.js` 后缀（ESM only）
