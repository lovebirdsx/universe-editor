# extensions/perforce/CLAUDE.md

一等（trusted）SCM 插件，与 git 扩展地位对等：在 extension-host 进程里 `spawn('p4', argv)`，把 Perforce client 经 VSCode 式 SCM API 呈现成侧栏源代码管理提供方；另含 Perforce Graph（历史图谱）与 Helix Swarm（代码审核）两个子模块。本文是三者的上下文地图（处理相关任务前通读）。

## 扩展内置 Perforce（p4）插件

`extensions/perforce` 在 extension-host 进程里 `spawn('p4', argv)`，把一个 Perforce client（workspace）通过 VSCode 式 **SCM API**（`scm.createSourceControl`）呈现成侧栏源代码管理提供方。功能深度已覆盖 core + advanced（连接/登录、changelist 分组、edit/add/delete/revert、submit、diff、编号 changelist 管理 + reopen、shelve/unshelve、resolve、autoEdit、dirty-diff、annotate blame）**+「收集修改」体验对齐 git**（待收集/reconcile 置顶分组 + 一键收集、explorer/editor 签出入口、聚焦刷新、组级还原、状态栏计数）。

> ⚠️ **头号红线（务必逐字保持）**：密码 / ticket **绝不进明文 settings/aiSettings/线协议**。登录只把密码经 **stdin** 喂给 `p4 login`（`client.ts` `login()`），ticket 由 `p4` 自身按 `P4TICKETS` 机制保存，插件**不自管凭据**。任何新功能都不得把凭据落盘、打日志、或经 RPC 明文传。
>
> 先读 skill `create-extension`（插件通用骨架、manifest 贡献点、engines 红线、NLS）——本文档只讲 p4 特有的东西。

## 分层架构（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| 并发门控 | `concurrency.ts` | `ConcurrencyGate`：每 client 一个 FIFO 并发门；`run(task, priority?, onStart?)` 双队列（`interactive`/`background`），**静态预留 1 槽**——background 硬顶 `max - reserve`（默认 4→3），interactive 优先出队且可用全部 `max`；`setMax` 重算 `_backgroundCap` 后 `_drain` |
| CLI 封装 | `p4Service.ts` | `spawn('p4', argv)`（**数组、`shell:false`**，绝不拼 shell 串）；`exec`/`execJson`(`-Mj`)/`execTagged`(`-ztag`)；连接全局选项 `-p/-u/-c`；**env 净化**（剥离 `ELECTRON_*`/`NODE_OPTIONS` 防被劫持）；经 `ConcurrencyGate` 限并发。**非零退出不 reject**，只有 spawn 失败（p4 缺失 ENOENT）才 reject |
| 输出解析 | `p4Output.ts` | 纯函数：`parseMarshalJson`（`-Mj` 每行一 JSON）、`parseZtag`（`... key value`，空行分记录）、`collapseNumberedKeys`（`depotFile0/1/…` 并行键折叠成数组）。**全部纯、可对 fixture 单测** |
| 领域解析 | `openedParser.ts` `fstatParser.ts` `shelveParser.ts` `blameSource.ts` `changeSpec.ts` `changelist.ts` `filelogParser.ts` `cstatParser.ts` | 把 p4 记录 → 领域模型 / 分组。**纯，无 p4 I/O**，各带 `__tests__` |
| 连接发现 | `clientDiscovery.ts` | 无连接 `p4 -ztag info` 解析 client/root/user（**不取 port**，见下节红线）；`perforce.port/user/client` 兜底；folder 不在 p4 workspace 内 → 返回 undefined（禁用 provider） |
| client 编排 | `client.ts` `clientManager.ts` `baselineProvider.ts` | `PerforceClient` = 一个 client 一个 `SourceControl` + 动态 changelist 分组 + refresh 编排 + 所有 p4 操作方法；`ClientManager` 按 root 路由；`BaselineProvider` = `#have` 内容缓存（`depotFile#rev` 键） |
| 入口 & UI 挂钩 | `extension.ts` `p4StatusBar.ts` `autoEdit.ts` `p4Decoration.ts` `p4Error.ts` `nls.ts` | `activate` 发现 client → 注册全部命令；状态栏、autoEdit、行装饰、错误分类/toast、本地化 |

**加一个新 p4 能力的典型路径**：`client.ts` 加一个方法（多半一行 `this._mutate(...)`）→ `extension.ts` 注册对应命令 → `package.json` 加 command + menu 项 + nls 两文件。若要新解析逻辑，先在纯解析模块写 + 单测。

## ⚠️ 共享 FIFO 并发门被大扇出灌满 → 交互命令排队几分钟（本轮根因）

**根因（实测）**：所有 p4 命令共用一个上限 4 的 FIFO 并发门（`ConcurrencyGate`）。用户在有 9115 条待收集改动的 workspace 点 SCM 文件行，磁盘复核把 9115 条候选切成 ~114 批 `reconcile -n` 用 `Promise.all` 一次性提交，**灌满门数分钟**；点击触发的 `p4 fstat` + `p4 print` 排在 FIFO 队尾，于是 diff 要等几分钟才打开。

**为什么是静态预留而非动态**：动态（比如「interactive 可以插队」）仍会让大扇出先占满所有槽，点击只能在队尾等；静态预留一个槽（background 硬顶 `max - reserve`，默认 4→3）保证任何时候都留着一个槽给 interactive，用户点击永远先于后台批次。**为什么 background 硬顶在 `max - reserve` 而非软上限**：软上限 = 没任务时后台也能用满 `max`，一旦某个 refresh 正好在点击前扇出，槽又被占满，预留失效。`reserve` 是「background 的静态天花板」，不是「background 的地板」。

**interactive 标记判据（最终清单，加新 p4 命令照此办）**：用户点击/悬停触发的读、且用户要等它才能看到东西 = interactive；扫描 / 轮询 / 批量（reconcile 复核、refresh、后台扇出）= background（默认）。**超时选用**：能断言「正常该多快」的元数据读 → `INTERACTIVE_EXEC`（30s 紧超时）；耗时随数据量线性增长的内容传输（`print`，以及巨型 CL 上 GB 级输出的 `describe -s`/`describe -S -s`）→ `INTERACTIVE_CONTENT_EXEC`（只提优先级，保留 600s 预算）。

- **interactive（已标）**：`fstat`（gutter/Timeline/openChange diff）、`print`（diff/baseline 内容，CONTENT）、`annotate` + `changes -l`（blame）、`diff -se`（timeline pending 探针）、`filelog`（Timeline 视图/切活动编辑器）、`changes -s submitted`（开图谱）、`describe -s`（点图谱节点，CONTENT）、`opened` 经 `_openedFiles`（图谱 pending 节点）、`where` 经 `_whereLocalPaths`（图谱/Swarm 读调用方）、`describe -S -s` 经 `describeChangeFiles`（展开 Swarm review，CONTENT）。
- **刻意不标（background 默认）**：refresh 的 `opened`/`changes -s pending`、`_fetchShelved` 的 `describe -S -s`（带 30s 紧超时）、`reconcile -n` 全扫/增量批、`deleteChangelist` 的 `describe -S -s`、`_applyCommittedChange` 的 `print`/`where`、他人占用扫描的 `opened -a`（带 20s 紧超时，见下「他人占用」节）——这些是 mutation 或后台扇出，不是点击读。
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
- **回归护栏**：`smoke.perforceCollectChanges.spec.ts` 的 `phantom delete @regression`——点 reconcile 行 → 断言 diff 的 modified 侧 == 真实盘上内容（不是空）。改坏 `clientToLocalPath` 会红。单测见 `pathUtil.test.ts`/`openedParser.test.ts`/`reconcileParser.test.ts`。

## ⚠️ sync 拒绝有**两个**形态，只解析一个就会谎报「已是最新」（踩过）

`p4 sync` 拒绝更新本地已改动的文件时，形态**取决于 client 的 `Options`**，两者结构完全不同，**必须都解析**（真机实测见 PROBE-FINDINGS §13）：

| | `allwrite noclobber`（游戏项目常见） | `noallwrite` clobber |
|---|---|---|
| 文案 | `can't update modified file` | `Can't clobber writable file` |
| 通道 | **stdout** | **stderr** |
| exit | **0** | **1** |
| 范围 | **只跳过该文件**，其余照常更新 | **中断整次 run** |
| `-ztag` | 行**照样在 raw stdout**，只是没有结构化记录（无 `... key value` 前缀，被 `parseZtag` 丢弃）——`previewSync` 因此能从 `result.stdout` 捞回来 | 走 stderr，不受影响 |
| `-Mj` | 塌成 `{"data":…}` blob | 同上 |

- **曾经的 bug**：只有 clobber 被解析 → allwrite client 上 `parseSyncOutput` 四个正则全不命中（`APPLIED_LINE` 要求 ` - ` 后紧跟 `updated`/`updating`/…，实际紧跟 `can't`）→ 全零 summary → `runSync` 弹「已是最新版本」= **假成功**，用户被送走时以为落后的文件已是最新。同一根因让 `previewSync`（走 `execTagged`）拿到零记录报 `upToDate`，窄作用域下落后计数与 Explorer 灰字一并消失，与 rev chip 的 `↓#head` 自相矛盾。
- **现行**：`REFUSED_MODIFIED_LINE` → `SyncRunSummary.refusedModified`（并使 `unrecognized` 转假）；纯函数 `parseSyncRefused` 把 plain 行折回 `SyncPreviewFile[]`（`action: 'not updated'`），`previewSync` 并进 `files` 使三处信号一致（`total` 仍只读 records —— `totalFileCount` 已含拒绝行，别叠加）。`sync()` 顺带把 `refusedFiles` 带出来供「查看差异」用，避免再跑一条可能与用户所见不一致的 p4 命令。
- **分支顺序即优先级**：`refusedModified > 0` 排在 `upToDate` 之前（一次多 filespec run 可同时产生两者，报被拒绝的更有行动价值）。**「什么都没解析出来」绝不能再回落成「已是最新」**——那是最坏的答案（与成功不可区分），现在报「没有返回可识别的结果」+ 打开输出频道按钮。
- **`-f` 是逃生阀，不是默认补救**。p4 拒绝的唯一原因就是文件里有未收集的工作，而 `sync -f` 会永久销毁它（§11.2 已实测覆盖本地草稿）。所以三条硬约束缺一不可：① 它只能作为**显式按钮**出现（绝不自动重跑成 `-f`）；② 点击后必须走 `confirmForceGet()` **二次确认**，文案明确「未收集的改动将丢失、不可撤销」；③ 默认路径仍是先收集——按钮顺序固定为 `收集改动 → 查看差异 → 强制拉取`（收集是无损的、p4 会排合并，故领先；force 排在看过 diff 之后）。按钮集由纯函数 `refusedSyncButtons({refusedModified, mustResolve, allowForce})` 拼装（`extension.ts`，带单测）；`allowForce` 在本次 run 已经是 `-f` 时为 false——同样的拒绝再给一次 force 只会原地打转。clobber 分支同样给 force，但**不给「查看差异」**：它走 stderr/exit 1，`refusedFiles` 从 stdout 解析故为空，没有 per-file 本地路径可 diff。
- **「查看差异」直调 `target.openChange`，不要绕回 `perforce.openChange` 命令**。runSync 已经持有发起这次 get 的 client；命令版会用 `resolveClient` 从路径重新解析，而它在无 root 命中时回退 active repository——那是命令路由语义，对一个我们已知归属的文件是错的。
- **加任何新的 sync 输出解析前**：先想「这条行走 stdout 还是 stderr、exit 几、中断还是跳过」四问，四个答案都不同就是两个形态。

