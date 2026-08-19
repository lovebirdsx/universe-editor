# 发布扩展 SDK（npm）

把扩展开发发布集合发布到公开 npm（`@universe-editor` scope），供仓库外的第三方扩展作者 `npm install`。这是内部运维手册；面向扩展作者的版本语义说明在 [`docs/extension-dev/zh-CN/versioning.md`](../extension-dev/zh-CN/versioning.md)。

> 发布**外部扩展**（`.vsix` → 市场）是另一条链路，见 [发布外部扩展](publishing-extensions.md)。

## 发布集合

| 包 | 版本规则 | 内容 |
|---|---|---|
| `@universe-editor/extension-api` | **版本号 = 扩展 API 版本**，bump 走 [COMPATIBILITY.md](../../packages/extension-api/COMPATIBILITY.md) 的破坏性变更流程（契约测试快照 + 变更记录） | API 面（Universe 版 `vscode.d.ts`） |
| `@universe-editor/extension-manifest` | 独立 semver，有对外可见变更才发 | manifest 类型/zod 校验、激活事件构造器、`engines.universe` 协商、分类集合 |
| `@universe-editor/extension-packaging` | 独立 semver，同上 | `createVsix` / `readVsixManifest`（`uex package` 的依赖） |
| `@universe-editor/uex` | 独立 semver，同上 | 对外 CLI（bin `uex`）：`package` / `ls` / `dev` / `login` / `publish` / `unpublish` |
| `@universe-editor/create-extension` | 独立 semver，同上 | `npm create @universe-editor/extension` 脚手架（basic / webview 两模板） |
| `@universe-editor/e2e-contract` | 独立 semver，有对外可见变更才发 | `window.__E2E__` 探针的类型/常量 |
| `@universe-editor/e2e-harness` | **minor 跟随编辑器 minor** | Playwright fixtures / 页面对象 / launch 辅助 |

**版本联动注意**：`create-extension` 的 `src/sdkVersions.ts` 与 `uex` 的 `src/lib/sdkVersion.ts` 是**生成物**（`pnpm ext-packages:gen` 从 extension-api / uex 的 `package.json` 与 pnpm-workspace.yaml catalog 生成，勿手改）。由于 `create-extension` 内嵌 extension-api / uex 的版本号、`uex` 内嵌 extension-api 的版本号，bump extension-api 时必须同时 bump uex 与 create-extension、bump uex 时必须同时 bump create-extension——否则目标包 npm 发布物里仍是旧版本号，preflight 的版本耦合检查会强制拦截。

`@universe-editor/extensions-common` **不在发布集合**：它的 RPC 基建（`stdioProtocol` 等）运行时依赖不可发布的 `@universe-editor/platform`。作者面模块已物理迁入 `extension-manifest`，`extensions-common` 依赖并 re-export 它，仓库内消费方零改动。

### e2e-harness 的 `@playwright/test` 是 peerDependency

`@universe-editor/e2e-harness` 不内置 `@playwright/test`——它是 peerDependency（当前 `^1.62.0`，与 `pnpm-workspace.yaml` catalog 的 playwright 区间一致）。消费方（如 samples 仓库）必须**显式**在 devDependencies 安装同区间的 `@playwright/test`。红线：整个依赖树只能有一份 `@playwright/test` 物理拷贝（两份会各自维护 worker/进程表，启动即崩）；`pnpm why @playwright/test` 出现两份时，把消费方版本对齐到同一区间。版本联动：e2e-contract 独立 semver，e2e-harness 的 minor 跟随编辑器 minor——升编辑器时同步升 e2e-harness。

## 前置（运营，一次性）

1. 注册 npm org `@universe-editor`（包名写死进所有第三方代码，**发布后不可再改**；若被占用，备选 scope 需升级拍板）。
2. 发布账号 `npm login`，且该账号在 org 内有 publish 权限。

## 发布步骤（一键）

发版频率低，本地一键发布；CI 自动化属公开阶段前置（计划 Phase F）。

**发布前，开发者自己做的事**：

1. bump 各包 `package.json` 的 version（独立 semver）。extension-api 的 bump 必须先完成契约测试快照更新 + COMPATIBILITY.md 变更记录，否则脚本 preflight 会拒绝发布。
2. 版本常量无需手改——`create-extension/src/sdkVersions.ts` 与 `uex/src/lib/sdkVersion.ts` 是生成物（`pnpm ext-packages:gen`，发布 preflight 也会自动再生成），守卫测试仍会校验漂移。bump extension-api / uex 时必须同时 bump create-extension（及 uex），preflight 的版本耦合检查会拦截漏发的目标包。
3. 非 SDK 目录的联动改动（如 `extensions/*` 的 `engines.universe` 同步）先单独提交——脚本只放行 SDK 发布集合目录内的未提交改动，并将其 commit。

然后一条命令：

```bash
pnpm ext-packages:publish [-- 选项] [pkg ...]
```

