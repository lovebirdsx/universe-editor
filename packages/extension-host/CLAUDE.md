# packages/extension-host/CLAUDE.md

扩展宿主（extension host）进程包：对等 VSCode 的 extension host 运行时——装好的扩展在这里被 spawn、扫描、按 Workspace Trust 门控激活、经 RPC 桥拿到宿主能力、按启用禁用过滤。本文是扩展宿主运行时的上下文地图（处理相关任务前通读）。

## 扩展宿主运行时（单 host + Workspace Trust + RPC 桥 + 启用禁用生效链）

对等 VSCode 的 extension host 运行时那层。核心判断（本仓库已确立）：**分发链路早已就绪**（`.vsix`/市场安装、`<userData>/extensions` 落盘、`extensions.json`，见 `apps/editor/src/main/services/extensionManagement/CLAUDE.md`），本层是**装好之后**——扩展怎么被 spawn 进独立进程、怎么经 RPC 桥拿到宿主能力、信任与启用禁用怎么生效。

> ⚠️ 第一原则：**先分清运行时 vs 分发**。"获取→安装→更新→卸载→信任治理 UI"是**分发**（`apps/editor/src/main/services/extensionManagement/CLAUDE.md`），它到 `fire onDidChangeExtensions` → `ExtensionsContribution` 触发 `refreshExtensions()`（重启 host 重扫）为止。**重扫之后**——spawn、RPC、命令注册、崩溃重启——是**运行时**，是本文。两端别混。
>
> ⚠️ 第二原则：**运行时也分层，别改错层**。① main 进程 `extensionHostMainService` 只管**搬字节**（spawn Electron-as-node + 抽 stdio，keyed by opaque handle），不懂 RPC。② shared IPC 契约（`extensionHostService.ts` 的 `ExtHostStartSpec`/`start`/`onStdout`…）。③ renderer 是 **RPC 对端**——`HostConnection`（一连接=一 protocol+client+server+全部 `MainThread*` 通道）+ `ExtensionHostClientService`（管单 host 生命周期 + 命令路由）+ 各 `MainThread*.ts`（把宿主能力实现出来）。④ 决策层 `ExtensionEnablementService`（启用禁用 4 态引擎）。改暴露给扩展的能力→②③；改进程生命周期→③（外加①的 spawn/env）；改启用禁用→④＋生效链。
>
> ⚠️ 第三原则：**隔离在激活期不在进程间（单 host + Workspace Trust）**。所有本地扩展（内置+外置）跑同一个 host 进程、享完整 API 面；`capabilities.untrustedWorkspaces` 声明 + 工作区信任状态在**激活时**门控（对照 VSCode）。曾经按安装来源分 trusted/restricted 双进程，因受限 host 拿不到 languages 通道导致 eslint 类扩展诊断失效而废弃（2026-07，实施史见 memory [[extension-system-progress]]）。

### 架构总览（运行时四层）

