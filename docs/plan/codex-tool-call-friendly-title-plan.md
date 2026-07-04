# Codex 工具调用卡片友好标题 支持计划

> 关联改动：本仓库已完成 **renderer 层**的工具调用卡片友好化（标题显示友好说明、命令细节降入展开区、outline / sticky 同步用友好标题）。
>
> - view-model：`AcpToolCall.rawInput` 透传（`acpSessionModel.ts` + `acpSession.ts`）
> - 归一化纯函数：`workbench/agents/toolCallDisplay.ts` 的 `deriveToolCallDisplay(call)`
> - 消费点：`ToolCallCard.tsx`（标题/展开命令块）、`StickyScrollOverlay.tsx`、`acpTimelineOutline.ts`
>
> **Claude 侧已完全生效**（Bash 的 `description` / Grep 的 `pattern` 被提为标题）。**本计划专门补齐 Codex 侧**，让 codex 的命令类工具卡片也显示友好标题、命令行降为细节。
>
> 通用纪律：
> - 改 `vendor/codex-acp` 属 submodule fork，**不在 pnpm workspace 内**。改完必须 `pnpm agent:build`（npm ci + tsc + prune）重建 `vendor/codex-acp/{dist,node_modules}`，否则 main 仍跑旧产物。
> - fork 内测试用它自带 npm 工具链（`npm test`），renderer 侧改动跑 `pnpm check` / `pnpm e2e`。
> - fork 改动应能干净地 rebase 到上游，改动尽量收敛在 `CodexToolCallMapper.ts`。

---

## 背景：Codex 与 Claude 的关键差异

| | Claude fork | Codex fork |
|---|---|---|
| 友好说明来源 | agent 每次调用自带 `input.description`（人话，如"查看工作区状态"） | **协议里没有 description 字段** |
| 命令结构化解析 | 无（renderer 从 `rawInput` 取 `command`/`description`） | `parsed_cmd` / `commandActions`（`read`/`search`/`listFiles`/`unknown`） |
| 现状标题 | Bash=命令行（已被 renderer 用 description 覆盖） | `read`/`search`/`listFiles` 已友好；**`unknown` 走裸命令行**（`createCommandActionEvent` 的 unknown 分支 + `commandActions.length !== 1` 的降级路径） |

**结论**：codex 的普通 shell 命令（`unknown`）没有天然的"友好说明"数据源。renderer 的 `deriveToolCallDisplay` 对 codex 只能回退命令行——这是数据源限制，纯 renderer 层无法解决。

关键代码位置（`vendor/codex-acp/src/CodexToolCallMapper.ts`）：
- `createCommandExecutionUpdate`（L77）：`commandActions.length === 1` 走 `createCommandActionEvent`；否则整体 `title: command`（裸命令行）。
- `createCommandActionEvent`（L419）：`read`/`search`/`listFiles` 友好；`unknown` 分支 `title: stripShellPrefix(command)`（裸命令行）。

---

## 方案选择（阶段 0，先定方向）

- [ ] 0.1 在三个方案里选一个（下面按推荐度排序），确定后再进入对应阶段。

### 方案 A（推荐）· fork 内为 command 生成结构化 description，renderer 复用现有管线
在 `CodexToolCallMapper.ts` 里，为 execute/command 类 `tool_call` 的 `rawInput` **补一个 `description` 字段**（友好说明），命令仍放 `rawInput.command`。
- renderer 端**零改动**：`deriveToolCallDisplay` 已优先读 `rawInput.description`、把 `command` 降为副标题/展开细节，逻辑与 Claude 完全对称。
- description 的生成源：codex 的 `parsed_cmd`（`read`/`search`/`list_files`/`unknown`）已是结构化解析，可映射成人话；`unknown` 用启发式（取首个可执行程序名 + 关键参数，如 `运行 npm build`）。
- **取舍**：友好度受限于 codex 的解析质量；`unknown` 的描述是启发式的，不如 Claude 的 agent 原生 description 精准，但优于裸命令行。

### 方案 B · 仅统一 codex 的降级路径，不引入 description
只把 `createCommandActionEvent` 的 `unknown` 分支和 `commandActions.length !== 1` 的整体降级，改成"标题用一句固定友好模板（如 `执行命令`）+ 命令进 rawInput"。
- 改动最小，但标题信息量低（所有 unknown 命令标题都一样），需靠展开区看具体命令。
- 适合"只要不再把裸命令行当标题"的最低目标。

### 方案 C · renderer 侧为 codex 加启发式 fallback（不碰 fork）
在 `toolCallDisplay.ts` 里，当 `kind === 'execute'` 且无 `description` 时，对 `rawInput.command` 做启发式提炼（程序名 + 动作）。
- 不用 `pnpm agent:build`，纯 renderer。
- **缺点**：把 shell 解析逻辑放进 UI 层，和 codex 已有的 `parsed_cmd` 解析重复、二次解析质量更差；不推荐，仅当不想动 submodule 时的备选。

> 下面阶段以**方案 A** 展开（最对称、友好度最高）。若选 B/C，取对应子集执行。

---

## 阶段 1 · fork 内生成 command 的友好 description（方案 A）

