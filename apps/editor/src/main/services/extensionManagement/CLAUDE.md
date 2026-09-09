# apps/editor/src/main/services/extensionManagement/CLAUDE.md

对等 VSCode 的 `extensionManagement` 层——插件市场与扩展管理的**分发链路**（获取、安装、更新、卸载、治理）：main 服务在本目录，renderer 侧在 `services/extensionsWorkbench` + `workbench/extensions`，加载运行时在 `packages/extension-host/CLAUDE.md`（别混）。

> ⚠️ 先分清改动落在哪层：① 纯逻辑包（`extension-packaging` 读 VSIX / `extension-gallery` 编解码市场协议，零 IO 零 DI）② main 服务（落盘/下载/网络）③ shared IPC 契约 ④ renderer（门面 + UI + 命令）。改错层要么运行不生效，要么把 IO 泄进纯逻辑包。本文档到「落盘 + 触发 host 重启重扫」为止。

## 架构总览（四层）

```
① 纯逻辑包（零 IO / 零 DI，bundle 进 main）
   packages/extension-packaging/src/{vsix,signature}.ts   VSIX=ZIP 读取/校验（zip-slip 防护）+ Ed25519 验签
   packages/extension-gallery/src/{protocol,query,parse}.ts   /extensionquery POST 协议 codec + pickVsixAsset + readEngineConstraint
   packages/extension-manifest/src/{manifest,manifest-schema,semver}.ts   manifest 校验 + semver

② main 服务（IO / 网络 / 落盘编排）
   extensionManagementService.ts   install/uninstall/getInstalled + installFromGallery + 启用禁用 + 更新 + 恶意隔离
   extensionGalleryService.ts      query/getExtensions/download/getControlManifest（网络失败降级空、绝不 throw）
   packages/node-services/src/extensions/extensionInstallEngine.ts         installVsix 七步/uninstall/sweepObsolete（main 与远端 server 共享）
   packages/node-services/src/extensions/installedExtensionsManifest.ts    extensions.json 读写（installed[] + enablement 往返 + .obsolete + rename-with-retries）
   packages/node-services/src/extensions/nls.ts                            manifest NLS 本地化（%key% → package.nls*.json）

③ shared IPC 契约：shared/ipc/extensionManagementService.ts + extensionGalleryService.ts（wire DTO 可结构化克隆）

④ renderer（门面 + UI + 命令）
   services/extensionsWorkbench/ExtensionsWorkbenchService.ts   聚合已装+市场→IExtensionEntry，装前信任门禁
   workbench/extensions/{ExtensionsView,ExtensionEditor}.tsx    视图（搜索+分栏）+ 详情页（README/贡献点/装卸）
   services/editor/ExtensionEditorInput.ts                      详情页虚拟 EditorInput（scheme universe:/extension/<id>）
   contributions/ExtensionsViewContribution.ts                  视图容器+视图（套路 B）
   actions/extensionsActions.ts                                 从VSIX安装/卸载/显示/检查更新命令（套路 A）
```

## ① 纯逻辑包（extension-packaging / extension-gallery）

**判定标准：能不能不碰 fs/net/DI 就写完？能→放这里，用 vitest node 纯单测。**

- `vsix.ts`：**zip-slip 防护**（解压路径规范化后必须仍在目标目录内）是安全红线，勿删。
- `parse.ts`：`ENGINE_PROPERTY_KEYS` **同时认** `Universe.Editor.Engine` + `Microsoft.VisualStudio.Code.Engine`（兼容 VSCode 生态包）；**无 vsixUrl 的版本直接丢弃**。
- `pickCompatibleVersion(ext, hostVersion)`：按 host 版本选第一个 `satisfies(engineConstraint)` 的版本（缺失 fail-open）。`_installFromGallery` 用它选版，`checkForUpdates` 只推兼容新版；renderer 标注「将安装兼容版本 X」并禁用不兼容项安装按钮。
- 请求头 `Accept: application/json;api-version=3.0-preview.1`（open-vsx 同款）。

## ② main 服务

### 管理服务 `extensionManagementService.ts`

