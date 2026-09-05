---
name: tree-virtualization-threshold-scroll-jump
description: Tree 按行数在两种容器形态间切换本身就是缺陷；虚拟器每次重新挂载都会把 scrollOffset 归零，正解是 scroller 身份恒定 + initialOffset 活读 DOM
metadata:
  type: project
---

`workbench-ui` 的 `<Tree>` 曾按 `visibleNodes.length > virtualizationThreshold`（默认 200）在两种渲染模式间切换，**滚动容器随之整体更换**（非虚拟=根 `[role="tree"]`，虚拟=`VirtualList` 内层 div）。展开/折叠一个目录恰好跨阈值时视口跳回顶部。第一轮试图用「scroll 事件镜像 + 翻转后恢复」补救，只治好折叠方向；**展开方向仍漂移**——因为病根有两层，镜像只够治第一层。

**Why:** 换容器丢的是 DOM 上的 scrollTop（第一层），但 `@tanstack/virtual-core` 的 `_willUpdate` 在检测到 `getScrollElement()` 身份变化时会 `cleanup()` 后重新挂载，**最后一步是 `_scrollToOffset(getScrollOffset())`，新实例的 `getScrollOffset()` 回落到 `initialOffset`（默认 0）**（第二层）。于是虚拟器既把 DOM 写成 0，又按 offset=0 算错渲染窗口；镜像 effect 随后把 DOM 写回，但虚拟器内部 `scrollOffset` 仍是 0，要等原生 scroll 事件异步回灌才纠正——这个时间差就是残留漂移。折叠方向只走 `cleanup()`、无重新挂载、无 `_scrollToOffset`，所以干净：**「展开偏、折叠不偏」的不对称就是这一层的指纹**。

**How to apply:**
- **不要按数量切换容器形态**。现在 `[role="tree"]` 恒为 scroller（7 个视图的树根本来就有 `overflow-y: auto`），阈值只决定 `VirtualList` 的 `windowed`；两种情况下 DOM 结构一致（spacer + absolute 定位行），只是渲染行数不同。镜像 ref 与两个恢复/跟踪 effect 已全部删除。
- **`windowed: false`（≤ 阈值全量渲染）是刻意保留的**：happy-dom 无布局引擎，窗口化会渲染 0 行，96 处「断言行在 DOM 里」的单测与 `smoke.searchOrder` 的 >50 行断言全靠它。改成「始终窗口化」会让这些全挂。
- **`useVirtualizer` 的 `initialOffset` 必须活读 DOM**（`() => resolveScrollElement()?.scrollTop ?? 0`）。虚拟器附着时会把种子值写回 DOM，假定 0 就会把 `useScrollRestore` 刚恢复的位置拽回顶部（`ScmView.treeState` 的恢复用例正是被这个打挂的）。
- **React 子 ref 先于父 ref 附着**：首次渲染时父容器的 ref 还是 null，虚拟器会推迟到「碰巧的某次后续渲染」才附着——而附着就归零。`Tree` 用 `containerReady` state 门控 `{containerReady && <VirtualList/>}`，把附着钉死在挂载期（此时位置本就是 0）。任何「把祖先元素当 scrollElement」的用法都要这么门控。
- **给 spacer 加 `flexShrink: 0`**：树根多为 flex column，可收缩的 spacer 会塌成视口高度，滚动范围直接消失（`smoke.searchScroll` / `smoke.searchScrollRestore` 守的就是这个）。
- 单测断言 `[role=tree].scrollTop` 时要同时断言**树内没有嵌套 scroller**——否则位置活在别的元素上，断言看着过实际没测到（变异测试才暴露）。
- 相关：`[[virtual-list-scroll-anchor-restore]]`（动态行高下的锚点恢复，是另一套问题）。
