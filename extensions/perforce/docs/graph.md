# Perforce Graph（p4 图谱）

`Perforce Graph` 是对等 **Git Graph** 的主编辑区标签页，把**已提交的 changelist 历史**可视化。Perforce 历史是**严格编号、线性排列的 changelist 列表**（没有 git 那样的本地分支合并 DAG），所以图谱是**单条泳道**（single lane）——这是与 git graph 最根本的差别，其余交互（搜索、右键、详情面板、view-state 持久化）都刻意与 git graph 对齐以保证一致体验。

> 先读 `../CLAUDE.md` 的「分层架构」「连接红线」「密钥红线」——本文只讲**图谱特有**的东西：数据源方法、wire 类型、renderer 编辑器与注册。

## 三层技术栈（自底向上）

| 层 | 文件 | 职责 |
|---|---|---|
| wire 类型 | `packages/extensions-common/src/contracts/perforceGraph.ts` | renderer↔扩展共享的 DTO（`P4GraphChangeDto` / `P4GraphRepoDto` / `P4GraphLoadResult` / `P4GraphChangeDetailsDto` / `P4GraphFileChangeDto` / `P4GraphFileDiffRequest`）+ `PerforceGraphCommands` 命令 id 常量。**必须**在 `index.ts` re-export |
| 纯解析 | `extensions/perforce/src/p4GraphParser.ts` | `parseChangesList` / `parseChangeDescribe`（numbered 并行键折叠）/ `statusFromAction`（p4 action→A/M/D/R）/ `fileDiffRevs`（按 status 算 left/right rev spec）/ `parseWhereLocalPaths` / `displayPath`。**全纯、可对 fixture 单测** |
| 数据源 | `extensions/perforce/src/client.ts` | 图谱方法：`getGraphChanges(max)` / `getGraphHaveChange(scopes)` / `getPendingCount` / `getOpenedForGraph` / `getGraphChangeDetails(id)` / `printRevision(spec)` / `_whereLocalPaths` |
| 命令 | `extensions/perforce/src/extension.ts` | 注册 10 个 `perforce-graph.*` 命令（见下）——**运行时命令**（`commands.registerCommand`），构建 DTO、算单泳道 parents、跑 diff |
| 编辑器 | `apps/editor/src/renderer/workbench/perforceGraph/PerforceGraphEditor.tsx` | 主 React 编辑器：单泳道单选 + 顶部"待定变更"节点。只用 `ICommandService` + `IScmService` 跨 JSON 边界调命令 |
| 输入/状态/动作 | `apps/editor/src/renderer/services/editor/PerforceGraphEditorInput.ts` · `services/perforceGraph/perforceGraphViewState.ts` · `actions/perforceGraphActions.ts` | EditorInput（URI `universe:/perforceGraph`）· module-level view-state 单例（重开秒恢复）· 两个 Action2 |

## 命令清单（`PerforceGraphCommands`）

`getRepos` / `setRepo` / `getChanges` / `getHaveChange` / `getChangeDetails` / `getPendingChanges` / `openFileDiff` / `openWorkingTreeFile` / `syncToChange` / `getSyncScopes`。全部走 `commands.registerCommand`（**不进 package.json `commands` 数组**，见头号坑），renderer 用 `commands.executeCommand(PerforceGraphCommands.xxx, ...)` 调用。

