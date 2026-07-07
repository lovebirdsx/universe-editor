# 03 · 安装管理服务与用户扩展目录

> 这是本方案的核心。它把"下载好的 VSIX"变成"目录里被扫描器认领的扩展"，并管理其生命周期。
> 对标 VSCode 的 `IExtensionManagementService`。
> 现有代码锚点：用户扩展目录 `<userData>/extensions`（[`extensionHostMainService.ts:103`](../../../apps/editor/src/main/services/extensionHost/extensionHostMainService.ts)），restricted host 已扫描它，`hasUserExtensions()` 已存在（[`extensionHostService.ts:93`](../../../apps/editor/src/shared/ipc/extensionHostService.ts)）。

## 1. 现状：目录已在，但只读

- restricted host 启动时 `env.UNIVERSE_USER_EXTENSIONS_DIR = <userData>/extensions`，bootstrap 扫描它。
- `hasUserExtensions()` 检查该目录是否非空——**唯一现有的"用户扩展"感知点**。
- **缺**：没有任何东西会**往这个目录写**。没有已装清单、没有版本管理、没有启用状态、没有删除机制。

本服务补齐"可写管理"。落盘后的目录形态与内置扩展一致，所以 [`scanExtensions`](../../../packages/extension-host/src/extensionScanner.ts) 零改动即可认领。

## 2. 目录布局（对标 VSCode）

```
<userData>/extensions/
├── extensions.json                        ← 🆕 已装清单（本服务维护）
├── .obsolete                              ← 🆕 待删标记（Windows 占用规避）
├── ms-python.python-2024.1.0/            ← 扩展目录：<publisher>.<name>-<version>
│   ├── package.json
│   └── dist/extension.js
├── redhat.vscode-yaml-1.14.0/
└── .a1b2c3.tmp/                           ← 🆕 解压中的临时目录（原子 rename 前）
```

### 目录命名：`<publisher>.<name>-<version>`

与 VSCode 完全一致。好处：同一扩展多版本可共存（升级时先装新、再标删旧）、`.obsolete` 精确定位。

### `extensions.json`（🆕 已装清单）

```jsonc
{
  "version": 1,
  "installed": [{
    "identifier": { "id": "ms-python.python", "uuid": "..." },
    "version": "2024.1.0",
    "location": "ms-python.python-2024.1.0",   // 相对 extensions/ 的目录名
    "type": "user",                             // "user" | "system"，见 §6
    "installedAt": 1720000000000,
    "source": "gallery",                        // "gallery" | "vsix"
    "galleryMetadata": { "publisherDisplayName": "Microsoft", "installCount": 12345 }
  }],
  "enablement": { "some.ext": false }           // 缺省即启用；见 §5
}
```

> 为什么要清单而非"纯靠扫目录"？① 记录来源/时间/市场元数据（扫描只能得到 manifest）；② 记录启用状态；③ 更新时区分"这版是我装的"；④ 校验目录与清单一致（发现手工塞入的目录）。VSCode 同理维护 `extensions.json`。

### `.obsolete`（🆕 待删标记）

```jsonc
{ "ms-python.python-2023.0.0": true }
```

Windows 上正在运行的扩展文件被进程占用，无法即时删除。VSCode 的解法：**标记为 obsolete，下次启动时（无占用）清理**。直接照搬。

## 3. `IExtensionManagementService`（🆕 main 进程）

契约放 `apps/editor/src/shared/ipc/extensionManagementService.ts`，实现放 `main/services/extensionManagement/extensionManagementService.ts`。对标 `IUpdateService` 的 `createDecorator` + 事件驱动写法。

