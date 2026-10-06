# 案例：Claude 计划模式的权限策略（planPermissionPolicy）

> 本文是 [`../CLAUDE.md`](CLAUDE.md) 套路 ACP-D 的案例拆分：讲清个人设置
> `agentSettings.claude.planPermissionPolicy` 的三档语义、判定顺序、与 fork 的契约点及风险。
> **改动该策略前通读本页。**
>
> 前身「两级静默批准」（`acp.plan.autoApproveWithUpdates` / `acp.plan.autoApproveUnscoped`）
> 已整体移除：它是客户端替 CLI 做批准，白名单永远追不上 CLI 的询问形态。新设计把批准权交回
> CLI 的原生分类器（Auto），客户端只在 Skip 档做「替用户点一次性允许」这一件事。

## 三档语义（`skip` 默认 / `auto` / `manual`）

只对**内置 Claude agent**（`isClaudeAgent(agentId)`，即 `claude-code`）且会话 **mode === plan** 的
权限请求生效；其余（codex、echo 桩、非 plan 的 Claude 会话）走原有通用路径
（`AcpPermissionHandler.tryAutoApprove`，`switch_mode` 除外）。

| 值 | 客户端行为 | CLI 侧 |
|---|---|---|
| `skip`（默认） | 每次询问**只选 Agent 给出的一次性「允许」选项**（精确 `optionId === 'allow-once'` 且 `kind === 'allow_once'`）；不弹卡、不写规则 | `settings.useAutoModeDuringPlan = false`——分类器关闭；仍需确认的请求交给客户端 |
| `auto` | **客户端不批准任何请求**：分类器放行的不会到客户端，其余一律弹卡 | `settings.useAutoModeDuringPlan = true`——由 CLI 原生分类器决定 |
| `manual` | 客户端不批准任何请求（同上） | `useAutoModeDuringPlan = false`——分类器关闭，仍需确认的请求交给客户端 |

策略本身不新增授权规则；人工卡片仍可由用户明确选择持久授权。作用域选项只应用 Agent 的规则，
不把整个工具类别写进 `acp.permissions.autoApprove`。Skip 只返回一次性选项 id。

## 判定顺序（`AcpSessionService.onRequestPermission`）

1. `_findSession(params.sessionId)` 失败 → 直接 `cancelled`（无身份、无模式可判，凭它批准等于无凭无据）；
2. `isClaudeAgent(session.agentId) && _isPlanMode(session)`（mode 配置项 `currentValue === 'plan'`）成立
   才进入本策略；否则维持原有行为（通用 `tryAutoApprove`，`switch_mode` 恒不走它）；
3. 策略取**会话快照**（`_planPolicyBySession`，握手时第一次读设置即固定）；`skip` 时用
   `selectSkipOneShotOption` 找一次性允许选项；
4. 找不到（只有持久选项 / `allow_once` 拼写不匹配 / `kind === 'switch_mode'`）→ **回落人工卡片**，
   绝不退而选择永久授权；
5. 命中 → telemetry `acp.permission_plan_skip_approved`（只带 `{optionId, kind}`），日志只记
   optionId/kind + 固定文案，**不回显选项文案、命令、查询**。

`switch_mode`（ExitPlanMode）刻意排除：它的自动化只由 `acp.plan.autoExecute` 显式驱动（倒计时卡片），
Skip 不再有第二条静默短路。`AskUserQuestion` 由 fork 在 `canUseTool` 里先于权限请求拦下、走 ACP form
elicitation（`unstable_createElicitation`），本策略碰不到它。

## 设置 → CLI：`settings.useAutoModeDuringPlan`

- 载体是握手 `_meta.claudeCode.options`（`claudePlanAutoModeOptions`），四条路径统一：
  `session/new`（`buildNewSessionMeta`）、`session/load`（`buildResumeMeta`）、重连 hot-resume
  （`_reconnectSession` 复用 `buildResumeMeta`）、空会话重建（`buildNewSessionMeta`）、
  `session/fork`（`buildForkMeta`，仅 Claude 携带快照；当前 fork 只复制记录，设置实际在后续 load 生效）。
- fork 把它当 **SDK `Options.settings` 对象**（`_meta.claudeCode.options` → `userProvidedOptions`）传下去，
  写入 CLI 的 flag-settings 层。该键不是普通覆盖优先级：CLI 在其读取的 policy / flag / user / local
  等来源中只要发现显式 `false` 就禁用，flag 的 `true` 无法强制覆盖其他来源的 `false`。
- fork 端合并规则（`vendor/claude-agent-acp/src/acp-agent.ts` 的 `configuredSettings`）：
  调用方给的是**对象**时与 `CLAUDE_MODEL_CONFIG` 派生的
  `{modelOverrides, availableModels}` **按键合并**（调用方键优先），不再整块顶掉；字符串值仍是
  设置文件路径，原样透传（调用方优先）。回归见 fork 的
  `src/tests/create-session-options.test.ts`。
- null 语义：`useAutoModeDuringPlan` 是布尔，三档都显式写（`auto` → true，其余 false），
  不做「不传」优化——会话一旦建立，CLI 侧与客户端快照永远同值。

## 配置层：只认个人层

