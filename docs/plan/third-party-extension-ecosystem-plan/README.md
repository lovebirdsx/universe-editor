# 第三方插件生态设计方案

> 目标：把当前"外部扩展只能在本仓库内开发"的现状，升级为"**仓库外的第三方开发者**能独立开发、调试、打包、发布扩展"的完整生态，对标 VSCode 的扩展开发者体验（`@types/vscode` + `yo code` + `vsce` + Extension Development Host + Marketplace 自助发布）。
> 前置阅读：[`docs/plan/extension-marketplace-plan/README.md`](../extension-marketplace-plan/README.md)（分发链路，已全部落地）、`packages/extension-host/CLAUDE.md`（运行时）、`apps/editor/src/main/services/extensionManagement/CLAUDE.md`（分发）。

## 文档结构

| 文档 | 内容 | 对应阶段 |
|---|---|---|
| 本文（README） | 结论先行、现状与缺口、已拍板决策、总体架构、分阶段路线、风险 | — |
| [01-sdk-and-api.md](./01-sdk-and-api.md) | `@universe-editor/extension-api` npm 公开发布、版本协商语义对外化、兼容治理 | Phase A |
| [02-dev-experience.md](./02-dev-experience.md) | `--extension-development-path` 开发宿主、host 断点调试、重启重载 | Phase B |
| [03-toolchain.md](./03-toolchain.md) | `create-extension` 脚手架 + `uex` CLI（package / dev / login / publish） | Phase C |
| [04-publishing-backend.md](./04-publishing-backend.md) | 市场后端 publisher/token 模型、自助 publish API、防投毒服务端校验 | Phase D |
| [05-docs-and-samples.md](./05-docs-and-samples.md) | 面向第三方的开发者文档、API 参考、VSCode 移植指南、外部形态样例 | Phase E |
| [06-public-phase-roadmap.md](./06-public-phase-roadmap.md) | 公开阶段前置项（自助注册、签名、审核 SOP）——**只登记不实施** | Phase F |

---

## 0. 结论先行

**编辑器侧的"跑扩展 + 装扩展"两条链路都已就绪，本次要补的是"仓库外开发者"这一侧的全部体验。**

上一轮（`extension-marketplace-plan`，Phase A–D/F 已落地）解决了**用户**怎么获取扩展；本轮解决**第三方开发者**怎么产出扩展。当前所有"外部扩展"（`extensions-external/{pdf,eslint,excel-diff}`）实际都长在本仓库里，依赖三个仓库内 hack 才能构建，这些 hack 恰好就是缺口清单：

```
        已就绪（本仓库内闭环）                     缺失（仓库外开发者视角，本次新建）
┌──────────────────────────────────┐   ┌────────────────────────────────────────────┐
│ 运行时：单 host + Workspace Trust │   │ SDK：extension-api 没发 npm，外部装不到      │
│ 分发：VSIX 安装 + /extensionquery │   │ 脚手架：无 npm create，模板长在仓库 skill 里 │
│ 市场后端：静态 registry 服务器    │   │ 打包 CLI：pack.mjs 借 workspace 依赖的 hack  │
│ 管理 UI：视图 + 详情页 + 更新     │◄──│ 调试：无 --extension-development-path，      │
│ API 治理：COMPATIBILITY + 契约测试│   │       无 host 断点，改一行=重新打包安装      │
│ 范例扩展 ×3（但只能在仓库内构建） │   │ 发布：运维手动 scp，第三方无上架通道         │
│ 发布运维：publish.mjs + upload    │   │ 文档：无面向第三方的 getting started/API 参考│
└──────────────────────────────────┘   └────────────────────────────────────────────┘
```

一句话：**编辑器能跑扩展、用户能装扩展，但一个不在本仓库的开发者今天完全无从下手。本方案填的就是从 `npm create` 到 `uex publish` 的整条开发者旅程。**

### 与 VSCode 生态组件的对照（心智模型）

