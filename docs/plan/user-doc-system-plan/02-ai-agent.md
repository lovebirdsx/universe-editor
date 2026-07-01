# 02 · AI Agent（核心册）

> 所属计划：[用户文档系统建设计划](./README.md)
> 定位：**全系统最核心的一册**。AI Agent 是本编辑器区别于普通编辑器的灵魂功能，用户文档在此册最厚。讲清"让 AI 帮我读写项目文件、批量改内容"这条主线，覆盖会话 / 采纳改动 / 模型与成本 / 技能记忆 MCP / 模式与思考等级 / 会话管理。
> 依赖：[00-foundation](./00-foundation.md)（目录、加载机制、写作/链接约定、术语表基线）。必须待 M0 打通文档间相对链接后，本册互链才生效。
> 里程碑：M1（与 [01 快速上手](./01-getting-started.md) 一起构成"核心可用"）

---

## 目录

- [1. 目标](#1-目标)
- [2. 读者与前置](#2-读者与前置)
- [3. 信息架构](#3-信息架构)
- [4. 逐页要点](#4-逐页要点)
- [5. 链接与交叉引用](#5-链接与交叉引用)
- [6. 本册注意事项](#6-本册注意事项)
- [7. 执行步骤](#7-执行步骤)
- [8. 验收标准](#8-验收标准)

---

## 1. 目标

1. 让**非技术的游戏内容创作者**在读完 overview + first-session 后，能独立跑通第一次 Agent 会话，并明白"这东西能帮我干嘛"。
2. 把"AI 直接改我的文件"这件事讲**安全**：用户知道去哪看改了什么、怎么采纳或回退。
3. 讲清本编辑器特有的两套易混概念——**Agent 模型 vs 平台 AI 模型**、**会话停靠位置（次侧栏 / 编辑器区）**——避免用户踩坑。
4. 覆盖全部 AI Agent 相关命令的核心用法（会话、模型、模式、思考等级、字体、时间线导航、会话内查找），命令名与快捷键**逐条以代码为准**。
5. 与 [05 版本控制](./05-git-scm.md)（会话更改、AI 提交信息）、[06 定制](./06-customization.md)（AI 供应商与密钥）强互链，形成学习路径。

---

## 2. 读者与前置

- **读者**：第一次接触 AI 编辑器的内容创作者，不预设懂编程 / Git / 命令行。
- **阅读前置**：建议先读 [01 快速上手](./01-getting-started.md) 的界面导览与命令面板。
- **功能前置（务必在 overview / first-session 显著提示）**：Agent 要能回复，需先在设置里配好至少一个可用模型与供应商密钥——详见 [06 · AI 供应商](./06-customization.md)。没配好时会话发不出有效回复，这是新用户第一大卡点。
- **事实来源（本册写作时逐条核对）**：
  - 命令 id / 标题 / 快捷键：`apps/editor/src/renderer/actions/` 下 `agentSessionActions.ts`、`agentModelActions.ts`、`agentSettingsActions.ts`、`agentTimelineActions.ts`、`agentContextActions.ts`、`aiActions.ts`、`sessionTitleActions.ts`、`inlineCompletionActions.ts`、`commitMessageActions.ts`。
  - 界面中文用词：`apps/editor/src/shared/i18n/messages/zh-CN.ts`（前缀 `acp.` / `agent.` / `aiModels.` / `aiFeatures.` / `action.agent.` / `action.ai.`）。
  - 面板 / 视图容器：`contributions/AgentsContributions.ts`、`contributions/BuiltInViewContainersContribution.ts`。
  - 特性背景（辅助理解，非用户文案）：`.claude/memory/` 下 `session-cost-feature`、`session-timer-feature`、`session-diff-feature`、`async-session-create`、`codex-claude-skills-memory-parity`。

---

## 3. 信息架构

用户文档落位 `docs/user/zh-CN/ai-agent/`，共 **7 页**。

| 文件（相对 `docs/user/zh-CN/`） | 页面标题 | 覆盖内容 | 关键代码出处 |
|---|---|---|---|
| `ai-agent/overview.md` | Agent 是什么，能帮你做什么 | 价值与场景、AGENTS 面板位置、核心概念地图（会话/模式/模型/技能/记忆/MCP/思考等级） | `AgentsContributions.ts`（`viewContainer.agents`, SecondarySideBar）、`OpenAgentViewAction` |
| `ai-agent/first-session.md` | 你的第一次 Agent 会话 | 手把手：新建会话 → 选 Agent → 输入发送 → 引导/取消 → 加选区上下文 | `NewAgentSessionAction`、`SelectAgentAction`、`FocusAgentInputAction`、`CancelAgentTurnAction`、`AddSelectionToAgentChatAction`、`acp.prompt.*`/`acp.send.*` |
| `ai-agent/reviewing-changes.md` | 审阅并采纳 Agent 的改动 | 会话更改视图、diff 阅读、采纳/回退的安全心智 | `ShowAcpSessionChangesAction`、`viewContainer.sessionChanges`、`acp.changes.*`、memory `session-diff-feature` |
| `ai-agent/models-and-cost.md` | 模型选择与花费 | Agent 模型 vs 平台 AI 模型、按功能分配模型、¥ 成本、运行时间 | `SelectAgentModelAction`、`PickModelAction`、`aiFeatures.*`、`acp.cost.*`、`acp.session.runningTime`、memory `session-cost/timer` |
| `ai-agent/skills-memory-mcp.md` | 技能、记忆与 MCP | `.claude/skills`、`.claude/memory/MEMORY.md`、MCP 外部工具接入 | `OpenAcpMcpSettingsAction`、`acp.mcpServers`、`view.agents.mcp`、memory `codex-claude-skills-memory-parity` |
| `ai-agent/modes-and-thinking.md` | 模式与思考等级 | Agent 模式、思考等级、何时用哪种 | `SelectAgentModeAction`、`SelectAgentThoughtLevelAction`、`agent.selectMode.*`/`agent.selectThoughtLevel.*` |
| `ai-agent/managing-sessions.md` | 管理会话 | 历史/恢复/切换/清理、会话标题、聊天字体、时间线导航与会话内查找 | `ResumeAgentSessionAction`、`SwitchSessionAction`、`RefreshAgentSessionsAction`、`ClearAgentSessionHistoryAction`、字体三命令、`agentTimelineActions.ts`、`ChatFind*` |

> 截图统一放 `docs/user/zh-CN/assets/ai-agent/`，暗色主题，命名 kebab-case。

---

## 4. 逐页要点

> 下列每页均须以样板页骨架落地（唯一 H1 + TOC + `## 下一步` / `## 相关阅读`）。命令名用 `zh-CN.ts` 的中文标题；快捷键以 Windows 键位（`Ctrl`/`Alt`/`Shift`）为准。

### 4.1 overview.md — Agent 是什么，能帮你做什么

- **讲什么**：用"能帮你动手做事的 AI 助手"开篇，强调它**能读写你项目里的文件、执行批量操作**，不只是聊天问答。这是本页也是全册的"钩子"，必须让非技术读者在前三屏内秒懂价值。
- **任务导向要点**：
  - 一句话定位：普通聊天 AI 只会"告诉你怎么做"，本编辑器的 Agent 会"直接在你的项目里做完"，做完的改动你再逐条审阅。
  - 用 3 个内容创作场景讲价值（非编程例子）：把所有关卡描述里的"HP"统一改成"生命值"；从整套设定集里找出提到某角色的全部文件并汇总；按既定模板一次生成 10 条任务对话文案并写入对应文件。
  - 说明内置两个 Agent：**Claude Code** 与 **Codex**（默认用 Claude Code，见配置 `acp.defaultAgentId` 默认 `claude-code`）。两者用法一致，能力/可选模型略有差异，先用默认即可。
  - AGENTS 面板在哪：**次侧栏**（Secondary Side Bar）的 "Agents" 容器（图标为闪光/sparkle）；容器内含 "Agents" 与 "MCP 服务器" 两个视图。首次可用"打开 Agents 视图"命令唤出。
  - 聊天可**换位置**（会话停靠）：默认停在次侧栏；也可移到编辑器区当成一个标签页，适合边看文件边对话。用"切换 Agent 聊天位置"或"在编辑器中打开 Agent 会话"切换，选择会被记住。
  - **核心概念地图**（每条一句话 + 链到本册对应页 / [07 术语表](../reference/glossary.md)）：
    - 会话：与 Agent 的一轮完整对话上下文 → [first-session](./first-session.md)
    - 模型：Agent 用哪个大模型思考 → [models-and-cost](./models-and-cost.md)
    - 花费与时间：一次会话花了多少钱、跑了多久 → [models-and-cost](./models-and-cost.md)
    - 会话更改：本次会话改了哪些文件、如何审阅 → [reviewing-changes](./reviewing-changes.md)
    - 模式 / 思考等级：Agent 的行为方式与推理深度 → [modes-and-thinking](./modes-and-thinking.md)
    - 技能 / 记忆 / MCP：让 Agent 更懂你的项目 → [skills-memory-mcp](./skills-memory-mcp.md)
    - 会话管理：历史、恢复、切换、查找 → [managing-sessions](./managing-sessions.md)
- **涉及命令 + 快捷键**：`打开 Agents 视图`；`新建 Agent 会话`（`Ctrl+Alt+N`）；`切换 Agent 聊天位置`；`在编辑器中打开 Agent 会话`。
- **建议截图**：`<!-- 截图：次侧栏 AGENTS 面板全貌（会话列表 + 输入框） -->`、`<!-- 截图：聊天停靠在编辑器区当标签页 -->`
- **互链去向**：→ [first-session](./first-session.md)（马上上手）；概念词 → 各页 + [术语表](../reference/glossary.md)。

### 4.2 first-session.md — 你的第一次 Agent 会话

- **讲什么**：新用户照着做，跑通从"打开面板"到"收到第一条回复"的完整流程。全册最"手把手"的一页，步骤要能被零基础用户逐字照做。
- **任务导向要点**：
  - 前置提示（放页首醒目位置）：需先配好模型/供应商，否则发不出有效回复 → 链 [06 · AI 供应商](../customization/ai-providers.md)。
  - 步骤 1 新建会话：`Ctrl+Alt+N`，或面板里的"新建会话"按钮（`acp.emptySession.newSession`）。说明新建后会立刻出现空会话页、可马上输入（无需等待连接）。
  - 步骤 2（可选）选 Agent：命令"选择 Agent 并新建会话…"或空会话页"选择 Agent"按钮——**注意此命令会顺带新建一个会话**，不是单纯切默认 Agent；列表里不可用的 Agent 会标注"未安装（PATH 中找不到命令）"。
  - 步骤 3 输入需求并发送：输入框占位文案"询问 Agent…"，`Enter` 发送（按钮文案"发送 (Enter)"）；首条消息过短会先弹确认（可配 `acp.prompt.confirmShortFirstMessageLength`，默认 20 字符）。
  - **写好第一条需求的示范（给可套用的句式）**：明确"改什么 + 在哪些文件/目录 + 期望结果"。反例"帮我改一下文案"；正例"把 `levels/` 目录下所有 `.md` 里的『HP』替换成『生命值』，保留大小写以外的格式"。
  - 步骤 4 运行中继续引导：运行时仍可再发消息（按钮变"运行中 · 发送以引导"），可用来纠偏或补充要求。
  - 步骤 5 取消当前回合：`Ctrl+Shift+Escape`，或点"停止 (Esc)"；说明取消不会撤销已经落盘的改动（撤销去 reviewing-changes）。
  - 进阶提示：聚焦输入框 `Ctrl+Alt+I`；把编辑器里选中的文本作为上下文丢给 Agent —— "将选区添加到 Agent 聊天"，`Ctrl+K Ctrl+L`（会自动新建/复用会话并把选区作为上下文附上）。
  - 收尾引导：会话跑完后，第一件事是去看"会话更改" → 顺势带到下一页。
- **涉及命令 + 快捷键**：`新建 Agent 会话`(`Ctrl+Alt+N`)、`选择 Agent 并新建会话…`、`聚焦 Agent 输入框`(`Ctrl+Alt+I`)、`取消 Agent 回合`(`Ctrl+Shift+Escape`)、`将选区添加到 Agent 聊天`(`Ctrl+K Ctrl+L`)。
- **建议截图**：`<!-- 截图：空会话页 + 输入第一条需求 -->`、`<!-- 截图：运行中状态与停止按钮 -->`
- **互链去向**：→ [reviewing-changes](./reviewing-changes.md)（收到改动后怎么看）；→ [models-and-cost](./models-and-cost.md)；前置 → [06 AI 供应商](../customization/ai-providers.md)。

### 4.3 reviewing-changes.md — 审阅并采纳 Agent 的改动

- **讲什么**：这是**安全主题**。Agent 会直接把改动写到磁盘上，用户必须知道去哪审阅、怎么采纳或撤销。全册最需要"让用户安心"的一页。
- **任务导向要点**：
  - 心智先行：Agent 一次会话可能改多个文件，本编辑器把这些改动聚合成"会话更改"集合，逐文件可看 diff。它是"这次会话动了什么"的总账，独立于 Git 的工作区改动视图。
  - 打开会话更改：命令"显示会话更改"，或会话编辑器标题栏的 diff 图标；视图位于**主侧栏**的"会话更改"容器（图标 diff）。
  - 列表 / 树两种视图切换："以列表查看" / "以树查看"（右上角工具栏按钮）；文件多时用树更清楚。
  - 预览与钉住：单击文件 = 预览（复用同一个预览标签，快速扫过多个文件不堆一堆标签），双击 = 钉住成独立标签；行内还有"打开文件" / "打开预览"。
  - 读 diff：左旧右新、按状态着色（新增 / 修改 / 删除）；删除项无内容可点。教读者重点看"改动是否符合预期、有没有误伤"。
  - 采纳 vs 回退（**关键，并与 05 分工**）：改动已在磁盘上，"采纳"通常意味着后续用 Git **暂存并提交**；"回退"意味着用 Git **放弃更改**或撤销单个文件。真正的暂存/提交/放弃操作在 [05 · 会话更改](../git/session-changes.md) 深讲，本页只讲"看懂 diff + 做决策"，并把动手操作指向 05。
  - 安全建议给读者：先建 Git 仓库/先提交一次干净状态，再让 Agent 大改，这样任何改动都可一键回退（细节链 05）。
  - 空态：会话没改文件时提示"此会话尚未修改任何文件。"
- **涉及命令 + 快捷键**：`显示会话更改`（无默认快捷键；命令面板可搜）。
- **建议截图**：`<!-- 截图：会话更改列表/树 -->`、`<!-- 截图：某文件的 diff 预览 -->`
- **互链去向**：→ [05 · 会话更改](../git/session-changes.md)（**强互链**，暂存/提交/放弃在那册）；→ [05 · 提交与 AI 提交信息](../git/commit.md)；← [first-session](./first-session.md)。

### 4.4 models-and-cost.md — 模型选择与花费

- **讲什么**：怎么选模型、给不同功能分别配模型、看清一次会话花了多少钱与多久。
- **任务导向要点**：
  - **两套模型体系（务必讲清，这是易混点）**：用一张对照表区分，避免用户以为改了一个就全生效。

    | | Agent 模型 | 平台 AI 模型 |
    |---|---|---|
    | 作用对象 | 当前 Agent 会话 | 编辑器内置 AI 功能 |
    | 切换命令 | 选择 Agent 模型… | 选择 AI 模型 |
    | 来源 | Agent 自身暴露的模型列表 | 你在设置里配置的供应商模型 |
    | 不可用时 | 提示"活跃 Agent 未提供模型选择器。" | 需先配供应商，否则列表为空 |

  - **按功能分配模型**（在"AI 与 Agent 设置"的 Agents 分组里，各功能可用不同模型，例如内联补全用更小更快的）：对话（`aiFeatures.chat` = 对话，说明"AGENTS 会话与对话补全使用的模型"）、提交信息（`aiFeatures.commit` = 提交信息，"生成 Git 提交信息使用的模型"）、内联补全（`aiFeatures.inline` = 内联补全，"编辑器幽灵文本补全使用的模型"）、会话标题（`aiFeatures.sessionTitle` = 会话标题，"为 AGENTS 会话生成友好标题使用的模型"），各有独立选择命令。
  - 打开设置：命令面板搜"打开 AI 与 Agent 设置"。
  - **成本显示**：输入框下方有 ¥ 人民币开销 chip（悬浮提示"会话费用 - 点击查看明细"），点击弹"会话费用明细"，按模型列出输入/输出 token 与各模型开销及总计；数据来自 Agent 上报的真实用量（含子任务开销），无法精确时标注为"预估会话费用"。
  - **运行时间**：会话运行时间（`acp.session.runningTime`）只累计 Agent 实际运行的净时长，不含挂起/等待。
- **涉及命令 + 快捷键**：`选择 Agent 模型…`、`选择 AI 模型`、`选择内联补全模型`、`选择提交信息模型`、`选择会话标题模型`、`打开 AI 与 Agent 设置`（均无默认快捷键，命令面板可搜）。
- **建议截图**：`<!-- 截图：Agent 模型选择器 -->`、`<!-- 截图：AI 与 Agent 设置的按功能分配 -->`、`<!-- 截图：会话费用明细弹窗 -->`
- **互链去向**：→ [06 · AI 供应商](../customization/ai-providers.md)（配供应商与密钥，前置）；→ [03 · 内联补全](../editing/inline-completion.md)；→ [05 · 提交与 AI 提交信息](../git/commit.md)；→ [managing-sessions](./managing-sessions.md)（会话标题）。

### 4.5 skills-memory-mcp.md — 技能、记忆与 MCP

- **讲什么**：三种"给 Agent 增能"的机制，以及它们对内容创作者到底意味着什么（进阶但高价值）。
- **任务导向要点**：
  - **技能 Skills**：放在项目 `.claude/skills` 下的可复用能力包；在输入框敲 `/` 可看到可用技能。举例：一个"按模板生成任务文案"的技能，让 Agent 每次都按你的规范产出。
  - **记忆 Memory**：`.claude/memory/MEMORY.md` 作索引 + 分篇正文；Agent 每轮自动读索引、按需读分篇。用于让 Agent **记住项目设定、术语译法、写作风格**，省得每次重复解释。
  - 一套 `.claude/` 目录同时服务内置的两个 Agent（Claude 与 Codex）。
  - **MCP**（外部工具/数据接入协议）：命令"打开 MCP 设置"落到设置里的 `acp.mcpServers`；AGENTS 容器里的"MCP 服务器"视图可查看当前会话已连接的服务器（无则提示"此会话没有配置 MCP 服务器。"）。
  - 面向创作者定调：这些偏进阶，价值是"让 AI 更懂你的项目、少解释、更一致"，不必一开始就全用上。
- **涉及命令 + 快捷键**：`打开 MCP 设置`（命令面板可搜）。
- **建议截图**：`<!-- 截图：输入 / 弹出技能列表 -->`、`<!-- 截图：MCP 服务器视图 -->`、`<!-- 截图：设置里的 acp.mcpServers -->`
- **互链去向**：→ [06 · 设置](../customization/settings.md)；→ [07 术语表](../reference/glossary.md)（技能 / 记忆 / MCP）；← [overview](./overview.md)。

### 4.6 modes-and-thinking.md — 模式与思考等级

- **讲什么**：两个"当前会话级"的调节旋钮——Agent 模式、思考等级，以及何时用哪种。
- **任务导向要点**：
  - **Agent 模式**（"选择 Agent 模式…"）：Agent 的行为模式，具体可选项由当前 Agent 提供；不同 Agent 暴露的模式不同，当前 Agent 不提供时提示"活跃 Agent 未提供会话模式选择器。"
  - **思考等级**（"选择 Agent 思考级别…"）：Agent 推理投入的深度；越高越细致但**越慢、越贵**；不提供时提示"活跃 Agent 未提供思考级别开关。"
  - 场景建议：简单批量替换/查找 → 低思考即可；设计、推理、跨文件重构类 → 提高思考等级。
  - 强调：这两项作用于**当前活跃会话**，且依赖 Agent 能力，可能不可用。
- **涉及命令 + 快捷键**：`选择 Agent 模式…`、`选择 Agent 思考级别…`（均无默认快捷键，命令面板可搜）。
- **建议截图**：`<!-- 截图：模式选择器 -->`、`<!-- 截图：思考等级选择器 -->`
- **互链去向**：→ [models-and-cost](./models-and-cost.md)（思考等级影响成本）；← [first-session](./first-session.md)。

### 4.7 managing-sessions.md — 管理会话

- **讲什么**：会话的历史、恢复、切换、清理，加上会话标题、聊天字体与会话内导航/查找。
- **任务导向要点**：
  - **恢复历史会话**：`Ctrl+Shift+H`，从列表挑（显示标题、所在目录、相对时间）；属于其它工作区的会话会以**只读预览**打开，避免误连错目录。
  - **刷新会话列表**：命令"刷新 Agent 会话列表"。
  - **跨窗口切换会话**：`Alt+S`（"切换会话…"）。
  - **清除会话历史**：命令"清除 Agent 会话历史"，有确认弹窗；说明它**只清本地历史索引**，Agent 侧的对话仍保留直到其自行清理。
  - 会话可见范围可配：`acp.sessions.historyScope`（当前工作区 / 当前 worktree / 全部）。
  - **会话标题**：自动生成；可指定专门的"会话标题模型"（详见 [models-and-cost](./models-and-cost.md)）。
  - **聊天字体大小**：增大 `Ctrl+=`、减小 `Ctrl+-`、重置 `Ctrl+0`（仅在聊天获得焦点时生效）。
  - **时间线导航（会话聊天聚焦时）**：这组键仅在聊天获得焦点时生效，建议以小表格呈现给读者：

    | 操作 | 快捷键 | 命令标题 |
    |---|---|---|
    | 上一项 / 下一项 | `Alt+↑` `Alt+↓`（或 `Alt+K` `Alt+J`） | 聚焦上一个/下一个时间线项 |
    | 顶部 / 底部项 | `Alt+A` / `Alt+E` | 聚焦时间线顶部项/底部项 |
    | 滚动 上/下 | `Ctrl+Alt+↑` / `Ctrl+Alt+↓` | 向上/向下滚动时间线 |
    | 翻页 上/下 | `Ctrl+Alt+PageUp` / `Ctrl+Alt+PageDown` | 时间线向上/向下翻页 |
    | 折叠当前项 | `Alt+F` | 切换时间线项折叠状态 |
    | 全部折叠循环 | `Ctrl+Alt+F` | 循环切换时间线折叠状态（全部） |
    | 跳转到计划 | `Alt+P` | 跳转到计划 |

  - **会话内查找**：`Ctrl+F` 打开，`F3` 下一个 / `Shift+F3` 上一个 / `Esc` 关闭（查找条文案：下一个匹配项 (F3) / 上一个匹配项 (Shift+F3) / 关闭 (Esc)）。
- **涉及命令 + 快捷键**：`恢复 Agent 会话…`(`Ctrl+Shift+H`)、`切换会话…`(`Alt+S`)、`刷新 Agent 会话列表`、`清除 Agent 会话历史`、`增大/减小/重置聊天字体大小`(`Ctrl+=`/`Ctrl+-`/`Ctrl+0`)、`在会话中查找`(`Ctrl+F`)、`查找下一个`(`F3`)/`查找上一个`(`Shift+F3`)、时间线导航一组（见上）。
- **建议截图**：`<!-- 截图：恢复会话列表 -->`、`<!-- 截图：切换会话（跨窗口） -->`、`<!-- 截图：会话内查找条 -->`
- **互链去向**：→ [overview](./overview.md)；→ [models-and-cost](./models-and-cost.md)（会话标题模型）；← [first-session](./first-session.md)。

---

## 5. 链接与交叉引用

- **册内学习路径**：overview → first-session → reviewing-changes → models-and-cost，随后按需读 skills-memory-mcp / modes-and-thinking / managing-sessions。每页 `## 下一步` / `## 相关阅读` 落实。
- **跨册强互链**：
  - reviewing-changes ↔ [05 · 会话更改](../git/session-changes.md)（同一视图，采纳/回退落在 Git 那册）。
  - models-and-cost → [06 · AI 供应商](../customization/ai-providers.md)（供应商与密钥是所有模型功能的前置）；提交信息模型 → [05 · 提交](../git/commit.md)；内联补全模型 → [03 · 内联补全](../editing/inline-completion.md)。
  - skills-memory-mcp → [06 · 设置](../customization/settings.md)。
- **术语链接**：会话 / 智能体 / 模式 / 思考等级 / 技能 / 记忆 / MCP / 会话更改，首次出现链到 [07 术语表](../reference/glossary.md) 对应锚点。
- **命令速查回填**：本册所有命令名 + 快捷键在 [07 · 快捷键速查](../reference/keyboard-shortcuts.md) / [命令速查](../reference/command-reference.md) 汇总，正文文末可选"相关命令"聚合区。

---

## 6. 本册注意事项

- **术语"会话更改" vs "会话改动"（发现的不一致，须统一）**：UI 实际用词是 **"会话更改"**（`viewContainer.sessionChanges` = `会话更改`，命令 `显示会话更改`）；但 [00 术语表基线](./00-foundation.md#8-术语表基线) 写作"会话改动"。**以 UI 为准**：建议把术语表基线改为"会话更改"，本册正文一律用"会话更改"。落地时同步告知 05 册作者。
- **面板名保留英文 "Agents"**：`viewContainer.agents` 与 `view.agents.main` 的中文文案仍是 `Agents`（未译）。文档提到面板时保留 "Agents"，不要自造译名如"智能体面板"。
- **"选择 Agent"命令会顺带新建会话**：`SelectAgentAction` 标题是"选择 Agent 并新建会话…"，写作别简化成"仅切换默认 Agent"。
- **"打开 Agent 设置"命令面板搜不到**：`OpenAgentSettingsAction`（"打开 Agent 设置"）未启用命令面板（无 `f1`），通常由界面按钮触发；命令面板能搜的入口是 **"打开 AI 与 Agent 设置"**（`ai.manageModels`）。正文引导"从命令面板打开设置"时用后者。
- **模型两套体系易混**：Agent 模型（`SelectAgentModelAction`）与平台 AI 模型（`PickModelAction`）用途不同，models-and-cost 必须并列讲清，避免用户以为改了一个就全生效。
- **依赖活跃会话与 Agent 能力**：模型/模式/思考等级选择都要求"当前有活跃会话"且"Agent 暴露该选项"，否则弹提示。相关页要说明"可能不可用"。
- **成本/思考等级涉及真实花费**：措辞保持中性、给权衡（更慢更贵 vs 更细致），不写"随便调高"。
- **快捷键以 Windows 为准**：Mac 差异（`Cmd` 等）统一在 07 速查表标注，本册不逐页展开。
- **`InlineCode` 会把纯路径渲染成可点链接**（见 00 §6.4）：正文里像 `.claude/skills`、`acp.mcpServers` 这类会被当路径的示例注意排版，避免误触发跳转。

---

## 7. 执行步骤

1. 确认 [00](./00-foundation.md) 已打通 `docRegistry` 多语言加载与"相对 `.md` 链接跳转"，否则本册互链是死的。
2. 在 `docs/user/zh-CN/ai-agent/` 建 7 个 md（overview / first-session / reviewing-changes / models-and-cost / skills-memory-mcp / modes-and-thinking / managing-sessions），每篇含唯一 H1 + TOC + `## 下一步` / `## 相关阅读`。
3. 逐页对照 §4 要点与代码出处填内容；每个命令名 / 快捷键回查 `actions/*.ts` 与 `zh-CN.ts` 后再落笔。
4. 处理术语"会话更改"统一（见 §6），必要时提 PR 顺带修 00 术语表基线。
5. 与 [05](./05-git-scm.md)、[06](./06-customization.md) 作者对齐互链锚点：`git/session-changes.md`、`git/commit.md`、`customization/ai-providers.md`。
6. 截图：暗色主题，放 `docs/user/zh-CN/assets/ai-agent/`，无法即时产出的留 `<!-- 截图：… -->` 占位并在册末汇总"待补图清单"。
7. `pnpm check`（仅截取错误）；应用内经 `DocEditorInput` 逐页打开自测渲染与跳转；涉及交互链路时跑 `pnpm e2e` 文档打开/跳转冒烟。
8. 回填 [07](./07-reference-and-faq.md) 命令/快捷键速查（把本册命令表并入）。

---

## 8. 验收标准

- [ ] 7 页齐全，路径与命名与 [README](./README.md) / [00](./00-foundation.md) 完全一致。
- [ ] 每页有 TOC、`## 下一步` / `## 相关阅读`、必要截图占位（至少 `<!-- 截图：… -->`）。
- [ ] 所有命令名、快捷键与 `actions/*.ts`、`zh-CN.ts` 一致（逐条核对，含 `Ctrl+Alt+N`/`Ctrl+Shift+Escape`/`Ctrl+Alt+I`/`Ctrl+Shift+H`/`Alt+S`/`Ctrl+K Ctrl+L`/字体三键/时间线导航/查找键）。
- [ ] overview 用内容创作场景讲清价值，非技术读者可懂；AGENTS 面板位置（次侧栏）与两个内置 Agent 描述准确。
- [ ] first-session 可被新用户照做跑通第一次会话，且显著提示"需先配供应商/模型"。
- [ ] reviewing-changes 讲清安全审阅心智与"采纳/回退落在 Git"的分工，且与 [05 会话更改](../git/session-changes.md) 互链成立。
- [ ] models-and-cost 讲清 Agent 模型 vs 平台 AI 模型、四类功能分配（对话/提交信息/内联补全/会话标题）、¥ 成本明细与运行时间。
- [ ] 术语"会话更改"全册统一，并与 07 术语表一致（若改基线，同步 00）。
- [ ] 面板名保留 "Agents"；命令面板引导用"打开 AI 与 Agent 设置"而非"打开 Agent 设置"。
- [ ] 所有内部链接可解析（无死链），术语首现链到 [07 术语表](../reference/glossary.md)。
- [ ] 应用内经 `DocEditorInput` 能正常打开渲染全部 7 页。
- [ ] `pnpm check` 通过（仅截取错误）；文档打开/跳转 e2e 冒烟通过。
