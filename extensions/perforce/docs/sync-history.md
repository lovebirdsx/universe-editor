# Perforce Sync History（拉取历史）

宿主里的一个虚拟编辑器标签页（URI `universe:/perforceSyncHistory`）：把**每一次拉取**渲染成一条记录——耗时、六类文件计数、进程读写字节、磁盘写入事件数、**p4 调用次数（原生 / δ 两个来源）**、引擎 / 目标修订 / force / 并行线程、范围与触发入口。数据全部来自扩展写在本地的一份 JSON，宿主经两个只读命令取 DTO，**这条链上一个 p4 都不用跑**。

> 先读 `../CLAUDE.md`。本文只讲拉取历史特有的东西：与图谱账本的分工（为何不能合并）、`facts` 快照的时机、两个记录点、触发入口表与测试地图。

## 三层技术栈（自底向上）

| 层             | 文件                                                                                                                                                                            | 职责                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| wire 类型      | `packages/extensions-common/src/contracts/perforceSyncHistory.ts`                                                                                                               | `P4SyncRunDto` / `P4SyncRunDetailDto`（多了完整 scope）/ `P4SyncHistoryLoadOptions` / `P4SyncHistoryLoadResult` + `PerforceSyncHistoryCommands`（`getRuns` / `getRun`）。改动要 bump 时先 `pnpm --filter @universe-editor/extensions-common build`                                                                                                           |
| 数据层         | `extensions/perforce/src/syncHistory.ts`                                                                                                                                        | 纯函数 `outcomeOfRun` / `syncNothingHappened`（**与 toast 分支共用一份**）/ `buildSyncHistoryEntry` / `isEntry` / `toRunDto` / `toRunDetailDto`；每次 run 一个的 `SyncP4CallCounter`（见下）；持久化类 `SyncHistoryLog`（`<globalStoragePath>/syncHistory.json`，per-process tmp + rename 原子写，mtime+size stamp 跨窗口重载，整段 best-effort）            |
| 事实来源       | `extensions/perforce/src/client.ts`                                                                                                                                             | `SyncRunResult.facts`（引擎 / 线程 / `startedAt` / `io` / `diskWrites` / `p4Calls`）+ `_withSyncFacts`。δ 与原生两条路都经它装饰；**编辑器自己预检拒绝的 run（`notRun`）不贴 facts**（见下）                                                                                                                                                                 |
| 记录点         | `extensions/perforce/src/extension.ts`                                                                                                                                          | `recordSyncHistory` helper + **两个**落账点（见下）+ 落账后的 host→renderer poke（见「落账即推送」）+ `perforce-sync-history.getRuns/getRun` 两个只读命令                                                                                                                                                                                                                                                     |
| 宿主页         | `apps/editor/src/renderer/workbench/perforceSyncHistory/`                                                                                                                       | `PerforceSyncHistoryEditor.tsx`（列表 + 详情，中间 `Sash` 可拖、宽度持久化；`loadSeq` 守卫与 `state.limit` 派发即写） + `syncHistoryFormat.ts`（纯格式化，**镜像**扩展侧的字节格式化，绝不 import 扩展代码；`p4CallsLabel`/`p4CallsRowLabel` 管调用数的三态、`p4CommandBreakdown` 管分类的下界）+ `syncHistoryCsv.ts`（导出用的 CSV 渲染：表头 = DTO 字段名，缺项留空而非 0；调用数拆成 `p4Calls.total/.native/.p4delta/.complete` 四列，分类拆成 `.p4deltaByCommand/.p4deltaByCommandComplete` 两列） |
| 输入/状态/动作 | `apps/editor/src/renderer/services/editor/PerforceSyncHistoryEditorInput.ts` · `services/perforceSyncHistory/syncHistoryViewState.ts` · `actions/perforceSyncHistoryActions.ts` | EditorInput（常量 URI 单例）· **单桶** module-level view-state（不像 graph 那样按 input id 分桶——这个 tab 只有一个实例；拖过的列表宽度也在其中，storage 侧是 `perforceSyncHistory.listWidth`）· 三个 Action2：`perforce-sync-history.view`、`perforce-sync-history.exportCsv`（重新拉**全量**再经保存对话框写文件，不改页面状态）、poke 入口 `_workbench.perforceSyncHistoryRecorded`（与 `stale`/`noteSyncHistoryRecorded` 的防抖同住 view-state） |

宿主侧只经 `ICommandService` 调 `PerforceSyncHistoryCommands.*`；扩展侧对这些 id 写字面量（`import type` 契约，运行时擦除），与 `perforce-graph.*` 同一套纪律。

