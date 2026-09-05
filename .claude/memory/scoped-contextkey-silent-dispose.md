---
name: scoped-contextkey-silent-dispose
description: ScopedContextKeyService.dispose() 只清 key 不报错——菜单 when 全静默判 false；配上不稳定 props 身份（默认参数 `= []`）就从潜伏变成菜单整体消失
metadata:
  node_type: memory
  type: project
---

`ScopedContextKeyService.dispose()`（`packages/platform/src/command/contextKey.ts`）**只 `_keys.clear()`**：不抛错、不置 disposed 标志。dispose 之后 `get()` 静默透传父级，所有查不到的 key 判 `undefined`，菜单 `when` 全线判 false。**失效是无声的**——没有异常、没有日志，只是条目"不见了"。

**三方共谋的显形条件**（症状：SCM 行右键菜单弹出后按 ↓，整个菜单消失；dev-only，e2e/prod 跑 `out/` 不复现）：
1. dispose 静默清空（上）。
2. wrapper 用 naive `useMemo(createScoped) + useEffect(cleanup dispose)` → StrictMode 干跑提前清空（同 [[strictmode-useref-emitter-dispose-dev-only]]）。
3. `ContextMenu` 的 `args = []` **默认参数**每次函数体执行都是新数组 → `runCommand` useCallback 重建 → `rows` useMemo 重算 → ArrowDown 的内部 setState 一重渲染就对着已清空的 context 重解析 → `rows.length === 0` → `return null`。

只有 2 而没有 3 时菜单不会消失（其它 wrapper 从不重算 rows），**看起来没 bug 只是没触发**，不是反例。

**修法双保险**：① 稳定身份的哨兵常量（模块级 `const NO_ARGS: readonly unknown[] = []`）掐断无谓重算；② `apps/editor/src/renderer/workbench/useScopedContextKey.ts`——recreate-if-disposed 守卫 + overrides 浅比较（顺带取消"overrides 必须 memo"的隐性契约），已收口 5 处 wrapper（Scm/Explorer/Editor/EditorTab/Remote ContextMenu）。事件回调里命令式建、closeMenu 里 dispose 的（TimelineView / ExtensionTreeView）不经 React 生命周期，刻意不迁。

**通用教训**：静默失效的资源（dispose 后可读不报错）+ 会重算的消费方 = dev-only 幽灵 bug。写 React 里持有此类资源，一律走 recreate-if-disposed 守卫，别用裸 useMemo。

回归防护：单测 `scm/__tests__/ScmView.strictmode.test.tsx` 的 `'keeps the row context menu open when the arrow keys move through it'`（改前必红）+ `workbench/__tests__/useScopedContextKey.test.tsx`。
