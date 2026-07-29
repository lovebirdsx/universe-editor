# 发布扩展 SDK（npm）

把扩展开发三件套发布到公开 npm（`@universe-editor` scope），供仓库外的第三方扩展作者 `npm install`。这是内部运维手册；面向扩展作者的版本语义说明在 [`docs/extension-dev/zh-CN/versioning.md`](../extension-dev/zh-CN/versioning.md)。

> 发布**外部扩展**（`.vsix` → 市场）是另一条链路，见 [发布外部扩展](publishing-extensions.md)。

## 发布集合

| 包 | 版本规则 | 内容 |
|---|---|---|
| `@universe-editor/extension-api` | **版本号 = 扩展 API 版本**，bump 走 [COMPATIBILITY.md](../../packages/extension-api/COMPATIBILITY.md) 的破坏性变更流程（契约测试快照 + 变更记录） | API 面（Universe 版 `vscode.d.ts`） |
| `@universe-editor/extension-manifest` | 独立 semver，有对外可见变更才发 | manifest 类型/zod 校验、激活事件构造器、`engines.universe` 协商、分类集合 |
| `@universe-editor/extension-packaging` | 独立 semver，同上 | `createVsix` / `readVsixManifest`（`uex package` 的依赖） |

`@universe-editor/extensions-common` **不在发布集合**：它的 RPC 基建（`stdioProtocol` 等）运行时依赖不可发布的 `@universe-editor/platform`。作者面模块已物理迁入 `extension-manifest`，`extensions-common` 依赖并 re-export 它，仓库内消费方零改动。

## 前置（运营，一次性）

1. 注册 npm org `@universe-editor`（包名写死进所有第三方代码，**发布后不可再改**；若被占用，备选 scope 需升级拍板）。
2. 发布账号 `npm login`，且该账号在 org 内有 publish 权限。

## 发布步骤（手动）

发版频率低，手动发布；CI 自动化属公开阶段前置（计划 Phase F）。

```bash
# 0. 确认版本号
#    extension-api 的 bump 必须已完成契约测试快照更新 + COMPATIBILITY.md 变更记录，
#    否则视为破坏性变更流程未走完，禁止发布。
# 1. 全量校验 + 构建（dist 必须是最新）
pnpm check
pnpm --filter @universe-editor/extension-api --filter @universe-editor/extension-manifest --filter @universe-editor/extension-packaging build

# 2. 内容检查点：dist 无 __tests__，LICENSE / README.md 在列
cd packages/extension-api && npm pack --dry-run   # 另两个包同样过目

# 3. 发布（pnpm 会把 workspace:/catalog: 协议替换为真实版本号）
pnpm --filter @universe-editor/extension-api publish
pnpm --filter @universe-editor/extension-manifest publish
pnpm --filter @universe-editor/extension-packaging publish

# 4. 核对协议替换结果（catalog 首次对外，别盲信）
npm view @universe-editor/extension-api dependencies
npm view @universe-editor/extension-packaging dependencies
# 期望：vscode-languageserver-types / adm-zip 是真实版本区间；
#       @universe-editor/* 互赖是真实版本号（不是 workspace:* / catalog:）

# 5. 打 tag（extension-api 必打；另两个有发布就打）
git tag extension-api@0.7.1 && git push origin extension-api@0.7.1
```

发布后验证（等同计划 Phase A 完成标准）：仓库外空目录 `npm i @universe-editor/extension-api @universe-editor/extension-manifest typescript`，写一个最小扩展（`activate` 里 `commands.registerCommand` + 导入运行时值 `FoldingRangeKind`），`npx tsc --noEmit` 不装任何额外 `@types` 即通过。

## 内网 fallback：市场托管 tarball

完全离线内网拉不到公网 npm 时，SDK tarball 由市场服务器静态托管（**不建私有 registry**）：

```bash
# pack 三件套 → <stage>/gallery/sdk/（pnpm pack 与 publish 共用打包逻辑，产物与 npm 一致）
pnpm gallery:publish-sdk -- --stage ./market-stage

# 与扩展市场同一入口上传（sdk/** 随 assets 一起先于 registry 落地）
pnpm gallery:upload -- --stage ./market-stage --host <IP> --user deploy --dir <市场根>
```

作者侧安装：

```bash
npm i https://<市场地址>/gallery/sdk/universe-editor-extension-api-0.7.1.tgz
npm i https://<市场地址>/gallery/sdk/universe-editor-extension-manifest-0.1.0.tgz
```

每次 npm 发布后应同步跑一遍 `gallery:publish-sdk` + `gallery:upload`，保持内网 tarball 与 npm 版本一致。

## 0.x 版本政策（对外的强制声明位）

1.0 之前 **minor 即可携带破坏性变更**（semver 0.x 惯例）。该政策必须在三处反复声明：各包 npm README、`docs/extension-dev/zh-CN/versioning.md`、编辑器 Release Notes。内部阶段是低成本试错窗口，公开前尽量把 API 面收敛到位。

## 红线

- **`npm` 是唯一真相源**：仓库内部继续 `workspace:*`，仓库外消费走 npm；两世界由"外部消费者冒烟 CI"（计划 Phase E）持续对齐，防漂移。
- 包名、`engines.universe` 的语义解释（API 版本而非编辑器版本）进了第三方代码即锁死，发布前按"不可再改"标准过目。
- 扩展 API 的 `enum` 一律普通 enum（非 const enum，`isolatedModules` 下 TS2748）——已升级为 API 设计规则，见 COMPATIBILITY.md。
