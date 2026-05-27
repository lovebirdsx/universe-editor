# 焦点管理重构方案（React + VSCode 范式混合）

## Context

universe-editor 当前焦点管理分散在多个子系统中，没有统一抽象，导致多类边界问题：
- Ctrl+B 关 SideBar 后焦点丢到 `body`，下次快捷键路由失效
- Action 调 `part.focus()` 时 React 组件可能尚未挂载（懒加载 view），目前靠 `SEARCH_FOCUS_INPUT_EVENT` / `EXPLORER_FOCUS_VIEW_EVENT` 这类 CustomEvent 兜底——异步、分散、不可靠
- QuickInput 关闭后焦点恢复用手工实现的 `_restoreFocusTarget` 三重检查；新增 Dialog/Popover 时只能复制粘贴
- Split / Alt+0-9 多 group 切换时 Monaco 未挂载导致 `focus()` 空操作；`activateGroup() + focus()` 非原子
- ContextKey 体系只有 `editorFocus` 一个，缺 `focusedView` / `sideBarFocus` / `panelFocus` / `activityBarFocus` 等，快捷键 precondition 写不出来
- `usePartFocusTarget` 用了 `useEffect` 而非 `useLayoutEffect`，有微秒级 race

**目标**：把焦点管理从"分散散点 + CustomEvent 兜底"升级为"事件驱动的 Part + 中枢化 FocusTracker + 标准化弹层 FocusScope + 焦点栈/历史栈"，分 5 个里程碑独立交付。

**关键设计取舍**：
- 不照搬 vscode 的同步命令式 Part（React reconciler 决定挂载时机，必须异步可等待）
- 借鉴 vscode 处理 webview 的模式（状态机 `Initializing → Ready` + 命令队列 + 乐观事件 + Delayer），它正是"异步、黑盒、慢挂载"子系统的成熟方案，与 React 同构
- 弹层场景引入 `@react-aria/focus` 的 `<FocusScope contain restoreFocus autoFocus>`，业内标准解，避免重新发明
- 工作台主体（Part / View / Group 间协调）保留 vscode 范式

## 整体架构

```
┌─ 平台层（packages/platform）
│  ├─ FocusTrackerService          全局 focusin/focusout 监听 + setTimeout(0) 防抖
│  ├─ Part 升级                    onDidFocus/onDidBlur/onDidMount + ensureMounted() + deferred focus queue
│  ├─ FocusStackService            [M4] 焦点栈，按 part 注册顺序
│  └─ HistoryService               [M5] 编辑器导航栈 + 选区记忆
│
├─ 服务层（apps/editor/services）
│  ├─ LayoutService.focusPart(id, opts)
│  ├─ LayoutService.focusView(viewId, opts)   挂载等待 → 拿 focusable element → focus
│  ├─ FocusableRegistry            viewId → () => HTMLElement
│  ├─ ViewContainerMemoryService   [M4] containerId → lastFocusedViewId
│  └─ RendererFocusTrackerService  注入 document，实现接口
│
├─ React 适配 hooks
│  ├─ usePartFocusTarget           [M1] useEffect → useLayoutEffect
│  ├─ useViewFocusable(viewId, getEl)   组件用一行注册到 service
│  └─ useFocusContextKey(key)      读 ContextKey 给 UI 用
│
├─ ContextKey（contribution 统一维护）
│  └─ focusedPart / focusedView / sideBarFocus / panelFocus / activityBarFocus / auxiliaryBarFocus / editorFocus
│
└─ 弹层（QuickInput / Dialog / Popover）
   └─ <FocusScopeOverlay> 薄封装 @react-aria/focus 的 FocusScope
```

依赖图：

```
M1 (基础设施)  ──→  M2 (focusPart 中枢 + ContextKey)  ──→  M3 (FocusScope 弹层)
                                                    └─→  M4 (焦点栈 + F6)
M5 (HistoryService) —— 与 M1-M4 解耦，可并行
```

## M1：焦点基础设施

**目标**：Part 事件化 + mount 状态机 + ensureMounted；FocusTrackerService；修 `useLayoutEffect` race。本里程碑不改调用方，仅打底。

**新建**：
- `packages/platform/src/workbench/focusTracker.ts` —— `IFocusTrackerService` 接口 + decorator
- `apps/editor/src/renderer/services/focus/RendererFocusTrackerService.ts` —— 实现（document focusin/focusout + setTimeout(0) debounce）
- `packages/platform/src/__tests__/workbench/focusTracker.test.ts`
- `packages/platform/src/__tests__/workbench/part.test.ts`

