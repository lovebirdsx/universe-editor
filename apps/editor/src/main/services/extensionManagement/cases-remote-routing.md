# cases-remote-routing

> 本文从 [CLAUDE.md](CLAUDE.md) 的「远程路由」节外溢，范围是：远端扩展管理的**路由决策与坑**——为什么不做双 host 分流、哪些调用刻意不路由、enablement 的 per-authority 语义、服务端写队列与 renderer 刷新守卫。机制总览与 9 个带 `authority?` 尾参的方法清单见 [CLAUDE.md](CLAUDE.md)。

## 不做 VSCode 式 extensionKind 双 host 分流

VSCode 允许同一扩展按 `extensionKind` 决定跑本地还是远端（UI 扩展留在本地）。本项目**单 host**、整体在远端：扩展装到远端才生效，本地那份装了也不会被加载。于是安装路由简化为一条规则——**remote 工作区默认装远端**，不引入 per-extension 的 kind 判定。

## `listBuiltinExtensions` 刻意不按 authority 路由

远端内置扩展随 bundle 部署，与本机**同源同 id**（同一份 `extensions/` 产物），所以本机读到的结果对 remote 工作区同样有效。路由过去反而错：远端 server 只扫 `<dataDir>/user-extensions`，查内置结果恒空，Extensions 视图里所有内置扩展的图标会消失。main 侧 `extensionManagementService.ts:263`（本目录）的实现只读本地内置目录、没有 `authority` 参数——这不是漏了尾参。

## enablement 的 per-authority 语义

- **global 态按 authority 存**：远端有它自己的 `extensions.json`（在远端 `<dataDir>` 下，经 `RemoteChannels.ExtensionManagement` 读写），禁用一个远端扩展不会连累本机同名扩展。
- **workspace 态跟随工作区不动**：workspace 级 enablement 本来就绑在 workspace 上，remote 工作区天然是另一个 workspace，无需按 authority 再加一层。

**坑（`ExtensionHostClientService._disabledIds`，`renderer/services/extensions/ExtensionHostClientService.ts:459`）**：远端 host 扫描的是「内置 ∪ 远端已装」，所以传给 `UNIVERSE_DISABLED_EXTENSIONS` 的 id 全集必须**与这个扫描面求交集**。直接喂 `getEffectiveDisabledIds()` 的全集时，一个只在远端装过的扩展被禁用后永远进不了 `UNIVERSE_DISABLED_EXTENSIONS`——远端 host 那份失效，禁用看起来「没生效」。代码注释就守这一条。

## `_authorityFor` 必须豁免 builtin

builtin 条目的 `remote = true` **只驱动 UI 分组**（Extensions 视图把「远端可用」的内置扩展归到 Remote 组），不代表它可以通过远端通道管理。所有按 authority 分流的**管理 / 图标调用**都要过
`ExtensionsWorkbenchService._authorityFor`（`ExtensionsWorkbenchService.ts:649`）：

```ts
return entry.remote && !entry.isBuiltin ? this._authority : undefined
```

漏掉 `!entry.isBuiltin` 的后果同上——远端 server 只扫 user-extensions，路由过去图标恒空；卸载 / 启用禁用也会打到不存在的条目上。

## 服务端写队列必须是模块级、按目录 keyed

远端 `extensionManagementService` 是 **per-connection 构建**的（每个连接一套实例），但 `extensions.json` 的写是**同一份文件**。写队列因此不能挂在实例上——多窗口 / 多连接并发时，各实例的队列互不可见，两次读-改-写交错就会**丢记录**。`packages/remote-server/src/extensionManagementService.ts:56` 的 `writeQueues: Map<string, Promise<unknown>>` 是模块级的，key 取 `path.resolve(this._userExtensionsDir)`（`:207`），保证同一目录的写串行、不同数据目录互不阻塞。

## renderer 刷新的两条守卫

`renderer/services/extensionsWorkbench/ExtensionsWorkbenchService.ts` 的 `refreshInstalled`（`:329`）与 `_search` 一样要 seq 陈旧守卫：

- `const seq = ++this._refreshSeq`，每个 `await` 之后比 `seq !== this._refreshSeq` 就放弃（`:340`、`:352`）——切换工作区时旧 authority 的响应不能覆盖新状态。
- **远端分支必须 catch 并保留上次集合**：`getInstalled(authority).catch(() => this._remoteInstalled)`（`:336`）。断连时不让异常冒泡（列表整片空白 + unhandled rejection），而是继续显示上一次的远端列表。

## e2e：直连模式的数据目录与 spec

e2e 直连模式（`UNIVERSE_REMOTE_SERVER_CMD`）下 daemon 的 `--data-dir` 落在
`<userData>/remote-direct/<authority>`（`apps/editor/src/main/services/remote/remoteConnectionMainService.ts:622` 的 `_bringUpDirect`），所以每个 authority 的远端 `user-extensions`、`extensions.json` 天然隔离，且被安装引擎与远端 host 共用（两者都从 `remote-server/src/serverPaths.ts` 解析）。

扩展侧的远端 spec 是 `apps/editor/e2e/specs/remote.extensions.spec.ts`（`@regression`）：本地构建 `.vsix` → 上传安装进 daemon 的 `<dataDir>/user-extensions` → 远端 host 重扫后贡献的命令出现 → 卸载同时清掉记录与命令；另一条用例禁用远端扩展并断言生效的 disabled 集合随之变化。