## ⚠️ 状态栏条目无法传参 → 作用域级与文件级拉取必须是两个命令

`StatusBarItem`（`packages/extension-api/src/index.ts`）只有 `command: string | undefined`，**没有 arguments 字段**。behind 项（「N 个可更新」）曾复用 `perforce.syncLatest`，而后者无参时回退到活动编辑器文件 → **说「N 个可更新、拉整个作用域」，实际只拉一个文件**；若活动文件恰好不落后还会弹「已是最新」而那 N 个仍然落后。现在 behind 项指向独立的运行时命令 `perforce.syncScope`（无菜单/命令面板入口，与 `perforce.cancelBusy`/`reopenTo` 同款先例，规避 renderer Action2 遮蔽坑），rev chip 保持 `perforce.syncLatest`（per-file 语义，回退活动编辑器恰是它描述的那个文件）。**给状态栏加需要「同一动作不同作用域」的入口时，一律加命令，别想着传参。**

**本轮把 behind 项的一次性 `#head` 跳转变成了「选变更列表」**：`perforce.syncScope` 现在先 `pickBehindChangelist`（QuickPick：第一项固定「最新版本」`#head`，等价旧行为；其后按新→旧列本工作区尚未完全同步的已提交 CL，`partial` 额外标「部分已同步」；末项「更早的变更列表…」手动输号），选定后 `runSync(spec, { resolveTotal })`。`perforce.syncScope` **仍是运行时命令**（不进 `contributes.commands`），仍是 behind 项唯一调用方——只是交互从「点击即拉」变成「选完再拉」。落后的 CL 列表与流式进度条见下面两节。

## ⚠️ `sync -n` 反推不出「落后了哪些 CL」→ 落后 CL 列表用 `changes` + `cstat` 两条命令

**根因（真机实测）**：`p4 -ztag sync -n` 的 `change` 字段是**首条记录里的一个全局总量**（"这次 sync 会把你带到哪个 CL"），不是每文件的 changelist——既有的落后计数链路只能回答「落后多少个文件」，回答不了「落后了哪些 CL」（PROBE-FINDINGS §1 记录该字段、§12.3.0 记录记录数/`totalFileCount` 语义，佐证它无从按文件反查 CL）。而 `cstat` 是唯一能回答「这个 client 缺哪些 CL」的命令。

**现行（两条命令，都 interactive——用户点了在等）**：
- `p4 changes -s submitted -l -m 51 <scope>` 列最近历史带描述（读 change 表，实测 97–500ms，复用图谱的 `parseChangesList`；`+1` 探「还有更早的吗」，与图谱翻页同款）。
- `p4 cstat <scope>@<最旧列出的CL>,#head` 把这些 CL 分类成 have/need/partial（新纯解析 `src/cstatParser.ts` `parseCstat`，未知 status 丢弃不猜——误判成 need 会推一个其实已经同步的 CL）。

**cstat 必须带修订范围**：无界 cstat 输出随文件数线性增长（PROBE-FINDINGS §9 实测 2.1s / 279KB），范围由「最旧列出的 CL」界定，工作量才与展示窗口（最多 50 条）成正比。

**红线（降级与诚实）**：cstat 失败 / 超时 / 零记录一律降级为「最近的变更列表（未分类）」+ 打 `[perforce] behind-list: ...` 日志——`BehindChangelistResult.classified=false` 由调用方把占位文案改成「无法分辨哪些已同步，仅列最近」；**绝不静默、绝不谎报「已是最新」**（那与成功不可区分，是下面 sync 解析节记过的最坏答案）。`changes` 失败则 `ok:false`，直接报错不给列表。

## ⚠️ `P4Service` 首条流式通道：`P4ExecOptions.onStdoutLine`（sync 进度条数据源）

`sync` 需要逐文件推进的进度条，而 p4 每文件吐一行 stdout——这是本扩展第一条**流式**通道（`p4Service.ts` 新增 `onStdoutLine` 逐行回调，边收边回调，`carry` 存半个行跨 chunk 不拆行）。与既有「巨量 stdout」「子进程永不退出」两节**同款红线**：回调跑在异步 `data`/`close` handler 里，**必须 try/catch 吞掉用户回调的异常**（只记 `onStdoutLine callback threw` 日志），否则 uncaughtException 杀掉整个 extension host；超出 `maxOutputBytes` overflow 后停止回调（`if (overflowed) return`）。

- **单一真相**：逐行判定与最终 summary **共用** `syncParser.ts` 的 `classifySyncLine`（流式只驱动 UI，权威结果仍来自完整输出的 `parseSyncOutput`）——进度条永不会与结尾 summary 漂移；`syncLineFile` 从行里抠文件名显示。
- **UI 侧 150ms 节流**（`extension.ts` 的 `PROGRESS_REPORT_INTERVAL_MS`）：p4 每文件一行，不节流就是上万条 RPC。本扩展**首次用** `window.withProgress`（`ProgressLocation.Notification`，带 increment 百分比 + `cancellable`）；取消按钮路由到 `target.cancelBusy()`，与状态栏 spinner 同一 abort 机制，不搞两套。
- **总数拿不到就退化为不确定进度条**：`syncScope` 的 `resolveTotal` 对 `#head` 免费（落后检查已数过 `status.syncBehindCount`），其它 spec 才跑一次 `previewSyncTotal(spec)` dry-run；拿不到只显示已处理文件数，**绝不编总数**（编一个到 40% 就停的总数比没有总数更糟）。同步照常进行。

## ⚠️ unresolved 信号只认 `fstat -Ru`——`opened` 从不报（真机实测）

P4D 2024.2 实测（PROBE-FINDINGS §11.5）：`p4 opened` 通篇没有 `unresolved` 键（`p4 help opened` 也不文档化），「需要合并」信号只在 `fstat` 的裸键 `unresolved` 与 `fstat -Ru <scope>`（只列有 unresolved 整合记录的文件；走 opened/have 表，45 万文件工作区 ~1.2s）里。

- `client._doRefresh` 仅在 `openedFiles.length > 0` 时跑 `fstat -Ru //...`（零 opened 整个跳过，绝大多数刷新零额外 p4 工作）；**失败保留上一次集合**（失败 ≠ 零 unresolved，参照 `runOpenedByOthersScan` 先例），成功零记录才真的清空。`openedParser.unresolved` 保留作防御并与 fstat 集合 OR；U 行由合并集合**标记 `OpenedFile`**（`{...f, unresolved: true}`）后喂 changelist 组 + resolve 置顶组。
- 探针是 background 优先级 + `FSTAT_UNRESOLVED_TIMEOUT_MS`（20s）紧超时——它在 refresh 链路里，绝不能占 interactive 预留槽或 600s 预算。
- 零 opened 时真机输出 `<scope> - file(s) not opened on this client.` exit 0（-Mj 下塌 data blob → `execRecords` 自动回退 -ztag → 解析成**零记录**，不是假记录）。
- fstat 的 `clientFile` 是本地路径（见下节）——探针结果直接 `norm()` 建集合，绝不再翻译。
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
- **`perforce.commandTimeout`**（默认 600s，`0`=不限）：约束「永久挂死」而非「执行慢」——大 depot 的慢命令不受影响，只有真卡死才被强杀。经 `setP4CommandTimeoutSeconds` 在 `extension.ts` activate 时接线（含配置变更热更）。
- **凭据探针特例**：`swarmAuth.ts` 的 `p4 tickets` / `p4 login -s` 探针用 `CREDENTIAL_PROBE_TIMEOUT_MS`（15s）紧超时——ticket 探针本该毫秒级返回，15s 不返回就是挂死，不能让一次探针吃掉整条 600s 预算。
- **交互命令特例**：`INTERACTIVE_COMMAND_TIMEOUT_MS`（30s）+ `INTERACTIVE_EXEC = { priority: 'interactive', timeoutMs }`——用户点击/悬停触发的**元数据读**（open diff 的 fstat / gutter / blame / timeline pending 探针 / `diff -se`）本该亚秒返回，30s 不返回就是挂死，立刻 toast 失败而非让用户盯死 UI。与 `CREDENTIAL_PROBE_TIMEOUT_MS`（15s）/ `SHELVED_DESCRIBE_TIMEOUT_MS`（30s，见搁置节）同属「紧超时先例」：**能明确「正常该多快」的命令给紧超时；「执行慢但合理」的走 600s 预算；耗时随数据量线性增长的内容传输只给优先级、不套紧超时**。
- **内容传输例外（`INTERACTIVE_CONTENT_EXEC = { priority: 'interactive' }`，无 `timeoutMs`）**：`p4 print` 传输的是**整个文件内容**，延迟 = 文件大小 ÷ 带宽，跟挂死无关——5MB 文件在慢 VPN 上 40s 是正常不是卡死。所以 print 只插队（拿预留槽 + 压过后台批量），**不套 30s 紧超时**（省略 `timeoutMs` 回落 `perforce.commandTimeout` 的 600s 预算，见 `p4Service.ts` `_spawn` 的 `options?.timeoutMs ?? this._defaultTimeoutMs`）。给 print 套 30s 会误杀大文件 diff（watchdog 强杀 → openChange 弹「timed out」且不 fallback，这是本轮引入过的用户可见回归）。判据就一条：**耗时随数据量增长的给优先级不给紧超时；能断言「正常该多快」的给紧超时**。
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

## SCM 分组模型（与 git 根本不同）

git 是「staged / working 两个固定组」；p4 是「一个文件属于**恰好一个 pending changelist**」→ 视图是**动态分组**：默认 changelist（组 id `default`，永远显示）+ 每个编号 changelist（组 id `cl:<n>`）+ 每个 CL 的搁置文件（组 id `shelved:<n>`）。

- 分组纯逻辑在 `changelist.ts` 的 `groupChangelists()`（喂 `p4 opened` + `p4 changes -s pending`）。
- `client.ts` `_applyGroups()` 用 `DesiredGroup[]` **对账** live ResourceGroups：新建 / 更新 label+states / dispose 消失的。**不要每次全量重建组**（会闪烁 + 泄漏）。
- 组 id ↔ changelist id 互转：`numberedGroupId`/`shelvedGroupId`/`changelistIdFromGroupId`。组作用域命令靠宿主附在 group action 上的 `scmResourceGroupId` 定位 CL（见 `extension.ts` `groupChangelistId`）。
- `sc.count` = 打开文件总数（不含搁置）；`acceptInputCommand`/`acceptInputActions` 在默认组有文件时挂 Submit / Revert Unchanged。