## 与图谱账本（`graphSyncLedger`）的分工——为何不能合并

两个文件并列放在 `globalStoragePath` 下、互不读写，语义**刻意不同**：

|       | 账本（graphSyncLedger）                               | 历史（syncHistory）                                     |
| ----- | ----------------------------------------------------- | ------------------------------------------------------- |
| 语义  | 每范围的**最新同步位置**，`contradictedBy` 退休旧记录 | 每次 run 一条**事件流，永不去重**                       |
| 身份  | `(clientRoot, scope)`，内容被后来的记录覆盖           | `id`（`at`-pid-seq），scope 只是内容                    |
| scope | 必须**完整**（身份依赖它）                            | 可截断（`MAX_SCOPE_PATHS=64` + `scopeOmitted`），仅展示 |
| 覆盖  | 只记能表达为 claim 的**成功** run                     | 取消 / 失败 / 无法识别 / **被门拒绝**也各一条           |

**为什么不能只留一个**：账本回答「这个范围现在停在哪」，历史回答「昨天那次为什么这么慢」。把失败也塞进账本会让徽章逻辑面对一堆无法表达为 claim 的行；把去重逻辑搬进历史则会抹掉恰恰最想要的那几条（失败与取消）。图谱徽章的读法见 `docs/graph.md`。

## `facts` 快照必须早于 `_endExternalSuspend`（本功能最容易写错的一处）

`sync()` 的结构是「`_withBusy(...)` 里跑引擎 → `_withSyncFacts(run, ...)` → `finally { _endExternalSuspend(); _clearSyncProgress() }`」。快照**必须在 finally 之前**：`_endExternalSuspend` 会 `_stopSyncIoProbes`，把 `_syncIoReadBytes/_syncIoWriteBytes` 清零——晚一步就永远读到「无采样器」。`clientSyncFacts.test.ts` 有一条专项断言守着它（`run 结束后 facts.io 仍非空`）。

run 的时钟（`facts.startedAt`）在 `await this._noteSyncPreviewDrift(...)` **之后**取：那条「预览的范围已经变了」的提示属于 run 之前的插曲，用户盯着它读多久都不该进耗时。

`_withSyncFacts` 对 `notRun: true` 的 run **原样返回**：预检拒绝一个 p4 都没起，`engine: 'p4'` 会指认一个不存在的进程，`parallelThreads` 是个无所约束的旋钮，io / diskWrites 是共享计数器的残值。facts 缺席才是唯一真话。

另外三条已知近似（同样写在 `client.ts` 的 JSDoc 里，用户文档已声明）：

- **采样周期 1s**：末尾不足一秒的部分可能漏计；`_syncIoSampled` 只在采样器**真的报过数**时为真，所以「1 秒内跑完的 get」记的是**无采样**而不是 0 B。
- **重叠 sync 共享计数器**：io 与 `diskWrites` 是该 client 的全局累计，两次重叠的 run 各自记到的都是**两跑之和**（与状态栏速率同口径）。
- **`'transient'` 采样失败会丢弃已采字节** → 该 run 记为无采样。

## p4 调用次数（`p4Calls`）：口径、三态与「为什么是下界」

`facts.p4Calls = { native, p4delta, complete }`，即**这一次 get 起了多少个 p4 client 进程**（`SyncP4CallCounter`，每次 run 一个，绝不共享——重叠的两次 get 各记各的，也不会把 runs 之间的后台命令算进来）。

**口径 = client 命令进程的启动次数**，不是服务器日志行数：

- **原生**：`_syncViaP4` 那次 `p4 sync` 的 `onSpawn` 回调 +1。**spawn 失败 / ENOENT 不计**（一个字节的请求都没发出去），排队取消但进程已起**计**（进程真实存在过），命令本身退出非零**也计**（往返与进程开销都发生了）。原生这一半**永远精确**（`complete` 不被它改写）。
- **δ**：δ 自己上报。`--json` 流先发一条 `{kind:'p4CommandCount',count:0}`，此后每**成功启动**一个原生 p4（字符集 `p4 set`、client / fstat / have / sync…）再发一条自增事件；summary 的 `p4Calls` 是最终累计数。消费方 `readP4deltaCallCount` 对事件取 **max** 作总数，并**按 `count` 值去重**计已知事件（并发下事件可能乱序抵达，`count` 大的先到；拿 `count <= observed` 过滤会丢掉合法事件）。**只按流里真实出现的调用累计，绝不把每次 δ 调用当成 1 次**。
- **不统计 δ 进程自身**，也不统计 p4 内部再发的子请求（服务端往返、p4 自己 fork 的东西）——那些从外面数不出来，报一个估出来的数比不报更糟。
- **失败回退两半相加**：δ 起了几个进程后死掉、本轮转原生兜底，两段都留在同一个计数器里（丢掉前一段就是谎报更便宜的一次 run）。
- **取消是下界**：`cancelBusy` 杀在半途时，δ 侧只能给出已经观测到的数。

