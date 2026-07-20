# 06 · 扩展系统与工程化

> 均为事实核实（文件:行号可复核），推测处标注。

## ① 现状速写

### A. 扩展系统

**运行时架构**：VSCode 范式的独立 extension host 子进程（`ELECTRON_RUN_AS_NODE` 跑 `packages/extension-host` 的 esbuild 单文件 bundle），stdio 换行分帧 JSON RPC，复用 platform 的 ChannelServer/ProxyChannel；RPC 对端是 renderer（main 只搬字节）。renderer 侧 16 个 `MainThread*` 桥文件，覆盖 commands/window/scm/fs/languages/editor/output/storage/webview/ai。

**单 host + Workspace Trust（已核实落地）**：
- 单 host：`ExtensionHostClientService.ts`（525 行）单连接；内置 + 外置同进程、同 API 权限。
- 激活门控 `packages/extension-host/src/activationService.ts:68-83`：不受信工作区中 `capabilities.untrustedWorkspaces.supported:false`（或缺省）的扩展不激活，对齐 VSCode；`'limited'` 照常激活由扩展自查 `workspace.isTrusted`。
- built-in 豁免：`activationService.ts:71`；Restricted 模式 UI：状态栏 shield + 首开弹窗 + Grant/Revoke/Manage 三命令；授予信任动态 replay 已 fire 的激活事件，撤销重启 host。信任服务在 `packages/platform/src/workspace/workspaceTrust.ts`（最长父前缀继承）。

**built-in vs external 双轨制**：

| | `extensions/*`（7 个） | `extensions-external/*`（3 个：pdf/eslint/excel-diff） |
|---|---|---|
| workspace | pnpm workspace + turbo 图内 | 不在 workspace；esbuild 从 `extensions/typescript` "借"（`eslint/esbuild.config.mjs:22-26`） |
| 分发 | `runtime-resources.mjs stage` → electron-builder `extraResources` | `.vsix` 打包，走市场/本地安装 |
| CI affected | turbo `...[base]` 图计算 | git 路径 diff（`EXTERNAL_SUITES` + 共享设施 fan-out） |
| e2e | 4 个自有套件 + git 由核心套件覆盖 | `--extensionDevelopmentPath` 磁盘加载，不装 vsix |

e2e 最小激活集经 `UNIVERSE_ENABLED_EXTENSIONS` allowlist（`e2e-harness/src/launch.ts:26`，host 侧 `bootstrap.ts:274-275` 消费）。

**API 兼容策略（成熟度超预期）**：`packages/extension-api/COMPATIBILITY.md` 是正式兼容承诺——版本即 API 版本（当前 0.5.0）、semver 口径表、`engines.universe` 协商语义、弃用机制、1.0 冻结条件；可执行抓手是契约测试（冻结 `RUNTIME_EXPORTS` + 逐 namespace 方法快照）；semver 校验 fail-closed（`extensionScanner.ts:112-113`）。

**Marketplace/gallery（已基本落地）**：plan 自述 Phase A–D + F 完成、Phase E（硬隔离+签名）后置。客户端 extension-gallery（`/extensionquery` 协议）+ extension-packaging（VSIX）+ main 侧 gallery/management 服务（6h TTL 恶意/弃用 control manifest）；UI ExtensionsView + ExtensionEditor；服务端 `scripts/server/server.mjs` 零依赖静态服务器，发布运维 `scripts/gallery/*.mjs`。`GALLERY_URL` 默认空 = 市场禁用。

### B. 工程化 / 构建 / 测试 / 发布