## 「收集修改」= 待收集(reconcile)分组（对标 git untracked/modified）

**根因**：git 面板 = 磁盘真相（`git status`），p4 面板 = 服务器 `p4 opened`（只显示**已签出**的文件）→ 磁盘上改了/建了/删了但没签出的文件面板看不到，形成「改了看不到、想签点不到」死结。补法是一个**固定置顶分组**「待收集的改动」（组 id `RECONCILE_GROUP_ID = 'reconcile'`，`changelist.ts`）。

- **发现**：`p4 reconcile -n -a -e -d //...`（`-n` = **dry-run，绝不改服务器**）报告偏离 depot 的文件；`reconcileParser.ts`（纯函数 + 单测）把记录 → `ReconcileFile[]`（字段同 `opened`：depotFile/clientFile/action/rev）。`client.ts` `_refreshReconcile()` 跑它并**过滤掉已 opened 的路径**（用 `norm()` 比对，防同一文件双列）。
- **收集**：`reconcile()` / `reconcileAll()` 跑**真** `p4 reconcile -a -e -d`（去掉 `-n`），文件签出进 changelist、离开待收集组。
- **⚠️ 收集后的复核是后台异步的（去卡顿，踩过）**：`_mutate` 的 spinner 原本包住「收集命令 + 一整条全 client refresh」，其中最贵的是**对待收集组全部历史候选重跑 `reconcile -n`**（O(候选数)，大 workspace 上千条）——单文件收集的命令本身 O(1)，用户看到的长时间转圈全来自它。现在 cheap path 一律「**同步按最新 `_openedPaths` 过滤 → 立即 `_setReconcileFiles(candidates)` 渲染**（刚收集的文件正确离组）→ `_scheduleBackgroundReverify` 把磁盘复核挂后台」，**`deferReconcileReverify` 参数链已整体删除**（旧实现只对三个收集方法后台化，参数在 `_mutate`/`refresh`/`_refreshAfterMutation`/`reconcile*` 间串，改动面大且漏改即静默回退成同步）。`_scheduleBackgroundReverify` 有**防重入守卫**（`if (this._backgroundReverify) return`）——连续多次 refresh 只调度一次后台复核，不堆叠 N 次全量重扫；且**必须先跨一个 macrotask 边界**（只挂 `_runSerial` 会被调用方的 `await` 顺带 drain 掉，等于没延后，单测正是这么红的）。候选 > `RECONCILE_REVERIFY_MAX_PATHS`（1500）时磁盘复核**整个跳过**（见下「性能门控」）。取舍：后台复核完成前，其余陈旧候选会短暂滞留数秒；`perforce.autoRefresh=false` 时滞留更久（无文件监视自愈），靠下次刷新收敛。**fullScan（Clean Refresh）永不延后**——那是用户显式要的全量扫描。`whenBackgroundReverifySettled()` 供测试等待。
- **批次并行**：`_rescanReconcilePaths` 的 `chunkByLength` 批次用 `Promise.all` 并行提交（`ConcurrencyGate` 限流），**但必须按批序合并** `scanned`/`fresh` —— `mergeReconcile` 对 `fresh` 顺序敏感，乱序会改变待收集组行序。单批 `execRecords` 套 try/catch（spawn ENOENT 不再连坐整条 refresh）；失败批不计入 `scanned` 从而保留旧条目。
- **watcher 回环消噪**：真 `p4 reconcile`/`p4 edit` 会清只读位 → 触发 watcher → 对**已签出**文件跑 `reconcile -n` 报错（纯噪音）。`refreshReconcilePaths` 在 `_runSerial` 任务**内部**（确保读到最新 `_openedPaths`）过滤掉已签出路径，全空直接 return。
- **分阶段 busy 文案 + 耗时打点**：`_busyOps` 是栈、栈顶即状态栏文案 → `_refreshAfterMutation` 把 refresh 包进第二层 `_withBusy('Refreshing')`，用户看到「正在收集改动…」→「正在刷新…」，立刻知道收集本身已成功。`_doRefresh` 对 opened / changes+shelved / reconcile 各打一条 `[perforce] refresh/<stage> Nms` + 一条 total，配合 `p4Service` 的逐命令 `exit N (Xms)` 拼成完整链路（打开 Perforce 输出频道自查慢在哪步）。reconcile stage 的 label 由 `_refreshReconcile` 的返回枚举拼出，每条路径都要如实：`reconcile`（fullScan 真跑了全扫）、`reconcile(deferred)`（cheap path 后台复核已调度）、`reconcile(skipped)`（超阈值整个跳过）、`reconcile(none)`（发现关闭或零候选，零 p4 工作）。**不要改成逐阶段推 busy 标签** —— 每次 `_emitChange` 波及 polling/timeline 订阅者。
- **性能门控（关键取舍）**：reconcile 扫描在大 workspace 慢，**默认不在每次 refresh 跑**。`_reconcileActive` 粘性开关：`refresh({reconcile:true})`（cleanRefresh）/ 收集操作 / `perforce.autoReconcile` 才开启；关闭时 `_refreshReconcile` 直接清空组返回，**零额外 p4 调用**。**超阈值跳过（用户确认的取舍）**：cheap path 的磁盘复核在候选 > `RECONCILE_REVERIFY_MAX_PATHS`（1500）时整个跳过——9115 条候选会切成 ~114 批 `reconcile -n` 用 `Promise.all` 灌满并发门几分钟（「点击几分钟打不开 diff」的头号根因）；跳过的那条尾巴靠 file-watcher 增量 + 手动 Clean Refresh 收敛，**绝不静默**（打 `[perforce] reconcile re-verify skipped: N candidates exceed 1500` 日志）；opened-set 过滤仍同步执行，刚收集的文件照常离组。
- **固定组生命周期**：reconcile 组在**构造函数里第一个** `createResourceGroup`（SCM 视图按创建序渲染 → 保证置顶），`hideWhenEmpty=true`，**不进 `_groups` Map**（`_applyGroups` 对账不碰它，避免被 dispose），`dispose()` 里单独释放。
- **行 contextValue = `RC`**（`p4Decoration.ts` `toReconcileResourceState`），与已签出行区分，menu `when` 用 `scmResourceState == RC` 单独挂「收集」inline。
- **cleanRefresh 正名**：原来与普通 refresh 等价（占位），现在 = 带 reconcile 发现的全量刷新。
- **持久化 + 启动秒开**：reconcile 组不再是纯派生——`_reconcileFiles` + `_dismissed` 经注入的 `ReconcileStore` 落盘（`extension.ts` 用 `context.workspaceState`，key = `perforce.reconcile.<normRoot>` 按 client root 分 repo）。构造后、首个 refresh 前调 `client.restoreReconcile()`：载入快照 + `_reconcileActive=true` + 渲染，**不设 `_fullScanRequested` → 启动不跑 `reconcile -n`**；首个普通 refresh 走 cheap path 按最新 `opened` 过滤已签出项即可自洽。写入统一收敛在 `_setReconcileFiles`（过滤 dismissed → 存 `_reconcileFiles` → 渲染 → `_persistReconcile`）。`_goOffline` 只清 UI 不清盘。`create`/构造函数新增可选 `store?` 参数，测试省略 = 纯内存 no-op。
- **移出列表（永久忽略 = dismissed）**：`_dismissed: Set<string>`（normalized clientFile）。`dismissReconcile(paths)` 加入并落盘；`filterDismissed`（`reconcileParser.ts` 纯函数）在 `_setReconcileFiles` 末端统一过滤 → 即使 Clean Refresh 全量扫到也不冒出来。文件夹/组目标经 `expandDismissPaths`（纯函数，按 `norm` 前缀展开成当前列表里的具体条目；组头传 `<root>/...`）。`clearDismissed()` = 逃生阀（清空 + `refresh({reconcile:true})`）。**收集/移出会解除 dismiss**：`reconcile()`/`moveToReconcile()` 成功前调 `_undismiss(paths)`（显式重新纳入视野）。命令 `perforce.dismissReconcile`（icon `eye-off`，挂 RC 行 inline + reconcile 组/文件夹）、`perforce.clearDismissed`（reconcile 组头）。
- **move out 增量化（去卡顿）**：`moveToReconcile`/`revertReconcile` **不再** `_fullScanRequested=true` 跑全量 `reconcile -n <scope>`，改为对已知 path 调 `refreshReconcilePaths(paths)`（O(改动数)）。目录版先 `_concreteReconcilePaths`（剥 `/...` 后缀 + `expandDismissPaths`）展开成具体条目再增量扫。测试 `clientReconcilePersist.test.ts` 断言移出后所有 `reconcile -n` argv **不含** `//...` / `<root>/...`。

### Explorer 按需 hint 通道（`checkWorkingTree`）

上面那个 `_reconcileActive` 粘性开关有个用户可见后果：**冷启动且无持久化快照时它是 false → reconcile 组恒空 → Explorer 里「改了但没签出」的文件零提示**（git 侧同类文件是有的）。补法**不是**打开全量扫描（那正是「点击几分钟打不开 diff」的根因），而是加一条**由 Explorer 当前渲染出来的文件行驱动**的按需查询通道——成本与可见行数同阶，与 depot 规模无关。

链路：renderer `ScmWorkingTreeHintService`（pull 式，骨架照抄同目录 `ScmIgnoredResourcesService`：render 期问 → 150ms 去抖批量 → 缓存 + LRU 4096 → `version` observable 触发重渲染）→ capability 命令 `perforce.checkWorkingTree`（**运行时注册，绝不进 `contributes.commands`**，同头号坑）→ `client.checkWorkingTree(paths)` → 复用 `_rescanReconcilePaths` 的分批/并发/client 语法翻译。配置项 `perforce.reconcileHint.enabled`（默认开）可整体关掉。

四条决策，改这条通道前先对照：

- **不喂进 `ScmDecorationsService`**：`getFile(...) !== undefined` 是既有的「该文件有本地改动」判据，被 dirty-diff 门控与 `dirtyDiffActions` 依赖；塞进去还会连带走 SCM `resourceStates` → 触发 `_reconcileActive` sticky / 持久化 / dismissed 三连锁。新服务只服务 Explorer 行。
- **徽标从 `toReconcileResourceState` 派生**（`p4Decoration.ts` `toWorkingTreeHint`）：letter 必须是 `RC`，不是动作字母 E/A/D。两条通道（组 / hint）可能先后描述同一个文件，各写一份 style 映射会让同一文件在 Clean Refresh 前后徽标跳变。单测 `clientWorkingTreeHint.test.ts` 直接与 `toReconcileResourceState` 的返回值逐字段比对，改坏派生关系即红。
- **只给文件行，目录不染色**：按需模型对未展开子树一无所知，目录颜色只会是个下界，展开即变——来回闪烁比不显示更糟。push 态的祖先冒泡（`ScmDecorationsService.folders`）在用户跑过 Clean Refresh 后照常工作，两套目录真相不混用。
- **只读派生（最容易被"顺手优化"破坏）**：`checkWorkingTree` 绝不置 `_reconcileActive`、绝不写 `_reconcileFiles`、绝不 `_persistReconcile()`、绝不 `_emitChange()`。一旦有人想「既然都扫了不如存下来」，这条通道就退化成它要规避的 sticky 全量发现。护栏 = store save spy + 组 `resourceStates` 身份 + `onDidChange` 计数 + 直读 `_reconcileActive`。

