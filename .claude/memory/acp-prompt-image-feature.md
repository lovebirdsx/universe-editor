---
name: acp-prompt-image-feature
description: ACP 输入框图片支持（粘贴/拖拽/附件按钮）+ 88×88 共享 ChatImage 控件带锚定预览弹窗 + 恢复卡死根因/修复
metadata: 
  node_type: memory
  type: project
  originSessionId: e2666196-90c8-4c60-b914-e96bf9211c33
---

ACP session 输入框支持图片，渲染侧原本就支持（MessageContent 的 ImageBlock），只补了输入侧。整条管线镜像 SelectionContext 套路。

**输入三入口**：粘贴(Ctrl+V)/拖拽图片文件/附件按钮(ImagePlus)。核心纯函数在 `services/acp/promptImage.ts`（PromptImage 类型、validateImage、composeImageBlocks、blobToPromptImage/bytesToPromptImage、mimeTypeForFileName）。能力降级：agent 的 `promptCapabilities.image !== true` 时禁用入口 + Info 通知；observable `session.imageSupported`。限额可配：`acp.prompt.image.maxSizeMB`(默认5)、`acp.prompt.image.maxCount`(默认5)。

**拖拽 bug 根因**：早 return 未 preventDefault → 冒泡到 EditorGroupView 打开图片；且 Explorer 内部拖拽只带 text/uri-list 无 File → 走 IFileService.readFile 读 URI（acceptImageUris）。onPromptDrop 顶部先 `if(!dragContainsResources) return; preventDefault(); stopPropagation()`。

**共享控件 `workbench/agents/ChatImage.tsx`**：88×88 缩略图(object-fit:contain)，点击开**锚定预览弹窗**（不是全屏 lightbox——全屏挡视线）。定位坑：初版用 `position:absolute; bottom:100%` 固定在缩略图上方，靠窗口边缘/被聊天区 overflow 裁剪时被遮挡。最终版：`createPortal` 到 body + `position:fixed`，用 `useLayoutEffect` 测 anchor(`getBoundingClientRect`) 和弹窗尺寸后在视口坐标里算 left/top，上方放不下自动翻到下方 + 水平 clamp 进视口；首帧 `visibility:hidden` 先测再定位；滚动/resize 直接关。原生 pan/zoom：滚轮以光标为锚缩放、拖动平移、双击复位。消息图(MessageContent ImageBlock)与附件缩略图(PromptImageChips)都复用它。testid：缩略图沿用 `acp-image-block`，弹窗是 `acp-image-preview-popover`。

**恢复含图 session 卡死——真正根因（严重，之前判断错过一次）**：症状是恢复含图 Codex session 卡死。**先排除 tracer**：真实 session 文件（`.codex/sessions/.../rollout-*.jsonl`）里图片只有 ~8.7KB 小 PNG，不是多 MB，tracer 不是本例主因。真凶是 **`services/acp/filePathLink.ts` 的文件路径正则灾难性回溯（catastrophic backtracking）**：codex-acp fork 恢复时把图片转成 `[@image](data:image/png;base64,<8770字符>)` markdown 文本，markdown inline 解析器对 base64 主体每个跟在 `/`/`+` 后的位置调 `matchFilePathAt`，正则 `(?:SEG+/)*SEG+` 因 `SEG` 字符类**自身包含 `/`** 而退化成 `(a+)+`，对斜杠密集又无合法扩展名结尾的串指数回溯（实测单次 `matchFilePathAt` >35s 不返回）。修复：`SEG` 从 `[^NON_SEG]` 改成 `[^NON_SEG/\\]`（段内排除路径分隔符，与 `REL_SEG` 一致，消除歧义→线性），从 >35s 降到 5ms。回归测试在 `filePathLink.test.ts`（扫 4KB 斜杠密集 data URL <1s）。

