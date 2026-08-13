# Extension API 评审遗留优化计划（fe301598 评审后续）

> **状态（2026-08-13）：十项全部完成（P1.1~P1.5 / P2.1 / P2.2 / P3.1 / P3.2 / P3.3）。**
> 来源：对提交 fe301598（extension-api 0.10~0.12 parity）的多角度代码评审。
> 评审确认的 18 处正确性缺陷已在评审当轮修完（rename overwrite 数据丢失、树视图命令参数
> DTO 化、whenOpened 键不匹配 5s 延迟、幻影展开事件、容器 order 冲突等），本计划只收录
> **当轮刻意不修**的设计级 / 性能级 / 可维护性遗留项。
>
> **给执行 agent 的注意事项**：
> 1. 文中「文件:行」引用基于评审时的代码状态，之后已有一轮修复落盘——动手前先重读现场
>    确认问题仍存在、行号自行重定位；若某项已被顺手解决，直接在本文件标记完成并说明。
> 2. 期与期无强依赖，可按需抽单项执行；单项内的子条目尽量一次做完（同一批文件反复动
>    代价高）。
> 3. 修 bug 类先写失败测试复现；纯重构类以「行为零变化 + 既有测试全绿」为验收。

## 贯穿约束（每项收尾必做）

1. `pnpm check` 全绿；涉及交互的项跑对应 e2e（`pnpm e2e specs/smoke.treeView.spec.ts`、
   `smoke.webviewPanel.spec.ts` 等）+ `pnpm e2e:smoke`。
2. 加/改 RPC 方法走 `packages/extension-host/CLAUDE.md`「加一条新通道」清单；尾部可选参数
   的 undefined 经 RPC 层保持为 undefined（已根治，P3.3）；仅中段可选参数仍需 `| null` +
   `== null` 约定（易踩坑 #14）。
3. 行为对扩展开发者可见的：同步 `packages/extension-api/COMPATIBILITY.md` 与
   `docs/extension-dev/zh-CN/`（重点 `api/README.md`、`migration-from-vscode.md`）。
4. 本计划各项**均不改 API 签名**，无需版本五处联动 bump；若执行中发现必须改签名，
   按 `extension-api-parity-roadmap-plan.md` 的约束走 minor bump。

## P1：契约与正确性（对扩展可见的行为背离）

### 1.1 Tree View 增量刷新：handle 稳定化 + 子树失效（复杂，本计划最大件）— ✅ 已完成（2026-08-13）

**改法**（与下方"方向"一致，两处实现细节按落地情况修正）：

- **host 侧稳定身份**（`hostTreeViews.ts`）：handle 按三级身份分配，依次为
  `TreeItem.id` → 元素对象本身（仍在同一页时）→ 父**句柄**下的 label（`/` 转义
  `//`，同名兄弟 `~n` 去重）。子节点的 key 挂父 handle 而非父 key 字符串，所以父
  节点改名不会连带作废整棵子树的身份。handle 只在元素不再从父 `getChildren` 回来
  时回收（连同其缓存子树），这既保住展开态又给 handle 表封了顶。
- **debounce + 子树失效**：`_scheduleRefresh` 在 50ms 窗口内合并 burst（构造函数第三
  参可注入，测试用 5ms）；窗口内出现无参 fire 则整树语义胜出。flush 时把每个变更
  元素重新 `getTreeItem` 成 DTO 随 wire 一起发。
- **wire 契约改为 `$refresh(viewId, items?: ITreeItemDto[])`**（原 `parentHandles?`
  死代码删除）：无 items = 整树失效；有 items = 每个 DTO 就地替换对应行并只丢它的
  children 页。
- **renderer 缓存改页 + epoch**（`TreeViewsService.ts`）：不再有全局 generation，
  每页（roots 为 `-1`，其余为父 handle）各自记 epoch，**仅在该页有 in-flight 拉取时
  记账且单调递增**——踩过的坑：settle 时删除 epoch 条目会让计数器归零，更老的在途
  拉取比对相等后把已失效的行"复活"（`ExtensionTreeView` e2e 与新增单测各守一道）。
- **视图侧补拉**（`ExtensionTreeView.tsx`）：`onDidChangeView` 时对仍展开、但 children
  页被丢掉的行调 `model.expand()`（已展开时只拉不发事件），保持"展开事件只由用户
  交互触发"的语义。
- **性能**：children 拉取改 `Promise.all` 批量 `getTreeItem`（原 500 子节点 = 500 次
  串行 await）。