**改动**：
- `packages/platform/src/workbench/part.ts` —— 加事件 + mount 状态机 + deferred focus queue
- `packages/platform/src/index.ts` —— re-export
- `apps/editor/src/renderer/workbench/usePartContainer.ts` —— `useEffect` → `useLayoutEffect`
- `apps/editor/src/renderer/main.tsx` —— 注入 `RendererFocusTrackerService`

**Part 核心改动**：

```ts
type MountState = 'unmounted' | 'mounted'

abstract class Part extends Disposable {
  private _mountState: MountState = 'unmounted'
  readonly onDidMount = this._onDidMount.event
  readonly onDidUnmount = this._onDidUnmount.event
  readonly onDidFocus = this._onDidFocus.event
  readonly onDidBlur = this._onDidBlur.event

  private _pendingFocus: { token: number; expiresAt: number } | undefined

  whenMounted(timeoutMs = 2000): Promise<void> { /* resolve on onDidMount */ }

  focus(): void {
    const target = this._focusTarget ?? this._container
    if (this._mountState === 'mounted' && target) {
      target.focus()
      this._onDidFocus.fire()   // 乐观 fire；FocusTracker 用真实 focusin 校正
      return
    }
    this._pendingFocus = { token: ++Part._token, expiresAt: Date.now() + 2000 }
  }

  _attachContainer(el: HTMLElement | null): void {
    if (el === null) { /* fire onDidUnmount, clear pending */ }
    else {
      this._container = el
      if (this._mountState !== 'mounted') {
        this._mountState = 'mounted'
        this._onDidMount.fire()
      }
      const pending = this._pendingFocus
      this._pendingFocus = undefined
      if (pending && Date.now() < pending.expiresAt) {
        queueMicrotask(() => this.focus())  // 等子组件 setFocusTarget
      }
    }
  }
}
```

**FocusTracker 核心**：document focusin/focusout 监听，相邻事件用 `setTimeout(0)` 合并，避免跨 Part 切换时的中间态。

**验收**：
- 单测：mount→focus 直接生效；focus→mount 自动 flush；超时不 flush；StrictMode 双挂载不重复 fire
- 单测：FocusTracker `setTimeout(0)` debounce；prev/current container 解析
- 手动：dev 启动 + DevTools 看 contextkey 切换无报错

**风险**：happy-dom 对 focusin/focusout 冒泡支持有限，单测用 `dispatchEvent(new FocusEvent('focusin', { bubbles: true }))` 显式构造。

## M2：ContextKey 补齐 + LayoutService.focusPart 中枢

**目标**：补齐 7 个 ContextKey；新增 `focusPart()` / `focusView()` 作为唯一焦点入口；替换 4 个 CustomEvent 路径。修复"Part 切换/隐藏焦点丢失" + "View 未挂载焦点失败"两个痛点。

**新建**：
- `apps/editor/src/renderer/contributions/FocusContextKeyContribution.ts` —— 订阅 FocusTracker 维护所有焦点 ContextKey
- `apps/editor/src/renderer/services/focus/FocusableRegistry.ts` —— viewId → focusable element 注册表
- `apps/editor/src/renderer/workbench/useViewFocusable.ts`
- `apps/editor/src/renderer/workbench/useFocusContextKey.ts`

**改动**：
- `packages/platform/src/workbench/layoutService.ts` —— 加 `focusPart(id, opts?)` / `focusView(viewId, opts?)` 接口
- `apps/editor/src/renderer/services/layout/LayoutService.ts` —— 实现
- `apps/editor/src/renderer/workbench/explorer/ExplorerView.tsx` / `search/SearchView.tsx` —— 用 `useViewFocusable` 替换 CustomEvent 监听
- `apps/editor/src/renderer/workbench/sidebar/SideBar.tsx` —— view 根节点加 `data-view-id="..."` 属性
- `apps/editor/src/renderer/actions/searchActions.ts` / `layoutActions.ts` —— 改调 `layoutService.focusView(...)`
- `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` —— Monaco focus/blur 联动剥离到 contribution

**删除**：
- `SEARCH_FOCUS_INPUT_EVENT` / `EXPLORER_FOCUS_VIEW_EVENT` 常量与 dispatch / listener

**核心接口**：

```ts
interface IFocusPartOptions {
  source?: 'user' | 'restore' | 'command'
  preserveFocusInQueue?: boolean   // 默认 true
}

interface ILayoutService {
  focusPart(id: PartId, opts?: IFocusPartOptions): Promise<boolean>
  focusView(viewId: string, opts?: IFocusPartOptions): Promise<boolean>
}
```

