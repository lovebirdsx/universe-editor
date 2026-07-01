# AI Agent 快速入门

Universe Editor 内置了 AI 辅助 Agent，可以理解你的项目、阅读和修改文件、并执行多步骤任务。

## 目录

- [Agent 能做什么](#agent-能做什么)
- [打开 Agent](#打开-agent)
- [新建会话](#新建会话)
- [选择 Agent / 模型 / 模式](#选择-agent--模型--模式)
- [发送消息与查看工具调用](#发送消息与查看工具调用)
- [MCP 设置](#mcp-设置)
- [小贴士](#小贴士)

## Agent 能做什么

- 回答关于当前项目的问题，定位代码。
- 按你的要求修改文件、新建内容。
- 执行命令、运行任务，并把每一步的工具调用展示给你审阅。

## 打开 Agent

- 在右侧活动栏（`Ctrl+Alt+B`）点击 **Agent** 图标，打开 Agent 视图。
- 找不到时，用命令面板（`Ctrl+Shift+P`）搜索「Agent」相关命令打开。

## 新建会话

- 在 Agent 视图中点击「新建会话」开始一段新的对话。
- 每个[会话](../reference/glossary.md#会话agent-会话)有独立的上下文，互不干扰。

## 选择 Agent / 模型 / 模式

在输入框附近可以切换：

- **Agent**：选择使用哪一个 agent。
- **模型**：选择对话使用的模型。
- **[模式](../reference/glossary.md#模式agent-模式)**：在不同的工作模式之间切换（如只读咨询 / 可改文件等）。

## 发送消息与查看工具调用

- 在输入框输入需求，回车发送；运行过程中也可继续补充消息。
- Agent 调用工具（读文件、改文件、执行命令）时会以卡片形式展示，点击可展开查看细节。
- 涉及文件改动时会给出[差异（diff）](../reference/glossary.md#差异--diff)，方便你确认改了什么。

## MCP 设置

- Agent 支持通过 [MCP](../reference/glossary.md#mcp)（Model Context Protocol）接入外部工具与数据源。
- 在 Agent 的 MCP 设置入口中配置可用的 MCP 服务器。

## 小贴士

- 描述需求时尽量具体，给出相关文件或目标，Agent 的结果会更准确。
- 对不确定的大改动，先让 Agent 说明思路，确认后再执行。

## 下一步

- [采纳与回退改动](../ai-agent/reviewing-changes.md)
- [模型与成本](../ai-agent/models-and-cost.md)

## 相关阅读

- [AI Agent 完整文档](../ai-agent/overview.md)
- [术语表](../reference/glossary.md)
