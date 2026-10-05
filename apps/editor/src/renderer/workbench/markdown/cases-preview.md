# cases-preview.md

本文从 `workbench/markdown/CLAUDE.md` 拆出，范围是**线②预览渲染**的两处增强复盘：vimium 式 link hints 键盘导航、本地图片渲染的 markdown 侧接线（`universe-app` scheme 机制本身在 `docs/development/app-protocol.md`）。改 `MarkdownView.tsx` / `useMarkdownLinkHints.ts` / `resourceUri.ts` 前通读。

## link hints（`f` 键跟随链接）

`f` 在可视 `a[href]` 上叠 home-row 短标签（`asdfghjkl`），输标签即跟随；`shift+f` 在侧边/新标签打开（等同 ctrl/cmd+click）。

- **标签算法**（`workbench/editor/markdownLinkHints.ts`）：vimium 式 BFS 变长前缀码——`offset` 指针让「已展开的前缀」与队列尾部脱钩，从而保证前缀无关；结果按「先反转字符串再 sort、再反转回」打散，让短标签均匀分布。**坑**：循环条件必须带 `|| hints.length === 1`（`markdownLinkHints.ts:31`）强制首次展开，否则 `count === 1` 时单个链接拿到空 label、提示不可见。
- **交互 hook**（`workbench/editor/useMarkdownLinkHints.ts`）：扫描可视链接 → 分配标签 → **document capture 阶段**接管键盘（`document.addEventListener('keydown', onKeyDown, true)`，`useMarkdownLinkHints.ts:166`；逐字符过滤 / Backspace / Esc / 非字母键取消）→ 激活时向 `<a>` 派发**合成 click**，复用预览既有 onClick 的全部路由（零重复）。滚动/resize/blur 即 dismiss——陈旧坐标比没有提示更糟。
- **两条独立路径**：开启 hints 走 keybinding service（`f` / `shift+f` → Action2），hints 自身的过滤/激活/取消走 hook 的 capture 监听器。别指望用一条路径统一。
- **Action2 门控**：`actions/markdownActions.ts` 的 `LINK_HINTS_WHEN` = `markdownPreviewFocused && !markdownPreviewFindVisible && !markdownPreviewLinkHintsVisible`。
- **焦点对账（已修勿回退）**：controller effect 挂 `focusin` 监听后必须**主动对账一次** `el.contains(el.ownerDocument.activeElement)`（`useMarkdownReaderNav.ts:171`）——自动聚焦的 `focusin` 早于监听器挂载、会被漏掉，症状是「预览打开后直接按 f 无效」。
- **装配**：`useMarkdownReaderNav` 统一装配预览与内置文档中心（`MarkdownPreviewEditor.tsx` / `DocEditor.tsx` 各一行），controller 仍挂 `IMarkdownPreviewController`（`services/editor/MarkdownPreviewRegistry.ts`，keyed by registryUri）。**旧记述「MarkdownPreviewEditor 经 ref 转发」已不成立**。扩展键盘导航（`j/k/gg/G/h/l` 滚动、`H/L` 前进后退、find、help）复用同一 controller + contextKey + Action2 对称结构。
- **依赖（别批）**：裸 `f` 能触发的前提是 `editorTextFocus` 不残留 true，见 `editor-text-focus-stuck-swallows-keys`。
- **e2e（锚点已变更）**：spec 现为 `extensions/markdown/e2e/specs/markdownPreview.spec.ts`（`apps/editor/e2e/specs/` 下已无此 spec）。用真实键盘而非 runCommand：helper `showLinkHints` 先 `bringToFront`、仅在未生效时重按 `f`；标签 DOM 带 `data-testid="md-link-hint"` + `data-link-label`。doc center 共用同一套 hints。

## 本地图片（markdown 侧接线）

- **解析层放行边界**：旧 `markdownRenderer.isSafeHref` 只放行 http(s)/file/data:image，**相对路径根本进不了 AST**；现由 `isImageSrc` 放行本地路径（相对/绝对/file://），仍拒 `javascript:` / `vbscript:` / 非图片 `data:`。**Windows 盘符 `C:\a.png` 不算 scheme**——scheme 检测要单独排除 `/^[a-z]:[\\/]/i` 形状，别只写 `^[a-z][a-z0-9.+-]*:`。锚：`services/acp/markdownRenderer.ts:802/824`。
- **两处 allowRoots**：`MarkdownView` 顶层 effect 经 `IResourceAccessService.allowRoots` 声明 `[文档目录, workspaceRoot]`（`MarkdownView.tsx:128-139`）——两者都要给，漏一个则相对/绝对路径被 403 拒。
- **单点 URI 转换**：`workbench/markdown/resourceUri.ts` 的 `asPreviewResourceUri(src, baseUri, workspaceRoot)` 在 `MarkdownView.InlineImage` 一处转换（`MarkdownView.tsx:509`）；不认识的 src 返回 `undefined` 即不渲染。`defaultRenderImage` 与 ACP 的 `ChatImage` 共用这一层——**改这里两个消费方同时受影响**（跨批：`services/acp/cases-prompt-images.md`）。
