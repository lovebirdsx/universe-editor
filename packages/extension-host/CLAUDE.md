# packages/extension-host/CLAUDE.md

扩展宿主（extension host）运行时：装好的扩展在这里被 spawn、扫描、按 Workspace Trust 门控激活、经 RPC 桥拿到宿主能力、按启用禁用过滤。分发链路（安装/更新/卸载/信任 UI）在 `apps/editor/src/main/services/extensionManagement/CLAUDE.md`——本文从 `onDidChangeExtensions` → `ExtensionsContribution.refreshExtensions()` 重扫之后接手，两端别混。

## 运行时四层（别改错层）

① main 进程 `extensionHostMainService.ts` **只搬字节**（spawn Electron-as-node + 抽 stdio，keyed by opaque handle），不懂 RPC。
② shared IPC 契约 `apps/editor/src/shared/ipc/extensionHostService.ts`（`ExtHostStartSpec`/`start`/`onStdout`…；`ExtHostKind` 已塌成单值 `'local'`）。
③ renderer 是 **RPC 对端**：`HostConnection`（一连接=protocol+client+server+全部 MainThread* 通道）+ `ExtensionHostClientService`（单 host 生命周期 + 命令路由）+ 各 `MainThread*.ts`（宿主能力实现）。
④ 决策层 `ExtensionEnablementService`（启用禁用 4 态引擎）。

- **第一原则：RPC 对端是 renderer 不是 main**——命令路由/View UI/SCM 状态都在 renderer。想暴露能力往 renderer 的 `MainThread*` 加，别往 main 加逻辑。RPC 复用 platform `ChannelServer/ChannelClient/ProxyChannel`（`/^on[A-Z]/` 是事件，其余方法名直传 call），唯一新代码是 stdio 适配器（`StdioFramingProtocol` 换行分帧，不用 base64）。
- **第二原则：隔离在激活期不在进程间（单 host + Workspace Trust）**：所有本地扩展（内置+外置）跑同一个 host、享完整 API 面，`capabilities.untrustedWorkspaces` + 工作区信任在**激活时**门控。曾按安装来源分 trusted/restricted 双进程，因受限 host 拿不到 languages 通道致 eslint 类扩展诊断失效而废弃（2026-07，见 memory [[extension-system-progress]]）。**已无进程级沙箱**：扩展（含外置）与内置同权（裸 node:fs/spawn）；**UI/文档不得宣称外部扩展已沙箱**。
- **贯穿红线：密钥绝不进 renderer/wire DTO，也绝不进日志。**

## 加一条 MainThread*/ExtHost* 通道（暴露宿主能力）

对标 VSCode `MainThreadXxx`/`ExtHostXxx`（最简样板 `MainThreadOutput`/`MainThreadStorage`）：

1. 契约 `packages/extensions-common/src/protocol/rpc.ts`：`ExtHostChannels` 加通道名 + `IMainThreadXxx`（renderer 实现）/`IExtHostXxx`（host 实现）接口 + wire DTO（**必须可结构化克隆**：URI 走 fsPath/revive，二进制走 base64 `bytes.ts`——newline-JSON 传不了 Uint8Array）。
2. host 侧 `packages/extension-host/src/`：`apiFactory.ts` bridge 加方法；`extensionService.ts` 实现并调 `IMainThreadXxx`；`bootstrap.ts` 建 client + 注册 `IExtHostXxx`。
3. extension-api `packages/extension-api/src/`：加 namespace/类型。**enum 用普通 enum 非 const enum**（扩展 tsconfig 开 `isolatedModules`，跨模块 const enum 报 TS2748）。
4. renderer 侧：`MainThreadXxx.ts` 实现；`HostConnection.ts` `server.registerChannel(ExtHostChannels.mainThreadXxx, ProxyChannel.fromService(...))`（host→renderer 方向还要 `client.getChannel` 建 proxy）；依赖经 `HostConnectionDeps` 传入，**无条件注册**（单 host 无按 tier 分叉）。
5. 建完重建 dist：`pnpm --filter @universe-editor/extensions-common --filter @universe-editor/extension-host build`（dev watcher 自动）。

**已有通道**：commands/window/scm/fs/output/languages/editor/ai/storage/webviews（extHost*/mainThread* 成对；window 另有反向通道 extHostWindow）。加能力前先看能否复用。

