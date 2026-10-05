# 案例：计划模式的两级静默批准（plan-scoped / unscoped approve）

> 本文是 [`../CLAUDE.md`](CLAUDE.md) 套路 ACP-D 的案例拆分：讲清两个设置
> （`acp.plan.autoApproveWithUpdates` / `acp.plan.autoApproveUnscoped`）为什么存在、判定条件、
> fork 契约点与风险。改动该策略前通读本页。

## 背景：CLI 2.1.287 的 plan 回归

从 `bypassPermissions` 直接切到 plan 时，CLI 2.1.287 不启用 "auto mode during plan" 分类器
（`prepareContextForPlanMode` 对 bypass 走 plain plan entry），于是工作区外的读取/命令退回逐条询问；
2.1.220 不询问。同命令同 cwd 的 A/B 对照里只有 `bypassPermissions→plan` 这一格由 allow 变 ASK。

用户痛点：plan 模式下 `ls ~/.codex/...` 这类命令反复弹权限卡。

**两级通道**（同一目的，按 Agent 给不给得出可固化规则划分；两者正交，互不降级）：

| 级 | 触发形状 | 动作 | 设置 |
|---|---|---|---|
| 一级 | options 里有 `allow-with-updates`（CLI 给了作用域化批准） | 选中它，CLI 应用其 `updatedPermissions` | `acp.plan.autoApproveWithUpdates` |
| 二级 | 本次**没有**作用域选项（旧范围），或即使有也仍只选一次（子 agent 网页/MCP 搜索白名单，见下） | 选中 `allow-once`：放行这一次，**不写任何规则** | `acp.plan.autoApproveUnscoped` |

二级覆盖的是 CLI 想不出可固化规则的询问（heredoc、`for` 循环、长 `cd` 链——`shellSuggestionsLabel`
表达不了该 changeSet），子 agent 的询问也常落在这里。**旧范围**一级命中时二级**永不**介入：有作用域选项就
不该降级成「仅本次」，否则会白丢一次可记忆的机会；网页/MCP 白名单是刻意的例外（见下）。

## 一级判定（`_planAutoApproveWithUpdates`）

六条全部成立才静默返回该选项，任一不成立回落人工卡片：

1. `params.toolCall.kind` ∈ {`execute`, `read`, `search`}（即 Bash/PowerShell + Read/Glob/Grep；
   `switch_mode` 与其它 kind 天然排除；共用纯函数 `isPlanAutoApproveKind`）；
2. 设置 `acp.plan.autoApproveWithUpdates` 非显式 false（默认开）；
3. 会话 mode 选项 `currentValue === 'plan'`（共用 `_isPlanMode`）；
4. options 里有 `optionId === 'allow-with-updates'` 且 `kind === 'allow_always'`；
5. 首项不是 reject（共用 `_rejectOptionFirst`）；
6. 会话已知（判定挂在 `_findSession` 之后，未知会话沿用 `cancelled` 语义）。

## 二级判定（`_planAutoApproveUnscoped`）

两组范围，命中任一即返回 `allow-once`（放行本次、不写任何规则），共用设置 `acp.plan.autoApproveUnscoped`：

- **旧范围** `execute`/`read`/`search`（`isPlanAutoApproveKind`）——语义不变；
- **子 agent 网页/MCP 搜索白名单**（`PLAN_SUBAGENT_WEB_TOOLS`）：精确 `toolName` + `kind` 成对匹配
  （`WebSearch`/`WebFetch` → `fetch`；`mcp__brave-search__brave_web_search` → `other`）。名称取自
  `_meta.claudeCode.toolName` 的**原始名**（MCP 不折叠），不按标题、server 名、前缀或包含 search 猜身份，
  也不推广到其他 MCP 服务或主 agent。用户选择同时覆盖指定 MCP 搜索工具是本范围的唯一来源。

按序（任一不成立回落人工卡片）：

1. kind ∈ {`execute`, `read`, `search`}，**或**命中网页白名单（精确名 + kind 成对）；
2. 设置 `acp.plan.autoApproveUnscoped` 非显式 false（默认开）；
3. 旧范围：本次 options 里**没有** `allow-with-updates`（与一级正交）；网页范围**不受此条约束**——
   一级不覆盖它，即使有 `allow-with-updates` 也仍选 once（只放行本次、不写规则），不借机写盘；
4. 会话 mode 是 plan；
5. options 里有 `optionId === 'allow-once'` **且** `kind === 'allow_once'`——**按 id 精确匹配，不按 kind**：
   codex fork 的对应 id 是下划线风格的 `allow_once`（`vendor/codex-acp/src/permissions/option-ids.ts`），
   按 kind 匹配会把它一并接管；
