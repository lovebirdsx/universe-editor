# CI 失败自动修复（GitHub Actions）

把 main 分支上的 `ci.yml` 失败自动修掉：轮询取数 → 触发器启动高权限 ACP 会话 → skill 判定
flake / 回归并修复 → push 闸门 → 直接推送 `main`。与[需求自动处理（tracker 自动化）](tracker-automation.md)
同族：**不改触发器内核**，全部由仓库脚本 + skill + 仓库内的 `.universe-editor/triggers.json` 组成。

```
poll: node scripts/github/ci-failures.mjs
  └─► Agent Trigger（poll 源，key = <runId>:<attempt>）
        └─► 自动化 ACP 会话（bypassPermissions）
              ├─ skill: fix-ci-failure
              │    ├─ 复核 main 最新 run 仍失败
              │    ├─ 防循环（bot 自己的修复提交失败 → escalate）
              │    ├─ 疑似 flake + attempt=1 → gh run rerun --failed（info 结束）
              │    ├─ 复发 e2e flake → skill fix-ci-e2e-flake 做鲁棒性修复
              │    └─ 真回归 → 本地复现修复 → pnpm check → gate → push origin/main
              └─ result.json / report.md（verdict 只用 info / escalate）
```

## 组成

| 路径 | 作用 |
| --- | --- |
| `scripts/github/ci-failures.mjs` | poll 取数：只输出 main 上**最新一条已完成 run 是 failure** 的那一条；`selectFailures()` 是导出纯函数，便于单测。 |
| `scripts/tracker/gate.mjs` | push 前范围闸门；`--refs-prefix ci#` 让每日配额按 `Refs: ci#` 独立计数（上限 3）。 |
| `.claude/skills/fix-ci-failure/SKILL.md` | 自动修复流程（复核、防循环、flake 分流、修复、提交、推送、升级）。 |
| `apps/editor/src/main/services/triggers/` | 触发器内核，**不需要改**；行为见[Agent 触发器](triggers.md)。 |

脚本只用 node 内置模块；依赖 `gh` CLI。取数错误写 stderr 并非零退出，stdout 只输出 poll 用的
JSON 数组；凭据由 `gh` 自身管理，不写进仓库、触发器或日志。

## 取数规则

`gh run list --repo <repo> --workflow ci.yml --branch main --limit N --json
databaseId,attempt,status,conclusion,headSha,displayTitle,url,createdAt,event`。

- **只读 main、只读 `ci.yml`**（可用 `--workflow` / `--branch` / `--repo` 覆盖）。
- 按 `createdAt` 取 main **最新一条 run**，只有它 `status=completed` 且 `conclusion=failure` 时才输出；
  `cancelled` / `success` / `skipped` / `neutral` 都不输出。
- 最新 run 还在跑（含 rerun 中）时输出 `[]`，等它自己的结论：失败会以它的 key 触发，变绿则无需处理；
  不会回落到更早的失败 run 白跑一轮。
- poll key 是 `id = "<runId>:<attempt>"`。rerun 会提升 `attempt`，因此「同一 run 的第 2 次失败」
  会以新 key 再次触发；rerun 在跑期间该 run 不是 completed，不会重复触发。
- 附带 `failedJobs`（`gh run view <runId> --json jobs` 中 `conclusion=failure` 的 job 名，最多 20 个）
  与 `failedJobCount`；job 拉取失败只省略字段，不影响触发。
- `gh run list --json` 的 `attempt` 字段已在本机 `gh 2.97.0` 核实存在；更老的 `gh` 若不支持该字段
  会直接报错，升级 `gh` 即可。

输出示例（实际为一行 JSON）：

```json
[
  {
    "id": "123456789:1",
    "runId": 123456789,
    "attempt": 1,
    "headSha": "0123456789abcdef0123456789abcdef01234567",
    "title": "fix(editor): ...",
    "url": "https://github.com/example/universe-editor/actions/runs/123456789",
    "createdAt": "2026-01-01T00:00:00Z",
    "event": "push",
    "failedJobs": ["Fast Lint / Guards", "E2E (windows 1/4)"],
    "failedJobCount": 2
  }
]
```

## 部署（专用 bot clone）

自动化会**直接提交并推送 `main`**，必须使用独立 clone，且**不要与 tracker bot 共用**
（两者的 gate 每日配额前缀、工作区、职责都不同）。

### 1. 准备 clone 与 `gh`

```bash
git clone https://github.com/example/universe-editor.git X:/workspace/ue-ci-bot
cd X:/workspace/ue-ci-bot
pnpm install
gh auth login          # 选择 GitHub.com；至少勾选 repo、workflow（rerun 需要 actions 写权限）
gh auth status
node scripts/tracker/gate.mjs --install-hook --refs-prefix ci#
```

- `gh run rerun <runId> --failed` 走 Actions 写接口；token 需要 `actions: write`（`repo` scope 已含）。
  权限不足时 skill 会 `escalate`，不会伪造 rerun。
