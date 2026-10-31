# cases-preview.md

本文从 `workbench/markdown/CLAUDE.md` 拆出，范围是**线②预览渲染**的增强复盘：vimium 式 link hints 键盘导航、本地图片渲染的 markdown 侧接线（`universe-app` scheme 机制本身在 `docs/development/app-protocol.md`）、LaTeX 数学公式。改 `MarkdownView.tsx` / `useMarkdownLinkHints.ts` / `resourceUri.ts` / `MathNode.tsx` 前通读。

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

## LaTeX 数学公式（KaTeX）

语法对齐 VSCode `markdown-math`：`$…$`、`$$…$$`、```` ```math ````；**不支持** `\(...\)` / `\[...\]`。渲染链路：自研 parser 出 AST → `MathNode` 调懒加载的 KaTeX → `dangerouslySetInnerHTML`。所有 `MarkdownView` 消费方（预览、ACP 聊天、文档中心、发行说明）默认开启；只有文件预览受 `markdown.math.enabled` 控制。

- **AST / 解析**（`services/acp/markdownRenderer.ts`）：新增 `math_block`（块级）与 `math_inline`（行内，`display` 区分 `$$`）。`ParseMarkdownOptions.math` 省略 = 开启，显式 `false` 关闭；`toChildOptions` 必须传播 `false`，否则列表/引用递归会把关闭的数学重新打开。`inlineToText` 用原始 TeX，标题 slug / 大纲文本保持稳定。
- **块级边界**：行首 0–3 空格 + `$$` 才开块；`$$$`/`$$$$`（长 dollar 串）与一行内出现 ≥2 个 `$$` 对不按块处理，避免流式半截文本吞掉后文。剩余部分含 1 个 `$$` 且其后只有空白 → 单行块；否则向下找闭符（行尾 `$$` 优先，闭符后同行文本丢弃），未闭合到 EOF（流式容错）。块内不做任何 Markdown 解析，围栏/空行都是 TeX。
- **列表项特例**：`- $$`（多行开符）要把首行剩余内容移入 item 的 child block（`mathAsChild`），否则 `$$` 会被当行内文本；`- $$x$$`（单行）仍走行内 display。`childStart = itemLine` 保证嵌套块行号仍是绝对行号。
- **行内边界**：开符前一字符不能是 `$`/`\`，且须为开头、空白或非 ASCII 单词字符（CJK 可紧邻）；闭符后一字符不能是 ASCII 单词字符。只认**第一个**未转义 `$`，它不合法就整段按字面处理（对齐 markdown-it-katex，避免 `$a$b$c$` 拉到最后）。`$` 加入转义集（`\$` 永远可转义）。`$` 在 code span 之前处理，反引号内仍是代码；公式内部不再解析 Markdown。
- **流式增量**（`services/acp/markdownIncremental.ts`）：`lastSafeSplit` 改用 `mathBlockMask(lines, mathEnabled)` 的 `insideMath | insideFence`，数学态**优先**于围栏态（块内 ``` 是 TeX，围栏内 `$$` 是代码）。mask 与 parser 共用 `matchMathBlockStart` / `matchMathBlockClose`；`parseMarkdownStreaming` 的第四个参数必须与 parse options 的 `math` 一致，否则 `math:false` 时 `$$` 会被误当成公式、围栏内的空行被当成安全切点。**坑（列表作用域）**：`- $$` 与缩进 opener 的数学属于列表 item，遇到 dedent / 不跟缩进内容的空行时 item 与公式同时结束，而该 dedent 行可能另起公式。mask 不复制 parser 的列表递归：`- $$` 的开符列（`markerWidth`）可精确判定，dedent 后从该行重新分类（但 EOF 处的尾随空行仍算公式内，因为后续 chunk 可能继续 item）；缩进 opener 无法区分根级与列表子块，遇到 dedent 后**全部标为 inside**（放弃后续切分，绝不渲染错）。`MarkdownView.useMarkdownNodes` 的 cache 以 `frontmatter/math/schemes` 为 option key，key 变化重建 `MarkdownStreamCache`，避免 sealed 前缀与 tail 用不同解析选项。
- **KaTeX 安全边界（红线）**：`mathRenderer.ts` 固定 `trust:false`（`\href`/`\url`/`\includegraphics`/`\html*` 退化为错误文本）、`throwOnError:false`、`strict:'ignore'`、`output:'htmlAndMathml'`、`maxExpand:1000`、`maxSize:100`。**不用 DOMPurify**：KaTeX 已转义文本，DOMPurify 反而会剥掉 MathML。注意：原始 TeX 字符串（如 `javascript:`）可能出现在转义后的 `<annotation>` 文本里，属安全文本；断言注入面要看是否生成了 `href=`/`<img`/`<script>`，而不是字符串子串。`macros` 每次渲染复制一份，`\def`/`\gdef`/`\newcommand` 不跨公式泄漏（也不要设置 `globalGroup`）；跨公式复用走 `markdown.math.macros`。
- **加载与字体**：KaTeX JS 与 `katex/dist/katex.min.css` 都挂在 `mathRenderer.ts` 这个动态 import 的 chunk 上，首屏不背 ~280KB JS / ~24KB CSS 与 39 个 `@font-face`；Vite 在动态 chunk 解析时注入 CSS，字体 woff2 由 Vite 打包到 `out/renderer/assets`。CSP 已允许 `style-src 'unsafe-inline'` 与 `font-src 'self' data:`，`resourceProtocol` 已支持 woff/woff2/ttf。渲染结果未知（加载中/关闭/失败）时显示等宽原始 TeX，不阻塞页面；chunk 加载失败会重置 loader promise，下次挂载可重试。
- **组件**：`MathInlineNode` 永远是 `<span>`（即使 `$$` display 模式）——`<div>` 不能出现在 `<p>` 里；`MathBlockNode` 是 `<div data-testid="md-math-block" data-line>`，承接预览滚动同步。`MathOptionsContext` 由 `MarkdownView` 提供 `{ enabled, macros }`；`markdown.math.macros` 经 `mathOptions.ts` 的 `sanitizeMathMacros` 清洗（丢非字符串值/空 key）。
- **配置**：`contributions/MarkdownConfigurationContribution.ts` 注册 `markdown.math.enabled`（boolean，默认 true）与 `markdown.math.macros`（object，additionalProperties string）。`markdown.math.enabled` 只由 `MarkdownPreviewEditor` 用**精确 key** 的 `affectsConfiguration` 订阅（平台配置服务不做前缀匹配）并作为 `math` prop 传入；`markdown.math.macros` 由 `MarkdownView` 自己订阅配置，因此预览、ACP 聊天、文档中心、发行说明拿到同一套宏，`mathMacros` prop 仅作测试/嵌入方覆盖。
- **测试**：`markdownRenderer.math.test.ts`（块级/行内/边界/mask，含 `- $$` 后 dedent `$$`、缩进 opener 作用域、`math:false` 掩码与 `$$a$$$ b$$` 首个候选失败）、`markdownIncremental.math.test.ts`（逐字符前缀等价 + 不封存公式内空行 + 列表作用域回归 + `math:false` 掩码参数）、`mathRenderer.test.ts`（trust:false 注入面、宏不泄漏、错误不抛异常、sanitize）、`MarkdownView.math.test.tsx`（span/div 形态、`math={false}`、宏透传、配置宏热更新、懒加载、流式行号、选项切换重建 cache）；e2e `apps/editor/e2e/specs/smoke.markdownMath.spec.ts` 验证三种语法、货币文本、KaTeX FontFace 真实 loaded 和 `markdown.math.enabled` 热切换。