另两处易踩：hint 与组共用三个谓词（已 opened / scope 外 / dismissed），全被过滤掉则**零 p4 spawn**；返回值**回显调用方自己的路径字符串**（扫描报的是从 client 语法翻译来的路径，拼法未必与 host 一致，不回显会让 renderer 缓存键对不上，还会把没问过的路径——比如 rename 的另一半——报到不存在的行上）。

回显那张 map 的 key 必须是 `scopeKey` 而非 `norm`——它两侧**不同源**：请求方按用户打开目录的拼法给，答案按 `p4 info` 报的 clientRoot 拼，Windows/macOS 上两者可以只差大小写却指同一个文件（`norm` 只折盘符，会漏配 → hint 静默消失，Clean Refresh 后又冒出来）。同一个方法里查 `_openedPaths` / `_dismissed` 仍用 `norm`，因为那两个 set 的键与被比较的值同源（都由 p4 报）。`pathUtil.ts` 里 `scopeKey` 的注释就是这条判据的出处。路由用 `resolveContaining`（严格最长前缀）而非 `resolveClient`——后者的 active 回退是命令路由语义，数据查询用它会把不归任何 client 的路径扔给 active client 扫。

## 命令路由（一 id 多 client）

所有 p4 source control 共享 id `perforce`，靠**每个 client 唯一的 root** 路由（`clientManager.ts`）：

- provider/组命令 → 参数带 `{ rootUri }`，精确命中。
- 资源/文件命令 → 参数带绝对 `resourceUri`，取 **root 最长前缀**命中的 client。
- 无参命令 → `mgr.active`（跟随 SCM 视图选择，经 `perforce.setActiveRepo` 推入）。
- 路径比较统一走 `pathUtil.ts` `norm()`（正斜杠、去尾斜杠、小写盘符），**别手写大小写折叠**（ESLint 护栏会拦，见 memory `eslint-path-identity-guardrails`）。

## 操作方法约定（`client.ts`）

绝大多数 mutating 操作走 `_mutate(label, args, paths?, options?)`：跑 p4（可取消）→ 失败 toast（`notifyP4Failure`）→ **按文件失效缓存** → **refresh（第二层 busy 文案）**。加新操作时优先复用它。

- **缓存失效按文件（`_invalidateAfterMutation`）**：单文件/小批量（≤ `MAX_FILE_SCOPED_INVALIDATIONS`=64、且不含 `/...` 递归语法）→ 逐条 `_cache.invalidateFile(p)`（原始路径 + `norm(p)` 双针，`invalidateFile` 是子串匹配）**外加显式清 `P4CacheNs.opened`**；空 paths / 批量 / 目录递归 → 保持 `invalidateWorkspace()`。`opened` ns 必须显式清：它只有 `'all'` 一个 key（喂图谱 `getPendingCount`/`getOpenedForGraph`），路径 needle 匹配不到，不清会让图谱 pending 数在 TTL 内陈旧。其余 ttl ns 无需动的完整论证写在该方法的注释里（`where`/`changeDetailPaths` 只依赖 client view；`filelog`/`changesSubmitted` 只在 submit/sync 后变、那些操作 paths 为空 → 走全清；`shelvedDescribe` key 是 CL id 且 shelve/unshelve 不带 paths → 走全清）。`invalidateFile` 此前只有单测、生产零调用，现已转正。
- **`P4CacheNs.fstat` 短 TTL（`Math.max(workspaceTtlMs, 15_000)`）**：`BaselineProvider.getFstatInfo(localPath)` 是唯一 fstat 入口，key = `norm(localPath)`（`invalidateFile` 可精确命中）。**绝不能 immutable**——`haveRev` 随 `p4 sync` 变，immutable 会把 stale `depotFile#haveRev` 永久钉死，diff 左侧永远错；短 TTL 只吸收「切 tab / 重复点击」的突发重复读。**负结果（不受控文件）用 `NOT_CONTROLLED = ''` 哨兵缓存**（`wrap` 不缓存 `undefined`，哨兵防 gutter 每次切 tab 都对非 depot 文件重跑 fstat）；**exitCode≠0 的瞬时失败不缓存**（下次重试，不被钉 15s）。
- **取消能力（用户主动放弃长操作）**：三层管道 —— ① `P4ExecOptions.signal?: AbortSignal`（`p4Service.ts`）：abort 即 `proc.kill()`，`close` 时 **resolve 一个 stderr 带 `was cancelled` 的失败结果**（与 watchdog / 巨量 stdout 同款红线：异步回调绝不 throw）；② `client.ts` 的 `_cancellable(fn)` 把 in-flight `AbortController` 压进 `_cancelSources` 栈并经 `status.busyCancellable` 上报，`cancelBusy()` 全部 abort；取消后**不弹错误 toast**（主动取消不是故障），只记日志并照常刷新；③ UI 入口 = 状态栏 spinner 项在 `busyCancellable` 时把 `command` 指向 `perforce.cancelBusy`（`p4StatusBar.ts`）。**该命令是运行时命令（`commands.registerCommand`），绝不进 `contributes.commands`** —— 见下文头号坑（会注册无 handler 同名命令并遮蔽真 handler）。测试：`p4Service.test.ts` 的 cancellation suite（假子进程 + 断言 kill + resolve 失败而非 reject）。
- 需要 spec 表单的（`change -i`、`change -o` 改描述）走 stdin `input`，见 `newChangelist`/`editChangelistDescription` + `changeSpec.ts`（`buildNewChangeSpec`/`replaceDescription`/`parseDescription` 纯函数）。
- `refresh()` 有**合并（coalesce）**：并发调用排队成一次，`_refreshing`/`_queued` 守卫；每步查完 `if (this._disposed) return`。支持 `refresh({reconcile:true})` 开启 reconcile 发现（last-writer-wins 标志，见上文待收集分组）。**在飞时的并发调用会 `await _inFlightRefresh` 等在飞刷新链结束**（不提前返回）——调用方 promise 语义 = "我要的刷新已被真正执行"；SCM 标题栏 Refresh 按钮的禁用/转圈正是挂在这个 promise 上（renderer `ScmViewToolbar` 按 `命令@rootUri` 跟踪在飞命令，`ActionButton` busy 时禁用 + **原图标原地旋转**——git syncing 同款表达，无图标的命令才兜底 Loader2）。改 refresh 语义时同步改 git 侧 `repository.ts`（同构）。测试：`clientRefresh.test.ts`（perforce）/ `repositoryRefresh.test.ts`（git）/ `ScmViewToolbar.pending.test.tsx`（renderer）。
- SCM 标题栏按钮**不走** `ViewTitleActions`（那是 view/title 的通用渲染），而是 `ScmViewToolbar.tsx`（经 view toolbar registry 挂进 SideBar 头）→ `scmShared.tsx` `menuActions(MenuId.ScmTitle, {scmProvider}, 'navigation')` + `ActionButton`；overflow（`…` 菜单）走 `menuToRows`。按钮点击 = `commandService.executeCommand(cmd, {rootUri, sourceControlId})`，promise 经 RPC 直通扩展宿主 handler。
- **view/title 按钮（`ViewTitleActions.tsx`）有同款 pending**：点击后禁用 + 原图标旋转，await executeCommand settle 恢复。Swarm Reviews 的手动刷新走这里——但 `swarm.refreshReviews` 的 handler 只是同步发事件总线（`requestSwarmReviewsRefresh`），真实 fetch 在视图侧，故 bus 带**完成回执**：请求返回 promise，视图 reload 完成后 `resolveSwarmReviewsRefresh()` flush；`trackSwarmRefreshConsumer()` 计数防无消费者时 promise 挂起（按钮永久禁用）。给任何"命令只发事件、视图干活"的按钮加加载态，照此 ack 模式办。
- 破坏性操作（delete/revert/revertChangelist/submit/deleteShelved）在 `extension.ts` 命令层 `showWarningMessage` 二次确认，**不要**把确认塞进 client 方法。**submit 直达 depot 不可撤销**（不像 git 有 amend/undo）→ 确认框文案须注明「This cannot be undone / 此操作不可撤销」。
- **还原两档**：`revert`（单文件）、`revertChangelist`（整组 `p4 revert -c <id> //...`，破坏性、需确认）、`revertUnchanged`（`revert -a`，只还原内容未变的、安全、无需确认）——三者别混。

## 连接状态 & 离线

server 端状态、**无 FS watcher**。`ConnectionState` = `connected|offline|not-logged-in`。任何 p4 命令非零退出经 `p4Error.ts` `classifyP4Error` 分类：session 过期/未登录 → `not-logged-in`（提示重新登录），连接失败 → `offline`。`_goOffline` 清空组 + count=0 + emit（状态栏更新），**不刷屏弹错**。

捕捉**编辑器外改动**有三条互补手段（都因服务器无 watcher 而必需）：
- **文件监视自动刷新**（`workspaceWatcher.ts`，`perforce.autoRefresh` 默认**开**）：用 `workspace.createFileSystemWatcher(RelativePattern(打开的文件夹, '**/*'))` 监视磁盘，**去抖（400ms）**后把三个事件（create/change/delete）报的**绝对路径**（`uri.fsPath`）累积进 `refreshReconcilePaths(paths)`——增量 reconcile（O(改动文件数)，不是全量 `refresh({reconcile:true})`），编辑器保存与外部工具改动都覆盖；`node_modules`/`.git`/`dist`/`.turbo` 由 main 侧进程外 @parcel/watcher 的 `files.watcherExclude` 在 watcher 层剪枝（`apps/editor/src/main/services/fileWatcher/fileWatcherMainService.ts`），`isNoise` 再滤掉 swap/lock 临时文件作双保险。**⚠️ 为什么绝不能在 host 进程里对用户目录 recursive `node:fs.watch`**：Linux 上 Node 递归 watch 吃同一进程的 inotify 配额，巨型 monorepo 耗尽后 `ENOSPC` **从 watch 回调里同步 throw、调用方无法拦截** → uncaughtException → extension host `process.exit(1)` → 无限崩溃重启。RPC watcher 进程外隔离 + 崩溃自恢复，无此问题；`createFileSystemWatcher` 抛错则落日志 + 关闭自动刷新（降级不抛，与旧最终降级一致）。**⚠️ 坑：绝不能监视 `client.root`**——p4 client root 是整个 workspace 映射（大型游戏项目可能在打开文件夹的很多层之上），监视它慢且容易失败；同理 reconcile 扫描范围也必须从 `//...` 收窄——聚焦目录（`workspace.focusEnabled`+`workspace.focusFolders`）启用且非空时用聚焦目录，否则回退打开文件夹（`extension.ts` 的 `applyReconcileScope` → `resolveFocusScopeDirs`（`focusScope.ts` 纯函数）→ `client.setReconcileScope(dirs)`，多 filespec + 嵌套去重；范围外路径在 `_setReconcileFiles` 漏斗处过滤），否则大 depot 每次保存全盘扫（"改了文件不进待收集组"的旧 bug 根源）。
- **autoEdit**（`autoEdit.ts`，默认关）：`onDidChangeTextDocument` 首次改动即 `p4 edit`。
- **轮询**（`startPolling`，`perforce.refreshInterval` 秒，最小 10s 地板，默认关）：定时兜底，留给共享盘/CI。
- **状态栏计数**：`ClientStatus` 带 `openedCount`/`reconcileCount`，`p4StatusBar.ts` 连接态下显示「client名 N个已打开 M个待收集」，对标 git ahead/behind。刷新在 `_doRefresh` 末尾更新 `_openedCount`，`_goOffline` 清零。