**验收结果**：`hostTreeViews.test.ts` 24 例（含 burst 合并为一次、fire(element) 只窄
到该子树、整树 fire 不回归、provider 重建对象/改名/`TreeItem.id` 三种身份、回收后
handle 不再执行命令、`getTreeItem` 并行度断言）；`TreeViewsService.test.ts` 20 例
（子树失效只丢该页、空数组等价整树、未缓存 handle 不触发事件、两种在途/重试竞态）；
`ExtensionTreeView.test.tsx` 新增两例（整树刷新保持展开、per-element 刷新只重拉该
子树）；`smoke.treeView.spec.ts` 新增 `@regression`「keeps the expansion across a
per-element refresh」并把原两例的断言收紧为"展开态跨刷新保留"。

### 1.2 WebviewPanel.active/visible 与 editor group 真实联动（中）— ✅ 已完成（2026-08-13）

**改法**：view state 统一由 `WebviewService` 从 editor groups 推导，不再由
`WebviewPanelHost` 挂载/卸载上报（`reportPanelViewState` 已从接口删除）：
- `setEditorGroupsAccessor` 接线时订阅 `onDidActiveGroupChange` + 每个 group 的
  `onDidActiveEditorChange`（`onDidAddGroup/RemoveGroup` 维护动态订阅，DisposableMap
  按 group.id 记账，根 store `markAsSingleton` 防 reload 泄漏门禁误报）；创建路径
  （`createHostPanel` / `openPanel`）在流尾显式补一次重算作初始上报（preserveFocus
  打开不发 active-editor 事件）。
- 统一计算：`visible` = tab 是所在组的 activeEditor（经 `findEditor` 拿 canonical
  实例比对，兼容 model 同 id 去重换新）；`active` = visible 且该组 `isActive`；按
  handle 记上次上报位串去重，迁移才走 `$acceptPanelViewState`（host 侧原有去重兜底）。
- custom editor：`openPanel` 加尾参 `editor`，`CustomEditorHost` 把自己的 input 传入，
  routing 存 `editor` 字段——「无 routing input 即 no-op」早退消失，custom editor
  面板同样随切 tab/分屏焦点迁移触发 `onDidChangeViewState`；初始上报排在
  `$resolveCustomEditor` 之后上流，保证 host 面板已存在。
- 文档：`COMPATIBILITY.md` 0.11.0 节、`webview-guide.md`、`migration-from-vscode.md`
  与 extension-api 的 `WebviewPanel.active/visible` JSDoc 已同步新语义。

**验收**：单测 `WebviewService.test.ts` 用真实 `EditorGroupsService` 覆盖状态矩阵
（分屏切焦点掉 active 保 visible / 切 tab 往返 / preserveFocus 不误报 active / custom
editor 路径 / 去重）；`smoke.webviewPanel.spec.ts` 新增「fires onDidChangeViewState
when the panel tab hides and re-shows」e2e（切走收 visible=false、reveal 收回
true 各一次）。`pnpm check` 全绿；该 spec + webview/webviewDiff e2e + @p0 冒烟均过。

### 1.3 `contributes.views` 的 `when` 子句门控（中）— ✅ 已完成（2026-08-13）

**改法**：门控落在 `ViewDescriptorService`（对齐 VSCode，不走渲染层 if）。platform
`IViewDescriptor` 加 `when?: string`；translator 从此透传；service 注入
`IContextKeyService`，`getViewsByContainer` 按 `ContextKeyExpr.deserialize`（按原始串
memo）+ `contextMatchesRules` 过滤（空/解析失败 = 可见，VSCode 语义），容器若没有任何
可见视图则随既有「空容器不显示」规则从活动栏消失。订阅 `onDidChangeContext`：先按全部
已注册 when 表达式引用的 key 做 affects 短路，再逐视图对比可见性缓存，只在真翻转时 bump
`version`（不打点持久化），翻转写 debug 日志到 views channel。**when 是硬门控**：可见
集合只用于查询/渲染，`_viewLocations`/`_viewStates` 里的用户定制（归属/顺序/折叠/尺寸）
原样保留；move/reorder/order 分配/生成容器回收改走未过滤的 `_allViewsByContainer`，
隐藏视图不参与 UI 排序但不被记账逻辑丢弃。DI 接线（main.tsx 中 IContextKeyService /
ILoggerService 均先于 createInstance 注册）无需改。

