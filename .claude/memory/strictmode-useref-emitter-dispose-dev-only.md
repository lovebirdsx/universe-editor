---
name: strictmode-useref-emitter-dispose-dev-only
description: dev-only 失效根因——StrictMode 空跑在 effect cleanup 里 dispose 了 useRef 持有的 Emitter，re-mount 后 ref 仍指向死对象
metadata: 
  node_type: memory
  type: project
  originSessionId: 877bf397-b151-41ae-b0e7-1aba88c4e832
---

session outline 高亮不跟随键盘移动的 bug，**只在 `pnpm dev` 复现，production/e2e 正常**——唯一差异是 React StrictMode（`main.tsx` 把 app 包在 `<StrictMode>`，dev 下对每个 effect 做 mount→cleanup→re-mount 空跑暴露副作用，prod 是 no-op）。

**根因**：ChatBody 原代码在 effect cleanup 里 dispose 一个 `useRef` 持有的 Emitter：
```ts
const activeSlotRef = useRef(new Emitter<void>())
useEffect(() => {
  const emitter = activeSlotRef.current
  return () => emitter.dispose()   // StrictMode 空跑把 E1 dispose 了
}, [])
```
StrictMode 空跑：mount 捕获 E1 → cleanup `E1.dispose()` → re-mount。但 `useRef` 初值只在首次保留，re-mount 时 `activeSlotRef.current` 仍是**已 dispose 的 E1**。此后 `.fire()` 落在死 emitter → 订阅方永不收到通知。

**佐证**：不依赖 emitter 的路径（点击、回车跳转走 `getActiveKey()`/`scrollToKey`）dev 下正常，只有 `.fire()` 触发的高亮跟随失效——与「回车能跳、之后 Alt 键高亮不动」现象吻合。

**修法**：惰性创建 + 不在 cleanup 里 dispose（emitter 无 OS 资源，GC 可回收；订阅方 detach 时 dispose 自己的订阅）：
```ts
const activeSlotRef = useRef<Emitter<void> | null>(null)
if (activeSlotRef.current === null) activeSlotRef.current = new Emitter<void>()
// 消费处一律 activeSlotRef.current?.fire()（可空）
```

**通用教训**：`useRef(new X())` 持有的 disposable，**绝不要在 effect cleanup 里 dispose**——StrictMode 会把它 dispose 掉而 ref 不会重建。要么惰性创建 + 不 dispose（GC 回收），要么用 `markAsSingleton` 兜底泄漏检测。

回归防护靠单测 `ChatBody.test.tsx` 的 `'still fires onDidChangeActive under StrictMode (dev double-invoke)'`（用 `<StrictMode>` 包裹 render，修复前 fires=0）；e2e 是 prod build 复现不了此 bug，只防同步链路整体回归。

关联 [[reload-disposable-leak-marksingleton]]（同属 StrictMode/disposable 兜底坑）。