| 选项 | 说明 |
|---|---|
| `[pkg ...]` | 只发布指定包（目录名或包名），默认全部发布集合 |
| `--dry-run` | 只读检查照跑，写操作只打印 `[dry-run]` |
| `--no-gallery` | 跳过内网 pack + scp 同步 |
| `--no-push` | 跳过 git push（本地验证用；不带该旗标重跑可补推收敛） |
| `--allow-non-main` | 允许非 main 分支（本地 verdaccio 验证用） |
| `--registry <url>` | npm registry，默认 `https://registry.npmjs.org` |
| `--stage <dir>` | 市场 stage 目录（默认 `UE_GALLERY_STAGE` 或 `<repo>/market-stage`） |
| `--env <mode>` | `.env` 分层加载模式；内网同步变量（UE_RELEASE_HOST / UE_RELEASE_USER / UE_GALLERY_DIR）通常按环境放 `.env.<mode>`（如 `.env.prod`），不带该旗标默认 `dev`、只加载 `.env` / `.env.local`，配置 `.env.prod` 的机器发布需带 `-- --env prod` |

它做了什么（顺序）：

1. **preflight**：工作区白名单（SDK 目录外有未提交改动则拒绝）、main 分支、与 upstream 同步、`npm whoami` 登录态、各包本地版本高于 npm 已发布版（相同增量跳过、更低报错）、集合外 workspace 依赖已在 npm 发布（防发布出指向未发布版本的包）、git tag 未占用、extension-api 的 COMPATIBILITY.md 变更记录与 `src/index.ts` 版本常量、自动再生成 create-extension/uex 的版本常量（生成物，随发布 commit）、版本耦合检查（源包发布而目标包未 bump/未选则拒绝）、内网上传配置。
2. **build**（拓扑序，连同 workspace 依赖）+ extension-api 契约测试（快照兜底）。
3. **pack 内容检查**：无 `dist/__tests__/`、LICENSE / README.md 在列、bin 入口 `dist/cli.js` 与 templates/ 在列。
4. **发布**（拓扑序逐个 `pnpm publish --no-git-checks`）+ 发布后核对依赖表无 `workspace:` / `catalog:` 残留、`@universe-editor/*` 互赖为精确版本（异常只警告不中断，结尾汇总）。
5. **git**：commit SDK 目录改动（`chore(release): publish ...`）、每个发布包打 annotated tag（`extension-api@0.13.0`，不带 scope）、push 到 main。
6. **内网同步**（`--no-gallery` 跳过）：pack 发布集合 tarball 到市场 stage 并 scp 上传（保持内网 tarball 与 npm 一致）。

**幂等自愈**：npm 发布成功但 tag/push/gallery 中断时，重跑同一命令即可收敛（已发布版本增量跳过、缺失 tag 补打、gallery 重同步）。npm 版本不可变，同版本重跑不会重复发布。

### 手动兜底（一键脚本异常时）

```bash
# 0. 确认版本号
#    extension-api 的 bump 必须已完成契约测试快照更新 + COMPATIBILITY.md 变更记录，
#    否则视为破坏性变更流程未走完，禁止发布。
# 1. 全量校验 + 构建（dist 必须是最新）
pnpm check
pnpm --filter @universe-editor/extension-api --filter @universe-editor/extension-manifest --filter @universe-editor/extension-packaging --filter @universe-editor/uex --filter @universe-editor/create-extension --filter @universe-editor/e2e-contract --filter @universe-editor/e2e-harness build

# 2. 内容检查点：dist 无 __tests__，LICENSE / README.md 在列
cd packages/extension-api && npm pack --dry-run   # 其余包同样过目
#    create-extension 额外确认 templates/ 在列、uex/create-extension 的 bin 字段指向 dist/cli.js

# 3. 发布（pnpm 会把 workspace:/catalog: 协议替换为真实版本号）
pnpm --filter @universe-editor/extension-api publish
pnpm --filter @universe-editor/extension-manifest publish
pnpm --filter @universe-editor/extension-packaging publish
pnpm --filter @universe-editor/uex publish
pnpm --filter @universe-editor/create-extension publish
pnpm --filter @universe-editor/e2e-contract publish
pnpm --filter @universe-editor/e2e-harness publish

# 4. 核对协议替换结果（catalog 首次对外，别盲信）
npm view @universe-editor/extension-api dependencies
npm view @universe-editor/extension-packaging dependencies
npm view @universe-editor/uex dependencies
npm view @universe-editor/e2e-harness dependencies
# 期望：vscode-languageserver-types / adm-zip / @clack/prompts 是真实版本区间；
#       @universe-editor/* 互赖是真实版本号（不是 workspace:* / catalog:）

# 5. 打 tag（extension-api 必打；另六个有发布就打）
git tag extension-api@0.7.1 && git push origin extension-api@0.7.1
```

发布后验证（等同计划 Phase A 完成标准）：仓库外空目录 `npm i @universe-editor/extension-api @universe-editor/extension-manifest typescript`，写一个最小扩展（`activate` 里 `commands.registerCommand` + 导入运行时值 `FoldingRangeKind`），`npx tsc --noEmit` 不装任何额外 `@types` 即通过。

## uex 的 npm 发布

