# 案例：计划模式的作用域化静默批准（plan-scoped approve）

> 本文是 [`../CLAUDE.md`](CLAUDE.md) 套路 ACP-D 的案例拆分：讲清 `acp.plan.autoApproveWithUpdates`
> 为什么存在、判定条件、两个 fork 契约点与风险。改动该策略前通读本页。

## 背景：CLI 2.1.287 的 plan 回归

从 `bypassPermissions` 直接切到 plan 时，CLI 2.1.287 不启用 "auto mode during plan" 分类器
（`prepareContextForPlanMode` 对 bypass 走 plain plan entry），于是工作区外的读取/命令退回逐条询问；
2.1.220 不询问。同命令同 cwd 的 A/B 对照里只有 `bypassPermissions→plan` 这一格由 allow 变 ASK。

用户痛点：plan 模式下 `ls ~/.codex/...` 这类命令反复弹权限卡。方案是编辑器替用户选中 Agent 自己给的
**作用域化批准**（`allow-with-updates`）——CLI 随即应用该选项携带的 `updatedPermissions`，
同类请求不再询问。

## 判定（`acpSessionService.ts` 的 `_planAutoApproveWithUpdates`）

六条全部成立才静默返回该选项，任一不成立回落人工卡片：

1. `params.toolCall.kind` ∈ {`execute`, `read`, `search`}（即 Bash/PowerShell + Read/Glob/Grep；
   `switch_mode` 与其它 kind 天然排除）；
2. 设置 `acp.plan.autoApproveWithUpdates` 非显式 false（默认开）；
3. 会话 mode 选项 `currentValue === 'plan'`（与 `ElicitationCard` 同款判定）；
4. options 里有 `optionId === 'allow-with-updates'` 且 `kind === 'allow_always'`；
5. 首项不是 reject；
6. 会话已知（判定挂在 `_findSession` 之后，未知会话沿用 `cancelled` 语义）。

挂载点在 `onRequestPermission`：`tryAutoApprove`（用户 kind 白名单）仍先行；命中后不创建
`pendingPermission`、不写 `persistAllow`，直接返回 `selected`，并打点
`acp.permission_plan_auto_approved`。

## fork 契约点

- **`allow-with-updates` 是 fork 的稳定 id**（`vendor/claude-agent-acp/src/permissions/options/shared.ts`），
  kind 恒 `allow_always`，且只有它代表「作用域化批准」。id 若被上游改名，策略静默失效（回落卡片，安全方向）。
  该 id 是保留契约：判定不按 agentId 过滤（与 `_planAutoResolve` 对 `exit-plan-*` 的处理一致），
  别的 agent 若碰巧发同名选项也会被同样对待——codex-acp 只发 `allow_once`/`allow_for_session`/`allow_always`，不受影响。
- **`defaultToNo` 用选项顺序代理**：编辑器不是 AIR/v2 客户端（`acpClientService.ts` 未声明
  `_meta.jetbrains.air`），拿不到结构化 changeSet / `defaultToNo`；fork 在 `defaultToNo` 时把 reject
  排到首位（`permissions/options.ts` 的 `declineFirstOptionOrder`），因此「首项是 reject」= 不静默批准。
  代理只会**抑制**批准，不会过度批准；但它是 fail-open 的——**fork 同步时若改了选项排序或新增 kind，
  必须回来复检这里**（另一条路是让 fork 给 v1 客户端也盖 `defaultToNo` 的 `_meta`，目前未做）。
- **作用域选项不进 `acp.permissions.autoApprove`**：`allow-with-updates` / `allow-skill-exact` /
  `allow-skill-prefix`（`SCOPED_ALLOW_ALWAYS_OPTION_IDS`）自带规则，点选它们不等于对整个 tool kind
  永久批准；写进去会变成「一次点击 = 该 kind 之后全部静默批准」，远超选项标签承诺的范围。

## 覆盖边界与风险

- Read/Glob/Grep（`read`/`search`）只在**全部** update 的 destination 都是 `session` 时才给出该选项
  （`options/filesystem.ts` 的 `isFileSessionChangeSet`）→ 纯内存，不落盘。
- Bash/PowerShell（`execute`）只要求 `addDirectories` 是 session，命令规则（`addRules`）的 destination
  不校验（`options/shell.ts`）→ **命令规则可能写入工作区 `.claude/settings.local.json`**。设置说明与用户文档已写明。
- Shell 的覆盖面是「plan 模式下任何 CLI 愿意记住的命令」，不只工作区外的读取；CLI 自认为危险的询问靠
  `suppressAlwaysAllowRule`/`matchedAskRule` 直接不提供该选项 + `defaultToNo` 置顶两道闸挡住。
- Skill/WebFetch/WebSearch/Agent 的 kind 是 `other`/`fetch`/`think`，不在覆盖范围内（其内置建议走
  `localSettings` 写盘路径）。
- 默认开 = 现有用户可见行为变化；设置可关，telemetry 提供可观测性。

## 回归守护

单测 `session/__tests__/AcpSessionService.test.ts` 的
`describe('plan scoped auto-approve (acp.plan.autoApproveWithUpdates)')`；
e2e `apps/editor/e2e/specs/smoke.agentsPlanShellPermission.spec.ts`——默认静默批准那条是 `@p1`
（默认行为，随全量趟跑），关设置/拒绝项置顶两条是 `@regression`；用 echo agent 的
`approve-shell` / `approve-shell-danger` canned 指令。
