---
name: extension-host-runtime
description: 处理"扩展宿主运行时 / 双信任层 / RPC 桥 / 启用禁用生效链"相关功能时召回——本仓库对等 VSCode 的 extension host 运行时那层：装好的扩展如何被 spawn 进独立子进程、如何按信任级隔离（trusted 内置 vs restricted 外部）、renderer↔host 的 MainThread*/ExtHost* RPC 桥如何接、静态贡献命令如何路由到属主 tier、崩溃/workspace 切换/启用禁用如何触发受控重启，以及"启用/禁用扩展"的完整决策与生效链（renderer 决策引擎 ExtensionEnablementService → effective disabled ids → host 启动 spec.disabledIds → env UNIVERSE_DISABLED_EXTENSIONS → bootstrap 扫描过滤）。当任务涉及：给 host 加一条新的 MainThread*/ExtHost* 通道（暴露一个新的宿主能力给扩展）、改 host 生命周期（懒启动/崩溃重启/workspace 重启/reload 回收）、改双 host 隔离边界（哪些能力只给 trusted）、改启用禁用（global/workspace 4 态、作用域、生效方式、per-tier 只重启受影响层）、内置插件也可禁用、host 进程 spawn/env/Node 权限模型、命令路由账本（\_commandOwner）、或排查"扩展装了但命令不生效/host 不重启/禁用不生效/tsserver 被无谓重启"时使用。给出运行时四层文件地图（main 进程 host service → shared IPC 契约 → renderer HostConnection+ExtensionHostClientService+MainThread\* → 决策 ExtensionEnablementService）、加一条 RPC 通道的清单、启用禁用生效链、双 host 隔离规则、per-tier 重启签名、易踩坑。区别于：extension-marketplace-management（获取→安装→更新→卸载→信任治理的分发链路，到"落盘 + fire onDidChangeExtensions"为止）、create-extension（起一个新扩展骨架 + 贡献点）、extend-language-plugin（语言 provider 四数据流，是本层 mainThreadLanguages 桥的下游）、webview-custom-editor（webview 桥，是本层的一条具体通道）——本 skill 是"装好的扩展怎么被加载运行、宿主能力怎么暴露、启用禁用怎么生效"的运行时管道本身。
disable-model-invocation: true
---

# 扩展宿主运行时（双信任层 + RPC 桥 + 启用禁用生效链）

对等 VSCode 的 extension host 运行时那层。核心判断（本仓库已确立）：**分发链路早已就绪**（`.vsix`/市场安装、`<userData>/extensions` 落盘、`extensions.json` 见 skill `extension-marketplace-management`），本层是**装好之后**——扩展怎么被 spawn 进独立进程、怎么按信任级隔离、怎么通过 RPC 桥拿到宿主能力、启用禁用怎么生效。

> ⚠️ 第一原则：**先分清运行时 vs 分发**。"获取→安装→更新→卸载→信任治理"是**分发**（skill `extension-marketplace-management`），它到 `fire onDidChangeExtensions` → `ExtensionsContribution` 触发 `refreshExtensions()`（restricted host 重扫）为止。**重扫之后**——spawn、RPC、命令注册、崩溃重启——是**运行时**，是本 skill。两端别混。
>
> ⚠️ 第二原则：**运行时也分层，别改错层**。① main 进程 `extensionHostMainService` 只管**搬字节**（spawn Electron-as-node + 抽 stdio，keyed by opaque handle），不懂 RPC。② shared IPC 契约（`extensionHostService.ts` 的 `ExtHostStartSpec`/`start`/`onStdout`…）。③ renderer 是 **RPC 对端**——`HostConnection`（一连接=一 protocol+client+server+全部 `MainThread*` 通道）+ `ExtensionHostClientService`（管两 tier 生命周期 + 命令路由）+ 各 `MainThread*.ts`（把宿主能力实现出来）。④ 决策层 `ExtensionEnablementService`（启用禁用 4 态引擎）。改暴露给扩展的能力→②③；改进程生命周期→③（外加①的 spawn/env）；改启用禁用→④＋生效链。

## 架构总览（运行时四层）

