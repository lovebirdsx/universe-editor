# cases-prompt-images

> 本文是 `services/acp/CLAUDE.md`「输入框」的纵切案例：ACP 输入框的**图片输入**——三入口（粘贴/拖拽/附件按钮）、能力降级与限额、88×88 共享 `ChatImage` 控件与锚定预览弹窗、恢复含图 session 卡死的根因、恢复图片显示为图片的渲染链路、tracer 大帧防护。@/# 药丸引用见 [cases-prompt-ref-pills.md](cases-prompt-ref-pills.md)；Monaco 输入框编排见 [cases-prompt-input-monaco.md](cases-prompt-input-monaco.md)。

## 三入口、能力降级与限额

- 三入口：Ctrl+V 粘贴（EditContext 下由主进程剪贴板兜底 `acceptClipboardImage`）/ OS 拖入图片文件（`acceptImageFiles`）/ 应用内拖入图片 URI（`acceptImageUris`）。渲染侧本来就支持（`MessageContent` 的 ImageBlock 渲染），本功能**只补输入侧**；整条管线镜像 SelectionContext 套路。
- 核心纯函数集中 `services/acp/promptImage.ts`：`PromptImage` / `ImageLimits` / `validateImage`（→ `ImageRejectReason`：`unsupported-type` / `too-large` / `too-many`）/ `composeImageBlocks` / `blobToPromptImage`（OS File）/ `bytesToPromptImage`（URI 读取）/ `mimeTypeForFileName` / `isSupportedImageMime`（`SUPPORTED_IMAGE_MIME`）。发送链路 `sendPrompt(text, refs, contexts, images)`。
- 能力降级：agent `promptCapabilities.image !== true` → 三入口禁用 + Info 通知（`acp.image.unsupported`）。observable `session.imageSupported` 在 `session/acpSession.ts` 从 initialize 响应里 `caps?.image === true` 缓存。
- 限额可配：`acp.prompt.image.maxSizeMB`（默认 5）/ `acp.prompt.image.maxCount`（默认 5），`PromptInput.tsx` 读成 `ImageLimits`（`maxBytes` / `maxCount`）。一批多文件按「接受即增长」的计数裁剪（快照起始数、逐个 accepted 增长），超限只报**一条** Warning（第一个拒绝原因），不逐条刷屏。

## 拖拽落输入框：两个必踩坑

- **坑 A（早 return 未 preventDefault）**：早期 `onPromptDrop` 未命中时直接 return，drag 事件继续冒泡到 `EditorGroupView` → 拖进输入框反而**打开了图片文件**。
- **坑 B（Explorer 内部拖拽没有 File）**：应用内拖拽只带 `text/uri-list`，`dataTransfer.files` 为空 → 必须走 `IFileService.readFile` 读字节（`acceptImageUris` + `bytesToPromptImage`）。反过来，OS 外部拖入时 `files` 里有真 File（走 `acceptImageFiles`），此时**不能再按 URI 读一遍**（会双附件）。
- 修法（`PromptInput.tsx` 的 `onPromptDrop`）：开头先 `if (!dragContainsResources(e.dataTransfer)) return`，命中后**立即** `preventDefault() + stopPropagation()`——即便这次 drop 最终不被消费，也绝不能冒泡到编辑器组 body（打开文件）或触发浏览器 navigate-to-file 默认行为。
- 对照：`onPromptDragOver` 只 `preventDefault()`、**刻意不 stopPropagation**——同屏托管在编辑器组里时，body 的 dragover 还要跑，好让它判断指针在输入框内并清掉「open here」高亮；两处都 stop 会两处同时发亮（该分工写在 `PromptInput.tsx` 的注释里）。

## 撤销/重做：图片附件是独立撤销栈