| 开发者旅程 | VSCode 生态 | 本方案 | 现状 |
|---|---|---|---|
| 拿到 API 类型 | `@types/vscode`（npm） | `@universe-editor/extension-api`（npm 公开发布） | ✅ 发布就绪（手册 + tarball 验证通过，待 org 注册后 publish） |
| 起项目 | `yo code` / `generator-code` | `npm create @universe-editor/extension` | 无（仓库内 skill 不对外） |
| 开发调试 | F5 → Extension Development Host + 断点 | `--extension-development-path` + `--inspect-extensions` + launch.json 模板 | 无（仅 e2e env hack） |
| 快速迭代 | Reload Window / restartExtensionHost | `workbench.action.restartExtensionHost` 命令 + 可选 watch 自动重载 | host 重启机制已有，无命令入口 |
| 打包 | `vsce package` → .vsix | `uex package` | `createVsix` 逻辑已有（`extension-packaging`），无对外 CLI |
| 发布 | `vsce publish`（PAT token） | `uex publish`（Bearer token） | ✅ 已落地（token 认证 API + 联调测试） |
| 市场侧账号 | Marketplace publisher 注册 | 内部阶段运维发 token；公开阶段自助注册（Phase F） | 无 |
| 学习资料 | code.visualstudio.com/api + samples 仓库 | `docs/extension-dev/` + 外部形态 hello-world 样例 | 无 |

---

## 1. 已拍板决策（硬约束）

前四项已与你确认；后五项为本方案推荐的次级决策，**随方案一并 review，有异议时改这里并联动改对应章节**。

| # | 决策项 | 选择 | 含义 |
|---|---|---|---|
| 1 | **生态范围** | 先内部后公开 | 架构按公开生态设计（认证、签名留好接口不实现），运营先从公司内团队/受邀开发者起步；公开阶段前置项集中登记在 [06](./06-public-phase-roadmap.md) |
| 2 | **发布通路** | 自助 token 发布 | 市场后端加 publisher + token 认证，`uex publish` 直传。**两步走**匹配决策 1：内部阶段 token 由运维脚本签发（无注册页面），公开阶段才建自助注册 |
| 3 | **调试体验** | 完整对标 VSCode | `--extension-development-path` 开发宿主 + host `--inspect` 断点 + 脚手架自带 launch.json（F5）+ 重启 host 命令 |
| 4 | **VSCode 兼容策略** | 移植指南 + API 对齐 | 不做 `vscode` 模块 shim、不承诺兼容；API 命名/语义持续对齐 VSCode 压低移植成本，文档给对照表 |
| 5 | API 包分发方式（推荐） | 公开 npm（`@universe-editor` scope） | 包本身无机密，公开发布不影响内部阶段；完全离线内网场景 fallback：市场服务器托管 tarball（`npm i <url>`）。scope 若被占用需运营侧先注册 npm org |
| 6 | CLI 形态（推荐） | 两个包：`@universe-editor/create-extension`（脚手架）+ `@universe-editor/uex`（bin `uex`：package/dev/login/publish） | 对标 `generator-code` + `vsce` 的分工；`npm create @universe-editor/extension` 走 npm 惯例 |
| 7 | 开发宿主 userData（推荐） | 默认隔离（`<userData>/../<产品名> - ExtDev`），可用 `--user-data-dir` 覆盖 | 与 VSCode（共享 userData）不同：我们的 storage 是 JSON 文件写入，双实例并发写会互相覆盖，隔离换安全。实施时如已有多实例安全存储可复议 |
| 8 | proposed API 机制（推荐） | 0.x 阶段不建 | 现阶段整个 API 面按 semver 0.x 语义（minor 即 breaking）滚动，靠 COMPATIBILITY.md + 契约测试治理；`enabledApiProposals` 式机制推迟到 API 1.0 前夕（登记在 06） |
| 9 | 对外文档载体（推荐） | `docs/extension-dev/zh-CN/` 随仓库（对齐 `docs/user/zh-CN` 惯例），接入 `pnpm docs:check` | 内部阶段中文 + 随 repo 分发；公开阶段再考虑文档站与英文化（登记在 06） |

---

## 2. 现状与缺口详析

### 2.1 可直接复用的资产