除 `syncToChange` 外全部只读。`syncToChange` 是唯一的写命令（P4V 式 "get revision as of a changelist"）：`p4 sync` 到所选 CL，把工作区 have 版本**移动**（可回退可前进）——只动本地工作区，depot 仍只读。范围 = 请求的 `scopePaths`（经 `buildSyncFilespecs` 展开，目录转 `<dir>/...`）或图谱显示范围（`wholeRepo ? '//...' : workspaceScope`）；`@CL` 后缀由 `clSpecOf` 生成（只认纯数字，防任意文本 splice 进 filespec）；执行复用插件的 `runSync`（进度条 / 拒绝处理同一套）；确认策略 = 纯函数 `graphSyncConfirmKind`（`graphSync.ts`，三态）：`force` 请求 → 弹**合并**的强制确认框（覆盖未收集改动 + 时间旅行重置两层语义合成一个 modal，`confirmForceGet(spec, scopeText)`——与 Explorer 的「拉取版本…」强制档**共用同一个**函数与文案，故正文只说「目标版本」不说 changelist）并透传 `force` 给 `runSync` → `p4 sync -f`；否则委托 `graphSyncNeedsConfirm`：`confirmed`（多选目录对话框已确认）/ `isLatest`（目标 = 最新行，等价 get latest）/ 单文件 scope 免确认，目录 / 多路径 / 整显示范围弹时间旅行警告。**`force` 压过全部三条豁免**（`isLatest` / `confirmed` / 单文件都不豁免，见下）。`getSyncScopes` 列图谱 client root 的顶层目录（纯 `readdir`，零 p4 调用，失败读作「无候选」），喂 renderer 的多选目录对话框。

**红线：`force` 只能升级警告，绝不能豁免警告**。`graphSyncNeedsConfirm` 的入参类型 `GraphSyncConfirmInput` **刻意不含** `force`——把 force 传给它（想借 `isLatest` 免确认）是编译错误；force 一律经 `graphSyncConfirmKind` 短路成 `'force'`。理由：`isLatest` 免确认的前提是「get latest 不是时间旅行」，而 `-f` 无论目标是不是 head 都会重写可写本地副本、销毁未收集的工作；单文件 scope 恰是最需要 force 的场景（have 上但本地改过 → 普通 get 报 up-to-date 什么都不做）。确认文案点名目标版本与 scope（截断 300 字符 + `(N filespecs)`，两侧共用 `syncSpec.ts` 的 `scopeTextOf`）——整仓库图谱的 scope 是 `//...`/工作区根 `...`，那行是用户唯一能察觉「这一下要重拉整仓」的时机。日志行带 `-f` 标记：图谱自己的溯源行（`graph sync -f … to @4521`，非 force 也打），加上 `PerforceClient.sync` 的日志行（`[perforce] sync -f @4521: N applied, …`，**所有** `-f` 入口共用这一处，故 Explorer 侧的强制档同样留有痕迹；带标记的不只是成功汇总——**失败 / 取消 / 已最新**三种结局同样带，被 clobber 挡下的那次强制 get 恰是最需要留下痕迹的）——事后追查「谁覆盖了我的文件」时，这是唯一能区分强制 get 与普通 get 的现场。

## 本地同步点（"已同步"徽章 / `haveChange`）

图谱列的是 depot 侧历史，看不出「哪些已经拉到本地」。**本地同步点**补上这一维：该 scope 下**已进入工作区 have 列表的最新已提交 CL**（`client.ts` `getGraphHaveChange`），renderer 在命中行打 `Synced` 徽章，并在工具栏追加 `· Synced to #NNNN`（徽章只对当前加载页可见，工具栏那句是同步点被分页出去 / 被搜索滤掉时的兜底）。

数据来源 = `p4 changes -s submitted -m 1 <filespec…>#have`。`#have` 是 p4 的**修订说明符**，解析的是工作区真实的 have 表，所以 P4V / 命令行等**外部同步同样反映**——比「自己记录上次 get 的 CL」正确。

**它是纯 background 查询，不在首屏路径上**：`perforce-graph.getChanges` 只回列表，renderer 拿到后另发 `perforce-graph.getHaveChange` 把徽章补上（两段式）。真机实测（百万文件工作区，完整表格在 `docs/pitfalls.md`「图谱同步点」节）：列表 185ms，而 have 查询**与 scope 内文件数同阶**——全工作区 36–40s、窄子树 340ms、单文件 180ms。由此：