- **落盘七步（install）**：解压临时目录 → 校验 manifest → 目标 `<userData>/extensions/<id>-<version>/` → 原子 rename → 写 `extensions.json` → 清 `.obsolete` → fire `onDidChangeExtensions`。Windows 文件占用兜底：删不掉的目录打 `.obsolete` 标记，下次启动扫描时清扫。**落盘在共享引擎 `installVsix`，本服务只做 gallery 下载/验签/防投毒 + 队列 + 事件编排。**
- **`installFromGallery`（防投毒核心）**：`_assertNotMalicious` → `gallery.download` → `readVsixManifest` → **校验下载包 `publisher.name.version` 与市场元数据一致** → 复用本地 install（带 `galleryMetadata`）。
- **启用禁用**：`getDisabledIds` / `setEnablement`（全局粒度，持久化在 `extensions.json` 的 enablement 段）。
- **更新**：`checkForUpdates`（对已装的 gallery-source 扩展反查比版本）/ `updateExtension`（= installFromGallery）。
- **恶意隔离**：`quarantineMalicious`（拉 control manifest，禁用已装恶意 id）。

### 市场服务 `extensionGalleryService.ts`

- `query` / `getExtensions` / `download`（缓存目录 `CachedExtensionVSIXs`，temp+rename）/ `getControlManifest`（TTL 缓存）。
- **网络红线：`query`/`getExtensions` 任何网络失败都降级返回空、绝不 throw**（市场不可达时 UI 仍可用）。
- `GALLERY_URL` 经 `IEnvironmentMainService.galleryUrl` 读（cli/env/file）。**默认空 = OSS 语义**：未配置则市场搜索恒空，只有本地 `.vsix` 可用。

### enablement 持久化

`extensions.json` 同时存 `installed[]` 和 enablement。**坑：`writeInstalledRecords` 必须经 `readManifestFile` 往返保留 enablement**（勿回退），否则装一个新扩展就把别的禁用状态冲掉。

### 启用禁用 → 生效链路（host 过滤）

禁用不是运行时卸载，是**扫描时过滤**：`getDisabledIds` → renderer 传进 host 启动 spec `disabledIds` → main 写 env `UNIVERSE_DISABLED_EXTENSIONS` → `extension-host/src/bootstrap.ts` 扫描时按 `e.id` 过滤。

### 远程路由（authority 尾参）

9 个方法带可选 `authority?` 尾参（getInstalled/installVSIX/installFromGallery/uninstall/getDisabledIds/getLocalIcon/setEnablement/checkForUpdates/updateExtension），非空即路由远端：

- **代理取得**：`_remoteProxy(authority)` = `IRemoteConnectionService.getServiceProxy(authority, RemoteChannels.ExtensionManagement)`，**每次调用都重取、绝不缓存**（跨 stop/reconnect 稳定，缓存会致死代理——见根 CLAUDE.md 远程行）。
- **远端安装 = 本地验签 + 分片上传**：client 侧先跑完所有本地闸门（防投毒、验签、引擎兼容），再 `uploadBegin → uploadChunk(≤1 MiB) → installUploaded` 上传；server 只 re-check identifier/version 后调共享 `installVsix` 落盘。
- **远端目录**：`remote-server/src/extensionManagementService.ts` 管 `<dataDir>/user-extensions`；目录解析单一真相在同目录 `serverPaths.ts`；协议契约 `node-services/src/extensions/extensionManagementProtocol.ts`。

**已知限制**：`quarantineMalicious` 只治理本机；"市场不可达"与"查无此扩展"同显示为不可安装；同 id 本地/远端条目共用同一 enablement 徽标；写序列化按 daemon 进程级隔离。

## ③ shared IPC 契约

`createDecorator` + `ProxyChannel.fromService/toService`（套路 C），通道名在 `shared/ipc/channelNames.ts`。

## ④ renderer

