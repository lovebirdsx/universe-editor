# 插件市场设计方案

> 目标：把当前"以内置扩展为主"的扩展系统，扩展成"外部开发者可发布、用户可从市场搜索安装"的开放生态。
> 参考：VSCode 的 `extensionManagement` 分层、`IExtensionGalleryService` / `IExtensionManagementService` 抽象、VSIX 格式、`/extensionquery` 市场协议。
> 前置阅读：[`docs/plan/maintainability-roadmap/05-extension-system.md`](../maintainability-roadmap/05-extension-system.md)（扩展系统治理现状）。

## 文档结构

| 文档 | 内容 |
|---|---|
| 本文（README） | 结论先行、现状与缺口、总体架构、关键决策、分阶段路线 |
| [01-packaging-and-manifest.md](./01-packaging-and-manifest.md) | 打包格式（兼容 VSIX）、manifest 市场元数据字段扩展 |
| [02-gallery-protocol.md](./02-gallery-protocol.md) | 市场协议客户端契约（兼容 `/extensionquery`）、地址可配置注入 |
| [03-management-service.md](./03-management-service.md) | 安装 / 卸载 / 更新 / 启用禁用服务、用户扩展目录扫描 |
| [04-ui-and-ux.md](./04-ui-and-ux.md) | 扩展视图、详情页、命令、状态与交互 |
| [05-security-and-trust.md](./05-security-and-trust.md) | 安全模型、信任提示、恶意清单、未来硬隔离路线 |
| [07-server-deployment-and-ops.md](./07-server-deployment-and-ops.md) | 市场后端（静态 registry 服务器）实现、发布运维脚本、部署与联调 |

---

## 0. 结论先行

**运行时已经就绪，本次要补的是"分发链路"。**

调研（VSCode 源码 + 本仓库现状）得出一个关键判断：universe-editor **已经有一套能真实加载运行外部扩展的 VSCode 范式运行时**——独立 extension host 子进程、stdio RPC、trusted/restricted 双信任层、`@universe-editor/extension-api`（即 `vscode.d.ts` 等价物）、`engines.universe` 版本协商、懒激活、崩溃有界重启，且 `<userData>/extensions` 这个"外部扩展目录"在代码里**已经存在并被 restricted host 扫描**（`extensionHostMainService.ts:103`、`bootstrap.ts:219`）。

因此，插件市场**不是从零起步**，而是补齐 VSCode 里 `extensionManagement` 那一层——它在我们仓库里目前完全缺失：

```
        已就绪（运行时）                       缺失（分发链路，本次新建）
┌────────────────────────────┐   ┌──────────────────────────────────────┐
│ extension-host 子进程       │   │ 打包格式（兼容 VSIX）                 │
│ stdio RPC / MainThread*     │   │ 市场协议客户端（/extensionquery）      │
│ extension-api (vscode.d.ts) │◄──│ 安装/卸载/更新管理服务                 │
│ 懒激活 / 崩溃重启           │   │ 用户扩展目录的"可写"管理（现在只读扫描）│
│ ExtensionPointTranslator    │   │ 扩展管理 UI（视图 + 详情页）           │
│ 6 个内置扩展                │   │ 市场地址配置注入                       │
└────────────────────────────┘   └──────────────────────────────────────┘
```

一句话：**运行时能"跑"扩展，但用户没有任何途径去"获取、安装、更新、卸载"扩展。本方案填的就是这条路。**

---

## 1. 已确认的关键决策

以下四项已与你确认，作为方案的硬约束：

| 决策项 | 选择 | 含义 |
|---|---|---|
| **市场服务端** | 自建后端 + 兼容 VSCode 协议 | 客户端对齐 `/extensionquery` POST 协议（open-vsx 同款），后端我们自己实现/部署；协议兼容意味着未来也能指向 open-vsx 实例 |
| **打包格式** | 兼容 VSIX（ZIP + `extension/package.json`） | 不发明新格式；可复用 VSIX 生态工具链（`vsce` 等），客户端解压逻辑成熟 |
| **安全隔离** | MVP 维持软隔离 | 沿用现有 restricted host（fs 走网关 + 不给裸能力），Node 权限模型硬隔离后置；靠"发布者信任提示 + 恶意清单"补足社会工程层防护 |
| **本次交付** | 完整设计方案（先不写码） | 本套文档即交付物；你 review 后再进入实施 |

---

## 2. 现状与缺口详析

### 2.1 已就绪的运行时（可直接复用）

