---
name: quick-navigate-picker-contract
description: Ctrl+Tab / Alt+S 这类「按住修饰键、松开即选中」的 quick-navigate picker：契约是 {modifier, triggerKey}，宿主 keybinding 必须带 when: '!quickInputVisible'
metadata:
  node_type: memory
  type: project
---

「按住修饰键移动、松开即选中」的手势（VSCode quickNavigate 移植）由 `IQuickNavigateOptions` 描述，定义在 `packages/platform/src/workbench/quickInputService.ts`：`modifier: 'ctrl' | 'alt'`、`initialSelectionIndex`（开局高亮，用 `apps/editor/src/renderer/services/quickInput/quickNavigateSelection.ts` 的 `computeInitialSelectionIndex` 算「当前项的下一步」）、`triggerKey`（打开它的那个键：锁定态连点即逐行循环，Shift 反向）。面板侧全在 `packages/workbench-ui/src/feedback/quickInput/QuickInputPanel.tsx`：锁定 = 输入框只读 + 提示行，`document` 收到对应修饰键的 keyup 就 accept，Enter 才解锁交还过滤。消费者：Ctrl+Tab（`apps/editor/src/renderer/actions/editorActions.ts`）、Alt+S / Alt+Shift+S（`apps/editor/src/renderer/actions/agentSessionActions.ts`）。

**坑 1（必须）**：宿主 keybinding 要带 `when: '!quickInputVisible'`。面板可见期若键位仍解析，全局键盘 handler 的 quickInputVisible 分支会 `preventDefault + stopPropagation` 且只放行 Escape —— 重复按键到不了面板，连点循环失效。**但 `when` 管不到「面板还没挂上」那段**：`pick()` 之前若还有 IPC（Alt+S 的 `getAllSessions()` 要 fan-out 到所有窗口），此时 `quickInputVisible` 仍是 false，连点会重入命令，第二次 `pick()` 覆盖 `_currentOnHide`（单槽）→ 上一个 Promise 永远 pending。这段要靠宿主自己的 in-flight 标志挡（`runSwitchSession` 已挡）。

**坑 2**：quickNavigate 模式下 `activeItemId` 是**惰性**的——面板 activeItems 的 focus effect 首行 `|| quickNavigate` 直接返回，高亮只认 `initialSelectionIndex`。所以别妄想把「当前项」同时传成 `activeItemId` 来额外高亮，它只会变成一句死描述；当前项的用处只是给下标当锚点。

**验证姿势**：这类手势只有真实按键 e2e 守得住（`apps/editor/e2e/specs/smoke.sessionSwitcherQuickNavigate.spec.ts`）；面板侧由 `packages/workbench-ui/src/__tests__/QuickInput.test.tsx` 的 `quick navigate locked mode` describe 覆盖。