**验收**：单测 `ViewDescriptorService.test.ts` 新增 when-clause gating 4 用例
（when=false 不出现、context 翻转出现/消失且无关键不 bump、复合表达式、容器消失/归位）
+ `ExtensionTranslation.test.ts` 透传 2 断言；manifest-schema 本就允许 `when`，schema
未动。`pnpm check` 全绿；`smoke.treeView / viewMove / viewSizes / viewReorder / activityBar`
10 用例 e2e 全过；@p0 冒烟全过。文档同步：`COMPATIBILITY.md` 0.12.0 节、
`contribution-points.md` views 的 when 行、`services/views/CLAUDE.md`。

### 1.4 `visibleTextEditors` 时序语义打磨（中）— ✅ 已完成（2026-08-13）

**改法**：`whenOpen` held-fire + generation 整批丢弃整体拆除，改为「getter 即
时重建 + 短宽限期 + onDidOpen 增量并入」（`extensionService.ts`）：

- **getter 即重建**：push 到达即按最新快照重建 `_visibleTextEditors`（只含已
  镜像成员，组序保持），getter 在事件间隙暴露的是「最新集合的已知子集」——
  短暂缺员窗口属结构性（渲染端先语言激活后推 didOpen，无法根治），已在
  COMPATIBILITY.md / api/README.md / migration-from-vscode.md / extension-api
  JSDoc 如实文档化，收敛由 didOpen 保证。
- **500ms 宽限期**（`VISIBLE_EDITORS_DOC_GRACE_MS`）替代 15s 上限：有未镜像
  成员时 arm/重置一个共享定时器，期间零事件；成员在窗口内到齐则取消定时器
  立即报完整集合（冷路径通常单跳）；超时按已镜像子集上报，布局变化不再被
  扣 15 秒。
- **迟到并入按 editor 粒度**：`ExtHostDocuments.onDidOpen` 常驻监听（替代
  `whenOpen` promise），落地文档若仍在最新推送集合（identity 比对）即重建
  getter 并补报事件——镜像落地**不设等待上限**：旧设计 15s 后 gen 失配整批
  丢弃、文档永久缺席的场景消除；fire 统一按 URI join 去重（顺带的收益：
  「已报子集」与宽限到期子集相同时不发假退化事件）。
- activer editor 路径（`acceptActiveEditorChange` / `getActiveTextEditor` 的
  `ACTIVE_EDITOR_DOC_WAIT_MS`）不在本项范围，未动。

**验收**：`extensionService.test.ts` visible describe 9 例全绿——既有 4 例行
为不回归；新增 5 例中 4 例先红后绿（冷文档布局变化 1000ms 内上报而非 15s、
push 竞态 + 迟到 20s 镜像仍并入终态完整、getter 短窗缺员且 didOpen 收敛、
宽限期内 stragglers 到齐只 fire 一次完备集），第 5 例守护同文档双分屏列两
项。`pnpm check` 全绿。

### 1.5 杂项正确性小件（简单，可一个 agent 打包）— ✅ 已完成（2026-08-13）