| 资产 | 位置 | 复用方式 |
|---|---|---|
| API 包 + 兼容治理 | `packages/extension-api`（0.7.0，`COMPATIBILITY.md` + 契约测试冻结快照） | 发 npm 即可对外；治理机制原样延用 |
| 版本协商 | `packages/extension-manifest/src/semver.ts`：`satisfies(hostApiVersion, engines.universe)` fail-closed | 已在安装与激活两处生效，对外只差把语义**写成文档** |
| VSIX 打包逻辑 | `packages/extension-packaging` 的 `createVsix`（各扩展 `scripts/pack.mjs` 都是其薄封装） | `uex package` 直接复用，把"借 workspace 依赖"的调用方式换成正常 npm 依赖 |
| 从目录加载未打包扩展 | `UNIVERSE_USER_EXTENSIONS_DIR` env（e2e hack，整体替换用户扩展目录）；scanner 已支持 symlink/junction 目录 | 证明"目录直载"运行时无障碍；正式 `--extension-development-path` 改为**附加**语义（见 [02](./02-dev-experience.md)） |
| host 重启机制 | `ExtensionHostClientService._restart`（崩溃/信任撤销/enablement 变更共用，签名化防无谓重启） | 重启 host 命令 = 给现成机制加一个 Action2 入口 |
| host spawn 链路 | `extensionHostMainService.ts`：`spawn(process.execPath, [entry], {ELECTRON_RUN_AS_NODE})` | `--inspect` 只是往 argv 前插一个 node flag |
| 市场后端 + 发布运维 | `scripts/server/server.mjs`（`/extensionquery` + 静态托管）+ `scripts/gallery/{publish,unpublish,upload}.mjs` | publish API 的服务端逻辑 = 把 `publish.mjs` 的抽取/upsert 逻辑搬进 server 的认证端点后面 |
| 配置注入范式 | `main/environment/configItems.ts`（cli > env > file） | `--extension-development-path` / `--inspect-extensions` 照抄声明 |
| 范例扩展 | `extensions-external/{pdf,eslint,excel-diff}` | 内容可参考，但构建方式（createRequire 借 workspace）**不可对外照抄**，需另立外部形态样例 |

### 2.2 缺口清单（本次要建）

| 缺口 | 对标物 | 落点 | 文档 |
|---|---|---|---|
| API 包对外分发 ✅ | `@types/vscode` | extension-api 发 npm：deps 修正（`vscode-languageserver-types` 须进 `dependencies`，见 01 §2）、LICENSE/README、发布流程 | [01](./01-sdk-and-api.md) |
| 扩展开发模式 | `--extensionDevelopmentPath` | 新 CLI 参数（附加语义 + id 冲突 dev 胜）、单实例锁豁免、窗口标识、trust 豁免 | [02](./02-dev-experience.md) |
| host 断点调试 | `--inspect-extensions` | spawn 时注入 `--inspect=<port>`、sourcemap 约定、launch.json attach 模板 | [02](./02-dev-experience.md) |
| 重启 host 命令 | `workbench.action.restartExtensionHost` | Action2 包一层现成 `_restart`；可选 dev path watch 自动重载 | [02](./02-dev-experience.md) |
| 脚手架 ✅ | `yo code` | `@universe-editor/create-extension`：basic / webview 两模板，含 launch.json、esbuild、watch | [03](./03-toolchain.md) |
| 打包/发布 CLI ✅ | `vsce` | `@universe-editor/uex`：`package`（复用 extension-packaging）、`dev`（定位并拉起编辑器）、`login`/`publish` | [03](./03-toolchain.md) |
| 自助发布后端 ✅ | Marketplace publish API | server 加 `gallery/api/publish` 等端点 + publisher/token 模型 + 服务端防投毒校验 + 版本不可变 | [04](./04-publishing-backend.md) |
| 对外开发者文档 | code.visualstudio.com/api | `docs/extension-dev/zh-CN/`：getting-started、贡献点参考、webview/语言指南、发布、移植指南 | [05](./05-docs-and-samples.md) |
| 外部形态样例 | extension-samples 仓库 | `samples/hello-world`（不进 workspace、真 npm 依赖）+ CI 外部消费者冒烟 job | [05](./05-docs-and-samples.md) |
| 公开阶段硬化 | publisher 注册 / vsce-sign | 自助注册、VSIX 签名、审核 SOP、API 1.0 —— 只登记 | [06](./06-public-phase-roadmap.md) |