- **`HAVE_CHANGE_EXEC` = `{ priority: 'background', timeoutMs: 60_000 }`**：它已不在关键路径，预算只用来兜住真正挂死的 p4；background 不占用并发门给交互读预留的那一槽。**不要**把它挪回 `Promise.all`——那正是第一版「真机永不出现徽章」的原因（5s 预算 vs 40s 成本 = 每次都超时，且失败不缓存 → 每次加载重跑一遍注定超时的查询）。
- **早期版本用 `@<client>`**（同语义、同答案），但 `@client` 会先把整个 client 的 have 表物化出来：全工作区 40s、**单文件也要 6.3s**，而 `#have` 单文件 180ms。要提速是换 `#have`，不是换更小的预算。
- **缓存 TTL 独立**：`P4CacheNs.haveChange` = `max(workspaceTtlMs, 5min)`，**刻意比列表长**——重读列表是索引查询（185ms），重跑探针是 40s，两者不该共命运。`wrap` 返回 `undefined` = 不缓存失败（下次重试），空答案（该 scope 从未同步）**要**缓存。
- **红线：查询用的 filespec 必须与列表用的完全同一份**。`extension.ts` 的 `resolveGraphScope` 一处解析、两个命令共用（各拿一份 `P4GraphLoadOptions` 后得到同一组 filespec）。**不要**为探针另建一份（重建 / 换分支写法会让返回的 CL 不在列表里，徽章静默永不显示）。
  - scoped（选区 / 文件 / 合并历史）：`buildSyncFilespecs(scopePaths)`，**同一个数组**喂列表与探针。
  - unscoped：探针 = **同一个 `workspaceScope`**（`<工作区根>/...`）。**不要**窄化成 client root：工作区是 client 子目录时，client 级同步点可能由 scope 外的文件产生，会**高报**（把没同步的行标成已同步）。
  - `wholeRepo`：列表是 `//...`，而 **`//...` 不能带任何修订说明符**（真机报 `Path 'E:/...' is not under client's root`，这是该分支以前从未成功过的原因），故探针改用 client root 通配符 `buildScopeFilespec(target.root, true)` + `#have`。carve-out 成立的理由：have 修订只存在于视图映射到该 root 的文件，它们是 `//...` 列表的子集，答案不会命名列表外的 CL。
