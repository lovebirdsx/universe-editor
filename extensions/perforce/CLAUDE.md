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
| CLI 封装 | `p4Service.ts` | `spawn('p4', argv)`（**数组、`shell:false`**，绝不拼 shell 串）；`exec`/`execJson`(`-Mj`)/`execTagged`(`-ztag`)；连接全局选项 `-p/-u/-c`；**env 净化**（剥离 `ELECTRON_*`/`NODE_OPTIONS` 防被劫持）；经 `ConcurrencyGate` 限并发。**非零退出不 reject**，只有 spawn 失败（p4 缺失 ENOENT）才 reject |
| 输出解析 | `p4Output.ts` | 纯函数：`parseMarshalJson`（`-Mj` 每行一 JSON）、`parseZtag`（`... key value`，空行分记录）、`collapseNumberedKeys`（`depotFile0/1/…` 并行键折叠成数组）。**全部纯、可对 fixture 单测** |
| 领域解析 | `openedParser.ts` `fstatParser.ts` `shelveParser.ts` `blameSource.ts` `changeSpec.ts` `changelist.ts` | 把 p4 记录 → 领域模型 / 分组。**纯，无 p4 I/O**，各带 `__tests__` |
| 连接发现 | `clientDiscovery.ts` | 无连接 `p4 -ztag info` 解析 client/root/user（**不取 port**，见下节红线）；`perforce.port/user/client` 兜底；folder 不在 p4 workspace 内 → 返回 undefined（禁用 provider） |
| client 编排 | `client.ts` `clientManager.ts` `baselineProvider.ts` | `PerforceClient` = 一个 client 一个 `SourceControl` + 动态 changelist 分组 + refresh 编排 + 所有 p4 操作方法；`ClientManager` 按 root 路由；`BaselineProvider` = `#have` 内容缓存（`depotFile#rev` 键） |
| 入口 & UI 挂钩 | `extension.ts` `p4StatusBar.ts` `autoEdit.ts` `p4Decoration.ts` `p4Error.ts` `nls.ts` | `activate` 发现 client → 注册全部命令；状态栏、autoEdit、行装饰、错误分类/toast、本地化 |

**加一个新 p4 能力的典型路径**：`client.ts` 加一个方法（多半一行 `this._mutate(...)`）→ `extension.ts` 注册对应命令 → `package.json` 加 command + menu 项 + nls 两文件。若要新解析逻辑，先在纯解析模块写 + 单测。

## ⚠️ 连接解析：`-p` 端口绝不从 `p4 info` 推导

**头号连接坑（踩过）**：`p4 info` 的 `serverAddress` 是**服务器自报的内部 bind 地址**（P4P 代理后端常是 `p4:1666` 这种不可路由地址），**不是**客户端拨号用的 P4PORT。真正的 P4PORT 由 p4 CLI 自己按 **cwd 逐级向上查找 P4CONFIG/P4ENVIRO/env/`p4 set`** 解析。

- `connectionFor`（`clientDiscovery.ts`）**只在** `perforce.port` 显式设置时才传 `-p`（逃生阀）；否则**省略 `-p`**，让 p4 自解析 P4CONFIG。插件用 `clientRoot` 做子进程 cwd（`P4Service` 构造），p4 本就能解析出对的 port/user/client。
- `-c`（client）**必须传**：扫描兜底分支里 folder 属于 ambient 之外的 client 时，不钉 `-c` 会让 cwd 的 P4CONFIG 解析回 ambient client。`-u` 已知则传。
- **诊断法**：命令静默失败（exit 0 但 stderr `Connect to server failed; TCP connect to <addr> failed`）→ 多半是 `-p` 传了错地址。对比 `p4 <cmd>`（裸跑，走 P4CONFIG）与插件拼的 `-p ... -u ... -c ...` 即可定位。

## ⚠️ `-Mj` 在部分命令上会退化成单个 `data` blob

`-Mj`（marshalled JSON）并非对所有命令都吐结构化字段。**观察到 P4D 2024.2 上 `annotate` / `describe` 的 `-Mj` 把每行/整块塞进单个 `{"data":"..."}`**，丢掉 `lower`/`upper`/`user`/`time`/`desc` 等字段；只有 `-ztag` 才带这些。`fstat`/`opened`/`changes` 的 `-Mj` 正常。

- blame（`getBlame`）因此改用 `execTagged`（`-ztag`）跑 `annotate -c -q` + `describe -s`。**加任何"报表型/多字段"命令前，先在真服务器上 `p4 -Mj <cmd>` 验证它是否吐结构化键**；不确定就用 `-ztag`（`execTagged`）更稳。
- 另一坑：`-ztag annotate -u` 的 `time` 是**显示日期串**（`2026/04/30 05:56:38`）而非 unix 秒 → 别 `Number()*1000`。author/time 从 `describe`（`time` 是干净 unix 秒）取，annotate 只取 `lower` 拿 changelist。


## ⚠️ `opened`/`reconcile -n` 的 `clientFile` 是 client 语法，不是本地路径（踩过）

**头号数据坑**：`p4 opened` 和 `p4 reconcile -n` 的 `-Mj` 输出里 `clientFile` 字段是 **client 语法**（`//客户端名/相对路径`），**不是本地文件系统路径**——**只有 `fstat` 的 `clientFile` 才是本地路径**（[Perforce filespecs 文档](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/filespecs.html)）。曾经 `openedParser.ts`/`reconcileParser.ts` 注释误写「Local filesystem path」并直接当本地路径用，引出两个连锁 bug：

- **改动显示成整文件删除**：`client.ts` `openChange()` 里 `readFile('//客户端名/...')` 在 Windows 被当 UNC 主机访问 → 失败 → `modified=''` → diff 右侧空 → 看起来像删了整个文件（不是真删除，是读不到工作区内容）。
- **`//` URI 报错**：同一 client 语法路径喂进编辑器打开源文件，`file://` URI 的 `//` 变成非法 authority/双斜杠 → `_validateUri` 抛 `path cannot begin with two slash characters`。
- **附带**：文件监视增量 reconcile 里 `norm(本地路径)` vs `norm(client语法)` 比不上，去重/清理静默失效。

**修法**：纯函数 `pathUtil.ts` `clientToLocalPath(clientFile, clientRoot)`——client 语法**天然以 client root 为根**，故只需前缀替换（去掉 `//客户端名/` 拼到 `clientRoot`），**无需 `p4 where` 往返**；已是本地路径（非 `//` 开头）原样返回，可无条件套用。`parseOpened`/`parseReconcile` 加可选 `clientRoot` 参数（`client.ts` 传 `this.root`；测试省略则保持 verbatim）。`getOpenedForGraph` 因此也顺带修好（`f.clientFile` 现在是本地路径，`where` 只兜底缺失项）。

- **fake-p4 也要对齐**：`fake-p4.mjs` 原来 `opened`/`reconcile` emit 本地路径 → 掩盖了这个 bug。现在 `clientSyntaxOf()` emit client 语法（`//client/rel`），并补了 `fstat`/`print`（baseline diff 需要）+ `toDepotFile()`（吃本地/depot/client 三种语法）。
- **回归护栏**：`smoke.perforceCollectChanges.spec.ts` 的 `phantom delete @regression`——点 reconcile 行 → 断言 diff 的 modified 侧 == 真实盘上内容（不是空）。改坏 `clientToLocalPath` 会红。单测见 `pathUtil.test.ts`/`openedParser.test.ts`/`reconcileParser.test.ts`。


## ⚠️ 巨量 stdout 会撑爆 V8 字符串上限 → 扩展宿主崩溃（踩过）