---

## 3. 总体架构

### 3.1 新增/改动的包与目录

```
packages/
  extension-api/              【改】发 npm：deps 修正 + LICENSE/README + 发布脚本（01）✅
  extension-manifest/  🆕✅    作者面小包（activation/manifest/manifest-schema/semver/categories，
                               从 extensions-common 迁入；01 §1 决策点记录了换包缘由）
  extension-packaging/        【改】发 npm（uex 依赖它做 package）；createVsix 面向外部调用方硬化（03）
  extensions-common/          （不发布：RPC 基建依赖 platform；作者面已迁入 extension-manifest 并 re-export）
  create-extension/  🆕       npm create 脚手架：模板 + 交互问询（03）
  uex/               🆕       对外 CLI：package / dev / login / publish（03）

apps/editor/src/
  main/environment/configItems.ts        【改】+EXTENSION_DEV_PATHS、+INSPECT_EXTENSIONS（02）
  main/index.ts                          【改】dev path 存在时跳过单实例锁（02）
  main/services/extensionHost/
    extensionHostMainService.ts          【改】spawn 注入 --inspect；env 传 dev paths（02）
    devExtensionsDir.ts        🆕        dev path 解析（多路径、附加语义）（02）
  renderer/services/extensions/          【改】scanner 结果带 isUnderDevelopment；trust 豁免；标识（02）
  renderer/actions/extensionsActions.ts  【改】+RestartExtensionHost 命令（02）

packages/extension-host/src/
  bootstrap.ts / extensionScanner.ts     【改】三目录合并扫描（builtin/user/dev），id 冲突 dev 胜（02）
  activationService.ts                   【改】isUnderDevelopment 豁免 trust 门控（02）

scripts/server/server.mjs               【改】✅ +gallery/api/{publish,unpublish,whoami}（04）
scripts/server/galleryPublish.mjs 🆕✅   publish 服务端流水线（防投毒：亲自解包校验）（04）
scripts/server/bundle.mjs       🆕✅     esbuild 单文件产物 dist/server.js（04）
scripts/gallery/token.mjs       🆕✅     运维签发/吊销 publisher token（04）

docs/extension-dev/zh-CN/      🆕       第三方开发者文档全套（05）
samples/hello-world/           🆕       外部形态样例（不进 workspace）（05）
```

### 3.2 端到端开发者旅程（目标态）

```
第三方开发者（不在本仓库）
  │
  ▼ npm create @universe-editor/extension        # Phase C
  │   模板：package.json(engines.universe) + esbuild + src/extension.ts
  │        + .vscode/launch.json（attach 9229）+ README
  ▼ npm install                                  # Phase A：extension-api 从公开 npm 拉到
  │
  ▼ npm run watch  +  uex dev --inspect          # Phase B/C
  │   uex 定位已安装的 Universe Editor，拉起：
  │   --extension-development-path=<cwd> --inspect-extensions=9229
  │   → 开发宿主窗口（标题带 [扩展开发宿主]，dev 扩展豁免 trust）
  │   → VSCode 里 F5 attach，断点命中 host 进程
  │
  ▼ 改代码 → watch 重编 → 命令面板 "重启扩展宿主"   # Phase B
  │
  ▼ uex package                                  # Phase C：产出 <publisher>.<name>-<version>.vsix
  │
  ▼ uex login（贴运维签发的 token）→ uex publish    # Phase D
  │   POST /api/gallery/publish（Bearer token + vsix 流）
  │   服务端：验 token→亲自读 VSIX manifest→publisher 一致性→版本不可变
  │         →落 assets→upsert registry.json（先 assets 后 registry）
  │
  ▼ 其他用户在编辑器 Extensions 视图搜索安装        # 已就绪（extension-marketplace-plan）
```

关键点：最后一步之后**完全复用现有分发链路与运行时**——客户端防投毒校验、恶意隔离、启用禁用、Workspace Trust 全部不动。本方案只负责把"仓库外的人"接进这条已经能跑的流水线。

