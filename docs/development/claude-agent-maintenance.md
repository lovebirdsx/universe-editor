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
| 本轮起点 SHA | `6d86f07` | fork HEAD：session-anchor / query-resources 提取、真实 SDK·dist 验收与窗口门禁均已提交。本批（compact 边界父链兜底）在其上，随子仓提交后主仓 gitlink 一并 bump |
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
| CT-COMPACT-RESTORE | 已压缩会话恢复保留压缩前显示内容与 steering；跨 boundary 的父链在 `logicalParentUuid` 为 `null` / 悬空时经 `compactMetadata.preservedSegment.tailUuid` 兜底，不得截断压缩前历史；缺磁盘历史时正确降级 | `acp-agent.ts`（`loadSession` / `replaySessionHistory`）、`transcript-history.ts`（`rebuildTranscriptDisplayChain` / `displayParentOf`）、`resumed-session.ts` | `session-contract-guards.test.ts`（实际 load）、`acp-agent.test.ts`（replay across compaction）、`transcript-history.test.ts` | `apps/editor/src/renderer/services/acp/session/__tests__/AcpSession.timeline.test.ts` | 离线 + 真实 transcript 只读语料核对；真实 CLI 历史恢复未验证 |
| CT-FORK-ANCHOR | 指定位置分叉：活跃与休眠/新实例均正确定位；显式锚点不存在即报错，不退化成整份复制 | `session-anchor.ts`（`resolveForkAnchor`）、`acp-agent.ts`（`unstable_forkSession` / 薄壳 `forkSliceBefore`）、`transcript-history.ts`（`findFoldedPromptParent`） | `session-anchor.test.ts`、`fork-session-sdk.test.ts`（真实 SDK 文件操作）、`session-contract-guards.test.ts`、`acp-agent.test.ts`（rewind/fork）、`transcript-history.test.ts` | `apps/editor/integration/scenarios/acpForkContract.integration.test.ts`（合成 transcript 的真实 dist 腿）、`apps/editor/src/renderer/services/acp/session/__tests__/AcpSession.poolResume.integration.test.ts` | 离线 + 真实 SDK 文件改写（合成 transcript）；真实模型请求未验证 |
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

**验收保留项**：全量 E2E 的 `smoke.windows.spec.ts` 有 3 项首跑在 8 秒内未达到预期、重试后通过：新窗口加载目录、窗口列表数量、退出后关闭所有窗口。最后一项超时时仍有 2 个窗口。三项在本批冒烟中通过，但尚未定位全量运行的首跑超时原因，不能认定为既有 flake 或与本批无关；本批未修改窗口实现或放宽超时。真实模型请求、生产网关、真实 SDK 历史复制及 fork 后 effort 继承仍未验证；性能标签与独立 `e2ea` 回归套件不计入已验证范围。（此段保留为前批历史；该首跑超时已在后续批次定位候选成因并加启动门禁，见「窗口用例的启动竞争与门禁」。）

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

## P2 第二批：会话锚点 / query 资源边界 + 真实 SDK·dist 验收 + 窗口门禁

起点 fork `90795e5`（纯历史解析整理已提交）。本批三块：把 `acp-agent.ts` 里两段可独立的行为抽成模块（会话锚点解析、query 资源释放），补走生产入口 / 真实依赖的验收，并给窗口用例加启动门禁。**全部未提交**（fork 工作树有改动、gitlink 未 bump）。

### 边界与状态归属

- **`session-anchor.ts`（新）**：`resolveForkAnchor(deps)` 承接原 `forkSliceBefore` 的窄决策——依赖注入（已取得的 `liveUuid`、`readChain` 只调一次、`readRawEntries` 仅 folded 回退时调、`messageIdForGrouping` 与 replay 共用），复用 `transcript-history.ts` 的 `findFoldedPromptParent`，返回 `{upToMessageId, resolution}`（`live` / `active` / `folded`）。**状态归属**：`SessionTiming` 起止与 `fork-point` 日志仍在生产调用点（`acp-agent.ts` 的 `forkSliceBefore` 薄壳），模块不反向 import agent。
  保持的行为：live 优先 / 有效链只读一次 / folded 回退 / 首条锚点 `invalidParams` / 未知锚点 `invalidParams` / folded parent 必须仍在有效链 / 空 `cwd` 在解析中省略（SDK 省略 `dir` 时「searches all projects」）/ 任何失败绝不成整份复制。未动 `messageUuidBefore` 的 rewind 路径。