**三态由 `complete` 承载**（`SyncP4CallCounter.noteDelta`）：δ **从未 spawn** → 不改写 `complete`（原生那一半仍是确数，不是「未知」）；δ spawn 了但 summary 缺席 / 非法 / 报的值**小于**已观测值 → 保留观测下界并置 `complete=false`。**统计绝不参与操作成败或回退判定**——它只是 facts 的一个字段。

**分类的完整性是独立的一维**（`p4deltaByCommandComplete`），**不与 `complete` 绑定**：总数是确数不代表分类也是确数——老引擎可能只发总数（分类退回事件流那一份），此时 `complete: true` 而 `p4deltaByCommandComplete: false`（下界）。反过来，`complete: false` 时分类也必是下界。两列分开说，UI / CSV 才既不夸大完备、也不把下界读成确数。

**老记录 = 「未采集」**：DTO 里 `p4Calls` 是可选的，早于该字段的记录**没有这一组**，UI 必须显示「未采集（此记录早于该字段）」，**绝不当成 0**；`complete=false` 且总数为 0 时显示「未完整采集」，同样**绝不显示成总数 0**。CSV 把这几点拆成 `p4Calls.total` / `.native` / `.p4delta` / `.complete` 四列，另有 `p4Calls.p4deltaByCommand` 与 `p4Calls.p4deltaByCommandComplete` 两列说分类：缺字段留空、总数照写、完整性各占一列。`isEntry` 对畸形组（负 / 小数 / 非安全整数 / 形状不对 / 非布尔的完整性标志）**丢弃整条**。

**δ 侧只有源码改了**：外部 `p4delta` 必须**重新构建并安装**才会上报；老版本 δ 不发 `p4CommandCount` / summary 无 `p4Calls` → `complete=false`，UI 说未完整采集。**没有版本门探测**——不识别的字段天然就是「未上报」。

**排查未完整采集**：先核对 Perforce 输出中的实际引擎路径与来源。托管副本优先于 PATH / 系统安装目录，但显式环境变量或配置路径仍可覆盖它（见 [`../src/p4delta/CLAUDE.md`](../src/p4delta/CLAUDE.md)）。无论来源如何，实际运行的 δ 必须支持计数并给出合法的最终计数；旧引擎、进程中断或输出异常都可能导致 `complete=false`，不代表拉取失败。更新引擎只能改善后续操作的采集；已写入的历史不会补齐。

## 分类账 `p4deltaByCommand`：这 N 次调用花在哪

两个来源都是引擎**已有的输出**：

- `p4CommandCount` 事件的 `command` 字段（每次真实 spawn 一条；`count` 只用来定位总数，分类按事件条数累计）；
- summary 的 `p4CallsByCommand`。

**谁给出可信的总数，分类就跟谁走**（`SyncP4CallCounter.noteDelta`）：summary 可信 → 用 `reportedByCommand`；summary 缺席 / 报的值落后 / **分类没通过验证** → 用事件流上**已观测**的那份，并明确说成下界（取消、崩溃之后「这 37 次是什么」照样答得出来）。**总数与分类各有一个完整性标志**：`complete` 管总数，`p4deltaByCommandComplete` 管分类——只有一份**通过验证**的 summary 分类才算完整账，**绝不因为「总数完整」就把分类也冒充成完整**。**两边都没有 = 未采集**——老引擎不发分类、或这一跑一个 `command` 事件都没有，这与「0 次」是两码事，所以字段可选、缺席时 CSV 留空、详情说「未采集（该引擎不报告按命令的分类）」。

**受控键与自洽校验**（`readCommandTally` / `verifiesCommandTally`）：契约的固定枚举 `set / have / fstat / opened / ignores / add / edit / delete / revert / where / sync / reconcile / clean / info / client`。白名单之外的键（未来新增类别、伪造键）与非法值（负 / 小数 / 非安全整数）一律丢弃，**坏事件整条丢弃**（`count` 非法时它的 `command` 同样不可信）。summary 的分类还要**自洽**才算可信：各项之和恰好等于 `p4Calls`、每一类都不大于总数、且不小于事件流已观测到的次数——任一不成立（例如某类大于总数、或 summary 漏掉了真实发生过的 spawn）都退回事件流那一份，绝不冒称完整。