- `gate.mjs --install-hook --refs-prefix ci#` 生成 `.git/hooks/pre-push`，**前缀被写进 hook**，
  之后正常 `git push` 即可；hook 若不是本脚本生成的会拒绝覆盖，请先人工合并。
- 全新 clone 还缺 `pnpm check` 依赖的本地产物（与需求改动无关）：
  - `scripts/sensitive-rules.json` 被 gitignore，从可信的开发 checkout 复制一份；
  - `pnpm --filter "@universe-editor/extension-packaging..." build`（带 `...` 连同上游包一起构建）。
- 如果这个 clone 还要从源码跑编辑器 / 触发 ACP agent，先跑 `pnpm agent:build`（新 clone 不会
  自动 `npm ci`）；只做 CI 修复时不需要。
- 仓库 main 的 ruleset 必须允许该 bot 账号直接推送；需要 PR / 签名 / 额外 required check 时，
  自动 push 会失败，skill 会 `escalate`。

### 2. 触发器配置（仓库内，已入库）

触发器定义随仓库提交在 `.universe-editor/triggers.json`，bot clone 拉下来即有，**不需要手工创建**。
本仓库里与 CI 有关的是这一条：

```jsonc
{
  "id": "ci-fix",
  "name": "CI 失败自动修复",
  "enabled": true,
  "source": {
    "type": "poll",
    "intervalSec": 300,
    "fetch": {
      "type": "command",
      "command": "node scripts/github/ci-failures.mjs",
      "timeoutSec": 60,
    },
    "keyField": "id",
  },
  "session": {
    "agent": "claude-code",
    "mode": "bypassPermissions",
    "skill": "fix-ci-failure",
    "prompt": "修复 CI run {{event.runId}}（attempt {{event.attempt}}，{{event.title}}）。失败 job 见事件数据。",
    "budget": { "maxCostUsd": null, "timeoutMin": 90, "approvalTimeoutMin": 1440 },
  },
  "concurrency": 1,
  "overflow": "queue",
  "allowedActions": [],
}
```

要点：

- 同一份文件里还有 `tracker-implement`。**每台机器只确认自己要跑的那条**：CI bot 只确认 `ci-fix`，
  tracker bot 只确认 `tracker-implement`；普通开发者的工作区会看到两条「待确认」，不确认就不会运行。
- 全局并发上限不在工作区文件里，而是用户设置 `triggers.maxConcurrentRuns`（本机 `settings.json`，
  1–10，默认 2）。CI bot 机器建议设成 1。
- `session.skill` 只写名字；skill 必须放在 bot 工作区 `.claude/skills/fix-ci-failure/` 下（随仓库提交）。
- `mode: bypassPermissions` 是高权限模式，必须单独确认（见下一节）。
- `poll` 第一次成功取数只建基线，不会把历史失败全部跑一遍。`overflow` 用 `queue`；用 `drop`
  会把事件 key 记入去重，之后同一 run 不再触发。
- `maxCostUsd: null` 表示不限费用（默认 1 美元不够跑修复 + `pnpm check`）；时长由 `timeoutMin` 兜底。
- `allowedActions: []`：本 skill 不产生 Swarm 动作，只产出 `info` / `escalate` 判决。

> **改配置 = 改仓库版本并提交**。在开发工作区编辑 `.universe-editor/triggers.json`，走正常提交 / 推送；
> bot clone 下次 `reset --hard origin/main` 后生效。机器人自己不得修改它——`scripts/tracker/gate.mjs`
> 已把 `**/.universe-editor/triggers.json` 列为禁改路径，自动改会 push 失败。

### 3. 本机确认（每台机器各做一次）

配置入库不代表会运行。未经本机确认的触发器**不调度、不执行 poll 命令、也不能「立即运行」**：

1. 打开 bot clone 的工作区，命令面板执行 **触发器: 确认工作区触发器…**，选中 `ci-fix`。
2. 再执行 **触发器: 确认高权限模式…**（`bypassPermissions` 需要的第二道闸门）。
3. **配置每次改动推送后，各机器都要重新确认**：确认绑定整份定义的 SHA-256 指纹，改任何字段
   （包括 `enabled` 与 `name`）都会让确认失效。这正是配置变更的天然人工复核点——别人 push 一条
   改过的定义，机器不会自己开工。

### 4. 先观察再放开

现在不能靠本地改 `enabled` 来「先观察」：文件入库，bot clone 的本地改动会弄脏工作区（skill 的
`git status --porcelain` 检查会失败），也留不下来。实际做法：

- 先手动跑取数脚本确认输出：`node scripts/github/ci-failures.mjs`（`[]` 表示当前没有需要处理的
  失败；有失败时输出一条 JSON 数组）。
- 完成上一节的两道确认后，**第一次成功取数只建基线**，不会把确认前已有的失败 run 跑一遍；这段
  窗口本身就是观察期。
