# cases-virtualization-scroll.md

本文从 `CLAUDE.md` 拆出，范围是 `Tree` / `VirtualList` 的**虚拟化与滚动约定**——为什么「按行数切换渲染形态」本身是缺陷、`initialOffset` 与 spacer 的两条硬性写法、以及断言 scrollTop 时的测试纪律。改 `packages/workbench-ui/src/tree/Tree.tsx` / `packages/workbench-ui/src/list/VirtualList.tsx` 前通读；绘制层面的三条约定（底衬 / `top` / reveal 不用 `scrollIntoView`）见 [docs/development/scroll-lists.md](../../docs/development/scroll-lists.md)。

## 1. 不要按行数更换滚动容器（「展开偏、折叠不偏」是病根指纹）

`<Tree>` 曾按 `visibleNodes.length > virtualizationThreshold`（默认 200，`tree/Tree.tsx:49` 的 `DEFAULT_THRESHOLD`、`:142` 的 prop）在两种渲染形态间切换，**滚动容器随之整体更换**（非虚拟 = 根 `[role="tree"]`，虚拟 = `VirtualList` 内层 div）。展开/折叠一个目录恰好跨阈值时视口跳回顶部。第一轮用「scroll 事件镜像 + 翻转后恢复」补救只治好了折叠方向，**展开方向仍漂移**——病根有两层，镜像只够第一层。

**Why**：

- 第一层：换容器丢的是 DOM 上的 scrollTop。
- 第二层：`@tanstack/virtual-core` 的 `_willUpdate` 在检测到 `getScrollElement()` 身份变化时 `cleanup()` 后重新挂载，**最后一步是 `_scrollToOffset(getScrollOffset())`，而新实例的 `getScrollOffset()` 回落到 `initialOffset`（默认 0）**。于是虚拟器既把 DOM 写成 0，又按 offset=0 算错渲染窗口；镜像 effect 随后把 DOM 写回，但虚拟器内部 `scrollOffset` 仍是 0，要等原生 scroll 事件异步回灌才纠正——这个时间差就是残留漂移。折叠方向只走 `cleanup()`、无重新挂载、无 `_scrollToOffset`，所以干净：**「展开偏、折叠不偏」的不对称就是这一层的指纹**。

**约定**：`[role="tree"]` **恒为唯一 scroller**（7 个视图的树根本来就有 `overflow-y: auto`），阈值只决定 `VirtualList` 的 `windowed`（`tree/Tree.tsx:450`）；两种情况下 DOM 结构一致（spacer + absolute 定位行），只是渲染行数不同。旧的「scroll 事件镜像 + 翻转后恢复」ref 与两个恢复/跟踪 effect **已全部删除，勿回退**。

## 2. `initialOffset` 必须活读 DOM，附着要靠 `containerReady` 门控

- `useVirtualizer` 的 `initialOffset` 必须**活读 DOM**：`() => resolveScrollElement()?.scrollTop ?? 0`（`list/VirtualList.tsx:102`）——虚拟器附着时会把种子值写回 DOM，假定 0 就会把 `useScrollRestore` 刚恢复的位置拽回顶部（`ScmView.treeState` 的恢复用例正是被这个打挂的）。
- **React 子 ref 先于父 ref 附着**：首次渲染时父容器的 ref 还是 null，虚拟器会推迟到「碰巧的某次后续渲染」才附着——而附着就归零。`Tree` 用 `containerReady` state 门控 `{containerReady && <VirtualList/>}`（`tree/Tree.tsx:172` / `:445`），把附着钉死在挂载期（此时位置本就是 0）。**任何把祖先元素当 `scrollElement` 的用法都要这么门控**。

## 3. spacer 必须 `flexShrink: 0`；`windowed: false` 是刻意保留

- spacer 加 `flexShrink: 0`（`list/VirtualList.tsx:204`）：树根多为 flex column，可收缩的 spacer 会塌成视口高度，滚动范围直接消失（守护：`smoke.searchScroll` / `smoke.searchScrollRestore`）。
- **`windowed: false`（≤ 阈值全量渲染）刻意保留**：happy-dom 无布局引擎，窗口化渲染 0 行，96 处「断言行在 DOM 里」的单测与 `smoke.searchOrder` 的 >50 行断言全靠它。**勿改成「始终窗口化」**。

## 4. 测试纪律：断言 `scrollTop` 必须同时断言「树内没有嵌套 scroller」

否则位置活在别的元素上，断言看着过、实际没测到（变异测试才暴露）。

## 5. 视口窗口回调：`onVisibleNodesChange`（几何自算，与 `windowed` 正交）

`Tree` 可选地上报「滚动视口覆盖了哪些行」——`visibleNodes` 里跨越视口的那一段，上下各加 `VISIBLE_OVERSCAN`（5）行松弛。用途是**按需工作**的副作用通道（逐行向服务声明可见性、驱动按需查询），**不是渲染输入**：在回调里 `setState` 会让每次滚动都重渲染整棵树。

- **几何自算，不读 `virtualizer.getVirtualItems()`**：非 windowed 模式下 `VirtualList` 渲染全部行、虚拟器 `totalSize` 只是 `estimateSize` 累加，它算出的 window 不是视口（happy-dom 下还直接返回空）。这与第 3 节的「`windowed: false` 刻意保留」是同一件事的两面——两种模式上报同一个窗口，回调因此与 `windowed` 正交。
- **`clientHeight <= 0` = 没有视口**（侧栏隐藏 / 未布局）→ 上报空数组，消费方据此停查。ResizeObserver 是「隐藏 → 显示」唯一的重算触发（那一次不产生 scroll 事件）；rAF 合帧；去重键 = `(visibleNodes 身份, start, end)`——nodes 身份入键让「结构变了但索引区间没变」也能重报（`useTreeModel` 按结构版本 `useMemo` 派生 `visibleNodes`，结构不变则身份稳定）。
- 首报**推迟一帧**（等布局落定），与 reveal 同一条教训（见 CLAUDE.md 的 reveal 条目）。
- 监听挂在唯一 scroller `[role="tree"]` 上（第 1 节）；未传 prop 时整个 effect 早退，其余 `Tree` 使用者零开销；卸载时摘监听、断 RO、cancel rAF。
- 守护：`src/__tests__/Tree.visibleWindow.test.tsx`（窗口与两端夹紧 / 滚动去重 / 结构变化重报 / 零高度与 RO 恢复 / `getRowHeight` 累加路径 / 未传 prop 不挂 scroll 监听 / 卸载停止 / 纯 selection 变化不回调）。

## 相关

- 绘制三条约定 + 残影排查套路：[docs/development/scroll-lists.md](../../docs/development/scroll-lists.md)
- 动态行高下的恢复/导航（内容锚点 + 收敛循环）：[docs/development/scroll-lists.md](../../docs/development/scroll-lists.md) 的「动态测量下的恢复与导航」节
- Allotment 侧的重挂载空窗与 `resize()` 纪律：[docs/development/allotment-layout.md](../../docs/development/allotment-layout.md)
