# 编辑器文本编辑快捷键

这里列出**编辑器内核（Monaco）自带**的文本编辑键位。它们不需要装任何扩展，只要焦点在编辑器里就生效——但有一部分被本编辑器的功能占用了，末尾两节专门讲这些情况。

被占用后失去默认键的那几个功能，本编辑器都在别的键上补了一份，表里标着「备选键」；按[平台差异](#平台差异windows--mac--linux)一节确认自己系统上的键。

想找高频项，先看[快捷键速查表](./keyboard-shortcuts.md)；想改键，见[定制 · 键盘快捷方式](../customization/keybindings.md)。

## 目录

- [怎么读这张表](#怎么读这张表)
- [光标与选择](#光标与选择)
- [编辑与行操作](#编辑与行操作)
- [多光标](#多光标)
- [编辑器内查找](#编辑器内查找)
- [代码编辑](#代码编辑)
- [代码折叠](#代码折叠)
- [导航](#导航)
- [平台差异：Windows / Mac / Linux](#平台差异windows--mac--linux)
- [被本编辑器占用的键](#被本编辑器占用的键)

## 怎么读这张表

- 键位按 **Windows** 书写。Mac 上 `Ctrl` → `Cmd`（⌘）、`Alt` → `Option`（⌥），其余按键一致；**Linux 另有几处不同**，见[平台差异](#平台差异windows--mac--linux)。
- 「命令面板名称」是通过 `Ctrl+Shift+P` 搜索时该命令显示的名字。编辑器内核的命令来自 Monaco，显示的是**英文名**（这是有意的，方便与上游对照）。
- 标 **需语言支持** 的条目依赖当前文件的语言能力，换个文件类型可能就没反应——例如行注释需要该语言有注释符号，格式化需要该语言有格式化器。

## 光标与选择

| 操作 | 快捷键 | 命令面板名称 |
| --- | --- | --- |
| 上 / 下 / 左 / 右移动 | `↑` / `↓` / `←` / `→` | Cursor Up / Down / Left / Right |
| 按词左右移动 | `Ctrl+←` / `Ctrl+→` | Cursor Word Left / Right |
| 移到行首 / 行尾 | `Home` / `End` | Cursor Home / End |
| 移到文件开头 / 结尾 | `Ctrl+Home` / `Ctrl+End` | Cursor Top / Bottom |
| 上一页 / 下一页 | `PageUp` / `PageDown` | Cursor Page Up / Down |
| 向上 / 向下滚动一页 | `Shift+Alt+PageUp` / `Shift+Alt+PageDown`（备选键） | Scroll Page Up / Down |
| 扩展选区 | `Shift+↑↓←→`、`Shift+Home` / `End`、`Ctrl+Shift+Home` / `End` | Cursor \* Select |
| 逐行扩大选区 | `Ctrl+L` | Expand Line Selection |
| 按语法扩大 / 缩小选区 | `Shift+Alt+→` / `Shift+Alt+←` | Expand / Shrink Selection |
| 跳到配对括号 | `Ctrl+Shift+\` | Go to Bracket |

## 编辑与行操作

| 操作 | 快捷键 | 命令面板名称 |
| --- | --- | --- |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| 全选 | `Ctrl+A` | Select All |
| 删除当前行 | `Ctrl+Shift+K` | Delete Line |
| 在下方 / 上方插入行 | `Ctrl+Enter` / `Ctrl+Shift+Enter` | Insert Line Below / Above |
| 缩进 / 反缩进 | `Ctrl+]` / `Ctrl+[` | Indent / Outdent Line |
| 切换行注释 | `Ctrl+/`（需语言支持） | Toggle Line Comment |
| 添加 / 移除行注释 | `Ctrl+K Ctrl+C` / `Ctrl+K Ctrl+U`（需语言支持） | Add / Remove Line Comment |
| 切换块注释 | `Shift+Alt+A`（需语言支持；Linux 见下） | Toggle Block Comment |
| 上移 / 下移行 | `Ctrl+Shift+↑` / `Ctrl+Shift+↓`（备选键） | Move Line Up / Down |
| 向上 / 向下复制行 | `Shift+Alt+↑` / `Shift+Alt+↓`（Linux 用 `Ctrl+Shift+Alt+↑` / `↓`，备选键） | Copy Line Up / Down |

> 按词删除用 `Ctrl+Backspace` / `Ctrl+Delete`。上移 / 下移行、复制行的原生键 `Alt+↑` `Alt+↓` 在本编辑器里是别的功能，见[被本编辑器占用的键](#被本编辑器占用的键)。
>
> `Ctrl+Shift+↑` `Ctrl+Shift+↓` 被本编辑器拿去做「上移 / 下移行」后，内核原本挂在这两个键上的**次要**功能（Windows 上是按行扩展选区，Linux 上是「在下方 / 上方加光标」）就用不上了；它们的主键都在，分别是 `Shift+↑` / `Shift+↓` 和 `Shift+Alt+↓` / `Shift+Alt+↑`。

## 多光标

| 操作 | 快捷键 | 命令面板名称 |
| --- | --- | --- |
| 选中下一个相同的词 | `Ctrl+D` | Add Selection To Next Find Match |
| 选中所有相同的词 | `Ctrl+Shift+L` | Select All Occurrences of Find Match |
| 全改（一次改掉所有相同的词） | `Ctrl+F2` | Change All Occurrences |
| 在每个选中行的行尾加光标 | `Shift+Alt+I` | Insert Cursor at End of Each Line Selected |
| 在下方 / 上方加光标 | `Ctrl+Alt+↓` / `Ctrl+Alt+↑`（Linux 不同，见下） | Insert Cursor Below / Above |
| 撤销最后一次光标操作 | `Ctrl+U` | Cursor Undo |
| 退出多光标 | `Esc` | Remove Secondary Cursors |

## 编辑器内查找

这些是**查找框打开后**在编辑器里换个匹配继续跳的键。打开查找框本身见[快捷键速查表 · 搜索与导航](./keyboard-shortcuts.md#搜索与导航)。

| 操作 | 快捷键 | 命令面板名称 |
| --- | --- | --- |
| 下一个 / 上一个匹配 | `F3` / `Shift+F3` | Find Next / Previous |
| 下一个 / 上一个**选中内容**的匹配 | `Ctrl+F3` / `Ctrl+Shift+F3` | Find Next / Previous Selection Match |

> 查找框内的开关（区分大小写、全词、正则等）见[单文件内查找与替换](../search-navigation/find-in-file.md)。

## 代码编辑

| 操作 | 快捷键 | 命令面板名称 |
| --- | --- | --- |
| 转到行 / 列 | `Ctrl+G` | Go to Line/Column... |
| 转到文件中的符号 | `Ctrl+Shift+O`（需语言支持） | Go to Symbol in Editor... |
| 触发建议（补全） | `Ctrl+Space` | Trigger Suggest |
| 触发参数提示 | `Ctrl+Shift+Space`（需语言支持） | Trigger Parameter Hints |
| 快速修复 | `Ctrl+.`（需语言支持） | Quick Fix... |
| 重命名符号 | `F2`（需语言支持） | Rename Symbol |
| 格式化文档 | `Shift+Alt+F`（需语言支持；Linux 见下） | Format Document |
| 格式化选区 | `Ctrl+K Ctrl+F`（需语言支持） | Format Selection |

## 代码折叠

| 操作 | 快捷键 | 命令面板名称 |
| --- | --- | --- |
| 折叠 / 展开 | `Ctrl+Shift+[` / `Ctrl+Shift+]` | Fold / Unfold |
| 切换折叠（在光标所在处折叠与展开之间切换） | `Ctrl+Shift+Alt+F`（备选键） | Toggle Fold |
| 折叠全部 / 展开全部 | `Ctrl+K Ctrl+0` / `Ctrl+K Ctrl+J` | Fold All / Unfold All |
| 递归折叠 / 展开 | `Ctrl+K Ctrl+[` / `Ctrl+K Ctrl+]` | Fold / Unfold Recursively |
| 折叠所有块注释 | `Ctrl+K Ctrl+/` | Fold All Block Comments |

> 切换折叠的原生键 `Ctrl+K Ctrl+L` 被本编辑器占用了，所以补了 `Ctrl+Shift+Alt+F`，见下节。
>
> 在 Markdown 文件里 `Ctrl+Shift+[` / `Ctrl+Shift+]` 是**升级 / 降级标题**（Markdown 扩展的功能），折叠请用 `Ctrl+K Ctrl+[` / `Ctrl+K Ctrl+]`。

## 导航

| 操作 | 快捷键 | 命令面板名称 |
| --- | --- | --- |
| 下一个 / 上一个问题 | `F8` / `Shift+F8` | Go to Next / Previous Problem |
| 下一个 / 上一个错误或警告 | `Alt+F8` / `Shift+Alt+F8` | Go to Next / Previous Error or Warning |
| 下一个 / 上一个符号高亮 | `F7` / `Shift+F7` | Go to Next / Previous Symbol Highlight |

## 平台差异：Windows / Mac / Linux

Mac 只做 `Ctrl` → `Cmd`、`Alt` → `Option` 的换算。**Linux 不同**，因为编辑器内核按平台注册键位。本编辑器会按当前平台读取内核键位，所以下面这几项在 Linux 上以「Linux」列为准：

| 操作 | Windows / Mac | Linux |
| --- | --- | --- |
| 向上 / 向下复制行 | `Shift+Alt+↑` / `Shift+Alt+↓` | `Ctrl+Shift+Alt+↑` / `↓`（备选键，原生键 `Ctrl+Alt+Shift+↑` / `↓` 被「调整视图高度」占用） |
| 在下方 / 上方加光标 | `Ctrl+Alt+↓` / `Ctrl+Alt+↑` | `Shift+Alt+↓` / `Shift+Alt+↑` |
| 切换块注释 | `Shift+Alt+A` | `Ctrl+Shift+A` |
| 格式化文档 | `Shift+Alt+F` | `Shift+Alt+F`（备选键，原生键 `Ctrl+Shift+I` 被「开发者工具」占用） |

其余键位两平台一致；`Ctrl+Shift+↑` / `Ctrl+Shift+↓`（上移 / 下移行）和 `Ctrl+Shift+Alt+F`（切换折叠）、`Shift+Alt+PageUp` / `PageDown`（滚动一页）都是本编辑器三平台一致的备选键。

> **为什么**：编辑器内核的默认键在 Windows 与 Linux 上并不完全一致。本编辑器按当前平台镜像这套键位，所以「键盘快捷方式」页面（`Ctrl+K Ctrl+S`）里显示的与这里一致。想固定下来，按[定制 · 键盘快捷方式](../customization/keybindings.md)自己绑一个。

## 被本编辑器占用的键

下面这些键在编辑器内核里本来另有含义，但本编辑器把它们给了更常用的功能。表格里写的是**在本编辑器里按下去实际会发生什么**；最后一列里已经补了备选键的，可以按备选键把内核功能用回来：

| 键 | 实际作用 | 内核里本来的含义 | 内核功能的备选键 |
| --- | --- | --- | --- |
| `Alt+↑` / `Alt+↓` | 查找光标处单词的上一处 / 下一处 | 上移 / 下移行 | `Ctrl+Shift+↑` / `Ctrl+Shift+↓` |
| `Ctrl+K Ctrl+L` | 把选区添加到已有 Agent 聊天 | 切换折叠 | `Ctrl+Shift+Alt+F` |
| `Alt+PageUp` / `Alt+PageDown` | 文件有未提交改动时：上一处 / 下一处更改；没有改动时是滚动一页 | 滚动一页 | `Shift+Alt+PageUp` / `Shift+Alt+PageDown` |
| `Ctrl+Shift+↑` / `Ctrl+Shift+↓` | 上移 / 下移行（本编辑器补的备选键占用了内核的次要键位） | 按行扩展选区（Windows）、在下方 / 上方加光标（Linux）——两者都还有主键 | — |
| `Ctrl+0` … `Ctrl+9` | 跳转到编号书签 | — | — |
| `Ctrl+Shift+I` | 打开开发者工具（Linux 上这会挡住「格式化文档」） | — | Linux 上用 `Shift+Alt+F` 格式化 |
| `Ctrl+Alt+Shift+↑` / `↓` | 调整聚焦视图的高度 | 列选择 / （Linux）复制行 | 复制行见上表；列选择在 Linux 上内核自己就停用了 |
| `F1` | 命令面板（与 `Ctrl+Shift+P` 相同） | 编辑器内快速命令 | — |
| `Ctrl+F` / `Ctrl+H` | 编辑器内查找 / 替换（同一个功能） | 编辑器内查找 / 替换 | — |

> 表里没有备选键的，可以自己重新绑定，见[定制 · 键盘快捷方式](../customization/keybindings.md)。

## 下一步

- [快捷键速查表](./keyboard-shortcuts.md)
- [命令速查表](./command-reference.md)

## 相关阅读

- [定制 · 键盘快捷方式](../customization/keybindings.md)（自定义、导入 VSCode 绑定）
- [单文件内查找与替换](../search-navigation/find-in-file.md)
- [符号与定义跳转](../search-navigation/symbols-and-definitions.md)
- [Markdown 编辑与预览](../editing/markdown.md)
