> 本文从 [CLAUDE.md](CLAUDE.md) 拆出的案例细节：diff 数据源铁律 / diff 编辑器接入 / 行内评论锚定。红线结论见主文档。

### 📐 diff 数据源铁律

**diff 两侧都从 p4 快照读取，绝不用工作区文件**（`getFileContent` 命令 → `client.printRevision(...)`）：

- 首版默认比较是 **base(0) → v1**，不是「空 → v1」：`p4 describe -S -s <change>` 的 `rev#` 是 shelved 文件的 depot 基线 revision；非新增文件左侧读 `${depotFile}#${rev}`，新增文件左侧才为空。否则所有 v1 edit 都会显示成整文件新增。
- **多 version 时默认左侧仍是 depot 基线(0)，不是「上一个 version」**：文件列表按 shelf vs 基线算，若默认拿上一 version 作左侧，一个在版本间没变、但相对基线有改动的文件会显示成空 diff（列表说改了、diff 两边一样，自相矛盾）。对标 GitHub PR 单文件默认对 base diff。用户可用 Compare 下拉显式选更早 version 做版本间比较。右侧读 `${depotFile}@=${versionChange}`；删除文件右侧为空。
- Swarm version 有 `archiveChange` 时优先用它作为不可变快照，回退 `change`。作者 changelist 会被重新 shelve，不能拿它代表旧 version。
- `#revision` 可进 immutable print cache；`@=<pending-change>` 可被 reshelve 原地替换，不能进永久缓存——**但 `@=<archiveChange>` 不可变**，renderer 请求带 `immutable: true`（`SwarmFileContentRequest.immutable`），`printRevision/printRevisionBytes(spec, immutable)` 据此走 `P4CacheNs.print`（bytes 以 `bytes:` 前缀 key + base64 存字符串缓存）。打开已存在的 immutable diff tab 还会被 renderer 短路（`openFileDiff` 查 `editorService.openEditors`，零 p4 流量）；diff model 另有 `diffModelCache` LRU（容量 8，全文校验防 pending re-shelve 脏读），关闭重开免 createModel+tokenize+diff 计算。
- **绝不用工作区当前文件当右侧**——它会随本地编辑漂移，行号对不上 Swarm 评论锚点。
- 文件列表 / 版本元数据走 `describeVersion`（pending shelf 用 `p4 describe -S -s <change>`，报表型命令走 `execRecords()` 防 `-Mj` 塌陷，见上文 p4 插件节）。**`describeVersion` 的入参 change 也必须走 `archiveChange ?? change`**：作者的 `version.change`（如 100452）可能被 re-shelve/清空，直接用它会让文件列表时有时无、内容漂移成空；archive shelf（如 100475）才是不可变快照。这条与右侧内容 `changeForVersion` 是同一铁律的两个消费点，别只修一处。
- 侧栏 **SWARM CHANGES** 视图（`renderer/workbench/swarm/SwarmChangesView.tsx`）是这条铁律的第三个消费点：它跟随 SWARM REVIEWS 的选中行，按 `getReview` → 取 `versions[last]` 的 `archiveChange ?? change` → `describeVersion` 取数，恒与 depot 基线(0) 对比，与详情页的 version/compare 选择器解耦。archive shelf 不可变，所以强制刷新（review mutate）时**不给它带 `force`**，只给 pending 快照带。
- “打开文件”目标是当前 client 的工作区副本，路径必须批量走 `p4 where <depotFile...>`；不能从 depot/display path 猜本地路径。无映射时 DTO 传 `localPath:null`，标题栏隐藏该动作。

### diff 编辑器基础能力接入

- `SwarmDiffEditorInput` 必须继承通用 `DiffEditorInput`（仍覆写自己的 `typeId/id/resource`），这样 `isInDiffEditor`、`diffEditorHasOpenableFile` 与标准标题栏 Action2 才能识别：打开文件 / 上一个差异 / 下一个差异。
- `SwarmDiffEditor` 在 `setModel` 后用 `EditorGroupContext` 的 group id 注册 `DiffEditorRegistry`，cleanup 对称 unregister；否则标准导航、焦点与 e2e diff 探针都找不到 live Monaco 实例。
- 首次 `onDidUpdateDiff` 一次性调用 `revealFirstDiff()` 并立即注销监听；不能在 `setModel` 后同步 `goToDiff()`，此时 diff/layout 尚未计算完成。

### 行内评论锚定（Swarm API 要求）

- Monaco 空 view-zone 占位撑出评论条带 + overlay widget 托 React root（`createRoot`），逐锚点一套，对标 `InlineDirtyDiffController`（见 `apps/editor/src/renderer/workbench/scm/CLAUDE.md` 的 dirty-diff 案例）。
- `SwarmAddCommentRequest.context` 里 `content` = **锚定行 + 前 4 行原文**：Swarm 用它在文件漂移后**重新锚定**评论（API 硬要求，不是可选优化）。
- 提交评论时 `side`（left/right）→ 映射成 `context.rightLine`/`leftLine` + `version`；review 级评论则无 `context`。
- host 侧 `addComment` handler 会把顶层 `content` 折进 `context.content`（Swarm 要的是 `context.content`）。
