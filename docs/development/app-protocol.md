# `universe-app` 协议（renderer 自定义 scheme）

prod 的 renderer 页面不走 `file://`，而是 `universe-app://root/index.html`。本文记录**为什么必须这样**（Chromium 的拦截时机）、单 handler 的双用途、注册时序与 dev 差异、origin 变更的副作用。实现集中在 `apps/editor/src/main/ipc/resourceProtocol.ts`。

## 为什么从 `file://` 改 scheme（关键坑，实测确认）

自定义 secure scheme 的资源**从 `file://` 页面加载不通**——Chromium 在请求发起前就拦截，**请求根本到不了 `protocol.handle` handler**（诊断表现：scheme 注册成功、handler 装了、但从未有 request 到达；`fetch` 与 `<img>` 一样）。**且不同 authority 也算跨 origin、同样被拦**（secure standard scheme）。

VSCode 能用自定义 scheme，是因为它 prod 页面本身就是 `vscode-file://` —— **shell 与资源同 scheme**。所以我们的做法是让 shell 也搬进 `universe-app`：不是给图片开一条特殊通道，而是把整个页面换 origin。

## 单 handler 双用途

- `universe-app://root/<path>` → `out/renderer/<path>`（shell + assets）。
- `universe-app://root/_resource_/<encoded-abs-path>` → 任意本机文件，**先过 allow-list 边界校验**再读盘（`main/ipc/resourceRoots.ts` 是不含 electron 依赖的纯逻辑，可 node 单测）。

资源与 shell **同一 origin `universe-app://root`**，靠路径前缀 `/_resource_/` 区分——**不是不同 authority**（换 authority 会被上一条拦掉）。renderer 相对 asset（`./assets/...`，vite 默认 base）天然解析到同 scheme。`APP_SHELL_URL` / `RESOURCE_PATH_PREFIX` 是这两个形状的常量出口（`resourceProtocol.ts`）。

边界 allow-list 由 **renderer** 经 `IResourceAccessService.allowRoots` 声明（套路 C 服务，通道 ResourceAccess；`main/services/resourceAccess/`、`shared/ipc/resourceAccessService.ts`）——main 不预先知道任何目录，授权与 `webSecurity` 无关。

## 注册时序（唯一一次调用）

- `protocol.registerSchemesAsPrivileged([...])` **必须在 `app.whenReady()` 前**（`apps/editor/src/main/index.ts:176`），且**只能有一次调用**——后一次会覆盖前表，所以 IMAGE_SCHEME_PRIVILEGE 与 APP_SCHEME_PRIVILEGE 合并进同一个数组。
- `installAppProtocolHandler(rendererDir)` 在 whenReady 内（`main/index.ts:756`，与 `installImageProtocol()` 并列）。
- `will-navigate` 放行 `universe-app:`；`WindowMainServiceOptions.rendererHtml` 字段已删（`loadFile` 不再用）。

## dev 与 prod 的差异

dev 页面是 `http://localhost`（Vite），图片走 `universe-app://` 仍跨 origin → **仅当存在 `rendererUrl` 时**给 dev 窗口设 `webSecurity: false`（`main/services/window/windowMainService.ts:260`）。prod 保持开启：资源边界在 handler 内校验，与 `webSecurity` 无关——别把 dev 的放宽误读成「prod 也靠 webSecurity 挡」。

## 副作用：origin 变更即存储分区变更

prod origin 从 `file://` 变 `universe-app://root`，renderer 的 `localStorage` / `sessionStorage` 按 origin 分区会「重置」——项目状态走 main `state.json` 不受影响；开发期不考虑向后兼容。

## 相关

- markdown 侧接线（本地图片的放行与 URI 转换）见 `apps/editor/src/renderer/workbench/markdown/cases-preview.md`。
- webview iframe 用同一 scheme 服务子资源，另有一条「blank 文档 / CSP 继承」的坑链：`apps/editor/src/renderer/workbench/webview/cases-webview-pitfalls.md`。
