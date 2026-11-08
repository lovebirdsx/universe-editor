/**
 * All user-visible copy for the M1 phone PWA. Keeping it in one module makes a
 * later i18n pass a mechanical replacement instead of a JSX crawl.
 */
export const strings = {
  appName: 'Universe 遥控',
  appTagline: '在手机上查看并遥控 PC 编辑器里的 agent 会话',

  pairTitle: '连接 PC 编辑器',
  pairIntro: '在 PC 上打开「手机设备」设置并扫描二维码。也可以手动输入配对码。',
  pairCodeLabel: '配对码',
  pairCodePlaceholder: 'XXXX-XXXX',
  pairCodeHint: '配对码 2 分钟内有效，且只能使用一次。',
  pairDeviceNameLabel: '设备名称',
  pairDeviceNamePlaceholder: '例如：我的手机',
  pairSubmit: '开始配对',
  pairSubmitting: '配对中…',
  pairInvalidCode: '请输入 8 位配对码（形如 XXXX-XXXX）。',
  pairMissingDeviceName: '请输入设备名称。',

  pairErrorUnauthorized: '配对码无效或已过期，请在 PC 上重新生成。',
  pairErrorRateLimited: '尝试次数过多，请稍后再试。',
  pairErrorBadRequest: '配对码格式不正确，请检查后重试。',
  pairErrorForbidden: 'PC 拒绝了这次配对请求。',
  pairErrorNotSupported: '当前 PC 版本不支持手机配对，请升级编辑器。',
  pairErrorInternal: 'PC 端处理配对失败，请重试。',
  pairErrorNetwork: '无法连接 PC，请确认手机与 PC 在同一网络后重试。',
  pairErrorUnknown: '配对失败，请重试。',
  pairStorageUnavailable: '浏览器存储不可用，配对仅在当前页面有效。',

  statusConnecting: '连接中',
  statusConnected: '已连接',
  statusReconnecting: '离线·重连中',
  statusInvalid: '已失效',
  statusVersionMismatch: '版本不一致',
  statusUnknownPc: 'PC',

  settings: '设置',
  settingsTitle: '设置',
  settingsClose: '关闭',
  settingsDeviceName: '设备名称',
  settingsDeviceId: '设备 ID',
  settingsPcName: 'PC 名称',
  settingsUnpair: '解除配对',
  settingsUnpairHint: '解除后需要重新扫码配对才能继续使用。',

  inboxTitle: '收件箱',
  inboxEmpty: '暂无会话（会话镜像将在后续版本提供）',
  inboxLoading: '正在连接 PC…',
  inboxWaitingSnapshot: '已连接，正在获取会话…',
  inboxReconnecting: '离线·重连中，正在尝试重新连接…',
  inboxVersionMismatch: '手机端与 PC 版本不一致，请刷新页面。',
  inboxRefresh: '刷新页面',

  guideTitle: '还没有配对',
  guideBody: '在 PC 上打开「手机设备」设置，扫描二维码即可配对。',
  guideHint: '手机与 PC 需要能够互相访问（局域网或 Tailscale）。',

  credentialsInvalid: '此设备已被吊销或凭据失效，请重新配对。',
  noticeDismiss: '知道了',

  bucketInputNeeded: '待审批',
  bucketInProgress: '运行中',
  bucketFailed: '出错',
  bucketCompleted: '已完成',

  agentLabel: 'Agent',
  workspaceLabel: '工作区',
  sessionUpdatedJustNow: '刚刚',
  sessionUpdatedMinutesAgo: (minutes: number): string => `${minutes} 分钟前`,
} as const

const PAIR_ERRORS: Readonly<Record<string, string>> = {
  unauthorized: strings.pairErrorUnauthorized,
  invalid: strings.pairErrorUnauthorized,
  expired: strings.pairErrorUnauthorized,
  rate_limited: strings.pairErrorRateLimited,
  bad_request: strings.pairErrorBadRequest,
  forbidden_operation: strings.pairErrorForbidden,
  not_supported: strings.pairErrorNotSupported,
  internal: strings.pairErrorInternal,
  network: strings.pairErrorNetwork,
}

export function pairErrorText(code: string | undefined): string {
  if (code === undefined) return strings.pairErrorUnknown
  return PAIR_ERRORS[code] ?? strings.pairErrorUnknown
}
