---
name: markdown-preview-local-images-app-scheme
description: "markdown 预览本地图片渲染;prod renderer 页面从 file:// 改为自定义 universe-app scheme,资源同源 _resource_ 前缀 + localResourceRoots 边界"
metadata: 
  node_type: memory
  type: project
  originSessionId: a620497a-2399-4d0f-b8f2-c16fae586c69
---

markdown 预览支持本地图片(相对/绝对/file:// 路径),对齐 VSCode asWebviewUri + localResourceRoots。完成于 2026-07-02。

**根因两层**:①解析层 `markdownRenderer.isSafeHref` 只放行 http(s)/file/data:image,相对路径进不了 AST(已改用新 `isImageSrc` 放行本地路径,仍拒 javascript:/非图片 data:);②加载层项目原本无自定义协议、webSecurity 开启,`<img src=file://>` 跨 origin 被拦。

**关键坑(实测确认,耗时最久)**:自定义 secure scheme 的资源**从 `file://` 页面加载不通** —— Chromium 在请求发起前就拦截,请求根本到不了 `protocol.handle` handler(diag 文件验证:scheme 注册成功、handler 装了、但从无 request 到达)。fetch 和 `<img>` 都一样。**且不同 authority 也算跨 origin 同样被拦**(secure standard scheme)。VSCode 能用自定义 scheme 是因为它 prod 页面本身就是 `vscode-file://` 同 scheme。

**最终方案**:prod 的 renderer 页面从 `loadFile(file://)` 改为 `loadURL('universe-app://root/index.html')`(自定义 scheme)。资源与 shell **同一 origin `universe-app://root`**,靠路径前缀 `/_resource_/` 区分(不是不同 authority!)。单 `protocol.handle('universe-app')`:`/_resource_/<encoded-abs-path>` 走 allow-list 边界校验后读盘,其余路径服务 `out/renderer/` 下 shell+assets。renderer 相对 asset(`./assets/...`,vite 默认 base)天然解析到同 scheme。

**dev 模式**:页面是 `http://localhost`(Vite),图片走 `universe-app://` 仍跨 origin → 给 dev 窗口设 `webSecurity:false`(仅 `rendererUrl` 存在时;prod 保持开启,边界在 handler 内校验与 webSecurity 无关)。

**接线**:scheme 注册 `registerAppProtocolScheme()` 必须在 `app.whenReady()` 前(index.ts 顶层);handler `installAppProtocolHandler(rendererDir)` 在 whenReady 内。边界 allow-list 由 renderer 经 `IResourceAccessService.allowRoots`(套路 C 服务,通道 ResourceAccess)声明:MarkdownView 顶层 effect 声明 `[baseUri文档目录, workspaceRoot]`。renderer URI 转换纯函数 `resourceUri.ts` 的 `asPreviewResourceUri`,在 `MarkdownView.InlineImage` 单点转换(defaultRenderImage/ChatImage 都受益)。

**关键文件**:`main/ipc/resourceProtocol.ts`(协议+双用途 handler)、`main/ipc/resourceRoots.ts`(无 electron 依赖的边界纯逻辑,可 node 测)、`shared/ipc/resourceAccessService.ts`、`renderer/workbench/markdown/resourceUri.ts`。`will-navigate` 放行 `universe-app:`。`WindowMainServiceOptions.rendererHtml` 字段已删(loadFile 不再用)。

**副作用**:prod origin 从 `file://` 变 `universe-app://root`,renderer localStorage/sessionStorage 按 origin 分区会"重置"(项目状态走 main state.json 不受影响;开发期不考虑向后兼容)。

相关:[[markdown-preview-link-hints]] [[acp-prompt-image-feature]]
