# 追溯每行的来历（Blame）

Blame 让你看清某一行内容**是谁、在哪次[提交](../reference/glossary.md#提交--commit)、什么时候**改的。多人协作时，或者当你回忆"这段设定当初为啥这么写"时，它特别有用。

## 目录

- [编辑器里的行尾注解](#编辑器里的行尾注解)
- [状态栏上的 Blame](#状态栏上的-blame)
- [悬停看详情](#悬停看详情)
- [开关 Blame](#开关-blame)
- [自定义显示](#自定义显示)
- [查一个文件的完整历史](#查一个文件的完整历史)

## 编辑器里的行尾注解

把光标停在某一行上，这一行的行尾会浮现一条灰色注解，默认格式是"提交说明, 作者 (多久以前)"，例如"平衡数值, 张三 (3 天前)"。它只标注光标所在的那一行，不会铺满整个文件，所以不会干扰你阅读。

<!-- 截图：编辑器行尾的 blame 灰字注解 + 悬停卡片 -->

> 还没提交过的行，注解会显示英文 **"Not Committed Yet"**（尚未提交）。这是当前界面的原样文案。

## 状态栏上的 Blame

编辑器底部的状态栏也会显示当前行的 Blame（默认格式是"作者 (多久以前)"）。

**点击这个状态栏项，会直接打开 [Git 图谱](./git-graph.md)** 并定位到对应的那次提交，方便你顺藤摸瓜看这次改动的来龙去脉。

<!-- 截图：状态栏 blame 项 -->

## 悬停看详情

把鼠标停在行尾的灰色注解上，会弹出这次提交的完整信息：作者、邮箱、提交说明、时间和短哈希。

> 悬停卡片里的部分时间短语（如 just now、N days ago）目前是英文原样显示。

## 开关 Blame

Blame 的两块显示可以分别开关，命令都能从命令面板搜到：

- **切换 Git Blame 编辑器修饰**：开关编辑器里的行尾注解。
- **切换 Git Blame 状态栏项**：开关底部状态栏的 Blame。

## 自定义显示

想调整显示格式，在设置里搜 `git.blame`。常用项：

- `git.blame.editorDecoration.enabled` / `git.blame.statusBarItem.enabled`：分别是行尾注解、状态栏项的开关。
- `git.blame.editorDecoration.template` / `git.blame.statusBarItem.template`：显示模板。可用的占位标记有 `${hash}`、`${hashShort}`、`${subject}`、`${authorName}`、`${authorEmail}`、`${authorDate}`、`${authorDateAgo}`。
- `git.blame.editorDecoration.disableHover`：关掉行尾注解的悬停卡片。
- `git.blame.ignoreWhitespace`：计算 Blame 时忽略只改了空白的改动（避免因为缩进调整就把整行算到你头上）。

## 查一个文件的完整历史

本编辑器没有独立的"文件历史"面板。想看一个文件都经历过哪些改动，走 [Git 图谱](./git-graph.md)：选中某次提交，下方会列出它改动的文件；或者直接从上面说的**状态栏 Blame 项点进图谱**，定位到某一行对应的那次提交，再往前后翻。

## 下一步

- [会话更改：AI 改了哪些文件](./session-changes.md)

## 相关阅读

- [提交历史图（Git 图谱）](./git-graph.md)（点 Blame 就进这里）
- [版本控制是什么，为什么需要它](./overview.md)
