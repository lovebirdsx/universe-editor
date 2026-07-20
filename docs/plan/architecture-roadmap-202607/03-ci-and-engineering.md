# 03 · CI 与工程化

> 依据：[06-extensions-engineering.md](../architecture-review-202607/06-extensions-engineering.md) P2 #1/#2 + P3 若干。
> 批次：任务 1 第一批（P1）；任务 2-4 第二批（P2）；机会型见末尾。

## 任务 1：CI 三板斧 ⬜（P1，第一批，预估 0.5 天）

**背景**：`ci.yml` 全文无 `concurrency:` / `timeout-minutes:`；package-windows 每个 PR 无条件跑完整 Windows 打包（ci.yml:490-493）。同一 PR 连续 push 排队跑全量流水线，挂死 job 只能等 GitHub 默认 6h。这是当前 CI 成本/时长的最大杠杆，改动只有几行 yaml。

**步骤**：

1. workflow 顶层加 `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`（main push 分组可豁免 cancel，保留全量兜底记录）。
2. 每个 job 加 `timeout-minutes`（按历史时长 P95 + 50% 余量设置，e2e/package 类放宽）。
3. package-windows 降频：仅 main push / tag / 手动触发 / 打包相关路径变更（electron-builder.yml、runtime-resources、vendor、installer.nsh 等）时运行——路径 diff 可并入 detect-affected 已有机制。

**验证**：PR 上连续 push 两次，旧 run 被取消；无关 PR 不再触发 package-windows；main push 仍全量。

## 任务 2：extensions-external typecheck 入 CI ⬜（P2，第二批，预估 0.5 天）

**背景**：三个外置扩展（pdf/eslint/excel-diff）都有 `"typecheck": "tsc --noEmit"` 脚本，但 e2e-external job 只 build+e2e（ci.yml:407,417），`run-external-e2e.mjs` 只跑 esbuild；turbo 覆盖不到 workspace 外。类型错误只要不炸 bundle 就带病过 CI。

**步骤**：把三个外置扩展的 typecheck 纳入 e2e-external job（或 detect-affected 后的轻量独立 job），触发条件复用现有 `EXTERNAL_SUITES` 路径 diff。

**验证**：在外置扩展里埋一个类型错误，CI 必须红。

## 任务 3：扩展激活失败回传用户可见 ⬜（P2，第二批）

**背景**：`activationService.ts:111-113` activate 抛错只 console.error 到 host stderr，用户装了坏扩展会"静默无功能"，对市场生态口碑重要。

**步骤**：

1. host → renderer 加 `$onActivationError` 事件（extension-host RPC 协议 + renderer 侧 MainThread 桥）。
2. renderer 落两处：通知（notification）+ Extensions 视图对应扩展条目的错误徽标（点开可见错误 message/stack）。
3. 测试：host 侧单测（激活抛错 → 事件发出）；renderer 侧单测（事件 → 通知 + 徽标状态）；可选 e2e（装一个 activate 必炸的 fixture 扩展）。

## 任务 4：`engines.universe` 发布侧强制必填 ⬜（P2，第二批）

**背景**：`extensionScanner.ts:112` 只在声明了区间时才校验（fail-open）；开放市场后未声明兼容区间的扩展会在 API 演进时静默坏掉。

**步骤**：gallery publish 脚本（`scripts/gallery/*.mjs`）校验 manifest 必含 `engines.universe`，缺失拒绝发布；扫描端 fail-open 行为保留（兼容已装扩展），仅发布侧闭环。三个外置扩展作金丝雀确认都已声明。

---

## 机会型任务（P3，随迭代顺手做）

- ⬜ turbo 各步骤加 `--summarize` 上传 summary 工件，回答缓存命中健康度；`e2e.outputs` 移除 test-results（`turbo.json:27,32`，trace/截图/视频推高缓存体积）。
- ⬜ startup-metrics / bench / bundle-size 三类观测产物补跨 run 对比消费闭环（小脚本对比 base run 工件 + PR 评论），observe-only 升级为"回归可见"；启动耗时软报告择机升 hard 门禁。
- ⬜ docs:check 扩到 docs/plan、docs/development（`scripts/check-doc-links.mjs:19`）+ 锚点校验；清理 `docs/plan/extension-marketplace-plan/README.md:252-253` 末尾的生成残片（`</content>`/`</invoke>`）；docs/plan 加一张各 plan 状态索引。
- ⬜ claude-helper 扩展补测试并纳入 affected 矩阵；numbered-bookmarks 补 e2e。
- ⬜ 1.0 冻结路线节奏约束：0.x 期间每次 extension-api minor bump，给三个外置扩展跑一次 `engines` 下界抬升演练。
