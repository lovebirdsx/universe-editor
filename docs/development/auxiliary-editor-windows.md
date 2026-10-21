# 辅助编辑器窗口

辅助窗口（auxiliary editor windows）让同一个编辑器工作区把编辑器拆到多个原生窗口里：拖出标签、移动/复制编辑器组、窗口级缩放与关闭。它不是第二份 workbench——所有窗口共享同一个 renderer 运行时、DI 容器、Monaco 与扩展宿主，只是每个窗口有独立的 `EditorPart`（编辑器布局）。

## 架构与数据流

```
main 进程
  auxiliaryWindowsMainService   每个父窗口一份：token 预登记 / window-open 策略 / 原生窗口生命周期 / 几何
  windowMainService             BrowserWindow 与 renderer 的父级绑定
        ▲ prepare(token, geometry) / setWindowOpenHandler / did-create-window
        │                    │
renderer（主窗口，唯一运行时）
  window.open('about:blank', frameName=token) ──► 子 BrowserWindow（同源、无独立 preload 的宽松面）
        │
  AuxiliaryEditorWindowService  领养 Window / 建 EditorPart / 记录 token ↔ window
  WorkbenchWindowService        全局窗口注册表：document ↔ window ↔ part、焦点窗口
  EditorGroupsService           全局枚举（groups / getGroup / mainPart / activeGroup）
        │
  AuxiliaryWindowHost           createPortal(<EditorArea part={entry.part}/>, auxDocument#root)
```

- **同一 renderer**：辅助窗口不是独立进程，`window.open` 返回的 Window 与其 Document 被主 React 树用 `createPortal` 挂载 `EditorArea`。React context、DI、Monaco model、扩展宿主全部继承主树，因此跨窗口打开同一文件共享文本模型。
- **每窗口一个 part**：`EditorPart` 持有该窗口的网格、活动组与布局；`EditorGroupsService` 提供全局枚举，命令与恢复逻辑必须走它，不能用单组假设。
- **主窗口标识**：`WorkbenchWindowService.mainWindow` 是 `isMain: true` 的窗口；辅助窗口的 `token` 是能力值，`undefined` 仅限主窗口。
- **页面恢复**：布局持久化按窗口记录 part/组，reload 后按 token 重建辅助窗口；`restoreEditorsToMainWindow` 是**产品选择**：把所有辅助 part 的编辑器合并到 `mainPart.activeGroup`，主窗口自身的多组布局保持不动。VSCode 的 `IMainEditorPart.mergeAllGroups` 只枚举当前活动 part 自己的组，不是跨窗口合并，二者语义不同，勿按 VSCode 名称反推。

## 窗口创建与 IPC 安全

1. renderer 先向父窗口绑定的 `IAuxiliaryWindowsMainService.prepareWindow(...)` 申请一次性 token（可带 `geometry` 或 `bounds`），main 记录 token、父窗口与解析后的几何。
2. renderer 用 `window.open('about:blank', token)` 打开；父窗口的 `setWindowOpenHandler` 只放行**已预登记且父级匹配**的 token，其余一律 deny。
3. `did-create-window` 完成登记。辅助窗口不注入完整 renderer preload/IPC；它通过同一 renderer 的 DOM 共享工作，主进程能力仍由父窗口的通道代理。
4. token 有 TTL；取消/失败/重复拖放要 `cancelPrepared`。关闭走 `requestClose` → renderer 决定是否否决（脏编辑器回迁）→ `finalizeClose`。

几何解析在 main：以 `screen.getDisplayNearestPoint` 取工作区，宽度/高度做 `MIN_*` 与工作区裁剪，位置再夹到可达范围内。拖出建窗传的是 `screenX/screenY`（CSS/DIP 坐标，与 BrowserWindow bounds 同空间）。

## 浮层与文档归属

每个窗口有自己的 Document，所有文档级浮层必须挂到**owner document**。解析顺序统一走 `@universe-editor/workbench-ui` 的 `useOwnerDocument(explicit?)`：**显式 prop > `OwnerDocumentProvider` > 全局 `document`**。`Workbench` 根部 provide 主文档，`AuxiliaryWindowHost` 为每个辅助 portal 子树重新 provide 该窗口的 document。