```
① main 进程（搬字节，不懂 RPC）
   apps/editor/src/main/services/extensionHost/extensionHostMainService.ts
       spawn(process.execPath, [entry], {ELECTRON_RUN_AS_NODE})；按 kind 设 env；treeKill 回收 tsserver 孙子进程
       start(spec)/writeStdin/stop/stopAll/hasUserExtensions；onStdout/onStderr/onExit（keyed by handle）
   apps/editor/src/main/services/extensionHost/builtinExtensionsDir.ts   内置目录单一真相（host 扫描 + 管理服务列举 都用它）
   apps/editor/src/main/services/extensionHost/userExtensionsDir.ts      外部扩展目录（<userData>/extensions）
   apps/editor/src/main/services/extensionHost/tsServerPaths.ts          vendored tsserver CLI 路径（typescript 内置插件用）

② shared IPC 契约
   apps/editor/src/shared/ipc/extensionHostService.ts   IExtensionHostService + ExtHostStartSpec{kind,workspaceRoot?,locale?,extensionsDir?,disabledIds?}

③ renderer（RPC 对端 + 生命周期 + 能力实现）
   apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts   两 tier 生命周期 + 贡献合并 + 命令路由账本 + 崩溃/workspace/启用禁用重启
   apps/editor/src/renderer/services/extensions/HostConnection.ts               一连接的全部 RPC 接线（ExtHost* client + MainThread* server）
   apps/editor/src/renderer/services/extensions/MainThread*.ts                  宿主能力实现（Commands/Window/Fs/Output/Languages/Editor/Ai/Storage + Scm/Webview 服务）
   apps/editor/src/renderer/services/extensions/ExtensionPointTranslator.ts     manifest 静态贡献（commands/menus/keybindings/configuration）→ core 注册表
   apps/editor/src/renderer/contributions/ExtensionsContribution.ts             启动编排：start→getContributions→translate→activate + 监听 onDidChangeExtensions 重扫 + 恶意隔离
   packages/extension-host/src/bootstrap.ts                                     host 进程入口：扫描 + 按 UNIVERSE_DISABLED_EXTENSIONS 过滤 + 注册 ExtHost* 通道
   packages/extensions-common/src/rpc.ts                                        ExtHostChannels 通道名 + 所有 IMainThread*/IExtHost* 接口 + wire DTO

④ 决策层（启用禁用 4 态引擎）
   apps/editor/src/renderer/services/extensions/ExtensionEnablementService.ts   global(main extensions.json)+workspace(renderer WORKSPACE storage) 合并决策 → getEffectiveDisabledIds
   apps/editor/src/main/services/extensionManagement/extensionManagementService.ts   getDisabledIds/setEnablement（global 落盘）+ listBuiltinExtensions
   apps/editor/src/renderer/services/extensionsWorkbench/ExtensionsWorkbenchService.ts   门面：聚合内置+外部→IExtensionEntry(含 enablementState) + setEnablement 转发
   apps/editor/src/renderer/actions/extensionsActions.ts                        4 个 enablement 命令（VSCode 对齐 ID）
```

## ① main 进程 host service

`ExtensionHostMainService` **只搬字节**，照抄 `AcpHostMainService`：`spawn(process.execPath, [entry], { env: {ELECTRON_RUN_AS_NODE:1, ...} })`——用 Electron 自带 node，**不依赖系统 node/npx**。每个进程一个 opaque `handle`（randomUUID），`onStdout/onStderr/onExit` 都带 handle，renderer 按 handle 分流。

- **按 kind 分叉 env**（`start(spec)`）：
  - `trusted`：`UNIVERSE_BUILTIN_EXTENSIONS_DIR`（内置目录）+ `UNIVERSE_TSLS_CLI`/`UNIVERSE_TSLS_TSSERVER`（typescript 插件自 spawn tsserver 用）。
  - `restricted`：`UNIVERSE_USER_EXTENSIONS_DIR` + 可选 Node 权限模型 argv（见下）。
  - 两者共用：`UNIVERSE_EXT_HOST_KIND`、`UNIVERSE_WORKSPACE_ROOT`（workspace 根）、`UNIVERSE_DISPLAY_LOCALE`（manifest NLS）、`UNIVERSE_DISABLED_EXTENSIONS`（**启用禁用生效点**，见下）。
