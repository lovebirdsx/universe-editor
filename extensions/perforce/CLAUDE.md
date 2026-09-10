# extensions/perforce/CLAUDE.md

一等（trusted）SCM 插件，与 git 扩展地位对等：在 extension-host 进程里 `spawn('p4', argv)`，把 Perforce client 经 VSCode 式 SCM API 呈现成侧栏源代码管理提供方。本文是**导航 + 必读红线**；专项知识已分层拆出，按下表按需加载。

## 子模块与专项导航（处理对应任务前必读）

| 任务 | 必读 |
|---|---|
| Perforce Graph（历史图谱） | [`extensions/perforce/docs/graph.md`](extensions/perforce/docs/graph.md) |
| Helix Swarm（代码审核） | [`src/swarm/CLAUDE.md`](src/swarm/CLAUDE.md) |
| 收集修改 / Explorer 改动徽标 / 落后灰字 | [`extensions/perforce/docs/reconcile.md`](extensions/perforce/docs/reconcile.md) |
| 菜单贡献 / when 子句 / 图标 / 多选拖放 | [`extensions/perforce/docs/menus.md`](extensions/perforce/docs/menus.md) |
| e2e / fake-p4 | [`e2e/CLAUDE.md`](e2e/CLAUDE.md) |
| 任何 p4 命令行为 / 解析 | [`extensions/perforce/docs/pitfalls.md`](extensions/perforce/docs/pitfalls.md)（13 条踩坑完整叙事） |

> 先读 skill `create-extension`（插件通用骨架、manifest 贡献点、engines 红线、NLS）——本文档只讲 p4 特有的东西。

## 分层架构（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| 并发门控 | `concurrency.ts` | `ConcurrencyGate`：每 client 一个 FIFO 并发门；`run(task, priority?, onStart?)` 双队列（`interactive`/`background`），**静态预留 1 槽**——background 硬顶 `max - reserve`（默认 4→3），interactive 优先出队且可用全部 `max` |
| CLI 封装 | `p4Service.ts` | `spawn('p4', argv)`（**数组、`shell:false`**，绝不拼 shell 串）；`exec`/`execJson`(`-Mj`)/`execTagged`(`-ztag`)；连接全局选项 `-p/-u/-c`；**env 净化**（剥离 `ELECTRON_*`/`NODE_OPTIONS`）；经 `ConcurrencyGate` 限并发。**非零退出不 reject**，只有 spawn 失败（ENOENT）才 reject |
| 输出解析 | `p4Output.ts` | 纯函数：`parseMarshalJson`（`-Mj` 每行一 JSON）、`parseZtag`（`... key value`，空行分记录）、`collapseNumberedKeys`（并行键折叠成数组） |
| 领域解析 | `openedParser.ts` `fstatParser.ts` `shelveParser.ts` `blameSource.ts` `changeSpec.ts` `changelist.ts` `filelogParser.ts` | 把 p4 记录 → 领域模型 / 分组。**纯，无 p4 I/O**，各带 `__tests__` |
| 连接发现 | `clientDiscovery.ts` | 无连接 `p4 -ztag info` 解析 client/root/user（**不取 port**）；`perforce.port/user/client` 兜底；folder 不在 workspace 内 → 返回 undefined |
| client 编排 | `client.ts` `clientManager.ts` `baselineProvider.ts` | `PerforceClient` = 一个 client 一个 `SourceControl` + 动态 changelist 分组 + refresh 编排 + 所有 p4 操作方法；`ClientManager` 按 root 路由；`BaselineProvider` = `#have` 内容缓存 |
| 入口 & UI 挂钩 | `extension.ts` `p4StatusBar.ts` `autoEdit.ts` `p4Decoration.ts` `p4Error.ts` `nls.ts` | `activate` 发现 client → 注册全部命令；状态栏、autoEdit、行装饰、错误分类/toast、本地化 |