**根因（宿主崩溃，`01eece1e` 落盘后才抓到堆栈）**：`_spawn` 曾无条件 `Buffer.concat(stdout).toString('utf8')`。超大 depot（`G:/aki_3.6/...`）上某条命令（`print` 巨型文件 / `describe` 巨型 CL）stdout 累积超过 **V8 单字符串上限 `0x1fffffe8`（≈512MB）**，`toString` 抛 `Cannot create a string longer than ...`——**从异步 `close` 回调抛出、无 try/catch → 冒泡成 `uncaughtException` → 整个 extension-host 进程 `exit(1)` 崩溃重启**（不只是这一条 p4 命令失败，所有扩展一起挂）。

- **现防护（`p4Service.ts` `_spawn`）**：边收边计 `stdoutBytes`，超 `DEFAULT_MAX_OUTPUT_BYTES`（256MB，远低于 512MB 限）即清缓冲 + `proc.kill()`，`close` 时优雅返回 `{stdout:'', stderr:'... exceeded NMB and was aborted', exitCode:1}`；`toString` 再套 try/catch 兜底病态输入。`P4ExecOptions.maxOutputBytes` 可按命令覆写（测试用小 cap 复现）。
- **红线**：`_spawn` 的 `close`/`data` 回调是**异步**的，里面任何 throw 都无处可接 → **必须 resolve 成失败结果，绝不让异常逃逸**。加任何新的流式/缓冲逻辑（大输出命令）都守住这条：p4 命令失败是一等公民（非零退出本就不 reject），宿主崩溃不是。
- **诊断法**：崩溃看 `<userData>/logs/<session>/extensionHost.log`（dev = `AppData/Roaming/Universe Editor - Dev/logs`），`uncaughtException` 堆栈直指 `extension.js` 行；`Buffer.toString` + `Cannot create a string longer than` 就是这个坑。测试见 `p4Service.test.ts`（`vi.mock('node:child_process')` 注入假子进程，`exec` 经并发门须 `await flush()` 再 emit）。


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
- **性能门控（关键取舍）**：reconcile 扫描在大 workspace 慢，**默认不在每次 refresh 跑**。`_reconcileActive` 粘性开关：`refresh({reconcile:true})`（cleanRefresh）/ 收集操作 / `perforce.autoReconcile` 才开启；关闭时 `_refreshReconcile` 直接清空组返回，**零额外 p4 调用**。
- **固定组生命周期**：reconcile 组在**构造函数里第一个** `createResourceGroup`（SCM 视图按创建序渲染 → 保证置顶），`hideWhenEmpty=true`，**不进 `_groups` Map**（`_applyGroups` 对账不碰它，避免被 dispose），`dispose()` 里单独释放。
- **行 contextValue = `RC`**（`p4Decoration.ts` `toReconcileResourceState`），与已签出行区分，menu `when` 用 `scmResourceState == RC` 单独挂「收集」inline。
- **cleanRefresh 正名**：原来与普通 refresh 等价（占位），现在 = 带 reconcile 发现的全量刷新。
- **持久化 + 启动秒开**：reconcile 组不再是纯派生——`_reconcileFiles` + `_dismissed` 经注入的 `ReconcileStore` 落盘（`extension.ts` 用 `context.workspaceState`，key = `perforce.reconcile.<normRoot>` 按 client root 分 repo）。构造后、首个 refresh 前调 `client.restoreReconcile()`：载入快照 + `_reconcileActive=true` + 渲染，**不设 `_fullScanRequested` → 启动不跑 `reconcile -n`**；首个普通 refresh 走 cheap path 按最新 `opened` 过滤已签出项即可自洽。写入统一收敛在 `_setReconcileFiles`（过滤 dismissed → 存 `_reconcileFiles` → 渲染 → `_persistReconcile`）。`_goOffline` 只清 UI 不清盘。`create`/构造函数新增可选 `store?` 参数，测试省略 = 纯内存 no-op。
- **移出列表（永久忽略 = dismissed）**：`_dismissed: Set<string>`（normalized clientFile）。`dismissReconcile(paths)` 加入并落盘；`filterDismissed`（`reconcileParser.ts` 纯函数）在 `_setReconcileFiles` 末端统一过滤 → 即使 Clean Refresh 全量扫到也不冒出来。文件夹/组目标经 `expandDismissPaths`（纯函数，按 `norm` 前缀展开成当前列表里的具体条目；组头传 `<root>/...`）。`clearDismissed()` = 逃生阀（清空 + `refresh({reconcile:true})`）。**收集/移出会解除 dismiss**：`reconcile()`/`moveToReconcile()` 成功前调 `_undismiss(paths)`（显式重新纳入视野）。命令 `perforce.dismissReconcile`（icon `eye-off`，挂 RC 行 inline + reconcile 组/文件夹）、`perforce.clearDismissed`（reconcile 组头）。
- **move out 增量化（去卡顿）**：`moveToReconcile`/`revertReconcile` **不再** `_fullScanRequested=true` 跑全量 `reconcile -n <scope>`，改为对已知 path 调 `refreshReconcilePaths(paths)`（O(改动数)）。目录版先 `_concreteReconcilePaths`（剥 `/...` 后缀 + `expandDismissPaths`）展开成具体条目再增量扫。测试 `clientReconcilePersist.test.ts` 断言移出后所有 `reconcile -n` argv **不含** `//...` / `<root>/...`。

## 命令路由（一 id 多 client）

所有 p4 source control 共享 id `perforce`，靠**每个 client 唯一的 root** 路由（`clientManager.ts`）：

- provider/组命令 → 参数带 `{ rootUri }`，精确命中。
- 资源/文件命令 → 参数带绝对 `resourceUri`，取 **root 最长前缀**命中的 client。
- 无参命令 → `mgr.active`（跟随 SCM 视图选择，经 `perforce.setActiveRepo` 推入）。
- 路径比较统一走 `pathUtil.ts` `norm()`（正斜杠、去尾斜杠、小写盘符），**别手写大小写折叠**（ESLint 护栏会拦，见 memory `eslint-path-identity-guardrails`）。

## 操作方法约定（`client.ts`）

绝大多数 mutating 操作走 `_mutate(label, args, paths?)`：跑 p4 → 失败 toast（`notifyP4Failure`）→ **清 baseline 缓存** → **refresh**。加新操作时优先复用它。

- 需要 spec 表单的（`change -i`、`change -o` 改描述）走 stdin `input`，见 `newChangelist`/`editChangelistDescription` + `changeSpec.ts`（`buildNewChangeSpec`/`replaceDescription`/`parseDescription` 纯函数）。
- `refresh()` 有**合并（coalesce）**：并发调用排队成一次，`_refreshing`/`_queued` 守卫；每步查完 `if (this._disposed) return`。支持 `refresh({reconcile:true})` 开启 reconcile 发现（见上文待收集分组）。**在飞时的并发调用会 `await _inFlightRefresh` 等在飞刷新链结束**（不提前返回）——调用方 promise 语义 = "我要的刷新已被真正执行"；SCM 标题栏 Refresh 按钮的禁用/转圈正是挂在这个 promise 上（renderer `ScmViewToolbar` 按 `命令@rootUri` 跟踪在飞命令，`ActionButton` busy 时禁用 + **原图标原地旋转**——git syncing 同款表达，无图标的命令才兜底 Loader2）。改 refresh 语义时同步改 git 侧 `repository.ts`（同构）。测试：`clientRefresh.test.ts`（perforce）/ `repositoryRefresh.test.ts`（git）/ `ScmViewToolbar.pending.test.tsx`（renderer）。
- SCM 标题栏按钮**不走** `ViewTitleActions`（那是 view/title 的通用渲染），而是 `ScmViewToolbar.tsx`（经 view toolbar registry 挂进 SideBar 头）→ `scmShared.tsx` `menuActions(MenuId.ScmTitle, {scmProvider}, 'navigation')` + `ActionButton`；overflow（`…` 菜单）走 `menuToRows`。按钮点击 = `commandService.executeCommand(cmd, {rootUri, sourceControlId})`，promise 经 RPC 直通扩展宿主 handler。
- **view/title 按钮（`ViewTitleActions.tsx`）有同款 pending**：点击后禁用 + 原图标旋转，await executeCommand settle 恢复。Swarm Reviews 的手动刷新走这里——但 `swarm.refreshReviews` 的 handler 只是同步发事件总线（`requestSwarmReviewsRefresh`），真实 fetch 在视图侧，故 bus 带**完成回执**：请求返回 promise，视图 reload 完成后 `resolveSwarmReviewsRefresh()` flush；`trackSwarmRefreshConsumer()` 计数防无消费者时 promise 挂起（按钮永久禁用）。给任何"命令只发事件、视图干活"的按钮加加载态，照此 ack 模式办。
- 破坏性操作（delete/revert/revertChangelist/submit/deleteShelved）在 `extension.ts` 命令层 `showWarningMessage` 二次确认，**不要**把确认塞进 client 方法。**submit 直达 depot 不可撤销**（不像 git 有 amend/undo）→ 确认框文案须注明「This cannot be undone / 此操作不可撤销」。
- **还原两档**：`revert`（单文件）、`revertChangelist`（整组 `p4 revert -c <id> //...`，破坏性、需确认）、`revertUnchanged`（`revert -a`，只还原内容未变的、安全、无需确认）——三者别混。

