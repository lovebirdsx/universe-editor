---
name: reload-disposable-leak-marksingleton
description: dev/E2E 下 React 组件拥有的订阅/disposable 在 reload(beforeunload)时被 DisposableTracker 误报，需用 markAsSingleton 兜底
metadata: 
  node_type: memory
  type: project
  originSessionId: 2c01cba2-8358-4546-a5a2-4b3ec47f5eab
---

本仓库 renderer 的 `DisposableTracker`（dev/E2E 安装）在 `beforeunload` 里先 `reactRoot.unmount()` 再 `computeLeakingDisposables()`（`apps/editor/src/renderer/main.tsx`）。但 reload 这个**同步**卸载路径下，React StrictMode 在 `reappearLayoutEffects` / `reconnectPassiveEffects` 阶段创建的 effect 资源（`useEffect`/`useLayoutEffect` 里的订阅）**cleanup 不会 flush**，于是被当成泄漏报告——即使代码的 effect cleanup 写得完全正确。

**判断要点**：泄漏堆栈帧含 `reappearLayoutEffects` / `reconnectPassiveEffects`、对象是 `xxx.onDidChangeYyy(...)` 返回的订阅，且只在真实 dev reload 出现、vitest/happy-dom 复现不了（测试环境 RTL `act`/`unmount` 会 flush passive，真实 Electron 的 beforeunload 不会）→ 基本就是这类「reload 误报」。

**How to apply**：用项目既有范式 `markAsSingleton(...)` 兜底（参考 `apps/editor/src/renderer/workbench/titlebar/useTitleBarMenus.ts:106` 的 `markAsSingleton(combinedDisposable(d1, d2))`）。正常 unmount（切换 view）effect cleanup 仍真正 dispose；reload 时 renderer 即将销毁，不 dispose 也无真泄漏，markAsSingleton 只抑制误报。已这样修过：`useTreeModel.ts`、`Tree.tsx`、`scmShared.tsx` 的 useMenuRevision。

另一类**真**泄漏：render 阶段 `new XxxDisposable()`（如 `useOwnedTreeModel` 里 `create()`）在 StrictMode 双 render/并发被丢弃时会产生永不 dispose 的孤儿。用 `useRef` 守卫让创建幂等，并用一个 `created` 集合在 unmount 时 dispose 全部（含被丢弃 render 的实例）。这类可用「级联 dispose 断言」做确定性回归测试（直接断言 `model.isDisposed`，不走 tracker，因为 markAsSingleton 会让 tracker 失效）。相关：[[e2e-relaunch-flake-windows]]。
