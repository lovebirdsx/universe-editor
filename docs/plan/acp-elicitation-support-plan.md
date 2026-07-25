# ACP Elicitation 支持 实施计划

> 背景：MCP 2025-06-18 引入 elicitation（server 经 client 向用户要结构化输入），2025-11-25 增加 URL mode。ACP 以 UNSTABLE 的 `elicitation/create` / `elicitation/complete` 承载同一能力。**两个内置 agent fork 都已实现桥接，缺的只是编辑器（ACP client）一侧**。
>
> 通用纪律：
> - 每个阶段结束跑 `pnpm check`（仅截取错误输出）；涉及交互链路的阶段末跑相关 e2e。
> - 改动 vendor fork 后跑 `pnpm agent:build`。
> - 提交粒度建议按阶段，commit 信息遵循 conventional commits。

## 1. 目标与范围

让编辑器作为 ACP client 支持 elicitation 双模式：

1. **form mode**：agent 发来 `elicitation/create`（JSON Schema 表单）→ 会话内渲染表单卡片 → 用户填答 → `accept/decline/cancel` 三态回传。
2. **url mode**：agent 发来 URL elicitation → 展示完整 URL + 域名征求同意 → 系统浏览器打开 → `elicitation/complete` 通知联动收尾。

声明能力后将**自动解锁**的三条 agent 侧既有通路（fork 已按 `clientCapabilities.elicitation` 门控）：

| 通路 | 来源 | 说明 |
|---|---|---|
| MCP server elicitation | fork `handleMcpElicitation`（`acp-agent.ts:4369`） | 真正的 MCP 2025 elicitation，本会话内任何 MCP server 可用 |
| AskUserQuestion 切流 | fork `acp-agent.ts:4159` | 声明 form 后不再走 `universe-editor/ask_user_question` ext-method，改走标准 elicitation |
| refusal fallback dialog | fork `acp-agent.ts:5106-5111` | 模型拒答时征询"换 fallback 模型重试"（单选表单，通用 renderer 天然覆盖） |

**不在范围**：MCP server 自身实现 elicitation（那是 server 作者的事）；codex-acp 侧改动（上游已原生支持，零改动受益）。

## 2. 关键架构发现（约束计划成立的前提）

1. **agent 侧已完成，编辑器侧 SDK 已具备类型面**。编辑器 `@agentclientprotocol/sdk@0.22.1` 已有 `ClientCapabilities.elicitation{form,url}`、`Client.unstable_createElicitation?` / `unstable_completeElicitation?`；fork 的 1.2.1 是 0.22.1 的 wire 超集，**协议完全兼容**（方法名均为 `elicitation/create` / `elicitation/complete`）。

2. **唯一 wire 损耗：EnumOption.description / _meta**。编辑器 0.22.1 的 zod validator（`zEnumOption` 只认 `const`+`title`）会 **strip** fork 放进 enum option 的 `description` 和 `_meta`（AskUserQuestion 选项的说明文字与 preview 走这里）。当前 QuestionCard 显示选项描述，**要保持平价就必须升级编辑器 SDK 到 1.2.x**（与两个 fork 同版本），否则用户可见信息变少。→ 阶段 0。

3. **现状降级链（未声明能力时）**：
   - AskUserQuestion → fork 回退到 `universe-editor/ask_user_question` ext-method（`acp-agent.ts:4259-4292`），编辑器 `QuestionCard` 已服务此路径；
   - MCP elicitation → SDK 默认 auto-decline（fork 注释 `acp-agent.ts:5093-5096`）；
   - 若 agent 违规强发而 clientImpl 未实现 → SDK 回 `-32601 method not found`，不断连（SDK `acp.js:545-551`）。
   即**能力声明是唯一的开关**，client 侧不声明则一切照旧，本计划可以安全分阶段落地。