```ts
export interface IExtensionManagementService {
  readonly _serviceBrand: undefined

  /** 已装集变化（装/删/启停）。renderer 据此刷新 UI + 触发 host 重扫。 */
  readonly onDidChangeExtensions: Event<void>
  /** 单次安装进度（下载百分比 → 解压 → 完成/失败），供 UI 显示。 */
  readonly onInstallProgress: Event<IInstallProgress>

  getInstalled(): Promise<ILocalExtension[]>

  /** 从市场装：内部走 gallery.download → installVSIX。 */
  installFromGallery(extension: IGalleryExtension): Promise<ILocalExtension>
  /** 从本地 .vsix 装（Phase A 的核心；也是 installFromGallery 的下半程）。 */
  installVSIX(vsixPath: string): Promise<ILocalExtension>

  uninstall(extension: ILocalExtension): Promise<void>

  /** 启用/禁用（写 enablement，触发重扫使其生效）。 */
  setEnablement(extension: ILocalExtension, enabled: boolean): Promise<void>

  /** 检查更新：对已装的 gallery 来源扩展，查市场是否有更高版本。 */
  checkForUpdates(): Promise<IExtensionUpdate[]>
  updateExtension(update: IExtensionUpdate): Promise<ILocalExtension>
}
```

通道名：`channelNames.ts` 加 `ExtensionManagement: 'extensionManagement'`。

## 4. 安装流程（`installVSIX` 的确切步骤）

这是最需要严谨的路径。每步都对应一个失败要能干净回滚：

```
installVSIX(vsixPath):
  1. readVsixManifest(vsixPath)                    // extension-packaging，只读 extension/package.json
  2. 校验:
       - zod 过（manifest 合法）
       - satisfies(hostApiVersion, engines.universe)   // 引擎兼容，fail-closed
       - publisher 必填（市场来源）
       - control manifest 未标记 malicious            // 见 05
  3. key = `${publisher}.${name}-${version}`
     targetDir = extensions/<key>
     若已存在同 key 且非 obsolete → 幂等返回（已装）
  4. tmpDir = extensions/.<random>.tmp
     extractVsix(vsixPath, tmpDir)                 // 只解 extension/**；zip-slip 防护
  5. 原子落盘: fs.rename(tmpDir, targetDir)         // 同盘 rename 是原子的
       - 若 targetDir 被 .obsolete 标记占用 → 先清标记
  6. 更新 extensions.json: 追加 installed 条目
  7. fire onDidChangeExtensions
  失败任意步: 删 tmpDir，不动 extensions.json，抛错
```

关键点：

- **临时目录 + 原子 rename**：解压是多文件写，中途崩溃会留半成品。先解到 `.tmp`、成功后一次 `rename`——扫描器永远只看到完整目录。这是 VSCode 的标准手法。
- **随机临时名**：用传入的随机后缀（⚠️ 脚本环境 `Math.random()` 不可用于 workflow，但这是运行时代码，正常用 `crypto.randomUUID()`）。
- **幂等**：重复装同版本直接返回，不报错。

## 5. 卸载与启用/禁用

### 卸载

```
uninstall(ext):
  1. 从 extensions.json 移除 installed 条目
  2. 尝试 fs.rm(dir, {recursive})
       - 成功 → done
       - 失败(EBUSY/EPERM，Windows 占用) → 写入 .obsolete[dir]=true（下次启动清理）
  3. fire onDidChangeExtensions
```

启动时清理：main 服务初始化时读 `.obsolete`，逐个尝试删除、删成功的移出标记。对标 VSCode 的 obsolete 清理。

### 启用/禁用（MVP：全局）

```
setEnablement(ext, enabled):
  写 extensions.json 的 enablement[id]
  fire onDidChangeExtensions   // renderer 触发重扫，禁用的扩展被过滤
```

**过滤在哪做？** 两个选择：

| 方案 | 说明 |
|---|---|
| A. 扫描器过滤（推荐） | 把 enablement 传给 host，`scanExtensions` 跳过禁用项。禁用 = host 里根本不存在该扩展，最干净 |
| B. renderer 翻译时过滤 | host 照常扫，renderer 拿到后跳过禁用项的贡献点翻译。但 host 里扩展仍激活，不彻底 |

