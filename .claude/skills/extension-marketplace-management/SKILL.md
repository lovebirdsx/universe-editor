---
name: extension-marketplace-management
description: 处理"插件市场/扩展管理（分发链路）"相关功能时召回——本仓库对等 VSCode `extensionManagement` 层，让外部开发者可发布、用户可搜索/安装/更新/卸载扩展。当任务涉及从本地 `.vsix` 安装扩展、接市场搜索并一键安装（`/extensionquery` 协议）、扩展视图/详情页 UI、检查更新、发布者信任提示、启用/禁用扩展、恶意扩展隔离、control manifest（恶意/弃用清单）、GALLERY_URL 市场地址配置、VSIX 打包读取/校验、防投毒一致性校验、用户扩展目录（`<userData>/extensions`）的可写管理（extensions.json / .obsolete / 原子 rename）时使用。给出四层架构（extension-packaging/extension-gallery 纯逻辑包 → main 管理+市场服务 → shared IPC 契约 → renderer 门面+UI）的文件地图、防投毒/信任/隔离三道安全闸门、启用禁用的持久化与 host 过滤链路、DI 注册顺序坑、安全红线。区别于运行时那层（extension host 子进程 / RPC / provider / SCM，见 memory [[extension-system-progress]] 与 skill extend-language-plugin）：本 skill 是"获取→安装→更新→卸载→信任治理"的分发链路本身，不碰扩展怎么被加载运行。
disable-model-invocation: true
---

# 插件市场与扩展管理（分发链路）

对等 VSCode 的 `extensionManagement` 层。核心判断（调研 VSCode 源码 + 本仓库已确立）：**运行时早已就绪**（extension host 子进程、双信任层、`<userData>/extensions` 已被 restricted host 扫描），本层补的是**分发链路**——用户"获取、安装、更新、卸载、治理"扩展的整条路。

> ⚠️ 第一原则：**先分清你的改动落在哪一层**。四层职责不交叉：① 纯逻辑包（`extension-packaging` 读 VSIX / `extension-gallery` 编解码市场协议，零 IO、零 DI）② main 服务（真正落盘、下载、网络）③ shared IPC 契约（`createDecorator` + wire DTO）④ renderer（门面 `ExtensionsWorkbenchService` + 视图/详情页 UI + 命令）。改错层要么编译过运行不生效，要么把网络/文件 IO 泄进了本该纯的逻辑包。
>
> ⚠️ 第二原则：**分发 ≠ 运行时**。"装好的扩展怎么 spawn、怎么注册 provider/命令/SCM、怎么崩溃重启"是运行时（另一套，见 memory [[extension-system-progress]]）。本 skill 到"落盘 + 触发 restricted host 重扫"为止；重扫之后的加载是运行时的事。两端别混。

## 架构总览（四层）

```
① 纯逻辑包（零 IO / 零 DI，bundle 进 main）
   packages/extension-packaging/src/vsix.ts        VSIX=ZIP+extension/package.json 读取/解压/校验（zip-slip 防护）
   packages/extension-gallery/src/{protocol,query,parse}.ts   /extensionquery POST 协议 codec + pickVsixAsset + readEngineConstraint
   packages/extensions-common/src/{manifest,manifest-schema}.ts   manifest 校验（含市场元数据字段）+ semver.ts（satisfies/compareVersions）

② main 服务（IO / 网络 / 落盘）
   apps/editor/src/main/services/extensionManagement/extensionManagementService.ts   install/uninstall/getInstalled + installFromGallery + 启用禁用 + 更新 + 恶意隔离
   apps/editor/src/main/services/extensionManagement/extensionGalleryService.ts      query/getExtensions/download/getControlManifest（网络失败一律降级空、绝不 throw）
   apps/editor/src/main/services/extensionManagement/installedExtensionsManifest.ts  extensions.json 读写（installed[] + enablement 往返）

③ shared IPC 契约（createDecorator + wire DTO）
   apps/editor/src/shared/ipc/extensionManagementService.ts   IExtensionManagementService + ILocalExtension + IExtensionUpdate
   apps/editor/src/shared/ipc/extensionGalleryService.ts      IExtensionGalleryService + IGalleryExtension + IExtensionControlManifest

④ renderer（门面 + UI + 命令）
   apps/editor/src/renderer/services/extensionsWorkbench/ExtensionsWorkbenchService.ts   聚合已装+市场→IExtensionEntry，装前信任门禁
   apps/editor/src/renderer/workbench/extensions/{ExtensionsView,ExtensionEditor}.tsx     视图（搜索+分栏）+ 详情页（README/贡献点/装卸）
   apps/editor/src/renderer/services/editor/ExtensionEditorInput.ts                       详情页虚拟 EditorInput（scheme universe:/extension/<id>）
   apps/editor/src/renderer/contributions/ExtensionsViewContribution.ts                   视图容器+视图（套路 B）
   apps/editor/src/renderer/actions/extensionsActions.ts                                  从VSIX安装/卸载/显示/检查更新命令
```

