---
name: update-claude-agent-acp
description: 维护内置 ACP agent fork（vendor/claude-agent-acp，自维护 git submodule）：评估并选择性吸收上游 agentclientprotocol/claude-agent-acp 的变化、维护产品行为契约、重建产物。当用户说更新 claude-agent-acp / 看上游有什么变化 / 吸收上游修复 / 同步 acp agent / 升级内置 agent / 升级 claude-agent-sdk 时使用。
disable-model-invocation: true
---

# 维护 claude-agent-acp（评估并选择性吸收上游变化）

`vendor/claude-agent-acp` 是我们**独立维护的 fork**：**git submodule，不在 pnpm workspace 内，用自带 npm 工具链独立构建**（见根 CLAUDE.md）。上游是 `agentclientprotocol/claude-agent-acp`（npm `@agentclientprotocol/claude-agent-acp`，Apache-2.0，作者 Zed Industries）。

核心套路：**固定比较范围 → 逐条读变更实现/测试/前提 → 影响分类 → 采纳（移植或等价实现）/ 不适用 / 延后 → 完整验证 → 更新评估台账**。**不再以 rebase / 保 diff 最小为目标**：Git 历史与 submodule 结构保持不变，上游变更按需选择吸收。

> **本 skill 只手动调用**：frontmatter `disable-model-invocation: true` + `agents/openai.yaml` 的 `allow_implicit_invocation: false`，不被模型隐式触发。

> ⚠️ 第一原则：**产品行为契约不能被上游同名实现静默覆盖**。主仓库 renderer 依赖 fork 的既有行为（尤其 AskUserQuestion 的 extMethod 兜底、ext-method / `_meta` 形状）；评估上游变更时逐条核对，优先「两条路并存」而非二选一。

## 流程

### 0. 摸清现状（只读）
全部用 `git` / `gh api` 探查，**不要**在调查阶段改动 submodule：
```bash
cd vendor/claude-agent-acp
git remote -v                 # 通常只有 origin = 我们的 fork，无 upstream
git log --oneline -8          # 顶部若干条是我们的自定义提交，其下是上游基线
git rev-parse main HEAD origin/main   # ⚠️ submodule 常是 detached HEAD；本地 main 可能过时，别用它做基线
```
> 注：package.json 内部 `version`（如 0.85.1）与上游 git **tag** 不是一回事，版本号对不上正常，不影响评估。

### 1. 固定比较范围
```bash
git -C vendor/claude-agent-acp fetch upstream
git -C vendor/claude-agent-acp log --oneline HEAD..upstream/main   # 待评估清单
gh api 'repos/agentclientprotocol/claude-agent-acp/compare/<起点>...<上游HEAD>' --jq '.ahead_by,.behind_by,.total_commits'
git -C vendor/claude-agent-acp diff --stat <基线>..HEAD            # 我们改了哪些文件，预判影响面
```
记录起止 SHA 与提交数；**已审阅到的上游 SHA ≠ 已吸收**。

### 2. 逐条评估与分类
读每条变更的实现、测试、前提，按下表处置并记入台账（`docs/development/claude-agent-maintenance.md`「上游评估记录」）：

| 分类 | 处置 |
|---|---|
| 安全 / 权限 / 数据损坏 / SDK·CLI 兼容修复 | 优先采纳，不等月度巡检 |
| 产品需要的新功能 | 按本地契约实现 |
| 通用且自包含的修复 | 可直接移植，保留来源 |
| 上游专属功能 / 内部重构 | 通常不跟，记录不适用理由 |
| 与本地行为重叠 | 先确认 wire 形状与 editor 侧兼容，再决定切上游还是保持本地 |

依赖（SDK / CLI / ACP SDK / transcript 格式）分别跟踪，升级单独成批，不夹在结构重构或功能改动里。

### 3. 实现
- 采纳：移植上游补丁，或按本地结构**等价实现**（不要求与上游代码形状一致）。
- 分块、单一职责：一次只解决一个行为问题；不夹带无关格式化（本仓库风格 = 分号 + 双引号 + `printWidth:100`）。
- 每个行为变更配走**生产入口**（真实 `session/load`、`unstable_forkSession` 等）的测试，且测试能抓错。
- 同步更新 `vendor/claude-agent-acp/CLAUDE.md` 的「本地行为清单」。

### 4. 验证
```bash
npm --prefix vendor/claude-agent-acp run typecheck
env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN npm --prefix vendor/claude-agent-acp run test:run
pnpm agent:build
UNIVERSE_FORK_CONTRACT=1 pnpm --filter @universe-editor/editor test:integration acpForkContract
pnpm check
```
- 契约测试**默认 10s 内必须跑完**——超时不是「加超时」的理由，先查谁占住 SDK 控制通道（案例 12）。
- **codex 腿的 `CODEX_HOME` 已由共享 fixture 自动隔离**：`apps/editor/integration/fixtures/realForkConnection.ts` 给每个 codex 连接在建临时 cwd 里 `mkdtemp` 一个干净 home（写 `cli_auth_credentials_store = "file"`，不复制父环境任何东西），故跑契约测试**不再需要**手工 `CODEX_HOME=$(mktemp -d)`，也不会读写开发者真实 `~/.codex`。**但独立跑 codex CLI（不经该 fixture，如 `codex exec`）仍须显式 `CODEX_HOME=$(mktemp -d)`；任何情况下都绝不改动真实用户 auth 文件。**
- `pnpm check` 的 `FileWatcherMainService` debounce / `DiffEditor getPosition` 偶发失败是主仓库既有 flake，重跑即绿。