```
① main 进程（搬字节，不懂 RPC）
   apps/editor/src/main/services/extensionHost/extensionHostMainService.ts
       spawn(process.execPath, [entry], {ELECTRON_RUN_AS_NODE})；按 spec 设 env；treeKill 回收 tsserver 孙子进程
       start(spec)/writeStdin/stop/stopAll/hasUserExtensions；onStdout/onStderr/onExit（keyed by handle）
   apps/editor/src/main/services/extensionHost/builtinExtensionsDir.ts   内置目录单一真相（host 扫描 + 管理服务列举 都用它）
   apps/editor/src/main/services/extensionHost/userExtensionsDir.ts      外部扩展目录（<userData>/extensions）
   apps/editor/src/main/services/extensionHost/tsServerPaths.ts          vendored tsserver CLI 路径（typescript 内置插件用）

② shared IPC 契约
   apps/editor/src/shared/ipc/extensionHostService.ts   IExtensionHostService + ExtHostStartSpec{workspaceRoot?,extensionsDir?,userExtensionsDir?,locale?,disabledIds?}；ExtHostKind 已塌成单值 'local'（仅 webview 路由留用）

③ renderer（RPC 对端 + 生命周期 + 能力实现）
   apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts   单 host 生命周期 + 贡献索引 + 命令路由账本 + 崩溃/workspace/信任撤销/启用禁用重启
   apps/editor/src/renderer/services/extensions/HostConnection.ts               一连接的全部 RPC 接线（ExtHost* client + MainThread* server，全部通道无条件注册）
   apps/editor/src/renderer/services/extensions/MainThread*.ts                  宿主能力实现（Commands/Window/Fs/Output/Languages/Editor/Ai/Storage + Scm/Webview 服务）
   apps/editor/src/renderer/services/extensions/ExtensionPointTranslator.ts     manifest 静态贡献（commands/menus/keybindings/configuration）→ core 注册表
   apps/editor/src/renderer/contributions/ExtensionsContribution.ts             启动编排：start→getContributions→translate→activate + 监听 onDidChangeExtensions 重扫 + 恶意隔离
   packages/extension-host/src/bootstrap.ts                                     host 进程入口：合并扫内置+外部两目录 + 按 UNIVERSE_DISABLED_EXTENSIONS 过滤 + 注册 ExtHost* 通道
   packages/extensions-common/src/protocol/rpc.ts                                        ExtHostChannels 通道名 + 所有 IMainThread*/IExtHost* 接口 + wire DTO

④ 决策层（启用禁用 4 态引擎）
   apps/editor/src/renderer/services/extensions/ExtensionEnablementService.ts   global(main extensions.json)+workspace(renderer WORKSPACE storage) 合并决策 → getEffectiveDisabledIds
   apps/editor/src/main/services/extensionManagement/extensionManagementService.ts   getDisabledIds/setEnablement（global 落盘）+ listBuiltinExtensions
   apps/editor/src/renderer/services/extensionsWorkbench/ExtensionsWorkbenchService.ts   门面：聚合内置+外部→IExtensionEntry(含 enablementState) + setEnablement 转发
   apps/editor/src/renderer/actions/extensionsActions.ts                        4 个 enablement 命令（VSCode 对齐 ID）

⑤ 信任门控（激活期，非进程间）
   packages/platform/src/workspace/workspaceTrust.ts                            IWorkspaceTrustManagementService（最长父前缀继承，app-scope 存储，workspaceTrustInitialized 屏障）
   packages/extension-host/src/activationService.ts                             _isActivatable 门控：未受信 + supported:false + 非内置 → 不激活；授予后 replayFiredEvents
   apps/editor/src/renderer/contributions/WorkspaceTrustContribution.ts         状态栏 Restricted Mode 条目 + 首开未信任文件夹弹窗（E2E 探针在场跳过）
   apps/editor/src/renderer/actions/workspaceTrustActions.ts                    Grant/Revoke/Manage 三命令
```

### ① main 进程 host service

`ExtensionHostMainService` **只搬字节**，照抄 `AcpHostMainService`：`spawn(process.execPath, [entry], { env: {ELECTRON_RUN_AS_NODE:1, ...} })`——用 Electron 自带 node，**不依赖系统 node/npx**。每个进程一个 opaque `handle`（randomUUID），`onStdout/onStderr/onExit` 都带 handle，renderer 按 handle 分流。

- **env**（`start(spec)`，单 host 无分叉）：`UNIVERSE_BUILTIN_EXTENSIONS_DIR` + `UNIVERSE_USER_EXTENSIONS_DIR`（两目录都扫，内置胜 id 碰撞）、`UNIVERSE_TSLS_CLI`/`UNIVERSE_TSLS_TSSERVER`（typescript 插件自 spawn tsserver 用）、`UNIVERSE_WORKSPACE_ROOT`（workspace 根）、`UNIVERSE_DISPLAY_LOCALE`（manifest NLS）、`UNIVERSE_DISABLED_EXTENSIONS`（**启用禁用生效点**，见下）。另有 e2e 专用的 `UNIVERSE_ENABLED_EXTENSIONS` allowlist。`UNIVERSE_DEV_EXTENSIONS`（`--extension-development-path`，path.delimiter 拼接的扩展根列表；附加扫描、id 冲突 dev 胜、豁免 disabled 过滤与 trust 门控，scanner 打 `isUnderDevelopment`）。
- **treeKill 回收孙子进程**：host fork 出 grandchild（typescript 插件 → tsserver）。优雅停（`stop` 关 stdin / `stopAll` before-quit / renderer `beforeunload`）让 CLI 自己的 exit hook 回收 tsserver；**treeKill 是 backstop**（硬 SIGKILL 会甩掉慢启动的 tsserver 成孤儿，卡 Playwright teardown、给真实用户留 stray electron.exe）。这条链路的坑详见 memory [[agent-binary-silent-download-e2e-fix]]。
- **已无进程级沙箱**：单 host 后所有扩展（含外置）与内置同权（裸 node:fs/spawn），隔离只在激活期（见 ⑤）。曾经的 restricted host fs 网关与 Node 权限模型 opt-in 已随双 host 一并拆除；**UI/文档不得宣称外部扩展已沙箱**（`docs/user/zh-CN/customization/extensions.md` 已如实写"接近编辑器本身的权限"）。

