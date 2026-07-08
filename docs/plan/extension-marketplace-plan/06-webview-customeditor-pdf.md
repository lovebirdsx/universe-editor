# 06 · Webview / CustomEditor API + PDF 预览扩展（市场第一个扩展）

> 目标：为扩展系统补上 VSCode 式 **Webview + CustomEditor** 能力，并把 PDF 预览
> 作为**第一个走市场安装链路（`.vsix` → restricted host）的真扩展**落地。

## 决策（已拍板）

- **API 完整度**：完整对标 VSCode（`WebviewPanel` / `CustomReadonlyEditorProvider` /
  `asWebviewUri` / `postMessage` 双向桥），使 vscode-pdf 近乎零改动移植，并为后续
  webview 类扩展铺路。
- **PDF 落地形态**：独立仓库（fork vscode-pdf）打成 `.vsix`，经现有
  `workbench.extensions.action.installFromVSIX` 装进 **restricted host**。

## 现状约束（调研结论）

1. **扩展 API 无 Webview/CustomEditor**：`packages/extension-api/src/index.ts` 仅有
   `languages/commands/window/workspace/scm/ai`。vscode-pdf 依赖的
   `window.registerCustomEditorProvider` + `WebviewPanel` + `asWebviewUri` 全缺。
2. **预览编辑器都是内置 renderer 组件**：图片 = `ImageEditor.tsx` + `ue-file:`；
   markdown = `MarkdownView`。走 `editorComponentMap` + `EditorRegistry` +
   `IEditorResolverService` 三处绑定，非扩展。
3. **资源沙箱基础设施已就位**（关键复用点）：
   - `universe-app://root/_resource_/<abs-path>` 特权协议 —— `main/ipc/resourceProtocol.ts`
   - allow-list —— `main/ipc/resourceRoots.ts`（`allowResourceRoots` / `isPathAllowed`）
   - `asPreviewResourceUri` —— `renderer/workbench/markdown/resourceUri.ts`（= VSCode `asWebviewUri`）
   这三者正是 VSCode `asWebviewUri` + `localResourceRoots` 的等价物，webview 层直接复用。
4. **VSIX 安装链路已存在**：`installVSIX` 命令 + management 服务落盘 restricted host。
5. **restricted host 无 AI**（trusted-only），fs 只走网关。webview 给 restricted host
   是本方案最大的**新增攻击面**，安全约束见 Phase B。

## Phase A — Webview 承载基础设施（宿主，不碰扩展 API）

- **main**：`resourceRoots` 允许把「扩展安装目录」加入 allow-list，使
  `universe-app://root/_resource_/<扩展目录>/...` 能加载 pdf.js 的
  `pdf.mjs`/`pdf.worker.mjs`/`cmaps`/`standard_fonts`（vscode-pdf assets ≈19MB）。
  接线点：扩展激活/解析 customEditor 时，把 `localResourceRoots`（扩展目录 + 文档目录）
  经 IPC 喂给 `allowResourceRoots`。
- **renderer**：新建 `workbench/webview/WebviewElement.tsx`
  - `<iframe sandbox="allow-scripts">` 承载扩展给的 HTML
  - CSP 注入（对齐 vscode-pdf 的 `Content-Security-Policy` meta，`cspSource` = `universe-app://root`）
  - `postMessage` 双向桥（renderer ↔ iframe）
  - `asWebviewUri(fileUri)` → `universe-app://root/_resource_/...`（复用 `resourceUri.ts` 逻辑，抽公共函数）
- 复用 `resourceProtocol.ts`，**不新造协议**。

## Phase B — 扩展 API 契约：Webview + CustomEditor

- `extension-api/src/index.ts`：新增类型 + 命名空间方法
  - `Webview`（`html` / `options` / `asWebviewUri` / `cspSource` / `postMessage` / `onDidReceiveMessage`）
  - `WebviewPanel`（`webview` / `onDidDispose` / `reveal` / `dispose`）
  - `CustomDocument` / `CustomReadonlyEditorProvider`（`openCustomDocument` / `resolveCustomEditor`）
  - `window.registerCustomEditorProvider(viewType, provider, options)`
  - **`version` 从 `0.1.0` bump**（COMPATIBILITY.md + 契约快照同步）
- `apiFactory.ts` + `IExtensionHostBridge`：对应 bridge 方法（HTML 设置、postMessage 双向、
  asWebviewUri、customEditor 注册/回调）。**KEEP IN SYNC** 两处 bridge 定义。
- `extensions-common`：`contributes.customEditors` 类型（`manifest.ts`）+ zod 校验
  （`manifest-schema.ts`，`viewType` / `displayName` / `selector[].filenamePattern`）。
- **RPC**：`ExtensionHostClientService` ↔ host 新增 webview 消息通道（渲染 HTML、
  postMessage 双向流、asWebviewUri 请求、document 生命周期）。