6. 首项不是 reject（fork 标记与顺序矛盾时以拒绝为准）；
7. 命中 `_meta.claudeCode.matchedAskRule` → 不接管（**唯一否决位**：用户自己配置的 ask 规则）；
8. 标记与归属（`_meta.claudeCode.clientMayAutoApproveOnce` / `parentToolUseId`）：
   - `clientMayAutoApproveOnce === false` → **一律弹卡**（主/子 agent 都一样）：CLI 要么要了拒绝项
     优先的提示（顺序代理已挡），要么压制了 always-allow 规则（`suppressAlwaysAllowRule`，删除类命令
     ——顺序代理**挡不住**这条），要么命中了用户的 ask 规则；
   - **网页/MCP 白名单**：只对子 agent（`parentToolUseId` 存在且非空）放宽，且必须
     `clientMayAutoApproveOnce === true`——缺失、畸形或 false 一律弹卡（fail-closed）：名称再对，没有
     肯定式标记也不接管；
   - **旧范围**：子 agent 在缺标记时放行——放宽的只是「缺字段」（旧 fork 不盖标记，而子 agent 的询问本就
     常带不出作用域选项）；主 agent 只在 `clientMayAutoApproveOnce === true` 时放行，缺字段或畸形一律 warn
     回卡片（fail-closed）。

挂载点在 `onRequestPermission`，一级之后、构造 `pendingPermission` 之前；命中后不创建卡片、不写
`persistAllow`，直接返回 `selected`，并打点 `acp.permission_plan_auto_approved_unscoped`
（`{optionId, kind, source}`，无标题/命令文本）。诊断行只放 `marker=<absent|false>`、固定策略原因
`reason`（`unscoped` | `web`，仅日志枚举，不进遥测）与 optionId/kind 列表——选项文案、查询、URL、参数
一律不回显（沿用隐私惯例，单测有断言）。

## fork 契约点

- **`allow-with-updates` 是 fork 的稳定 id**（`vendor/claude-agent-acp/src/permissions/options/shared.ts`），
  kind 恒 `allow_always`，且只有它代表「作用域化批准」。id 若被上游改名，策略静默失效（回落卡片，安全方向）。
  该 id 是保留契约：判定不按 agentId 过滤（与 `_planAutoResolve` 对 `exit-plan-*` 的处理一致），
  别的 agent 若碰巧发同名选项也会被同样对待——codex-acp 只发 `allow_once`/`allow_for_session`/`allow_always`，不受影响。
- **两枚新 `_meta` 键由 fork 盖在 v1 客户端上**（`vendor/claude-agent-acp/src/acp-agent.ts`，只对非 AIR）：
  - `clientMayAutoApproveOnce: boolean`——**肯定式**：盖它的 fork 恒写布尔（`false` = CLI 要人回答），
    只有旧 fork 才整个缺字段。编辑器只把 `true` 当批准依据；缺字段仅对**旧范围**子 agent 放宽，
    网页/MCP 白名单一律要求显式 `true`；
  - `matchedAskRule: true`——只在命中用户自己的 ask 规则时出现（与上一条的 false 同时出现，保留它是为了
    给「子 agent 放宽」留一个显式否决位）。
  完整叙事见 `vendor/claude-agent-acp/cases-permissions.md`。
- **`_meta.claudeCode.toolName` 是白名单身份的唯一来源**：fork 对非 AIR 在 `mcpServer` 或 `parentToolUseId`
  存在时盖上**原始** `toolName`（MCP 名不折叠、不转 AIR）。子 agent 归属成功解析时同时携带父 ID 和工具名；
  归属未解析或缺名（如主 agent 的纯 `WebSearch`、旧 fork、标题冒充）时不进入新增网页批准路径。
  该键由 agent **自报、不防伪**：白名单只扩「子 agent 的这三个精确工具」，不等于该工具只读或 MCP 服务
  可信；网络/MCP 调用仍可能向服务发送数据并产生费用。
- **`defaultToNo` 的选项顺序代理只挡得住一级与二级的一半**：编辑器不是 AIR 客户端，只看「首项是 reject」。
  代理只会**抑制**批准，不会过度批准；但它是 fail-open 的——fork 同步时若改了选项排序或新增 kind，
  必须回来复检。二级不靠它：`marker === false` 覆盖了全部三种「要人回答」的成因（含代理挡不住的
  `suppressAlwaysAllowRule`）。
- **作用域选项不进 `acp.permissions.autoApprove`**：`allow-with-updates` / `allow-skill-exact` /
  `allow-skill-prefix`（`SCOPED_ALLOW_ALWAYS_OPTION_IDS`）自带规则，点选它们不等于对整个 tool kind
  永久批准；写进去会变成「一次点击 = 该 kind 之后全部静默批准」，远超选项标签承诺的范围。
  二级只点 `allow-once`，天然不触发写入。
- **既有旁路（记录在案，不在本次范围）**：`AcpPermissionHandler.tryAutoApprove` 仍在最前面跑，用户把
  kind 加进 `acp.permissions.autoApprove` 后它选**第一个** allow 选项——那可能是作用域化选项。该行为由
  用户显式配置驱动，本次未改。

