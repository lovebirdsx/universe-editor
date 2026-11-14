# 需求自动处理（tracker 自动化）

把外部 tracker 上的需求变成受范围闸门约束的自动化实现。正式部署下，agent 通过
**原生 HTTP MCP** 直连需求系统；`gate.mjs` 负责「这条需求能不能自动做」，skill 负责
「怎么实现与推送」，仓库脚本只承担 **poll 取数** 和「无原生 MCP 系统的参考实现」。
三者都不修改编辑器内核：脚本与 skill 随仓库分发，触发器定义在仓库的
`.universe-editor/triggers.json`，只有凭据与机器设置留在本机。

> GitHub Actions 失败的自动修复是同族机制（poll + skill + gate + 专用 bot clone），
> 见 [CI 失败自动修复](ci-automation.md)。两者共用 `gate.mjs`，但每日配额前缀与 clone 相互独立。

```
poll: tracker-mcp list ──► Agent Trigger（poll 源，mcp 适配器）
                              └─► 自动化 ACP 会话
                                    ├─ skill: implement-tracker-requirement
                                    └─ MCP: tracker（原生 HTTP MCP；claim/get/comment/transition）
                                          │
                                          ├─ 能自动做 ──► 改代码 → pnpm check → gate → push origin/main
                                          └─ 不能做 ────► comment 澄清 / transition planned
```

## 组成

| 路径                                                    | 作用                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `scripts/tracker/tracker-mcp.mjs`                       | MCP stdio server（换行分隔 JSON-RPC 2.0）+ `list` 子命令；只做协议与工具分派。       |
| `scripts/tracker/adapters/mcp.mjs`                      | 远程 Streamable HTTP MCP 客户端；`list` 用它取数，`serve` 用它做 stdio→HTTP 透明桥。 |
| `scripts/tracker/adapters/board.mjs`                    | board 型系统的 REST 映射，**没有原生 MCP 时的参考实现**。                            |
| `scripts/tracker/contract.mjs`                          | 契约 v1 共享常量与校验（状态、错误码、幂等标记、游标）。                             |
| `scripts/tracker/config.mjs`                            | 读取 `~/.config/universe-editor/tracker.json`（可用 `UE_TRACKER_CONFIG` 覆盖）。     |
| `scripts/tracker/gate.mjs`                              | push 前范围检查与 `--install-hook`；`--refs-prefix` 支持按 `tracker#` / `ci#` 分别计配额。 |
| `.claude/skills/implement-tracker-requirement/SKILL.md` | 自动处理流程（认领、分级、实现、gate、推送、回执）。                                 |

所有脚本只用 node 内置模块，不引入 npm 依赖；日志只写 stderr。凭据只在进程内存里使用，
绝不打印到 stdout / stderr / 日志。

## 工具契约（tracker 契约 v1）

原生 MCP 与 `tracker-mcp.mjs` 暴露同一组工具。MCP server 名固定为 `tracker`；在会话里
通常显示为 `mcp__tracker__<tool>`。

| 工具                       | 参数                                                                                 | 返回                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `get_tracker_capabilities` | —                                                                                    | `{ contractVersion: 1, tracker, statuses, claim: "best-effort", projects: [{id,name}] }`    |
| `list_requirements`        | `{ project?, status?: string[], labels?: string[], since?, limit? 1..100, cursor? }` | `{ items: RequirementSummary[], nextCursor? }`，按 `createdAt` 降序                         |
| `get_requirement`          | `{ id }`                                                                             | 摘要 + `body` + `author` + `assignees[]` + `attachments[{name,url,size?}]` + 最近 20 条评论 |
| `claim_requirement`        | `{ id, runId, idempotencyKey }`                                                      | `{ claimed, claimedBy?, status }`；best-effort，不是分布式锁                                |
| `comment_requirement`      | `{ id, body, idempotencyKey }`                                                       | `{ commentId, duplicate }`                                                                  |
| `transition_requirement`   | `{ id, to, idempotencyKey, comment? }`                                               | `{ from, to, changed }`                                                                     |