4. **交互式请求的统一模式已成熟**：`pending observable + Promise settle`。permission（`acpSessionService.ts:1390-1455`）与 question（`1457-1490`）同构：sink 构造含 `resolve/cancel` 的 pending 对象写入 session observable，UI 卡片（`PermissionCard`/`QuestionCard`，挂在 `ChatBody.tsx:341-342` 时间线下方、输入框上方）读 observable 渲染，用户操作调 resolve 清 observable 并兑现挂起的 Promise 回 agent。elicitation 照抄此模式即可。

5. **UI 基建齐备，无需新造**：`packages/workbench-ui` 有 `Input`/`Select`（自绘下拉，直接可渲染 enum 单选）/`Checkbox`/`Toggle`/`Button`；draft 缓存先例 `acpQuestionDraftCache.ts`（内存 Map，key=`sessionId+toolCallId`）；URL consent 用 `IDialogService.confirm`（`RendererDialogService.ts:43`）+ `IOpenerService.open`（http/https 白名单，`OpenerService.ts:44,106-114`）。

6. **取消语义边界**：SDK 的 client 方法签名不带 AbortSignal，agent 的 `$/cancel_request`（turn 取消时 fork 会发）不会传到 `unstable_createElicitation` 的调用方。已知边界：turn 取消后卡片可能残留，用户事后作答会回给已死的请求（agent 端安全忽略）。**会话关闭时取消 pending** 是必须做的（现有先例：`acpSession.ts:864-866`）；turn 取消不做额外处理，记为已知限制。

7. **decline ≠ cancel 必须在 UI 上区分**：fork 对 MCP elicitation 的 decline 语义是"用户明确拒绝"（server 可能走替代路径），cancel 是"没表态"。卡片需要三个出口：提交 / 明确拒绝 / 关闭（Esc、会话切换不算关闭——draft 恢复）。

## 3. 数据流（form mode 全链路）

```
MCP server ──elicit──▶ Claude Agent SDK（fork 进程内）
  ──onElicitation──▶ fork handleMcpElicitation（acp-agent.ts:4369）
  ──elicitation/create──▶ ACP wire
  ──▶ 编辑器 ClientSideConnection requestHandler（SDK 分发到 client.unstable_createElicitation）
  ──▶ clientImpl.unstable_createElicitation（acpClientService.ts）
  ──▶ sink.onCreateElicitation（acpSessionService.ts）
        按 params.sessionId 找 session → new Promise 挂起
        → session.presentElicitation(pending) 写 observable
  ──▶ ElicitationCard（ChatBody 挂载点）渲染 schema 表单
  ──用户提交/拒绝/关闭──▶ pending.resolve(result) → settle 清 observable
  ──Promise 兑现──▶ SDK 回 CreateElicitationResponse ──▶ fork 映射回 ElicitResult ──▶ MCP server
```

url mode 分叉：卡片改为"consent 卡"（完整 URL + 高亮域名 + message）→ 确认后 `IOpenerService.open` 并立即回 `accept`（仅代表同意打开）→ 按 `elicitationId` 登记 → `unstable_completeElicitation` 到达时更新卡片为"已完成"。

## 4. 阶段任务

### 阶段 0 · 升级编辑器 ACP SDK 至 1.2.x

**目标**：消除 wire 损耗（EnumOption.description/_meta 被 strip），与两个 fork 同版本。

1. `apps/editor/package.json` 的 `@agentclientprotocol/sdk` 升到 `^1.2.1`（catalog 在 `pnpm-workspace.yaml` 统一管理，改 catalog）。
2. 处理 breaking changes（0.22 → 1.x 跨度大，先 `pnpm check` 让 typecheck 指出全部破损点；重点关注 `ClientSideConnection` 构造、schema 类型名变更、`exactOptionalPropertyTypes` 下新增的可选字段）。
3. 全量回归：`pnpm check` + ACP 相关 e2e（`pnpm --filter @universe-editor/editor e2eg "agent"`）。

**回退预案**：若升级 breakage 过大，可降级为"停留 0.22.1 + 接受 description 丢失"，在 `ElicitationCard` 里选项只渲染 label——届时 AskUserQuestion 平价受损，需用户重新决策。

### 阶段 1 · 协议层：clientImpl + sink + session view-model