| 能力 | 位置 | 复用方式 |
|---|---|---|
| 扩展扫描 | `packages/extension-host/src/extensionScanner.ts` | 已能扫描任意目录的 `<ext>/package.json`；市场装的扩展落到用户目录后**直接被现有扫描器认领**，无需改动扫描核心 |
| restricted host | `extensionHostMainService.ts` + `ExtensionHostClientService.ts` | 外部扩展已走 restricted tier；市场装的扩展天然进这条链路 |
| manifest 校验 | `packages/extension-host/src/manifest.ts`（zod） | 已 `.passthrough()` 容忍未知字段（前向兼容）；市场元数据字段是**加法** |
| 贡献点翻译 | `renderer/services/extensions/ExtensionPointTranslator.ts` | 已支持 commands/menus/submenus/keybindings/configuration/jsonValidation |
| 版本协商 | `packages/extensions-common/src/semver.ts` | `satisfies(hostApiVersion, engines.universe)`，fail-closed |
| 崩溃/重启 | `ExtensionHostClientService.ts:84-118` | 有界重启（3 次/60s）+ workspace 切换协调重启 |
| 配置注入范式 | `apps/editor/src/main/environment/configItems.ts` | `UPDATE_URL` 就是现成模板：cli > env > file，市场地址照抄 |

### 2.2 缺口清单（本次要建）

| 缺口 | VSCode 对应物 | 本方案落点 |
|---|---|---|
| **打包/校验一致性** | VSIX + `getManifest` | 兼容 VSIX 读取；下载后校验 manifest id/version 与市场元数据一致（防投毒） |
| **市场查询客户端** | `IExtensionGalleryService` | 新建 `IExtensionGalleryService`（main 进程），实现 `/extensionquery` 协议 |
| **安装管理** | `IExtensionManagementService` | 新建 `IExtensionManagementService`（main 进程）：下载→校验→解压→原子落盘→触发重扫 |
| **用户扩展目录的可写管理** | `extensionsPath` + `extensions.json` profile | 现在只读扫描；需加"已装清单 + 启用状态 + 待删标记" |
| **启用/禁用** | `EnablementState` | 存 storage，扫描时过滤；MVP 先做全局启用/禁用 |
| **扩展管理 UI** | `extensions/browser/extensionsViewlet` | 新建 Extensions 视图容器 + 详情页 editor input |
| **市场地址配置** | `product.json.extensionsGallery` | 加 `GALLERY_URL` 配置项（cli/env/file） |
| **恶意/弃用清单** | control manifest | 客户端拉一份 control JSON，命中则禁用/告警 |

---

## 3. 总体架构

### 3.1 分层与新增包

沿用仓库既有的 monorepo 分层，**新增下面这些**（标 🆕）：

```
packages/
  extensions-common/         【改】manifest 加市场元数据字段；新增 gallery/management 的 DTO + 通道名
  extension-host/            （基本不动，扫描器可能加"跳过 . 目录"）
  extension-api/             （不动）
  extension-gallery/  🆕     纯逻辑：/extensionquery 请求构造与响应解析（无 IO，可单测）
  extension-packaging/ 🆕    纯逻辑：VSIX(zip) 读取、manifest 抽取、完整性校验（Node fs，可单测）

apps/editor/src/
  main/services/extensionManagement/  🆕
    extensionGalleryService.ts        市场查询/下载（用 IRequestService/net）
    extensionManagementService.ts     安装/卸载/更新/启用禁用；维护 extensions.json
    installedExtensionsManifest.ts     已装清单读写 + .obsolete 标记
  shared/ipc/
    extensionGalleryService.ts   🆕   IExtensionGalleryService 契约 + 通道名
    extensionManagementService.ts 🆕  IExtensionManagementService 契约 + 通道名
  main/environment/configItems.ts     【改】加 GALLERY_URL
  renderer/services/extensionsWorkbench/ 🆕
    ExtensionsWorkbenchService.ts     UI 侧门面：聚合"已装 + 市场"，暴露 observable 给视图
  renderer/workbench/extensions/  🆕
    ExtensionsView.tsx                侧栏视图（搜索 + 列表）
    ExtensionEditor.tsx               详情页（README/贡献点/版本）
    ExtensionEditorInput.ts           虚拟 editor input（对标 AiSettingsEditorInput）
  renderer/actions/extensionsActions.ts 🆕  安装/卸载/启用等命令
  renderer/contributions/
    ExtensionsViewContribution.ts 🆕  注册视图容器 + 视图（对标套路 B）
```

**为什么市场/安装服务放 main 进程？** 因为它们要做网络请求、写文件系统、解压 zip——这些都是 main 的职责（renderer 无同步 fs，且安全上不该让 renderer 直接落盘可执行代码）。renderer 侧只保留一个 `ExtensionsWorkbenchService` 门面，通过 `ProxyChannel` 调 main（对标现有套路 C）。

