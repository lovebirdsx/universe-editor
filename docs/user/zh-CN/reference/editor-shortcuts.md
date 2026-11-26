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
- [全局 Vim 模式（可选，默认关闭）](#全局-vim-模式可选默认关闭)
- [平台差异：Windows / Mac / Linux](#平台差异windows--mac--linux)
- [被本编辑器占用的键](#被本编辑器占用的键)

## 怎么读这张表

- 键位按 **Windows** 书写。Mac 上 `Ctrl` → `Cmd`（⌘）、`Alt` → `Option`（⌥），其余按键一致；**Linux 另有几处不同**，见[平台差异](#平台差异windows--mac--linux)。
- 「命令面板名称」一列写的是命令在命令面板里的名字。编辑器内核的命令来自 Monaco，本表按内核的**英文原名**书写（方便与上游对照）；界面语言为简体中文时，面板里显示的是内核自带的中文名——例如 `Sort Lines Ascending` 显示为「按升序排列行」。
- 标 **需语言支持** 的条目依赖当前文件的语言能力，换个文件类型可能就没反应——例如行注释需要该语言有注释符号，格式化需要该语言有格式化器。
- 标 **本编辑器新增** 的条目是另一种情况：内核**从来没有**给这个功能配过键，这个键是本编辑器加的，不存在「原生键被占用」。

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
| 排序选中行 | `F9` / `Shift+F9`（本编辑器新增） | Sort Lines Ascending / Descending |

> 按词删除用 `Ctrl+Backspace` / `Ctrl+Delete`。上移 / 下移行、复制行的原生键 `Alt+↑` `Alt+↓` 在本编辑器里是别的功能，见[被本编辑器占用的键](#被本编辑器占用的键)。
>
> `Ctrl+Shift+↑` `Ctrl+Shift+↓` 被本编辑器拿去做「上移 / 下移行」后，内核原本挂在这两个键上的**次要**功能（Windows 上是按行扩展选区，Linux 上是「在下方 / 上方加光标」）就用不上了；它们的主键都在，分别是 `Shift+↑` / `Shift+↓` 和 `Shift+Alt+↓` / `Shift+Alt+↑`。
>
> `F9` / `Shift+F9` 是**本编辑器新增**的默认键，不是上面那种「备选键」——内核给这两个排序命令本来就没配键。排序**按整行进行**：选中的是哪些行，就排哪些行，只选中一行里的一段则不会有反应；**光标只有一个且没有选中内容时，按 `F9` 会把整个文件排序**（多光标下没有选区则不会有反应）。右键菜单里的「排序选中行」两项只在**有选区且文件可写**时出现。

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
>
> Vim 模式下改用 `z` 系列折叠键（`zc` / `zo` / `za` / `zM` / `zR` / `[z` / `]z` 等），见[全局 Vim 模式](#全局-vim-模式可选默认关闭)。

## 导航

| 操作 | 快捷键 | 命令面板名称 |
| --- | --- | --- |
| 下一个 / 上一个问题 | `F8` / `Shift+F8` | Go to Next / Previous Problem |
| 下一个 / 上一个错误或警告 | `Alt+F8` / `Shift+Alt+F8` | Go to Next / Previous Error or Warning |
| 下一个 / 上一个符号高亮 | `F7` / `Shift+F7` | Go to Next / Previous Symbol Highlight |

## 全局 Vim 模式（可选，默认关闭）

开启后，Vim 键位覆盖**整个工作台**：编辑器文本与 Chat 输入框、列表 / 树、菜单 / 浮层、标签栏、ActivityBar、设置页、通知中心、Chat 时间线、Markdown 预览与文档中心，以及终端的 Normal Mode。它不依赖扩展，也不修改 Monaco 的原生键位；关闭时本文其余键位表保持原样。

### Vim 快速上手

**怎么开**：命令面板执行「切换 Vim 模式」，或设置里把 `vim.enabled` 设为 `true`，或点状态栏右侧的模式文字（该命令归在「Vim」分类下，命令面板输入 `Vim` 即可找到）。开启后状态栏会显示 `NORMAL` / `INSERT` 等当前模式；再执行一次即关闭，所有键位立即恢复。

**先学这几个键**（焦点在编辑器文本里）：

| 想做什么 | 按键 |
| --- | --- |
| 移动 | `h` `j` `k` `l`，`w` / `b` 按词，`gg` / `G` 文件首 / 末 |
| 开始输入 | `i`（光标处）、`a`（光标后）、`o`（下方新开一行）；输入完按 `Esc` 回 Normal |
| 删除 / 复制 / 粘贴 | `x` 删一个字符、`dd` 删一行、`yy` 复制一行、`p` 粘贴 |
| 撤销 / 重做 | `u` / `Ctrl+R` |
| 搜索 | `/foo` 回车，`n` / `N` 跳下一个 / 上一个 |
| 选择 | `v`（按字符）、`V`（按行）、`Ctrl+V`（块），移动后 `d` / `y` / `c` |
| 重复上一次修改 | `.` |
| 不知道键是什么 | 按 `Space ?` 打开键位速查表，可输入文字过滤 |

操作符可以和移动、文本对象、数字组合：`d2w`（删两个词）、`ciw`（改当前词）、`ci"`（改引号内文字）、`3dd`、`2d3w`（等于 `d6w`）。

**在资源管理器、搜索结果、菜单、标签栏等界面里**，同样用 `j` / `k` 移动、`gg` / `G` 跳首末、`Enter` 激活；按 `Space` 再按字母是 leader 序列（如 `Space e` 聚焦资源管理器、`Space f` 快速打开）。无论焦点在编辑器文本还是这些界面，输入多键前缀后停顿约 0.3 秒都会弹出 which-key 提示，列出可用的下一个键。

**常见问题**：

- **按键没反应或在输入框里打不出 Vim 命令**：普通输入框（搜索框、行内输入框等）、Quick Input、模态对话框、HTML 预览（Webview）里 Vim 不介入，这是设计；Chat 输入框是例外，它是内嵌编辑器，按 Vim 工作——起始模式由 `vim.prompt.defaultMode` 决定，默认 `normal`（按 `i` 开始输入），设为 `insert` 则聚焦即可打字。
- **某个键被快捷键抢走了**：你若给该键绑定了自己的快捷键，Vim 会让行（保留键除外），见下文[优先级](#优先级用户键位保留集与自定义映射)。
- **`Ctrl+V` 不能粘贴 / `Ctrl+R` 变成重做**：编辑器文本 Normal 下这些 Ctrl 键归 Vim；需要粘贴先 `i` 进入 Insert，或用 `p`。
- **想在终端里用**：终端默认是 Insert（按键属于 shell），按 `Ctrl+Shift+\` 进入终端 Normal Mode。
- **中文输入法停在中文**：`vim.autoSwitchInputMethod`（默认开，仅 Windows）会在 Normal 下切英文、Insert 恢复。只有**当前有焦点**的界面会切；切到别的应用（Alt+Tab）或窗口失焦时会还给你原来的输入法，回来后再切英文；多个分屏同时打开时，后台的编辑器不会抢走当前编辑器的英文。
- **想临时关掉某一块**：`vim.surfaces.*` 可按界面关闭，例如 `vim.surfaces.editor` 只关编辑器文本（含 Chat 输入框与 Output 面板）。
- **想看当前有哪些键**：`Space ?`（键位速查表）或命令「Vim：显示当前键位映射」。

### 开启与关闭

三选一：

- 设置里把 `vim.enabled` 设为 `true`；
- 命令面板执行「切换 Vim 模式」（命令 id `workbench.action.toggleVimMode`）；
- 点击状态栏右侧的模式图标（悬停显示当前模式，点击即切换开关）。

任一窗口有 Vim surface 持有焦点时，状态栏显示当前模式文字：`NORMAL` / `INSERT` / `VISUAL` / `V-LINE` / `V-BLOCK`，终端 Normal 显示 `TERMINAL`。紧挨着有一个反馈条目：显示已输入但尚未完成的按键（如 `"a2d`、`g`、`3gg`、`<Space>w`），以及按下没有映射的键时短暂出现的 `Unsupported: <键>`。不需要这些可把 `vim.showStatusBar` 设为 `false`。关闭 `vim.enabled` 会立即恢复所有界面的普通键位。

可以按界面单独关闭：`vim.surfaces.lists`（树 / 列表 / Markdown 预览与文档中心）、`vim.surfaces.menus`（菜单）、`vim.surfaces.overlays`（浮层 / 选择器 / 通知中心）、`vim.surfaces.tabs`（编辑器标签栏）、`vim.surfaces.activityBar`（ActivityBar 与视图容器标题）、`vim.surfaces.terminalNormalMode`（终端 Normal Mode）、`vim.surfaces.editor`（编辑器文本、Chat 输入框与 Output 面板）。

### 模式、记忆与透传

- **Normal / Insert / Visual**：编辑器文本与 Chat 输入框有 Normal、Insert 与三种 Visual（`v` 按字符、`V` 按行、`Ctrl+V` 块选择）；其它第一方 surface 没有自己的 Insert，`Esc` 会回到 Normal 并把后续按键交还给 Vim。
- **模式按 surface 实例记忆**（仅内存，重启后重置）：编辑器按「编辑器组 + 输入」记忆，同一个文件在两个分屏里互不影响；关闭标签页会忘掉该输入的模式，重新打开从 Normal 开始。终端按终端实例记忆，默认是 Insert。Chat 输入框按 session 记忆，起始模式取 `vim.prompt.defaultMode`（默认 Normal）；切走再回来按该默认值开始，同一 session 的两个分屏共享。列表 / 菜单 / 浮层 / 标签栏 / ActivityBar / 视图容器标题默认 Normal。
- **Insert 模式只处理 `Esc` 与 `Ctrl+[`**（编辑器内另见下文 Insert 一节；编辑器里 `Ctrl+[` 同样退出 Insert，不会变成 Monaco 的「减少缩进」）：其余按键全部原样输入。编辑器与终端在切到 Normal 时，`vim.autoSwitchInputMethod`（默认开启，仅 Windows）会把系统输入法临时切到英文，Insert 恢复；输入法组合期间的按键（`isComposing` / `keyCode 229`）一律放行。
- **输入框、Quick Input、对话框透传**：普通可编辑控件（搜索框、行内输入框等）聚焦时，裸键保持普通输入；Quick Input（快速打开 / 命令面板等）打开期间 Vim 完全不介入；带 `[data-renderer-dialog]` 的模态对话框同样透传。**Chat 输入框例外**：它是内嵌的 Monaco 编辑器，按编辑器 Vim 工作，起始模式由 `vim.prompt.defaultMode` 决定（默认 Normal，按 `i` 进 Insert；设为 `insert` 则打开即可打字）；Normal 下 Enter 是 Vim 的换行移动、不再发送消息，浮层打开时 Esc / 方向键先归浮层，空闲 Esc 把焦点交回 Chat 时间线（从时间线按 `i` 可回来）。
- **Webview 不支持**：焦点进入 iframe（例如 HTML 预览）时 Vim 不介入，按键留在 frame 内。需要宿主标记的场景使用 `data-vim-surface="webview"`。
- **按键序列只认当前可用的**：带 `when` 条件的键位在条件不成立时不会占住前缀——例如不在对比编辑器里时按 `]` 不会进入「等待下一键」，而是直接交回编辑器自己的 `]` 前缀。
- **未映射键**：Normal 模式下，列表 / 菜单 / 浮层 / 终端里未映射的可打印键会被 Vim 吞掉，不会触发 Quick Open 或输入到别处，并在状态栏短暂提示 `Unsupported: <键>`；功能键和组合键照常交给工作台。把 `vim.passThroughUnmappedKeys` 设为 `true` 可让这些可打印键继续下传。
- **计数与前缀**：支持数字前缀（如 `3j`、`2dd`）。键位表里的多段序列（leader、列表命令等）在 `vim.sequenceTimeoutMs`（默认 800ms）内等待下一键；编辑器内核的 `g` / `z` / `[` / `]` / `>` / `<` 前缀同 Vim 内置命令，无限等待下一键。`Esc` 会取消待定状态，焦点移出 surface 时计数与前缀重置。
- **`G` / `gg` 的计数**：所有列表、树、标签栏等 surface 与编辑器一致——不带数字 `gg` 是首项、`G` 是末项；带数字则跳到第 N 项（`3G` / `3gg` 是第 3 项，`1G` 是首项）。终端 Normal 的 `NG` / `Ngg` 跳到第 N 行（buffer 行号），Markdown 预览的 `NG` / `Ngg` 跳到第 N 行**源码**（预览里没有源码行信息时退回首 / 末）。**例外**：Chat 时间线与通知中心的 `G` / `gg` 忽略数字，始终是首 / 末项。
- **which-key 提示**：leader 等工作台多键序列、以及编辑器内核的 `g` / `z` / `[` / `]`、操作符等待（`d` / `y` / `c` / `>` / `<`）、`i` / `a` 文本对象等前缀，按下后停顿约 0.3 秒，屏幕上会列出可用的下一个键与对应命令；打开期间不会超时，按 `Esc`、继续输入或切换焦点才结束。补全弹窗可见时暂不显示（状态栏仍显示待定键），离开 Insert 时补全弹窗会自动关闭。`vim.whichKey` 设为 `false` 可关闭。
- **键位速查表**：命令「Vim：显示键位速查」（`workbench.action.vim.showKeymapCheatSheet`，默认 `Space ?`）列出每类界面当前生效的键位（已合并你的 `vim.keymap`，当前界面排在最前），编辑器部分还包含全部内核键位说明；可输入文字过滤。

### 编辑器

编辑器文本区的 Vim 是一个内置的、较完整的子集：移动、操作符、文本对象、Visual、寄存器、`.` 重复、搜索都有。**每个键的说明都能在键位速查表里看到**（`Space ?`），下表是按用途整理的速览。

#### 移动（Normal）

| 操作 | 键位 |
| --- | --- |
| 左 / 右 / 上 / 下移动 | `h` / `l` / `j` / `k`，或方向键 |
| 按显示行上 / 下移动 | `gj` / `gk`，可带计数；只在自动换行开启时逐视觉行移动，关闭时等同 `j` / `k` |
| 按词移动 | `w` `b` `e`；大写 `W` `B` `E` 按空白分词 |
| 行首 / 行尾 | `0` / `$`，或 `Home` / `End`；`^` 到首个非空白字符 |
| 文件首行 / 末行 / 第 N 行 | `gg` / `G` / `NG` 或 `Ngg` |
| 段落 | `{` / `}` |
| 行内查找字符 | `f{字符}` / `F{字符}` 跳到该字符，`t{字符}` / `T{字符}` 停在其前一格；`;` / `,` 重复 / 反向重复上一次（跨编辑器共享），可带计数 |
| 括号匹配 | `%`；`N%` 跳到文件 N% 处 |
| 翻页 | `Ctrl+F` / `Ctrl+B`（整页）、`Ctrl+D` / `Ctrl+U`（半页）；或 `PageDown` / `PageUp` |
| 视口下 / 上滚一行（光标尽量不动） | `Ctrl+E` / `Ctrl+Y`，可带计数（如 `3Ctrl+E`） |
| 光标行置顶 / 居中 / 置底 | `zt` / `zz` / `zb`；带计数时 `[count]zt` 把该行号放到目标位置，并把光标移到该行（保持列） |
| 跳到视口首 / 中 / 末可见行 | `H` / `M` / `L`；`[count]H`、`[count]L` 从首 / 末行向里数，`M` 不接受计数（同 Vim） |
| 下移一行到行首非空白 | `Enter`（同 Vim 的 `<CR>`） |
| 导航历史后退 / 前进 | `Ctrl+O` / `Ctrl+I`（对应「后退 / 前进」；编辑器位置和视图焦点在同一条跳转栈里，见 [导航历史](../search-navigation/history.md#vim-模式下视图也进历史)） |

#### 编辑（Normal）

| 操作 | 键位 |
| --- | --- |
| 进入 Insert | `i`（光标处）、`a`（光标后）、`I`（行首第一个非空白字符）、`gI`（第 1 列）、`A`（行尾之后）、`o` / `O`（下方 / 上方新行）；可带计数，如 `3ifoo<Esc>` 输入三遍 |
| 删除 | `x` / `X`（字符，`Delete` 同 `x`）、`D`（到行尾）、`d` + 移动 / 文本对象（`dw` `dd` `d$` `diw` 等） |
| 修改（删除后进入 Insert） | `c` + 移动 / 文本对象（`cc` 整行、`cw`、`ciw`、`ci"` 等）；`C` 同 `c$`；`s` 替换字符、`S` 同 `cc`。`cw` 与 Vim 一样等同 `ce`（不吃掉词后的空白） |
| 复制 | `y` + 移动 / 文本对象（`yw` `yy` `yiw` 等）；`Y` 同 `yy` |
| 粘贴 | `p` / `P` |
| 替换单个字符 | `r{字符}` |
| 切换大小写 | `~`（字符）；`g~` / `gu` / `gU` + 移动或文本对象（切换 / 小写 / 大写，`g~~` `guu` `gUU` 作用于整行） |
| 缩进 / 反缩进 | `>` / `<` + 移动，`>>` / `<<`（支持计数，如 `3>>`） |
| 合并行 | `J`（以空格连接）、`gJ`（不插入空格）；`3J` 合并三行，一次 `u` 撤销 |
| 撤销 / 重做 | `u` / `Ctrl+R` |
| 重复上一次修改 | `.`（含 Insert 中输入的按键：文字、`Backspace`，自动缩进 / 自动闭合括号会按当时的上下文重新触发；Insert 里用方向键移动光标后，只重做移动之前输入的部分；`3.` 用新计数重做；跨分屏共享） |

**计数相乘**：操作符前后的数字相乘，`2d3w` 等于 `d6w`。

**文本对象**（跟在 `d` `y` `c` `>` `<` `g~` `gu` `gU` 或 Visual 之后）：`i` 取内部、`a` 取包含分隔符 / 空白的外部——`w` `W`（词）、`"` `'` `` ` ``（引号）、`(` `)` `b`（圆括号）、`[` `]`、`{` `}` `B`（花括号）、`<` `>`、`p`（段落）、`t`（HTML / XML 标签块）。例如 `ci(`、`da"`、`yip`、`vi{`。引号对象与 Vim 一致：光标在两个引号串之间时取「光标前最近的引号」开头的那一段；光标前没有引号时取其后第一对；行内的 `\"` 转义引号不算。

**寄存器**：`"{名字}` 放在 `d` / `y` / `c` / `p` 之前选择寄存器。`""` 是默认寄存器，`"0` 是最近一次复制（删除不会覆盖它），`"a`–`"z` 是具名寄存器（大写 `"A` 表示追加），`"_` 是黑洞（丢弃），`"+` / `"*` 是系统剪贴板。不指定寄存器的删除 / 修改若跨行（或删整行），内容进编号寄存器 `"1`–`"9`（`"1` 最新，旧的依次后移）；不跨行的小删除进 `"-`。（Vim 里 `d%` `d/` `dn` `d{` 等恒用 `"1` 的特例未实现。）`vim.useSystemClipboard` 设为 `true` 后，默认寄存器与系统剪贴板互通。从系统剪贴板粘贴是异步的：等待期间如果光标移动或内容变了，这次粘贴会被放弃，不会粘到错误位置。

**折叠**：

| 操作 | 键位 |
| --- | --- |
| 折叠 / 展开 / 切换 | `zc` / `zo` / `za`；大写 `zC` / `zO` / `zA` 递归 |
| 折叠全部 / 展开全部 | `zM` / `zR` |
| 下一个 / 上一个折叠开头 | `zj` / `zk` |
| 跳到当前 / 外层折叠的开头、结尾 | `[z` / `]z`（列移到首个非空白字符；只对打开的折叠生效） |

折叠闭合时，光标在折叠头行上的行级操作（`dd` / `yy` / `>>` / `o` 等，以及 `dj` / `3j` 这类按行计数的移动）把整个折叠当作一行，作用于折叠的全部行。自动换行开启时 `j` / `k` 仍按逻辑行移动，逐视觉行移动用 `gj` / `gk`；闭合折叠对两者都只占一个显示行，折叠头自身折行也按一行计。

#### Visual 模式

`v`（按字符）、`V`（按行）、`Ctrl+V`（块选择）进入；同一个键再按、或 `Esc` / `Ctrl+[` 退出（有待定前缀时先取消前缀）。进入后用任何移动键扩展选区，`o` / `O` 跳到选区另一端，`gv` 重选上一次的 Visual 区域，`i` / `a` + 文本对象按对象扩展（如 `viw`、重复 `ip` 扩到下一段，重复 `i(` / `a(` 逐层向外扩一层括号；反向选择时 `iw` 向前扩展）。`gv` 在文本变短后按当前文档裁剪，不会出错。`$` 后选区包含换行（`v$` 选到行尾并含换行符）。用鼠标点击改变选区会结束 Visual；`u` / `Ctrl+R` 之后不会残留旧选区。

| 操作 | 键位 |
| --- | --- |
| 删除 / 复制 / 修改 | `d` `x` / `y` / `c` `s`；大写（`D` `X` / `Y` / `C` `S` `R`）按整行，块选择下 `D` / `C` 到行尾 |
| 缩进 / 反缩进 | `>` / `<` |
| 大小写 | `~` 切换、`u` 小写、`U` 大写（`g~` `gu` `gU` 亦可） |
| 合并行 / 不加空格合并 | `J` / `gJ` |
| 替换所选每个字符 | `r{字符}` |
| 用寄存器内容替换选区 | `p`（`P` 替换后不覆盖寄存器） |
| 块选择：每行前 / 后插入 | `I` / `A` |

状态栏显示 `VISUAL` / `V-LINE` / `V-BLOCK`。

#### 代码导航（Normal）

以下键与 VSCode Vim / Neovim 社区约定一致，全部在 Normal 模式、不离开主键盘：

| 操作 | 键位 |
| --- | --- |
| 跳转定义 / 声明 | `gd` / `gD` |
| 跳转类型定义 / 实现 | `gy` / `gi` |
| 查看引用 / 速览引用 | `gr` / `gR` |
| Hover 文档 | `K` 或 `gh` |
| 搜索光标下单词 | `*` 向前 / `#` 向后（整词匹配，Vim `\<...\>` 语义） |
| 下一个 / 上一个问题（跨文件） | `]d` / `[d` |
| 下一处 / 上一处更改 | `]c` / `[c`；焦点在列表 / 树中时，只要活动编辑器是对比编辑器也同样生效 |

`g`、`[`、`]`、`>`、`<`、`z`、`f` `t` `r`、`"` 等是待定前缀，无限等待下一键（同 Vim 内置命令，不受 `vim.sequenceTimeoutMs` 影响）。待定期间按功能键（`F1`–`F12`）会取消前缀并照常交给工作台；按 `Backspace` / `Delete` / `Enter` / `Tab` / 方向键等编辑或移动类按键则取消前缀并**吞掉这一击**（不会误删字符或换行）。`r<Space>`（替换成空格）、`r<Enter>`（换行）、`f<Tab>` 这类「把该键当字符参数」的用法照常可用；等待字符参数期间 `Space` 也是参数，不会触发 leader。`AltGr` / macOS `Option` 组合出来的字符（如 `@`、`€`）作为普通字符键处理。这些原生前缀键由编辑器内核处理，不能用 `vim.keymap` 覆盖；需要自定义时使用下文的 leader 别名（折叠父级也可用 `<leader>z`）。`dz*`、`dH` 这类「操作符 + 视口 / 折叠命令」组合不支持，会取消操作符。`d}` / `d{` 遵循 Vim 规则：终点落在下一段空行行首时收到上一行行尾，起点在缩进里则按整行删除。

Normal 模式下**未实现的字符键会被吞掉**，不会输入到缓冲区；`F1`–`F12`、媒体键、输入法组合键等非文本功能键不拦截，仍交给工作台和编辑器处理。

**Ctrl 组合键的归属**：`Ctrl+H` / `Ctrl+J` / `Ctrl+K` / `Ctrl+L` 仍归工作台（替换 / 切换底栏 / 和弦 / 扩选），Ctrl+K 和弦照常可用。编辑器 Normal 下 Vim 接管 `Ctrl+F` / `Ctrl+B` / `Ctrl+D` / `Ctrl+U` / `Ctrl+E` / `Ctrl+Y`（滚动，`Ctrl+Y` 不再重做）、`Ctrl+R`（重做）、`Ctrl+V`（块选择，不再粘贴）；`Ctrl+O` / `Ctrl+I`（导航后退 / 前进，可带计数如 `3<C-o>`）在所有 Normal surface 上同义，走 Vim 键位表，可用 `vim.keymap` 改绑（id `nav.back` / `nav.forward`）；视图焦点只在 Vim 开启时才记进导航历史。这些组合若你有自己的同键绑定，用户键位优先（见下文优先级）。

**光标与 `Esc`**：Normal / Visual 下光标是块状，Insert 下恢复为你设置的光标样式。`j` / `k` 会记住期望列：经过短行后回到原来的列；`$` 之后上下移动都贴着行尾。`gj` / `gk` 单独记住视觉行内的横向位置，跨过较短的行后同样会回到原来的位置。从 Insert 按 `Esc` 光标左移一格（同 Vim），并且一次 `u` 撤销整段 Insert 输入。Normal 下**没有任何待定状态时**按 `Esc`：先清除搜索高亮，没有高亮可清时把焦点交给编辑器标签栏（Chat 输入框中改为交回 Chat 时间线；可用 `h` / `l` 切换标签，`Enter` 回正文）；取消前缀 / 计数的那一次 `Esc` 不会跳到标签栏。`Ctrl+[` 在 Normal / Visual / Insert 下都等同 `Esc`。

`/`、`?` 搜索为**字面量子串**（不支持正则或多行查询），`*`、`#` 只匹配完整单词（词字符为 `[A-Za-z0-9_$]`，`foo` 不会命中 `fooBar`），`n` / `N` 沿用上一次搜索的模式。默认 smartcase：查询全小写时忽略大小写，含大写字母时区分。可在查询后加 `\c` 忽略大小写、`\C` 强制区分（对本次搜索生效），也可点击搜索框右侧的 `Aa` 切换本次策略；默认策略由 `vim.searchCaseSensitivity` 控制（`smart` / `sensitive` / `insensitive`，默认 `smart`）。区分大小写且无匹配时会提示可加 `\c`。连续两个反斜杠 `\\` 表示字面反斜杠（如 `C:\\config` 搜索 `C:\config`）。没有更多匹配时会环绕整个文件（wrapscan）。

按 `/` 或 `?` 后编辑器右上角出现与 Ctrl+F 查找框同尺寸的搜索框，焦点进入输入框（此时可用中文输入法；组合期间不搜索，候选词提交后立即刷新）；输入过程中光标实时跳到下一个匹配。`Enter` 确认并回到 Normal 模式，`Esc` 取消并把光标放回搜索前的位置；查询留空直接 `Enter` 会重复上一次搜索。默认**不保留高亮**：`Enter` 确认、`n` / `N` 跳转后只移动光标并清除预览高亮。把 `vim.highlightSearch` 设为 `true` 后会高亮全部匹配并在编辑时刷新（大文件有扫描上限），Normal 模式按 `Esc` 清除（等价 `:nohlsearch`）。

和 Vim 一致，起始搜索会跳过光标所在的那个匹配，`n` / `N` 也跳过当前匹配，重叠的匹配按 Vim 的不重叠规则推进；没有下一个匹配时环绕回来。搜索框聚焦期间 `Ctrl+F` / `Ctrl+H` / `F3` / `Shift+F3` 不会打开或操作编辑器查找框，以免查询内容丢失。搜索框关闭后可用 `n` / `N` 继续跳转。`d/`、`dn`、`dN` 这类「操作符 + 搜索」组合暂不支持。

Insert 模式：所有键原样输入，`Esc` 或 `Ctrl+[` 回到 Normal 模式。

**只读编辑器**（只读文件、对比编辑器的只读一侧等）：移动、`y` 复制、搜索照常；所有会改内容的命令（`d` `c` `p` `x` `J` `>` `.` 等）被拒绝，也不会进入 Insert，Visual 下的 `d` / `c` 只是退出 Visual。

### 列表 / 树 / 菜单 / 浮层

这些 surface 没有 Insert 模式（不输入文本），聚焦时按 Normal 处理。通用键位：

| 操作 | 键位 |
| --- | --- |
| 上 / 下移动 | `k` / `j`（树、菜单还可 `h` / `l` 向左折叠回父 / 向右展开进子；菜单里 `h` / `l` 收起 / 展开子菜单；浮层由宿主决定左右语义） |
| 首项 / 末项 / 第 N 项 | `gg` / `G` / `NG`（`3G`、`3gg` 都是第 3 项） |
| 翻页 | `Ctrl+U` / `Ctrl+D`（菜单没有视口，落到首 / 末项） |
| 视口下 / 上滚一行（不移动焦点 / 选中） | `Ctrl+E` / `Ctrl+Y`（列表、树、浮层；菜单不适用）。滚动后焦点行可能离开视口，下一次 `j` / `k` 会把它带回 |
| 激活 | `Enter` 或 `o` |
| 预览 | `p`（宿主支持预览时；菜单里等同激活） |
| 展开 / 折叠 / 切换 | `zo` / `zc` / `za`（树、Chat 等支持折叠的宿主） |
| 右键菜单 | `m` |
| 复制 / 删除 | `yy` / `dd`（宿主实现时） |
| 筛选 / 查找 | `/`（宿主有筛选框时：Outline、设置页、Git / Perforce 图谱等，聚焦其搜索框） |
| 退出 surface | `Esc`（具体动作由宿主决定：菜单收一层或关闭、浮层关闭等）。侧栏 / 底栏里的视图列表（Explorer、SCM、搜索结果等）先收拢多选，**没有可退出的状态时把焦点交回编辑器**，与关闭 Vim 时的 `Esc` 一致 |
| 导航历史后退 / 前进 | `Ctrl+O` / `Ctrl+I`：与编辑器内同义，共用同一条跳转栈。在视图里按 `Ctrl+O` 回到进入视图前的编辑器位置，随后 `Ctrl+I` 回到这个视图（所以在 Explorer 里 `Ctrl+O` 不再弹出「打开文件」；菜单 / 浮层除外） |

Markdown 预览与文档中心也是列表类 surface（`vim.surfaces.lists` 控制）：`j` / `k` 滚动、`gg` / `G`、`Ctrl+D` / `Ctrl+U`、`Ctrl+E` / `Ctrl+Y` 等与原有的预览键盘导航（`f` 链接提示、`/` 查找等）共存；见 [Markdown 编辑与预览](../editing/markdown.md)。

列表内的搜索框、行内输入框等**可编辑控件**聚焦时，裸键仍是普通输入，Vim 不会接管。Git / Perforce 图谱、Explorer、搜索结果、SCM、Outline、快捷键编辑器、扩展列表、MCP Servers、Process Explorer 等共享同一套列表 surface。

设置页：行列表里 `j` / `k` 移动、`gg` / `G` 首末、`Ctrl+D` / `Ctrl+U` 翻页、`Enter` 聚焦当前行的控件、`/` 聚焦设置搜索框；左侧目录（TOC）里 `j` / `k` 选分区、`Enter`（或 `l`）跳到该分区、`/` 同样聚焦搜索框。行内控件里按 `Esc` 回到行列表。

通知中心：`j` / `k` 选通知、`gg` / `G` 首末（忽略数字）、`Ctrl+D` / `Ctrl+U` 每页 5 条、`Ctrl+E` / `Ctrl+Y` 纯视口滚动、`Enter` 执行该通知的主操作（进度通知则取消）、`x` 关闭该通知、`Esc` 关闭通知中心。

Chat 时间线（焦点在时间线而非输入框时）：`j` / `k` 上下滚动时间线（只移动视图、不改变选中卡片；选行用 `Alt+J` / `Alt+K`）、`h` / `l` 折叠层级出 / 入、`gg` / `G` 首 / 末（忽略数字）、`Ctrl+D` / `Ctrl+U` 翻页、`Ctrl+E` / `Ctrl+Y` 细滚一行、`zo` / `zc` / `za` 或 `Enter` / `o` 展开折叠、`m` 打开当前卡片右键菜单、`yy` 复制当前行文本；`i` 把焦点送回输入框，`a` / `e` 跳到时间线顶部 / 底部。输入框本身保持普通输入。

### 输出面板（Output）

Output 面板的内容是只读 Monaco 编辑器，聚焦后按 Normal 处理（没有 Insert 模式，也没有搜索；受 `vim.surfaces.editor` 控制）。只提供滚动类键位，不会修改输出内容：

| 操作 | 键位 |
| --- | --- |
| 上 / 下移动一行 | `k` / `j`，可带计数（如 `5j`） |
| 按显示行上 / 下移动 | `gj` / `gk`，可带计数；输出强制自动换行，长日志按视觉行移动 |
| 视口下 / 上滚一行（光标尽量不动） | `Ctrl+E` / `Ctrl+Y`，可带计数 |
| 半页 / 整页 | `Ctrl+D` / `Ctrl+U`、`Ctrl+F` / `Ctrl+B`，计数表示页数 |
| 首行 / 末行 | `gg` / `G`；带计数时跳转到该行号（如 `120G`） |

Normal 模式下 `Ctrl+F` 是整页下滚（同 Vim），不会打开查找框；需要查找时先关闭 Vim（`vim.enabled`）或从命令面板执行 Monaco 的查找命令。`Esc` 在查找框等 Monaco 控件已经打开时仍交给 Monaco；方向键、`PageUp` / `PageDown`、`Home` / `End` 保持原生行为。未映射的可打印键会被吞掉，不会编辑缓冲区；`v` / `V` / `Ctrl+V` 同样被吞掉，面板保持 Normal（不会进入看不见的 Visual 状态）。

### 编辑器标签栏

先把焦点交给标签栏：在编辑器 Normal 模式、没有待定前缀 / 搜索高亮时按 `Esc`，或执行命令 `workbench.action.focusEditorTabs`。再使用：

| 操作 | 键位 |
| --- | --- |
| 上一个 / 下一个标签 | `h` / `l`（同时激活该编辑器，但焦点留在标签栏） |
| 第一个 / 最后一个 | `0` / `gg`、`$` / `G` |
| 打开并聚焦编辑器正文 | `Enter` |
| 关闭当前标签 | `x`（固定标签不可关闭） |
| 固定 / 取消固定 | `p` |
| 标签右键菜单 | `m` |
| 回到编辑器正文 | `Esc` |

### ActivityBar 与视图容器标题

ActivityBar 聚焦时：`j` / `k` 在容器间移动光标，`gg` / `G` 首 / 末，`Enter` 或 `l` 打开当前容器并把焦点交给它的第一个视图。

Panel / 辅助侧边栏的**标签式**容器标题聚焦时：`h` / `l` 切换上一个 / 下一个容器，`j` 或 `Enter` 聚焦当前容器的内容，`gg` / `G` 首 / 末，`Esc` 同 `Enter`。标签式标题之外的标签栏（如主侧边栏的图标标题）不注册此 surface。

### Leader

默认 leader 为 `Space`（`vim.leader` 可改，值用 Vim token，如 `space`、`,`；`Space`、`<space>`、单个空格都等价于 `space`，写成无法识别的值会回退为 `space` 并在控制台告警）。Leader 序列可在任意 Normal surface 使用；标注「编辑器内」的条目只在编辑器文本 surface 生效：

| 序列 | 动作 |
| --- | --- |
| `<leader> e` | 聚焦资源管理器 |
| `<leader> f` | 快速打开文件 |
| `<leader> p` | 打开命令面板 |
| `<leader> s` | 全局搜索 |
| `<leader> g` | 聚焦源代码管理 |
| `<leader> x` | 聚焦扩展 |
| `<leader> b` | 聚焦主侧边栏 |
| `<leader> j` | 聚焦底栏 |
| `<leader> t` | 聚焦终端 |
| `<leader> o` | 聚焦大纲 |
| `<leader> q` | 关闭当前编辑器 |
| `<leader> n` / `<leader> N` | 下一个 / 上一个编辑器 |
| `<leader> w h/j/k/l` | 向左 / 下 / 上 / 右移动焦点：先在编辑器组之间移动，到边缘后进入该方向的侧栏 / 底栏 / 辅助侧栏，再到窗口边缘时按屏幕方位进入该方向的辅助编辑器窗口；从辅助窗口回到主窗口时落到该方向最近的侧栏视图（如右侧大纲），没有更近的视图才回到编辑器组（命令 `workbench.action.navigateLeft/Down/Up/Right`）；在 Explorer 里 `<leader> w l` 回到编辑器 |
| `<leader> w H/J/K/L` | 把当前编辑器标签移到左 / 下 / 上 / 右相邻编辑器组 |
| `<leader> w w` | 聚焦下一个编辑器组 |
| `<leader> w s` | 向下拆分编辑器 |
| `<leader> w v` | 向右拆分编辑器 |
| `<leader> w c` | 关闭当前编辑器组内的全部编辑器（`workbench.action.closeEditorsInGroup`），不是只关当前标签；只关当前标签用 `<leader> q` |
| `<leader> ?` | 显示键位速查表 |
| `<leader> d` / `<leader> D` | 编辑器内：跳转定义 / 速览定义 |
| `<leader> r` / `<leader> R` | 编辑器内：查看引用 / 速览引用 |
| `<leader> y` / `<leader> i` | 编辑器内：跳转类型定义 / 实现 |
| `<leader> k` | 编辑器内：Hover 文档 |
| `<leader> a` | 编辑器内：快速修复 |
| `<leader> c` | 编辑器内：切换行注释 |
| `<leader> m` | 编辑器内：重命名符号 |
| `<leader> F` | 编辑器内：格式化文档 |
| `<leader> I` | 编辑器内：组织导入 |
| `<leader> G` | 编辑器内：转到行 |
| `<leader> O` / `<leader> S` | 编辑器内：文件内符号 / 工作区符号 |
| `<leader> h` / `<leader> l` | 编辑器内：后退 / 前进 |
| `<leader> z` | 编辑器内：跳到父级折叠 |

`<leader> w H/J/K/L` 需要按 Shift（键位区分大小写）；一次移动一个相邻编辑器组，焦点跟随被移动的标签。目标方向没有相邻组时按 VS Code 的「移动编辑器到…组」语义新建组；原组因此变空（没有其它标签）会自动关闭。

列表 / 树 / 菜单 / 浮层里的裸 `Space` 让给 leader；预览用 `p`，激活用 `Enter` 或 `o`。

### 终端 Normal Mode

终端的默认模式是 Insert（所有按键直接送给 shell）。聚焦终端时按 `Ctrl+Shift+\`（`workbench.action.terminal.enterNormalMode`）进入 Normal Mode；进入时会按 `vim.autoSwitchInputMethod` 把输入法切到英文。Normal Mode 下：

| 操作 | 键位 |
| --- | --- |
| 上 / 下滚动一行 | `k` / `j` |
| 视口下 / 上滚一行（不移动光标） | `Ctrl+E` / `Ctrl+Y` |
| 半页 / 整页 | `Ctrl+U` / `Ctrl+D`、`Ctrl+B` / `Ctrl+F` |
| 滚动到顶部 / 底部 / 第 N 行 | `gg` / `G` / `NG`（或 `Ngg`，N 为 buffer 行号） |
| 开始按行选择 | `v`（之后 `j` / `k` 扩展选择） |
| 复制选中并退出 Normal | `y` |
| 退出 Normal 回到 shell | `i`、`a`、`q` 或 `Esc`（有选区时先清除选区并保持 Normal，再按一次才退出） |

把终端在面板与编辑器区之间移动（拖动 / 「移到编辑器区」）不会打断 Normal Mode：模式保持，焦点仍在时继续使用英文输入法。`vim.surfaces.terminalNormalMode` 设为 `false` 可整体关闭终端 Normal Mode。Insert 模式下终端保持原有的 Ctrl 组合与 shell 行为。

### 优先级：用户键位、保留集与自定义映射

- **用户键位优先**：某个键存在 weight ≥ User 的键位绑定时，Vim 会让行（不执行 Vim 命令），交给全局快捷键分发器执行用户绑定的命令。这里比较的是**同一次击键**，与用户绑定声明的 `when` 是否成立有关。
- **保留集例外**：`vim.reservedKeys` 里的键不会被 User 绑定抢走（具体执行什么仍由 Vim 键位表决定）。默认保留 `escape`、`ctrl+[`、`i`、`a`、`:`、`/`、`?`、`<leader>`；把某个键从列表里删掉，用户绑定即可胜出。`Ctrl+D` / `Ctrl+U` 在列表里也映射翻页，`Ctrl+F` / `Ctrl+B` / `Ctrl+E` / `Ctrl+Y` 主要用于编辑器、列表与终端 Normal，编辑器里还有 `Ctrl+R` / `Ctrl+O` / `Ctrl+I` / `Ctrl+V`；它们都不在保留集里，有同键 User 绑定时用户键位优先。
- **`Ctrl+H` / `Ctrl+J` / `Ctrl+K` / `Ctrl+L` 不走 Vim**：在菜单、浮层 / 选择器、对话框与 Agent 配置栏聚焦期间它们是工作台的方向别名；纯列表 / 树聚焦时保持全局含义，移动用方向键或开启 Vim 后的裸键。`Ctrl+P` / `Ctrl+N` 始终是快速打开 / 新建文件。`Ctrl+J` / `Ctrl+K` 等别名与 `Ctrl+K` 和弦的互斥规则见[快捷键速查表](./keyboard-shortcuts.md#菜单内键盘操作)。
- **自定义映射**：`vim.keymap` 是对象数组，字段为 `id`、`keys`（Vim token 数组，多段即序列）、`command`（命令 id）、`args`（可选）、`when`（可选上下文表达式）、`surfaces`（可选 surface 种类数组）。
  - **覆盖**：`id` 与内置条目相同时只改你写出的字段，其余（`surfaces` / `when` / `args`）继承内置；某个界面自带的键位（如设置页的 `/`）同样可以按 `id` 覆盖或解绑，仅在该界面聚焦时生效（`id` 见「Vim：显示当前键位映射」的输出）；
  - **追加**：`id` 不是内置时，必须同时写 `keys` 与 `command`；
  - **解绑**：`command` 以 `-` 开头（同 keybindings.json），用 `id` 或 `keys` 指明目标，如 `{ "id": "list.activate.o", "command": "-list.activate" }`，`{ "keys": ["x"], "command": "-" }` 表示该键任意命令，可加 `surfaces` 限定；
  - **token 写法**：可打印键保持大小写（`g` 与 `G` 不同），特殊键用小写名（`escape`、`enter`、`space`、`up`），组合键写 `ctrl+d`（修饰键小写，顺序为 `ctrl+alt+meta+shift`），`<leader>` 代表 `vim.leader`；
  - 省略 `surfaces` 时对所有非编辑器 surface 生效（编辑器只处理以 leader 开头的序列）；写错的条目会被忽略并在 Output 的 **Vim Keymap** 通道里列为问题（执行「Vim：显示当前键位映射」查看）。

  例如：

```json
"vim.keymap": [
  { "id": "user.saveAll", "keys": ["<leader>", "S"], "command": "workbench.action.files.saveAll" },
  { "id": "list.activate.o", "keys": ["l"], "command": "list.activate" }
]
```

### 全部 `vim.*` 配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `vim.enabled` | `false` | 全局开关。关闭后所有 Vim surface 恢复普通键位 |
| `vim.showStatusBar` | `true` | 状态栏显示当前 surface 的模式文字与待定键反馈 |
| `vim.autoSwitchInputMethod` | `true` | Normal / 终端 Normal 时切英文输入法，Insert 恢复；仅 Windows 生效 |
| `vim.searchCaseSensitivity` | `smart` | 编辑器 `/` 与 `?` 搜索的大小写策略：`smart` / `sensitive` / `insensitive` |
| `vim.highlightSearch` | `false` | 编辑器搜索：高亮全部匹配并在编辑时刷新；Normal 下 `Esc` 清除 |
| `vim.whichKey` | `true` | leader 与编辑器内核多键前缀停顿约 0.3 秒后列出可用的下一个键；补全弹窗可见时不显示 |
| `vim.useSystemClipboard` | `false` | 编辑器默认寄存器与系统剪贴板互通（`y` / `d` / `c` 写入，`p` / `P` 读取） |
| `vim.leader` | `space` | Leader 键的 Vim token |
| `vim.sequenceTimeoutMs` | `800` | 键位表多段序列（leader 等）等待下一键的超时；编辑器内核前缀（`g`/`z` 等）无限等待 |
| `vim.reservedKeys` | `["escape","ctrl+[","i","a",":","/","?","<leader>"]` | 永不让给 User 键位的键 |
| `vim.passThroughUnmappedKeys` | `false` | 未映射的可打印键是否继续下传 |
| `vim.keymap` | `[]` | 用户自定义映射，见上节 |
| `vim.surfaces.lists` | `true` | 树 / 列表 / Markdown 预览与文档中心 |
| `vim.surfaces.menus` | `true` | 右键菜单 / 下拉菜单 |
| `vim.surfaces.overlays` | `true` | 通知中心、悬浮面板等浮层 |
| `vim.surfaces.tabs` | `true` | 编辑器标签栏 |
| `vim.surfaces.activityBar` | `true` | ActivityBar 与视图容器标题 |
| `vim.surfaces.terminalNormalMode` | `true` | 终端 Normal Mode |
| `vim.surfaces.editor` | `true` | 编辑器文本、Chat 输入框与 Output 面板；关闭后编辑器按普通 Monaco 工作，leader 序列也不再生效 |
| `vim.prompt.defaultMode` | `normal` | 新打开的 Chat 输入框起始模式：`normal`（按 `i` 开始输入）或 `insert`（打开即可打字）；仅在 Vim 启用且 `vim.surfaces.editor` 开启时生效 |

### 排障：当前键位与分发轨迹

- **Vim：显示当前键位映射**（命令 id `workbench.action.vim.showActiveKeymap`）把当前生效的键位表写入 Output 的 **Vim Keymap** 通道，包括：全局开关 / leader、当前活跃 surface 与模式、合并后的有效 keymap、`vim.keymap` 用户覆盖、保留集，以及被 User 绑定遮蔽的键。先聚焦目标界面再执行，才能看到该 surface 的键位。
- **键盘快捷方式故障排查**：执行「开发人员：切换键盘快捷方式故障排查」（`Developer: Toggle Keyboard Shortcuts Troubleshooting`），会在 Output 的 **Keyboard Shortcuts Troubleshooting** 通道逐键记录分发结果。开启 Vim 后同样会记录 Vim 的决策，常见行：

```text
→ vim surface=list(list:explorer) mode=normal
→ vim surface=list(list:explorer) mode=normal / sequence pending [g]
→ vim surface=list(list:explorer) mode=normal / EXECUTE list.focusFirst(1)
→ vim surface=list(list:explorer) mode=normal / ⤫ user binding shadows Vim — workbench.action.togglePanel
→ vim surface=list(list:explorer) mode=normal / ⤫ editable target
```

看到 `⤫ user binding shadows Vim` 说明用户键位优先；看到 `⤫ editable target`、没有 Vim 行或 `vimSurfaceId` 为空，说明焦点不在 Vim surface（普通输入框、Quick Input、对话框或 Webview）。也可以检查 `vimEnabled` / `vimMode` / `vimNormalMode` / `vimVisualMode` / `vimSurface` / `vimSurfaceId` / `vimTerminalNormalMode` 这些上下文键（Keyboard Shortcuts 的 when 表达式里可引用）。

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
| `Alt+PageUp` / `Alt+PageDown` | 文件有未提交改动或活动编辑器是文本对比编辑器时：上一处 / 下一处更改；否则是滚动一页 | 滚动一页 | `Shift+Alt+PageUp` / `Shift+Alt+PageDown` |
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
