# Perforce Graph（p4 图谱）

`Perforce Graph` 是对等 **Git Graph** 的主编辑区标签页，把**已提交的 changelist 历史**可视化。Perforce 历史是**严格编号、线性排列的 changelist 列表**（没有 git 那样的本地分支合并 DAG），所以图谱是**单条泳道**（single lane）——这是与 git graph 最根本的差别，其余交互（搜索、右键、详情面板、view-state 持久化）都刻意与 git graph 对齐以保证一致体验。

> 先读 `../CLAUDE.md` 的「分层架构」「连接红线」「密钥红线」——本文只讲**图谱特有**的东西：数据源方法、wire 类型、renderer 编辑器与注册。

## 三层技术栈（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| wire 类型 | `packages/extensions-common/src/contracts/perforceGraph.ts` | renderer↔扩展共享的 DTO（`P4GraphChangeDto` / `P4GraphRepoDto` / `P4GraphLoadResult` / `P4GraphChangeDetailsDto` / `P4GraphFileChangeDto` / `P4GraphFileDiffRequest` / `P4GraphSyncPoint`）+ `PerforceGraphCommands` 命令 id 常量。**必须**在 `index.ts` re-export |
| 纯解析 | `extensions/perforce/src/p4GraphParser.ts` | `parseChangesList` / `parseChangeDescribe`（numbered 并行键折叠）/ `statusFromAction`（p4 action→A/M/D/R）/ `fileDiffRevs`（按 status 算 left/right rev spec）/ `parseWhereLocalPaths` / `displayPath`。**全纯、可对 fixture 单测** |
| 数据源 | `extensions/perforce/src/client.ts` | 图谱方法：`getGraphChanges(max)` / `getGraphHaveChange(scopes)` / `getPendingCount` / `getOpenedForGraph` / `getGraphChangeDetails(id)` / `printRevision(spec)` / `_whereLocalPaths` |
| 同步账本 | `extensions/perforce/src/graphSyncLedger.ts` | 纯函数（`scopeIdentity` / `scopeCovers` / `lookupSyncPoint`）+ `GraphSyncLedger`（落 `<globalStoragePath>/graphSyncLedger.json`）。每次编辑器内 sync 记一条，图谱只读它——见「本地同步点」节 |
| 命令 | `extensions/perforce/src/extension.ts` | 注册 11 个 `perforce-graph.*` 命令（见下）——**运行时命令**（`commands.registerCommand`），构建 DTO、算单泳道 parents、跑 diff |
| 编辑器 | `apps/editor/src/renderer/workbench/perforceGraph/PerforceGraphEditor.tsx` | 主 React 编辑器：单泳道单选 + 顶部"待定变更"节点。只用 `ICommandService` + `IScmService` 跨 JSON 边界调命令 |
| 输入/状态/动作 | `apps/editor/src/renderer/services/editor/PerforceGraphEditorInput.ts` · `services/perforceGraph/perforceGraphViewState.ts` · `actions/perforceGraphActions.ts` | EditorInput（URI `universe:/perforceGraph`）· module-level view-state 单例（重开秒恢复）· 两个 Action2 |

## 命令清单（`PerforceGraphCommands`）

`getRepos` / `setRepo` / `getChanges` / `getHaveChange` / `getSyncPoint` / `getChangeDetails` / `getPendingChanges` / `openFileDiff` / `openWorkingTreeFile` / `syncToChange` / `getSyncScopes`。全部走 `commands.registerCommand`（**不进 package.json `commands` 数组**，见头号坑），renderer 用 `commands.executeCommand(PerforceGraphCommands.xxx, ...)` 调用。

除 `syncToChange` 外全部只读。`syncToChange` 是唯一的写命令（P4V 式 "get revision as of a changelist"）：`p4 sync` 到所选 CL，把工作区 have 版本**移动**（可回退可前进）——只动本地工作区，depot 仍只读。范围 = 请求的 `scopePaths`（经 `buildSyncFilespecs` 展开，目录转 `<dir>/...`）或图谱显示范围（`wholeRepo ? '//...' : workspaceScope`）；`@CL` 后缀由 `clSpecOf` 生成（只认纯数字，防任意文本 splice 进 filespec）；执行复用插件的 `runSync`（进度条 / 拒绝处理同一套）；确认策略 = 纯函数 `graphSyncConfirmKind`（`graphSync.ts`，三态）：`force` 请求 → 弹**合并**的强制确认框（覆盖未收集改动 + 时间旅行重置两层语义合成一个 modal，`confirmForceGet(spec, scopeText)`——与 Explorer 的「拉取版本…」强制档**共用同一个**函数与文案，故正文只说「目标版本」不说 changelist）并透传 `force` 给 `runSync` → `p4 sync -f`；否则委托 `graphSyncNeedsConfirm`：`confirmed`（多选目录对话框已确认）/ `isLatest`（目标 = 最新行，等价 get latest）/ 单文件 scope 免确认，目录 / 多路径 / 整显示范围弹时间旅行警告。**`force` 压过全部三条豁免**（`isLatest` / `confirmed` / 单文件都不豁免，见下）。`getSyncScopes` 列图谱 client root 的顶层目录（纯 `readdir`，零 p4 调用，失败读作「无候选」），喂 renderer 的多选目录对话框。

**红线：`force` 只能升级警告，绝不能豁免警告**。`graphSyncNeedsConfirm` 的入参类型 `GraphSyncConfirmInput` **刻意不含** `force`——把 force 传给它（想借 `isLatest` 免确认）是编译错误；force 一律经 `graphSyncConfirmKind` 短路成 `'force'`。理由：`isLatest` 免确认的前提是「get latest 不是时间旅行」，而 `-f` 无论目标是不是 head 都会重写可写本地副本、销毁未收集的工作；单文件 scope 恰是最需要 force 的场景（have 上但本地改过 → 普通 get 报 up-to-date 什么都不做）。确认文案点名目标版本与 scope（截断 300 字符 + `(N filespecs)`，两侧共用 `syncSpec.ts` 的 `scopeTextOf`）——整仓库图谱的 scope 是 `//...`/工作区根 `...`，那行是用户唯一能察觉「这一下要重拉整仓」的时机。日志行带 `-f` 标记：图谱自己的溯源行（`graph sync -f … to @4521`，非 force 也打），加上 `PerforceClient.sync` 的日志行（`[perforce] sync -f @4521: N applied, …`，**所有** `-f` 入口共用这一处，故 Explorer 侧的强制档同样留有痕迹；带标记的不只是成功汇总——**失败 / 取消 / 已最新**三种结局同样带，被 clobber 挡下的那次强制 get 恰是最需要留下痕迹的）——事后追查「谁覆盖了我的文件」时，这是唯一能区分强制 get 与普通 get 的现场。

