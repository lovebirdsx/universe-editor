# Perforce 踩坑红线（完整叙事归档）

> 本文是 `extensions/perforce/CLAUDE.md` 的配套详情档。主文件只留每条坑的一句判据；这里保留「现象 + 根因 + 修法 + 实测数据」的完整叙事，供排查与改相关逻辑前查阅。

## 目录

- [共享 FIFO 并发门被大扇出灌满 → 交互命令排队几分钟](#共享-fifo-并发门被大扇出灌满--交互命令排队几分钟本轮根因)
- [连接解析：`-p` 端口绝不从 `p4 info` 推导](#连接解析-p-端口绝不从-p4-info-推导)
- [`-Mj` 在部分命令上会退化成单个 `data` blob](#-mj-在部分命令上会退化成单个-data-blob)
- [blame 元数据绝不走 `describe -s`（巨型 CL 挂死）](#blame-元数据绝不走-describe--s巨型-cl-挂死踩过)
- [搁置发现绝不扇出 `describe -S -s`](#搁置发现绝不扇出-describe--s--s同款挂死风险)
- [`opened`/`reconcile -n` 的 `clientFile` 是 client 语法](#openedreconcile--n-的-clientfile-是-client-语法不是本地路径踩过)
- [sync 拒绝有三个形态](#sync-拒绝有三个形态只解析一个就会谎报已是最新踩过)
- [`P4Service` 首条流式通道：`onStdoutLine`](#p4service-首条流式通道p4execoptionsonstdoutlinesync-进度条数据源)
- [`--parallel` 下 stdout 突发输出 → 状态栏数字冻结数分钟](#--parallel-下-stdout-成突发输出--状态栏数字冻结数分钟真机实测)
- [unresolved 信号只认 `fstat -Ru`](#unresolved-信号只认-fstat--ruopened-从不报真机实测)
- [巨量 stdout 会撑爆 V8 字符串上限 → 宿主崩溃](#巨量-stdout-会撑爆-v8-字符串上限--扩展宿主崩溃踩过)
- [p4 子进程永不退出 → 宿主无限挂起](#p4-子进程永不退出--宿主无限挂起44-分钟闩锁卡死)
- [中文/非 ASCII 路径 argv 乱码；超长 argv ENAMETOOLONG](#中文非-ascii-路径经-argv-传给-p4-会乱码超长-argv-会-enametoolong已修复-x-argfile)

---

## ⚠️ 共享 FIFO 并发门被大扇出灌满 → 交互命令排队几分钟（本轮根因）

**根因（实测）**：所有 p4 命令共用一个上限 4 的 FIFO 并发门（`ConcurrencyGate`）。用户在有 9115 条待收集改动的 workspace 点 SCM 文件行，磁盘复核把 9115 条候选切成 ~114 批 `reconcile -n` 用 `Promise.all` 一次性提交，**灌满门数分钟**；点击触发的 `p4 fstat` + `p4 print` 排在 FIFO 队尾，于是 diff 要等几分钟才打开。（这条具体的大扇出源头——待收集组的磁盘复核把全量候选切成批——**已随「待收集」组删除**；静态预留的教训仍适用于任何批量 p4 命令。）

**为什么是静态预留而非动态**：动态（比如「interactive 可以插队」）仍会让大扇出先占满所有槽，点击只能在队尾等；静态预留一个槽（background 硬顶 `max - reserve`，默认 4→3）保证任何时候都留着一个槽给 interactive，用户点击永远先于后台批次。**为什么 background 硬顶在 `max - reserve` 而非软上限**：软上限 = 没任务时后台也能用满 `max`，一旦某个 refresh 正好在点击前扇出，槽又被占满，预留失效。`reserve` 是「background 的静态天花板」，不是「background 的地板」。

**interactive 标记判据（最终清单，加新 p4 命令照此办）**：用户点击/悬停触发的读、且用户要等它才能看到东西 = interactive；扫描 / 轮询 / 批量（reconcile 复核、refresh、后台扇出）= background（默认）。**超时选用**：能断言「正常该多快」的元数据读 → `INTERACTIVE_EXEC`（30s 紧超时）；耗时随数据量线性增长的内容传输（`print`，以及巨型 CL 上 GB 级输出的 `describe -s`/`describe -S -s`）→ `INTERACTIVE_CONTENT_EXEC`（只提优先级，保留 600s 预算）。

- **interactive（已标）**：`fstat`（gutter/Timeline/openChange diff）、`print`（diff/baseline 内容，CONTENT）、`annotate` + `changes -l`（blame）、`diff -se`（timeline pending 探针）、`filelog`（Timeline 视图/切活动编辑器）、`changes -s submitted`（开图谱）、`describe -s`（点图谱节点，CONTENT）、`opened` 经 `_openedFiles`（图谱 pending 节点）、`opened` 经 `openedStateAmong` / `openedInTree`（统一 Revert 确认的 live 预检）、`where` 经 `_whereLocalPaths`（图谱/Swarm 读调用方）、`describe -S -s` 经 `describeChangeFiles`（展开 Swarm review，CONTENT）。
- **刻意不标（background 默认）**：refresh 的 `opened`/`changes -s pending`、`_fetchShelved` 的 `describe -S -s`（带 30s 紧超时）、`reconcile -n` 全扫/增量批、`deleteChangelist` 的 `describe -S -s`、`_applyCommittedChange` 的 `print`/`where`、他人占用扫描的 `opened -a`（带 20s 紧超时）、behind 灰字探针 `checkBehind` 的逐文件 `fstat`（带 20s 紧超时）——这些是 mutation、后台扇出或渲染路径被动突发，不是点击读。
- **共享 helper 的处理**：`_whereLocalPaths` 同时被 mutation（`_applyCommittedChange`）和 graph/Swarm 读调用，故默认 background、加可选 `options` 参数由调用方定优先级（读调用方显式传 `INTERACTIVE_EXEC`）；`_openedFiles` 只有图谱 pending 两个消费方（refresh 自己跑 `opened`，不经过它），故直接标 `INTERACTIVE_EXEC`。
- **以后加任何批量 p4 命令都要想**：它会不会把门灌满、把交互命令挡在队尾——批量命令一律 background，用户读一律显式标 interactive。

## ⚠️ 连接解析：`-p` 端口绝不从 `p4 info` 推导

**头号连接坑（踩过）**：`p4 info` 的 `serverAddress` 是**服务器自报的内部 bind 地址**（P4P 代理后端常是 `p4:1666` 这种不可路由地址），**不是**客户端拨号用的 P4PORT。真正的 P4PORT 由 p4 CLI 自己按 **cwd 逐级向上查找 P4CONFIG/P4ENVIRO/env/`p4 set`** 解析。

- `connectionFor`（`clientDiscovery.ts`）**只在** `perforce.port` 显式设置时才传 `-p`（逃生阀）；否则**省略 `-p`**，让 p4 自解析 P4CONFIG。插件用 `clientRoot` 做子进程 cwd（`P4Service` 构造），p4 本就能解析出对的 port/user/client。
- `-c`（client）**必须传**：扫描兜底分支里 folder 属于 ambient 之外的 client 时，不钉 `-c` 会让 cwd 的 P4CONFIG 解析回 ambient client。`-u` 已知则传。
- **诊断法**：命令静默失败（exit 0 但 stderr `Connect to server failed; TCP connect to <addr> failed`）→ 多半是 `-p` 传了错地址。对比 `p4 <cmd>`（裸跑，走 P4CONFIG）与插件拼的 `-p ... -u ... -c ...` 即可定位。

## ⚠️ `-Mj` 在部分命令上会退化成单个 `data` blob

`-Mj`（marshalled JSON）并非对所有命令都吐结构化字段。**观察到 P4D 2024.2 上 `annotate` / `describe` 的 `-Mj` 把每行/整块塞进单个 `{"data":"..."}`**，丢掉 `lower`/`upper`/`user`/`time`/`desc` 等字段；只有 `-ztag` 才带这些。`fstat`/`opened`/`changes` 的 `-Mj` 正常。

- blame（`getBlame`）因此改用 `execTagged`（`-ztag`）跑 `annotate -c -q` + `changes -l`。**加任何"报表型/多字段"命令前，先在真服务器上 `p4 -Mj <cmd>` 验证它是否吐结构化键**；不确定就用 `-ztag`（`execTagged`）更稳。
- 另一坑：`-ztag annotate -u` 的 `time` 是**显示日期串**（`2026/04/30 05:56:38`）而非 unix 秒 → 别 `Number()*1000`。author/time 从 `changes -l`（`time` 是干净 unix 秒）取，annotate 只取 `lower` 拿 changelist。

## ⚠️ blame 元数据绝不走 `describe -s`（巨型 CL 挂死，踩过）

`describe -s <cl>` 即使不带 diff 也列出该 CL 的**全部文件**（`depotFile0..N`）。对巨型 branch CL（initial branch，几十万文件）输出是 GB 级、命令永不返回（实测 >3min）——`getBlame` 曾按 unique CL 串行 `describe -s` 补 summary，blame 因此永远不显示。修法：元数据（user/time/desc 第一行）改从**一次** `p4 -ztag changes -l <file>` 取（单文件历史，亚秒级），解析复用图谱的 `parseChangesList`，缓存走 `P4CacheNs.changesSubmitted`（key `blame:<file>`）。回归护栏 `clientBlame.test.ts`（describe 挂起时 getBlame 仍须返回 + 断言零 describe 调用）。同理，任何新功能需要"CL 的元数据"时都用 `changes`/`change -o`，**不要** `describe`。

## ⚠️ 搁置发现绝不扇出 `describe -S -s`（同款挂死风险）

搁置组（`shelved:<n>`）需要每个 CL 的搁置文件列表，只能靠 `describe -S -s <cl>`——**但绝不能对每个 pending CL 都跑一遍**。`_fetchShelved` 曾如此（注释写了"只查有搁置的"，`parsePendingRecord` 却把标记字段丢了 → 实际全量扇出），在大 depot 上 O(pending CL 数) 条串行 GB 级命令，正是收集操作 spinner 长时间转圈的头号挂死源。

**实测事实（P4D 2024.2，真服务器验证）**：

| 探测 | 结果 |
|---|---|
| `p4 -ztag changes -s pending -c <client>` | 记录带**裸键** `... shelved `（无值）；**只有该 CL 真有搁置时才出现**，否则整个键缺席 → 存在性即信号 |
| `p4 -Mj changes ...` | 在该服务器上塌成 `{"data":...}` blob（故走 `execRecords` 自动回退 `-ztag`） |
| `p4 changes -s shelved -c <client>` | **不过滤**——同一个 CL 仍以 `*pending*` 返回，不能当权威索引用（曾按此设计，已被验证推翻） |

**现行实现**：`PendingChangelist.shelved: boolean`（`changelist.ts`）由 `parsePendingRecord` 按 `record['shelved'] !== undefined` 填充（`openedParser.ts`）→ `_fetchShelved(ids)` 只收 `pending.filter(c => c.shelved)` 的 id，**零额外往返**；余下 O(有搁置的 CL 数，通常 0–2) 条 describe 用 `Promise.all` 并行提交（由 `ConcurrencyGate` 排队），每条带 `SHELVED_DESCRIBE_TIMEOUT_MS`（30s）紧超时作硬顶。单条失败记日志跳过，**绝不回退成逐 CL 扇出**。

## ⚠️ `opened`/`reconcile -n` 的 `clientFile` 是 client 语法，不是本地路径（踩过）

**头号数据坑**：`p4 opened` 和 `p4 reconcile -n` 的 `-Mj` 输出里 `clientFile` 字段是 **client 语法**（`//客户端名/相对路径`），**不是本地文件系统路径**——**只有 `fstat` 的 `clientFile` 才是本地路径**（[Perforce filespecs 文档](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/filespecs.html)）。曾经 `openedParser.ts`/`reconcileParser.ts` 注释误写「Local filesystem path」并直接当本地路径用，引出两个连锁 bug：

- **改动显示成整文件删除**：`client.ts` `openChange()` 里 `readFile('//客户端名/...')` 在 Windows 被当 UNC 主机访问 → 失败 → `modified=''` → diff 右侧空 → 看起来像删了整个文件（不是真删除，是读不到工作区内容）。
- **`//` URI 报错**：同一 client 语法路径喂进编辑器打开源文件，`file://` URI 的 `//` 变成非法 authority/双斜杠 → `_validateUri` 抛 `path cannot begin with two slash characters`。
- **附带**：文件监视增量 reconcile 里 `norm(本地路径)` vs `norm(client语法)` 比不上，去重/清理静默失效。

**修法**：纯函数 `pathUtil.ts` `clientToLocalPath(clientFile, clientRoot)`——client 语法**天然以 client root 为根**，故只需前缀替换（去掉 `//客户端名/` 拼到 `clientRoot`），**无需 `p4 where` 往返**；已是本地路径（非 `//` 开头）原样返回，可无条件套用。`parseOpened`/`parseReconcile` 加可选 `clientRoot` 参数（`client.ts` 传 `this.root`；测试省略则保持 verbatim）。`getOpenedForGraph` 因此也顺带修好（`f.clientFile` 现在是本地路径，`where` 只兜底缺失项）。

- **⚠️ `opened -a` 是这条坑的镜像（他人占用扫描踩点）**：`-a` 输出的 `clientFile` 是**别人 client** 的 client 语法（`//otherclient/Source/...`），用自己的 clientRoot 翻译会拼出本地不存在的假路径——「他人占用」灰字的本地路径**必须从 `depotFile` 走 `_whereLocalPaths` 反查**（`runOpenedByOthersScan` 里 `parseOpened` 刻意**不传** `this.root`，且别人 client 的语法路径绝不回传给任何 p4 命令）。真机输出形态见 `e2e/fixtures/PROBE-FINDINGS.md` §4。
- **fake-p4 也要对齐**：`fake-p4.mjs` 原来 `opened`/`reconcile` emit 本地路径 → 掩盖了这个 bug。现在 `clientSyntaxOf()` emit client 语法（`//client/rel`），并补了 `fstat`/`print`（baseline diff 需要）+ `toDepotFile()`（吃本地/depot/client 三种语法）。
- **回归护栏**：这条 phantom delete `@regression` 已迁进 `e2e/specs/perforceWorkingTreeHint.spec.ts`——盘上改过的未签出文件 → Explorer 出 `RM` 徽标 → `perforce.openChange` 打开 diff → 断言 modified 侧 == 真实盘上内容（不是空）。改坏 `clientToLocalPath` 会红。单测见 `pathUtil.test.ts`/`openedParser.test.ts`/`reconcileParser.test.ts`。

## ⚠️ sync 拒绝有三个形态，只解析一个就会谎报「已是最新」（踩过）

`p4 sync` 拒绝更新文件时，形态**取决于 client 的 `Options` 与拒绝原因**，三者结构/语义都不同，**必须都解析**（前两种真机实测见 PROBE-FINDINGS §13，第三种 2026-09-09 在 `allwrite noclobber` client 的 `--parallel` run 里抓到）：

| | `allwrite noclobber`（游戏项目常见） | `noallwrite` clobber | `can't overwrite existing file`（孤儿文件占位） |
|---|---|---|---|
| 文案 | `can't update modified file` | `Can't clobber writable file` | `can't overwrite existing file <local>` |
| 通道 | **stdout** | **stderr** | **stdout** |
| exit | **0** | **1** | **0** |
| 范围 | **只跳过该文件**，其余照常更新 | **中断整次 run** | **只跳过该文件**，其余照常更新 |
| 语义 | 本地有**已修改的**未收集内容 | 可写文件被覆盖 | 本地有**未被 p4 跟踪的孤儿文件**占位（`p4 have` 无记录、`fstat headAction add`） |
| `-ztag` | 行**照样在 raw stdout**，只是没有结构化记录（无 `... key value` 前缀，被 `parseZtag` 丢弃）——`previewSync` 因此能从 `result.stdout` 捞回来 | 走 stderr，不受影响 | 同第一列（raw stdout，无结构化记录） |
| `-Mj` | 塌成 `{"data":…}` blob | 同上 | 同上 |

- **曾经的 bug**：只有 clobber 被解析 → allwrite client 上 `parseSyncOutput` 四个正则全不命中（`APPLIED_LINE` 要求 ` - ` 后紧跟 `updated`/`updating`/…，实际紧跟 `can't`）→ 全零 summary → `runSync` 弹「已是最新版本」= **假成功**，用户被送走时以为落后的文件已是最新。同一根因让 `previewSync`（走 `execTagged`）拿到零记录报 `upToDate`，与 rev chip 的 `↓#head` 自相矛盾。**第三种形态是同型 bug 的复发**：`--parallel` run 里 7 行 `can't overwrite existing file` 全不被识别 → 全零 summary → 弹「Get revision returned no recognized result」。
- **现行**：`REFUSED_MODIFIED_LINE` → `SyncRunSummary.refusedModified`、`REFUSED_OVERWRITE_LINE` → `SyncRunSummary.refusedOverwrite`（两者都使 `unrecognized` 转假，**分别计数、不并桶**）。纯函数 `parseSyncRefused` 只把 **refusedModified** 行折回 `SyncPreviewFile[]`（`action: 'not updated'`），`previewSync` 并进 `files` 使三处信号一致（`total` 仍只读 records —— `totalFileCount` 已含拒绝行，别叠加）。`sync()` 顺带把 `refusedFiles`（**仅 refusedModified**）带出来供「查看差异」用，避免再跑一条可能与用户所见不一致的 p4 命令。
- **为什么孤儿文件（`refusedOverwrite`）必须独立桶、且不给 collect/diff**：`refusedModified` 的本地有「修改」——有真实内容可 diff、collect 会把改动排进合并；而 `refusedOverwrite` 的文件**不在 have 表**（多半是引擎安装残留/共享存储资产，`pathType share`），没有「修改」可言——collect 会把它**收集成 add**（把不该入库的东西塞进 CL），diff 会显示「depot 不存在 vs 孤儿文件」的噪音。唯一对症的补救是 `sync -f`（「不管磁盘现状强制写入」正对孤儿占位）或用户手动删掉孤儿文件。**并入 refusedModified 会让「收集改动」「查看差异」按钮对它出现，误导用户**。
- **分支顺序即优先级**：`refusedModified > 0` / `refusedOverwrite > 0` 都排在 `upToDate` 之前（一次多 filespec run 可同时产生拒绝与 up-to-date，报被拒绝的更有行动价值）。**「什么都没解析出来」绝不能再回落成「已是最新」**——那是最坏的答案（与成功不可区分），现在报「没有返回可识别的结果」+ 打开输出频道按钮。
- **`-f` 是逃生阀，不是默认补救**。对 refusedModified，p4 拒绝的唯一原因就是文件里有未收集的工作，而 `sync -f` 会永久销毁它（§11.2 已实测覆盖本地草稿）；对 refusedOverwrite，`-f` 是**唯一**能挪走孤儿占位的途径。所以三条硬约束缺一不可：① 它只能作为**显式按钮**出现（绝不自动重跑成 `-f`）；② 点击后弹**勾选式 per-file force 多选列表**（`pickForceGetFiles`）而非盲目全量重跑；③ 对 refusedModified，默认路径仍是先收集——按钮顺序固定为 `收集改动 → 查看差异 → 强制拉取`（收集是无损的、p4 会排合并，故领先；force 排在看过 diff 之后）。按钮集由纯函数 `refusedSyncButtons({refusedModified, refusedOverwrite, mustResolve, allowForce})` 拼装（`extension.ts`，带单测）：**`refusedModified > 0` 时给 collect/diff/force（orphan 计数只在 message 里呈现，refusedModified 语义优先）；纯 `refusedOverwrite > 0` 时只给 force**（不给 collect/diff，语义不符）。`allowForce` 在本次 run 已经是 `-f` 时为 false——同样的拒绝再给一次 force 只会原地打转。clobber 分支同样给 force，但**不给「查看差异」**：它走 stderr/exit 1，`refusedFiles` 从 stdout 解析故为空，没有 per-file 本地路径可 diff（也无 per-file 列表可勾选，故 clobber 的 force 仍是原 scope 重跑 + `confirmForceGet()`）。
- **勾选式 per-file force（`pickForceGetFiles`）**：拒绝行本身就点名了每个被跳过的文件，对整个 scope 重跑 `-f` 会为这几个文件重传整个 scope（宽 scope 如 `//...` 在巨型游戏仓上是 GB 级），且会静默覆盖该 scope 内**所有**有未收集改动的文件——销毁面隐形扩大。故改为**只对被拒文件 force**：合并 `refusedFiles`(modified) + `refusedOverwriteFiles`(orphan) 成一个多选 picker，**默认全选**（用户逐个反选想保留的），`labelColor` 按来源着色（`'modified'`=黄 / `'orphan'`=紫），`description` 带 `depotFile#rev`，picker 的 `title` 即二次确认文案（说清勾选的本地副本将被销毁）不再叠第二层 modal。勾选结果经纯函数 `buildForceGetFilespecs`（`p4Filespec.ts`）拼成 `escapeFilespecPath(depotFile)#rev` 的 per-file filespec——**`#rev` 钉住被拒时的确切修订**，`-f` sync 不会漂到比用户刚看到的更新的 `#head`；转义在拼后缀前，路径里的字面 `#`/`%` 被编码而非被当成 rev 分隔符。`showQuickPick` 的多选形态（`canPickMany: true` + 每项 `picked: true` 预选 + `labelColor`）返回调用方传入的原数组元素（wire 只 round-trip 索引），故 picker item 上额外的 `depotFile`/`rev` 字段随对象穿透回来。确认按钮 `okLabel` 带 `{0}` 实时计数「强制拉取所选 (N)」，全不勾时禁用。
- **「查看差异」直调 `target.openChange`，不要绕回 `perforce.openChange` 命令**。runSync 已经持有发起这次 get 的 client；命令版会用 `resolveClient` 从路径重新解析，而它在无 root 命中时回退 active repository——那是命令路由语义，对一个我们已知归属的文件是错的。
- **加任何新的 sync 输出解析前**：先想「这条行走 stdout 还是 stderr、exit 几、中断还是跳过」四问，四个答案都不同就是一个新形态——再追问第五问「文件在 have 表里吗」，在/不在决定了它进 `refusedModified` 还是 `refusedOverwrite`。

## ⚠️ `P4Service` 首条流式通道：`P4ExecOptions.onStdoutLine`（sync 进度条数据源）

`sync` 需要逐文件推进的进度条，而 p4 每文件吐一行 stdout——这是本扩展第一条**流式**通道（`p4Service.ts` 新增 `onStdoutLine` 逐行回调，边收边回调，`carry` 存半个行跨 chunk 不拆行）。与既有「巨量 stdout」「子进程永不退出」两节**同款红线**：回调跑在异步 `data`/`close` handler 里，**必须 try/catch 吞掉用户回调的异常**（只记 `onStdoutLine callback threw` 日志），否则 uncaughtException 杀掉整个 extension host；超出 `maxOutputBytes` overflow 后停止回调（`if (overflowed) return`）。

- **单一真相**：逐行判定与最终 summary **共用** `syncParser.ts` 的 `classifySyncLine`——流式路径上缓冲 stdout 被整体跳过（正是它撑爆过旧的 256MB 上限），summary 由逐行累加构建而非从完整字符串 re-parse，两条路径仍零漂移；`syncLineFile` 从行里抠文件名显示。up-to-date 是整 run 判定（非逐行），流式版在 `onStdoutLine` 里顺手捕该行（`sawUpToDateLine`）+ 末尾 OR stderr，与 `parseSyncOutput` 的双通道判定对称。
- **缓冲跳过边界（`skipStdout` / `keepStdout`）**：流式默认跳过 stdout 累积（`skipStdout = onStdoutLine !== undefined && keepStdout !== true`）；`execRecords` 的 `recoverPartialOnTimeout` 内部 collector 与**非 recover 腿**都需要 buffered stdout 做 `-Mj` 塌陷检测 → `_execRecordsLeg` 对任何带调用方 `onStdoutLine` 的调用都强制 `keepStdout: true`（不只 recover 分支），否则塌陷检测会拿空串静默解析成空 records。
- **UI 侧 150ms 节流**（`extension.ts` 的 `PROGRESS_REPORT_INTERVAL_MS`）：p4 每文件一行，不节流就是上万条 RPC。本扩展**首次用** `window.withProgress`（`ProgressLocation.Notification`，不定形态 + `cancellable`）；取消按钮路由到 `target.cancelBusy()`，与状态栏 spinner 同一 abort 机制，不搞两套。状态栏侧另有一条 200ms 节流（`client.ts` `_bumpSyncProgress`，镜像 `_setScanProgress`）。
- **无预扫、无总数**：sync **不做** `sync -n` 预扫计数（宽 scope 上预扫本身要走同款服务器比对、最坏近一分钟却一个字节不传——纯开销），进度条直接显示「已处理 N · 已用时」的不定形态（状态栏 `…branch_xyz: Syncing 421 · 1m 23s` + 通知条同款）。**绝不编总数**（编一个到 40% 就停的总数比没有总数更糟）。「预览将要拉取的内容」命令（`previewSync`，`sync -n` 列文件）是用户主动触发的只读预演，与此无关、保留。
- **syncProgress 生命周期**：`ClientStatus.syncProgress` 在 `_cancellable` settle 后立即 `_clearSyncProgress()`（success/failure/cancel 三路径同一时点），finally 只兜底 classify/parse 段的 throw——计数与 "Syncing" 标签同生共死，收尾 refresh（"Refreshing" 标签）期间绝不残留 sync 计数。非流式 sync（如 Explorer 单文件 `syncFiles`）从未 set 过该字段，`_clearSyncProgress` 有早退守卫不触发空 emit。

## ⚠️ `--parallel` 下 stdout 成突发输出 → 状态栏数字冻结数分钟（真机实测）

真机巨型仓库（游戏仓库、大块二进制资源）根目录拉取：`p4 sync --parallel=threads=N` 传输大文件期间**不输出任何行**，一批完成才 flush——状态栏的「已处理数」会整段冻结（几分钟到 10 分钟+），与 `-I` 进度指示互斥：`p4 help sync` 明说 *"Requesting progress indicators causes the --parallel flag to be ignored"*（`-I` 会退化成串行传输，大仓库不可接受，已否决）。

- **对策 A（已落地）**：sync 期间状态栏叠加**文件监视器磁盘写入计数**（`SyncProgress.diskWrites`）：挂起分支里对每个 watcher 事件计数并复用 `_bumpSyncProgress` 的 200ms 节流。它是**下限近似值**——renderer 每批截断 5000 事件（`MainThreadFileEvents.MAX_EVENTS_PER_BATCH`）+ `files.watcherExclude`，真实写入数恒 ≥ 计数；与 p4 计数**不同源**，UI 上两个数字分开呈现（`Syncing 421 · disk +567 · 3m20s`），tooltip 说明近似语义。计数在 scope guard 之前（语义是「工作区正在被写」，不是「有漂移」），重置在挂起 arm（深度 0→1）时、**不在** `_clearSyncProgress`（那里清零会让最后一次渲染归零）。
- **对策 B（已落地）**：sync 生命周期**挂起外部漂移处理**（`_beginExternalSuspend`/`_endExternalSuspend`，`_externalSuspendCount` 计数非布尔——`_busyOps` 是栈、runSync 可被状态栏/Explorer/graph/timeline 并发触发）。5s 自变更窗口（`SELF_MUTATION_SUPPRESS_MS`）对整仓 sync 必然过期，其后续写入全被当外部漂移 → reconcile 窄查询洪流与 sync 竞争 background 并发槽。挂起期事件只计数、绝不进 `_externalChangePending`；`_flushExternalChanges` 顶部挂起分支保留队列**不重排定时器**；释放时重新 arm 尾巴窗口（`SYNC_TAIL_SUPPRESS_MS`，晚到的 RPC 事件回流）并补跑一次 sync 前入队的窄查询。
- **已知缺口（有意为之）**：挂起期间被丢弃的**外部**改动本 session 内不会被 re-derive——sync 后 refresh 只跑 `opened`/`changes`/`fstat`（不走工作区树），drift 只由每 session 一次的 reconcile 扫描 + 窄查询写入；成功路径 `_invalidateWorkspaceState()` 丢 checkpoint → 下次 session 重扫覆盖。Explorer 的 RC 徽标走 renderer 独立链（`ScmWorkingTreeHintService` + `checkWorkingTree`），不受影响。释放日志 `released external-change suspension (N watcher event(s) dropped)` 是量化盲区的判据。
- **诊断法**：状态栏数字冻结 ≠ UI 卡死。看 Perforce 输出频道：sync 期间持续有 reconcile 批 spawn（洪流）或完全没有新行（`--parallel` 静默期）都指向这里；真机验证判据=冻结期间 `磁盘 +N` 是否还在跳动。

## ⚠️ unresolved 信号只认 `fstat -Ru`——`opened` 从不报（真机实测）

P4D 2024.2 实测（PROBE-FINDINGS §11.5）：`p4 opened` 通篇没有 `unresolved` 键（`p4 help opened` 也不文档化），「需要合并」信号只在 `fstat` 的裸键 `unresolved` 与 `fstat -Ru <scope>`（只列有 unresolved 整合记录的文件；走 opened/have 表，45 万文件工作区 ~1.2s）里。

- `client._doRefresh` 仅在 `openedFiles.length > 0` 时跑 `fstat -Ru //...`（零 opened 整个跳过，绝大多数刷新零额外 p4 工作）；**失败保留上一次集合**（失败 ≠ 零 unresolved，参照 `runOpenedByOthersScan` 先例），成功零记录才真的清空。`openedParser.unresolved` 保留作防御并与 fstat 集合 OR；U 行由合并集合**标记 `OpenedFile`**（`{...f, unresolved: true}`）后喂 changelist 组 + resolve 置顶组。
- 探针是 background 优先级 + `FSTAT_UNRESOLVED_TIMEOUT_MS`（20s）紧超时——它在 refresh 链路里，绝不能占 interactive 预留槽或 600s 预算。
- 零 opened 时真机输出 `<scope> - file(s) not opened on this client.` exit 0（-Mj 下塌 data blob → `execRecords` 自动回退 -ztag → 解析成**零记录**，不是假记录）。
- fstat 的 `clientFile` 是本地路径——探针结果直接 `norm()` 建集合，绝不再翻译。
- e2e 死链已修：fake-p4 的 `opened` **不** emit unresolved、`fstat -Ru` 才 emit 裸键——`perforceResolve.spec.ts` 的 U 组断言因此真守这条链（revert 掉 client 探针 5 条全红）。
- `parseResolveOutput` 真机四形态（`- merging` / `Diff chunks:` / `- merge from` / `- ignored`）已识别，见 syncParser 注释与单测。

## ⚠️ 巨量 stdout 会撑爆 V8 字符串上限 → 扩展宿主崩溃（踩过）

**根因（宿主崩溃，`01eece1e` 落盘后才抓到堆栈）**：`_spawn` 曾无条件 `Buffer.concat(stdout).toString('utf8')`。超大 depot 上某条命令（`print` 巨型文件 / `describe` 巨型 CL）stdout 累积超过 **V8 单字符串上限 `0x1fffffe8`（≈512MB）**，`toString` 抛 `Cannot create a string longer than ...`——**从异步 `close` 回调抛出、无 try/catch → 冒泡成 `uncaughtException` → 整个 extension-host 进程 `exit(1)` 崩溃重启**（不只是这一条 p4 命令失败，所有扩展一起挂）。

- **现防护（`p4Service.ts` `_spawn`）**：边收边计 `stdoutBytes`，超 `DEFAULT_MAX_OUTPUT_BYTES`（256MB，远低于 512MB 限）即清缓冲 + `proc.kill()`，`close` 时优雅返回 `{stdout:'', stderr:'... exceeded NMB and was aborted', exitCode:1}`；`toString` 再套 try/catch 兜底病态输入。`P4ExecOptions.maxOutputBytes` 可按命令覆写（测试用小 cap 复现）。
- **红线**：`_spawn` 的 `close`/`data` 回调是**异步**的，里面任何 throw 都无处可接 → **必须 resolve 成失败结果，绝不让异常逃逸**。加任何新的流式/缓冲逻辑（大输出命令）都守住这条：p4 命令失败是一等公民（非零退出本就不 reject），宿主崩溃不是。
- **诊断法**：崩溃看 `<userData>/logs/<session>/extensionHost.log`（dev = `AppData/Roaming/Universe Editor - Dev/logs`），`uncaughtException` 堆栈直指 `extension.js` 行；`Buffer.toString` + `Cannot create a string longer than` 就是这个坑。测试见 `p4Service.test.ts`（`vi.mock('node:child_process')` 注入假子进程，`exec` 经并发门须 `await flush()` 再 emit）。

## ⚠️ p4 子进程永不退出 → 宿主无限挂起（44 分钟闩锁卡死）

`_spawn` 原本没有任何超时：一条 p4 命令 spawn 后若**永不退出**（凭据提示等待、服务器无响应、网络断在半开连接），`close` 事件永不来，promise 永不 settle。由于 renderer↔host RPC 也无全局超时，上游一层层等死——44 分钟后那条命令「成功」完成（子进程退出码 0），期间所有重试被 renderer 闩锁静默丢弃，零告警。这是「后台新 review 零通知」的头号根因（完整链路分析见 `src/swarm/CLAUDE.md`）。

- **SpawnWatchdog**（`p4Service.ts`）：每条命令带 deadline 定时器，到点 `proc.kill()`，`close` 时 resolve 失败结果（`stderr` 带 `timed out after Ns and was killed`，exitCode 1）。复用「巨量 stdout」同款防护通道与红线：**watchdog 回调是异步的，绝不 throw，只 resolve 失败**；onTimeout 先把 stderr 文案拼好，防止 kill 后 close 再覆盖。测试见 `p4Service.test.ts` 的 watchdog suite（假子进程 + fake timers）。
- **`perforce.commandTimeout`**（默认 600s，`0`=不限）：约束「永久挂死」而非「执行慢」——大 depot 的慢命令不受影响，只有真卡死才被强杀。**不约束内容传输写命令**（见下条 `CONTENT_TRANSFER_EXEC`）。经 `setP4CommandTimeoutSeconds` 在 `extension.ts` activate 时接线（含配置变更热更）。
- **`perforce.syncParallelThreads`**（默认 4，`0`=串行）：`p4 sync --parallel=threads=N` 的并行拉取线程数。硬前提是服务器开 `net.parallel.max`（默认 0 禁用），不支持时 p4 静默回落串行——客户端无需写降级。只加在真实 sync 的 args 上，预扫 `sync -n` 不带（不传输）。经 `client.setSyncParallelThreads` 接线（`extension.ts` 读配置 + 热更，`switchClient` 的 wiring 也带一份——换工作区后的新 client 也得拿到）。
- **凭据探针特例**：`swarmAuth.ts` 的 `p4 tickets` / `p4 login -s` 探针用 `CREDENTIAL_PROBE_TIMEOUT_MS`（15s）紧超时——ticket 探针本该毫秒级返回，15s 不返回就是挂死，不能让一次探针吃掉整条 600s 预算。
- **交互命令特例**：`INTERACTIVE_COMMAND_TIMEOUT_MS`（30s）+ `INTERACTIVE_EXEC = { priority: 'interactive', timeoutMs }`——用户点击/悬停触发的**元数据读**（open diff 的 fstat / gutter / blame / timeline pending 探针 / `diff -se`）本该亚秒返回，30s 不返回就是挂死，立刻 toast 失败而非让用户盯死 UI。与 `CREDENTIAL_PROBE_TIMEOUT_MS`（15s）/ `SHELVED_DESCRIBE_TIMEOUT_MS`（30s）同属「紧超时先例」：**能明确「正常该多快」的命令给紧超时；「执行慢但合理」的走 600s 预算；耗时随数据量线性增长的内容传输只给优先级、不套紧超时**。
- **内容传输例外（`INTERACTIVE_CONTENT_EXEC = { priority: 'interactive' }`，无 `timeoutMs`）**：`p4 print` 传输的是**整个文件内容**，延迟 = 文件大小 ÷ 带宽，跟挂死无关——5MB 文件在慢 VPN 上 40s 是正常不是卡死。所以 print 只插队（拿预留槽 + 压过后台批量），**不套 30s 紧超时**（省略 `timeoutMs` 回落 `perforce.commandTimeout` 的 600s 预算）。给 print 套 30s 会误杀大文件 diff（watchdog 强杀 → openChange 弹「timed out」且不 fallback，这是本轮引入过的用户可见回归）。判据就一条：**耗时随数据量增长的给优先级不给紧超时；能断言「正常该多快」的给紧超时**。
- **内容传输写命令豁免 600s（`CONTENT_TRANSFER_EXEC = { timeoutMs: 0 }`）**：上一条管**读**（print），本条管**写**——`sync` / `submit` / `shelve` / `unshelve`（含 `unshelveFiles`）/ `revert`（plain + `-c`）/ `clean`。这些命令的耗时随**传输字节数**线性增长（整仓 sync 合法跑几十分钟），600s 兜底会把「慢但健康」误判成「挂死」在传输中段强杀。`timeoutMs: 0` 让 SpawnWatchdog 不武装（`Number.isFinite(0) && 0 > 0` 为假），与 `commandTimeout` 的 `0`=不限同义。**豁免判据（唯一权威）**：耗时随传输字节数增长 → 豁免；随文件数**扫描**增长 → 保留 600s（扫那么久本身就是服务器锁争用，正是 watchdog 的意义）。**硬约束**：豁免的命令必须经 `client._cancellable` 注册取消源——没了 watchdog，状态栏/通知的「点取消」就是唯一逃生阀，故 `unshelveFiles` / `_unshelveFilesIndividually` 这两处原本无 signal 的也先包 `_cancellable` 再豁免。不带 `priority`：background mutation 体量大，占交互预留槽会饿死 fstat。**保留 600s 不动**：edit/add/delete/reconcile/reopen/revert `-a`/`-k`/resolve/change -d/shelve -d（元数据/扫描型）与预扫 `sync -n`。
- **P4ExecOptions.timeoutMs** 可按命令覆写（测试用小值复现挂死）。

## ⚠️ 中文/非 ASCII 路径经 argv 传给 p4 会乱码；超长 argv 会 ENAMETOOLONG（已修复：`-x` argfile）

**现象（修复前）**：unicode-enabled 服务器 + `P4CHARSET=utf8` 环境下，对含中文的 depotFile 跑 `p4 print`（Swarm review diff、图谱文件 diff 都走它）报 `Perforce client warning: No Translation for parameter ...` exit 1 → `printRevision` 静默 `return ''` → **diff 两侧全空**（纯 ASCII 路径正常，极具迷惑性）。另一条：对含上万文件的 DEFAULT 组头「移出 Changelist」（`revert -k` 展开全部路径）报 `spawn ENAMETOOLONG`，经 RPC 冒成 wire error。

- **乱码根因**：Windows 上 Node `spawn('p4', argv)` 用 `CreateProcessW` 传 UTF-16 argv；p4.exe 的 CRT `main` 按**系统 ANSI 代码页（cp936/GBK）**转回字节。而 `P4CHARSET=utf8` 让 p4 期望 argv 是 UTF-8 → GBK 字节里的中文无法翻译。
- **超长根因**：Windows `CreateProcess` 命令行上限约 32767 字符。组头操作展开全部路径后一次性 `spawn('p4', ['revert','-k', ...paths])`，ASCII 路径原先不走 `-x`，17k 条轻松超限。Node 常见路径是创建 ChildProcess 后 `error` 事件（也曾同步 throw）；原先 `proc.on('error')` 直接 reject → RPC。
- **已实测的死路（乱码）**：env 注入 `P4COMMANDCHARSET=winansi`（CP1252 ≠ 系统 ANSI）；`=cp936`（机器相关，不可作通用修复）；清空 `P4CHARSET`（改变用户既有配置语义，副作用大）。
- **修复（`p4Service.ts`）**：p4 全局选项 **`-x <argfile>`**——`prepareSpawnArgs` 在 `_spawn`/`execBinary` 层统一检测：
  - 切分点取 `min(首个非 ASCII, 超 `MAX_PATH_ARGS_CHARS`（8000）处)`：非 ASCII 从不留在 argv（进 UTF-8 临时 argfile）；巨型列表即使混入一个中文路径，命令行仍有界。
  - `reason: 'encoding'` 表示切在首个非 ASCII；`reason: 'length'` 表示切在长度预算。第一项就超则整段进文件。
  - 短 ASCII 命令零开销，不写临时文件。
  - p4 把 argfile 参数追加在命令行参数之后，顺序不变；`-x` 前置。命令结束同步删临时文件；写失败也会 best-effort 删半写文件。
  - **写文件失败**：仅当原 argv 未超 budget（纯 encoding 短命令）才回退直传；原 argv 已超长（length 切，或 encoding 切但列表本身已超）**禁止回退**，调用方不 spawn，resolve exit 1。
  - **ENAMETOOLONG/E2BIG**（`spawn()` 同步 throw 或 `error` 事件）一律 resolve `{exitCode:1}`，**不 reject**。ENOENT（p4 缺失）仍 reject。异步回调绝不 throw（宿主崩溃红线）。
  - spawn 日志逐项累计截断（前 500 字符 + 参数个数），禁止把上万路径 `join` 成大字符串。
  - 纯切分逻辑 `splitArgsForArgfile` 已导出，单测见 `p4Service.test.ts`；e2e 的 fake-p4 已支持 `-x`（`swarmReview.spec.ts` 有中文路径 review diff 回归用例）。
- **不在 `_mutate` 里按批切 mutation**：`-x` 是 p4 原生大参数通道（一条命令、原子、不灌满 `ConcurrencyGate`）。读路径的 `chunkByLength`（`reconcile -n` / `ignores` / `where`）保持分批，限制单次输出体积。
