# Claude Shell 命令实时输出 支持计划（方案 B）

> **实施状态（2026-07-06）**：阶段 1–2 已实现；correlation 经两轮联调定位到最终可靠方案。核心改动：
> - 新增 `vendor/claude-agent-acp/src/liveBashTool.ts`（自建 in-process MCP bash 工具 + spawn 实时回流 + 跨平台 shell + 树 kill + 超时/取消）。
> - `acp-agent.ts`：`options` 挂 `mcpServers['universe-live-bash']` + `toolAliases:{Bash:'mcp__universe-live-bash__bash'}`；`canUseTool` 把 alias 名归一回 `Bash`（权限卡/always-allow 规则/execute 卡片一致）。
> - **correlation 主通道 = `session.toolUseCache` 命令匹配**：`resolveToolCallId` 扫 `toolUseCache`（由**原始 SDK tool_use chunk** 填充，`id` 与 `input.command` 原子同块、在工具执行前的流式阶段就绪），按 command 匹配 Bash 条目拿 `id`（带 `consumedToolUseIds` 去重防同命令复用）。这是唯一可靠通道。
> - 单测：`src/tests/live-bash-tool.test.ts`（14 例）+ `acp-agent.test.ts` 权限归一 3 例；renderer 零改动。
>
> **联调根因复盘（两轮）**：
> - **第 1 轮 bug**：主通道 `recordLiveBashCorrelation` 从**流式 ACP `tool_call` 通知**读 `rawInput.command`——但真实 Bash 的 `tool_call` 通知 `rawInput:{}` 为空，命令只在随后的 `tool_call_update`(refine) 才补上 → buffer 永不写入；兜底 `__acpToolCallId` 经 `canUseTool` 注入，但会话 `bypassPermissions` 模式下 `canUseTool` 不被调用。→ 命中兜底合成 id → phantom 卡。
> - **第 2 轮误判**：反编译 SDK 见 `s.run(args,{toolUseBlock,signal})`，误以为 `extra.toolUseBlock.id` 是 MCP handler 的可靠来源。**实为 SDK 原生工具（带 `.run`）路径**；in-process MCP 工具经 `createSdkMcpServer`→MCP `tools/call`，`extra` 是 `{signal,sessionId,_meta,sendNotification}`，**无 `toolUseBlock`** → 运行时恒 undefined，仍走兜底。
> - **最终修复**：改读 `session.toolUseCache`（原始 SDK chunk，id+command 原子、执行前就绪），彻底避开「ACP 通知 rawInput 延迟」和「MCP extra 无 tool_use id」两个坑。`extraToolUseId` 保留为廉价首查（对原生工具有效），实际靠 `resolveToolCallId` 兜住。
>
> **注意**：用户第 2 轮实测命令误写成 `do echo $1`（位置参数为空），故 12 行输出全是空行——**非本功能 bug**，日志 `terminal_output_delta.data:"\n"` ×12 证实实时流本身工作正常。
>
> **阶段 4.1 E2E 冒烟不适用**：e2e 用 JS echo-agent mock，不跑真 fork/claude.exe，无法触发 live-bash 路径；renderer 消费已由 `AcpSession.timeline.test.ts` 覆盖。

---

> **目标**：让 claude agent 的 shell（Bash）调用像 codex 一样**实时流式**显示命令输出（命令跑到一半就逐步刷新 stdout），而不是命令结束后一次性显示结果。
>
> **调研结论前置**（已完成，见下方"背景"）：
> - 编辑器渲染层**已支持**增量流式：`AcpSession._accumulateTerminalOutput`（`acpSession.ts:783`）消费 `_meta.terminal_output_delta`（append）/`terminal_output`（replace），折进 execute 卡片 `call.text`，`TerminalOutput` 组件渲染。**codex 就是靠这条链路实时的，renderer 侧零改动即可复用。**
> - 问题根因在 **claude fork（vendor）侧**：Claude Agent SDK 把 Bash 当黑盒，只在命令**结束**时通过 `tool_result` 一次性给全部 stdout；SDK 无任何 bash stdout 增量通道（`SDKToolProgressMessage` 只有 `elapsed_time_seconds`，无内容）。
> - **VSCode 官方（`D:\git_project\vscode` agentHost 分支）对 claude 也没解决**，但其 **copilot** 用 `overridesBuiltInTool` 覆盖 SDK 内置 bash、自建 PTY、边跑边发增量 —— 这套"host 接管 Bash 执行 + 自建 PTY + 自发增量"就是方案 B 的参考实现。
>
> **通用纪律**：
> - 改 `vendor/claude-agent-acp` 属 submodule fork，**不在 pnpm workspace 内**。改完必须 `pnpm agent:build` 重建 `vendor/claude-agent-acp/{dist,node_modules}`，否则 main 仍跑旧产物。
> - fork 内测试用它自带 vitest（`cd vendor/claude-agent-acp && npm test`）；renderer 侧改动跑 `pnpm check` / `pnpm e2e`。
> - 改动尽量收敛、可干净 rebase 到上游 —— 新增文件优先，尽量不散改 `acp-agent.ts`。

