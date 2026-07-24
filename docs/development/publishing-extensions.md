# 发布外部扩展

把 `extensions-external/*` 里的扩展自动打包成 `.vsix` 并发布进[扩展市场](marketplace-server.md)。一条命令走完 **build → 打包 → 发布进本地 stage → 上传服务器**。

> 想搭市场服务器、了解 registry 格式与部署，看 [配置扩展市场服务器](marketplace-server.md)。
> 只想安装扩展，看[用户文档](../user/zh-CN/customization/extensions.md#安装第三方扩展)。

## 一条命令

```bash
# 发布所有 extensions-external/* 里有改动的扩展（自动发现 + 增量跳过 + 上传）
pnpm ext:release

# 只发布本地 stage、不上传服务器
pnpm ext:release -- --no-upload

# 只处理指定扩展（目录名或 publisher.name）
pnpm ext:release -- pdf excel-diff

# 预演，不实际改动
pnpm ext:release -- --dry-run
```

选项：

| 选项 | 作用 |
|---|---|
| `--stage <dir>` | 市场 stage 目录（默认 `<repo>/market-stage`，或环境变量 `UE_GALLERY_STAGE`） |
| `--force` | 忽略增量判定，强制重新 build/打包/发布（覆盖已存在版本） |
| `--no-upload` | 只写本地 stage，不 `scp` 到服务器 |
| `--dry-run` | 打印将执行的步骤，不实际改动 |
| `[ext ...]` | 只处理指定扩展（目录名或 `publisher.name`），默认全部合法扩展 |

上传所需的连接信息与市场运维脚本共用（见 [`scripts/gallery/README.md`](../../scripts/gallery/README.md)）：`UE_RELEASE_HOST` / `UE_RELEASE_USER` / `UE_GALLERY_DIR`。

## 它做了什么

`pnpm ext:release`（`scripts/ext-release/release.mjs`）按顺序：

1. **自动发现**：扫 `extensions-external/*`，只挑 manifest **合法**的目录（非 `private`，且有 `publisher`、`name`、`version`、`engines.universe`——这几项是市场防投毒校验的硬要求）。不合法的目录打印 `skip <名字> (原因)` 后忽略。
2. **增量判定**：若某扩展的 `<publisher>.<name>@<version>` 已在 stage 的 `registry.json` 里，跳过它的 build/打包/发布（打印 `skip ...@... (registry 已有)`）。要重发同一版本用 `--force`。
3. **装依赖 → build + 打包**：对每个待发布扩展，若其 `package.json` 声明了运行时 `dependencies` 且本地还没装（这些扩展在 pnpm workspace 外、有自己的 `node_modules`，依赖会 bundle 进产物），先在其目录跑 `npm ci`（有 `package-lock.json`）或 `npm install`；然后跑 `npm run build` 与 `npm run package`。`package` 调各扩展的 `scripts/pack.mjs`，后者是 `@universe-editor/extension-packaging` 的 `createVsix` 的薄封装——**打进 `.vsix` 的文件由该扩展 `package.json` 的 `files[]` 决定**（外加存在时的 `README.md`/`CHANGELOG.md`），与 app 内置扩展的打包逻辑同一套规则，不会漂移。
4. **发布进 stage**：调 `scripts/gallery/publish.mjs`，把 `.vsix` 落地到 `<stage>/gallery/assets/**` 并 upsert `registry.json`。
5. **上传**（除非 `--no-upload`）：调 `scripts/gallery/upload.mjs`，把 stage 的市场内容 `scp` 到服务器市场根（先 assets、后 registry.json，避免半态）。

## 新增一个待发布扩展

**无需改发布脚本**。把扩展放进 `extensions-external/<name>/`，满足以下几点即被自动纳入：

- `package.json` 有 `publisher`、`name`、`version`、`engines.universe`，且 **不是** `"private": true`。
- 有 `build` 与 `package` 两个 npm 脚本；`package` 指向一个 `scripts/pack.mjs`。
- `files[]` 列出要打进包的目录/文件（如 `["dist", "assets", "icon.png"]`）。

最省事的做法是**照抄现有扩展**（如 `extensions-external/pdf`）的 `scripts/pack.mjs`——三个扩展的该文件完全一致，都是 `createVsix` 的薄封装，直接复制即可。

## 版本管理

各扩展**独立版本**，各自维护 `package.json` 的 `version`。发布哪个版本就在包内 bump 到哪个版本，`registry.json` 天然支持同一扩展多版本并存（客户端取最高版本）。

## 单独打包（不发布）

只想生成 `.vsix`（例如手动分发或本地 `installVSIX` 测试）：

```bash
cd extensions-external/pdf
npm run build && npm run package   # 产出 universe.universe-pdf-<version>.vsix
```

## 下架

下架走市场运维脚本（`pnpm ext:release` 只负责发布）：

```bash
pnpm gallery:unpublish -- --stage ./market-stage universe.universe-pdf@0.1.0   # 某版本
pnpm gallery:unpublish -- --stage ./market-stage universe.universe-pdf          # 整个扩展
# 然后重新 upload 覆盖 registry.json
pnpm gallery:upload -- --stage ./market-stage --host <IP> --user deploy --dir <市场根>
```

## 验证

```bash
node --test scripts/ext-release/__tests__/lib.test.mjs   # 发现/选择/增量的纯逻辑单测
pnpm --filter @universe-editor/extension-packaging test  # createVsix 打包单测
```