- ⚠️ **安全红线（restricted host + webview）**：
  - iframe `sandbox` 不含 `allow-same-origin`，脚本无法读宿主 DOM/cookie。
  - webview 只能 `asWebviewUri` 到「扩展目录 + 声明的 localResourceRoots」，
    经 `isPathAllowed` 强校验，越界 403。
  - **绝不给 webview 任何密钥/AI 通道**（restricted host 本就无 AI）。
  - postMessage 载荷必须可结构化克隆，host 侧对 `vscode.open` 等命令走白名单
    （对齐 vscode-pdf 的 `onDidReceiveMessage` → `commands.executeCommand('vscode.open', ...)`）。
  - 文档/UI **不得宣称沙箱等同 web**——如实写「webview 内代码接近扩展自身权限，
    但受 CSP + 资源 allow-list 约束」。

## Phase C — CustomEditor 接入编辑器系统

- `ExtensionPointTranslator`：新增处理 `customEditors` 贡献点
  - 按 `selector.filenamePattern` 调 `IEditorResolverService.registerEditor`
    （priority 100，`.pdf` 覆盖 catch-all）
  - 向 `editorComponentMap` 动态注册 webview 宿主组件
- 新建 `services/editor/CustomEditorInput.ts`（虚拟 EditorInput）
  - `typeId` 按 `viewType` 命名空间隔离（遵守 [[editor-input-identity-isolation]]）
  - 携带 `resource` + `viewType`，可序列化以支持窗口恢复
- 新建 `workbench/editor/CustomEditorHost.tsx`
  - 承载 `WebviewElement`，桥接到 host 里扩展的 `resolveCustomEditor`
  - 生命周期：tab 关闭 → dispose document + webview（对标 vscode-pdf `onDidDelete`）
- provider 注册进 `BuiltInEditorProvidersContribution`（deserialize）。

## Phase D — vscode-pdf 移植为 Universe 扩展（.vsix）

- fork vscode-pdf（独立仓库）：
  - `import "vscode"` → `@universe-editor/extension-api`
  - `context.extensionPath` / `webview.asWebviewUri` / `postMessage` / `webview.html` 语义对齐
  - `WebviewCollection` / `PDFDocument` / `PDFViewerProvider` 基本可原样保留
- manifest：`engines.universe`（匹配 bump 后的 API version）+
  `contributes.customEditors`（`pdf.view` / `filenamePattern: *.pdf`）+
  配置项（`pdf.defaultZoomValue` / `pdf.sidebarViewOnLoad`）
- 打包 pdf.js assets（19MB）进 VSIX（注意 `files` 数组 + `.vscodeignore` 等价）
- 装：`workbench.extensions.action.installFromVSIX` → restricted host 落盘 → 重扫激活

## Phase E — 验证 / 文档 / e2e

- `pnpm check`（lint+typecheck+test，仅看错误）
- 新增单测：
  - `extension-api` 契约快照（webview/customEditor 类型）
  - `ExtensionPointTranslator` 处理 customEditors
  - `resourceRoots` 扩展目录 allow-list
- e2e（`@p1`）：装 pdf `.vsix` → 打开 `.pdf` → webview iframe 渲染出 pdf.js canvas。
  install 走文件对话框，复用现有 `installVsixExtension` 探针（`shared/e2e/contract.ts`）。
  改 renderer/main 后 `pnpm --filter editor build` 再跑。
- 文档：更新 `docs/user/zh-CN/customization/extensions.md`（新增 webview 能力 +
  安全边界如实说明）；`pnpm docs:check` 校验死链。

## 关键文件清单（改动落点）

**新建**
- `apps/editor/src/renderer/workbench/webview/WebviewElement.tsx`
- `apps/editor/src/renderer/workbench/editor/CustomEditorHost.tsx`
- `apps/editor/src/renderer/services/editor/CustomEditorInput.ts`

**改动**
- `packages/extension-api/src/index.ts`（+ 类型 + 命名空间 + version bump）
- `packages/extension-host/src/apiFactory.ts`（+ bridge 方法）
- `packages/extensions-common/src/{manifest,manifest-schema}.ts`（+ customEditors）
- `apps/editor/src/renderer/services/extensions/ExtensionPointTranslator.ts`（+ customEditors 处理）
- `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts`（+ webview RPC）
- `apps/editor/src/main/ipc/resourceRoots.ts`（扩展目录 allow-list 接线）
- `apps/editor/src/renderer/workbench/editor/EditorArea.tsx`（editorComponentMap 动态注册）
- `apps/editor/src/renderer/contributions/BuiltInEditorProvidersContribution.ts`（CustomEditorInput deserialize）

**外部**
- fork vscode-pdf → `.vsix`（Phase D）

## 风险 / 注意

- **API version bump** 牵动契约快照测试 + COMPATIBILITY.md，须同步。
- **RPC 序列化**：webview HTML/postMessage 载荷经 ProxyChannel 须可结构化克隆；
  URI 用 revive（参照 [[realpath-uri-ipc-revive]]）。
- **disposable 泄漏**：webview/document/iframe 生命周期严格 `_register`，
  参照 [[fix-disposable-leak]]、[[editor-group-open-orphan-leak]]。
- **restricted host webview = 新攻击面**，Phase B 安全红线不可削。
- 工作量集中在 Phase A–C（宿主 + API + RPC）；Phase D 移植相对机械。
