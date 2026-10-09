# cases-tree-state.md

本文从 CLAUDE.md 拆出，范围是 explorer 树状态的四块完整论证：展开状态持久化、剪贴板镜像与 `_setRoot` 竞态（易踩坑 11）、compact 折叠链成形、目录读取调度与慢目录归因。

## 展开状态持久化（仿 SCM scmTreeState）

`_setRoot` 仍 `_nodes.clear()` + `_model.reset()`，但随后 `_restoreExpansion` 从 WORKSPACE 存储（key `explorer/treeState/<root>`，实现见 `explorerTreeState.ts`）按深度升序重放展开集合并自愈剔除失效目录；选择/焦点/滚动仍丢弃。`explorerTreeState.ts` 防抖写 + `_setRoot` 回灌 + `onDidChangeWorkspaceScope` 兜底，focusEnabled 开/关都生效。要新增「记住别的树状态」得扩展同一套机制，别以为全部无持久化。唯一例外是剪贴板——它是 shared 镜像不是树状态（见下）。

## 剪贴板镜像与 `_setRoot` 竞态（易踩坑 11 完整故事）

剪贴板权威在 main 侧 `IFileClipboardService`（main 内存 + OS 剪贴板，跨窗口共享、快照可带远端 URI）。renderer 侧：

- `ExplorerClipboardContextContribution` 订阅 shared `onDidChangeClipboard`（ProxyChannel 广播**含发起窗口**）→ `tree.adoptClipboard` 回灌本地状态 + 同步 context key，构造时还会 `readResources` 一次做启动快照初始化（renderer reload 后 cut 变暗与 context key 不丢）。
- **事件方向严格单向**：`adoptClipboard` 只进不出；回写 shared 只有「清空」方向，且只在剪贴板内容真的失效时——`tree.clearClipboard`（cut 项被 rename/delete/move）、CancelCut、paste-move 成功后的直接 `clear()`。
- `clearClipboard` 的空态早退让它对已空镜像幂等（不多打一次 IPC）。

**`_setRoot` 不许清剪贴板**（已修，勿回退）。在 `_setRoot` 清会踩两个坑：

1. **冷启动竞态**——`IWorkspaceService` hydration 会在启动快照 adopt 之后再推一次 root（对象标识比对，同一 workspace 也 refire），把 main 快照清掉；
2. **窗口 B 切文件夹会摧毁窗口 A 待粘贴的 cut 状态**。

切根后不会残留错误变暗：`isCut` 比对 URI，旧根下的项匹配不到新根任何一行。

## compact 折叠链成形（`_compactChainReady`）

压缩行的 id 是**链尾**，晚成形会让行 id 变化并静默丢焦点。所以链的成形时机由 `_compactChainReady` 守：`getChildren` 发现某子目录的链只缓存了一半就返回 `null`，让 `TreeModel.expand` 把它路由回 `loadChildren` 补链。

补链只挂 `dataSource.loadChildren` 和刷新共用的 `_reloadNodes`，**绝不下沉进 `_loadChildren`**（会闭环递归整棵树）。链因文件系统变化伸缩时靠 `_captureCompactAnchors`（重读**之前**）+ `_remapSelectionToCompact`（之后）把焦点迁到新行。

## watcher 冷启动延迟

递归监听是主进程 CPU 大头，冷启动时 root 展开已够首屏，watcher 推迟到 idle phase arm（`_watchStarted` / `_coldStartSettled` 双闸，见构造函数注释；`WorkspaceWatchContribution` 在 idle phase 调 `startWatching()`），避开与 renderer restore 抢 CPU。冷启动窗口期外部改动可能漏报，`startWatching`/`_refreshLoadedNodes` 会补一次全量重读——别把冷启动期的「没收到 watcher 事件」当 bug。

## 目录读取调度（pending / trailing / 代际）

展开、compact 预取、刷新、watcher、exclude/focus 重读**共用每节点一个在途读取**（`_scheduleLoad` → `_drainLoads` 的 do/while）。刷新不再另起一次并发 `list`，而是给在途读取打 `trailing` 标记，由循环再做一轮；两轮之间的多次刷新合并成一次，**尾读期间**再来的变化又赢得下一轮——没有事件会被吞掉。这里的坑是 `node.pending` 的清空时机：必须在循环退出的**同一个同步时刻**（`finally` 里）清，放到后一个微任务里，落在「promise 已解决但 pending 还在」窗口的刷新就会挂到一个已经停下的循环上被静默丢弃。

`_generation`（`_setRoot` / `dispose()` 递增）守所有跨 await 路径：`_loadChildren` 写回前要 `generation` 未变且 `_nodes.get(key) === node`（同一节点对象），compact 预取每步前后也要重查。否则旧根的读取结果会写回、`_ensureNode` 会把旧根目录重新建进新树。drain 的 do/while 条件也复用同一 liveness 判定——尾读（trailing）不会为已换根 / 已销毁的节点再发一次 `list`。可观测到的一半是 `dispose()`（`_nodes` 不清，旧读取会写进去）；根切换那一半是防御性的——`_nodes.clear()` 已经让旧节点脱钩，读起来只是白做。

## 大目录处理（排序热点与慢目录归因）

目录项处理在 `explorerEntries.ts`（`selectDirectoryEntries` / `sortDirectoryEntries` / `processDirectoryEntries`）：

- **过滤在 URI 构造与排序之前**。exclude/focus 走的是「父目录相对路径 + 名字」拼出的相对路径，等价于 `relativeTo(root, parent/name)`——**不引入新的路径身份归一**。否则一个被排除的大目录仍要为每条目 `joinPath` 并参与排序。
- **模块级复用一个 `Intl.Collator`**。逐次 `name.localeCompare(other, undefined, opts)` 会为**每次比较**构造 collator：19 万条真实感文件名实测排序+构造 7.8s，换成复用 collator 后整段（过滤+构造+排序）0.5s。排序语义、比较选项、稳定顺序都没变（`sort` 稳定，collator 分不开的大小写差异保持目录原序）。
- **超过 `ENTRY_CHUNK_SIZE`(5000) 才分片**：线性段（19 万条约 100ms）按 `yieldToMain` 切开，小目录不受影响；排序仍是单次（部分排序的结果还要再排一遍，而 collator 正是排序里贵的部分）。
- 慢/超大目录写三条相位（`pushPerfPhaseSample`）+ 一行 warn，只含目录 URI / 原始与可见条数 / source（expand|compact|refresh）/ 三段耗时，**不含文件名**：`explorer.listReadWall (source, ipc, not cpu)`（IPC 等待）、`explorer.processWall (source, awaits, not cpu)`（过滤+构造+排序，含分片 yield）、`explorer.sortEntries (source, sync)`（未分片的同步排序，单独记录真实起止；线性分片内也有同步处理）。墙钟相位都不是 CPU，别再当同步处理归因。
