# 01 · ACP 契约固化与 fork 维护

> 依据：[05-acp-ai.md](../architecture-review-202607/05-acp-ai.md) 问题 #1/#2/#4/#5/#6。
> 批次：任务 1/2/3 属第一批（P1）；任务 4/5 属第二批（P2）；机会型见末尾。

## 背景

- 5 个自定义 ext-method（`ask_user_question` / `set_session_title` / `rewind_session` / `_universe/compaction` / `_claude/sdkMessage`）+ 多个 `_meta` 印章在 editor 与两个 fork 间各写一份，靠 "keep both in sync" 注释维系（`acpSessionModel.ts:190,199,210,221`）。editor 的 e2e 全用 `.cjs` 假 agent，**editor↔真 fork 之间没有任何自动化集成验证**。
- codex fork 有维护文档（`vendor/codex-acp/CLAUDE.md`：红线 + 本地改动清单 + rebase 核对表），claude fork 没有任何等价物；19 个本地提交 +1343 行集中改在单个 6579 行的 `acp-agent.ts`（≈20% 被动过），上游发版频繁且大概率会自己实现 rewind/compact/标题持久化等重叠功能。两个 fork clone 均未配 `upstream` remote。
- agent 相关 16 个 e2e spec 全部 `@p1`，旗舰功能没有任何 CI 阻塞门。

---

## 任务 1：跨仓契约测试 ✅（P1，第一批，预估 1 天）

> 已完成（2026-07-20）。落地：
> - **共用定义**：新增 `acpExtMethods.ts`（`ACP_EXT_METHODS` 5 个方法名 + `ACP_META_KEYS`），`acpSessionModel.ts` 的 4 个常量 + `acpSessionService.ts` 的 `SDK_MESSAGE_EXT_METHOD` 全部改为 re-export 这份单一定义（生产与测试共用，不再各抄一份）。
> - **真子进程工具**：`integration/fixtures/realForkConnection.ts` 用系统 node spawn `vendor/<fork>/dist/index.js`（同生产 `ELECTRON_RUN_AS_NODE` 启动物），经 stdio ndJsonStream 建 `ClientSideConnection`；`forkDistExists` 缺 dist 时让 spec skip（本地无 agent:build 不炸）。
> - **契约 spec**：`integration/scenarios/acpForkContract.integration.test.ts`（14 例）——名称表 == editor 期望字面量（editor 自洽双向锁）；**dist-scan 离线断言**（新增）逐个断言 claude dist 含全 5 个、codex dist 含其实现的 2 个（rewind/set_title）方法名字面量；claude/codex 两个 fork 的 initialize 跨 SDK 版本握手（editor SDK 0.22.1 ↔ claude/codex fork 1.2.x）+ capabilities/`_meta` 形状；claude 的 rewind/set_session_title 走真连接断言方法路由 + 参数契约 + 结构化错误 wire（不发真 prompt）。
> - **dist-scan 补 CI 缺口**：名称表断言只证明 editor 自身一致（两侧都在 editor 仓、不读 fork），无法抓 fork 侧改名；而抓 fork 改名的真连接路由腿又因需 Claude 二进制在 CI self-skip。dist-scan 直接读 `vendor/<fork>/dist/index.js` 文本断言方法名字面量存在——**离线、CI 恒跑**，是"破坏性验证"的 CI 可执行等价物（改 fork 方法名 → dist 里字面量消失 → 测试红，已自检）。
> - **破坏性验证**：篡改期望方法名 → dist-scan 红（claude+codex 双抓）；真连接腿（有二进制时）篡改 fork dist 方法名 → 红（`"Method not found"`）；恢复 → 绿。
> - **CI 接入**：新增 `acp-contract` job（`needs: detect-affected` + `if: acp-contract == 'true'` + submodule recursive + `pnpm agent:build`），触发路径由 `affected-e2e-matrix.mjs` 的 `computeShouldRunAcpContract` 纯函数按 `vendor/**` / acp renderer 服务 / acpHost·claude·codex main 服务 / 契约测试自身计算，main push `--all` 全量兜底；普通 `integration` job 里该 spec 因无 dist 自动 skip。补 3 个路由单测。
> - **claude ext-method 腿的 binary 前置**：实测中 claude fork 的 `session/new` 会**急切 spawn Claude 原生 CLI**（SDK `query()` 在建会话时即启动，非首个 prompt 才启动），故 rewind/set_session_title 三例改为门控在 `claudeBinaryAvailable()`（`CLAUDE_CODE_EXECUTABLE` 指向真实存在的二进制）——本地装了 Claude 才跑，CI 无二进制自动 skip；离线核心（名称表 + dist-scan + 双 fork 握手）无此依赖恒跑。
> - **边界说明**：`ask_user_question`/`_universe/compaction`/`_claude/sdkMessage` 为 agent→client 方向，需真 prompt 才触发，契约测试以名称表锁其 wire 名；notification `_meta` 印章的解析形状由 editor 侧 `acpSessionUpdateMeta.ts` 既有单测覆盖。

