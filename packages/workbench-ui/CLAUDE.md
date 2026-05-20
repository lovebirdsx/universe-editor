# packages/workbench-ui/CLAUDE.md

Workbench 风格 React UI 基础设施。**依赖 React，不依赖 Electron**，可在 happy-dom 环境单测。

## 提供的能力

| 模块 | 用途 |
|---|---|
| `ContextViewService` | Floating UI 定位 + Portal 渲染的浮层服务 |
| `ContextMenu` | MenuRegistry 驱动的右键菜单（消费 `MenuId.*` 注册的条目） |
| `HoverService` | delay 触发 / keyboard-accessible 的 hover popup |
| `VirtualList` | `@tanstack/react-virtual` 薄包装，固定/动态行高均支持 |
| `useDragHandle` | 原生 HTML5 drag source hook |
| `useDropTarget` | 原生 HTML5 drop target hook |
| `DragSessionContext` | React context 跨边界传递 DnD payload（不走 DataTransfer） |

## 何时新建组件

- 需要 Floating UI 定位能力（popup / tooltip / dropdown）
- 需要跨组件 DnD 状态共享
- 需要虚拟滚动（列表 > 200 项时）

## Floating UI 用法

```tsx
import { useFloating, autoPlacement, offset } from '@floating-ui/react'

const { refs, floatingStyles } = useFloating({
  middleware: [offset(4), autoPlacement()],
})
```

## 关键约束

- **无 Electron 依赖**：不 import `electron` / `@electron/...`
- **不依赖 platform DI**：通过 props 接收服务实例，不用 `@IFooService` 装饰器
- 测试文件位于 `src/__tests__/`，环境 `happy-dom`
- 相对导入带 `.js` 后缀（ESM only）
