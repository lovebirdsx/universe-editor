# extensions/perforce/CLAUDE.md

一等（trusted）SCM 插件，与 git 扩展地位对等：在 extension-host 进程里 `spawn('p4', argv)`，把 Perforce client 经 VSCode 式 SCM API 呈现成侧栏源代码管理提供方。本文是**导航 + 必读红线**；专项知识已分层拆出，按下表按需加载。

## 子模块与专项导航（处理对应任务前必读）

| 任务 | 必读 |
|---|---|
| Perforce Graph（历史图谱） | [`docs/graph.md`](docs/graph.md) |
| Helix Swarm（代码审核） | [`src/swarm/CLAUDE.md`](src/swarm/CLAUDE.md) |
| 工作区范围（daily scope）/ 收集修改 / Explorer 改动徽标 / 落后灰字 | [`docs/reconcile.md`](docs/reconcile.md) |
| 菜单贡献 / when 子句 / 图标 / 多选拖放 | [`docs/menus.md`](docs/menus.md) |
| e2e / fake-p4 | [`e2e/CLAUDE.md`](e2e/CLAUDE.md) |
| δ 引擎 / 自装副本（下载·校验·升级） | [`src/p4delta/CLAUDE.md`](src/p4delta/CLAUDE.md) |
| 任何 p4 命令行为 / 解析 | [`docs/pitfalls.md`](docs/pitfalls.md)（踩坑完整叙事） |

> 先读 skill `create-extension`（插件通用骨架、manifest 贡献点、engines 红线、NLS）——本文档只讲 p4 特有的东西。

## 分层架构（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| 并发门控 | `concurrency.ts` | `ConcurrencyGate`：每 client 一个 FIFO 并发门；`run(task, priority?, onStart?)` 双队列（`interactive`/`background`），**静态预留 1 槽**——background 硬顶 `max - reserve`（默认 4→3），interactive 优先出队且可用全部 `max` |
| CLI 封装 | `p4Service.ts` | `spawn('p4', argv)`（**数组、`shell:false`**，绝不拼 shell 串）；`exec`/`execJson`(`-Mj`)/`execTagged`(`-ztag`)；连接全局选项 `-p/-u/-c`；**env 净化**（剥离 `ELECTRON_*`/`NODE_OPTIONS`）；经 `ConcurrencyGate` 限并发。**非零退出不 reject**，只有 spawn 失败（ENOENT）才 reject |
| 输出解析 | `p4Output.ts` | 纯函数：`parseMarshalJson`（`-Mj` 每行一 JSON）、`parseZtag`（`... key value`，空行分记录）、`collapseNumberedKeys`（并行键折叠成数组） |
| 领域解析 | `openedParser.ts` `fstatParser.ts` `shelveParser.ts` `blameSource.ts` `changeSpec.ts` `changelist.ts` `filelogParser.ts` | 把 p4 记录 → 领域模型 / 分组。**纯，无 p4 I/O**，各带 `__tests__` |
| 连接发现 | `clientDiscovery.ts` | 无连接 `p4 -ztag info` 解析 client/root/user（**不取 port**）；`perforce.port/user/client` 兜底；folder 不在 workspace 内 → 返回 undefined |
| 工作区范围 | `scopeConfig.ts` `scope.ts` | 日常范围：client root 下固定位置 `.p4delta-scope` 的**严格解析**（纯函数）+ 集合代数 / 路径身份 / 「目标是否被完整覆盖」的**本地计算**（纯函数）；编辑器与 δ 各读同一份文件，**没有运行时协议** |
| client 编排 | `client.ts` `clientManager.ts` `baselineProvider.ts` | `PerforceClient` = 一个 client 一个 `SourceControl` + 动态 changelist 分组 + refresh 编排 + 所有 p4 操作方法；`ClientManager` 按 root 路由；`BaselineProvider` = `#have` 内容缓存 |
| 入口 & UI 挂钩 | `extension.ts` `p4StatusBar.ts` `autoEdit.ts` `p4Decoration.ts` `p4Error.ts` `nls.ts` | `activate` 发现 client → 注册全部命令；状态栏、autoEdit、行装饰、错误分类/toast、本地化 |

**加一个新 p4 能力的典型路径**：`client.ts` 加一个方法（多半一行 `this._mutate(...)`）→ `extension.ts` 注册对应命令 → `package.json` 加 command + menu 项 + nls 两文件。若要新解析逻辑，先在纯解析模块写 + 单测。