CSV 写成 `command=count; command=count`（次数降序，同数按命令名），显示层写成 `sync 740 · ignores 332`；紧跟的 `p4Calls.p4deltaByCommandComplete` 列说这份分类是完整账还是下界（与 `p4Calls.complete` 分开）。**命令名不翻译**：它们就是命令行上的那些词，译名会让这一行对不上 p4delta 日志与脚本。

**本批不做的**：不正则解析人类日志，不根据稀疏 progress 推精确阶段耗时（Rust 尚未提供阶段耗时事件）。引擎已有的 `elapsedMs` / `counts` 照常展示。

## δ 运行引用 `deltaRunId` 与两条日志出口

`deltaRunId` 是这次 get 的 δ **运行引用**（`p4d-<ms>-<pid>-<seq>-<rand>`），在 `P4deltaService._spawn` 里按「一次真实尝试」生成——引擎没启动就没有它。它随结果带回，落在**本次 sync 的** `SyncP4CallCounter` 上（每次 run 一个实例，绝不放在 client 字段上：并发的两次 get 会串账），再由 `_withSyncFacts` 落到记录与 DTO。**取消、失败、无 summary、δ 后转原生都保留它**（日志在盘上，那一跑真的发生了）；纯原生的一次 get 没有它——**回退不虚构第二次 δ run**。

δ 的输出分两条：

- **`P4delta` 输出频道**（`extension.ts`，与 `Perforce` 频道并列）：一次运行的实时诊断，逐行带「接收时间（本地 ISO + 时区）+ 相对运行的单调耗时 + runId」。**Perforce 频道只留开始 / 结束摘要与 runId**——`client.ts` 原先四处「运行结束后把 stderr 全量回放」已删除，否则一段几千行的报告会挤在同一个时间戳下、把 p4 自己的账埋掉。
- **落盘**：`<globalStoragePath>/p4delta-logs/<runId>.log`，由 `p4delta/p4deltaRunLog.ts` 写（纯 Node、注入式、目录之外不 import 宿主能力）。默认单文件 10 MiB、单运行队列 1 MiB、保留 7 天 / 200 个 / 总量 100 MiB；截断与丢行都留标记，终态行与 **summary 摘要页脚**都走尾部预留（正文被截断也写得进去）。运行中写 `.log.writing`，收尾改成 `.log`——**另一个窗口正在写的 `.writing` 不会被清理**，只有超过保守期限的才当崩溃遗留收掉。

`P4deltaService` 在内存里另留一份 `result.log` 供失败详情 / 拒绝行解析读，它是**有界尾部**（最后 200 行且 <= 128 KiB）：逐行诊断照旧实时送频道与落盘，砍的只是内存里那份事后回读。summary 记录除实时进频道外，还被压成一行**有界**的命令统计摘要（`P4deltaRunEnd.summary`，只摘 mode / ok / counts / elapsedMs / p4Calls / p4CallsByCommand，<= 8 KiB），收尾时作为页脚写出——**不是 summary 的复读**，只为在正文被截断后仍留得住「这 N 次调用花在哪」。

**打开日志**：详情里的「打开 p4delta 日志」、命令面板的「显示 P4delta 输出」/「打开最近一次 p4delta 日志」。页面只递**历史 id**，`perforce-sync-history.openLog` 从那条记录自己身上取 runId，再从固定目录读有界快照（目录前缀校验 + 拒绝符号链接），经 `workspace.openTextDocument({content})` 打开成 untitled 文档——远程开发时日志在执行扩展的 host 上，把远端 file URI 交给 UI 只会得到一个打不开的标签页。记录**没有**可用的 δ 引用时（没有这条历史、记录早于该字段、或这一跑真没走 δ）只回答**中性**的一句「找不到关联的运行」——三种情形只有最后一种能说「没走 δ」，措辞区分不了就不该断言；而且**绝不退化成「打开最近一份」**（那是别人的日志）；日志已被保留策略清掉时明说，不打开空文档。命令面板那条按 **mtime** 取最近的一次运行（`P4deltaRunLog.list`），**已结束与仍在写的混排**：一次刚起、还在写的运行就是最近的那一次，把它压到已结束的后面就会打开上一次的日志。