---

## 背景：三个 agent 的终端输出机制对比

| | Claude（现状） | Codex | 目标（Claude 方案 B 后） |
|---|---|---|---|
| 执行方 | Claude Agent SDK 内部 spawn，黑盒 | codex app-server 原生 | **fork 自己 spawn 子进程** |
| 增量来源 | 无（SDK 只在 tool_result 一次性给全部） | 原生 `exec_command_output_delta` | fork 边读子进程 stdout 边发 |
| 上屏时机 | 命令结束后一次性 | 实时逐块 | **实时逐块** |
| 协议载体 | tool_result → 一次性 `terminal_output`（全量，且需 client 声明 capability，我们没声明→退化成 ```console``` 代码块） | `_meta.terminal_output_delta`（append） | **`_meta.terminal_output_delta`（append）** |

关键代码锚点：
- **renderer 消费点（不改）**：`apps/editor/src/renderer/services/acp/acpSessionUpdateMeta.ts:77` `readTerminalOutput`（读 delta/full）→ `acpSession.ts:783` `_accumulateTerminalOutput`（折叠）→ `ToolCallCard.tsx:122` execute 分支 → `ToolCallOutput.tsx:18` `TerminalOutput`。
- **fork 现状（要改）**：
  - `vendor/claude-agent-acp/src/tools.ts:154` `Bash` 分支：`supportsTerminalOutput` 为 false 时只返回 description，命令结果走 `toolUpdateFromToolResult`（`tools.ts:547`）在结束时一次性包 ```console```。
  - `vendor/claude-agent-acp/src/acp-agent.ts:3733` `options` 装配：`disallowedTools`、`mcpServers`、`toolAliases`、`canUseTool` 都在这里。
  - `vendor/claude-agent-acp/src/acp-agent.ts:2936` `canUseTool`：权限门控入口。
  - `vendor/claude-agent-acp/src/acp-agent.ts:5188` tool_result 映射（Bash 分支在 `tools.ts:547`）。

---

## 方案 B 核心思路（对标 VSCode copilot）

1. **用 `toolAliases` 把 SDK 的 `Bash` 重定向到 fork 自建的 in-process MCP 工具**（SDK 支持 `toolAliases: { Bash: 'mcp__<server>__bash' }`，见 `sdk.d.ts:1357`）。模型仍按习惯发 `Bash` tool_use，SDK 内部改为调我们的工具，执行权回到 fork 手里。
2. **自建工具 handler 里自己 `child_process.spawn` 执行命令**，实时读 stdout/stderr。
3. **handler 执行期间，用 fork 持有的 `client` 引用实时 `sessionUpdate` 推 `_meta.terminal_output_delta`**（append，关联同一 `toolCallId`）。renderer 侧零改动即可实时上屏。
4. handler 结束时返回完整输出给 SDK（作为 tool_result，供模型读取），并发 `terminal_exit`（退出码）。

> **为什么用 `toolAliases` 而非直接 `disallowedTools:["Bash"]` + 新工具名**：alias 保持模型对 `Bash` 的调用习惯与提示词认知（Claude 的系统提示深度依赖 `Bash` 工具语义），只在执行层替换实现，认知零偏移。这也是 SDK 文档给出的"覆盖内置工具"官方姿势。

---

## 阶段 0 · 方案确认与可行性验证（先做，避免返工）