## 关键机制（坑结论）

- **spawn/env**（`extensionHostMainService.start`）：`spawn(process.execPath, [entry], {ELECTRON_RUN_AS_NODE})`——Electron 自带 node，不依赖系统 node/npx；handle=randomUUID 分流 stdio。env：内置+外部两目录（都扫，id 冲突 **dev > 内置 > 已装**，first-occurrence-wins）、`UNIVERSE_TSLS_*`、`UNIVERSE_WORKSPACE_ROOT`、`UNIVERSE_DISPLAY_LOCALE`、`UNIVERSE_DISABLED_EXTENSIONS`（**启用禁用生效点**）；e2e 专用 `UNIVERSE_ENABLED_EXTENSIONS` allowlist；`UNIVERSE_DEV_EXTENSIONS`（豁免 disabled 与 trust 门控）。
- **treeKill 是 backstop 不是主路径**：优雅停（stdin EOF 级联）让 CLI 的 exit hook 回收 tsserver 孙子进程；硬 SIGKILL 甩孤儿（卡 Playwright teardown）。改 host 退出路径务必保留优雅停链，见 [[agent-binary-silent-download-e2e-fix]] 与 [cases-runtime-pitfalls.md](cases-runtime-pitfalls.md)。
- **静态贡献命令需账本 `_commandOwner`**（`_fetchAndIndex` 记账 + ledger 回调）：静态命令的 bootstrap proxy 调的是 client service 的 `executeContributedCommand`，不闭包连接；重启窗口期旧连接命令随 teardown 清。成因见 [cases-runtime-pitfalls.md](cases-runtime-pitfalls.md)。
- **信任门控**（`activationService.ts` `_isActivatable`）：未受信 + `supported:false` + 非内置 → 不激活（= VSCode `DisabledByTrustRequirement`）；`limited` 照常激活自读 `workspace.isTrusted` 降级；**built-in 恒豁免**（scanner `builtin` 标志，否则 TS/git 在未信任窗口全挂）。信任状态：platform `IWorkspaceTrustManagementService`（最长父前缀继承、`workspaceTrustInitialized` 屏障）；连接后激活前先 `$initializeWorkspaceTrust` seed。**授予=动态**（`$onDidGrantWorkspaceTrust` → `replayFiredEvents()` 重放激活事件）；**撤销=重启 host**（已激活扩展无法就地卸载）。
- **fs 网关仍在但非沙箱**：`workspace.fs` 走 `MainThreadFs`（复用 `AcpPathPolicy` 拒 .ssh/.aws/.env + 禁逃逸），但扩展可裸 `node:fs` 绕过——不是安全边界。
- **启用禁用 4 态**（Disabled/Enabled × Global/Workspace；内置也可禁用）：决策引擎**必须在 renderer**（`ExtensionEnablementService`，workspace 态只在 renderer WORKSPACE storage，global 态读 main `extensions.json`）。优先级：workspace disabled → workspace enabled → global disabled → 默认 EnabledGlobally（**workspace 覆盖 global**）；host 唯一输入 = `getEffectiveDisabledIds`。
- **生效链（禁用=扫描时过滤）**：`getEffectiveDisabledIds → _disabledIds()`（与内置∪已装求交）`→ host.start({disabledIds}) → main 写 UNIVERSE_DISABLED_EXTENSIONS → bootstrap.ts 扫描 filter`。改生效方式顺此链找。
- **版本不兼容 ≠ 用户禁用**：`scanSingleExtension` 对 `engines.universe` 不满足返回 `isValid:false`+`validationMessage`（不再 throw-skip；manifest 解析失败仍 throw）；`computeActiveExtensions` 排除 isValid:false；UI 侧 main 用同源 `satisfies` 填 `isVersionCompatible`。
- **只在签名变化时重启**：`_launchedDisabledIds` + `disabledSignature`（排序 join），签名不变不重启——**无谓重启杀 + 重 spawn tsserver**；host 未跑时先清 `_starting` memo 再 `_restart`。
- **懒启动**：`_starting` memo 幂等；无外部扩展仍 spawn（内置同 host）。
- **崩溃重启**：指数退避 + `MAX_RESTARTS=3` 窗口，超限给手动 Restart 通知；planned stop（`_stopping`）不计崩溃；串行走 `_restartQueue`。
- **workspace 切换**：host 启动 pin workspace 根，切换需重启。**必先 `await Promise.allSettled([_starting])`**（`_repin` 屏障），否则撞上初始 boot 丢 swap，host 永远 pin 空 workspace（git 不注册 SCM）；`_repinning` 同步武装，同回合命令走 `_whenReady` 阻塞。见 [cases-runtime-pitfalls.md](cases-runtime-pitfalls.md)。
- **`_restart`**：stop → 重 start → `_fetchAndIndex` → fire `onDidChangeContributions`（**重 translate 必须在 activation 前**：新 host 命令先回 core 注册表才能被 onCommand proxy 命中）→ activateByEvent(STARTUP + STARTUP_FINISHED)。
- **reload 回收**：window reload 不 dispose service（async dispose 不跑），`beforeunload` 同步 `host.stop(handle)`——否则每次 reload 孤儿一个重型 host 饿死后续 spawn。见 [cases-runtime-pitfalls.md](cases-runtime-pitfalls.md)。
- **main `_setEnablement` 不 fire `onDidChangeExtensions`**：renderer 的 enablement 服务编排，main 再 fire 双重重启 host（quarantine 仍 fire）。
- **enablement 服务不碰 malicious**：恶意扩展走既有 quarantine（`ExtensionsContribution`）→ 写 global disabled → 自然表现为 DisabledGlobally。别在 enablement 服务里调 `quarantineMalicious`（有写副作用且只返回新增隔离 id）。
- **teardown 无条件清全局能力（单 host 下是对的）**：`_teardownConnection` 里 resetSourceControls/timeline/treeViews/webview 无条件调；临终 host 的 `$unregisterSourceControl` 可能随 IPC 关闭丢失，必须主动清，否则视图残留上一 workspace 的 provider。见 [cases-runtime-pitfalls.md](cases-runtime-pitfalls.md)。
- **wire 尾参 undefined 已在 RPC 层根治**（`ProxyChannel.toService` 剥尾部 undefined）；残余：**中段可选参数必须声明 `| null`**（JSON 数组语义 undefined→null，如 `$findFiles` 的 exclude/maxResults），用 `== null` 判定。见 [cases-runtime-pitfalls.md](cases-runtime-pitfalls.md)。
- **远程 host 的 $mid URI 会被 codec 互译**：renderer 的 MainThread* 做 `scheme === 'file'` 判断远程下必失效（曾致 `MainThreadFileEvents` 拒收 watcher base，git 收不到文件事件）——URI 空间判断同时接受 `file:` 与 `REMOTE_SCHEME`；裸字符串路径（LSP wire、SCM fsPath）不带 $mid，仍走 `parseWireUri`/`fsPathToWorkspaceUri` 手动互译。见 [cases-runtime-pitfalls.md](cases-runtime-pitfalls.md)。
- **DI 注册顺序**（`main.tsx`）：`ExtensionEnablementService` 必须先于 `ExtensionHostClientService` 与 `ExtensionsWorkbenchService`（两者注入它）。
- **Action2 async run 的 accessor 首个 await 即失效**：enablement 命令在第一个 await 前同步取完 service（快照传后续 helper），见 [[action2-async-accessor-invalidation]]。

