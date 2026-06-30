---
name: dirty-diff-inline-peek
description: 在 standalone Monaco 里制作"内联 diff peek / 嵌入式 diff 浮层"类功能时召回——把一个真 Monaco diff editor 嵌进编辑器某行下方的浮层（VSCode ZoneWidget/QuickDiffWidget 等价物），拿到双侧行号+语法高亮+内部滚动。当任务涉及 dirty-diff 色条点击弹 peek、内联展示 HEAD↔当前/任意两文本的 diff、给 peek 加动作栏/导航/Revert/Stage、Esc 关闭浮层、浮层初始限高+拖动调整、变更出视口自动滚入、或要复刻 VSCode QuickDiffWidget 的布局公式时使用。给出 overlay-widget+空view-zone 的渲染骨架、三套照搬 VSCode 的布局公式、context-key/host-registry/Esc 接线、E2E 套路与易踩坑。区别于 register-monaco-command（接命令）/ fix-keybinding-not-firing（键不触发诊断）：本 skill 是"造一个内嵌 diff 浮层并把交互接齐"。
disable-model-invocation: true
---

# 内联 diff peek（standalone Monaco 的 ZoneWidget 等价物）

在某行下方弹一个浮层，里面是一个**真 Monaco diff editor**。这是 VSCode `QuickDiffWidget`（基于 `PeekViewWidget`/`ZoneWidget` + `EmbeddedDiffEditorWidget`）的功能；我们是 **standalone monaco**，VSCode 那些私有 PeekView/embedded-diff 模块被 tree-shake 掉了，但 **`monaco.editor.createDiffEditor` 在 standalone 完全可用**（`DiffEditor.tsx` 已证），所以直接内嵌一个 diff editor，**双侧行号 / 语法高亮 / 内部滚动 / reveal 全部白拿**。

> ⚠️ 第一原则：**不要手写 DOM diff**。本仓库初版踩过这个坑——用 content-widget + `computeLineDiff` 渲染增删行 HTML，结果无语法高亮、宽度被内容撑不满宽、长 diff 撑爆。终版改内嵌 diff editor 后这些问题一次性消失。手写那套已全删，别回退。参考实现就是 dirty-diff peek（见末尾路径），照抄它的骨架。

## 核心渲染骨架：overlay-widget + 空 view-zone 占位

VSCode `ZoneWidget` 的精髓不是把内容塞进 view-zone 的 DOM（那层**不可交互、不满宽、不可滚**），而是：

1. **空 view-zone 占位**——只为在文本流里"撑出"垂直高度（把下方代码推开），DOM 节点是个空 div。
2. **overlay-widget 渲染真面板**——overlay 在编辑器的可交互、可滚动层，能满宽（盖住行号区）、按钮可点、滚轮可用。
3. **view-zone 的 `onDomNodeTop`/`onComputedHeight` 回调驱动 overlay 的 `top`/`height`**——让浮层随滚动贴着占位带走。

```
overlay DOM = 面板（header 动作栏 + body 容器 + 底部拖动手柄）
              position:absolute; z-index:10; 初始 top:-1000px（等回调定位，免闪烁）
  ├─ body 里 createDiffEditor(...) ← 真 diff editor
空 view-zone（afterLineNumber = 变更末行, heightInPx = 面板高, domNode = 空div）
  ├─ onDomNodeTop(top)      → node.style.top = top
  └─ onComputedHeight(h)    → node.style.height = h; 重排内嵌 diff editor
```

overlay 自身定位返回 `getPosition: () => null`（自管位置）。teardown 时务必 `removeOverlayWidget` + `changeViewZones(removeZone)` + diff editor `setModel(null)`+`dispose()` + 两个临时 model `dispose()`。

## 三套照搬 VSCode 的布局公式（别自创）

全部来自 `vscode/src/vs/editor/contrib/zoneWidget/browser/zoneWidget.ts` + `quickDiffWidget.ts`，直接抄：

1. **overlay 横向定位**（满宽、不压滚动条、盖住最左行号区）：
   ```
   left  = (minimap 在左 ? minimapWidth : 0)         // 一般 0
   width = info.width - info.minimap.minimapWidth - info.verticalScrollbarWidth
   ```
   用 `editor.getLayoutInfo()`。订阅 `onDidLayoutChange` 重算。