| # | 问题 | 落点 | 修法 |
|---|---|---|---|
| a | `createHostPanel` 在 editor groups accessor 未接线时 console.error 后静默 return，扩展拿到"活"panel 但 tab 永不存在，后续 setHtml/postMessage 全 no-op | `WebviewService.ts` | ✅ 排队+回放（选前者）。`MainThreadWebviews` 对负 handle 空间（扩展自有 panel）的调用在 accessor 未接线时 warn 并挂起在 `whenEditorGroupsWired` promise 上，接线后按到达顺序回放（同步快路径保正常路径零开销）；dispose 时冲刷队列并让排队调用 no-op。选排队而不是 dispose+reject 的理由：accessor 在 main.tsx bootstrap 同步接线、远早于 host 连接，生产里永不会交叠，排队对任何接线时序回归都自愈且对扩展零可见失败；`window.createWebviewPanel` 是同步 API，reject 无法不改签名表达，且 fire-and-forget RPC 的 reject 会变成 host 侧 unhandledRejection |
| b | `findFiles` 的 catch 在 token 已取消时无条件吞掉**真实错误**（路径策略拒绝/RPC 断开恰与取消同刻） | `extensionService.ts` findFiles | ✅ 已修。token 已取消时：`isCancellationError` 的取消类错误静默返回 []；其它错误 console.warn 后按取消语义返回 []；token 未取消照旧 rethrow |
| c | 诊断 code round-trip 变型：`'0123'` 经 marker 往返变 number 123 | `lspMonacoConvert.ts` markerToLspDiagnostic | ✅ 已决：对齐 VSCode。调研 vscode main `extHostTypeConverters.Diagnostic`：正转 `String(code)`（数字也字符串化），反转恒返回字符串（`isString ? code : code.value`，不恢复 href）。故去掉我方的 `/^\d+$/→Number` 启发式，读回恒为字符串——前导零 `'0123'` 原样保留（修复缺陷），数字 code 读回为字符串（与 VSCode 同款有损），`codeDescription.href` 继续恢复（比 VSCode 更完整的增量，不构成 parity 背离）。不需 side-table。已写入 COMPATIBILITY.md 0.10.0 节、migration-from-vscode.md 诊断行与 extension-api JSDoc |
| d | 树 default-expanded（collapsibleState=2）节点子级永不自动拉取（TreeModel 懒加载仅显式 expand 触发），vscode 会拉 | `workbench-ui/src/tree/TreeModel.ts` + `ExtensionTreeView.tsx` | ✅ 已修（仅 TreeModel，`ExtensionTreeView.tsx` 无需改）。`_collect` 物化 default-expanded 节点时经新私有 `_pullChildren`（与 `expand()` 共用）触发一次子级拉取，settle 后发一次结构事件驱动重渲染并自然级联嵌套层；不发 `_onDidChangeExpansion`（保持"仅用户交互"语义，不纠缠 1.1 增量刷新）；每 id 只拉一次（loading/error 守卫，失败重试走显式 expand）。影响面核实：同时用 defaultExpanded+loadChildren 的消费者只有 ExtensionTreeView |
| e | 扩展容器 order 分层不变量脆弱：`EXTENSION_CONTAINER_ORDER_BASE=100` 隐含「内置容器 order 永远个位数」，无守卫 | platform ViewContainerRegistry | ✅ 分层排序（选前者）。`IViewContainerDescriptor` 加 `contributed?: boolean`，`getViewContainers` 先按层（内置<贡献）再按 order 排；translator 注册扩展容器时置 `contributed: true`，`ORDER_BASE=100` 退化为层内间距。现存全部 order（内置最大 6、Swarm 3.5、扩展 100+、generated 动态容器默认非贡献层）下排序结果与旧行为逐一致，属行为零变化加固；新增 `viewRegistry.test.ts` 锁分层语义 |

## P2：性能与健壮性

### 2.1 文件事件管线：兴趣订阅粒度 + 源头过滤（中）— ✅ 已完成（2026-08-13）

**改法**（与下方"方向"一致，"单文件走非递归"按 glob 语义修正后落地）：

- **wire 契约改 `{base, pattern}`**（`extensions-common` rpc.ts 新增
  `IFileWatcherInterestDto`，host 侧最终确认保留）：`$subscribeFileEvents` /
  `$unsubscribeFileEvents` 各带一份兴趣描述。
- **host 侧兴趣 0↔n 翻转**（`hostFileWatchers.ts`）：按 `(folded base, pattern)`
  引用计数，同一兴趣只在 0↔n 翻转时打 RPC（50 个同 glob watcher = 1 对调用，同
  base 不同 pattern 各计一份）；`_declareInterest(dto, flip)` 保留「计数 +
  fire-and-forget + catch warn」形状，3.2b 可直接抽出复用。踩坑修正：`dispose()`
  不能走 `_releaseInterest` 引用计数（同兴趣 lease count>1 时漏发 unsubscribe），
  改为全量直发后清表。
- **host 匹配分组**：watcher 按 anchor（`base ?? workspaceRoot`，经
  `getPathComparisonKey` 折叠）分组进 `_byAnchor`，`acceptFileEvents` 每事件每
  anchor 只算一次 `relativePathUnder`，组内逐 matcher——O(events × anchors)。
- **renderer 源头过滤**（`MainThreadFileEvents.ts`）：持声明兴趣表，`_forward`
  同样按 anchor 分组后逐事件试配；整批零命中直接不上 RPC，部分命中先过滤再做
  5000/批截断（cap 自此只花在中标事件上），丢弃数写 debug 日志。
- **目录表增量 add/remove**：platform `IFileWatcherService` 的
  `watchOutOfWorkspaceFolders`（全量替换）拆为 `addOutOfWorkspaceFolder` /
  `removeOutOfWorkspaceFolder` / `clearOutOfWorkspaceFolders`；main 侧改为 declared
  集合记账 + 增删后重算 wanted（嵌套折叠、under-root skip 原逻辑保留），增量
  remove 父目录后仍声明的子目录会重新 arm。同 base 多 pattern 共享折叠后的
  folder watch（renderer 引用计数）。
