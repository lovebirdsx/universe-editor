---
name: perforce-graph-get-revision-feature
description: p4 graph/scoped history/timeline/explorer 多选六入口 Get Revision（P4V 式，@CL/#rev 移 have 版本）+ 两处 force（-f）恒确认（图谱右键 / Explorer「拉取版本…」后四档，红 labelColor，共用 confirmForceGet(spec,scopeText)）；rev 后缀一律由 _syncTargets 转义后拼；多选/图谱范围解析走 resolveContaining + resolveCommonClient 跨 client 严校验；e2e 种子须造「have 落后、@CL 升中间版本」正向场景，force 判据只能靠 refused 种子
metadata:
  node_type: memory
  type: project
---

对齐 P4V "Get Revision"：在历史视图里把工作区（或其中目录/文件）同步到某个变更列表，只动 have 版本、绝不碰 depot。五入口：全局图谱行右键「Get This Revision」（直接 `@CL`，范围跟随 wholeRepo 开关）+「Get Revision…」（多选目录对话框，镜像 GitGraphWorktreePickerDialog）；文件/文件夹历史行右键 Get This Revision + Get Latest Revision（后者直调 `perforce.syncLatest`）；Timeline 行右键 Get This Revision（唯一用 `#rev` 的入口，天然文件修订粒度）；Explorer 多选 `perforce.sync`/`perforce.syncLatest`。

确认策略（纯函数 `graphSync.ts`）：`graphSyncConfirmKind` 三态 —— `force` 请求恒为 `'force'`（弹合并的强制确认框，覆盖未收集改动 + 时间旅行重置两层语义合成**一个** modal），否则委托 `graphSyncNeedsConfirm`：单文件恒免确认；`isLatest`（目标行==head，等价 get latest）免；对话框路径 `confirmed:true`（确认按钮即授权）免；目录/多目录/整显示范围弹时间旅行 `showWarningMessage`。

**强制的确认框两侧共用一个**：`confirmForceGet(spec, scopeText)`（`extension.ts`，文案在 `syncSpec.ts` 的 `forceConfirmMessage`），图谱与 Explorer「拉取版本…」的四个强制档、以及拒绝后的补救都走它。正文用「**目标版本**」`{0}` 而非「changelist」——同一个 spec 位可能是 `@4521`/`@2026/08/01`/`#4`/`#head`，写死 changelist 会撒谎；`{1}` 是 `scopeTextOf` 截断 300 字符后的范围（Explorer 单文件/无 scope 分支传 `effectiveSyncScope(options.scope, target.syncScopes)`，即无 scope 时会真正回落到的那批 filespec）。

**`force` 只升级警告、绝不豁免警告**：`force` 刻意不进 `GraphSyncConfirmInput`（传给它即编译错误），故四条豁免（单文件/`isLatest`/`confirmed`/目录）对它全部失效——`isLatest` 行上右击强制拉取照样弹框（少了这条就是静默覆盖本地工作的通道）。`-f` 的显式入口仍是三个：① Explorer/命令面板 `perforce.sync` quick pick 的**后四项**（前缀「强制拉取：」+ 红色 `labelColor: 'force'`，把 `#head`/`@CL`/`@date`/`#rev` 四种命名各配一个强制版）＝事前整 scope `-f`；② 图谱右键「强制拉取（覆盖本地文件）」＝唯一同时携带两层破坏性（覆盖 + 时间旅行）的入口，故合成单弹窗而非叠两个 modal；③ refusal 补救（事后，per-file picker / clobber 走同一个 confirm）。日志：`PerforceClient.sync` 的日志行带 `-f`（`[perforce] sync -f @4521: N applied…`，覆盖全部入口，且**失败/取消/已最新三种结局同样带**——被 clobber 挡下的那次强制 get 最需要痕迹），图谱另有 `graph sync -f … to @CL` 的溯源行。

**quick pick 单选形态没有 title 位、`labelColor` 是渲染端闭集**：给单选列表加「危险项」要三处一起动（`universeColorIds.ts` 注册 `picker.forceLabel` + `QuickInput.module.css` + `QuickInputPanel.labelColorClass` 分支），且红色行的含义只能写进 label 与 `placeHolder`（无图例位），故档位名统一用「强制拉取：」前缀、placeholder 里带一句图例。