## 本地同步点（"已同步"徽章 / 账本 + 手动查询）

图谱列的是 depot 侧历史，看不出「哪些已经拉到本地」。**本地同步点**补上这一维：该 scope 下**已进入工作区 have 列表的最新已提交 CL**，renderer 在命中行打 `Synced` 徽章，工具栏追加 `· Synced to #NNNN`（徽章只对当前加载页可见，工具栏那句是同步点被分页出去 / 被搜索滤掉时的兜底）。

**答案有三个来源，按代价与新鲜度排序**：

1. **本地账本**（`graphSyncLedger.ts`，零 p4 调用，`getSyncPoint` 同步返回）——编辑器内每次 get/sync 完成后写一条；`load()` / `revalidate()` / 换 scope 只读它。这是常态路径。
2. **窄 scope 的自动查询**——**scoped tab**（文件 / 目录 / 合并历史，`scopePaths` 存在）账本没答案时仍自动查 `#have`（成本 180–340ms，付得起），保持老行为。
3. **用户按「查询同步点」按钮**（`getHaveChange` 带 `force`）——唯一能看到**外部同步**的途径，也是宽 scope 唯一的查询方式。

**为什么不再自动查宽 scope**：`#have` 的成本 ≈ scope 内文件数（真机百万文件工作区 36–42s，表在 `docs/pitfalls.md`「图谱同步点」节）。旧实现每次打开图谱 / 换 scope / 刷新都付一遍这个成本：**整图未知名 `#? (click to query)` 本身就是「不替用户做这个决定」**。全图（未 scoped 且非 wholeRepo）与 wholeRepo 两条分支的首次打开都走它。

**红线：账本的 scope 坐标是 host path + isDirectory（`SyncScopeTarget`），不是 filespec**。`resolveGraphScope` 一处解析出 `list`/`have`/`ledgerScope`，其中 `list`/`have` 是**转义后、目录展开后**的 p4 filespec——拿它做包含推理必然错（`X:/ws/a` 与 `X:/ws/ab` 的前缀陷阱、`%23` 转义、`<dir>/...` 后缀）。**读写账本一律用 `ledgerScope`**，`buildSyncFilespecs` 只用来喂 p4。

### 账本（`graphSyncLedger.ts`）

- **记什么**：`{ clientRoot, paths, change, source: 'sync'|'query', at, complete, floor }`。`record()` **重读磁盘再合并**（多窗口各持一份内存副本，不重读会互相覆盖）、按 `scopeIdentity` 去重只留最新、上限 200 条。原子写（temp + rename）。
- **存哪儿**：`context.globalStoragePath/graphSyncLedger.json`——**多窗口共享**（renderer 内存里的服务是 per-window 的，各存一份必然发散），且**不写进 p4 工作区目录**（那是用户与 p4 自己的领地，写进去会被 reconcile / 提交扫到）。
- **怎么答**：`lookupSyncPoint(records, clientRoot, scope)` —— 候选 = **scope 包含目标**的记录（目标自身 + 更宽的祖先，**不含更窄的**），取 `at` **最新**的一条。
  - **红线：按时间取，不按深度取**。「最具体优先」是错的：先 `sync A/B@4520`、再 `sync A@4560`，此时 A/B/C 的答案是 **4560**（后一次同步把整个 A 也推到了 4560），按深度会答 4520 = 低报。
  - **更窄的记录绝不回答更宽的问题**。宽 scope 的答案**可以**来自更窄记录吗？不可以——那正是旧实现里「unscoped 探针不得窄化成 client root」那条红线的同一个错误方向。
  - **答案来自更宽 scope 时是上界**（`widerScope: true`），UI 必须标注：`sync A@4560` 之后问 A/B，答案 4560 只保证「A/B 不超过 4560」。上界**用包含关系判定**（问题 scope 是否覆盖记录的全部路径），不是比 scope 身份——多选 tab 问 `[dir, dir/f.txt]` 而记录是 `[dir]` 时，答案其实是精确的（那次 get 也动了 f.txt），比身份会给出一个假的「上界」警告。
- **新记录只在「可能把文件带回更旧处」时才作废它触及、却没重新覆盖的旧记录**（`contradictedBy`）。一条记录说的是「这个 scope 里的**每个**文件都在这个 CL」；此后一条**触及它**（两条 scope 里有路径互相包含：落在它内部，或多选 tab 与它部分重叠）、又覆盖不了它全部路径的新记录，才**可能**证伪它。
  - **判据是 `floor`（本次操作可能把文件带到的最旧 CL），不是「新记录取值更低」**——这是本规则最容易搞错的一处：**更窄 scope 的答案天然更低，那不是矛盾**（见下条）。
    - **只读查询**：`NO_REGRESSION`。它**不移动任何文件**，没有资格成为任何一条旧记录过时的证据。
    - **拉 head（`#head`）**：同样 `NO_REGRESSION`——只可能前进，没有更新可取。
    - **`@CL`**：**那个 CL**。`@8793700` 不可能把文件带到 8793700 以下；目标是 8793700 而旧记录正好是 8793700 时不构成回退（`>` 而非 `>=`）。
    - **其余**（`#<rev>`、空 spec 的逐文件 get）：spec 本身判不出来 → `0`，即「可能落到任意旧处」。
    - **缺 `floor` 的旧账本 / 手写记录一律按 `0` 读**：这个方向的误判只多花一次查询，反过来会留下一条过时的高报。
  - **红线：`#have` 答的是「碰过这个范围的最新 CL」，宽 scope 的同步点可能从未碰过它**。整仓库 `@8793700` 完全可能没改过 `Source/.../k.可视化编辑` 下任何文件，于是该目录查询答出的 `8793491` **正确、更低、且与宽记录相容**（宽 get 依然把那些文件留在了 8793700 那一版，只是从未改动过它们）。**真机实测的完整链路**：工作区图谱显示 `#8793700` → 在子目录历史里按下查询得到 `#8793491` → 回到工作区图谱变成 `#? (click to query)`，白付一次整仓库探针。这就是把 `floor` 引进来的原因：*两个不同范围的答案不一样，本身不构成任何证据*。
  - 实例（**高报红线**，这条仍然作废）：整仓库记账 `{X:/ws @8793700}` → 之后 Timeline 把 `X:/ws/src/a.txt` 拉回旧修订（`#<rev>`，`floor = 0`）→ 旧记录仍以 `widerScope: false`（无保留、看似精确）回答 `X:/ws` 是 8793700，而 src 已经不在 8793700。清单里没有任何信息说明 ws 的**其它**文件在哪，所以诚实的答案是「不知道」——图谱退回「点击查询」。
  - 被新记录**完整覆盖**的旧记录保留（新记录赢下它本可以回答的每一次 lookup，留着不花钱、也不用删）。改这条要么重写账本模型、要么回到 per-file 的 have 查询——后者正是本机制存在的理由。
  - **墓碑（`change: ''`）的 `floor = 0`**，所以它照旧作废它触及的更宽记录：「这个范围里没有任何已同步的文件」和「更宽的记录说这些文件都在某个 CL」不能同时为真。已知代价：对一个**空的 / 未被 client 映射的**文件夹按查询，这两种情况在 p4 那里不可分辨，更宽 scope 的徽章会退回「点击查询」——偏低的方向，再查一次即可恢复。
  - **作废要打日志**：`record()` 把每条被作废的记录连同它的 CL 与 host 路径写进 Perforce 输出频道。作废抹掉的是**另一个 tab / 另一个 scope** 的徽章，而它的缺席在那边读起来就是「从来没问过」——没有这行日志，账本里不会留下任何解释（上面那条真机 bug 就是这么无痕的）。
