# claude-agent-acp 独立维护

`vendor/claude-agent-acp` 是 **git submodule、独立维护的 fork**，不在 pnpm workspace 内，用它自带的 npm 工具链独立构建（启动/打包机制见根 `CLAUDE.md`「内置 ACP agent」节）。上游是 `agentclientprotocol/claude-agent-acp`（npm `@agentclientprotocol/claude-agent-acp`，Apache-2.0，作者 Zed Industries）。

维护重心是**维护产品行为契约、选择性吸收上游变化**，不再是「回放补丁、保持与上游 diff 最小」。`codex-acp` 沿用原有策略，本文件只覆盖 Claude adapter；跨 fork 行为对照仍保留。

流程细节在 skill `update-claude-agent-acp`，历史案例在其 `.claude/skills/update-claude-agent-acp/references/cases.md`；fork 自身的行为清单与维护红线在 `vendor/claude-agent-acp/CLAUDE.md`。

## 边界：产品行为 vs SDK / CLI / ACP / transcript

adapter 维护**会话生命周期、历史恢复和编辑器消费的 ACP 输出与 `_meta` 形状**。底层依赖分别跟踪、各自成批，不夹在结构重构或功能改动里：

- **SDK**（`@anthropic-ai/claude-agent-sdk`）：把 ACP 请求翻成 SDK query、把 SDK 事件映回 ACP。返回形状易变，改动集中到窄接口。
- **CLI**（Claude Code 二进制）：控制请求单通道串行等运行时特性由它决定；构建期采样本机二进制版本写入 `dist/claude-binary.json` 的 `cliVersion`（与 SDK 包版本是不同命名空间）。
- **ACP SDK**（`@agentclientprotocol/sdk`）：client/agent wire 契约。
- **transcript**（会话 `*.jsonl` 与 `subagents/agent-*.jsonl`）：回放、压缩重建、fork 锚点解析的输入格式。

## 基线台账

SHA 记录当前 P2 起点；下表测试结果保留为**首批验收历史**，其中「本批」指首批 AIR 退役。P2 实测结果单列在下方，不覆盖历史记录。

| 项 | 值 | 说明 |
|---|---|---|
| P2 起点 SHA | `b868c673531547b60f9abf1ca8c31cc67a5b279a` | 前批 AIR 退役与门禁已提交；主仓起点 `e8b3c229`。本批纯历史解析整理尚未提交，fork HEAD 未动 |
| 最后整体吸收的上游 SHA | `a44c486` | 分叉点（`#1243`）；**已审阅到的上游 SHA ≠ 其变更已吸收** |
| `@anthropic-ai/claude-agent-sdk` | `0.3.287` | fork `package.json` dependencies |
| `@agentclientprotocol/sdk` | `1.7.0` | 同上 |
| CLI 版本（协议验证用） | `2.1.287` | 真实 CLI 路由已执行：经 CLI 自支持的 `ANTHROPIC_CUSTOM_MODEL_OPTION` 可**无凭据**成功切换；真实模型请求、生产网关与 SDK 历史复制仍未验证 |
| fork `typecheck` / `lint` | 通过 | 基线、AIR 退役后与新增测试后均通过 |
| fork 单测 | 基线 2713 通过 / 31 跳过 / 1 失败；本批 **2427 通过 / 31 跳过 / 0 失败** | 删除 AIR 专属生产代码、40 个 AIR golden 快照与专属测试后，原先的 AIR 回放快照顺序失败一并消失；plain / zed / v2 场景不受影响 |
| `pnpm agent:build` | 通过 | 两个 adapter 均重建成功 |
| 跨仓契约测试 | 无 CLI：**30 通过 / 7 跳过**；真实 CLI：**37 通过 / 0 失败** | 7 条跳过项需真实 Claude 二进制；真实 CLI 用例隔离用户配置（临时 `CLAUDE_CONFIG_DIR`）并剥离网关环境变量 |
| `pnpm check` | 通过 | 常规运行未启用跨仓契约：该文件 5 通过 / 32 跳过；不替代上述显式启用的验证 |
| `pnpm check:full` | 通过 | 94 / 94 任务成功，其中 85 个命中缓存 |
| 定向 Electron E2E | 1 通过 / 1 跳过 | agents 与会话创建性能 spec；性能标签被入口过滤，未验证真实创建性能 |
| `pnpm e2e:smoke` | 106 通过 | 核心冒烟 |
| `pnpm e2e` | 成功退出，存在重试 | 26 / 26 任务成功，其中 21 个命中缓存；core 并行 298 通过 / 3 跳过 / 3 flaky，串行 11 通过；未单独运行 `pnpm e2ea` |

