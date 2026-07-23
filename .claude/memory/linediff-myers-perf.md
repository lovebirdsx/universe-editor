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

**2026-07 追加：** dirty-diff 热路径已改走 `computeLineDiffFromLines`（行数组入口）——HEAD 侧缓存 `toDiffLines()` 结果、buffer 侧用 `model.getLinesContent()` + `trimTrailingEmptyLine`，避免每次刷新对超大文件做全文字符串拷贝/normalize/split；两个入口的行切分语义必须保持一致（尾随换行的幻影空行都要 pop 掉），详见 [[largefile-reveal-dirtydiff-vscode-parity]]。

**2026-07 二修（真机 tabSwitchPerf 日志抓到 dirtyDiff.compute 4073ms）：** Myers 实现藏着**空间尺寸 bug**——`myersMiddle` 的 `V` 数组按 `2*(n+m)+1` 分配（34 万行 ≈ 5.4MB Int32Array），而 `trace.push(v.slice())` 每轮全量拷贝；文件与基线差异大（用户 Perforce 工作区 index.d.ts vs have revision，D 打满 2000 上限）时 = 2000 轮 × 5.4MB ≈ 10GB 级 memcpy + 海量 GC 垃圾（顺带诱发后续切换的无归因 major-GC long task）。**k 对角线只落在 [-maxD, maxD]，V 只需 `2*maxD+1`（4001）**。同时加 `MAX_DIFF_BUDGET_MS=100` 墙钟预算（对标 VSCode DiffComputer maxComputationTime，其在 worker 我们在主线程故取小值），超时同走粗粒度整块替换回退；`computeLineDiffFromLines(a,b,budgetMs?)` 第三参仅测试用（0 = 立即回退，确定性）。实测 34 万行：worst(D 超上限) 4073ms→172ms、moderate(D=600) 56ms。
