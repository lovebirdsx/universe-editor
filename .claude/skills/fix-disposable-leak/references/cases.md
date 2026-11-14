# 案例库（fix-disposable-leak）

> 单编号自包含：每条 = **信号**（判别特征，一行）+ 现象/根因 → 修法/复现 + 锚点。
> 通用机制、排查流程与易踩坑速记在 `../SKILL.md`；新经验按同样格式追加到本文件。
> 判据优先级：**能用「级联 dispose 断言」就不用 tracker**（见案例 2 末段）。

**案例 1 — `EditorGroupModel.openEditor` 早退丢弃已交出所有权的孤儿 input**
信号：泄漏报告出现「新 input 实例 + 其内部 `_store`」两条连续 idx、创建点是 `new XxxEditorInput`；触发路径含 `ReopenClosedEditorAction`（反序列化出仍开着 tab 的副本）或 `moveEditor` 目标组已有同 id 分屏克隆。
根因：`EditorGroupModel.openEditor` 命中同 id 的 `existing`（`findEditor` → `matches`）时**早退**，但调用方按约定已把新建的 `editor` 交出所有权——早退路径既不 add 进 `_editorStore` 也不 dispose，新实例 + 其 `_store` 双 Disposable 泄漏。`EditorService.openEditor` 自己的去重分支早就正确处理（`updateFrom` + dispose），绕过 service 直打 model/group 的路径没有保护。
修法：早退分支收敛为**单一真源** `if (editor !== existing) { existing.updateFrom?.(editor); editor.dispose() }`（`packages/platform/src/workbench/editorGroupModel.ts:218`）；`updateFrom` 吸收新内容的契约与对称写法见 `packages/platform/CLAUDE.md`「EditorInput.updateFrom 契约」。修完后 `EditorGroupsService.moveEditor` 里那句手写 `if (existing && existing !== editor) editor.dispose()` 变冗余，已删。
**e2e 抓不到**：`apps/editor/e2e/specs/smoke.reopenClosedEditor.spec.ts` 的流程是「先关 Settings 再 reopen」，reopen 时组内已无副本 → 结构上不走孤儿分支（无论修没修都绿）；且该 spec 全 `@regression`，本地 `pnpm e2e` 主趟会剥离它。定位靠单元级 `withLeakCheck`：`openEditor(a)` → `openEditor(同 resource 的 dup)` → `model.dispose()` 当场报 idx 连续两条。回归 `packages/platform/src/__tests__/workbench/editorGroupModel.test.ts` 两例——「disposes a duplicate-identity orphan」断言 `dup.isDisposed === true && a.isDisposed === false`、「updateFrom before disposing」断言先吸收再 dispose；移除修复行两例即挂。
判据：想复现「交出所有权后被丢弃」的孤儿泄漏，**用单元 leak 断言，别指望 e2e teardown gate**——重开的 tab 一直 rooted 开着，本就不是泄漏。

**案例 2 — reload 同步卸载：正确的 effect 订阅被误报（附「真泄漏」姊妹形态）**
信号：泄漏堆栈帧含 `reappearLayoutEffects` / `reconnectPassiveEffects`，泄漏对象是 `xxx.onDidChangeYyy(...)` 返回的订阅；**只在真实 dev reload 出现，vitest/happy-dom 复现不了**。
根因：renderer 的 `DisposableTracker`（dev/E2E 安装）在 `beforeunload` 里先 `reactRoot.unmount()` 再 `computeLeakingDisposables()`（`apps/editor/src/renderer/main.tsx`）。但 reload 这条**同步**卸载路径下，StrictMode 在 `reappearLayoutEffects` / `reconnectPassiveEffects` 阶段建的 effect 资源 cleanup **不会 flush**，于是被当成泄漏——即使 effect cleanup 写得完全正确。测试环境复现不了的原因：RTL 的 `act`/`unmount` 会 flush passive effect，真实 Electron 的 beforeunload 不会。
修法：用既有范式 `markAsSingleton(...)` 兜底（参考 `apps/editor/src/renderer/workbench/titlebar/useTitleBarMenus.ts:114` 的 `markAsSingleton(combinedDisposable(d1, d2))`；已这样修过 `useTreeModel.ts`、`Tree.tsx`、`scmShared.tsx` 的 useMenuRevision）。正常 unmount（切换 view）时 effect cleanup 仍真正 dispose；reload 时 renderer 即将销毁，不 dispose 并无真泄漏，`markAsSingleton` 只抑制误报。
**姊妹形态（真泄漏，别被上面的「误报」结论带偏）**：render 阶段 `new XxxDisposable()`（如 `useOwnedTreeModel` 里的 `create()`）在 StrictMode 双 render / 并发被丢弃时会产生**永不 dispose 的孤儿**。修法 = `useRef` 守卫让创建幂等 + 一个 `created` 集合在 unmount 时 dispose 全部（含被丢弃 render 的实例）；回归用**级联 dispose 断言**（直接断言 `model.isDisposed`），**不能走 tracker**——`markAsSingleton` 会让 tracker 失效，走它只会假绿。