- **单文件降级收窄**（对"方向"的如实修正）：本仓库 glob 语义下 slashless 字面量
  （`'app.txt'`）= 任意深度 basename（ripgrep `-g` / VSCode 同款），并非单文件，
  递归 watch 不能省；「无 `**` 但含 glob」的 pattern 深度虽受限，`fs.watch` 无深度
  档。因此只对**含 `/` 且无 glob 字符**的真·锚定单文件（`'cfg/app.txt'`）降级为
  经 `IOutOfWorkspaceWatchService` 聚合层的文件级非递归 watch（复用既有
  `watchOutOfWorkspace` 存在性采样分类，多消费者不互踩）。
- `MainThreadFileEvents` 新依赖经 `HostConnectionDeps`（`outOfWorkspaceWatch` +
  `workspaceRoot`）接线；文件级 watch 句柄与 folder watch 在 dispose 时一并清。
- 扩展可见 API 语义零变化，COMPATIBILITY.md / docs 未动。

**验收**：`hostFileWatchers.test.ts` 22 例（含 50 同 pattern watcher 仅 1 对 wire
调用、同 base 不同 pattern 各自翻转、ci 平台大小写折叠合并、anchor 分组扇出回归，
dispose 漏发 unsubscribe 一例先红后绿）；`MainThreadFileEvents.test.ts` 11 例
（不匹配 pattern 的事件不出 renderer、based 过滤、folder 共享计数、单文件降级、
slashless 保递归、dispose 清场）；`fileWatcherMainService.test.ts` 31 例（folders
相关改写为增量：collapse、remove 父重 arm 子、clear）。`pnpm check` 全绿。e2e 跳过：
纯 host/RPC/main 管线内部改动，无 UI 交互面；且内置扩展源码无一调用
`createFileSystemWatcher`（git/SCM 不消费该管线），无既有 e2e 覆盖路径。

### 2.2 `findFiles` 数组 exclude 引擎层剪枝（中）— ✅ 已完成（2026-08-13）

**改法**：改动全在 `MainThreadFs.$findFiles`，wire 契约与 host 侧
`undefined→null / null→[] / glob→[glob]` 映射均未动。

- **数组 exclude 整体下沉引擎查询**：string 项原样进 `query.excludes`（rg
  `-g !glob` + `expandExcludeGlob` 的目录剪枝语义——无 slash 的 `node_modules`
  按 gitignore 语义任意深度整棵子树不遍历；这与 `exclude === null` 时的配置排除项
  恰好同一条管线）；renderer 后过滤整段删除（`_compileExclude` 移除）。
- **RelativePattern 项折算**（`_foldExcludeForEngine`）：base 经
  `relativePathUnder` 折算成枚举根相对前缀拼到 pattern 前；base 在根外或 URI
  无效折成「不排除」（等价旧的 `() => false`）。折算时**复刻
  `compileGlobMatcher` 的归一化**（slashless pattern 前缀 `**/` 才能在锚定前缀
  下保住「base 下任意深度 basename」语义）；空 pattern 保持旧语义折成空。
- **cap 语义修正**：排除在枚举前生效，`FIND_FILES_ENUMERATION_CAP` 只统计有效
  候选，不再出现「被排除目录吃光 10 万额度后真命中被静默截断 + 误导 warn」。
- include 过滤仍在后处理（`pattern: ''` 全量枚举语义未变），不在本项范围。
- 文档同步：`COMPATIBILITY.md` 0.10.0 节 findFiles 行、`api/README.md` 与
  `migration-from-vscode.md` 的 findFiles 行、extension-api `findFiles` JSDoc。

**验收**：`MainThreadFs.test.ts` 30 例全绿（原 24 例零改动保留；fakeSearch 改
为忠实模拟引擎——按 `query.excludes` 用 gitignore 语义剪枝 + maxResults 截断）。
新增 6 例中 5 例先红后绿：string exclude 进引擎且不混入默认排除项、slashless
排除任意深度目录剪枝、RelativePattern 折算（含 RelativePattern include 的枚举根
联动）、根外 base 折成空、**10 万条被排除条目不再吃掉 cap**（旧实现返 `[]` +
warn，新实现返回真命中且不 warn）。文档同步如上。e2e 跳过：纯 renderer 侧引擎
查询编排，无 UI 交互面，且没有内置扩展调用 `workspace.findFiles` 形成覆盖路径。

