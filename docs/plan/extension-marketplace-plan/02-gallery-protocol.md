# 02 · 市场协议客户端与地址配置

> 决策：**自建后端 + 兼容 VSCode 协议**。客户端对齐 `/extensionquery` POST（open-vsx 同款），后端我们自建/部署。
> 参考现有实现：网络下载 + 缓存范式见 [`remoteSchemaMainService.ts`](../../../apps/editor/src/main/services/remoteSchema/remoteSchemaMainService.ts)；配置注入范式见 [`configItems.ts`](../../../apps/editor/src/main/environment/configItems.ts) 的 `UPDATE_URL`。

## 1. 为什么协议兼容能成立

VSCode 的市场地址**不是硬编码**，而是从 `product.json` 注入：

```jsonc
// product.json
"extensionsGallery": {
  "serviceUrl": "https://marketplace.visualstudio.com/_apis/public/gallery",
  "itemUrl": "...",
  "resourceUrlTemplate": "..."
}
```

OSS 构建的 `product.json` 里**没有这个字段** → 没有市场 → 这正是 VSCodium 指向 open-vsx 的原理。open-vsx 是一套完整的、协议兼容的开源市场实现（Eclipse 基金会）。

**结论**：只要我们的客户端实现同一套 `/extensionquery` 协议，就能：① 指向自建后端；② 未来无缝指向 open-vsx 实例做备份/迁移；③ 用 open-vsx 现成后端快速验证客户端（Phase B 验证手段）。

## 2. `/extensionquery` 协议（客户端要实现的部分）

### 请求

```
POST {galleryUrl}/extensionquery
Accept: application/json;api-version=3.0-preview.1
Content-Type: application/json
```

Body（`IRawGalleryQuery`）：

```jsonc
{
  "filters": [{
    "criteria": [
      { "filterType": 8,  "value": "Microsoft.VisualStudio.Code" }, // Target：固定标识
      { "filterType": 10, "value": "python" },                       // SearchText：搜索词
      { "filterType": 7,  "value": "ms-python.python" }              // ExtensionName：精确取某扩展
    ],
    "pageNumber": 1,
    "pageSize": 50,
    "sortBy": 0,      // 0=Relevance 4=InstallCount 6=Rating 10=Updated
    "sortOrder": 0
  }],
  "flags": 914        // 位标志：要哪些附加数据（版本/文件/属性/统计）
}
```

关键 `filterType` 枚举（与 VSCode 一致，客户端需要的子集）：

| 值 | 名称 | 用途 |
|---|---|---|
| 7 | ExtensionName | 按 `publisher.name` 精确查（安装指定扩展用） |
| 8 | Target | 目标产品标识（固定值） |
| 10 | SearchText | 关键词搜索 |
| 12 | ExcludeWithFlags | 排除（如未发布版本） |

关键 `flags`（按需 OR）：`IncludeVersions(0x1)`、`IncludeFiles(0x2)`、`IncludeVersionProperties(0x10)`、`IncludeStatistics(0x100)`、`IncludeLatestVersionOnly(0x200)`。

> **兼容性提醒**：`filterType: 8` 的 `value` 在 VSCode 是 `"Microsoft.VisualStudio.Code"`。自建后端时，可以（a）也认这个字符串以最大化兼容工具链，或（b）定义自己的 target 标识（如 `"Universe.Editor"`）。**建议后端两者都认**，客户端固定发我们自己的标识——这样既兼容又清晰。这是需你和后端一起定的小契约。

### 响应

```jsonc
{
  "results": [{
    "extensions": [{
      "extensionId": "uuid",
      "extensionName": "python",
      "displayName": "Python",
      "shortDescription": "...",
      "publisher": { "publisherName": "ms-python", "displayName": "Microsoft" },
      "versions": [{
        "version": "2024.1.0",
        "assetUri": "...", "fallbackAssetUri": "...",
        "files": [
          { "assetType": "Microsoft.VisualStudio.Services.VSIXPackage", "source": "https://.../download.vsix" },
          { "assetType": "Microsoft.VisualStudio.Services.Icons.Default", "source": "..." },
          { "assetType": "Microsoft.VisualStudio.Services.Content.Details", "source": "...README" }
        ],
        "properties": [
          { "key": "Microsoft.VisualStudio.Code.Engine", "value": "^1.80.0" },
          { "key": "Microsoft.VisualStudio.Code.ExtensionDependencies", "value": "" }
        ]
      }],
      "statistics": [{ "statisticName": "install", "value": 12345 }]
    }],
    "resultMetadata": [{ "metadataType": "ResultCount", "metadataItems": [{ "name": "TotalCount", "count": 999 }] }]
  }]
}
```

客户端要做的：从 `files[]` 里按 `assetType` 找到 VSIX 下载地址、图标、README；从 `properties[]` 里读引擎版本要求；从 `statistics[]` 读安装量/评分。

> 引擎属性 key 在 VSCode 是 `Microsoft.VisualStudio.Code.Engine`，值形如 `^1.80.0`。自建后端应放我们的 `engines.universe` 值。同样建议后端复用这个 key 名以兼容，或定义 `Universe.Editor.Engine`——由后端契约决定，客户端按约定解析。

## 3. `extension-gallery` 包（🆕 纯逻辑，可单测）

把"协议编解码"这块无 IO 的逻辑独立成包，便于单测，也让 main 服务保持薄：

