---
name: strictmode-useref-emitter-dispose-dev-only
description: dev-only 失效根因——StrictMode 空跑在 effect cleanup 里 dispose 了 useRef 持有的 Emitter，re-mount 后 ref 仍指向死对象
metadata: 
  node_type: memory
  type: project
  originSessionId: 877bf397-b151-41ae-b0e7-1aba88c4e832
---

只在 `pnpm dev` 复现的 bug，先怀疑 React StrictMode（dev 对每个 effect 做 mount→cleanup→re-mount 空跑，prod 是 no-op）。

**坏例**（effect cleanup dispose `useRef` 持有的 disposable）：
```ts
const activeSlotRef = useRef(new Emitter<void>())
useEffect(() => {
  const emitter = activeSlotRef.current
  return () => emitter.dispose()   // StrictMode 空跑把 E1 dispose 了
}, [])
```
`useRef` 初值只在首次保留，re-mount 后 ref 仍指向**已 dispose 的 E1**，`.fire()` 落死对象，订阅方永不收到通知。

**好例**（惰性创建 + 不 dispose；emitter 无 OS 资源，GC 回收，订阅方 dispose 自己的订阅）：
```ts
const activeSlotRef = useRef<Emitter<void> | null>(null)
if (activeSlotRef.current === null) activeSlotRef.current = new Emitter<void>()
// 消费处一律 activeSlotRef.current?.fire()（可空）
```

**通用教训**：`useRef(new X())` 持有的 disposable，**绝不要在 effect cleanup 里 dispose**——要么惰性创建 + 不 dispose，要么用 `markAsSingleton` 兜底泄漏检测。佐证排查法：不依赖该 emitter 的路径 dev 下正常、依赖的失效，即可锁定。

回归防护：单测 `ChatBody.test.tsx` 的 `'still fires onDidChangeActive under StrictMode (dev double-invoke)'`；e2e 是 prod build 复现不了此 bug。

关联 [[reload-disposable-leak-marksingleton]]（同属 StrictMode/disposable 兜底坑）。
