# 扩展市场发布运维（gallery）

把 `.vsix` 发布进自建扩展市场的运维脚本。市场后端本身就是 `scripts/server` 那台**零依赖静态服务器**——它在服务自动更新之外，同时按 `<发布目录>/gallery/registry.json` 生成 `/extensionquery` 响应（详见 [`docs/development/marketplace-server.md`](../../docs/development/marketplace-server.md)）。本目录的脚本负责**生成并维护那份 registry 与资产目录**，再同步上服务器。

> 只想安装扩展？看[用户文档](../../docs/user/zh-CN/customization/extensions.md#安装第三方扩展)。
> 想搭市场服务器？看 [`scripts/server/README.md`](../server/README.md) 与 [`docs/development/marketplace-server.md`](../../docs/development/marketplace-server.md)。

## 数据布局

本地 stage 里市场内容放在 `<stage>/gallery/`；服务器上则落在**市场根**（server 的 `--gallery-root`，与更新根 `--root` 解耦，默认 `<root>/gallery`）：

```
<stage>/gallery/  ←→  <服务器市场根>/
  registry.json          所有扩展的清单（服务器据此生成 /extensionquery）
  control.json           恶意/弃用清单（可选，手写）
  assets/
    <publisher>.<name>/<version>/
      <publisher>.<name>-<version>.vsix
      icon.png / README.md / CHANGELOG.md   （从 VSIX 内抽取，可选）
```

> 「市场根」与更新目录解耦：合并部署时它是 `<更新根>/gallery`（默认），独立部署时可指向另一块磁盘（如 `/data/extensions`）。URL 上市场始终挂在 `{base}gallery/` 命名空间，与磁盘位置无关。详见 [`docs/development/marketplace-server.md`](../../docs/development/marketplace-server.md)。

`registry.json` 里的元数据**全部由 `publish.mjs` 从 VSIX 内 `extension/package.json` 抽取**（`publisher/name/version/displayName/description/categories/engines.universe`），你无需手写——这样也杜绝了「市场元数据与包内声明不一致」导致客户端防投毒校验拒装。每个版本条目还带 `publish.mjs` 写入的 `sha256` + `signature`（市场签名，见下）。

## 市场签名（发布必配）

客户端对市场安装的 VSIX **强制验签**（fail-closed）：registry 条目的 `signature` 须能被客户端内置的市场公钥验证，否则拒装。签名与 `sha256` 由 `publish.mjs` 在发布时自动计算，签的是**暂存后的规范文件字节**（Ed25519）。

- **私钥**：`--signing-key-file <pem>`（或 env `UE_GALLERY_SIGNING_KEY_FILE`）传入，pkcs8 PEM，只存运维机/CI secret，**绝不进 repo**。没有就跑 `pnpm gallery:keygen -- --out market-key.pem` 生成（mode 0600，已存在拒覆盖）。
- **keyId**：默认 `market-v1`，`--key-id` 覆盖。registry 里签名带 keyId，客户端按 id 查公钥。
- **公钥**：内置在客户端 `apps/editor/src/main/services/extensionManagement/marketplaceSigningKeys.ts`（keygen 会打印要贴入的片段）。
- **轮换**：生成 `market-v2` → 新客户端内置 v2 公钥（保留 v1）→ 等带 v2 的客户端铺量 → 发布侧切 `--key-id market-v2`。旧客户端遇到未知 keyId 会拒装，故切换必须等铺量。
- **本地 VSIX 安装不验签**（用户显式选择的文件属显式信任，无市场签名可验）。

## 脚本

| 脚本 | npm 别名 | 作用 |
|---|---|---|
| `publish.mjs` | `pnpm gallery:publish` | 读 `.vsix` → 抽元数据/图标/README → 落地到本地 stage 的 `gallery/assets/**` → 签名 → upsert `registry.json` |
| `keygen.mjs` | `pnpm gallery:keygen` | 生成市场签名密钥对（Ed25519）：私钥 PEM 落盘（0600），打印公钥与客户端内置片段 |
| `unpublish.mjs` | `pnpm gallery:unpublish` | 从 registry 下架某扩展或某版本 + 删本地资产 |
| `upload.mjs` | `pnpm gallery:upload` | 把 stage 的 `gallery/**` scp 到服务器**市场根**（`--dir` = server 的 `--gallery-root`；**先 assets 后 registry.json**，避免半态） |
| `token.mjs` | `pnpm gallery:token` | 自助发布 API 的 token 签发/吊销/盘点（直接读写服务器 `--auth-dir` 下的 `publishers.json`，只存 sha256 哈希） |

「stage 目录」是本地的市场镜像，脚本只写它、不碰服务器；`upload.mjs` 才做同步。stage 可以就是服务器市场根的本地副本，长期保留以便增量发布。

> 自助发布通道（`uex publish` 经服务器的 `gallery/api/*` 端点直达）与本目录的 stage+scp 通道写**同一份** registry（格式由 `lib.mjs` 单点保证）。启用 API 后约定 scp 通道仅灾备/代传用，两者不要并发写。详见 [`docs/development/marketplace-server.md`](../../docs/development/marketplace-server.md)「自助发布 API」节。

## 发布一个扩展

> 发布 `extensions-external/*` 里的自研扩展，**首选 [`pnpm ext:release`](../../docs/development/publishing-extensions.md)**——它自动 build + 打包 + 调用本目录的 `publish.mjs`/`upload.mjs`，支持自动发现与增量。下面是本目录脚本的**底层手动流程**，用于第三方 `.vsix` 或需要精细控制 stage 的场景。

```bash
# 1) 打包扩展成 .vsix（各扩展自带打包脚本 scripts/pack.mjs，都是 createVsix 的薄封装）
cd extensions-external/pdf && pnpm build && pnpm package && cd -
# ESLint 同理（其 build 产双 bundle：client + 独立 LSP server）：
cd extensions-external/eslint && pnpm build && pnpm package && cd -

# 2) 发布进本地 stage（首次会创建 stage/gallery/；可一次传多个 .vsix）
#    需市场签名私钥（没有先跑：pnpm gallery:keygen -- --out market-key.pem）
pnpm gallery:publish -- --stage ./market-stage --signing-key-file ./market-key.pem \
  extensions-external/pdf/universe.universe-pdf-0.1.0.vsix \
  extensions-external/eslint/universe.universe-eslint-0.1.0.vsix

# 3) 同步到服务器市场根（--dir = server 的 --gallery-root；assets 先、registry.json 后）
pnpm gallery:upload -- --stage ./market-stage --host iloop.aki.kuro.com  --user deploy --dir /srv/universe-editor/gallery
```

`--stage` 也可用环境变量 `UE_GALLERY_STAGE`；`upload.mjs` 的 `--host/--user` 与 `scripts/release/upload.mjs` 共用 `UE_RELEASE_*`，而**市场根用独立的 `--dir`（或 `UE_GALLERY_DIR`）**，与更新目录 `UE_RELEASE_DIR` 解耦。

发布多个：`pnpm gallery:publish -- --stage ./market-stage --signing-key-file ./market-key.pem a.vsix b.vsix c.vsix`。

## 下架

```bash
# 下架某版本
pnpm gallery:unpublish -- --stage ./market-stage universe.universe-pdf@0.1.0
# 下架整个扩展（所有版本）
pnpm gallery:unpublish -- --stage ./market-stage universe.universe-pdf
# 然后重新 upload 覆盖 registry.json
pnpm gallery:upload -- --stage ./market-stage --host <IP> --user deploy --dir /srv/universe-editor/gallery
```

> `upload` 用 scp 增量同步，**不会删除**服务器上已存在的旧 assets 目录。彻底清理需按 `unpublish` 的提示到服务器手动删对应 `<市场根>/assets/<...>` 目录。

## publish token 签发/吊销（自助发布 API）

服务器 `gallery/api/*` 端点的认证数据存 **`--auth-dir`（默认 `<root>/../auth`）下的 `publishers.json`**（只存 token 的 sha256 哈希 + label/时间戳；server 按 mtime 自动重载，改完免重启）。🔴 `--auth-dir` 绝不能在 server 的 `--root` / `--gallery-root` 之内——那是公开静态命名空间。

```bash
# 签发：明文只打印一次（交付给开发者 uex login；publisher 首次隐式创建；label 用于对账/定点吊销）
pnpm gallery:token -- issue --publisher acme --label zhangsan-laptop --auth-dir /srv/auth
# 吊销（立即生效）/ 盘点（不列哈希）
pnpm gallery:token -- revoke --publisher acme --label zhangsan-laptop --auth-dir /srv/auth
pnpm gallery:token -- list --auth-dir /srv/auth
```

直接读写服务器上的文件：ssh 上去跑，或对本地副本跑完随 `gallery:upload` 通道上传。token 走 Bearer 明文过线——公网部署务必把服务器置于 TLS 反代之后。协议细节见 [`docs/development/marketplace-server.md`](../../docs/development/marketplace-server.md)「自助发布 API」节。

## 恶意/弃用清单（control.json）

手写 `<stage>/gallery/control.json`，`upload` 会一并同步：

```jsonc
{
  "malicious": ["evil.ext"],
  "deprecated": { "old.ext": { "reason": "不再维护", "migrateTo": "new.ext" } }
}
```

客户端启动时（及每 ≤6h）拉一次，命中 `malicious` 的扩展拒装、已装则自动禁用告警。

## 本地端到端联调（无需真服务器）

```bash
# 0) 生成本地测试密钥对（私钥只在本机；打印的公钥用于第 3 步 env 注入）
pnpm gallery:keygen -- --out ./market-key.pem --key-id market-test
# 1) 发布进本地 stage
pnpm gallery:publish -- --stage ./market-stage --signing-key-file ./market-key.pem --key-id market-test \
  extensions-external/pdf/universe.universe-pdf-0.1.0.vsix
# 2) 起静态服务器，市场根指向 stage/gallery（与更新根解耦；base=/ 便于本地）
node scripts/server/server.mjs --root ./market-stage --gallery-root ./market-stage/gallery --port 8788 --base /
#    便捷等价：pnpm gallery:serve
# 3) 起编辑器 dev 指向本地市场，并把测试公钥注为验签公钥（x 取自 keygen 输出）
UNIVERSE_GALLERY_URL=http://localhost:8788 \
UNIVERSE_GALLERY_SIGNING_KEYS='{"market-test":"<keygen 打印的 x>"}' pnpm dev
# → 扩展视图搜 pdf → 安装 → 生效 → 卸载
```

## 验证

```bash
node --test "scripts/gallery/__tests__/**/*.test.mjs"   # 或 pnpm test:release（含全部 scripts 测试）
```