### 3.2 端到端数据流

**搜索 → 安装 → 生效**的完整链路：

```
用户在 Extensions 视图搜索 "python"
  │
  ▼ renderer: ExtensionsWorkbenchService.search(query)
  │  ProxyChannel → main
  ▼ main: ExtensionGalleryService.query({ text:"python" })
  │  POST {galleryUrl}/extensionquery  (兼容 VSCode 协议)
  ◄  返回 IGalleryExtension[]（名称/版本/下载URL/评分/图标）
  │
用户点 "Install"
  │
  ▼ main: ExtensionManagementService.installFromGallery(gallery)
  │  1. download VSIX → <userData>/CachedExtensionVSIXs/<key>.vsix
  │  2. extension-packaging: 读 extension/package.json
  │  3. 校验: engines.universe satisfies 主机API? id/version 一致? 恶意清单?
  │  4. extract → <userData>/extensions/.<uuid>.tmp → 原子 rename → <publisher>.<name>-<version>/
  │  5. 写 extensions.json（登记已装 + 启用）
  │  6. fire onDidInstallExtension
  │
  ▼ renderer: ExtensionsContribution 收到"扩展集变化"
  │  触发 restricted host 重扫 / 重启（复用现有 workspace-swap 协调重启机制）
  ▼ host 重新 scanExtensions(<userData>/extensions) → 新扩展被认领
  ▼ ExtensionPointTranslator 翻译其 contributes → 命令/菜单即刻可见、可懒激活
  │
扩展生效 ✔（用户执行其命令即触发 onCommand 激活）
```

关键点：**第 6 步之后完全复用现有运行时**——这就是"运行时已就绪"的价值。市场只负责把扩展**正确地放进目录**，剩下的加载/激活/翻译一行都不用改。

---

## 4. 与 VSCode 的对照关系（心智模型）

| VSCode | universe-editor（本方案） | 说明 |
|---|---|---|
| `product.json.extensionsGallery.serviceUrl` | `GALLERY_URL` 配置项（cli/env/file） | 地址注入，不硬编码 |
| `IExtensionGalleryService` | `IExtensionGalleryService`（main） | 市场查询/下载，协议兼容 |
| `IExtensionManagementService` | `IExtensionManagementService`（main） | 安装/卸载/更新 |
| `ExtensionsWorkbenchService` | `ExtensionsWorkbenchService`（renderer） | UI 门面 |
| VSIX = zip + `extension/package.json` | 同左（兼容） | 打包格式 |
| `<userData>/extensions` + `extensions.json` | 同左（新增 extensions.json） | 目录约定 |
| `.obsolete` 标记删除 | 同左 | 规避 Windows 文件占用 |
| control manifest（恶意清单） | 同左 | 安全 |
| `EnablementState` | 全局 enabled/disabled（MVP 简化） | 启用状态 |
| Web Worker host 硬隔离 | **不做**（MVP 软隔离） | 见决策表 |

---

## 5. 分阶段实施路线

按"能尽早跑通一个最小闭环"排序，每个阶段独立可验证：