- **`query-resources.ts`（新）**：`releaseQueryResources(session)` 承接原 `closeQueryStream` 的资源块——`queryClosed` 幂等门控 → 清 consumer / compaction / 孤儿 queued-turn timer → settings dispose → `input.end` → `query.close`（顺序不可换，先摘监听再终止子进程）。最小结构接口 `QueryResourceHolder`，不导出内部 `Session`、不反向依赖 agent。**状态归属**：`abortController`（可能是 client 提供的共享 controller）、sessions map 增删、hook 回调与 runtime 集合、teardown / resurrection 编排仍归 agent；模块不 abort、不 delete map、不重复释放。资源归属表写在模块头注释。

### 测试与真实依赖验收

- fork 单测新增：`session-anchor.test.ts`（10）、`query-resources.test.ts`（5）、`fork-session-sdk.test.ts`（8）；原有 `acp-agent.test.ts` 的 fork-point 与 `session-contract-guards.test.ts` 入口用例保留，另补一条 query 资源的生产路径特征用例（自发流结束后显式 `closeSession`：dispose / close / `input.end` 各仍只调一次、husk 被移除、`abortController` 仅由 teardown abort）。
- **8 条真实 SDK**（`fork-session-sdk.test.ts`）：无 `vi.mock`，用真实 `getSessionMessages` / `forkSession` 在临时 `CLAUDE_CONFIG_DIR` 下的合成 transcript 上做文件操作（不发 prompt、不读凭据）。**首批 2 条失败**：合成 transcript 的 folded attachment 顺序与 `resolution` 期望与真实 SDK 行为不符；按真实结果修正后 **8/8 通过**。**实测结论（勿写成「raw uuid 全被重映射」）**：`forkSession` 把保留行的 `uuid` / `parentUuid` 重映射为新 uuid、丢弃 progress / sidechain 行，但 **folded attachment 行本身及其 `attachment.source_uuid`（客户端 prompt id）原样保留**；`compact_boundary` 的 `logicalParentUuid` 也重映射到新的压缩前 uuid，显示链因此穿过边界。
- **真实 dist / CLI 跨仓契约**（`acpForkContract.integration.test.ts`，`UNIVERSE_FORK_CONTRACT=1`）：真实 dist/**CLI 三次实跑**分别为 **45 通过 / 1 失败**、**46/46**、**46/46**（首跑新增 fork 断言把 SDK 附加的 `custom-title` 元数据行当成消息，得到多余的 `undefined`；按行类型排除该元数据后两次连绿，并非靠重试掩盖失败）；**无 CLI** 为 **38 通过 / 8 跳过**。新增真实 dist 腿：合成 transcript 上的锚定 fork（切点正确、源字节不变；未知锚点 `-32602` 且不产生新文件；首条锚点 `-32602`），以及**不带 prompt 的 `session/load` 回放**继承 turn。
- **负向证明**：破坏 folded 有效链判定 → 3 红（`transcript-history` / `session-anchor` / `acp-agent` 入口）；关闭首条消息拒绝 → 2 红；去掉 `queryClosed` 幂等 return → 2 红；还原 `publish.yml` → 退役护栏红。均精确恢复。
- **手动更新的 3 个 v2 golden**（`bash-background` / `permission-denied` / `subagent-native-sessions`）：`#1252` 有意改未知退出码的 wire（v1 发 `exit_code:null`、v2 省略 `exitCode`），**属人工确认后的定向更新，不是 `-u` 自动重录**。
- fork 最终联合验收：**2476 通过 / 31 跳过 / 0 失败**（56 文件：53 通过 / 3 跳过）；`typecheck` / `lint` / `format:check` 通过。最新 `pnpm agent:build` 重建两个 adapter 后，隔离凭据的真实 dist / CLI 契约再次 **46/46 通过**。

### 窗口用例的启动竞争与门禁

证据**支持** quit 命令的派发被排队，而非 Electron 的 quit 宽限窗口：失败现场里目标目录在卡顿前已设好、窗口列表正确、退出链**一旦被派发约 130ms 走完**、随后探测立即被应答；`round14` 的退出用例超时后仍有 2 个窗口。建窗后窗口还在 adopt 目录、起自己的扩展宿主（实测该段卡 7.7–14s），紧跟 `whenRestored()` 的固定预算断言把整段预算花在等待上而误判。

**门禁 `waitForProbeServiceable`（`packages/e2e-harness`）**：等一次 renderer→main 的**只读探测往返**能走通再开始计时。它**只是一次 ping**——减轻启动竞争，**不等于完整的 extension ready 信号，也不是性能修复 / 根治**；探测抛错原样上抛（不被吞成「未就绪」），悬着则在 poll 的 20s 上限失败。harness 补 4 条受控测试（成功不看 windows 值 / 真实 IPC 拒绝不被吞 / 关闭窗口不被吞 / 永不 resolve 有界，用假计时器避免真等 20s）。

**窗口统计**（`specs/smoke.windows.spec.ts`，每轮 5 例）：

- 前 **27 轮 / 135 次执行**：**8 次首跑失败**（多为 retry 救回）、**1 次重试仍失败**（`round14` 的「Exit closes every window」，`toBe(0)` 实收 2、重试同形态）。
- 随后 **18 轮 / 90 次执行**：**全绿**（采用的是**早期 catch-all 版本**的门禁）。
- 本轮**改写门禁后**（去掉宽泛 catch、失败保留原错误）的实跑**另列**：**6 轮 / 30 次执行全绿**；失败现场（如有）存 `/tmp/claude-acp-closure/final-windows/`。
- **仅本机 WSL/Linux 验证；Windows 平台未验证。**

### 本轮主仓联合验收

- `pnpm check:full`：**94/94 任务成功，77 个命中缓存**；常规 integration 为 35 通过 / 41 跳过，不替代上述显式启用的 46 项真实 dist / CLI 契约。
- 定向 `pnpm e2e specs/smoke.windows.spec.ts specs/smoke.agents.spec.ts`：**6 通过**；`pnpm e2e:smoke`：**106 通过**。两次 E2E 均实际执行，构建可命中缓存。
- 首次 `pnpm e2e`：**25/26 任务成功，19 个命中缓存**；core 并行 301 通过 / 3 跳过、串行 11 通过，Perforce 37 通过 / 1 失败。失败为 `swarmReview.spec.ts` 的 reload 后恢复 review 用例，首跑和重试均未在 5 秒内显示 `Review #1001`，现场停在 Loading。定向复现一次首跑失败、重试通过，随后默认预算单跑通过；另一次 CI 预算运行也通过。未做干净基线对比，不据此断言与本轮无关，亦未放宽超时或修改 Swarm 实现。
- 第二次 `pnpm e2e`：**26/26 任务成功，24 个命中缓存**。实际重跑 core（并行 301 通过 / 3 跳过、串行 11 通过）与 Perforce（38 通过），无 flaky；TypeScript / Markdown / AI suite 沿用第一次通过的缓存。Swarm 重跑通过只说明本次恢复成功，具体时序根因仍未关闭。
- 七个同族窗口 spec 的定向 `pnpm e2ea`：**14 通过 / 1 跳过**（并行 10 通过 / 1 跳过、串行 4 通过），实际执行；不是完整 `e2ea` 全量验收。Windows 专属用例仍需对应平台验证。
- 最后注释精简后，fork `typecheck` / `lint` / `format:check` 通过；发布退役护栏 **2 通过 / 0 跳过**。主仓 `pnpm check` **93/93 任务成功，74 个命中缓存**，包含文档、敏感串、知识导航与 CLAUDE 大小护栏；lint 无错误，4 条 React Hooks 警告位于本轮未修改的文件。主仓 / fork 的 `git diff --check` 通过，codex 工作树无变更。

### 未验证 / 未宣称

- 真实模型请求、生产网关、fork 后 effort 继承仍未授权验证，不宣称覆盖；真实 SDK 文件改写用的是合成 transcript，不等于真实会话复制。
- 未修改窗口产品实现、未放宽既有断言预算；门禁只加就位等待。

## P2 第三批：compact 边界父链兜底（修复 + 真实语料核对）

起点 fork `6d86f07`（P2 第二批已提交）。

**症状**：编辑器恢复一个已两次 compact 的会话，时间线只剩最后一次压缩之后的历史；恢复后显示的首条用户消息实际是整段会话的最后一条。**根因**：`transcript-history.ts` 的显示链回溯用 `parentUuid ?? logicalParentUuid` 跨 boundary，而 CLI 写 `logicalParentUuid` 有三种形态——正确 / `null` / 指向文件里不存在的 uuid，后两种让 `byUuid.get()` 得 `undefined`，回溯**静默断在 boundary**。目标会话（`fd8a7215`，两个 boundary）：第一个的 `logicalParentUuid` 与其 `compactMetadata.preservedSegment.tailUuid` 一致（`dd377dac…` = line 909 attachment），第二个的 `logicalParentUuid`（`95102dbe…`）全文件仅此一处出现、与自身 tailUuid（`df0cf69c…` = line 1731）不一致。

**修法**：`displayParentOf` 按序取第一个**能在 `byUuid` 里解析**的候选——`parentUuid` → `logicalParentUuid` → `compactMetadata.preservedSegment.tailUuid`。tail 只补位、不改道（语料里「两者同时可解析」的 115 个 boundary 上逐字相等；另有 37 个「lp 有效、tail 悬空」由 skip 语义自然回落，两种顺序在该语料上结果相同）；保留 lp 优先是防御性的——tail 一旦可解析却指错段，反序会劫持整条回溯。非 boundary 行不带后两个候选（137,675/137,675 行，同一快照），行为与旧码逐字一致；候选全不可解析时仍停在 boundary，不退化成文件序。

**真实语料只读核对**（`~/.claude/projects/*/*.jsonl`，核对时快照 306 文件 / 101 个含 boundary 文件；`node --experimental-strip-types` 直载 fork 源的真函数，与旧算法逐文件对照）：lp 有效 152 / `null` 18 / 悬空 10；坏 boundary 上 `preservedSegment.tailUuid` **28/28 可解析**；tail 从不指向 boundary 自身或之后的行，也不指向 sidechain / meta / summary（0/143），46/143 指向 attachment。链变化：**15 个变长 / 0 个变短**，变长链根全部是 `type=user` 的真会话起点；目标会话过滤后链 **200 → 1135**，根回到文件 line 3 的首条用户消息（`09eca67c…`）。该核对**不等于**真实 CLI 历史恢复验证：它验证的是解析逻辑对真实 transcript 形态的恢复能力，未经 `--resume` 走真实 CLI。

**测试与负向验证**：`transcript-history.test.ts` 6 例（悬空 lp / `null` lp / 优先级守卫 / 双坏降级锚 / tail 为 attachment / 两 boundary 且较新那个链接坏）、`session-contract-guards.test.ts` 走真 `session/load` 的 2 例（`it.each` 覆盖两种坏形态，断言 6 项顺序表）、`acp-agent.test.ts` 回放 1 例。**把第三候选删掉（等价旧码）→ 上述 7 例全红**，精确还原后 fork 全量 **2485 通过 / 31 跳过 / 0 失败**（较第二批基线 2476 增 9，即本批新增用例），`typecheck` / `lint` / `format:check` 通过。

**已知限制**：① 链变长使回放字节预算更吃紧（本机增量 ≤3.39 MB/会话，对 `MAIN_REPLAY_TOTAL_CAP_BYTES` 96 MiB 余量充足）；预算触顶的现象是「丢最新尾部」，属独立话题，本批不改。② tail 若指向被 rewind 放弃的分支，回溯会顺它走进去、把 CLI 已丢弃的消息带回时间线（本机语料 0/180；lp 可解析时旧码本就有同一暴露面，文件内无法判别活/弃分支）。③ 链变长后 `backfillForkedToolResults` 与子代理 stats restamp 的扫描面变大，压缩前的分叉 tool_result / 子代理用量会被正确补上——属**期望**变化，不是回归。

## 后续范围

**本轮已执行**（详见各节）：纯历史解析整理（已提交 fork `90795e5`）；会话锚点解析与 query 资源释放的模块化提取；真实 SDK 文件操作验收（8/8）与真实 dist/CLI 跨仓契约验收（46/46；无 CLI 38/8 skip）；上游固定范围评估 12 项与 `compare` 回归修复（19/19）；窗口用例的启动门禁。

**持续维护事项**（不自动启动）：SDK / CLI / ACP / transcript 各自跟踪、按需单独成批升级；上游按月或 minor 发版评估一次；生命周期与状态机重构留给之后的独立批次。**不自动升级依赖、不自动同步上游、不自动启动下一轮重构。**

## 上游评估记录

每轮评估固定比较范围，逐条记录；**已审阅到的上游 SHA 不代表其所有变化已吸收**。

| 评估批次 | 上游范围（起..止） | 变更（目的） | 影响判断 | 处置 | 原因 | 本地测试 |
|---|---|---|---|---|---|---|
| 首次固定范围评估 | `a44c486..b2dbc8f5a1b8`（12 提交） | 逐条见下方「首次固定范围评估」 | 采纳 3 项 + 1 项局部；不适用 6 项；延后 2 项 | `#1252` / `#1258` / `#1233` 采纳，`#1249` 仅采纳「废弃流式 tool call」部分 | 与本地 AIR 退役面、v1 契约、依赖单独成批策略相关 | fork 单测 2473 通过 / 31 跳过 / 0 失败；typecheck / lint / format:check 通过 |

