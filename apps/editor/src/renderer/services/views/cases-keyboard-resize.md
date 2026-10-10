# View pane 键盘 resize（ctrl+alt+shift+上下）

焦点在侧栏某个 view 上时，`ctrl+alt+shift+↑/↓` 调整该 view pane 的高度，空间与相邻 pane 互相借还。左右键仍是整条侧栏的宽度（view 在 stack 里没有横向尺寸）；Panel 的 tiled view 不参与（无 per-view 几何，上下键仍调面板高度）。

## 链路

```
按键 → layoutActions.resizeFocusedView        （读 root context key focusedViewPane）
     → IViewPaneResizeRegistry.resize(viewId, ±RESIZE_STEP)
     → ViewPaneContainer 的 handler            （useViewPaneResize 按 viewId 注册）
     → viewPaneLayout.computeResizeSizes → allotmentRef.resize(sizes)
```

- **判定用 `focusedViewPane`**：`ViewPane` 的 `data-view-pane` 派生（`FocusContextKeyContribution`），覆盖**标题栏 + 内容区**——焦点停在折叠箭头或 toolbar 按钮上也算"这个 view"。`focusedView` 保持 ViewBody-only 语义不变：outline / explorer tree / swarm 的键位 gate 在它上面，扩大触发面会连带改变它们。
- **注册按 viewId 而非容器**：一个 view 只由一个已挂载容器渲染，查找不必猜 owner。`views.length < 2` 不注册（单 view 填满容器，没有邻居可借）。
- **无人处理返回 false**：调用方保持 part 级行为（侧栏纵向仍是 no-op）。几何未上报（`sizesRef` 长度不匹配、Allotment 重挂载窗口——机制与守卫纪律见 [allotment-layout.md](../../../../../../docs/development/allotment-layout.md)）同属此类。

## 借还语义（`computeResizeSizes`）

- 放大：向**下方**最近的展开邻居借，不足则依次向更远的邻居 spillover，再向**上方由近及远**借；每个 donor 最多让到 `VIEW_OPEN_MIN`。
- 缩小：还给下方最近的展开邻居（无则上方最近）；自身不破 `VIEW_OPEN_MIN`。
- 折叠 pane 既不借也不还，数值原样；**总量守恒**。
- 一个像素都动不了（无展开邻居 / donor 全到底 / 目标已折叠）→ 返回 `undefined`，调用方 no-op。

## 坑

- **落盘写计算值，不写 onChange 上报值**：onChange 在测试环境异步投递，且折叠 pane 上报的是 28px header（会覆盖它记住的展开尺寸）。走 `setViewSizes(..., { persist: true })` 并过滤折叠 pane——与 `onDragEnd` 同一套谓词。
- **必须自带 clamp**：Allotment 对越界请求只静默 clamp，屏上值与 persisted 值就此漂移，下一次按键会从错误的基线起算。
- **不要 bump version**：`setViewSizes` 有意不 bump（高频按键会变成高频整树 re-render）；DOM 已由 `resize()` 更新。
- **键盘与拖动共用 `userResizedRef`**：在 `handle.resize()` 前置位，阻止启动窗口内的 `onChange` 按旧持久化值撤销本次操作；`sashDraggingRef` 仍只表示正在拖动。连续 grow → shrink 是必要回归场景，单次按键无法暴露旧尺寸覆盖。
- **恢复校正「未应用即保持武装」（跨重载恢复的兜底）**：`correctToStoredSizes` 返回「是否已按持久化值对齐」；`storedSizesKey` 代表的这次恢复只在返回 true 后才算消费——几何未上报 / 有折叠 pane / 容器装不下（`deficit<0`）都保持 pending，由后续 onChange 重试，**不受 600ms 窗口限制**。窗口只约束「启动几何沉降需要的额外校正」，不是恢复的截止时间：慢机上 reconcile 会早于 Allotment 首次上报几何落地、首帧容器又常小于持久化总和，两条老路径（窗口内 onChange + 一次性 key effect）会同时失守，等分被 `proportionalLayout` 原样保持、5s 内无人拉回（CI 现象：reload 后 pane 高度恰差一个 `RESIZE_STEP`）。用户操作（`userResizedRef`）作废 pending，用户优先语义不变。

## 验证

- 借还边界：`services/views/__tests__/viewPaneLayout.test.ts`
- 分发与回退：`actions/__tests__/layoutResizeActions.test.ts`
- 容器接线 / 持久化 / unmount 后停止路由：`workbench/sidebar/__tests__/ViewPaneContainer.test.tsx`
- key 语义（标题栏 vs tiled）：`contributions/__tests__/FocusContextKeyContribution.test.ts`
- e2e（真按键 + 跨重载）：`e2e/specs/smoke.viewSizes.spec.ts`
