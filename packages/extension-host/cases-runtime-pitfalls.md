# cases-runtime-pitfalls

> 本文从 `CLAUDE.md` 拆出，范围是：extension host 运行时若干坑的**完整叙事与成因**——命令路由账本、treeKill 回收链、workspace 切换屏障、reload 回收、teardown 清全局能力、wire 尾参 undefined、远程 $mid URI 互译，以及文档镜像与激活时序（getActiveTextEditor 死锁、open 补发、冷启动语言竞态、unhandled rejection 上浮）、事件推送两护栏与兴趣 lease 的 dispose 语义、findFiles 额度消耗顺序、manifest NLS 的 locale 链、扩展目录双通道隔离。CLAUDE.md 只留一句话结论；要理解「为什么」或复现排查再看本文。

## 命令路由账本 `_commandOwner: Map<id, HostConnection>`

runtime 命令由连接自带的 `MainThreadCommands` 闭包自己的 extHost proxy，天然正确。但**静态贡献命令**（manifest 声明的命令）的 bootstrap proxy 调的是 client service 的 `executeContributedCommand`，不闭包任何连接——所以需要账本：`_fetchAndIndex` 记账 + `MainThreadCommands` 的 ledger 回调。单 host 下账本仍保留：重启窗口期旧连接的命令要随 teardown 清掉，否则指向已死的连接。

## treeKill 是 backstop 不是主路径

host fork 出 grandchild（typescript 插件 → tsserver）。优雅停链路：`stop` 关 stdin / `stopAll` before-quit / renderer `beforeunload`，让 CLI 自己的 exit hook 回收 tsserver。**treeKill 只做 backstop**：硬 SIGKILL 会甩掉慢启动的 tsserver 成孤儿——卡 Playwright teardown、给真实用户留 stray electron.exe。改 host 退出路径务必保留优雅停链。

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

## 字符串流式切帧必须带「扫描游标 + 分片累积器」

`stdioProtocol.ts` 的 `StdioFramingProtocol` 按换行分帧，帧可以有几 MB（ACP 回放的 base64 图片按 ~64KB 分片到达）。`buffer += chunk` 之后每片都从 0 开始 `indexOf('\n')` 会在长帧上退化成 **O(n²)**：15MB 帧、64KB 分片实测 820ms → 加游标后 6ms（`packages/extensions-common/src/protocol/stdioProtocol.ts:39-41` 的注释即此）。同一手法在 `acpProtocolTracer.ts` 的 `LineBuffer.scan` 与 `MAX_TRACE_LINE`（超长行停止缓冲、绝不再 JSON.parse）里复用。任何「字符串流 + 分帧」的新代码照此实现，别写 from-zero 的重复扫描。

## 文档镜像：openTextDocument 走模型级同步

`workspace.openTextDocument` 不新建链路：`MonacoModelRegistry.acquire` + `DocumentMirrorTracking` 挂进 `DocumentSyncContribution`（`apps/editor/src/renderer/contributions/DocumentSyncContribution.ts`）管线，与编辑器打开的文档在 host 端同构；ref **有意驻留不释放**。untitled 也进镜像。save-as 语义 = close(untitled) → open(file) → didSave(file)，`didSave` 经 whenOpened 门控保证排在镜像 open 之后。

## 事件推送两护栏（洪泛前科）

① **兴趣订阅**：首个监听者 `$subscribe`、末个退订，**无监听零 RPC**（文件事件/诊断/树视图同模式）；② **防抖合并**：诊断 50ms、可见编辑器 microtask。**加推送类通道必须照此办**——租约实现在 `packages/extension-host/src/interestGate.ts`。

## 引用计数型资源的 dispose 不能走「释放一次」路径

`InterestGate`（`packages/extension-host/src/interestGate.ts`）的 lease `count > 1` 时，`dispose()` 若走 `release()` 会漏发 unsubscribe；dispose 语义必须是「**每个唯一 key 全量直发一次 + 清表**」。

## cap / 截断额度必须在过滤之后消耗