**案例 3 — StrictMode 空跑 dispose 掉 `useRef` 持有的 Emitter（dev-only 失效）**
信号：只在 `pnpm dev` 复现；不依赖该 emitter 的路径正常、依赖它的失效；e2e（prod build）结构上复现不了。
`useRef` 初值只在首次保留，而 StrictMode（dev 对每个 effect 做 mount→cleanup→re-mount 空跑，prod no-op）让 cleanup 跑了一次：
```ts
const ref = useRef(new Emitter<void>())
useEffect(() => { const e = ref.current; return () => e.dispose() }, [])  // 空跑把 E1 dispose 了
```
re-mount 后 ref 仍指向**已 dispose 的 E1**，`.fire()` 落死对象，订阅方永不收到通知。好例 = 惰性创建且**不 dispose**（`useRef<Emitter<void> | null>(null)` + 首次赋值；emitter 无 OS 资源靠 GC，订阅方 dispose 自己的订阅），消费处一律 `ref.current?.fire()`（可空）。
通用教训：**`useRef(new X())` 持有的 disposable 绝不要在 effect cleanup 里 dispose**——要么惰性创建 + 不 dispose，要么用 `markAsSingleton` 兜底泄漏检测（案例 2）。
回归防护：单测 `apps/editor/src/renderer/workbench/agents/__tests__/ChatBody.test.tsx:2193` 的 `'still fires onDidChangeActive under StrictMode (dev double-invoke)'`。同型姐妹坑（cleanup 里**置位**的 ref 必须在 setup 里复位）见 `extensions/perforce/docs/graph.md`「这个闩必须在 effect 的 setup 里复位」。

**案例 4 — 普通 Map 持有的存活 Webview 面板缺失父链**
信号：PDF/Excel 预览功能断言通过，teardown 固定报告 `WebviewPanelModel` 及内部 store 两条连续 idx；面板仍开着，服务本身已在单例根下。
根因：面板从 React 卸载释放改为跟随 input 生命周期后，服务中的普通 Map 只保存引用、不建立 Disposable 父链。不能恢复 unmount 时 closePanel，否则跨组/跨窗口移动会销毁仍使用的面板。
修法：`_panels = this._register(new DisposableMap<number, WebviewPanelModel>())`；close/reset 用 `deleteAndDispose`，服务销毁走注册容器级联释放；reset 同时清理 input dispose 订阅。不改全局快照、不标记 panel 单例、不在 E2E 末尾补 closeAll 掩盖。
复现：对单例服务创建仍打开的 custom/host-created panel，两条 tracker 测试修前失败、修后通过；另测 service/input 销毁的级联释放。此处必须在服务存活时检查父链，仅测最终 dispose 抓不住遗漏。
锚：`apps/editor/src/renderer/services/extensions/WebviewService.ts` 与同目录 `__tests__/WebviewService.test.ts`；外部 PDF、Excel suite 各两项通过泄漏门禁。