- **为什么不能靠 Monaco**：图片只活在 `PromptInput` 的 React state（`images`），从不进文本模型；`Ctrl+Z` 只动 Monaco 历史，图片 chip 分毫不动。纯逻辑栈 `services/acp/promptImageUndo.ts` 补齐：`recordAttach(added, altVersion)` / `canUndo` / `undo` / `canRedo` / `redo` / `dropEntriesFor(ids)` / `invalidateRedo` / `reset` / `state`，栈深 50。
- **两条历史按 `alternativeVersionId` 交织**：三处 attach 在**手势发起时**读 `getAlternativeVersionId()` 记为条目版本（异步读取虽在 await 前取，但版本语义正是「贴图那一刻」，读取期间打的字必须先被撤销）；条目只在「当前版本 === 条目版本」时可消费。attach 后打字会推高版本 → `Ctrl+Z` 先让 Monaco 撤文本；撤回到 attach 时的版本后，下一次 `Ctrl+Z` 才轮到图片。`altVersion === undefined`（编辑器未就绪）或 **generation 已变**（读取期间发生过 `reset()`，如提交/`setText`）的 attach 一律不记录——否则会在栈顶留下永远不可消费的条目，堵死下面所有历史。不记录仍会清空 redo 分支。这样新旧操作按时间顺序撤销，又不必教 Monaco 认识非文本编辑。
- **按键路由**：`AcpChatWidgetService` 按 **focused widget** 聚合 context key `acpPromptImageUndoAvailable` / `acpPromptImageRedoAvailable`；Action2 `UndoPromptImageAction` / `RedoPromptImageAction`（`ctrl+z` / `ctrl+y` + `ctrl+shift+z`，weight `ACP_SCOPED_KEY_WEIGHT`，`f1:false`，`when` 额外要求 `acpPromptInputFocused`）只在可撤/可重做时抢占。不可用时绑定不参与仲裁，`MonacoDefault` 的 `undo` 继续 defer 给 Monaco——纯文本撤销与截图前完全一致。
- **无效化**：新 attach 清空 redo；手动点 × 删 chip → `dropEntriesFor([id])`（否则 `Ctrl+Z` 会把它复活）+ `invalidateRedo`；任何新编辑（用户键入，或 `insertRef` 这类程序化插入——它会推高版本并丢弃 redo）都 `invalidateRedo` 并重算 key；`setText` 走 `setValue` 清掉 Monaco 历史后经 `onDidResetHistory` → `reset()`（并推高 generation）；提交即使缓冲区已空也调 `handle.clearHistory()` 硬重置（`setText('')` 在等值时是 no-op）。
- **undo/redo 不算用户输入**：`onEditorChange` 对 `source === 'undo' | 'redo'` 只镜像 text/caret + `syncImageUndoState()`，不关历史弹窗、不触发 `@@`/`@#` 选择器、不重置 popover dismiss（见 [cases-prompt-input-monaco.md](cases-prompt-input-monaco.md)）。
- 测试：`__tests__/promptImageUndo.test.ts`（门控/批量/LIFO/prune/无效化/栈深/generation）；`PromptInput.test.tsx` 覆盖程序化插入后 key 重算；e2e `smoke.acpPasteImage.spec.ts` 的真实按键路径（I1 撤/重贴、I2 先图片后文本、I3 新编辑使 redo 失效）。`selection contexts`（`contexts` 列表）刻意未纳入撤销——其添加路径是 `setText` 语义改写，已知不一致。另外，attach 图片不会清 Monaco 的文本 redo 分支（Monaco 无公开的「只清 redo」API），但两栈按 `altVersion` 门控，不会出现顺序倒置，属可接受取舍。

## 共享控件 ChatImage：88×88 缩略图 + 锚定预览弹窗

- `workbench/agents/ChatImage.tsx`：消息图（`MessageContent` 的 ImageBlock）与附件缩略图（`PromptImageChips`）共用。
- 缩略图 88×88（`object-fit: contain` 保长宽比）；点击开**锚定预览弹窗**，刻意**不做全屏 lightbox**（全屏挡视线）。
- 定位方案：`createPortal` 到 body + `position: fixed`（绝不放进会被聊天区 overflow 裁剪的滚动容器）；`useLayoutEffect` 量 anchor（`getBoundingClientRect`）与弹窗尺寸后在视口坐标里算 left/top；上方放不下自动翻到下方 + 水平 clamp；首帧 `visibility: hidden`（先测再定位，避免闪跳）。
- 尺寸：小图保底、大图封顶到窗口尺寸、中间按原像素；被 clamp 到最大尺寸时改为视口居中（lightbox 式）——其余情况贴缩略图。
- 交互：滚轮以**光标为锚**缩放、拖动平移、双击复位、关闭按钮、Esc / 点外关闭。滚动/resize 把弹窗**重新锚回**缩略图而不关闭（聊天新消息会自动 pin 到底，滚动是常态）；缩略图所在行卸载后无锚可跟才关闭。
- testid：聊天消息缩略图 `acp-image-block`；附件 chip `acp-prompt-image-chip`（容器 `acp-prompt-image-chips`）；弹窗 `acp-image-preview-popover`。

