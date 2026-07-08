# 07 · 市场后端部署与运维（分发链路的服务端）

> 决策已拍板（本次）：**静态 registry 服务器** + **同一服务器进程复用**（扩展现有 `scripts/server`）+ **服务器实现 + 部署 + 运维文档全套**。
> 前置：客户端协议契约见 [02-gallery-protocol.md](./02-gallery-protocol.md)；面向部署方的后端契约规范已存在于 [`docs/development/marketplace-server.md`](../../development/marketplace-server.md)。

## 0. 结论先行

客户端（`extension-gallery` codec + main 管理服务 + UI，Phase A–D 已全部就绪）和「后端该实现什么」的契约文档都齐了。**唯一空缺是后端服务本身 + 内容运维链路**。本方案不引入任何数据库或第三方框架，而是**复用仓库已成熟的「零依赖静态服务器 + 一键跨平台服务化」范式**（`scripts/server`），把它从「只服务自动更新」升级为「同时服务自动更新 + 扩展市场」。

一句话：更新分发已经有一套零依赖、一键部署、跨平台服务化的服务器；市场后端就是给它**再挂三个市场端点**，并配一套「把 .vsix 发布进市场」的运维脚本。

## 1. 为什么用静态 registry，而非动态服务

客户端只消费三个端点（见 marketplace-server.md）：

| 端点 | 方法 | 客户端何时调 |
|---|---|---|
| `/extensionquery` | POST | 搜索、按 id 精确取、检查更新 |
| `<source>`（vsix / icon / readme 的绝对 URL） | GET | 安装下载、详情页 |
| `/control.json` | GET | 启动时 + 每 ≤6h 拉恶意/弃用清单 |

`/extensionquery` 的响应完全可以由**一份 registry 清单**在内存里做过滤/排序/分页生成——不需要 DB、不需要全文检索引擎。这与本仓库「裸机、一键、零依赖、Windows 也要」的运维哲学一致（对照 `scripts/server/README.md`）。open-vsx 那套 PostgreSQL + Elasticsearch 对当前扩展体量是过度设计。协议兼容仍在，未来体量上来随时可切 open-vsx，客户端一行不改。

## 2. 数据模型：`registry.json` + 静态资产目录

> **更新根与市场根解耦**（实现补记）：市场内容的磁盘位置由独立的 `--gallery-root` 决定，**默认 `<root>/gallery`**（合并部署，如下图），也可指向另一块磁盘/另一套权限（如 `--gallery-root /data/extensions`）。URL 上市场固定挂在 `{base}gallery/` 命名空间，与磁盘位置无关。本地开发尤其依赖这点：更新产物在 `apps/editor/release/`、市场 stage 在别处，`--root` + `--gallery-root` 让一个进程同时服务两者。`upload.mjs` 的 `--dir` 即服务器上的市场根（对齐 `--gallery-root`），环境变量用独立的 `UE_GALLERY_DIR`。

市场内容（默认在更新根的 `gallery/` 子树）在现有更新产物之外：

```
<root>/                          ← 现有：更新分发根（--base /universe-editor/）
  latest.yml  *.exe  *.blockmap  ← 更新产物（不动）
  index.html  release-notes.json ← 下载页（不动）
  gallery/                       ← 🆕 市场内容（= 默认 --gallery-root；可拆到独立目录）
    registry.json                ← 所有扩展的清单（服务器据此生成 /extensionquery 响应）
    control.json                 ← 恶意/弃用清单（可手写，也可留空 {"malicious":[],"deprecated":{}}）
    assets/
      <publisher>.<name>/
        <version>/
          package.vsix           ← VSIX 本体
          icon.png               ← 可选
          README.md              ← 可选
          CHANGELOG.md           ← 可选
```

`registry.json` 形态（**运维唯一需要维护的元数据**，其余字段由发布脚本从 VSIX 内的 `package.json` 自动抽取）：

```jsonc
{
  "extensions": [
    {
      "publisher": "universe",
      "name": "universe-pdf",
      "displayName": "PDF Viewer",
      "shortDescription": "在编辑器里预览 PDF",
      "categories": ["Other"],
      "publisherDisplayName": "Universe",
      "versions": [
        {
          "version": "0.1.0",
          "lastUpdated": "2026-07-08T00:00:00Z",
          "engine": "^0.1.0",           // 写进 properties[] 的 Universe.Editor.Engine
          "assetDir": "assets/universe.universe-pdf/0.1.0",
          "files": { "vsix": "package.vsix", "icon": "icon.png", "readme": "README.md" },
          "installCount": 0             // 可选统计，运维可手动/脚本累加
        }
      ]
    }
  ]
}
```

> 设计原则：`registry.json` 只存「市场元数据」，VSIX 是唯一真相源。发布脚本读 VSIX 内 `extension/package.json` 抽 `publisher/name/version/displayName/description/categories/engines.universe`，回填进 registry——**避免手写元数据与包内声明不一致**（否则客户端防投毒校验会拒装，见 marketplace-server.md「防投毒」节）。