`FIND_FILES_ENUMERATION_CAP`（`apps/editor/src/renderer/services/extensions/MainThreadFs.ts`）原先在 renderer 后过滤**之前**扣，被排除目录吃光额度后真命中被静默截断、还报误导 warn。凡「先枚举再过滤 + 有上限」的管线都要查这一点。

## fire-and-forget RPC 的 reject 会变 unhandledRejection

单 host 内 fire-and-forget 消息的 reject 会变成 unhandledRejection；同步 API（如 `window.createWebviewPanel`）**无法用 reject 表达失败**——改用排队回放。

## getActiveTextEditor 防死锁

根因：`DocumentSyncContribution._openDoc` 把文档镜像推送排在 `await activateByEvent` **之后**，于是在 `activate()` 里等镜像必死锁。修法：`ExtensionActivationService.isActivating`（`packages/extension-host/src/activationService.ts`）为真时立即 resolve undefined + 日志；非激活期等待缩到 2s（`GET_ACTIVE_EDITOR_DOC_WAIT_MS`，`packages/extension-host/src/extensionService.ts`）。原则：**API getter 永不无限挂起，挂起比报错难诊断一个量级**。

## onDidOpenTextDocument 订阅时补发

`ExtHostDocuments.onDidOpenWithBackfill`（`packages/extension-host/src/hostDocuments.ts`）在新 listener 的微任务内补发订阅时已镜像的文档，**exactly-once**（快照成员被 close / 语言重开替换则跳过，live 事件已送达）——消灭「激活后轮询首文档」样板。

## 冷启动语言竞态

编辑器恢复（createModel + languageForResource）先于 `contributes.languages` 翻译 → 纯贡献关联落 plaintext 且镜像带错语言。修法：`ModelLanguageResyncContribution`（`apps/editor/src/renderer/contributions/ModelLanguageResyncContribution.ts`）订阅 `LanguageRegistry.onDidChangeLanguages`，微任务后只对 plaintext 模型重解析升级（先自愈 register 未知 id，防 monaco 静默回退）。

## unhandled rejection 上浮

host `$onUnhandledRejection` 经 `IMainThreadExtensions` 推 renderer——dev 弹通知，e2e 经探针 `getExtHostUnhandledRejections` + harness teardown 门（与 `expectNoLeaks` 同位）判失败。**测试全绿 ≠ 无运行时错误。**

## 语言可变 ⇒ 依赖语言的条件键要跟着订

`editorLangId` context key 补订 `FileEditorInput.onDidChangeLanguage`（setTextDocumentLanguage 链路的下游）；另扩展 OutputChannel 行首由 `MainThreadOutput` per-handle 状态机加 `[HH:mm:ss.SSS]` 时间戳。

## manifest NLS 的 locale 传递链（排查「本地化没生效」第一站）

renderer `getCurrentLocale()` → `ExtHostStartSpec.locale` → `extensionHostMainService` 写 env `UNIVERSE_DISPLAY_LOCALE` → `bootstrap.ts` 读 env 传给 scanner。机制本体：manifest 写 `%key%` + 扩展根 `package.nls.json`（英文默认必备）/ `package.nls.<locale>.json`，`packages/extension-host/src/nls.ts` 的 `loadNlsBundle` / `localizeManifest` 深度遍历替换整串（非整串或缺 key 原样保留 → miss 可见）。**两个消费方必须同步**：host scanner（激活贡献点）与 main 列表侧（`packages/node-services/src/extensions/nls.ts` 的复制实现，header 注明 Keep the two in sync），后者 locale 用 main `getCurrentLocale()`。

## 两个扩展目录通道不合并

`UNIVERSE_USER_EXTENSIONS_DIR`（e2e **替换**语义，`apps/editor/src/main/services/extensionHost/userExtensionsDir.ts`）与 `--extension-development-path`（**附加**语义）两通道**不合并**——合并会改变 e2e 的隔离前提。

## 测试侧坑：gate 住 activate 的测试扩展

release 钩子在异步 import 完成后才挂上 globalThis——可选调用 `?.()` 会静默 no-op、让 `await activating` 永挂，须先 poll 钩子就位。