**目标**：不通 UI，先让 `elicitation/create` 能完整 round-trip（用测试驱动）。

1. `acpClientService.ts`：
   - `DEFAULT_INIT_PARAMS.clientCapabilities` 加 `elicitation: { form: {} }`（**url 本阶段不声明**）；
   - clientImpl 加 `unstable_createElicitation: (params) => sink.onCreateElicitation(params)`、`unstable_completeElicitation: (params) => sink.onCompleteElicitation(params)`（本阶段 sink 侧 complete 可为 no-op + log，url 阶段才接线）。
2. `acpSessionModel.ts`：新增 `AcpPendingElicitation { request: CreateElicitationRequest, resolve(result: CreateElicitationResponse), cancel() }`；`IAcpSession.pendingElicitation: IObservable<AcpPendingElicitation | undefined>` + `presentElicitation`。
3. `acpSession.ts`：实现 observable + `presentElicitation`；会话关闭时取消（照 `pendingQuestion` 先例 L864-866）。
4. `acpSessionService.ts`：`onCreateElicitation` —— 未知 session 直接回 `{ action: 'cancel' }`；否则 Promise+settle 模式挂起；telemetry 打点（`acp.elicitation_shown` / `acp.elicitation_resolved`，带 mode 与 action）。
5. **同一 session 同时只允许一个 pending elicitation**：与 question/permission 一致；若并发到达，后者排队或直接 cancel（参照现有 question 的处理，取一致行为）。
6. 单测：协议级走 `testing/inMemoryAcpPair.ts`——桩 agent 发 `elicitation/create`，断言 sink 收到、resolve 后 agent 收到正确响应；会话关闭 → pending 取消、agent 收到 cancel。

### 阶段 2 · Schema 规范化与校验纯函数

**目标**：把 `ElicitationSchema` 归一成 UI 可消费的字段模型，可单测。新文件 `services/acp/acpElicitationForm.ts`。

1. `normalizeElicitationForm(schema): ElicitationFormField[]`——字段类型判别联合：`string`（含 minLength/maxLength/pattern/format/default）/ `number`（min/max/default）/ `boolean`（default）/ `enum`（oneOf/anyOf → options[{value,title,description}]，单选）/ `enum-multi`（array+anyOf items）。无法归一的属性跳过 + warn（对齐 `normalizeMcpServers` 的"坏条目跳过不抛错"原则）。
2. `validateElicitationValues(fields, values, required): string | null`——提交前校验：required 缺失、pattern、min/max、minLength/maxLength；返回首条错误信息或 null。
3. 注意 AskUserQuestion 形态**自然落入**通用模型：fork 产出的 `question_<n>`（enum/enum-multi）+ `question_<n>_custom`（string）就是普通字段，不需要特判。
4. 单测覆盖：五种字段类型、default 预填、required 校验、畸形 schema 降级。

### 阶段 3 · ElicitationCard UI

**目标**：用户可见的表单卡片。新文件 `workbench/agents/ElicitationCard.tsx`，挂 `ChatBody.tsx`（`QuestionCard` 旁边）。

1. `useObservable(session.pendingElicitation)`，无 pending 返回 null。
2. 字段渲染映射（全部用 workbench-ui 原子控件）：string→`Input`、number→`Input type=number`、boolean→`Checkbox`、enum 单选→`Select`（选项带 description 副行）、enum-multi→`Checkbox` 组。
3. 三个出口：提交（`accept`+content，先跑阶段 2 校验，失败内联报错）/ 拒绝（`decline`，按钮文案"拒绝"）/ 关闭（`cancel`，Esc 或 ×）。卡片显示 `request.message` 作为标题区。
4. draft 缓存：新文件 `acpElicitationDraftCache.ts` 照 `acpQuestionDraftCache.ts`，key = `sessionId + (toolCallId ?? message 哈希)`，切会话往返恢复。
5. i18n：按钮与提示文案走 localize + zh-CN 消息表。
6. 组件测试（happy-dom）：渲染各字段类型、提交/拒绝/关闭三路径、draft 恢复。

