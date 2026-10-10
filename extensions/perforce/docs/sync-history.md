# Perforce Sync History（拉取历史）

宿主里的一个虚拟编辑器标签页（URI `universe:/perforceSyncHistory`）：把**每一次拉取**渲染成一条记录——耗时、六类文件计数、进程读写字节、磁盘写入事件数、引擎 / 目标修订 / force / 并行线程、范围与触发入口。数据全部来自扩展写在本地的一份 JSON，宿主经两个只读命令取 DTO，**这条链上一个 p4 都不用跑**。

> 先读 `../CLAUDE.md`。本文只讲拉取历史特有的东西：与图谱账本的分工（为何不能合并）、`facts` 快照的时机、两个记录点、触发入口表与测试地图。

## 三层技术栈（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| wire 类型 | `packages/extensions-common/src/contracts/perforceSyncHistory.ts` | `P4SyncRunDto` / `P4SyncRunDetailDto`（多了完整 scope）/ `P4SyncHistoryLoadOptions` / `P4SyncHistoryLoadResult` + `PerforceSyncHistoryCommands`（`getRuns` / `getRun`）。改动要 bump 时先 `pnpm --filter @universe-editor/extensions-common build` |
| 数据层 | `extensions/perforce/src/syncHistory.ts` | 纯函数 `outcomeOfRun` / `syncNothingHappened`（**与 toast 分支共用一份**）/ `buildSyncHistoryEntry` / `isEntry` / `toRunDto` / `toRunDetailDto`；持久化类 `SyncHistoryLog`（`<globalStoragePath>/syncHistory.json`，per-process tmp + rename 原子写，mtime+size stamp 跨窗口重载，整段 best-effort） |
| 事实来源 | `extensions/perforce/src/client.ts` | `SyncRunResult.facts`（引擎 / 线程 / `startedAt` / `io` / `diskWrites`）+ `_withSyncFacts`。δ 与原生两条路都经它装饰；**编辑器自己预检拒绝的 run（`notRun`）不贴 facts**（见下） |
| 记录点 | `extensions/perforce/src/extension.ts` | `recordSyncHistory` helper + **两个**落账点（见下）+ `perforce-sync-history.getRuns/getRun` 两个只读命令 |
| 宿主页 | `apps/editor/src/renderer/workbench/perforceSyncHistory/` | `PerforceSyncHistoryEditor.tsx` + `syncHistoryFormat.ts`（纯格式化，**镜像**扩展侧的字节格式化，绝不 import 扩展代码） |
| 输入/状态/动作 | `apps/editor/src/renderer/services/editor/PerforceSyncHistoryEditorInput.ts` · `services/perforceSyncHistory/syncHistoryViewState.ts` · `actions/perforceSyncHistoryActions.ts` | EditorInput（常量 URI 单例）· **单桶** module-level view-state（不像 graph 那样按 input id 分桶——这个 tab 只有一个实例）· Action2 `perforce-sync-history.view` |

宿主侧只经 `ICommandService` 调 `PerforceSyncHistoryCommands.*`；扩展侧对这些 id 写字面量（`import type` 契约，运行时擦除），与 `perforce-graph.*` 同一套纪律。

## 与图谱账本（`graphSyncLedger`）的分工——为何不能合并

两个文件并列放在 `globalStoragePath` 下、互不读写，语义**刻意不同**：

| | 账本（graphSyncLedger） | 历史（syncHistory） |
|---|---|---|
| 语义 | 每范围的**最新同步位置**，`contradictedBy` 退休旧记录 | 每次 run 一条**事件流，永不去重** |
| 身份 | `(clientRoot, scope)`，内容被后来的记录覆盖 | `id`（`at`-pid-seq），scope 只是内容 |
| scope | 必须**完整**（身份依赖它） | 可截断（`MAX_SCOPE_PATHS=64` + `scopeOmitted`），仅展示 |
| 覆盖 | 只记能表达为 claim 的**成功** run | 取消 / 失败 / 无法识别 / **被门拒绝**也各一条 |

**为什么不能只留一个**：账本回答「这个范围现在停在哪」，历史回答「昨天那次为什么这么慢」。把失败也塞进账本会让徽章逻辑面对一堆无法表达为 claim 的行；把去重逻辑搬进历史则会抹掉恰恰最想要的那几条（失败与取消）。图谱徽章的读法见 `docs/graph.md`。

## `facts` 快照必须早于 `_endExternalSuspend`（本功能最容易写错的一处）

`sync()` 的结构是「`_withBusy(...)` 里跑引擎 → `_withSyncFacts(run, ...)` → `finally { _endExternalSuspend(); _clearSyncProgress() }`」。快照**必须在 finally 之前**：`_endExternalSuspend` 会 `_stopSyncIoProbes`，把 `_syncIoReadBytes/_syncIoWriteBytes` 清零——晚一步就永远读到「无采样器」。`clientSyncFacts.test.ts` 有一条专项断言守着它（`run 结束后 facts.io 仍非空`）。

