# Perforce 概览与连接

本编辑器内置 **Perforce（Helix Core）** 集成，和 Git 一样挂在[源代码管理](../reference/glossary.md#源代码管理scm)侧栏里：一个工作区若是 Perforce 客户端（client），就会出现名为 **"Perforce: <客户端名>"** 的源代码管理提供方，Git 与 Perforce 可以并存、互不干扰。

## 目录

- [它能做什么](#它能做什么)
- [前提：安装 p4 命令行](#前提安装-p4-命令行)
- [连接是怎么建立的](#连接是怎么建立的)
- [登录与注销](#登录与注销)
- [切换工作区（client）](#切换工作区client)
- [离线与会话过期](#离线与会话过期)
- [接下来去哪](#接下来去哪)

## 它能做什么

- 按 **changelist** 分组列出你签出（opened）的文件：默认 changelist 在最上，其余编号 changelist 依次排列。
- 拉取版本：**拉取最新版本**、**拉取版本…**（按 changelist / 日期 / 修订号，或强制覆盖）、**预览将要拉取的内容**。
- 落后感知：资源管理器灰字 `↓` + 状态栏可更新计数，不用开 P4V 就知道哪些文件有新版本。
- 他人占用：灰字 `✎` 提示哪些文件正被别人签出（悬停可见 `user@client`）。
- 签出（edit）、新增（add）、删除（delete）、还原（revert）、提交（submit）。
- 单击文件行，看本地与仓库 have 版本的对比。
- 新建 / 编辑 changelist，把文件在 changelist 之间搬动。
- 搁置（shelve）与取出搁置（unshelve）。
- 冲突解决：置顶的「需要合并」组 + 自动合并 / 接受我的 / 接受对方的 + 三向合并编辑器。
- 状态栏显示活动文件的版本（`#have / #head`）。
- 在多个 Perforce 工作区（client）之间切换。
- 单条泳道可视化浏览已提交 changelist 历史（Perforce 图谱）。
- 编辑器左侧改动色条（dirty-diff）、行内 Blame——与 Git 共用同一套界面。

## 前提：安装 p4 命令行

集成通过官方 **`p4` 命令行**（Helix Core CLI）与服务器通信。请先安装 `p4` 并确保它在系统 `PATH` 中。找不到 `p4` 时，Perforce 源代码管理会静默禁用，不影响编辑器其余功能。

## 连接是怎么建立的

打开一个文件夹后，集成会运行一次 `p4 info` 来解析当前的客户端、根目录、用户和服务器地址。这些值按 Perforce 的惯例来源：环境变量（`P4PORT` / `P4USER` / `P4CLIENT`）、`p4 set`，或文件夹所在或上层目录里的 **P4CONFIG** 文件。

如果这些渠道都没提供，可在[设置](../customization/settings.md)里填兜底值：

- `perforce.port` —— 兜底 `P4PORT`（`server:port`）
- `perforce.user` —— 兜底 `P4USER`
- `perforce.client` —— 兜底 `P4CLIENT`

> 推荐优先用 `p4 set` / P4CONFIG 管理连接，设置里的兜底值只作最后手段。

当 `p4 info` 报告不到客户端根目录（该文件夹不在任何 Perforce 工作区内），该文件夹就不会出现 Perforce 提供方。

## 登录与注销

在 Perforce 面板标题栏的 **⋯ 菜单** 里有 **登录** / **注销**：

- **登录**：弹出输入框填密码 / ticket，集成把它喂给 `p4 login`。**密码 / ticket 绝不写入明文设置，也不经过任何网络协议明文传输**；ticket 由 `p4` 自身按 `P4TICKETS` 机制保存，集成不自行保管。
- **注销**：运行 `p4 logout`。

## 切换工作区（client）

面板标题栏 ⋯ 菜单里的 **切换工作区（Client）…** 列出你名下所有 Perforce client（显示名称与根目录，当前项带勾），选中即切换。切换后新的 client 出现在源代码管理侧栏，旧的仍在列表里，两者并存、互不干扰——适合一台机器上同时跟多个分支的场景。

## 离线与会话过期

Perforce 的状态在服务器上，没有本地文件监视器。集成会识别两类连接问题并在状态栏提示，而不是反复弹错误：

- **离线**：服务器不可达（检查网络与 `P4PORT`）。
- **未登录 / 会话过期**：ticket 失效，用上面的 **登录** 重新登录即可。

状态栏显示当前客户端名与连接状态，点击打开 **Perforce 图谱**；想看完整命令日志，用面板标题栏 ⋯ 菜单里的 **显示输出** 打开 **Perforce 输出** 底栏。

## 接下来去哪

- [拉取版本与状态感知](./sync-and-status.md)
- [日常操作：签出、提交、对比](./daily-workflow.md)
- [Changelist 与搁置](./changelists-and-shelving.md)
- [提交历史图（Perforce 图谱）](./perforce-graph.md)
- [Swarm 代码审核（P4 Code Review）](./swarm-code-review.md)
- [冲突解决与进阶设置](./resolve-and-advanced.md)