## 【红线】恢复含图 session 卡死 = filePathLink 正则灾难性回溯

- 症状：恢复含图 Codex session 卡死。**先排除 tracer**——真实 session 文件（`.codex/sessions/.../rollout-*.jsonl`）里图片只有 ~8.7KB 小 PNG，不是多 MB，tracer 不是本例主因。
- 真凶：`services/acp/filePathLink.ts` 的文件路径正则**灾难性回溯**。codex-acp fork 恢复时把图片降级成 `[@image](data:image/png;base64,<8770字符>)` markdown 文本，inline 解析器对 base64 主体每个跟在 `/`/`+` 后的位置调 `matchFilePathAt`；`(?:SEG+/)*SEG+` 因 `SEG` 字符类**自身包含 `/`** 而退化成 `(a+)+`，对斜杠密集又无合法扩展名结尾的串指数回溯（实测单次 `matchFilePathAt` >35s 不返回）。
- 修法：`SEG` 从 `[^NON_SEG]` 改成 `[^NON_SEG/\\]`（段内排除路径分隔符，与 `REL_SEG` 一致，消除歧义 → 线性），>35s 降到 5ms。
- 回归：`__tests__/filePathLink.test.ts` 的 `does not catastrophically backtrack on a slash-dense data: URL`（4KB 斜杠密集 data URL <1s）。复发自查：往 `SEG`/`CJK_SEG` 家族加字符类前，先确认段内仍排除路径分隔符，别把 `/` 放回去。

## 恢复图片显示为图片（治本，不碰 vendor）

- 现象：用户反馈「Claude 恢复图片正常、Codex 不正常」。根因：codex fork 恢复时把图片降级成 `[@image](data:image/png;base64,...)` 文本，而渲染层 `isSafeHref` 只认 http/file 不认 `data:` → 原样显示一坨长文本（并触发上面的正则卡死）。
- **曾一度改 vendor codex-acp（新增 imageBlockFromUrl 发真 ACP image 块）但被用户叫停**；最终方案是在渲染层解析文本 image，**不改 submodule、无需 `agent:build`**：
  - `services/acp/markdownRenderer.ts` 新增导出 `isImageDataUrl(href)`——**仅白名单 `data:image/*;base64,`**，绝不放行任意 `data:`（防 XSS）；`![alt](url)` 与 `[label](url)` 两种语法遇 image data URL 都产出 `{type:'image',src,alt}` AST 节点（link 分支在 `isSafeHref` / `looksLikeFilePath` 判断**之前**先拦）。增量解析器 `markdownIncremental.ts` 委托 `parseMarkdown`，自动继承。
  - `workbench/markdown/MarkdownView.tsx` 加可注入 `renderImage?(src, alt)` prop + `ImageRenderContext`（默认 `defaultRenderImage` 渲染裸 `<img class=mdImage>`，文档预览用）；image AST 节点经 `InlineImage` 组件的 `useContext` 取渲染器。改这个**共享渲染器**前先读 [workbench/markdown/CLAUDE.md](../../workbench/markdown/CLAUDE.md)。
  - `workbench/agents/MessageContent.tsx` 的 MarkdownBlock 传 `renderImage={renderChatImage}` → `<ChatImage src alt testId="acp-image-block">`，恢复的文本 image 渲染成与 ACP image 块一模一样的缩略图+预览控件。
- 测试：`markdownRenderer.test.ts`（`isImageDataUrl` 白名单/XSS 拒绝 + `![]` 与 `[@image]` 两语法产 image 节点 + 非 image data 仍拒）、`MarkdownView.test.tsx`（默认 `<img>` + `renderImage` 委托）、`MessageContent.test.tsx`（`[@image](data:...)` 渲染成 `acp-image-block` 且原始文本不泄漏）。

## 粘贴图片彻底失效：editContext 吞掉容器内 paste（挂错元素）