```
buildQuery(options): IRawGalleryQuery          // 组装 filters/flags
parseQueryResult(raw): IGalleryExtension[]     // 解析响应 → 领域模型
pickVsixAsset(version): string | undefined     // 从 files[] 取 VSIXPackage
pickAsset(version, type): string | undefined   // 取图标/README/etc
readEngineConstraint(version): string | undefined  // 从 properties[] 取引擎约束
```

领域模型 `IGalleryExtension`（客户端内部表示，屏蔽协议细节）：

```
{ identifier: { id: "publisher.name" }, uuid, displayName, publisher,
  version, description, iconUrl?, readmeUrl?, vsixUrl,
  engineConstraint?, installCount?, rating?, categories?, ... }
```

**为什么独立成包**：协议解析是最容易出 bug 又最好测的部分（各种缺字段/多版本/资产缺失），单测覆盖它，主服务只管网络与编排。对标 VSCode 把 `extensionGalleryService` 里纯函数部分抽出来的思路。

## 4. `IExtensionGalleryService`（🆕 main 进程服务）

契约放 `apps/editor/src/shared/ipc/extensionGalleryService.ts`，实现放 `main/services/extensionManagement/extensionGalleryService.ts`。对标 `IUpdateService` 的写法（`createDecorator` + `_serviceBrand`）。

```ts
export interface IExtensionGalleryService {
  readonly _serviceBrand: undefined
  /** 市场是否已配置（GALLERY_URL 有值）。无值时 UI 隐藏市场、只显示已装。 */
  isEnabled(): Promise<boolean>
  /** 搜索。分页、排序、分类过滤。 */
  query(options: IQueryOptions): Promise<IGalleryQueryResult>
  /** 按 id 精确取（安装指定扩展 / 检查更新用）。 */
  getExtensions(ids: IExtensionIdentifier[]): Promise<IGalleryExtension[]>
  /** 下载 VSIX 到临时缓存目录，返回本地路径。带 ETag/校验。 */
  download(extension: IGalleryExtension): Promise<string>
  /** 取 README/CHANGELOG 文本（详情页用）。 */
  getReadme(extension: IGalleryExtension): Promise<string>
}
```

实现要点（复用现有范式）：

- **网络**：`fetch`（已在 `remoteSchemaMainService` 用，Electron 环境可用）或 electron `net`。POST + `Accept: ...;api-version=3.0-preview.1`。
- **下载缓存**：VSIX 下到 `<userData>/CachedExtensionVSIXs/<publisher>.<name>-<version>.vsix`，对标 VSCode。下完立即校验完整性（见 01 文档 §5）。
- **图标/README 缓存**：可复用 `remoteSchemaMainService` 的 ETag + TTL + stale-fallback 缓存模式（那套已经很成熟）。
- **离线降级**：市场不可达时，`query` 返回空 + 错误态，UI 显示"市场不可用"，但**已装扩展照常工作**（市场只影响"获取"，不影响"运行"）。
- **通道名**：`channelNames.ts` 的 `ServiceChannels` 加 `ExtensionGallery: 'extensionGallery'`。

## 5. 市场地址配置注入（🆕 GALLERY_URL）

完全照抄 `UPDATE_URL` 的模式（cli > env > file）。在 `configItems.ts` 加：

```ts
/** Extension marketplace gallery URL. cli > env > file. Empty ⇒ marketplace disabled. */
export const GALLERY_URL: ConfigItem<'string'> = {
  id: 'galleryUrl',
  type: 'string',
  cli: 'gallery-url',
  env: 'UNIVERSE_GALLERY_URL',
  filePath: 'galleryUrl',
  args: '<url>',
  description: '覆盖扩展市场地址',
  validate: isHttpUrl,
}
```

并加入 `CLI_OPTIONS` 数组（`--help` 可见）。

**语义**：

- **有值** → `IExtensionGalleryService.isEnabled()` 为 true，UI 显示市场搜索。
- **无值** → 市场关闭，Extensions 视图只显示"已装 + 从 VSIX 安装"（Phase A 能力）。这与 VSCode OSS 无 `extensionsGallery` 字段时行为一致。

**默认值策略** ⚠️ 需你拍板：打包版是否内置一个默认市场地址（指向我们自建后端）？

| 选项 | 说明 |
|---|---|
| A. 打包版内置默认地址（推荐） | 开箱即用；用户可用 `--gallery-url` 覆盖。类比 `UPDATE_URL` 打包版有默认 feed |
| B. 始终留空，需用户/部署方配置 | 更保守；但普通用户装不了扩展，体验差 |

建议 A，且默认地址通过**打包时注入**（类似 product.json 机制），而非硬编码进源码——保持 OSS 构建无市场的能力。

## 6. control manifest（恶意/弃用清单）

VSCode 会定期拉一份 control JSON，标记恶意/弃用/需迁移的扩展。MVP 简化版：

```jsonc
// {galleryUrl}/control.json 或独立 URL
{
  "malicious": ["evil.ext"],                    // 命中则拒装 + 已装则禁用告警
  "deprecated": { "old.ext": { "reason": "...", "migrateTo": "new.ext" } }
}
```

由 `IExtensionGalleryService` 拉取并缓存，`IExtensionManagementService` 在安装前查询。详见 [05 安全文档](./05-security-and-trust.md)。

---

**本文结论**：协议兼容让我们"客户端一次实现、后端可换"（自建 / open-vsx 皆可）；纯协议逻辑抽 `extension-gallery` 包单测；地址走 `GALLERY_URL` 配置注入（照抄 `UPDATE_URL`），空值即无市场（兼容 OSS 语义）。需你拍板：**target/engine 的 key 名后端契约**、**打包版是否内置默认市场地址**。
