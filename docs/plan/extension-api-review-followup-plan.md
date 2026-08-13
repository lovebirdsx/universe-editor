# Extension API 评审遗留优化计划（fe301598 评审后续）

> **状态（2026-08-13）：待执行。**
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
2. 加/改 RPC 方法走 `packages/extension-host/CLAUDE.md`「加一条新通道」清单；注意
   newline-JSON 的 `undefined→null` 坑（易踩坑 #14）——直到 P3.3 落地前，尾部可选参数
   仍需调用端省略 + 接收端 `!= null` 判定。
3. 行为对扩展开发者可见的：同步 `packages/extension-api/COMPATIBILITY.md` 与
   `docs/extension-dev/zh-CN/`（重点 `api/README.md`、`migration-from-vscode.md`）。
4. 本计划各项**均不改 API 签名**，无需版本五处联动 bump；若执行中发现必须改签名，
   按 `extension-api-parity-roadmap-plan.md` 的约束走 minor bump。

## P1：契约与正确性（对扩展可见的行为背离）

### 1.1 Tree View 增量刷新：handle 稳定化 + 子树失效（复杂，本计划最大件）

**现状**（`packages/extension-host/src/hostTreeViews.ts` + renderer
`TreeViewsService.ts` / `ExtensionTreeView.tsx`）：

- `onDidChangeTreeData` 完全忽略被刷新的 element：任何变更都清空整张 handle 表并发
  全量 `$refresh(viewId)`，renderer 清空全部缓存从 roots 重拉。
- `nextHandle` 从不复位，重拉后所有节点拿**新 handle**——TreeModel 按 `String(handle)`
  存的展开/选中/焦点全部失效，провider 每 fire 一次用户树就整体折叠一次。
- 无 debounce：git 类扩展在文件事件里 refresh（`npm install` 期间数百次）= 每次一轮
  全量失效 + RPC + 整树重拉。
- wire 契约 `$refresh(viewId, parentHandles?)`（`treeViewWire.ts`）声明支持子树失效，
  但两端都是死代码：host 恒发全量，renderer 明确忽略该参数。
- 附带性能项：host 侧 children 拉取对每个 child **串行** `await provider.getTreeItem`
  （500 子节点 = 500 次串行 await）；renderer `pushExpansion` 逐节点发
  `$acceptExpansionState`（评审后已改为仅用户交互触发，重构时保持该语义）。

**方向**（对齐 VSCode extHostTreeViews 的 items-map 模式）：

- host 侧维护 element→handle 的**稳定映射**（有 `TreeItem.id` 用 id，否则对象身份），
  刷新不重编号；`onDidChangeTreeData(element)` 只失效该子树，向 wire 发对应
  `parentHandles`。
- handle 生命期与「代」(generation) 解耦：DTO 携带 generation，renderer 校验后只清
  被点名的 children 页，展开/选中天然保住。
- `$refresh` 加 debounce（~50ms 合并窗口，burst 折叠为一次）。
- children 拉取改 `Promise.all` 批量 resolve。

**验收**：单测覆盖「fire(element) 只重拉该子树 + 展开态保持 + 其它缓存页不失效」
「fire() 全量语义不回归」「burst N 次 fire 合并为一次 wire refresh」；
`smoke.treeView.spec.ts` 补「refresh 后展开态保持」e2e。

### 1.2 WebviewPanel.active/visible 与 editor group 真实联动（中）

**现状**：

- `apps/editor/src/renderer/workbench/editor/WebviewPanelHost.tsx`：挂载即无条件上报
  `(active=true, visible=true)`，卸载报 `(false,false)`，不跟踪 editor group 焦点/
  激活编辑器变化。`ViewColumn.Beside + preserveFocus:true` 创建的面板从未获焦却报
  active=true 且永不更新。
