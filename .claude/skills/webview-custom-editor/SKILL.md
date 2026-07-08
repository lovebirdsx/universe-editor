---
name: webview-custom-editor
description: 制作"基于 webview / 自定义编辑器的文件预览"类功能时召回——本仓库对等 VSCode 的 webview + CustomEditor API，让扩展用一个内嵌 iframe 渲染任意 HTML 来预览某类文件（PDF 是首个实例，后续如 3D 模型 / 音视频 / 表格 / 自定义数据格式 预览同理）。当任务涉及给某文件类型加图形化预览编辑器、用扩展 `registerCustomEditorProvider` + `resolveCustomEditor` 填 webview、`asWebviewUri` + `localResourceRoots` 把本地资源喂进 iframe、webview `postMessage` 双向桥、把某三方 vscode webview 扩展移植成 .vsix 装进 restricted host、或扩展外部资产（大体积静态文件）经特权协议加载时使用。给出五层落点（extension-api 契约 / extensions-common 协议+激活事件 / extension-host 句柄 / renderer WebviewService+iframe / resolver 接入）文件地图、asWebviewUri 同步纯函数约定、两个已知竞态/资源坑、out-of-workspace .vsix 构建套路、E2E 验证法、安全红线。区别于 extension-marketplace-management（装/更新/卸载分发链路）与 extend-language-plugin（语言 provider）：本 skill 是"造 webview 预览能力 + 把预览类扩展落成 .vsix"。
disable-model-invocation: true
---

# Webview / 自定义编辑器预览

对等 VSCode 的 `Webview` + `CustomReadonlyEditorProvider` API：扩展注册一个 `viewType`（manifest `contributes.customEditors` 把它绑到文件 glob），用户打开匹配文件时工作台开一个 tab + 沙箱 iframe，回调扩展的 `resolveCustomEditor` 让它设 `webview.html`/`options`。PDF 预览是首个实例；任何"用 HTML/JS 渲染某类文件"的预览（3D、音视频、CSV、自定义二进制格式…）都走这条路。

> ⚠️ 第一原则：**分清你要做的是"造 API/宿主基建"还是"写一个用它的扩展"**。基建（五层，见下）已就位且完整对标 VSCode——多数新预览扩展**只碰扩展侧**（写 `extension.ts` + manifest + 打包），根本不用动 packages/apps。只有当预览需要**现有 API 尚无的能力**（如文件监听 / 可编辑保存 / webview 持久化状态）时才回头扩 API。先判断，别默认从内核改起。
>
> ⚠️ 第二原则：**iframe 不是硬沙箱**。`sandbox="allow-scripts allow-same-origin"`（allow-same-origin 是为了让 `universe-app://root` 子资源能加载）。真正的护栏是**扩展声明的 CSP + 资源 allow-list**（只服务 `localResourceRoots` 下的文件）。外部扩展的 webview 里代码≈拥有扩展自身权限。**文档/UI 绝不能宣称它是等同网页的沙箱**（见 `docs/user/zh-CN/customization/extensions.md` 的措辞）。

## 五层架构（基建，多数扩展不用碰）

```
① 契约  packages/extension-api/src/webview.ts
        Webview(html/options/cspSource/asWebviewUri/postMessage/onDidReceiveMessage)
        WebviewPanel / CustomDocument / CustomReadonlyEditorProvider
        index.ts: window.registerCustomEditorProvider(viewType, provider, options)
        ⚠️ 改 API 必 version bump（package.json 同步 + COMPATIBILITY.md + index.test.ts 契约快照）
② 协议  packages/extensions-common/src/
        webviewProtocol.ts  fsPathToWebviewUrl（asWebviewUri 的纯函数实现，见下）+ WEBVIEW_CSP_SOURCE
        manifest.ts/manifest-schema.ts  contributes.customEditors 类型 + zod
        activation.ts  customEditorActivationEvent(viewType) = `onCustomEditor:${viewType}`
        rpc.ts  IMainThreadWebviews（host→renderer 写穿）/ IExtHostWebviews（renderer→host 回调）+ 通道名
③ host   packages/extension-host/src/hostWebviews.ts
        HostWebviewManager：provider 按 providerHandle、panel 按 renderer 分配的 panelHandle
        HostWebview 写穿 html/options（$setWebviewHtml/$setWebviewOptions）over RPC
④ renderer  apps/editor/src/renderer/
        services/extensions/WebviewService.ts  跨双 tier 单例，setExtHost(kind) 分连接，openPanel 路由回 owning tier
        workbench/webview/WebviewElement.tsx  iframe 宿主 + postMessage 桥 + 写 html + allowRoots
        workbench/editor/CustomEditorHost.tsx  开 panel + 挂 WebviewElement（含竞态修复，见坑①）
        services/editor/CustomEditorInput.ts  typeId=customEditor，id 按 viewType 命名空间隔离
⑤ 接入  apps/editor/src/renderer/
        services/extensions/ExtensionPointTranslator.ts  处理 customEditors 贡献点
        contributions/ExtensionsContribution.ts  _registerCustomEditor → IEditorResolverService.registerEditor
                                                 （default=priority100 覆盖 catch-all / option=1 仅 Reopen With）
        workbench/editor/EditorArea.tsx  editorComponentMap.set('customEditor', CustomEditorHost)
        contributions/BuiltInEditorProvidersContribution.ts  CustomEditorInput deserialize（窗口恢复）
```

