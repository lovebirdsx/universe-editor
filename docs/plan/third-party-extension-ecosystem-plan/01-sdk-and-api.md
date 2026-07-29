# 01 — SDK 对外化：extension-api 的 npm 发布与版本协商语义

> Phase A。目标：**仓库外**的开发者 `npm install @universe-editor/extension-api` 后能编译出一个扩展；API 的版本承诺与协商语义有对外可引用的出处。
> 现状：包已存在（`packages/extension-api`，version 0.7.0 = API 版本），治理已存在（`COMPATIBILITY.md` + 契约测试快照），**唯独没有分发渠道**——外部拿不到这个包，`extensions-external/*` 全靠 tsconfig `paths` 映射到 workspace `dist/` 的 hack。
>
> **实施状态（2026-07-29）**：✅ 已完成并验证（pnpm check 全绿 + 仓库外空目录 tarball 安装/tsc/运行时三验）。实施中对发布集合做了一处修订（见 §1 决策点）：`extensions-common` 因运行时依赖不可发布的 platform 无法整包发布，作者面抽为新包 `@universe-editor/extension-manifest`。发布手册落位 [`docs/development/publishing-sdk.md`](../../development/publishing-sdk.md)，versioning 草稿落位 [`docs/extension-dev/zh-CN/versioning.md`](../../extension-dev/zh-CN/versioning.md)。

## 1. 发布集合与依赖图

不是只发一个包。按"谁会出现在仓库外的 `node_modules` 里"划定发布集合：

```
扩展作者的 package.json 依赖：
  @universe-editor/extension-api        核心 API 面（≈ vscode.d.ts）        【必发】
  @universe-editor/extension-manifest   ActivationEvents 等激活事件构造器    【必发】
                                        （COMPATIBILITY.md 明确推荐作者使用，
                                          手写激活事件字符串拼错即永不激活）
                                        + manifest 类型/zod 校验 + semver + categories
工具链（Phase C）的依赖：
  @universe-editor/extension-packaging  createVsix/readVsixManifest          【必发】
                                        （uex 依赖；它 dependencies 里已有
                                          extension-manifest，构成同批发布理由②）
  @universe-editor/uex                  CLI（Phase C 交付，本阶段占位 scope）
  @universe-editor/create-extension     脚手架（Phase C 交付，同上）
```

**决策点：作者面抽成 `@universe-editor/extension-manifest` 小包发布（实施中对原方案的修订）。** 原方案是 extensions-common 整包直接发布、不做内联拆分；实施时发现不可行——`stdioProtocol.ts` 运行时依赖 `@universe-editor/platform`（`Disposable`/`Emitter`），`rpc.ts`/`aiWire.ts` 的 d.ts 带 `import type from '@universe-editor/platform'`，而 platform 是整个内核、不可发布，直接发布会让外部安装后解析失败。修订方案：作者与工具链需要的 5 个自包含模块（activation / manifest / manifest-schema / semver / categories）**物理迁入**新包；`extensions-common` 依赖并 re-export（仓库内消费方零改动），manifest 校验真相仍单一（host 与 CLI 共享同一份）；`extensions-common` 本体不发布（RPC 基建本就不该出现在外部 node_modules）。被否的备选：拆分 extensions-common 移走 RPC 基建后整包发布（迁移面 ~40 处 import，过大）；VSCode 式 vsce 自带校验（双份真相，正是本节最初想避免的漂移）。

## 2. extension-api 发布准备清单

按序执行，每条都有明确验收：

1. **依赖修正（必须，当前会直接坏）**：`vscode-languageserver-types` 从 `devDependencies` 移入 `dependencies`。两个独立理由：
   - `src/index.ts` re-export 了它的**运行时值** `FoldingRangeKind`——dist/index.js 里是真 import，缺依赖则扩展 bundle 时解析失败；
   - d.ts 里 `export type {...} from 'vscode-languageserver-types'` 要求消费者的 TS 能解析该模块，devDep 不随包安装。
   仓库内没暴露此问题是因为 pnpm workspace 的 hoist 恰好让它可解析——**这正是"没在仓库外消费过"藏住的 bug 类型**，也是 Phase A 验证必须在仓库外空目录做的原因。
2. **包元数据**：`license`（先定 SPDX，与法务/开源策略对齐——这是发布前的运营前置）、`LICENSE` 文件、`readme`（面向扩展作者的最小上手 + 指向 docs/extension-dev）、`repository`/`homepage`/`keywords`、`publishConfig: { access: "public" }`。
3. **发布内容核对**：`files: ["dist"]` 已有；确认 `dist/__tests__/` 不进包（当前 `dist/__tests__/index.test.d.ts` 会被带上——tsconfig exclude 测试目录或 files 收窄为具体文件）。`npm pack --dry-run` 逐项过目。
4. **engines 声明**：包自身加 `engines.node`（与编辑器内嵌 Electron 的 node 大版本对齐），防止作者用过老 node 构建出诡异产物。
5. **extension-manifest / extension-packaging 同批处理**：补齐同样的元数据；`extension-packaging` 的 `@universe-editor/extension-manifest: workspace:*` 与 `adm-zip: catalog:` 由 pnpm publish 自动替换为真实版本（发布后 `npm view` 核对替换结果，这是 pnpm catalog 首次对外，别盲信——实施已验证 `pnpm pack`/`publish` 替换正确：`catalog:` → 版本区间、`workspace:*` → 精确版本号）。
6. **npm org**（运营事项，技术侧的外部依赖）：注册 `@universe-editor` scope。若被占用，备选 scope 决策升级给你拍板——**包名会写死进所有第三方代码，发布后不可再改**。

