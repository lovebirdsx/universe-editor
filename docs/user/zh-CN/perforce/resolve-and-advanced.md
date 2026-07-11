# 冲突解决与进阶设置

收尾篇：处理冲突、Blame 溯源，以及所有 Perforce 相关设置。承接[Changelist 与搁置](./changelists-and-shelving.md)。

## 目录

- [冲突解决（resolve）](#冲突解决resolve)
- [Blame：这行是谁改的](#blame这行是谁改的)
- [设置一览](#设置一览)
- [密钥安全](#密钥安全)
- [排错](#排错)

## 冲突解决（resolve）

当仓库里有了比你 have 版本更新的改动，提交或[取出搁置](./changelists-and-shelving.md#取出搁置unshelve)时可能需要 **resolve**：

- 在文件或 changelist 组上选**解决冲突**，集成运行 Perforce 的自动合并（`p4 resolve -am`）。
- 能自动合并的文件会被合并；无法自动合并的会保留标记，供你手动处理后再提交。

## Blame：这行是谁改的

Perforce 文件同样支持行内 **Blame（溯源）**，与 Git 共用同一界面：底层用 `p4 annotate` 得到每行归属的 changelist，再取该 changelist 的描述与作者。

- 打开 Blame 的方式、行内提示的显示偏好，都沿用 [Git 的 Blame 说明](../git/blame-and-history.md)。
- 显示相关的 `git.blame.*` 偏好设置对 Perforce 文件同样生效——它们控制的是**界面呈现**，与后端是 Git 还是 Perforce 无关。

## 设置一览

在[设置](../customization/settings.md)里搜索 `perforce`：

| 设置项 | 作用 | 默认 |
|---|---|---|
| `perforce.port` | 兜底 `P4PORT`（`server:port`） | 空 |
| `perforce.user` | 兜底 `P4USER` | 空 |
| `perforce.client` | 兜底 `P4CLIENT` | 空 |
| `perforce.autoEdit` | 编辑未签出文件时自动 `p4 edit` | 关 |
| `perforce.autoReconcile` | 每次刷新时扫描[待收集的改动](./daily-workflow.md#收集改动reconcile)（大工作区可能较慢） | 关 |
| `perforce.autoRefresh` | 监视工作区磁盘，文件变化时自动刷新并扫描待收集改动（去抖） | 开 |
| `perforce.refreshInterval` | 轮询刷新间隔（秒，最小 10，`0` 关闭） | 关 |
| `perforce.cache.enabled` | 缓存 p4 结果以减少服务器往返 | 开 |
| `perforce.cache.workspaceTtl` | 工作区状态缓存有效期（毫秒，`0` 关闭工作区缓存） | 4000 |
| `perforce.cache.diskLimitMb` | 不可变历史数据磁盘缓存上限（MB，`0` 关闭落盘） | 50 |

连接类设置只作兜底，推荐优先用 `p4 set` / P4CONFIG，见[概览与连接](./overview.md#连接是怎么建立的)。

### 关于缓存

因为每次 p4 操作都要往返服务器，集成会缓存结果以提速：

- **不可变历史数据**（已提交变更的详情、某个具体版本的文件内容）永不改变，会被缓存并**跨会话落盘**——重开 [Perforce Graph](./perforce-graph.md) 或查看历史 diff 无需再次请求服务器。
- **工作区状态**（已打开文件、路径映射等）可能变化，只做短时（`workspaceTtl`）缓存，且**任何变更操作后立即失效**，因此界面里的操作总能看到最新结果。`workspaceTtl` 只影响「编辑器之外」（例如命令行 `p4`、他人）改动后被察觉的延迟；把它设为 `0` 可关闭工作区缓存（不可变历史缓存仍生效）。

## 密钥安全

密码 / ticket **绝不写入明文设置文件，也不经任何网络协议明文传输**。登录凭据交给 `p4` 自身按 `P4TICKETS` 机制保存，集成不自行保管。这与本编辑器对所有敏感凭据的一致红线相同。

## 排错

- **面板不出现**：确认 `p4` 在 `PATH` 中，且该文件夹在某个 Perforce 客户端根目录下（`p4 info` 能报出 client root）。
- **提示未登录 / 会话过期**：用面板 ⋯ 菜单的**登录**重新登录。
- **看不到最新服务器状态**：手动**刷新**；默认开启的文件监视会在磁盘改动时自动刷新（`perforce.autoRefresh`），也可开启 `perforce.refreshInterval` 轮询。
- **改了文件但面板里没有**：默认的文件监视会把未签出改动收进[待收集的改动](./daily-workflow.md#收集改动reconcile)；若关掉了 `perforce.autoRefresh`，用**刷新（清理）**或[收集改动](./daily-workflow.md#收集改动reconcile)手动收进来。
- **想看底层命令**：点状态栏客户端名，打开 **Perforce 输出**面板看完整日志。

更多通用问题见[常见问题](../reference/faq.md)与[疑难排查](../reference/troubleshooting.md)。