关键文件：
- `extensions/perforce/src/graphSync.ts` — `clSpecOf`（纯数字白名单→`@n`）/`graphSyncConfirmKind`（force 三态）/`graphSyncNeedsConfirm`/`resolveCommonClient`（paths 必须全归同一 client）
- `extensions/perforce/src/syncSpec.ts` — Explorer「拉取版本…」的纯决策层：`syncPickItems()`（**8 项字面量：普通 4 + 强制 4，顺序即屏幕顺序**；`kind: head|changelist|date|rev` + `force` + `labelColor`）/`syncPromptOf`（`Record<Exclude<Kind,'head'>,…>`，新增 kind 不补 prompt 即编译错误）/`syncSpecOf`（typed sigil 原样用，否则 rev 补 `#`、其余补 `@`）/`effectiveSyncScope`（镜像 `_syncTargets` 的**空数组同样回落**）/`scopeTextOf`（300 截断 + `(N filespecs)`）/`forceConfirmMessage`
- `extensions/perforce/src/p4Filespec.ts` — `buildSyncFilespecs`（逐条转义+目录 `<dir>/...`+嵌套去重+保序，**不拼 rev 后缀**）
- `extensions/perforce/src/extension.ts` — `perforce-graph.syncToChange`（`graphSyncConfirmKind` 三态分流 + `req.force` 透传 `runSync`）/`getSyncScopes` 运行时命令 + `syncSelectionOwner` 多选校验 + 共享的 `confirmForceGet(spec, scopeText)`；`perforce.sync` 的两个分支各自把「本次真正会覆盖的 scope」算成文案（多选=`buildSyncFilespecs(selection)`，单文件/无 scope=`effectiveSyncScope(scoped?.scope, target.syncScopes)`）；`PerforceGraphSyncDialog` 的候选就是 `getSyncScopes` 的纯 readdir（零 p4，失败空列表）
- `extensions/perforce/src/client.ts` — `_syncTargets`（唯一拼 `@CL`/`#rev` 的地方，空 scope 回落到 `_syncScopes`）；`sync()` 的汇总日志带 `-f` 标记（全入口的审计点）
- `extensions/perforce/src/timelineProvider.ts` — `TimelineSyncRunner` 注入复用 `runSync`（进度/取消/拒绝补救同一套）
- `apps/editor/src/renderer/workbench/perforceGraph/PerforceGraphEditor.tsx` — `openChangeMenu` 两分支各一条 `danger` 红项 `id:'forceGet'`，发 `force:true` 且**刻意不带 `isLatest`/`confirmed`**
- `apps/editor/src/renderer/workbench/perforceGraph/PerforceGraphSyncDialog.tsx` — 空候选时显示解释文案+确认禁用，不静默回退整工作区
- 渲染端 labelColor 三件套：`packages/workbench-ui/src/feedback/quickInput/QuickInputPanel.tsx`（`labelColorClass` 闭集分支）+ 同目录 `QuickInput.module.css`（`.itemLabelForce`）+ `apps/editor/src/renderer/services/themes/universeColorIds.ts`（`picker.forceLabel`，`cssVarCoverage.test.ts` 守契约）

教训：
1. **后缀拼接位置是红线**：`@CL`/`#rev` 只能由 `client._syncTargets` 在 `buildScopeFilespec` 转义**之后**拼；调用方只传裸 filespec。顺手修掉旧 `syncTargetOf`（拼 `/...` 不转义）改走 `buildScopeFilespec`。timeline 的 `#rev` 也要数字白名单（rev 跨 RPC 来）。
2. **遮蔽红线两半**：`perforce-graph.*` 运行时命令绝不进 `contributes.commands`；而 timeline 贡献菜单命令**必须**进（+commandPalette when:false）。
3. **多选/范围解析一律数据查询语义**：`resolveContaining`（严格最长前缀、无 active fallback），跨 client 经 `resolveCommonClient` 一次判定即中止——一次 `p4 sync` 只跑一个 client。
4. **e2e 时间旅行种子只能造正向**：fake-p4 不带 `-f` 的回退是 no-op，必须「have 落后、`@CL` 升到中间版本」；`submitted` 种子数组化并带 `rev`（写 `changeMeta[cl].rev`）才能让 `@cl` 落非 head；fake-p4 `changes` case 按 submitted 文件集过滤（无文件集的 annotate-only 种子豁免，勿伤 blame）。
5. 全局图谱行右键同时有直接项与省略号弹窗项是 P4V 惯例，靠 `confirmed` 字段区分两层确认。
6. **e2e 造 force 可观测差异只能用 `refused: true` 种子**：正向 get 带不带 `-f` 都写同样的字节，证明不了任何事；`refused` 让 fake 在无 `-f` 时跳过该文件（保留本地草稿、have 不动），带 `-f` 才覆盖——磁盘内容 + haveRev 双通道就是判据。守卫靠三处：`graphSync.test.ts` 的 force 真值表 + `PerforceGraphEditor.test.tsx` 对 payload 的 `toEqual` 精确断言（多带 `isLatest` 即红，已变异验证过）+ Explorer 侧 `syncSpec.test.ts`（八档顺序、force 组必有 labelColor、普通组**必须没有**该键）。Explorer 的 force e2e 靠「落盘修订号既非草稿也非 head」同时证明 `-f` 到达 p4 与跑的是所选 spec（`@4521` 落 #2、`#3` 落 #3）——只断言「文件变了」会漏掉 `#head` 顶包。

e2e 五 spec 在 `extensions/perforce/e2e/specs/`：`perforceGraphSync`（含图谱 force get describe，`refused` 种子）/`perforceGraphFileHistorySync`/`perforceGraphFolderHistorySync`/`perforceTimelineGetRevision`/`perforceExplorerSyncMultiSelect`（@regression，另含「后四项强制档」describe：菜单路径走 `@4521 -f`、`runCommand('perforce.sync', {resourceUri})` 走单文件分支的 `#3 -f`）。