**目标**：editor CI 中有一道自动化闸门，能在 ext-method / `_meta` wire 形状漂移时失败。

**步骤**：

1. 在 editor 侧把 5 个 ext-method 名称与 `_meta` 印章的 wire 形状收敛为可复用的断言模块（现有常量在 `acpSessionModel.ts:190-221`，形状探测在 `acpSessionUpdateMeta.ts`）——契约测试与生产代码共用同一份定义，避免测试自己再抄一份。
2. 写集成测试 harness：用 `pnpm agent:build` 产物直接以 node 启动 `vendor/claude-agent-acp/dist/index.js`（与生产同一套 `ELECTRON_RUN_AS_NODE` 启动物，测试环境用系统 node 等价），经 stdio ndJsonStream 建立 `ClientSideConnection`（复用 `inMemoryAcpPair` 之外新增"真子进程对"工具）。
3. 每个 fork 一个 spec：`initialize → newSession → 逐个 ext-method 握手`，断言：
   - `initialize` 响应的 capabilities 与 `_meta` 形状；
   - 5 个 ext-method 的请求/响应 wire 形状（字段名、类型、必选性）；
   - 关键 `sessionUpdate` 的 `_meta` 印章形状（compaction、sdkMessage 等）。
   - 不依赖网络与真实模型：只走协议握手层，不发真 prompt（或用 fork 的 mock/dry 模式，以实测可行性为准）。
4. CI 接入：挂到 integration job；触发条件走路径过滤（`vendor/**`、`apps/editor/src/renderer/services/acp/**`、`apps/editor/src/main/services/{acpHost,claudeBinary,claudeConfig,codexBinary,codexConfig}/**` 变更时 + main push 全量兜底），需要 `git submodule update --init` + `pnpm agent:build` 前置步骤。

**验证**：故意改掉 fork 侧一个 ext-method 字段名，测试必须红；恢复后绿。

**验收**：契约测试入 CI 并在相关路径变更时运行；两个 fork 的 5 个 ext-method + `_meta` 印章全部有 wire 形状断言。

## 任务 2：claude fork 维护文档 + upstream remote ✅（P1，第一批，预估 0.5 天）

> 已完成（2026-07-20）：新建 `vendor/claude-agent-acp/CLAUDE.md`（提交在 fork 仓库自身，对齐 codex fork 归属），覆盖四要素——红线（diff 最小/本仓库自有 prettier 配置与父项目相反/PostToolUse 钩子已 grep vendor 但仅本地状态/新功能落新文件）、本地改动清单（19 个提交逐条列功能+落点文件+5 个 ext-method 名，标注 rewind/AskUserQuestion/esbuild 三处新文件热区）、rebase 核对表（以父项目跨仓契约测试为回归底线）、上游同步节奏（每月或 minor 发版）。新增 `scripts/setup-vendor-remotes.mjs`（幂等，已实跑为两个 fork 配好 upstream），命令写进两个 fork CLAUDE.md。