**focusView 实现**：
```ts
async focusView(viewId, opts) {
  await this._viewsService.openView(viewId)            // 切到所在容器
  const partId = this._containerToPartId(viewId)
  await this.focusPart(partId, opts)                   // reveal + whenMounted + focus
  const getEl = this._focusableRegistry.get(viewId)
  if (getEl) requestAnimationFrame(() => getEl()?.focus())
  return true
}
```

**useViewFocusable**：
```ts
function useViewFocusable(viewId: string, getElement: () => HTMLElement | null): void {
  const registry = useService(IFocusableRegistry)
  useLayoutEffect(() => {
    const d = registry.register(viewId, getElement)
    return () => d.dispose()
  }, [registry, viewId, getElement])
}
```

**FocusContextKeyContribution**：订阅 `tracker.onDidFocusChange`，从 `currentElement` 反查最近的 `[data-view-id]` 父节点拿 viewId，从 `getActivePartId()` 拿 partId，更新所有相关 ContextKey。

**验收**：
- 单测：focusPart 隐藏 part → reveal → mount → focus 全链路；超时返回 false；focusableRegistry 注册/获取/dispose
- 集成：searchActions / layoutActions 调用后 contextkey 正确
- e2e 新增 `apps/editor/e2e/specs/smoke.focusRouting.spec.ts`：
  - SideBar 收起状态调 `focusView` → 自动 reveal + focus
  - 各 part 切换时 contextkey 准确
- 手动：SideBar 收起 → 命令面板调 Focus Explorer → 自动展开 + 焦点进输入框

**改动顺序**：先加 hook + registry（不破坏老的）→ 实测无回归 → 再删 CustomEvent。

**风险**：
- happy-dom 无 raf，测试 mock `globalThis.requestAnimationFrame`
- `FocusContextKeyContribution` 必须 `BlockStartup`，否则 precondition 解析时 key 不存在被当 false

## M3：弹层焦点标准化（react-aria FocusScope）

**目标**：QuickInput / Dialog / Popover 统一用 `<FocusScope contain restoreFocus autoFocus>`，删除 `QuickInputService` 手工焦点字段。修复"弹层关闭焦点恢复不准"。

**新增依赖**：`@react-aria/focus`（只引这个细粒度子包，~30KB gzip）

**新建**：
- `apps/editor/src/renderer/workbench/common/FocusScopeOverlay.tsx`：

```tsx
import { FocusScope } from '@react-aria/focus'

export function FocusScopeOverlay({ visible, onEscape, children }) {
  useEffect(() => {
    if (!visible || !onEscape) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onEscape() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [visible, onEscape])
  if (!visible) return null
  return <FocusScope contain restoreFocus autoFocus>{children}</FocusScope>
}
```

**改动**：
- `apps/editor/package.json` —— 加 `@react-aria/focus`
- `apps/editor/src/renderer/workbench/quickInput/QuickInputView.tsx` —— 外包 `<FocusScopeOverlay>`
- `apps/editor/src/renderer/services/quickInput/QuickInputService.ts` —— 删 `_capturedFocusTarget` / `_captureFocusTarget()` / `_restoreFocus()` / `_restoreFocusTarget`

**验收**：
- 单测：autoFocus / restoreFocus / Escape 行为
- e2e 扩 `smoke.commandPalette.spec.ts`：Editor 聚焦 → Ctrl+P → Escape → editorFocus 仍 true
- 手动：Explorer 输入框 → Ctrl+P → Escape → 焦点回 Explorer 输入

**风险**：
- react-aria 的 `contain` 拦截 Tab，弹层内不要有外链元素跳到 part 外
- happy-dom 可能不完整支持 FocusScope，单测可 mock：`vi.mock('@react-aria/focus', () => ({ FocusScope: ({children}) => <>{children}</> }))`，真实行为靠 e2e 兜底

## M4：焦点栈、lastFocusedView、F6/Shift+F6 Part 导航

**目标**：ViewContainer 记忆 `lastFocusedView`；维护全局 part 焦点栈；新增 `focusNextPart` (F6) / `focusPreviousPart` (Shift+F6) 命令；用焦点栈仲裁修复"多 group 切换 race"。

**新建**：
- `packages/platform/src/workbench/focusStack.ts` —— `IFocusStackService` 接口
- `apps/editor/src/renderer/services/focus/FocusStackService.ts` —— 实现（订阅 FocusTracker，限长 16）
- `apps/editor/src/renderer/services/focus/ViewContainerMemoryService.ts` —— containerId → lastFocusedViewId
- `apps/editor/src/renderer/actions/focusActions.ts` —— F6 / Shift+F6 / focusFirstEditorGroup / focusActiveEditorGroup

