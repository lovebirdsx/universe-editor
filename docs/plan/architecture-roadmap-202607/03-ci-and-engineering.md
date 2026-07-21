# 03 · CI 与工程化

> 依据：[06-extensions-engineering.md](../architecture-review-202607/06-extensions-engineering.md) P2 #1/#2 + P3 若干。
> 批次：任务 1 第一批（P1）；任务 2-4 第二批（P2）；机会型见末尾。

## 任务 1：CI 三板斧 ✅（P1，第一批，预估 0.5 天）

> 已完成（2026-07-20）：ci.yml 顶层加 `concurrency`（PR 取消旧 run，main push 按 SHA 分组不取消保留全量兜底）；8 个 job 全部加 `timeout-minutes`（ci/integration 20、detect-affected 10、e2e 45、extensions/external 30、bench 25、package-windows 60）；package-windows 改 `needs: detect-affected` + `if: package-windows == 'true'`，新增输出由 `affected-e2e-matrix.mjs` 的 `computeShouldPackage` 纯函数按打包机制路径（electron-builder.yml/build/package.json/electron.vite.config.ts/scripts/release/vendor/lockfiles）计算，main/tag/手动走 `--all` 强制全量。纯函数已补 3 个路由单测。

**背景**：`ci.yml` 全文无 `concurrency:` / `timeout-minutes:`；package-windows 每个 PR 无条件跑完整 Windows 打包（ci.yml:490-493）。同一 PR 连续 push 排队跑全量流水线，挂死 job 只能等 GitHub 默认 6h。这是当前 CI 成本/时长的最大杠杆，改动只有几行 yaml。

**步骤**：

1. workflow 顶层加 `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`（main push 分组可豁免 cancel，保留全量兜底记录）。
2. 每个 job 加 `timeout-minutes`（按历史时长 P95 + 50% 余量设置，e2e/package 类放宽）。
3. package-windows 降频：仅 main push / tag / 手动触发 / 打包相关路径变更（electron-builder.yml、runtime-resources、vendor、installer.nsh 等）时运行——路径 diff 可并入 detect-affected 已有机制。

**验证**：PR 上连续 push 两次，旧 run 被取消；无关 PR 不再触发 package-windows；main push 仍全量。

## 任务 2：extensions-external typecheck 入 CI ✅（P2，第二批，预估 0.5 天）

> 已完成（2026-07-21）。落地：
> - **先修阻塞项**：pdf/excel-diff 的 `typecheck` 原为裸 `tsc`（二者无本地 tsc，脚本本会失败）→ 改为 `node ../../extensions/numbered-bookmarks/node_modules/typescript/bin/tsc --noEmit`（对齐其 esbuild.config 已有的 numbered-bookmarks 借用模式；eslint 扩展本就借 typescript 扩展的 tsc，保留不动）。
> - **CI 接入**：`ci.yml` 的 `e2e-external` job 在 Excel `npm ci` prep 之后、e2e run 之前加 `Typecheck external extension` 步骤（`npm --prefix … run typecheck`）。复用现有 `has-external` + per-suite matrix 门控，无需改 `affected-e2e-matrix.mjs`；excel 的 xlsx 类型由既有 prep 步骤提供。
> - **破坏性验证**：pdf 埋 `const x: number = 'str'` → typecheck 红（TS2322）；revert 后绿。三个扩展 typecheck 本地均 exit 0。

**背景**：三个外置扩展（pdf/eslint/excel-diff）都有 `"typecheck": "tsc --noEmit"` 脚本，但 e2e-external job 只 build+e2e（ci.yml:407,417），`run-external-e2e.mjs` 只跑 esbuild；turbo 覆盖不到 workspace 外。类型错误只要不炸 bundle 就带病过 CI。

**步骤**：把三个外置扩展的 typecheck 纳入 e2e-external job（或 detect-affected 后的轻量独立 job），触发条件复用现有 `EXTERNAL_SUITES` 路径 diff。

**验证**：在外置扩展里埋一个类型错误，CI 必须红。

## 任务 3：扩展激活失败回传用户可见 ✅（P2，第二批）