---

## 4. 分阶段实施路线

按"每阶段独立可验证、尽早暴露对外接口的设计错误"排序。A 与 B 无依赖可并行；C 依赖 A（模板引用 npm 包）与 B（launch.json 用 dev 模式）；D 依赖 C（uex 是发布客户端）；E 收口。

### Phase A — SDK 对外化（[01](./01-sdk-and-api.md)）✅ 已完成（2026-07-29）
> 目标：仓库外 `npm install @universe-editor/extension-api` 能编译出一个扩展。

- extension-api 发布准备：`vscode-languageserver-types` 移入 `dependencies`（它含运行时值且 d.ts re-export 需要消费者可解析）、LICENSE/README/repository/publishConfig
- extension-packaging 同批发布（uex 的依赖）；其对 `extensions-common` 的依赖经新包 `@universe-editor/extension-manifest` 解决（extensions-common 运行时依赖 platform 不可发布，见 01 §1 决策点）
- npm org 注册（运营事项）+ 发布流程文档化（先手动 `pnpm publish`，CI 自动化后置）→ [`docs/development/publishing-sdk.md`](../../development/publishing-sdk.md)
- `engines.universe` 版本协商语义 + 0.x 破坏性变更政策 → 草稿 [`docs/extension-dev/zh-CN/versioning.md`](../../extension-dev/zh-CN/versioning.md)（正式落位在 Phase E）
- 宿主 API 版本可查询：`--version` 输出与 About 对话框均带 `Extension API` 行
- **验证**：仓库外空目录 `npm i @universe-editor/extension-api` + `tsc` 编译一个 hello 扩展通过；`FoldingRangeKind` 等运行时值可导入（实施以 pnpm pack tarball 等价验证，待 org 注册后按手册发布）

### Phase B — 扩展开发模式（[02](./02-dev-experience.md)）✅ 已完成（2026-08-01）
> 目标：从开发目录直接加载扩展，断点可命中，改代码一条命令重载。

- `--extension-development-path`（可重复）：configItems 声明 → `ExtHostStartSpec` → env → bootstrap 三目录合并扫描（dev 附加、id 冲突 dev 胜）
- dev 模式实例：跳过单实例锁 + userData 默认隔离 + 窗口标题/状态栏 "[扩展开发宿主]" 标识
- dev 扩展豁免 Workspace Trust 门控（同 builtin 待遇，scanner 打 `isUnderDevelopment`）
- `--inspect-extensions=<port>`：spawn host 时 argv 注入 `--inspect`
- 命令 `workbench.action.restartExtensionHost`（id 对齐 VSCode）；可选增强：watch dev path 产物变更自动重启
- **验证**：手工目录 → dev path 启动 → 命令生效 → VSCode attach 断点命中 → 重启命令后新代码生效；e2e 补 dev path 加载冒烟

### Phase C — 工具链（[03](./03-toolchain.md)）✅ 已完成（2026-08-01）
> 目标：`npm create` 起步、`uex package` 出包，全程不接触本仓库。

- `@universe-editor/create-extension`：交互问询（名称/publisher/模板）+ basic/webview 两模板（esbuild + watch + launch.json/tasks.json + vitest 可选）
- `@universe-editor/uex`：`package`（extension-packaging 封装 + manifest 校验前置）、`dev`（定位已装编辑器并带 dev 参数拉起）、`login`/`publish`（客户端先行，服务端 Phase D 联调）
- **验证**：`npm create` → `uex dev` 起宿主 F5 断点 → `uex package` 出 .vsix → 编辑器"从 VSIX 安装"成功

### Phase D — 自助发布通路（[04](./04-publishing-backend.md)）✅ 已完成（2026-08-01）
> 目标：拿到 token 的第三方 `uex publish` 直达市场。