- **treeKill 回收孙子进程**：host fork 出 grandchild（typescript 插件 → tsserver）。优雅停（`stop` 关 stdin / `stopAll` before-quit / renderer `beforeunload`）让 CLI 自己的 exit hook 回收 tsserver；**treeKill 是 backstop**（硬 SIGKILL 会甩掉慢启动的 tsserver 成孤儿，卡 Playwright teardown、给真实用户留 stray electron.exe）。这条链路的坑详见 memory [[agent-binary-silent-download-e2e-fix]]。
- **Node 权限模型 opt-in**（`_permissionArgs`）：`UNIVERSE_EXT_HOST_PERMISSION=1` 才启用 `--experimental-permission --allow-fs-read=<extDir>`，且先 `spawnSync` 探测支持性，不支持降级软隔离。**默认关**——窄 fs-read 可能让 Electron-as-node 读不到自身资源而崩溃循环，本机不可验证。

## ③ renderer RPC 桥（本层最常改的地方）

**RPC 对端是 renderer 不是 main**（同 ACP）：命令路由目标 CommandsRegistry / View UI / SCM 状态都在 renderer。RPC 复用 platform 现成 `ChannelServer/ChannelClient/ProxyChannel`，唯一底层新代码是 stdio 适配器（`StdioFramingProtocol`，换行分隔 UTF-8 帧，不用 base64——JSON 转义了裸换行）。ProxyChannel 约定：`/^on[A-Z]/` 是事件，其余方法名直传 call。

- **`HostConnection`**：一条连接的全部接线。构造时建 protocol → `ChannelClient`（调 host 的 `ExtHost*` 通道）+ `ChannelServer`（托管 renderer 的 `MainThread*` 通道），按 kind 条件注册通道（见隔离规则）。`ExtensionHostClientService` 每 tier 持一个。
- **`ExtensionHostClientService`**：管 `_trusted`/`_restricted` 两连接。`start()` = `Promise.allSettled([_startTrusted, _startRestricted])`（受限失败只 warn，绝不拖垮 workbench 或 trusted）。`getContributions`/`activateByEvent` 合并 live 连接。
- **命令路由账本 `_commandOwner: Map<id, HostConnection>`**：runtime 命令各连接自带 `MainThreadCommands` 闭包自己的 extHost proxy（天然正确）；**静态贡献命令需账本**（`_fetchAndIndex` 记账 + `MainThreadCommands` ledger 回调），因为静态命令的 bootstrap proxy 调的是 client service 的 `executeContributedCommand`，得知道转发给哪个 tier。兜底 trusted。

### 加一条新的 MainThread\*/ExtHost\* 通道（暴露一个宿主能力给扩展）

对标 VSCode `MainThreadXxx`/`ExtHostXxx`。清单（以现有 `MainThreadOutput`/`MainThreadStorage` 为最简样板）：

1. **契约** `packages/extensions-common/src/rpc.ts`：`ExtHostChannels` 加通道名常量；定义 `IMainThreadXxx`（renderer 实现，host 调）和/或 `IExtHostXxx`（host 实现，renderer 调）接口 + wire DTO（**必须可结构化克隆**：URI 走 fsPath 字符串或 revive；二进制走 base64，见 `bytes.ts`，newline-JSON 不能传 Uint8Array）。
2. **host 侧** `packages/extension-host/src/`：`apiFactory.ts` 的 `IExtensionHostBridge` 加方法；`extensionService.ts` 实现并经 client 调 `IMainThreadXxx`；`bootstrap.ts` 建 client + 注册 `IExtHostXxx` 通道。
3. **extension-api** `packages/extension-api/src/`：加 namespace/类型（**enum 用普通 enum 非 const enum**——git 扩展 tsconfig 开 `isolatedModules`，跨模块访问 ambient const enum 报 TS2748）。
4. **renderer 侧** `MainThreadXxx.ts` 实现 `IMainThreadXxx`（注入所需 platform 服务）；`HostConnection.ts` 里 `server.registerChannel(ExtHostChannels.mainThreadXxx, ProxyChannel.fromService(...))`（若 host→renderer 方向还要 `client.getChannel` 建 ExtHost proxy）；能力仅给某 tier 时用 `deps.xxx` 条件注册（见隔离规则），依赖经 `HostConnectionDeps` 从 `ExtensionHostClientService._connect` 传入。
5. 建完 `pnpm --filter @universe-editor/extensions-common --filter @universe-editor/extension-host build`（dev watcher 自动，离开 dev 手动），apps 才看得到新符号。

