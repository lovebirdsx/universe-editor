# Quick-navigate picker：按住修饰键、松开即选中

`Ctrl+Tab`（切换编辑器）与 `Alt+S` / `Alt+Shift+S`（切换 agent 会话）共用一个移植自 VSCode quickNavigate 的手势：**面板打开时修饰键仍按住**——按住期间连点触发键逐行循环，**松开修饰键即选中当前行**，Enter 则退回成普通的可过滤 picker。

## 契约：`IQuickNavigateOptions`

定义在 `packages/platform/src/workbench/quickInputService.ts`：

| 字段 | 语义 |
|---|---|
| `modifier: 'ctrl' \| 'alt'` | 锁定手势所用的修饰键 |
| `triggerKey?: string` | 打开它的那个键（小写）。锁定态下**连点**即逐行循环，`Shift` 反向 |
| `initialSelectionIndex?: number` | 开局高亮行。用 `apps/editor/src/renderer/services/quickInput/quickNavigateSelection.ts` 的 `computeInitialSelectionIndex(items, currentId, reverse)` 算「当前项的下一步」——当前项的唯一用处是给下标当锚点 |

面板侧全在 `packages/workbench-ui/src/feedback/quickInput/QuickInputPanel.tsx`：**锁定 = 输入框 `readOnly` + 提示行**；**宿主 document**（`targetDocument`，缺省为全局 `document`）收到对应修饰键的 keyup 就 accept；按 Enter 才解锁、交还输入过滤（解锁记录在 `unlockedFor` 上并与 `quickNavigate` 对象比对——宿主换一次 picker 就会重新进入锁定态）。`QuickInputPortal` 传入面板实际 portal 进去的那个 document，并经 `QuickInputPanel` 透传给 `QuickPickPanel`——漏透传时监听会留在主文档，辅助窗口里松手永远不触发。

## 边界三：面板在哪个文档，键就归哪个文档

辅助窗口是独立 realm，同一个面板可能渲染进任意文档：

- 修饰键 keyup 必须注册在 `targetDocument` 上；主文档收不到辅助窗口的按键。
- `Ctrl+N` / `Ctrl+P`（列表上下移动）走输入框的 React `onKeyDown`，不会跨 realm；但全局 keybinding dispatcher 会在捕获阶段先看到它们。`isQuickInputOwnedKey` 依赖 `isEditableTarget(e.target)` 放行——该判定必须按形状识别跨 realm 输入框（见 [auxiliary-editor-windows.md](auxiliary-editor-windows.md)），否则辅助窗口里 `Ctrl+N` 会执行「新建文件」、`Ctrl+P` 会重开快速打开，列表一步也不动。
- 锁定态下这两个别名**不 preventDefault 之外的动作**：命中后只移动高亮，松开修饰键接受的仍是移动后的行。

消费者：`apps/editor/src/renderer/actions/editorActions.ts`（Ctrl+Tab）、`apps/editor/src/renderer/actions/agentSessionActions.ts`（Alt+S / Alt+Shift+S）。

## 边界一：宿主 keybinding 必须带 `when: '!quickInputVisible'`

面板可见期若该键仍被解析，全局键盘 handler 的 `quickInputVisible` 分支会 `preventDefault + stopPropagation` 且只放行 Escape——重复按键到不了面板，连点循环直接失效。

**但 `when` 管不到「面板还没挂上」的那段窗口**：`pick()` 之前若还要等 IPC（Alt+S 的 `getAllSessions()` 跨窗口 fan-out），此刻 `quickInputVisible` 仍是 false，连点会重入命令，第二次 `pick()` 覆盖单槽 `_currentOnHide` → 上一个 Promise 永远 pending。这段只能靠宿主自己的 **in-flight 标志**挡（`runSwitchSession` 已挡）。

## 边界二：quickNavigate 下 `activeItemId` 是惰性的

面板 activeItems 的焦点 effect 首行 `|| quickNavigate` 直接返回，高亮只认 `initialSelectionIndex`。所以别把「当前项」同时传成 `activeItemId` 期望额外高亮——它只会变成一句死描述。

## Alt+C：键盘触发行尾移除

四类带移除能力的 Quick Pick（命令面板最近使用、`Agents: 打开侧边任务…`、最近打开的工作区、`Ctrl+Tab` 编辑器行）共用一条键盘入口，语义等同高亮行的 ×：

- **判定单一来源**：`packages/workbench-ui/src/feedback/quickInput/removeShortcut.ts` 的 `isAltRemoveShortcut`（经包 `index.ts` 导出），面板与宿主全局 handler 都调它，避免两处守卫漂移。只认 `Alt+C`，拒绝额外 `Ctrl`/`Meta`/`Shift` 及 `AltGraph`，避免 AltGr 误删；仅对 `key: 'ç'` 且 `code: 'KeyC'` 兜底 macOS Option+C，不把其他键盘布局的物理 KeyC 当成字符 c。
- **面板处理顺序**：命中即 `preventDefault`（没有可移除行也吞，避免打出字符）；先走 `onItemRemove && canRemove(item)` → `removeItem`，否则找当前项 `buttons` 里 `role: 'remove'` 的按钮 → `state.onTriggerItemButton`。两者都不存在就是无副作用的 no-op：不 accept、不关闭面板、不触发齿轮。
- **`role: 'remove'` 是显式语义标记**（platform `IQuickPickItemButton`），不要靠图标 id、tooltip 或按钮顺序猜操作；命令面板只给最近使用行的 × 标它，齿轮不标。
- **全局按键放行**：Quick Input 可见时，`useGlobalKeybindingHandler` 必须用同一判定把 `Alt+C` 留给面板，否则用户或扩展注册的同键全局命令会先吞掉它；面板外不接管该键。
- **locked 态不额外放宽**：`Ctrl+Tab` 按住 Ctrl 时仍用 `Ctrl+X`；先按 Enter 解锁、松开 Ctrl 后 `Alt+C` 才可用。视图行 `removable: false`，按了不做事。

## 验证

- 手势只有**真实按键** e2e 守得住：`apps/editor/e2e/specs/smoke.sessionSwitcherQuickNavigate.spec.ts`。
- `Alt+C` 的两条真实路径：`smoke.commandPaletteItemButtons.spec.ts`（鼠标 × / 键盘 Alt+C 参数化）与 `smoke.quickOpenRecentTargets.spec.ts`（视图行无操作；解锁后关闭非脏编辑器且列表保持打开）。
- 面板侧由 `packages/workbench-ui/src/__tests__/QuickInput.test.tsx` 的 `quick navigate locked mode` describe 覆盖。