## 六条必读红线（每条判据一句；完整叙事见 [docs/pitfalls.md](docs/pitfalls.md)）

1. **密钥/ticket 绝不落盘、不进日志、不经 RPC 明文传**。登录只把密码经 **stdin** 喂给 `p4 login`；ticket 由 `p4` 自身按 `P4TICKETS` 机制保存，插件**不自管凭据**。
2. **连接 `-p` 端口绝不从 `p4 info` 的 `serverAddress` 推导**（那是服务器自报的内部 bind 地址，代理后端常不可路由）。只在 `perforce.port` 显式设置才传 `-p`，否则省略 `-p` 让 p4 按 cwd 自解析 P4CONFIG；`-c`（client）必须传。
3. **共享 FIFO 并发门：批量=background、用户点击读=interactive**。任何批量 p4 命令都要想「会不会把门灌满把交互挡在队尾」；后台命令硬顶 `max-1`，静态预留一槽给交互。
4. **`_spawn` 的异步回调（`data`/`close`/watchdog/onStdoutLine）绝不 throw**——异常冒泡成 `uncaughtException` 会杀掉整个 extension host。p4 命令失败是一等公民（resolve 失败结果），宿主崩溃不是。巨量 stdout 边收边计字节、超 256MB 即杀进程。
5. **SCM 分组模型与 git 根本不同**：p4 是「一个文件属于恰好一个 pending changelist」→ 动态分组（默认组 + 每个编号 CL + 每个 CL 的搁置组），`_applyGroups()` 用 `DesiredGroup[]` 对账而非全量重建。命令路由靠**每个 client 唯一的 root 最长前缀**命中（`clientManager.ts`），路径比较统一走 `pathUtil.ts` `norm()`。
6. **工作区范围（daily scope）只来自 `.p4delta-scope`，编辑器自己解析，绝不读成「没有约束」**：配置文件固定放在 **client root 下**（不再沿上级链查找），`scopeConfig.ts` 严格解析（未知字段 / 重复键 / 反斜杠 / 绝对路径 / `..` 越界 / 通配符一律报错），`scope.ts` 算集合代数——**编辑器与 δ 各读同一份文件，两侧是同一契约的两份实现，没有运行时协议**（无请求文件 / 快照 / 回显 / 指纹 / token）。范围 = 打开的文件夹 ∩ 配置 include，**排除永远优先**，配置文件自身是隐式的 file 排除；只有 **ENOENT** 才是「没有配置」（＝工作区即范围），`empty`（含 `include: []`）与 `blocked`（文件在但读不了 / 非法）都**不是**「没有约束」：日常操作（扫描 / 收集 / 清理 / 拉取）一律拒绝，绝不回退整个工作区。**没有「配置在预览与执行之间变了就拒绝」这一档**——没有冻结的旧计划可对照，执行那一刻读的就是当前文件；预览→执行间的范围漂移只有一句提示（`perforce.sync.previewConfigMoved`），不拒绝不重放。写操作（收集 / 清理）的 carve 与 δ 分支**只在 `_mutateWrite` 执行入口现算**：命令层只交原始 typed targets + 用户授权（`confirmedTargets` / `overrideScope`，规则在执行那刻现读），`reconcileUsesP4delta` 不参与决策（确认前 carve 会把 δ 的宽目标在引擎切换时直通原生）。argv 里没有 `--` 条目；`--no-scope-file` **只由用户显式确认**（「按所选执行」）产生；`perforce.reconcile.excludeFolders` 只是**收集降噪**，以 `--exclude-dir/-file` 随收集侧调用走，与范围两码事（详情见 [docs/reconcile.md](docs/reconcile.md)）。

其余坑（sync 拒绝三形态、clientFile 是 client 语法、`-Mj` 塌陷、blame describe 挂死、搁置扇出、流式通道、`--parallel` stdout 突发冻结 + 进程 IO 速率探针、unresolved 信号、中文路径 argv 乱码、跨生产者的路径拼写）一律见 [docs/pitfalls.md](docs/pitfalls.md)。

## 操作方法约定（`client.ts`）