测试结果由实施/验收批次回填，分别记录通过、失败、跳过与环境限制；**不把失败直接归为已知 flake**。

## 功能契约表

稳定 ID 供测试与评估台账引用。验证层级：离线单测 / 真实 dist / 真实 CLI；缺真实 CLI 的选跑腿必须明确标「未执行」，不被 mock 覆盖。

| ID | 必须成立的行为 | 实现入口（fork `src/`） | fork 测试 | 主仓测试 | 验证层级 |
|---|---|---|---|---|---|
| CT-COMPACT-RESTORE | 已压缩会话恢复保留压缩前显示内容与 steering；缺磁盘历史时正确降级 | `acp-agent.ts`（`loadSession` / `replaySessionHistory`）、`transcript-history.ts`（`rebuildTranscriptDisplayChain`）、`resumed-session.ts` | `session-contract-guards.test.ts`（实际 load）、`acp-agent.test.ts`（replay across compaction）、`transcript-history.test.ts` | `apps/editor/src/renderer/services/acp/session/__tests__/AcpSession.timeline.test.ts` | 离线；真实 CLI 历史恢复未验证 |
| CT-FORK-ANCHOR | 指定位置分叉：活跃与休眠/新实例均正确定位；显式锚点不存在即报错，不退化成整份复制 | `acp-agent.ts`（`unstable_forkSession` / `forkSliceBefore` / `foldedPromptForkPoint`）、`transcript-history.ts`（`findFoldedPromptParent`） | `session-contract-guards.test.ts`、`acp-agent.test.ts`（rewind/fork）、`transcript-history.test.ts` | `apps/editor/src/renderer/services/acp/session/__tests__/AcpSession.poolResume.integration.test.ts` | 离线；真实 SDK 复制未验证 |
| CT-SUBAGENT | 非 AIR 输出含 editor 可识别的子 Agent 信息；归属正确、完成即结束；自引用父 ID 不污染状态 | `tools.ts`、`subagent-history.ts`、`acp-agent.ts` | `session-contract-guards.test.ts`（实际 prompt）、`tool-call-contract.test.ts`、`tools.test.ts` | `apps/editor/src/renderer/services/acp/session/__tests__/acpSessionUpdateMeta.test.ts`、同目录 `AcpSession.timeline.test.ts` | 离线；真实子 Agent 业务未验证 |
| CT-CONTROL-CHANNEL | 新会话首 turn 前不发阻塞性上下文查询；load 不等不必要控制请求；后台刷新只在合法阶段执行 | `acp-agent.ts`（`hasStartedTurn`、`refreshContextWindowInBackground`） | `create-session-options.test.ts`、`session-config-options.test.ts`（deferred 控制请求） | `apps/editor/integration/scenarios/acpForkContract.integration.test.ts` | 离线；真实 CLI 配置路由通过（见验收记录） |
| CT-CONFIG-KEEP | new/load/fork/rewind 的关键 model/effort/权限设置符合现有约定 | `session-config-ids.ts`、`session-model.ts`、`session-effort.ts` | `resumed-model-sync.test.ts`、`session-config-options.test.ts`、`session-contract-guards.test.ts`（合成 fork transcript 的 model/mode 恢复） | `apps/editor/src/renderer/services/acp/session/__tests__/AcpSessionService.test.ts` | 离线；真实 fork 后配置及 effort 继承未验证 |
| CT-EXT-METHODS | editor 常量表与约定 wire 名一致；dist 包含被测扩展名；选定方法可路由且校验参数 | `acp-agent.ts`（method 常量与路由） | `tools.test.ts` | `apps/editor/integration/scenarios/acpForkContract.integration.test.ts`（消费 `acpExtMethods.ts`） | 离线常量 + dist 字符串检查/握手 + 真实 CLI 部分路由；不等同于所有扩展的行为覆盖 |
| CT-COST-USAGE | turn 中途 `usage_update` 携带成本明细；订阅额度用量运行时特性探测 | `session-cost.ts`、`usage.ts` | `session-cost.test.ts`、`usage.test.ts` | — | 离线 |
| CT-LEGACY-AIR | 旧 AIR capability 输入不再启用专属协议：`initialize` 不回显、不广告 AIR；fork 忽略 AIR 的 fork 锚点，退回无锚点 tip fork | `acp-agent.ts`（`initialize` 应答、`unstable_forkSession` 锚点解析）、`tool-calls/client-capabilities.ts` | `session-contract-guards.test.ts`（「旧 AIR capability 输入不再启用专属协议」） | — | 离线 |