## 宿主泛化：p4/git 共用一个无偏见 host

dirty-diff gutter 与 inline blame 原本硬编码 `git.*` 命令；已抽象为「**provider 上报的 capability**」，host 零 SCM 知识：

- 契约在 `packages/extensions-common/src/contracts/dirtyDiff.ts`（`DirtyDiffCapabilities` + `dirtyDiffCommandId(providerId, cap)`）和 `blame.ts`（`BlameCapabilities` + `blameCommandId`）。命令 id = `<providerId>.<capability>`（`git.getHeadContent` / `perforce.getBlame`）。
- 渲染侧 `DirtyDiffContribution.ts` / `ScmBlameContribution.ts` / `dirtyDiffActions.ts` 注入 `IScmService`，用 `resolveScmProviderId(sourceControls, fsPath, selectedRootUri?)`（`ScmService.ts`，键走 `scmProviderPathKey`）解析归属 provider → 派生命令 id 调用。**第三参 `selectedRootUri` 是 SCM 面板当前选择的 repo**：命中的归属者优先，未命中回退最长前缀——同一文件同时归属 git+p4 时按用户选择路由（git 嵌套在 p4 workspace 里的场景）。消费方从 `scmViewState.selectedRepo` 取并挂 autorun 重触发；两个 contribution 的缓存按 `providerId + '\n' + path` **分槽**，切 repo 不清缓存零串扰。
- **能力探测靠 `CommandsRegistry.getCommand(id)`**：贡献命令会真的注册进 CommandsRegistry。p4 无暂存区 → **不注册** `perforce.stageChange` → host 的 `_activeProviderSupportsStage()` 返回 false → Stage 按钮自动隐藏（`canStage` 回调）。**给 p4 加/减能力就是加/减对应 `commands.registerCommand`**。
- p4 侧实现：`getHeadContent`（`#have` 内容或 null）、`getBlame`（`annotate -c -q` + 一次 `changes -l <file>` 补 summary/author/time，返回 == `BlameResultDto` 的 `P4BlameResult`）、`openChange`（have vs 本地 diff）、`checkIgnore`（见下）。这些是**运行时命令**（`commands.registerCommand`，不进 package.json），对齐 git。
- **`checkIgnore`（被忽略文件变暗）**：宿主 `ScmIgnoredResourcesService` 按批问「这批路径里哪些被忽略」。p4 侧 = `p4 ignores -i <paths…>`（`client.ts` 的 `checkIgnore` + 纯函数 `ignoresParser.ts`），三条不可省的设计：
  - **background 优先级 + 20s 紧超时**：这是滚 Explorer / 切 tab 被动触发的批量装饰读，不是用户等结果的点击。标 interactive 会占掉并发门静态预留的那个交互槽，正是本文档「共享 FIFO 并发门」记过的头号坑。
  - **入口连接守卫**（`_connection !== 'connected'` 直接返回 `[]`）：离线时零 spawn，否则每滚一屏就刷一批必败命令进 output 频道。
  - **depot 过滤**：`p4 ignores -i` 是**纯规则求值器**（git 的 `check-ignore` 会查 index，已 tracked 的文件永不上报），所以命中候选还要跑一次 `fstat -T clientFile,headAction` 剔掉「已在 depot 且 headAction 非 delete」的文件——不然整片受控内容会变暗。fstat 失败时**保留候选**（规则已命中，过滤只是精化）。
  - 返回值必须与入参**逐字相同**（宿主按原串做 key）：p4 回显的是它自己归一化过的路径，`parseIgnores` 用 `scopeKey` 反查回原串，反查不中的行整体丢弃。
  - e2e：`e2e/specs/perforceIgnored.spec.ts` + fake-p4 的 `ignores` case（`P4SeedConfig.ignored` 种子；`SeedFile.untracked` 用来造「在盘上但不在 depot」的文件）。
- **shift+alt+y 不在扩展里**：`workbench.action.scm.openChanges` 是 renderer Action2（buffer-aware，唯一 open-changes 入口：快捷键 / 编辑器标题栏对比图标 / 命令面板 / explorer 右键）。git/p4 的 `*.openChange` 已降级为纯 provider 能力命令（与 `getHeadContent` 同级），无参 fallback 已删。blame 配置在 `scm.blame.*`（renderer `ScmConfigurationContribution` 注册），blame 状态栏点击走 `scm.blame.openCommit` → 约定命令 `<providerId>-graph.view`。p4 冲突标记（`>>>> ORIGINAL`/`==== THEIRS`/`==== YOURS`/`<<<<`）由 renderer `conflictParser` 双格式状态机统一识别，UI 与 git 共用（`MergeConflictContribution`）。
- **e2e 覆盖**：`e2e/specs/perforceDirtyDiffBlame.spec.ts` 五步链（gutter → shift+alt+y → peek → blame 状态栏点击进图谱 → p4 冲突 Accept）。fake-p4 的 `annotate` case + `changes -l` 的 `state.changeMeta` 种子（`P4SeedConfig.annotate`）专为 blame e2e 服务。

> 改宿主泛化时：`packages/extensions-common` 与渲染 contribution 两侧都要动；改完先 `pnpm --filter @universe-editor/extensions-common build` 再让 apps 看到。测试见 `dirtyDiffActions.test.ts` / `ScmBlameContribution.test.ts`（都注入了带 `{id,rootUri}` 的 IScmService fake）。

## 菜单 & when 子句（`package.json`）

- SCM 视图内菜单用 `scmProvider == perforce` 门控（**`scmProvider` 只在 SCM 视图作用域有效，explorer/editor 菜单用不了它**——这是踩过的坑）。**explorer/editor 菜单用 `resourceScmProvider =~ /\|perforce\|/` 门控**（可选叠 `!explorerResourceIsFolder` / `scmActiveResourceHasChanges` / `!isInDiffEditor`）；p4 的签出/新增/删除/收集就是这么进 explorer 右键 + editor 标题栏的，命令 handler 复用 SCM 版同一个。
  - ⚠️ **别用 `resourceScheme == file` 门控**（曾踩过：它对**任何**文件都成立 → 打开非 p4 仓库时 p4 菜单项照样冒出来，且 git/p4 的 `openChange` 在对方仓库互相串台）。`resourceScmProvider` 是**通用**「该资源归属哪些 SCM provider」context key，与 dirty-diff/blame 宿主泛化同源，app 核心不写死单一 SCM 名。
  - ⚠️⚠️ **值是「归属集合」不是单个 id**（第二次踩过：git 仓库嵌套在 p4 workspace 里时，同一文件**同时**归属 git+p4）。曾用 `resolveScmProviderId`（最长前缀，只返回**一个**最具体 owner）→ 嵌套 git 根前缀更长 → 值 = `git` → p4 菜单 `== perforce` 判定失败**消失**。修法：`resolveScmProviderIds`（返回**全部** owner）+ `encodeScmProviderIds`（编码成两端带竖线的 `|git|perforce|`）→ 门控用**成员正则** `=~ /\|perforce\|/`（两端竖线防 `perforce` 误配 `perforce-graph`）。`resolveScmProviderId`（单数）**保留**给 dirty-diff/blame 的命令路由（那里就要最具体的单个 owner），别混用。
  - ⚠️ **package.json 里正则要双反斜杠**：JSON 字符串 `"...=~ /\\|perforce\\|/..."` → 解析后 `=~ /\|perforce\|/`（含反斜杠）→ scanner 正确读成「字面竖线」。漏写反斜杠 → `/|perforce|/` 是**空 alternation 匹配一切**，门控恒真（静默失效，测试务必覆盖「仅 git / 空归属 → 隐藏」）。
  - **key 由谁设**：explorer 右键 = `ExplorerContextMenu.tsx`（scoped ctx-key，`encodeScmProviderIds(resolveScmProviderIds(...))`）；editor 标题栏 = `useEditorGroupScopedContextKey.ts`（per-group scoped，随活动编辑器 + `scmService.sourceControls` autorun 重算）。两处都 `useOptionalService(IScmService)`，非 file scheme / 无归属 → 空串。给 git 侧 `editor/title` 也补了 `resourceScmProvider =~ /\|git\|/` 对称门控。测试见 `ScmService.test.ts`（resolveScmProviderIds 嵌套用例 + encode）与 `ExplorerContextMenu.test.tsx`（嵌套 git-in-p4 显示 p4 项）。