> **实施状态（截至 2026-07）**：Phase A–D 已全部落地并通过 `pnpm check`；Phase E 按既定决策不做，仅登记为未来路线。实施中确定的次级问题决策见 [§6](#6-实施中已拍板的次级问题决策)。

### Phase A — 本地安装闭环（不依赖市场后端） ✅ 已完成
> 目标：能从一个 `.vsix` 文件手动安装扩展并生效。这把整条"落盘→重扫→生效"链路打通，且不阻塞在后端。

- `extension-packaging` 包：VSIX 读取 + manifest 抽取 + 完整性校验
- `IExtensionManagementService`（main）：`install(vsixPath)` / `uninstall` / `getInstalled`
- 用户扩展目录可写管理：`extensions.json` + `.obsolete` + 原子 rename
- 命令：`扩展: 从 VSIX 安装…`、`扩展: 卸载`
- 安装后触发 restricted host 重扫（复用现有重启机制）
- **验证**：手动打包一个内置扩展成 vsix → 装 → 命令面板出现其命令 → 卸载消失

### Phase B — 市场查询与安装 ✅ 已完成
> 目标：接入自建后端，能搜索并一键安装。

- `extension-gallery` 包：`/extensionquery` 请求构造 + 响应解析
- `IExtensionGalleryService`（main）：`query` / `getExtensions` / `download`
- `GALLERY_URL` 配置注入
- `installFromGallery`：下载→校验一致性→走 Phase A 的安装
- control manifest 拉取（恶意/弃用清单）
- **验证**：配置指向后端（或临时 open-vsx 实例）→ 搜索 → 安装 → 生效

### Phase C — 管理 UI ✅ 已完成
> 目标：图形化的扩展视图与详情页。

- Extensions 视图容器 + 视图（对标套路 B）
- `ExtensionsWorkbenchService`（renderer）门面：聚合已装 + 市场结果
- 详情页 editor（README / 贡献点表 / 版本 / 安装卸载按钮）
- 状态：安装中/已装/可更新 徽标
- **验证**：e2e 冒烟——打开视图、搜索、安装、卸载

### Phase D — 更新与信任 ✅ 已完成
> 目标：生态运维能力。

- 检查更新 / 自动更新（复用 UpdateContribution 的调度思路）
- 发布者信任提示（首次安装某发布者弹确认）
- 启用/禁用（全局粒度）+ 恶意扩展启动时自动隔离
- **验证**：装旧版→有更新徽标→更新到新版

### Phase E（后置）— 硬隔离与签名 ⏸️ 未做（登记未来路线）
> 决策已定：MVP 不做。此处仅登记未来路线，见 [05-security-and-trust.md](./05-security-and-trust.md)。

- Node 权限模型默认开启且可靠
- VSIX 签名验证（PKCS#7，对标 `@vscode/vsce-sign`）

### Phase F — 市场后端部署与运维 ✅ 已完成
> 目标：补齐分发链路的服务端——此前客户端与「后端该实现什么」的契约文档已齐，唯缺后端实现与内容运维。

- 市场后端复用 `scripts/server` 的零依赖静态服务器：`server.mjs` 挂 `/extensionquery`（读 `gallery/registry.json` 过滤/排序/分页）+ `/control.json` + `.vsix` 静态托管，与自动更新**同一进程、同一部署**
- 发布运维脚本 `scripts/gallery/{publish,unpublish,upload}.mjs`（从 `.vsix` 抽元数据生成 registry，assets 先/registry 后同步）
- 文档：`docs/development/marketplace-server.md`（新增「内置静态 registry 服务器自建市场」实操）、`scripts/gallery/README.md`、`scripts/server/README.md`（兼服务市场）
- **验证**：`pnpm test:release`（gallery 逻辑 + server 市场路由）；本地端到端 `publish → server → dev 搜索安装`
- 详见 [07-server-deployment-and-ops.md](./07-server-deployment-and-ops.md)

---

## 6. 实施中已拍板的次级问题（决策）

原方案 §6 列出四个待拍板问题，实施阶段按如下决策落地：

1. **扩展 id 规范**：market 安装强制 `publisher.name`（发布者必填，防投毒校验依赖它）；本地 `.vsix` 仍容忍无 publisher 的扩展（id 退化为 name），照顾内置扩展打包场景。
2. **市场后端形态**：客户端对齐 `/extensionquery`（`3.0-preview.1`），后端形态不锁死；`GALLERY_URL` 默认空 = OSS 语义（未配置则市场搜索为空，仅本地 `.vsix` 可用），可随时指向自建服务或 open-vsx 实例。
3. **内置扩展是否进市场**：内置扩展为 System 类型（随包发布、不可卸），与用户从市场/VSIX 安装的 User 类型区分；市场只管理 User 扩展。
4. **启用/禁用粒度**：MVP 只做**全局**启用/禁用（持久化在 `extensions.json`，restricted host 扫描时按 `UNIVERSE_DISABLED_EXTENSIONS` 过滤），workspace 级后置。

---

## 7. 风险与注意事项

- **API 兼容策略是生态基石**：一旦有外部扩展，`extension-api` 的破坏性变更就会伤害生态。强烈建议**在 Phase A/B 之前或同期**落地 `05-extension-system.md` 里的"API 契约测试 + COMPATIBILITY.md"（那份文档已定为 P1）。市场放大了这个问题的影响面。
- **软隔离的诚实边界**：MVP 阶段外部扩展**拿得到 Node 能力**（restricted host 的权限模型默认关）。这意味着"安装 = 相当程度的信任"。UI 和文档必须**如实告知用户**，不能给"已沙箱"的错觉。详见 05 文档。
- **重扫 vs 热加载**：安装后目前设计是"重启 restricted host 重扫"，简单可靠但有一次扩展功能中断。VSCode 支持 `deltaExtensions` 增量热加载——这是后续优化项，MVP 不做。
- **Windows 文件占用**：解压/删除必须走"临时目录 + 原子 rename""标记删除待重启清理"，否则运行中的扩展文件被占用会失败。这是 VSCode 踩过的坑，直接照搬其解法。
</content>
</invoke>