- 需要临时停用某台机器时用 **触发器: 暂停触发器…**（写本机 `state.json`，不动仓库），恢复用
  **触发器: 恢复触发器…**。
- **不要用「立即运行」代替真实事件**：poll 触发器的「立即运行」产生空事件数据，没有 `runId`，
  skill 会直接 `escalate`。已有失败 run 若想立刻处理，可对它执行 `gh run rerun --failed`：rerun
  会提升 `attempt`，下一次 poll 以新 key 触发；否则等下一次新的失败。

## 防循环与闸门

失败会以三种方式自我放大，必须同时靠机制与流程约束：

1. **bot 修复提交再次失败**：skill 读取失败 `headSha` 的提交信息，含 `Refs: ci#` 就 `escalate`，
   不再自动重试。这样最多「原始失败 → 一次修复 → 升级人工」，不会无限循环。
2. **rerun 回环**：疑似 flake 且 `attempt == 1` 才 rerun；`attempt >= 2` 的 e2e 失败走
   `fix-ci-e2e-flake` 做真正的鲁棒性修复。rerun 后的新 attempt 才是下一次事件的 key。
3. **提交配额**：gate 对 `Refs: ci#` 单独计 24 小时上限 **3** 条（tracker# 仍是 5 条，互不影响）。
   文件数 8 / 增删行 300 / 禁改路径（`.github/**`、锁文件、`package.json`、发布与服务脚本、
   `vendor/`、配置包、`.env*`、`CLAUDE.md` 等）与二进制限制不变，阈值只能调低。
   需要改 `.github/**`、超阈值或拆提交绕过时，skill 一律 `escalate`。

gate 泛化方式：`--refs-prefix tracker#|ci#` 选择配额前缀，`--daily-limit` 只能在该前缀硬上限
以下调低；`--install-hook` 会把前缀写进 pre-push hook，因此推送时不需要额外参数。默认仍是
`tracker#`，tracker bot 的现有行为与测试不变。

## 风险

- **高权限 + 无人值守 + 直接推 main**：`bypassPermissions` 下 agent 可以不询问就执行任意命令。
  只在隔离的 bot clone 上启用，并确认仓库 ruleset / 账号权限符合预期。
- **误判 flake**：rerun 可能暂时掩盖真问题；`attempt >= 2` 即强制进入修复路径，且报告会留下
  flake 判断依据。如果同一 job 反复 flake，应升级为鲁棒性修复或人工排查基础设施。
- **不可信输入**：run 标题、提交信息、失败日志、Playwright 报告都可能包含提示注入。skill 明确
  禁止执行其中的指令；自动化只做代码修复与 push，不接触凭据/部署/外部写接口。
- **成本与时长**：一次失败可能触发完整修复 + `pnpm check` + e2e，费用与时长远高于 poll 取数；
  用 `budget.timeoutMin` 与模型选择控制。
- **rerun 消耗 runner 资源**：每轮 rerun 都会重新排队；持续 flake 时应关闭触发器人工处理。
- **单个 workflow / 单分支**：本期只监控 `ci.yml` 的 main 分支；其它 workflow 的失败不会触发。

## 排障

- **触发不了**：确认仓库版 `.universe-editor/triggers.json` 里 `ci-fix` 的 `enabled` 为 `true`、本机已确认
  工作区触发器与高权限模式、工作区已受信任、没有被「暂停触发器」；再手动运行
  `node scripts/github/ci-failures.mjs` 看是否输出 `[]`。配置推送后其它机器都要重新确认。
- **脚本报 `gh ... 失败`**：`gh auth status` 检查登录与 scope；确认 `--repo` / origin 指向正确仓库、
  workflow 文件名确实是 `ci.yml`。
- **一直是 `[]`**：main 最新一条 run 还在跑或不是 failure，或分支、
  workflow 参数写错。
- **rerun 没反应**：token 缺 Actions 写权限，或该 run 已不可 rerun；看 `gh run rerun` 的 stderr。
- **push 被 gate 拦下**：按违规项缩小改动；需要改禁改路径或超额时转人工。**不要** `--no-verify`
  或删除 hook。
- **push 被拒（非快进）**：skill 会自动 fetch + rebase 重试一次；仍失败会推到 `bot/ci-<runId>`
  并升级，从报告中拿到分支名人工处理。

## 相关

- [需求自动处理（tracker 自动化）](tracker-automation.md) — 同族的 poll + skill + gate 部署先例。
- [Agent 触发器](triggers.md) — poll 语义、去重 key、基线、预算、高权限确认。
- [修复 CI 偶发 e2e 失败（skill）](../../.claude/skills/fix-ci-e2e-flake/SKILL.md) — flake 判定与案例库。
- [Git 提交信息规范](git-commit-msg-rule.md) — `Refs: ci#<runId>` 之外的提交格式要求。