- **目录级命令**：explorer 右键传 `{ resource, isDirectory }`（见 `ExplorerContextMenu` args）；handler 读 `isDirectory` 决定是否把路径转成 p4 递归语法 `<dir>/...`（见 `extension.ts` `perforce.reconcile`：目录 → `${path}/...`，复用同一命令 + 同一「收集改动」标题，不新增命令）。要支持目录版的其它 p4 操作照此办：菜单项去掉 `!explorerResourceIsFolder`，handler 分叉 `<dir>/...`。
- 行选择靠 `scmResourceState`（单字母，来自 `p4Decoration.ts` `contextValue`：E/A/D/B/I/M，未 resolve=U，搁置=S，**待收集=RC**）。组选择靠 `scmResourceGroup == reconcile`（固定组）/ `=~ /^cl:/` / `=~ /^shelved:/`（正则）。
- 加行内动作：`scm/resourceState/context` `group: "inline@N"`；组动作：`scm/resourceGroup/context`；标题栏：`scm/title`。
- **explorer/editor 命令传参坑**：explorer 右键把 `resource` 作为 **`UriComponents`**（`{$mid,scheme,path}`）传，**跨 RPC 丢 `fsPath` getter**（`.fsPath` 读出空串）→ 用 `pathUtil.ts` `uriToFsPath(resource)` 从 scheme+path 重建路径（见 `extension.ts` `resolveTargetPath`），别读 `.fsPath`。
- **多选（已打通）**：`ScmView.tsx` 的 `ScmFileRow` inline `run` 传三参 `executeCommand(cmd, primary, selection)`——`primary` = 点击行 `{...resource, scmResourceGroupId}`，`selection` = 全选中行（`getSelectedResources()` 读 `treeModel.selection`；单击行时只含 primary，避免误扫旧选择）。p4 侧 `resolveTargetPaths(args)`（`extension.ts`，纯逻辑 `selectionPaths` 已导出+单测）解析 `args[1]` 多选、回退 `args[0]` 单个/活动编辑器。edit/add/delete/revert/reopen/resolve 均已多选；破坏性确认文案带数量（`*.confirmMany`）。**宿主选择模型本就完整（拖拽早在用），此前只差行 inline 没传选择集**。
- **文件行也带 `scmResourceGroupId`**：上面 `primary`/`selection` 每项都附所属组 id → 文件行的组作用域命令（如单个搁置文件的 unshelve/delete）能定位 changelist；handler 里 `groupChangelistId(arg)` 拿 CL、`resourcePath(arg)` 拿 depotFile，二者都在 → 走单文件版（`unshelveFile`/`deleteShelvedFile`），只 CL 无 path → 整组版。同理默认组/文件行 shelve 共用 `perforce.shelve`：`groupChangelistId=='default'` → 先建编号 CL（`moveToNewChangelist`）再 shelve；文件行 shelve = 反查所在 CL 整组 shelve（`changelistOf`/`pathsInChangelist` 从 `_changelistByPath` 反查，刷新时填充）。
- **SCM 树里的文件夹行（tree 视图）= 子树多选**：`ScmView.tsx` `ScmFolderRow` 的 `run` 传 `(primary={resourceUri:<folder>,isDirectory:true,scmResourceGroupId}, selection=<子树全部文件 args>)`——`selection` 由 `getFolderFileResources(node)` 递归 `childrenMap` 收集（复用 `fileNodeToArg`）。**复用文件行同一 `resolveTargetPaths(args)` 管线**，故 p4 侧无需为文件夹分叉：走 selection 的命令（revert/reopen/moveToNewChangelist）天然生效；只有 reconcile 读 `args[0].isDirectory` 转 `<dir>/...` 递归。**folder 菜单必须由 p4 自己贡献 `scm/resourceFolder/context`**（host 不写死 SCM）——门控用 `scmResourceGroup`（folderScope 无 state），别把 shelve（changelist 级语义）放进去。
- **拖到 changelist 组头 = drop-move**：`ScmGroupRow` 用 `useDropTarget` + `readDroppedResources(e)` 读 uri-list → `{resourceUri:u.fsPath, scmResourceGroupId}` selection → 派 **约定命令 `<providerId>.reopenTo`**。该命令**运行时注册（`commands.registerCommand`，不进 package.json commands）**，host 用 `CommandsRegistry.getCommand(id)` 探测其存在来决定组是否可 drop（对齐 dirty-diff/blame 的 capability-by-registration；不进 package.json 规避 [[renderer-action-shadowed-by-extension-command-decl]] 遮蔽坑）。文件行/文件夹行同时作拖拽源（`resourceDragProps`，folder 拖子树 uris）。e2e 无法可靠脚本化 HTML5 DnD → 直接 `runCommand('perforce.reopenTo', groupArg, selection)` 验证落地链路（见 `smoke.perforceChangelist.spec.ts`）。
  - **`reopenTo` 双向路由（reconcile ⇄ changelist，host 零改动）**：因每个 p4 组（含 reconcile）都渲染成同一个可 drop 的 `ScmGroupRow`，双向拖拽的逻辑**全在扩展 handler**。按目标组 id 分叉：① 落在 **reconcile 组**（`RECONCILE_GROUP_ID`）→ 把其中**已签出**的路径（`changelistOf(p)!==undefined`）走 `moveToReconcile`（`revert -k`），已是未收集的跳过；② 落在 **default/编号 changelist** → 拖来的路径按开状态分流：已签出的走 `reopen -c`，**未签出的 reconcile 文件走新方法 `reconcileInto(cl, paths)`**（`reconcile -a -e -d [-c <cl>]`，`default` 省略 `-c`）——因为 reconcile 文件根本没 open，`reopen` 对它无效，必须真收集进去。shelved 组不是合法目标（`changelistIdFromGroupId` 后既非 `default` 也非 `/^\d+$/` 即 return）。fake-p4 的**真** `reconcile`（非 `-n`）case 要认 `-c` 把文件 open 进指定 CL（否则恒进 default）。
- **inline 图标精简**：`openChange` 从文件行 inline 移除（单击行已走 `resource.command` 打开 diff，按钮冗余），命令保留在右键 `1_open` 组。文件行常驻 inline = revert/reopen/moveToNew/shelve(+resolve 仅 U)。default 与编号 changelist 组头 inline 对齐（都有 shelve），差异仅 default 无 Submit（p4 不能直接 submit default，固有限制）。`hideWhenEmpty:false` 对所有 pending 组统一（空编号 CL 也常显，留作 drop 目标）。
- ⚠️ **manifest 图标名必须在 `apps/editor/src/renderer/workbench/viewContainerHeader/icon-map.ts` 的 `ICON_MAP` 登记**（踩过）：p4 `package.json` menu 项的 `"icon"` 只是**名字**，渲染侧 `resolveHeaderIcon(name)` 查这张表拿 lucide 组件；**表里没有 → 返回 undefined → `ActionButton` 静默退化成显示 title 文字**（不是报错，是文字按钮）。给 p4 加带图标的命令/菜单，除了写 manifest，**还要在 icon-map 补 `name→LucideIcon`**。这张表是全局共享的（container + 命令 + 下面的组头图标同源）。
- **changelist 组头前导图标（UI 一致性）**：`ScmGroupRow` 按 group-id 类别渲染前导 glyph（`ScmView.tsx` `groupIconName`，已导出+单测）——**default 与 `cl:<n>` 同用 `changelist` 图标**表达「本质都是 changelist」（修「DEFAULT 与编号组样式不一」的观感），`reconcile`→`reconcile`(list-plus)、`shelved:`→`archive`；未识别 id（git 的 workingTree/index）返回 undefined 不渲染 → host 无侵入。图标名同样走 icon-map。配套：default 组 label 缩短为「默认 / Default」（独立 nls key `perforce.group.defaultShort`，别动仍用完整名的 quickpick/revert 确认文案）。

## 解析器测试套路（纯函数，node 环境）

领域/输出解析全部纯函数 + `src/__tests__/*.test.ts`，对 fixture 断言（`openedParser`/`reconcileParser`/`changeSpec`/`changelist`/`shelveParser`/`blameSource`/`pathUtil`/`p4Output`）。**新增任何解析逻辑先写纯函数 + 单测**，client 只做编排。mock extension-api 套路见 create-extension（`vi.mock('@universe-editor/extension-api', …)`）。带 I/O 的 `p4Service` 用 `vi.mock('node:child_process')` 注入假子进程测（见上节崩溃防护 + 超时 / 取消 suite）。

## Timeline（单文件历史，`p4 filelog`）

`timelineProvider.ts` 是对等 git timeline 的单文件历史：Explorer 侧栏 Timeline 视图列出当前文件的修订历史（`PerforceTimelineProvider`，id `perforce-history`），点击行打开与上一修订的 diff。renderer 的 Timeline 视图零改动——按 scheme 聚合所有 provider、多来源按 timestamp 归并，git/p4 条目自然并排。

- **数据源**：`client.getFilelog(depotFile, max, fromRev?)` → `p4 filelog -m <max> <depot>[#rev]`，走 `execRecords`（`-Mj` 塌陷自动回退 `-ztag`），解析在 `filelogParser.ts`（纯函数：numbered 并行键主路径 + 单值键防御路径，rev strip `#` 前缀）。结果走 `P4CacheNs.filelog`（TTL，对齐 `changesSubmitted`；`_mutate` 的 `invalidateWorkspace` 自动失效）。
- **分页**：git 同款 limit+1 探针。cursor = `${depotFile}#${probe.rev}`（opaque，翻页 `lastIndexOf('#')` 解析，**不再 fstat**）；`p4 filelog file#N` 从 #N 往回列（含 #N），probe 在下一页复现为第一条，与 `git log <cursor>` 语义一致。
- **Pending 项（对齐 git 的 Uncommitted Changes）**：首页顶部，双判定——fstat 有 `action`（已签出）直接成立；未签出时跑 `p4 diff -se <file>`（exit 0 且非空 = 磁盘偏离 have，即 reconcile-drift 情形）。`perforce.timeline.showPending`（默认开）可关。点击 = have 版本 vs 工作区 diff（右侧 `liveModified` 跟随实时编辑；open-for-add 无 have 则左侧为空）。`p4 filelog` 对 open-for-add 报错 → 只返回 pending 项（对齐 git unborn branch）。
- **client 解析必须走 `ClientManager.resolveContaining`**（严格最长前缀，**无 active fallback**）——`resolveClient` 的 active fallback 是命令路由语义（无参命令打向当前选中 repo），timeline 是数据查询语义，fallback 会把 root 外的文件错误归到 active client。openDiff 命令 handler 同样用 `resolveContaining`。
- **`trackClient` 防抖 200ms**：client 的 `onDidChange` 在 `_withBusy` push/pop 时也 fire，不防抖会让一次 mutate 触发视图反复重载。
- **历史项 diff 两侧**：复用图谱的 `statusFromAction` + `fileDiffRevs`（add→左空、delete→右空、edit→`#rev-1`/`#rev`）+ `client.printRevision`（带 immutable 缓存）。
- **右键菜单**：`timeline/item/context`，when `timelineItem == perforce:file:rev`（pending 项 `perforce:file:working` 不配菜单，对齐 git）。
- **不做**：`-i` follow integrates（输出含来源行、解析复杂，第一版只显示当前 depot 路径历史）。中文 depot 路径的 argv 乱码已在 `P4Service` 层统一修复（`-x` argfile，见上节），filelog/print 不再受限。
- 测试：`__tests__/timelineProvider.test.ts`（仿 git 测试 mock 套路 + 真 `ClientManager` 测 `resolveContaining`）+ `__tests__/filelogParser.test.ts`。

## 密钥 / env 安全红线（重申）