- React context 沿 React 树传播、**不沿 DOM portal 传播**：任何跨文档的 `createPortal` 子树都必须重新包一层 `OwnerDocumentProvider`，否则子树里的浮层仍会解析到主文档。通知/进度宿主、`ChatImage`、`WhenInputCell`、`PerforceGraphSyncDialog` 都按此处理。
- 原语内部解析，调用点不必逐个传文档：`AnchoredSurface`（菜单、hover、context view）、`useMenuNavigation`（键盘捕获）、`Select`、`FocusScopeOverlay`、`TooltipProvider`。显式 `targetDocument` 仍可覆盖，供宿主在 provider 之外使用。
- `FloatingPortal` 的 `root` 必须是 owner document 的 `body`，window capture 监听挂 owner document 的 `defaultView`；只改 portal 不改监听，会出现"菜单画在辅助窗口、方向键却由主窗口处理"。
- 直接 portal 的浮层（`ChatImage` 预览、`WhenInputCell`、`PerforceGraphSyncDialog`）自己解析 owner document，并用所选窗口的 `innerWidth/innerHeight` 做视口夹取。
- `DialogHost` 仍把发起时捕获的 Document 传给 `ConfirmDialog` → `FocusScopeOverlay targetDocument`；`RendererDialogService` 在**发起操作时**捕获活跃窗口的 Document，而不是在服务构造时固定；`QuickInput` 同理。
- Monaco 编辑器内容浮层（hover / suggest / find 详情）由编辑器自身创建，落在编辑器所在文档；`monacoWorkbenchLayoutService.getContainer(window)` 按目标窗口解析该窗口的 `#root`，平台级 hover 同样跟随目标文档。`mainContainer` / `activeContainer` 仍固定主窗口，只作无目标容器时的兜底（见 [overlay-layers.md](overlay-layers.md)）。

通用规则：**浮层跟随宿主文档，不跟随全局 `document`**。新增 overlay 时先问"它渲染进哪个 document"，优先让原语从 context 解析；只有跨文档 portal 才需要显式重新 provide。

### 通知与进度：按发起文档路由

VSCode 的 `INotificationService` / `IProgressService` 是每个 workbench 窗口一份。本仓库只有一个 renderer、一份服务，因此用"**发起文档**"达到等价语义：

- `NotificationService.notify()` 在调用时捕获 `currentWorkbenchDocumentOrUndefined()`；真正需要指定窗口的调用方用 `notifyWithOrigin(origin, opts)`。origin 只存在于 renderer 内存（`notificationOrigins` observable），**绝不进入 platform 的 `INotification` 或持久化 JSON**；恢复的通知没有 origin，自然回落主窗口。
- `NotificationsToast` 按 `workbenchDocumentOrMain(origin)` 分组，每组 `createPortal` 到目标文档；每窗口最多 5 条。通知中心在 `toggleCenter()` 打开时捕获 `centerDocument`，关闭/文档注销时清空。
- 文档关闭后 origin 被清理，尚未处理的条目回落主窗口（`workbenchDocumentOrMain`）；通知**不会**跟着之后切换的活跃窗口漂移。
- `ProgressService.withProgress()` 在**进入时**捕获 origin（不是延迟 mount 时），notification 走 `notifyWithOrigin`，dialog 同时发布 `dialogDocument`；`ProgressDialogHost` portal 到该文档。来源文档注销时服务立即清空 `dialogDocument`，宿主回落主窗口；`QuickInputService` 在来源文档注销时直接 `hide()`，让挂起的 `pick()` / `input()` 结算，避免继续 portal 到死文档。
- 通知的已读状态、`unreadCount`、清空/全部已读仍是应用级全局状态——只有"画在哪个窗口"按 origin 路由。

语义边界：origin 是"调用 `notify()` 时活跃的窗口"，不是"任务发起窗口"。后台任务完成时用户已切窗口，会落在当前窗口；需要固定归属的调用点应显式传 origin。

### 跨 realm 的 DOM 判定

辅助窗口是独立 JS realm：主 realm 的 `element instanceof HTMLElement` / `Element` / `Node` 对辅助窗口元素**恒为 false**（两者的构造函数不是同一对象）。所有"这是不是可编辑元素 / 是不是浮层祖先 / 是不是节点"的判定都必须按形状实现，入口是 workbench-ui 的 `isElementLike` / `isHTMLElementLike` / `isEditableElement` / `isNodeLike` / `isTagElement`（`dom/domRealm.ts`）。典型后果：