## asWebviewUri 必须同步 → 纯函数，不走 RPC

`webview.asWebviewUri(fileUri)` 在扩展里是**同步**调用（vscode-pdf 在 `resolveCustomEditor` 里直接拼 HTML 字符串），不能 RPC 往返。所以 host 侧 `HostWebview.asWebviewUri` 调 `extensions-common` 的**纯函数** `fsPathToWebviewUrl(fsPath)` → `universe-app://root/_resource_/<编码后的绝对路径>`。这是 VSCode `asWebviewUri` 的等价物，复用既有特权协议（`main/ipc/resourceProtocol.ts` + allow-list `main/ipc/resourceRoots.ts`），**不新造协议**。`cspSource` = `universe-app://root`（`WEBVIEW_CSP_SOURCE`），扩展把它写进 CSP meta。

## 写一个新预览扩展（最常见任务）：照抄 extensions-external/pdf

PDF 扩展是范例。新预览扩展**故意放在 pnpm workspace 外**（`extensions-external/<name>/`），因为它以 .vsix 形态经市场链路装进 restricted host，不是内置扩展（workspace globs 只含 `apps/*`/`packages/*`/`extensions/*`）。骨架：

```
extensions-external/<name>/
  src/extension.ts        activate 里 window.registerCustomEditorProvider(viewType, { openCustomDocument, resolveCustomEditor })
  assets/                 预览器静态资产（如 pdf.js 19MB）——运行时经 asWebviewUri 加载，不打进 bundle
  package.json            engines.universe 匹配 bump 后 API version；contributes.customEditors；activationEvents:["onCustomEditor:<viewType>"]；files:["dist","assets","icon.png"]
  esbuild.config.mjs      bundle src→dist；.html 走 text loader 内联模板 HTML；alias @universe-editor/extension-api → 其 dist
  scripts/pack.mjs        压成 extension/** 结构的 .vsix（[Content_Types].xml + extension.vsixmanifest 占位 + extension/package.json + dist + assets）
  tsconfig.json / src/html.d.ts / README.md / .gitignore(dist,*.vsix)
```

**out-of-workspace 构建的关键坑**：该目录没有本地 `node_modules`。
- esbuild：从 workspace 里装了它的包借——`createRequire(resolve(repoRoot,'extensions/numbered-bookmarks/package.json'))`，且 Windows 下动态 `import()` 绝对路径须 `pathToFileURL(...).href`。
- adm-zip（打包用）：`createRequire(resolve(repoRoot,'packages/extension-packaging/package.json'))`。
- @types/node + extension-api 类型：tsconfig 用 `typeRoots` 指向 workspace 的 `@types`，`paths` 把 `@universe-editor/extension-api` 映射到其 `dist/index.d.ts`。
- 前置：`packages/extension-api` 得先有 dist（`pnpm build` 会做）。
- 构建/打包：`node esbuild.config.mjs && node scripts/pack.mjs` → `<publisher>.<name>-<version>.vsix`。用真实安装路径的 `readVsixManifest`（extension-packaging）验它能被读。

**扩展侧代码要点**（`extension.ts`）：
- 用 `context.extensionPath` 拼资产路径；`asWebviewUri(fileUri(...))` 转 URL 填进 HTML。
- 模板 HTML（如 pdf.js viewer.html）经 esbuild `.html` text loader 内联成字符串，再字符串替换：剥掉硬编码的相对 `<script>/<link>`，注入 `asWebviewUri` 后的 URL + CSP meta。
- `localResourceRoots` **必须同时包含扩展目录和文档所在目录**（见坑②）。
- 装了 API 依赖的三方扩展移植：`import "vscode"` → `@universe-editor/extension-api`，语义基本对齐；砍掉现有 API 无的能力（如 `createFileSystemWatcher` 自动重载）。