- custom editor（非 hostCreated）面板：`WebviewService.reportPanelViewState` 对无
  routing input 的 handle 直接 no-op（`hostWebviews.ts` 侧 viewState 恒 stale），
  `onDidChangeViewState` 永不触发，扩展无法按可见性暂停渲染。

**方向**：在 WebviewService（或专门 contribution）订阅 editor group 服务的
активgroup/active-editor 变化，统一计算：`visible` = 该 tab 是所在 group 的活动 tab；
`active` = 且所在 group 是焦点 group；变化时才上报（去重）。custom editor 路径复用同一
计算，去掉「无 routing 即 no-op」的早退。

**验收**：单测 mock group 服务验证状态矩阵（分屏/切 tab/切 group/preserveFocus）；
`smoke.webviewPanel.spec.ts` 补「切走 tab 后 onDidChangeViewState 收到
visible=false」e2e。

### 1.3 `contributes.views` 的 `when` 子句门控（中）

**现状**：`ExtensionPointTranslator.ts` 翻译时静默丢弃 `when`（注释自认 not gated on
yet），platform `IViewDescriptor` 无 when 字段，视图管道无门控概念。VSCode 生态大量
扩展依赖 `when`（如 npm scripts 视图仅在有 package.json 时出现），移植即得到永久显示的
空占位视图，连 warn 都没有。

**方向**：`IViewDescriptor` 加 `when?: string`；在 viewDescriptorService /
ViewPaneContainer 层经 `IContextKeyService` 求值并订阅 context 变化门控可见性（对齐
VSCode ViewDescriptorService 层做门控、不是渲染层 if）；translator 透传。

**验收**：单测「when=false 的视图不出现在容器、context 翻转后出现/消失」；
manifest-schema 已允许 when 字段则不动 schema。

### 1.4 `visibleTextEditors` 时序语义打磨（中）

**现状**（`packages/extension-host/src/extensionService.ts`，
`acceptVisibleEditorsChange` 附近）：

- 事件最多等 `ACTIVE_EDITOR_DOC_WAIT_MS`（15s）/未镜像文档，布局变化事件可迟到 15 秒。
- getter 在等待窗口内同步暴露**缺员**集合（activate() 里同步读是最常见用法）。
- generation 守卫按**整批**丢弃：push [a]（a pending）→ push [b] → a 的镜像晚到被整批
  丢弃，а 从此永久缺席（renderer 按 URI 集合去重不会重推同一集合）。

**方向**：立即用已镜像子集更新 + fire，迟到文档镜像落定时**增量补入**再 fire（或
200–500ms 短 grace 替代 15s）；generation 失配时不整批丢弃，改按 editor 粒度合并进
当前代（校验该 editor 仍在最新可见集里）。

**验收**：单测覆盖「冷文档分屏事件不迟到」「连续两次 push 竞态后终态集合完整」
「getter 在事件间隙不缺员（或明确文档化短暂窗口语义）」。

### 1.5 杂项正确性小件（简单，可一个 agent 打包）

| # | 问题 | 落点 | 修法 |
|---|---|---|---|
| a | `createHostPanel` 在 editor groups accessor 未接线时 console.error 后静默 return，扩展拿到"活"panel 但 tab 永不存在，后续 setHtml/postMessage 全 no-op | `WebviewService.ts` | 未接线时挂起请求排队、accessor 就位后回放；或立即通知 host dispose 该 panel 并让 createWebviewPanel reject——二选一，不许静默 |
| b | `findFiles` 的 catch 在 token 已取消时无条件吞掉**真实错误**（路径策略拒绝/RPC 断开恰与取消同刻） | `extensionService.ts` findFiles | 仅吞取消类错误；其它错误至少 warn 后再按取消语义返回 |
| c | 诊断 code round-trip 变型：`'0123'` 经 marker 往返变 number 123 | `lspMonacoConvert.ts` markerToLspDiagnostic | 决策项：要么 MainThreadLanguages 为扩展发布的诊断保留原值 side-table，要么接受损失并写入 COMPATIBILITY.md 已知差异。先查 VSCode 行为再定 |
| d | 树 default-expanded（collapsibleState=2）节点子级永不自动拉取（TreeModel 懒加载仅显式 expand 触发），vscode 会拉 | `workbench-ui/src/tree/TreeModel.ts` + `ExtensionTreeView.tsx` | 物化 default-expanded 节点时触发一次子级拉取；注意别破坏 1.1 的增量语义 |
| e | 扩展容器 order 分层不变量脆弱：`EXTENSION_CONTAINER_ORDER_BASE=100` 隐含「内置容器 order 永远个位数」，无守卫 | platform ViewContainerRegistry | 注册表层引入内置层/贡献层分层排序（层内按既有 order），或至少加一条断言测试锁住不变量 |