### ③ renderer RPC 桥（本层最常改的地方）

**RPC 对端是 renderer 不是 main**（同 ACP）：命令路由目标 CommandsRegistry / View UI / SCM 状态都在 renderer。RPC 复用 platform 现成 `ChannelServer/ChannelClient/ProxyChannel`，唯一底层新代码是 stdio 适配器（`StdioFramingProtocol`，换行分隔 UTF-8 帧，不用 base64——JSON 转义了裸换行）。ProxyChannel 约定：`/^on[A-Z]/` 是事件，其余方法名直传 call。

- **`HostConnection`**：一条连接的全部接线。构造时建 protocol → `ChannelClient`（调 host 的 `ExtHost*` 通道）+ `ChannelServer`（托管 renderer 的 `MainThread*` 通道），**全部通道无条件注册**（单 host 所有扩展共享完整 API 面，门控在激活期）。`ExtensionHostClientService` 持有一个。
- **`ExtensionHostClientService`**：管单个 `_conn`（`ExtHostKind` 已塌成 `'local'`，仅 webview 面板归属路由留用该类型）。`start()` memo 幂等；连接后先 `$initializeWorkspaceTrust` seed 信任状态再激活。
- **命令路由账本 `_commandOwner: Map<id, HostConnection>`**：runtime 命令由连接自带 `MainThreadCommands` 闭包自己的 extHost proxy（天然正确）；**静态贡献命令需账本**（`_fetchAndIndex` 记账 + `MainThreadCommands` ledger 回调），因为静态命令的 bootstrap proxy 调的是 client service 的 `executeContributedCommand`。单 host 下账本仍保留——重启窗口期旧连接的命令要随 teardown 清掉。

#### 加一条新的 MainThread\*/ExtHost\* 通道（暴露一个宿主能力给扩展）

对标 VSCode `MainThreadXxx`/`ExtHostXxx`。清单（以现有 `MainThreadOutput`/`MainThreadStorage` 为最简样板）：

1. **契约** `packages/extensions-common/src/protocol/rpc.ts`：`ExtHostChannels` 加通道名常量；定义 `IMainThreadXxx`（renderer 实现，host 调）和/或 `IExtHostXxx`（host 实现，renderer 调）接口 + wire DTO（**必须可结构化克隆**：URI 走 fsPath 字符串或 revive；二进制走 base64，见 `bytes.ts`，newline-JSON 不能传 Uint8Array）。
2. **host 侧** `packages/extension-host/src/`：`apiFactory.ts` 的 `IExtensionHostBridge` 加方法；`extensionService.ts` 实现并经 client 调 `IMainThreadXxx`；`bootstrap.ts` 建 client + 注册 `IExtHostXxx` 通道。
3. **extension-api** `packages/extension-api/src/`：加 namespace/类型（**enum 用普通 enum 非 const enum**——git 扩展 tsconfig 开 `isolatedModules`，跨模块访问 ambient const enum 报 TS2748）。
4. **renderer 侧** `MainThreadXxx.ts` 实现 `IMainThreadXxx`（注入所需 platform 服务）；`HostConnection.ts` 里 `server.registerChannel(ExtHostChannels.mainThreadXxx, ProxyChannel.fromService(...))`（若 host→renderer 方向还要 `client.getChannel` 建 ExtHost proxy）；依赖经 `HostConnectionDeps` 从 `ExtensionHostClientService._connect` 传入，无条件注册（单 host 无按 tier 条件注册）。
5. 建完 `pnpm --filter @universe-editor/extensions-common --filter @universe-editor/extension-host build`（dev watcher 自动，离开 dev 手动），apps 才看得到新符号。