2. **高度：初始限高 + 可拖动**（VSCode `showChange` + ZoneWidget `_getMaximumHeightInLines`）：
   ```
   初始 = clamp( 变更高 + 上下文(~6) + headerLines,  下限8,  floor(编辑器行数/3) )
   拖动上限 = floor(编辑器行数 * 0.8)
   编辑器行数 = getLayoutInfo().height / fontInfo.lineHeight
   ```
   拖动：底部放一条 `ns-resize` 手柄，`mousedown`→全局 `mousemove`，把 px 增量换算成**取整行增量**（`delta<0?ceil:floor`）再 clamp，改 `heightInLines` 后 `changeViewZones(accessor.layoutZone(id))` 重排。E2E 用的 `resizeByPx(deltaPx)` 走同一套数学。

3. **出视口才滚入**（VSCode `revealRange`）：
   ```
   editor.revealLineInCenterIfOutsideViewport(region.endLine)
   ```
   内嵌 diff editor 侧：`onDidUpdateDiff` 一次性回调里 `getModifiedEditor().revealLineInCenter(变更首行)`，让长 hunk 打开时滚到首个改动行。

## 内嵌 diff editor 的关键 options

```ts
createDiffEditor(bodyEl, {
  automaticLayout: false,            // 自己 layout（随 view-zone 高/编辑器宽）
  readOnly: true, originalEditable: false,
  renderSideBySide: false,           // 内联模式（VSCode quick diff 同款）
  renderOverviewRuler: false, renderMarginRevertIcon: false,
  minimap: { enabled: false }, folding: false, stickyScroll: { enabled: false },
  diffAlgorithm: 'advanced', ignoreTrimWhitespace: false,
  lineNumbers: 'on',                 // 双侧行号
  fontFamily/fontSize/lineHeight: 取宿主 editor 的 EditorOption.fontInfo,  // 字体一致
  scrollbar: { alwaysConsumeMouseWheel: true, ... },  // 滚轮不穿透到宿主编辑器
})
```
两个临时 model 用唯一 scheme（如 `dirtydiff-peek://original/<seq>`），`setModel({original, modified})`，每次重开 +seq 防撞。

## 把交互接齐（Esc / 命令 / E2E）：context-key + host-registry

浮层是命令式 DOM，不在 React 树里，命令/键位/探针够不到它——用**模块单例 registry** 暴露 host（仿 `MarkdownPreviewRegistry`）：

1. **host-registry**（`DirtyDiffPeekRegistry`）：`setHost/clearHost/getHost`，host 接口暴露 `openAtLine/closePeek/isPeekOpen/...`。承载浮层的 contribution 在绑定活动编辑器时 `setHost(this)`，dispose 时 `clearHost`。任一时刻至多一个 host。
2. **context-key**（`dirtyDiffPeekVisible`，VSCode 叫 dirtyDiffVisible）：contribution 用 `contextKeyService.createKey` 建，开/关 peek 时 set；**所有关闭路径统一走一个 `closePeek()`** 同步清 key（别散落多个 `controller.close()`，会漏清）。
3. **Esc 命令**（`CloseDirtyDiffPeekAction`）：`keybinding{ primary:'escape', when:'dirtyDiffPeekVisible', weight: WorkbenchContrib+50 }`——**weight 必须压过** Monaco 的 Esc 和工作台 `FocusActiveEditorGroupAction`（Esc @ WorkbenchContrib=200），否则编辑器没聚焦时被它抢走。run 里 `DirtyDiffPeekRegistry.getHost()?.closePeek()`。`registerAction2` 在 `actions/index.ts`。
4. 同理可加"在光标处打开 peek"命令（`ShowChangeAtCursorAction`）。

## E2E 套路

浮层在 overlay 层、命令式，**用 probe + host introspection 验，别靠 DOM 选择器**：probe 加 `openDirtyDiffPeekAtLine/getDirtyDiffPeekState(panelHeightPx,maxHeightPx,editorFirstVisibleLine)/isDirtyDiffPeekVisible/resizeDirtyDiffPeekByPx`（contract.ts 同步加类型）。spec 用真 git 仓库 + 长文件，在**远离顶部**处造一大块改动（既超 1/3 初始上限、又初始在视口外），一次断：①`panelHeightPx>0 且 ≤maxHeightPx`（封顶）②`editorFirstVisibleLine>1`（滚入视口）③`resizeByPx(大值)` 增高且不超上限 ④真 `page.keyboard.press('Escape')` 后 `isDirtyDiffPeekVisible()` 变 false。Esc 必须用**真键盘**（走 useGlobalKeybindingHandler 全链），别用 runCommand 绕过。

## 易踩坑速记