- `isEditableTarget` 若是主 realm 判定，辅助窗口里的 Quick Input 输入框不算可编辑元素，全局 keybinding dispatcher 会先手吞掉 `Ctrl+N` / `Ctrl+P`（新建文件 / 快速打开），quick-navigate 的列表导航失效。
- `focusout.relatedTarget` 跨 realm 时被 `instanceof Node` 拒绝，会误清 `acpChatFocused`（Copy Message 等行消失）。
- 对话框 Enter 判定、菜单/浮层的祖先遍历、焦点恢复的 `previousFocus` 捕获同理。
- **事件字段同样跨 realm**：`ev.target`、`ev.relatedTarget`、`document.activeElement`、`focusin/focusout` 的 `relatedTarget` 都可能是辅助窗口节点，不要写 `target instanceof Node/Element/HTMLElement`；用形状判定。这一条同时覆盖 click 委派、dragover 落点、tooltip 的宿主体内移动判定、焦点是否仍在容器内（`relatedTarget` 在容器内时不能当作移出）。

**创建 DOM 时优先跟随宿主 document**：Chromium 允许主文档方法遍历并插入辅助文档节点（会自动 adopt，通常不抛 `WrongDocumentError`），但 wrapper 的 prototype 仍属创建它的 realm，`instanceof` 结果与节点所在窗口不一致。辅助窗口里的代码块后处理等应先用 `root.ownerDocument` 建 walker / fragment / 节点，使 realm 与宿主一致（参考 `useFindInContainer.ts`、`codeBlockLinks.ts`）。反过来，**主 document 创建、随后被 adopt 进辅助 document 的节点，其 JS wrapper 仍属于主 realm**（React 异步提交、Swarm inline comment 的 zone 即此类），不要依赖 realm 判定来区分它。

**焦点恢复也要按 document 捕获**：react-aria 的 `FocusScope` 在 render 阶段用全局 `document.activeElement` 播种恢复目标，辅助窗口里会指向主窗口。`FocusScopeOverlay` 在解析后的 owner document 不是主 document（或显式传了 `shouldRestoreFocus`）时禁用 react-aria 的恢复，改用自己从宿主 `doc.activeElement` 捕获的 previous focus；新增模态浮层不要再绕过它直接使用 `FocusScope`。

platform 的 `part.ts` 不依赖 DOM 类型，因此只读容器的 `ownerDocument` 形状（`{ activeElement: unknown }`），不引入 `instanceof`。`apps/editor/src/renderer/__tests__/domRealmUsage.test.ts` 扫描 `packages/workbench-ui/src` 与 `apps/editor/src/renderer` 的生产代码，禁止对 DOM 构造器做 `instanceof`（`domRealm.ts`、测试与 e2e 除外）。happy-dom 的 `new Window()` 元素构造器与主 realm 共享、但 Document 构造器独立：它能覆盖文档归属语义，元素跨 realm 的 `instanceof` 失败仍无法在单测复现，由真实 Electron e2e（`smoke.auxiliaryEditorWindow.realm.spec.ts`）守护。

**ResizeObserver 必须用元素所属 window 的构造器**（`el.ownerDocument.defaultView.ResizeObserver`）。Blink 在构造时把 observer 注册到该 window 的 `ResizeObserverController`，而 `LocalFrameView::NotifyResizeObservers` 只取**本 frame** `DomWindow` 的 controller：主 realm 构造的 observer 观察辅助 document 元素时，回调只在主窗口的渲染生命周期里投递。辅助窗口最大化遮住主窗口后主 frame 停帧，回调永不触发，Monaco 的内联 px 尺寸停在最大化前，画布只剩旧矩形。已修复 `GridLayout`（`packages/workbench-ui`）与 Monaco `ElementSizeObserver`（monaco patch，覆盖所有 `automaticLayout` 编辑器）；回归用例 `apps/editor/e2e/specs/smoke.auxiliaryEditorWindowResize.spec.ts`。新增任何驱动布局的 RO 时照此取 owner window。

### 文档级全局监听

需要挂 `window`/`document` 监听的功能（鼠标侧键、全局拖放安全网、peek 导航）不能只挂主窗口。`installPerWorkbenchDocument(attach)`（`services/windows/workbenchDocumentEvents.ts`）对当前已注册文档和之后新增的文档各调用一次 `attach(doc)`，文档注销时自动 `dispose`，没有注册文档时回落全局 `document`。新增此类监听一律用它，不要自己维护文档集合。