**已有通道**（`ExtHostChannels`）：commands/window/scm/fs/output/languages/editor/ai/storage/webviews（`extHost*` + `mainThread*` 成对；window 的反向通道 `extHostWindow` 目前只回推 progress 取消）。加能力前先看有没有能复用的。

### ⑤ Workspace Trust（隔离在激活期，对照 VSCode）

**模型**：单 host 跑全部本地扩展（内置+外置），`bootstrap.ts` 合并扫内置+外部两目录（内置胜 id 碰撞）。信任不是进程边界而是**激活门控**：

- **状态**：platform `IWorkspaceTrustManagementService`（`packages/platform/src/workspace/workspaceTrust.ts`），最长父前缀继承（照抄 VSCode `doGetUriTrustInfo`），app-scope 存储。我们的 `IStorageService` 是 async（VSCode 是同步），故暴露 `workspaceTrustInitialized` promise 让消费方 await 首次加载。
- **声明**：manifest `capabilities.untrustedWorkspaces`（`true` / `{supported:false}` / `{supported:'limited'}`；有 main 未声明 → 默认 `false`）。
- **门控**（host 侧 `ExtensionActivationService._isActivatable`）：未受信 + `supported:false` + 非内置 → **不激活**（= VSCode `DisabledByTrustRequirement`）；`limited` 照常激活、自行读 `workspace.isTrusted` 降级。**built-in 恒豁免**（scanner 带 `builtin` 标志——否则 TS/git 在未信任窗口全挂）。
- **授予=动态**：renderer 订阅 `onDidChangeTrust`，授予时调 `$onDidGrantWorkspaceTrust`，host `replayFiredEvents()` 重放已 fire 的激活事件（否则已开文档的 `onLanguage:` 不再触发）。**撤销=重启 host**（已激活扩展无法就地卸载，重启后门控从头算）。
- **API**：extension-api `workspace.isTrusted` + `onDidGrantWorkspaceTrust`；renderer 连接后、任何激活前 `$initializeWorkspaceTrust` seed（保证扩展 `activate` 里读到正确值）。
- **UI**：`WorkspaceTrustContribution`（AfterRestore）= 状态栏 "Restricted Mode" 条目（shield 图标，点击 manage）+ 首开未信任文件夹一次性弹窗（**E2E 探针在场时跳过弹窗**避免阻塞）；`workspaceTrustActions.ts` = Grant/Revoke/Manage 三命令。

**fs 网关仍在但非沙箱**：`workspace.fs` API 仍走 `MainThreadFs`（复用 `AcpPathPolicy` 拒 .ssh/.aws/.env + 禁逃逸，cwd=workspaceRoot），但扩展可裸 `node:fs` 绕过——它只约束走 API 的扩展，不是安全边界。

**贯穿红线**：密钥只走 main `ISecretStorageService`(safeStorage)，绝不进 renderer/wire DTO。

### ④ 启用/禁用：决策引擎 + 生效链

**完整 VSCode 4 态模型**（`EnablementState`：`DisabledGlobally`/`DisabledWorkspace`/`EnabledGlobally`/`EnabledWorkspace`）。内置也可禁用（对齐 VSCode，只是不可卸载）。实施全记录见 memory [[extension-enablement-feature]]。

- **决策引擎必须在 renderer**（`ExtensionEnablementService`）：workspace 态存 renderer `StorageScope.WORKSPACE`（跟随打开文件夹），只 renderer 有；global 态读 main `extensions.json`（经 `IExtensionManagementService.getDisabledIds/setEnablement`）。
- **解析优先级**（`getEnablementState`）：workspace disabled → workspace enabled → global disabled → 默认 `EnabledGlobally`（**workspace 覆盖 global**）。
- **`getEffectiveDisabledIds`** = global disabled（除非被 workspace enable 覆盖）∪ workspace disabled。这是 host 消费的**唯一输入**。
- **生效链（禁用不是运行时卸载，是扫描时过滤）**：
  ```
  ExtensionEnablementService.getEffectiveDisabledIds()
    → ExtensionHostClientService._disabledIds()   // 与 (listBuiltinExtensions ∪ getInstalled) 求交
    → host.start({ disabledIds })                 // spec.disabledIds
    → main 写 env UNIVERSE_DISABLED_EXTENSIONS
    → bootstrap.ts 扫描时 extensions.filter(e => !disabled.has(e.id))
  ```
  改启用禁用的生效方式就顺这条链找。