- **范围**：`git -C vendor/claude-agent-acp log --oneline <起点>..upstream/main`，记录起止 SHA。
- **处置**：采纳（移植或按本地结构等价实现）/ 不适用 / 延后；采纳项须有对应本地测试。
- **分类原则**：安全、权限、数据损坏、SDK·CLI 兼容修复优先评估；产品需要的新功能按本地契约实现；通用且自包含的修复可移植并保留来源；上游专属功能或内部重构通常不跟、记录不适用理由。

### 首次固定范围评估（`a44c486..b2dbc8f5a1b8`，12 项，逐条）

只读经 `gh api` 取范围清单、每提交完整 patch 与测试，未 fetch / 新增 remote / checkout。**已审阅到此 SHA ≠ 已吸收**；SDK / CLI / ACP 锁定版本不变。分叉点解析（本地最大单笔）与 v1 的为编辑器扩展均在下方「本地测试」列，不在此表重复。

| 提交 | 上游 PR | 内容（目的） | 处置 | 原因 | 本地测试 |
|---|---|---|---|---|---|
| `8589a9cf150d` | #1250 | 恢复主线程 agent 配置项（revert #1112）：agent picker + `applyFlagSettings({agent})` + `_meta.claudeCode.options.agent` 透传 | **延后** | 本地编辑器不消费主线程 agent 配置项、也不传 `options.agent`（`_meta.claudeCode.options` 只带 `settings`）；恢复会引入无本地契约的 config option 面与实时切换路径。待产品需要主线程 persona 时按本地契约实现并补 wire 契约测试 | 无（未采纳） |
| `52a92be959f7` | #1252 | 仅依据明确 tool result 报告退出码；未知码 v1 发 `exit_code: null`、v2 省略 `exitCode` | **采纳** | 通用自包含修复。编辑器不读 `exit_code`（只消费 `terminal_output*`），对本地零影响；需同步 `tool-calls/{facts,renderer,reporters/bash}.ts` 与 `v2/terminal.ts`（AIR 退役，无 AIR 分支） | `tools.test.ts`（含 6 分支表）、`acp-v2.test.ts` 新增；3 个 v2 golden 有意更新；`compare.ts` 增 `withUnknownExitCode` 允许；负向移除 `failureExitCode` 即变红 |
| `96acfeccf9cd` | #1253 | ACP v2 面报告 compaction / notice | **不适用** | 上游实验性 v2 草稿面；编辑器协商 protocolVersion 1；上游声明对 v1 无变化 | 无 |
| `4ddda8f37e2c` | #1254 | ACP v2 面停止广告 steering | **不适用** | 同上，v2-only | 无 |
| `3a61172e194c` | #1255 | ACP v2 面服务 providers | **不适用** | 同上，v2-only | 无 |
| `07c7ed3752a5` | #1256 | ACP v2 面 fork（fork + resume 一步到位） | **不适用** | 同上，v2-only；本地 fork 走 v1 `unstable_forkSession`（含磁盘锚点解析） | 无 |
| `5598efbc8ab1` | #1258 | `getContextUsage({detail:'summary'})`，避免每分类 `messages/count_tokens` 突发限流 | **采纳** | 锁定 SDK `0.3.287` 已支持 `detail`；**保留本地 `hasStartedTurn` 闸门**（turn 前不发）；不照搬上游「新会话立刻发请求」的测试 | `create-session-options.test.ts` / `session-config-options.test.ts` 断言调用参数为 `{detail:'summary'}` 且 turn 前不发 |
| `7b5c61a4ed55` | #1225 | release 0.86.0 元数据 | **不适用** | 仅发布元数据；fork 不发布 npm，版本号无功能含义 | 无 |
| `0e83a06c4a88` | #1249 | async task 路由 / Monitor / 结构化 task id / backgrounded 标记 + 废弃的流式 tool call | **部分采纳** | 前半依赖 `async-tasks.ts` / `tool-calls/background.ts`，随本地 AIR 退役已删，`native-subagents.ts` 也无 async task 路由 → **不适用**；「废弃的流式 tool call」影响所有客户端、在 `acp-agent.ts`（`dispatchedToolCalls` 记录 + abandoned/stuck 分流）→ **采纳** | `incomplete-tools.test.ts` 新增 3 例、既有用例补发完整 `tool_use`；负向移除 dispatch 记录 6 例变红 |
| `0724b17c581e` | #1260 | dependabot 依赖小版本升级（`@types/node` / `ip-address`） | **延后** | 依赖升级按策略单独成批，不夹带本轮 | 无 |
| `390b0b9f8bf0` | #1233 | 被折进 task-notification 周期的 prompt 正确结算 | **采纳** | 本地可复现：自主 origin 结果被按 origin 跳过会悬挂 `session/prompt`，客户端一直 running；锁定 SDK `0.3.287` 具备 `user_message_uuids` | `acp-agent.test.ts` 新增 5 例（`deferred settlement` describe）；负向移除 `answersPendingPrompt` 即 3 例变红 |
| `b2dbc8f5a1b8` | #1261 | release 0.87.0 元数据 | **不适用** | 同 release 0.86 | 无 |