- **`#have` 必须拼在转义之后**（`getGraphHaveChange` 内部拼；与 `buildForceGetFilespecs` 拼 `#rev` 同一条规矩，见 `p4Filespec.ts`）——否则路径里的 `#` 会和分隔符撞车。空 scope 列表直接返回 `{ id: null, failed: true }`（裸 `-m 1` 是「depot 里最新的变更」，与 have 点正相反，而且它会**成功**回答，错的答案还会被缓存）。
- **失败与空答案必须可区分**（契约 `P4GraphHaveChangeResult`）：查询失败 / 超时 / spawn ENOENT / 无 client → `{ id: null, failed: true }`，只写日志、绝不弹错；「该 scope 里没有已同步的文件」→ `{ id: null, failed: false }`。renderer **只在 `failed: false` 时写 state**——探针失败保留原徽章（一次瞬时超时不该销毁一个大概率仍正确的标注），空答案才是答案（`p4 sync` 到旧 CL 会让同步点真的后退）。`getGraphHaveChange` 自带 try/catch（异常冒泡会杀掉 extension host）。日志 `[perforce] graph have point: #N (K filespec(s), Xms)` 是现场唯一溯源线索，**耗时必须在里面**。
- **`failed` 不缓存、空答案缓存**：p4 对「filespec 什么都没匹配到」是 **exit 0 + 零记录**（真机实测 184ms），所以空答案天然落在缓存那侧，不会退化成每次 revalidate 重跑一遍的全量查询。
- **显式重载强制重探**：`getHaveChange` 的 `force` 只由 `load()`（工具栏 ↺ / 换 scope / 切 client）传 `true`，`revalidate()`（SCM 自动刷新、get 后、Load more）不传——重跑一次的成本是 scope 的规模。`force` 走 `P4Cache.invalidate(ns, key)`，不清整个命名空间。
- **renderer 侧的 generation 守卫**：`PerforceGraphEditor` 的 `haveSeqRef` **独立于 `fetchSeqRef`**（后者在 reveal 分页时也自增，共用会把仍然正确的徽章踢掉）。`load()` 里 `++haveSeqRef` 且 `setHaveChange(null)`（换 scope 时旧答案不得贴到新列表），load / revalidate 落地后各补一次探针，探针落地时比对 seq、过期答案丢弃（三条竞态用例在 `PerforceGraphEditor.test.tsx`：探针在飞时切 scope、两次探针乱序 resolve、失败保留旧徽章 / 空答案清徽章）。
- **刷新**：成功 sync 会 `invalidateWorkspace()` 清掉它。图谱自己发起的 get（右键 Get This Revision / Get Latest Revision / Force Get、目录对话框）在命令 resolve 后显式 `revalidate()`（`getThenRevalidate`）——plain get 不改 `p4 opened`，SCM observable 驱动的自动刷新**不保证**触发。**这 5 个入口各有一条 renderer 单测**（`PerforceGraphEditor re-reads after a get` 表驱动，逐个断言 `getChanges` 与 `getHaveChange` **各**被读第二次）；**不要**指望 e2e 守它——SCM 自动刷新那条路也会投递一次 reload，把 `.then(revalidate)` 改成 no-op 后 e2e 照样绿（已实测）。
- **已知限制**：徽章在列表出现后**才**补上，大工作区可能晚几十秒（缓存命中时几乎即时）；**取消 / 失败的 sync 不失效缓存**（既有行为，`changesSubmitted` 同样如此）→ 之后的自动 revalidate 会复用旧同步点，最长滞后一个 TTL（5 分钟；按 ↺ 立即重探）；外部同步同理，最坏滞后一个 TTL（`perforce.refreshInterval` 默认 0，图谱开着不动不会自己重查）；同步点不落在已加载页时不显示行内徽章，由工具栏兜底（**不为它触发分页**）；换 scope / 关页签**不取消**在飞的探针（收益只是早释放一个后台槽）。

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
- **renderer 单测**：`workbench/perforceGraph/__tests__/PerforceGraphEditor.test.tsx`，mock `ICommandService` 返回假 DTO，断言渲染/展开详情/待定节点。
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
- `extensions/perforce/e2e/specs/perforceGraphHave.spec.ts` —— 同步点徽章三条回归（落在已同步行 / 图谱内 get 后前移 / **打开的是 client 子目录时**整仓库 scope 把徽章移到 client 级同步点——第三条刻意让两个 scope 的答案不同，否则断言在点击前后都成立、等于假绿；fake-p4 的 `changes` case 认 `#have` 后缀，并按**同一个文件**同时过 scope 与 per-file haveRev，seed 用 `SeedFile.haveRev` 把 have 停在中间版本）

## 其它

- 图谱仍**以只读浏览为主**：提交/签出等写操作在 SCM 侧栏（见 `../CLAUDE.md`）。唯一的例外是右键 "Get This Revision / Get Revision… / Force Get (Overwrite Local Files)"（`syncToChange`，见命令清单）——前两者只把工作区 have 版本移动到所选 CL，depot 仍只读；**Force Get 额外销毁目标 scope 内的本地未收集改动**（`p4 sync -f`，确认后执行，见 `../docs/pitfalls.md` 的 `-f` 逃生阀节）。右键其余项是"复制变更号/复制提交信息/发送到 Agent Chat"。
- 加分页/加载更多：`P4GraphLoadResult.moreAvailable` + `PERFORCE_GRAPH_PAGE_SIZE`，`getGraphChanges` 跑 `-m <max+1>` 探测是否还有更多。