契约清单可增长：新增行为先加行、再加走生产入口的测试。主仓拥有一部分独立验收契约，不能为适配 fork 输出退化而同步放宽断言。

### 首批验收记录

本批包含三块：契约守卫测试、AIR 退役清理、验证门禁。

1. **契约守卫**：新增 `vendor/claude-agent-acp/src/tests/session-contract-guards.test.ts`，共 **8 个用例**——原有 5 个（实际 `session/load` 入口的压缩 / steering 恢复与无磁盘降级、`unstable_forkSession` 的磁盘锚点解析与 fork 后 model / mode 恢复、非 AIR `Task` / `Agent` 启动归属与完成）+ 1 个 `session/load` 后台用量刷新（独立于 AIR 的能力契约）+ 2 个「旧 AIR capability 输入不再启用专属协议」（`initialize` 不回显、不广告 AIR；fork 忽略 AIR 的 fork 锚点，退回无锚点 tip fork）。数据写入独立临时目录，不访问用户历史。fork 测试的 SDK 复制是 mock：断言锚点参数与合成产物的恢复，不声称验证真实 SDK 复制。
2. **AIR 退役清理**：删除 AIR 生产专属代码（`src/air-extension.ts`、AIR 版 `async-tasks.ts` / `file-change-audit.ts` / `goal-extension.ts` / `context-compaction-meta.ts` / `tool-calls/background.ts` 等）、40 个 AIR golden 快照（`src/tests/acp-scenarios/__snapshots__/air/`）与 AIR 专属测试文件，fork 内的 AIR 扩展文档 `air-extensions.md` 一并删除。**plain / zed / v2 场景不受影响**；**共享行为保留**：tip fork（SDK `forkSession`）、磁盘锚点解析、native 子 Agent 与后台通知（`_universe/background_activity`）。
3. **门禁**：CI 增加 fork `typecheck` 与离线单测（剥离宿主网关环境变量）；契约测试显式启用且缺 fork dist 时必须失败，未启用时不干扰常规本地运行。负向验证：显式启用且 Claude dist 缺失时失败，同样缺产物但未启用时仍允许常规单测运行。

四类负向实验分别恢复错误的历史优先级、移除磁盘锚点匹配、移除非 AIR 工具名、移除首 turn 闸门，守卫均失败；随后生产文件逐字恢复。控制通道复用 `create-session-options.test.ts` 已有 deferred 用例，不重复新增。

**结果（本批本地实跑）**：fork 单测 2427 通过 / 31 跳过 / 0 失败，`typecheck` 与 `lint` 通过。跨仓契约测试：真实 CLI **37 通过 / 0 失败**；无 CLI **30 通过 / 7 跳过**（7 条为需真实 Claude 二进制的用例）。主仓检查与 Electron E2E 结果见基线台账。

#### 额外模型与切换失败归类（本批定位）

`_meta.extraModels` 只把客户端给的 id **追加进 model picker**，不证明该模型可用；真正的可切性由原生 CLI 在 `setModel` 时判定。因此不能把切换失败写成「`catalog_unknown`」，也不能断言必然是 `model_not_found`：