绝大多数 mutating 操作走 `_mutate(label, args, paths?, options?)`：跑 p4（可取消）→ 失败 toast（`notifyP4Failure`）→ **按文件失效缓存** → **refresh**。加新操作时优先复用它。它只负责拼 argv，骨架在 `_mutateVia` 上——δ 引擎（`p4delta.*`）接**收集 / 收集到指定 CL / 清理**这三个写操作（经 `_mutateWrite`，同骨架、同三条出口）与 **get**（`#head`/`@<CL>` 普通与强制都走 `_syncViaP4delta`；`#rev`/日期等 spec 保持原生），其余写操作固定原生；写操作与 get 都先 `_ensureScopeResolved`（范围 `blocked`/`empty` 时直接拒绝而不是回退整个工作区），δ 的调用只带**本操作自己的**排除项、范围文件的排除由 δ 自己读；范围分层、选择规则、失败处置与退回原生的守卫见 [docs/reconcile.md](docs/reconcile.md)。

- **缓存失效按文件**（`_invalidateAfterMutation`）：小批量（≤64 且无 `/...`）逐条 `_cache.invalidateFile(p)` 并显式清 `P4CacheNs.opened`；空 paths/批量/目录递归 → `invalidateWorkspace()`。
- **取消能力三层管道**：`P4ExecOptions.signal`（abort 即 kill + resolve 失败）→ `client._cancellable(fn)`（压 `_cancelSources` 栈 + 上报 `busyCancellable` + bump `cancellableEpoch`）→ UI **两个入口统一经 `extension.ts` 的 `confirmAndCancelBusy` 二次确认**（状态栏 spinner 点击 = `perforce.cancelBusy`，**运行时命令，不进 `contributes.commands`**；以及 sync 通知进度条的取消按钮）。`cancelBusy` 是全杀（abort 掉该 client 所有在飞源），故确认框文案须点明会一并停止同工作区其它 p4 操作；确认框是异步缺口，确认后必须复查 `client.cancellableEpoch` 未变才 `cancelBusy()`——否则会误杀确认期间新起的操作（如 get 后的 collect）。取消后不弹错误 toast。
- 破坏性操作（delete/revert/submit 等）在 `extension.ts` 命令层 `showWarningMessage` 二次确认，**不要**塞进 client 方法。**submit 直达 depot 不可撤销**，确认框文案须注明。
- **还原三档别混**：`revert`（统一入口）、`revertChangelist`（整组，破坏性需确认）、`revertUnchanged`（`revert -a`，安全无需确认）；`moveToReconcile`（`revert -k`）是「移出 Changelist」，不是还原。详见 [docs/reconcile.md](docs/reconcile.md)。

## 宿主泛化：p4/git 共用一个无偏见 host

dirty-diff gutter 与 inline blame 原本硬编码 `git.*` 命令；已抽象为「**provider 上报的 capability**」，host 零 SCM 知识。契约在 `packages/extensions-common/src/contracts/{dirtyDiff,blame}.ts`，命令 id = `<providerId>.<capability>`。**给 p4 加/减能力就是加/减对应 `commands.registerCommand`**；能力探测靠 `CommandsRegistry.getCommand(id)`。渲染侧按 `resolveScmProviderId(sourceControls, fsPath, selectedRootUri?)` 解析归属 provider（第三参是 SCM 面板当前选中 repo，处理 git 嵌套 p4）。`shift+alt+y` = renderer Action2 `workbench.action.scm.openChanges`（唯一 open-changes 入口）。

> 改宿主泛化时：`packages/extensions-common` 与渲染 contribution 两侧都要动；改完先 `pnpm --filter @universe-editor/extensions-common build` 再让 apps 看到。

## Timeline（单文件历史，`p4 filelog`）

`timelineProvider.ts` 是对等 git timeline 的单文件历史（id `perforce-history`），点行开上一修订 diff。数据源 `client.getFilelog` → `p4 filelog -m <max> <depot>[#rev]`（`execRecords`），解析在 `filelogParser.ts`。分页用 limit+1 探针（cursor = `${depotFile}#${rev}`，不再 fstat）。Pending 项对齐 git Uncommitted Changes。**client 解析必须走 `ClientManager.resolveContaining`**（严格最长前缀、无 active fallback——数据查询语义）。右键 `perforce.timeline.getThisRevision` 走注入的 `TimelineSyncRunner` 复用 `runSync`。