## 连接状态 & 离线

server 端状态、**无 FS watcher**。`ConnectionState` = `connected|offline|not-logged-in`。任何 p4 命令非零退出经 `p4Error.ts` `classifyP4Error` 分类：session 过期/未登录 → `not-logged-in`（提示重新登录），连接失败 → `offline`。`_goOffline` 清空组 + count=0 + emit（状态栏更新），**不刷屏弹错**。

捕捉**编辑器外改动**有三条互补手段（都因服务器无 watcher 而必需）：
- **文件监视自动刷新**（`workspaceWatcher.ts`，`perforce.autoRefresh` 默认**开**）：node `fs.watch(**打开的文件夹** workspace.rootPath,{recursive:true})` 监视磁盘（对齐 git `repositoryWatcher.ts`），**去抖（400ms）**后触发 `refresh({reconcile:true})`，编辑器保存与外部工具改动都覆盖。递归不可用时降级为非递归 watch（会落日志），忽略 `.git`/`node_modules`/临时文件。**⚠️ 坑：绝不能监视 `client.root`**——p4 client root 是整个 workspace 映射（大型游戏项目可能在打开文件夹的很多层之上），对它递归 watch 在 Windows 上慢且常直接失败→降级非递归→**嵌套子目录的改动永远看不到**（"改了文件不进待收集组"的真 bug）。同理 reconcile 扫描范围也从 `//...` 收窄到打开文件夹（`client.setReconcileScope(folder)` → `reconcile -n <folder>/...`），否则大 depot 每次保存全盘扫。**首party 可信扩展跑在 host 进程，可直接用 `node:fs`**。
- **autoEdit**（`autoEdit.ts`，默认关）：`onDidChangeTextDocument` 首次改动即 `p4 edit`。
- **轮询**（`startPolling`，`perforce.refreshInterval` 秒，最小 10s 地板，默认关）：定时兜底，留给共享盘/CI。
- **状态栏计数**：`ClientStatus` 带 `openedCount`/`reconcileCount`，`p4StatusBar.ts` 连接态下显示「client名 N个已打开 M个待收集」，对标 git ahead/behind。刷新在 `_doRefresh` 末尾更新 `_openedCount`，`_goOffline` 清零。

## 宿主泛化：p4/git 共用一个无偏见 host

dirty-diff gutter 与 inline blame 原本硬编码 `git.*` 命令；已抽象为「**provider 上报的 capability**」，host 零 SCM 知识：

- 契约在 `packages/extensions-common/src/contracts/dirtyDiff.ts`（`DirtyDiffCapabilities` + `dirtyDiffCommandId(providerId, cap)`）和 `blame.ts`（`BlameCapabilities` + `blameCommandId`）。命令 id = `<providerId>.<capability>`（`git.getHeadContent` / `perforce.getBlame`）。
- 渲染侧 `DirtyDiffContribution.ts` / `GitBlameContribution.ts` / `dirtyDiffActions.ts` 注入 `IScmService`，用 `resolveScmProviderId(sourceControls, fsPath)`（`ScmService.ts`，root 最长前缀，键走 `scmProviderPathKey`）解析归属 provider → 派生命令 id 调用。
- **能力探测靠 `CommandsRegistry.getCommand(id)`**：贡献命令会真的注册进 CommandsRegistry。p4 无暂存区 → **不注册** `perforce.stageChange` → host 的 `_activeProviderSupportsStage()` 返回 false → Stage 按钮自动隐藏（`canStage` 回调）。**给 p4 加/减能力就是加/减对应 `commands.registerCommand`**。
- p4 侧实现：`getHeadContent`（`#have` 内容或 null）、`getBlame`（`annotate -u -c -q` + 批量 `describe -s` 补 summary，返回 == `BlameResultDto` 的 `P4BlameResult`）、`openChange`（have vs 本地 diff）。这些是**运行时命令**（`commands.registerCommand`，不进 package.json），对齐 git。

> 改宿主泛化时：`packages/extensions-common` 与渲染 contribution 两侧都要动；改完先 `pnpm --filter @universe-editor/extensions-common build` 再让 apps 看到。测试见 `dirtyDiffActions.test.ts` / `GitBlameContribution.test.ts`（都注入了带 `{id,rootUri}` 的 IScmService fake）。

## 菜单 & when 子句（`package.json`）

- SCM 视图内菜单用 `scmProvider == perforce` 门控（**`scmProvider` 只在 SCM 视图作用域有效，explorer/editor 菜单用不了它**——这是踩过的坑）。**explorer/editor 菜单用 `resourceScmProvider =~ /\|perforce\|/` 门控**（可选叠 `!explorerResourceIsFolder` / `scmActiveResourceHasChanges` / `!isInDiffEditor`）；p4 的签出/新增/删除/打开更改/收集就是这么进 explorer 右键 + editor 标题栏的，命令 handler 复用 SCM 版同一个。
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
- **inline 图标精简**：`openChange` 从文件行 inline 移除（单击行已走 `resource.command` 打开 diff，按钮冗余），命令保留在右键 `1_open` 组 + explorer/editor title。文件行常驻 inline = revert/reopen/moveToNew/shelve(+resolve 仅 U)。default 与编号 changelist 组头 inline 对齐（都有 shelve），差异仅 default 无 Submit（p4 不能直接 submit default，固有限制）。`hideWhenEmpty:false` 对所有 pending 组统一（空编号 CL 也常显，留作 drop 目标）。
- ⚠️ **manifest 图标名必须在 `apps/editor/src/renderer/workbench/viewContainerHeader/icon-map.ts` 的 `ICON_MAP` 登记**（踩过）：p4 `package.json` menu 项的 `"icon"` 只是**名字**，渲染侧 `resolveHeaderIcon(name)` 查这张表拿 lucide 组件；**表里没有 → 返回 undefined → `ActionButton` 静默退化成显示 title 文字**（不是报错，是文字按钮）。给 p4 加带图标的命令/菜单，除了写 manifest，**还要在 icon-map 补 `name→LucideIcon`**。这张表是全局共享的（container + 命令 + 下面的组头图标同源）。
- **changelist 组头前导图标（UI 一致性）**：`ScmGroupRow` 按 group-id 类别渲染前导 glyph（`ScmView.tsx` `groupIconName`，已导出+单测）——**default 与 `cl:<n>` 同用 `changelist` 图标**表达「本质都是 changelist」（修「DEFAULT 与编号组样式不一」的观感），`reconcile`→`reconcile`(list-plus)、`shelved:`→`archive`；未识别 id（git 的 workingTree/index）返回 undefined 不渲染 → host 无侵入。图标名同样走 icon-map。配套：default 组 label 缩短为「默认 / Default」（独立 nls key `perforce.group.defaultShort`，别动仍用完整名的 quickpick/revert 确认文案）。