- **`complete` / `partial`**：`refusedModified`/`refusedOverwrite`/`keptOpen`/`mustResolve` 全 0 才算精确；被拒绝的文件留在原版本 → 答案只能是上界。**该记的三类**：`applied > 0`、`upToDate === true`（p4 明确说「已是最新」——回读到的落点就是真相，不记就是「我明明点了拉取但徽章不动」）、以及有拒绝但仍有动作的 run（记成上界）。**不该记的两类**：取消 / 失败，以及**结局无法识别**（`!summary`，或 exit 0 + 什么都没应用 + 又没有 up-to-date 行）——后者可能意味着任何事，宁可不记也不猜。

### 记账的写入点（`runSync`）

- **`runSync` 的 `ledgerScope` 是必填选项**：新增 sync 入口时编译器会逼你想清楚「这次 sync 覆盖哪些 scope」。这是刻意的——漏记一个入口 = 「我明明拉了但图谱不显示」，比不做这个功能更糟。已知入口：图谱 4 个（Get This Revision / Get Latest Revision / Force Get / Get Revision… 对话框）、Explorer 的拉取最新版本 / 拉取指定版本 / 单文件 get、Timeline 的 get、状态栏的「落后」chip（`p4StatusBar` → `perforce.syncLatest`，**记的是活动编辑器里的那个文件**——chip 本来就只描述一个文件，`resolveTargetPath` 取它；只有命令面板里没有活动文件时才退回 `scopeLessLedgerScope`）。
- **无 scope 的 get 记的是它的真实范围，不是 client root**（`scopeLessLedgerScope`）：无参数时 `PerforceClient.sync` 打的是 `_syncScopes`＝打开的文件夹（配了 `workspace.focusFolders` 则是那些目录），只有没有打开任何文件夹时才是 `//...`。记成 client root 会让「整仓库」scope 的图谱拿一个从没碰过那些文件的 CL 打徽章——正是本文件的头号红线（高报）。（`scopeLessLedgerScope` 是编译期逼出来的：这条洞是靠代码审查发现的，e2e 与单测都没覆盖无参 get。）
- **回读答「空」要写墓碑，同样是记真事**：`readGraphSyncPoint` 区分**失败**（非零退出 / 抛错 → `failed`，什么都不写）与**空答案**（exit 0 + 零记录 → 该 scope 的 have 列表里没有 CL）。空答案发生在「拉到该 scope 第一个变更之前」或「拉回文件还存在之前」这类 get 上；写墓碑才能让更旧的、更宽的记录不再声称它停在某个 CL 上（与查询答空同一条规矩，`recordEmpty(..., 'sync')`）。
- **`@CL` 的 get 必须回读落点，不能记请求的 CL**。`p4 sync a.txt@4521` 把 a.txt 落在一个**可能不等于 4521** 的 revision 上（4521 从未碰过该文件时落在它之前最后一个碰过它的 CL）。所以 sync 结束后跑 `readGraphSyncPoint(scopes, suffix)`（`p4 changes -s submitted -m 1 <scope><suffix>`，background / 5s 预算，`suffix` = 原样的 `@4521` / `#head` / `#4` / 空）拿真实落点。后缀**只由 `_syncTargets` 转义后拼接**（路径里的 `#` 会先变 `%23`）。
- **回读 `await` 在 `runSync` 里**（不在 `.then` 里），所以 sync 命令 resolve 时账本**已经**在盘上——renderer 的 revalidate 不会读到旧值。
- **`#have` 必须拼在转义之后**（`getGraphHaveChange` 内部拼；与 `buildForceGetFilespecs` 拼 `#rev`、`readGraphSyncPoint` 拼 `@cl` 同一条规矩，见 `p4Filespec.ts`）。空 scope 列表直接返回 `{ id: null, failed: true }`（裸 `-m 1` 是「depot 里最新的变更」，与 have 点正相反，而且它会**成功**回答，错的答案还会被缓存）。

### 查询覆盖记账（truth beats bookkeeping）

- **只有真的去问了服务器的那次查询才写账本**（`opts.force === true`，即按钮 / 用户显式查询），就地覆盖该 scope 的记录——否则一条旧的记账会把答案永久冻在那一刻，用户按按钮也改不动。
  - **scoped tab 的自动探针（`force: false`）不写**：它吃 `P4CacheNs.haveChange` 缓存（TTL = `max(workspaceTtl, 5min)`），所以返回的可能是**上一次问服务器**的旧答复。而记录是按 `at: askedAt`（派发时刻）排序的，把一份旧答复盖上「此刻」的戳写进去，会压过这期间真实发生的 get —— 往回拉的方向上就是**高报**（声称一个 scope 已经没有的 CL）。它照样回答它自己那个 tab，只是不许替工作区记账。
- **查询答「空」要写墓碑记录，不能只删自己那条**：服务端说「这儿什么都没有同步」是一等答案（`p4 sync` 到旧 CL、revert 都会让同步点真的后退）。若只是删掉该 scope 自己的记录，一条**更旧的、更宽的**记录会在下一次 load 时把这个 CL 重新贴回徽章——用户刚问到的答案被静默推翻。故写 `recordEmpty()`（`change: EMPTY_SYNC_POINT` 的记录），它按 `at` 压过那条宽的、并按 `contradictedBy` 把那条宽的**作废**，lookup 见到它即报「无答案」。
- **查询失败 ≠ 空答案**（契约 `P4GraphHaveChangeResult`）：失败 / 超时 / spawn ENOENT / 无 client → `{ id: null, failed: true }`，**什么都不写**，renderer 保留原徽章。只写日志、绝不弹错。`getGraphHaveChange` 自带 try/catch（异常冒泡会杀掉 extension host）。日志 `[perforce] graph have point: #N (K filespec(s), Xms)` / `sync point read-back …` **耗时必须在里面**。

