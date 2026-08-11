# 04 — 自助发布通路：市场后端的 publisher/token 模型与 publish API

> ✅ 已完成（2026-08-01）。`scripts/server/server.mjs` 挂 `gallery/api/{publish,unpublish,whoami}`（流水线在 `galleryPublish.mjs`）；`scripts/gallery/token.mjs` 签发/吊销；esbuild 单文件产物 `scripts/server/dist/server.js`（`pnpm server:bundle`，`setup.mjs` 部署该产物）；测试含 uex CLI 真联调（`scripts/server/__tests__/uex-publish.integration.test.mjs`）。运维与协议文档见 `docs/development/marketplace-server.md`「自助发布 API」节。
>
> Phase D。目标：拿到 token 的第三方开发者 `uex publish` 直达市场，运维不再人肉 scp。
> 现状：`scripts/server/server.mjs`（626 行零依赖静态服务器）已挂 `/extensionquery`（POST，先于静态判定）+ `gallery/**` 静态托管；registry 由维护者本地跑 `scripts/gallery/publish.mjs` 生成后 `upload.mjs` scp 上去。
> 决策背景（README 决策 1+2）：自助 token 发布，但**两步走**——内部阶段双通道拿 token（运维签发 + 网页注册页），token 自服务页/邮箱验证/验证码是公开阶段的事（[06](./06-public-phase-roadmap.md)）。
> 修订（2026-08-10）：新增自助注册端点（`GET gallery/register` 一次性表单页 + `POST gallery/api/register`，§2）与服务端发布时签名（publish 流水线落资产阶段 signVsix，§3）。
> 修订（2026-08-11）：**注册审批制**——网页注册落 `status: 'pending'`，publish/unpublish 一律 403 直至管理员批准；配套最小审批页 `GET gallery/admin` + `gallery/api/admin/*`（独立管理令牌 `--admin-token-file`）；whoami 透出 `status`；运维通道 `token.mjs issue` 直接 `active`（§1/§2）。

## 1. publisher / token 模型

```
<server 数据目录，绝不在 galleryRoot 下>/auth/publishers.json
{
  "publishers": [
    {
      "name": "acme",                          // 即 vsix manifest 的 publisher 字段
      "email": "ops@acme.example",             // 可选，仅落库备用（注册页收集；内部阶段不做验证）
      "status": "pending",                     // 2026-08-11 修订：pending/active/rejected；缺省按 active（兼容历史记录）
      "created": "2026-08-11T00:00:00Z",       // publisher 首次创建时间
      "tokens": [
        { "hash": "<sha256 hex>",              // 只存哈希；明文仅签发时打印一次
          "label": "zhang-san-laptop",         // 便于人肉对账与定点吊销
          "created": "2026-08-01T00:00:00Z",
          "revoked": null }
      ]
    }
  ]
}
```

- **token 格式**：`uet_<24 bytes crypto random, base64url>`（前缀便于密钥扫描工具识别；不在 token 里编码 publisher——归属查表即可，编进去只会诱导"看起来能自解释"的错误信任）。
- **一个 publisher 多 token**（每人/每 CI 一枚，按 label 定点吊销）；token 泄露的爆炸半径 = 该 publisher 名下所有扩展，所以**吊销能力与签发能力同批交付**，不进 Phase F。
- **🔴 安全红线：认证数据的存放位置**。`gallery/**` 整个是静态托管命名空间（任何人可 GET），`publishers.json` 必须放 galleryRoot **之外**的独立目录（新 `--auth-dir` 配置，默认 `<root>/../auth`），并在 server 启动时自检：若 auth-dir 被解析进任何静态根之内，直接拒绝启动。

## 2. API 设计

挂进现有 `handleGallery` 的路由分支（沿用"POST 端点先于静态/方法判定"的既有结构）：

