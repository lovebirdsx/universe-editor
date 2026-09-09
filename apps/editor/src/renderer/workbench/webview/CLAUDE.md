# apps/editor/src/renderer/workbench/webview/CLAUDE.md

webview 的 iframe 宿主（`WebviewElement.tsx`）在本目录。本文是 webview / 自定义编辑器预览**基建**的上下文地图（五层架构 + 已知坑结论）；**写一个新预览扩展**（最常见的任务，照抄 pdf 范例）见 `extensions-external/pdf/CLAUDE.md`。十个已知坑的完整复盘（症状→根因→修法→守护用例）在 [cases-webview-pitfalls.md](cases-webview-pitfalls.md)，动 WebviewElement/CustomEditorHost 前通读。

## Webview / 自定义编辑器预览

对等 VSCode 的 `Webview` + `CustomReadonlyEditorProvider` API：扩展注册一个 `viewType`（manifest `contributes.customEditors` 绑到文件 glob），打开匹配文件时工作台开 tab + 沙箱 iframe，回调 `resolveCustomEditor` 让它设 `webview.html`/`options`。PDF 预览是首个实例；任何"用 HTML/JS 渲染某类文件"的预览（3D、音视频、CSV、自定义二进制格式…）都走这条路。

> ⚠️ 第一原则：**分清「造 API/宿主基建」还是「写一个用它的扩展」**。基建（五层）已就位且完整对标 VSCode——多数新预览扩展**只碰扩展侧**（写 `extension.ts` + manifest + 打包），根本不用动 packages/apps。只有预览需要**现有 API 尚无的能力**（文件监听 / 可编辑保存 / 状态持久化）时才回头扩 API。先判断，别默认从内核改起。
>
> ⚠️ 第二原则：**iframe 不是硬沙箱**。`sandbox="allow-scripts allow-same-origin"`（allow-same-origin 是为了让 `universe-app://root` 子资源能加载）。真正的护栏是**扩展声明的 CSP + 资源 allow-list**（只服务 `localResourceRoots` 下的文件）。外部扩展的 webview 里代码≈拥有扩展自身权限。**文档/UI 绝不能宣称它是等同网页的沙箱**（`docs/user/zh-CN/customization/extensions.md` 的措辞）。

## 五层架构（基建，多数扩展不用碰）

```
① 契约  packages/extension-api/src/webview.ts
        Webview(html/options/cspSource/asWebviewUri/postMessage/onDidReceiveMessage)
        WebviewPanel / CustomDocument / CustomReadonlyEditorProvider
        ⚠️ 改 API 必 version bump（package.json 同步 + COMPATIBILITY.md + index.test.ts 契约快照）
② 协议  packages/extensions-common/src/
        webviewProtocol.ts  fsPathToWebviewUrl（asWebviewUri 的纯函数实现）+ WEBVIEW_CSP_SOURCE
        manifest.ts/manifest-schema.ts  contributes.customEditors 类型 + zod
        rpc.ts  IMainThreadWebviews（host→renderer）/ IExtHostWebviews（renderer→host）+ 通道名
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
        workbench/editor/EditorArea.tsx + contributions/BuiltInEditorProvidersContribution.ts  组件映射 + deserialize
```

## asWebviewUri 必须同步 → 纯函数，不走 RPC

`webview.asWebviewUri(fileUri)` 在扩展里是**同步**调用（vscode-pdf 在 `resolveCustomEditor` 里直接拼 HTML 字符串），不能 RPC 往返。所以 host 侧调 `extensions-common` 的**纯函数** `fsPathToWebviewUrl(fsPath)` → `universe-app://root/_resource_/<编码后的绝对路径>`。这是 VSCode `asWebviewUri` 的等价物，复用既有特权协议（`main/ipc/resourceProtocol.ts` + allow-list `main/ipc/resourceRoots.ts`），**不新造协议**。`cspSource` = `universe-app://root`（`WEBVIEW_CSP_SOURCE`），扩展把它写进 CSP meta。

## 写一个新预览扩展（最常见任务）

骨架、out-of-workspace 构建套路、扩展侧代码要点全部在 `extensions-external/pdf/CLAUDE.md`（PDF 扩展是范例，照抄它）。本文档只保留基建与坑。

