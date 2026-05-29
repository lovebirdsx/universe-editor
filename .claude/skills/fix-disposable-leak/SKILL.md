---
name: fix-disposable-leak
description: 诊断并修复本仓库（VSCode 范式内核）的 Disposable 内存泄漏。当用户提到“内存泄漏 / memory leak / 未释放的 Disposable / Disposable leak(s) detected / DisposableTracker 报告了泄漏”，或贴出带 `trackDisposable` / `lifecycle.ts` / `computeLeakingDisposables` 的泄漏堆栈时使用。聚焦通用排查与修复流程；具体哪个类泄漏由 agent 当场判断。
version: 1.0.0
---

# 修复 Disposable 内存泄漏

本仓库用基于父子链的 `DisposableTracker` 检测泄漏。修复套路高度一致：**找到泄漏对象的创建点 → 确认它没被挂到正确的父节点 → 用 `_register` / `DisposableStore.add` / React cleanup 把它挂上 → 加回归测试 → 验证**。具体是哪个类、哪条业务路径泄漏，由你读代码当场判断。

## 检测机制（必须先理解，否则会误判）

源码：`packages/platform/src/base/lifecycle.ts`。

- **`Disposable` 基类构造时会创建一个内部 `_store: DisposableStore`**，并把 `_store` 设为自身的子节点。所以**一个泄漏的 Disposable 通常会报成两条**：一条是 `new DisposableStore`（在 `new Disposable` 里），一条是 `new Disposable` 本身，且两者 `idx` 连续。看到连续 idx 的这对，按**同一个对象**处理。
- **判定“未泄漏”的唯一条件**：该对象已被 `dispose()`，**或**它的根祖先被 `markAsSingleton` 标记。
- **父子链只由 `DisposableStore.add(o)` / `this._register(o)` 建立**（内部调 `setParentOfDisposable`）。⚠️ **闭包里引用一个 disposable 不会建立父链** —— 仅仅 `() => foo.dispose()` 持有引用，`foo` 的根仍是它自己，照样会被上报。要消除泄漏，**必须真正 `_register` / `add`**。
- 渲染进程 tracker 在 **DEV / E2E** 安装：`apps/editor/src/renderer/main.tsx`。所有根服务挂在单例 `workbenchStore = markAsSingleton(new DisposableStore())` 下，因此根服务即使不显式 dispose 也不会被报。
- 报告时机：`beforeunload` 里**先 `reactRoot.unmount()` 再 `computeLeakingDisposables()`**。意味着 React `useEffect` 的 cleanup 已经跑过——**正常的 React 订阅不会是元凶**；元凶是没挂上父链、或挂错地方的对象。
- 主进程也有 tracker（`apps/editor/src/main/index.ts`，`process.on('exit')` 时报告）。

## 排查流程

### 1. 解析泄漏报告
- 每条泄漏有 `idx`（创建序号）和创建堆栈。**自底向上读堆栈**：最靠近业务的那一帧（`new XxxService` / `new XxxSession` / `someService.onDidChangeXxx`）就是拥有者/创建点。
- 连续 idx + 同一构造点 = 同一对象的 Disposable/`_store` 对，合并看。
- idx 相差很大 = 不同事件、可能是**互相独立**的泄漏，分别处理，不要强行归因到一起。
- **核对路径与版本**：堆栈里的绝对路径和行号必须对得上当前工作目录。本仓库常有并行 checkout（如 `universe-editor` vs `universe-editorN`），`lifecycle.ts` 行号不同就说明**代码版本不同**，先和用户确认改哪一份，否则改了不生效。
- 堆栈被截断（结尾像 `(h`）无法定位时，**找用户要完整堆栈**，不要瞎猜。

### 2. 定位创建点（用 Explore / Grep 并行扫）
- 用堆栈帧里的类名/事件名，Grep 出**该构造函数或该事件的所有调用点**。
- **横向对比**：同一类对象往往有多条创建路径，其中一条正确 `_register` 了、另一条漏了——漏的那条就是 bug。（本次案例：`resumeSession()` 调了 `this._register(session)`，`createSession()` 漏了。）
- 确认拥有者本身是否挂在单例/被释放的父链上；如果拥有者没事，问题就在“拥有者→泄漏对象”这一环没建链。