## 3. 服务端改动：`server.mjs` 挂市场路由

在现有 `scripts/server/server.mjs`（零依赖、只有 node 内置模块）里，`handle()` 于「静态文件回退」之前插入市场路由分支。**保持零依赖**：registry 过滤/排序/分页用纯 JS 实现。

### 3.1 `POST {base_or_root}/extensionquery`

- 读 `<root>/gallery/registry.json`（带 mtime 缓存，改动自动重载，无需重启）。
- 解析请求 body 的 `filters[0].criteria`：
  - `filterType 8`（Target）：忽略值或校验属于 `Universe.Editor` / `Microsoft.VisualStudio.Code`（两者都认，兼容 vsce 工具链，对齐 marketplace-server.md「两个约定」）。
  - `filterType 10`（SearchText）：对 `displayName + name + shortDescription` 子串匹配。
  - `filterType 7`（ExtensionName，可多个）：按 `publisher.name` 精确取（安装 / 检查更新路径）。
  - `filterType 5`（Category）：分类过滤。
- `sortBy`：0 相关度（默认原序）/ 4 安装量 / 6 评分 / 10 更新时间；`sortOrder` 升降序。
- `pageNumber/pageSize` 分页。
- 按 `flags`（`IncludeLatestVersionOnly` 等）决定每个扩展返回全部版本还是仅首个（最新版放数组首位）。
- 组装成 `IRawGalleryQueryResult`：每个 version 的 `files[]` 用 `AssetType` 常量名（`Microsoft.VisualStudio.Services.VSIXPackage` / `...Icons.Default` / `...Content.Details` / `...Content.Changelog`），`source` 拼成**绝对 URL**（`{请求 origin}/{base}gallery/<assetDir>/<file>`）；`properties[]` 写 `Universe.Editor.Engine`；`statistics[]` 写 install/rating；`resultMetadata` 写 `ResultCount → TotalCount`。
- 空 registry / 读失败 → 返回 `{"results":[{"extensions":[],"resultMetadata":[...0]}]}`（**永不 500**，与客户端「网络失败降级空」对称）。

### 3.2 `GET .../control.json`

直接静态返回 `<root>/gallery/control.json`；缺失时返回 `{"malicious":[],"deprecated":{}}`。禁缓存（沿用现有 `cacheHeaders` 对 `.json` 的处理）。

### 3.3 VSIX / icon / README 下载

**无需新代码**——它们就是 `gallery/assets/**` 下的静态文件，现有静态文件服务 + Range + 路径穿越防护直接覆盖。`.vsix` 加进 `MIME` 表（`application/octet-stream`，走 `max-age` 缓存，因为按 `<version>` 目录不可变）。

### 3.4 路由前缀决策

市场端点挂在 `--base` 之下（与更新产物同前缀），即 `{base}extensionquery`、`{base}control.json`、`{base}gallery/assets/**`。客户端 `GALLERY_URL` 因此配成 `http://<host>/universe-editor`（与 `publish.url` 同前缀，运维只记一个地址）。`server.mjs` 现有逻辑已把 `!pathname.startsWith(config.base)` 判 404，市场分支落在 base 命中之后即可。

> 端点相对性验证：客户端把 `GALLERY_URL` 末尾 `/` 去掉后拼 `/extensionquery`、`/control.json`（见 marketplace-server.md），故 `GALLERY_URL = http://host/universe-editor` → POST `http://host/universe-editor/extensionquery`，正好落在 `base=/universe-editor/` 内。✓

## 4. 运维脚本：把 .vsix 发布进市场

新增 `scripts/gallery/`（与 `scripts/server`、`scripts/release` 平级），全部零依赖 node（adm-zip 从 `packages/extension-packaging` 解析，复用 pdf 扩展 `pack.mjs` 的范式）：

| 脚本 | 作用 |
|---|---|
| `publish.mjs` | 核心。输入一个或多个 `.vsix`：解压读 `extension/package.json` → 校验 `publisher` 必填、`engines.universe` 存在 → 抽 icon/README → 落地到 `<stageDir>/gallery/assets/<pub>.<name>/<version>/` → upsert 进 `registry.json`（同 version 覆盖，新 version 插到 `versions[]` 首位并按 semver 校验递增）。**本地生成/更新 stage 目录**，不碰服务器。 |
| `unpublish.mjs` | 从 registry 移除某扩展或某版本（删条目 + 删 assets 目录）。 |
| `upload.mjs`（复用/扩展 `scripts/release/upload.mjs`） | 把 `<stageDir>/gallery/**` scp 到服务器发布目录。**顺序红线**：先传 `assets/**`（VSIX 落地），最后覆盖 `registry.json`（清单最后覆盖，与 latest.yml 排最后同理，避免客户端读到「清单说有、包还没到」的半态）。 |

`registry.json` 的 upsert 复用 `packages/extension-packaging`（读 VSIX）+ `packages/extensions-common/semver.ts`（`compareVersions` 校验版本递增）——**运维脚本与客户端共用同一份纯逻辑**，杜绝两侧解析口径漂移。

