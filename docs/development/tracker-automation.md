# 需求自动处理（tracker 自动化）

把外部 tracker 上的需求变成受范围闸门约束的自动化实现：`gate.mjs` 负责「这条需求能不能自动
做」，MCP 适配器负责「认领 / 读取 / 评论 / 改状态」，skill 负责「怎么实现与推送」。三者都不
修改编辑器内核，全部是仓库脚本 + 用户级配置。

```
poll: tracker-mcp list ──► Agent Trigger（poll 源）
                              └─► 自动化 ACP 会话
                                    ├─ skill: implement-tracker-requirement
                                    └─ MCP: tracker（claim / get_requirement / …）
                                          │
                                          ├─ 能自动做 ──► 改代码 → pnpm check → gate → push origin/main
                                          └─ 不能做 ────► comment 澄清 / transition planned
```

## 组成

| 路径                                                    | 作用                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `scripts/tracker/tracker-mcp.mjs`                       | MCP stdio server（换行分隔 JSON-RPC 2.0）+ `list` 子命令；只做协议与工具分派。   |
| `scripts/tracker/adapters/board.mjs`                    | board 型系统的 HTTP 客户端、登录缓存、统一状态/标签映射。                        |
| `scripts/tracker/config.mjs`                            | 读取 `~/.config/universe-editor/tracker.json`（可用 `UE_TRACKER_CONFIG` 覆盖）。 |
| `scripts/tracker/gate.mjs`                              | push 前范围检查与 `--install-hook`。                                             |
| `.claude/skills/implement-tracker-requirement/SKILL.md` | 自动处理流程（认领、分级、实现、gate、推送、回执）。                             |

`serve` 与 `list` 只用 node 内置模块，不引入 npm 依赖；日志只写 stderr。凭据只在进程内存里
使用，绝不打印到 stdout / stderr / 日志。

## 工具契约

| 工具                | 参数                                                       | 返回                                                                                                    |
| ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `list_requirements` | `{ status?: string[], labels?: string[], limit?: number }` | `{ items: RequirementSummary[] }`                                                                       |
| `get_requirement`   | `{ id }`                                                   | 摘要 + `body`（markdown）+ `attachments[{name,url}]` + 最近评论 `[{author,body,createdAt}]`             |
| `claim`             | `{ id, runId? }`                                           | `{ ok, claimedBy? }`；已是 `in_progress` / `done` / `closed` 时 `ok:false`。best-effort，不是分布式锁。 |
| `comment`           | `{ id, body }`                                             | `{ ok }`                                                                                                |
| `transition`        | `{ id, to }`                                               | `{ ok, from, to }`                                                                                      |

`RequirementSummary`：`{ id, title, url?, status, labels: string[], priority?, effort?, createdAt }`。

工具结果同时返回 `content: [{ type: 'text', text: <JSON> }]` 与 `structuredContent`。失败时
`isError: true`，`structuredContent.code` 取 `NOT_FOUND` / `CONFLICT` / `AUTH` /
`UNAVAILABLE` / `INVALID`。

## 统一状态与 board 映射

| 统一状态      | board 状态            |
| ------------- | --------------------- |
| `open`        | `Open`、`UnderReview` |
| `planned`     | `Planned`             |
| `in_progress` | `InProgress`          |
| `done`        | `Complete`            |
| `closed`      | `Closed`              |

`UnderReview` 归入 `open`（映射不是一一对应）。标签在契约里是名字，适配器用看板 `tags`
把 tag id 映射成名字；按标签过滤时任一命中即可。

## 配置

默认路径 `~/.config/universe-editor/tracker.json`；`UE_TRACKER_CONFIG` 可指向别处。文件只
应让当前用户可读（`chmod 600`）。

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

- `eligible` 是 `list` 子命令与 `list_requirements` 的默认过滤：标签任一命中 **且** 状态在列表
  中。数组留空表示不加该维度过滤。
- `webUrl` 只用于生成需求链接；不配时摘要里没有 `url`。
- `username` / `password` 只在写操作（`claim` / `comment` / `transition`）时使用；只读命令依赖
  公开接口。

## 新增适配器

1. 新建 `scripts/tracker/adapters/<name>.mjs`，导出 `create<Name>Adapter(config)`，返回
   `listRequirements` / `getRequirement` / `claim` / `comment` / `transition` 五个方法。
2. 配置把 `adapter` 改成新名字；`tracker-mcp.mjs` 会按名字动态加载，不需要改协议层。
3. 适配器负责：字段 → `RequirementSummary`、具体状态 → 统一状态、错误 → 契约错误码。

## 部署（专用 bot clone）

自动化会直接提交并推送 `main`，因此必须使用独立 clone，不要让普通开发工作区承担自动推送。