**路径、argv 等仍可能包含敏感信息**（工作区路径、depot 路径），日志只留在本机 / 远端 host 的存储目录里，**编辑器不上传**；运行头不写环境变量、不探测引擎版本。

## 两个记录点（都在 `extension.ts` 的 `runSync` 收尾处）

1. **落账点 A**：`const res = await window.withProgress(...)` 之后、`if (res.cancelled) return` **之前**。此刻 applied / upToDate / unrecognized / failed / cancelled 全部已定，而**任何 toast 与补救对话框都还没 await**——所以 `durationMs` 量的是拉取本身，不是你盯着弹窗读了多久。失败与取消也因此各留一条。
2. **落账点 B**：范围门 `if (!decision.ok) return` 之前，记一条 `outcome:'declined'`（p4 一行没跑，所以没有 `facts`）。

**`declined` 有两个来源**（落账点 B 的门拒绝，以及客户端预检拒绝 `SyncRunResult.notRun`），两者都满足「这次 get 没有执行」，所以不新增第 7 种结果值——原因由「错误」一行给出：`notRun` 时客户端把**真正的拒绝理由**放进 `error.suggestion`（`kind: 'other'`，不触发命令层的 clobber 补救——那条重试只会被同样拒绝一次），范围门那条则由门自己的提示说明。`buildSyncHistoryEntry` 对 `declined` 一律记 **`startedAt = at`、`durationMs = 0`、不落 facts**：这个 0 是结构性的，不是量出来的——否则它会量到用户读拒绝弹窗的时间，或者 `at` 与调用点之间的同毫秒偏差。

命令层在 `if (res.cancelled) return` 之后紧跟一条 `if (res.notRun === true) return`：客户端已经用 `perforce.sync.scopeRefused` 说过原因了，再走一遍失败分支只会把同一句话挂在「Get revision failed」的标题下重播。

`recordSyncHistory` **不 await**（`record()` 是同步 fs：正常几十 KB 的账本约 1ms，最坏（200 条 × 64 路径）几十毫秒；每次 get 一次，且已经在进度 UI 之后），且整段 try/catch：历史写失败绝不冒泡——这条路径在红线 4（`_spawn` 回调不得 throw）的射程内。

## 落账即推送（页面自动刷新）

页面不再靠用户点 Refresh 才看到新记录。`recordSyncHistory` 落账后发一次 **host → renderer poke**：`commands.executeCommand('_workbench.perforceSyncHistoryRecorded')`（常量 `SYNC_HISTORY_RECORDED_COMMAND` 在 `extension.ts`），渲染侧由同名 Action2 接住，转给 `syncHistoryViewState.ts` 的 `noteSyncHistoryRecorded()`。

- **fire-and-forget，且没有 ack 看门狗**：swarm 的 `SwarmNotificationPoller` 需要看门狗是因为它有一条**不能被堵住的定时器**（一次 await 把之后所有 tick 静默卡死）；这里没有周期、没有后续 tick、没有「缺行」这种可观测缺口——poke 丢了就丢了下一次 get 再发，最坏是这一次刷新没发生。poke 的 rejection 与同步 throw 都在扩展侧吞掉并写一行 Perforce output（该路径在红线 4 射程内）。
- **落点在 helper 内，不挑调用点**：`history.record` 全仓只有 `recordSyncHistory` 一处调用，两个记录点（门拒绝与 run 收尾）自动都覆盖，`declined` 也 poke——「点了 get 什么都没发生」正是列表陈旧时最该看得见的一条。
- **poke 不带参数**：「有新东西」就是全部消息，页面整页重读（0 次 p4 调用），带 id 只会引出「哪一条」这种没人要回答的问题。
- **渲染侧两分支**：页面已挂载 → 置 `stale` 后进 **250ms 合并窗口**静默重载（窗口锚定在第一次 poke，不被后续 poke 推后；隔着对话框的第二次 get 落在窗口之外，会再刷一次——那是第二件发生的事）；未挂载（该 tab 不是活动编辑器）→ 只置 `stale`，下次挂载读一次。`stale` **在 poke 那一刻同步置位**，所以「计时器触发前 tab 被切走」这种丢失也有兜底；**重载失败时 `stale` 保持**（记录仍未看见，下次挂载再试）。
- **没有轮询、没有配置开关**：读记录是本地文件读（`_reloadIfChanged` 的 mtime+size 指纹），零 p4 调用、不占并发门，所以不需要像 `perforce.refreshInterval` 那样给用户一个「大 depot 就关掉」的旋钮。
- **跨窗口缺口**：历史文件在多窗口间共享，但每个窗口跑自己的扩展宿主，**别的窗口的 get 不会 poke 本窗口**（那些要手动 Refresh）。这是「不做轮询」的既定代价，用户文档已声明。
- **poke id 绝不进 `package.json` 的 `contributes.commands`**：声明即遮蔽 renderer 的同名 Action2 且 `executeCommand` 静默解析成 `undefined`（`../src/swarm/CLAUDE.md` 第 13 条）。`extensionSyncHistory.test.ts` 有一条读 manifest 的守卫。