**本轮回归**：`#1252` 在 `acp-scenarios/compare.ts` 新增的等价允许（`withUnknownExitCode`）最初在快速前跳路径上有缺陷——`wanted` 只在循环外算一次，`next` 跳过适配器自有行后没有随落点重算，同一 `toolCallId` 的 `terminal_exit` 数值→`null` 转换漏在真正落到的记录上，造成误报。补走生产比较路径的回归用例后 `acp-scenarios-compare.test.ts` **19/19 通过**；转换语义不变、基线不被改写，未前跳时行为等价。

**本轮采纳的验收与外部缺口**：三项采纳均走生产入口的离线测试；`#1233` 的 folded-prompt 真实 CLI 场景、`#1252` 的 Zed/Delta 客户端实读、`#1258` 的限流消除均未在真实网关/模型上外部验证，保留为外部验收缺口。`#1250` 的 wire 形状（`agent` config option + `applyFlagSettings`）未做编辑器侧确认，故延后而非采纳。

## 发布入口：本地已退役，远端尚未改

**本地（本工作树）已退役**：fork 的 `.github/workflows/publish.yml` 已 `git rm`（fork 工作树里为 `D`，未提交）。保留 `ci.yml`（`contents: read`）与 `conventional-prs.yml`（仅校验 PR 标题）。护栏 `scripts/__tests__/vendor-release-retirement.test.mjs` 断言该文件不存在、且 claude fork 全部 workflow 源文件不含发布标记（`npm publish` / `release-please-action` / `id-token: write` / `contents: write` 等）。fork 是 submodule，普通 `ci` job 不拉子模块（护栏自跳过），由带 `submodules: recursive` 的 `acp-contract` job 显式跑一次，否则该护栏在 CI 从不真正执行。

