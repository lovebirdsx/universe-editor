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

`registry.json` 里的元数据**全部由 `publish.mjs` 从 VSIX 内 `extension/package.json` 抽取**（`publisher/name/version/displayName/description/categories/engines.universe`），你无需手写——这样也杜绝了「市场元数据与包内声明不一致」导致客户端防投毒校验拒装。

## 脚本

| 脚本 | npm 别名 | 作用 |
|---|---|---|
| `publish.mjs` | `pnpm gallery:publish` | 读 `.vsix` → 抽元数据/图标/README → 落地到本地 stage 的 `gallery/assets/**` → upsert `registry.json` |
| `unpublish.mjs` | `pnpm gallery:unpublish` | 从 registry 下架某扩展或某版本 + 删本地资产 |
| `upload.mjs` | `pnpm gallery:upload` | 把 stage 的 `gallery/**` scp 到服务器**市场根**（`--dir` = server 的 `--gallery-root`；**先 assets 后 registry.json**，避免半态） |

「stage 目录」是本地的市场镜像，脚本只写它、不碰服务器；`upload.mjs` 才做同步。stage 可以就是服务器市场根的本地副本，长期保留以便增量发布。

## 发布一个扩展

```bash
# 1) 打包扩展成 .vsix（各扩展自带打包脚本，如 extensions-external/pdf/scripts/pack.mjs）
cd extensions-external/pdf && pnpm build && node scripts/pack.mjs && cd -

# 2) 发布进本地 stage（首次会创建 stage/gallery/）
pnpm gallery:publish -- --stage ./market-stage \
  extensions-external/pdf/universe.universe-pdf-0.1.0.vsix

# 3) 同步到服务器市场根（--dir = server 的 --gallery-root；assets 先、registry.json 后）
pnpm gallery:upload -- --stage ./market-stage \
  --host <IP> --user deploy --dir /srv/universe-editor/gallery
```

`--stage` 也可用环境变量 `UE_GALLERY_STAGE`；`upload.mjs` 的 `--host/--user` 与 `scripts/release/upload.mjs` 共用 `UE_RELEASE_*`，而**市场根用独立的 `--dir`（或 `UE_GALLERY_DIR`）**，与更新目录 `UE_RELEASE_DIR` 解耦。

发布多个：`pnpm gallery:publish -- --stage ./market-stage a.vsix b.vsix c.vsix`。

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
# 1) 发布进本地 stage
pnpm gallery:publish -- --stage ./market-stage extensions-external/pdf/universe.universe-pdf-0.1.0.vsix
# 2) 起静态服务器，市场根指向 stage/gallery（与更新根解耦；base=/ 便于本地）
node scripts/server/server.mjs --root ./market-stage --gallery-root ./market-stage/gallery --port 8788 --base /
#    便捷等价：pnpm gallery:serve
# 3) 起编辑器 dev 指向本地市场
UNIVERSE_GALLERY_URL=http://localhost:8788 pnpm dev
# → 扩展视图搜 pdf → 安装 → 生效 → 卸载
```

## 验证

```bash
node --test "scripts/gallery/__tests__/**/*.test.mjs"   # 或 pnpm test:release（含全部 scripts 测试）
```