- **门面 `ExtensionsWorkbenchService`**：聚合 `ILocalExtension` + `IGalleryExtension` → `IExtensionEntry`。`_searchSeq` 单调 token 防陈旧搜索覆盖。`install()` 前先 `_ensurePublisherTrusted`。
- **视图**：`ExtensionsView.tsx`（搜索 300ms debounce + INSTALLED/MARKETPLACE 分栏）。
- **详情页**：虚拟 `ExtensionEditorInput`（TYPE_ID `extensionDetail`）+ `ExtensionEditor.tsx`；provider 在 `BuiltInEditorProvidersContribution.ts` 注册，`EditorArea.tsx` 的 `editorComponentMap.set('extensionDetail', ExtensionEditor)`。
- **命令** `extensionsActions.ts`：ShowExtensions / InstallFromVSIX / Uninstall / CheckForExtensionUpdates。

## 四道安全闸门（安全红线，勿拆）

1. **防投毒**：市场安装校验下载 VSIX 的 `publisher.name.version` 与市场元数据一致。
2. **市场验签（fail-closed）**：市场安装强制校验 Ed25519 签名（`vsixHash`+`vsixSignature`，公钥内置 `marketplaceSigningKeys.ts`，env `UNIVERSE_GALLERY_SIGNING_KEYS` 可叠加覆盖）——未签名/hash 不符/签名不过/未知 keyId 一律拒装。本地 `installVSIX` **有意不验签**（用户显式选择=显式信任）。验签在纯包 `extension-packaging/signature.ts`；发布侧签名见 `scripts/gallery`。
3. **发布者信任**：首次安装某发布者弹确认（`_ensurePublisherTrusted`），记住集存 `IStorageService` GLOBAL（key `extensions.trustedPublishers`）。
4. **恶意隔离**：control manifest 标记的恶意扩展——安装时拒绝（`_assertNotMalicious`，fetch 失败 fail-open、命中 fail-closed），已装的启动时 `quarantineMalicious` 自动禁用 + 通知（`ExtensionsContribution._boot` 末尾）。

**贯穿红线（全项目级）**：密钥绝不进日志/AI Debug/任何 wire DTO，UI 一律掩码；**UI/文档不得宣称扩展已沙箱**（外部扩展近乎原生 Node 权限）。

## 关键决策（已拍板）

- **市场装强制 publisher**（防投毒依赖）；本地 `.vsix` 容忍无 publisher（id 退化为 name）。
- **System（内置、不可卸） vs User（市场/VSIX 装）**：市场只管 User。
- **启用禁用只做全局粒度**，workspace 级后置。

## 常见任务 → 改哪里

- **加市场协议字段 / 换 asset 解析**：`extension-gallery/parse.ts`（+ `protocol.ts` 常量），纯单测。
- **改 VSIX 读取 / 打包兼容**：`extension-packaging/vsix.ts`（zip-slip 防护勿动）。
- **改安装落盘 / 原子性 / 占用兜底**：`node-services/src/extensions/extensionInstallEngine.ts` 的 installVsix 七步 + 同目录 `installedExtensionsManifest.ts`。
- **改防投毒校验**：`extensionManagementService._installFromGallery` 的一致性校验段。
- **改市场验签 / 密钥轮换**：`extension-packaging/signature.ts` + `marketplaceSigningKeys.ts`；发布侧签名 `scripts/gallery`。
- **改市场地址配置**：`main/environment/configItems.ts`（GALLERY_URL 项）。
- **改启用禁用粒度 / 生效方式**：`getDisabledIds/setEnablement` + host 过滤链（见上「生效链路」节）。
- **改更新检查策略**：`checkForUpdates`（版本比较 `extension-manifest/semver.ts`；选版 `pickCompatibleVersion`）。
- **改远端路由 / 分片上传 / 远端目录**：`_remoteProxy`/`_uploadAndInstall` + `remote-server/src/{extensionManagementService,serverPaths}.ts` + 协议 `node-services/src/extensions/extensionManagementProtocol.ts`。
- **改信任提示文案/记住策略**：`ExtensionsWorkbenchService._ensurePublisherTrusted`。
- **改扩展视图/详情页 UI**：`workbench/extensions/{ExtensionsView,ExtensionEditor}.tsx`。
- **加扩展相关命令**：`actions/extensionsActions.ts` + `actions/index.ts`（套路 A）。
- **扩展装好后怎么加载/激活**：**不在本文档**，是运行时（`packages/extension-host/CLAUDE.md`）。

## 易踩坑速记

