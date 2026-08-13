# 远程开发

远程开发让你把「编辑体验留在本地、代码与文件系统放在远端」——像 VSCode 的 Remote-SSH 一样，Universe Editor 通过 SSH 连到一台 Linux 主机（或 WSL），在那台机器上部署一个轻量 server，把文件浏览、搜索、保存等操作路由到远端执行，本地的编辑器则负责界面与交互。

这一页讲清前置条件、怎么连、连上后有哪些入口与状态反馈，以及出问题时去哪看日志。

## 目录

- [前置条件](#前置条件)
- [连接流程](#连接流程)
- [命令速查](#命令速查)
- [状态栏指示器](#状态栏指示器)
- [断线自动重连](#断线自动重连)
- [远程资源管理器](#远程资源管理器)
- [排障](#排障)

## 前置条件

- **远端主机**：一台能通过 SSH 登录的 **Linux** 主机（或用 **WSL**）。
- **远端环境**：远端主机上已安装 **Node.js ≥ 20** 和 **npm**（编辑器需要它们把 server 部署并跑起来）。
- **本地 SSH**：本地已配置好 `~/.ssh/config` 或能直接用 `user@host[:port]` 免密登录（SSH 密钥认证）。连接过程会以非交互方式（BatchMode）运行 `ssh`，如果登录需要你手输密码，连接会失败——请先配好密钥。

## 连接流程

1. 打开命令面板（`Ctrl+Shift+P`），运行 **Remote-SSH: Connect to Host…**；或在左侧 **远程资源管理器** 里点击某台主机的连接图标。
2. 在弹出的列表里选择 `~/.ssh/config` 里的主机，或直接输入 `user@host[:port]`。
3. 编辑器通过 SSH 连上远端，自动部署并启动 server（首次连接会慢一些，进度会显示在窗口底部）。
4. 部署完成后，在远端主机的主目录里选择一个文件夹，作为工作区打开。

之后就可以像操作本地文件夹一样浏览、打开、搜索远端文件了。

## 命令速查

这些命令都归在命令面板的 **Remote-SSH** 分类下，当前显示英文原名：

| 命令 | 作用 |
| --- | --- |
| Connect to Host… | 连接一台主机（或输入 `user@host[:port]`）并打开远端文件夹 |
| Open Folder on Host… | 在已连接的主机上另选文件夹打开 |
| Close Connection | 关闭到某主机的连接（若正打开着它的工作区，会先关掉该工作区） |
| Retry Connection | 重试一条失败的连接 |
| Stop Remote Server | 停止远端主机上的 server 并断开连接 |

## 状态栏指示器

当当前工作区是远端工作区时，状态栏**最左侧**会出现一个 `SSH: <主机>` 条目，它同时反映了连接状态：

- **已连接**：显示 `SSH: <主机>`，带远端图标。
- **连接中**（部署 / 转发 / 握手）：显示 `SSH: <主机> (Connecting...)`，图标转圈。
- **重连中**：显示 `SSH: <主机> (Reconnecting...)`，图标同步动画。
- **失败**：显示 `SSH: <主机> (Failed)`，前缀带警告符号。

点击该条目会弹出菜单，包含 **Open Folder on Host…**、**Close Connection**、**Retry Connection**、**Stop Remote Server** 四个动作。

## 断线自动重连

远端连接意外中断（比如 SSH 掉线）时，编辑器会自动尝试透明重连：

- 掉线超过约 1 秒，弹出「Connection to <主机> lost. Reconnecting...」的进度通知。
- 重连成功：关闭进度通知，并短暂提示「Reconnected to <主机>.」。
- 重连失败：弹出错误通知，提供 **Retry**（重试连接）和 **Close Remote Workspace**（关闭远端工作区）两个按钮。

短暂的网络抖动（1 秒内即恢复）不会弹通知，避免闪烁。

## 远程资源管理器

左侧活动栏有一个**远程资源管理器**标签页，分三组：

- **SSH Targets**：`~/.ssh/config` 里的主机 + 你手动添加的主机。每行有状态圆点（灰=未连、绿=已连、橙=连接中、红=失败）；已连接的主机可直接「在主机上打开文件夹」，未连接的显示连接图标。右上角 **+** 可以手动添加 `user@host[:port]`，手动添加的条目旁有「忘记」按钮可删除。
- **Connections**：当前活跃连接列表，按状态提供 打开文件夹 / 重试 / 关闭 / 停止 server 等动作。
- **Recent**：最近打开过的远端工作区，点击可重新打开，悬停可移除。

## 排障

- **看日志**：远端 server 的日志在远端主机的 `~/.universe-editor-server/server.log`。部署、连接、转发失败，先去这里找具体报错。
- **停止 server**：想彻底停掉远端那台进程，运行 **Remote-SSH: Stop Remote Server**（或在状态栏条目菜单 / 远程资源管理器里点停止）。
- **开发期自定义启动命令**：开发模式下可用环境变量 `UNIVERSE_REMOTE_SERVER_CMD` 指定启动远端 server 的命令（用于联调自建 server，仅开发环境生效）。

## 下一步

- [界面导览](../getting-started/interface-tour.md)
- [打开第一个项目](../getting-started/first-project.md)

## 相关阅读

- [命令速查表](../reference/command-reference.md)
- [排障指南](../reference/troubleshooting.md)