**改动**：
- `apps/editor/src/renderer/services/layout/LayoutService.ts` —— `focusPart` 内若 SideBar/Panel/AuxBar 且有 lastFocusedView，转 `focusView`
- `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` —— blur 后 queueMicrotask 改为查 focusStack.getTop()，只有栈顶仍是同组才恢复
- `apps/editor/src/renderer/services/editor/editorFocus.ts` —— 删 syncEditorFocusContext 中的自动恢复，统一走 focusStack
- `apps/editor/src/renderer/actions/editorActions.ts` —— `activateGroupAndFocus` 改为 await onDidActiveGroupChange → focusStack.push → group focus

**核心**：
```ts
interface IFocusEntry {
  partId: PartId
  viewId?: string
  groupId?: number
  timestamp: number
}

interface IFocusStackService {
  onDidChange: Event<void>
  push(entry: Omit<IFocusEntry, 'timestamp'>): void
  getTop(): IFocusEntry | undefined
  nextPart(): PartId | undefined         // 跳过隐藏 part
  previousPart(): PartId | undefined
}
```

**FileEditor blur 仲裁**：
```ts
editor.onDidBlurEditorWidget(() => {
  queueMicrotask(() => {
    const top = focusStack.getTop()
    // 只有栈顶仍指向当前 group 才恢复（说明误触 blur 而非真切组）
    if (top?.partId === PartId.EditorMain && top.groupId === currentGroupId) {
      editor.focus()
    }
  })
})
```

**验收**：
- 单测：push 顺序 / 限长 16 / nextPart 跳隐藏 / WeakRef 不阻 GC
- 集成：split 后切组焦点跨 Monaco 不被自动恢复打断
- e2e：扩 `smoke.focusRouting.spec.ts` 加 F6 循环 + SideBar 切回时 lastFocusedView 恢复
- 手动：Explorer 输入文字 → 切命令面板 → F6 → 直接进 Explorer 输入框

**风险**：
- F6 在弹层打开时被 `FocusScope contain` 拦截，precondition 加 `!quickInputVisible && !dialogVisible`
- WeakRef 在 Electron 33 / Node 18+ 原生支持

## M5：HistoryService（编辑器导航栈 + 选区记忆）

**目标**：独立交付编辑器导航历史，支持 Alt+Left/Right 跳转上次位置。与 M1-M4 解耦，可并行开发。

**新建**：
- `packages/platform/src/workbench/historyService.ts` —— `IHistoryService` 接口
- `apps/editor/src/renderer/services/history/HistoryService.ts` —— 实现
- `apps/editor/src/renderer/contributions/HistoryContribution.ts`
- `apps/editor/src/renderer/actions/historyActions.ts` —— GoBack (Alt+Left) / GoForward (Alt+Right) / ClearHistory
- `apps/editor/e2e/specs/smoke.history.spec.ts`

**改动**：
- `apps/editor/src/renderer/workbench/editor/FileEditor.tsx` —— Monaco mount 后调 `historyService.attachEditor(editor, uri)`，selection change 节流后 record

**核心接口**：
```ts
interface IHistoryEntry {
  resource: URI
  selection?: { startLine, startColumn, endLine, endColumn }
  timestamp: number
}

interface IHistoryService {
  onDidChange: Event<void>
  recordCurrent(): void
  goBack(): Promise<boolean>
  goForward(): Promise<boolean>
  canGoBack(): boolean
  canGoForward(): boolean
}
```

**实现要点**：
- 双向栈 + `_suppressNext` 标志（goBack/goForward 触发的 active change 不再 record）
- 栈顶去重（同 URI 同行号）
- 上限 50，超出 shift
- 仅内存，不持久化（与 vscode 一致）
- selection 250ms debounce，仅记"显著跳转"（行差 > 10 或文件切换）

**验收**：
- 单测：三次切换 → back 长 3；goBack/goForward 互换；去重；上限
- 集成：A → B 行 100 → C → goBack 落在 B 行 100
- e2e：`smoke.history.spec.ts` 验证 Alt+Left/Right
- 手动：跳三文件 + Alt+Left 路径正确；中途打开新文件 forward 清空

## 跨里程碑统一约定

**命名**：
- 接口 `IXxxService`，decorator 同名 `createDecorator<IXxxService>('xxx')`
- 事件 `onDidXxx`（已发生）/ `onWillXxx`（可拦截）
- Action ID 与 vscode 对齐：`workbench.action.focusNextPart` / `workbench.action.focusExplorerView` / `workbench.action.goBack`
- ContextKey lowerCamelCase 沿用 vscode（`focusedPart` / `focusedView` / `sideBarFocus` / `editorFocus`）