- **turbo**：任务图小而清晰；`turbo.json:3` 高质量注释解释非显然决策。CI 缓存 `actions/cache` 存 `.turbo`，key=`turbo-{os}-{sha}`；无 remote cache、无命中率度量。
- **依赖治理**：catalog 覆盖率非常高且例外都有注释（electron-updater、mermaid pin 等）；`allowBuilds`/`patchedDependencies` 显式管控。
- **构建/打包**：electron-vite 三端；dev 下 platform/workbench-ui alias 到 src。打包 asar + 精确 asarUnpack；vendor submodule 产物 + 内置扩展 + docs 经 `runtime-resources.mjs stage` 进 extraResources，配 `verify-source`/`verify-packaged` 校验；electronLanguages 裁 locale 省 ~39MB。更新链 generic provider + `latest.yml`/blockmap，`autoDownload=false` + `autoInstallOnAppQuit`，发布版可运行时覆盖 feed；NSIS 自定义 installer.nsh。
- **测试基建**：vitest 三 project（main-node / renderer-node / renderer-dom，DOM 测试显式登记 fail-loud）；e2e 核心 82 spec + 4 内置扩展套件 + 3 外置套件；e2e-harness/e2e-contract 基座包；tag 分级治理（@p0/@p1 阻塞、@regression 独立趟、@serial 单 worker、@flaky continue-on-error、@perf 观测）+ RUNBOOK 登记册；affected 矩阵（PR 走 turbo affected，main push 全量兜底），矩阵脚本自身有 node:test 且入 CI 门禁。
- **CI**：单 workflow：ci → integration / detect-affected / bench(软) / package-windows；e2e 2 OS × 2 shard；三类观测产物上传。**无 `concurrency` 组、无 `timeout-minutes`**；package-windows 每个 PR 无条件跑完整 Windows 打包。
- **文档**：分层 CLAUDE.md 质量高；docs/user + `pnpm docs:check` 死链校验入 CI；plan 文档带实施状态回写；maintainability-roadmap 的"核实纪要"（记录被否决的调研结论）是少见的文档纪律。

## ② 做得好的点

1. **API 兼容承诺是"文档 + 可执行快照"双件套**，生态基石在开市场之前就位。
2. **Workspace Trust 照抄 VSCode 而非发明**，连"为什么放弃双 host"都有 memory/skill 记录可追溯。
3. **e2e 分级 + affected 矩阵 + RUNBOOK 三件套**是治理 flaky 的正确形态。
4. **打包链路可验证**：verify 脚本把"extraResources 是否带全"变成断言而非人肉。
5. **注释解释"为什么"**：turbo.json、electron-builder.yml、CI 非显然 step 都有因果注释。
6. catalog 例外显式登记、脚本层（release/gallery/matrix）有自己的测试且入 CI 门禁。

## ③ 问题清单

### P2

1. **CI 无 concurrency 取消组、无任务超时** — `ci.yml` 全文无 `concurrency:` / `timeout-minutes:`。同一 PR 连续 push 会排队跑完整流水线（含每 PR 无条件的 package-windows，ci.yml:490-493 无 if 条件）；挂死 job 只能等 GitHub 默认 6h。【推测】这是当前 CI 成本/时长的最大杠杆。
2. **extensions-external 的 typecheck 不在任何 CI 门禁** — 三个外置扩展都有 `"typecheck": "tsc --noEmit"`（如 `excel-diff/package.json:37`），但 e2e-external job 只 build+e2e（ci.yml:407,417），`run-external-e2e.mjs` 只跑 esbuild（不查类型），turbo 又覆盖不到 workspace 外。类型错误只要不炸 bundle 就能带病过 CI。

### P3