**已有通道**（`ExtHostChannels`）：commands/window/scm/fs/output/languages/editor/ai/storage/webviews（`extHost*` + `mainThread*` 成对）。加能力前先看有没有能复用的。

## ③↔④ 双 host 信任级隔离规则（安全边界，勿拆）

**受限（restricted）host 拿不到高权能力**——通过 `HostConnectionDeps` 里把这些设为**可选**、只在 `kind === 'trusted'` 时传：

- **SCM**（`deps.scm`）：SCM 服务是全局单例，是 trusted 能力；受限连接不注册 `mainThreadScm`，host 侧 `createSourceControl` 在 `kind='restricted'` 时抛错（`extensionService.ts`）。**⚠️ teardown 必须对称按 tier 清理**：`ScmService._sourceControls` 是全局列表，但 provider 只注册在 trusted 宿主 → `_teardownConnection` 里 `resetSourceControls()` **只能在 `kind === 'trusted'` 时调**（与同处 `webview.reset(conn.kind)` 的按-tier 精确清理对齐）。无条件调用会让 restricted 宿主崩溃 / 工作区切换重启（`[trusted, restricted]` 顺序：trusted 先重注册好 provider，紧接 restricted teardown）把刚注册的 git/p4 provider 全清空 → 偶现 "No source control providers registered"、git+p4 同时消失、reload 或禁用启用任一插件才恢复。见坑速记 13。
- **语言特性**（`deps.languageFeatures` + `editorService`+`uriIdentity`）：语言插件 trusted-only（见 [[extend-language-plugin]]，是本层 `mainThreadLanguages` 桥的下游）。
- **AI 模型**（`deps.aiModel`）：AI 能力只给 trusted 内置扩展（贯穿红线）。
- **共享给两 tier**：commands/window/fs（走网关）/output/storage/webview。**fs 必走 `MainThreadFs` 网关**（复用 `AcpPathPolicy` 拒 .ssh/.aws/.env + 禁逃逸，cwd=workspaceRoot）；可信扩展要 raw node:fs 仍可直接用（git 即此）。

**贯穿红线**：密钥只走 main `ISecretStorageService`(safeStorage)，绝不进 renderer/wire DTO；**UI/文档不得宣称外部扩展已沙箱**（近乎原生 Node 权限，`docs/user/zh-CN/customization/extensions.md` 已如实写"接近编辑器本身的权限"）。

## ④ 启用/禁用：决策引擎 + 生效链

**完整 VSCode 4 态模型**（`EnablementState`：`DisabledGlobally`/`DisabledWorkspace`/`EnabledGlobally`/`EnabledWorkspace`）。内置也可禁用（对齐 VSCode，只是不可卸载）。实施全记录见 memory [[extension-enablement-feature]]。

- **决策引擎必须在 renderer**（`ExtensionEnablementService`）：workspace 态存 renderer `StorageScope.WORKSPACE`（跟随打开文件夹），只 renderer 有；global 态读 main `extensions.json`（经 `IExtensionManagementService.getDisabledIds/setEnablement`）。
- **解析优先级**（`getEnablementState`）：workspace disabled → workspace enabled → global disabled → 默认 `EnabledGlobally`（**workspace 覆盖 global**）。
- **`getEffectiveDisabledIds`** = global disabled（除非被 workspace enable 覆盖）∪ workspace disabled。这是 host 消费的**唯一输入**。
- **生效链（禁用不是运行时卸载，是扫描时过滤）**：
  ```
  ExtensionEnablementService.getEffectiveDisabledIds()
    → ExtensionHostClientService._tierDisabledIds(kind)  // 与该层 owned ids 求交（trusted→listBuiltinExtensions, restricted→getInstalled）
    → host.start({ disabledIds })                        // spec.disabledIds
    → main 写 env UNIVERSE_DISABLED_EXTENSIONS
    → bootstrap.ts 扫描时 extensions.filter(e => !disabled.has(e.id))
  ```
  改启用禁用的生效方式就顺这条链找。
- **per-tier 只重启受影响层**（`_onEnablementChanged`）：每 tier 记 `_launchedDisabledIds[kind]`（`disabledSignature` = 排序后 join 的 order-independent 签名），enablement 变更时只重启签名变了的 tier——**否则无谓重启 trusted 会杀 + 重 spawn tsserver**。restricted 可能需首次启动（之前全禁用），故先清 `_startingRestricted` memo。