- **版本不兼容 ≠ 用户禁用**：`scanSingleExtension` 对 `engines.universe` 不满足**不再 throw-skip**，返回带 `isValid: false` + `validationMessage` 的条目（manifest 解析失败仍 throw-skip）。`computeActiveExtensions` 把 `isValid === false` 从 `active` 排除（`deduped` 保留供可见性），builtin/dev 均不豁免。UI 侧由 main 管理服务用同源 `satisfies` 填 `ILocalExtension.isVersionCompatible` 呈现（对照 VSCode `DisabledByInvalidExtension`）。
- **只在签名变化时重启**（`_onEnablementChanged`）：记 `_launchedDisabledIds`（`disabledSignature` = 排序后 join 的 order-independent 签名），enablement 变更时只有签名变了才重启——**否则无谓重启会杀 + 重 spawn tsserver**。host 未跑时（之前全禁用）先清 `_starting` memo 再 `_restart`（无连接时跳过 stop）。

### 生命周期：懒启动 / 崩溃 / workspace / reload

- **懒启动 + memo**：`_starting` 缓存 in-flight promise，幂等。无外部扩展时仍 spawn（内置扩展在同一个 host 里）；`host.hasUserExtensions()` 只用于决定是否传外部目录。
- **崩溃重启**（`_handleCrash`）：异常退出码 → 指数退避重启（`RESTART_BASE_DELAY_MS * 2^(n-1)`）+ 滚动窗口 `MAX_RESTARTS=3`，超限给手动 Restart 通知。**planned stop 不计崩溃**（`_stopping` set）。重启串行化走 `_restartQueue`（崩溃/切换/撤销信任可能同时触发）。
- **workspace 切换**（`_onWorkspaceChanged`）：host 启动时 pin workspace 根，切换需重启。**必须先 `await Promise.allSettled([_starting])`**（`_repin` 屏障）——swap 可能撞上初始 boot 还在 spawn（Windows CI 更慢），此时 `this._conn` 还没赋值，直接读会丢掉 swap，host 永远 pin 在空 workspace（git 看不到 rootPath 不注册 SCM）。`_repinning` promise 同步武装（首个 await 前），让同一事件回合里的命令走 `_whenReady` 阻塞到重 pin 完成。
- **`_restart(reason)`**：stop（planned 不计崩溃）→ 重 start → `_fetchAndIndex` → **fire `onDidChangeContributions`（重 translate）→ activateByEvent(STARTUP + STARTUP_FINISHED)**。重 translate 必须在 activation 前：新 host 的命令要先回到 core 注册表，才能被 onCommand proxy 命中。
- **reload 回收**（`beforeunload`）：window reload 销毁 renderer 但不 dispose service（async dispose 不跑），故 `beforeunload` 同步 `host.stop(handle)`——否则每次 reload 都孤儿一个重型 host（自带 tsserver），e2e 全套跑下来堆积饿死后续 spawn。

### 常见任务 → 改哪里