## 已知坑（都是真 bug，e2e 抓到）

1. **CustomEditorHost provider 注册竞态**：provider 是**异步**注册的——打开文件 fire `onCustomEditor:<viewType>` → host 激活扩展 → `$registerCustomEditorProvider` RPC 回程。若 `CustomEditorHost` 一挂载就 `openPanel`，此刻 WebviewService 里还没这个 provider，返回 undefined → 永久空白。**修法**（已在 `CustomEditorHost.tsx`）：首次 `openPanel` 失败则订阅 `webviewService.onDidChangeProviders` 重试，加一个超时（~15s）兜底才判 failed。改这块务必保留重试。
2. **localResourceRoots 漏文档目录 → 预览器出 UI 但空内容**：只 allow-list 扩展目录时，`asWebviewUri(document.uri)` 生成的 URL 被资源协议拒（文档在别处，如 tmp 目录）。表现：pdf.js 出 toolbar 但 0 页。**修法**：扩展 `resolveCustomEditor` 里 `localResourceRoots: [扩展目录, 文档所在目录]`（PDF 扩展的 `dirUri(document.uri)`）。

3. **iframe 继承 app-shell CSP → 预览器裸骨架/inline&module 脚本全被拒（真根因，别再归咎 allowRoots）**：webview iframe 若是 `about:blank`（无 `src`）+ `doc.write`，这类 **local-scheme 文档会继承发起方（renderer 主页 index.html）的 CSP**，而扩展写在 HTML `<meta>` 里的 CSP **无法放宽已继承的 CSP（CSP 只能叠加收紧）**。于是扩展声明的 `script-src`（含 pdf.js 需要的 module/inline/blob worker）被主文档的 `script-src 'self'` 卡死。环境差异放大了迷惑性：**prod**（`'self'`=`universe-app://root`）下 module 脚本侥幸匹配 self 能跑、PDF 居然出内容但 inline 脚本被拒/worker 降级；**dev**（`'self'`=`http://localhost`）下 `universe-app://` 的 CSS/JS 全不匹配 → 完全裸骨架、每个文件都一样。**修法**（已在 `WebviewElement.tsx` + `resourceProtocol.ts` + `index.html`）：iframe 导航到**真实 URL 的空白文档** `universe-app://root/_webview_blank_`（`WEBVIEW_BLANK_URL`），该响应**不带 CSP header**，`doc.write` 写入扩展 HTML 后扩展 meta CSP 才真正生效；origin 仍是 `universe-app://root`，`_resource_` 子资源照常加载。**配套坑（父文档 frame-src）**：iframe 的 `src` 受**父文档**（`renderer/index.html`）CSP 的 `frame-src`（回退 `default-src 'self'`）约束——`about:blank` 无 src 不受限，一旦改成真实 `universe-app://` URL，dev 下 `'self'`=`http://localhost` 不匹配就 `ERR_BLOCKED_BY_CSP`。必须在主文档 CSP 显式加 `frame-src 'self' universe-app:`。**又一层坑（dev 跨源）**：dev 下主页 `http://localhost` 与 iframe `universe-app://root` **跨源**，renderer 直接 `iframe.contentDocument.write` 抛 `Can only call open() on same-origin documents`。所以 blank 文档内置一个 loader（常驻 `window` message listener），renderer 用 `postMessage`（`WEBVIEW_SETUP_MARKER`）把 HTML 送进去，由 loader 在**同源内** `document.write`。**关键**：`document.write` 替换文档 body 但**不重建 window listener**，所以 loader 常驻、可反复接收后续 HTML 灌入——iframe **永不重建**（早期 `reloadNonce`/换 key 重载 iframe 的做法是错的，见坑⑥）。守护用例：`smoke.webview.spec.ts` 的内联扩展声明自己的 CSP + 跑一段 inline `<script>` 写标记，断言标记出现——继承 shell CSP 时该 inline script 会被拒，用例转红。