**目标**：codex 的 execute/command 类 `tool_call` 的 `rawInput` 带上 `description`，命令保留在 `rawInput.command`。

### 1.1 新增描述生成纯函数
- [ ] 在 `CodexToolCallMapper.ts`（或同目录新文件 `commandDescription.ts`）加 `describeParsedCommand(action: CommandAction): string`：
  - `read` → `读取文件 <name/path>`
  - `search` → `搜索 "<query>"`（无 query 时 `搜索文件`）
  - `listFiles` → `列出 <path> 下的文件`（无 path 时 `列出文件`）
  - `unknown` → 启发式：`stripShellPrefix` 后取首个 token（程序名），映射常见命令（`npm`/`pnpm`/`git`/`cargo`/`ls`/`cat`…）为动作短语，兜底 `运行 <程序名>`。
- [ ] 为该函数写 fork 内单测（`src/tests/`，覆盖四种 CommandAction + 常见 unknown 命令）。

### 1.2 接入 command 事件
- [ ] `createCommandActionEvent`（L419）：`read`/`search`/`listFiles` 分支保留现有友好 `title`，**额外**在返回对象加 `rawInput: { command: commandAction.command, cwd, description: describeParsedCommand(commandAction) }`（当前这几个分支没带 rawInput，补上使 renderer 可展开命令细节）。
- [ ] `unknown` 分支：`title` 可保留命令行（renderer 会用 description 覆盖），核心是 `rawInput` 加 `description`。
- [ ] `createCommandExecutionUpdate`（L77）的 `commandActions.length !== 1` 整体降级路径：同样给 `rawInput` 补 `description`（多 action 时可拼接或取主 action）。

### 1.3 与现有 rawInput 字段兼容
- [ ] 确认补 `description` 不影响 codex 既有对 `rawInput.command` 的消费（terminal 输出关联等，见 `createTerminalCommandEvent`）。description 是新增可选字段，纯附加。

**验证**：fork 内 `npm test` 通过；`pnpm agent:build` 重建产物。

---

## 阶段 2 · renderer 侧验证与（如需）微调

**目标**：确认 renderer 的 `deriveToolCallDisplay` 对 codex 新数据正确工作，命令降入展开区、outline/sticky 用友好标题。

- [ ] 2.1 复核 `deriveToolCallDisplay`（`toolCallDisplay.ts`）：execute 分支已是 `description` 优先、`command` 作 subtitle → 展开区命令块。**预期零改动**。
- [ ] 2.2 若方案 A 的 `search` 描述与 renderer 现有 `search` 分支（从 `rawInput.pattern` 造 `搜索 "..."`）冲突/重复：codex 用 `execute`/`read`/`search` kind，检查 kind 分派是否命中预期分支，必要时让 codex 的 search 也带 `rawInput.pattern` 走同一分支，避免两套"搜索"文案。
- [ ] 2.3 补 renderer 单测：在 `toolCallDisplay.test.ts` 加 codex 形态用例（execute + `rawInput.description` 无 Claude 特有字段时，标题取 description、subtitle 取 command）。

**验证**：`pnpm check`（仅看错误）。

---

## 阶段 3 · 端到端联调

**目标**：真实 codex 会话里，命令卡片标题为友好说明、展开见命令、outline 节点为友好说明。

- [ ] 3.1 起一个 codex 会话，触发若干命令（一个 read、一个 search、一个普通 shell 如 `pnpm build`）。
- [ ] 3.2 核对：卡片标题=友好说明；展开区有命令行细节；Outline 视图对应节点=友好说明；sticky 悬浮头=友好说明。
- [ ] 3.3 回归 Claude 会话，确认未受影响（同一 renderer 路径）。
- [ ] 3.4 如涉及可断言的交互，评估是否加/更新 `apps/editor/e2e/specs/` 冒烟；否则手动验证记录在此。

**验证**：`pnpm e2e`（仅截错误）；手动联调结论回填本节。

---

## 风险与注意

- **submodule 运维坑**：改 `vendor/codex-acp` 必跑 `pnpm agent:build`；提交时注意 submodule 指针更新 + fork 仓库单独推送。参考记忆 [[codex-ai-title-persistence-parity]] 里 eslint hook 污染 vendor 的坑。
- **上游 rebase**：改动集中在 `CodexToolCallMapper.ts` 一处，降低与上游冲突面。
- **description 质量**：`unknown` 命令的启发式描述天然不如 Claude 的 agent 原生 description。若后续 codex 协议提供更好的命令意图字段，可替换启发式。
- **对称性**：目标是 codex 与 Claude 在 renderer 层走**完全相同**的 `deriveToolCallDisplay` 路径，差异只在"fork 是否喂了 description"。不要为 codex 在 renderer 层开分叉逻辑（否则违背单一归一化点的设计）。

---

## 验证命令

```bash
# fork 内
cd vendor/codex-acp && npm test
# 重建 codex agent 产物（必须）
pnpm agent:build
# renderer 校验
pnpm check        # lint + typecheck + test，仅看错误
pnpm e2e          # 涉及交互链路，仅截错误
```
