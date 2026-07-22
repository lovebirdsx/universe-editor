---
name: allotment-remount-empty-splitview-window
description: allotment key 重挂载后 SplitView 为空直到 ResizeObserver tick，窗口跨多次提交；imperative resize 前必须等 onChange 报告真实几何
metadata: 
  node_type: memory
  type: project
  originSessionId: 0dab18bb-cb6a-4aa2-a0cd-cbbcd589cae1
---

allotment v1.20 的 `SplitView` 在 mount effect(deps `[]`)里创建，但不传 `defaultSizes` 时 **viewItems 初始为空**；子 pane 的 `addView` reconcile 被状态门控，要等 **ResizeObserver 首次回调**(异步)后的二次渲染才执行。因此 key 重挂载后存在一个**跨越多次 commit** 的窗口期：`ref.current.resize(sizes)` 会打到 `viewItems` 为空的 SplitView 上，`resizeViews` 不做边界检查 → `Cannot read properties of undefined (reading 'minimumSize')`。

**Why:** ViewPaneContainer 的"view 集合变化则跳过 resize"守卫只在变化那一次 effect 生效，但窗口期更长；窗口期内 `sizesRef` 残留旧实例的 sizes，长度恰好等于新 views 数时所有守卫都被穿透(切换工作区时：views 水合 → 重挂载 → collapsed 水合在 ResizeObserver 前落地)。

**How to apply:** 对 allotment 的 imperative `handle.resize()`，只用**当前实例** `onChange` 报告过的 sizes 做守卫；view 集合变化(重挂载)时立刻清空缓存的 sizes(ref)，让长度守卫在新实例 onChange 回报前一直拦截。勿依赖"跳过一次 effect"来覆盖 reconcile 窗口。复现测试：`ViewPaneContainer.test.tsx`(FakeResizeObserver 手动控制 reconcile 时机)。相关:[[secondary-sidebar-maximize-restart-width-reset]]
