---
name: markdown-preview-link-hints
description: "markdown 预览的 vimium 式键盘导航(link hints + 滚动/前进后退),纯 renderer 线②"
metadata: 
  node_type: memory
  type: project
  originSessionId: d7080423-794f-4974-8916-b46829d36e07
---

markdown 预览(`MarkdownPreviewEditor`)加了 vimium 风格键盘导航,属 markdown 子系统**线②预览渲染**(纯 renderer,不碰插件/LSP)。

**Link hints**:`f` 在所有可视 `a[href]` 上叠加 home-row 短标签(`asdfghjkl`),输标签即跟随;`F`(shift+f)在侧边/新标签打开(等同 ctrl/cmd+click)。
- 标签算法 `workbench/editor/markdownLinkHints.ts`:vimium 式 BFS 变长前缀码(offset 指针保证前缀无关 + sort+reverse 打散)。**坑**:count=1 须 `|| hints.length===1` 强制展开,否则返回空 label。
- 交互 hook `workbench/editor/useMarkdownLinkHints.ts`:扫描可视链接→分配标签→**document capture 阶段**接管键盘(逐字符过滤/Backspace/Esc/非字母键取消)→激活时向 `<a>` 派发合成 click(复用预览既有 onClick 全部路由,零重复)。
- 注意:开启 hints 走 keybinding service(`f`→Action2),hints 自身过滤/激活/取消走 hook 的 capture 监听器,**两条独立路径**。

**关键集成点**(对标 find 的对称结构):
- Action2 在 `actions/markdownActions.ts`,`actions/index.ts` 注册。when 门控 `markdownPreviewFocused && !find && !linkHints`。
- controller 方法挂 `IMarkdownPreviewController`(`services/editor/MarkdownPreviewRegistry.ts`),`MarkdownPreviewEditor.tsx` 经 ref 转发(同 findRef 套路)。
- context key `markdownPreviewLinkHintsVisible`。
- 焦点对账修复:controller effect 挂 focusin 监听后须主动对账 `el.contains(activeElement)` 一次,否则自动聚焦的 focusin 早于监听器挂载被漏(预览打开即按 f 无效)。

**依赖**:裸 `f` 键能触发,前提是 `editorTextFocus` 不残留 true,见 [[editor-text-focus-stuck-swallows-keys]]。

**e2e**:`smoke.markdownPreview.spec.ts`,用真实键盘(非 runCommand),helper 先 bringToFront + 仅在未生效时重按。hint 标签 DOM 带 `data-testid=md-link-hint` + `data-link-label`。

**How to apply**:扩展键盘导航(滚动 j/k/gg/G、前进后退 H/L 等)继续走线②,复用 controller+contextKey+Action2 对称结构。详见 skill markdown-subsystem-context(线②)。