页面侧另有两处为自动刷新引入的纪律：`load()` 的 **`loadSeq` 守卫**（一次 load 可以比发起它的挂载活得久，只有最后派发的那次允许写状态）与 **`state.limit` 在派发时写**（否则 poke 触发的重载会读到用户点「加载更多」之前的页大小，把翻页顶回 50 条）。

## 触发入口表（`options.trigger` 必填）

| 调用点                                                        | 值                                               |
| ------------------------------------------------------------- | ------------------------------------------------ |
| Timeline runner（`perforce.timeline.getThisRevision`）        | `timeline`                                       |
| `perforce.syncLatest` / `perforce.sync` 带 resource/selection | `explorer`                                       |
| 同上的**无参**分支（命令面板）                                | `command`                                        |
| `perforce-graph.syncToChange`                                 | `graph`                                          |
| 状态栏修订标记 chip                                           | `statusBar`                                      |
| 内部补救（clobber 后的强制重试、逐文件 force 重试）           | `recovery`（放在 spread **之后**覆盖调用方的值） |

`trigger` 必填的理由同 `ledgerScope`：每个入口自报家门，否则那一列就是谎言。判定只看**实参**：`syncLatestFor` 用 `resourcePath(args[0])` 判「调用方点名了资源吗」，点名才是 `explorer`，无参（状态栏 chip、命令面板）一律用调用方传入的 `trigger`。**活动文件回落只影响 scope、不影响 trigger**——`resolveTargetPath` 在没有资源参数时会回落到 `_workbench.getActiveEditorFile`，若拿「是否解析出路径」当判据，任何有活动文件的无参调用都会被记成资源管理器点击。**状态栏 chip 是唯一需要额外接线的入口**——`StatusBarItem.command` 是 `string | undefined`、**没有传参通道**，所以新增了一个运行时命令 `perforce.syncLatestFromStatusBar`（**不进 `contributes.commands`**，照 `perforce.cancelBusy` 先例）；`perforce.syncLatest` 的函数体提成局部 `syncLatestFor(args, trigger)`，两个 id 各自转发。

## 契约与降级的三条硬要求

`getRuns` 只按 `max` / `root` 取一页，**没有游标**：宿主「Load more」就是抬高 `max` 重读全量，在 200 条上限下这比排他时间戳游标更稳（`at` 是 `Date.now()`，同一毫秒的两条记录会让 `at < cursor` 的切口永久漏掉一条）。两个命令是**纯文件读、零 p4 调用**（不碰并发门），参数逐字段窄化、不信任渲染侧。

`getRun` 的「没有」用 **`null`**，`undefined` 只留给**命令根本不在**（宿主对未注册 id 解析出 `undefined`，扩展只有激活过各道门才会注册这些命令）。两者在宿主眼里曾经同形，于是「这个安装里没有 perforce 扩展」被渲染成「这条记录已被淘汰」——一块面板说扩展不可用、另一块断言记录被顶掉，自相矛盾。宿主详情面板因此是三态：`undefined` → 扩展不可用、`null` → 已不在历史中、其余正常渲染，`catch` 一律按不可用。

页面对三件事必须如实说，而不是编一个好听的数：

1. **扩展不可用**（命令未注册 → resolve `undefined`，或调用 reject）≠「你从没拉过」——前者说扩展不可用（该态带刷新按钮，扩展可能稍后才起来），后者才是空历史。
2. **`io` 缺席 → 「不可用（此平台没有采样器）」**，绝不显示 `0B`。
3. **`diskWrites` 一律 `≥N`**：它来自 renderer 的 watcher（会截断、遵循 `watcherExclude`），是下界不是确数。
4. **`p4Calls` 缺席 → 「未采集」**，`complete=false` → 总数带 `≥` 且注明「未完整采集」，**0 且不完整绝不显示成总数 0**（见上一节的口径）。