- 密码/ticket 只经 stdin → `p4 login`，绝不落 settings/日志/RPC（见文件头）。
- 子进程 env 走 `sanitizeEnv()`（`p4Service.ts` `ENV_DENYLIST`），与 git spawner 同款——防 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` 把 node 型子进程劫持。加任何新 spawn 都必须走 `P4Service`，别自己 `spawn`。
- 所有参数用**数组**传给 `spawn`，`shell:false`，路径/描述不进 shell，杜绝注入。

## 配置项（`perforce.*`）

`enabled`(默认 true)、`port`/`user`/`client`（连接兜底，优先 `p4 set`/P4CONFIG）、`maxConcurrent`(4)、`commandTimeout`(600s，单个 p4 进程最长存活秒数，超时强杀；0=不限——约束「永久挂死」而非「执行慢」，见上节 SpawnWatchdog)、`refreshInterval`(0=关，最小 10s)、`autoEdit`(false)、`autoReconcile`(false，每次 refresh 带 reconcile 发现)、`autoRefresh`(true，文件监视触发带 reconcile 发现的自动刷新)、`reconcileHint.enabled`(true，Explorer 按需 hint 通道总开关，见上文「Explorer 按需 hint 通道」)、`syncPreview.autoCheck/intervalSec`(300s，最小 30s，落后感知两级探针)、`openedByOthers.autoCheck`(true)/`openedByOthers.intervalSec`(300s，最小 30s，他人占用灰字)、`timeline.showPending`(true，Timeline 顶部待定更改条目)、`cache.*`。加新配置：`package.json` `contributes.configuration` + nls description key，读用 `workspace.getConfiguration('perforce').get(key, default)`。

## 验证

```bash
# 改了 extensions-common / extension-host 后先重建 dist（pnpm dev 下 watcher 自动）
pnpm --filter @universe-editor/extensions-common build
pnpm --filter @universe-editor/perforce test    # 仅跑 p4 单测（快）
pnpm check                                       # lint+typecheck+全测+docs:check，仅看错误
```

- 用户可见改动（命令名/菜单/配置/交互）→ 同步 `docs/user/zh-CN/perforce/`（overview / daily-workflow / changelists-and-shelving / resolve-and-advanced），内部链接由 `pnpm docs:check` 校验，别留死链。
- 交互流程改动 → `pnpm e2e`（本地 Windows 有 launch flake，交 CI）。
- **性能修复回归护栏**（并发门优先级/预留槽、fstat 缓存、reconcile 阈值跳过、交互紧超时）见 `__tests__/concurrency.test.ts`（gate 级复现：预留槽/硬顶/FIFO/setMax/waitedMs）、`__tests__/p4Service.test.ts`（priority 穿透 + 排队打点 + `execRecords` 重试透传 + 交互紧超时）、`__tests__/baselineProvider.test.ts`（fstat/print 缓存 + `getHaveContentResult` 三态）、`__tests__/clientReconcilePersist.test.ts`（阈值跳过 + 防重入守卫 + reconcile stage label 四态）、`__tests__/clientInteractivePriority.test.ts`（表驱动不变量：每个交互读调用点确实以 `priority: 'interactive'` 发出，删掉任一 `INTERACTIVE_EXEC` 即红）、`__tests__/clientOpenChange.test.ts`（openChange 失败可见/回退）。
- 打包自动收录：`scripts/release/runtime-resources.mjs` `discoverBuiltinExtensions` 用 `readdirSync` 扫 `extensions/`，perforce 的 `files:["dist","package.nls.json","package.nls.zh-cn.json","icon.svg"]` 必须齐（`assertPackagedFile` 校验）。

## e2e：fake p4（无需真 p4d）

本机 / CI 有 `p4` client 但**无可达 p4d**，`p4 info` 发现失败 → provider 整体禁用，任何 p4 端到端链路都跑不起来。故有一套 **fake p4**：
- `p4Service._spawn` 认 **`UNIVERSE_P4_PATH`** 覆盖 `spawn('p4')`；`.mjs/.js/.cjs` 结尾则用 `process.execPath <script>` 跑（宿主里是 Electron-as-node，`sanitizeEnv` 会剥 `ELECTRON_RUN_AS_NODE`，`_spawn` 对该情况**重新补回** `=1` 否则起成 GUI Electron）。纯逻辑 `resolveP4Command()` 已导出 + `p4Service.test.ts` 守。
- `extensions/perforce/e2e/fixtures/fake-p4.mjs`：**磁盘状态** fake，depot/have/opened 存一个 JSON（`UNIVERSE_P4_FAKE_STATE`）；`reconcile -n` 真去 walk client root 比对磁盘 vs have-revision，`edit/add/delete/reconcile/revert` 真改 opened 集。依赖零、纯 Node。要覆盖新 p4 子命令就在它的 `switch(command)` 里加一个 case，注意 `-Mj`(默认) 与 `-ztag` 两种输出模式（`emit()` 已分流）。**⚠️ 协议形态必须与真服务器对齐**：`changes` case 现在按 `state.shelved[id]` 非空才 emit 裸键 `shelved: ''`（对齐上文实测的裸键存在性信号）——漏了它就会让「无搁置 → 零 describe」的优化在 e2e 里假绿，或让搁置组在真机上永不出现。
- `extensions/perforce/e2e/fixtures/perforceApp.ts`：cold-launch fixture（开 workspace 会重启宿主，不能用 shared 实例），`test.use({ p4Seeds:{files:[...]}, openSubdir })` 定制，`perforce` fixture 给 `clientRoot`/`openDir`/`file()`。spec 在 `extensions/perforce/e2e/specs/`（如 `perforceCollectChanges.spec.ts`，改盘上文件 → 断言进「Changes to Reconcile」组）。**⚠️ Playwright option fixture 的值不能是裸数组**（会被当 tuple 只取首元素 → `seeds is not iterable`），故种子包一层对象 `P4SeedConfig{files}`。
- 改了扩展 `src/` 后 e2e 用的是 `dist/`：先 `pnpm --filter @universe-editor/perforce build`；改了 app 侧（renderer/main）先 `pnpm --filter @universe-editor/editor build`（e2e 跑 `out/`）。**⚠️ 单跑某个 spec 必须带 `UNIVERSE_E2E_NO_TAG_FILTER=1`**（在 `extensions/perforce` 目录下 `npx playwright test -c e2e/playwright.config.ts perforceCollectChanges`）——默认 pass 的 grepInvert 排除 `@regression`/`@serial` 等 tag，p4 spec 基本全带 `@regression`，不带该 env 会报 "No tests found"（机制见 `packages/e2e-harness/src/playwrightConfig.ts`）。

## 关键参考路径

- `extensions/perforce/src/p4Service.ts` —— CLI 封装 + env 净化 + `-Mj`/`-ztag`
- `extensions/perforce/src/client.ts` —— PerforceClient：分组对账 + `_mutate` + 全操作方法 + reconcile 分组/收集 + getHeadContent/getBlame/openChange + polling + 状态计数
- `extensions/perforce/src/extension.ts` —— activate + 全命令注册 + 路由 helper（resourcePath/groupChangelistId/resolveTargetPath，含 `uriToFsPath` explorer 传参修正）
- `extensions/perforce/src/reconcileParser.ts` —— `reconcile -n` 输出解析（纯 + 单测），待收集分组数据源
- `extensions/perforce/src/clientManager.ts` / `clientDiscovery.ts` —— 路由 / `p4 info` 发现
- `extensions/perforce/src/changelist.ts` / `p4Output.ts` —— 分组纯逻辑 / 输出解析（numbered 并行键）
- `extensions/perforce/src/{openedParser,fstatParser,shelveParser,blameSource,changeSpec,filelogParser,cstatParser}.ts` —— 领域解析（各带 __tests__；filelogParser 是 Timeline 单文件历史的数据源；cstatParser 是落后 CL 列表的 have/need/partial 分类）
- `extensions/perforce/src/timelineProvider.ts` —— Timeline provider（单文件历史 + 待定更改项 + openDiff/copyChangelistNumber 命令；含 resolveContaining/debounce 注释）
- `extensions/perforce/src/{baselineProvider,p4Decoration,p4Error,autoEdit,p4StatusBar,concurrency,pathUtil,nls}.ts`
- `packages/extensions-common/src/contracts/{dirtyDiff,blame}.ts` —— provider capability 契约（宿主泛化）
- `apps/editor/src/renderer/services/extensions/ScmService.ts` —— `resolveScmProviderId`（单个最具体 owner，dirty-diff/blame 路由）/ `resolveScmProviderIds`（全部 owner，菜单门控）/ `encodeScmProviderIds`（`|a|b|` 成员编码）/ `scmProviderPathKey`
- `apps/editor/src/renderer/contributions/{DirtyDiffContribution,ScmBlameContribution,MergeConflictContribution}.ts` —— 渲染侧消费 capability + `CommandsRegistry.getCommand` 能力探测
- `extensions/git/` —— 对照样板（Repository/RepositoryManager/gitError/nls 都是 p4 的镜像来源）
- 相关 skill：`create-extension`（插件通用套路）；dirty-diff 内联 peek UI 见 `apps/editor/src/renderer/workbench/scm/CLAUDE.md`
- 相关 memory：`extension-system-progress` / `eslint-path-identity-guardrails` / `dirty-diff-inline-peek-feature` / `path-comparison-convergence` / `perforce-collect-changes-ux`
- 中文路径 `p4 print` 空 diff / 超长 argv ENAMETOOLONG（`-x` argfile）已收敛在上文「中文/非 ASCII 路径经 argv 传给 p4 会乱码；超长 argv 会 ENAMETOOLONG」节

## 其它

- 项目开发期，**不考虑向后兼容**——改 p4 模型/契约放手改。
- 关键逻辑保留调试输出（走 `log`→Perforce output channel / `console.error`，**stdout 是 RPC 通道不能占**）。
- 发现新经验，回来更新本文件。

## Perforce Graph（p4 图谱）

`Perforce Graph` 是对等 **Git Graph** 的主编辑区标签页，把**已提交的 changelist 历史**可视化。Perforce 历史是**严格编号、线性排列的 changelist 列表**（没有 git 那样的本地分支合并 DAG），所以图谱是**单条泳道**（single lane）——这是与 git graph 最根本的差别，其余交互（搜索、右键、详情面板、view-state 持久化）都刻意与 git graph 对齐以保证一致体验。

> 先读上文「扩展内置 Perforce（p4）插件」节（分层架构、`p4Service`/`client`/解析器、连接红线、密钥红线）——本节只讲**图谱特有**的东西：数据源方法、wire 类型、renderer 编辑器与注册。

### 三层技术栈（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| wire 类型 | `packages/extensions-common/src/contracts/perforceGraph.ts` | renderer↔扩展共享的 DTO（`P4GraphChangeDto` / `P4GraphRepoDto` / `P4GraphLoadResult` / `P4GraphChangeDetailsDto` / `P4GraphFileChangeDto` / `P4GraphFileDiffRequest`）+ `PerforceGraphCommands` 命令 id 常量。**必须**在 `index.ts` re-export |
| 纯解析 | `extensions/perforce/src/p4GraphParser.ts` | `parseChangesList` / `parseChangeDescribe`（numbered 并行键折叠）/ `statusFromAction`（p4 action→A/M/D/R）/ `fileDiffRevs`（按 status 算 left/right rev spec）/ `parseWhereLocalPaths` / `displayPath`。**全纯、可对 fixture 单测** |
| 数据源 | `extensions/perforce/src/client.ts` | 图谱方法：`getGraphChanges(max)` / `getPendingCount` / `getOpenedForGraph` / `getGraphChangeDetails(id)` / `printRevision(spec)` / `_whereLocalPaths` |
| 命令 | `extensions/perforce/src/extension.ts` | 注册 7 个 `perforce-graph.*` 命令（见下）——**运行时命令**（`commands.registerCommand`），构建 DTO、算单泳道 parents、跑 diff |
| 编辑器 | `apps/editor/src/renderer/workbench/perforceGraph/PerforceGraphEditor.tsx` | 主 React 编辑器：单泳道单选 + 顶部"待定变更"节点。只用 `ICommandService` + `IScmService` 跨 JSON 边界调命令 |
| 输入/状态/动作 | `apps/editor/src/renderer/services/editor/PerforceGraphEditorInput.ts` · `services/perforceGraph/perforceGraphViewState.ts` · `actions/perforceGraphActions.ts` | EditorInput（URI `universe:/perforceGraph`）· module-level view-state 单例（重开秒恢复）· 两个 Action2 |

### 命令清单（`PerforceGraphCommands`）

`getRepos` / `setRepo` / `getChanges` / `getChangeDetails` / `getPendingChanges` / `openFileDiff` / `openWorkingTreeFile`。全部走 `commands.registerCommand`（**不进 package.json `commands` 数组**，见头号坑），renderer 用 `commands.executeCommand(PerforceGraphCommands.xxx, ...)` 调用。

### 与 Git Graph 的复用点（别重造轮子）

Perforce Graph 大量复用 git graph 的成熟部件——加功能前先看能不能复用：

- **`services/gitGraph/graphLayout.ts` `computeGraphLayout`**：泳道布局引擎，单泳道也用它（parents 用 `visible[i+1]` 串成一条链）。
- **`services/gitGraph/fileTree.ts` `buildFileTree<T extends {status,path}>`**：已泛型化（原本绑 `GitGraphFileChangeDto`），p4 传自己的 `P4GraphFileChangeDto`。改文件树逻辑要**同时顾及 git/p4 两个调用点**。
- **`workbench/gitGraph/GitGraphContextMenu`**：右键菜单组件直接复用。
- **`workbench/gitGraph/GitGraphEditor.module.css`**：`import styles from '../gitGraph/GitGraphEditor.module.css'`——**共用一份样式**，改样式波及两个编辑器。
- **`SendCommitToAgentChatAction`**：右键"发送到 Agent Chat"复用它，传 `{ hash: id, message }`。

单泳道差异集中在 `PerforceGraphEditor.tsx`：`PENDING_ID = '*'`（顶部待定变更节点，对应 git 未提交节点）、单选而非多选、`PALETTE` 单色。

### 编辑器注册三件套（所有内置编辑器都一样）

新做/改图谱编辑器必改三处，缺一不显示：

1. `contributions/BuiltInEditorProvidersContribution.ts` —— `EditorRegistry.registerEditorProvider({ typeId, componentKey, deserialize })`
2. `workbench/editor/EditorArea.tsx` —— `editorComponentMap.set('perforceGraph', PerforceGraphEditor)`
3. `services/editor/PerforceGraphEditorInput.ts` —— `EditorInput` 子类，无 scope 时固定 URI `universe:/perforceGraph`；带 `PerforceGraphScope` 时 resource = `universe:/perforceGraph?<query>`（scope 编码进 query → 每个路径一个独立 tab、可序列化恢复），`deserialize` 已带参（见下「文件/文件夹历史」节）

Action2 在 `actions/index.ts` `registerAction2`。

### 文件/文件夹历史（scoped graph）

图谱可限定到**单个文件/文件夹**：`perforce-graph.viewFileHistory`（renderer Action2，命令面板 + Explorer 右键 `4_visualize@2` + SCM 文件行 `1_open`）打开带 `PerforceGraphScope { path, isDirectory, label }` 的 `PerforceGraphEditorInput`，历史只列影响该路径的已提交 changelist。

- **`getChanges` 的 scope 参数**（`P4GraphLoadOptions`）：`scopePath` + `scopeIsDirectory`。存在时忽略 `wholeRepo`——scoped 分支用 `mgr.resolveContaining(scopePath)`（严格最长前缀、无 active fallback，数据查询语义，镜像 timeline）定位 client，`buildScopeFilespec` 拼 filespec；pending 计数经 `openedUnderScope` 过滤（`client.ts getPendingCount`）。
- **为什么 scoped 分支用 `resolveContaining` 而不是 `graphClient()`**：`graphRoot` 是整图谱共享的可变状态（`perforce-graph.setRepo` 写它），scoped 查询是「按路径定位数据」的只读语义，绝不能读/写它——否则限定到某文件的标签页会污染整图谱视图的选中 client，反之亦然。
- **红线：任何拼进 p4 命令行的路径都必须过 `buildScopeFilespec` / `escapeFilespecPath`**（`src/p4Filespec.ts`）。`@ # * %` 是 p4 filespec 元字符（revision range / 通配 / 百分号转义引入符），路径里的字面 `@`/`#`/`*`/`%` 会被服务器重新解释、静默改变作用域含义，必须百分号编码（`%` 先转，避免把其它转义引入的 `%` 二次转义）。目录 scope 走 `<dir>/...`（先剥尾斜杠再拼）。
- **scoped UI 差异**：隐藏 Globe（whole-repo 开关）与 client 下拉、不写全局 `setRepo`、不持久化选中行；单文件 scope 的行右键多一项「Open Changes」。view state 按 `input.id` 分桶（有界 LRU cap 12，全局桶永不淘汰），多个历史 tab 各自独立。