## 生命周期：懒启动 / 崩溃 / workspace / reload

- **懒启动 + memo**：`_startingTrusted`/`_startingRestricted` 缓存 in-flight promise，幂等。restricted **无外部扩展不 spawn**（`host.hasUserExtensions()` 探测 `<userData>/extensions` 非空）。
- **崩溃重启**（`_handleCrash`）：异常退出码 → 指数退避重启（`RESTART_BASE_DELAY_MS * 2^(n-1)`）+ 滚动窗口 `MAX_RESTARTS=3`，超限给手动 Restart 通知。**planned stop 不计崩溃**（`_stopping` set）。
- **workspace 切换**（`_onWorkspaceChanged`）：host 启动时 pin workspace 根，切换需重启 live tier。**必须先 `await Promise.allSettled([_startingTrusted, _startingRestricted])`**——swap 可能撞上初始 boot 还在 spawn（Windows CI 更慢），此时 `this._trusted` 还没赋值，直接读会丢掉 swap，host 永远 pin 在空 workspace（git 看不到 rootPath 不注册 SCM）。
- **`_restart(kind, reason)`**：stop（reason='workspace' 时）→ 重 start → `_fetchAndIndex` → **fire `onDidChangeContributions`（重 translate）→ activateByEvent(STARTUP + STARTUP_FINISHED)**。重 translate 必须在 activation 前：新 host 的命令要先回到 core 注册表，才能被 onCommand proxy 命中。
- **reload 回收**（`beforeunload`）：window reload 销毁 renderer 但不 dispose service（async dispose 不跑），故 `beforeunload` 同步 `host.stop(handle)` 每个 live host——否则每次 reload 都孤儿一个重型 trusted host（自带 tsserver），e2e 全套跑下来堆积饿死后续 spawn。

## 常见任务 → 改哪里

- **暴露一个新宿主能力给扩展**（新 API namespace）：加一条 MainThread*/ExtHost* 通道，见上"加一条新通道"清单五步。
- **改某能力只给 trusted / 放给 restricted**：`HostConnectionDeps` 该字段可选性 + `HostConnection` 里 `if (deps.xxx)` 条件注册 + `ExtensionHostClientService._connect` 的 `kind === 'trusted' ? {...} : {}` 传参。
- **改 host spawn / env / 权限模型**：`extensionHostMainService.start`（env 分叉）+ `_permissionArgs`。
- **改内置/外部扫描目录**：`builtinExtensionsDir.ts` / `userExtensionsDir.ts`（单一真相，host 与管理服务共用）。
- **改启用禁用的 4 态语义 / 优先级**：`ExtensionEnablementService`（决策）。
- **改启用禁用生效方式**：生效链五环（enablement → \_tierDisabledIds → spec.disabledIds → env → bootstrap filter）。
- **改启用禁用命令 / 快捷键 / 菜单**：`extensionsActions.ts`（4 个 VSCode 对齐 ID：`extensions.enableGlobally`/`disableGlobally`/`enableForWorkspace`/`disableForWorkspace`），在 `actions/index.ts` 注册（套路 A）。workspace 命令先 `ctx.enablement.hasWorkspace()` 检查。
- **改扩展列表 UI 的启用禁用呈现**：门面 `ExtensionsWorkbenchService`（`IExtensionEntry.enablementState`/`isBuiltin`）+ `workbench/extensions/{ExtensionsView,ExtensionEditor}.tsx`。
- **改静态贡献翻译**（manifest commands/menus/keybindings/configuration → core）：`ExtensionPointTranslator.ts`。
- **改崩溃/重启策略**：`ExtensionHostClientService` 的 `_handleCrash`/`_restart`/`MAX_RESTARTS`。
- **扩展怎么被安装/更新/卸载到磁盘**：**不在本 skill**，是分发链路（skill `extension-marketplace-management`）。本 skill 从 `onDidChangeExtensions` → `refreshExtensions()` 接手。
- **语言 provider（definition/hover/诊断…）怎么写**：**不在本 skill**，是 `mainThreadLanguages` 桥的下游（skill [[extend-language-plugin]]）。
- **起一个全新扩展骨架 + 贡献点**：skill `create-extension`。

## 易踩坑速记

