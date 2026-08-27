# 配置扩展市场服务器

这一页写给想**自建扩展市场**的部署方或后端开发者：编辑器客户端如何连到市场服务器、服务器需要实现哪几个接口、以及怎样快速验证。若你只是想安装扩展，看[内置扩展](../user/zh-CN/customization/extensions.md#安装第三方扩展)即可，无需读这一页。

## 目录

- [工作原理](#工作原理)
- [最快路径：用内置静态 registry 服务器自建市场](#最快路径用内置静态-registry-服务器自建市场)
  - [registry.json 格式](#registryjson-格式)
  - [发布与下架](#发布与下架)
  - [本地端到端联调](#本地端到端联调)
- [自助发布 API：uex publish 直达](#自助发布-apiuex-publish-直达)
  - [自助注册（审批制）](#自助注册审批制)
  - [审批管理：admin API 与管理页](#审批管理admin-api-与管理页)
  - [token 签发与吊销](#token-签发与吊销)
  - [服务端发布流水线](#服务端发布流水线)
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

## 最快路径：用内置静态 registry 服务器自建市场

**不想自己写后端？本仓库自带一套零依赖静态市场服务器**，与[自建更新服务器](../../scripts/server/README.md)是**同一个进程**——它在服务自动更新之外，同时按一份 `registry.json` 生成 `/extensionquery` 响应、静态托管 `.vsix`。你只需维护清单、发布 `.vsix`，无需数据库、无需实现协议。下面「服务器要实现的接口」几节是给想**从零写后端**（或对接 open-vsx）的人看的参考规范；用内置服务器可跳过。

**一次部署，既服务更新又服务市场**：按 [`scripts/server/README.md`](../../scripts/server/README.md) 把服务器搭起来（`setup.sh` / `setup.ps1`，systemd / 计划任务；或在开发机直接 `pnpm server:setup -- --env prod` 远程首装，不必登服务器），它就已经带市场路由。

**更新根与市场根解耦**。URL 上市场固定挂在 `{base}gallery/` 命名空间下，但它在磁盘的位置由 `--gallery-root` 决定，**默认 `<root>/gallery`**——这样两种部署都自然：

```
① 合并部署（默认，零配置）: --root /srv/universe-editor
   /srv/universe-editor/
     latest.yml  *.exe  ...       更新产物
     gallery/                     市场内容（= 默认 --gallery-root）
       registry.json  control.json  assets/<publisher>.<name>/<version>/*.vsix

② 独立部署: --root /srv/universe-editor  --gallery-root /data/extensions
   /srv/universe-editor/          只有更新产物
   /data/extensions/              市场内容（可另一块磁盘/另一套权限/另一节奏上传）
     registry.json  control.json  assets/...
```

两种部署下客户端看到的 URL 完全一致（`{base}gallery/...`）。**本地开发**尤其需要解耦：更新产物在 `apps/editor/release/`，市场 stage 在别处，一条命令同时服务两者：

```bash
node scripts/server/server.mjs --root apps/editor/release --gallery-root market-stage/gallery --base /
# 便捷脚本：pnpm server:serve（更新+市场）或 pnpm gallery:serve（纯市场）
```

客户端 `GALLERY_URL` 与更新地址同前缀同机：若 server 的 `--base` 是 `/universe-editor/`，则配 `GALLERY_URL=http://<host>/universe-editor`。

### registry.json 格式

服务器唯一读取的市场元数据。**推荐用 [`scripts/gallery`](../../scripts/gallery/README.md) 的 `publish.mjs` 从 `.vsix` 自动生成**（它从包内 `package.json` 抽 `publisher/name/version/displayName/description/categories/engines.universe`，避免手写与包内声明不一致而触发防投毒拒装）；`engines.universe` 的 range 语法 fail-closed——`||` 与连字符范围（`1.2.3 - 2.0.0`）直接拒发，只允许 `>=X.Y.Z <A.B.C`、`^X.Y.Z`、`~X.Y.Z`、精确版本、`*`。格式：

```jsonc
{
  "extensions": [
    {
      "publisher": "universe",
      "name": "universe-pdf",
      "displayName": "PDF Viewer",
      "shortDescription": "在编辑器里预览 PDF",
      "categories": ["Other"],
      "versions": [
        {
          "version": "0.1.0",
          "lastUpdated": "2026-07-08T00:00:00Z",
          "engine": "^0.1.0",                          // 写进 properties[] 的 Universe.Editor.Engine
          "assetDir": "assets/universe.universe-pdf/0.1.0",
          "files": { "vsix": "universe.universe-pdf-0.1.0.vsix", "icon": "icon.png", "readme": "README.md" },
          "installCount": 0,                           // 可选统计
          "sha256": "<64-hex>",                        // publish.mjs 写入：VSIX 字节哈希
          "signature": { "algorithm": "ed25519", "keyId": "market-v1", "value": "<base64>" }
        }
      ]
    }
  ]
}
```

服务器把每个 version 的 `files` 拼成**绝对下载 URL**（`{请求来源}{base}gallery/{assetDir}/{file}`）注入协议响应的 `files[]`。`versions[]` 首位视为最新版（`publish.mjs` 按 semver 降序维护）。改动 `registry.json` / `control.json` 后**无需重启**服务器——它按文件 mtime 自动重载。

`sha256` / `signature` 是**市场签名**（`publish.mjs --signing-key-file` 写入，签名为对暂存 VSIX 字节的 Ed25519 签名）：服务器把它们透传进协议响应 `properties[]`（`Universe.Editor.VsixHash` / `Universe.Editor.VsixSignature` / `Universe.Editor.SignatureKeyId`），客户端下载后验签，**未签名或验签失败一律拒装**（fail-closed）。密钥与轮换见 [`scripts/gallery/README.md`](../../scripts/gallery/README.md#市场签名发布必配)。**自己从零写后端时**：要么如实透出这三个 property（签名由你的发布管线生成），要么接受客户端拒装——没有第三条路。

### 发布与下架

三条写入通道，写同一份 registry（格式由 `scripts/gallery/lib.mjs` 单点保证）：

1. **自助发布 API（推荐，第三方/CI）**：开发者持 token 直接 `uex publish` 直达，无需运维经手——见下节[自助发布 API](#自助发布-apiuex-publish-直达)。
2. **本地 stage + scp 上传（运维通道）**：登第一批内置扩展、灾备（server 挂了仍可静态重建 registry）、以及"第三方交 vsix 由运维代传"的受控兜底。
3. **`pnpm ext:release`**：本仓库 `extensions-external/*` 从源码一键发布（build + 打包 + 发布 + 上传，支持增量），本质是通道 2 的封装，见[发布扩展](publishing-extensions.md)。

> ⚠️ **通道 1 与通道 2/3 不要并发使用**：scp 整文件覆盖与 publish API 同时写 registry 理论上会互相撕。约定：启用 API 后 scp 通道仅灾备用。

运维通道用法：

```bash
pnpm ext:release                    # 发布所有有改动的外部扩展并上传
pnpm ext:release -- --no-upload     # 只写本地 stage
```

若你手上已有现成的 `.vsix`（第三方产物），或想单独操作 stage/下架，用 [`scripts/gallery`](../../scripts/gallery/README.md) 的脚本（零依赖）：

```bash
# 打包扩展成 .vsix 后，发布进本地 stage（签名私钥没有就先 pnpm gallery:keygen -- --out market-key.pem）
pnpm gallery:publish -- --stage ./market-stage --signing-key-file ./market-key.pem path/to/universe.universe-pdf-0.1.0.vsix
# 同步到服务器的市场根（--dir = server 的 --gallery-root；先 assets、后 registry.json，避免半态）
#   合并部署： --dir /srv/universe-editor/gallery
#   独立部署： --dir /data/extensions
pnpm gallery:upload -- --stage ./market-stage --host <IP> --user deploy --dir /srv/universe-editor/gallery
# 下架
pnpm gallery:unpublish -- --stage ./market-stage universe.universe-pdf@0.1.0
```

注意运维通道的 `publish.mjs` **允许同版本覆盖**（带告警，用于受控修复）；自助 API 则强制版本不可变（409），这是供应链安全地基——两条通道的严格度刻意不同。

### 本地端到端联调

```bash
pnpm gallery:keygen -- --out ./market-key.pem --key-id market-test   # 本地测试密钥对
pnpm gallery:publish -- --stage ./market-stage --signing-key-file ./market-key.pem --key-id market-test \
  extensions-external/pdf/universe.universe-pdf-0.1.0.vsix
# --gallery-root 指向 stage 的 gallery，与更新根解耦（本地更新根随意，这里也用 stage）
node scripts/server/server.mjs --root ./market-stage --gallery-root ./market-stage/gallery --port 8788 --base /
UNIVERSE_GALLERY_URL=http://localhost:8788 \
UNIVERSE_GALLERY_SIGNING_KEYS='{"market-test":"<keygen 打印的 x>"}' pnpm dev   # 扩展视图搜索 → 安装 → 生效
# 便捷等价：pnpm gallery:serve
```

## 自助发布 API：uex publish 直达

内置服务器在静态市场之外还提供一套 **Bearer token 认证的自助发布 API**，让仓库外的开发者不依赖运维 scp 即可上架（对标 `vsce publish`）。前三个端点与 [`uex` CLI](../../packages/uex/README.md) 的 `login/publish/unpublish` 一一对应，外加一个**无认证**的自助注册端点：

| 端点 | 方法 / 认证 | 行为 |
| --- | --- | --- |
| `{base}gallery/api/publish` | POST；`Authorization: Bearer <token>` | body 为 **VSIX 二进制流**（`application/octet-stream`）。成功 `201` 返回 `{ "id", "version" }` |
| `{base}gallery/api/unpublish` | POST；Bearer | body JSON `{ "id": "<publisher>.<name>", "version": "1.2.3" \| null }`（`null` = 整扩展下架）。只能下架 token 归属 publisher 名下的条目 |
| `{base}gallery/api/whoami` | GET；Bearer | `200 { "publisher": "acme", "status": "active" }`——`uex login` 用它验证 token 有效性；`status` 为审批状态（`pending` 也返回 200，作者靠 `uex whoami` 查审批进度） |
| `{base}gallery/api/register` | POST；**无认证**（IP 节流） | body JSON `{ "publisher", "email?", "label?" }`。成功 `201` 返回 `{ "publisher", "token", "label", "status": "pending" }`——**token 明文只在这次响应里出现** |

状态码约定：认证失败一律 `401`（不区分 token 不存在/已吊销/**已拒绝**，不给探测面）；manifest publisher 与 token 归属不符 `403`；**publisher 待审批（pending）时 publish/unpublish 返回 `403`（消息含 `pending approval`，作者能看懂在等审批）**；**同版本已存在 `409`（版本不可变——改内容必须 bump version，这是供应链安全地基，无例外）**；包体超限 `413`（默认 128MB，`--max-vsix-size` 字节数可配）；**未配置签名私钥时 publish `503`**。注册端点的失败码：`400`（publisher 名非法——须匹配 `^[a-z0-9][a-z0-9-]*$`、≤64 字符、非保留名，或 email 非法）、`409 publisher name is taken`（一律不区分原因，不给占名探测面）、`429`（IP 节流，见下节）。

> **`uex --registry` 的地址是服务器 base、不带 `gallery`**：例如 server 以 `--base /universe-editor/` 部署在 `https://market.example.com`，则 `uex login acme --registry https://market.example.com/universe-editor`。uex 会自行拼 `gallery/api/...` 后缀；编辑器侧 `GALLERY_URL` 同理（两者指向同一个 base）。

开发者侧全流程（`uex` 的安装与更多命令见其 [README](../../packages/uex/README.md)）：

```bash
uex login acme --registry <服务器 base>      # 贴运维签发的 token；whoami 验证后存 ~/.uex/config.json
uex publish                                  # 打包 + 上传；CI 里用 UNIVERSE_MARKET_TOKEN 传 token
uex unpublish acme.demo@1.0.0                # 下架某个版本
```

### 自助注册（审批制）

开发者无需运维经手即可拿到 token：浏览器打开 **`GET {base}gallery/register`**（内嵌中文一次性表单，零外部资源），填 publisher 名提交，页面调上面的 register API 并展示 token 与按本站地址预拼好的 `uex login` 命令。**token 只显示这一次**，丢失只能吊销重签。

**2026-08-11 起注册为审批制**：网页注册创建的 publisher 落 `status: 'pending'`（写入 `publishers.json`），token 照常签发——作者可以立即 `uex login`、`uex whoami` 查状态，但 **publish/unpublish 一律 403（消息含 `pending approval`）**，直到管理员在管理页批准（见下节）。审批通过（`active`）后无需任何客户端改动即可发布；被拒绝（`rejected`）后其 token 一律 401，与无效 token 不可区分（不给探测面）。`status` 字段缺失的历史记录一律按 `active` 处理（向后兼容）；运维通道 `token.mjs issue` 签发的 publisher 直接 `active`。

- `publisher` 规则：小写字母/数字/连字符、不能以连字符开头、≤64 字符、非保留名；首次注册即隐式创建该 publisher。
- `email` 可选：仅落库（`publishers.json` 条目的可选字段）备公开阶段联系用，不公开展示。
- `label` 可选：标记 token 用途/设备，默认 `web-register`。

节流由 **`--register-rate-limit` / `UE_SERVER_REGISTER_RATE_LIMIT`** 控制（每 IP 每小时，默认 `10`，`0` = 关闭）。实现是**内存级滑动窗口**（进程重启即清零），且取 socket 对端 IP——反代部署下同源 IP 共享额度是其固有局限；`x-forwarded-for` 解析与持久限流属公开阶段清单。

> ⚠️ register 与运维 ssh 直改 `publishers.json`（`token.mjs`）是同文件两条 read-modify-write 写通道，存在与既有 scp upload 通道对 registry **同级的写竞态**——避免同时操作。

### 审批管理：admin API 与管理页

管理端点挂在同一进程（`galleryPublish.mjs` 内），认证用**独立的管理令牌**（与 publish token 不同一套凭证）：经 **`--admin-token-file` / `UE_SERVER_ADMIN_TOKEN_FILE`** 配置文件路径，内容为令牌明文（trim 后单行）。启动期即读取：flag 给了但文件不可读/为空**拒绝启动**；不配置则启动横幅打 warning（admin console disabled），管理页与管理 API 一律 **`503`（fail-closed，同签名密钥语义）**。请求侧校验为 Bearer 与配置值各自 sha256 后 `timingSafeEqual`，失败一律 `401`。

| 端点 | 方法 / 认证 | 行为 |
| --- | --- | --- |
| `{base}gallery/admin` | GET；无认证（页面） | 审批管理页（内嵌中文 HTML，零外部资源）：令牌输入（sessionStorage 暂存）→ 待审批/已启用/已拒绝三分区 → 批准/拒绝/删除行内操作。未配置管理令牌时页面本身 503 |
| `{base}gallery/api/admin/publishers` | GET；管理令牌 | publisher 列表 `200 { "publishers": [ { "name", "email", "status", "created", "tokenCount", "extensions": [...] } ] }`（`extensions` 从 registry.json 汇总） |
| `{base}gallery/api/admin/publishers/approve` | POST；管理令牌 | body `{ "name" }`：`pending → active`；非 pending `409`，不存在 `404` |
| `{base}gallery/api/admin/publishers/reject` | POST；管理令牌 | body `{ "name" }`：`pending → rejected`；非 pending `409`，不存在 `404` |
| `{base}gallery/api/admin/publishers/remove` | POST；管理令牌 | body `{ "name" }`：删除记录（释放名字，可重新注册）。仅允许 **pending/rejected 且名下无扩展**；否则 `409` |

所有管理写操作与 publish 共用进程内串行写队列、写后显式失效 mtime 缓存，并走 logLine 审计日志。管理页只覆盖**审批**这一件事——publisher 自视角报表/运营视角完整管理台属公开阶段（计划 06）。

### token 签发与吊销

认证数据存 **`--auth-dir`（默认 `<root>/../auth`）下的 `publishers.json`**，只存 token 的 sha256 哈希与 label/时间戳，外加 publisher 级字段：`email`（可选）、`status`（`pending`/`active`/`rejected`，缺省按 `active` 兼容历史记录）、`created`（ISO 时间戳）。🔴 **红线：`--auth-dir` 绝不允许落在任何静态服务目录（`--root` / `--gallery-root`）之内**——`gallery/**` 整个是公开静态命名空间，落进去等于把哈希表公开下载；server 启动时自检，命中直接拒绝启动。

签发/吊销用 [`scripts/gallery/token.mjs`](../../scripts/gallery/README.md)（直接读写服务器上的 `publishers.json`：ssh 上去跑，或对本地副本跑完随既有 scp 通道上传；server 按 mtime 自动重载，**无需重启**）：

```bash
# 签发：明文只打印一次（此后不可再查，泄露只能吊销重签）；publisher 首次出现即隐式创建
pnpm gallery:token -- issue --publisher acme --label zhangsan-laptop --auth-dir /srv/auth
# 吊销（label 定点，立即生效）与盘点（只列 label/时间，不列哈希）
pnpm gallery:token -- revoke --publisher acme --label zhangsan-laptop --auth-dir /srv/auth
pnpm gallery:token -- list --auth-dir /srv/auth
```

> ⚠️ **HTTPS 是 token 安全的前提**：token 以 Bearer 明文过线。公网/跨办公网部署必须置于 TLS 反代之后（server 自身不做 TLS，反代是标准解）；纯内网 HTTP 部署请自知风险等级。

### 服务端发布流水线

发布侧是[客户端防投毒校验](#防投毒客户端会做的一致性校验)的对称另一半：**registry 元数据只从服务端亲自解开的 VSIX 里抽取，客户端上传时声称什么一概不信**。一次 publish 的处理顺序：

1. Bearer token → sha256 → `publishers.json` 查归属（revoked 拒）；**审批门控**：pending 一律 `403 pending approval`，rejected 一律 `401`（与无效 token 不可区分）；
2. 请求体**流式落盘**临时文件，边写边计体积（超限中断 `413`，不整包进内存）；
3. 亲自读包内 `extension/package.json` 并过 **zod 校验**（与宿主同一份 schema）；
4. manifest `publisher` 必须等于 token 归属，否则 `403`；
5. registry 已有 `<id>@<version>` → `409`；
6. 抽 icon/README/CHANGELOG 落 `assets/<id>/<version>/`（zip entry 名一律 basename 化后落地，zip-slip 免疫；staging 目录写完原子 rename）；
7. 原子更新 `registry.json`（先 assets 后 registry 的既有约定；写后显式失效进程内缓存，紧随其后的搜索立即可见）；
8. 审计日志记录 publish/unpublish（who/id/version）——日志即内部阶段的审计面。

**发布签名在服务端自动完成**（落资产时对暂存的 VSIX 跑 `signVsix` 写 `sha256` + `signature`，产物与运维通道 `publish.mjs` 一致），扩展作者无感。配置：

- **`--signing-key-file` / `UE_SERVER_SIGNING_KEY_FILE`**：Ed25519 私钥（pkcs8 PEM，用 `pnpm gallery:keygen` 生成）。启动期即解析校验，文件缺失或不可解析直接拒绝启动。
- **`--signing-key-id` / `UE_SERVER_SIGNING_KEY_ID`**：默认 `market-v1`，必须与编辑器内置公钥的 keyId 一致（见 `packages/extension-packaging` 的 signature 模块）。

**未配置签名私钥时 server 照常启动**（启动横幅打 warning），静态托管 / 更新分发 / whoami / register / unpublish 均不受影响，但 publish 一律 `503`——编辑器验签 fail-closed，无签名的包上架也必然拒装，因此在入口处直接拒绝。

发布实现依赖解 zip 与 zod，因此部署形态是 **esbuild 打包的单文件产物**（`scripts/server/dist/server.js`，仓库内 `pnpm server:bundle` 生成），而非直接跑源码 `server.mjs`——部署流程仍是"一个文件 + node"，见 [`scripts/server/README.md`](../../scripts/server/README.md)。

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

### 构建期注入：打出开箱可用的包

上面的几种方式都是**运行时**覆盖打包默认值。内网部署方若希望**打出来的客户端开箱可用**（首次启动即连上市场与更新，不用给每个用户再下发 `update-config.json`），在构建前把真实地址写进仓库根的 `.env`（`.env*` 已 gitignore，不会误提交）：

```bash
# 仓库根 .env（或 .env.prod，按 --env <mode> 分层选择）
UE_GALLERY_URL=http://<host>/universe-editor       # 写入打包版 product.json 的 galleryUrl
UE_UPDATE_FEED_URL=http://<host>/universe-editor/  # 写入 electron-builder.yml 的 publish.url
```

打包脚本（`pnpm --filter @universe-editor/editor package:win*` / `package:linux:dir`）在打包前 `loadEnv()` 并注入这两个变量：

- **`UE_GALLERY_URL`**：`scripts/release/runtime-resources.mjs` 在 stage `product.json` 时按 env 覆盖 `galleryUrl`（未配置则保留仓库里的占位值原样）。
- **`UE_UPDATE_FEED_URL`**：`scripts/release/package.mjs` 注入 `process.env`，electron-builder 展开 `electron-builder.yml` 里的 `${env.UE_UPDATE_FEED_URL}`（未配置则回填占位值兜底）。

**仓库里永远只保留占位值**（`gallery.example.com` 等 RFC 保留段），真实内网地址只存在于 gitignored 的 `.env`，不进仓库。没配 env 时构建**不会失败**，只是产出指向占位地址的包。变量清单与占位值见仓库根 [`.env.example`](../../.env.example)。

## 服务器要实现的接口

> 下面几节是给**从零写后端**或对接 open-vsx 的人看的协议参考。用[内置静态 registry 服务器](#最快路径用内置静态-registry-服务器自建市场)的话这些已经实现好了，可跳到[两个约定](#两个必须与后端对齐的约定)与[防投毒](#防投毒客户端会做的一致性校验)了解客户端行为即可。

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
- 客户端按 `versions[]` 从新到旧**选第一个兼容当前编辑器版本的版本**（对照每个版本的 `engines.universe` 区间做 satisfies；全不兼容则该扩展不可安装、按钮禁用）。因此仍请把最新版放在数组首位（或按请求只返回最新版）。

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
2. **引擎约束 key**：客户端读版本 `properties[]` 时，依次认 **`Universe.Editor.Engine`** 和 **`Microsoft.VisualStudio.Code.Engine`** 两个 key，值形如 `>=0.13.0 <1.0.0`。填任一个都能被识别；对应扩展 `package.json` 里的 `engines.universe`（0.13.0 起声明的是**编辑器版本**兼容区间，客户端用运行时编辑器版本做 satisfies 选版）。

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
| 引擎版本不兼容装不上 | 客户端按 `versions[]` 从新到旧选第一个 `engines.universe` 兼容当前编辑器的版本，全不兼容则安装报错/按钮禁用；也可能 `properties[]` 缺引擎 key 或 key 名不在客户端认的两个之内 |
| 配置文件写了却不生效 | 确认写的是 `<userData>/update-config.json` 且字段名为 `galleryUrl`；命令行 / 环境变量会覆盖它 |

日志：市场相关操作记录在名为 **Extension Gallery** 的日志通道（`extensionGallery`），网络失败会以 `warn` 记录，可据此定位服务器端问题。