4. **allowRoots 与写 HTML 的竞态（次要加固，非坑③真因）**：`WebviewElement.tsx` 里授权 allow-list（`resourceAccess.allowRoots` RPC）与交出 HTML 若不排序，资源请求可能先于授权到达 main → 403。**修法**（已合并进上面那个 effect）：交出 HTML 前先 `await allowRoots(roots)`，`cancelled` 标志防旧 await 竞态。诊断辅助：`resourceProtocol.ts` 的 403 分支 `console.warn` 被拒路径。> ⚠️ 历史教训：这条最初被误当成坑③"裸骨架"的真因，实际真因是上面的 CSP 继承——allowRoots 排序是正确加固但改了它 dev 仍裸骨架。

5. **Ctrl+P（Go to File）绕过 resolver → 用文本编辑器打开二进制**：`FileQuickAccessProvider._open` 曾直接 `new FileEditorInput`，不走 `IEditorResolverService`，PDF 等被文本编辑器打开成乱码（Explorer 走 resolver 所以正常）。这是 [[editor-input-identity-isolation]] 记录的"多条打开路径绕过 resolver"通病。**修法**：所有打开文件的入口都走 `editorResolver.openEditor(uri, {pinned})`；跨 group 查重按 `uriIdentity.isEqual(editor.resource, uri)`（别 `instanceof FileEditorInput`，否则 customEditor 打开的同一文件认不出）。

6. **切走 tab 再切回 → webview 白屏（iframe 重建竞态）**：`EditorGroupView` 只渲染 active editor，切走 tab 会 unmount `CustomEditorHost`→`closePanel` dispose 旧 panel；切回重新 mount→`openPanel` 建新 panel（html 初始 `''`，host 异步 resolve 后才灌真 HTML）。**旧错误设计**：`WebviewElement` 在 html 从 `''` 变真值时 `setFrameLoaded(false)`+bump `reloadNonce`（换 iframe `key` 重建 iframe）。但 `frameLoaded` 是**组件级 state、与具体 iframe 实例解耦**——旧 iframe 的 `onLoad` 把 flag 置 true，而 `iframeRef` 此刻可能已指向新建的 iframe（blank 文档没加载完、loader 没注册），`postMessage` 打空 → 白屏（"大概率"取决于 onLoad 与 html 到达的批处理竞速）。**修法**（`WebviewElement.tsx`）：**iframe 永不重建**（删掉 `reloadNonce`/`lastHtmlRef`），靠 loader 常驻 listener 反复接收 HTML（见坑③）；`frameLoaded` 绑定唯一 iframe（只 fire 一次、永久有效），html 变化时只要 `frameLoaded && html!==''` 就重发。**CustomEditorHost 仍用 `key={panel.panelHandle}`** 让**换 panel**（往返产生新 handle）时整体重建 WebviewElement——干净跟随。守护用例：`smoke.webview.spec.ts` 的 "hidden and revealed" @regression。

7. **重启/reload 恢复后 webview 空白（恢复路径绕过 resolver factory 不激活扩展）**：正常打开走 `ExtensionsContribution._registerCustomEditor` 的 resolver factory，factory 里 `activateByEvent(onCustomEditor:<viewType>)` 触发扩展激活→注册 provider。但**窗口恢复走 `EditorRegistry.deserialize('customEditor')`→`CustomEditorInput.deserialize` 直接 `new`**，完全绕过 factory → 扩展从不激活 → provider 从不注册 → `CustomEditorHost.openPanel` 永远拿不到 provider → 空白直至 15s 后 failed。**修法**（`CustomEditorHost.tsx`）：组件 mount 的 effect 里主动 `extensionHost.activateByEvent(customEditorActivationEvent(customInput.viewType))`（幂等，对正常打开无害），provider 随后经 `onDidChangeProviders` 重试接上。**教训**：任何"打开走 resolver factory 做副作用（激活/授权）"的编辑器，其 deserialize 恢复路径都要补同样的副作用——deserialize 只造 input，不跑 factory。

