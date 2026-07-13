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
  // command titles reused at runtime
  'perforce.command.commit': '提交',
  'perforce.command.submit.title': '提交',
  'perforce.command.revertUnchanged.title': '还原未改动的文件',
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
  // p4Error.ts
  'perforce.btn.openOutput': '打开 Perforce 输出',
  'perforce.error.offline': 'Perforce 服务器不可达——请检查连接与 P4PORT',
  'perforce.error.sessionExpired': '会话已过期——请重新登录',
  'perforce.error.notLoggedIn': '尚未登录 Perforce 服务器',
  'perforce.error.noClient': '未找到 Perforce 工作区（client）——请检查 P4CLIENT / P4CONFIG',
  'perforce.error.noCli': '未找到 p4 命令行工具——请安装 Helix Core CLI 后重试',
  // status bar
  'perforce.status.offline': '离线',
  'perforce.status.notLoggedIn': '未登录',
  'perforce.status.tooltip': 'Perforce：{0} · {1} 个已打开，{2} 个待收集',
  // swarm (P4 Code Review)
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
  'perforce.swarm.notify.one': '审核 #{0} 需要你处理。',
  'perforce.swarm.notify.many': '有 {0} 个新审核需要你处理。',
  'perforce.swarm.notify.open': '打开',
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