发布流（对照 `scripts/server/README.md §三`）：

```bash
# 1) 打包扩展成 vsix（各扩展自带，如 extensions-external/pdf/scripts/pack.mjs）
# 2) 发布进本地 stage 的 registry
node scripts/gallery/publish.mjs --stage <stageDir> path/to/universe.universe-pdf-0.1.0.vsix
# 3) 上传 gallery 子树到服务器（assets 先、registry.json 后）
node scripts/gallery/upload.mjs --host <IP> --user deploy --dir /srv/universe-editor
```

## 5. 部署与服务化：复用现有一键范式

**不新增服务化脚本**——`setup.mjs`/`setup.sh`/`setup.ps1` 部署的 `server.mjs` 一旦挂上市场路由，就**同一进程同时服务更新与市场**。运维方视角零变化：

- Ubuntu：`sudo bash setup.sh`（systemd `universe-update-server`）。
- Windows：`./setup.ps1`（计划任务 `UniverseUpdateServer`）。
- 改了 `server.mjs` 后热替换：拷文件 + 重启进程（README §六已有完整流程，市场路由随之生效）。

唯一新增的运维动作是「把 gallery 子树同步上去」（§4 的 upload），与更新产物上传是并列的两条内容流，共用一台服务器、一个端口、一个 base。

## 6. 客户端侧配置（无需改码，仅文档）

`GALLERY_URL` 已就绪（cli `--gallery-url` / env `UNIVERSE_GALLERY_URL` / file `<userData>/update-config.json` 的 `galleryUrl`）。部署方把它指向 `http://<host>/universe-editor`（与更新同前缀同机）。默认空 = 无市场（OSS 语义）保持不变。

## 7. 交付清单（本次）

**代码**
- `scripts/server/server.mjs`：`handle()` 挂 §3 的市场路由（extensionquery / control.json / vsix MIME），保持零依赖。
- `scripts/gallery/publish.mjs`、`unpublish.mjs`、`upload.mjs`：§4 运维脚本。
- 根 `package.json` 加脚本：`gallery:publish` / `gallery:unpublish` / `gallery:upload`（对齐现有 `server:serve` / `release:upload` 命名）。
- `scripts/gallery/__tests__/*.test.mjs`（node:test，对齐 `scripts/server/__tests__`）：query 过滤/排序/分页、registry upsert 版本递增、control.json 兜底。
- `scripts/server/__tests__/server.test.mjs`：补市场路由用例（POST extensionquery 命中 registry、空 registry 降级、vsix Range 下载、control.json 兜底）。

**文档**
- 扩写 `docs/development/marketplace-server.md`：从「协议规范」升级为「协议规范 + **自建部署运维实操**」——新增「用内置静态 registry 服务器自建市场」「registry.json 格式」「发布/下架 vsix 流程」「本地端到端联调」「运维/排错」诸节。
- 扩写 `scripts/server/README.md`：现有服务器现在**兼服务市场**，新增市场子树说明与 gallery 上传步骤。
- 新增 `scripts/gallery/README.md`：发布运维手册。
- 回填 `docs/plan/extension-marketplace-plan/README.md`：登记「Phase F — 市场后端部署与运维」为已交付，指向本文。
- 若涉及用户可见文案，检查 `docs/user/zh-CN/customization/extensions.md` 是否需同步（预计不涉及，端到端行为不变）。

## 8. 本地端到端联调（不需要真服务器）

```bash
# 1) 造一个 stage 目录并发布 pdf 扩展进去
node scripts/gallery/publish.mjs --stage /tmp/ue-market extensions-external/pdf/universe.universe-pdf-0.1.0.vsix
# 2) 起服务器指向该 stage（base=/ 便于本地）
node scripts/server/server.mjs --root /tmp/ue-market --port 8788 --base /
# 3) 起编辑器 dev，指向本地市场
UNIVERSE_GALLERY_URL=http://localhost:8788 pnpm dev
# → 扩展视图搜索 pdf → 安装 → 生效 → 卸载
```

（可加一个 `pnpm gallery:serve` 便捷脚本，类比 `server:serve`。）

## 9. 验证

```bash
pnpm test:release        # scripts 下 node:test（含新增 gallery + server 市场路由用例）
pnpm docs:check          # 文档内部链接无死链（本文接入 CI）
# 手动：curl -X POST http://localhost:8788/extensionquery -d '{"filters":[{"criteria":[{"filterType":10,"value":"pdf"}],"pageNumber":1,"pageSize":50,"sortBy":0,"sortOrder":0}],"flags":787}'
# 手动：curl -i http://localhost:8788/control.json
# 手动端到端：§8
```

## 10. 非目标（本次不做，登记未来）

- 发布 API / 鉴权 / 网页发布门户（当前发布靠运维脚本 + scp，够用）。
- 全文检索 / 评分评论系统（registry 内存过滤够当前体量）。
- VSIX 签名验证（PKCS#7）——属 Phase E 硬隔离，既定不做。
- 切 open-vsx（协议已兼容，需要时改 `GALLERY_URL` 即可，无客户端改动）。
