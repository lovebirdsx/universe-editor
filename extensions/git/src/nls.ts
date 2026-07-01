/** Localization stub for the git extension. Keys + English defaults establish the
 *  translation contract; ZH_CN provides the current Chinese surface. */

const ZH_CN: Readonly<Record<string, string>> = {
  // repository.ts
  'git.input.placeholder': '消息（Ctrl+Enter 提交）',
  'git.group.staged': '暂存的更改',
  'git.group.changes': '更改',
  'git.progress.committing': '正在提交…',
  'git.progress.amendingCommit': '正在修正提交…',
  'git.progress.undoing': '正在撤销…',
  'git.progress.syncing': '正在同步…',
  'git.progress.pulling': '正在拉取…',
  'git.progress.pushing': '正在推送…',
  'git.btn.forcePush': '强制推送',
  'git.push.forceConfirm': '强制推送到远程？这将覆盖远程分支历史，可能导致他人的提交丢失。',
  'git.remote.none': '未配置远程仓库。',
  'git.pick.remoteToPush': '选择要推送到的远程仓库',
  'git.progress.fetching': '正在获取…',
  'git.stash.noChanges': '没有可储藏的更改。',
  'git.pick.stashToPop': '选择要弹出的储藏',
  'git.pick.stashToApply': '选择要应用的储藏',
  'git.pick.stashToDrop': '选择要删除的储藏',
  'git.pick.branchToMerge': '选择要合并到当前分支的分支',
  'git.pick.branchToRebase': '选择要变基到的分支',
  'git.input.newBranchName': '新分支名称',
  'git.branch.noOtherToDelete': '没有其他分支可删除。',
  'git.pick.branchToDelete': '选择要删除的分支',
  'git.btn.delete': '删除',
  'git.branch.notFullyMerged': '分支"{0}"尚未完全合并，仍然删除？',
  'git.branch.noneToPublish': '没有分支可发布。',
  'git.pick.remote': '选择远程仓库',
  'git.progress.publishing': '正在发布…',
  'git.input.remoteName': '远程仓库名称（如 origin）',
  'git.input.remoteUrl': '远程仓库 URL',
  'git.pick.remoteToRemove': '选择要移除的远程仓库',
  'git.input.tagName': '标签名称',
  'git.tag.noneToDelete': '没有标签可删除。',
  'git.pick.tagToDelete': '选择要删除的标签',
  'git.progress.updatingSubmodules': '正在更新子模块…',
  'git.btn.discardAll': '放弃所有更改',
  'git.discard.allConfirm': '放弃工作区中的所有更改？此操作无法撤销。',
  'git.pick.branchToCheckout': '选择要签出的分支',
  'git.branch.noneAvailable': '没有可用的分支。',
  'git.stash.none': '没有储藏。',
  // extension.ts
  'git.commit.noMessage': '请先输入提交消息。',
  'git.commit.noChanges': '没有可提交的更改。',
  'git.commit.noCommitsToAmend': '没有可修正的提交。',
  'git.btn.discardChanges': '放弃更改',
  'git.discard.fileConfirm': '放弃"{0}"中的更改？此操作无法撤销。',
  // repositoryWorktrees.ts
  'git.worktree.createNewBranch': '新建分支…',
  'git.pick.branchForWorktree': '选择要从其创建工作区的分支',
  'git.input.worktreeLocation': '工作区位置',
  'git.progress.creatingWorktree': '正在创建工作区…',
  'git.progress.initializingSubmodules': '正在初始化子模块…',
  'git.worktree.submoduleInitFailed': '新工作区中子模块初始化失败：{0}',
  'git.btn.openInNewWindow': '在新窗口中打开',
  'git.btn.open': '打开',
  'git.worktree.created': '工作区已在 {0} 创建。',
  'git.worktree.noneToOpen': '没有其他工作区可打开。',
  'git.pick.openWorktreeInNewWindow': '在新窗口中打开工作区',
  'git.pick.openWorktree': '打开工作区',
  'git.worktree.noneToDelete': '没有工作区可删除。',
  'git.pick.worktreeToDelete': '选择要删除的工作区',
  'git.worktree.dirtyConfirm': '工作区"{0}"有更改或已锁定，仍然删除？',
  'git.progress.deinitializingSubmodules': '正在反初始化子模块…',
  'git.worktree.busy':
    '无法删除工作区"{0}"：其文件夹正在使用中。请关闭在 {1} 上打开的所有编辑器窗口或终端后重试。',
  // gitError.ts
  'git.btn.openGitLog': '打开 Git 日志',
  'git.error.notFullyMerged': '该分支有未合并的提交——使用强制删除可丢弃这些提交',
  'git.error.nonFastForward': '远程仓库有您本地没有的提交——请先拉取，或使用强制推送',
  'git.error.localChanges': '请先提交或储藏您的本地更改',
  'git.error.conflict': '请解决冲突后继续',
  'git.error.notFound': '不存在该分支、标签或提交',
  'git.error.remoteUnreachable': '远程仓库不可达——请检查 URL 和网络连接',
  'git.error.authFailed': '身份验证失败——请检查您的凭据',
}

const useZhCn = (process.env.UNIVERSE_DISPLAY_LOCALE ?? '').toLowerCase().startsWith('zh')

export function localize(
  key: string,
  defaultMessage: string,
  vars?: Record<string, unknown>,
): string {
  const template = (useZhCn ? ZH_CN[key] : undefined) ?? defaultMessage
  if (!vars) return template
  return template.replace(/\{([^}]+)\}/g, (match, rawKey) => {
    const k = String(rawKey).trim()
    const v = vars[k]
    return v === undefined ? match : String(v)
  })
}