## P3：可维护性（纯重构，行为零变化）

### 3.1 glob 引擎统一（中）— ✅ 已完成（2026-08-13）

**改法**：两套 glob→RegExp 引擎收敛为 platform 单一 fragment 编译器 + 两个入口
（`packages/platform/src/glob/glob.ts`），extensions-common 的 glob 模块变薄适配。
两边的**语义无差异项**（`*`/`?`/`**` 跨段与零段、输入串归一化、大小写全平台敏感、
未闭合 `{`/`[` 按字面）原样共享；**真实差异**逐条处置如下：

- **`[...]` 字符类、brace 备选按 glob 片段编译**：platform 版原为字面字符/逐字
  escape——统一后补齐（VSCode 语法能力）；现存消费方的合法输入（字面备选、无 `[`
  的 pattern）编译结果逐一致，属"补齐缺失能力"而非行为变更。
- **slashless-basename 差异刻意保留**：`makeGlobMatcher` 不再"补上"该语义——
  files.exclude/search.exclude/files.watcherExclude 里无 `/` 的排除项旧行为是
  根目录级排除，改成任意深度会静默改变 Explorer/Search 的用户可见行为；
  editorAssociations/schemaMatch 的调用方本就自带 `**/` 前缀
  （`ExtensionsContribution.toResolverGlob`、schemaMatch 的 `[p, **/${p}]` 展开），
  无真实需要。该差异改为由共享 helper `normalizeExtensionGlobPattern`（platform
  新导出）在入口层显式表达：`compileGlobMatcher = 归一化 + 同一编译器`，
  `makeGlobMatcher = 原样编译`，两式在模块头文档声明。与此同理，pattern 级
  归一化（反斜杠/前后导斜杠）也仅属扩展面入口，设置面保持原样。
- **扩展面入口** `compileGlobMatcher`（slashless=任意深度 basename，服务
  findFiles/watcher）随编译器移到 platform 并经 `glob/index.ts` 既有 barrel 出根；
  extensions-common 的 `glob.ts` 改为 re-export（`compileGlobMatcher` +
  `normalizeExtensionGlobPattern`），renderer/ext host 消费方 import 路径零改动。
- **`splitAbsoluteGlob` 移入 extensions-common 的 glob 模块**（自
  `hostFileWatchers.ts` 私有函数提升，含 `HAS_GLOB_CHARS`，`[` 计入 glob 字符与
  编译器的字符类支持一致）；glob-free 分支改用 platform `dirname`/`basename`，
  glob 分支保持段切分（"首个 glob 段之前的字面前缀 verbatim"语义 dirname 表达
  不了，强用会让 `'a/../b/*.ts'` 这类 base 拼写归一化失真，故 `normalizeFsPath`
  不适用）。两处 stone-dead 退化拼写有新语义并被测试钉住：`'//file.txt'` 旧接受
  base `'/'`（与同名 posix 根的 `'/file.txt'` 拒绝语义本就矛盾），现统一拒绝
  任何裸根；`'/abs//file.txt'` 旧 base 保留尾双斜杠 `'/abs/'`，现折叠为
  `'/abs'`（comparison-key 层本就折叠，wire 拼写差异对外不可见）。
- **P2.2 复刻收敛**：`MainThreadFs._foldExcludeForEngine` 的内联归一化（反斜杠/
  斜杠剥离 + slashless→`**/` 前缀 + `**`/空直通）删除，改用共享
  `normalizeExtensionGlobPattern`（helper 内置 `**` 与空 pattern 直通，rg
  `-g !glob`/expandExcludeGlob 剪枝路径的输入字符串与旧实现逐一致）。

**验收**：
- platform `glob.test.ts` 53 例全绿 = 原 platform 用例 + 原 extensions-common
  `compileGlobMatcher` 15 例（零改动迁入）+ `makeGlobMatcher` 字符类/片段备选
  能力断言 + `normalizeExtensionGlobPattern` 定向用例 + **交叉矩阵**（12 个
  pattern × 17 条路径，覆盖 `**`/`*`/`?`/`{a,b}`/`[...]`/slashless basename/
  前导 `./`/反斜杠/大小写策略）断言统一不变式
  `compileGlobMatcher(p) ≡ makeGlobMatcher([normalizeExtensionGlobPattern(p)])`，
  另钉住两个入口 slashless 差异的边界断言与双入口大小写一致性。
