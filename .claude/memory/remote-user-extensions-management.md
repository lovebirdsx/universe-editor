---
name: remote-user-extensions-management
description: remote 工作区用户扩展全生命周期支持(安装/卸载/启停/UI 分组/Install in Remote)落地——协议 v6 + 本地验签分片上传远端的设计决策
metadata: 
  node_type: memory
  type: project
  originSessionId: 670a52f9-3b1f-4fcd-b541-4653d393eaef
  modified: 2026-08-20T01:53:37.075Z
---

remote 工作区用户扩展支持已落地(2026-08-20):`RemoteChannels.ExtensionManagement`(协议 v6)+ 契约 `node-services/src/extensions/extensionManagementProtocol.ts`;安装引擎下沉 `node-services/src/extensions/`(main 与 remote-server 共享);main 侧 `IExtensionManagementService` 9 方法带尾参 `authority?` 路由 `getServiceProxy`;renderer 门面/enablement 按 authority 聚合,ExtensionsView 分 `remoteAuthorityLabel` 与 Local 两组 + Install in Remote。目录知识见 `apps/editor/src/main/services/extensionManagement/CLAUDE.md` 远程路由节。

**Why**(非显然决策):
- 不做 VSCode 式 extensionKind 双 host 分流——本项目单 host 整体在远端,扩展装到远端才生效,安装路由简化为「remote 工作区默认装远端」。
- 下载+Ed25519 验签+防投毒+engines 校验全在**本地**完成,vsix 经隧道 ≤1MiB 分片上传(codec raw attachment),远端只重查 id/version——gallery 可能是内网地址远端不可达,且远端 bundle 不带 gallery/验签栈。
- `listBuiltinExtensions` 不按 authority 路由:远端内置随 bundle 部署与本机同源同 id,本机结果对 remote 有效。
- 远端用户扩展目录 `<dataDir>/user-extensions`(dataDir 默认 `~/.universe-editor-server`,跨版本稳定),与 extensionHostConnection 共用 `remote-server/src/serverPaths.ts` 单一真相;远端 host 本就恒扫该目录,装进去即被重扫生效。
- enablement global 态按 authority 存远端 extensions.json;workspace 态本就跟随工作区不动;`ExtensionHostClientService._disabledIds` 交集全集 remote 下换成「内置 ∪ 远端已装」。

**How to apply**:改远端扩展分发顺 `extensionManagementProtocol.ts` 契约走;renderer 取 authority 必须订阅 onDidChangeWorkspace(见 [[agent-settings-remote-authority-routing]]);e2e 直连模式 dataDir 在 `<userData>/remote-direct/<authority>`,spec 见 `e2e/specs/remote.extensions.spec.ts`(@regression)。相关:[[remote-dev-v2-full-stack]]、[[extension-system-progress]]。

Review 收口坑(2026-08-20):① builtin 条目 `remote=true` 只驱动 UI 分组,管理/图标调用必须经 `_authorityFor`(豁免 builtin 走本地——远端 server 只扫 user-extensions,路由过去图标恒空);② server 服务 per-connection 构建,extensions.json 写队列须模块级按 `path.resolve(userExtensionsDir)` keyed(实例级队列多窗口并发丢记录);③ refreshInstalled 与 search 一样要 seq 陈旧守卫,远端分支 catch 保留上次集合防断连空白+unhandled rejection。已知限制清单在 extensionManagement CLAUDE.md 远程路由节。