### ⚠️ 头号坑：renderer Action2 命令绝不能进扩展 `commands` 数组

图谱的打开命令（`perforce-graph.view`）**handler 在 renderer 的 Action2**（`ViewPerforceGraphAction`），扩展只把它贡献到 scm/title **菜单**。此命令**绝不能**再写进 `extensions/perforce/package.json` 的 `contributes.commands` 数组。

- **后果**：`contributes.commands` 会在扩展宿主侧注册一个同名、**无 handler** 的命令。执行时该宿主命令胜出、遮蔽 renderer Action2 → `executeCommand` **静默返回 undefined、不抛错、编辑器不打开**，极难排查（命令"成功"却什么都没发生）。
- **正确做法**：只在 `contributes.menus`（scm/title）里写该命令项，菜单项自带 `icon` 即可显示图标；title/tooltip 由 renderer Action2 的 `title` 提供。对照 git 扩展：`git-graph.view` 只出现在 menus，从不在 commands 数组。
- **排查手法**：e2e 探针 `getActiveGroupEditorCount` 对比同结构的 git-graph（count=1 打开）vs perforce-graph（count=0 no-op），秒判是"命令被吞"而非"组件渲染崩"。

（这条通用护栏见 memory `renderer-action-shadowed-by-extension-command-decl`。）

### p4 图谱的数据层红线（-Mj / -ztag / -p）

图谱数据源踩的是 p4 通用坑的子集，完整版见上文 p4 插件节，此处只标图谱相关：

- **`-Mj` 是否吐结构化字段因命令 + 服务器版本而异，不能假设"报表型命令都安全"**：某些 P4D 上 `changes` / `describe` / `where` / `info` / `clients` 的 `-Mj` 会塌成单个 `{"data":"..."}` 文本 blob（丢掉全部结构化字段），只有脚本型命令（`fstat` / `opened`）稳定保留字段；`-ztag` 对所有命令都正常。塌陷现象是"命令 `exit 0`、手动执行有输出，但图谱空"——`parseChangesList` 读 `record['change']` 拿不到值，`if (!id) continue` 全部跳过。
- **报表型 p4 命令统一走 `P4Service.execRecords()`，不要用 `execJson`**：它先跑 `-Mj`，用 `isCollapsed()`（所有记录都只含 `data` 键）检测塌陷，命中则自动回退 `-ztag` 并用 `parseZtagAsMarshal` 规整成与 `-Mj` 同构的扁平记录（保留 `depotFile0/1` 扁平键、聚合多行 desc、按"键重现"切分记录）——parser 零改，正常服务器零额外开销。图谱的 `changes` / `describe -s` / `opened` / `where` 均应走这条路径。
- **`describe`（带 diff，无 `-s`）和 `annotate` 的 `-Mj` 必塌 blob**——图谱**不碰这俩**（文件 diff 走 `p4 print -q` 取两个 revision 的原文，本地在 renderer 做 diff）。
- **诊断"exit 0 但无数据"**：先在真实服务器 `p4 -Mj <cmd>` 对比 `p4 -ztag <cmd>`，看前者是否塌成 `{"data":...}`；若给图谱加新的报表型/多字段命令，同样先做这个验证。
- **连接 `-p` 绝不从 `p4 info` 的 `serverAddress` 推**（那是服务器内部 bind 地址，代理后端不可路由）；只在 `perforce.port` 显式设置才传 `-p`，否则让 p4 按 cwd 自解析 P4CONFIG。

### 密钥红线（照搬 p4 集成，重申）

密码/ticket 绝不进明文 settings/aiSettings/wire；所有 p4 spawn 走 `P4Service`（array args、`shell:false`、env denylist 剥 `ELECTRON_*`/`NODE_OPTIONS`）；**stdout 是 RPC 通道，绝不写调试**（用 `log`→Perforce 输出频道 / `console.error`）。

### 测试套路

- **纯解析器单测**：`p4GraphParser.ts` 的每个函数对 fixture 断言（`extensions/perforce/src/__tests__/p4GraphParser.test.ts`）。新增解析逻辑先写纯函数 + 单测，client 只做编排。
- **renderer 单测**：`workbench/perforceGraph/__tests__/PerforceGraphEditor.test.tsx`，mock `ICommandService` 返回假 DTO，断言渲染/展开详情/待定节点。
- **e2e 冒烟**：`extensions/perforce/e2e/specs/perforceGraph.spec.ts`（`@p1`）——`perforce-graph.view` 是 renderer Action2，无 p4 服务器也能开（显示 unavailable 态），断言 `[data-testid="perforceGraph-editor"]` 可见。

#### e2e 两个必踩坑

1. **e2e 跑 `out/main/index.js` 预构建产物**：改 renderer 后必须 `pnpm --filter @universe-editor/editor build`，改扩展后 `pnpm --filter @universe-editor/perforce build`，否则 e2e 用旧产物。
2. **`getByText('Perforce Graph')` 子串匹配**会同时命中标题 span 和 "Perforce Graph is unavailable…" 错误文案 → strict-mode violation。断言标题用 `{ exact: true }`。

### 验证

```bash
## 改了 extensions-common 后先重建（pnpm dev 下 watcher 自动）
pnpm --filter @universe-editor/extensions-common build
pnpm --filter @universe-editor/perforce build
pnpm --filter @universe-editor/editor build   # e2e 前必做

pnpm check   # lint + typecheck + 全量单测 + docs:check
pnpm --filter @universe-editor/editor exec playwright test -c e2e/playwright.config.ts specs/smoke.perforceGraph.spec.ts
```

改了用户可见文案/交互，同步 `docs/user/zh-CN/perforce/perforce-graph.md`（`pnpm docs:check` 校验内链）。

### 关键参考路径

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

### 其它

- 图谱是**只读历史视图**：不做提交/签出等写操作（那些在 SCM 侧栏，见上文 p4 插件节）。右键仅"复制变更号/复制提交信息/发送到 Agent Chat"。
- 加分页/加载更多：`P4GraphLoadResult.moreAvailable` + `PERFORCE_GRAPH_PAGE_SIZE`，`getGraphChanges` 跑 `-m <max+1>` 探测是否还有更多。

## Helix Swarm（P4 Code Review）集成

已拆出：Swarm 子模块（REST 客户端 / 审核领域模型 / 审核 UI / 认证）见 [`src/swarm/CLAUDE.md`](src/swarm/CLAUDE.md)。