- 症状：升级内嵌 Monaco 后粘贴图片完全无反应。曾有一次「修复」把 paste handler 挂在 `ed.getContainerDomNode()`（`_promptEditorInner`）上并加主进程 `IHostService.readClipboardImage` 回退，还配了单测绿——**真实环境从未触发**。
- 真因：`editContext: true` 给内层 `native-edit-context` div 绑了 Chromium EditContext API，**该元素及其 Monaco 子树内的 DOM 祖先都不再向普通 `addEventListener('paste')` 派发**；只有 `document` 层与 **Monaco DOM 之外**的 React 宿主 div（`_promptEditorHost` / drop-host）在 **capture 阶段**能可靠收到。单测 stub `<textarea>` 的合成 `fireEvent.paste` 绕过了真实 EditContext → 假绿。通用规范（键盘/剪贴板/输入类监听的挂载纪律）见 [docs/development/monaco-embedding.md](../../../../../../docs/development/monaco-embedding.md)。
- 修法：paste 监听从 PromptMonacoEditor 的 containerDomNode 移到 PromptInput 的 drop-host div（`dropHostRef` + `useEffect` 原生 capture 监听），删掉 `onPaste` prop 管线。主进程回退逻辑本身正确、只是挂错了元素（同步 ClipboardEvent 在此上下文拿不到图字节，`navigator.clipboard.read()` 又被 Electron 权限挡住）。
- E2E 回归 `apps/editor/e2e/specs/smoke.acpPasteImage.spec.ts`：`electronApp.evaluate` 用主进程 `clipboard.writeImage` 塞 PNG → 真 `Control+V` → 断言 `acp-prompt-image-chips`；echoAgent 加 `ECHO_AGENT_IMAGE=1` env 开 `promptCapabilities.image`，probe `installAcpEchoAgent` 加第三参 env。

## acpProtocolTracer 大帧防护（相邻独立修复）

- 多 MB 大图流式场景（Claude 侧或粘贴大图）确实会卡：`acpProtocolTracer._feed` 用 `scan` 偏移消除 O(m²) 行重组；单行超 `MAX_TRACE_LINE`（512KB）丢弃、只发 `<large frame N bytes elided>`；`redactForTrace` 兜底裁剪 base64。
- 回归：e2e `smoke.agentsImageResume.spec.ts`（echoAgent `emit-image:<count>x<kb>` + 计时 `page.evaluate` 探针，3376ms → 940ms）。
- 它**不是**恢复卡死的主因（见上面红线节），两者独立。

## 测试与 e2e 要点

- 单测：`promptImage.test.ts`（mime/限额/两种构造）、`promptImageUndo.test.ts`（撤销栈语义）、`ChatImage` 的 UI 测试、以及上节三个渲染链路测试。
- e2e：`smoke.acpPasteImage.spec.ts`（真 Ctrl+V + Ctrl+Z/Ctrl+Y）、`smoke.agentsImageResume.spec.ts`（大帧/恢复耗时）、`smoke.acpFragmentCopy.spec.ts`（chip 可见性）。
- 图片 prompt 的 e2e 断言**必须 poll 到消息落地**：`sendAcpPrompt` 的 await 不等 echo 回复渲染完成（详见 skill `fix-ci-e2e-flake` 对应案例）。

## 关键参考路径

- 纯函数：`promptImage.ts`；撤销栈：`promptImageUndo.ts`；能力位：`session/acpSession.ts`（`imageSupported`）
- 输入侧：`workbench/agents/PromptInput.tsx`（`acceptImageFiles` / `acceptImageUris` / `onPromptDrop` / drop-host paste / `undoPromptImage`）；按键：`renderer/actions/agentPromptActions.ts`
- 展示：`workbench/agents/ChatImage.tsx` / `PromptImageChips.tsx` / `MessageContent.tsx`
- 解析：`services/acp/markdownRenderer.ts`（`isImageDataUrl`）、`workbench/markdown/MarkdownView.tsx`（`renderImage`）
- 红线：`services/acp/filePathLink.ts`（`SEG` 字符类）+ `__tests__/filePathLink.test.ts`
- tracer：`services/acp/acpProtocolTracer.ts`（`MAX_TRACE_LINE`）