## 3. 版本与发布流程

- **extension-api 的版本号继续 = API 版本**（`COMPATIBILITY.md` 既定），与 app 版本（0.1.x）无关。发布动作追加进现有破坏性变更流程：契约测试快照 → bump version → 变更记录 → **`pnpm publish` + git tag `extension-api@<ver>`**。
- extension-manifest / extension-packaging 从 `0.1.0` 起步管理独立 semver，只在有对外可见变更时发版。
- **流程形态：先手动、后 CI**。内部阶段发版频率低，手动 `pnpm --filter <pkg> publish`（步骤写进 `docs/development/`，含 `npm pack --dry-run` 检查点）；CI 自动化（tag 触发 + provenance）登记到 Phase F 前再做——过早自动化一个月发一次的事，收益负。
- **npm 是唯一真相源**。仓库内部继续用 `workspace:*`（内置扩展、e2e 不受影响）；只有仓库外消费走 npm。两个世界经 Phase E 的"外部消费者冒烟 CI"（`npm pack` 本地最新 → 装进样例构建）持续对齐，防"发布的包与仓库内行为漂移"。

## 4. engines.universe 协商语义对外化

机制已全部存在（`extension-manifest/semver.ts` 的 `satisfies` fail-closed；scanner 跳过不满足的扩展并记日志），本阶段只做**表述层**工作：草稿已落位 [`docs/extension-dev/zh-CN/versioning.md`](../../extension-dev/zh-CN/versioning.md)（Phase E 将其纳入完整文档套件）：

- 写给作者的三句话：`engines.universe` 声明的是 **API 版本**（= extension-api 包版本），不是编辑器版本；推荐区间 `">=0.7.0 <1.0.0"`（下界 = 你实际用到的最低 API）；**不要用 `^0.x`**（caret 在 0.x 下会把兼容的 minor 新增也挡掉——`COMPATIBILITY.md` 已论证，照搬）。
- **宿主 API 版本要可查询**：作者需要知道"用户装的编辑器支持到哪版 API"。落点：关于对话框 / `--version` 输出里带 `extension API: 0.7.0`；编辑器 Release Notes 每次带 API 版本。实现是把 host 内嵌的 extension-api version 暴露给 about/version 链路（小改动，本阶段做）。
- 0.x 语义（minor 即可 breaking）在 npm README、versioning.md、Release Notes 三处**反复**声明——这是内部阶段唯一的低成本试错窗口，对外预期必须打足。

## 5. 内网 fallback：市场服务器托管 tarball

完全离线内网（拉不到公网 npm）的兜底，**低成本顺手做**：发布流程里 `npm pack` 产出的 `.tgz` 同步传给市场服务器静态托管（`{base}gallery/sdk/`），作者 `npm i https://<market>/gallery/sdk/universe-editor-extension-api-0.7.0.tgz`。不建私有 registry（Verdaccio 等）——多一个常驻服务不值得，tarball URL 安装对 npm/pnpm 都原生支持。

## 6. 验证（Phase A 完成标准）

```bash
# 在仓库外的空目录（真·仓库外，不是 workspace 子目录）：
npm init -y && npm i @universe-editor/extension-api @universe-editor/extension-manifest typescript
# 写一个最小扩展：activate() 里 commands.registerCommand + 导入 FoldingRangeKind（运行时值）
npx tsc --noEmit          # 类型自包含：不额外装任何 @types 即通过
node -e "import('@universe-editor/extension-api').then(m=>console.log(m.version))"   # 运行时可加载
```

外加：`npm pack --dry-run` 内容清单 review 通过；`docs/development/` 发布手册落地。

## 7. 坑与注意

- **d.ts 自包含性是这个阶段最容易翻车的地方**：仓库内 hoist 掩盖依赖缺失（见 §2.1）。验证必须在仓库外空目录 + 干净 npm cache 做。
- **`enum` 继续用普通 enum 非 const enum**（既有红线，`isolatedModules` 下 TS2748）——对外后这条从"仓库约定"升级为"API 设计规则"，写进 COMPATIBILITY.md。
- **发布是单向门**：包名、`engines.universe` 的语义解释（API 版本而非编辑器版本）一旦进了第三方代码就锁死。本阶段所有命名决策按"不可再改"的标准过目。
- extension-api 的 `README` 别复制 docs 长文——npm 页面只留定位 + 最小示例 + 链接，真相单一在 docs/extension-dev（Phase E）。
