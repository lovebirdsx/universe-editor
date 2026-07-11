/** Localization stub for the perforce extension. Keys + English defaults
 *  establish the translation contract; ZH_CN provides the current Chinese
 *  surface. Mirrors extensions/git/src/nls.ts (manifest NLS is a separate
 *  mechanism — see package.nls*.json). */

const ZH_CN: Readonly<Record<string, string>> = {
  // client.ts
  'perforce.input.placeholder': '默认 changelist 的提交描述',
  'perforce.group.default': '默认 Changelist',
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
  'perforce.btn.revert': '还原',
  'perforce.revert.confirm': '还原 “{0}”？本地更改将丢失。',
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
  'perforce.shelve.needNumbered': '只有编号的 changelist 才能搁置。',
  'perforce.btn.deleteShelved': '删除搁置',
  'perforce.deleteShelved.confirm': '删除 changelist #{0} 中已搁置的文件？',
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