## ① 纯逻辑包（extension-packaging / extension-gallery）

**判定标准：能不能不碰 fs/net/DI 就写完？能→放这里，用 vitest node 纯单测。**

- `extension-packaging/vsix.ts`：VSIX 就是 ZIP，取 `extension/package.json`。**zip-slip 防护**（解压路径必须规范化后仍在目标目录内，`..` 越界拒绝）是安全红线，勿删。
- `extension-gallery`：
  - `protocol.ts`：`/extensionquery` POST body 构造 + `AssetType` 常量（沿用 VSCode 名）。请求头 `Accept: application/json;api-version=3.0-preview.1`（open-vsx 同款）。
  - `parse.ts`：响应 → 领域模型 `IGalleryExtension`。`pickVsixAsset` 挑 VSIX 下载地址、`readEngineConstraint` 读引擎约束。`ENGINE_PROPERTY_KEYS` **同时认** `Universe.Editor.Engine` + `Microsoft.VisualStudio.Code.Engine`（兼容 VSCode 生态包）。**无 vsixUrl 的版本直接丢弃**（装不了的条目不进模型）。
  - `query.ts`：`buildQuery(options)` / `parseQueryResult(raw)`。

## ② main 服务

### 管理服务 `extensionManagementService.ts`

- **落盘七步（install）**：解压到临时目录 → 校验 manifest → 目标 `<userData>/extensions/<id>-<version>/` → 原子 rename → 写 `extensions.json` → 清 `.obsolete` 标记 → fire `onDidChangeExtensions`。Windows 文件占用兜底：删不掉的目录打 `.obsolete` 标记，下次启动扫描时清扫。
- **`installFromGallery`（防投毒核心）**：`_assertNotMalicious` → `gallery.download` → `readVsixManifest` → **校验下载包的 `publisher.name.version` 与市场元数据一致**（不一致 throw `does not match the marketplace entry`）→ 复用本地 install（带 `galleryMetadata`）。这一步是防"市场元数据说是 A、下载下来是 B"的投毒。
- **`IManagementGallery`**（注入接口，`{download, getControlManifest, getExtensions}`）：构造函数第 3 参，让管理服务能反查市场（更新检查、恶意清单）。
- **启用禁用**：`getDisabledIds` / `setEnablement`（全局粒度，持久化在 `extensions.json` 的 enablement 段）。
- **更新**：`checkForUpdates`（对已装的 gallery-source 扩展 `getExtensions` 反查、比版本）/ `updateExtension`（= installFromGallery）。
- **恶意隔离**：`quarantineMalicious`（拉 control manifest，禁用已装的恶意 id，返回禁用列表）。

### 市场服务 `extensionGalleryService.ts`

- `query` / `getExtensions` / `download`（下载到 `CachedExtensionVSIXs`，temp+rename，命中缓存复用）/ `getControlManifest`（TTL 缓存 + untrusted 归一化）。
- **网络红线：`query`/`getExtensions` 任何网络失败都降级返回空、绝不 throw**（市场不可达时 UI 仍可用，只是搜不到）。
- `GALLERY_URL` 经 `IEnvironmentMainService.galleryUrl` 读（三层配置 cli `--gallery-url` / env `UNIVERSE_GALLERY_URL` / file `galleryUrl`）。**默认空 = OSS 语义**：未配置则市场搜索恒空，只有本地 `.vsix` 可用。

### enablement 持久化 `installedExtensionsManifest.ts`

`extensions.json` 同时存 `installed[]` 和 enablement。**坑：`writeInstalledRecords` 必须保留 enablement**（经 `readManifestFile` 往返），否则装一个新扩展就把别的禁用状态冲掉了。