| 端点 | 方法/认证 | 行为 |
|---|---|---|
| `{base}gallery/register` | GET；无认证 | 无登录态一次性注册表单页（静态 HTML）：填 publisher（+可选 email/label）→ 调下方 register API → 页面一次性显示 token，关页即不可再查 |
| `{base}gallery/api/register` | POST；无认证 | body = `{ "publisher": "acme", "email"?: "...", "label"?: "..." }`。注册即创建 publisher 并签发首枚 token，201 返回 `{ "publisher", "token", "label", "status": "pending" }`；非法名/email 400；重名 409；IP 节流 429（内存级每 IP 每小时，默认 10，`--register-rate-limit` 可配）。保留 publisher 名单（universe/universe-editor/official/admin 等）一律 409 |
| `{base}gallery/api/publish` | POST；`Authorization: Bearer <token>` | body = **vsix 二进制流**（`application/octet-stream`；不用 multipart——零依赖服务器手写 multipart 解析是自找的攻击面）。走 §3 流水线，成功 201 返回 `{ id, version }` |
| `{base}gallery/api/unpublish` | POST；Bearer | body = `{ "id": "<publisher>.<name>", "version": "1.2.3" \| null }`（null=整个扩展下架）。只能动 token 归属 publisher 名下的条目 |
| `{base}gallery/api/whoami` | GET；Bearer | 200 `{ "publisher": "acme", "status": "active" }`——`uex login` 用它验证 token 有效性；`status` 透出审批状态，pending 也放行 200（作者靠 `uex whoami` 查进度），rejected 一律 401 |
| `{base}gallery/admin` | GET；无认证（页面） | 最小审批页（内嵌中文 HTML，2026-08-11 修订）：待审批/已启用/已拒绝三分区，行内批准/拒绝/删除。未配置管理令牌时 503 |
| `{base}gallery/api/admin/publishers` | GET；管理令牌 | publisher 列表（name/email/status/created/tokenCount/extensions） |
| `{base}gallery/api/admin/publishers/approve` · `/reject` · `/remove` | POST；管理令牌 | body `{ "name" }`：approve/reject 仅 pending（非 pending 409、未知 404）；remove 仅 pending/rejected 且名下无扩展（否则 409），删除即释放名字 |

- **审批门控（2026-08-11 修订）**：网页注册的 publisher 落 `pending`，publish/unpublish 一律 403（消息含 `pending approval`），管理页批准后转 `active` 放行；被拒绝转 `rejected` 后其 token 一律 401，与无效 token 不可区分。管理令牌经 `--admin-token-file` / `UE_SERVER_ADMIN_TOKEN_FILE` 配置（与 publish token 独立的一套凭证），未配置则管理页与管理 API 一律 503（fail-closed）；校验为 Bearer 与配置值各自 sha256 后 timingSafeEqual，失败一律 401。管理写操作与 publish 共用进程内串行写队列、写后显式失效 mtime 缓存、走 logLine 审计。
- 认证失败一律 401（不区分"token 不存在/已吊销/已拒绝"，不给探测面）；publisher 不匹配 403；版本已存在 409；包体超限 413（默认 128MB，`--max-vsix-size` 可配）。
- **限流本阶段只做 register**（无认证端点必须有兜底：IP 节流 + 保留名单 + 审计日志）；publish/unpublish 的限流仍不做（token 门槛已在），登记 Phase F；但 413 体积限制与请求体读取的**流式落盘**（不整包进内存）必须本阶段做——这是稳定性而非安全议题。

## 3. 服务端 publish 流水线（防投毒的对称另一半）

客户端安装侧已有"下载包与市场元数据一致性校验"；发布侧的对称保证是：**registry 元数据只从服务端亲自解开的 VSIX 里抽取，客户端上传时声称什么一概不信**。流水线：

```
① 认证        Bearer → sha256 → publishers.json 查归属（revoked 拒）；
              审批门控：pending 一律 403，rejected 一律 401（与无效 token 不可区分）
② 收包        流式写 <tmp>/upload-<uuid>.vsix，边写边计体积（超限中断 413）
③ 亲自读包    readVsixManifest（extension-packaging）：zip 解析 + extension/package.json
              + manifest zod 校验（extensions-common，与宿主同一份 schema）
④ 归属校验    manifest.publisher === token 归属，否则 403
⑤ 版本不可变  registry 已有 <id>@<version> → 409（改内容必须 bump version，杜绝
              "同版本换包"——这是供应链安全的地基，无例外，运维也不例外）
⑥ 落资产      抽 icon/README/CHANGELOG（zip-slip 防护复用 extension-packaging 的规范化检查）
              → <galleryRoot>/assets/<id>/<version>/ 临时目录写完原子 rename
⑥b 签名       服务端 Ed25519 私钥调 lib.mjs 的 signVsix，versionEntry 写入 sha256+signature
⑦ upsert      registry.json 更新（复用 scripts/gallery/lib.mjs 的抽取/合并逻辑）
              ——先 assets 后 registry 的既有原子约定；写后失效 readJsonCached 缓存
⑧ 审计        logLine 记 publish/unpublish/register（who/id/version/来源 IP），日志即内部阶段的审计面
```

**签名配置（2026-08-10 修订）**：`--signing-key-file` / `UE_SERVER_SIGNING_KEY_FILE` 指定服务端 Ed25519 私钥，`--signing-key-id` 指定 keyId（默认 `market-v1`）。签名在落资产阶段完成，versionEntry 带 sha256+signature，编辑器 fail-closed 验签得以满足、客户端零改动。**未配密钥时 publish 返回 503**（注册/whoami/unpublish 不受影响）——宁可发布通道整体不可用，也不放出未签名的版本条目。

