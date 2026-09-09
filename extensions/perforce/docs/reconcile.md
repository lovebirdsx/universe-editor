# 收集修改（常驻 reconcile 分组）与 Explorer 按需徽标通道

> 本文是 `extensions/perforce/CLAUDE.md` 的配套详情档，讲「收集修改」体验对齐 git 的完整实现：常驻 reconcile 分组、Explorer 行级改动徽标（`checkWorkingTree`）、落后灰字（`checkBehind`）。

## 收集修改（常驻 reconcile 分组）

**根因**：git 面板 = 磁盘真相（`git status`），p4 面板 = 服务器 `p4 opened`（只显示**已签出**的文件）→ 磁盘上改了/建了/删了但没签出的文件面板看不到，形成「改了看不到、想签点不到」死结。解法是一个**常驻分组** `_reconcileGroup`（`RECONCILE_GROUP_ID = 'reconcile'`，SCM 组 id，标题「Changes」，与 git 的 Changes 组同名以省出横向空间），它的 `resourceStates` = 未签出但磁盘偏离 depot 的全部文件，**整组可见、可点、可拖**，让 p4 面板对齐 git 的「Changes」体验：

- **常驻组成员**：`client.ts` `_reconcileGroup` 在 `_resolveGroup` 之后、changelist 组之前创建（`createResourceGroup`），所以渲染在「Needs Resolve」之下、changelist 组之上（SCM 视图按创建顺序显示组）；`hideWhenEmpty = true`，无漂移时整组消失。
- **组内容 = 全量替换，不是 patch**：`_applyDriftGroup()` 是**唯一**写 `_reconcileGroup.resourceStates` 的地方，且**每次赋整个数组**。全量替换是承重设计——renderer 从新数组整体重建文件/文件夹装饰，**离开集合的行连带它的文件夹染色（含祖先）一起回收**；逐行 patch 会把我们打回文件夹聚合的老路。行过滤（已 `opened` / excluded / scope 外）在赋值处而非合并处跑，所以「收集一个文件」下次刷新就自动移进它的 changelist 组，无需重新扫描忘记它。
- **数据源**：`_driftFiles`（`Map<key, ReconcileFile>`）。发现走**单轮扫描 + watcher 增量**——每个会话一次穷举扫描（`scheduleReconcileScan`，`_rescanReconcilePaths` 按目录分批喂入），之后靠 `_startExternalWatcher`（`watchRoot` + `createFileSystemWatcher`，见 `extension.ts` 传的 opts）逐文件增量修正。任何会改 `_driftFiles` 的路径都走 `_scheduleDriftApply()` 合并赋值（窗口随行数缩放）；扫描轮末 `_flushDriftApply()` 同步落定，面板与「scanning x/y」后缀同 tick 收敛。
- **Bug D 的两条失效路径都已堵**：watcher 删除磁盘路径（`_onExternalFileEvent` → `_flushExternalChanges` 的窄查询 + checkpoint 合并），以及目录变更的命名空间擦除路径（超过 `MAX_EXTERNAL_NARROW_PATHS` 预算或目录事件时 `_invalidateAndLatch`）。都不得回退成「重新打开又全量重扫」——启动快照（checkpoint）持久化仍在，只是这两条路径不再摧毁它。
- **收口**：`_applyDriftGroup()` 同时维护 `_driftShown`/`_driftTotal` 与 `_updateDriftGroupLabel()`（截断 `perforce.reconcileLimit` 默认 10000、扫描进度后缀），二者都是**进度/截断提示，绝非装饰**——scan 逐目录推进而非一次原子落地，不带后缀的部分列表会被当作完整列表，用户会以为看全了。
- **收集**：`reconcile(paths)`（explorer 右键「收集改动」`perforce.reconcile`，目录转 `<dir>/...`）跑**真** `p4 reconcile -a -e -d`，文件签出进 changelist。`reconcileInto(cl, paths)`（`reconcile -a -e -d [-c <cl>]`，`default` 省略 `-c`）把未签出文件直接收集进指定 changelist——供把未签出文件拖到 changelist 组头（`reopenTo`，见下文）。
- **移出 Changelist**：`moveToReconcile(paths)` = `p4 revert -k`（退出签出、磁盘内容保留），之后该文件出现在「Changes」组并在资源管理器显示改动徽标（M/A/D），可再收集回任意 changelist。**它必须自己把这些行加回漂移集**（`_reapplyDriftForMutation`：裸目录补 `/...` → `_reconcileScanBatch` 窄查一次 → upsert 进 `_driftFiles`/`_driftWatchedKeys` → `_scheduleDriftApply()`）——`_mutate` 的善后只做减法（`_removeDriftUnder`），而这些文件 revert 前是 `opened`（本就不在漂移集里），减法减不到任何东西；同时 mutation 自己的 watcher 事件被 `_suppressExternalChanges()` 抑制，两头都不补的结果是文件**在本会话彻底消失**，要等下个会话扫描才回来。查询失败只记日志、**绝不记成 clean**（漂移留给下个会话的扫描找到）。守卫见 `clientReconcileScan.test.ts` 的 `re-adds reverted files as drift…`。凡是「让文件从 opened 变回未签出」的新命令都要照此补这一步。
- **还原（统一入口）**：`perforce.revert` 按打开状态分流——已打开走 `revert(paths)` = `p4 revert`（离开 changelist + 丢本地改动）；未打开走 `revertReconcile(paths)` = `p4 clean`（旧「丢弃未收集的改动」）。确认框在含已打开文件时列出将离开 changelist 的文件（`revertPlan.ts`）。Explorer 目录去掉 `!explorerResourceIsFolder`，`openedInTree(dir)` 做 live `p4 opened dir/...` 预检后始终 `p4 clean dir/...`，有 opened / fail-open 才叠加 `p4 revert dir/...`。**目录判定走纯函数 `isRevertDirectoryTarget(selection, arg0.isDirectory)`**：Explorer 右键目录时菜单期总会把选区物化成 args[1] 且含 primary 自身，所以行右键只能判「selection 恰好只有那一个目录」；但空选区形态仍真实存在（Explorer 空区右键菜单无 args[1]、右键工作区根行 selection 被过滤成空数组、旧宿主），handler 须用 `selection[0]?.path ?? resolveTargetPath(args[0])` 兜底取目录路径，绝不能判 `selectionPaths(...).length === 0`——那是 06d94fa9 起的失效条件，让目录 revert 恒掉进逐文件分支静默无效果。多选混入目录项时并入 `plan.directories`（多目录经 `openedInTrees` 单条 `p4 opened <d1>/... <d2>/...` 批量预检）。`client.revertReconcile` 只作执行原语，不再有独立菜单/命令面板入口。
- **扫描范围**：`applyReconcileScope` → `resolveFocusScopeDirs`（`focusScope.ts` 纯函数）→ `client.setReconcileScope(dirs)`，聚焦目录（`workspace.focusEnabled`+`workspace.focusFolders`）非空时用聚焦目录，否则回退打开文件夹；范围外路径在 `_isInReconcileScope` 处过滤。