### renderer（`PerforceGraphEditor.tsx`）

- **`haveSeqRef` 独立于 `fetchSeqRef`**（后者在 reveal 分页时也自增，共用会把仍然正确的徽章踢掉）。
- **`load()` 开头 `++haveSeqRef` + `setSyncPoint(null)`**（换 scope 时旧答案不得贴到新列表）——**所有换 scope 的路径都汇到 `load()`**，所以「过期答案不会跨 scope 落地」这条只靠它成立。
- **红线：用户查询自增 seq，账本读不自增**。查询是「用户等着的最新真相」，压过在飞的一切；账本读只是填空，若也自增，则任何一次 load / revalidate 落地都会**静默丢掉用户正在等的答案**——而「切 scope」恰好就会触发一次 load，正是最容易被撞上的场景（e2e 实测：`perforceGraphHave.spec.ts` 第三条 journey 一度因此稳定失败，`PerforceGraphEditor.test.tsx` 的 `keeps a user query that a load lands on top of` 是它的单测）。残留代价：查询在飞时若有一次 get 落账，查询可能最后落地并带回更旧的答案；下一次 load / revalidate 会读账本纠正。
- **取号必须在「拒绝重复按」之后**：`++haveSeqRef.current` 一旦被一次**注定要被拒绝**的按压执行，在飞的那次查询就变成过期答案而被丢弃，用户等到的答复永远不落地（实测：按钮停止转圈、徽章不动）。任何「先取号、后判可否」的写法都有这个洞。
- **账本读不得覆盖它超车的那次查询**（`racedByQuery`）：序号守卫拦不住——账本读若在查询**之后**派发，抓到的是同一个序号。而账本读的内容是**查询前**的（扩展在查询命令返回时才写账本），所以它最后落地会把用户刚等到的答案换成旧值（或 null，徽章整块消失）。判据用**派发时刻**的 `queryInFlightRef`，不能用到岸时刻（到岸时那次查询通常已经答完，ref 已释放）。
- **只有点击才分页**：工具栏的 `#4521` 是按钮 → `revealCommit(id)`（复用既有 reveal / 自动翻页）；**徽章本身永不触发分页**（分页是几十次 depot 查询，不能由一个标注自行发起）。未知态 `#? (click to query)` 本身也是按钮，点了即查。
- **同步点可能没有那一行；「找不到」必须在翻页之前就知道**（真机反馈：打开某目录历史点「跳转到同步点」，机器翻了 16 页把该目录 4879 条历史全拉进来、然后什么也没发生）。判据来自 p4 自身的有序性：`p4 changes` 的输出**严格按 CL 号递减**，而每一页都是该序列的**连续前缀**，所以——**窗口里出现任何一行 CL 号 < 目标号，目标就永远不可能出现**（存在必在更上面）。三处据此统一：
  - `ruledOut(changes, id)`：收手判据（非 CL 号的 id，如合成 pending 节点 `*`，同判）；没有它，`MAX_REVEAL_PAGES` 就是唯一护栏，即「找不到就翻 20 页」。反面同样成立：**目标比窗口里所有行都旧时不许提前收手**（那才可能真的在更旧历史里，得继续翻，页数上限兜底）。
  - 落点 `syncPointRowOf(changes, pointId)`：窗口里第一行 CL 号 ≤ 目标号者 —— 即**该范围内被这次同步覆盖到的最新变更**。它不只是「就近凑合」：行严格递减，所以这一行就是**全历史**里最新的被覆盖项（更近的若存在，必在它上面且会先被找到）。`onMiss: 'below'` 只在同步点两个入口（工具栏 `#CL` 与行菜单「跳转到同步点」）传，`pendingReveal`（timeline / blame / Commit Changes）走 `exact`：那些地方用户点的是**具体某个变更**，落到别的行上是误导，只该提示「不在当前范围的历史里」。
  - 徽章同落点：`isHave={c.id === syncPointRow?.id}`。目标在历史里时它**恒等于**目标行（与旧行为完全一致），不在时落在覆盖行上——**不变量是「徽章行 = 落点行」，不用给徽章开特例**。代价是工具的措辞要跟上：`haveTooltip` 分两档（`haveBadge.tooltip` 精确 / `haveBadge.coveredTooltip` 覆盖，后者要点明「同步点没改这个范围」），工具栏仍显示记录的 CL（它是诚实的上限且带来源与时间）。
  - 落空不再静默：三种结局各自发 toast（`landedBelow` / `notInScope` / `reveal.missing`）并打 `logger.debug`（翻了几页、为什么收手）——这次的问题在日志里曾完全无痕。**单测钉的是翻页次数**（`reveal.test.tsx` 的两个 stop 用例），**e2e 钉的是用户可见的落点与提示**（`perforceGraphHave.spec.ts` 第四条 journey：文件夹 scope + 只碰外部目录的同步点），两边都要先删掉该分支验红。