## 常见任务 → 改哪里

- 暴露新宿主能力：加一条通道，见上 5 步。
- 改接线/依赖注入：`HostConnectionDeps` + `HostConnection` 注册 + `_connect` 传参（无条件注册）。
- 改信任门控语义：`activationService.ts` `_isActivatable` + manifest `capabilities.untrustedWorkspaces` zod（`extension-host/src/manifest.ts`）。
- 改信任 UI（状态栏 Restricted Mode + 首开未信任弹窗，E2E 探针在场跳过弹窗）：`WorkspaceTrustContribution` + `workspaceTrustActions.ts`。
- 改 host spawn/env：`extensionHostMainService.start`。
- 改内置/外部扫描目录：`builtinExtensionsDir.ts` / `userExtensionsDir.ts`（单一真相，host 与管理服务共用）。
- 远端用户扩展：经 `RemoteChannels.ExtensionManagement` 分发安装（`packages/remote-server`），远端 host 恒扫 `<dataDir>/user-extensions`——不经本机 `userExtensionsDir.ts`。
- 改 4 态语义/优先级：`ExtensionEnablementService`；改生效方式：顺生效链。
- 改启用禁用命令/快捷键/菜单：`extensionsActions.ts`（VSCode 对齐 ID，套路 A 注册）；workspace 命令先 `ctx.enablement.hasWorkspace()` 检查。
- 改扩展列表 UI enablement 呈现：门面 `ExtensionsWorkbenchService`（enablementState/isBuiltin）+ `workbench/extensions/*`。
- 改静态贡献翻译（manifest commands/menus/keybindings/configuration → core）：`ExtensionPointTranslator.ts`。
- 改崩溃/重启策略：`_handleCrash`/`_restart`/`MAX_RESTARTS`。
- 安装/更新/卸载到磁盘：**不在本文**，分发链路（`apps/editor/src/main/services/extensionManagement/CLAUDE.md`）。
- 语言 provider 怎么写：`mainThreadLanguages` 桥下游，skill [[extend-language-plugin]]。
- 起全新扩展骨架：skill `create-extension`。