## Explorer 按需 hint 通道（`checkWorkingTree`）——未收集改动的行级徽标

未签出但磁盘偏离 depot 的文件在资源管理器文件行上显示**改动徽标**（M/A/D，与 git 状态字母一致）：一条**由 Explorer 当前渲染出来的文件行驱动**的按需查询通道——成本与可见行数同阶，与 depot 规模无关（绝不打开全量扫描，那正是「点击几分钟打不开 diff」的根因）。它与上节的常驻 reconcile 分组**并存**：分组是面板 / 文件夹染色 / 可操作性的完整真相，这条通道是行级改动徽标的按需发现。

链路：renderer `ScmWorkingTreeHintService`（pull 式，骨架照抄同目录 `ScmIgnoredResourcesService`：render 期问 → 150ms 去抖批量 → 缓存 + LRU 4096 → `version` observable 触发重渲染）→ capability 命令 `perforce.checkWorkingTree`（**运行时注册，绝不进 `contributes.commands`**，同头号坑）→ `client.checkWorkingTree(paths)` → 复用 `_rescanReconcilePaths` 的分批/并发/client 语法翻译。配置项 `perforce.reconcileHint.enabled`（默认开）可整体关掉。

**owner 仲裁必须按能力过滤**（`ScmService.ts` 的 `resolveScmProviderIdWhere`）：p4 workspace 内常有嵌套的独立 git provider（`git.repositoryScanMaxDepth` 命中的子目录）。裸最长前缀会让嵌套 git 胜出，而 git 侧从不注册 `checkWorkingTree` → `executeCommand` 返回 undefined → `_flush` 把整批路径当 clean 写进缓存，该行**再也不会重新入队**，症状就是「p4 确实有改动但 Explorer 永远不显示改动徽标」。所以最长前缀只在**注册了该能力**的 owner 里选（显式选中的 repo 仍优先，与既有语义一致）；无 capable owner 时**既不缓存也不入队**，这是能力晚注册（`checkWorkingTree` 在 `extension.ts` 注册，晚于 SourceControl 创建且不伴随 `sourceControls` 变更）能自愈的唯一原因——别为「省一次仲裁」把它改成写缓存。