**恢复图片正确显示为图片（治本，改渲染层解析文本 image，不碰 vendor）**：用户反馈"Claude 恢复图片正常、Codex 不正常"。根因：codex-acp fork 恢复时把图片降级成 `[@image](data:image/png;base64,...)` markdown 文本，而 renderer markdown 解析器的 `isSafeHref` 只认 http/file 不认 `data:` → 原样显示成一坨长文本（且触发上面的正则卡死）。**曾一度改 vendor codex-acp（新增 imageBlockFromUrl 发真 ACP image 块）但被用户叫停——最终方案改在渲染层解析文本类 image，无需改 submodule**：
- `services/acp/markdownRenderer.ts` 新增导出 `isImageDataUrl(href)`（仅 `data:image/*;base64,` 白名单，绝不放行任意 `data:` 防 XSS）；`![alt](url)` 与 `[label](url)` 两种语法遇到 image data URL 都产出 `{type:'image',src,alt}` AST 节点（link 分支在原 isSafeHref/looksLikeFilePath 判断**之前**先拦 isImageDataUrl）。增量解析器 `markdownIncremental.ts` 委托 `parseMarkdown`，自动继承。
- `workbench/markdown/MarkdownView.tsx` 加可注入 `renderImage?(src,alt)` prop + `ImageRenderContext`：默认 `defaultRenderImage` 渲染裸 `<img class=mdImage>`（文档预览用），image AST 节点经 `InlineImage` 组件 `useContext` 取渲染器。
- `workbench/agents/MessageContent.tsx` 的 MarkdownBlock 传 `renderImage={renderChatImage}`，`renderChatImage(src,alt)` 返回 `<ChatImage src alt testId="acp-image-block">` → 恢复的 Codex 文本 image 渲染成和 ACP image 块一模一样的缩略图+预览控件。
- 测试：markdownRenderer.test.ts（isImageDataUrl 白名单/XSS 拒绝 + `![]`/`[@image]` 两语法产 image 节点 + 非 image data 仍拒）、MarkdownView.test.tsx（默认 `<img>` + renderImage prop 委托）、MessageContent.test.tsx（`[@image](data:...)` 文本渲染成 acp-image-block 且原始文本不泄漏）。**不改 vendor、无需 agent:build**。

**关于 tracer 的另一独立修复仍保留**（多 MB 大图流式场景确实会卡，Claude 侧或粘贴大图）：`acpProtocolTracer._feed` 用 `scan` 偏移消除 O(m²) 行重组 + 单行超 `MAX_TRACE_LINE`(512KB) 丢弃只发 `<large frame N bytes elided>` + `redactForTrace` 兜底裁剪 base64。E2E `smoke.agentsImageResume.spec.ts`（echoAgent `emit-image:<count>x<kb>` + 计时 page.evaluate 探针，buggy 3376ms/修复后 940ms）。

相关坑见 [[e2e-async-session-prompt-not-settled]]（图片 prompt 的 E2E 需 poll 落地）。

**粘贴图片彻底失效根因（Monaco editContext:true 吞 paste 事件——之前修复没生效）**：升级到内嵌 Monaco 后（[[prompt-monaco-input-migration]]）粘贴图片完全无反应。曾一次"修复"把 paste handler 挂在 `ed.getContainerDomNode()`（`_promptEditorInner`）上并加主进程 `IHostService.readClipboardImage` 回退，配了单元测试还是绿——**但真实环境从未触发**。真因：`editContext:true` 给内层 `native-edit-context` div 绑了 Chromium `EditContext` API，**该元素及其 Monaco 子树内的 DOM 祖先都不再向普通 `addEventListener('paste')` 派发 paste 事件**（EditContext 接管输入管线）；只有 `document` 层和 **Monaco DOM 之外**的 React 宿主 div（`_promptEditorHost`/drop-host）在 **capture 阶段**能可靠收到。旧单元测试用 stub `<textarea>` 的合成 `fireEvent.paste` 绕过了真实 EditContext 所以假绿。**修复**：把 paste 监听从 PromptMonacoEditor 的 containerDomNode 移到 PromptInput 的 drop-host div（`dropHostRef` + `useEffect` 原生 capture 监听），删掉 onPaste prop 管线。回退逻辑（同步事件无图 → 主进程读剪贴板）本身正确，只是挂错了元素。E2E 回归 `smoke.acpPasteImage.spec.ts`：`electronApp.evaluate` 用主进程 `clipboard.writeImage` 塞 PNG → 真 `Control+V` → 断言 `acp-prompt-image-chips`；echoAgent 加 `ECHO_AGENT_IMAGE=1` env 开 `promptCapabilities.image`，probe `installAcpEchoAgent` 加第三参 env。**教训**：Monaco editContext:true 下所有键盘/剪贴板/输入类 DOM 监听都要挂在编辑器 DOM 之外的宿主元素（capture），别挂 containerDomNode；单元测试的 stub textarea 无法覆盖 EditContext 行为差异，此类必须 e2e 真事件验证。见 [[monaco-055-editcontext-nls]]。