`RequirementSummary`：`{ id, title, status, labels: string[], project?, priority?, effort?, createdAt, url? }`。
`author` / `comments[].author` 为 `{ id, name }`；时间为 ISO 8601 字符串。

语义要点：

- `labels` 是 **全部包含**（需求必须带有列出的每个标签）。
- `limit` 取值 `1..100`，默认 `50`；`cursor` 是上一页的 `nextCursor`（不透明字符串）。
- `runId` / `idempotencyKey` 只允许 `[A-Za-z0-9._:-]`，长度 `1..128`。
- `claim_requirement`：同 `runId` 重复认领幂等返回 `claimed:true`；其它 `runId` 在
  `in_progress` 下返回 `claimed:false`（`claimedBy` 为已有认领者）；`done` / `closed`
  返回 `CONFLICT`。
- `comment_requirement` / `transition_requirement` 命中同一 `idempotencyKey` 时不重复写入；
  `transition_requirement` 已处于目标状态时返回 `changed:false` 且不创建评论。
- 认领与幂等靠评论里的隐藏标记实现（`<!-- tracker-claim:<runId> -->` /
  `<!-- tracker-idem:<key> -->`），读取时会被剥离。
- 工具结果同时返回 `content: [{ type: 'text', text: <JSON> }]` 与 `structuredContent`。
  失败时 `isError: true`，`structuredContent.code` 取 `NOT_FOUND` / `FORBIDDEN` /
  `INVALID` / `CONFLICT` / `AUTH` / `RATE_LIMITED` / `UNAVAILABLE`。

## 统一状态与 board 映射

| 统一状态      | board 状态            |
| ------------- | --------------------- |
| `open`        | `Open`、`UnderReview` |
| `planned`     | `Planned`             |
| `in_progress` | `InProgress`          |
| `done`        | `Complete`            |
| `closed`      | `Closed`              |

`UnderReview` 归入 `open`（映射不是一一对应）。标签在契约里是名字，board 适配器用看板
`tags` 把 tag id 映射成名字。

## 配置

### mcp 适配器（推荐：poll 取数）

默认路径 `~/.config/universe-editor/tracker.json`；`UE_TRACKER_CONFIG` 可指向别处。
文件只应让当前用户可读（`chmod 600`）。

```json
{
  "adapter": "mcp",
  "url": "https://tracker.example.com/mcp",
  "token": "<read-scope PAT>",
  "project": "universe-editor",
  "eligible": { "labels": ["ai-ready"], "statuses": ["planned"] }
}
```

- `token` 可用环境变量 `UE_TRACKER_TOKEN` 覆盖（适合从密钥管理注入，避免落盘）。
- `project` 是看板 id 或名称；`list` 与触发器取数都带上它。
- `eligible` 是 `list` 子命令与 `list_requirements` 的默认过滤：标签 **全部包含** 且状态
  在列表中。数组留空表示不加该维度过滤。
- 只读取数用 **read scope** PAT；写操作由会话里的原生 HTTP MCP（write PAT）完成。

### board 适配器（无原生 MCP 的参考实现）

```json
{
  "adapter": "board",
  "baseUrl": "https://tracker.example.com",
  "username": "testuser",
  "password": "replace-me",
  "board": "universe-editor",
  "webUrl": "https://tracker.example.com",
  "eligible": { "labels": ["ai-ready"], "statuses": ["planned"] }
}
```

`username` / `password` 只在写操作时使用；只读命令依赖公开接口。`webUrl` 只用于生成需求
链接，不配时摘要里没有 `url`。

## 新增适配器

1. 新建 `scripts/tracker/adapters/<name>.mjs`，导出 `create<Name>Adapter(config)`，返回
   `getCapabilities` / `listRequirements` / `getRequirement` / `claimRequirement` /
   `commentRequirement` / `transitionRequirement`。