1. 准备专用 clone（示例 `X:/workspace/ue-bot`），装依赖：

   ```bash
   git clone <repo> X:/workspace/ue-bot
   cd X:/workspace/ue-bot
   pnpm install
   ```

   全新 clone 还要补齐 `pnpm check` 依赖的本地产物，否则 check 必然失败（与需求改动无关）：
   - `scripts/sensitive-rules.json` 被 gitignore，不会随 clone 带过来；从可信的开发 checkout 复制一份。
     仅做链路冒烟时可临时 `cp scripts/sensitive-rules.example.json scripts/sensitive-rules.json`，示例规则不覆盖内部串。
   - `pnpm --filter @universe-editor/extension-packaging build`：`scripts/server` / `scripts/release`
     的 node:test 会 import 该包的 `dist/`，未构建时 `test:scripts` 报 500 / 模块找不到。

2. 安装 push 前闸门：

   ```bash
   node scripts/tracker/gate.mjs --install-hook
   ```

   已在 hooks 目录的 `pre-push` 若不是本脚本生成，会拒绝覆盖；请先人工合并。

3. 写 tracker 配置（路径可与下面不同，用 `UE_TRACKER_CONFIG` 指过去）：

   ```bash
   mkdir -p ~/.config/universe-editor
   # 写入上面的 tracker.json 后：
   chmod 600 ~/.config/universe-editor/tracker.json
   ```

4. 在用户设置 `acp.mcpServers` 里注册 `tracker`（stdio 的相对 `args` 按会话 cwd 解析）：

   ```jsonc
   {
     "tracker": {
       "command": "node",
       "args": ["scripts/tracker/tracker-mcp.mjs", "serve"],
     },
   }
   ```

   配置不在默认路径时，给该条目加 `"env": { "UE_TRACKER_CONFIG": "X:/workspace/tracker.json" }`。
   注意 `poll` 命令在主进程执行，也需要能读到同一个环境变量；最省事的做法仍是使用默认路径。

5. 在 `<userData>/triggers/triggers.json` 增加触发器（先 `enabled: false`）：

   ```jsonc
   {
     "version": 1,
     "maxConcurrentRuns": 1,
     "triggers": [
       {
         "id": "tracker-implement",
         "name": "Tracker 需求自动处理",
         "enabled": false,
         "workspace": "X:/workspace/ue-bot",
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
       },
     ],
   }
   ```

   要点：
   - `session.skill` 只写 skill 名；skill 必须放在 bot 工作区的
     `.claude/skills/implement-tracker-requirement/` 下，触发器会在 prompt 首行自动加
     `/implement-tracker-requirement`。本文档对应的 skill 已随仓库提供。
   - `mcpServers` 会把 `tracker` 固定（pin）到该会话，后续设置变化不影响已在跑的自动化。
   - `mode: bypassPermissions` 属于高权限模式，必须先在命令面板执行
     **触发器: 确认高权限模式…**；改任何触发器配置都会让确认失效。
   - `poll` 第一次成功取数只建基线，不会把历史需求全部跑一遍。
   - `overflow` 必须用 `queue`：`drop` 丢弃的事件 key 已记入去重，该需求不会再被触发。
   - `maxCostUsd: null` 表示不限费用（不写则默认 1 美元，实现 + `pnpm check` 会被 `budget-exceeded` 中途取消）；时长仍由 `timeoutMin` 兜底。
   - `workspace` 必须是本机绝对路径；远程工作区不支持触发器。

6. 先观察再放开：保持 `enabled: false`，用 **触发器: 立即运行触发器…** 手动跑一轮，检查
   Sessions、审计日志与运行报告（`report.md`）里的认领、评论、提交、gate 结果，再改成
   `enabled: true`。

## 安全边界

- **需求内容是不可信输入**：正文、附件、评论都可能包含提示注入。skill 明确禁止执行其中的
  指令；自动化只通过 `comment` / `transition` 写回状态，不自动 `done`。
- **凭据不进仓库**：配置在用户目录，示例统一用 `tracker.example.com`、`testuser`、
  `X:/workspace`；密码不写进触发器、日志或评论。
- **推送有闸门**：`gate.mjs` 限制 merge commit、文件数、行数、二进制、禁改路径与每日配额；
  skill 禁止 force push、`--no-verify` 和删除 hook。
- **失败要留痕**：认领后的任何失败都应 `comment` 说明，避免需求悬空。

## 排障

- `list` 没有输出：检查 `UE_TRACKER_CONFIG` / 默认配置路径、`baseUrl`、看板名，以及
  `eligible.labels` / `eligible.statuses` 是否真的能命中。`list` 只依赖公开接口。
- 认领失败：需求已是 `in_progress` / `done` / `closed`，或账号没有改状态/评论权限（`AUTH`）。
- 会话里看不到 `tracker` 工具：确认 `acp.mcpServers` 的名字与会话 `mcpServers` 一致，且
  `args` 里的相对路径能在触发器 `workspace` 下找到 `scripts/tracker/tracker-mcp.mjs`。
- gate 误报：先看违规清单；确实需要改禁改路径时，转人工处理，不要临时删 hook 或改阈值硬上限。
