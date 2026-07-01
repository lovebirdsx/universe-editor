# 命令速查表

这里按功能域列出最常用的命令：命令面板里的名称、作用、以及快捷键（如果有）。它只收高频核心，不穷举全部命令。

> **一条心智**：记不住某个功能在哪、叫什么，就按 `Ctrl+Shift+P` 打开[命令面板](./glossary.md#命令面板)输入关键词搜。这比背命令名管用得多。

## 目录

- [关于"中 / 英"标注](#关于中--英标注)
- [文件与项目](#文件与项目)
- [布局与视图](#布局与视图)
- [搜索与导航](#搜索与导航)
- [AI Agent](#ai-agent)
- [Git 版本控制](#git-版本控制)
- [Markdown](#markdown)
- [定制](#定制)
- [帮助与诊断](#帮助与诊断)

## 关于"中 / 英"标注

大部分命令在命令面板里显示中文。但有少数命令目前仍显示**英文原名**——如果你用中文关键词搜不到，多半就是这类。下表凡是当前显示英文的，都在名称后用"（英文）"标注，并给出中文释义，搜索时请用英文词。

## 文件与项目

| 命令面板名称 | 作用 | 快捷键 |
| --- | --- | --- |
| 打开文件夹… | 把文件夹作为项目打开 | `Ctrl+K Ctrl+O` |
| 打开文件… | 用系统对话框打开任意文件 | `Ctrl+O` |
| 打开最近打开的项… | 回到近期用过的项目 | `Ctrl+R` |
| 转到文件…（快速打开） | 按文件名快速打开文件 | `Ctrl+P` |
| 新建文件 | 新建无标题文件 | `Ctrl+N` |
| 保存 | 保存当前文件 | `Ctrl+S` |
| 另存为… | 另存到新位置或新文件名 | `Ctrl+Shift+S` |
| 保存全部（Save All，英文） | 一次保存所有未保存的文件；命令面板当前显示英文 "Save All" | `Ctrl+Alt+S` |

> 更多见 [资源管理器与文件操作](../editing/explorer-and-files.md) 与 [快速打开与命令面板](../search-navigation/quick-open.md)。

## 布局与视图

| 命令面板名称 | 作用 | 快捷键 |
| --- | --- | --- |
| 切换主侧边栏 | 显隐左侧文件树所在的侧栏 | `Ctrl+B` |
| 切换辅助侧边栏 | 显隐右侧 Agents / 大纲所在的侧栏 | `Ctrl+Alt+B` |
| 切换面板 | 显隐底部输出 / 终端面板 | `Ctrl+J` |
| 向右拆分编辑器 | 把编辑区分成左右两栏 | `Ctrl+\` |
| 聚焦大纲视图 | 打开并聚焦大纲 | `Ctrl+Shift+Q` |
| 切换自动换行 | 长行折行显示 | `Alt+Z` |

> 更多见 [界面导览](../getting-started/interface-tour.md) 与 [标签页与分屏](../editing/tabs-and-split.md)。

## 搜索与导航

| 命令面板名称 | 作用 | 快捷键 |
| --- | --- | --- |
| 在文件中查找 | 全局搜索，可跨文件替换 | `Ctrl+Shift+F` |
| 快速搜索 | 浮动方式即时搜索并跳转 | `Ctrl+Q` |
| 查找 | 在当前文件里查找 | `Ctrl+F` |
| 替换 | 在当前文件里查找并替换 | `Ctrl+H` |
| 转到编辑器中的符号… | 跳到当前文件里的符号 | `Ctrl+Shift+O` |
| 转到工作区中的符号… | 跨文件按符号名搜索 | `Ctrl+T` |
| 转到定义 | 跳到符号定义处 | `F12` |
| 后退 / 前进 | 沿导航轨迹前后穿梭 | `Alt+←` / `Alt+→` |

> 更多见 [全局搜索与替换](../search-navigation/global-search.md)、[符号与定义跳转](../search-navigation/symbols-and-definitions.md)、[导航历史](../search-navigation/history.md)。

## AI Agent

| 命令面板名称 | 作用 | 快捷键 |
| --- | --- | --- |
| 新建 Agent 会话 | 开始一段新对话 | `Ctrl+Alt+N` |
| 选择 Agent 并新建会话… | 换 Agent（会顺带新建会话） | 无 |
| 聚焦 Agent 输入框 | 跳到输入框 | `Ctrl+Alt+I` |
| 取消 Agent 回合 | 中止当前回合 | `Ctrl+Shift+Escape` |
| 将选区添加到 Agent 聊天 | 把选中文本作为上下文 | `Ctrl+K Ctrl+L` |
| 恢复 Agent 会话… | 打开历史会话 | `Ctrl+Shift+H` |
| 切换会话… | 跨窗口切换会话 | `Alt+S` |
| 选择 Agent 模型… | 切换当前会话的模型 | 无 |
| 选择 Agent 模式… | 切换 Agent 行为模式 | 无 |
| 选择 Agent 思考级别… | 调节推理深度 | 无 |
| 显示会话更改 | 打开会话更改视图 | 无 |
| 触发内联补全 | 主动求一条补全建议 | `Alt+\` |
| 选择内联补全模型 | 为补全单独指定模型 | 无 |

> 更多见 [Agent 概览](../ai-agent/overview.md)、[你的第一次 Agent 会话](../ai-agent/first-session.md)、[模型选择与花费](../ai-agent/models-and-cost.md)。

## Git 版本控制

| 命令面板名称 | 作用 | 快捷键 |
| --- | --- | --- |
| 提交 | 把暂存的改动记成一次提交 | 输入框内 `Ctrl+Enter` |
| 暂存更改 / 取消暂存更改 | 把文件加入 / 移出下次提交 | 无 |
| 放弃更改 | 丢弃某文件的改动（不可撤销） | 无 |
| 打开更改 | 打开当前文件的 diff | `Shift+Alt+Y` |
| 拉取 / 推送 / 同步 | 与远程仓库同步 | 无 |
| Generate Commit Message（英文） | 生成提交信息；命令面板显示英文，中文释义"生成提交信息" | 无 |
| View Git Graph（英文） | 查看 Git 图谱；命令面板显示英文，中文释义"查看 Git 图谱" | 无 |
| Focus Search（英文） | 聚焦 Git 图谱搜索框；仅图谱激活时生效，中文释义"聚焦搜索" | 图谱内 `Ctrl+F` |
| Toggle Remote Branches（英文） | 在图谱里开关远程分支显示；中文释义"切换远程分支" | 无 |
| 刷新 | 刷新源代码管理状态 | `Ctrl+Alt+G` |

> Git 图谱相关的 View Git Graph / Focus Search / Toggle Remote Branches 以及 AI 的 Generate Commit Message 目前均只显示英文，用英文关键词搜索。更多见 [提交你的改动](../git/commit.md) 与 [提交历史图（Git 图谱）](../git/git-graph.md)。

## Markdown

Markdown 的格式命令与预览链接导航命令，目前有相当一部分只显示**英文原名**。下表给出中文释义供对照。

| 命令面板名称 | 作用 | 快捷键 |
| --- | --- | --- |
| 打开预览 | 替换当前标签为预览 | `Ctrl+Shift+V` |
| 在侧边打开预览 | 保留源码，侧边显示预览 | `Ctrl+K Ctrl+V` |
| 加粗 / 斜体 / 行内代码 | 套用对应格式 | `Ctrl+B` / `Ctrl+I` / `Ctrl+M` |
| 数学公式 | 插入数学公式 | `Ctrl+Shift+M` |
| Toggle Strikethrough（英文） | 切换删除线 | 无 |
| Increase / Decrease Heading Level（英文） | 升 / 降标题级别 | `Ctrl+Shift+]` / `Ctrl+Shift+[` |
| Toggle Task Completion（英文） | 切换任务勾选 | `Alt+C` |
| Format Table（英文） | 格式化对齐表格 | `Ctrl+Alt+T` |
| Organize Link Definitions（英文） | 整理链接定义 | 无 |
| Show Link Hints（英文） | 预览内键盘跳转链接 | `F`（预览焦点） |

> 上表标"（英文）"的命令面板显示英文原名，搜索用英文词。更多见 [Markdown 编辑与预览](../editing/markdown.md)。

## 定制

| 命令面板名称 | 作用 | 快捷键 |
| --- | --- | --- |
| 打开设置 | 打开图形化设置编辑器 | `Ctrl+,` |
| 打开设置 (JSON) | 直接编辑 settings.json | 无 |
| 打开键盘快捷方式 | 打开快捷键编辑器 | `Ctrl+K Ctrl+S` |
| 颜色主题 | 切换深色 / 浅色主题 | 无 |
| 配置显示语言 | 切换中文 / 英文界面（重启生效） | 无 |
| 打开 AI 与 Agent 设置 | 配置供应商、模型、密钥 | 无 |

> 更多见 [定制 · 设置](../customization/settings.md)、[键盘快捷方式](../customization/keybindings.md)、[主题与语言](../customization/themes-and-language.md)、[AI 供应商配置](../customization/ai-providers.md)。

## 帮助与诊断

| 命令面板名称 | 作用 | 快捷键 |
| --- | --- | --- |
| 检查更新 | 手动检查有无新版本 | 无 |
| 开发人员：显示日志... | 挑一个日志文件在输出面板查看 | `Ctrl+Shift+U` |
| 开发人员：打开日志文件夹 | 在系统文件管理器里打开日志目录 | 无 |

> 反馈问题时附上日志会更容易定位，取日志的步骤见 [排障指南 · 日志在哪、怎么取](./troubleshooting.md#日志在哪怎么取)。

## 下一步

- [快捷键速查表](./keyboard-shortcuts.md)

## 相关阅读

- [常见问题](./faq.md)
- [排障指南](./troubleshooting.md)
- [术语表](./glossary.md)
