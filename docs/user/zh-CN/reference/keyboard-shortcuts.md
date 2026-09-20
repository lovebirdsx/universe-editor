# 快捷键速查表

这里按功能域汇总 Universe Editor 里最常用的快捷键。它只收高频核心项，不追求穷举——想找某个不常用的命令，随时按 `Ctrl+Shift+P` 打开[命令面板](./glossary.md#命令面板)搜。

## 目录

- [Windows / Mac 差异](#windows--mac-差异)
- [通用](#通用)
- [菜单内键盘操作](#菜单内键盘操作)
- [布局](#布局)
- [编辑器：标签与分屏](#编辑器标签与分屏)
- [编辑器：文本编辑](#编辑器文本编辑)
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
| 全部保存（Save All） | `Ctrl+Alt+S` |
| 打开设置 | `Ctrl+,` |
| 放大 / 缩小 / 重置缩放 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
| 新建窗口 | `Ctrl+Shift+N` |
| 关闭窗口 | `Ctrl+Shift+W` |
| 循环聚焦下一个 / 上一个区域 | `F6` / `Shift+F6` |

> 更多见 [快速上手 · 命令面板](../getting-started/command-palette.md) 与 [定制 · 设置](../customization/settings.md)。

## 菜单内键盘操作

用右键菜单键 / `Shift+F10` 弹出菜单后，键盘就归菜单所有，全程不用碰鼠标：

| 操作 | 快捷键 |
| --- | --- |
| 上移 / 下移高亮项 | `↑` / `↓`（或 `Ctrl+P` / `Ctrl+N`） |
| 展开 / 收起子菜单 | `→` / `←`（或 `Ctrl+L` / `Ctrl+H`） |
| 跳到第一项 / 最后一项 | `Home` / `End` |
| 执行高亮项 | `Enter` |
| 关闭菜单（有子菜单时先收一层） | `Esc` |

键盘打开菜单时，高亮会停在上次执行过的那一项，重复操作直接回车即可。

四个 `Ctrl` 别名与对应方向键作用相同，**只在菜单打开期间生效**。菜单没开时它们仍是原来的功能：`Ctrl+P` 转到文件、`Ctrl+N` 新建文件、`Ctrl+H` 替换，`Ctrl+L` 在编辑器里展开行选择。带 `Shift` / `Alt` 的组合不受影响（`Ctrl+Shift+P` 命令面板、`Ctrl+Shift+N` 新窗口照旧）。

> 唯一的差别：菜单里没有可展开 / 收起的东西时，方向键会「穿透」给下面的视图（比如资源管理器里按 `→` 顺带展开了文件夹），而 `Ctrl` 别名不会。
>
> Mac 上这四个别名仍按实体 `Ctrl` 按（emacs 传统键位），不随上文的 `Ctrl` → `Cmd` 换算。

## 布局

| 操作 | 快捷键 |
| --- | --- |
| 切换主侧边栏 | `Ctrl+B` |
| 切换辅助侧边栏 | `Ctrl+Alt+B` |
| 切换底栏 | `Ctrl+J` |
| 显示资源管理器 | `Ctrl+Shift+E` |
| 显示源代码管理 | `Ctrl+Shift+G` |
| 显示扩展 | `Ctrl+Shift+X` |
| 在编辑器中打开终端 | `` Ctrl+` `` |
| 聚焦终端 | `` Alt+` `` |
| 新建终端 | `` Ctrl+Shift+` `` |
| 打开原生控制台 | `Ctrl+Shift+C` |
| 聚焦大纲视图 | `Ctrl+Shift+Q` |
| 最大化 / 还原底栏 | `Alt+M` |
| 调整聚焦视图的大小 | `Ctrl+Alt+Shift+←` / `→` / `↑` / `↓` |

> 更多见 [快速上手 · 界面导览](../getting-started/interface-tour.md)。

## 编辑器：标签与分屏

| 操作 | 快捷键 |
| --- | --- |
| 关闭编辑器 | `Ctrl+W` |
| 关闭其他编辑器 | `Alt+W` |
| 重新打开已关闭的编辑器 | `Ctrl+Shift+T` |
| 打开下一个 / 上一个编辑器 | `Ctrl+PageDown` / `Ctrl+PageUp` |
| 把编辑器移到左 / 右一组 | `Ctrl+Shift+PageUp` / `Ctrl+Shift+PageDown` |
| 上一处 / 下一处更改（文件有改动时） | `Alt+PageUp` / `Alt+PageDown` |
| 最近使用的编辑器和视图（MRU） | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| 向右拆分编辑器 | `Ctrl+\` |
| 切换自动换行 | `Alt+Z` |
| 更改语言模式（当前文件的语法高亮语言） | `Ctrl+K M` |
| 后退 / 前进（导航历史） | `Alt+←` / `Alt+→` |

> 更多见 [编辑与文件 · 标签页与分屏](../editing/tabs-and-split.md) 与 [搜索与导航 · 导航历史](../search-navigation/history.md)。

## 编辑器：文本编辑

以下按键由**编辑器内核（Monaco）自带**，编辑器文本获得焦点时即生效。

| 操作 | 快捷键 |
| --- | --- |
| 切换行注释（`//`） | `Ctrl+/` |
| 删除当前行 | `Ctrl+Shift+K` |
| 在下方 / 上方插入行 | `Ctrl+Enter` / `Ctrl+Shift+Enter` |
| 缩进 / 反缩进 | `Ctrl+]` / `Ctrl+[` |
| 向上 / 向下复制行 | `Shift+Alt+↑` / `Shift+Alt+↓` |
| 选中下一个相同的词（多光标） | `Ctrl+D` |
| 选中所有相同的词 | `Ctrl+Shift+L` |
| 折叠 / 展开 | `Ctrl+Shift+[` / `Ctrl+Shift+]` |
| 格式化文档 | `Shift+Alt+F` |
| 转到文件中的符号 | `Ctrl+Shift+O` |
| 转到行 | `Ctrl+G` |

> `Ctrl+/`、`Shift+Alt+F`、`Ctrl+Shift+O` 需要当前语言支持注释 / 格式化 / 符号。
> `Shift+Alt+↑` `Shift+Alt+↓` `Shift+Alt+F` 在 Linux 上是别的键（其中两项在 Linux 没有可用默认键）。
> 有几种键被本编辑器占用了，最常见的两个：`Alt+↑` `Alt+↓` 是「查找光标处单词」，`Ctrl+K Ctrl+L` 是「把选区加到 Agent 聊天」。

> 更多见 [编辑器文本编辑快捷键](./editor-shortcuts.md)（含多光标、折叠、导航与完整平台差异）。

## 搜索与导航

| 操作 | 快捷键 |
| --- | --- |
| 编辑器内查找（含输出面板日志区） | `Ctrl+F` |
| 编辑器内替换（输出面板只读，无反应） | `Ctrl+H` |
| 查找下一个 / 上一个 | `F3` / `Shift+F3` |
| 全局搜索（在文件中查找） | `Ctrl+Shift+F` |
| 在文件夹中查找（资源管理器聚焦、选中文件夹时） | `Shift+Alt+F` |
| 快速搜索 | `Ctrl+Q` |
| 转到编辑器中的符号… | `Ctrl+Shift+O` |
| 转到工作区中的符号… | `Ctrl+T` |
| 转到定义 | `F12` |
| 速览定义 | `Alt+F12` |
| 转到引用 | `Shift+F12` |

> 查找类快捷键作用于**当前聚焦的编辑器**（文件编辑器或输出面板日志区），见 [单文件内查找与替换](../search-navigation/find-in-file.md)。
>
> 符号与定义类快捷键来自**编辑器内核**，需要当前语言提供符号；命令面板里显示英文名。见 [编辑器文本编辑快捷键](./editor-shortcuts.md)。

> 更多见 [搜索与导航 · 全局搜索与替换](../search-navigation/global-search.md) 与 [符号与定义跳转](../search-navigation/symbols-and-definitions.md)。

## AI Agent

| 操作 | 快捷键 |
| --- | --- |
| 新建 Agent 会话 | `Ctrl+Alt+N` |
| 聚焦 Agent 输入框 | `Ctrl+Alt+I` |
| 取消 Agent 回合 | `Ctrl+Shift+Escape`；会话聚焦时也可按 `Shift+Esc` |
| 将选区添加到已有 Agent 聊天 | `Ctrl+K Ctrl+L` |
| 恢复 Agent 会话… | `Ctrl+Shift+H` |
| 切换会话…（跨窗口） | `Alt+S`；`Alt+Shift+S` 反向 |
| 聚焦第 1~8 个会话配置项 | `Alt+1` ~ `Alt+8`（会话编辑器聚焦时） |
| 触发内联补全 | `Alt+\`（编辑器文本焦点） |
| 采纳内联补全 | `Tab`（幽灵文本可见时） |

> 会话内的字体缩放、时间线导航、查找等按键**仅在聊天获得焦点时**生效；配置栏的 `Alt+1` ~ `Alt+8` 不同，它要求**会话编辑器（编辑区）获得焦点**。详见 [AI Agent · 管理会话](../ai-agent/managing-sessions.md)。
>
> 配置栏浮层打开期间，四个 `Ctrl` 别名（`Ctrl+P` `Ctrl+N` `Ctrl+H` `Ctrl+L`）与 `↑` `↓` `←` `→` 作用相同——规则与上面的[菜单内键盘操作](#菜单内键盘操作)一致，浮层关掉即恢复原义。

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
