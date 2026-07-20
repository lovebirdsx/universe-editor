# Agent 是什么，能帮你做什么

这一页帮你在三分钟内明白：AI [Agent](../reference/glossary.md#智能体--agent)（智能体）是什么、能帮内容创作者干什么、在哪里找到它。这是理解整个编辑器的钥匙。

## 目录

- [一句话说清](#一句话说清)
- [它能帮你做什么](#它能帮你做什么)
- [两个内置 Agent](#两个内置-agent)
- [AGENTS 面板在哪](#agents-面板在哪)
- [聊天可以换位置](#聊天可以换位置)
- [核心概念地图](#核心概念地图)

## 一句话说清

普通聊天 AI 只会"告诉你怎么做"；本编辑器的 Agent 会**直接在你的项目里做完**——读文件、改文件、执行操作，做完的改动你再逐条审阅。

换句话说，它不只是问答助手，而是一个能动手的助手。

## 它能帮你做什么

作为游戏内容创作者，你可以把这类活儿交给它（都不需要你会编程）：

- **批量统一用词**：把所有关卡描述里的"HP"统一改成"生命值"。
- **跨文件汇总**：从整套设定集里找出提到某个角色的全部文件，汇总成一份清单。
- **按模板生成内容**：按你既定的模板，一次生成 10 条任务对话文案，并写入对应文件。

<!-- 截图：次侧栏 AGENTS 面板全貌（会话列表 + 输入框） -->

## 两个内置 Agent

编辑器内置了两个 Agent：**Claude Code** 与 **Codex**。默认使用 Claude Code。两者用法基本一致，能力和可选[模型](../reference/glossary.md#模型)略有差异——刚开始用默认的即可。

## AGENTS 面板在哪

- 位置：[辅助侧边栏](../reference/glossary.md#辅助侧边栏)（界面最右侧）的 **"Agents"** 容器，图标是一个闪光（sparkle）。
- 容器内有两个视图：**Agents**（会话列表与输入框）和 **MCP 服务器**。
- 找不到时，从[命令面板](../reference/glossary.md#命令面板)搜"打开 Agents 视图"唤出；用 `Ctrl+Alt+B` 可显隐辅助侧边栏。

## 聊天可以换位置

Agent 聊天默认以标签页的形式在**编辑器区**打开——适合一边看文件一边对话。此时辅助侧边栏的 **Agents** 视图只显示会话列表。

- 你也可以把聊天面板停靠进辅助侧边栏，但该方式为**实验特性、支持并不完善，未来版本可能被移除**，因此默认关闭。
- 如需启用，在[设置](../customization/settings.md)中打开 `acp.chat.enableSidebarLocation`。启用后可通过命令"切换 Agent 聊天位置"在辅助侧边栏 / 编辑器区之间切换，你的选择会被记住；关闭该设置会自动把聊天移回编辑器区。

<!-- 截图：聊天停靠在编辑器区当标签页 -->

## 核心概念地图

围绕 Agent 有几个概念，先混个脸熟，用到时再细看：

- **[会话](../reference/glossary.md#会话agent-会话)**：与 Agent 的一轮完整对话上下文 → [你的第一次 Agent 会话](./first-session.md)
- **[模型](../reference/glossary.md#模型)**：Agent 用哪个大模型思考 → [模型选择与花费](./models-and-cost.md)
- **花费与时间**：一次会话花了多少钱、跑了多久 → [模型选择与花费](./models-and-cost.md)
- **[会话更改](../reference/glossary.md#会话更改)**：本次会话改了哪些文件、如何审阅 → [审阅并采纳 Agent 的改动](./reviewing-changes.md)
- **[模式](../reference/glossary.md#模式agent-模式) / [思考等级](../reference/glossary.md#思考等级)**：Agent 的行为方式与推理深度 → [模式与思考等级](./modes-and-thinking.md)
- **[技能](../reference/glossary.md#技能skill) / [记忆](../reference/glossary.md#记忆memory) / [MCP](../reference/glossary.md#mcp)**：让 Agent 更懂你的项目 → [技能、记忆与 MCP](./skills-memory-mcp.md)
- **会话管理**：历史、恢复、切换、查找 → [管理会话](./managing-sessions.md)

**本页涉及的命令：**

| 命令面板名称 | 快捷键 | 作用 |
| --- | --- | --- |
| 打开 Agents 视图 | 无 | 唤出 AGENTS 面板 |
| 新建 Agent 会话 | `Ctrl+Alt+N` | 开始一段新对话 |
| 切换 Agent 聊天位置 | 无 | 在辅助侧边栏 / 编辑器区之间切换（需先启用 `acp.chat.enableSidebarLocation`） |
| 在编辑器中打开 Agent 会话 | 无 | 把聊天作为标签页打开 |

## 下一步

- [你的第一次 Agent 会话](./first-session.md)

## 相关阅读

- [模型选择与花费](./models-and-cost.md)
- [术语表](../reference/glossary.md)