### 3. 应用最小且一致的修复
按泄漏对象类型选手段：
- **某个 `Disposable` 子类实例**（service / view-model / session）→ 在其拥有者里 `this._register(theInstance)`，**对齐同文件里已正确的兄弟路径**。
- **事件订阅**（`xxx.onDidChangeYyy(listener)` 返回的 disposable）→ 用 `this._register(...)` 包住；若在 React 里则 `useEffect` 返回 `() => d.dispose()`。
- **`toDisposable(fn)` / 定时器 / 监听器** → 同样 `_register` / `add`。
- ⚠️ 再次强调：**别用闭包“假装”释放**。必须真正进父链或显式 `dispose()`。
- 本仓库处于开发期、无需向后兼容；优先“最小、与既有范式一致”的改法。若发现累积型隐患（如 close 后仍被 `_store` 持有直到服务销毁），可指出但默认不顺手大重构，除非用户要。

### 4. 加回归测试
测试位于 `src/**/__tests__/*.test.ts(x)`。两种写法：
- **直接断言级联释放**（推荐，确定性强）：构造拥有者 → 触发创建 → `owner.dispose()` → 断言子资源被释放（如底层连接 `disposed === true` / 状态变 `closed`）。本次即给 fake 连接加 `disposed` 标记，断言 `svc.dispose()` 后 `conn.disposed === true`。
- **用泄漏断言助手**：`packages/platform/src/__tests__/_helpers/leakAssert.ts` 的 `withLeakCheck(fn)` 或 `useLeakCheck()`，包住“创建→dispose”，自动断言无泄漏。注意它用全局 tracker，测试里 new 出来但没被拥有者接管的桩对象（history/storage 等）自身也会被算泄漏，必要时在用例内一并 dispose 或换用“级联释放”写法。
- 写完**先验证测试能抓住 bug**：移除修复行应当让新测试失败。

### 5. 验证
```bash
# 跑改动涉及的测试文件（按需替换路径）
pnpm --filter @universe-editor/editor exec vitest run --project renderer <test-file>
# 或平台包：pnpm --filter @universe-editor/platform test

pnpm --filter @universe-editor/editor typecheck
pnpm --filter @universe-editor/editor lint
# 提交前可跑全量：pnpm check
```
手动验证：`pnpm --filter @universe-editor/editor dev` 复现操作 → 关窗/Restart Editor → 看 dev console 不再打印对应 `Disposable leak(s) detected`。E2E 冒烟见 `apps/editor/e2e/specs/smoke.disposableLeak.spec.ts`。

## 关键参考路径
- `packages/platform/src/base/lifecycle.ts` —— `DisposableTracker` / `computeLeakingDisposables` / `Disposable` / `DisposableStore` / `toDisposable` / `markAsSingleton` / `setDisposableTracker`
- `apps/editor/src/renderer/main.tsx` —— tracker 安装（DEV/E2E）、`workbenchStore` 单例根、`beforeunload` 报告
- `apps/editor/src/main/index.ts` —— 主进程 tracker
- `packages/platform/src/__tests__/_helpers/leakAssert.ts` —— `withLeakCheck` / `useLeakCheck`
- `apps/editor/e2e/specs/smoke.disposableLeak.spec.ts` —— E2E 泄漏冒烟

## 易踩坑速记
1. 一个泄漏报两条（对象 + 其 `_store`），idx 连续，别当成两个 bug。
2. 闭包引用 ≠ 建立父链，消不掉泄漏。
3. React 订阅不是元凶（报告前已 unmount）；盯没进父链的对象。
4. 根服务在单例下不被报——所以“没被报”不代表“被释放”。
5. 堆栈路径/行号要对上当前 checkout，否则在改一份没运行的代码。
6. 横向对比同类创建路径，漏 `_register` 的那条就是 bug。