**案例 5 — 主进程退出时在飞的「优雅回收宽限等待」订阅**
信号：主进程泄漏报告只有两条（或 2×N 条）连续 idx，堆栈是 `toDisposable ← ManagedChildProcess.onDidExit ← ProcessLifecycleRegistry._waitForExit ← reclaimOwner ← WindowMainService._reclaimWindowProcesses ← BrowserWindow 'closed'`；每对对应一个被回收的子进程。
根因：`_waitForExit` 在宽限期内订阅每个目标的 `onDidExit`，只在「全部退出」或「grace 定时器到期」时 dispose。窗口关闭后应用随即退出（最后一个窗口 → `window-all-closed` → `app.quit()`），`will-quit` 里 `ProcessLifecycleRegistry.dispose()` 只强杀 Job/进程组，**不收尾在飞等待**；定时器是 `unref` 的，`process.on('exit')` 快照前不会触发 → 订阅被判泄漏（即使目标进程已被杀，tracker 也只看订阅 disposable 是否 dispose）。
修法：registry 持有 `_pendingWaits: Set<() => void>`（每个等待的 `done`：清定时器 + 从集合移除 + dispose 订阅 + resolve，幂等），`dispose()` 开头同步调用全部 `finish()`。resolve 后 `reclaimOwner` 的续体会再跑一次 `_hardKill`，对已清空的 slot 是 no-op，安全。
回归：`packages/node-services/src/process/__tests__/processLifecycle.test.ts`「dispose settles the in-flight grace wait so its exit subscriptions are released」——FakeTarget 的 Emitter 用 `onDidAddListener`/`onWillRemoveListener` 计数，`reclaimOwner` 后断言 1、`dispose()` 后断言 0；移除 dispose 里的收尾循环即失败。属 SKILL.md 坑 10 的同族：**只靠异步事件/定时器释放的 disposable，退出路径必须补一条同步摘除**。

**案例 6 — 主进程退出时在飞的「端点发现」子 token 源（挂在父 token 上的订阅）**
信号：主进程泄漏报告只有一条（CTS 本身不是 `Disposable` 子类，被报的是它构造时挂在父 token 上的订阅），堆栈是 `toDisposable ← MutableToken._event ← new CancellationTokenSource ← AiModelRegistry._discover ← _resolveEntryUncached ← _resolveEntry ← getModels`；触发时机是模型列表拉取期间关窗退出。
根因：`_discover` 用 `new CancellationTokenSource(parentToken)` 给每次探测派生死线 token；CTS 构造时订阅父 token 的 `onCancellationRequested`，返回的 disposable 由 `_parentListener` 持有，只在 CTS `dispose()` 时释放。而该 CTS 仅在 `Promise.race` 结束的 `finally` 里 dispose。退出时父 CTS 被 cancel（`AiModelMainService.dispose` 的 `_metadataRequests` / `_inflight` 循环）只会让子 CTS `cancel()` 并触发 provider 的 abort，**不会释放子 CTS 挂在父 token 上的订阅**；`Emitter.dispose()` 只清 listener 列表、不 dispose 各订阅 disposable，所以 tracker 照报。子 CTS 自己的 `finally` 是微任务，晚于 `process.on('exit')` 快照。同域 `remoteCoordinator` / `_metadataRequests` 都是「集合 + dispose 时同步 cancel+dispose」，唯独这里漏了。
修法：registry 持 `_discoverySources: Set<CancellationTokenSource>`，建 source 即登记，`finally` 里先 `delete` 再 `dispose`（结束即摘除，避免集合累积）；`dispose()` 开头同步 `cancel()+dispose()` 全部在飞 source。退出链全同步可达：`will-quit → rootInstantiation.dispose() → AiModelMainService.dispose() → super.dispose() → registry.dispose()`。
回归：`packages/platform/src/__tests__/ai/aiModelRegistry.test.ts`「releases the parent-token subscription of a discovery still in flight」——自建 token 统计仍在册的 cancellation listener，`void reg.getModels(parent)`（发现同步启动）后断言 1、`reg.dispose()` 后断言 0；删掉 dispose 循环即失败（1 to be 0）。**计时陷阱**：测试必须用 `vi.useFakeTimers()` 且不要推进时间——若让 `_discover` 的 2.5s 死线在快照前触发，`finally` 会替 bug 收尾，测试反而变绿。