- server：publisher/token 模型（`<authDir>/publishers.json`，存 token 哈希）+ `POST gallery/api/publish`（Bearer + vsix 流）+ `unpublish` + `whoami`；auth-dir 落入静态根启动自检硬拒
- 服务端防投毒：**亲自**读 VSIX 的 `extension/package.json`（extension-packaging 的 zod 校验，与宿主同 schema），publisher 必须等于 token 归属，同版本 409 不可变；流式落盘 + `--max-vsix-size` 413
- registry 原子更新（`writeJsonAtomic` + 缓存显式失效）沿用"先 assets 后 registry"约定；`scripts/gallery/token.mjs` 运维签发/吊销（与签发能力同批交付）
- 部署升级：esbuild 单文件产物（`pnpm server:bundle` → `dist/server.js`），`setup.mjs` 部署产物；`uex login/publish/unpublish` 全链路联调通过
- **验证**：本地起 server → 签 token → `uex login`（whoami）→ `uex publish` → extensionquery 可见 → 同版本 409 → revoke 后 401（`pnpm test:release` 内真 CLI 联调）

### Phase E — 对外文档与样例（[05](./05-docs-and-samples.md)）
> 目标：一个没接触过本项目的开发者，只靠文档走通全流程。

- `docs/extension-dev/zh-CN/`：getting-started（create→F5→package→publish 全程）、贡献点参考、webview/语言特性指南、发布规范、`engines.universe` 语义、VSCode 移植指南（API 对照表 + pdf 案例提炼）
- `samples/hello-world`：外部形态（不进 workspace、真 npm 依赖版本号）；CI 加"外部消费者冒烟" job（npm pack 本地包 → 装进样例 → 构建 + uex package 通过）
- 接入 `pnpm docs:check`
- **验证**：docs:check 通过；找一位未参与实施的同事按文档从零 dogfood 走通

### Phase F — 公开阶段前置（[06](./06-public-phase-roadmap.md)）⏸️ 只登记不实施
- publisher 自助注册 + 邮箱验证 + token 自管理（轮换/吊销）
- VSIX 签名（复活 marketplace-plan 的 Phase E）
- 审核队列 / 恶意上报响应 SOP / 生态运营
- API 1.0 稳定承诺 + proposed API 机制、文档英文化与文档站

---

## 5. 风险与注意事项

- **API 面一旦对外就是承诺**。发 npm 的那一刻起，`extension-api` 的每次 breaking 都伤害仓库外的真实代码。0.x 语义（minor=breaking）必须在 README/文档里**反复**声明，且 COMPATIBILITY.md 的契约测试在 CI 的地位要保持刚性。内部阶段是最后的低成本试错窗口，公开前尽量把 API 面收敛到位。
- **`uex publish` 是新的攻击面**。服务端必须亲自解包校验（manifest zod + publisher 一致 + zip-slip 防护复用 extension-packaging）、限制上传体积、版本不可变。token 泄露的爆炸半径 = 该 publisher 名下所有扩展，吊销机制（`token.mjs revoke`）Phase D 就要有，不能等 Phase F。
- **"接近编辑器本身的权限"的诚实边界继续有效**。生态开放会放大恶意扩展风险，但内部阶段的信任模型（发布者信任提示 + 恶意清单 + 人际信任）够用；**UI/文档仍不得宣称沙箱**。签名与审核是公开阶段的门票（Phase F），不要提前透支也不要拖过公开时点。
- **双实例数据竞争**：开发宿主与主实例并存是新常态，决策 7 的 userData 隔离是当前 storage（JSON 文件）下的安全解。若未来 storage 升级为多实例安全，可回归 VSCode 的共享语义。
- **dev 附加语义 ≠ 现有 e2e 替换语义**：`UNIVERSE_USER_EXTENSIONS_DIR`（整体替换）保留给 e2e，`--extension-development-path`（附加 + dev 胜）是新通道，两者并存、别合并——合并会破坏三个 external 扩展的 e2e fixture。
- **CLI 的向后兼容压力小于 API 但大于 0**：`uex` 的命令行接口进了第三方 CI 脚本后同样难改，vsce 的子命令/参数命名照抄即可（`package`/`publish`/`login`），不要发明。
- **服务器从"零依赖"变"单依赖"**：publish 端点要解 zip（adm-zip）。建议 esbuild 把 server bundle 成单文件保持部署简单性（详见 04 §5），不要让部署流程退化成"先 npm install"。