`@universe-editor/uex` 已发布就绪：`LICENSE` / `README.md` / `publishConfig.access: public` / `files`（`dist`、排除 `__tests__`）齐备，`cd packages/uex && npm pack --dry-run` 可自检产物内容。npm org（见上面「前置」节）就绪后与其余 SDK 包同流程发布（已并入上面「发布步骤」）。发布后外部用户即可 `npx uex ...` 或 `npm i -g @universe-editor/uex` 使用完整工具链（打包 / 登录 / 发布 / 下架），无需克隆本仓库。

## uex 本地验证（发 npm 前）

`npx uex` 的本地对等测法，由快到接近真实安装分三档：

```bash
# 1. 直接跑构建产物（改动源码后先构建；`...` 后缀连同依赖包一起）
pnpm --filter @universe-editor/uex... build
node packages/uex/dist/cli.js --help

# 2. 全局 link 出 uex 命令（对等 npx 使用体验；link 指向仓库包目录，
#    workspace:* 依赖经 pnpm 已装好的 node_modules 符号链接解析，无需发布）
cd packages/uex && npm link
cd <任意扩展目录> && uex ls
npm unlink -g @universe-editor/uex    # 测完清理

# 3. tarball 检查"将要发布的内容"（files 白名单、bin 指向）
cd packages/uex && pnpm pack
```

⚠️ 第 3 档的坑：`pnpm pack` 会把 `workspace:*` 改写成真实版本号，`npm i -g <tgz>` 会真去 npm registry 拉 `@universe-editor/extension-manifest` / `extension-packaging`——**这两个依赖包发布之前，tarball 全局安装必然失败**。真正的 npx 等价验证只能在依赖包发布后做；在此之前用第 2 档。

端到端联调（对着本地市场服务器跑完整发布流，server 起法见 [配置扩展市场服务器](marketplace-server.md)）：

```bash
# 1. 签发 active token（明文只打印一次；网页注册的 token 是 pending，publish 会 403，
#    本地测完备性直接走运维签发通道；server 按 mtime 自动重载 publishers.json，无需重启）
node scripts/gallery/token.mjs issue --publisher <name> --label local-test --auth-dir <auth目录>

# 2. 测试扩展的 package.json：publisher 必须与 token 归属一致，且有 files 白名单
#    （可直接用 extensions-external/pdf，或 create-extension 脚手架一个）

# 3. 完整流程（registry = server 地址含 base，如 --base / 即 http://localhost:8788）
uex login <name> --registry http://localhost:8788 --token uet_<明文>
uex whoami --registry http://localhost:8788        # 应显示 active
uex ls                                             # 确认进包文件清单
uex publish --registry http://localhost:8788
uex unpublish <name>.<ext> --yes --registry http://localhost:8788
```

凭据落 `~/.uex/config.json`（按 registry 分桶）；不想污染环境用 `UNIVERSE_MARKET_TOKEN` 环境变量替代 `login`。

自动化对照：`scripts/server/__tests__/uex-publish.integration.test.mjs` 用真 server + 真 dist 跑 login → publish → extensionquery → 同版本 409 → unpublish 全链路（经 `pnpm test:release` 触发），手动验证之外由它兜底。

## 内网 fallback：市场托管 tarball

完全离线内网拉不到公网 npm 时，SDK tarball 由市场服务器静态托管（**不建私有 registry**）。一键命令在每次 npm 发布后默认自动同步（`--no-gallery` 关闭）；也可单独手动：

```bash
# pack 发布集合 → <stage>/gallery/sdk/（pnpm pack 与 publish 共用打包逻辑，产物与 npm 一致）
pnpm gallery:publish-sdk -- --stage ./market-stage

# 与扩展市场同一入口上传（sdk/** 随 assets 一起先于 registry 落地）
pnpm gallery:upload -- --stage ./market-stage --host <IP> --user deploy --dir <市场根>
```

作者侧安装：

```bash
npm i https://<市场地址>/gallery/sdk/universe-editor-extension-api-0.7.1.tgz
npm i https://<市场地址>/gallery/sdk/universe-editor-extension-manifest-0.1.0.tgz
```

每次 npm 发布后应同步跑一遍（一键命令已自动执行）。

## 0.x 版本政策（对外的强制声明位）

1.0 之前 **minor 即可携带破坏性变更**（semver 0.x 惯例）。该政策必须在三处反复声明：各包 npm README、`docs/extension-dev/zh-CN/versioning.md`、编辑器 Release Notes。内部阶段是低成本试错窗口，公开前尽量把 API 面收敛到位。

## 红线

- **`npm` 是唯一真相源**：仓库内部继续 `workspace:*`，仓库外消费走 npm；两世界由"外部消费者冒烟 CI"（计划 Phase E）持续对齐，防漂移。
- 包名、`engines.universe` 的语义解释（API 版本而非编辑器版本）进了第三方代码即锁死，发布前按"不可再改"标准过目。
- 扩展 API 的 `enum` 一律普通 enum（非 const enum，`isolatedModules` 下 TS2748）——已升级为 API 设计规则，见 COMPATIBILITY.md。
