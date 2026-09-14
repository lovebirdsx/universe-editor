# 浮层层级与裁剪

编辑器里的 tooltip / 菜单 / 对话框为什么有时被截断、有时被压在别的面板下面，由两件事决定：**挂在哪**（决定会不会被祖先的 `overflow` 裁掉）和**在哪个层**（决定跟别人谁压谁）。本文是这两件事的单一真相。

## 四条挂载链路

| 链路 | 挂载点 | 定位 | 层级来源 | 代表 |
|---|---|---|---|---|
| **A. React portal** | `document.body`（`FloatingPortal`，或宿主自己 `createPortal`：`DialogHost` / `ProgressDialogHost` / `QuickInput` / `NotificationsToast` / `NotificationsCenter`） | Floating UI —— `AnchoredSurface` 与 `TooltipProvider` 传 `strategy: 'fixed'`，`Select` 用默认的 `absolute` | `--z-*` 令牌 | `TooltipProvider`、`useHover`、`ContextMenu`/`ListMenu`、`Select`、对话框、进度、通知、`QuickInput` |
| **B. monaco 平台层** | `#root` | absolute / fixed | monaco 内建（40 / 2550） | find widget 按钮 tooltip、编辑器右键菜单（context view）、action widget、monaco quick input |
| **C. monaco 编辑器内容层** | `.monaco-editor > .overflowingContentWidgets`（content widget）/ `.overflowingOverlayWidgets`（overlay widget） | **fixed**（开启 `fixedOverflowWidgets` 后） | monaco 内联 **11–100** | 编辑器 hover（含 git blame 注解）、suggest + 详情、参数提示、rename 框、内联 message、取色器、post-edit widget；**glyph hover 是 overlay widget**，落在另一个容器里 |
| **D. 视图自绘** | 视图容器内 | absolute / fixed | 局部数字 + 令牌 | terminal 工具栏菜单、提交图设置面板、explorer 右键、scm/outline/timeline 溢出菜单 |

A 与 B 的共同点是**挂在窗口级容器上**，所以永远不会被某个面板的 `overflow` 裁掉：

- A：portal 到 `document.body`，`position: fixed`。
- B：`monacoWorkbenchLayoutService` 覆写 monaco 的 `ILayoutService`，把 hover service / context view / action widget / quick input 的容器从"活动编辑器容器"改成 `#root`（monaco standalone 默认挂编辑器容器，那是 `overflow: hidden` 的）。见该文件头部的说明。

C 曾经是缺口：monaco 的编辑器内容浮层不走 `ILayoutService`，默认 `fixedOverflowWidgets: false` 时 `position: absolute`，包含块是 `.monaco-editor`，于是被最近的 `overflow: auto` 祖先——编辑区的 `.editorContent`——在 editor group 边界切一刀。**所有 `editor.create` 必须走 `createWorkbenchEditor`**（`apps/editor/src/renderer/workbench/editor/monaco/workbenchEditorFactory.ts`），它把 `fixedOverflowWidgets: true` 作为不变式注入；`createDiffEditor` 不用改，monaco 已对其内嵌编辑器强制该选项。漏配由 `workbenchEditorFactory.test.ts` 的源码扫描拦截。

## 三段式分层

`packages/workbench-ui/src/theme/tokens.css` 是 token 的单一真相（数值、取值理由、第三方占位都写在它的注释里），本文不复述数值。分层是三段：

```
视图内局部索引（≤100，字面量）
  <  视图层   --z-view-backdrop / --z-view-overlay
  <  workbench chrome  --z-workbench-chrome
  <  工作台级浮层  --z-popover … --z-tooltip
```

| token | 语义 |
|---|---|
| `--z-view-backdrop` / `--z-view-overlay` | 视图自己的 dismiss 背板，与它上面的模态 / 面板 |
| `--z-workbench-chrome` | 标题栏（含窗口控件、菜单栏、命令中心）——**应用边框** |
| `--z-popover` | 工作台级轻量浮层：quick input、输入建议、状态栏浮层 |
| `--z-dialog` | 模态对话框 + 进度 |
| `--z-dropdown` | 锚定在对话框内的 portal 浮层（`Select`） |
| `--z-toast-center` / `--z-toast` | 通知中心面板 / toast 栈（两者在右下角像素级重合，栈必须在上） |
| `--z-menu` | 菜单家族：右键菜单、溢出菜单、下拉菜单、`AnchoredSurface` |
| `--z-tooltip` | tooltip 与 hover 卡 |

**视图层为什么在 chrome 之下**：视图里的全屏背板一旦压过标题栏，窗口控件（最小化/关闭）就点不到了，点标题栏还会命中背板的关闭回调——应用边框必须永远可达。所以「视图里开的东西」不许越过 chrome，「工作台级浮层」（quick input / 对话框 / 通知 / 菜单 / tooltip）可以。

**判据：一个浮层该不该进这张表，看它能不能盖到自己的容器之外。** 能盖到别的视图、别的区域、别的浮层上的 → 必须用令牌；只在自己容器内竞争（tab 条的拖放指示线、Allotment 的分隔条、子菜单相对父表面、sticky scroll 的层叠、标题栏自己的下拉——`.titlebar` 带 z-index 是个 stacking context，下拉填什么数都出不去）→ 保持局部字面量，**不要** token 化：写进这张表等于宣称它参与全局竞争。

两名守卫：workbench-ui 的 `zIndexContract.test.ts`（阶梯顺序 + 本包 css 与 tsx 内联不得出现 ≥100 字面量）；editor 侧的 `cssVarCoverage.test.ts`（`var(--z-*)` 必须已在 tokens.css 定义 + 字面量不得超过视图内容上限 100）。

## 不在我们手里的层

monaco 与 allotment 自带数字，改不了也不该改：

- monaco 编辑器内 widget 跨 **11–100**（glyph hover 11、参数提示 39、suggest 40、hover 40–50、rename **100**）——全在视图层之下。
- monaco 平台层最高到 **2550**（`.quick-input-widget`），落在 `--z-menu` 与 `--z-tooltip` 之间的空档里：那里什么都没有，也别往里放东西。
- monaco 编辑器内 message 用 **10000**，与 `--z-tooltip` 同层，DOM 顺序决定。
- monaco diff 编辑器内部更高（**10001 / 100000**：隐藏未变更区、revert 按钮、装饰），在我们所有层级之上——diff 视图里浮层被它们压住属正常。
- allotment 的分隔线 **5**、sash **35**。

## 排查一个浮层的问题

1. DevTools 选中浮层节点，看 `position`：`absolute` 且包含块在编辑器里 → 大概率是被某个 `overflow` 祖先裁剪，顺着祖先链找第一个 `overflow != visible` 的元素。
2. 看它所在链路上有没有 `transform` / `filter` / `backdrop-filter` / `contain` / `will-change` —— 任一个都会成为 `fixed` 后代的包含块，让"挂到窗口"的策略失效。
3. 层级对不上时，先确认它用的是哪个 token，再看对手的 token；两边都是字面量就说明有浮层没进阶梯。
4. 右侧是 webview / iframe 时：仓库里的 webview 就是普通 `<iframe>`，浮层**能**整体盖住它（同文档合成），但盖不进它的文档内部——iframe 内的 tooltip、菜单不受我们控制。
