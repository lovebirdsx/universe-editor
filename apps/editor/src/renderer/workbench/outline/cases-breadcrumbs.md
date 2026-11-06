# 面包屑（Breadcrumbs）

UI 在 `workbench/editor/breadcrumbs/`，服务/模型在 `services/breadcrumbs/`，命令在 `actions/breadcrumbsActions.ts`，配置贡献在 `contributions/BreadcrumbsConfigurationContribution.ts`。挂载点仍是 `workbench/editor/Breadcrumbs.tsx`（FileEditor 顶部，每组一份）。

## 组隔离

`BreadcrumbsBar` 只用 `IOutlineService.forGroup(group.id)`，**绝不用门面 observable**——门面镜像活动组，分屏时背景组会显示聚焦组的符号路径。`forGroup` 必须返回稳定对象（`useObservable` 按引用重订阅，见本目录 CLAUDE.md 坑 8）。

## 路径与 picker

- 路径模型是纯函数 `breadcrumbsModel.ts`：工作区内走 `uriIdentity.relativePath`，**不插入 workspace 根段**；工作区外/无 workspace 走绝对路径；派生 URI 只用 `URI.with({ path })` / `URI.joinPath`，禁止 `.fsPath`，否则远程 scheme/authority 丢失。
- 文件 picker（`filePickerModel.ts` + `FileBreadcrumbPicker.tsx`）：`Tree` 懒加载目录，目录优先排序，应用 `files.exclude` 但**始终保留当前文件**；单击文件打开，双击/箭头展开目录。
- 符号 picker（`symbolPickerModel.ts` + `SymbolBreadcrumbPicker.tsx`）：打开时冻结大纲快照；方向键只 `previewSymbol`（滚动 + 高亮，不动光标）；Escape/外部点击 `restoreViewState` 恰好一次；确认**先 restore 再 reveal**（`revealSymbol` 不会清预览装饰）。

## 键盘与上下文键

- `breadcrumbs.focusAndSelect`（`ctrl+shift+.`）/ `breadcrumbs.focus`（`ctrl+shift+;`）要求 root key `breadcrumbsPossible`；栏内 `Left/Right/Enter/Down/Space/Ctrl+Enter/Escape` 要求 `breadcrumbsActive`。全部绑定 `weight: KeybindingWeight.WorkbenchContrib + 50`，否则同键的全局无 when 绑定按 weight 先赢（根 CLAUDE.md 红线）。
- `BreadcrumbsService` 按组注册 controller；活动组切换时 `dismissPicker()`，组移除时清理。焦点进入栏 `activate`；blur 先用 `event.relatedTarget` 同步判断焦点是否仍在栏/portal，仍不确定才 `setTimeout(0)` 后读 `activeElement`（focusout 与 focusin 之间 `activeElement` 瞬时为空，microtask 会落进空窗，见坑 8）。
- 命令优先用 `IBreadcrumbsService.activeController`，回退到活动组 controller：Tab 可以把焦点落到**非活动组**的面包屑上，只按 `groups.activeGroup` 取 controller 会操作错组。
- 确认符号后焦点被 `revealSymbol` 移到编辑器，可能没有栏 blur 事件：`closePicker` 的 microtask 必须在焦点已离开栏/picker 时 deactivate，否则 `breadcrumbsActive` 残留会劫持编辑器按键。

## 容易踩的坑

1. **外部点击顺序**：picker 打开时在 document **capture** 阶段处理 `mousedown`，先关闭并还原符号预览，再让 Monaco 处理点击；点中同一锚点段时置一次性 `suppressNextOpen`，否则 AnchoredSurface 关闭后 React `onClick` 会立刻重开。
2. **背景组点击**：栏的 `mousedown` 在 `!group.isActive` 时 `preserveFocusOnActivation(true)`，`setTimeout(0)` 复位；否则组激活 effect 把焦点抢回 Monaco。
3. **TreeModel 解构调用**：`TreeModel` 会先解构 `loadChildren` / `getParent` 再调用，数据源里这两个方法都必须是箭头属性（类方法会丢 `this`，目录展开或 ArrowLeft 会静默/抛错）。
4. **FloatingPortal 异步挂载**：`AnchoredSurface` 的 portal 子节点在首帧之后才挂载，符号 picker 在 effect 里 `treeRef.current?.focus()` 拿到的是 null（方向键会留在锚点段上）。焦点放 ref callback，`rootRef` 一挂载就 focus。
5. **picker 焦点也算 active**：焦点进入 portal 时栏已 blur，必须在 picker 的 `onFocusCapture` 里重新 `activate(controller)`，否则背景组点开 picker 后 `breadcrumbsActive` 为 false；焦点从 portal 离开（Tab）时 surface 的 `onBlurCapture` 关掉 picker，否则 active 残留会劫持别处按键。
6. **配置是精确匹配**：五个 `breadcrumbs.*` key 逐个订阅；`filePath`/`symbolPath`/`enabled` 变化时关闭当前 picker。
7. **测试定位**：栏用 `data-testid="editor-breadcrumbs"`；picker 用 `data-testid="breadcrumbs-file-picker"` / `"breadcrumbs-symbol-picker"`；符号行有 `role="treeitem"` + `data-selected`。
8. **picker 内可聚焦控件抢焦点**：twistie 是 `<button tabIndex={-1}>`，鼠标点击仍会从 tree 容器抢走焦点；Chromium 的 focusout 与 focusin 之间 `activeElement` 瞬时为 `<body>`，`queueMicrotask` 恰落进空窗 → 误判离开 portal → 关弹窗（症状：点折叠箭头不展开反而关闭）。修法两层：twistie `onMouseDown` `preventDefault()` 让焦点留在 tree（对齐 OutlineView 的不可聚焦 chevron，也避免 Enter 双 toggle）；`handlePickerBlur` 先看 `relatedTarget`，再用 `setTimeout(0)` 兜底。回归：`BreadcrumbsBar.test.tsx` "keeps the file picker open…"、e2e "file picker twistie expands without closing the picker"。

## 验证

```bash
cd apps/editor && pnpm vitest run --project renderer-node --project renderer-dom \
  src/renderer/services/breadcrumbs/__tests__ \
  src/renderer/workbench/editor/breadcrumbs/__tests__ \
  src/renderer/workbench/editor/__tests__/Breadcrumbs.test.tsx
# 仓库根
pnpm e2e specs/smoke.breadcrumbs.spec.ts
```
