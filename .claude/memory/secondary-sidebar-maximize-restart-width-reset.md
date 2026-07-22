---
name: secondary-sidebar-maximize-restart-width-reset
description: 最大化状态重启后二级侧栏宽度被重置的真根因:Allotment 构造期捕获过期闭包 + onChange 瞬态帧被无条件持久化;修法=init 目标经 ref 现读 + 侧栏宽度只在 onDragEnd 持久化(VSCode 语义)
metadata: 
  node_type: memory
  type: project
  originSessionId: b6866530-fc08-4f67-9b73-b1fbc2e9417d
---

aea7b026 给横向 editor pane 加 `LayoutPriority.High` 只修了「容器增量分给谁」,真实用户场景(state.json `isMaximized:true` 重启)仍必现(本机 4/6):main 在 ready-to-show 才 `maximize()`,与 renderer 初始布局 + 异步 layout reconcile 竞速。

**真根因(两层)**:
1. allotment 1.20.5 在 SplitView 构造时捕获 onChange 闭包且更新滞后 —— WorkbenchLayout 初始化分支读到过期的 `secondarySidebarVisible=false`,把二级侧栏按隐藏(0)算目标;
2. 可见性翻转的修正 effect 在 init 前运行被 `!isInitializedRef` 挡掉且不再重跑;随后 allotment 应用可见性把 pane 挤到 minSize(170),该瞬态帧被 onChange 无条件 `setSize` 持久化,污染完成。

**修法**(WorkbenchLayout.tsx):
- init resize 的目标全部在 queueMicrotask 内经 ref 现读(`sidebarVisibleRef`/`secondarySidebarVisibleRef`/`initialSizesRef`);
- sidebar/secondary 持久化从 onChange 移到 **onDragEnd**(只有用户拖 sash 才写回,VSCode 语义)——容器缩放/启动沉降/程序性纠正的瞬态帧永不进存储;`lastSecondarySizeRef` 因此可删(服务值不再会被瞬态污染);
- 垂直分割 editor pane 也加 `LayoutPriority.High`(防最大化把 panel 高度撑大后持久化,同族 bug 垂直版)。

**教训**:allotment 的 onChange/onDragEnd 回调内读 props 一律走 ref,勿信闭包;守护测试须模拟真实时间线(`isMaximized:true` 重启)而非稳定后 live maximize —— 三条时间线(容器增长 / 最大化重启 / 增长→收缩)都在 `smoke.maximizedSecondarySidebarRestore.spec.ts`。本机 markdown 预览 cursor 对齐 e2e 失败是既有环境 flake,与此无关。

**CI 环境约束(2026-07 修正)**:CI runner 虚拟显示器小(windows ≈1024 / xvfb ≈1280)且 xvfb 无窗口管理器 → `maximize()` 可能 no-op、`isMaximized()` 恒 false、`innerWidth > 1500` 这类绝对阈值永远等不到。e2e 操控窗口尺寸一律用 `setBounds`(增长 cap 到 workArea,等待用相对阈值 before+60),重启竞态用例保留 seed `isMaximized:true` 但**不断言 OS 最大化状态**。