`unpublish`：registry 条目移除 + 资产目录删除（MVP 直删；"保留窗口期防正在下载的用户 404"登记为增强——内部阶段流量可忽略）。

## 4. 部署形态：从"零依赖单文件"到"零依赖单产物"

publish 端点需要解 zip（adm-zip，经 extension-packaging）——直接打破 server.mjs "拷一个文件就能跑"的部署不变式。**方案：esbuild 把 server + extension-packaging + adm-zip + gallery/lib.mjs bundle 成单文件产物 `dist/server.js`**，setup 脚本分发产物而非源文件；部署体验不变（仍是一个文件 + node），开发体验不变（源码照常分文件）。

- 备选（登记不采）：手写最小 zip reader（central directory + `node:zlib` inflateRaw，~百行可行）——省下 bundle 步骤，但自维护 zip 解析器的长期成本 > 一条 esbuild 命令，且 bundle 方案还顺带解决了"复用 lib.mjs / extension-packaging"的引用问题。
- `pnpm test:release` 既有的 server 市场路由测试改为对 bundle 产物 + 源码双跑其一（实施时看测试结构成本取舍，至少覆盖源码形态）。

## 5. 运维脚本 `scripts/gallery/token.mjs`

```bash
node scripts/gallery/token.mjs issue --publisher acme --label zhangsan-laptop --auth-dir <dir>
  # 生成 token → 存哈希 → stdout 打印明文一次（提示"此后不可再查，只能重发"）
node scripts/gallery/token.mjs revoke --publisher acme --label zhangsan-laptop --auth-dir <dir>
node scripts/gallery/token.mjs list [--publisher acme] --auth-dir <dir>   # 只列 label/时间，不列哈希
```

- 直接读写服务器上的 `publishers.json`（运维 ssh 上去跑，或对本地副本跑完随既有 scp 通道上传）——内部阶段不为签发做 HTTP API，签发面越小越好。
- publisher 首次出现即隐式创建（`issue` 时不存在则建）——内部阶段"建 publisher"不值得独立仪式。

## 6. 与既有链路的兼容

- `publish.mjs`/`upload.mjs` 本地运维通道**保留**：登第一批内置扩展、灾备（server 挂了仍可静态重建 registry）、以及"第三方交 vsix 由运维代传"的受控兜底。两条通道写同一份 registry，格式由 lib.mjs 单点保证。
- 编辑器客户端**零改动**：`/extensionquery`、control.json、下载安装、防投毒校验全部不动——本阶段纯服务端 + CLI 增量。

## 7. 测试与验证

- 单测（`pnpm test:release` 域内扩展）：token 哈希/吊销判定；publish 流水线各拒绝分支（401/403/409/413/坏包 400）；zip-slip 恶意包 fixture；版本不可变；registry upsert 后缓存失效；auth-dir 误入静态根的启动自检。
- **Phase D 完成标准（端到端）**：本地起 server → `token.mjs issue` → 仓库外项目 `uex login`（whoami 通过）→ `uex publish` → 编辑器（`--gallery-url` 指本地）搜索到并安装成功 → 再次 publish 同版本被 409 → `token.mjs revoke` 后 publish 401。
- 文档：`docs/development/marketplace-server.md` 增补 publish API 一节 + token 运维手册。

## 8. 坑与注意

- **HTTPS 是 token 安全的前提**：token 走 Bearer 明文过线。部署文档必须写明"公网/跨办公网部署必须置于 TLS 反代之后"；server 自身不做 TLS（保持简单，反代是标准解）。内网 HTTP 部署要在文档里如实标注风险等级。
- **`readJsonCached` 的缓存失效**：publish 写 registry 后不失效缓存，客户端要等 TTL 才看到新扩展——实施时给 registry/control 的缓存加显式失效钩子，并测它。
- **两条写通道的竞态**：`upload.mjs` scp 与 publish API 同时写 registry 理论上会撕（scp 整文件覆盖）。内部阶段靠约定（用 API 后 scp 通道仅灾备用）+ 文档警示；文件锁不值得为低频场景引入。
- **"登录页/管理台"的封印边界（2026-08-11 修订改写）**：注册页是无登录态的一次性表单（填完即弃，token 只显示一次）；配套的**最小审批页**（`gallery/admin`，仅待审批三分区 + 批准/拒绝/删除，令牌 sessionStorage 暂存、无登录态服务）已随审批制落地——它只做"审批"这一件事，无会话、无账户体系，不改变服务端无状态 UI 的定性。**带登录态的完整管理台、token 自服务页（轮换/吊销/列表）仍属公开阶段（06）**——现在加只会长出一个没人维护的半成品。