- **查询按钮跟在答案后面，不跟视图控件在一起**（`data-testid="perforceGraph-querySyncPoint"`，落在 `.count` 行内、`#4521` 之后）：重新问一次是关于**这个数字**的动作，放进右侧标题栏那排控件里会被读成另一个视图开关。两个入口必须同时存在——`#?` 是「还不知道，按一下」，按钮是「已经记着，重新问一次」；只有前者时，记账后就没有再问的路。
- **按钮图标与菜单项同一个 `sync`**（`RefreshCw`，`icon-map.ts` 里 `sync` 的同一个组件）：同一动作在两处必须是同一个符号，问号让人以为它是「这是什么」而不是「再查一次」。
- **在飞期间：一次只允许一个查询 + 可见反馈**。按下后图标换成 `Spinner`（`data-querying="true"`，`data-tooltip` 同时切成「正在查询」）、旁边出现 `data-testid="perforceGraph-queryElapsed"` 的秒表（100ms 一次，只重绘一个数字）。答案落地后秒表**保留 2.5s** 并带 `data-done="true"`——窄 scope 的答复常常比第一次 tick 还快，那行数字是「这一次点击起效了」的唯一凭据。
  - `queryInFlightRef` **在飞时拒绝第二次按压**（按钮与菜单同一个入口），并 toast 说明「已经有一次查询在进行中」（`INotificationService`，用 `useOptionalService` 取，容器里没有它时按钮照常工作）。第二次按不会更快——它只会再排一次同样按 scope 规模计费的查询。
  - **只有用户查询（`force`）开表**：scoped tab 的自动探针便宜且自发，给它转圈会让「秒表」这一个信号同时表示两件事。判据是 `askServer(force, seq)` 的 `force`。
  - `stopSyncQueryClock` 只在 `seq === haveSeqRef.current` 时调用：被顶掉的那次探针不许停表，否则新按的那次会跟着失去秒表（用户看到的是「我按了，它停了，然后又转起来」）。
  - `cancelSyncQueryClock`（换 scope 的 `load()` 里）**连秒表一起清、并释放独占槽**，不写 `done`：那次答案已经被丢弃，报它的耗时会指向一个不存在的结果。
  - **失败是第三种结局**：`stopSyncQueryClock(true)` → 秒表带 `data-done` + `data-failed`，tooltip 说明「没拿到答案」，徽章保持不变。把它和「答复了但没变化」显示成同一个样子，等于让人以为查过了。
  - 组件卸载置 `clockDisposedRef`：晚到的答复仍会走到 `stopSyncQueryClock`（序号在卸载后不再自增），不拦就会再武装一个 2.5s 定时器。「卸载时清 interval + timeout」只覆盖已存在的那一个。
  - **这个闩必须在 effect 的 setup 里复位**（复现测试：`ends the clock the query started, under StrictMode's dry-run mount`，harness 的 `strict: true`）。dev 的 `<StrictMode>`（`main.tsx`）对每个 effect 做 mount → cleanup → 再 mount，**同一个组件实例**，于是空跑那次 cleanup 把它永久置 true——之后每次 `stopSyncQueryClock` 都在清掉 interval 后提前返回：**秒表数字冻在最后一次 tick、`Spinner` 永不还原，而答案本身照常落地**（`setSyncPoint` 在同一个 `.then` 里，跑在前面）。通式：**凡是在 cleanup 里置位的 ref，setup 里必须复位**，否则该标志在 dev 下等价于「永久卸载」（同 `strictmode-useref-emitter-dispose-dev-only`；prod 不复现，只有单测能守）。
- **「答空」与「没问过」在界面上要分得开**：`queriedEmpty` 记下最后一次查询答的是 `id: null`（该 scope 里没有任何已同步文件），此时 `#?` 的 tooltip 改成「Perforce 答复：该范围里没有已同步的文件」，`load()` 换 scope 时清掉。两者都显示 `#?` 是诚实的（没有可命名的 CL），但 tooltip 说「还不知道」会把刚花几十秒问到的答案说成没问过，并把用户直接送回同一次查询。
- **右键菜单里同样有这两项**（`Query Sync Point` / `Go to Sync Point`，图标 `sync` / `go-to-definition`）：图谱只有这一个行菜单，而鼠标常常正停在行上；`syncPoint` 未知时**不出现**跳转项（没有目标，点它只会静默 no-op）。菜单项与工具栏按钮走的是**同一个** `refreshSyncPoint('query')` / `revealCommit(id)`，不存在两套语义（独占槽与 toast 也因此自动共用）。
- **`PerforceGraphEditor.keyboard.test.tsx` 用 `toEqual` 钉住了行菜单的完整标签表**：加/删菜单项必须同步改那处断言（否则 `pnpm check` 会在 renderer-dom 里失败，且失败信息只指向该用例）。

### 探针本身（`getHaveChange`）—— 仍在，但降级为「用户要才跑」

- **`HAVE_CHANGE_EXEC` = `{ priority: 'background', timeoutMs: 60_000 }`**：预算只用来兜住真正挂死的 p4。background 不占用并发门给交互读预留的那一槽。**不要**把它挪回 `getChanges` 的 `Promise.all`——那正是第一版「真机永不出现徽章」的原因（5s 预算 vs 40s 成本 = 每次都超时，且失败不缓存 → 每次加载重跑一遍注定超时的查询）。
- **缓存 TTL 独立**：`P4CacheNs.haveChange` = `max(workspaceTtlMs, 5min)`，**刻意比列表长**。`wrap` 返回 `undefined` = 不缓存失败（下次重试）；空答案（该 scope 从未同步）**要**缓存——p4 对「filespec 什么都没匹配到」是 **exit 0 + 零记录**（真机 184ms），不会退化成每次刷新重跑一遍全量查询。
- **`force` 只由查询按钮传 `true`**（走 `P4Cache.invalidate(ns, key)`，不清整个命名空间）；scoped tab 的自动探针传 `false`，吃缓存。**`revalidate()` 一律不 force**——重跑一次的成本是 scope 的规模。
- **红线：探针用的 filespec 必须与列表用的完全同一份**。`resolveGraphScope` 一处解析、两个命令共用。**不要**为探针另建一份（重建 / 换分支写法会让返回的 CL 不在列表里，徽章静默永不显示）：
  - scoped（选区 / 文件 / 合并历史）：`buildSyncFilespecs(scopePaths)`，**同一个数组**喂列表与探针。
  - unscoped：探针 = **同一个 `workspaceScope`**（`<工作区根>/...`）。**不要**窄化成 client root：工作区是 client 子目录时，client 级同步点可能由 scope 外的文件产生，会**高报**（把没同步的行标成已同步）。
  - `wholeRepo`：列表是 `//...`，而 **`//...` 不能带任何修订说明符**（真机报 `Path 'E:/...' is not under client's root`），故探针改用 client root 通配符 `buildScopeFilespec(target.root, true)` + `#have`。carve-out 成立的理由：have 修订只存在于视图映射到该 root 的文件，它们是 `//...` 列表的子集，答案不会命名列表外的 CL。

### 图谱内 get 之后的重读

- **成功 sync 会 `invalidateWorkspace()`**；图谱自己发起的 get（右键 Get This Revision / Get Latest Revision / Force Get、目录选择对话框）在命令 resolve 后显式 `revalidate()`（`getThenRevalidate`）——plain get 不改 `p4 opened`，SCM observable 驱动的自动刷新**不保证**触发。revalidate 落地后读**账本**（不是服务端），此时扩展已在 sync 命令 resolve 前把新记录写进盘。
- **这 5 个入口各有一条 renderer 单测**（`PerforceGraphEditor re-reads after a get` 表驱动，逐个断言 `getSyncPoint` 被读第二次；scoped 分支另外断言探针也重跑一次）；**不要**指望 e2e 守它——SCM 自动刷新那条路也会投递一次 reload，把 `.then(revalidate)` 改成 no-op 后 e2e 照样绿（已实测）。