四条决策，改这条通道前先对照：

- **本通道不写 SCM `resourceStates`**：`checkWorkingTree` / hint 服务只服务 Explorer 行，绝不写 `_reconcileGroup.resourceStates`——那是 `_applyDriftGroup()` 的专属职责（见上节）。但注意：`ScmDecorationsService` 确实会消费常驻 reconcile 组的 `resourceStates` 来给文件夹染色，二者靠**组**衔接，而非拆掉 hint 通道去喂装饰。
- **徽标从 `toReconcileResourceState` 派生**（`p4Decoration.ts` `toWorkingTreeHint`）：letter 复用该行的 `contextValue`——**git 对齐的动作字母加 `R` 前缀**（edit→`RM`、add→`RA`、delete→`RD`），与已签出行共用同一份 style 映射，保证徽标与行装饰观感一致。`R` 前缀是关键：字母改成与 git 相同的 M/A/D 后，`scmResourceState` 已无法区分「未收集」与「已签出」的同一动作，菜单门控改用组 id（`scmResourceGroup != reconcile`）；单测 `clientWorkingTreeHint.test.ts` 直接与 `toReconcileResourceState` 的返回值逐字段比对，改坏派生关系即红。
- **文件行出改动徽标；文件夹染色走 `ScmDecorationsService`，不靠本通道**：`ScmWorkingTreeHintService.getFolderHint` 现在只从 pull 通道已有缓存的文件 hint 聚合向上传播（删除红色 > 其余动作，同级按 source 键取小），作为**首轮扫描落地前的兜底下界**。权威的文件夹颜色是 `ScmDecorationsService`——它读常驻 reconcile 组 `resourceStates` 的整组替换（可回收），本通道不再有独立目录聚合表（旧的 `_scanFolders` / `onDidPublishWorkingTreeScan` 已删）——背景扫描一次 publish 上万条 hint 灌进按可见行数定容的 LRU 会自我抹除、还挤掉可见行刚查到的答案（根因教训）。仍是**已发现改动的下界**——未展开的子树查不到、保存/工作区切换也会让颜色增减，用户已确认接受该权衡；别为补全上界去做全量发现。
- **只读派生（最容易被"顺手优化"破坏）**：`checkWorkingTree` 绝不写任何共享状态、绝不持久化、绝不 `_emitChange()`。一旦有人想「既然都扫了不如存下来」，这条通道就退化成它要规避的全量发现。护栏 = store save spy + `onDidChange` 计数。

另两处易踩：hint 按两个谓词过滤（已 opened / scope 外），全被过滤掉则**零 p4 spawn**；返回值**回显调用方自己的路径字符串**（扫描报的是从 client 语法翻译来的路径，拼法未必与 host 一致，不回显会让 renderer 缓存键对不上，还会把没问过的路径——比如 rename 的另一半——报到不存在的行上）。

回显那张 map 的 key 必须是 `scopeKey` 而非 `norm`——它两侧**不同源**：请求方按用户打开目录的拼法给，答案按 `p4 info` 报的 clientRoot 拼，Windows/macOS 上两者可以只差大小写却指同一个文件（`norm` 只折盘符，会漏配 → hint 静默消失）。同一个方法里查 `_openedPaths` 仍用 `norm`，因为那个 set 的键与被比较的值同源（都由 p4 报）。`pathUtil.ts` 里 `scopeKey` 的注释就是这条判据的出处。路由用 `resolveContaining`（严格最长前缀）而非 `resolveClient`——后者的 active 回退是命令路由语义，数据查询用它会把不归任何 client 的路径扔给 active client 扫。