8. **打开后 iframe 不自动获焦（要手动点）+ 获焦后宿主快捷键全失效 + 转发的快捷键双触发**：三件事纠缠，对齐 VSCode webview（`vscode/src/vs/workbench/contrib/webview/browser/pre/index.html` 的 `handleInnerKeydown` + `webviewElement.ts` 的 `handleKeyEvent`/`_doFocus`）。**(a) 不自动获焦**：group 激活时 `EditorGroupView` 调 `focusEditorInput(activeEditor)`，它只认 Monaco（FileEditorRegistry/DiffEditorRegistry），`CustomEditorInput` 无 `focus()` → fall back 到 `focusGroupBody`，聚焦的是 iframe **外面**的 editor-group-body。**修法**：`CustomEditorInput.override focus()` → 走 `WebviewFocusRegistry.requestFocus(viewType, resource)`（仿 MarkdownPreviewRegistry；provider 异步注册故带 pending-focus 队列，controller 晚到时补聚焦）。**关键时序坑（切回 tab 不响应/需手动 focusActiveEditorGroup 的真因）**：iframe 先 load blank 文档，随后 loader 的 `document.write` **重建文档丢焦点**，扩展脚本（pdf.js）又是**异步**初始化——所以聚焦不能只在 `frameLoaded` 时做一次，必须在 **HTML 写入并 settle 后**（`html!==''` 的延迟 effect，~80ms）再 `frame.focus()+contentWindow.focus()`，用 `wantFocusRef` 记录意图跨越这几段异步（对齐 VSCode deferred `_doFocus`）。聚焦后 `syncEditorFocusContext` 清 `editorTextFocus`/`editorFocus`（否则残留 true 让全局键盘守卫把 iframe 当文本面板吞键，见 [[editor-text-focus-stuck-swallows-keys]]）。**(b) 获焦后宿主快捷键失效**：`useGlobalKeybindingHandler` 在**父 document** capture 监听 keydown，而**键盘事件不跨 iframe 边界**——焦点在 iframe 内时 keydown 只在 iframe 自己的 document 派发，宿主永远收不到 → Ctrl+W/Ctrl+P 等全死。**修法**：`injectBootstrap` 注入脚本 `capture` 监听 keydown，**放行无 ctrl/alt/meta 的裸键给 webview**（打字/pdf.js 翻页），带功能修饰键的 `postMessage` 转发；`WebviewElement` 收到后 `new KeyboardEvent('keydown', {...init, bubbles:true})` 在 **iframe 元素**上 `dispatchEvent` → 冒泡经父 document、capture 处理器解析，`e.target`=iframe（`isEditableTarget` 返回 false）正常执行。**(c) 双触发（Ctrl+P 既开 Go to File、又触发 webview 内打印）**：`preventDefault()` **挡不住** pdf.js——它在 iframe `window` 上 **capture 阶段**监听 keydown 后**主动调 `window.print()`**（不是浏览器默认行为，preventDefault 无效）。**修法**（VSCode 同款）：bootstrap 对 native 快捷键（ctrl/meta + P80/F70/S83/Z90/Y89）用 **`stopImmediatePropagation()`+`preventDefault()`**。bootstrap 注入在 `<head>`、pdf.js 脚本在 body 末尾，同 target 同 capture 阶段按注册顺序，bootstrap 先跑就能 `stopImmediatePropagation` 掉 pdf.js 的监听器。守护用例：`smoke.webview.spec.ts` 的 "focuses the iframe on open and forwards host shortcuts" @regression（断言 `document.activeElement.tagName==='IFRAME'` + 帧内 Ctrl+P 后 `defaultPrevented===true` + 内联的 pdf.js 式 print 监听标记 **不出现** + `quickInputVisible` 变 true）；"hidden and revealed" @regression 追加断言切回后 `activeElement==='IFRAME'`。

## 若要扩 API（可编辑保存 / 文件监听 / 状态持久化等）

沿五层动，**KEEP IN SYNC 两处 bridge 定义**（`extension-host/src/apiFactory.ts` 的 `IExtensionHostBridge` ⋈ `extension-api/src/index.ts` 的同名 interface + window 委托）。新增 RPC 方法同时加进 `IMainThreadWebviews`（host→renderer）或 `IExtHostWebviews`（renderer→host）+ WebviewService/HostWebviewManager 两侧实现。**API version bump**：`extension-api` 的 `version` 常量 + package.json 同步，minor 加法，补 COMPATIBILITY.md 变更行 + index.test.ts 契约快照。wire 上的 URI 记得 `URI.revive`（[[realpath-uri-ipc-revive]]）。

## E2E 验证