跨窗口广播的自定义事件（打开设置/快捷键编辑器时聚焦搜索框、切换设置作用域）走 `workbench/preferences/preferencesFocus.ts`：向**每个已注册文档**派发，事件用目标文档 realm 的构造函数创建（主 realm 的 `Event` 不是辅助窗口 WebIDL 的 `Event`）；接收组件监听自己的 owner document。

### 文档级焦点跟踪

`RendererFocusTrackerService` 在构造时订阅主文档，并对之后 `registerWorkbenchDocument` 的每个辅助文档挂 `focusin`/`focusout`，注销时解绑。只盯主文档会让辅助窗口的焦点事件完全缺席，焦点历史与 `settled` 当前项永远停在主窗口。`workbenchFocusRestorer` 读取的是 `currentWorkbenchDocumentOrUndefined()?.activeElement`，不能用全局 `document.activeElement`。

## 标签拖放与拖出建窗

- `useDragHandle` / `useDropTarget` 经 `DragSessionContext` 共享 payload；context 穿过 portal，因此主↔辅、辅↔辅的拖放是同一个会话。
- 每个 Document 都挂一份 `useDragSessionDocument`：drop / dragend / Escape 在**落点窗口**也能清理或取消会话；主窗口的清理不再假定所有事件都会回到主 document。
- 拖出判定是纯函数 `decideTabDragOut`（`services/editor/tabDragOut.ts`）：校验配置 `workbench.editor.dragToOpenWindow`（默认 true）、payload 是否已被消费、是否 Escape 取消、坐标是否有效、落点是否仍在某个窗口内；通过后以落点为 `geometry` 建窗。
- 修饰键对齐 VSCode：Windows/Linux `Ctrl`、macOS `Alt` = 复制（clone input，保留 dirty 与 sticky）；否则移动。编辑区边缘 drop 走分屏，跨组 drop 按指针位置插入。
- 已消费的 drop 不再触发建窗；取消手势不建窗。

## 可移动编辑器的生命周期

窗口/组移动只改变 DOM 宿主，不应结束资源：

- **终端**：xterm 的持久 holder 被 reparent，React 卸载不 dispose 会话；PTY 生命周期绑在 `TerminalEditorInput.dispose()`。
- **Webview / 自定义编辑器**：`WebviewService.openPanel` 对同一 input 复用 panel，并在 `input.onWillDispose` 时关闭；`CustomEditorHost` 卸载时**不得**关闭 panel（否则扩展会收到 panel closed，移动一次就重新 resolve）。
- **未命名/脏编辑器**：移动保留 input 身份与 model；复制走 clone，未保存内容随序列化带走。

## 窗口级命令

`CloseWindowAction` 与缩放三命令按 `IWorkbenchWindowService.activeWindow` 路由：焦点在辅助窗口时只操作该窗口的 webContents，绝不误关主工作区。`ReloadWindow` 仍是整应用重启（所有窗口共享一个 renderer），这是当前架构限制；恢复后按持久化布局重建辅助窗口。

main 进程有两处不能只看"当前窗口 id"：

- **原生文件夹对话框**以焦点辅助窗口为父。`ElectronFolderDialog` 接受 `getDialogParent(fallback)`，`windowScopeFactory` 注入 `auxiliaryWindows.getDialogParent(win.id, fallback)`：焦点在属于该工作区的辅助窗口时，对话框挂在辅助窗口上；否则回落工作区窗口。`MainHostService` 已走同一规则。
- **`WindowMainService.getFocusedWindowId()`**：焦点窗口是工作区窗口时原样返回；是辅助窗口时经 `AuxiliaryWindowsMainService.getParentWindowId()` 映射回**存活的**父工作区窗口，再走 lastFocused/首个窗口回退。窗口级 IPC 服务仍绑定在父窗口上，返回辅助窗口 id 会让命令找不到服务。

## 标题栏与窗口控制

辅助窗口与主窗口用同一套 chrome：Windows/Linux `frame: false`，macOS `titleBarStyle: 'hidden'` + `trafficLightPosition`（保留红绿灯）。标题栏由 renderer 画（`AuxiliaryTitleBar`，复用主 `TitleBar.module.css`），因此能跟随 `--vscode-titleBar-*` 主题变量；原生 frame 由 OS 上色，做不到这一点。