tooltip（`syncPointTooltip`）**先讲来源再讲结论**，因为「记账」与「查询」对「什么没被反映」的含义根本不同：
- 查询所得：`Answered by Perforce at <time>`（此后新增的改动未同步）；
- 记账所得：`Recorded at <time>, when this editor pulled that changelist`，并**明说编辑器之外的同步不被反映**，要新答案请按查询按钮；
- 外加 `widerScope` / `partial` 两条上界说明。

**旧的「在编辑器之外的同步同样算数」不再成立**——旧实现查的是真 have 表所以成立，现在账本只知道编辑器内发起的 get。用户文档（`docs/user/zh-CN/perforce/perforce-graph.md`）必须同步改口径。

### 已知限制

- 账本**只知道编辑器内发起的同步**；外部 `p4 sync` 要按查询按钮才看得见（这正是按钮存在的理由）。
- 标签页关掉再开**不丢**：账本在扩展侧、`view.syncPoint` 也跟着 `result` 一起持久化。
- 换 scope / 关页签**不取消**在飞的探针（收益只是早释放一个后台槽）。
- **长同步的 `#head` 回读会读到中途提交**：`readGraphSyncPoint(scopes, '#head')` 问的是「同步这一刻的 head」，若同步跑了几分钟且期间有人提交，回读拿到的可能是**同步期间**提交的 CL——账本因此高报一点点。不修正的理由：真正的落点只有逐个文件 `fstat` 才知道（成本＝scope 规模，正是本功能要躲的开销），而高报一条是新提交、下一次同步就会真正拉下来。
- **自动探针的答复时间戳最多偏 5 分钟**：scoped tab 的自动探针吃缓存（见上「查询覆盖记账」），它显示在徽章 tooltip 上的 `Answered by Perforce at …` 说的是**这次派发**的时刻，而答复可能来自最多 5 分钟前的一次真实查询。账本不受影响（自动探针不记账），徽章本身的值也不会因此变错——只是那句时间不如它听起来那么精确。
- 记账上限 200 条、按 scope 去重；同一 scope 反复 get 只留最新一条。

## 与 Git Graph 的复用点（别重造轮子）

Perforce Graph 大量复用 git graph 的成熟部件——加功能前先看能不能复用：

- **`services/gitGraph/graphLayout.ts` `computeGraphLayout`**：泳道布局引擎，单泳道也用它（parents 用 `visible[i+1]` 串成一条链）。
- **`services/gitGraph/fileTree.ts` `buildFileTree<T extends {status,path}>`**：已泛型化（原本绑 `GitGraphFileChangeDto`），p4 传自己的 `P4GraphFileChangeDto`。改文件树逻辑要**同时顾及 git/p4 两个调用点**。
- **`workbench/gitGraph/GitGraphContextMenu`**：右键菜单组件直接复用。
- **`workbench/gitGraph/GitGraphEditor.module.css`**：`import styles from '../gitGraph/GitGraphEditor.module.css'`——**共用一份样式**，改样式波及两个编辑器。
- **`SendCommitToAgentChatAction`**：右键"发送到 Agent Chat"复用它，传 `{ hash: id, message }`。

单泳道差异集中在 `PerforceGraphEditor.tsx`：`PENDING_ID = '*'`（顶部待定变更节点，对应 git 未提交节点）、单选而非多选、`PALETTE` 单色。

## 编辑器注册三件套（所有内置编辑器都一样）

新做/改图谱编辑器必改三处，缺一不显示：

1. `contributions/BuiltInEditorProvidersContribution.ts` —— `EditorRegistry.registerEditorProvider({ typeId, componentKey, deserialize })`
2. `workbench/editor/EditorArea.tsx` —— `editorComponentMap.set('perforceGraph', PerforceGraphEditor)`
3. `services/editor/PerforceGraphEditorInput.ts` —— `EditorInput` 子类，无 scope 时固定 URI `universe:/perforceGraph`；带 `PerforceGraphScope` 时 resource = `universe:/perforceGraph?<query>`（scope 编码进 query → 每个路径一个独立 tab、可序列化恢复），`deserialize` 已带参（见下「文件/文件夹历史」节）

Action2 在 `actions/index.ts` `registerAction2`。

## 文件/文件夹历史（scoped graph，含多选合并历史）

图谱可限定到**一批文件/文件夹**：`perforce-graph.viewFileHistory`（renderer Action2，命令面板 + Explorer 右键 `4_visualize@2` + SCM 文件行 `1_open`）打开带 `PerforceGraphScope { paths: {path,isDirectory}[], label }` 的 `PerforceGraphEditorInput`，历史只列影响**任一** scope 路径的已提交 changelist（并集）。Explorer/SCM 的 `(primary, selection)` 双参约定使多选免费生效（`resolveGraphScopeTargets`），选区为空时回退 primary / 活动编辑器。

