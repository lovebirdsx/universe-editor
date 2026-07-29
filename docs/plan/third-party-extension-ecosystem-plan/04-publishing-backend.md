# 04 — 自助发布通路：市场后端的 publisher/token 模型与 publish API

> Phase D。目标：拿到 token 的第三方开发者 `uex publish` 直达市场，运维不再人肉 scp。
> 现状：`scripts/server/server.mjs`（626 行零依赖静态服务器）已挂 `/extensionquery`（POST，先于静态判定）+ `gallery/**` 静态托管；registry 由维护者本地跑 `scripts/gallery/publish.mjs` 生成后 `upload.mjs` scp 上去。
> 决策背景（README 决策 1+2）：自助 token 发布，但**两步走**——本阶段只做"运维签发 token + 服务端认证 API"；自助注册/邮箱验证是公开阶段的事（[06](./06-public-phase-roadmap.md)）。

## 1. publisher / token 模型

```
<server 数据目录，绝不在 galleryRoot 下>/auth/publishers.json
{
  "publishers": [
    {
      "name": "acme",                          // 即 vsix manifest 的 publisher 字段
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
| `{base}gallery/api/publish` | POST；`Authorization: Bearer <token>` | body = **vsix 二进制流**（`application/octet-stream`；不用 multipart——零依赖服务器手写 multipart 解析是自找的攻击面）。走 §3 流水线，成功 201 返回 `{ id, version }` |
| `{base}gallery/api/unpublish` | POST；Bearer | body = `{ "id": "<publisher>.<name>", "version": "1.2.3" \| null }`（null=整个扩展下架）。只能动 token 归属 publisher 名下的条目 |
| `{base}gallery/api/whoami` | GET；Bearer | 200 `{ "publisher": "acme" }`——`uex login` 用它验证 token 有效性 |

- 认证失败一律 401（不区分"token 不存在/已吊销"，不给探测面）；publisher 不匹配 403；版本已存在 409；包体超限 413（默认 128MB，`--max-vsix-size` 可配）。
- **限流本阶段不做**（内部信任环境 + token 门槛已在），登记 Phase F；但 413 体积限制与请求体读取的**流式落盘**（不整包进内存）必须本阶段做——这是稳定性而非安全议题。

## 3. 服务端 publish 流水线（防投毒的对称另一半）

客户端安装侧已有"下载包与市场元数据一致性校验"；发布侧的对称保证是：**registry 元数据只从服务端亲自解开的 VSIX 里抽取，客户端上传时声称什么一概不信**。流水线：

```
① 认证        Bearer → sha256 → publishers.json 查归属（revoked 拒）
② 收包        流式写 <tmp>/upload-<uuid>.vsix，边写边计体积（超限中断 413）
③ 亲自读包    readVsixManifest（extension-packaging）：zip 解析 + extension/package.json
              + manifest zod 校验（extensions-common，与宿主同一份 schema）
④ 归属校验    manifest.publisher === token 归属，否则 403
⑤ 版本不可变  registry 已有 <id>@<version> → 409（改内容必须 bump version，杜绝
              "同版本换包"——这是供应链安全的地基，无例外，运维也不例外）
⑥ 落资产      抽 icon/README/CHANGELOG（zip-slip 防护复用 extension-packaging 的规范化检查）
              → <galleryRoot>/assets/<id>/<version>/ 临时目录写完原子 rename
⑦ upsert      registry.json 更新（复用 scripts/gallery/lib.mjs 的抽取/合并逻辑）
              ——先 assets 后 registry 的既有原子约定；写后失效 readJsonCached 缓存
⑧ 审计        logLine 记 publish/unpublish（who/id/version/来源 IP），日志即内部阶段的审计面
```

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
- **不要顺手加"登录页/管理台"**：本阶段服务端刻意保持无状态 UI、纯 API + 静态文件。管理台是公开阶段（06）连同注册流程一起设计的事，现在加只会长出一个没人维护的半成品。