## P2：性能与健壮性

### 2.1 文件事件管线：兴趣订阅粒度 + 源头过滤（中）

**现状**（`packages/extension-host/src/hostFileWatchers.ts` +
`MainThreadFileEvents.ts` + `fileWatcherMainService.ts`）：

- `_declareInterest` 每个 watcher create/dispose 都打一次 RPC（应只在 0↔n 翻转时上
  wire）；每个新 unique base 触发 renderer **全量替换式**重推 out-of-workspace 目录表。
- `$subscribeFileEvents(base)` 只带目录不带 glob：renderer/main 对整个目录递归转发全部
  变更，模式过滤留在 host 侧事后做——窄 watcher（`**/*.log`）挂高 churn 目录时每次写盘
  都白跑一次 RPC，正中 5000/批截断防的洪流。
- `acceptFileEvents` 对 events × watchers 逐对 `relativePathUnder` 重算，O(n·m) 热路径。
- 单文件 pattern（`RelativePattern(dir, 'app.txt')`）也武装整棵递归 watch。

**方向**：host 侧兴趣计数、wire 只在 0↔n 翻转；DTO 改 `{base, pattern}`，renderer 用
`compileGlobMatcher` 源头过滤（host 保留最终确认）；目录表改增量 add/remove 而非全量
替换；事件按 base 分组、相对路径每 base 算一次；单文件/无 `**` pattern 走非递归 watch。

**验收**：单测「50 watcher 稳态创建/销毁只产生 O(unique base) 次 wire 调用」「不匹配
pattern 的事件不出 renderer」；现有 hostFileWatchers/MainThreadFileEvents/
fileWatcherMainService 测试全绿。

### 2.2 `findFiles` 数组 exclude 引擎层剪枝（中）

**现状**（`MainThreadFs.ts` `$findFiles`）：数组形 exclude 传给搜索引擎的是 `[]`，改在
renderer 后过滤——rg 仍遍历 node_modules；更糟的是 `FIND_FILES_ENUMERATION_CAP` 在
过滤**之前**消耗，被排除目录吃光额度后真命中被静默截断并报误导 warn。

**方向**：string 项直接留在引擎层；RelativePattern 项按其 base 折算成 walk 级排除；
不变量「cap 只统计有效候选」对两种 exclude 形态一致。

**验收**：单测「数组 exclude 下引擎收到等价排除、cap 语义正确」；
`MainThreadFs.test.ts` 现有 24 用例全绿。

## P3：可维护性（纯重构，行为零变化）

### 3.1 glob 引擎统一（中）

`packages/extensions-common/src/glob/glob.ts`（compileFragment/compileGlobMatcher，服务
findFiles/watcher）与 `packages/platform/src/glob/glob.ts`（patternToRegex/
makeGlobMatcher，服务 editorAssociations/files.exclude/search.exclude）是两套
glob→RegExp 引擎。方向：platform 版补 `[...]` 字符类与 slashless-basename 语义后，
extensions-common 版收敛为 re-export/薄适配（extensions-common 已依赖 platform）。
`splitAbsoluteGlob`（`hostFileWatchers.ts` 私有）同属 RelativePattern 语义，移到
extensions-common 的 glob 模块共享，内部复用 platform `path.ts` 的
normalizeFsPath/dirname/basename。验收：两套引擎的既有测试合并后全绿 + 交叉用例
（同一 pattern 两个入口结果一致）。