- [ ] 0.1 **验证 `toolAliases` 真能拦截 `Bash`**：写最小 fork 内实验/单测，装配 `toolAliases: { Bash: 'mcp__universe__bash' }` + 一个打日志的 SDK MCP 工具，确认模型发 `Bash` 时 SDK 调到我们的工具（而非内置）。若 alias 不生效，回退到 `disallowedTools:["Bash"]` + 自定义工具名 `bash`（但需评估对模型调用习惯的影响）。
- [ ] 0.2 **验证 in-process MCP 工具 handler 内能否拿到 `client` 发 `sessionUpdate`**：handler 通过闭包捕获 `this.client` + `sessionId` + `toolUseID`（`extra` 参数是否带 toolUseID 需实测；若没有，用 handler 创建时的上下文绑定）。确认能在 handler **执行中途**（不 return）发出 `tool_call_update`。
- [ ] 0.3 **确认 `toolUseID` 关联**：renderer 的 `_accumulateTerminalOutput` 按 `toolCallId` 累加。必须保证：①模型的 `Bash` tool_use 先产生一个 `tool_call`（pending）；②我们发的 `terminal_output_delta` 的 `toolCallId` 与之**同一个 id**。核对 SDK 在 alias 场景下 tool_use_id 的一致性（这是成败关键，务必在 0 阶段跑通）。
- [ ] 0.4 记录实验结论，若任一验证失败，评估退路（见"风险与退路"）。

**产出**：一份可跑通的最小 PoC（模型跑 `sleep 1 && echo a && sleep 1 && echo b`，编辑器里能看到 a、b 分两次出现），再进入阶段 1。

---

## 阶段 1 · fork 内新增自建 bash 工具 + PTY/子进程执行

**目标**：新增一个 in-process MCP 工具，接管 Bash 执行并实时回流。改动集中在**新文件**，`acp-agent.ts` 只做最小接线。

### 1.1 新增 `src/liveBashTool.ts`（新文件，改动隔离）
- [ ] 定义 `createLiveBashTool(ctx)`，`ctx` 含：
  - `client`：发 `sessionUpdate` 的 ACP client。
  - `getSessionId()` / `sessionId`：路由用。
  - `cwd`：命令执行目录（来自 `params.cwd`）。
  - `logger`：调试输出（关键逻辑加 debug 日志，符合项目约定）。
- [ ] 工具 schema 对齐 SDK `BashInput`（`command`、`timeout?`、`description?`、`run_in_background?` 等；至少 `command` 必填，其余可选透传）。
- [ ] handler 实现：
  1. 解析 `command`。用 `child_process.spawn`（shell 模式，跨平台：Windows 用 `cmd`/`pwsh`，\*nix 用 `/bin/sh -c`；参考 fork 现有 spawn 用法或 codex 的 shell 选择）在 `cwd` 下执行。
  2. **实时**监听 `stdout`/`stderr` 的 `data` 事件，每块 → `client.sessionUpdate({ sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId, _meta: { terminal_output_delta: { data: chunk } } } })`。
  3. 命令结束：发 `terminal_exit`（`{ exit_code, signal, terminal_id: toolCallId }`）+ 状态 `completed`/`failed`；handler `return` 完整 aggregated 输出作为 tool_result（供模型读取，保持与内置 Bash 对模型的语义一致）。
  4. **取消支持**：监听 SDK 传入的 abort signal（`extra` 或 handler 上下文），signal abort 时 kill 子进程（Windows 用 `tree-kill` 语义，参考记忆 [[agent-binary-silent-download-e2e-fix]] 的孤儿进程坑，务必 `/F` 或递归 kill 子进程树）。
  5. **超时**：`timeout` 参数（或默认上限）到点 kill + 标记 failed。
- [ ] **terminal_output_mode 兼容**：复用 fork 现有 `_meta` 形状（`acp-agent.ts:430` `ToolUpdateMeta` 已定义 `terminal_output` / `terminal_output_delta` 语义）。我们**始终发 delta（append）**，与 codex 对齐；renderer 的 `readTerminalOutput` 优先取 `terminal_output_delta`。

### 1.2 `acp-agent.ts` 接线（最小改动）
- [ ] 在 `createSession`（`acp-agent.ts:3733` `options` 装配处）：
  - 用 `createSdkMcpServer({ name: 'universe-live-bash', tools: [liveBashTool] })` 挂到 `mcpServers`（合进现有 `mcpServers` map，注意不覆盖用户 MCP）。
  - 加 `toolAliases: { Bash: 'mcp__universe-live-bash__bash' }`（若 0.1 验证 alias 可用）。
  - handler 需要 `sessionId` —— 在 `createSession` 内构造工具时闭包捕获当前 `sessionId` + `this.client`。