## 解析器测试套路（纯函数，node 环境）

领域/输出解析全部纯函数 + `src/__tests__/*.test.ts`，对 fixture 断言（`openedParser`/`reconcileParser`/`changeSpec`/`changelist`/`shelveParser`/`blameSource`/`pathUtil`/`p4Output`）。**新增任何解析逻辑先写纯函数 + 单测**，client 只做编排。mock extension-api 套路见 create-extension（`vi.mock('@universe-editor/extension-api', …)`）。带 I/O 的 `p4Service` 用 `vi.mock('node:child_process')` 注入假子进程测（见上节崩溃防护）。当前 perforce 包 13 个测试文件。

## 密钥 / env 安全红线（重申）

- 密码/ticket 只经 stdin → `p4 login`，绝不落 settings/日志/RPC（见文件头）。
- 子进程 env 走 `sanitizeEnv()`（`p4Service.ts` `ENV_DENYLIST`），与 git spawner 同款——防 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` 把 node 型子进程劫持。加任何新 spawn 都必须走 `P4Service`，别自己 `spawn`。
- 所有参数用**数组**传给 `spawn`，`shell:false`，路径/描述不进 shell，杜绝注入。

## 配置项（`perforce.*`）

`enabled`(默认 true)、`port`/`user`/`client`（连接兜底，优先 `p4 set`/P4CONFIG）、`maxConcurrent`(4)、`refreshInterval`(0=关，最小 10s)、`autoEdit`(false)、`autoReconcile`(false，每次 refresh 带 reconcile 发现)、`autoRefresh`(true，文件监视触发带 reconcile 发现的自动刷新)、`cache.*`。加新配置：`package.json` `contributes.configuration` + nls description key，读用 `workspace.getConfiguration('perforce').get(key, default)`。

## 验证

```bash
# 改了 extensions-common / extension-host 后先重建 dist（pnpm dev 下 watcher 自动）
pnpm --filter @universe-editor/extensions-common build
pnpm --filter @universe-editor/perforce test    # 仅跑 p4 单测（快）
pnpm check                                       # lint+typecheck+全测+docs:check，仅看错误
```

- 用户可见改动（命令名/菜单/配置/交互）→ 同步 `docs/user/zh-CN/perforce/`（overview / daily-workflow / changelists-and-shelving / resolve-and-advanced），内部链接由 `pnpm docs:check` 校验，别留死链。
- 交互流程改动 → `pnpm e2e`（本地 Windows 有 launch flake，交 CI）。
- 打包自动收录：`scripts/release/runtime-resources.mjs` `discoverBuiltinExtensions` 用 `readdirSync` 扫 `extensions/`，perforce 的 `files:["dist","package.nls.json","package.nls.zh-cn.json","icon.svg"]` 必须齐（`assertPackagedFile` 校验）。

## e2e：fake p4（无需真 p4d）

本机 / CI 有 `p4` client 但**无可达 p4d**，`p4 info` 发现失败 → provider 整体禁用，任何 p4 端到端链路都跑不起来。故有一套 **fake p4**：
- `p4Service._spawn` 认 **`UNIVERSE_P4_PATH`** 覆盖 `spawn('p4')`；`.mjs/.js/.cjs` 结尾则用 `process.execPath <script>` 跑（宿主里是 Electron-as-node，`sanitizeEnv` 会剥 `ELECTRON_RUN_AS_NODE`，`_spawn` 对该情况**重新补回** `=1` 否则起成 GUI Electron）。纯逻辑 `resolveP4Command()` 已导出 + `p4Service.test.ts` 守。
- `extensions/perforce/e2e/fixtures/fake-p4.mjs`：**磁盘状态** fake，depot/have/opened 存一个 JSON（`UNIVERSE_P4_FAKE_STATE`）；`reconcile -n` 真去 walk client root 比对磁盘 vs have-revision，`edit/add/delete/reconcile/revert` 真改 opened 集。依赖零、纯 Node。要覆盖新 p4 子命令就在它的 `switch(command)` 里加一个 case，注意 `-Mj`(默认) 与 `-ztag` 两种输出模式（`emit()` 已分流）。
- `extensions/perforce/e2e/fixtures/perforceApp.ts`：cold-launch fixture（开 workspace 会重启宿主，不能用 shared 实例），`test.use({ p4Seeds:{files:[...]}, openSubdir })` 定制，`perforce` fixture 给 `clientRoot`/`openDir`/`file()`。spec 在 `extensions/perforce/e2e/specs/`（如 `perforceCollectChanges.spec.ts`，改盘上文件 → 断言进「Changes to Reconcile」组）。**⚠️ Playwright option fixture 的值不能是裸数组**（会被当 tuple 只取首元素 → `seeds is not iterable`），故种子包一层对象 `P4SeedConfig{files}`。
- 改了扩展 `src/` 后 e2e 用的是 `dist/`：先 `pnpm --filter @universe-editor/perforce build`；改了 app 侧（renderer/main）先 `pnpm --filter @universe-editor/editor build`（e2e 跑 `out/`）。**⚠️ 单跑某个 spec 必须带 `UNIVERSE_E2E_NO_TAG_FILTER=1`**（在 `extensions/perforce` 目录下 `npx playwright test -c e2e/playwright.config.ts perforceCollectChanges`）——默认 pass 的 grepInvert 排除 `@regression`/`@serial` 等 tag，p4 spec 基本全带 `@regression`，不带该 env 会报 "No tests found"（机制见 `packages/e2e-harness/src/playwrightConfig.ts`）。

## 关键参考路径

- `docs/plan/perforce-scm-plugin-plan.md` —— 5 阶段实施计划 + 设计（§2 分组模型差异、host 泛化策略、密钥红线原文）
- `docs/plan/perforce-collect-changes-ux-plan.md` —— 「收集修改」体验对齐 git 的设计 + 实施状态（reconcile 分组、菜单入口、聚焦刷新、组级还原、多选宿主受限）
- `extensions/perforce/src/p4Service.ts` —— CLI 封装 + env 净化 + `-Mj`/`-ztag`
- `extensions/perforce/src/client.ts` —— PerforceClient：分组对账 + `_mutate` + 全操作方法 + reconcile 分组/收集 + getHeadContent/getBlame/openChange + polling + 状态计数
- `extensions/perforce/src/extension.ts` —— activate + 全命令注册 + 路由 helper（resourcePath/groupChangelistId/resolveTargetPath，含 `uriToFsPath` explorer 传参修正）
- `extensions/perforce/src/reconcileParser.ts` —— `reconcile -n` 输出解析（纯 + 单测），待收集分组数据源
- `extensions/perforce/src/clientManager.ts` / `clientDiscovery.ts` —— 路由 / `p4 info` 发现
- `extensions/perforce/src/changelist.ts` / `p4Output.ts` —— 分组纯逻辑 / 输出解析（numbered 并行键）
- `extensions/perforce/src/{openedParser,fstatParser,shelveParser,blameSource,changeSpec}.ts` —— 领域解析（各带 __tests__）
- `extensions/perforce/src/{baselineProvider,p4Decoration,p4Error,autoEdit,p4StatusBar,concurrency,pathUtil,nls}.ts`
- `packages/extensions-common/src/contracts/{dirtyDiff,blame}.ts` —— provider capability 契约（宿主泛化）
- `apps/editor/src/renderer/services/extensions/ScmService.ts` —— `resolveScmProviderId`（单个最具体 owner，dirty-diff/blame 路由）/ `resolveScmProviderIds`（全部 owner，菜单门控）/ `encodeScmProviderIds`（`|a|b|` 成员编码）/ `scmProviderPathKey`
- `apps/editor/src/renderer/contributions/{DirtyDiffContribution,GitBlameContribution}.ts` —— 渲染侧消费 capability + `CommandsRegistry.getCommand` 能力探测
- `extensions/git/` —— 对照样板（Repository/RepositoryManager/gitError/nls 都是 p4 的镜像来源）
- 相关 skill：`create-extension`（插件通用套路）；dirty-diff 内联 peek UI 见 `apps/editor/src/renderer/workbench/scm/CLAUDE.md`
- 相关 memory：`extension-system-progress` / `eslint-path-identity-guardrails` / `dirty-diff-inline-peek-feature` / `path-comparison-convergence` / `perforce-collect-changes-ux`

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
3. `services/editor/PerforceGraphEditorInput.ts` —— `EditorInput` 子类，固定 URI `universe:/perforceGraph`

Action2 在 `actions/index.ts` `registerAction2`。

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

**Helix Swarm** 是 Perforce 官方的 web 代码审核系统。本集成把审核流程搬进编辑器，对标 GitHub PR：**发起审核 → 看列表/状态 → 打分（vote）+ 评论 → 改状态（transition）→ 行内评论 + 任务**。它是 `extensions/perforce` 插件的一个**子模块**（`src/swarm/`），复用 p4 插件的连接 / 认证 / spawn 基础设施。

> 先读上文「扩展内置 Perforce（p4）插件」节（分层架构、`P4Service`/`client`、连接红线、密钥红线、`-Mj`/`-ztag` 坑）——本节只讲 **Swarm 特有**的东西：REST 客户端、审核领域模型、审核 UI、认证。

### Swarm 领域模型（先建立心智模型，别拍脑袋）

- **review ↔ shelved changelist**：一个 review 追踪一个**搁置（shelved）的 changelist**。发起审核 = 把 CL `p4 shelve` 后 `POST /reviews`。
- **version（版本）**：每次重新 shelve 到同一个 review = 新增一个 **version**。`review.versions[]` 每项有 `{ rev, change, pending, time }`——`change` 是那个版本对应的 changelist 号，**diff 就靠它取快照**（见下"diff 数据源铁律"）。⚠️ **`rev` 不唯一**：未 approve 前的多次 re-shelve 全部报同一个 rev（rev 只在 approve 时递增），版本身份必须用数组位置 / `change`，绝不能把 `rev` 当唯一键（SwarmReviewEditor 曾因此把选择器卡在最老 shelf）。
- **状态机是服务器权威的，绝不客户端计算**：state = `needsReview` / `needsRevision` / `approved` / `rejected` / `archived`。**合法的下一步永远 `GET /reviews/{id}/transitions` 问服务器**（它按当前用户 + 规则算），拿到 `{ state: label }` 映射后渲染成按钮。绝不在客户端硬编码"从 X 能到 Y"。`approved:commit`（Approve and Commit）是带 `:commit` 后缀的特殊 transition。
- **task 状态机**：评论可标记为 task（`comment` → `open` → `addressed` → `verified`），不能跳级（`open`→`verified` 必须先 `addressed`）。这是**客户端**的合法迁移集（`SwarmInlineThread.tsx` 的 `nextTaskStates()`），因为 Swarm 对 taskState 迁移不做服务器校验。
- **vote**：`up` / `down` / `clear`。

### 📋 dashboard「Needs My Action」铁律：`participants=me` 不展开 group/project

`SwarmClient._loadDashboard` 本地推导 needsAction（**故意不调 `dashboards/action`**：v9-only、此部署会 504）。但 **Swarm 的 `reviews?participants=<me>` 过滤器只匹配 individual participant（被单独指派为 reviewer、或已投票/评论的人），绝不展开 group/project 成员**。于是纯通过 Swarm project（如 `swarm-project-typescriptreview`）或 group 关联、用户还没个人参与的 review，`participants=me` **永远查不到**（实测穷尽翻 600 条不出现），从不进 needsAction——投票后才变 individual participant，但那时往往已 approved 被状态过滤掉，表现为「从来不出现」。

- **补法**：`perforce.swarm.needsActionAuthors`（发起者集合，持久化配置）非空时，`_loadDashboard` 并发多发一路 `listReviews({ author: [...authors], state: ['needsReview','needsRevision'] })`，其 open review 并入 needsAction（`deriveNeedsAction` 按 id 去重合并 authored+participating+byAuthor）。空集=仅 participants（旧行为）。dashboard command handler 从 `workspace.getConfiguration('perforce').get('swarm.needsActionAuthors')` 读配置传入；in-flight 合并 key 须纳入 authors 签名。
- **实测确认的过滤器语义**（v9，别再逐个试）：`author[]=a&author[]=b`、`state[]=needsReview&state[]=needsRevision` 都是**精确 OR**；`author=` 命中该作者全部 review。而 **`group=` 参数被服务端忽略**（不同 group 返回相同集合）；`project=<name>`（= `swarm-project-<name>` 去前缀）**真生效**但一个 project 就动辄 200+、全公司审核池并集 >500，直接并入会淹没列表——所以走 author 白名单而非 project/group 展开。

### Activity Bar 角标 + 状态栏计数（Needs My Action 计数）

`swarmViewState.ts` 的 `swarmNeedsActionCount`（模块单例 observable）是唯一计数源，两个写入方、两个读取方：

- **写入①`SwarmReviewNotificationContribution.refresh()`**（后台轮询，view 关闭也在跑）：`_computeDisplayed` 算出**侧栏分组口径**的列表（filterNeedsAction + ignore split，**不排除自己 authored 的、不含关键词**），`.set(displayed.length)`；通知集再从中排除 authored（两种口径一处算，别分叉）。
- **写入②`SwarmReviewsView` 的 effect**（view 挂载期间）：`needsActionActive.length` 变更即写回（vote/ignore/过滤后即时更新）。
- **读取①`SwarmActivityContribution`**（`ActivityBarBadgeContributions.ts`，AfterRestore 注册）：autorun 读计数 → `IActivityService.showActivity('workbench.view.swarm', {count})`，0 时撤角标。ActivityBar 已按容器通用渲染 `activitybar-badge-<containerId>` testid，无需改渲染层。
- **读取②底部状态栏**（`swarmStatusBar.ts`）：**被动显示 renderer 推送值**——同一 autorun 里 `executeCommand(SwarmCommands.setStatusCount, count)` 推给 host（先 `CommandsRegistry.getCommand` 判存在，perforce 缺席不刷 warn）。**host 绝不自己从 dashboard 推计数**：author 白名单/approvable/ignore 全在 renderer，host 自算必然分叉（真实 bug：侧栏 0、状态栏 30）。`SwarmStatusBarController` 只剩 `setCount` + `refresh()`（可用性 show/hide），不再有 startPolling；`perforce.swarm.pollInterval`（>0 秒，floor 10s）改作 `SwarmNotificationPoller` 的 tick 间隔，一条管线同时驱动通知/角标/状态栏。

**泄漏测试坑**：该计数 observable 是模块单例，前一个测试未 dispose 的 contribution 会在后一个（装 DisposableTracker 的）测试里继续响应 `.set()` 产生无父链 badge handle → 误报泄漏。非泄漏断言的测试用完必须 `store.dispose()`。

### Ignore / Unignore + 按 ID 打开（纯渲染层，不碰 host/API）

- **ignore 是纯客户端概念**：`services/swarm/swarmIgnoreStore.ts` 模块级单例（Emitter 永不 dispose，对标 `swarmViewState`）。持 `Set<id>` + `Map<id, SwarmReviewDto 快照>`，`attach(storage)` 惰性加载（幂等，view 与 editor 都 mount 时只load一次），GLOBAL 持久化 key `swarm.ignoredReviews`/`swarm.ignoredReviewMeta`。dashboard 数据源不变（host 不感知 ignore），**渲染时**用纯函数 `splitIgnored(reviews, ignoredIds)` 把 needsAction 分流出 IGNORED 组。
- **meta 快照是必需兜底**：被 ignore 的 review 若某次 dashboard 不再返回（作者移出 needsActionAuthors 白名单等），IGNORED 组靠 `getMeta(id)` 仍能渲染 + 提供 unignore。IGNORED 组空时不显示组头。
- **侧栏 + 详情页双向同步**：都订阅 `swarmIgnoreStore.onDidChange`；侧栏右键菜单据 `isIgnored` 显示 Ignore/Unignore，详情页 header 同理。ignore 时详情页用 `detail`（DetailDto）拼一份精简 `SwarmReviewDto` 传入（DetailDto 无 upVotes/downVotes，从 participants 现算）。
- **按 ID 打开**：`OpenSwarmReviewByIdAction`（`swarm.openReviewById`，renderer Action2）——`f1:true` + `MenuId.ViewTitle`(`when: view == workbench.view.swarm.reviews`, icon `go-to-file`)，`IQuickInputService.input({validateInput})` 取数字 id → `openEditor(new SwarmReviewEditorInput(id))`。命令 id **不进**扩展 package.json（renderer Action2 遮蔽护栏）。
- **IGNORED 受 reviewWindowDays 约束自动清理**：`SwarmViewContribution` 在 store hydrate 后 + 配置变更时调 `swarmIgnoreStore.pruneExpired(windowDays)`，按 meta 快照的 `updated` 删过期项（`updated===0` 缺失永不删、`windowDays<=0` 不删，对齐 dashboard 窗口语义；判定纯函数 `expiredIgnoredIds`）。删除走 store 的 delete+persist+fire，所有消费方（侧栏/详情页/角标/通知）经 onDidChange 收敛。被清理的 review 理论上回到 Needs My Action，但 dashboard 同样按窗口过滤，故实际不可见。
- **测试坑**：给 `SwarmReviewsView` 加了 `useService(IStorageService)`，其组件测试的 `createServices` 必须补注册 IStorageService（否则 useService 抛错，整个测试文件挂）。store 单测用 `vi.resetModules()` + 普通 `import` 隔离单例，**不能**用 `import(url?t=random)`（vitest 报 "Unknown variable dynamic import"）。

### UI 状态持久化（侧栏 + 详情页记忆，纯渲染层）

三条独立机制，别混：

- **侧栏折叠 + keyword（跨重启）**：`services/swarm/swarmReviewsUiStore.ts` 模块级单例（对标 `swarmIgnoreStore`：`attach(storage)` 幂等 + 同步 `isReady` + `onDidChange`，GLOBAL key `swarm.reviewsView.collapsed`/`swarm.reviewsView.keyword`）。`SwarmReviewsView` 的 collapsed/keyword 初值读它、变更写回。**筛选条件（author/approvable/hideApproved）不在这里**——那三个走 `perforce.swarm.*` config（settings.json，`SwarmConfigurationContribution`），是用户配置不是视图临时态。
- **消除 IGNORED 闪烁的根因修复**：ignore store 若在 view mount 后才异步 hydrate，dashboard 内存缓存命中时首帧 `list()` 返空 → 被 ignore 的 review 先闪现在 Needs My Action。修法两层：① `SwarmViewContribution` 注入 `IStorageService`，在 **BlockStartup** 阶段就 `swarmIgnoreStore.attach` + `swarmReviewsUiStore.attach`（app 启动即 hydrate，早于 view mount）；② store 加同步 `isReady`，view 用 `ignoreReady` gate 首帧不渲染分组作双保险。加了 store 的 `isReady` 后其单测补断言。
- **详情页版本/滚动/草稿（仅跨 tab 切换，内存）**：`swarmViewState.ts` 的 `_reviewEditorStates: Map<reviewId, {selectedVersion,compareVersion,commentDraft,filesScrollTop}>`（对标 `swarmReviewDetailCache`，**不跨重启**）。`SwarmReviewEditor` **用 useRef 读一次**初值（避免自身 scroll 写入 churn restore effect），三个 state 各一 effect 写回。文件列表滚动位置：`SwarmReviewFiles` 加 `initialScrollTop`/`onScrollTopChange` props，经 `Tree` 的 `rootRef` 拿容器、**capture 阶段** listen scroll（同时覆盖非虚拟=root 滚动与虚拟>200=内层 scroller）。Files 显示形式（list/tree）另走 GLOBAL storage（既有，未动）。测试坑：Map 是模块单例，`SwarmReviewEditor.test.tsx` 共用 reviewId '1001' 会串状态，须导出 `clearSwarmReviewEditorStates()` 在 before/afterEach 清。


### 三层技术栈（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| wire 类型 | `packages/extensions-common/src/contracts/swarm.ts` | renderer↔扩展共享 DTO（`SwarmReviewDto`/`SwarmReviewDetailDto`(含 `transitions`)/`SwarmDashboardResult`/`SwarmVoteRequest`/`SwarmTransitionRequest`(含 `commit?`)/`SwarmAddCommentRequest`(含 `context?`+`content?`)/`SwarmAddChangeRequest`/`SwarmUpdateReviewRequest`…）+ `SwarmCommands` 命令 id 常量。**必须**在 `index.ts` re-export |
| HTTP 客户端 | `extensions/perforce/src/swarm/swarmApi.ts` | 薄 REST 层：`get/post/patch`，拼 `/api/v{N}/…` URL，塞 Authorization header。**认了 `UNIVERSE_SWARM_BASE_URL` env 覆盖**（e2e fake server 用）。日志只打 URL + 状态码，**绝不打 body/header** |
| 认证 | `extensions/perforce/src/swarm/swarmAuth.ts` | `resolveTicket`（`p4 login -p` 取 ticket）+ `buildBasicAuth`（`Basic base64(user:secret)`）+ `resolveSwarmCredential`。**密钥红线见下** |
| 解析 | `extensions/perforce/src/swarm/swarmParser.ts` | Swarm JSON → DTO 的**纯函数**（`parseReviewList`/`parseReviewDetail`/`parseTransitions`/`parseComments`…）。可对 fixture 单测 |
| 客户端编排 | `extensions/perforce/src/swarm/swarmClient.ts` | `SwarmClient`：每个审核操作一个方法（`dashboard`/`listReviews`/`getReview`/`vote`/`transition`/`addComment`…）。组合 api + parser。持有 `SwarmClientConfig {baseUrl, apiVersion, user}` |
| 命令注册 | `extensions/perforce/src/swarm/swarmCommands.ts` | 注册全部 `perforce.swarm.*` 命令（`commands.registerCommand`）；`guard()` 把「未配置/未授权」失败映射成安全回退值；`SwarmClient` 按 config+active-client 签名**懒重建** |
| 状态栏 + 轮询 | `extensions/perforce/src/swarm/swarmStatusBar.ts` + `swarmNotificationPoller.ts` | 状态栏**被动显示** renderer 推送的分组口径计数（见上「Activity Bar 角标 + 状态栏计数」），host 只管用性 show/hide；轮询定时器在 host（`SwarmNotificationPoller`，Chromium 不节流），每 tick poke renderer `_workbench.swarmPollTick`；**新审核通知不在这里**——由 renderer 的 `contributions/SwarmReviewNotificationContribution.ts` 自带 60s 轮询兜底（首轮只 prime 基线不通知），以侧栏**最终显示**列表（作者/仅可审批/ignore 过滤后）为准发桌面通知；**窗口聚焦时 main 侧 `hostMainService.notify` 会门控掉 OS toast（`shown:false`），此时必须回退应用内 `INotificationService` toast（带打开动作）**——上升沿在发通知前已记入 `_known` 基线只消费一次，静默丢弃会导致该审核永远不再通知（曾是真 bug） |
| 审核列表侧栏 | `apps/editor/src/renderer/workbench/swarm/SwarmReviewsView.tsx` | Swarm Reviews viewlet：分组 + 关键词过滤 + 点开详情；`getTransitions` 驱动可审批图标与右键操作，菜单含打开/网页/复制/transition/obliterate |
| 审核详情主编辑区 | `apps/editor/src/renderer/workbench/swarm/SwarmReviewEditor.tsx` | 头部（审核网页链接/状态/作者/参与者/vote/transition/Update/Obliterate）+ 描述 + 版本选择器 + 文件列表 + review 级评论面板 |
| 文件 diff 编辑区 | `apps/editor/src/renderer/workbench/swarm/SwarmDiffEditor.tsx` + `SwarmInlineCommentController.ts` + `SwarmInlineThread.tsx` | Monaco diff + 行内评论（view-zone + overlay widget 托 React，对标 `InlineDirtyDiffController`） |
| 输入/状态/动作/贡献 | `services/editor/SwarmReviewEditorInput.ts` · `services/editor/SwarmDiffEditorInput.ts` · `services/swarm/swarmViewState.ts` · `actions/swarmActions.ts` · `contributions/SwarmViewContribution.ts` | 两个 EditorInput（见"身份隔离"）· view-state 单例 · Action2 · view 容器贡献 |

### 命令清单（`SwarmCommands`，全 `perforce.swarm.*`）

`ping` / `requestReview` / `updateReviewFromChangelist` / `listReviews` / `dashboard` / `getReview` / `getTransitions` / `createReview` / `vote` / `transition` / `obliterateReview` / `addChange` / `updateReview` / `listComments` / `addComment` / `setTaskState` / `getFileContent` / `describeVersion`。

- `getTransitions` 是列表与详情共用的服务器权威能力查询；列表里的“可 Approve”蓝色勾和右键状态操作都只能由它驱动。
- `obliterateReview` 走 `POST reviews/{id}/obliterate`，与 archived transition 不同，会永久删除审核。renderer 必须先做不可逆确认，服务端仍负责最终权限校验。

- **数据命令全走 `commands.registerCommand`（host 侧），renderer 用 `commands.executeCommand(SwarmCommands.xxx, arg)` 跨 JSON 边界调**。这些命令 **`requestReview`/`updateReviewFromChangelist`/`ping` 之外都不进 package.json `commands` 数组**——它们是纯数据 RPC，renderer 直接按 id 执行即可，无需声明（且声明会触发头号坑，见下）。
- **只有 `perforce.swarm.ping` / `perforce.swarm.requestReview` / `perforce.swarm.updateReviewFromChangelist` 进 package.json**（`ping` 是命令面板自检；后两者贡献到 SCM changelist 组头右键菜单 `3_swarm@1/@2`，都是**扩展宿主有真 handler** 的命令）。
- **`updateReview`（详情页 Update Review 按钮驱动，请求已带 reviewId）与 `updateReviewFromChangelist`（从 changelist 组头出发、先 QuickPick 选一个 review 再重新 shelve 关联新版本）是两条路径，别混**。候选排序是纯函数 `swarm/swarmReviewPick.ts`（`buildReviewPicks`：过滤已关闭、needsRevision 置顶、newest 次序），带单测。

### ⚠️ 头号坑：renderer Action2 命令绝不能进扩展 `commands` 数组

打开审核列表 / 打开某审核的命令（`swarm.openReviews` / `swarm.openReview`）**handler 在 renderer 的 Action2**（`swarmActions.ts`）。它们**绝不能**写进 `extensions/perforce/package.json` 的 `contributes.commands` 数组。

- **后果**：`contributes.commands` 会在扩展宿主侧注册一个同名、**无 handler** 的命令，执行时遮蔽 renderer Action2 → `executeCommand` **静默返回 undefined、不抛错、界面无反应**，极难排查。
- **host→renderer 只能走 `_workbench.*` 前缀**：状态栏 toast 要打开审核，用的是 `_workbench.openSwarmReview` / `_workbench.openSwarmReviews`（`WorkbenchOpenSwarmReview(s)Action`），因为 host 只被允许回调 `_workbench.*` 命名空间（见 `MainThreadCommands.ts` 的 `HOST_INVOKABLE_PREFIX`）。数据命令（host→自身）不受此限。

（通用护栏见 memory `renderer-action-shadowed-by-extension-command-decl`。）

### 🔒 密钥红线（比 p4 更敏感，重申）

ticket / token / password **只存在于内存 + Authorization header**，**绝不**进：`settings.json` / `perforce.*` 配置 / wire DTO / 日志。

- `resolveTicket` 走 `p4 login -p`（打印 ticket 到 stdout，**不写文件**——on-disk ticket 由 p4 CLI 自己的 P4TICKETS 管，我们不碰）。
- `swarmApi` 日志**只打 URL + HTTP 状态码**，绝不打 request/response body 或 Authorization header。
- 独立 token 路径（Swarm SSO / API token）若要做，走 `ISecretStorageService`（对标 AI provider 密钥），**绝不进 renderer/settings**——在 `swarmAuth.ts` 按 `authMode === 'token'` 分支。

### 🛣️ REST 路径铁律：comments 是 topic-based，不是嵌套资源

Swarm 的 comment 端点**不挂在 review 下**——它是独立的 topic-based 资源。写成嵌套路径会 404（`GET /api/v9/comments/reviews/8089913 → Swarm resource not found`）。

| 操作 | ✅ 正确（v9） | ❌ 错误（会 404） |
|---|---|---|
| 列评论 | `GET comments?topic=reviews/{id}` | `GET comments/reviews/{id}` |
| 加评论 | `POST comments`（body 带 `topic: reviews/{id}`） | `POST comments/reviews/{id}` |
| 改评论 / task 状态 | `PATCH comments/{id}` | `POST comments/{id}/edit` |

- **reviews 系列相反，全是嵌套路径且正确**：`reviews/{id}`、`.../transitions`、`.../vote`、`.../state`、`.../changes`。别把 comments 的心智模型套到 reviews 上。
- fake server（`fake-swarm.mjs`）也按 topic-based 匹配：`GET comments` 读 `?topic=`，`POST comments` 从 body.topic 取 id，`PATCH comments/{id}` 处理编辑。
- 路径由单测固化（`swarmClient.test.ts` 的 `SwarmClient comment endpoints`），断言完整 URL + method + body，回归在单测就挂，不用等真服务器。

### 📐 diff 数据源铁律

**diff 两侧都从 p4 快照读取，绝不用工作区文件**（`getFileContent` 命令 → `client.printRevision(...)`）：

- 首版默认比较是 **base(0) → v1**，不是「空 → v1」：`p4 describe -S -s <change>` 的 `rev#` 是 shelved 文件的 depot 基线 revision；非新增文件左侧读 `${depotFile}#${rev}`，新增文件左侧才为空。否则所有 v1 edit 都会显示成整文件新增。
- **多 version 时默认左侧仍是 depot 基线(0)，不是「上一个 version」**：文件列表按 shelf vs 基线算，若默认拿上一 version 作左侧，一个在版本间没变、但相对基线有改动的文件会显示成空 diff（列表说改了、diff 两边一样，自相矛盾）。对标 GitHub PR 单文件默认对 base diff。用户可用 Compare 下拉显式选更早 version 做版本间比较。右侧读 `${depotFile}@=${versionChange}`；删除文件右侧为空。
- Swarm version 有 `archiveChange` 时优先用它作为不可变快照，回退 `change`。作者 changelist 会被重新 shelve，不能拿它代表旧 version。
- `#revision` 可进 immutable print cache；`@=<pending-change>` 可被 reshelve 原地替换，不能进永久缓存。
- **绝不用工作区当前文件当右侧**——它会随本地编辑漂移，行号对不上 Swarm 评论锚点。
- 文件列表 / 版本元数据走 `describeVersion`（pending shelf 用 `p4 describe -S -s <change>`，报表型命令走 `execRecords()` 防 `-Mj` 塌陷，见上文 p4 插件节）。**`describeVersion` 的入参 change 也必须走 `archiveChange ?? change`**：作者的 `version.change`（如 8105452）可能被 re-shelve/清空，直接用它会让文件列表时有时无、内容漂移成空；archive shelf（如 8105475）才是不可变快照。这条与右侧内容 `changeForVersion` 是同一铁律的两个消费点，别只修一处。
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

