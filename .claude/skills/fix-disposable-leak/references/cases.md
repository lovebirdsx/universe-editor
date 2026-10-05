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