### 启用禁用 → 生效链路（host 过滤）

禁用不是运行时卸载，是**扫描时过滤**：`getDisabledIds` → renderer 传进 restricted host 启动 spec 的 `disabledIds` → main 写 env `UNIVERSE_DISABLED_EXTENSIONS` → `packages/extension-host/src/bootstrap.ts` 扫描时按 `e.id` 过滤掉。改启用禁用生效方式就顺这条链找。

## ③ shared IPC 契约

`createDecorator` + `ProxyChannel.fromService/toService`（套路 C）。通道名在 `shared/ipc/channelNames.ts`（`ExtensionManagement: 'extensionManagement'` / `ExtensionGallery: 'extensionGallery'`）。wire DTO 要可结构化克隆（URI 用 fsPath 字符串或 revive）。`IExtensionControlManifest = { malicious: readonly string[], deprecated: Record<...> }`。

## ④ renderer

- **门面 `ExtensionsWorkbenchService`**：聚合 `ILocalExtension`（已装）+ `IGalleryExtension`（市场）→ 视图模型 `IExtensionEntry`。`_searchSeq` 单调 token 防陈旧搜索结果覆盖新的。`install()` 前先 `_ensurePublisherTrusted`（信任门禁，见下）。用 `instantiation.createInstance` 在 main.tsx 注册。
- **视图**：`ExtensionsView.tsx`（搜索框 300ms debounce + INSTALLED/MARKETPLACE 分栏 + 行内装卸按钮）。视图容器/视图走 `ExtensionsViewContribution.ts`（套路 B，icon Puzzle，注册在 `contributions/registration/blockStartup.ts`）。
- **详情页**：虚拟 `ExtensionEditorInput`（scheme `universe:/extension/<id>`，TYPE_ID `extensionDetail`）+ `ExtensionEditor.tsx`（Header 装/卸/能力警告 + README tab（`MarkdownView` 传 `text`）+ Contributions tab）。provider 在 `BuiltInEditorProvidersContribution.ts` 注册，`EditorArea.tsx` 的 `editorComponentMap.set('extensionDetail', ExtensionEditor)`。
- **命令** `extensionsActions.ts`：ShowExtensions / InstallFromVSIX / Uninstall / CheckForExtensionUpdates，在 `actions/index.ts` 注册（套路 A）。

## 三道安全闸门（安全红线，勿拆）

1. **防投毒**：市场安装校验下载 VSIX 的 `publisher.name.version` 与市场元数据一致（`installFromGallery`）。
2. **发布者信任**：首次安装某发布者弹确认（`_ensurePublisherTrusted`），记住集存 `IStorageService` GLOBAL scope（key `extensions.trustedPublishers`）。诚实告知"接近编辑器本身的权限"。
3. **恶意隔离**：control manifest 标记的恶意扩展——安装时拒绝（`_assertNotMalicious`，fetch 失败 fail-open、命中 fail-closed），已装的在启动时 `quarantineMalicious` 自动禁用 + 通知（`ExtensionsContribution._boot` 末尾）。

**贯穿红线（全项目级）**：密钥只走 main `ISecretStorageService`(safeStorage)，绝不进 renderer/settings.json/任何 wire DTO；扩展无读密钥接口；AI 能力只给 trusted(内置)扩展；**UI/文档不得宣称扩展已沙箱**（外部扩展近乎原生 Node 权限，`docs/user/zh-CN/customization/extensions.md` 已如实写"接近编辑器本身的权限"）。

## 关键决策（已拍板，见计划 README §5/§6）

- **市场装强制 publisher**（防投毒依赖它）；本地 `.vsix` 容忍无 publisher（id 退化为 name，照顾内置扩展打包）。
- **GALLERY_URL 默认空 = OSS**；协议对齐 `/extensionquery`，后端形态不锁死（可指自建或 open-vsx）。
- **System（内置、不可卸） vs User（市场/VSIX 装）**：市场只管 User。
- **启用禁用只做全局粒度**，workspace 级后置。
- **Phase E（Node 硬隔离 + VSIX 签名验证）不做**，仅登记未来路线。

## 常见任务 → 改哪里