**步骤**：

1. 给 `vendor/claude-agent-acp` 补一份与 codex 同规格的 `CLAUDE.md`：
   - **红线**：diff 最小是生命线；哪些文件绝不动、哪些改动必须落新文件；
   - **本地改动清单**：逐条列出 19 个本地提交引入的功能（rewind / compaction / 标题持久化 / skills / memory 注入等）及其落点文件，供 rebase 核对；
   - **rebase 核对表**：上游同步操作步骤 + 每项本地功能的验证方式（跑任务 1 的契约测试即回归底线）；
   - **上游同步节奏**：明文写多久检查一次上游 release（建议每月一次或上游 minor 发版时）。
2. 两个 fork 的 clone 配 `upstream` remote：命令写进各自 CLAUDE.md（remote 是本地 clone 状态，不随仓库传播），或加一个 `scripts/setup-vendor-remotes.mjs` 一键配置。
3. 后续新功能落新文件的约定写入 fork CLAUDE.md（对齐 codex fork 的 PathUtils/AcpExtensions 模式）；已有的 rewind/compaction 逻辑**不主动搬迁**，待下次上游 rebase 冲突实际发生时按核对表逐步外移。

**验收**：claude fork 有 CLAUDE.md 且覆盖红线/清单/核对表/节奏四要素；本地两个 clone `git remote -v` 均含 upstream。

## 任务 3：agents e2e 提级 @p0 ✅（P1，第一批，预估 0.5 天）

> 已完成（2026-07-20）：`smoke.agents.spec.ts` 的 `test.describe` tag `@p1` → `@p0`，文件头注释同步。本地跑该 spec 绿（3.8s，含 app 启动，增幅远低于 2 分钟量级验收线）。echo agent 全链路不依赖网络与真二进制。CI 连续稳定性待上 main 后观察，若出现 flaky 按 `fix-ci-e2e-flake` skill 排查。

**步骤**：

1. `smoke.agents.spec.ts`（echo agent 全链路，不依赖网络与真二进制）tag `@p1` → `@p0`。
2. 观察两个 OS shard 上的 @p0 时长变化与稳定性（连续 10 次 CI 无 flaky 再定稿；若出现偶发失败，先按 `fix-ci-e2e-flake` skill 流程排查，不带病提级）。

**验收**：聊天主链路回归能阻塞合并；@p0 套件时长增幅可接受（< 2 分钟量级）。

## 任务 4：ext-method 纳入能力通告，删 agentId 白名单 ✅（P2，第二批；**前置：任务 1**）

**背景**：rewind 支持用 `agentId` 白名单硬编码（`acpSession.ts:270`，注释自认 "Static"），codex "文件回滚在客户端做" 的语义差异编码为 `filesAreClientSide = this.agentId === 'codex'`（`acpSession.ts:716`）——用户自定义 agent 即使实现了 ext-method 也不亮 rewind 入口。

**步骤**：

1. 协议侧（两个 fork）：`initialize` 响应 `_meta` 中通告 `universe-editor/*` ext 能力集，rewind 能力附 `filesRolledBackByAgent: boolean` 语义标志。
2. editor 侧：`acpSession` 改从 initialize 能力集读取，删除 `:270` 白名单与 `:716` 的 id 判断。
3. 任务 1 的契约测试同步断言能力通告的 wire 形状（三仓同一批落地）。
4. 假 agent（e2e `.cjs`）与 `inMemoryAcpPair` 桩补能力通告，验证自定义 agent 声明能力后 rewind 入口点亮。

**验收**：产品代码中 rewind 相关的 `=== 'claude-code'|'codex'` 分支清零；契约测试锁住能力通告形状。