`readPlanPermissionPolicy` 走 `getValueForTarget(key, ConfigurationTarget.User)`：Memory / Project /
VSCodeWorkspace 层一律忽略（工作区不能放宽也不能收紧），无效值回落 `skip`。
key 是 `agentSettings.claude.planPermissionPolicy`（不进 `~/.claude/settings.json`，只进编辑器自己的
settings.json）。settings schema `enumItemLabels` 与面板（`workbench/agentSettings/claude/PlanPermissionPanel.tsx`，
分类「Plan permissions」）都写明「对之后新建 / 恢复的会话生效」。

## 快照与生命周期

- 握手前（`_connectSession` / `_resumeSessionInner` / `_reconnectSession` / `_forkOnAgent`）取一次值并
  按本地会话 id 固定；此后改设置**不影响已建会话**（同一会话的 CLI flag 与客户端判定必须同值）。
- fork 取**源会话**的快照（源仍在内存时用它的本地 id），并把值 seed 到 fork 的 durable id 上，
  紧随其后的 `session/load` 复用同值——fork 与其父不会跑在不同策略下。
- `closeSession` 清快照；非 Claude agent 不占位（`_handshakePlanPolicy` 返回 undefined）。

## 覆盖边界与风险（改前必读）

- **Skip 是一次明确的安全放宽**：它不再区分 kind、工具名、子 agent 归属、`clientMayAutoApproveOnce === false`、
  `matchedAskRule`、拒绝项置顶等全部「CLI 想让人回答」的信号——只要 Agent 给了 `allow-once` 就选它。
  防线只剩 CLI 自己：**CLI 不提供一次性允许选项时**（它认为不可自动化），编辑器就回人工卡片（fail-closed，
  唯一保留的兜底）。改动 `selectSkipOneShotOption` 前先想清楚这一点。
- **`allow-once` 精确匹配**：按 `optionId === 'allow-once'` **且** `kind === 'allow_once'` 双条件；
  codex fork 用下划线 `allow_once`（`vendor/codex-acp/src/permissions/option-ids.ts`），不接管；
  `allow-with-updates`（`SCOPED_ALLOW_ALWAYS_OPTION_IDS`）等作用域选项自带规则，永不代选。
- **一次性允许不等于操作无副作用**：当前 fork 的普通 `allow-once` 不附加持久权限更新，但获准执行的
  shell/MCP 调用本身仍可写文件、发送数据或产生费用。Plan 不是只读沙盒。
- **Auto 的有效性受其他配置制约**：其他受支持来源显式禁用分类器、组织策略或模型能力限制，
  都可能使原生 Auto 不可用；客户端仍按人工卡片处理到达的请求，不额外放行。
- **`_isPlanMode` 依赖会话 configOptions**：取 `category === 'mode'` 的 `currentValue`。CLI 若改名/改值，
  本策略静默失效（退化为原有行为，不误放宽）。
- **`agentId` 是身份来源**：`isClaudeAgent` 只认 `'claude-code'`。e2e 里通过 `acp.agents` 覆盖同 id 来
  显式模拟 Claude——`acpClientService._ensureClaudeBinary` 因此加了一道 `spec.runAsNode === true` 判断，
  否则用户自建的 `claude-code` 条目会被强塞内置二进制路径。

## 回归守护

- 单测：
  - `session/__tests__/planPermissionPolicy.test.ts`——默认值 / 只认 User 层 / 无效值回落 / `isClaudeAgent` /
    flag 映射 / `selectSkipOneShotOption`（作用域选项在场也选 once、只有持久选项返回 undefined、
    codex 下划线不接管、`switch_mode` 排除、id-kind 不匹配排除）；
  - `session/__tests__/AcpSessionService.test.ts` 的
    `describe('Claude plan permission policy (agentSettings.claude.planPermissionPolicy)')`——skip 默认与
    各 kind/标记/危险询问、无一次性选项回卡片、codex 选项不接管、`switch_mode` 保留 autoExecute 倒计时、
    未知会话、manual/auto 不接管（且旧通用旁路不生效）、非 Claude / 非 plan 隔离、只认 User 层、
    会话快照（含「后建会话用新值」）、`_meta` 五条路径（new / load+重连 / fork）与 fork 合并后的
    `modelOverrides`/`availableModels` 保留；
  - `workbench/agentSettings/claude/__tests__/PlanPermissionPanel.test.tsx`——三档渲染、只写 User 层、
    忽略 Project 值、跟随外部改动。
- fork 单测 `vendor/claude-agent-acp/src/tests/create-session-options.test.ts`（settings 合并两条）。
- e2e `apps/editor/e2e/specs/smoke.agentsPlanShellPermission.spec.ts`（桩按 `claude-code` 身份安装，
  canned 指令见 `src/test-fixtures/echoAgent.cjs`）：默认 skip 静默选 once、拒绝置顶仍然放行一次、
  无一次性选项回卡片、User 层 manual/auto 弹卡、Memory 层被忽略、非 Claude 身份不受影响、
  子/主 agent 与各 marker 的 WebSearch 一律放行一次；`smoke.agentsPlanPermission.spec.ts` 守护
  `switch_mode` 的 `acp.plan.autoExecute` 倒计时不受 Skip 影响。