- `prepareOpen` 把当前主 document 的 `--vscode-titleBar-activeBackground` 作为 `backgroundColor` 传给 main，避免窗口显示前的闪白/闪黑；主题变化后 CSS 变量会随主题服务镜像进辅助 document。
- 非 macOS 窗口按钮走 `WindowControlsView`（无 DI 的纯展示组件，主/辅共用），最小化/最大化切换经 `IAuxiliaryWindowsService.minimizeWindow/toggleMaximizeWindow` IPC 到 main；关闭仍走 `requestClose`，保留脏编辑器回迁事务。标题栏本身是 `-webkit-app-region: drag`，双击最大化交给 Electron/OS 的原生 caption 行为，不要给 `<header>` 挂 `onDoubleClick`（drag 区收不到指针事件，按钮上的双击反而会冒泡上来）。
- main 侧在 `maximize` / `unmaximize` / 全屏事件上立即 `emitState`（不 debounce），否则自绘的最大化/还原图标要等 500ms 的几何防抖才更新。
- **原生标题按窗口计算**：`document.title` 是窗口自己的标题（`{活动编辑器} — Editor Window`，空窗口为本地化的 `Editor Window`），由 `AuxiliaryTitleBar` 跟随活动编辑器与标签重命名同步。服务建窗时只写空标题；`mirrorDocumentChrome.syncChrome` **不得**把主窗口标题复制过来（同一份 workspace 标题会让所有辅助窗口看起来一模一样，且覆盖掉编辑器名）。

## 跨窗口激活与焦点

**`IEditorGroupsService.activateGroup` 只改 renderer 激活态，不移动原生窗口焦点。** 只调用它会出现"目标 tab 已高亮、键盘输入仍在原窗口"的现象（Alt+←/→、Ctrl+Tab、Ctrl+P 的旧 bug 即此）。

统一入口：

- `activateGroupAndFocus(group, ctx, editor?)`（`services/editor/activateGroupAndFocus.ts`）：`activateGroup` → `setActive(editor)` → focusStack push → `IWindowFocusService.focusGroup(group)` → `focusEditorInput(...)`。**用户显式 reveal**（历史导航、Ctrl+Tab、Ctrl+P、Git Graph、扩展 `showTextDocument` 等）统一走它；后台打开/`preserveFocus` 路径不请求窗口聚焦。
- `IWindowFocusService`（`services/windows/windowFocusService.ts`）：主窗口用 `IWindowsService.getCurrentWindowId()` + `focusWindow(id)`，辅助窗口用 `IAuxiliaryWindowsService.focusWindow(token)`；`focusWindow` 同时 `setActiveWindow`，保证 overlay/dialog 归属同步。同一窗口的重复请求在一次 IPC 在途期间会被合并；IPC 失败只记 debug，不让命令失败。
- `LayoutService.focusView/focusPart` 只在 `source: 'command' | 'user'` 时请求窗口聚焦；`'restore'` 与未指定来源绝不抢焦点。`focusPart(PartId.EditorArea)` 按全局 `activeGroup` 解析所属窗口（编辑器组可能在辅助窗口），再走 `activateGroupAndFocus`，不硬编码主窗口。
- `MainThreadEditor.$showTextDocument` / `WebviewService.revealHostPanel` 等扩展入口必须保留 `preserveFocus` 语义：传了 `preserveFocus: true` 就只激活组、不请求窗口聚焦。
- 自动揭示（错误日志、扩展后台调用 `showOutputChannel`）传 `source: 'restore'`，可移动主窗口内的 DOM 焦点但绝不把窗口拉到前台。
- **QuickInput 关闭时的焦点恢复不能抢回窗口**：`FocusScopeOverlay` 默认在卸载时把焦点还给打开前的元素，但 Ctrl+Tab 这类同步命令会在 React 卸载面板之前就完成跨窗口激活；随后这次恢复会触发主 document 的 focusin → `WorkbenchWindowService` 把 activePart 切回主窗口。`QuickInputPortal` 因此传 `shouldRestoreFocus`，仅在当前 active workbench document 仍是面板宿主 document 时才恢复。
- **窗口激活不是编辑器聚焦意图**：辅助窗口被激活时 `AuxiliaryEditorWindowService` 调 `activatePart(part, { preserveFocus: true })`，平台侧落到组的 `preserveFocusOnActivation()`；`EditorGroupView` / `FileEditor` 的自动聚焦据此跳过。否则激活链路会在 `focusView` 之后把焦点抢进编辑器（表现为"命令执行了，焦点却不在目标视图"）。这是意图区分，**不要用延时规避**。
- **后台文档的 Part 不算聚焦**：Part 容器的 `isFocused()` 读自己的 `ownerDocument.activeElement`，但失去 OS 焦点的文档会保留最后的 activeElement。凡是"当前是否聚焦在某 Part/视图"的产品判定（context key、`Ctrl+Shift+E` 等 toggle 命令）必须在 `isFocused()` 之外再要求该 Part 的 document 等于当前 active workbench document（`services/focus/partFocus.ts` 的 `isPartFocusedInActiveDocument`），否则在辅助窗口打字时主窗口会误判侧栏仍聚焦，命令执行成"关闭侧栏"而不是"显示 Explorer"。
- **焦点竞争还来自两处细节**：`LayoutService.focusView` 的落点确认读元素自己的 `ownerDocument.activeElement`（主文档判定对辅助元素恒 false）；`_focusPart` 只在没有显式目标视图时才委派给该 Part 上次记住的视图，显式 `focusView(A)` 不能先打开/聚焦记住的视图 B。