## 覆盖边界与风险

- Read/Glob/Grep（`read`/`search`）只在**全部** update 的 destination 都是 `session` 时才给出作用域选项
  （`options/filesystem.ts` 的 `isFileSessionChangeSet`）→ 纯内存，不落盘。
- Bash/PowerShell（`execute`）的**一级**只要求 `addDirectories` 是 session，命令规则（`addRules`）的
  destination 不校验（`options/shell.ts`）→ **命令规则可能写入工作区 `.claude/settings.local.json`**。
  设置说明与用户文档已写明。**二级不写规则**，因此不存在这个写盘面。
- Shell 的覆盖面是「plan 模式下任何 CLI 愿意记住（一级）或只是本次放行（二级）的命令」，不只工作区外的读取；
  CLI 自认为危险的询问靠 `suppressAlwaysAllowRule`/`matchedAskRule` 不提供作用域选项 + `defaultToNo` 置顶，
  以及二级的肯定式标记 + ask 规则否决位挡住。
- **子 agent 归属靠 `_meta.claudeCode.parentToolUseId`**：编辑器不协商 `clientCapabilities.subagents`，
  子 agent 的询问走**根会话 id**，因此归属只能读 `_meta`。该键由 agent **自报、不防伪**——任何 agent
  盖上它就能进入「子 agent」分支。旧范围的放宽只对「缺标记」生效，而当前 fork 恒盖布尔标记，等于没有
  放宽面；网页/MCP 白名单另要求 `clientMayAutoApproveOnce === true`，且只覆盖三个精确工具名。若将来协商
  该能力、请求改路由到子会话 id，这里的 `_findSession` 与 mode 判定都要跟着改（子会话的 mode 未必是 plan）。
- **子 agent 归属读不到时的方向是安全侧**：读不到 = 当成主 agent = 要求标记 = 弹卡，不会误放宽。
  父调用 ID 为空的畸形值同样读作「无归属」。
- 一级仍不含 Skill/WebFetch/WebSearch/Agent（kind `other`/`fetch`/`think`），其内置建议走
  `localSettings` 写盘路径。二级新增的子 agent 网页/MCP 白名单**只**覆盖 `WebSearch`/`WebFetch`/
  `mcp__brave-search__brave_web_search` 三个精确名 + kind；`Agent`/`Skill`、其他 MCP 服务与近似名
  （前缀、另一 server 的 `search`）仍在覆盖外。该白名单**只放行本次**：不写规则、不落盘，但网络/MCP
  调用本身仍可能向服务发送数据并产生费用。
- 两个设置默认开 = 现有用户可见行为变化；都可关，telemetry 提供可观测性。

## 回归守护

- 单测 `session/__tests__/AcpSessionService.test.ts`：
  `describe('plan scoped auto-approve (acp.plan.autoApproveWithUpdates)')`（一级、内嵌二级子 describe，及
  「子 agent 网页/MCP 搜索白名单」子 describe——三工具三选项仍选 once、marker 缺失/false、ask 规则、
  拒绝置顶、主 agent、未知/近似名、名称-kind 不匹配、标题冒充、codex `allow_once` 不接管、连续两次不记忆）、
  `session/__tests__/acpSessionUpdateMeta.test.ts` 的 `_meta` reader 三态；
- fork 单测 `vendor/claude-agent-acp/src/tests/session-permission.test.ts` 的
  `describe("permission request auto-approve marker")` 与
  `describe("web/MCP search permission contract")`（原始 toolName/parent/标记/MCP provenance 合并、
  两/三选项、allow-once 无 updatedPermissions）+ v2 golden files
  （`src/tests/acp-scenarios/__snapshots__/v2/*.jsonl` 的权限请求行）——fork 侧改动后跑
  `env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN npx vitest run`；v2 快照更新用 `-u`；
- e2e `apps/editor/e2e/specs/smoke.agentsPlanShellPermission.spec.ts`——一级/二级默认静默批准两条与
  三个网页/MCP 工具白名单正例是 `@p1`；关设置（两级各一）/ 拒绝项置顶 / 主 agent 未盖章 /
  子 agent 被显式否定 / 网页工具的主 agent、缺 marker、marker=false、ask 规则、拒绝置顶、未知 MCP
  负例是 `@regression`；canned 指令 `approve-shell`（含作用域选项）、`approve-shell-danger`（拒绝项置顶）、
  `approve-shell-once`（无作用域 + 盖章）、`approve-shell-once-nomarker`、
  `approve-shell-once-subagent`，以及 `approve-web-{search,fetch,main,nomarker,denied,ask,reject-first,
  unknown-mcp}` / `approve-brave-search`（真实 fetch/other kind + `_meta.claudeCode`，不联网）。
