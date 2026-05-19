## 阶段五：UI 基础设施（ContextView / Hover / VirtualList / DnD）

### 目标

把各处自实现的 popup / contextmenu / 拖拽抽成通用基础设施。大目录 / 搜索结果改虚拟滚动。

### 关键文件

**新建独立包 `packages/workbench-ui/`**（React 组件不能进 platform：platform 是纯 Node 测试）：
- `packages/workbench-ui/package.json` —— 依赖 react / `@floating-ui/react` / `@tanstack/react-virtual`
- `packages/workbench-ui/tsconfig.json` —— 继承 `@universe-editor/config-ts/react`
- `packages/workbench-ui/eslint.config.mjs` —— 继承 `@universe-editor/config-eslint/react`
- `packages/workbench-ui/CLAUDE.md` —— 包说明 + 套路（什么时候新建组件、Floating UI 用法）
- `packages/workbench-ui/src/contextView/IContextViewService.ts` —— `show(anchor, render, options)` / `hide()`
- `packages/workbench-ui/src/contextView/ContextViewService.ts` —— 用 Floating UI 计算位置
- `packages/workbench-ui/src/contextMenu/ContextMenu.tsx` —— 基于 IContextViewService + MenuRegistry 渲染（消费 `MenuId.ExplorerContext` 等）
- `packages/workbench-ui/src/hover/HoverService.tsx` —— trigger delay / popup / keyboard accessible
- `packages/workbench-ui/src/list/VirtualList.tsx` —— `@tanstack/react-virtual` 薄包装，exports `<VirtualList items renderItem itemSize />`
- `packages/workbench-ui/src/dnd/useDragHandle.ts`、`useDropTarget.ts` —— 原生 HTML5 DnD + `DragSessionContext`（跨 React 边界传 payload；DataTransfer 跨 Tab 只能拿 string）
- `packages/workbench-ui/src/index.ts`
- `packages/workbench-ui/src/__tests__/...`

**修改**：
- `pnpm-workspace.yaml` —— catalog 新增 `@floating-ui/react: ^0.27.0`、`@tanstack/react-virtual: ^3.13.0`
- `apps/editor/package.json` —— `@universe-editor/workbench-ui: workspace:*`
- `apps/editor/src/renderer/workbench/explorer/ExplorerContextMenu.tsx` —— 迁到 `<ContextMenu items={...} />`，items 改走 MenuRegistry
- `apps/editor/src/renderer/workbench/editor/EditorTabContextMenu.tsx` —— 同上（已是 MenuRegistry 驱动，只换渲染层）
- `apps/editor/src/renderer/workbench/explorer/ExplorerView.tsx` —— 树 visible.length > 200 时启用 VirtualList，小目录保持原 DOM（happy-dom 测试更易写、StrictMode 双 render 更稳）；阈值走 `workbench.tree.virtualizationThreshold` 配置
- `apps/editor/src/renderer/workbench/search/SearchResultsTree.tsx` —— 同上
- `apps/editor/src/renderer/workbench/explorer/ExplorerTreeNode.tsx` —— 加 draggable / onDrop → `fileService.rename`
- `apps/editor/src/renderer/workbench/editor/EditorGroupView.tsx` —— tab 拖拽换序 / 跨 group 拖拽 → `editorGroupsService.moveEditor`

### 设计要点

1. **新独立包 `@universe-editor/workbench-ui`**（用户已确认接受第三方依赖）—— React 组件不能进 platform。包名 workbench-ui 而非 ui，强调它是 workbench 风格而非通用 UI 库。**不依赖 electron**。
2. **`@floating-ui/react`（~14kb gzipped）**：边界 collision / autoUpdate / 虚拟元素是非平凡的；被 shadcn / radix / headless-ui 广泛验证。VSCode 自己实现是因为不能依赖 React，我们没这限制。
3. **`@tanstack/react-virtual`（~5kb）**：API 现代、支持动态高度、TS 类型好。比 react-window 优。VSCode ListView 自实现成本太高，不复制。
4. **DnD 用原生 HTML5 而非 react-dnd**：react-dnd 100kb+，且与 React Context 强绑、跨 ErrorBoundary 易坏。原生 `dragstart / dragover / drop + DataTransfer.setData` 完全够用；`DragSessionContext` 在 React 内传递 payload。VSCode 也用原生。
5. **ContextMenu 渲染源改为 MenuRegistry**（`MenuId.ExplorerContext` 等）—— 当前 `ExplorerContextMenu` 是手写 items 数组，改后任何 Contribution 都可静态注册菜单项**而无需改 ExplorerContextMenu**。EditorTabContextMenu 已是 MenuRegistry 驱动，做参考。
6. **虚拟滚动阈值 200**：走 `ConfigurationRegistry`，schema `workbench.tree.virtualizationThreshold: 200`。

### 验收

- 单测新增 ~15：ContextViewService 5、HoverService 3、VirtualList 4（基础渲染 / 滚动 / 动态高度 / empty）、useDragHandle 3
- E2E 新增：`smoke.explorerDnD.spec.ts` @p1（Explorer 拖文件到子目录，断言迁移）、`smoke.editorTabDnD.spec.ts` @p1（tab 拖到另一 group）、改造现有 `smoke.contextMenu` 加 "MenuRegistry.appendMenuItem 动态注入一项后右键能看到"
- 性能基准：10k 节点 Explorer 渲染时间 < 100ms（virtual 启用）；1k 节点不启用 < 50ms
- Bundle size：renderer chunk 增长 < 60kb gzipped（验收门槛）

### 工作量

**L（1.5 周）**

---