- [ ] **确保仍产生 `tool_call`（pending）卡片**：核对 alias 场景下 SDK 是否仍走 `streamEventToAcpNotifications` 的 tool_use 分支产生 `tool_call`（`acp-agent.ts:5182`）。若 alias 使 tool_use 名变成 `mcp__...__bash`，需在 `toolInfoFromToolUse`（`tools.ts:128`）+ MCP 命名解析处让它仍识别为 execute/Bash 卡片（title 用命令行、kind `execute`）。**这是 UI 卡片正确渲染的关键**，可能需要在 tool_call 映射处加 alias 名 → Bash 语义的归一。

### 1.3 关闭内置 Bash 的一次性输出路径
- [ ] 确认 alias 生效后，内置 Bash 的 `toolUpdateFromToolResult` Bash 分支（`tools.ts:547`）不再被触发（因为执行走了我们的工具）。若仍有 tool_result 经过，避免与我们的实时流**重复输出**（去重：我们的工具已发全量，tool_result 分支应 no-op 或跳过）。

### 1.4 fork 内单测
- [ ] `src/tests/live-bash-tool.test.ts`：
  - handler 执行分段输出的命令 → 断言 `client.sessionUpdate` 被**多次**调用，且携带递增的 `terminal_output_delta`。
  - 退出码非 0 → 断言 `terminal_exit.exit_code` + 状态 `failed`。
  - abort signal → 断言子进程被 kill、发出 failed/cancelled。
  - 跨平台 shell 选择的纯函数（若抽出）单测。

**验证**：`cd vendor/claude-agent-acp && npm test` 通过；`npm run typecheck` 通过。

---

## 阶段 2 · 权限门控对齐（canUseTool）

**目标**：自建 bash 工具的权限体验与内置 Bash **完全一致**（Allow / Allow always / Reject，命令行展示、`Bash(cmd:*)` always-allow 规则）。

- [ ] 2.1 核对 alias 场景下 SDK 是否仍对 `Bash`（或 `mcp__...__bash`）触发 `canUseTool`（`acp-agent.ts:2936`）。
  - 若触发的 toolName 是 alias 后的 MCP 名，需在 `canUseTool` 里把它**归一回 `Bash`**，复用现有通用权限分支（`acp-agent.ts:3086` 的 requestPermissionFromClient）与 `describeAlwaysAllow`（`Bash(cmd:*)` 规则）。
  - `toolInfoFromToolUse` 需按 Bash 渲染权限卡（命令行标题、execute kind）。
- [ ] 2.2 MCP 工具默认可能绕过 `canUseTool`（SDK 对 in-process MCP 工具的权限策略需实测）。若默认自动放行，**必须**在 handler 执行前显式走一次权限请求（复用 `requestPermissionFromClient`），否则实时执行会绕过用户审批 —— **安全红线**。
- [ ] 2.3 `permissionMode`（plan/acceptEdits/bypass）语义：plan 模式下 Bash 应被拒/不执行，确认自建工具遵守当前 mode。
- [ ] 2.4 fork 单测：模拟拒绝 → 断言子进程**未 spawn**、无输出流。

**验证**：`npm test`；手动核对权限卡与内置 Bash 一致。

---

## 阶段 3 · 端到端联调（编辑器侧）

**目标**：真实 claude 会话里，shell 命令实时逐块显示，与 codex 体验一致。

- [ ] 3.1 `pnpm agent:build` 重建 fork 产物。
- [ ] 3.2 起 claude 会话，跑 `for i in 1 2 3; do echo $i; sleep 1; done`（\*nix）/ 等价 Windows 命令 → 编辑器里 1、2、3 应**分次**出现，而非结束后一次性。
- [ ] 3.3 核对：
  - execute 卡片实时刷新（`TerminalOutput` 组件），ANSI 颜色正常。
  - 完成后状态 icon → completed/failed（`ToolCallStatusIcon`）。
  - 权限卡（首次）行为正常。
  - 取消会话（`cancelTurn`）能中断正在跑的命令。
  - 长输出的高度上限 + 展开切换（`COLLAPSED_MAX_PX`）正常。
- [ ] 3.4 **会话恢复**：resume 一个含 bash 的历史会话，确认历史命令输出正确回放（历史走 tool_result 全量，非实时；核对不 double、不丢）。
- [ ] 3.5 **子 agent（Task）里的 Bash**：确认 `parentToolUseId` 路由正确（`_meta.claudeCode.parentToolUseId`），子卡片内也实时。
- [ ] 3.6 回归 codex 会话，确认未受影响（不同 fork，理论零影响，仍要验）。