2. 配置把 `adapter` 改成新名字；`tracker-mcp.mjs` 会按名字动态加载，不需要改协议层。
3. 适配器负责：字段 → `RequirementSummary`、具体状态 → 统一状态、错误 → 契约错误码。

## 部署（专用 bot clone）

自动化会直接提交并推送 `main`，因此必须使用独立 clone，不要让普通开发工作区承担自动推送。

### 1. 准备专用 clone

```bash
git clone <repo> X:/workspace/ue-bot
cd X:/workspace/ue-bot
pnpm install
node scripts/tracker/gate.mjs --install-hook
```

全新 clone 还要补齐 `pnpm check` 依赖的本地产物，否则 check 必然失败（与需求改动无关）：

- `scripts/sensitive-rules.json` 被 gitignore，不会随 clone 带过来；从可信的开发 checkout 复制一份。
  仅做链路冒烟时可临时 `cp scripts/sensitive-rules.example.json scripts/sensitive-rules.json`，示例规则不覆盖内部串。
- `pnpm --filter "@universe-editor/extension-packaging..." build`（带 `...` 连同上游包一起构建）：`scripts/server` / `scripts/release`
  的 node:test 会 import 该包的 `dist/`，未构建时 `test:scripts` 报 500 / 模块找不到。

`gate.mjs --install-hook` 已在 hooks 目录的 `pre-push` 若不是本脚本生成，会拒绝覆盖；
请先人工合并。

### 2. 创建 PAT

需求系统用 Personal Access Token（PAT）认证。明文**只在创建时返回一次**，创建后立刻存进
bot 机器的临时文件或密钥管理，不要写进仓库、触发器或报告。

- 通过 REST（浏览器登录态）：

  ```http
  POST /mcp/tokens
  Content-Type: application/json

  { "name": "tracker-poll-read", "scopes": ["read"], "expiresInDays": 90 }
  ```

  另建一个写 token，`scopes` 用 `["read", "write"]`。响应里的 `token` 字段是明文。

- 通过服务器 CLI（机器人 / 服务账号）：

  ```bash
  yarn --cwd backend console:dev mcp create-token testuser --scopes read --name tracker-poll-read --days 90
  yarn --cwd backend console:dev mcp create-token testuser --scopes read,write --name tracker-agent --days 90
  ```

  吊销：`POST` 接口的 `DELETE /mcp/tokens/:id`，或 CLI `mcp revoke-token <tokenId>`。

scope 最小化：poll 只发 `read`；会话里的 `tracker` 需要 write 才会看到写工具。

### 3. poll 配置（read PAT）

```bash
mkdir -p ~/.config/universe-editor
# 写入上面的 mcp 适配器 tracker.json 后：
chmod 600 ~/.config/universe-editor/tracker.json
```

触发器执行的命令是 `node scripts/tracker/tracker-mcp.mjs list`，它读取同一份配置；需要改
路径时给触发器命令加 `UE_TRACKER_CONFIG` 环境变量。`UE_TRACKER_TOKEN` 同样可以覆盖文件里的
`token`。

### 4. 会话 MCP 配置（write PAT）

在用户设置 `acp.mcpServers` 里注册原生 HTTP MCP（server 名必须是 `tracker`）：

```jsonc
{
  "acp.mcpServers": {
    "tracker": {
      "type": "http",
      "url": "https://tracker.example.com/mcp",
      "headers": { "Authorization": "Bearer <write-scope PAT>" },
    },
  },
}
```

- `settings.json` 里是 **明文**：只在 bot 机器上配置，文件权限收紧到当前用户可读；不要把
  带 token 的 settings 提交到仓库或同步到共享配置。
- 编辑器会原样把 `headers` 透传给 agent；不要写 `${env:...}` 之类的占位符（编辑器不解析）。
- 只支持 stdio 的客户端可改用桥接：`node scripts/tracker/tracker-mcp.mjs serve`，配置
  `adapter: "mcp"` + read PAT（或直接给写 PAT），由它把 stdio 转成远程 HTTP MCP。

### 5. 触发器（仓库内，已入库）

