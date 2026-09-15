# 滚动列表的渲染约定

树 / 虚拟列表（`packages/workbench-ui` 的 `Tree` + `VirtualList`）是全仓侧栏与列表视图的共同底座。本文是它们**绘制**层面的三条约定，以及违反之后那一类最难查的故障：**残影**——同一格出现新旧两段文字完全重合，且一直留到重启才消失。

残影的判据很简单：**DOM 是干净的**（每格一行、`data-row-key` 唯一、行矩形互不重叠、文本与数据一致），屏幕上的旧字是**没被清掉的旧栅格像素**。因此它不可能被 DOM 断言或截图比对抓住，只能靠约定 + 结构护栏守住，真正的验证是在真机上肉眼看一次。

## 1. 滚动内容必须有不透明底衬

行本身按设计是**透明**的（底色由所在 part 透出），而滚动容器可能被 Chromium 栅格进自己的一块 tile。当这块 tile 局部重栅格时，若滚动内容里没有任何不透明绘制，旧字形就留在 tile 上，新文字直接画上去——两段字完全重合。

约定：

- **底衬打在滚动内容里，不是打在 scroller 上，也不是祖先上。** 唯一落点：`VirtualList` 的 spacer（`backgroundColor: var(--view-background, transparent)`）。打在 scroller 自身或 part 根上时，它们不在同一个绘制层里，起不到覆盖作用。
- **谁画自己的背景，谁就 republish `--view-background`。** 现在有两类承载面：
  - part 根：`.sidebar` / `.panel`（`PaneComposite.module.css`）、`.editorAreaRoot` / `.editorArea`（`EditorArea.module.css`），值各自取本 part 的背景色。
  - **未走 portal 的浮层**：`FocusScopeOverlay` 没有自己的 DOM 节点，它的子树仍留在宿主 part 里（本仓的对话框大多如此），于是会继承到宿主的颜色。这类浮层若自己画了背景，必须在自己的根节点上 republish 成那层背景色——否则里面的列表会把宿主 part 的颜色盖到浮层上（`AiSettingsEditor.module.css` 的 `.probeDialog` 就是先例）。
- `:root` 里的默认值是 `transparent`，所以**默认行为 = 从前**：portal 到 `document.body` 的浮层（`DialogHost` / quick input / 菜单 / 通知）落在所有 part 之外，取到透明默认值，不受影响，也不需要设这个变量。
- **新增承载面要按上面两条自己判断**。漏了不会报错：要么该 part 里的列表退回「透明滚动内容」（残影那类问题回来），要么浮层被涂成宿主的颜色。

## 2. 行定位用 `top`，不用 `transform`

行是 `position: absolute` 定位在 `position: relative` 的 spacer 里，`top: Npx` 与 `translateY(Npx)` 像素等价。但 `transform` 走属性树，**脱离布局/绘制失效路径**：当一行的偏移和内容在同一帧里一起变化时，旧位置的失效矩形是按新变换推出来的，可能漏掉，于是旧字形留下来。`top` 把位移变成一次普通布局变化，两个矩形都会被正确失效。

同理，`VirtualList.getStableStyle` 按 index 缓存样式对象（保持行可 memo），改动它时别顺手把 `top` 换回 `transform`。

> 手写虚拟化列表还没跟上这条：`feedback/quickInput/QuickInputPanel.tsx` 与 `workbench/agents/ChatBody.tsx` 各自持有一套 `translateY` 定位（ChatBody 还叠了流式高度收敛 + 滚动锚点循环，改它要单独评估）。本文的约定对 `VirtualList`/`Tree` 成立。

## 3. reveal 只滚自己的 scroller，禁用 `scrollIntoView`