**远端（fork `main`）未改**：继承的 `publish.yml` 仍在，远端 run `37740723131`（`Publish and Release`，push 触发）release-please 与 preview job 均失败；该次运行的发布步骤记录如下（不推断全部历史运行的副作用）：

- `release-please` 3 秒即败：`The 'client-id' (or deprecated 'app-id') input must be set to a non-empty string`——远端没有 release-please App 凭据。
- `Publish preview to npm` 构建成功后在 publish 步失败：`npm error 404 ... PUT https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp - Not found ... you do not have permission`——npm 拒绝写入。
- 稳定发布（`Publish to npm`）与 `Tag the published preview` 未运行。

该次运行的发布尝试失败，但 workflow 仍是继承来的自动发布入口。本地这次删除尚未推送；**推送前复核护栏在 CI 里确实执行**，不要把「远端曾失败」当成已退役。

## 验证入口

```bash
npm --prefix vendor/claude-agent-acp run typecheck
npm --prefix vendor/claude-agent-acp run lint
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN npm --prefix vendor/claude-agent-acp run test:run
pnpm agent:build
UNIVERSE_FORK_CONTRACT=1 pnpm --filter @universe-editor/editor test:integration acpForkContract
```

真实 CLI 腿需要 `CLAUDE_CODE_EXECUTABLE`；需要真实模型请求的验证在授权环境另跑，不宣称被 mock 覆盖。不使用真实用户配置做测试；codex 腿必要时用临时干净 `CODEX_HOME=$(mktemp -d)` 并负责清理。`agent:build` 同时构建两个 adapter，顺带验证 codex 现有契约不回归。