- extensions-common `glob.test.ts` 12 例（re-export 语义保留抽样 + `splitAbsoluteGlob`
  全套——含自 hostFileWatchers.test.ts 迁入的既有 5 例、新增字符类切分/裸根拒绝
  用例及拆分结果回配 `compileGlobMatcher` 的交叉例）；extension-host
  `hostFileWatchers.test.ts` 17 例（移除 5 例 split 用例后，Registry 其余用例零改动）。
- apps `MainThreadFs.test.ts` 30 例 + `MainThreadFileEvents.test.ts` 11 例零改动全绿。
  platform/extensions-common/extension-host 包 `pnpm check` 全绿。
- e2e 跳过：纯内部重构；files.exclude/search.exclude/editorAssociations 走
  `makeGlobMatcher`/`makeExcludeMatcher` 的匹配结果对全部既有有效输入逐一致
  （差异只在既往不作为能力存在的 `[...]`/备选内 glob 路径），无 UI 交互面。
- 文档：纯内部重构，COMPATIBILITY.md 与 docs/extension-dev 未动。

### 3.2 副本收敛（简单，可打包一个 agent）— ✅ 已完成（2026-08-13）

| # | 副本 | 落点 | 落地结果 |
|---|---|---|---|
| a | `toCommandDto` 三份（hostScm.ts / hostTimeline.ts / hostTreeViews.ts） | `packages/extension-host` | ✅ 收敛为 `hostHandles.ts` 共享导出 `toCommandDto(cmd, fields)`：`tooltip` 恒过线，`disabled/icon/arguments` 由调用点经 `CommandWireField[]` 声明——tree=`['disabled']`、timeline=`['arguments']`、scm=`['disabled','icon','arguments']`，三处 wire 形状与原实现逐字一致。**刻意不统一去 arguments**：renderer 真实消费——`ScmView.commandArgs` 显式 arguments 优先于资源行本身（p4 shelved 行携 changelist+depot path），`TimelineView.runItem` 把 arguments 展入命令调用（`viewCommit` 从 `arguments[0]` 取 repo uri）；去掉会破坏这两个交互面 |
| b | 兴趣声明协议两份手写（`hostDiagnostics.ts` `_flipInterest` / `hostFileWatchers.ts` `_declareInterest`） | `packages/extension-host` | ✅ 新建 `interestGate.ts` 的 `InterestGate<TDto>`：按 key 计数 lease + 0↔n 翻转 fire-and-forget + catch warn + `dispose()` 全量直发后清表（P2.1 踩过的坑：lease 逐个 release 会在 count>1 时漏发 unsubscribe）；`acquire` 返回 one-shot lease。HostDiagnostics（固定单 key）与 HostFileWatcherRegistry（entry 持 lease 代替 interestKey）接入，warn 文案与翻转时机原样；`acquire` 返回裸对象不挂 leak tracker（host 进程不安装 tracker，避免无谓追踪开销）。新增 `interestGate.test.ts` 6 例（共享 0↔n、独立 key、one-shot、dispose 直发、滞后 release no-op、reject warn） |
| c | `fileExtension`（simpleFileDialogUtil.ts）与 platform `extname` 语义重复 | apps/editor dialogs | ✅ 函数体收敛为 `extname(name).slice(1).toLowerCase()`；通配归一化留在 `collectFilterExtensions` 未动。点头文件 / 多点 / 大小写边界与原版逐一致（既有 4 断言全绿） |
| d | `_hostPanelSubscriptions` 手写 Map+dispose 记账 | `WebviewService.ts` | ✅ 改 platform `DisposableMap`（`_register` 进服务 store：`set`/`deleteAndDispose`，dispose 随 `super.dispose()` 全清并自动 parent 泄漏追踪）；`dispose()` 手写迭代删除。注：P1.2 已为同文件 group 订阅引入 DisposableMap，本条补齐剩余手写 Map |
| e | `reset()` 与 `disposeHostPanel` 的 tab 关闭块逐字重复 | `WebviewService.ts` | ✅ 抽 `WebviewService._closeHostPanelTab(routing, input)`（两参签名绕开 strict TS 不做断言收窄）：suppress→逐组关 tab→未关则还原标志直 dispose，两侧语义逐字一致 |
| f | theme/iconTheme/productIconTheme/grammar 四段相同注册块 | `ExtensionPointTranslator.ts` | ✅ 收敛为泛型私有 `_registerContributionBatch<T>` + 单份 themeContext + 4 行调用。与计划字面（`[batch, register]` 元组循环）的偏差：四个回调的 batch 元素类型异构（IThemeContribution / IIconThemeContribution / IProductIconThemeContribution / IGrammarContribution），`strictFunctionTypes` 下元组数组需类型擦除/断言，泛型 helper 零断言且逐调用点类型安全 |
| g | `markerToLspDiagnostic` 5 层三元 severity + map-filter tags | `lspMonacoConvert.ts` | ✅ severity → 模块级查表 `LSP_SEVERITY_BY_MARKER`（`{8:1,4:2,2:3,1:4}`，`?? 1` 保"未知 severity 回 Error"语义）；tags map-filter → type-guard filter（LSP DiagnosticTag 与 Monaco MarkerTag 数值一致，guard 直接保留下探已知值） |
| h | `WebviewPanelInput` 的 `_focusResource` 参数可由 panelHandle 推导 | `WebviewPanelInput.ts` | ✅ `hostPanelResource` 自 `WebviewService.ts` 移入 `WebviewPanelInput.ts` 导出，构造器改为 3 参（`_focusResource` 内部推导）；`WebviewService` 改从该模块 import；`WebviewPanelInput.test.ts` 同步改为派生断言 |