1. **别手写 DOM diff**（头号）：standalone 能 `createDiffEditor`，内嵌它，白拿行号/高亮/滚动。手写无高亮、不满宽、长 diff 撑爆。
2. **overlay 而非 content-widget**：content-widget 宽度被内容撑、不满宽、且不在可滚层；必须 overlay-widget + 空 view-zone 占位。
3. **滚轮穿透**：内嵌 diff editor 不设 `scrollbar.alwaysConsumeMouseWheel:true`，滚轮会穿到宿主编辑器，浮层内滚不动。
4. **Esc 抢不到**：weight 不够会被工作台/Monaco 的 Esc 截胡；用 `WorkbenchContrib+50`、`when` 挂 context-key。
5. **context-key 漏清**：多条关闭路径各自 `close()` 会漏 set false，下次 Esc 失灵；收敛到单一 `closePeek()`。
6. **布局随变化重算**：订阅 `onDidLayoutChange` 重算 left/width 并 `layout()` 内嵌 editor；拖动后 `layoutZone`。
7. **临时 model/editor 泄漏**：teardown 必须 dispose diff editor + 两个 model + 移除 overlay/zone。盯 disposable-leak（见 [fix-disposable-leak]）。
8. **E2E 跑 `out/` 产物**：改 renderer 后必 `pnpm --filter @universe-editor/editor build` 再跑 spec，否则 probe 新方法 `is not a function`。
9. **gutter 点击区**：色条只有 3px 难点中——加透明 `::before` 命中区 + hover 加宽（VSCode 6px hover glyph 同款）。
10. **region↔HEAD 行映射**：peek 要 HEAD 侧文本/Revert/Stage，靠 `DirtyDiffRegion.originalStartLine/originalEndLine`；added 的 original 范围为空（end<start），`originalStartLine`=插入点前 HEAD 行（0=文件头），deleted 文件头特例 `originalStartLine===1`。

## 验证

```bash
pnpm check                                          # lint+typecheck+test，仅看错误
pnpm --filter @universe-editor/editor build         # e2e 跑 out/ 产物，改 renderer 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts smoke.dirtyDiffPeek
pnpm --filter @universe-editor/git build            # 若动了 Stage 后端（git 扩展 dist）
```

## 关键参考路径（dirty-diff peek 就是范例实现）

- `apps/editor/src/renderer/workbench/scm/dirtyDiff/InlineDirtyDiffController.ts` —— 渲染骨架 + 三套布局公式 + 拖动手柄 + 内嵌 diff editor（**抄这个**）
- `apps/editor/src/renderer/workbench/scm/dirtyDiff/DirtyDiffPeekRegistry.ts` —— host-registry 模块单例范式
- `apps/editor/src/renderer/contributions/DirtyDiffContribution.ts` —— 注册 host + context-key 维护 + 鼠标命中开关 + Revert/Stage/OpenChanges
- `apps/editor/src/renderer/contributions/dirtyDiff.ts` —— `DirtyDiffRegion`（含 original 行范围语义）+ `computeDirtyDiffRegions`
- `apps/editor/src/renderer/actions/dirtyDiffActions.ts` —— `CloseDirtyDiffPeekAction`(Esc)/`ShowChangeAtCursorAction`/导航命令；`actions/index.ts` 注册
- `apps/editor/src/renderer/workbench.css` —— `.inline-dirty-diff*`（overlay 定位/手柄）+ `.dirty-diff-gutter`（点击区放大）
- `apps/editor/src/renderer/workbench/editor/DiffEditor.tsx` —— standalone `createDiffEditor` 用法参照（model 生命周期/viewState）
- `apps/editor/src/renderer/e2e/probe.ts` + `apps/editor/src/shared/e2e/contract.ts` —— peek 探针四方法 + 类型
- `apps/editor/e2e/specs/smoke.dirtyDiffPeek.spec.ts` —— 封顶/滚入视口/拖动/Esc 冒烟
- Stage 后端：`extensions/git/src/hunkPatch.ts`(`selectHunkPatch`)/`repository.ts`(`stageChange`)/`gitService.ts`(`gitExec` stdin)/`packages/extensions-common/src/dirtyDiff.ts`(命令常量)
- VSCode 对照源：`vscode/src/vs/workbench/contrib/scm/browser/quickDiffWidget.ts` + `vscode/src/vs/editor/contrib/zoneWidget/browser/zoneWidget.ts`
- 相关 memory：[[dirty-diff-inline-peek-feature]]（功能状态/索引）、[[linediff-myers-perf]]（region 计算的 Myers 约束，**仅 gutter region 用，peek 面板不用**）
- 相关 skill：[fix-disposable-leak]（peek 的 model/editor 生命周期）、[register-monaco-command]（接命令）、[fix-keybinding-not-firing]（Esc 不触发时诊断）

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件