> ✅ 已完成（2026-07-21）：
> - **协议**：rpc.ts 新增 `mainThreadExtensions` 通道 + `IMainThreadExtensions.$onActivationError(IExtensionActivationErrorDto)`（extensionId/displayName/message/stack）。
> - **host 侧**：`ExtensionActivationService` 构造加第 5 个可选参 `onActivationError` 回调；`_doActivate` catch 在 console.error 之外调回调上报。`ExtensionService` 新增 `mainThreadExtensions` 构造参并把回调接到 activation；bootstrap.ts 装配该 proxy 并传入。
> - **renderer 侧**：新增 `MainThreadExtensions` 桥 + HostConnection 注册通道（`onActivationError` dep）；`ExtensionHostClientService` 新增 `onDidActivationError` 事件 + 失败时弹 error 通知；`ExtensionsWorkbenchService` 订阅事件维护 `_activationErrors` 表并写入 `IExtensionEntry.activationError`（host 重启/relaunch 时随 `onDidChangeContributions` 清空）；`ExtensionsView` 渲染 "Activation Failed" 错误徽标（`data-testid="extension-activation-error"`，title 显示 stack/message）。
> - **测试**：host 侧 2 例（抛错→上报含 displayName/message/stack；成功→不上报）；renderer 侧 2 例（事件→entry.activationError + onDidChange 触发；host relaunch→清空）。`pnpm check` 全绿。可选 e2e fixture 未做。

**背景**：`activationService.ts:111-113` activate 抛错只 console.error 到 host stderr，用户装了坏扩展会"静默无功能"，对市场生态口碑重要。

**步骤**：

1. host → renderer 加 `$onActivationError` 事件（extension-host RPC 协议 + renderer 侧 MainThread 桥）。
2. renderer 落两处：通知（notification）+ Extensions 视图对应扩展条目的错误徽标（点开可见错误 message/stack）。
3. 测试：host 侧单测（激活抛错 → 事件发出）；renderer 侧单测（事件 → 通知 + 徽标状态）；可选 e2e（装一个 activate 必炸的 fixture 扩展）。

## 任务 4：`engines.universe` 发布侧强制必填 ✅（P2，第二批）

> ✅ 已完成（2026-07-21）：发布侧闭环**此前已存在**——`scripts/gallery/lib.mjs` 的 `metadataFromManifest` 在缺 `engines.universe` 时抛错（`扩展 p.x 缺少 engines.universe`），publish.mjs 每个 VSIX 都过此校验，缺失即拒绝发布。本任务补齐验证与测试：
> - **测试**：`scripts/gallery/__tests__/lib.test.mjs` 已有 "缺 engine 抛错" 例，新增一例覆盖 `engines.universe` 空串 + `engines` 空对象两种边界（共 8 例全绿，`node --test`）。
> - **金丝雀**：三个外置扩展均已声明——pdf `>=0.2.0 <1.0.0`、excel-diff / eslint `>=0.4.0 <1.0.0`。
> - **扫描端 fail-open 保留**：`extensionScanner.ts` 仅在 `hostApiVersion` 与声明区间不兼容时才抛错；manifest schema（`z.object({ universe: z.string().min(1) })`）保证已装扩展仍能加载，未动。

**背景**：`extensionScanner.ts:112` 只在声明了区间时才校验（fail-open）；开放市场后未声明兼容区间的扩展会在 API 演进时静默坏掉。

**步骤**：gallery publish 脚本（`scripts/gallery/*.mjs`）校验 manifest 必含 `engines.universe`，缺失拒绝发布；扫描端 fail-open 行为保留（兼容已装扩展），仅发布侧闭环。三个外置扩展作金丝雀确认都已声明。

---

## 机会型任务（P3，随迭代顺手做）

- ⬜ turbo 各步骤加 `--summarize` 上传 summary 工件，回答缓存命中健康度；`e2e.outputs` 移除 test-results（`turbo.json:27,32`，trace/截图/视频推高缓存体积）。
- ⬜ startup-metrics / bench / bundle-size 三类观测产物补跨 run 对比消费闭环（小脚本对比 base run 工件 + PR 评论），observe-only 升级为"回归可见"；启动耗时软报告择机升 hard 门禁。
- ⬜ docs:check 扩到 docs/plan、docs/development（`scripts/check-doc-links.mjs:19`）+ 锚点校验；清理 `docs/plan/extension-marketplace-plan/README.md:252-253` 末尾的生成残片（`</content>`/`</invoke>`）；docs/plan 加一张各 plan 状态索引。
- ⬜ claude-helper 扩展补测试并纳入 affected 矩阵；numbered-bookmarks 补 e2e。
- ⬜ 1.0 冻结路线节奏约束：0.x 期间每次 extension-api minor bump，给三个外置扩展跑一次 `engines` 下界抬升演练。