**⚠️ 根因 / 修法（在飞查询竞态）**：renderer 侧 `ScmWorkingTreeHintService` 的在飞标记必须带 per-request 令牌。曾经 `_inFlight` 是无身份的 `Set<string>`：p4 `reconcile -n` 往返 > 150ms 去抖时，同一 key 的两次查询必然重叠——保存文件触发的 `_onFileEvents` 删掉标记意在丢弃旧答案，但第二次 flush 又把它加了回来，于是先返回的旧（保存前）答案被接受写进缓存，后返回的正确答案反而被丢弃。后果是该文件被永久钉死成「干净」：缓存里有条目故不再重新入队，而 `_revalidate()` 只遍历 `_cache.keys()`，标记时还没进缓存的 key 漏标；`_generation` 只在 `_invalidate()` 里 bump 也救不了——症状与真正的「没有改动」完全无法区分。修法：`_inFlight: Map<string, number>` + 单调 `_queryToken`，`_writeHint` 只接受 token 匹配的答案（latest-wins），不匹配打一行 debug 日志；`getHint` 缓存 miss 分支加 `_inFlight.has(key)` 守卫，避免重渲染重复入队灌满 `ConcurrencyGate`。回归护栏在 `apps/editor/src/renderer/services/scm/__tests__/ScmWorkingTreeHintService.test.ts`（两个用例：「旧答案在重新查询已发出后才落地时被丢弃」「在飞期间不重复入队」）。

## Explorer 落后灰字（`checkBehind`）——可见行按需 fstat + 状态栏 chip 复用

「远端有更新 ↓」灰字与「他人占用 ✎」的驱动机制**不同**：✎ 由启动 `opened -a` 后台扫描推全量；↓ 由**可见行按需探测**驱动（旧实现是启动时全量 `sync -n` 扫描，已废弃）——renderer `ScmBehindHintService`（`apps/editor/src/renderer/services/scm/ScmBehindHintService.ts`，pull 式，与 `checkWorkingTree` 同款：渲染期问 → 150ms 去抖批量 → 缓存 + 在飞 token latest-wins）在 Explorer 文件行渲染时调 capability 命令 `perforce.checkBehind`（**运行时注册，绝不进 `contributes.commands`**，同头号坑）→ `client.checkBehind(paths)` 逐文件 fstat（`#have < #head` 即 behind）→ 返回 behind 子集给 host 停问，真正的 ↓ 装饰经 `setSupplementaryDecorations` **push**（`_publishSupplementaryDecorations` 单一收口）。行不渲染就不探测，成本与可见行数同阶、与 depot 规模无关。

三条红线：

- **checkBehind 走 background 优先级 + `CHECK_BEHIND_TIMEOUT_MS`（20s）紧超时**：滚 Explorer 被动触发的渲染路径突发，不是用户等结果的点击，绝不能占并发门静态预留的交互槽（见「共享 FIFO 并发门」节）。
- **behind/occupied 按路径合并成单一 marker**：renderer 按路径 key 装饰，两个独立条目会互相覆盖——合并收口在 `_publishSupplementaryDecorations`（`✎` + `↓` → 单一 `✎ ↓`，两半 tooltip 换行拼接，e2e merge journey 守护）。
- **状态栏 chip 复用**：`updateBehindFromFstat` 把状态栏 rev chip 已跑的 fstat 结果喂进 `_setBehindFromInfo`（chip 与可见行探针共用的单一漏斗），同一文件不跑第二次服务器查询。**sync 成功 → `_clearBehindDecorations()` + `_invalidateWorkspaceState()`**：装饰靠渲染触发 + push，sync 清掉 behind map 与 fstat 缓存后，下一次可见行渲染重新 fstat（have==head → 不再 behind）——fstat 短 TTL 只吸收重复读突发，不是 behind 判定的持久层。