### 阶段 4 · AskUserQuestion 切流验证与旧路径清理

**目标**：确认声明 form 能力后三条通路全部工作，清理被替代的旧路径。

1. 手动/集成验证：真实 claude-code 会话里 AskUserQuestion 改走 elicitation（fork `acp-agent.ts:4159` 分支），选项 description/preview 可见（阶段 0 升级后）；refusal fallback dialog 可用。
2. 旧 ext-method 路径下线：`acpExtMethods.ts` 删 `askUserQuestion`、clientImpl 删分支、`acpSessionService.onAskUserQuestion`、`QuestionCard.tsx`、`acpQuestionDraftCache.ts`、相关测试一并删除（项目不考虑向后兼容；fork 在 form 能力下不会再发 ext-method）。同步删 fork 侧 `acp-agent.ts:4259-4292` 的回退分支？——**不删**：fork 可能被其他 client 使用，回退是它的资产；只删编辑器侧。
3. 跨 fork 契约测试 `__tests__/acpForkContract.integration.test.ts` 同步移除 ask_user_question 断言。

### 阶段 5 · url mode

1. `DEFAULT_INIT_PARAMS` 的 elicitation 加 `url: {}`。
2. url 请求渲染 consent 卡（复用 `ElicitationCard` 壳）：完整 URL 文本 + 域名高亮 + `request.message`；确认 → `IOpenerService.open(url)` + 回 `accept` + 卡片转为"等待完成"态；拒绝 → `decline`；关闭 → `cancel`。**不自动预取 URL、未同意不打开**（对齐 MCP 规范强制项）。
3. `onCompleteElicitation`：按 `elicitationId` 找到"等待完成"卡片 → 更新为"已完成"并可手动 dismiss；未知 id 静默忽略（规范要求）。
4. 单测 + 组件测试。

### 阶段 6 · e2e 与文档收尾

1. 扩展 `src/test-fixtures/echoAgent.cjs`：新增命令（如 `report-elicitation`）触发一个固定 form elicitation 与一个 url elicitation，回显用户提交内容。
2. 新增 `e2e/specs/smoke.agentsElicitation.spec.ts`（`@p1`）：form 提交 round-trip、decline、url consent → opener 拦截断言（e2e 里拦 `shell.openExternal` 或断言 consent 卡出现即可，不真开浏览器）。
3. 文档：`docs/user/zh-CN/ai-agent/` 相关页补充"agent 可能会向你弹出结构化提问/授权链接"；`apps/editor/src/renderer/services/acp/CLAUDE.md` 若存在且涉及交互模式，补一句 elicitation 的同构地位。
4. `pnpm check` + `pnpm e2e`（改动涉及编辑器交互链路）。

## 5. 风险与已知限制

| 风险/限制 | 应对 |
|---|---|
| SDK 0.22→1.x 升级 breakage 未知 | 阶段 0 独立提交，可整体回退；回退则接受 description 丢失 |
| 声明 form 即同时打开三条通路 | 阶段 2/3 的通用 renderer 必须覆盖全部形态后才做阶段 1 的能力声明（能力声明虽写在阶段 1，但合并到 main 应在阶段 3 之后——开发期可本地先声明调试） |
| turn 取消时卡片残留（SDK 不传 signal） | 已知限制；会话关闭路径必须取消 pending；用户迟到作答对 agent 无害 |
| ACP elicitation 仍是 UNSTABLE | wire 形状变动风险由"编辑器与 fork 锁同版本 SDK"收敛；升级时两侧一起升 |
| url mode 钓鱼面 | consent 卡显示完整 URL + 域名高亮、不预取、不自动打开；规范强制项逐条对齐 |

## 6. 执行顺序总览

```
阶段 0 SDK 升级（可独立合并）
阶段 1 协议层（能力声明本地调试，不急于合并）
阶段 2 schema 纯函数 ──┐
阶段 3 ElicitationCard ─┴─ 与阶段 1 一起合并（form 能力正式生效）
阶段 4 旧路径清理
阶段 5 url mode（独立合并）
阶段 6 e2e + 文档
```
