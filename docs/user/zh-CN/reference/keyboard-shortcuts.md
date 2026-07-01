# 快捷键速查表

这里按功能域汇总 Universe Editor 里最常用的快捷键。它只收高频核心项，不追求穷举——想找某个不常用的命令，随时按 `Ctrl+Shift+P` 打开[命令面板](./glossary.md#命令面板)搜。

## 目录

- [Windows / Mac 差异](#windows--mac-差异)
- [通用](#通用)
- [布局](#布局)
- [编辑器：标签与分屏](#编辑器标签与分屏)
- [搜索与导航](#搜索与导航)
- [AI Agent](#ai-agent)
- [Git 版本控制](#git-版本控制)
- [Markdown](#markdown)
- [编号书签](#编号书签)

## Windows / Mac 差异

本表以 Windows 键位书写。如果你用 Mac，按下面两条对应换算即可：

- `Ctrl` → `Cmd`（⌘）
- `Alt` → `Option`（⌥）

其余按键（`Shift`、`Enter`、`Tab`、`F1`–`F12`、方向键等）两平台一致。

> 弦和键（Chord）说明：像 `Ctrl+K Ctrl+O` 这种由空格分成两段的快捷键，要**先按第一组、松开、再按第二组**，不是同时按下。

## 通用

| 操作 | 快捷键 |
| --- | --- |
| 显示所有命令（命令面板） | `Ctrl+Shift+P` / `F1` |
| 转到文件…（快速打开） | `Ctrl+P` |
| 打开文件… | `Ctrl+O` |
| 打开文件夹… | `Ctrl+K Ctrl+O` |
| 打开最近打开的项… | `Ctrl+R` |
| 保存 | `Ctrl+S` |
| 另存为… | `Ctrl+Shift+S` |
| 保存全部（Save All） | `Ctrl+Alt+S` |
| 打开设置 | `Ctrl+,` |

> 更多见 [快速上手 · 命令面板](../getting-started/command-palette.md) 与 [定制 · 设置](../customization/settings.md)。

## 布局

| 操作 | 快捷键 |
| --- | --- |
| 切换主侧边栏 | `Ctrl+B` |
| 切换辅助侧边栏 | `Ctrl+Alt+B` |
| 切换面板 | `Ctrl+J` |
| 在编辑器中打开终端 | `` Ctrl+` `` |
| 聚焦大纲视图 | `Ctrl+Shift+Q` |

> 更多见 [快速上手 · 界面导览](../getting-started/interface-tour.md)。

## 编辑器：标签与分屏

| 操作 | 快捷键 |
| --- | --- |
| 关闭编辑器 | `Ctrl+W` |
| 关闭其他编辑器 | `Alt+W` |
| 重新打开已关闭的编辑器 | `Ctrl+Shift+T` |
| 打开下一个 / 上一个编辑器 | `Ctrl+PageDown` / `Ctrl+PageUp` |
| 最近使用的编辑器（MRU） | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 向右拆分编辑器 | `Ctrl+\` |
| 切换自动换行 | `Alt+Z` |
| 后退 / 前进（导航历史） | `Alt+←` / `Alt+→` |

> 更多见 [编辑与文件 · 标签页与分屏](../editing/tabs-and-split.md) 与 [搜索与导航 · 导航历史](../search-navigation/history.md)。

## 搜索与导航

| 操作 | 快捷键 |
| --- | --- |
| 文件内查找 | `Ctrl+F` |
| 文件内替换 | `Ctrl+H` |
| 查找下一个 / 上一个 | `F3` / `Shift+F3` |
| 全局搜索（在文件中查找） | `Ctrl+Shift+F` |
| 快速搜索 | `Ctrl+Q` |
| 转到编辑器中的符号… | `Ctrl+Shift+O` |
| 转到工作区中的符号… | `Ctrl+T` |
| 转到定义 | `F12` |
| 速览定义 | `Alt+F12` |
| 转到引用 | `Shift+F12` |

> 更多见 [搜索与导航 · 全局搜索与替换](../search-navigation/global-search.md) 与 [符号与定义跳转](../search-navigation/symbols-and-definitions.md)。

## AI Agent

| 操作 | 快捷键 |
| --- | --- |
| 新建 Agent 会话 | `Ctrl+Alt+N` |
| 聚焦 Agent 输入框 | `Ctrl+Alt+I` |
| 取消 Agent 回合 | `Ctrl+Shift+Escape` |
| 将选区添加到 Agent 聊天 | `Ctrl+K Ctrl+L` |
| 恢复 Agent 会话… | `Ctrl+Shift+H` |
| 切换会话…（跨窗口） | `Alt+S` |
| 触发内联补全 | `Alt+\`（编辑器文本焦点） |
| 采纳内联补全 | `Tab`（幽灵文本可见时） |

> 会话内的字体缩放、时间线导航、查找等按键**仅在聊天获得焦点时**生效，详见 [AI Agent · 管理会话](../ai-agent/managing-sessions.md)。

## Git 版本控制

| 操作 | 快捷键 |
| --- | --- |
| 刷新（源代码管理） | `Ctrl+Alt+G` |
| 打开更改（当前文件的 diff） | `Shift+Alt+Y` |
| 提交（在提交信息输入框内） | `Ctrl+Enter` |
| 转到下一处合并冲突 | `Alt+F9` |
| 转到上一处合并冲突 | `Shift+Alt+F9` |

> 更多见 [版本控制是什么，为什么需要它](../git/overview.md) 与 [提交你的改动](../git/commit.md)。

## Markdown

以下快捷键需在 Markdown 文件里、且**编辑器文本获得焦点**时生效（预览类除外）。

| 操作 | 快捷键 |
| --- | --- |
| 打开预览 | `Ctrl+Shift+V` |
| 在侧边打开预览 | `Ctrl+K Ctrl+V` |
| 加粗 | `Ctrl+B` |
| 斜体 | `Ctrl+I` |
| 行内代码 | `Ctrl+M` |
| 数学公式 | `Ctrl+Shift+M` |
| 升级 / 降级标题 | `Ctrl+Shift+]` / `Ctrl+Shift+[` |
| 切换任务勾选 | `Alt+C` |
| 格式化表格 | `Ctrl+Alt+T` |
| 预览内链接导航 | `F`（预览焦点） |

> 更多见 [Markdown 编辑与预览](../editing/markdown.md)。部分格式命令在命令面板里显示英文名，见 [命令速查表 · Markdown](./command-reference.md#markdown)。

## 编号书签

| 操作 | 快捷键 |
| --- | --- |
| 切换书签 0–9（在当前行打上 / 清除） | `Ctrl+Shift+0` … `Ctrl+Shift+9` |
| 跳转到书签 0–9 | `Ctrl+0` … `Ctrl+9` |

> 跳转快捷键只在编辑器文本获得焦点时生效。更多见 [编号书签](../editing/bookmarks.md)。

## 下一步

- [命令速查表](./command-reference.md)

## 相关阅读

- [常见问题](./faq.md)
- [术语表](./glossary.md)
- [定制 · 键盘快捷方式](../customization/keybindings.md)（自定义与导入 VSCode 绑定）