**错误处理**：
- `focusPart` / `focusView` / `whenMounted` 永不抛同步异常，统一 `Promise<boolean>` 或 reject
- 默认超时 2000ms
- 焦点失败不阻断后续，记 `ILogService.warn('[Focus] ...', err)`

**调试**：
- 加 namespace logger `focus`
- dev-only 命令 `workbench.action.dumpFocusState` 打印焦点栈 + ContextKey 全集 + 各 part mountState + pendingFocus token
- 扩 e2e 探针：`window.__E2E__.getFocusStack()` / `getActivePartId()` / `getContextKey(key)`

**测试基线**：
| 类型 | 工具 | 范围 |
|---|---|---|
| platform 单测 | vitest node | Part / FocusTracker / FocusStack / HistoryService（不依赖 DOM 部分） |
| renderer 单测 | vitest happy-dom + RTL | Hooks / Service DOM 集成 / Action2 |
| 集成 | vitest happy-dom | 跨服务场景 |
| e2e | Playwright + _electron + `__E2E__` | 真实焦点行为（happy-dom 不可信部分） |

**向后兼容**：
- `Part.focus()` / `isFocused()` 公共签名不变，语义升级为"立即或入队"对调用方透明
- `_setFocusTarget` 保留（内部用）

## 不要做的（明确范围外）

1. 不引入完整 react-aria，只 `@react-aria/focus` 子包
2. 不做 per-group HistoryService，M5 只全局栈
3. 不持久化焦点状态 / 历史栈（与 vscode 一致）
4. 不重写 EditorGroupsService
5. 不引入新状态管理库
6. 不动 Monaco 内部焦点（minimap / suggest widget 等）
7. 不做焦点动画 / 视觉反馈（CSS 焦点环属 UI 层议题）
8. 不预先拆 platform 公共包（FocusTrackerService 实现住 apps/editor）
9. 不重构 ContextKeyService 引擎
10. 不引入 web `inert` 属性管理

## 实施排序

```
Week 1: M1（基础设施，无 UI 改动）
Week 2: M2（最大块，含 CustomEvent 删除回归测试）
Week 3a: M3（react-aria 接入）
Week 3b: M4（焦点栈 / F6）
Week 4: M5（HistoryService）
```

双人并行：M5 可从 Week 1 末就开始，与 M1-M4 解耦。

## Critical Files

第一步必读必改的 5 个文件：

- `D:\git_project\universe-editor\packages\platform\src\workbench\part.ts` — M1 升级 Part 事件化和 mount 状态机的核心
- `D:\git_project\universe-editor\apps\editor\src\renderer\workbench\usePartContainer.ts` — M1 修 useLayoutEffect race；M1/M2 的 React 桥梁
- `D:\git_project\universe-editor\packages\platform\src\workbench\layoutService.ts` — M2 加 focusPart / focusView 接口
- `D:\git_project\universe-editor\apps\editor\src\renderer\services\quickInput\QuickInputService.ts` — M3 删手工焦点字段；现有"三重检查"是 M2 focusView 回退参考
- `D:\git_project\universe-editor\apps\editor\src\renderer\workbench\editor\FileEditor.tsx` — M2/M4/M5 汇合点（contextkey 剥离 / blur 仲裁 / history attach）

## 端到端验收（全部完成后）

1. **痛点 1（Part 切换焦点丢）**：Ctrl+B 关 SideBar → 焦点在 EditorArea 而非 body；点 ActivityBar Explorer → 焦点直接进 Explorer 输入框
2. **痛点 2（View 未挂载）**：冷启动后立刻 Ctrl+Shift+F → SearchView 挂载完成后焦点准确进搜索框
3. **痛点 3（弹层恢复不准）**：Explorer 输入文字 → Ctrl+P → Escape → 焦点回 Explorer 输入框
4. **痛点 4（多 group race）**：Ctrl+\ split → Alt+0/9 切换 → 焦点跟随到对应 group 的 Monaco，无闪烁
5. **F6 导航**：在所有可见 part 间循环，跨回 SideBar 时落回 lastFocusedView
6. **历史导航**：Alt+Left / Alt+Right 跨文件 + selection 正确恢复
7. **e2e 全绿**：`smoke.focusRouting.spec.ts` / `smoke.commandPalette.spec.ts` / `smoke.history.spec.ts` / 现有 `smoke.editorSplit.spec.ts`