**加一个新 p4 能力的典型路径**：`client.ts` 加一个方法（多半一行 `this._mutate(...)`）→ `extension.ts` 注册对应命令 → `package.json` 加 command + menu 项 + nls 两文件。若要新解析逻辑，先在纯解析模块写 + 单测。

## 五条必读红线（每条判据一句；完整叙事见 [extensions/perforce/docs/pitfalls.md](extensions/perforce/docs/pitfalls.md)）

1. **密钥/ticket 绝不落盘、不进日志、不经 RPC 明文传**。登录只把密码经 **stdin** 喂给 `p4 login`；ticket 由 `p4` 自身按 `P4TICKETS` 机制保存，插件**不自管凭据**。
2. **连接 `-p` 端口绝不从 `p4 info` 的 `serverAddress` 推导**（那是服务器自报的内部 bind 地址，代理后端常不可路由）。只在 `perforce.port` 显式设置才传 `-p`，否则省略 `-p` 让 p4 按 cwd 自解析 P4CONFIG；`-c`（client）必须传。
3. **共享 FIFO 并发门：批量=background、用户点击读=interactive**。任何批量 p4 命令都要想「会不会把门灌满把交互挡在队尾」；后台命令硬顶 `max-1`，静态预留一槽给交互。
4. **`_spawn` 的异步回调（`data`/`close`/watchdog/onStdoutLine）绝不 throw**——异常冒泡成 `uncaughtException` 会杀掉整个 extension host。p4 命令失败是一等公民（resolve 失败结果），宿主崩溃不是。巨量 stdout 边收边计字节、超 256MB 即杀进程。
5. **SCM 分组模型与 git 根本不同**：p4 是「一个文件属于恰好一个 pending changelist」→ 动态分组（默认组 + 每个编号 CL + 每个 CL 的搁置组），`_applyGroups()` 用 `DesiredGroup[]` 对账而非全量重建。命令路由靠**每个 client 唯一的 root 最长前缀**命中（`clientManager.ts`），路径比较统一走 `pathUtil.ts` `norm()`。

其余坑（sync 拒绝三形态、clientFile 是 client 语法、`-Mj` 塌陷、blame describe 挂死、搁置扇出、流式通道、unresolved 信号、中文路径 argv 乱码）一律见 [extensions/perforce/docs/pitfalls.md](extensions/perforce/docs/pitfalls.md)。

## 操作方法约定（`client.ts`）

绝大多数 mutating 操作走 `_mutate(label, args, paths?, options?)`：跑 p4（可取消）→ 失败 toast（`notifyP4Failure`）→ **按文件失效缓存** → **refresh**。加新操作时优先复用它。

- **缓存失效按文件**（`_invalidateAfterMutation`）：小批量（≤64 且无 `/...`）逐条 `_cache.invalidateFile(p)` 并显式清 `P4CacheNs.opened`；空 paths/批量/目录递归 → `invalidateWorkspace()`。
- **取消能力三层管道**：`P4ExecOptions.signal`（abort 即 kill + resolve 失败）→ `client._cancellable(fn)`（压 `_cancelSources` 栈 + 上报 `busyCancellable`）→ UI 状态栏 spinner 点取消（`perforce.cancelBusy`，**运行时命令，不进 `contributes.commands`**）。取消后不弹错误 toast。
- 破坏性操作（delete/revert/submit 等）在 `extension.ts` 命令层 `showWarningMessage` 二次确认，**不要**塞进 client 方法。**submit 直达 depot 不可撤销**，确认框文案须注明。
- **还原三档别混**：`revert`（统一入口）、`revertChangelist`（整组，破坏性需确认）、`revertUnchanged`（`revert -a`，安全无需确认）；`moveToReconcile`（`revert -k`）是「移出 Changelist」，不是还原。详见 [extensions/perforce/docs/reconcile.md](extensions/perforce/docs/reconcile.md)。

## 宿主泛化：p4/git 共用一个无偏见 host

