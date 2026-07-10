# 提交历史图（Perforce 图谱）

Perforce 图谱是一个专门用来**可视化浏览已提交 changelist 历史**的编辑器。想看清"仓库里依次提交了哪些改动"、或直接对某个 changelist 查看/对比它改了哪些文件，这里是最佳入口。

> 与 Git 不同，Perforce 的历史是一条**严格编号、线性排列的 changelist 列表**（没有本地分支合并那样的分叉），所以图谱是**单条泳道**。界面、搜索、右键菜单都与 [Git 图谱](../git/git-graph.md) 保持一致的使用体验。

## 目录

- [打开 Perforce 图谱](#打开-perforce-图谱)
- [图谱里能看到什么](#图谱里能看到什么)
- [搜索 changelist](#搜索-changelist)
- [右键即操作](#右键即操作)
- [图谱不可用时](#图谱不可用时)

## 打开 Perforce 图谱

两种方式：

- 命令面板运行 **View Perforce Graph**（查看 Perforce Graph）；
- 点 Perforce 源代码管理侧栏标题栏最左边的图谱图标。

> 命令面板里这条命令显示的是英文 **"View Perforce Graph"**（分类 "Perforce Graph"），搜索时请用英文。

打开后是一个编辑器标签页，标题为 **"Perforce Graph"**。

<!-- 截图：Perforce 图谱编辑器全貌（单泳道 changelist 列表 + 文件更改） -->

## 图谱里能看到什么

- **每行一个已提交的 [changelist](../reference/glossary.md#源代码管理scm)**，左侧是单条连线泳道，右侧有 changelist 编号、作者、工作区（client）、日期、描述等列。
- 最顶部有一行 **"待定变更"**，代表你当前已签出（opened）但还没提交的改动，与 Git 图谱里"未提交的更改"节点对应。
- **选中某个 changelist**，下方会列出它改了哪些文件，并按状态着色（已添加 / 已修改 / 已删除 / 已重命名）。点击文件行会看这次改动的差异；行尾的 **打开文件** 会打开当前工作树里的源文件，如果文件已被删除或重命名，编辑器会提示原因。

顶部还有"加载更多变更"，用于翻看更早的历史（默认一次加载最近若干条）。

## 搜索 changelist

图谱编辑器处于激活状态时，按 `Ctrl+F` 聚焦搜索框（占位文字"搜索变更…"），输入编号、作者或描述关键词快速定位。

> 命令面板里这条对应 **Focus Search**（聚焦搜索），且只在 Perforce 图谱编辑器激活时才生效。

## 右键即操作

在某个 changelist 上**右键**可执行：

- **复制变更号**：拷贝该 changelist 的编号。
- **复制提交信息**：拷贝该 changelist 的描述文字。
- **发送到 Agent Chat**（Send to Agent Chat）：把这个 changelist 的编号和描述发到 AI 会话的输入框，方便让 agent 结合这次改动回答问题。没有活动会话时会自动新建一个。

<!-- 截图：对某 changelist 右键的操作菜单 -->

## 图谱不可用时

如果当前项目文件夹不在任何 Perforce 工作区内，图谱会提示 **"Perforce Graph is unavailable — is this folder inside a Perforce workspace?"**。让文件夹处于某个 Perforce 客户端根目录下的办法，见 [Perforce 概览与连接](./overview.md#连接是怎么建立的)。

## 下一步

- [日常操作：签出、提交、对比](./daily-workflow.md)

## 相关阅读

- [Changelist 与搁置](./changelists-and-shelving.md)
- [提交历史图（Git 图谱）](../git/git-graph.md)（Git 侧的等价功能）