建议 A：禁用状态随 `ExtHostStartSpec` 传入（新增可选字段 `disabledIds?: string[]`），bootstrap 扫描后过滤。

> ⚠️ **启用/禁用粒度需你拍板**：MVP 只做全局（VSCode 还有 workspace 级）。建议 MVP 全局，够用；workspace 级后置。

## 6. System vs User 扩展类型 ⚠️ 需你拍板

VSCode 区分：
- **System**：随应用发布的内置扩展，不可卸载，用户看得到但只能禁用。
- **User**：用户自己装的，可卸可更新。

**问题**：我们的内置扩展（git/markdown/typescript/ai/...）现在放 `resources/extensions`（builtin 目录），走 **trusted** host；用户扩展放 `<userData>/extensions`，走 **restricted** host。两者物理隔离、信任层不同。

**这带来一个设计选择**：

| 选项 | 内置扩展在 UI 里 | 代价 |
|---|---|---|
| A. 内置扩展 = System，只读展示不可卸（推荐） | 显示在"已装"列表，标 System 徽标，可禁用不可卸 | 需要 UI 从两个来源（builtin trusted + user restricted）聚合展示 |
| B. 内置扩展不进 UI | UI 只管 user 扩展 | 用户看不到 git/markdown 是"扩展"，与 VSCode 心智不符 |
| C. 内置扩展也可上架市场 | 内置扩展也能被市场版覆盖更新 | 信任层混乱（trusted 的东西被 restricted 覆盖？），复杂度高 |

**建议 A**：内置扩展作为 System 类型只读展示（可禁用），保持它们在 trusted host、不可通过市场覆盖。`getInstalled()` 聚合两个来源，用 `type` 字段区分。这样 UI 符合 VSCode 心智，又不动信任模型。

## 7. 安装后如何"生效"：触发 host 重扫

安装/卸载/启停后，`onDidChangeExtensions` 触发 renderer 侧刷新。**扩展真正加载/卸载靠 restricted host 重启重扫**：

```
renderer: ExtensionsContribution 订阅 onDidChangeExtensions
  → 调 ExtensionHostClientService 重启 restricted host
  → host 重新 scanExtensions(<userData>/extensions)
  → 新扩展被认领 / 卸载的消失 / 禁用的被过滤
  → ExtensionPointTranslator 重新翻译贡献点
```

复用现有机制：`ExtensionHostClientService` 已有 **workspace 切换协调重启**逻辑（summary 记录的 MAX_RESTARTS/RESTART_WINDOW）。安装触发的重启走同一条协调路径——stop 旧 host、start 新 host、重新翻译。`ExtensionsContribution` 已订阅 `onDidChangeContributions` 做重启后重翻译，天然衔接。

**代价**：一次重启 = restricted host 里所有扩展短暂中断（重新激活）。对 MVP 可接受。

**优化（后置）**：VSCode 的 `deltaExtensions` 支持增量加载单个扩展、无需重启全部。这是 Phase D 之后的优化，MVP 不做——**明确记录此取舍**。

## 8. `ILocalExtension` 领域模型

```ts
interface ILocalExtension {
  identifier: { id: string; uuid?: string }
  manifest: IExtensionManifest
  version: string
  location: string              // 绝对路径
  type: 'user' | 'system'
  enabled: boolean
  source: 'gallery' | 'vsix' | 'builtin'
  galleryMetadata?: { publisherDisplayName?: string; installCount?: number; ... }
}
```

renderer 侧 `ExtensionsWorkbenchService` 把它和 `IGalleryExtension` 聚合成 UI 统一视图模型（见 [04 文档](./04-ui-and-ux.md)）。

---

**本文结论**：用户扩展目录已存在且被扫描，本服务补齐"可写管理"——`extensions.json` 清单、`.obsolete` 删除标记、临时目录+原子 rename 安装、启用禁用。生效完全复用现有 host 重启重扫，零改动运行时。需你拍板：**System/User 类型策略（建议内置=System 只读）**、**启用禁用粒度（建议全局）**。