另有一条容易忽略的：**失败 / 取消的 run 会带一份全零 summary**（p4 还没报数就中断了），把它渲染成「无需传输」等于说「本来就没东西要拉」——恰是「被拒绝」的反面。所以计数行只有在**确实有非零计数**或结果是 `upToDate` 时才显示 `nothing to transfer`，否则说「p4 未报告」（`filesLabel` / `countsLine` 的判据，单测钉着）。

## 测试地图

| 文件                                                                                         | 钉什么                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/__tests__/syncHistory.test.ts`                                                          | `outcomeOfRun` 六态与优先级（含 `notRun` → `declined`）、`buildSyncHistoryEntry` 的搬运与截断、declined 恒 0 耗时 / 无 facts、DTO 映射的 `scopeFirst` 与 `p4Calls`、`isEntry` 丢弃畸形 `p4Calls`、`SyncP4CallCounter` 各态（含未 spawn 不污染确数、回退两半相加、summary 落后取观测、**分类完整性独立于总数**：summary 只给总数时退回事件流分类且标下界）                                        |
| `src/__tests__/syncHistoryLog.test.ts`                                                       | 追加 / 排序 / 分页（total + hasMore）/ 201 条淘汰最老（乱序写入验证是排序裁剪）/ 损坏 JSON / 伪造条目被 `isEntry` 丢弃（含超长 scope）/ 跨窗口重载                                                                                                                                                                           |
| `src/__tests__/clientSyncFacts.test.ts`                                                      | 引擎与 `engineFallback` 四态、**快照早于清零**的回归、无采样 → `io` 缺席（不是 0）、预检拒绝 → `notRun` 且**整组 facts 缺席**；`p4Calls` 的原生成功 / 失败 / 取消 / 重叠隔离、δ 确认 / 只观测下界 / 未 spawn 后走原生仍精确 / 分类随总数一起出来、δ 死亡时是下界 / `deltaRunId` 在 δ 服务时存在、δ 死后转原生仍在、纯原生缺席                                                                                                  |
| `src/__tests__/p4deltaParser.test.ts`                                                        | JSONL 解析；`readP4deltaCallCount` 取 max 高水位、按 count 去重（乱序 / 重复 / 0 事件不给分类凭空加账）、summary 落后 / 畸形事件 / 无 summary 只给下界、分类的受控键与坏事件整条丢弃、**summary 分类自洽校验**（总和对不上 / 某类大于总数 / 某类小于已观测 → 不完整）                                                                                                                          |
| `src/__tests__/p4deltaRunLog.test.ts`                                                        | 有界队列 / 单文件截断标记 + 终态保留 / 队列上限丢行计数 / `.writing` 仅在收尾时翻成 `.log` / 按文件数·年龄淘汰 / **不删另一窗口活动文件**、只收超期遗留 / 目录前缀 + runId 形状 + 拒绝符号链接 / 读取前有界 flush                                                                                                             |
| `src/__tests__/p4deltaLogSink.test.ts`                                                       | 运行头（引擎来源 / cwd / argv）与终态行同时进频道与文件、正文超预算时终态行**与 summary 命令统计页脚**仍在、丢行有痕迹、收尾后列表可见、无存储目录只警告一次、频道抛错不影响落盘、并发两跑各写各的文件                                                                                 |
| `src/__tests__/extensionSyncHistory.test.ts`                                                 | 捕获 activate 注册的 handler + 真 `SyncHistoryLog`：恰好一条 / facts 落到记录（含 `p4Calls`）/ 六种 trigger（含无参调用不被记成 explorer）/ clobber 补救两条（`failed` + `recovery`）/ 门拒绝与预检拒绝 → `declined` 且没跑 p4、也不再补一条失败 toast / `getRuns` 参数窄化与 `p4Calls` 透传 / `getRun` 用 `null` 说「没有」/ **`openLog`**（按记录取 runId 打开快照文档、记录没有 δ 引用时**不退化成最近一份**、日志被清掉时说清楚、未知 id 同形回答、最近一次日志命令、无存储/无日志各一句、open show 的是 P4delta 频道）/ **poke 四条**（一次 get 一次且记录已在盘上、`declined` 也 poke、poke throw/reject 不影响 get、poke id 不在 manifest 的 `commands` 里） |
| `apps/editor/.../__tests__/syncHistoryFormat.test.ts` · `syncHistoryViewState.test.ts` · `perforceSyncHistoryActions.test.ts` · `syncHistoryCsv.test.ts` · `PerforceSyncHistoryEditor.test.tsx` | 「不可用而非 0B」「≥N」「δ 不使用线程」「失败 ≠ 从未执行」、`p4Calls` 的精确 / 下界 / 未采集三态（列表行同款）、**分类下界与总数分开说**（`p4Calls.p4deltaByCommandComplete` 独立一列 + 详情里按分类标志判断下界）、空态 vs 加载中、命令**未注册（resolve `undefined`）**→ 扩展不可用（且与「记录被顶掉」分开）、畸形返回、不可用态可刷新且不注册 `focusRows`、切行即清上一条详情、**无 poke 时重挂不重取**、首次加载跨卸载仍保住选中；poke seam：未挂载只置 `stale` / 已挂载防抖恰好一次 / 连打合并 / 触发前卸载不调用 / `_resetForTests` 清计时器 / Action2 的 ID 等于宿主用的字面量且路由到 seam；组件侧（真计时器，**不引 fake timers**）：poke 后列表 +1 且选中不跳、卸载期的 poke 在回来时重读一次、**poke 落进在飞的「加载更多」不把页大小顶回 50**、**两次 load 乱序落地时后派发的赢**、不可用态收到 poke 只重试不编造 |
| `e2e/specs/perforceSyncHistory.spec.ts`                                                      | 五条 journey：一次 get 恰好一行且详情正确（含 `p4Calls {native:1,p4delta:0,complete:true}` 与详情行、CSV 四列）/ **失败也留档**（且记录早于错误弹窗）/ IO 非零 / `UNIVERSE_P4_IO_PROBE=off` → 不可用 / **页面开着时的 get 不点刷新就出现新行**（先断言空态＝首次加载已落定，行只能由 poke 带出来；断言分两层，poke 坏掉时记录轮询照绿、DOM 那条超时，不会假绿） |
| `e2e/specs/perforceSyncP4delta.spec.ts`                                                      | δ 服务 get 时落档调用数为 `{native:0, p4delta:<fake 实际 spawn 数>, complete:true}`，期望值取自 `UNIVERSE_P4DELTA_P4CALL_LOG` 的末行（不硬编码）                                                                                                                                                                             |

e2e 的**稳态信号是记录本身**（`perforce-sync-history.getRuns` 轮询），不是行文本、也不是完成 toast：行文本全是一个样，toast 会消失，而记录对 applied / failed / cancelled 一视同仁。另注意 fake p4 在**文件落到 head 时会删掉显式 `haveRev`**（对齐真服务器），所以断言「这次 get 真的落盘了」要看磁盘内容，不要看 `readHaveRev`。

## 验证

```bash
pnpm --filter @universe-editor/perforce test
pnpm --filter @universe-editor/editor test
pnpm --filter @universe-editor/perforce build && pnpm --filter @universe-editor/editor build
cd extensions/perforce && UNIVERSE_E2E_NO_TAG_FILTER=1 pnpm e2eg perforceSyncHistory
```

用户可见行为（入口、每列含义、IO 口径声明）同步 `docs/user/zh-CN/perforce/sync-history.md`（`pnpm docs:check` 校验内链）。

## 关键参考路径

- `packages/extensions-common/src/contracts/perforceSyncHistory.ts` —— DTO + 命令 id
- `extensions/perforce/src/syncHistory.ts` —— 纯函数 + `SyncP4CallCounter` + `SyncHistoryLog`（对着 `graphSyncLedger.ts` 写，但**语义不同**，别照抄）
- `extensions/perforce/src/client.ts` —— 搜 `_withSyncFacts` / `SyncRunFacts` / `SyncP4CallCounter` / `_syncIoSampled`
- `extensions/perforce/src/p4delta/p4deltaParser.ts` —— 搜 `readP4deltaCallCount`（δ 侧的观测下界与分类）
- `extensions/perforce/src/p4delta/p4deltaRunLog.ts` / `src/p4deltaLog.ts` —— 运行日志的有界 writer 与频道出口
- `extensions/perforce/src/extension.ts` —— 搜 `p4delta-logs`（日志目录 / sink / 三个日志命令）
- `extensions/perforce/src/extension.ts` —— 搜 `recordSyncHistory`（helper、两个落账点、两个只读命令）
- `extensions/perforce/src/processIo.ts` —— 采样器（`UNIVERSE_P4_IO_PROBE` 是 e2e 的缝）
- `apps/editor/src/renderer/workbench/perforceSyncHistory/` —— 页面与纯格式化
