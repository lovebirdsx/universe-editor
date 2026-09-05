# 冲突解决与进阶设置

收尾篇：处理冲突、Blame 溯源，以及所有 Perforce 相关设置。承接[Changelist 与搁置](./changelists-and-shelving.md)。

## 目录

- [冲突解决（resolve）](#冲突解决resolve)
- [Blame：这行是谁改的](#blame这行是谁改的)
- [设置一览](#设置一览)
- [密钥安全](#密钥安全)
- [排错](#排错)

## 冲突解决（resolve）

当仓库里有了比你 have 版本更新的改动，[拉取](./sync-and-status.md)或[取出搁置](./changelists-and-shelving.md#取出搁置unshelve)时可能需要 **resolve**。待解决的文件会聚到一个置顶的 **需要合并** 组里（没有需要合并的文件时不显示）。

三种解决方式，都在该组文件行的行内按钮 / 右键菜单上：

- **解决冲突**（自动合并，`p4 resolve -am`）：让 Perforce 尝试自动合并。能自动合并的文件被直接解决；有真正冲突的文件保持待解决状态。**完成后有明确反馈**——比如「已自动合并 2 个，1 个仍需手动解决」，并带 **解决冲突** 按钮直接打开剩余文件的三向合并编辑器；全部已解决（本次没有实际合并发生时）提示「解决冲突完成」。
- **接受我的版本**（`p4 resolve -ay`）：丢弃对方的改动、保留你的。会先确认（提示「对方的改动将被丢弃」）。
- **接受对方的版本**（`p4 resolve -at`）：丢弃你的本地改动、采纳对方的。会先确认（提示「你的本地改动将被丢弃」）。

对整个 changelist 一键解决：在该组组头上选 **解决 Changelist 冲突**（自动合并该组全部待解决文件）。

### 三向合并编辑器

对仍有真正冲突的文件，选 **在合并编辑器中解决** 打开三向合并编辑器：左侧**基准** = 你的 have 版本（`#have`），右侧**传入** = 服务器 head 版本（`#head`），结果窗格预填磁盘上的文件（含 p4 冲突标记）。在结果里手动合并后**保存即接受**——保存会把合并结果作为「我的版本」解决掉该文件。

和 Git 冲突一样，打开含这些标记的文件时，每处冲突上方会浮现一行操作按钮：**Accept Current Change**（保留 YOURS，即你的工作区版本）、**Accept Incoming Change**（采纳 THEIRS，即仓库版本）、**Accept Both Changes**、**Compare Changes**（并排对比两侧）。点选后标记自动清除。

## Blame：这行是谁改的

Perforce 文件同样支持行内 **Blame（溯源）**，与 Git 共用同一界面：底层用 `p4 annotate` 得到每行归属的 changelist，再取该 changelist 的描述与作者。

- 打开 Blame 的方式、行内提示的显示偏好，都沿用 [Git 的 Blame 说明](../git/blame-and-history.md)。
- 显示相关的 `scm.blame.*` 偏好设置对 Perforce 文件同样生效——它们控制的是**界面呈现**，与后端是 Git 还是 Perforce 无关。

## 设置一览

在[设置](../customization/settings.md)里搜索 `perforce`：

| 设置项 | 作用 | 默认 |
|---|---|---|
| `perforce.port` | 兜底 `P4PORT`（`server:port`） | 空 |
| `perforce.user` | 兜底 `P4USER` | 空 |
| `perforce.client` | 兜底 `P4CLIENT` | 空 |
| `perforce.autoEdit` | 编辑未签出文件时自动 `p4 edit` | 关 |
| `perforce.reconcileHint.enabled` | 在资源管理器中标记磁盘上改过但未签出的文件（改动徽标 M/A/D，其父文件夹随之变色），见[收集改动](./daily-workflow.md#收集改动reconcile)。只检查当前显示在屏幕上的行，开销随可见行数而非 depot 规模增长；作用范围跟随聚焦目录 | 开 |
| `perforce.reconcileScan.maxBatchDurationMs` | 后台预热扫描单个目录批次的时间上限（毫秒，默认 10000），超时批次自动拆分子目录 | 10000 |
| `perforce.reconcile.excludeFolders` | reconcile 时忽略的目录列表（数组，支持相对/绝对路径）。收集祖先目录时会递归裁剪掉被排除的子目录 | `[]` |
| `perforce.refreshInterval` | 轮询刷新间隔（秒，最小 10，`0` 关闭） | 关 |
| `perforce.openedByOthers.autoCheck` | 后台「他人占用」扫描 + 灰字 | 开 |
| `perforce.openedByOthers.intervalSec` | 两次「他人占用」扫描的最小间隔秒数（最小 30） | 300 |
| `perforce.commandTimeout` | 单个 p4 进程最长存活秒数，超时强杀（`0` 不限制）。约束「永久挂死」而非「执行慢」——卡死在冻结网络盘上的 p4 不会再无限期占住并发槽 | 600 |
| `perforce.cache.enabled` | 缓存 p4 结果以减少服务器往返 | 开 |
| `perforce.cache.workspaceTtl` | 工作区状态缓存有效期（毫秒，`0` 关闭工作区缓存） | 4000 |
| `perforce.cache.diskLimitMb` | 不可变历史数据磁盘缓存上限（MB，`0` 关闭落盘） | 50 |

连接类设置只作兜底，推荐优先用 `p4 set` / P4CONFIG，见[概览与连接](./overview.md#连接是怎么建立的)。

### 关于目录排除

`perforce.reconcile.excludeFolders` 的排除只作用于 reconcile 的**发现**（资源管理器改动徽标）、**收集**（收集改动）与 `p4 clean`（还原未收集的工作区偏离）：被排除的目录不参与后台预热扫描与改动探测，右键收集改动时被排除的选区会被跳过，收集祖先目录时会递归裁剪掉被排除的子目录。它**不影响已签出文件的 `p4 revert`**——已签出文件在 SCM 面板里本就可见、是显式收集过的，还原照常作用。改动该配置后，命令与资源管理器徽标**即时生效**；只有后台预热扫描需要**重载窗口**才会按新配置重跑（扫描每会话一次，已染色的目录不会即时清场）。

### 关于缓存

因为每次 p4 操作都要往返服务器，集成会缓存结果以提速：

- **不可变历史数据**（已提交变更的详情、某个具体版本的文件内容）永不改变，会被缓存并**跨会话落盘**——重开 [Perforce Graph](./perforce-graph.md) 或查看历史 diff 无需再次请求服务器。
- **工作区状态**（已打开文件、路径映射等）可能变化，只做短时（`workspaceTtl`）缓存，且**任何变更操作后立即失效**，因此界面里的操作总能看到最新结果。`workspaceTtl` 只影响「编辑器之外」（例如命令行 `p4`、他人）改动后被察觉的延迟；把它设为 `0` 可关闭工作区缓存（不可变历史缓存仍生效）。

## 密钥安全

密码 / ticket **绝不写入明文设置文件，也不经任何网络协议明文传输**。登录凭据交给 `p4` 自身按 `P4TICKETS` 机制保存，集成不自行保管。这与本编辑器对所有敏感凭据的一致红线相同。

## 排错

- **面板不出现**：确认 `p4` 在 `PATH` 中，且该文件夹在某个 Perforce 客户端根目录下（`p4 info` 能报出 client root）。
- **提示未登录 / 会话过期**：用面板 ⋯ 菜单的**登录**重新登录。
- **看不到最新服务器状态**：手动**刷新**，或开启 `perforce.refreshInterval` 轮询。
- **改了文件但面板里没有**：普通改动会出现在面板的 **Working Tree Changes** 组；若该组隐藏、资源管理器也没有改动徽标，说明文件已签出且没有未收集改动，或已被[收集改动](./daily-workflow.md#收集改动reconcile)。想把它收进某个 changelist，在资源管理器右键 **收集改动** 即可。
- **想看底层命令**：在面板标题栏 ⋯ 菜单选 **显示输出**，打开 **Perforce 输出**底栏看完整日志。

更多通用问题见[常见问题](../reference/faq.md)与[疑难排查](../reference/troubleshooting.md)。