## 配置项（`perforce.*`）

`enabled`(true)、`port`/`user`/`client`（连接兜底，优先 `p4 set`/P4CONFIG）、`p4delta.*`（δ 引擎与自装副本，见 `src/p4delta/CLAUDE.md`）、`maxConcurrent`(4)、`commandTimeout`(600s，0=不限——约束「永久挂死」而非「执行慢」)、`refreshInterval`(0=关，最小 10s)、`autoEdit`(false)、`reconcileHint.enabled`(true)、`openedByOthers.autoCheck`(true)/`openedByOthers.intervalSec`(300s)、`timeline.showPending`(true)、`syncParallelThreads`(4，0=串行)、`cache.*`。`reconcile.excludeFolders`（收集降噪，不是范围来源，见红线 6）。加新配置：`package.json` `contributes.configuration` + nls description key。

## 验证

```bash
# 改了 extensions-common / extension-host 后先重建 dist（pnpm dev 下 watcher 自动）
pnpm --filter @universe-editor/extensions-common build
pnpm --filter @universe-editor/perforce test    # 仅跑 p4 单测（快）
pnpm check                                       # lint+typecheck+全测+docs:check，仅看错误
```

- 用户可见改动（命令名/菜单/配置/交互）→ 同步 `docs/user/zh-CN/perforce/`，内部链接由 `pnpm docs:check` 校验。
- 交互流程改动 → `pnpm e2e`（本地 Windows 有 launch flake，交 CI）。
- **性能修复回归护栏**见 `__tests__/concurrency.test.ts` / `p4Service.test.ts` / `baselineProvider.test.ts` / `clientInteractivePriority.test.ts` / `clientOpenChange.test.ts`。
- 打包自动收录：`scripts/release/runtime-resources.mjs` 用 `readdirSync` 扫 `extensions/`，perforce 的 `files:["dist","package.nls.json","package.nls.zh-cn.json","icon.svg"]` 必须齐。

## 关键参考路径

- `extensions/perforce/src/p4Service.ts` —— CLI 封装 + env 净化 + `-Mj`/`-ztag` + 并发门 + watchdog + argfile
- `extensions/perforce/src/processIo.ts` —— sync 期间按 pid 采样 p4 进程树 IO（Windows 常驻 PowerShell/WMI、Linux `/proc`、`UNIVERSE_P4_IO_PROBE` 测试缝）+ 定宽速率格式化
- `extensions/perforce/src/client.ts` —— PerforceClient：分组对账 + `_mutate` + 全操作方法 + reconcile + 范围应用（`refreshScope`/`_applyScopeBase`）+ checkWorkingTree/checkBehind + getHeadContent/getBlame/openChange
- `extensions/perforce/src/scopeConfig.ts` / `scope.ts` —— 范围配置的严格解析（纯函数）与集合代数 / 路径身份 / 目标覆盖判断（纯函数）
- `extensions/perforce/src/revertPlan.ts` —— 统一 Revert 分类 + 确认文案（纯函数）
- `extensions/perforce/src/extension.ts` —— activate + 全命令注册 + 路由 helper（`uriToFsPath` 修 explorer 传参）
- `extensions/perforce/src/clientManager.ts` / `clientDiscovery.ts` —— 路由 / `p4 info` 发现
- `extensions/perforce/src/timelineProvider.ts` —— Timeline provider
- `packages/extensions-common/src/contracts/{dirtyDiff,blame}.ts` —— provider capability 契约
- `apps/editor/src/renderer/services/extensions/ScmService.ts` —— `resolveScmProviderId(s)` / `encodeScmProviderIds`
- `extensions/git/` —— 对照样板
- 遮蔽坑见 skill `create-extension`；相关：`packages/config-eslint/CLAUDE.md`（路径身份护栏）/ `packages/platform/CLAUDE.md`（路径/URI 身份比较）

## 其它

- 项目开发期，**不考虑向后兼容**——改 p4 模型/契约放手改。
- 关键逻辑保留调试输出（走 `log`→Perforce output channel / `console.error`，**stdout 是 RPC 通道不能占**）。
- 发现新经验：p4 命令行为/解析坑 → 更新 `docs/pitfalls.md`；Graph/Swarm/菜单/reconcile 专项 → 更新对应子文件；只有「每条 p4 任务都必读」的才回写本文件。