### 编辑器身份隔离（同类多 tab 必做）

两个 EditorInput 都覆写 `id` 让不同审核 / 不同 diff = 不同 tab（见 memory `editor-input-identity-isolation`）：

- `SwarmReviewEditorInput`：`TYPE_ID='swarmReview'`，`resource = universe:/swarmReview/{id}`，`id` 含 reviewId。
- `SwarmDiffEditorInput`：继承 `DiffEditorInput`；`TYPE_ID='swarmDiff'`，`id = swarmDiff:{reviewId}:{depotFile}:{left}-{right}`，`resource` scheme `swarm-diff` + query 带 `l=/r=` 版本。**transient（不 deserialize）**——审核 diff 是临时视图，重启不恢复。

### 注册套路

**主编辑区编辑器三件套**（`swarmReview` + `swarmDiff` 各一套，缺一不显示）：
1. `contributions/BuiltInEditorProvidersContribution.ts` —— `EditorRegistry.registerEditorProvider({ typeId, componentKey, deserialize })`（swarmDiff 无 deserialize、transient）
2. `workbench/editor/EditorArea.tsx` —— `editorComponentMap.set('swarmReview'/'swarmDiff', …)`
3. `services/editor/Swarm*EditorInput.ts` —— review 是 `EditorInput` 子类；diff 是 `DiffEditorInput` 子类