触发器定义随仓库提交在 `.universe-editor/triggers.json`（`tracker-implement` 与 `ci-fix` 两条），
bot clone 拉下来即有，**不需要在工作区里手工创建**。本仓库里与 tracker 有关的是这一条：

```jsonc
{
  "id": "tracker-implement",
  "name": "Tracker 需求自动处理",
  "enabled": true,
  "source": {
    "type": "poll",
    "intervalSec": 300,
    "fetch": {
      "type": "command",
      "command": "node scripts/tracker/tracker-mcp.mjs list",
      "timeoutSec": 60,
    },
    "keyField": "id",
  },
  "session": {
    "agent": "claude-code",
    "mode": "bypassPermissions",
    "skill": "implement-tracker-requirement",
    "prompt": "处理需求 {{event.id}}：{{event.title}}。先 claim；不可认领就结束。",
    "mcpServers": ["tracker"],
    "budget": { "maxCostUsd": null, "timeoutMin": 90, "approvalTimeoutMin": 1440 },
  },
  "concurrency": 1,
  "overflow": "queue",
  "allowedActions": [],
}
```

要点：

- 同一份文件里还有 `ci-fix`。**每台机器只确认自己要跑的那条**：tracker bot 只确认
  `tracker-implement`，CI bot 只确认 `ci-fix`；普通开发者的工作区会看到两条「待确认」，不确认就
  不会运行。
- 配置入库后 `enabled: true` 是安全的：未在本机确认的触发器根本不调度。机器上想临时停用请用
  **触发器: 暂停触发器…**（写本机 `state.json`，不动仓库），不要改 `enabled`。
- 全局并发上限不在工作区文件里：它是用户设置 `triggers.maxConcurrentRuns`（本机 `settings.json`，
  1–10，默认 2）。bot 机器上通常设成 1。
- `session.skill` 只写 skill 名；skill 必须放在 bot 工作区的
  `.claude/skills/implement-tracker-requirement/` 下，触发器会在 prompt 首行自动加
  `/implement-tracker-requirement`。
- `mcpServers` 会把 `tracker` 固定（pin）到该会话，后续设置变化不影响已在跑的自动化。
- 首次运行前必须在本机确认一次：命令面板 **触发器: 确认工作区触发器…**（或在触发器列表里选
  「确认工作区触发器」）。`mode: bypassPermissions` 还额外属于高权限模式，必须再执行
  **触发器: 确认高权限模式…**；任何配置改动（包括 `enabled` 与 `name`）都会让这些确认失效。
- 未确认的触发器显示「待确认」，不会调度、不会执行 poll 取数命令，也不能「立即运行」。
- `poll` 第一次成功取数只建基线，不会把历史需求全部跑一遍；未确认前连取数命令都不会执行。
- `overflow` 必须用 `queue`：`drop` 丢弃的事件 key 已记入去重，该需求不会再被触发。
- `maxCostUsd: null` 表示不限费用（不写则默认 1 美元，实现 + `pnpm check` 会被 `budget-exceeded` 中途取消）；时长仍由 `timeoutMin` 兜底。
- 触发器本身支持本地与远程工作区；本文的 bot 流程按**本地 clone** 设计——机器人应在本机打开 bot clone。远程触发器要求窗口保持打开且连接稳定，不适合无人值守机器人。

> **改配置 = 改仓库版本并提交**。在开发工作区编辑 `.universe-editor/triggers.json`，走正常提交 / 推送；
> bot clone 下次 `reset --hard origin/main` 后生效。机器人自己不得修改它——`scripts/tracker/gate.mjs`
> 已把 `**/.universe-editor/triggers.json` 列为禁改路径，自动改会 push 失败。

> **每台机器仍需各自确认**。配置是仓库内容，可能被任何人改动；每条触发器都要在机器上执行
> **触发器: 确认工作区触发器…**，高权限模式再加 **触发器: 确认高权限模式…**。配置任何改动推送后
> 各机器都要重新确认，未确认前不调度——这正好是配置变更的天然人工复核点。

