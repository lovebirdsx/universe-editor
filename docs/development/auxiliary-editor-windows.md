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

每个窗口有自己的 Document，所有文档级浮层必须挂到**owner document**：

- React portal 宿主（`DialogHost` / `ProgressDialogHost` / `QuickInput` / tooltip）以目标窗口的 `document.body` 为容器；`RendererDialogService` 在**发起操作时**捕获活跃窗口的 Document，而不是在服务构造时固定。
- `DialogHost` 把该 Document 传给 `ConfirmDialog` → `FocusScopeOverlay targetDocument`，否则 Escape 监听会留在主窗口的 document 上。
- `TooltipProvider` 与 `useDragSessionDocument` 在辅助窗口内按 `entry.window.document` 注册监听。
- Monaco 的布局服务与 overflow widget 容器按编辑区所在 Document 创建；hover、suggest、find 因此落在发起编辑的窗口（见 [overlay-layers.md](overlay-layers.md)）。

通用规则：**浮层跟随宿主文档，不跟随全局 `document`**。新增 overlay 时先问"它渲染进哪个 document"，再把该 document 显式传给 portal / FocusScope / 事件监听。

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

## 测试与已知限制

- 核心 E2E：`apps/editor/e2e/specs/smoke.auxiliaryEditorWindow.spec.ts` 覆盖建窗、移动/复制、关闭、恢复、菜单归属、dialog 归属、窗口命令与 DnD；`smoke.auxiliaryEditorWindow.monaco.spec.ts` 用真实 tsserver 验证 hover 落在辅助文档。
- Playwright/CDP 不能发起跨两个 BrowserWindow 的原生 OS 拖拽。跨窗口 DnD 用例把 `DragEvent` 合成进真实 React 树：处理器、共享 DragSession、screen 几何、IPC 建窗与编辑器迁移都真实执行，但**不是**原生 OS 拖拽测试；没有用探针直接调 `moveEditorToNewWindow` 冒充拖拽。
- 拖出建窗的落点断言按 main 侧同样的"工作区可达范围"公式校验，避免把窗口管理器的边缘裁剪误判为产品错误。