run 的时钟（`facts.startedAt`）在 `await this._noteSyncPreviewDrift(...)` **之后**取：那条「预览的范围已经变了」的提示属于 run 之前的插曲，用户盯着它读多久都不该进耗时。

`_withSyncFacts` 对 `notRun: true` 的 run **原样返回**：预检拒绝一个 p4 都没起，`engine: 'p4'` 会指认一个不存在的进程，`parallelThreads` 是个无所约束的旋钮，io / diskWrites 是共享计数器的残值。facts 缺席才是唯一真话。

另外三条已知近似（同样写在 `client.ts` 的 JSDoc 里，用户文档已声明）：

- **采样周期 1s**：末尾不足一秒的部分可能漏计；`_syncIoSampled` 只在采样器**真的报过数**时为真，所以「1 秒内跑完的 get」记的是**无采样**而不是 0 B。
- **重叠 sync 共享计数器**：io 与 `diskWrites` 是该 client 的全局累计，两次重叠的 run 各自记到的都是**两跑之和**（与状态栏速率同口径）。
- **`'transient'` 采样失败会丢弃已采字节** → 该 run 记为无采样。

## 两个记录点（都在 `extension.ts` 的 `runSync` 收尾处）

1. **落账点 A**：`const res = await window.withProgress(...)` 之后、`if (res.cancelled) return` **之前**。此刻 applied / upToDate / unrecognized / failed / cancelled 全部已定，而**任何 toast 与补救对话框都还没 await**——所以 `durationMs` 量的是拉取本身，不是你盯着弹窗读了多久。失败与取消也因此各留一条。
2. **落账点 B**：范围门 `if (!decision.ok) return` 之前，记一条 `outcome:'declined'`（p4 一行没跑，所以没有 `facts`）。

**`declined` 有两个来源**（落账点 B 的门拒绝，以及客户端预检拒绝 `SyncRunResult.notRun`），两者都满足「这次 get 没有执行」，所以不新增第 7 种结果值——原因由「错误」一行给出：`notRun` 时客户端把**真正的拒绝理由**放进 `error.suggestion`（`kind: 'other'`，不触发命令层的 clobber 补救——那条重试只会被同样拒绝一次），范围门那条则由门自己的提示说明。`buildSyncHistoryEntry` 对 `declined` 一律记 **`startedAt = at`、`durationMs = 0`、不落 facts**：这个 0 是结构性的，不是量出来的——否则它会量到用户读拒绝弹窗的时间，或者 `at` 与调用点之间的同毫秒偏差。

命令层在 `if (res.cancelled) return` 之后紧跟一条 `if (res.notRun === true) return`：客户端已经用 `perforce.sync.scopeRefused` 说过原因了，再走一遍失败分支只会把同一句话挂在「Get revision failed」的标题下重播。

`recordSyncHistory` **不 await**（`record()` 是同步 fs：正常几十 KB 的账本约 1ms，最坏（200 条 × 64 路径）几十毫秒；每次 get 一次，且已经在进度 UI 之后），且整段 try/catch：历史写失败绝不冒泡——这条路径在红线 4（`_spawn` 回调不得 throw）的射程内。

## 触发入口表（`options.trigger` 必填）

| 调用点 | 值 |
|---|---|
| Timeline runner（`perforce.timeline.getThisRevision`） | `timeline` |
| `perforce.syncLatest` / `perforce.sync` 带 resource/selection | `explorer` |
| 同上的**无参**分支（命令面板） | `command` |
| `perforce-graph.syncToChange` | `graph` |
| 状态栏修订标记 chip | `statusBar` |
| 内部补救（clobber 后的强制重试、逐文件 force 重试） | `recovery`（放在 spread **之后**覆盖调用方的值） |

`trigger` 必填的理由同 `ledgerScope`：每个入口自报家门，否则那一列就是谎言。判定只看**实参**：`syncLatestFor` 用 `resourcePath(args[0])` 判「调用方点名了资源吗」，点名才是 `explorer`，无参（状态栏 chip、命令面板）一律用调用方传入的 `trigger`。**活动文件回落只影响 scope、不影响 trigger**——`resolveTargetPath` 在没有资源参数时会回落到 `_workbench.getActiveEditorFile`，若拿「是否解析出路径」当判据，任何有活动文件的无参调用都会被记成资源管理器点击。**状态栏 chip 是唯一需要额外接线的入口**——`StatusBarItem.command` 是 `string | undefined`、**没有传参通道**，所以新增了一个运行时命令 `perforce.syncLatestFromStatusBar`（**不进 `contributes.commands`**，照 `perforce.cancelBusy` 先例）；`perforce.syncLatest` 的函数体提成局部 `syncLatestFor(args, trigger)`，两个 id 各自转发。

