# Changelist 与搁置

Perforce 用 **changelist（变更列表）** 组织一组待提交的改动，用 **shelve（搁置）** 把改动暂存到服务器而不提交。承接[日常操作](./daily-workflow.md)。

## 目录

- [编号 changelist](#编号-changelist)
- [在 changelist 之间搬动文件](#在-changelist-之间搬动文件)
- [编辑描述](#编辑描述)
- [搁置（shelve）](#搁置shelve)
- [取出搁置（unshelve）](#取出搁置unshelve)
- [删除搁置](#删除搁置)

## 编号 changelist

默认 changelist 之外，可以建**编号 changelist**，把不同任务的改动分开、分别提交：

- **新建 changelist**：命令面板搜 "Perforce: 新建 changelist"，填描述，得到一个空的编号组。
- 每个编号 changelist 单独一组显示，可单独[提交](./daily-workflow.md#提交)。

## 在 changelist 之间搬动文件

把已签出的文件从一个 changelist 移到另一个，用的是 Perforce 的 `reopen`：

- 在文件行上选**移动到 changelist**，然后选目标（已有的编号 changelist、默认 changelist，或新建一个）。

这样就能把混在默认 changelist 里的改动整理进各自的任务组，再分别提交。

## 编辑描述

- **默认 changelist** 的描述就是面板输入框里的文字。
- **编号 changelist** 的描述可在该组上选**编辑描述**修改。

## 搁置（shelve）

搁置把当前签出的改动**上传到服务器暂存**，本地文件保持不变。适合：换机器继续、给别人 review、或临时腾出工作区。

- 在某个 changelist 组上选**搁置**，该组的改动被 shelve 到服务器。
- 搁置的文件以单独的搁置组显示，带 `S` 标记、置灰。

## 取出搁置（unshelve）

**取出搁置**把服务器上暂存的改动拉回工作区，重新变成签出状态：

- 在搁置组或搁置文件上选**取出搁置**。
- 若与本地已有改动冲突，会进入[冲突解决](./resolve-and-advanced.md#冲突解决resolve)流程。

## 删除搁置

不再需要的搁置可以清掉：在搁置组 / 文件上选**删除搁置**，它从服务器移除。注意这不影响你工作区里的文件。

---

下一步：[冲突解决与进阶设置](./resolve-and-advanced.md)