### 3.2 副本收敛（简单，可打包一个 agent）

| # | 副本 | 落点 | 收敛到 |
|---|---|---|---|
| a | `toCommandDto` 三份（hostScm.ts / hostTimeline.ts / hostTreeViews.ts；注意 treeViews 版评审后已改为不上 wire arguments + 带 disabled，收敛时以该语义为准并核对 scm/timeline 是否也该去 arguments） | `packages/extension-host` | `hostHandles.ts` 共享导出 |
| b | 兴趣声明协议两份手写（`hostDiagnostics.ts` `_flipInterest` / `hostFileWatchers.ts` `_declareInterest`，2.1 落地后再做以免返工） | `packages/extension-host` | 小型 interest-gate helper（计数 + fire-and-forget + catch warn） |
| c | `fileExtension`（simpleFileDialogUtil.ts）与 platform `extname` 语义重复 | apps/editor dialogs | `extname(name).slice(1).toLowerCase()`（注意评审后该函数已含通配归一化，只收敛纯扩展名提取部分） |
| d | `_hostPanelSubscriptions` 手写 Map+dispose 记账 | `WebviewService.ts` | platform `DisposableMap`（lifecycle.ts） |
| e | `reset()` 与 `disposeHostPanel` 的 tab 关闭块逐字重复 | `WebviewService.ts` | 抽 `_closeHostPanelTab(routing)` |
| f | theme/iconTheme/productIconTheme/grammar 四段相同注册块 | `ExtensionPointTranslator.ts` | 一个 `[batch, register]` 元组循环 |
| g | `markerToLspDiagnostic` 5 层三元 severity + map-filter tags | `lspMonacoConvert.ts` | 查表 `{8:1,4:2,2:3,1:4}` + type-guard filter |
| h | `WebviewPanelInput` 的 `_focusResource` 参数可由 panelHandle 推导 | `WebviewPanelInput.ts` | 构造器内部 `hostPanelResource(panelHandle)`，删参数 |

### 3.3 协议层根治 `undefined→null`（中，收益横切）

newline-JSON 把尾部可选参数的 `undefined` 变 `null`，目前每个调用点手工双保险
（调用端省略 + 接收端 `!= null`），已固化为 extension-host CLAUDE.md 易踩坑 #14，
且 `$findFiles token?` / `$revealWebviewPanel preserveFocus?` / `$refresh
parentHandles?` / `$executeTreeItemCommand commandId?` 还在堆积。方向：在
`packages/extensions-common/src/protocol/rpc.ts` 的序列化/分发层一次解决——序列化剥掉
尾部 `undefined`，或分发端把 `null` 参数归一为 `undefined`（二选一，全链路测试）。
落地后删 CLAUDE.md 易踩坑 #14 条目并清理各调用点的手工绕行，防止第 N+1 次复发。
验收：RPC 层单测覆盖「尾参 undefined 往返仍是 undefined」+ 全量 `pnpm check`。

## 建议执行顺序

1. **P1.5 杂项包**（一个 agent 一轮打包，风险低见效快）
2. **P1.2 WebviewPanel viewState**、**P1.3 views when 门控**（互不相关可并行）
3. **P3.3 协议层 undefined**（先做可让后续新 RPC 不再背绕行负担）
4. **P1.1 Tree View 增量刷新**（最大件，吃掉 1.5d；2.1 的 interest helper 依赖项无关）
5. **P1.4 visibleTextEditors**、**P2.1 文件事件管线**、**P2.2 findFiles exclude**
6. **P3.1 glob 统一**、**P3.2 副本收敛**（尾巴，行为零变化）