1. **RPC 对端是 renderer 不是 main**：main 只搬 stdio 字节。想暴露能力别往 main 加逻辑，往 renderer 的 MainThread* 加。
2. **wire DTO 必须可结构化克隆**：URI 用 fsPath/revive、二进制用 base64（`bytes.ts`）。newline-JSON 帧传不了 Uint8Array。
3. **extension-api 的 enum 用普通 enum**（非 const enum）：扩展 tsconfig 开 `isolatedModules`，const enum 跨模块报 TS2748。
4. **改 platform/extensions-common/extension-host 后先重建 dist**：`pnpm --filter @universe-editor/extensions-common --filter @universe-editor/extension-host build`（dev watcher 自动），否则 apps/host 看的是旧产物。
5. **workspace swap 前必 `await` in-flight start**：否则撞上初始 boot spawn 中，`_trusted` 未赋值，丢 swap，host pin 空 workspace（git 不注册 SCM）。
6. **per-tier 重启签名**：enablement 变更别无脑重启两 tier——trusted 重启杀 tsserver。用 `_launchedDisabledIds` + `disabledSignature` 只重启受影响层。
7. **main `_setEnablement` 不 fire `onDidChangeExtensions`**：renderer 的 `ExtensionEnablementService` 编排 enablement，main 再 fire 会双重重启 host（quarantine 仍 fire 保留）。
8. **enablement 服务不碰 malicious**：恶意扩展走既有 `ExtensionsContribution` quarantine → 写 global disabled → 自然表现为 `DisabledGlobally`。别在 enablement 服务里调 `quarantineMalicious`（有写副作用且只返回**新增**隔离 id）。
9. **treeKill 是 backstop 不是主路径**：优雅停（stdin EOF 级联）让 tsserver 被自己的 exit hook 回收；硬杀甩孤儿。改 host 退出路径务必保留优雅停链。见 [[agent-binary-silent-download-e2e-fix]]。
10. **DI 注册顺序**（`main.tsx`）：`ExtensionEnablementService` 必须 **先于** `ExtensionHostClientService` 与 `ExtensionsWorkbenchService`（两者都注入它）。
11. **Action2 async run 的 accessor 首个 await 即失效**：enablement 命令在第一个 `await` 前同步取完 service（快照传后续 helper），见 [[action2-async-accessor-invalidation]]。
12. **restricted 失败只 warn**：外部扩展是可选的，受限 host 起不来绝不能拖垮 workbench 或 trusted。
13. **teardown 必须按 tier 对称清理全局能力**：`_teardownConnection` 清 trusted-only 的全局状态（`resetSourceControls()`）时**必须** `if (conn.kind === 'trusted')` 门控，与 `webview.reset(conn.kind)` 对齐——否则 restricted 崩溃/切工作区重启会误清 trusted 刚注册的 SCM provider（git+p4 同时消失，reload/禁用启用才恢复）。复现测试 `ExtensionHostClientService.test.ts`「does not wipe SCM providers when the restricted host tears down」。历史：`resetSourceControls` 由 6c8d3aca（切工作区 SCM 不更新）引入 teardown，当时无 restricted 宿主故未暴露，外部插件系统上线后才显形。

## E2E

host 生命周期与启用禁用无直接 UI 入口，靠探针直调服务：

- 契约 `apps/editor/src/shared/e2e/contract.ts`：`getBuiltinExtensionIds()` / `getDisabledExtensionIds()` / `setExtensionEnablement(identifier, enabled, workspace?)`（另有分发链路的 `installVsixExtension`/`uninstallExtension`/`getInstalledExtensionIds`）。
- 实现 `apps/editor/src/renderer/e2e/probe.ts`：注入 `extensionEnablementService`（在 `main.tsx` 的 `installE2EProbeIfEnabled({...})` 接线），实现三个方法。
- spec `apps/editor/e2e/specs/smoke.extensions.spec.ts`：`@regression`「禁用内置扩展进入 effective disabled 集」= `setExtensionEnablement(id, false)` → poll `getDisabledExtensionIds()` 含之 → 再 enable → poll 不含。
- **e2e 跑 `out/` 产物**：改 renderer/main/probe 后必先 `pnpm --filter @universe-editor/editor build` 再跑。`@regression` 默认被主趟 `--grep-invert` 剥离，单独验证用 `npx playwright test -c e2e/playwright.config.ts e2e/specs/smoke.extensions.spec.ts --grep "@regression"`。

