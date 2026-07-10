---
name: extend-perforce-plugin
description: 给内置 Perforce（p4）插件加功能 / 改功能时召回——`extensions/perforce` 是对标 git 扩展的一等 SCM 插件，通过 extension-host + VSCode 式 SCM API 把一个 p4 client（workspace）呈现为「默认 + 编号 changelist」动态分组视图。当任务是「给 p4 加一个 p4 子命令的封装 / 新命令 / 新菜单项」「p4 的签出/提交/对比/搁置/resolve/reopen/autoEdit/blame/dirty-diff 相关改动」「p4 连接/登录/离线/轮询相关」「p4 解析器（-Mj/-ztag、opened/changes/describe/fstat/annotate 的 numbered 并行键）」「p4 与 git 共用的宿主泛化（dirty-diff baseline / blame 的 provider capability 抽象）」「p4 密钥红线（密码/ticket 绝不入明文）」时使用。给出分层架构（p4Service→client→extension）、SCM 分组模型、命令路由（rootUri/resourceUri 最长前缀）、provider capability 泛化（`<providerId>.getHeadContent`/`getBlame`/`stageChange`）、纯解析器测试套路、密钥/env 净化红线，以及全部关键文件索引。区别于：create-extension（起一个新插件骨架的通用套路）、dirty-diff-inline-peek（渲染侧内联 diff peek UI）、extend-language-plugin（语言 provider）。本 skill 专讲「在既有 p4 插件里增删改 p4 能力」。
disable-model-invocation: true
---

# 扩展内置 Perforce（p4）插件

`extensions/perforce` 是一等（trusted）SCM 插件，与 git 扩展地位对等：它在 extension-host 进程里 `spawn('p4', argv)`，把一个 Perforce client（workspace）通过 VSCode 式 **SCM API**（`scm.createSourceControl`）呈现成侧栏源代码管理提供方。功能深度已覆盖 core + advanced（连接/登录、changelist 分组、edit/add/delete/revert、submit、diff、编号 changelist 管理 + reopen、shelve/unshelve、resolve、autoEdit、dirty-diff、annotate blame）。

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


## SCM 分组模型（与 git 根本不同）

git 是「staged / working 两个固定组」；p4 是「一个文件属于**恰好一个 pending changelist**」→ 视图是**动态分组**：默认 changelist（组 id `default`，永远显示）+ 每个编号 changelist（组 id `cl:<n>`）+ 每个 CL 的搁置文件（组 id `shelved:<n>`）。

- 分组纯逻辑在 `changelist.ts` 的 `groupChangelists()`（喂 `p4 opened` + `p4 changes -s pending`）。
- `client.ts` `_applyGroups()` 用 `DesiredGroup[]` **对账** live ResourceGroups：新建 / 更新 label+states / dispose 消失的。**不要每次全量重建组**（会闪烁 + 泄漏）。
- 组 id ↔ changelist id 互转：`numberedGroupId`/`shelvedGroupId`/`changelistIdFromGroupId`。组作用域命令靠宿主附在 group action 上的 `scmResourceGroupId` 定位 CL（见 `extension.ts` `groupChangelistId`）。
- `sc.count` = 打开文件总数（不含搁置）；`acceptInputCommand`/`acceptInputActions` 在默认组有文件时挂 Submit / Revert Unchanged。

## 命令路由（一 id 多 client）

所有 p4 source control 共享 id `perforce`，靠**每个 client 唯一的 root** 路由（`clientManager.ts`）：

- provider/组命令 → 参数带 `{ rootUri }`，精确命中。
- 资源/文件命令 → 参数带绝对 `resourceUri`，取 **root 最长前缀**命中的 client。
- 无参命令 → `mgr.active`（跟随 SCM 视图选择，经 `perforce.setActiveRepo` 推入）。
- 路径比较统一走 `pathUtil.ts` `norm()`（正斜杠、去尾斜杠、小写盘符），**别手写大小写折叠**（ESLint 护栏会拦，见 memory `eslint-path-identity-guardrails`）。

## 操作方法约定（`client.ts`）