**侧栏 view 容器**：`contributions/SwarmViewContribution.ts` 注册 `workbench.view.swarm` 容器 + view，`ViewComponentRegistry` 映射到 `SwarmReviewsView`。Action2 在 `actions/index.ts` `registerAction2`。

**深链接**：`universe-editor://swarm/review/<id>` → `swarm.openReview`（`shared/deepLink.ts` 解析 + `DEEP_LINK_ALLOWED_COMMANDS` 白名单，见 `apps/editor/src/renderer/services/opener/CLAUDE.md`）。

### e2e 套路（fake Swarm REST server）

本机 / CI 无真 Swarm 服务器，用纯 Node fake server 端到端跑：

- `extensions/perforce/e2e/fixtures/fake-swarm.mjs`——依赖 free 的 `node:http` server，内存审核模型 `{1001:{…}}`，把 baseUrl 写进 `UNIVERSE_SWARM_FAKE_PORTFILE`，请求逐行记进 `UNIVERSE_SWARM_FAKE_LOG`。**认证无条件放行**（凭据链路由单测覆盖）。改端点在这里加 case。
- `extensions/perforce/e2e/fixtures/swarmApp.ts`——Playwright fixture：拉起 fake-swarm + fake-p4，seed 配置（`swarm.enabled/url/apiVersion`），暴露 `swarm.requests()` / `swarm.waitForRequest()`。
- `extensions/perforce/e2e/fixtures/fake-p4.mjs`——`login` case 在 `-p` 时打印假 ticket。
- `extensions/perforce/e2e/specs/swarmReview.spec.ts`（`@p1`）——开 view → 载 dashboard → 开审核 → vote → transition → 断言 fake server 记录到的请求 body。