## 契约与降级的三条硬要求

`getRuns` 只按 `max` / `root` 取一页，**没有游标**：宿主「Load more」就是抬高 `max` 重读全量，在 200 条上限下这比排他时间戳游标更稳（`at` 是 `Date.now()`，同一毫秒的两条记录会让 `at < cursor` 的切口永久漏掉一条）。两个命令是**纯文件读、零 p4 调用**（不碰并发门），参数逐字段窄化、不信任渲染侧。

`getRun` 的「没有」用 **`null`**，`undefined` 只留给**命令根本不在**（宿主对未注册 id 解析出 `undefined`，扩展只有激活过各道门才会注册这些命令）。两者在宿主眼里曾经同形，于是「这个安装里没有 perforce 扩展」被渲染成「这条记录已被淘汰」——一块面板说扩展不可用、另一块断言记录被顶掉，自相矛盾。宿主详情面板因此是三态：`undefined` → 扩展不可用、`null` → 已不在历史中、其余正常渲染，`catch` 一律按不可用。

页面对三件事必须如实说，而不是编一个好听的数：

1. **扩展不可用**（命令未注册 → resolve `undefined`，或调用 reject）≠「你从没拉过」——前者说扩展不可用（该态带刷新按钮，扩展可能稍后才起来），后者才是空历史。
2. **`io` 缺席 → 「不可用（此平台没有采样器）」**，绝不显示 `0B`。
3. **`diskWrites` 一律 `≥N`**：它来自 renderer 的 watcher（会截断、遵循 `watcherExclude`），是下界不是确数。

另有一条容易忽略的：**失败 / 取消的 run 会带一份全零 summary**（p4 还没报数就中断了），把它渲染成「无需传输」等于说「本来就没东西要拉」——恰是「被拒绝」的反面。所以计数行只有在**确实有非零计数**或结果是 `upToDate` 时才显示 `nothing to transfer`，否则说「p4 未报告」（`filesLabel` / `countsLine` 的判据，单测钉着）。

## 测试地图

| 文件 | 钉什么 |
|---|---|
| `src/__tests__/syncHistory.test.ts` | `outcomeOfRun` 六态与优先级（含 `notRun` → `declined`）、`buildSyncHistoryEntry` 的搬运与截断、declined 恒 0 耗时 / 无 facts、DTO 映射的 `scopeFirst` |
| `src/__tests__/syncHistoryLog.test.ts` | 追加 / 排序 / 分页（total + hasMore）/ 201 条淘汰最老（乱序写入验证是排序裁剪）/ 损坏 JSON / 伪造条目被 `isEntry` 丢弃（含超长 scope）/ 跨窗口重载 |
| `src/__tests__/clientSyncFacts.test.ts` | 引擎与 `engineFallback` 四态、**快照早于清零**的回归、无采样 → `io` 缺席（不是 0）、预检拒绝 → `notRun` 且**整组 facts 缺席** |
| `src/__tests__/extensionSyncHistory.test.ts` | 捕获 activate 注册的 handler + 真 `SyncHistoryLog`：恰好一条 / facts 落到记录 / 六种 trigger（含无参调用不被记成 explorer）/ clobber 补救两条（`failed` + `recovery`）/ 门拒绝与预检拒绝 → `declined` 且没跑 p4、也不再补一条失败 toast / `getRuns` 参数窄化 / `getRun` 用 `null` 说「没有」 |
| `apps/editor/.../__tests__/syncHistoryFormat.test.ts` · `PerforceSyncHistoryEditor.test.tsx` | 「不可用而非 0B」「≥N」「δ 不使用线程」「失败 ≠ 从未执行」、空态 vs 加载中、命令**未注册（resolve `undefined`）**→ 扩展不可用（且与「记录被顶掉」分开）、畸形返回、不可用态可刷新且不注册 `focusRows`、切行即清上一条详情、重挂不重取、首次加载跨卸载仍保住选中 |
| `e2e/specs/perforceSyncHistory.spec.ts` | 四条 journey：一次 get 恰好一行且详情正确 / **失败也留档**（且记录早于错误弹窗）/ IO 非零 / `UNIVERSE_P4_IO_PROBE=off` → 不可用 |

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
- `extensions/perforce/src/syncHistory.ts` —— 纯函数 + `SyncHistoryLog`（对着 `graphSyncLedger.ts` 写，但**语义不同**，别照抄）
- `extensions/perforce/src/client.ts` —— 搜 `_withSyncFacts` / `SyncRunFacts` / `_syncIoSampled`
- `extensions/perforce/src/extension.ts` —— 搜 `recordSyncHistory`（helper、两个落账点、两个只读命令）
- `extensions/perforce/src/processIo.ts` —— 采样器（`UNIVERSE_P4_IO_PROBE` 是 e2e 的缝）
- `apps/editor/src/renderer/workbench/perforceSyncHistory/` —— 页面与纯格式化