dirty-diff gutter 与 inline blame 原本硬编码 `git.*` 命令；已抽象为「**provider 上报的 capability**」，host 零 SCM 知识。契约在 `packages/extensions-common/src/contracts/{dirtyDiff,blame}.ts`，命令 id = `<providerId>.<capability>`。**给 p4 加/减能力就是加/减对应 `commands.registerCommand`**；能力探测靠 `CommandsRegistry.getCommand(id)`。渲染侧按 `resolveScmProviderId(sourceControls, fsPath, selectedRootUri?)` 解析归属 provider（第三参是 SCM 面板当前选中 repo，处理 git 嵌套 p4）。`shift+alt+y` = renderer Action2 `workbench.action.scm.openChanges`（唯一 open-changes 入口）。

> 改宿主泛化时：`packages/extensions-common` 与渲染 contribution 两侧都要动；改完先 `pnpm --filter @universe-editor/extensions-common build` 再让 apps 看到。

## Timeline（单文件历史，`p4 filelog`）

`timelineProvider.ts` 是对等 git timeline 的单文件历史（id `perforce-history`），点行开上一修订 diff。数据源 `client.getFilelog` → `p4 filelog -m <max> <depot>[#rev]`（`execRecords`），解析在 `filelogParser.ts`。分页用 limit+1 探针（cursor = `${depotFile}#${rev}`，不再 fstat）。Pending 项对齐 git Uncommitted Changes。**client 解析必须走 `ClientManager.resolveContaining`**（严格最长前缀、无 active fallback——数据查询语义）。右键 `perforce.timeline.getThisRevision` 走注入的 `TimelineSyncRunner` 复用 `runSync`。

## 配置项（`perforce.*`）

`enabled`(true)、`port`/`user`/`client`（连接兜底，优先 `p4 set`/P4CONFIG）、`maxConcurrent`(4)、`commandTimeout`(600s，0=不限——约束「永久挂死」而非「执行慢」)、`refreshInterval`(0=关，最小 10s)、`autoEdit`(false)、`reconcileHint.enabled`(true)、`openedByOthers.autoCheck`(true)/`openedByOthers.intervalSec`(300s)、`timeline.showPending`(true)、`syncParallelThreads`(4，0=串行)、`cache.*`。加新配置：`package.json` `contributes.configuration` + nls description key。

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
- `extensions/perforce/src/client.ts` —— PerforceClient：分组对账 + `_mutate` + 全操作方法 + reconcile + checkWorkingTree/checkBehind + getHeadContent/getBlame/openChange
- `extensions/perforce/src/revertPlan.ts` —— 统一 Revert 分类 + 确认文案（纯函数）
- `extensions/perforce/src/extension.ts` —— activate + 全命令注册 + 路由 helper（`uriToFsPath` 修 explorer 传参）
- `extensions/perforce/src/clientManager.ts` / `clientDiscovery.ts` —— 路由 / `p4 info` 发现
- `extensions/perforce/src/timelineProvider.ts` —— Timeline provider
- `packages/extensions-common/src/contracts/{dirtyDiff,blame}.ts` —— provider capability 契约
- `apps/editor/src/renderer/services/extensions/ScmService.ts` —— `resolveScmProviderId(s)` / `encodeScmProviderIds`
- `extensions/git/` —— 对照样板
- 相关 memory：`eslint-path-identity-guardrails` / `path-comparison-convergence` / `renderer-action-shadowed-by-extension-command-decl`

## 其它

- 项目开发期，**不考虑向后兼容**——改 p4 模型/契约放手改。
- 关键逻辑保留调试输出（走 `log`→Perforce output channel / `console.error`，**stdout 是 RPC 通道不能占**）。
- 发现新经验：p4 命令行为/解析坑 → 更新 `extensions/perforce/docs/pitfalls.md`；Graph/Swarm/菜单/reconcile 专项 → 更新对应子文件；只有「每条 p4 任务都必读」的才回写本文件。