#### e2e 必踩的四个坑（本次实测踩全）

1. **e2e 跑预构建产物**：改 renderer 必 `pnpm --filter @universe-editor/editor build`，改扩展必 `pnpm --filter @universe-editor/perforce build`，否则用旧 bundle（"view 不渲染"最常见就是这个）。
2. **`runCommand('swarm.openReviews')` 冷启动会 race `ViewsService.reconcileFromStorage`**：命令刚设的 active 容器被 storage 恢复覆盖 → view 不渲染。e2e **点 Activity Bar 项**（`[data-testid="activitybar-item-workbench.view.swarm"]`）打开，这才是健壮的用户路径。
3. **命令激活 race + 按钮文案匹配**：
   - 视图首次 mount 时扩展宿主命令可能**尚未注册**，`executeCommand` 返回 `undefined`。`SwarmReviewsView` 的 `load()` 遇 `undefined` **重试（250ms 退避，最多 20 次）**而非缓存空 dashboard——否则列表永远空。
   - 按钮内含图标 span（如 `↑Vote Up`），`getByText('Vote Up',{exact:true})` **匹配不到**；用 `getByRole('button',{name:'Vote Up'})`。
4. **别在 `expect.poll` 的驱动循环里断言尚未渲染的 locator**：`locator.textContent()` 会自动等待元素出现，把 poll 的第一轮卡死在自己的超时上（轮询还没成功、元素还不存在的死锁）。先沿用"快速 probe（如 `getSwarmNotifyDiag().lastActionable`）驱动轮询直到成功"，再用 `await expect(badge).toHaveText(...)` 断言。