- **无凭据的原生 CLI**：拒绝理由是 `Unable to validate model: Could not resolve authentication method…`——切模型要先对着目录校验，没凭据就校验不了，属**缺认证**而非模型不存在。归 `authentication_required` → `RequestError.authRequired`（`-32000`）+ `errorKind: authentication_failed`，且**不发** `config_option_update`（被拒就不是成功）。
- **已认证网关不提供该 id**：返回 `Model id not found`（本轮以 gateway stub 实测到该文本），归 `model_unavailable` → `RequestError.invalidParams` + `errorKind: model_not_found`。
- **其余文本**归 `unrecognised` → `RequestError.internalError` + `errorKind: unknown`，**不回显 CLI 原文**：ACP 兜底会把原始错误文本塞进 `error.data.details`，成为任意文本（含凭据）的通道，因此不得原样 rethrow `RequestError`。

成功路径由真实 CLI 经其自支持的 `ANTHROPIC_CUSTOM_MODEL_OPTION` 声明一个非一方 id 覆盖——无凭据、无网关即可切换成功，该用例在 37 条通过之内。**这不等同于**验证了真实模型请求或生产网关可用性；本批未运行生产网关，也未发真实 prompt。

**老两验收阻断项已解决**：

1. `acp-scenarios.test.ts` 的 AIR `session-load-replay` 快照顺序失败——随 AIR 专属快照删除消失，相对顺序不必提升为契约。
2. 真实 CLI `session/new` 额外模型切换返回 `Internal error`——根因不是模型不存在，而是无凭据时原生 CLI 校验不了该 id；旧实现把该 SDK 错误原样透传成 `Internal error`（原文留在 details），现按实测文本归类为 `authentication_failed`，不再回显原文。不属环境污染，也无需放宽断言。

**验收保留项**：全量 E2E 的 `smoke.windows.spec.ts` 有 3 项首跑在 8 秒内未达到预期、重试后通过：新窗口加载目录、窗口列表数量、退出后关闭所有窗口。最后一项超时时仍有 2 个窗口。三项在本批冒烟中通过，但尚未定位全量运行的首跑超时原因，不能认定为既有 flake 或与本批无关；本批未修改窗口实现或放宽超时。真实模型请求、生产网关、真实 SDK 历史复制及 fork 后 effort 继承仍未验证；性能标签与独立 `e2ea` 回归套件不计入已验证范围。

## P2 第一批：纯历史解析边界整理

本批从 `acp-agent.ts` 迁出 `RawTranscriptEntry`、transcript 分类、显示链重建、queued-command 合并与共享 origin 常量，集中到 `transcript-history.ts`。新模块仅有 SDK type-only 导入，不依赖文件 IO、SDK runtime、ACP 或 agent 类，也不加入 `lib.ts` 公共 API。folded steering 仅抽出同步 `findFoldedPromptParent`；原方法仍在同一位置读盘、await 并处理失败。

显示链的压缩桥接、最新有效 leaf、环检测与废弃分支过滤保持不变；harness 过滤不进入 `isDisplayMessageEntry`，避免 backfill 漏扫 tool_result。主历史与 `tools.ts` 子 Agent sidechain 判据有意不同，不合并。文件定位、读写、SDK 调用、出站循环及后台调度仍在原边界；SDK/CLI/ACP 版本、快照和 codex 实现均未改。