两个关键细节：

- **判定"已有焦点"只读目标 `document.hasFocus()`**，不能读 `WorkbenchWindowService.activeWindow`——pointerdown/focusin 会把 activeWindow 提前写成目标窗口，但原生焦点未必已过去；读错会在 Windows 上触发 always-on-top 窗口闪烁。
- **异步命令必须在第一个 `await` 之前取完 `IWindowFocusService` / `IContextKeyService`**：`ServicesAccessor` 在首个 await 后失效。main 侧两个 `focusWindow` 都先 `restore()` 被最小化的窗口——Windows 上对最小化窗口 `focus()` 是 no-op。

## 测试与已知限制

- 核心 E2E：`apps/editor/e2e/specs/smoke.auxiliaryEditorWindow.spec.ts` 覆盖建窗、移动/复制、关闭、恢复、菜单归属、dialog 归属、ACP 会话菜单/图片预览/通知归属、窗口命令、标题栏主题跟随、跨窗口焦点（Ctrl+P / Alt+← / Ctrl+Tab）、辅助窗口内 `Ctrl+Shift+E` 不误关侧栏、quick-navigate 的改键释放与 `Ctrl+N/P` 归属、原生标题随编辑器更新，以及 DnD；`smoke.auxiliaryEditorWindow.monaco.spec.ts` 用真实 tsserver 验证 hover 落在辅助文档；`smoke.auxiliaryEditorWindow.realm.spec.ts` 用真实辅助窗口守护跨 realm 判定（tooltip、markdown Shift-drop、prompt drop overlay、配置浮层文档归属与焦点交还、代码块文件链接）。
- **DevTools 属于主 renderer**：辅助窗口共享主窗口的 JS realm 与 webContents，`toggleDevTools` 只能打开主窗口的开发者工具，无法按辅助窗口分别打开。这是同 renderer 架构的直接结果，不是遗漏；要按窗口调试需等辅助窗口拥有独立 renderer。
- **Monaco 平台容器仍以主窗口为准**：`monacoWorkbenchLayoutService.mainContainer/activeContainer` 固定返回主 `#root`（`getContainer(window)` 已按目标窗口解析）。monaco 自带的 quick input、无障碍提示等少数走 `activeContainer` 的浮层在辅助窗口中仍会挂到主窗口；编辑器内容浮层与平台 hover 不受影响。完整重构需按 window 维护多容器集合，暂未做。
- 跨窗口焦点用例在 main 进程猴补 `BrowserWindow.prototype.focus/showInactive` 记录焦点请求，再断言最后一次请求指向辅助窗口（`about:blank`）。silent E2E 下窗口不真正抢焦点，所以断言"请求了哪个窗口"而不是 OS 焦点状态。
- Playwright/CDP 不能发起跨两个 BrowserWindow 的原生 OS 拖拽。跨窗口 DnD 用例把 `DragEvent` 合成进真实 React 树：处理器、共享 DragSession、screen 几何、IPC 建窗与编辑器迁移都真实执行，但**不是**原生 OS 拖拽测试；没有用探针直接调 `moveEditorToNewWindow` 冒充拖拽。
- 拖出建窗的落点断言按 main 侧同样的"工作区可达范围"公式校验，避免把窗口管理器的边缘裁剪误判为产品错误。