- **暴露一个新宿主能力给扩展**（新 API namespace）：加一条 MainThread*/ExtHost* 通道，见上"加一条新通道"清单五步。
- **改某能力的接线/依赖注入**：`HostConnectionDeps` 字段 + `HostConnection` 构造里注册通道 + `ExtensionHostClientService._connect` 传参（全部无条件注册，无按 tier 分叉）。
- **改信任门控语义**（哪些扩展在未受信工作区可激活）：`activationService.ts` 的 `_isActivatable` + manifest `capabilities.untrustedWorkspaces` zod（`packages/extension-host/src/manifest.ts`）。
- **改 host spawn / env**：`extensionHostMainService.start`（env 组装）。
- **改内置/外部扫描目录**：`builtinExtensionsDir.ts` / `userExtensionsDir.ts`（单一真相，host 与管理服务共用）。
- **远端 host 的用户扩展**：远端用户扩展经 `RemoteChannels.ExtensionManagement` channel 分发安装（`packages/remote-server`），远端 host 恒扫 `<dataDir>/user-extensions`（`serverPaths.ts` 单一真相，server 自己 set `UNIVERSE_USER_EXTENSIONS_DIR`）——不经过本机 `userExtensionsDir.ts`。
- **改启用禁用的 4 态语义 / 优先级**：`ExtensionEnablementService`（决策）。
- **改启用禁用生效方式**：生效链五环（enablement → \_disabledIds → spec.disabledIds → env → bootstrap filter）。
- **改启用禁用命令 / 快捷键 / 菜单**：`extensionsActions.ts`（4 个 VSCode 对齐 ID：`extensions.enableGlobally`/`disableGlobally`/`enableForWorkspace`/`disableForWorkspace`），在 `actions/index.ts` 注册（套路 A）。workspace 命令先 `ctx.enablement.hasWorkspace()` 检查。
- **改扩展列表 UI 的启用禁用呈现**：门面 `ExtensionsWorkbenchService`（`IExtensionEntry.enablementState`/`isBuiltin`）+ `workbench/extensions/{ExtensionsView,ExtensionEditor}.tsx`。
- **改静态贡献翻译**（manifest commands/menus/keybindings/configuration → core）：`ExtensionPointTranslator.ts`。
- **改崩溃/重启策略**：`ExtensionHostClientService` 的 `_handleCrash`/`_restart`/`MAX_RESTARTS`。
- **扩展怎么被安装/更新/卸载到磁盘**：**不在本文**，是分发链路（`apps/editor/src/main/services/extensionManagement/CLAUDE.md`）。本文从 `onDidChangeExtensions` → `refreshExtensions()` 接手。
- **语言 provider（definition/hover/诊断…）怎么写**：**不在本 skill**，是 `mainThreadLanguages` 桥的下游（skill [[extend-language-plugin]]）。
- **起一个全新扩展骨架 + 贡献点**：skill `create-extension`。

### 易踩坑速记