绝大多数 mutating 操作走 `_mutate(label, args, paths?)`：跑 p4 → 失败 toast（`notifyP4Failure`）→ **清 baseline 缓存** → **refresh**。加新操作时优先复用它。

- 需要 spec 表单的（`change -i`、`change -o` 改描述）走 stdin `input`，见 `newChangelist`/`editChangelistDescription` + `changeSpec.ts`（`buildNewChangeSpec`/`replaceDescription`/`parseDescription` 纯函数）。
- `refresh()` 有**合并（coalesce）**：并发调用排队成一次，`_refreshing`/`_queued` 守卫；每步查完 `if (this._disposed) return`。
- 破坏性操作（delete/revert/submit numbered/deleteShelved）在 `extension.ts` 命令层 `showWarningMessage` 二次确认，**不要**把确认塞进 client 方法。

## 连接状态 & 离线

server 端状态、**无 FS watcher**。`ConnectionState` = `connected|offline|not-logged-in`。任何 p4 命令非零退出经 `p4Error.ts` `classifyP4Error` 分类：session 过期/未登录 → `not-logged-in`（提示重新登录），连接失败 → `offline`。`_goOffline` 清空组 + count=0 + emit（状态栏更新），**不刷屏弹错**。轮询（`startPolling`，opt-in，`perforce.refreshInterval` 秒，最小 10s 地板）是唯一能捕捉编辑器外改动的手段。

## 宿主泛化：p4/git 共用一个无偏见 host

dirty-diff gutter 与 inline blame 原本硬编码 `git.*` 命令；已抽象为「**provider 上报的 capability**」，host 零 SCM 知识：

- 契约在 `packages/extensions-common/src/dirtyDiff.ts`（`DirtyDiffCapabilities` + `dirtyDiffCommandId(providerId, cap)`）和 `blame.ts`（`BlameCapabilities` + `blameCommandId`）。命令 id = `<providerId>.<capability>`（`git.getHeadContent` / `perforce.getBlame`）。
- 渲染侧 `DirtyDiffContribution.ts` / `GitBlameContribution.ts` / `dirtyDiffActions.ts` 注入 `IScmService`，用 `resolveScmProviderId(sourceControls, fsPath)`（`ScmService.ts`，root 最长前缀，键走 `scmProviderPathKey`）解析归属 provider → 派生命令 id 调用。
- **能力探测靠 `CommandsRegistry.getCommand(id)`**：贡献命令会真的注册进 CommandsRegistry。p4 无暂存区 → **不注册** `perforce.stageChange` → host 的 `_activeProviderSupportsStage()` 返回 false → Stage 按钮自动隐藏（`canStage` 回调）。**给 p4 加/减能力就是加/减对应 `commands.registerCommand`**。
- p4 侧实现：`getHeadContent`（`#have` 内容或 null）、`getBlame`（`annotate -u -c -q` + 批量 `describe -s` 补 summary，返回 == `BlameResultDto` 的 `P4BlameResult`）、`openChange`（have vs 本地 diff）。这些是**运行时命令**（`commands.registerCommand`，不进 package.json），对齐 git。

> 改宿主泛化时：`packages/extensions-common` 与渲染 contribution 两侧都要动；改完先 `pnpm --filter @universe-editor/extensions-common build` 再让 apps 看到。测试见 `dirtyDiffActions.test.ts` / `GitBlameContribution.test.ts`（都注入了带 `{id,rootUri}` 的 IScmService fake）。

## 菜单 & when 子句（`package.json`）

- SCM 视图内菜单用 `scmProvider == perforce` 门控（**`scmProvider` 只在 SCM 视图作用域有效，explorer/editor 菜单用不了它**——这是踩过的坑，别给 p4 加 explorer/editor 菜单再指望 `scmProvider`）。
- 行选择靠 `scmResourceState`（单字母，来自 `p4Decoration.ts` `contextValue`：E/A/D/B/I/M/R，未 resolve=U，搁置=S）。组选择靠 `scmResourceGroup =~ /^cl:/` 或 `/^shelved:/`（正则）。
- 加行内动作：`scm/resourceState/context` `group: "inline@N"`；组动作：`scm/resourceGroup/context`；标题栏：`scm/title`。