`apps/editor/e2e/specs/smoke.webview.spec.ts`（@p1@regression）是范例：**内联极简 custom-editor .vsix**（不依赖 pdf.js 重资产，headless 稳定）走全链路——`installVsixExtension` 装 → `openFileUri` 开匹配文件 → poll `getActiveEditorTypeId()==='customEditor'` → `frameLocator('[data-testid="webview-frame"]')` 断言 iframe 内渲染出标记元素（`allow-same-origin` 让 Playwright 能进 frame）。内联扩展**直接调 `globalThis['__universeExtensionHostBridge__']`**（装好的扩展无 node_modules 解析不了 api 包）。内联扩展还做两件事守护上面的 CSP/资源坑：(a) `asWebviewUri` 一个小 CSS 资源并断言 iframe 内元素 **computed style 生效**——守护坑④（allow-list 竞态）：纯内联 HTML 检查在所有 `universe-app://` 子资源 403 时仍会绿，必须实测一个 asWebviewUri 资源真的加载；(b) 声明自己的 `<meta>` CSP + 跑一段 inline `<script>` 写标记并断言其出现——守护坑③（iframe 继承 shell CSP）：继承 `script-src 'self'` 时 inline script 被拒、标记不出现。真资产扩展（如 PDF 渲染出 `<canvas>`）建议本地临时 spec 验一遍后删（临时诊断 spec 用完即删，别把重资产/console dump spec 留进 CI）。改了 renderer 必先 `pnpm build`（e2e 跑 `out/` 产物）。

## 安全红线（restricted host + webview = 新攻击面）

- restricted host **无 AI、无密钥**通道；webview 更不给任何密钥/AI（[[ai-service-foundation-progress]] 的红线延伸）。
- iframe `sandbox` 无 `allow-same-origin` 是理想，但本仓库因 `universe-app://` 子资源加载需要它——所以真护栏是 **CSP + 资源 allow-list**：只 `asWebviewUri` 到扩展目录 + 声明的 `localResourceRoots`，越界经 `isPathAllowed` 403。
- `postMessage` 载荷须可结构化克隆；host 侧处理 `vscode.open` 等命令走白名单。
- 文档**不得**把 iframe 说成硬沙箱。

## 验证

```bash
pnpm check                                    # lint+typecheck+test（44 tasks），仅看错误
pnpm build                                    # e2e 跑 out/ 产物，改 renderer/main 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts specs/smoke.webview.spec.ts
pnpm docs:check                               # 动了 docs/user 后校验死链
# 扩展侧：cd extensions-external/<name> && node esbuild.config.mjs && node scripts/pack.mjs
```

## 关键参考路径

- `extensions-external/pdf/`（**范例扩展，照抄它**）：`src/extension.ts`（provider + asWebviewUri + dirUri 修复）/ `esbuild.config.mjs`（out-of-workspace 构建 + text loader）/ `scripts/pack.mjs`（.vsix 打包）/ `README.md`（构建流程）
- `packages/extension-api/src/webview.ts` + `index.ts`（契约 + version bump 点）
- `packages/extensions-common/src/webviewProtocol.ts`（`fsPathToWebviewUrl` 纯函数——asWebviewUri 白拿）
- `packages/extension-host/src/hostWebviews.ts`（HostWebviewManager 句柄模型，仿 SCM handle）
- `apps/editor/src/renderer/services/extensions/WebviewService.ts`（跨 tier 单例路由）
- `apps/editor/src/renderer/workbench/webview/WebviewElement.tsx`（iframe + 桥，头注释讲清非硬沙箱）
- `apps/editor/src/renderer/workbench/editor/CustomEditorHost.tsx`（**竞态修复在此**）
- `apps/editor/src/renderer/services/editor/CustomEditorInput.ts`（`focus()` → WebviewFocusRegistry，见坑⑧）
- `apps/editor/src/renderer/services/editor/WebviewFocusRegistry.ts`（自动获焦句柄，带 pending-focus 队列，见坑⑧）
- `apps/editor/src/renderer/contributions/ExtensionsContribution.ts`（`_registerCustomEditor` + `toResolverGlob`）
- `apps/editor/e2e/specs/smoke.webview.spec.ts`（内联扩展全链路冒烟）
- VSIX 读取/安装：`packages/extension-packaging/src/vsix.ts` + `apps/editor/src/main/services/extensionManagement/extensionManagementService.ts`（`_installVSIX`）
- 计划文档：`docs/plan/extension-marketplace-plan/06-webview-customeditor-pdf.md`
- 相关 memory：[[extension-system-progress]]（运行时基座）、[[editor-input-identity-isolation]]（EditorInput id 隔离约定）、[[realpath-uri-ipc-revive]]（wire URI revive）
- 相关 skill：[extension-marketplace-management]（装/更新/卸载分发链路）、[extend-language-plugin]（语言 provider）、[fix-disposable-leak]（panel/document/iframe 生命周期）

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件。