- **测试迁移**：原 `acp-agent.test.ts` 的 28 个纯用例迁入 `transcript-history.test.ts`，新增 6 个 parent / source UUID / 有效链边界用例，共 34 个。生产入口测试保留，`session-contract-guards.test.ts` 仍为 8 个实际用例（Task / Agent 参数化展开）。
- **负向证明**：临时移除 `logicalParentUuid` 桥接，8 个纯函数用例及实际 `session/load` 压缩恢复守卫失败；精确恢复后，新模块与入口守卫 **42 / 42 通过**。没有重录快照。
- **fork 验收**：`typecheck`、`lint`、格式检查通过；全量 **2433 通过 / 31 跳过 / 0 失败**（50 个测试文件通过、3 个跳过）。
- **产物与跨仓契约**：`pnpm agent:build` 通过；真实 CLI `2.1.287` 下跨仓契约 **42 / 42 通过**。测试使用临时 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`，剥离宿主网关与凭据环境变量，不发模型 prompt。42 项包含前批后已提交的 codex 契约扩充，不是本批新增 5 项。
- **主仓全量检查**：`pnpm check:full` 通过，94 / 94 任务成功、93 个命中缓存；常规 integration 为 35 通过 / 37 跳过，不替代上述显式启用的真实 CLI 契约。
- **Electron E2E**：定向 `pnpm e2e specs/smoke.agents.spec.ts` 1 通过；`pnpm e2e:smoke` 106 通过。`pnpm e2e` 成功退出，26 / 26 任务成功、25 个命中缓存；editor core 本批实跑：并行 298 通过 / 3 跳过 / 3 flaky，串行 11 通过，扩展 suite 命中缓存。3 项窗口用例再次首跑超时、重试通过：新窗口加载目录、窗口列表数量、退出后关闭所有窗口；退出用例 8 秒后仍有 2 个窗口。未修改窗口逻辑或放宽超时，原因仍待单独定位。未单独运行 `pnpm e2ea`，不宣称覆盖完整回归套件。
- **收尾检查**：`pnpm check` 通过，文档链接、敏感串、知识导航与 CLAUDE 大小护栏通过；主仓及 fork `git diff --check` 通过，codex 工作树无变更。

本批只整理内部职责边界，无用户可见行为变化，已检查 `docs/user/`，无需同步。真实模型请求、生产网关、真实 SDK 历史复制及 fork 后 effort 继承仍未验证；不因本批结构整理声称前批窗口超时已修复。

## 后续范围（未开始）

纯历史解析第一批到此收尾。SDK/CLI 边界、生命周期与状态机重构留给之后的独立批次；不自动升级依赖、同步上游或启动下一轮重构。

## 上游评估记录

每轮评估固定比较范围，逐条记录；**已审阅到的上游 SHA 不代表其所有变化已吸收**。

| 评估批次 | 上游范围（起..止） | 变更（目的） | 影响判断 | 处置 | 原因 | 本地测试 |
|---|---|---|---|---|---|---|
| _待首次评估批次回填_ | | | | | | |

- **范围**：`git -C vendor/claude-agent-acp log --oneline <起点>..upstream/main`，记录起止 SHA。
- **处置**：采纳（移植或按本地结构等价实现）/ 不适用 / 延后；采纳项须有对应本地测试。
- **分类原则**：安全、权限、数据损坏、SDK·CLI 兼容修复优先评估；产品需要的新功能按本地契约实现；通用且自包含的修复可移植并保留来源；上游专属功能或内部重构通常不跟、记录不适用理由。

## 发布入口阻断项（推送前必须处理）

`vendor/claude-agent-acp/.github/workflows/publish.yml` 继承自上游：**push 到 fork `main` 会触发 `publish-npm-preview`，以 `@agentclientprotocol/claude-agent-acp` 之名发布 preview，并创建 tag / dispatch 外部 registry 更新**。是否实际生效取决于远端工作流的凭据（release-please App、npm OIDC trusted publishing、registry updater App）与权限。

- 本次**只记录、不修改**该 workflow，也不触发验证（不推送、不联网）。
- **任何向 fork `main` 的推送前，必须先核实并决定**：禁用继承的自动发布，或改为明确授权的发布入口。稳定发布（release-please → `publish-npm`）同属此阻断项。

## 验证入口

```bash
npm --prefix vendor/claude-agent-acp run typecheck
npm --prefix vendor/claude-agent-acp run lint
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN npm --prefix vendor/claude-agent-acp run test:run
pnpm agent:build
UNIVERSE_FORK_CONTRACT=1 pnpm --filter @universe-editor/editor test:integration acpForkContract
```

真实 CLI 腿需要 `CLAUDE_CODE_EXECUTABLE`；需要真实模型请求的验证在授权环境另跑，不宣称被 mock 覆盖。不使用真实用户配置做测试；codex 腿必要时用临时干净 `CODEX_HOME=$(mktemp -d)` 并负责清理。`agent:build` 同时构建两个 adapter，顺带验证 codex 现有契约不回归。