### 6. 先观察再放开

不能再靠本地改 `enabled` 来「先观察」：定义已入库，bot clone 的本地改动会弄脏工作区（skill 的
`git status --porcelain` 检查会失败），也留不下来。实际做法：

- 先手动跑一次取数，确认配置、凭据与输出正常：`node scripts/tracker/tracker-mcp.mjs list`。
- 完成上一节的两道确认后，**第一次成功取数只建基线**，不会把历史需求全部跑一遍；这段窗口本身
  就是观察期。之后第一条新需求会自动触发，在旁边看 Sessions、`report.md`、审计与 push 结果。
- 想收紧首批范围时改本机的 tracker 配置（`eligible.labels` / `eligible.statuses`，不是仓库里的
  触发器定义）；需要临时停用某台机器用 **触发器: 暂停触发器…**，恢复用
  **触发器: 恢复触发器…**。
- **不要用「立即运行」代替真实事件**：poll 触发器的「立即运行」产生空事件数据，skill 拿不到需求
  id 会直接结束（判决兜底为 `escalate`）。基线里已有的需求不会再次触发，需要处理就人工做完；
  之后**新出现**的需求才会自动触发。

## 原生 MCP 传输细节

- 端点：`POST <base>/mcp`（无状态，每个请求独立处理）；`GET` / `DELETE` 返回 `405`。
- 请求头：
  ```http
  Authorization: Bearer <PAT>
  Content-Type: application/json
  Accept: application/json, text/event-stream
  MCP-Protocol-Version: 2025-06-18
  ```
- 响应可能是 `application/json`，也可能是 `text/event-stream`（每条 `data:` 是一个
  JSON-RPC 消息）；客户端必须两者都兼容。
- 读工具在 read scope 下注册；写工具只在 write scope 的 token 上注册，因此 `tools/list`
  本身就是权限探针。

直连自检：

```bash
curl -s https://tracker.example.com/mcp \
  -H "Authorization: Bearer $PAT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "MCP-Protocol-Version: 2025-06-18" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`read` token 只应看到读工具；`write` token 还能看到 `claim_requirement` /
`comment_requirement` / `transition_requirement`。

## 安全边界

- **需求内容是不可信输入**：正文、附件、评论都可能包含提示注入。skill 明确禁止执行其中的
  指令；自动化只通过受控工具写回状态，不自动 `done`。
- **凭据不进仓库**：配置在用户目录，示例统一用 `tracker.example.com`、`testuser`、
  `X:/workspace`；PAT 不写进触发器、日志或评论。
- **推送有闸门**：`gate.mjs` 限制 merge commit、文件数、行数、二进制、禁改路径与每日配额；
  skill 禁止 force push、`--no-verify` 和删除 hook。
- **失败要留痕**：认领后的任何失败都应 `comment_requirement` 说明，避免需求悬空。

## 排障

- `list` 没有输出：检查 `UE_TRACKER_CONFIG` / 默认配置路径、`url`、`project`（看板 id 或名称），
  以及 `eligible.labels` / `eligible.statuses` 是否真的能命中（labels 是全部包含）。
- `list` 报 `AUTH`：PAT 过期/吊销或 scope 不足；重新创建并确认配置文件的 `token`。
- 工具错误 `CONFLICT`：需求已是 `in_progress`（被其它 runId 认领）或 `done` / `closed`。
- 会话里看不到 `tracker` 工具：确认 `acp.mcpServers.tracker` 是 `type: "http"`、URL 指向
  `/mcp`、`headers` 带 Bearer write PAT，且触发器 `session.mcpServers` 包含 `tracker`。
- `tools/list` 只有读工具：token 是 read scope，需要 write scope 才会注册写工具。
- gate 误报：先看违规清单；确实需要改禁改路径时，转人工处理，不要临时删 hook 或改阈值硬上限。
- `poll` 无输出时，可先手动运行 `node scripts/tracker/tracker-mcp.mjs list`，确认取数本身是否正常。