## E2E

host 生命周期与启用禁用无直接 UI 入口，靠探针直调服务：契约 `apps/editor/src/shared/e2e/contract.ts`（`getBuiltinExtensionIds`/`getDisabledExtensionIds`/`setExtensionEnablement(identifier, enabled, workspace?)`）、实现 `apps/editor/src/renderer/e2e/probe.ts`（`main.tsx` 接线）、spec `e2e/specs/smoke.extensions.spec.ts`（`@regression`：禁用内置扩展进 effective disabled 集）。e2e 跑 `out/` 产物：改 renderer/main/probe 后必先 `pnpm --filter @universe-editor/editor build`；`@regression` 默认被主趟剥离，单独验证加 `--grep "@regression"`。

## 验证

```bash
cd apps/editor && pnpm exec vitest run ExtensionEnablementService ExtensionHostClientService ExtensionsWorkbenchService
pnpm --filter @universe-editor/extension-host test
pnpm --filter editor build    # e2e 前必重建
cd apps/editor && npx playwright test -c e2e/playwright.config.ts e2e/specs/smoke.extensions.spec.ts --grep "@regression"
pnpm check    # 仅看错误
```

> 改了用户可见行为（命令名/界面文案/交互流程）时同步 `docs/user/zh-CN/customization/extensions.md`；`pnpm docs:check` 校验死链。

## 关键参考路径

- 路径速查（apps/editor）：main `services/extensionHost/{extensionHostMainService,builtinExtensionsDir,userExtensionsDir,tsServerPaths}.ts`；IPC 契约 `shared/ipc/extensionHostService.ts`；renderer `services/extensions/{ExtensionHostClientService,HostConnection,MainThread*,ExtensionPointTranslator,ExtensionEnablementService}.ts` + `services/extensionsWorkbench/ExtensionsWorkbenchService.ts` + `contributions/ExtensionsContribution.ts` + `actions/extensionsActions.ts`；DI `renderer/main.tsx`（EnablementService 先于 ClientService/WorkbenchService）
- 路径速查（packages）：`extensions-common/src/protocol/rpc.ts`（`ExtHostChannels` + 接口 + wire DTO；`bytes.ts` base64；`stdioProtocol.ts` 换行分帧）；`extension-host/src/{bootstrap,apiFactory,extensionService,activationService}.ts`；`platform/src/workspace/workspaceTrust.ts`（信任状态 + `workspaceTrustInitialized` 屏障）
- 用户文档：`docs/user/zh-CN/customization/extensions.md`。VSCode 对照：`src/vs/workbench/services/extensions/`、`src/vs/workbench/services/extensionManagement/`（`IWorkbenchExtensionEnablementService`/`EnablementState`）
- 相关：memory [[extension-system-progress]] / [[agent-binary-silent-download-e2e-fix]]；`apps/editor/src/main/services/extensionManagement/CLAUDE.md`；skill `create-extension` / `register-monaco-command` / `fix-disposable-leak`；[[extend-language-plugin]]；`apps/editor/src/renderer/workbench/webview/CLAUDE.md`；`apps/editor/src/renderer/services/views/CLAUDE.md`（套路 B）

## 其它

- 后续发现新经验（新通道套路、隔离/生命周期坑、启用禁用新语义），同步更新本文件。