## 解析器测试套路（纯函数，node 环境）

领域/输出解析全部纯函数 + `src/__tests__/*.test.ts`，对 fixture 断言（`openedParser`/`changeSpec`/`changelist`/`shelveParser`/`blameSource`/`pathUtil`/`p4Output`）。**新增任何解析逻辑先写纯函数 + 单测**，client 只做编排。mock extension-api 套路见 create-extension（`vi.mock('@universe-editor/extension-api', …)`）。当前 perforce 包 7 个测试文件 49 例。

## 密钥 / env 安全红线（重申）

- 密码/ticket 只经 stdin → `p4 login`，绝不落 settings/日志/RPC（见文件头）。
- 子进程 env 走 `sanitizeEnv()`（`p4Service.ts` `ENV_DENYLIST`），与 git spawner 同款——防 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` 把 node 型子进程劫持。加任何新 spawn 都必须走 `P4Service`，别自己 `spawn`。
- 所有参数用**数组**传给 `spawn`，`shell:false`，路径/描述不进 shell，杜绝注入。

## 配置项（`perforce.*`）

`enabled`(默认 true)、`port`/`user`/`client`（连接兜底，优先 `p4 set`/P4CONFIG）、`maxConcurrent`(4)、`refreshInterval`(0=关，最小 10s)、`autoEdit`(false)。加新配置：`package.json` `contributes.configuration` + nls description key，读用 `workspace.getConfiguration('perforce').get(key, default)`。

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

## 关键参考路径

- `docs/plan/perforce-scm-plugin-plan.md` —— 5 阶段实施计划 + 设计（§2 分组模型差异、host 泛化策略、密钥红线原文）
- `extensions/perforce/src/p4Service.ts` —— CLI 封装 + env 净化 + `-Mj`/`-ztag`
- `extensions/perforce/src/client.ts` —— PerforceClient：分组对账 + `_mutate` + 全操作方法 + getHeadContent/getBlame/openChange + polling
- `extensions/perforce/src/extension.ts` —— activate + 全命令注册 + 路由 helper（resourcePath/groupChangelistId/resolveTargetPath）
- `extensions/perforce/src/clientManager.ts` / `clientDiscovery.ts` —— 路由 / `p4 info` 发现
- `extensions/perforce/src/changelist.ts` / `p4Output.ts` —— 分组纯逻辑 / 输出解析（numbered 并行键）
- `extensions/perforce/src/{openedParser,fstatParser,shelveParser,blameSource,changeSpec}.ts` —— 领域解析（各带 __tests__）
- `extensions/perforce/src/{baselineProvider,p4Decoration,p4Error,autoEdit,p4StatusBar,concurrency,pathUtil,nls}.ts`
- `packages/extensions-common/src/{dirtyDiff,blame}.ts` —— provider capability 契约（宿主泛化）
- `apps/editor/src/renderer/services/extensions/ScmService.ts` —— `resolveScmProviderId` / `scmProviderPathKey`
- `apps/editor/src/renderer/contributions/{DirtyDiffContribution,GitBlameContribution}.ts` —— 渲染侧消费 capability + `CommandsRegistry.getCommand` 能力探测
- `extensions/git/` —— 对照样板（Repository/RepositoryManager/gitError/nls 都是 p4 的镜像来源）
- 相关 skill：`create-extension`（插件通用套路）、`dirty-diff-inline-peek`（内联 diff peek UI）
- 相关 memory：`extension-system-progress` / `eslint-path-identity-guardrails` / `dirty-diff-inline-peek-feature` / `path-comparison-convergence`

## 其它

- 项目开发期，**不考虑向后兼容**——改 p4 模型/契约放手改。
- 关键逻辑保留调试输出（走 `log`→Perforce output channel / `console.error`，**stdout 是 RPC 通道不能占**）。
- 用本 skill 发现新经验，回来更新本文件。
