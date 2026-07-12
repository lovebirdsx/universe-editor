---
name: extend-perforce-plugin
description: 给内置 Perforce（p4）插件加功能 / 改功能时召回——`extensions/perforce` 是对标 git 扩展的一等 SCM 插件，通过 extension-host + VSCode 式 SCM API 把一个 p4 client（workspace）呈现为「默认 + 编号 changelist」动态分组视图。当任务是「给 p4 加一个 p4 子命令的封装 / 新命令 / 新菜单项」「p4 的签出/提交/对比/搁置/resolve/reopen/autoEdit/blame/dirty-diff 相关改动」「p4 连接/登录/离线/轮询相关」「p4 解析器（-Mj/-ztag、opened/changes/describe/fstat/annotate 的 numbered 并行键）」「p4 与 git 共用的宿主泛化（dirty-diff baseline / blame 的 provider capability 抽象）」「p4 密钥红线（密码/ticket 绝不入明文）」时使用。给出分层架构（p4Service→client→extension）、SCM 分组模型、命令路由（rootUri/resourceUri 最长前缀）、provider capability 泛化（`<providerId>.getHeadContent`/`getBlame`/`stageChange`）、纯解析器测试套路、密钥/env 净化红线，以及全部关键文件索引。区别于：create-extension（起一个新插件骨架的通用套路）、dirty-diff-inline-peek（渲染侧内联 diff peek UI）、extend-language-plugin（语言 provider）。本 skill 专讲「在既有 p4 插件里增删改 p4 能力」。
disable-model-invocation: true
---

# 扩展内置 Perforce（p4）插件

`extensions/perforce` 是一等（trusted）SCM 插件，与 git 扩展地位对等：它在 extension-host 进程里 `spawn('p4', argv)`，把一个 Perforce client（workspace）通过 VSCode 式 **SCM API**（`scm.createSourceControl`）呈现成侧栏源代码管理提供方。功能深度已覆盖 core + advanced（连接/登录、changelist 分组、edit/add/delete/revert、submit、diff、编号 changelist 管理 + reopen、shelve/unshelve、resolve、autoEdit、dirty-diff、annotate blame）**+「收集修改」体验对齐 git**（待收集/reconcile 置顶分组 + 一键收集、explorer/editor 签出入口、聚焦刷新、组级还原、状态栏计数）。

> ⚠️ **头号红线（务必逐字保持）**：密码 / ticket **绝不进明文 settings/aiSettings/线协议**。登录只把密码经 **stdin** 喂给 `p4 login`（`client.ts` `login()`），ticket 由 `p4` 自身按 `P4TICKETS` 机制保存，插件**不自管凭据**。任何新功能都不得把凭据落盘、打日志、或经 RPC 明文传。
>
> 先读 skill `create-extension`（插件通用骨架、manifest 贡献点、engines 红线、NLS）——本 skill 只讲 p4 特有的东西。

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

## 命令路由（一 id 多 client）

所有 p4 source control 共享 id `perforce`，靠**每个 client 唯一的 root** 路由（`clientManager.ts`）：

- provider/组命令 → 参数带 `{ rootUri }`，精确命中。
- 资源/文件命令 → 参数带绝对 `resourceUri`，取 **root 最长前缀**命中的 client。
- 无参命令 → `mgr.active`（跟随 SCM 视图选择，经 `perforce.setActiveRepo` 推入）。
- 路径比较统一走 `pathUtil.ts` `norm()`（正斜杠、去尾斜杠、小写盘符），**别手写大小写折叠**（ESLint 护栏会拦，见 memory `eslint-path-identity-guardrails`）。

## 操作方法约定（`client.ts`）

绝大多数 mutating 操作走 `_mutate(label, args, paths?)`：跑 p4 → 失败 toast（`notifyP4Failure`）→ **清 baseline 缓存** → **refresh**。加新操作时优先复用它。

- 需要 spec 表单的（`change -i`、`change -o` 改描述）走 stdin `input`，见 `newChangelist`/`editChangelistDescription` + `changeSpec.ts`（`buildNewChangeSpec`/`replaceDescription`/`parseDescription` 纯函数）。
- `refresh()` 有**合并（coalesce）**：并发调用排队成一次，`_refreshing`/`_queued` 守卫；每步查完 `if (this._disposed) return`。支持 `refresh({reconcile:true})` 开启 reconcile 发现（见上文待收集分组）。
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

