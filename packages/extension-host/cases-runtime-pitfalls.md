# cases-runtime-pitfalls

> 本文从 `CLAUDE.md` 拆出，范围是：extension host 运行时若干坑的**完整叙事与成因**——命令路由账本、treeKill 回收链、workspace 切换屏障、reload 回收、teardown 清全局能力、wire 尾参 undefined、远程 $mid URI 互译。CLAUDE.md 只留一句话结论；要理解「为什么」或复现排查再看本文。

## 命令路由账本 `_commandOwner: Map<id, HostConnection>`

runtime 命令由连接自带的 `MainThreadCommands` 闭包自己的 extHost proxy，天然正确。但**静态贡献命令**（manifest 声明的命令）的 bootstrap proxy 调的是 client service 的 `executeContributedCommand`，不闭包任何连接——所以需要账本：`_fetchAndIndex` 记账 + `MainThreadCommands` 的 ledger 回调。单 host 下账本仍保留：重启窗口期旧连接的命令要随 teardown 清掉，否则指向已死的连接。

## treeKill 是 backstop 不是主路径

host fork 出 grandchild（typescript 插件 → tsserver）。优雅停链路：`stop` 关 stdin / `stopAll` before-quit / renderer `beforeunload`，让 CLI 自己的 exit hook 回收 tsserver。**treeKill 只做 backstop**：硬 SIGKILL 会甩掉慢启动的 tsserver 成孤儿——卡 Playwright teardown、给真实用户留 stray electron.exe。改 host 退出路径务必保留优雅停链。详见 memory [[agent-binary-silent-download-e2e-fix]]。

## workspace 切换必须 await in-flight start（`_repin` 屏障）

host 启动时 pin workspace 根，切换需重启。**必须先 `await Promise.allSettled([_starting])`**——swap 可能撞上初始 boot 还在 spawn（Windows CI 更慢），此时 `this._conn` 还没赋值，直接读会丢掉 swap，host 永远 pin 在空 workspace（git 看不到 rootPath 不注册 SCM）。`_repinning` promise 同步武装（首个 await 前），让同一事件回合里的命令走 `_whenReady` 阻塞到重 pin 完成。

## reload 回收：`beforeunload` 同步 stop

window reload 销毁 renderer 但不 dispose service（async dispose 不跑），故 `beforeunload` 同步 `host.stop(handle)`——否则每次 reload 都孤儿一个重型 host（自带 tsserver），e2e 全套跑下来堆积饿死后续 spawn。

## teardown 无条件清全局能力（单 host 下是对的）

`_teardownConnection` 里 `resetSourceControls()` + `timeline.reset()` + `treeViews.reset()` + `webview.reset(kind)` 无条件调——单 host 只有这一个连接，teardown 时清全局状态不会误伤其它 tier（双 host 时代会误伤，现在正确）。临终 host 的 `$unregisterSourceControl` fire-and-forget 消息可能随 IPC 关闭丢失，必须主动清，否则视图残留上一 workspace 的 provider。

## 可选 wire 尾参的 undefined 已在 RPC 层根治

`ProxyChannel.toService` 序列化前剥掉参数数组尾部的 `undefined`，远端 `param === undefined` 判定可靠，无需调用端省略/接收端 `!= null` 双保险。残余约定只剩中段参数：`undefined` 夹在实参中间仍按 JSON 数组语义变 `null`，中段可选参数必须声明 `| null`（如 `$findFiles` 的 exclude/maxResults）并用 `== null` 判定。

## 远程 host 的 $mid URI 会被 codec 互译

远程模式下 host 进程自带 `createJsonCodec(createRemoteURITransformer(authority))`（`bootstrap.ts`），带 `$mid:1` 的 URI 出线 `file:`→`remote-ssh://<authority>/…`、入线反向。renderer 的 MainThread* 若对 host 来的 URI 做 `scheme === 'file'` 判断，远程下必失效（曾致 `MainThreadFileEvents` 拒收 watcher interest base，git 扩展收不到文件事件、SCM 不自动刷新）——workspace URI 空间判断要同时接受 `file:` 与 `REMOTE_SCHEME`；反向发往 host 的 `$mid` URI 无需手动翻译，codec 会转回 host 本地 `file:`。注意裸字符串路径（LSP wire、SCM fsPath 字段）不带 `$mid`，codec 看不见，仍走 `parseWireUri`/`fsPathToWorkspaceUri` 手动互译。