> 已完成（2026-07-21）：新增单一定义 `acpExtMethods.ts` 的 `ACP_CAPABILITIES_META_KEY = 'universe-editor/capabilities'` + `AcpUniverseCapabilities`（`rewind.filesRolledBackByAgent`）。两个 fork 在 `agentCapabilities._meta` 通告该块（claude `filesRolledBackByAgent:true` / codex `false`），`pnpm agent:build` 重建 dist。editor 侧 `rewindSupported` 由静态 getter 改为 `IObservable<boolean>` + 私有 `_filesRolledBackByAgent`，均在 `attachConnection` 的 `initializeResult.then` 里从 `_meta` 解析并 set（与 `forkSupported`/`imageSupported` 同款已验证管线）；`rewindTo` 的 `filesAreClientSide` 改读 `!_filesRolledBackByAgent.get()`；消费端（`UserMessageItem.tsx`/`agentRewindActions.ts`/`acpSessionService.ts`）全改读 observable。契约测试 `acpForkContract.integration.test.ts` 补断言 `_meta['universe-editor/capabilities'].rewind.filesRolledBackByAgent`（claude=true/codex=false）+ dist-scan 加能力键字面量（16 例全绿）。`AcpSession.timeline.test.ts` 新增 4 例能力解析单测（自定义 agent 声明 rewind → `rewindSupported` 点亮 + 文件归属语义）。产品代码 rewind 相关 agentId 分支已清零（保留的 `codex` 分支仅剩成本估算，见任务 5）。

## 任务 5：per-agent quirks 表 ✅（P2，第二批）

**背景**：codex 成本估算是 vendor 逻辑但嵌在 AcpSession 核心（`acpSession.ts:1163,1269`）；`shared/ai/codexPricing.ts` 价格表手工硬编码。

**步骤**：

1. `acpAgentRegistry` 描述符挂可选 strategy 对象：成本估算器、文件回滚归属等 vendor 差异。
2. codexPricing + `_ingestPromptResponse` 中的 codex 分支收拢为 "codex 描述符注入的估算器"；AcpSession 核心只调用 strategy 接口。
3. 顺手盘点全仓其余 `=== 'claude-code'|'codex'` 分支（约 8 处），能收进描述符的收进，边缘启动注入类（二进制路径、nodeEntry）保留并注释登记。

**验收**：AcpSession/applyUpdate 主干无 vendor 条件分支；新增第三个 agent 时成本估算差异只需写描述符。

> 已完成（2026-07-21）：新增 `acpAgentCostStrategy.ts`——`AcpAgentCostStrategy` 接口（`fromUsageUpdate` / `fromPromptResponse` 两个钩子）+ `getAgentCostStrategy(agentId)` 查表（当前仅 `codex` 注册，claude 无 strategy = 报告权威成本）。AcpSession 构造时缓存 `_costStrategy`，`usage_update` 与 `_ingestPromptResponse` 两处 `agentId === 'codex'` 分支收拢为 `this._costStrategy?.fromUsageUpdate(...)` / `?.fromPromptResponse(...)`——主干不再有 vendor 条件分支，新增 agent 只需在 strategy 表注册。保留分支及注释登记：`acpAgentRegistry.ts` 的 `nodeEntry`/`MANAGED_BINARY_AGENT_IDS`（边缘启动注入类，二进制路径 + Electron node 入口，非 AcpSession 主干逻辑）。全量 editor 测试 3922 绿。

---

## 机会型任务（P3，随迭代顺手做）

- ⬜ acpHost stdout 加字节计数/水位日志（背压"先测量再决定"的测量步，`acpHostMainService.ts:201-211`）。
- ⬜ `available_commands_update` 的 `set(..., undefined)` 改走 16ms 批 + `_setImmediate` 守卫，与文件内自立约定对齐（`acpSession.ts:1129`）。
- ⬜ ChatBody 抽 `useChatScroll` hook（滚动物理是复杂度重心，已有 6 个滚动回归 e2e 兜底）；PromptInput 随功能改动渐进拆。
- ⬜ acpSessionHistory entry 的 `id` 与 `sessionIdOnAgent` 恒等重复字段清理（自认 schema 债，`acpSessionHistory.ts:46-56`）。