### 5. 提交（推送前有阻断项）
```bash
git diff --submodule=log vendor/claude-agent-acp   # 核对变更范围
```
- 提交/推送只在用户要求时做；开分支提交 submodule 指针，**不 force push、不重写历史**。
- ⚠️ **推送 fork `main` 前必须核实并决定自动发布**：继承自上游的 `.github/workflows/publish.yml` 会在 main push 时以 `@agentclientprotocol/claude-agent-acp` 名发布 preview 并 tag；未处理前不得推送。详见 `docs/development/claude-agent-maintenance.md`「发布入口阻断项」。

### 6. 更新台账
在 `docs/development/claude-agent-maintenance.md` 追加本批「上游评估记录」行（范围 / 目的 / 判断 / 处置 / 原因 / 本地测试），并回填基线字段（SHA / 版本 / 测试结果）。

## 适配套路（按文件）

- **`package.json`**：编辑时**当心重复 key**（公共行别在 new_string 重写）；`version`/依赖取上游，`build`（esbuild）取我方。
- **`package-lock.json`**：在 `vendor/*` 内重新生成锁一律带 `--registry=https://registry.npmjs.org`，否则本机镜像 URL 写进 `resolved` 污染 CI（案例 10）。
- **`esbuild.config.mjs` / `src/interactive.ts`** 等我方新增文件：上游无，直接保留。
- **`src/acp-agent.ts` / `src/tools.ts`**：双方都大改，需**语义合并**（案例 2、3、11）。

## 案例索引（按症状查，详情在 `references/cases.md`）

| 症状 | 案例 |
|---|---|
| fork `npm test` 报 `src\x` vs `src/x` 路径失败 | 1（扩展见 9） |
| AskUserQuestion 被上游「无 form 就禁用」掐断 / extMethod 丢失 | 2、5 |
| `npm test` 报 idle-without-result / `no_result` | 6 |
| SDK 升级后成批类型 / mock 适配报错 | 7、11 |
| session/load 或 resume 变慢、契约测试超时 | 8、9、12 |
| 升级后子 Agent 卡片降级成普通 tool | 13 |
| 已压缩会话恢复后丢压缩前历史 / steering | 14 |
| `npm ci` 报 `Missing ... from lock file` / EUSAGE | 10 |
| 测试成片失败、疑似环境变量污染 | 9（坑 1） |
| 拼接 append 型冲突后丢括号 / 对齐吞噬 | 9（坑 2）、11 |
| 挂在某分支上的副作用在上游新路径丢失 | 11 |

## 要点速记

1. 调查阶段全程只读（`git` / `gh api`），别在 plan mode 改 submodule。
2. submodule 是 detached HEAD；**本地 `main` 常过时**，基线用 `HEAD` / `origin/main` 的真实 sha。
3. 环境隔离：fork 单测带 `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN`；实测问题起独立 `node` 探针 + `CLAUDE_AGENT_LOGS=<dir>`。
4. AskUserQuestion：editor 主路径走标准 `elicitation.form/url`，fork 的 extMethod 仅兜底；**两路并存**（案例 2）。
5. `package.json` 解冲突当心**重复 key**；version/依赖取上游，build/esbuild 取我方。
6. 锁：在 `vendor/*` 重生成带 `--registry`（案例 10）；`npm ci --dry-run` 能过才算噪音可丢。
7. fork 测试已知 **6 个** Windows 路径分隔符失败是上游缺陷（案例 1 家族），非回归。
8. 契约测试默认 10s 内跑完；codex 腿用干净 `CODEX_HOME`。
9. 验证旧行为用 `git clone -q --no-hardlinks . /tmp/xxx`，不在工作区做破坏性 reset（案例 9 坑 5）。
10. **零冲突 ≠ 语义正确**：上游重构接口 / 新增校验 / 给已有函数加入参都可能静默遮蔽本地行为；typecheck + test + 契约测试都要跑（案例 5、6、14）。
11. **合并方式已改为选择性吸收**，不再 rebase；提交/推送仅在用户要求时做，推送 `main` 前先处理自动发布阻断项。

## 关键参考路径

- 根 `CLAUDE.md`「内置 ACP agent」节 + `scripts/release/vendor-install.mjs`、`package.json` 的 `agent:build`
- fork `CLAUDE.md`（本地行为清单 / 维护原则）+ `cases-session.md` / `cases-subagent.md` / `cases-permissions.md`
- `vendor/claude-agent-acp/src/{acp-agent.ts,tools.ts,interactive.ts,extra-models.ts}`、`vendor/claude-agent-acp/src/tests/{helpers.ts,session-doubles.ts,acp-scenarios/}`
- 主仓库 `apps/editor/src/renderer/services/acp/`（`acpClientService.ts` 的 `DEFAULT_INIT_PARAMS` 能力声明、`session/acpExtMethods.ts`、`session/acpSessionUpdateMeta.ts`）
- 跨仓契约测试 `apps/editor/integration/scenarios/acpForkContract.integration.test.ts` + `apps/editor/integration/fixtures/realForkConnection.ts`
- 台账与验证入口 `docs/development/claude-agent-maintenance.md`

## 其它
- 后续用本 skill，发现新经验，需同步更新本文件与 `references/cases.md`（新案例先在案例索引补一行）。