- **加一类市场协议字段 / 换 asset 解析**：`extension-gallery/parse.ts`（+ `protocol.ts` 常量），纯单测。
- **改 VSIX 读取 / 打包兼容**：`extension-packaging/vsix.ts`（zip-slip 防护勿动）。
- **改安装落盘流程 / 原子性 / 占用兜底**：`extensionManagementService.ts` 的 install 七步 + `installedExtensionsManifest.ts`。
- **改防投毒校验**：`extensionManagementService._installFromGallery` 的一致性校验段。
- **改市场地址配置**：`main/environment/configItems.ts`（GALLERY_URL 项 + CLI_OPTIONS）+ `environmentMainService.ts` getter。
- **改启用禁用粒度 / 生效方式**：管理服务 `getDisabledIds/setEnablement` + host 过滤链（env `UNIVERSE_DISABLED_EXTENSIONS` → bootstrap 过滤）。
- **改更新检查策略**：`checkForUpdates`（版本比较用 `extensions-common/semver.ts` 的 `compareVersions`）。
- **改信任提示文案/记住策略**：门面 `ExtensionsWorkbenchService._ensurePublisherTrusted`（storage key `extensions.trustedPublishers`）。
- **改扩展视图/详情页 UI**：`workbench/extensions/{ExtensionsView,ExtensionEditor}.tsx`。
- **加扩展相关命令**：`actions/extensionsActions.ts` + `actions/index.ts`（套路 A）。
- **扩展装好后怎么加载/激活/注册命令**：**不在本 skill**，是运行时（memory [[extension-system-progress]]）。本 skill 到 fire `onDidChangeExtensions` → `ExtensionsContribution` 触发 `refreshExtensions`（restricted host 重扫）为止。

## 易踩坑速记

1. **DI 注册顺序：gallery 必须先于 management**。管理服务构造函数注入 `IExtensionGalleryService`（作为 `IManagementGallery`），所以在 `apps/editor/src/main/services/main-services.ts` 里 gallery 要先注册，management 的 factory 里 `acc.get(IExtensionGalleryService)` 才拿得到。顺序反了运行时报未注册。
2. **`writeInstalledRecords` 会冲掉 enablement**（勿回退）：任何写 `extensions.json` 的路径都要经 `readManifestFile` 往返保留 enablement，否则装一个扩展把其它禁用状态清零。
3. **纯逻辑包别混进 IO**：`extension-gallery`/`extension-packaging` 是零 IO 零 DI 的 codec/reader。下载、缓存、落盘都在 main 服务。混进去就没法纯单测，也会让 bundle 依赖膨胀。
4. **workspace 包放 devDependencies + externalizeDeps**：纯逻辑包被 main bundle（`externalizeDeps.exclude`），运行时 npm 依赖（如 adm-zip）才进 `dependencies`。放错会打包崩（见 [[electron-builder-asarunpack-pnpm-workspace]]）。
5. **Action2 async run 的 accessor 首个 await 即失效**：install/uninstall/update 命令须在第一个 `await` 前同步取完所有 service（见 [[action2-async-accessor-invalidation]]）。
6. **IStorageService 是 async get/set**（无 store、无 StorageTarget），`StorageScope` 只有 `GLOBAL=0`/`WORKSPACE=1`（**无 APPLICATION**）；`localize` 用具名占位 `{name}` + 对象参（**非** `{0}`）；`IDialogService.confirm` 结果必带 `choice`。
7. **详情页 EditorInput 身份隔离**：虚拟 scheme `universe:/extension/<id>` 让每个扩展的详情页是独立 tab（见 [[editor-input-identity-isolation]]）。
8. **测恶意隔离要用可变 malicious 列表**：先干净装、再把 id 加进 malicious，然后测 `quarantineMalicious`——否则 install 自身的恶意检查会直接拒绝安装，测不到隔离路径。
9. **市场服务网络失败别 throw**：`query`/`getExtensions` 降级空数组。UI 层不该因市场不可达而崩。

## E2E

install 命令走文件对话框，无法在 e2e 里直接驱动，因此加了探针方法直调服务：
- 契约 `apps/editor/src/shared/e2e/contract.ts`：`installVsixExtension` / `uninstallExtension` / `getInstalledExtensionIds`。
- 实现 `apps/editor/src/renderer/e2e/probe.ts`（注入 `extensionManagementService`，在 `main.tsx` 的 `installE2EProbeIfEnabled({...})` 里接线）。
- spec `apps/editor/e2e/specs/smoke.extensions.spec.ts`（@p1；打开视图容器 + 用 `adm-zip` 现造 VSIX 装→`hasCommand` 出现→卸载消失，装卸那条打 `@regression` 从主趟剥离、CI 全量覆盖，见 [[e2e-regression-tag]]）。
- **e2e 跑 `out/` 产物**，改 renderer/main/probe 后必先 `pnpm --filter editor build` 再跑。

