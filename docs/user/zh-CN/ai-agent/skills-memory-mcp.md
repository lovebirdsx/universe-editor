# 技能、记忆与 MCP

这一页介绍三种"给 [Agent](../reference/glossary.md#智能体--agent) 增能"的机制——[技能](../reference/glossary.md#技能skill)、[记忆](../reference/glossary.md#记忆memory)、[MCP](../reference/glossary.md#mcp)，以及它们对内容创作者到底意味着什么。这些偏进阶，不必一上来就全用上。

## 目录

- [技能 Skills](#技能-skills)
- [记忆 Memory](#记忆-memory)
- [一套配置服务两个 Agent](#一套配置服务两个-agent)
- [MCP：接入外部工具](#mcp接入外部工具)
- [该从哪开始](#该从哪开始)

## 技能 Skills

技能是放在项目 `.claude/skills` 目录下的**可复用能力包**。

- 在输入框里敲 `/`，可以看到当前可用的技能列表。
- 举个例子：做一个"按模板生成任务文案"的技能，之后每次让 Agent 生成文案，它都会按你的规范产出，不用每次重复交代格式。

<!-- 截图：输入 / 弹出技能列表 -->

## 记忆 Memory

记忆让 Agent **跨会话记住**关于你项目的事情，省得每次重新解释。

- 结构：`.claude/memory/MEMORY.md` 是索引，加上若干分篇正文。
- Agent 每轮会自动读索引，按需读取相关分篇。
- 适合记什么：项目设定、术语译法、写作风格等——比如"HP 一律写成生命值"这类约定，写进记忆后 Agent 就会一直遵守。

## 一套配置服务两个 Agent

同一个项目的 `.claude/` 目录（技能与记忆）会**同时服务两个内置 Agent**（Claude Code 与 Codex）。配置一次，两个 Agent 都能用。

## MCP：接入外部工具

MCP（Model Context Protocol）是一套让 Agent 接入外部工具和数据源的协议。

- 命令"打开 MCP 设置"会跳到设置里的 MCP 服务器配置项。
- AGENTS 容器里的"MCP 服务器"视图，可以查看当前会话已连接的服务器；没有时提示"此会话没有配置 MCP 服务器。"

<!-- 截图：MCP 服务器视图 -->

## 该从哪开始

这三样的共同价值是**让 AI 更懂你的项目、少解释、结果更一致**。刚开始不用全上：

- 有反复交代的约定 → 写进记忆。
- 有固定套路的产出 → 做成技能。
- 需要接外部工具/数据 → 再研究 MCP。

**本页涉及的命令：**

| 命令面板名称 | 快捷键 | 作用 |
| --- | --- | --- |
| 打开 MCP 设置 | 无 | 配置 MCP 服务器 |

## 下一步

- [模式与思考等级](./modes-and-thinking.md)

## 相关阅读

- [设置](../customization/settings.md)
- [Agent 概览](./overview.md)
- [术语表](../reference/glossary.md)