- **`getChanges` 的 scope 参数**（`P4GraphLoadOptions`）：`scopePaths?: {path,isDirectory}[]`（单路径就是长度 1，无单独的单路径通道）。存在时忽略 `wholeRepo`——scoped 分支用 `resolveCommonClient(paths, mgr.resolveContaining)`（严格最长前缀、无 active fallback，数据查询语义，镜像 timeline + sync）定位**唯一** client，`buildSyncFilespecs` 展开 filespec；pending 计数经 `openedUnderAnyScope` 过滤（`client.ts getPendingCount`）。跨 client → `showErrorMessage` + 返回 `error:'multiClient'`（renderer 显示专门空态、隐藏计数行，绝不复用「0 changes / 无提交」文案）。
- **多 filespec 一条命令，不要手动分批**：`p4 changes -s submitted -l -m N <f1> <f2> …` 天然回答并集，超长 argv 由 `prepareSpawnArgs` 的 `-x <argfile>`（`MAX_PATH_ARGS_CHARS` 8000）兜底。缓存键必须 `[...scopes].sort()`（`buildSyncFilespecs` 保输入序，不排序则同一选区换点击顺序各缓存一份）；结果过 `dedupeChangesNewestFirst`——一个 CL 命中两个 filespec 会被报两次，而单泳道 parent 链要求 id 唯一且严格降序。
- **`clientRoot` 回程路由**：`P4GraphLoadResult.clientRoot` 带回列表来源 client，renderer 把它回传给 `getChangeDetails` / `openFileDiff`，扩展侧 `graphClientFor(req)` = `mgr.resolveClient({rootUri})` 优先、回退 `graphClient()`。缺了它，scoped tab 的 `describe`/`where` 会打到 ambient client → `localPath` 全 null（合并 tab 的过滤/计数完全依赖 localPath），出现「Get This Revision 成功而侧栏空」的读错写对矛盾。
- **为什么 scoped 分支用 `resolveContaining` 而不是 `graphClient()`**：`graphRoot` 是整图谱共享的可变状态（`perforce-graph.setRepo` 写它），scoped 查询是「按路径定位数据」的只读语义，绝不能读/写它——否则限定到某文件的标签页会污染整图谱视图的选中 client，反之亦然。
- **红线：任何拼进 p4 命令行的路径都必须过 `buildScopeFilespec` / `buildSyncFilespecs` / `escapeFilespecPath`**（`src/p4Filespec.ts`）。`@ # * %` 是 p4 filespec 元字符（revision range / 通配 / 百分号转义引入符），路径里的字面 `@`/`#`/`*`/`%` 会被服务器重新解释、静默改变作用域含义，必须百分号编码（`%` 先转，避免把其它转义引入的 `%` 二次转义）。目录 scope 走 `<dir>/...`（先剥尾斜杠再拼）。
- **展示粒度与查询粒度刻意不一致**：renderer 的 `normalizeGraphScopeSelection` 只去重 + 排序（key 用镜像 `pathUtil.norm` 的 `scopePathKey`——**只小写盘符**；用 `scmProviderPathKey` 会全小写，在大小写敏感主机上把两个真实不同的文件折进同一个 tab），**保留**嵌套在所选目录下的文件：tooltip / `+N` 忠实反映用户选区，而嵌套折叠是 `buildSyncFilespecs` 的职责。别「顺手统一」这两层。
- **scoped UI 差异**：隐藏 Globe（whole-repo 开关）与 client 下拉、不写全局 `setRepo`、不持久化选中行；行右键在「Open Changes」之外新增 Get Revision 对——Get This Revision（`syncToChange` + 全部 `scopePaths`，`graphSyncNeedsConfirm` 只对单文件免确认，目录/多路径弹时间旅行确认）+ Get Latest Revision（直调 `perforce.syncLatest`，多选走 `(primary, selection)` 双参）。目标行 = `result.head` 时带 `isLatest`（免确认，等价 get latest）。**「Open Changes」只在 `paths.length === 1 && !isDirectory` 时出现**（多路径下"打开差异"无唯一目标）。**两类图谱的行菜单末尾都有一个 `danger` 红色的「强制拉取（覆盖本地文件）」**（`Force Get (Overwrite Local Files)`，`id: 'forceGet'`，图标复用 `cloud-download`），发 `syncToChange` + `force: true` 并**刻意不带 `isLatest`/`confirmed`**——带了就等于给 force 开一条静默通道（`PerforceGraphEditor.test.tsx` 用 `toEqual` 精确 payload 断言钉死这点）。view state 按 `input.id` 分桶（有界 LRU cap 12，全局桶永不淘汰），多个历史 tab 各自独立。
- **详情面板过滤只对多选 tab 生效**：`buildChangePayload(details, {scopePaths, clientRoot})` 在 `paths.length > 1` 时按 `scmProviderPathKey` 过滤命中文件并给 subtitle 追加「另有 N 个未选文件」；单文件/单文件夹 tab **不传** `scopePaths`，逐字保持整 CL 行为。零命中显示 0 文件 + 计数，**绝不回退整 CL**（回退会掩盖「历史列表与文件集不一致」的真问题）。payload 缓存键必须含 scope 签名段（`perforce\n<clientRoot>\n<scopeSig>\n<cl>`），否则同一 CL 在不同 scope tab 间串味。

## ⚠️ 头号坑：renderer Action2 命令绝不能进扩展 `commands` 数组

图谱的打开命令（`perforce-graph.view`）**handler 在 renderer 的 Action2**（`ViewPerforceGraphAction`），扩展只把它贡献到 scm/title **菜单**。此命令**绝不能**再写进 `extensions/perforce/package.json` 的 `contributes.commands` 数组。

- **后果**：`contributes.commands` 会在扩展宿主侧注册一个同名、**无 handler** 的命令。执行时该宿主命令胜出、遮蔽 renderer Action2 → `executeCommand` **静默返回 undefined、不抛错、编辑器不打开**，极难排查（命令"成功"却什么都没发生）。
- **正确做法**：只在 `contributes.menus`（scm/title）里写该命令项，菜单项自带 `icon` 即可显示图标；title/tooltip 由 renderer Action2 的 `title` 提供。对照 git 扩展：`git-graph.view` 只出现在 menus，从不在 commands 数组。
- **排查手法**：e2e 探针 `getActiveGroupEditorCount` 对比同结构的 git-graph（count=1 打开）vs perforce-graph（count=0 no-op），秒判是"命令被吞"而非"组件渲染崩"。

（这条通用护栏见 memory `renderer-action-shadowed-by-extension-command-decl`。）

## p4 图谱的数据层红线（-Mj / -ztag / -p）

图谱数据源踩的是 p4 通用坑的子集，完整版见 `../docs/pitfalls.md`，此处只标图谱相关：

- **`-Mj` 是否吐结构化字段因命令 + 服务器版本而异，不能假设"报表型命令都安全"**：某些 P4D 上 `changes` / `describe` / `where` / `info` / `clients` 的 `-Mj` 会塌成单个 `{"data":"..."}` 文本 blob（丢掉全部结构化字段），只有脚本型命令（`fstat` / `opened`）稳定保留字段；`-ztag` 对所有命令都正常。塌陷现象是"命令 `exit 0`、手动执行有输出，但图谱空"——`parseChangesList` 读 `record['change']` 拿不到值，`if (!id) continue` 全部跳过。
- **报表型 p4 命令统一走 `P4Service.execRecords()`，不要用 `execJson`**：它先跑 `-Mj`，用 `isCollapsed()`（所有记录都只含 `data` 键）检测塌陷，命中则自动回退 `-ztag` 并用 `parseZtagAsMarshal` 规整成与 `-Mj` 同构的扁平记录（保留 `depotFile0/1` 扁平键、聚合多行 desc、按"键重现"切分记录）——parser 零改，正常服务器零额外开销。图谱的 `changes` / `describe -s` / `opened` / `where` 均应走这条路径。
- **`describe`（带 diff，无 `-s`）和 `annotate` 的 `-Mj` 必塌 blob**——图谱**不碰这俩**（文件 diff 走 `p4 print -q` 取两个 revision 的原文，本地在 renderer 做 diff）。
- **诊断"exit 0 但无数据"**：先在真实服务器 `p4 -Mj <cmd>` 对比 `p4 -ztag <cmd>`，看前者是否塌成 `{"data":...}`；若给图谱加新的报表型/多字段命令，同样先做这个验证。
- **连接 `-p` 绝不从 `p4 info` 的 `serverAddress` 推**（那是服务器内部 bind 地址，代理后端不可路由）；只在 `perforce.port` 显式设置才传 `-p`，否则让 p4 按 cwd 自解析 P4CONFIG。

