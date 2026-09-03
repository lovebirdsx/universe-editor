---
name: perforce-graph-get-revision-feature
description: p4 graph/scoped history/timeline/explorer 多选五入口 Get Revision（P4V 式，@CL/#rev 移 have 版本）；rev 后缀一律由 _syncTargets 转义后拼；多选/图谱范围解析走 resolveContaining + resolveCommonClient 跨 client 严校验；e2e 种子须造「have 落后、@CL 升中间版本」正向场景
metadata:
  node_type: memory
  type: project
---

对齐 P4V "Get Revision"：在历史视图里把工作区（或其中目录/文件）同步到某个变更列表，只动 have 版本、绝不碰 depot。五入口：全局图谱行右键「Get This Revision」（直接 `@CL`，范围跟随 wholeRepo 开关）+「Get Revision…」（多选目录对话框，镜像 GitGraphWorktreePickerDialog）；文件/文件夹历史行右键 Get This Revision + Get Latest Revision（后者直调 `perforce.syncLatest`）；Timeline 行右键 Get This Revision（唯一用 `#rev` 的入口，天然文件修订粒度）；Explorer 多选 `perforce.sync`/`perforce.syncLatest`。

确认策略（纯函数 `graphSync.ts graphSyncNeedsConfirm`）：单文件恒免确认；`isLatest`（目标行==head，等价 get latest）免；对话框路径 `confirmed:true`（确认按钮即授权）免；目录/多目录/整显示范围弹时间旅行 `showWarningMessage`。

关键文件：
- `extensions/perforce/src/graphSync.ts` — `clSpecOf`（纯数字白名单→`@n`）/`graphSyncNeedsConfirm`/`resolveCommonClient`（paths 必须全归同一 client）
- `extensions/perforce/src/p4Filespec.ts` — `buildSyncFilespecs`（逐条转义+目录 `<dir>/...`+嵌套去重+保序，**不拼 rev 后缀**）
- `extensions/perforce/src/extension.ts` — `perforce-graph.syncToChange`/`getSyncScopes` 运行时命令 + `syncSelectionOwner` 多选校验；`PerforceGraphSyncDialog` 的候选就是 `getSyncScopes` 的纯 readdir（零 p4，失败空列表）
- `extensions/perforce/src/timelineProvider.ts` — `TimelineSyncRunner` 注入复用 `runSync`（进度/取消/拒绝补救同一套）
- `apps/editor/src/renderer/workbench/perforceGraph/PerforceGraphSyncDialog.tsx` — 空候选时显示解释文案+确认禁用，不静默回退整工作区

教训：
1. **后缀拼接位置是红线**：`@CL`/`#rev` 只能由 `client._syncTargets` 在 `buildScopeFilespec` 转义**之后**拼；调用方只传裸 filespec。顺手修掉旧 `syncTargetOf`（拼 `/...` 不转义）改走 `buildScopeFilespec`。timeline 的 `#rev` 也要数字白名单（rev 跨 RPC 来）。
2. **遮蔽红线两半**：`perforce-graph.*` 运行时命令绝不进 `contributes.commands`；而 timeline 贡献菜单命令**必须**进（+commandPalette when:false）。
3. **多选/范围解析一律数据查询语义**：`resolveContaining`（严格最长前缀、无 active fallback），跨 client 经 `resolveCommonClient` 一次判定即中止——一次 `p4 sync` 只跑一个 client。
4. **e2e 时间旅行种子只能造正向**：fake-p4 不带 `-f` 的回退是 no-op，必须「have 落后、`@CL` 升到中间版本」；`submitted` 种子数组化并带 `rev`（写 `changeMeta[cl].rev`）才能让 `@cl` 落非 head；fake-p4 `changes` case 按 submitted 文件集过滤（无文件集的 annotate-only 种子豁免，勿伤 blame）。
5. 全局图谱行右键同时有直接项与省略号弹窗项是 P4V 惯例，靠 `confirmed` 字段区分两层确认。

e2e 五 spec 在 `extensions/perforce/e2e/specs/perforceGraph*Sync*`/`perforceTimelineGetRevision`/`perforceExplorerSyncMultiSelect`（@regression）。