- 契约在 `packages/extensions-common/src/dirtyDiff.ts`（`DirtyDiffCapabilities` + `dirtyDiffCommandId(providerId, cap)`）和 `blame.ts`（`BlameCapabilities` + `blameCommandId`）。命令 id = `<providerId>.<capability>`（`git.getHeadContent` / `perforce.getBlame`）。
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
- **拖到 changelist 组头 = drop-move**：`ScmGroupRow` 用 `useDropTarget` + `readDroppedResources(e)` 读 uri-list → `{resourceUri:u.fsPath, scmResourceGroupId}` selection → 派 **约定命令 `<providerId>.reopenTo`**。该命令**运行时注册（`commands.registerCommand`，不进 package.json commands）**，host 用 `CommandsRegistry.getCommand(id)` 探测其存在来决定组是否可 drop（对齐 dirty-diff/blame 的 capability-by-registration；不进 package.json 规避 [[renderer-action-shadowed-by-extension-command-decl]] 遮蔽坑）。handler 里校验目标 changelist 为 `default` 或 `/^\d+$/`（挡掉 reconcile/shelved 组）。文件行/文件夹行同时作拖拽源（`resourceDragProps`，folder 拖子树 uris）。e2e 无法可靠脚本化 HTML5 DnD → 直接 `runCommand('perforce.reopenTo', groupArg, selection)` 验证落地链路（见 `smoke.perforceChangelist.spec.ts`）。
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
- `apps/editor/e2e/fixtures/fake-p4.mjs`：**磁盘状态** fake，depot/have/opened 存一个 JSON（`UNIVERSE_P4_FAKE_STATE`）；`reconcile -n` 真去 walk client root 比对磁盘 vs have-revision，`edit/add/delete/reconcile/revert` 真改 opened 集。依赖零、纯 Node。要覆盖新 p4 子命令就在它的 `switch(command)` 里加一个 case，注意 `-Mj`(默认) 与 `-ztag` 两种输出模式（`emit()` 已分流）。
- `apps/editor/e2e/fixtures/perforceApp.ts`：cold-launch fixture（开 workspace 会重启宿主，不能用 shared 实例），`test.use({ p4Seeds:{files:[...]}, openSubdir })` 定制，`perforce` fixture 给 `clientRoot`/`openDir`/`file()`。样例 spec：`smoke.perforceCollectChanges.spec.ts`（改盘上文件 → 断言进「Changes to Reconcile」组；含"打开深层子目录"用例，`@regression`）。**⚠️ Playwright option fixture 的值不能是裸数组**（会被当 tuple 只取首元素 → `seeds is not iterable`），故种子包一层对象 `P4SeedConfig{files}`。
- 改了扩展 `src/` 后 e2e 用的是 `dist/`：先 `pnpm --filter @universe-editor/perforce build`；改了 app 侧（renderer/main）先 `pnpm --filter @universe-editor/editor build`（e2e 跑 `out/`）。单跑：`pnpm --filter @universe-editor/editor exec playwright test -c e2e/playwright.config.ts e2e/specs/smoke.perforceCollectChanges.spec.ts`。

## 关键参考路径

- `docs/plan/perforce-scm-plugin-plan.md` —— 5 阶段实施计划 + 设计（§2 分组模型差异、host 泛化策略、密钥红线原文）
- `docs/plan/perforce-collect-changes-ux-plan.md` —— 「收集修改」体验对齐 git 的设计 + 实施状态（reconcile 分组、菜单入口、聚焦刷新、组级还原、多选宿主受限）
- `extensions/perforce/src/p4Service.ts` —— CLI 封装 + env 净化 + `-Mj`/`-ztag`
- `extensions/perforce/src/client.ts` —— PerforceClient：分组对账 + `_mutate` + 全操作方法 + reconcile 分组/收集 + getHeadContent/getBlame/openChange + polling + 状态计数
- `extensions/perforce/src/extension.ts` —— activate + 全命令注册 + 路由 helper（resourcePath/groupChangelistId/resolveTargetPath，含 `uriToFsPath` explorer 传参修正）
- `extensions/perforce/src/reconcileParser.ts` —— `reconcile -n` 输出解析（纯 + 单测），待收集分组数据源
- `extensions/perforce/src/refreshController.ts` —— 聚焦刷新（`onDidChangeActiveTextEditor` 去抖）
- `extensions/perforce/src/clientManager.ts` / `clientDiscovery.ts` —— 路由 / `p4 info` 发现
- `extensions/perforce/src/changelist.ts` / `p4Output.ts` —— 分组纯逻辑 / 输出解析（numbered 并行键）
- `extensions/perforce/src/{openedParser,fstatParser,shelveParser,blameSource,changeSpec}.ts` —— 领域解析（各带 __tests__）
- `extensions/perforce/src/{baselineProvider,p4Decoration,p4Error,autoEdit,p4StatusBar,concurrency,pathUtil,nls}.ts`
- `packages/extensions-common/src/{dirtyDiff,blame}.ts` —— provider capability 契约（宿主泛化）
- `apps/editor/src/renderer/services/extensions/ScmService.ts` —— `resolveScmProviderId`（单个最具体 owner，dirty-diff/blame 路由）/ `resolveScmProviderIds`（全部 owner，菜单门控）/ `encodeScmProviderIds`（`|a|b|` 成员编码）/ `scmProviderPathKey`
- `apps/editor/src/renderer/contributions/{DirtyDiffContribution,GitBlameContribution}.ts` —— 渲染侧消费 capability + `CommandsRegistry.getCommand` 能力探测
- `extensions/git/` —— 对照样板（Repository/RepositoryManager/gitError/nls 都是 p4 的镜像来源）
- 相关 skill：`create-extension`（插件通用套路）、`dirty-diff-inline-peek`（内联 diff peek UI）
- 相关 memory：`extension-system-progress` / `eslint-path-identity-guardrails` / `dirty-diff-inline-peek-feature` / `path-comparison-convergence` / `perforce-collect-changes-ux`

## 其它

- 项目开发期，**不考虑向后兼容**——改 p4 模型/契约放手改。
- 关键逻辑保留调试输出（走 `log`→Perforce output channel / `console.error`，**stdout 是 RPC 通道不能占**）。
- 用本 skill 发现新经验，回来更新本文件。
