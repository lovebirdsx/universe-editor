---
name: linediff-myers-perf
description: computeLineDiff 必须保持 Myers O(ND)，dirty-diff 在大文件切换时复用它
metadata: 
  node_type: memory
  type: project
  originSessionId: cdf89e3f-38f7-4a13-8e49-b0bbb6a13eb0
---

`apps/editor/src/renderer/workbench/agents/lineDiff.ts` 的 `computeLineDiff` 表面是「ACP 聊天内联 diff 的小工具」，但它被 `contributions/dirtyDiff.ts` 的 `computeDirtyDiffRegions` 复用，对**整个打开文件 vs git HEAD** 做 diff。

**Why:** 切回大文件（如 16000 行）时 `DirtyDiffContribution._refresh` 会触发全文 diff。旧实现是 O(m·n) 的 LCS DP（16000² ≈ 2.5 亿格），即使文件未改动也照跑，独占主线程 ~2 秒造成切换冻结。第一次只加「前后缀裁剪」不够——改动分散在首尾时中间块仍横跨全文。

**How to apply:** 已改为 Myers O(ND) 算法（cost 随编辑距离 D，不随文件大小/改动分布）+ 前后缀裁剪快速路径 + `MAX_EDIT_DISTANCE=2000` 降级。**不要退回任何 O(m·n) 全矩阵实现**。修改时务必跑 `lineDiff.test.ts`（含首尾分散改动的 2 万行用例）和 `dirtyDiff.test.ts`。输出需保持每个变更块内 del 全部排在 add 之前（区域分类和 InlineDiffPreview 依赖此顺序）。