1. **RPC 对端是 renderer 不是 main**：main 只搬 stdio 字节。想暴露能力别往 main 加逻辑，往 renderer 的 MainThread* 加。
2. **wire DTO 必须可结构化克隆**：URI 用 fsPath/revive、二进制用 base64（`bytes.ts`）。newline-JSON 帧传不了 Uint8Array。
3. **extension-api 的 enum 用普通 enum**（非 const enum）：扩展 tsconfig 开 `isolatedModules`，const enum 跨模块报 TS2748。
4. **改 platform/extensions-common/extension-host 后先重建 dist**：`pnpm --filter @universe-editor/extensions-common --filter @universe-editor/extension-host build`（dev watcher 自动），否则 apps/host 看的是旧产物。
5. **workspace swap 前必 `await` in-flight start**：否则撞上初始 boot spawn 中，`_conn` 未赋值，丢 swap，host pin 空 workspace（git 不注册 SCM）。
6. **重启签名**：enablement 变更别无脑重启——重启杀 tsserver。用 `_launchedDisabledIds` + `disabledSignature` 只在签名变了时重启。
7. **main `_setEnablement` 不 fire `onDidChangeExtensions`**：renderer 的 `ExtensionEnablementService` 编排 enablement，main 再 fire 会双重重启 host（quarantine 仍 fire 保留）。
8. **enablement 服务不碰 malicious**：恶意扩展走既有 `ExtensionsContribution` quarantine → 写 global disabled → 自然表现为 `DisabledGlobally`。别在 enablement 服务里调 `quarantineMalicious`（有写副作用且只返回**新增**隔离 id）。
9. **treeKill 是 backstop 不是主路径**：优雅停（stdin EOF 级联）让 tsserver 被自己的 exit hook 回收；硬杀甩孤儿。改 host 退出路径务必保留优雅停链。见 [[agent-binary-silent-download-e2e-fix]]。
10. **DI 注册顺序**（`main.tsx`）：`ExtensionEnablementService` 必须 **先于** `ExtensionHostClientService` 与 `ExtensionsWorkbenchService`（两者都注入它）。
11. **Action2 async run 的 accessor 首个 await 即失效**：enablement 命令在第一个 `await` 前同步取完 service（快照传后续 helper），见 [[action2-async-accessor-invalidation]]。
12. **撤销信任必须重启 host，授予不用**：已激活扩展无法就地卸载，撤销走 `_restart`；授予是动态 `$onDidGrantWorkspaceTrust` + host `replayFiredEvents()` 重放激活事件。built-in 恒豁免门控（scanner `builtin` 标志），别给内置加信任判断。
13. **teardown 无条件清全局能力（单 host 下是对的）**：`_teardownConnection` 里 `resetSourceControls()` + `timeline.reset()` + `treeViews.reset()` + `webview.reset(kind)` 无条件调——单 host 只有这一个连接，teardown 时清全局状态不会误伤其它 tier。临终 host 的 `$unregisterSourceControl` fire-and-forget 消息可能随 IPC 关闭丢失，必须主动清，否则视图残留上一 workspace 的 provider。
14. **可选 wire 尾参的 undefined 已在 RPC 层根治**：`ProxyChannel.toService` 序列化前剥掉参数数组尾部的 `undefined`，远端 `param === undefined` 判定可靠，无需调用端省略/接收端 `!= null` 双保险。残余约定只剩中段参数：`undefined` 夹在实参中间仍按 JSON 数组语义变 `null`，中段可选参数必须声明 `| null`（如 `$findFiles` 的 exclude/maxResults）并用 `== null` 判定。
15. **远程 host 的 $mid URI 会被 codec 互译，renderer 侧 MainThread\* 收到的是 remote-ssh 空间**：远程模式下 host 进程自带 `createJsonCodec(createRemoteURITransformer(authority))`（`bootstrap.ts`），带 `$mid:1` 的 URI 出线 `file:`→`remote-ssh://<authority>/…`、入线反向。renderer 的 MainThread\* 若对 host 来的 URI 做 `scheme === 'file'` 判断，远程下必失效（曾致 `MainThreadFileEvents` 拒收 watcher interest base，git 扩展收不到文件事件、SCM 不自动刷新）——workspace URI 空间判断要同时接受 `file:` 与 `REMOTE_SCHEME`；反向发往 host 的 `$mid` URI 无需手动翻译，codec 会转回 host 本地 `file:`。注意裸字符串路径（LSP wire、SCM fsPath 字段）不带 `$mid`，codec 看不见，仍走 `parseWireUri`/`fsPathToWorkspaceUri` 手动互译。

### E2E

host 生命周期与启用禁用无直接 UI 入口，靠探针直调服务：

- 契约 `apps/editor/src/shared/e2e/contract.ts`：`getBuiltinExtensionIds()` / `getDisabledExtensionIds()` / `setExtensionEnablement(identifier, enabled, workspace?)`（另有分发链路的 `installVsixExtension`/`uninstallExtension`/`getInstalledExtensionIds`）。
- 实现 `apps/editor/src/renderer/e2e/probe.ts`：注入 `extensionEnablementService`（在 `main.tsx` 的 `installE2EProbeIfEnabled({...})` 接线），实现三个方法。
- spec `apps/editor/e2e/specs/smoke.extensions.spec.ts`：`@regression`「禁用内置扩展进入 effective disabled 集」= `setExtensionEnablement(id, false)` → poll `getDisabledExtensionIds()` 含之 → 再 enable → poll 不含。
- **e2e 跑 `out/` 产物**：改 renderer/main/probe 后必先 `pnpm --filter @universe-editor/editor build` 再跑。`@regression` 默认被主趟 `--grep-invert` 剥离，单独验证用 `npx playwright test -c e2e/playwright.config.ts e2e/specs/smoke.extensions.spec.ts --grep "@regression"`。

### 验证

```bash
cd apps/editor && pnpm exec vitest run ExtensionEnablementService ExtensionHostClientService ExtensionsWorkbenchService   # 决策/生命周期/门面
pnpm --filter @universe-editor/extension-host test    # host 端（scanner/manifest/extensionService）
pnpm --filter editor build    # e2e 前必重建
cd apps/editor && npx playwright test -c e2e/playwright.config.ts e2e/specs/smoke.extensions.spec.ts --grep "@regression"
pnpm check    # lint+typecheck+test（含 docs:check），仅看错误
```