### 验证

```bash
## 改了 extensions-common 后先重建（pnpm dev 下 watcher 自动）
pnpm --filter @universe-editor/extensions-common build
pnpm --filter @universe-editor/perforce build
pnpm --filter @universe-editor/editor build   # e2e 前必做

pnpm check   # lint + typecheck + 全量单测 + docs:check
pnpm --filter @universe-editor/editor exec playwright test -c e2e/playwright.config.ts specs/smoke.swarmReview.spec.ts
```

改了用户可见文案/交互，同步 `docs/user/zh-CN/perforce/swarm-code-review.md`（`pnpm docs:check` 校验内链）。

### 关键参考路径

- `packages/extensions-common/src/contracts/swarm.ts` —— wire 类型 + `SwarmCommands` 常量（改完 re-export）
- `extensions/perforce/src/swarm/swarmApi.ts` —— HTTP 层（`UNIVERSE_SWARM_BASE_URL` 覆盖）
- `extensions/perforce/src/swarm/swarmAuth.ts` —— 认证（密钥红线）
- `extensions/perforce/src/swarm/swarmParser.ts`（+ `__tests__/swarmParser.test.ts`）—— 纯解析
- `extensions/perforce/src/swarm/swarmClient.ts` —— 审核操作编排（搜 `dashboard`）
- `extensions/perforce/src/swarm/swarmCommands.ts` —— 命令注册（搜 `guard`）
- `extensions/perforce/src/swarm/swarmStatusBar.ts` —— 状态栏被动显示 renderer 推送计数（通知在 renderer `SwarmReviewNotificationContribution.ts`）
- `extensions/perforce/package.json` —— 只有 `ping`/`requestReview` 进 commands（头号坑）
- `apps/editor/src/renderer/workbench/swarm/` —— 全部 React UI（列表/详情/diff/行内评论）
- `apps/editor/src/renderer/actions/swarmActions.ts` —— Action2（openReviews/openReview + `_workbench.*` 双胞胎）
- `apps/editor/src/renderer/contributions/SwarmViewContribution.ts` —— view 容器
- `extensions/perforce/e2e/fixtures/fake-swarm.mjs` · `swarmApp.ts` —— e2e fake server + fixture
- `extensions/perforce/e2e/specs/swarmReview.spec.ts` —— e2e 冒烟
- `docs/plan/perforce-swarm-review-plan.md` —— 原始分阶段计划（P0–P5）

### 其它

- **状态永远问服务器**：加任何"改状态"入口前，先 `GET transitions` 拿合法集，别自己算。
- **report 型 p4 命令走 `execRecords()`**（`describe -s` / `where` 等），防 `-Mj` 塌成 `{data:...}` blob（见上文 p4 插件节）。
- **连接 `-p` 绝不从 `p4 info` 的 serverAddress 推**；只在 `perforce.port` 显式设置才传（同 p4 通用红线）。
- 加新审核操作：wire DTO（extensions-common）→ parser 纯函数 + 单测 → client 方法 → command 注册 → renderer `executeCommand` 调用，五步走，别跳层。
