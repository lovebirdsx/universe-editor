# cases-dirty-diff-regions.md

本文从 `workbench/scm/CLAUDE.md` 拆出，范围是 dirty-diff 的**区域计算引擎**——`computeLineDiff` 的 Myers 实现、它在「整个打开文件 vs HEAD」全文 diff 热路径上的用法、以及三条不许踩回去的红线。CLAUDE.md 只留一行护栏与入口；改 `workbench/agents/lineDiff.ts` 或 `contributions/dirtyDiff.ts` 的区域计算前通读本文。

## 案例：行 diff 引擎（Myers + 墙钟回退）与 dirty-diff 脏区

`workbench/agents/lineDiff.ts` 的 `computeLineDiff` 表面是「ACP 聊天内联 diff 的小工具」（`InlineDiffPreview.tsx` 消费），但**同一个函数**被 `contributions/dirtyDiff.ts` 的 `computeDirtyDiffRegions` 复用，对**整个打开文件 vs git HEAD** 做全文 diff。改这个引擎等于同时改两条产品线。

### 红线一：必须保持 Myers O(ND)，不许退回 O(m·n) 全矩阵

**根因**：切回大文件（上万行）时 `DirtyDiffContribution._refresh` 会触发全文 diff。旧实现是 O(m·n) 的 LCS DP（行数平方 ≈ 数亿格），**即使文件未改动也照跑**，独占主线程 ~2 秒造成切换冻结。第一次只加「前后缀裁剪」不够——改动分散在首尾时中间块仍横跨全文。

**现状**：Myers O(ND)（cost 随编辑距离 D，不随文件大小 / 改动分布）+ 前后缀裁剪快速路径 + `MAX_EDIT_DISTANCE`（=2000）降级。**不要退回任何 O(m·n) 全矩阵实现**。

**必须保持的输出不变量**：每个变更块内 del 必须**全部排在 add 之前**——区域分类（added / deleted / modified）与 `InlineDiffPreview` 都依赖这个顺序。护栏 = `lineDiff.test.ts` 的 `orders deletions before insertions within a replaced block`。

**改动后必跑**：`apps/editor/src/renderer/workbench/agents/__tests__/lineDiff.test.ts`（含 `diffs a large file with edits scattered at top and bottom in O(ND)` 与 `stays correct with many scattered edits on a huge file (V sized by edit distance)` 两个数万行用例）与 `apps/editor/src/renderer/contributions/__tests__/dirtyDiff.test.ts`。

### 红线二：热路径走行数组入口，两个入口的行切分语义必须一致

dirty-diff 热路径走 `computeLineDiffFromLines`（行数组入口），避免每次刷新对超大文件做全文字符串拷贝 / normalize / split：HEAD 侧缓存 `toDiffLines()` 的结果，buffer 侧用 `model.getLinesContent()` + `trimTrailingEmptyLine`（原地 pop 掉尾随换行的**幻影空行**）。两个入口的行切分语义必须一致——尾随换行的幻影空行在字符串入口与行数组入口都要 pop，否则「未改动」的文件会凭空多出一个变更块（`dirtyDiff.test.ts` 的 `reports no change between a trailing-newline HEAD and Monaco-style lines` / `drops exactly one trailing empty element` 守这条）。

### 红线三：V 数组按编辑距离定容 + 墙钟预算

**空间尺寸 bug（真机 tabSwitchPerf 日志抓到 `dirtyDiff.compute` 数秒）**：`myersMiddle` 的 `V` 数组曾按 `2*(n+m)+1` 分配（超大文件即数 MB 级 `Int32Array`），且 `trace.push(v.slice())` **每轮全量拷贝**——文件与基线差异大（真机现场：Perforce 工作区 `index.d.ts` vs have revision，D 打满 `MAX_EDIT_DISTANCE` 上限）时 = 数千轮 × 数 MB ≈ 数十 GB 级 memcpy + 海量 GC 垃圾（顺带诱发后续切换的无归因 major-GC long task）。**k 对角线只落在 `[-maxD, maxD]`，V 只需 `2*maxD+1`**。

**墙钟预算**：`MAX_DIFF_BUDGET_MS`（=100ms）——对标 VSCode `DiffComputer` 的 maxComputationTime，它在 worker 里跑、我们在主线程，故取小值；超时同走**粗粒度整块替换**回退（与 D 超 `MAX_EDIT_DISTANCE` 同一条回退路径）。`computeLineDiffFromLines(a, b, budgetMs?)` 第三参**仅测试用**（传 0 = 立即回退，让回退结果确定性可断言；护栏 = `lineDiff.test.ts` 的 `falls back to a coarse whole-block replace when the wall-time budget is exhausted`）。

**实测**：worst（D 超上限）数秒 → 亚秒；moderate 数十 ms。

### 关键参考路径

- `apps/editor/src/renderer/workbench/agents/lineDiff.ts` —— `computeLineDiff` / `computeLineDiffFromLines` / `myersMiddle` / `MAX_EDIT_DISTANCE` / `MAX_DIFF_BUDGET_MS`
- `apps/editor/src/renderer/contributions/dirtyDiff.ts` —— `computeDirtyDiffRegions` / `computeDirtyDiffRegionsFromLines` / `toDiffLines` / `trimTrailingEmptyLine`
- `apps/editor/src/renderer/contributions/DirtyDiffContribution.ts` —— 触发全文 diff 的 `_refresh`
- 测试：`apps/editor/src/renderer/workbench/agents/__tests__/lineDiff.test.ts`、`apps/editor/src/renderer/contributions/__tests__/dirtyDiff.test.ts`
- 下游消费者：dirty-diff 内联 peek 案例 [cases-dirty-diff-peek.md](cases-dirty-diff-peek.md)——注意 region 计算用本引擎，而 **peek 面板内容不用**（它内嵌真 Monaco diff editor）
