# 配置扩展市场服务器

这一页写给想**自建扩展市场**的部署方或后端开发者：编辑器客户端如何连到市场服务器、服务器需要实现哪几个接口、以及怎样快速验证。若你只是想安装扩展，看[内置扩展](../user/zh-CN/customization/extensions.md#安装第三方扩展)即可，无需读这一页。

## 目录

- [工作原理](#工作原理)
- [把客户端指向你的服务器](#把客户端指向你的服务器)
  - [三种配置方式](#三种配置方式)
  - [关于配置文件的一个坑](#关于配置文件的一个坑)
- [服务器要实现的接口](#服务器要实现的接口)
  - [1. 搜索：POST /extensionquery](#1-搜索post-extensionquery)
  - [2. VSIX 下载与 README](#2-vsix-下载与-readme)
  - [3. 恶意/弃用清单：GET /control.json](#3-恶意弃用清单get-controljson)
- [两个必须与后端对齐的约定](#两个必须与后端对齐的约定)
- [防投毒：客户端会做的一致性校验](#防投毒客户端会做的一致性校验)
- [用 open-vsx 快速验证](#用-open-vsx-快速验证)
- [排错清单](#排错清单)
- [相关阅读](#相关阅读)

## 工作原理

编辑器的市场客户端对齐 **VSCode / open-vsx 的 `/extensionquery` 协议**（`3.0-preview.1`）。这意味着服务器只要实现这套协议，客户端就能搜索、下载、安装扩展——协议兼容也让你日后可以无缝切到 [open-vsx](https://open-vsx.org) 实例。

一次「搜索 → 安装」的数据流：

```
客户端在扩展视图搜索关键词
  │  POST {GALLERY_URL}/extensionquery      ← 你的服务器返回匹配的扩展 + 每个版本的 VSIX 下载地址
  ▼
用户点「安装」
  │  GET  <VSIX 下载地址>                    ← 客户端下载 .vsix（地址来自上一步响应里的 files[]）
  │  下载后校验 publisher.name.version 与市场元数据一致（防投毒）
  ▼
解压落盘到 <userData>/extensions/ → 扩展生效
```

启动时客户端还会拉一次 `GET {GALLERY_URL}/control.json`（恶意/弃用清单）。

> **市场地址为空 = 关闭市场**。不配置 `GALLERY_URL` 时市场搜索恒为空，用户只能从本地 `.vsix` 安装（这是 OSS 语义，与 VSCode OSS 构建无 `extensionsGallery` 字段时一致）。已装扩展不受影响，照常运行。

## 把客户端指向你的服务器

### 三种配置方式

市场地址由 `GALLERY_URL` 配置项决定，优先级 **命令行 > 环境变量 > 配置文件**：

| 方式 | 写法 | 适用场景 |
| --- | --- | --- |
| 命令行参数 | `--gallery-url=https://market.example.com` | 临时试跑、覆盖默认 |
| 环境变量 | `UNIVERSE_GALLERY_URL=https://market.example.com` | 部署/CI 环境统一注入 |
| 配置文件 | 见下 | 面向最终用户的持久化部署 |

地址必须是合法的 `http(s)://` URL（客户端会校验）。客户端会自动去掉末尾多余的 `/`，因此填 `https://market.example.com` 或 `https://market.example.com/` 均可。所有端点都相对这个地址拼接（`{地址}/extensionquery`、`{地址}/control.json`）。

### 关于配置文件的一个坑

配置文件方式读取的是 **`<userData>/update-config.json`**（与自动更新地址 `updateUrl` **共用同一个文件**，不是单独的市场配置文件）：

```jsonc
// <userData>/update-config.json
{
  "galleryUrl": "https://market.example.com",
  "updateUrl": "https://update.example.com"   // 可选，与市场无关
}
```

`<userData>` 是编辑器的用户数据目录（可用 `--user-data-dir` 或 `UNIVERSE_USER_DATA_DIR` 覆盖）。文件缺失或格式错误会被静默忽略，此时回退到环境变量 / 命令行。

## 服务器要实现的接口

三个端点，全部相对 `GALLERY_URL`。

### 1. 搜索：POST /extensionquery

**请求**。客户端发送：

```
POST {GALLERY_URL}/extensionquery
Accept: application/json;api-version=3.0-preview.1
Content-Type: application/json
```

请求体（`filterType` / `flags` 均为数值位标志）：

```jsonc
{
  "filters": [{
    "criteria": [
      { "filterType": 8,  "value": "Universe.Editor" },  // Target：目标产品标识（客户端固定发这个）
      { "filterType": 10, "value": "python" },            // SearchText：搜索关键词（可选）
      { "filterType": 7,  "value": "acme.demo" },         // ExtensionName：精确取某扩展（安装/查更新用，可多个）
      { "filterType": 5,  "value": "AI" }                 // Category：分类过滤（可选）
    ],
    "pageNumber": 1,
    "pageSize": 50,
    "sortBy": 0,      // 0=相关度 4=安装量 6=评分 10=更新时间
    "sortOrder": 0    // 0=默认 1=升序 2=降序
  }],
  "flags": 787        // 客户端请求「版本+文件+版本属性+统计+仅最新版」的位或
}
```

`filterType` 取值：

| 值 | 名称 | 含义 |
| --- | --- | --- |
| 7 | ExtensionName | 按 `publisher.name` 精确查（安装指定扩展、检查更新时用；一次可带多个） |
| 8 | Target | 目标产品标识，客户端固定发 `Universe.Editor`（见[下文约定](#两个必须与后端对齐的约定)） |
| 10 | SearchText | 关键词搜索 |
| 5 | Category | 按分类过滤 |

**响应**。至少返回下面这些字段，客户端会从中解析出可安装条目：

```jsonc
{
  "results": [{
    "extensions": [{
      "extensionId": "uuid-可选",
      "extensionName": "demo",
      "displayName": "Demo",
      "shortDescription": "一句话描述",
      "publisher": { "publisherName": "acme", "displayName": "ACME Inc" },
      "versions": [{
        "version": "1.2.3",
        "lastUpdated": "2026-01-01T00:00:00Z",
        "files": [
          { "assetType": "Microsoft.VisualStudio.Services.VSIXPackage", "source": "https://cdn.example.com/acme.demo-1.2.3.vsix" },
          { "assetType": "Microsoft.VisualStudio.Services.Icons.Default",  "source": "https://cdn.example.com/acme.demo/icon.png" },
          { "assetType": "Microsoft.VisualStudio.Services.Content.Details", "source": "https://cdn.example.com/acme.demo/README.md" }
        ],
        "properties": [
          { "key": "Universe.Editor.Engine", "value": "^0.1.0" }
        ]
      }],
      "statistics": [
        { "statisticName": "install", "value": 12345 },
        { "statisticName": "averagerating", "value": 4.5 },
        { "statisticName": "ratingcount", "value": 200 }
      ],
      "categories": ["AI"]
    }],
    "resultMetadata": [
      { "metadataType": "ResultCount", "metadataItems": [{ "name": "TotalCount", "count": 999 }] }
    ]
  }]
}
```

解析规则（了解这些能避免「装不上/不显示」）：

- **`files[]` 里必须有 `assetType` 为 `Microsoft.VisualStudio.Services.VSIXPackage` 的条目**，其 `source` 就是 VSIX 下载地址。**没有它的版本会被客户端直接丢弃**（视为不可安装，不出现在列表里）。
- 图标取 `...Services.Icons.Default`，README 取 `...Services.Content.Details`，变更日志取 `...Services.Content.Changelog`（均可选）。
- 引擎约束从 `properties[]` 里读，key 见[下文约定](#两个必须与后端对齐的约定)。
- `statistics[]` 里 `install` / `averagerating` / `ratingcount` 用于展示安装量与评分（可选）。
- 分页总数取 `resultMetadata` 的 `ResultCount → TotalCount`；缺失时客户端回退成本页条目数。
- 客户端只读每个扩展 `versions[]` 的**第一个**版本作为「最新版」，因此请把最新版放在数组首位（或按请求只返回最新版）。

`source` 可以是任意可下载的绝对 URL（同源或指向 CDN 均可），客户端下载时会跟随重定向。

### 2. VSIX 下载与 README

这两者没有专门的端点——客户端直接 `GET` 上一步响应里给出的 `source` 地址：

- **VSIX**：下载到本地缓存 `<userData>/CachedExtensionVSIXs/<publisher>.<name>-<version>.vsix`，命中缓存则复用。必须返回真实的 `.vsix`（ZIP，内含 `extension/package.json`）。
- **README**：详情页展示用，返回 Markdown 文本即可；取不到时详情页 README 为空，不影响安装。

### 3. 恶意/弃用清单：GET /control.json

客户端启动时（及最长每 6 小时）拉一次，用于拦截恶意扩展、提示弃用迁移：

```jsonc
// GET {GALLERY_URL}/control.json
{
  "malicious": ["evil.ext"],                                       // publisher.name 列表：拒装 + 已装则启动时自动禁用告警
  "deprecated": {
    "old.ext": { "reason": "不再维护", "migrateTo": "new.ext" }    // 弃用提示（可选）
  }
}
```

字段都可选，最小可返回 `{ "malicious": [], "deprecated": {} }`。取不到（404 / 网络失败）时客户端按空清单处理，不阻断安装。

## 两个必须与后端对齐的约定

这两点是客户端硬编码的解析行为，服务器数据要与之匹配：

1. **Target 标识**：客户端在 `filterType: 8` 里固定发 **`Universe.Editor`**。后端做过滤时应认这个值；若你想同时兼容 VSCode 工具链（如用 `vsce` 发布），建议后端**同时认** `Universe.Editor` 和 `Microsoft.VisualStudio.Code`。
2. **引擎约束 key**：客户端读版本 `properties[]` 时，依次认 **`Universe.Editor.Engine`** 和 **`Microsoft.VisualStudio.Code.Engine`** 两个 key，值形如 `^0.1.0`。填任一个都能被识别；对应扩展 `package.json` 里的 `engines.universe`。

## 防投毒：客户端会做的一致性校验

从市场安装时，客户端下载 VSIX 后会**校验包内 `extension/package.json` 的 `publisher`、`name`、`version` 与市场响应里的元数据完全一致**，不一致会拒绝安装（报 `does not match the marketplace entry`）。因此：

- 市场装的扩展 **`publisher` 必填**（`identifier` 为 `publisher.name`），且必须与 VSIX 内声明一致。
- 服务器返回的 `version` 必须与该 `source` 指向的 VSIX 实际版本一致。
- 换言之，市场元数据不能「挂羊头卖狗肉」——这是防止「元数据说是 A、下载下来是 B」的投毒。

（本地 `.vsix` 手动安装不走市场，容忍无 publisher 的扩展，不受此约束。）

## 用 open-vsx 快速验证

不想马上写后端时，可直接把客户端指向一个 open-vsx 实例来验证整条链路（协议兼容）：

```bash
# 官方公共实例
--gallery-url=https://open-vsx.org/vscode/gallery

# 或自建 open-vsx 实例
```

若走 open-vsx，Target 请让后端兼容 `Microsoft.VisualStudio.Code`、引擎 key 用 `Microsoft.VisualStudio.Code.Engine`——这也是上面「建议后端两者都认」的原因。

## 排错清单

| 现象 | 排查方向 |
| --- | --- |
| 扩展视图市场栏始终为空 | 确认 `GALLERY_URL` 已配置且合法（`http(s)://`）；查看 `extensionGallery` 日志是否有 `query failed`——市场不可达时客户端**降级为空、不报错** |
| 能搜到但某条目不出现 | 该版本 `files[]` 缺 VSIX 资产（`...VSIXPackage`），被判为不可安装丢弃 |
| 点安装报 `does not match the marketplace entry` | VSIX 内 `publisher.name.version` 与市场元数据不一致（见[防投毒](#防投毒客户端会做的一致性校验)） |
| 引擎版本不兼容装不上 | `properties[]` 的引擎 key 值与扩展实际 `engines.universe` 不符，或 key 名不在客户端认的两个之内 |
| 配置文件写了却不生效 | 确认写的是 `<userData>/update-config.json` 且字段名为 `galleryUrl`；命令行 / 环境变量会覆盖它 |

日志：市场相关操作记录在名为 **Extension Gallery** 的日志通道（`extensionGallery`），网络失败会以 `warn` 记录，可据此定位服务器端问题。