`Tree` 的 reveal（`setSelection` 带 `reveal: true`）从行几何算出最小滚动量，直接赋值给自己那个滚动容器，**从不调用 `element.scrollIntoView`**——那个 API 会滚**所有**可滚动祖先，`overflow: hidden` 的盒子也不例外（脚本照样能滚）。后果有两层：一是选中一行会顺带把外层容器或文档挪走；二是「滚动位移 + 同帧内容变化」正是残影最容易出现的组合（外层动了、已经栅格好的区域没动，两帧叠在一起）。

几何算法同时覆盖了窗口化分支（目标行还没被渲染、取不到 DOM 元素）——这是它取代 `scrollIntoView` 的第二个理由。它假设 scroller 自身无 padding（每个宿主都是无 padding 的 flex 列、唯一子节点是 spacer）；给某个 tree 容器加 `padding-top` 会让所有 reveal 偏移同样的距离。

> 同样是手写路径：`list/useFlatListNavigation.ts` 的 `revealRow` 仍在 `row.scrollIntoView({ block: 'nearest' })`（快捷键表 / 扩展视图 / AI Debug / 会话列表）。同一类暴露，但那条路径的滚动容器由调用方传入、覆盖四个高频视图，改动要单独评估——**这里先记着，别当它已经干净**。

## 排查套路

怀疑是残影（而不是 DOM 缺陷）时，在出问题的窗口里打开 DevTools 跑：

```js
const rows = [...document.querySelectorAll('[role="treeitem"]')]
const ys = rows.map((r) => Math.round(r.getBoundingClientRect().top))
console.log(
  'rows=', rows.length,
  'dupKey=', rows.length !== new Set(rows.map((r) => r.dataset.rowKey)).size,
  'dupY=', ys.length !== new Set(ys).size,
)
// 强制重新栅格化：重影消失 = 确认是像素残留，不是 DOM 里真有两份
document.querySelector('#root').style.opacity = '0.999'
```

- 行数 / key / y 全干净 → 像素残留，按上面三条约定查。
- 出现重复行、重复 y 或文本与数据不符 → 是 DOM 缺陷，去查 `TreeModel` 的可见节点与 `Tree` 的行 key 归属。

## 守护

| 约定 | 护栏 |
|---|---|
| reveal 只滚自己的 scroller | `packages/workbench-ui/src/__tests__/Tree.revealScroll.test.tsx` —— spy `Element.prototype.scrollIntoView` 断言从未被调用、且外层 scroller 不动。**把实现换回 `scrollIntoView` 即变红**，这是唯一能证伪该约定的用例 |
| reveal 在真浏览器里仍然有效 | `apps/editor/e2e/specs/smoke.explorerRevealScroll.spec.ts`（滚动到顶后 reveal 把已选中的行带回来） |
| 行定位 / spacer 形状 | `packages/workbench-ui/src/__tests__/VirtualList.test.tsx`（`top` 断言、spacer 契约） |
| 列表重排后仍是「一摞不重叠的行」 | `apps/editor/src/renderer/workbench/swarm/__tests__/SwarmReviewsView.test.tsx` 的 soft refresh 用例（key 唯一、offset 严格递增、换选中不调 `scrollIntoView`）；`extensions/perforce/e2e/specs/swarmReview.spec.ts` 的 dashboard journey 补了真布局版（行矩形互不重叠、`End` 把最后一行底对齐） |

⚠️ e2e 那两条是**真布局护栏，不是复现**：残影本身没有可断言的信号（DOM 一直是干净的），而旧的 `scrollIntoView` 实现同样能通过「底对齐最后一行」这条断言。判断某条用例是否真的守住约定，唯一办法是**把实现改回去跑一遍**（`git checkout HEAD -- <file>` + rebuild），看它是否变红。

注：spacer 的底衬用的是 `var()`，**happy-dom 会丢弃 inline style 里的 `var()`**（那条声明读回空串；若它是该元素唯一的声明，`getAttribute('style')` 直接是 `null`），所以它只能靠代码审查与真机验证，写不成断言。

相关：[浮层层级与裁剪](overlay-layers.md)（浮层挂载与 `--z-*` 分层）。