**验收**：纯内部重构，行为零变化。extension-host 261 例全绿（含新增 `interestGate.test.ts` 6 例；`hostFileWatchers` 17 / `hostDiagnostics` 6 / `hostScm` 4 / `hostTimeline` 6 / `hostTreeViews` 24 例零改动通过，三处 wire 形状被既有断言钉住）；apps 定向 226 例全绿（`WebviewService` / `WebviewPanelInput` / `simpleFileDialogUtil` / `SimpleFileDialog` / `lspMonacoConvert` / `ExtensionTranslation` / `TreeViewsService` / `MainThreadLanguages`，其中 `WebviewPanelInput.test.ts` 因构造签名变化同步调整）。`pnpm check` 全绿。e2e：`smoke.webviewPanel.spec.ts` 2 例 + `smoke.treeView.spec.ts` @regression 3 例（`e2eg "extension tree view"`）+ @p0 冒烟全过。COMPATIBILITY.md 与 docs/extension-dev 未动（无扩展可见行为变化）。

### 3.3 协议层根治 `undefined→null`（中，收益横切）— ✅ 已完成（2026-08-13）

**改法**：选发送端方案——在 platform `ProxyChannel.toService` 的代理函数里
（序列化真实落点；extensions-common 的 rpc.ts 只是纯类型契约）加
`stripTrailingUndefined`，剥掉参数数组尾部的 `undefined`（在 token 提升之后处理
token 路径），尾部可选参数自此往返仍是 undefined，语义化 null 原样穿越。不选接收端
归一（`null→undefined`）的理由：协议存在中段语义化 null（`$findFiles` 的
`exclude: null`=默认排除集 / `maxResults: null`=无上限），归一会损毁之。中段
`undefined` 仍按 JSON 数组语义变 `null` 保持为约定（中段可选参数声明 `| null`）。
**清理**：`TreeViewsService` 的 loadChildren/executeTreeItemCommand 双分支省略简化
为直传；`hostTreeViews`（`!= null` 注释去 wire 化）、`extensionService`
acceptSelectionChange 归一化注释、treeViewWire `$executeTreeItemCommand` 契约文档、
相关测试名/断言同步；易踩坑 #14 改写为根治记录 + 中段约定；platform CLAUDE.md 补
IPC 约定一条。验收：`proxyChannel.test.ts` 新增 3 用例（先红后绿：尾参 undefined
往返仍是 undefined、语义化 null + 中段约定保持、token 路径不夹 null）+
`pnpm check` 全绿 + `@p0` 冒烟过。

## 建议执行顺序

1. **P1.5 杂项包**（一个 agent 一轮打包，风险低见效快）
2. **P1.2 WebviewPanel viewState**、**P1.3 views when 门控**（互不相关可并行）
3. **P3.3 协议层 undefined**（先做可让后续新 RPC 不再背绕行负担）
4. **P1.1 Tree View 增量刷新**（最大件，吃掉 1.5d；2.1 的 interest helper 依赖项无关）
5. **P1.4 visibleTextEditors**、**P2.1 文件事件管线**、**P2.2 findFiles exclude**
6. **P3.1 glob 统一**、**P3.2 副本收敛**（尾巴，行为零变化）