## 已知坑（结论级，完整复盘见 [cases-webview-pitfalls.md](cases-webview-pitfalls.md)）

1. **provider 注册竞态**：`CustomEditorHost` 首次 `openPanel` 失败必须订阅 `webviewService.onDidChangeProviders` 重试（~15s 超时兜底才判 failed）——改这块务必保留重试。
2. **localResourceRoots 漏文档目录 → 出 UI 但空内容**：扩展 `resolveCustomEditor` 里 `localResourceRoots: [扩展目录, 文档所在目录]`（PDF 的 `dirUri(document.uri)`）。
3. **iframe 继承 app-shell CSP（裸骨架真根因，别归咎 allowRoots）**：blank 文档必须导航到真实 URL `universe-app://root/_webview_blank_`（`WEBVIEW_BLANK_URL`，响应不带 CSP header），HTML 经 postMessage（`WEBVIEW_SETUP_MARKER`）送进常驻 loader 在**同源内** `document.write`——**iframe 永不重建**；主文档 CSP 必须保留 `frame-src 'self' universe-app:`。重型脚本（pdf.js）帧内 loader 收 message 会失效，文件变更重载走 `webview.postMessage` + 帧内脚本自己的 hook。
4. **allowRoots 与写 HTML 竞态（次要加固，非坑③真因）**：交出 HTML 前先 `await allowRoots(roots)`，`cancelled` 标志防旧 await。
5. **Ctrl+P 绕过 resolver 打开二进制**（[[editor-input-identity-isolation]] 通病）：打开文件入口一律走 `editorResolver.openEditor(uri, {pinned})`；跨 group 查重按 `uriIdentity.isEqual(editor.resource, uri)`，别 `instanceof FileEditorInput`。
6. **切 tab 再切回白屏（iframe 重建竞态）**：iframe 永不重建（见 3），`frameLoaded` 绑定唯一 iframe（只 fire 一次），html 变化只要 loaded 且非空就重发；`CustomEditorHost` 仍用 `key={panel.panelHandle}` 让**换 panel** 时整体重建。
7. **恢复路径绕过 resolver factory 不激活扩展**：`CustomEditorHost` mount effect 主动 `extensionHost.activateByEvent(customEditorActivationEvent(viewType))`（幂等）；任何「打开走 factory 做副作用」的编辑器，deserialize 恢复路径都要补同样的副作用。
8. **获焦三件事**：① 不自动获焦——`CustomEditorInput.focus()` → `WebviewFocusRegistry.requestFocus`（带 pending-focus 队列），聚焦在 HTML settle 后（`html!==''` 延迟 ~80ms）+ `wantFocusRef` 跨异步，聚焦后清 `editorTextFocus`/`editorFocus`（见 [[editor-text-focus-stuck-swallows-keys]]）；② 获焦后宿主快捷键失效——键事件不跨 iframe 边界，靠 `injectBootstrap` capture 监听 keydown：放行裸键、修饰键 postMessage 转发，`WebviewElement` 在 iframe 元素上 dispatchEvent 合成事件；③ 双触发——native 快捷键（ctrl/meta + P80/F70/S83/Z90/Y89）`stopImmediatePropagation()+preventDefault()` 防 pdf.js 式 capture 自响应脚本。
9. **帧内 Ctrl+W 关整个窗口**：bootstrap 里 `isNativeBrowserAction`（P/F/S/Z/Y/**W/N/R**）一律 `preventDefault()` 挡 Electron/Chromium 原生动作；其子集 `isPageHandledShortcut`（P/F/S/Z/Y）额外 `stopImmediatePropagation()`。
10. **custom-editor 晚注册竞态 → PDF 落兜底文本编辑器不自愈**：`EditorResolverService._upgradeOpenEditors(reg)` 在 registerEditor 成功后把已开 tab 升级成高优先级编辑器；`_explicitChoices` Set 跳过用户 Reopen With 的显式选择。**e2e 跑打包 out/ 且不自动构建**：离开 dev 模式必先全量 `pnpm build`（stale dist 曾致 `Method not found: $initializeWorkspaceTrust`）。

## 若要扩 API（可编辑保存 / 文件监听 / 状态持久化等）

沿五层动，**KEEP IN SYNC 两处 bridge 定义**（`extension-host/src/apiFactory.ts` 的 `IExtensionHostBridge` ⋈ `extension-api/src/index.ts` 的同名 interface + window 委托）。新增 RPC 方法同时加进 `IMainThreadWebviews` / `IExtHostWebviews` + WebviewService/HostWebviewManager 两侧实现。**API version bump**：`extension-api` 的 `version` 常量 + package.json 同步，minor 加法，补 COMPATIBILITY.md 变更行 + index.test.ts 契约快照。wire 上的 URI 记得 `URI.revive`（[[realpath-uri-ipc-revive]]）。

## E2E 验证

`apps/editor/e2e/specs/smoke.webview.spec.ts`（@p1@regression）是范例：**内联极简 custom-editor .vsix**（不依赖 pdf.js 重资产，headless 稳定）走全链路（installVsixExtension → openFileUri → poll `getActiveEditorTypeId()==='customEditor'` → `frameLocator('[data-testid="webview-frame"]')`）。内联扩展**直接调 `globalThis['__universeExtensionHostBridge__']`**。两条守护：(a) `asWebviewUri` 一个小 CSS 资源并断言 computed style 生效（守护坑④——纯内联 HTML 检查在子资源 403 时仍会绿）；(b) 声明自己的 meta CSP + inline script 写标记并断言出现（守护坑③）。真资产扩展（如 PDF 渲染 `<canvas>`）建议本地临时 spec 验完即删，重资产/console dump spec 别留进 CI。改了 renderer 必先 `pnpm build`。

## 安全红线（restricted host + webview = 新攻击面）

- restricted host **无 AI、无密钥**通道；webview 更不给任何密钥/AI（[[ai-service-foundation-progress]] 的红线延伸）。
- iframe `sandbox` 无 `allow-same-origin` 是理想，但本仓库因 `universe-app://` 子资源加载需要它——真护栏是 **CSP + 资源 allow-list**：只 `asWebviewUri` 到扩展目录 + 声明的 `localResourceRoots`，越界经 `isPathAllowed` 403。
- `postMessage` 载荷须可结构化克隆；host 侧处理 `vscode.open` 等命令走白名单。
- 文档**不得**把 iframe 说成硬沙箱。

## 验证

```bash
pnpm check                                    # lint+typecheck+test，仅看错误
pnpm build                                    # e2e 跑 out/ 产物，改 renderer/main 后必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts specs/smoke.webview.spec.ts
pnpm docs:check                               # 动了 docs/user 后校验死链
# 扩展侧：cd extensions-external/<name> && node esbuild.config.mjs && node scripts/pack.mjs
```

## 关键参考路径

- `extensions-external/pdf/`（**范例扩展，照抄它**，authoring 套路见其 CLAUDE.md）
- `packages/extension-api/src/webview.ts` + `index.ts`（契约 + version bump 点）
- `packages/extensions-common/src/protocol/webviewProtocol.ts`（`fsPathToWebviewUrl` 纯函数——asWebviewUri 白拿）
- `packages/extension-host/src/hostWebviews.ts`（HostWebviewManager 句柄模型）
- `apps/editor/src/renderer/services/extensions/WebviewService.ts`（跨 tier 单例路由）
- `apps/editor/src/renderer/workbench/webview/WebviewElement.tsx`（iframe + 桥，头注释讲清非硬沙箱）
- `apps/editor/src/renderer/workbench/editor/CustomEditorHost.tsx`（竞态修复在此）
- `apps/editor/src/renderer/services/editor/{CustomEditorInput,WebviewFocusRegistry}.ts`（focus 句柄，见坑⑧）
- `apps/editor/src/renderer/contributions/ExtensionsContribution.ts`（`_registerCustomEditor` + `toResolverGlob`）
- VSIX 读取/安装：`packages/extension-packaging/src/vsix.ts` + `apps/editor/src/main/services/extensionManagement/extensionManagementService.ts`
- 相关 memory：[[extension-system-progress]]（运行时基座）、[[editor-input-identity-isolation]]（EditorInput id 隔离约定）、[[realpath-uri-ipc-revive]]（wire URI revive）
- 相关：`apps/editor/src/main/services/extensionManagement/CLAUDE.md`（装/更新/卸载分发链路）；skill [extend-language-plugin]、[fix-disposable-leak]

## 其它
- 后续发现新经验，需同步更新本文件。
