---
name: scroll-content-ghosting-transparent-backdrop
description: 列表换选中后旧文字与新文字完全重叠且重启才消失=滚动内容无opaque底衬的残影；三处放大因素(透明底/transform定位/scrollIntoView越界滚祖先)
metadata:
  node_type: memory
  type: project
---

Swarm Reviews 侧栏列表用键盘换选中时，同一格出现**新旧文字完全重合**的残影，且一直留到重启。DOM 每格只有一份、文本是受控 React 文本 → 屏幕上的旧字是**没被清掉的旧栅格像素**，不是重复节点。像素残影无法在 CI 断言（happy-dom 无栅格、e2e 截图不可比），只能靠结构护栏 + 分因素消除。

**Why:** 滚动内容里的行全是透明底（`.tree`/`.row`/组头都无 background），底色靠祖先 part 透出；Chromium 可能把 scroller 的内容栅格进自己的层，该层某块 tile 重栅格时**没有 opaque 底衬去覆盖旧字形**，新文字就画在旧字上。另两处放大：行用 `transform: translateY()` 定位（走变换路径，脱离布局/绘制失效路径），reveal 用 `el.scrollIntoView({block:'nearest'})`（**会滚所有可滚动祖先，`overflow:hidden` 的也照滚**，脚本可滚）。

**How to apply:** ①opaque 底衬要打在**滚动内容里**（`VirtualList` 的 spacer `backgroundColor: var(--view-background, transparent)`），打在 scroller 自身或祖先上无效；**谁画自己的背景谁 republish 这个变量**——part 根（`.sidebar`/`.panel`/`.editorArea`）+ **未走 portal 且自绘背景的浮层**（`FocusScopeOverlay` 不 portal，子树仍继承宿主 part 的颜色，已给 `.probeDialog` 补上）；②行定位用 `top` 不用 `transform`（像素等价但 `top` 走正常失效路径）；③reveal 从行几何自算最小滚动量只赋给自己的 scroller，**永不调 `scrollIntoView`**。复现用例必须**先验证它在修复前是红的**（`git checkout HEAD -- <file>` + rebuild 跑一遍），否则只是自证——e2e 那类「底对齐最后一行」的断言旧实现同样能过，别拿它当复现。相关：[[virtual-list-scroll-anchor-restore]]、[[tree-virtualization-threshold-scroll-jump]]