## 密钥红线（照搬 p4 集成，重申）

密码/ticket 绝不进明文 settings/aiSettings/wire；所有 p4 spawn 走 `P4Service`（array args、`shell:false`、env denylist 剥 `ELECTRON_*`/`NODE_OPTIONS`）；**stdout 是 RPC 通道，绝不写调试**（用 `log`→Perforce 输出频道 / `console.error`）。

## 测试套路

- **纯解析器单测**：`p4GraphParser.ts` 的每个函数对 fixture 断言（`extensions/perforce/src/__tests__/p4GraphParser.test.ts`）。新增解析逻辑先写纯函数 + 单测，client 只做编排。
- **账本单测**：`extensions/perforce/src/__tests__/graphSyncLedger.test.ts`——包含关系（`X:/ws/a` 不含 `X:/ws/ab`）、文件 vs 目录 scope 不同身份、**更窄的记录绝不回答更宽的问题**、**按时间取而非按深度取**、跨 client 隔离、盘上往返 / 跨窗口合并 / 损坏文件 / 上限淘汰。
- **renderer 单测**：`workbench/perforceGraph/__tests__/PerforceGraphEditor.test.tsx`，mock `ICommandService` 返回假 DTO，断言渲染/展开详情/待定节点 + 同步点四条竞态（切 scope 丢弃过期答案 / 两次查询乱序 / 失败保留 / **查询不被落地的 load 丢掉**）+ 查询反馈（`data-querying` / 秒表 `data-done`）+ 行菜单两项（未知同步点时**没有**跳转项）。秒表与菜单的断言都靠 `renderWithDeferredSyncPoints` 把答复交给测试来结——答复自己 resolve 的 mock 观测不到在飞窗口。
- **e2e 冒烟**：`extensions/perforce/e2e/specs/perforceGraph.spec.ts`（`@p1`）——`perforce-graph.view` 是 renderer Action2，无 p4 服务器也能开（显示 unavailable 态），断言 `[data-testid="perforceGraph-editor"]` 可见。

### e2e 两个必踩坑

1. **e2e 跑 `out/main/index.js` 预构建产物**：改 renderer 后必须 `pnpm --filter @universe-editor/editor build`，改扩展后 `pnpm --filter @universe-editor/perforce build`，否则 e2e 用旧产物。
2. **`getByText('Perforce Graph')` 子串匹配**会同时命中标题 span 和 "Perforce Graph is unavailable…" 错误文案 → strict-mode violation。断言标题用 `{ exact: true }`。

## 验证

```bash
## 改了 extensions-common 后先重建（pnpm dev 下 watcher 自动）
pnpm --filter @universe-editor/extensions-common build
pnpm --filter @universe-editor/perforce build
pnpm --filter @universe-editor/editor build   # e2e 前必做

pnpm check   # lint + typecheck + 全量单测 + docs:check
pnpm --filter @universe-editor/editor exec playwright test -c e2e/playwright.config.ts specs/smoke.perforceGraph.spec.ts
```

改了用户可见文案/交互，同步 `docs/user/zh-CN/perforce/perforce-graph.md`（`pnpm docs:check` 校验内链）。

## 关键参考路径

- `packages/extensions-common/src/contracts/perforceGraph.ts` —— wire 类型 + 命令常量
- `extensions/perforce/src/p4GraphParser.ts`（+ `__tests__/`）—— 纯解析
- `extensions/perforce/src/client.ts` —— 图谱数据源方法（搜 `getGraphChanges`）
- `extensions/perforce/src/extension.ts` —— `perforce-graph.*` 命令注册（搜 `graphClient`）
- `extensions/perforce/package.json` —— **只有 menus 项**，无 commands 项（头号坑）
- `apps/editor/src/renderer/workbench/perforceGraph/PerforceGraphEditor.tsx` —— 主编辑器
- `apps/editor/src/renderer/services/perforceGraph/perforceGraphViewState.ts` —— view-state 单例
- `apps/editor/src/renderer/actions/perforceGraphActions.ts` —— 两个 Action2
- `apps/editor/src/renderer/services/gitGraph/{graphLayout,fileTree}.ts` —— 复用的布局/文件树
- `extensions/perforce/e2e/specs/perforceGraph.spec.ts` —— e2e 冒烟
- `extensions/perforce/e2e/specs/perforceGraph{FileHistory,FolderHistorySync,HistoryMultiSelect}.spec.ts` —— scoped 历史三条回归（单文件 / 目录 get / 多选并集 + 双路径 get；fake-p4 的 `changes` case 吃全部 filespec 并回答并集）
- `extensions/perforce/e2e/specs/perforceGraphHave.spec.ts` —— 同步点三条回归（**打开时不查**、按查询按钮才给出 `#4521`、点工具栏那句跳回该行 / 图谱内 get 后徽章靠**记账**前移、全程零查询 / **打开的是 client 子目录时**，文件夹 scope 答 4521、切到整仓库 scope 必须先回到「未知」再由自己的查询答 4522——第三条刻意让两个 scope 的答案不同，否则断言在点击前后都成立、等于假绿；fake-p4 的 `changes` case 认 `#have` 后缀（按**同一个文件**同时过 scope 与 per-file haveRev，seed 用 `SeedFile.haveRev` 把 have 停在中间版本）以及 `<spec>@<cl>` 后缀（sync 后的落点回读按 CL 收窄），两者都必须在**按 scope 过滤之前**剥掉后缀）

## 其它

- 图谱仍**以只读浏览为主**：提交/签出等写操作在 SCM 侧栏（见 `../CLAUDE.md`）。唯一的例外是右键 "Get This Revision / Get Revision… / Force Get (Overwrite Local Files)"（`syncToChange`，见命令清单）——前两者只把工作区 have 版本移动到所选 CL，depot 仍只读；**Force Get 额外销毁目标 scope 内的本地未收集改动**（`p4 sync -f`，确认后执行，见 `../docs/pitfalls.md` 的 `-f` 逃生阀节）。右键其余项是"复制变更号/复制提交信息/发送到 Agent Chat"。
- 加分页/加载更多：`P4GraphLoadResult.moreAvailable` + `PERFORCE_GRAPH_PAGE_SIZE`，`getGraphChanges` 跑 `-m <max+1>` 探测是否还有更多。
