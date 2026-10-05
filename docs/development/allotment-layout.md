# Allotment 分割布局：重挂载空窗、imperative resize 与尺寸持久化

`allotment`（1.20.x）是 view 容器（`apps/editor/src/renderer/workbench/sidebar/ViewPaneContainer.tsx`）与整个 workbench 骨架（`apps/editor/src/renderer/workbench/layout/WorkbenchLayout.tsx`）共用的 SplitView 底座。本文记录它在**挂载/重挂载窗口期**的两类陷阱、imperative `resize()` 的守卫纪律，以及「最大化重启后二级侧栏宽度被重置」的完整复盘。

## 1. `defaultSizes` 未传时 viewItems 初始为空（重挂载空窗）

allotment v1.20 的 `SplitView` 在 mount effect（deps `[]`）里创建，但不传 `defaultSizes` 时 **viewItems 初始为空**；子 pane 的 `addView` reconcile 被状态门控，要等 **ResizeObserver 首次回调**（异步）后的二次渲染才执行。因此 key 重挂载（view 集合变化 / 切 workspace）后存在一个**跨越多次 commit** 的窗口期：`ref.current.resize(sizes)` 会打到 `viewItems` 为空的 SplitView 上，`resizeViews` 不做边界检查 → `Cannot read properties of undefined (reading 'minimumSize')`。

**为什么既有守卫会被穿透**：`ViewPaneContainer` 的「view 集合变化则跳过 resize」守卫只在变化那一次 effect 生效，而窗口期更长；窗口期内 `sizesRef` 残留**旧实例**的 sizes，长度恰好等于新 views 数时所有守卫都被穿透（切工作区时：views 水合 → 重挂载 → collapsed 水合在 ResizeObserver 前落地）。

**修法纪律**：
- 对 allotment 的 imperative `handle.resize()`，**只用当前实例 `onChange` 报告过的 sizes 做守卫**；
- view 集合变化（重挂载）时**立刻清空缓存的 sizes ref**（`ViewPaneContainer.tsx:157-166`），让长度守卫在新实例 onChange 回报前一直拦截；
- **勿依赖「跳过一次 effect」**来覆盖 reconcile 窗口。

复现测试：`apps/editor/src/renderer/workbench/sidebar/__tests__/ViewPaneContainer.test.tsx`（FakeResizeObserver 手动控制 reconcile 时机）。

同族守卫：`WorkbenchLayout.tsx` 的 `isVerticalInitializedRef`——嵌套的垂直 Allotment（editor + panel）同样懒填充 viewItems，在它首次 `onChange` 之前 `resize()` 会打穿同一个空数组。

## 2. 最大化重启后二级侧栏宽度被重置（构造期闭包 + 瞬态帧持久化）

`aea7b026` 给横向 editor pane 加 `LayoutPriority.High` 只修了「容器增量分给谁」，真实用户场景（state.json `isMaximized:true` 重启）仍必现（本机 4/6）：main 在 ready-to-show 才 `maximize()`，与 renderer 初始布局 + 异步 layout reconcile 竞速。

**真根因（两层）**：
1. allotment 1.20.5 在 SplitView **构造时捕获 `onChange` 闭包**且更新滞后——`WorkbenchLayout` 的初始化分支读到过期的 `secondarySidebarVisible=false`，把二级侧栏按隐藏(0)算目标；
2. 可见性翻转的修正 effect 在 init 前运行、被 `!isInitializedRef` 挡掉且不再重跑；随后 allotment 应用可见性把 pane 挤到 minSize(170)，该**瞬态帧**被 `onChange` 无条件 `setSize` 持久化，污染完成。

**修法**（`WorkbenchLayout.tsx`）：
- init resize 的目标全部在 `queueMicrotask` 内经 ref 现读（`sidebarVisibleRef` / `secondarySidebarVisibleRef` / `initialSizesRef`，`:213-223`，含 `console.debug` 打点）；
- sidebar / secondary 的持久化从 `onChange` 移到 **`onDragEnd`**——只有用户拖 sash 才写回（VSCode 语义），容器缩放 / 启动沉降 / 程序性纠正的瞬态帧永不进存储；`lastSecondarySizeRef` 因此可删；
- 垂直分割的 editor pane 也加 `LayoutPriority.High`（同族 bug 的垂直版：防最大化把 panel 高度撑大后持久化）。

**教训**：
- allotment 的 `onChange` / `onDragEnd` 回调内读 props **一律走 ref、勿信闭包**；
- 守护测试须模拟**真实时间线**（seed state.json `isMaximized:true` 重启 + main 在 ready-to-show `maximize()` 与 renderer 初始布局竞速），而不是稳定后 live maximize——三条时间线（容器增长 / 最大化重启 / 增长→收缩）都在 `apps/editor/e2e/specs/smoke.maximizedSecondarySidebarRestore.spec.ts`。

> 排查时的旁注：本机 markdown 预览 cursor 对齐的 e2e 失败是**既有环境 flake**，与这里的布局问题无关，别当作线索。

## 3. e2e 里操控窗口尺寸（CI 约束）

CI runner 的虚拟显示器小（windows ≈1024 / xvfb ≈1280）且 xvfb 无窗口管理器 → `maximize()` 可能 no-op、`isMaximized()` 恒 false、`innerWidth > 1500` 这类绝对阈值永远等不到。**一律用 `setBounds`**（增长 cap 到 `screen.getPrimaryDisplay().workAreaSize`，等待用相对阈值 `before + 60`），重启竞态用例保留 seed `isMaximized:true` 但**不断言 OS 最大化状态**。完整案例见 skill `fix-ci-e2e-flake` 的案例 99。

## 相关

- view 容器内的折叠 / 尺寸持久化 / 键盘 resize：[services/views/CLAUDE.md](../../apps/editor/src/renderer/services/views/CLAUDE.md)、[cases-keyboard-resize.md](../../apps/editor/src/renderer/services/views/cases-keyboard-resize.md)
- tree / 虚拟列表的滚动容器约定：[cases-virtualization-scroll.md](../../packages/workbench-ui/cases-virtualization-scroll.md)
