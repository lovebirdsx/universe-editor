/** Localization stub for the perforce extension. Keys + English defaults
 *  establish the translation contract; ZH_CN provides the current Chinese
 *  surface. Mirrors extensions/git/src/nls.ts (manifest NLS is a separate
 *  mechanism — see package.nls*.json). */

const ZH_CN: Readonly<Record<string, string>> = {
  // client.ts
  'perforce.input.placeholder': '默认 changelist 的提交描述',
  'perforce.group.default': '默认 Changelist',
  'perforce.group.defaultShort': '默认',
  'perforce.group.numbered': '#{0}: {1}',
  'perforce.group.numberedNoDesc': '#{0}',
  'perforce.group.shelved': '已搁置的文件',
  'perforce.group.reconcile': '待收集的改动',
  'perforce.group.resolve': '需要合并',
  // status-bar busy labels (spinner text during long p4 operations)
  'perforce.busy.edit': '正在签出',
  'perforce.busy.add': '正在标记新增',
  'perforce.busy.delete': '正在标记删除',
  'perforce.busy.revert': '正在还原',
  'perforce.busy.reconcile': '正在收集改动',
  'perforce.busy.submit': '正在提交',
  'perforce.busy.reopen': '正在移动文件',
  'perforce.busy.shelve': '正在搁置',
  'perforce.busy.unshelve': '正在取出搁置',
  'perforce.busy.resolve': '正在解决冲突',
  'perforce.busy.change': '正在更新 changelist',
  'perforce.busy.deleteChangelist': '正在删除 changelist',
  'perforce.busy.deleteShelved': '正在删除搁置的文件',
  'perforce.busy.refresh': '正在刷新',
  'perforce.busy.openChange': '正在打开更改',
  'perforce.busy.openMergeEditor': '正在打开合并编辑器',
  'perforce.busy.sync': '正在拉取',
  'perforce.busy.generic': '正在处理',
  // command titles reused at runtime
  'perforce.command.commit': '提交',
  'perforce.command.submit.title': '提交',
  'perforce.command.revertUnchanged.title': '还原未改动的文件',
  'perforce.command.openChange.title': '打开更改',
  'perforce.command.openMergeEditor.title': '在合并编辑器中解决',
  // login prompt
  'perforce.login.prompt': 'Perforce 密码 / ticket',
  // mutating command confirmations + buttons
  'perforce.btn.delete': '标记删除',
  'perforce.delete.confirm': '将 “{0}” 标记为删除？',
  'perforce.delete.confirmMany': '将 {0} 个文件标记为删除？',
  'perforce.btn.revert': '还原',
  'perforce.revert.confirm': '还原 “{0}”？本地更改将丢失。',
  'perforce.revert.confirmMany': '还原 {0} 个文件？本地更改将丢失。',
  'perforce.btn.revertAll': '全部还原',
  'perforce.revertChangelist.confirm': '还原 {0} 中的所有文件？本地更改将丢失。',
  'perforce.btn.submit': '提交',
  'perforce.submit.confirmDefault': '将默认 changelist 提交到 depot？此操作不可撤销。',
  'perforce.submit.confirmNumbered': '将 changelist #{0} 提交到 depot？此操作不可撤销。',
  'perforce.submit.noDescription': '请先填写 changelist 描述。',
  // changelist management / shelve / resolve (Phase 3)
  'perforce.newChangelist.prompt': '新建 changelist 的描述',
  'perforce.reopen.placeholder': '将文件移动到 changelist',
  'perforce.reopen.newChangelist': '新建 Changelist…',
  'perforce.editChangelist.prompt': 'Changelist 描述',
  'perforce.shelve.defaultEmpty': '默认 changelist 没有可搁置的文件。',
  'perforce.shelve.defaultPrompt': '搁置到的新建 changelist 的描述',
  'perforce.btn.unshelve': '取出搁置',
  'perforce.unshelveByNumber.prompt': '要取出搁置的 changelist 编号',
  'perforce.unshelveByNumber.invalid': '请输入数字形式的 changelist 编号。',
  'perforce.unshelveByNumber.confirm':
    '取出 changelist #{0} 的搁置内容？将覆盖其涉及文件的本地副本。',
  'perforce.btn.deleteShelved': '删除搁置',
  'perforce.deleteShelved.confirm': '删除 changelist #{0} 中已搁置的文件？',
  'perforce.deleteShelved.confirmFile': '删除已搁置的文件 “{0}”？',
  'perforce.btn.deleteChangelist': '删除 Changelist',
  'perforce.deleteChangelist.notEmpty':
    'Changelist #{0} 仍有已打开的文件。请先移动或还原它们再删除。',
  'perforce.deleteChangelist.confirm': '删除 changelist #{0}？其中已搁置的文件也会被删除。',
  'perforce.revertReconcile.confirm': '放弃 “{0}” 的工作区改动？此操作不可撤销。',
  'perforce.revertReconcile.confirmMany': '放弃 {0} 个文件的工作区改动？此操作不可撤销。',
  // resolve（解决冲突）
  'perforce.btn.acceptYours': '接受我的版本',
  'perforce.btn.acceptTheirs': '接受对方的版本',
  'perforce.resolveAcceptYours.confirm': '接受我的版本解决 “{0}”？对方的改动将被丢弃。',
  'perforce.resolveAcceptYours.confirmMany': '接受我的版本解决 {0} 个文件？对方的改动将被丢弃。',
  'perforce.resolveAcceptTheirs.confirm': '接受对方的版本解决 “{0}”？你的本地改动将被丢弃。',
  'perforce.resolveAcceptTheirs.confirmMany':
    '接受对方的版本解决 {0} 个文件？你的本地改动将被丢弃。',
  'perforce.resolve.summary': '已自动合并 {0} 个，{1} 个仍需手动解决。',
  'perforce.resolve.done': '已自动合并 {0} 个文件。',
  'perforce.resolve.still': '{0} 个文件仍需手动解决。',
  'perforce.resolve.completed': '解决冲突完成。',
  'perforce.openMergeEditor.notControlled': '该文件不在 depot 中，无法进行三方合并。',
  'perforce.mergeEditor.yours': '我的版本',
  'perforce.mergeEditor.yoursRev': '我的版本（have #{0}）',
  'perforce.mergeEditor.theirs': '对方的版本',
  'perforce.mergeEditor.theirsRev': '对方的版本（head #{0}）',
  // sync（拉取版本）
  'perforce.syncPick.placeholder': '要拉取哪个版本？',
  'perforce.syncPick.head': '最新版本',
  'perforce.syncPick.changelist': '指定 changelist 时的版本…',
  'perforce.syncPick.date': '指定日期时的版本…',
  'perforce.syncPick.rev': '指定修订号…',
  'perforce.syncPick.force': '强制拉取最新版本（覆盖本地文件）',
  'perforce.syncPrompt.changelist': 'Changelist 编号',
  'perforce.syncPrompt.date': '日期（yyyy/mm/dd，可带时间）',
  'perforce.syncPrompt.rev': '修订号',
  'perforce.btn.forceSync': '强制拉取',
  'perforce.sync.forceConfirm':
    '强制拉取会覆盖本地文件，即使 Perforce 认为它们已是最新。其中未收集的改动将丢失，且此操作不可撤销。',
  'perforce.sync.failed': '拉取版本失败。{0}',
  'perforce.btn.collectChanges': '收集改动',
  'perforce.sync.upToDate': '已是最新版本。',
  'perforce.sync.refusedModified': '{0} 个文件未更新——它们有尚未收集的本地修改',
  'perforce.btn.viewRefusedDiff': '查看差异',
  'perforce.sync.refusedPickDiff': '选择一个文件查看它未收集的本地修改',
  'perforce.sync.refusedNoLocalPath': '无法显示差异：被跳过的文件没有映射到当前工作区。',
  'perforce.sync.unrecognized': '拉取版本没有返回可识别的结果，详情请查看 Perforce 输出。',
  'perforce.sync.applied': '已更新 {0} 个文件',
  'perforce.sync.keptOpen': '{0} 个已跳过（正在签出中）',
  'perforce.sync.mustResolve': '{0} 个需要合并',
  'perforce.btn.resolveNow': '解决冲突',
  'perforce.previewSync.failed': '无法预览将要拉取的内容。',
  'perforce.previewSync.placeholder': '共有 {0} 个文件将被拉取——选择一个可直接打开',
  'perforce.copyDepotPath.notControlled': '该文件不在 depot 中。',
  // 落后感知（Explorer 灰字 + 状态栏）
  // 三条 deco 描述是语言无关的符号（↓ / ✎），无需翻译；tooltip 仍按语言翻译。
  'perforce.deco.behind.tooltip':
    '可更新——服务器上有更新版本（{0} #{1}）。用「拉取最新版本」获取。',
  'perforce.status.behind': '{0} 个可更新',
  'perforce.status.behind.capped': '超过 {0} 个可更新',
  'perforce.status.behind.tooltip': '点击选择要将此工作区拉取到的变更列表',
  // 落后变更列表选择 + 同步进度
  'perforce.behindPick.failed': '无法列出此工作区落后的变更列表。',
  'perforce.behindPick.head': '最新版本',
  'perforce.behindPick.headDetail': '拉取整个作用域到最新已提交的修订',
  'perforce.behindPick.partial': '部分已拉取',
  'perforce.behindPick.detail': '拉取作用域到 @{0} 时的状态',
  'perforce.behindPick.older': '更早的变更列表…',
  'perforce.behindPick.placeholder': '选择要将此工作区拉取到的变更列表',
  'perforce.behindPick.placeholderUnclassified': '无法判断哪些已同步——显示最近的变更列表',
  'perforce.behindPick.placeholderNone':
    '所列范围内没有待定的变更列表——选择最新版本，或输入更早的编号',
  'perforce.sync.progressTitleHead': '拉取最新版本',
  'perforce.sync.progressTitle': '拉取 {0}',
  'perforce.sync.progressChecking': '正在检查要更新的内容…',
  'perforce.sync.progressCount': '{0} / {1}{2}',
  'perforce.sync.progressFiles': '{0} 个文件{1}',
  'perforce.busy.behindList': '正在加载变更列表',
  // 他人占用（Explorer 灰字）
  'perforce.deco.occupied.tooltip': '他人占用——{0} 打开着此文件',
  // p4Error.ts
  'perforce.btn.openOutput': '打开 Perforce 输出',
  'perforce.error.offline': 'Perforce 服务器不可达——请检查连接与 P4PORT',
  'perforce.error.sessionExpired': '会话已过期——请重新登录',
  'perforce.error.notLoggedIn': '尚未登录 Perforce 服务器',
  'perforce.error.noClient': '未找到 Perforce 工作区（client）——请检查 P4CLIENT / P4CONFIG',
  'perforce.error.noCli': '未找到 p4 命令行工具——请安装 Helix Core CLI 后重试',
  // sync / resolve guidance (classifySyncError)
  'perforce.error.clobber':
    '文件有未收集的本地修改。可以用强制拉取覆盖（会丢失这些修改），或者先收集修改',
  'perforce.error.mustResolve': '文件存在未解决的冲突，请先解决冲突后再同步',
  'perforce.error.upToDate': '已是最新版本',
  'perforce.error.noSuchFile': '文件不在 depot 中或不在当前 client 视图内',
  // status bar
  'perforce.status.offline': '离线',
  'perforce.status.notLoggedIn': '未登录',
  'perforce.status.tooltip': 'Perforce：{0} · {1} 个已打开，{2} 个待收集',
  'perforce.status.openGraph': '打开 Perforce 图谱',
  'perforce.status.cancelTooltip': '{0} —— 点击可取消',
  // 状态栏修订（#have / #head）
  'perforce.status.revAdded': '新增',
  'perforce.status.revAddedTooltip': '新文件，尚未提交到 depot',
  'perforce.status.revTooltip': '本机修订 #{0}，服务器 head 修订 #{1}',
  'perforce.status.revTooltipBehind': '本机修订 #{0}，服务器已到 #{1} —— 点击拉取此文件的最新版本',
  'perforce.status.revHeadTooltip': '服务器 head 修订 {0}',
  'perforce.status.revHaveTooltip': '本机修订 #{0}',
  // 切换工作区（client）
  'perforce.switchClient.placeholder': '切换到 Perforce 工作区（client）',
  'perforce.switchClient.none': '无法列出 Perforce client。请检查连接并先登录。',
  // timeline (file history)
  'perforce.timeline.providerLabel': 'Perforce 历史',
  'perforce.timeline.pendingChanges': '待定更改',
  'perforce.timeline.openComparison': '打开比较',
  'perforce.timeline.secondsAgo': '{0} 秒前',
  'perforce.timeline.minutesAgo': '{0} 分钟前',
  'perforce.timeline.hoursAgo': '{0} 小时前',
  'perforce.timeline.daysAgo': '{0} 天前',
  'perforce.timeline.weeksAgo': '{0} 周前',
  'perforce.timeline.monthsAgo': '{0} 个月前',
  'perforce.timeline.yearsAgo': '{0} 年前',
  // swarm (P4 Code Review)
  'perforce.command.swarm.requestReview.title': '发起新的 Swarm 审核…',
  'perforce.swarm.notConfigured':
    '尚未配置 Swarm。请设置 perforce.swarm.enabled 与 perforce.swarm.url。',
  'perforce.swarm.ping.ok': '已连接到 Swarm：{0}。',
  'perforce.swarm.error.unauthorized': 'Swarm 认证失败。请登录 Perforce 后重试。',
  'perforce.swarm.btn.login': '登录',
  'perforce.swarm.error.generic': 'Swarm 请求失败：{0}',
  'perforce.swarm.status.tooltip': '打开 Swarm 审核',
  'perforce.swarm.status.count': '{0} 个审核需要你处理',
  'perforce.swarm.status.none': '没有需要你处理的审核',
  'perforce.swarm.requestReview.clPrompt': '要审核的 changelist（编号，或 “default”）',
  'perforce.swarm.requestReview.descPrompt': '审核描述',
  'perforce.swarm.requestReview.reviewersPrompt': '审核人（逗号分隔，可选）。以 ! 前缀表示必选。',
  'perforce.swarm.requestReview.shelveFailed': '无法为审核搁置该 changelist（是否为空？）。',
  'perforce.swarm.requestReview.created': '已创建 Swarm 审核 #{0}。',
  'perforce.swarm.updateReview.clPrompt': '要为本审核重新搁置的 changelist（编号，或 “default”）',
  'perforce.swarm.updateReview.done': '已更新 Swarm 审核 #{0}。',
  'perforce.swarm.updateReview.enterId': '输入审核编号…',
  'perforce.swarm.updateReview.pickPlaceholder': '选择要用 changelist {0} 更新的 Swarm 审核',
  'perforce.swarm.updateReview.noneAuthored': '你没有进行中的审核——请输入要更新的审核编号',
  'perforce.swarm.updateReview.idPrompt': '要更新的 Swarm 审核编号',
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
