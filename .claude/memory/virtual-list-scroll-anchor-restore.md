---
name: virtual-list-scroll-anchor-restore
description: 动态测量虚拟列表的滚动恢复/导航必须用内容锚点+收敛循环，纯 scrollTop 必漂移；还原三坑=尺寸锚定对抗/registry 重排/末尾组无法置顶
metadata: 
  node_type: memory
  type: project
---

设置编辑器（`SettingsEditor.tsx`）TOC 高亮错位与滚动不恢复的完整修法（2026-08，worktree task1）：

1. **纯 scrollTop 恢复在 `measureDynamically` 下必然漂移**：保存的是真实测量坐标，恢复时上方行未测量（估算坐标），同一数值对应更深文档位置。正解=**内容锚点**（首个可见项 flatItemKey + 其距视口顶 offset），恢复时按 DOM rect 收敛对齐（`runAlignLoop` 引擎，仿 [[ChatBody]] `runScrollConvergence`）。
2. **收敛循环必须抑制 tanstack 的尺寸变化锚定**：`virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false`，否则 virtualizer 的自动 nudge 与循环每帧写入互相 creep，永远收敛不了（VirtualList handle 暴露 `setSizeChangeScrollAdjustment`）。
3. **恢复/导航 effect 不能把锚点对象当依赖**：scroll 事件里 saveAnchor 每次产生新对象 → render 期读出的引用每轮都变 → effect 被用户自己的滚动反复触发，两个循环互拉。锚点只在 effect 内快照（deps 用 scrollReady/scrollKey/registryVersion）。
4. **程序性滚动期间不写锚点**：循环滚动途中的 scroll 事件会把锚点污染成中途组；`alignLoopRef` 存在即跳过保存，循环 onSettle 统一 `persistPosition()`。
5. **配置 registry 会动态重排**（ThemesContribution 的 dispose+register 把节点挪到数组末尾，主题初始化后连续 fire ~6 次）：`entry.itemIndex` 立即过期——对齐循环每帧按 id/key 从最新 model 重解析；model/ranked 必须 useMemo（identity 稳定），循环以其为 epoch 在重排时续期窗口。
6. **末尾组物理上无法顶到视口顶**（下方内容不足一屏）：对齐循环要识别「到底+header 在视口内」即收敛，否则空转 600ms 停在前面组——此时 scroll spy 高亮落在前面组是 VSCode 同款固有行为，e2e 断言须避开末尾组。

同 id 配置节点重复注册（explorer 两处）的重复 key/双 TOC 项，在 `buildFlatModel` 按 node.id 分桶合并解决（title 取首个，同 key 后者覆盖）。