## 验证

```bash
pnpm --filter @universe-editor/extension-gallery test      # 市场协议 codec
pnpm --filter @universe-editor/extension-packaging test    # VSIX 读取 + zip-slip
cd apps/editor && pnpm exec vitest run extensionManagementService ExtensionsWorkbenchService   # 安装/防投毒/启用禁用/隔离/更新 + 门面信任门禁
pnpm --filter editor typecheck
pnpm --filter editor build    # e2e 前必重建
cd apps/editor && pnpm exec playwright test -c e2e/playwright.config.ts smoke.extensions
pnpm check    # lint+typecheck+test（含 docs:check），仅看错误
```

> 改了用户可见行为（命令名、市场交互、信任提示文案）时，同步 `docs/user/zh-CN/customization/extensions.md`（"安装第三方扩展"节）；`pnpm docs:check` 校验内部链接勿留死链。

## 关键参考路径

- `packages/extension-packaging/src/vsix.ts` —— VSIX 读取 + zip-slip 防护
- `packages/extension-gallery/src/{protocol,query,parse}.ts` —— `/extensionquery` 协议 codec + 引擎约束
- `packages/extensions-common/src/{manifest,manifest-schema}.ts` —— manifest 校验（含市场字段）；`semver.ts` —— satisfies / compareVersions
- `apps/editor/src/main/services/extensionManagement/extensionManagementService.ts` —— install 七步 + installFromGallery（防投毒）+ 启用禁用 + 更新 + quarantineMalicious
- `apps/editor/src/main/services/extensionManagement/extensionGalleryService.ts` —— query/download/getControlManifest（网络失败降级空）
- `apps/editor/src/main/services/extensionManagement/installedExtensionsManifest.ts` —— extensions.json（installed + enablement 往返）
- `apps/editor/src/shared/ipc/{extensionManagementService,extensionGalleryService}.ts` —— IPC 契约 + wire DTO
- `apps/editor/src/renderer/services/extensionsWorkbench/ExtensionsWorkbenchService.ts` —— 门面 + 信任门禁
- `apps/editor/src/renderer/workbench/extensions/{ExtensionsView,ExtensionEditor}.tsx` —— 视图 + 详情页
- `apps/editor/src/renderer/services/editor/ExtensionEditorInput.ts` —— 详情页虚拟 EditorInput
- `apps/editor/src/renderer/contributions/ExtensionsViewContribution.ts` —— 视图容器/视图（套路 B）
- `apps/editor/src/renderer/actions/extensionsActions.ts` —— 命令（套路 A）
- `apps/editor/src/main/environment/{configItems,environmentMainService}.ts` —— GALLERY_URL 配置注入
- `packages/extension-host/src/bootstrap.ts` —— 扫描时按 `UNIVERSE_DISABLED_EXTENSIONS` 过滤（启用禁用生效点）
- DI 接线：`apps/editor/src/main/services/main-services.ts`（gallery 先于 management）、`channelNames.ts`、`registerMainServices.ts`、`registerProxyServices.ts`、`window/scopedServicesFactory.ts`
- 计划文档：`docs/plan/extension-marketplace-plan/`（README §5 分阶段 + §6 决策；01 打包 / 02 协议 / 03 管理 / 04 UI / 05 安全）
- 用户文档：`docs/user/zh-CN/customization/extensions.md`（"安装第三方扩展"节）
- VSCode 对照：`src/vs/platform/extensionManagement/`（`IExtensionGalleryService` / `IExtensionManagementService` / `ExtensionsControlManifest`）、VSIX 格式、`extensionQuery`
- 相关：memory [[extension-system-progress]]（运行时：host/RPC/provider/SCM，本 skill 的下游）、[[extension-marketplace-progress]]（本层实施全记录）；skill extend-language-plugin（运行时语言特性）、view-system-context（套路 B 视图）、register-monaco-command（命令）、fix-disposable-leak

## 其它

- 后续用本 skill，发现新经验（新的协议字段、新的信任/隔离策略、新踩的坑），需同步更新本文件。
