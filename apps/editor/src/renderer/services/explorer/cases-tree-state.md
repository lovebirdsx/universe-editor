# cases-tree-state.md

本文从 CLAUDE.md 拆出，范围是 explorer 树状态的三块完整论证：展开状态持久化、剪贴板镜像与 `_setRoot` 竞态（易踩坑 11）、compact 折叠链成形。

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

补链只挂 `dataSource.loadChildren` / `refresh` / `_refreshLoadedNodes` 三处，**绝不下沉进 `_loadChildren`**（会闭环递归整棵树）。链因文件系统变化伸缩时靠 `_captureCompactAnchors`（重读**之前**）+ `_remapSelectionToCompact`（之后）把焦点迁到新行。

## watcher 冷启动延迟

递归监听是主进程 CPU 大头，冷启动时 root 展开已够首屏，watcher 推迟到 idle phase arm（`_watchStarted` / `_coldStartSettled` 双闸，见构造函数注释；`WorkspaceWatchContribution` 在 idle phase 调 `startWatching()`），避开与 renderer restore 抢 CPU。冷启动窗口期外部改动可能漏报，`startWatching`/`_refreshLoadedNodes` 会补一次全量重读——别把冷启动期的「没收到 watcher 事件」当 bug。