**验证**：`pnpm check`（仅看错误）；`pnpm e2e`（仅截错误）；手动联调结论回填本节。

---

## 阶段 4 · 测试与文档收尾

- [ ] 4.1 若交互可断言，评估在 `apps/editor/e2e/specs/` 加冒烟（用 `window.__E2E__` 探针断言 delta 上屏；参考记忆 [[e2e-async-session-prompt-not-settled]] 的"先 poll 消息数到位"坑）。若难稳定断言实时性，至少断言"命令输出最终正确 + 卡片为 execute"。给用例打 `@regression` tag（见记忆 [[e2e-regression-tag]]）。
- [ ] 4.2 关键逻辑加 debug 日志（项目约定：关键逻辑需调试输出便于后续分析）—— handler 的 spawn/chunk/exit/kill 各打点。
- [ ] 4.3 评估是否更新 `apps/editor/src/renderer/services/acp/CLAUDE.md`（协议层套路）或本 skill `acp-session-subsystem-context` —— 仅在 claude 终端流机制成为新"套路"时补一句。
- [ ] 4.4 提交注意：submodule 指针更新 + fork 仓库单独推送（参考记忆 [[codex-ai-title-persistence-parity]] 的 eslint hook 污染 vendor 运维坑）。

---

## 风险与退路

- **[高] `toolAliases` / tool_use_id 一致性**（阶段 0.1/0.3）：若 alias 后 tool_use_id 与我们发 delta 的 toolCallId 对不上，实时流不上屏。**退路**：`disallowedTools:["Bash"]` + 自定义工具名，但需在 tool_call 映射处把新工具名归一为 execute/Bash 卡片，且模型提示词对新工具名的认知需验证（可能需在 systemPrompt append 里说明）。
- **[高] 权限绕过**（阶段 2.2）：in-process MCP 工具可能默认不过 `canUseTool`。**必须**确保执行前有审批，否则是安全回归。这是 must-fix 门禁。
- **[中] 重复输出**（阶段 1.3）：我们实时发 + SDK tool_result 再发一次 → 内容翻倍。需确保只有一条路径产出最终文本。
- **[中] 跨平台 shell 与孤儿进程**（阶段 1.1）：Windows 子进程树 kill 不干净会像记忆 [[agent-binary-silent-download-e2e-fix]] 那样导致 e2e teardown 卡死。取消/超时务必递归 kill。
- **[中] 与内置 Bash 的功能差异**：内置 Bash 可能有 sandbox、background task（`Ctrl+B`）、`run_in_background` 等语义。自建工具需覆盖常用子集；background task 等高级语义可先不支持（明确降级 + 日志），避免范围爆炸。
- **[低] 上游 rebase**：改动集中在新文件 `liveBashTool.ts` + `acp-agent.ts` 少量接线，冲突面小。
- **[低] 与 codex `_meta` 协议漂移**：始终发 `terminal_output_delta`（append）与 codex 及 renderer 消费保持一致，不引入新 meta 形状。

---

## 涉及文件清单

**fork（vendor/claude-agent-acp/src/，改完必 `pnpm agent:build`）**
- `liveBashTool.ts`（新增）：自建 bash 工具 + spawn + 实时 delta + exit/kill。
- `acp-agent.ts`：`options` 装配处挂 SDK MCP server + `toolAliases`（`:3733` 附近）；`canUseTool` 归一（`:2936`）；tool_call 映射归一（若需，`:5182` 附近）；tool_result Bash 分支去重（经 `tools.ts:547`）。
- `tools.ts`：`toolInfoFromToolUse` Bash/alias 名归一为 execute 卡片（`:128`）。
- `src/tests/live-bash-tool.test.ts`（新增）。

**renderer（apps/editor/，预期零改动，仅验证）**
- `services/acp/acpSessionUpdateMeta.ts` `readTerminalOutput`（消费，不改）。
- `services/acp/acpSession.ts` `_accumulateTerminalOutput`（消费，不改）。
- `workbench/agents/ToolCallCard.tsx` / `ToolCallOutput.tsx`（渲染，不改）。
- 可能：`apps/editor/e2e/specs/`（阶段 4 冒烟）。

---

## 验证命令

```bash
# fork 内单测 + 类型
cd vendor/claude-agent-acp && npm test && npm run typecheck
# 重建 claude agent 产物（改 fork 后必须）
pnpm agent:build
# renderer 校验
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 涉及交互链路，仅截错误
```
