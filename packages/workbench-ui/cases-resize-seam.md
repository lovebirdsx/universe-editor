# workbench-ui/cases-resize-seam.md

## 症状与根因

拖 Explorer 右边界时，指针落在 seam 内侧几 px（Allotment sash 8px、跨缝居中；行右侧 4px 还是预览按钮），命中的是 `draggable` 行 → 浏览器启动原生 HTML5 DnD。在 `dragstart` 里 `preventDefault()` 只能取消拖拽，**不能把同一手势交还 sash**，用户看到「缩放不动，反而拖出文件」。

本仓的经典滚动条占 8px，把 Explorer 行内容整体往左推：sash 中心 ±10px 的带内大部分被滚动条占据，预览按钮落到带外。按在 sash 上或带内的滚动条左侧 2px 仍可 resize；按在按钮上拖动则由下面的「嵌套控件」规则兜底，绝不启动行拖拽。

## 仲裁规则（`src/dnd/resizeSeamGuard.tsx`）

`ResizeSeamDragGuard` 每个 workbench document 挂一次（主窗口 `Workbench.tsx`、辅助窗口 `AuxiliaryWindowHost.tsx`），在 document capture 监听 `pointerdown/pointermove/pointerup/pointercancel/dragstart/dragend/click`。

- 命中：`findResizeSeamAtPoint` 在 10px 带内找最近的 `[data-testid="sash"]`（Allotment）或 `[data-resize-sash="true"]`（本包 `Sash`），跳过 `.sash-disabled` / 零矩形 / hidden / `pointer-events:none`。按 sash 中心算距离，不用行自身边缘——滚动条会让行缘与缝错位。
- 统一延迟转发：pointerdown 落在「真实 sash + 可拖拽源」附近时只记录手势并临时 `draggable=false`，**不取消、不停止传播**（普通点击语义完整保留）；沿缝轴向移动 ≥3px 才把同一手势转发给 sash。Allotment 的阈值 move 会 `preventDefault`；共享 `Sash` 的 move 不能取消——它读的是浏览器兼容 `mousemove`，取消 pointermove 会把它吞掉。
- 嵌套控件兜底：pointerdown 落在拖拽源内部的 `button / a[href] / input / textarea / select / label[for] / role=button/menuitem/checkbox/switch / contenteditable` 上时，即使不在 seam 带内，`dragstart` 也一律 `preventDefault + stopPropagation`。行内 action 按钮（如预览按钮）永远不触发整行拖拽；元素自身既是拖拽源又是控件时除外（如 tab）。
- 原生 DnD 消解：**手势期间取消兼容 `mousedown` 的默认动作**——Chromium 在处理 pointermove 时按**当前光标下**的节点决定 drag source，sash 随边界移动后指针会落到可拖拽行上，即使按下点就在 sash 上也会启动文件拖拽。Allotment 读 pointer 事件、本包 `Sash` 读 mouse 事件本身不受 `preventDefault` 影响。pending 时另行把初始拖拽源临时 `draggable="false"`，pointerup/cancel/dragend/卸载恢复；**复位靠 MutationObserver 持续压制**：resize 会触发 React 重渲染，行组件把 `draggable: true` 重新写回 DOM，一次性设置会被覆盖。observer 只监听该元素的 `draggable` 属性，restore 时先 disconnect 再恢复原值。`dragstart` capture 仍兜底取消转发中的手势（只取消，不转发——转发留给第一次沿轴 move）。
- **不要改成只取消 `dragstart` 来防拖拽**：实测取消后该次移动被浏览器吞掉（pointermove 不再派发给 Allotment），缩放完全不动。
- 转发后**不要**对 move/up 调 `stopPropagation`：Allotment 和本包 `Sash` 的监听都在 window 上，stop 掉会冻结缩放。`Sash` 的 window 监听用 `useLayoutEffect`，确保合成 mousedown 后同一条真实 pointermove 能到达。
- 合成 Allotment 事件用 `PointerEvent('pointerdown')`（原按下坐标 + `pointerId/pageX/pageY` 等）；本包 `Sash` 用 `MouseEvent('mousedown')` + best-effort `setPointerCapture`。转发后抑制随后一次 click（目标在 sash 内则放行，保留 Allotment 双击 reset）。
- 取消/失焦清理：`pointercancel` / window blur 时，转发中的 Allotment 手势补发合成 `pointerup`（临时屏蔽 `releasePointerCapture`——指针失活时它会抛错，Allotment 会因此跳过 window 监听清理），共享 `Sash` 补发 `mouseup`；直接按在 sash 上的原生手势也跟踪并在同一路径清理（Allotment 只在 pointerup 清监听，Sash 只在 mouseup 清）。forwarded 手势收到 `buttons===0` 的 move 或新的 primary press 时同样补发 up 并复位。click 抑制一并清空。
- `pointermove` 收到 `buttons === 0` 时直接放弃 pending，避免在窗口外抬手后无按键启动 resize。

## 给新增代码的约定

- 拖拽源**不要**自行做边缘/距离判断，统一交给 guard；`useDragHandle` / `resourceDrag` 已不再包含这类逻辑。
- 自定义分隔条（不在 Allotment 内）必须带 `data-resize-sash="true"`，否则 guard 找不到缝。
- guard 必须在**每个 document** 挂一次；辅助窗口的 portal 子树要各自挂（已有 `OwnerDocumentProvider` 提供 document）。
- 单测：`src/__tests__/resizeSeamGuard.test.tsx`（几何、状态机、取消/blur 清理、项目 Sash 集成）；e2e：`apps/editor/e2e/specs/smoke.explorerResizeSash.spec.ts`（含溢出/滚动条与 blur 场景）。