## 验证

```bash
cd apps/editor && pnpm exec vitest run ExtensionEnablementService ExtensionHostClientService ExtensionsWorkbenchService   # 决策/生命周期/门面
pnpm --filter @universe-editor/extension-host test    # host 端（scanner/manifest/extensionService）
pnpm --filter editor build    # e2e 前必重建
cd apps/editor && npx playwright test -c e2e/playwright.config.ts e2e/specs/smoke.extensions.spec.ts --grep "@regression"
pnpm check    # lint+typecheck+test（含 docs:check），仅看错误
```

> 改了用户可见行为（启用禁用命令名、界面文案、交互流程）时，同步 `docs/user/zh-CN/customization/extensions.md`（"更新、禁用与卸载"节）；`pnpm docs:check` 校验内部链接勿留死链。

## 关键参考路径

- `apps/editor/src/main/services/extensionHost/extensionHostMainService.ts` —— spawn Electron-as-node + env 分叉 + treeKill 回收
- `apps/editor/src/main/services/extensionHost/builtinExtensionsDir.ts` —— 内置目录单一真相
- `apps/editor/src/shared/ipc/extensionHostService.ts` —— `ExtHostStartSpec`（kind/workspaceRoot/locale/disabledIds）+ IPC 契约
- `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` —— 两 tier 生命周期 + 命令路由账本 + per-tier 重启
- `apps/editor/src/renderer/services/extensions/HostConnection.ts` —— 一连接的全部 RPC 接线 + 按 kind 条件注册通道（隔离边界）
- `apps/editor/src/renderer/services/extensions/MainThread*.ts` —— 宿主能力实现（Commands/Window/Fs/Output/Languages/Editor/Ai/Storage）+ ScmService/WebviewService
- `apps/editor/src/renderer/services/extensions/ExtensionEnablementService.ts` —— 启用禁用 4 态决策引擎 + getEffectiveDisabledIds
- `apps/editor/src/renderer/services/extensionsWorkbench/ExtensionsWorkbenchService.ts` —— 门面（enablementState/isBuiltin/setEnablement）
- `apps/editor/src/renderer/actions/extensionsActions.ts` —— 4 个 enablement 命令（VSCode 对齐 ID）
- `apps/editor/src/renderer/contributions/ExtensionsContribution.ts` —— 启动编排 + onDidChangeExtensions 重扫 + 恶意隔离
- `apps/editor/src/renderer/services/extensions/ExtensionPointTranslator.ts` —— manifest 静态贡献 → core 注册表
- `packages/extensions-common/src/rpc.ts` —— `ExtHostChannels` + 所有 IMainThread*/IExtHost* 接口 + wire DTO；`bytes.ts` base64；`stdioProtocol.ts` 换行分帧
- `packages/extension-host/src/{bootstrap,apiFactory,extensionService}.ts` —— host 进程入口（含 UNIVERSE_DISABLED_EXTENSIONS 过滤）+ bridge + 能力实现
- DI 接线：`apps/editor/src/renderer/main.tsx`（EnablementService 先于 ClientService/WorkbenchService）
- 用户文档：`docs/user/zh-CN/customization/extensions.md`（"更新、禁用与卸载"节）
- VSCode 对照：`src/vs/workbench/services/extensions/`（ExtensionHostManager / RPCProtocol / MainThread*/ExtHost*）、`src/vs/workbench/services/extensionManagement/`（`IWorkbenchExtensionEnablementService` / `EnablementState`）
- 相关：memory [[extension-system-progress]]（本层完整实施史 Phase 0–6）、[[extension-enablement-feature]]（启用禁用实施）、[[agent-binary-silent-download-e2e-fix]]（treeKill/tsserver 孤儿）；skill `extension-marketplace-management`（上游分发链路）、`create-extension`（起新扩展）、[[extend-language-plugin]]（语言 provider，mainThreadLanguages 下游）、`webview-custom-editor`（webview 桥，一条具体通道）、`view-system-context`（套路 B）、`register-monaco-command`（命令）、`fix-disposable-leak`

## 其它

- 后续用本 skill，发现新经验（新的通道套路、新的隔离/生命周期坑、启用禁用新语义），需同步更新本文件。