> 改了用户可见行为（启用禁用命令名、界面文案、交互流程）时，同步 `docs/user/zh-CN/customization/extensions.md`（"更新、禁用与卸载"节）；`pnpm docs:check` 校验内部链接勿留死链。

### 关键参考路径

- `apps/editor/src/main/services/extensionHost/extensionHostMainService.ts` —— spawn Electron-as-node + env 分叉 + treeKill 回收
- `apps/editor/src/main/services/extensionHost/builtinExtensionsDir.ts` —— 内置目录单一真相
- `apps/editor/src/shared/ipc/extensionHostService.ts` —— `ExtHostStartSpec`（workspaceRoot/locale/disabledIds/两目录 override）+ IPC 契约
- `apps/editor/src/renderer/services/extensions/ExtensionHostClientService.ts` —— 单 host 生命周期 + 命令路由账本 + 签名化重启
- `apps/editor/src/renderer/services/extensions/HostConnection.ts` —— 一连接的全部 RPC 接线（全部通道无条件注册）
- `apps/editor/src/renderer/services/extensions/MainThread*.ts` —— 宿主能力实现（Commands/Window/Fs/Output/Languages/Editor/Ai/Storage）+ ScmService/WebviewService
- `apps/editor/src/renderer/services/extensions/ExtensionEnablementService.ts` —— 启用禁用 4 态决策引擎 + getEffectiveDisabledIds
- `apps/editor/src/renderer/services/extensionsWorkbench/ExtensionsWorkbenchService.ts` —— 门面（enablementState/isBuiltin/setEnablement）
- `apps/editor/src/renderer/actions/extensionsActions.ts` —— 4 个 enablement 命令（VSCode 对齐 ID）
- `apps/editor/src/renderer/contributions/ExtensionsContribution.ts` —— 启动编排 + onDidChangeExtensions 重扫 + 恶意隔离
- `apps/editor/src/renderer/services/extensions/ExtensionPointTranslator.ts` —— manifest 静态贡献 → core 注册表
- `packages/extensions-common/src/protocol/rpc.ts` —— `ExtHostChannels` + 所有 IMainThread*/IExtHost* 接口 + wire DTO；`bytes.ts` base64；`stdioProtocol.ts` 换行分帧
- `packages/extension-host/src/{bootstrap,apiFactory,extensionService,activationService}.ts` —— host 进程入口（含 UNIVERSE_DISABLED_EXTENSIONS 过滤 + 双目录合并扫描）+ bridge + 能力实现 + 信任门控
- `packages/platform/src/workspace/workspaceTrust.ts` —— `IWorkspaceTrustManagementService`（信任状态 + `workspaceTrustInitialized` 屏障）
- DI 接线：`apps/editor/src/renderer/main.tsx`（EnablementService 先于 ClientService/WorkbenchService）
- 用户文档：`docs/user/zh-CN/customization/extensions.md`（"更新、禁用与卸载"节）
- VSCode 对照：`src/vs/workbench/services/extensions/`（ExtensionHostManager / RPCProtocol / MainThread*/ExtHost*）、`src/vs/workbench/services/extensionManagement/`（`IWorkbenchExtensionEnablementService` / `EnablementState`）
- 相关：memory [[extension-system-progress]]（实施史 Phase 0–6 + 2026-07 双 host→单 host 重构）、[[extension-enablement-feature]]（启用禁用实施）、[[agent-binary-silent-download-e2e-fix]]（treeKill/tsserver 孤儿）；`apps/editor/src/main/services/extensionManagement/CLAUDE.md`（上游分发链路）、skill `create-extension`（起新扩展）、[[extend-language-plugin]]（语言 provider，mainThreadLanguages 下游）、`apps/editor/src/renderer/workbench/webview/CLAUDE.md`（webview 桥，一条具体通道）、`apps/editor/src/renderer/services/views/CLAUDE.md`（套路 B）、skill `register-monaco-command`（命令）、`fix-disposable-leak`

### 其它

- 后续发现新经验（新的通道套路、新的隔离/生命周期坑、启用禁用新语义），需同步更新本文件。