3. **扩展激活失败对用户不可见** — `activationService.ts:111-113`：activate 抛错只 console.error 到 host stderr，不回传 renderer、无通知/视图标记。市场生态下用户装了坏扩展会"静默无功能"。
4. **`engines.universe` 缺省时不校验放行**（fail-open）— `extensionScanner.ts:112` 只在声明了区间时才校验。开放市场后建议发布侧强制（gallery publish 校验必填）。
5. **计划文档残留生成碎片** — `docs/plan/extension-marketplace-plan/README.md:252-253` 末尾是字面量 `</content>` / `</invoke>`。
6. **docs:check 只覆盖 docs/user** — `scripts/check-doc-links.mjs:19`；docs/plan、docs/development 互链无校验，锚点校验是脚本自述的 phase-2。
7. **turbo 缓存可观测性为零 + 多 job 同 key 保存竞争** — 六个 job 共用 `turbo-{os}-{sha}` 各自保存 `.turbo`（同 run 后到者保存失败仅告警），实际入缓存内容取决于 job 完成顺序；无 `--summarize`/命中率上报。
8. **e2e 的 playwright-report/test-results 进 turbo outputs** — `turbo.json:27,32`：trace/截图/视频计入缓存条目，推高体积。【推测：未见容量治理】
9. **claude-helper 扩展零测试**，也不在 affected 矩阵套件之列；numbered-bookmarks 有单测但无 e2e。改动它们只有 lint/typecheck 兜底。
10. **更新 feed 为明文 http** — `electron-builder.yml:19`。内网自建是注释写明的刻意选择，且 electron-updater 校验 latest.yml 的 sha512；威胁模型限定"内网可信"，走出内网前需 TLS + 代码签名（Phase E 已登记，此处仅提示前置依赖）。
11. **`rendererDomTests` 手工登记清单**（`vitest.config.ts:14-37`，约 22 项）— 有 fail-loud 兜底属可接受债，清单在缓慢膨胀。
12. **workbench-ui peerDependencies 硬编码 `^19.0.0`** — 靠人工与 catalog 同步，实际漂移风险很低。

## ④ 方向性建议

### 扩展生态策略

- **把"软隔离"的诚实边界产品化**：受信工作区内所有扩展持全量 Node 能力是已登记的事实；市场 UI 持续如实呈现"安装≈信任该发布者"。下一个性价比最高的硬化点不是 Node 权限模型（已验证过不可靠），而是 **VSIX 发布侧强制**：publisher 必填（已做）+ `engines.universe` 必填（补 gallery publish 校验，闭掉 fail-open）+ 后续签名。
- **激活错误链路补全**：host → renderer 加 `$onActivationError` 事件，落到通知 + Extensions 视图徽标，成本低、对生态口碑重要。
- **1.0 冻结路线加节奏约束**：冻结条件里"语言 provider 全量迁移"是最大未决项；0.x 期间每次 minor bump 给三个外置扩展（生态金丝雀）跑一次 `engines` 下界抬升演练。
- **双轨制保留但补齐门禁**：extensions-external 作为"吃自己市场狗粮"的样板设计合理；把 typecheck 纳入 e2e-external job 或 detect-affected 后的轻量 job，双轨成本差距即基本抹平。

### 工程化演进

- **CI 第一优先级：`concurrency` + `timeout-minutes` + package-windows 降频**（main push / tag / 手动触发 / 相关路径变更才跑——可并入 detect-affected 已有的路径 diff 机制）。
- **turbo 缓存加观测**：各步骤加 `--summarize` 上传 summary 工件即可回答命中健康度；`e2e.outputs` 移除 test-results。CI 时长继续增长再考虑 remote cache（可复用 `scripts/server` 静态思路）。
- **观测产物补消费闭环**【推测性建议】：startup-metrics / bench / bundle-size 都在上传但无跨 run 趋势对比；小脚本对比 base run 工件 + PR 评论，把 observe-only 升级为"回归可见"，与现有软门禁哲学一致。
- **文档体系**：docs:check 扩到 docs/plan、docs/development + 锚点校验；清掉 marketplace README 残片；在 docs/plan 加一张各 plan 状态索引，避免完成态 plan 与 memory 双源漂移。
- **维持现有纪律**：核实纪要（否决夸大结论）与 RUNBOOK 的 flaky 判定标准是这个仓库工程文化里最值钱的两样东西，任何流程演进都不应稀释"每条结论挂证据"的门槛。