1. **DI 注册顺序：gallery 必须先于 management**（管理服务构造函数注入 `IExtensionGalleryService`）。`main/services/main-services.ts` 里顺序反了运行时报未注册。
2. **`writeInstalledRecords` 会冲掉 enablement**（勿回退）：任何写 `extensions.json` 的路径都要经 `readManifestFile` 往返保留 enablement。
3. **纯逻辑包别混进 IO**：`extension-gallery`/`extension-packaging` 零 IO 零 DI；下载、缓存、落盘都在 main 服务。
4. **workspace 包放 devDependencies + externalizeDeps**：纯逻辑包被 main bundle（`externalizeDeps.exclude`），运行时 npm 依赖才进 `dependencies`。放错会打包崩（见 [[electron-builder-asarunpack-pnpm-workspace]]）。
5. **Action2 async run 的 accessor 首个 await 即失效**：install/uninstall/update 命令须在第一个 `await` 前同步取完所有 service（见 [[action2-async-accessor-invalidation]]）。
6. **IStorageService 是 async get/set**（无 StorageTarget），`StorageScope` 只有 `GLOBAL=0`/`WORKSPACE=1`（无 APPLICATION）；`localize` 用具名占位 `{name}`；`IDialogService.confirm` 结果必带 `choice`。
7. **详情页 EditorInput 身份隔离**：虚拟 scheme `universe:/extension/<id>` 让每个扩展详情页是独立 tab（见 [[editor-input-identity-isolation]]）。
8. **测恶意隔离要用可变 malicious 列表**：先干净装、再把 id 加进 malicious，然后测 `quarantineMalicious`——否则 install 自身的恶意检查直接拒装。
9. **VSIX 磁盘缓存必须对 hash 才准命中**：同版本重发后 registry 的 sha256 会变；`download()` 命中前比对 `extension.vsixHash`，不符则删了重下（否则验签永远 hash-mismatch 且无自愈路径）。
10. **extensions.json 原子写的 rename 必须带重试（勿回退成裸 `fs.rename`）**：Windows 下目标文件会被 host 重扫并发读 / Defender 扫描瞬时持有，rename 直接 EPERM。`writeJsonAtomic` 走 `renameWithRetries`（EPERM/EACCES/EBUSY 10×100ms），有单测守护。

## E2E

install 命令走文件对话框，无法直接驱动，故加探针直调服务：

- 契约 `shared/e2e/contract.ts`：`installVsixExtension` / `uninstallExtension` / `getInstalledExtensionIds`；实现 `renderer/e2e/probe.ts`。
- spec `e2e/specs/smoke.extensions.spec.ts`（@p1；装卸那条打 `@regression` 剥离主趟，tag 语义见 `apps/editor/e2e/CLAUDE.md`）。
- 市场链路 e2e：`smoke.extensionsGallery.spec.ts`（@p1，文件内串行）——beforeAll 现场生成 Ed25519 密钥对、真跑 `publish.mjs` + `server.mjs`，app 经 `UNIVERSE_GALLERY_URL` + `UNIVERSE_GALLERY_SIGNING_KEYS` 指向该实例；探针 `installGalleryExtension`（绕过信任对话框）。

## 验证

```bash
pnpm --filter @universe-editor/extension-gallery test      # 市场协议 codec
pnpm --filter @universe-editor/extension-packaging test    # VSIX 读取 + zip-slip
cd apps/editor && pnpm exec vitest run extensionManagementService ExtensionsWorkbenchService
pnpm --filter editor build    # e2e 前必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts smoke.extensions
```

> 改了用户可见行为（命令名、市场交互、信任提示文案）时，同步 `docs/user/zh-CN/customization/extensions.md`。e2e 跑 `out/` 产物，改 renderer/main/probe 后必先 `pnpm --filter editor build`。

## 相关

- 运行时（host/RPC/provider，本文档的下游）：`packages/extension-host/CLAUDE.md`；memory [[extension-system-progress]] / [[remote-user-extensions-management]] / [[extension-api-review-followup-round]]
- VSCode 对照：`src/vs/platform/extensionManagement/`；skill：extend-language-plugin / register-monaco-command / fix-disposable-leak
