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
  pairCertTitle: '期望的证书指纹',
  pairCertHint:
    '本页无法读取实际证书。请打开浏览器的证书详情（接受「不安全」提示时可查看），确认其 SHA-256 指纹与此处及 PC 设置页一致；不一致时不要配对。',

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

  appearanceSection: '外观',
  appearanceThemeLabel: '主题',
  appearanceThemeSystem: '跟随系统',
  appearanceThemeLight: '浅色',
  appearanceThemeDark: '深色',
  appearanceThemeHint: '默认跟随手机系统的深色 / 浅色外观。',

  sessionDisplaySection: '会话显示',
  sessionDisplayOnlyMessage: '仅消息',
  sessionDisplayFull: '完整显示',
  sessionDisplayHint: '仅消息会隐藏思考与普通工具调用，保留对话内容和关键卡片。',

  sessionConfirmSection: '会话操作确认',
  sessionConfirmClose: '关闭会话前确认',
  sessionConfirmCloseHint: 'Agent 正在运行、等待审批或还有后台任务时，关闭前先确认。',
  sessionConfirmRemove: '移除会话前确认',
  sessionConfirmRemoveHint: '移除会删除会话、子任务和历史记录，且无法恢复。',
  sessionConfirmHint:
    '在确认弹层勾选「不再提示」会关闭对应确认；两个开关相互独立，可随时在这里重新开启。',

  fullscreenSection: '全屏显示',
  fullscreenEnter: '进入全屏',
  fullscreenExit: '退出全屏',
  fullscreenHint: '隐藏浏览器的地址栏与工具栏；按 Esc 或点击「退出全屏」可恢复。',
  fullscreenUnsupported:
    '当前浏览器不支持网页全屏。iPhone 或旧版 iPad 请用 Safari 的「分享 → 添加到主屏幕」，从主屏幕打开即可隐藏浏览器界面。',

  notificationsSection: '通知',
  notificationsHint: '通知只包含会话标题与提醒类别，经 Apple / Google 推送服务转发。',
  notificationsEnable: '开启通知',
  notificationsDisable: '关闭通知',
  notificationsEnabling: '正在开启…',
  notificationsDisabling: '正在关闭…',
  notificationsEnabled: '通知已开启',
  notificationsKindsLabel: '提醒类型',
  notificationsKindPermission: '等待审批',
  notificationsKindQuestion: 'Agent 提问',
  notificationsKindCompleted: '已完成',
  notificationsKindErrored: '出错',
  notificationsAlwaysNotify: 'PC 前也通知',
  notificationsAlwaysNotifyHint: 'PC 窗口聚焦时也发送手机通知。',
  notificationsCapabilitySecure: '安全上下文（HTTPS）',
  notificationsCapabilityPush: 'PushManager',
  notificationsCapabilityStandalone: '已添加到主屏幕',
  notificationsCapabilityYes: '可用',
  notificationsCapabilityNo: '不可用',
  notificationsUnsupportedInsecure:
    '通知需要 HTTPS。请通过 Tailscale 的 HTTPS 地址打开本应用；HTTP 局域网地址无法使用推送。',
  notificationsUnsupportedNotification: '当前浏览器不支持系统通知。',
  notificationsUnsupportedPush: '当前浏览器不支持 Web Push。',
  notificationsUnsupportedIos:
    '在 iPhone / iPad 上，请先在 Safari 中「分享 → 添加到主屏幕」，再从主屏幕图标打开本应用。',
  notificationsNoVapid: 'PC 端推送尚未就绪，请确认网关已开启后重试。',
  notificationsDenied: '通知权限被拒绝，请在系统设置中允许通知。',
  notificationsFailed: '开启通知失败，请重试。',
  notificationsOpenSession: '查看会话',
  notificationPermissionTitle: (title: string): string => `等待审批：${title}`,
  notificationQuestionBody: 'Agent 提问',
  notificationCompletedBody: '已完成',
  notificationErroredBody: '出错',

  inboxTitle: '收件箱',
  inboxEmpty: 'PC 上暂无进行中的 Agent 会话',
  inboxLoading: '正在连接 PC…',
  inboxWaitingSnapshot: '已连接，正在获取会话…',
  inboxReconnecting: '离线·重连中，正在尝试重新连接…',
  inboxOfflineBanner: '与 PC 的连接已断开，正在重连。列表可能不是最新。',
  inboxVersionMismatch: '手机端与 PC 版本不一致，请刷新页面。',
  updateAvailable: 'PC 端已更新，刷新页面即可使用新版本。',
  updateReload: '刷新',
  updateDismiss: '关闭提示',
  inboxRefresh: '刷新页面',
  shellFromCacheNotice:
    '当前页面来自缓存，可能不是最新版本。若一直显示离线，请清除该网站的浏览数据后重新打开。',

  connectionDiagnosticTitle: '连接诊断',
  connectionDiagnosticOrigin: '当前地址',
  connectionDiagnosticRetry: '立即重试',
  connectionDiagnosticRecheck: '重新检查',
  connectionDiagnosticRefresh: '刷新页面',
  connectionDiagnosticUnreachable: (origin: string): string => `无法访问 ${origin}`,
  connectionDiagnosticUnreachableBody: '手机没有收到 PC 网关的 HTTP 响应。请依次检查：',
  connectionDiagnosticHintSameNetwork: '手机和 PC 在同一个 Wi-Fi 或局域网。',
  connectionDiagnosticHintLocalNetwork: 'iOS：设置 → 隐私与安全 → 本地网络，允许 Safari / Chrome。',
  connectionDiagnosticHintVpn:
    '关闭手机上的 VPN、代理和私人中继；使用 Tailscale 时先确认 PC 在线。',
  connectionDiagnosticHintGateway:
    'PC 上「手机设备」里的网关仍在运行，Windows 防火墙允许专用网络。',
  connectionDiagnosticHintCertificate: '浏览器提示证书不受信任时，先在 Safari 中接受证书。',
  connectionDiagnosticHintClearSiteData:
    '页面能打开但一直离线时，可能运行的是旧缓存：清除该网站的浏览数据（或用无痕窗口）后重新打开并接受证书。',
  connectionDiagnosticHintRootCa:
    '长期使用建议在 PC 设置页切换为根证书模式，并在手机上完全信任根证书。',
  connectionDiagnosticReachable: '已到达 PC，但 WebSocket 握手失败',
  connectionDiagnosticReachableBody:
    'HTTP 已连通，地址和网络基本正常。问题多半在证书信任或 WebSocket：',
  connectionDiagnosticHintCertInstall:
    '局域网档：在 iOS 安装并信任 PC 的根证书，或改用 Tailscale 档。',
  connectionDiagnosticHintHostname: '使用主机名时，确认手机能把它解析到 PC 的局域网 IP。',
  connectionDiagnosticHintRefresh: '刷新手机页面后再试。',
  connectionDiagnosticHintTailscale: '长期使用建议改用 Tailscale 档，它提供受信任的 HTTPS 证书。',
  connectionDiagnosticInstallCa: '下载 PC 根证书',
  connectionDiagnosticInstallCaHint:
    '需先在 PC 上启用「根证书」模式。iOS：Safari 下载后到「设置 → 通用 → VPN 与设备管理」安装，再到「关于本机 → 证书信任设置」开启完全信任。',
  connectionDiagnosticForbidden: '已连接到 PC，但地址被拒绝',
  connectionDiagnosticForbiddenBody:
    'PC 网关不接受当前地址。请改用 PC 设置页显示的局域网 IP，或把该主机名加入允许列表。',
  connectionDiagnosticNotFound: 'PC 网关版本过旧',
  connectionDiagnosticNotFoundBody: '该网关不支持连接诊断接口。请更新 PC 上的编辑器。',
  connectionDiagnosticHttpError: (status: number): string => `PC 返回了 HTTP ${status}`,
  connectionDiagnosticHttpErrorBody: '网关已响应，但请求被拒绝。请查看 PC 上的「手机设备」日志。',
  connectionDiagnosticInvalidResponse: 'PC 返回了非预期响应',
  connectionDiagnosticInvalidResponseBody:
    '可能被代理、门户页或其它服务拦截。请确认地址和端口指向 Universe Editor。',
  connectionDiagnosticProtocolMismatch: 'PC 已更新，手机页面需要刷新',
  connectionDiagnosticProtocolMismatchBody: '刷新页面不会丢失配对凭据。',
  connectionDiagnosticSettingsHint: '检查手机能否通过 HTTP 到达 PC 网关；结果只显示在这台手机上。',

  sessionsTitle: '会话',
  sessionsEntry: '会话',
  sessionsBack: '返回收件箱',
  sessionsRefresh: '刷新',
  sessionsSearchPlaceholder: '搜索标题、内容、Agent 或工作区',
  sessionsFilterAll: '全部',
  sessionsFilterLive: '活跃',
  sessionsFilterClosed: '已关闭',
  sessionsLoading: '正在读取会话…',
  sessionsEmptyTitle: 'PC 上还没有可恢复的会话',
  sessionsEmptyBody: '只显示当前在 PC 上打开的工作区里的历史会话。',
  sessionsNoMatch: '没有找到匹配的会话',
  sessionsOffline: '离线，暂时无法读取会话历史。',
  sessionsOfflineBanner: '与 PC 的连接已断开，正在重连。目录可能不是最新。',
  sessionsOpening: '正在打开…',
  sessionsWillOpenWorkspace: '将在 PC 上打开此工作区',
  sessionsLiveBadge: '活跃',
  sessionsPinnedBadge: '置顶',
  sessionsGroupToday: '今天',
  sessionsGroupYesterday: '昨天',
  sessionsGroupEarlier: '更早',

  guideTitle: '还没有配对',
  guideBody: '在 PC 上打开「手机设备」设置，扫描二维码即可配对；也可以在下方手动输入配对码。',
  guideHint: '手机与 PC 需要能够互相访问（局域网或 Tailscale）。',
  guidePairTitle: '手动输入配对码',

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
  sessionUpdatedHoursAgo: (hours: number): string => `${hours} 小时前`,
  sessionUpdatedDaysAgo: (days: number): string => `${days} 天前`,

  badgePermission: '待审批',
  badgeElicitation: '待提问',
  badgeRemote: '远程',
  badgeReadOnly: '只读',
  badgeBackgroundTasks: (count: number): string => `后台任务 ${count}`,
  badgeWorkspaceDirty: '有修改',
  workspaceDirtyTitle: '工作区有未提交的修改',

  sessionBack: '返回',
  sessionLoading: '正在获取会话…',
  sessionLoadFailedTitle: '会话加载失败',
  sessionLoadFailedBody: 'PC 返回了无法识别的数据，请重试；若一直失败，请在 PC 上重新打开该会话。',
  sessionRetry: '重试',
  sessionRunning: '运行中',
  contextUsageLabel: (used: string, size: string, percent: number): string =>
    `上下文已用 ${used} / ${size} tokens（${percent}%）`,
  sessionTruncated: '时间线较早的内容已省略',
  activityThinking: '正在思考…',
  activityToolFallback: '正在调用工具…',
  activityPrevious: (title: string): string => `上一步 ${title}`,
  activityFailed: '失败',
  activityFailedWithReason: (reason: string): string => `失败：${reason}`,
  activityCancelled: '已取消',
  activitySyntheticDenial: '上游中断',
  sessionRemovedTitle: '会话已在 PC 上关闭',
  sessionRemovedBody: '这个会话已经结束。可以返回收件箱，或重新打开继续对话。',
  sessionReopen: '重新打开',
  sessionReopening: '正在重新打开…',
  sessionReopenFailed: '重新打开失败，请重试。',

  planTitle: (completed: number, total: number): string => `计划 ${completed}/${total}`,
  planExpand: '展开计划',
  planCollapse: '收起计划',
  planStatusPending: '待处理',
  planStatusInProgress: '进行中',
  planStatusCompleted: '已完成',

  thoughtTitle: '思考',
  thoughtExpand: '展开思考',
  thoughtCollapse: '收起思考',

  toolCallGroupTitle: (count: number): string => `执行了 ${count} 个操作`,
  toolCallExpand: '展开操作',
  toolCallCollapse: '收起操作',
  toolCallDetailLoading: '正在获取详情…',
  toolCallDetailError: '详情获取失败，请重试。',
  toolCallDetailRetry: '重试',
  toolCallDiffStats: (added: number, removed: number): string => `+${added} −${removed}`,
  memoryTrimmed: '内容已在 PC 端释放',
  messageNonText: '[包含附件]',

  noticeCompaction: '上下文已压缩',
  noticeResurrection: '会话已恢复',
  noticeDefault: '系统通知',

  pendingPermissionTitle: (title: string): string => `需要确认：${title}`,
  pendingPermissionSheetTitle: '等待你的审批',
  pendingElicitationTitle: (title: string | undefined): string =>
    title === undefined || title === '' ? 'Agent 提问' : `Agent 提问：${title}`,
  pendingElicitationSheetTitle: '回答提问',
  pendingOptionsLabel: '可选操作',
  pendingCancel: '取消',
  pendingOffline: 'PC 离线，暂时无法操作',
  pendingResolvedElsewhere: '已在 PC 上处理',
  pendingAutoExecuting: (seconds: number): string => `将在 ${seconds} 秒后自动执行`,
  pendingAutoPaused: '已暂停（自动执行倒计时）',
  pendingAutoPause: '暂停',
  pendingAutoResume: '继续',
  pendingCountdownLabel: '自动执行倒计时',
  pendingFeedbackLabel: '告诉 Agent 应该如何修改计划（可选）',
  pendingFeedbackPlaceholder: '例如：先补测试，再改实现',
  pendingFeedbackSubmit: '发送意见',
  pendingFeedbackNeedsReject: '当前请求没有可用的拒绝选项，无法发送意见。',
  pendingSubmitting: '处理中…',
  sheetExpand: '展开',
  sheetCollapse: '收起',
  sheetClose: '关闭',

  elicitationRequired: '此项为必填',
  elicitationStringTooShort: (min: number): string => `至少需要 ${min} 个字符`,
  elicitationStringTooLong: (max: number): string => `最多 ${max} 个字符`,
  elicitationPatternMismatch: '格式不正确',
  elicitationNumberInvalid: '请输入数字',
  elicitationIntegerInvalid: '请输入整数',
  elicitationNumberTooSmall: (min: number): string => `不能小于 ${min}`,
  elicitationNumberTooLarge: (max: number): string => `不能大于 ${max}`,
  elicitationMultiTooFew: (min: number): string => `至少选择 ${min} 项`,
  elicitationMultiTooMany: (max: number): string => `最多选择 ${max} 项`,
  elicitationAccept: '提交',
  elicitationDecline: '拒绝',
  elicitationCancel: '取消',
  elicitationUrlHint: '此操作需要在 PC 上完成，请在 PC 上打开上面的链接。',
  elicitationUrlLabel: '链接',
  elicitationTextHint: '请输入你的回答。',

  composerPlaceholder: '给 Agent 发消息…',
  composerPlaceholderWithCommands: '给 Agent 发消息…（/ 指令）',
  composerCommands: '斜杠指令',
  composerSend: '发送',
  composerStop: '停止',
  composerStopping: '正在停止…',
  composerSending: '发送中…',
  composerOffline: 'PC 离线，暂时不能发送消息',
  composerReadOnly: '只读会话不能发送消息',
  composerStopHint: '运行中也可以发送消息（排队给 Agent）',
  composerSendFailed: '发送失败，请重试。',
  composerDraftRestored: '已恢复上次未发送的草稿',
  composerAttach: '添加附件',
  promptRefList: '引用建议',
  promptRefLoading: '正在搜索…',
  promptRefEmpty: '没有匹配的引用',
  promptRefFailed: '引用搜索失败，请重试',
  promptRefKindFile: '文件',
  promptRefKindSymbol: '符号',
  promptRefKindScmChange: '本地修改',
  promptRefKindOpenEditor: '打开的编辑器',
  promptRefKindDocs: '文档',
  promptRefKindCommit: '提交',
  promptRefKindChatContext: '扩展上下文',
  promptRefPickCommit: '选择提交',
  promptRefWaitForPc: '请在电脑上完成选择…',
  promptRefCommitEmpty: '没有可用的提交',
  promptRefBack: '返回',
  attachmentUploading: '上传中…',
  attachmentUploadFailed: '上传失败',
  attachmentRemove: '移除附件',
  attachmentImageAlt: '图片附件',
  attachmentImageLoadFailed: '图片加载失败',
  attachmentTooMany: '最多添加 8 个附件',
  attachmentTooManyImages: '最多添加 5 张图片',
  attachmentImageTooLarge: '单张图片不能超过 5 MB',
  attachmentFileTooLarge: '单个文件不能超过 25 MB',
  attachmentTotalTooLarge: '附件总大小不能超过 50 MB',
  attachmentUnsupportedImage: '仅支持 PNG、JPEG、WebP、GIF 图片',
  draftImageFallbackName: '电脑端图片',
  draftImageOpen: '预览电脑端草稿图片',
  draftImageRemove: '移除电脑端图片',
  draftImageLoadFailed: '图片加载失败',

  imagePreviewTitle: '图片预览',
  imagePreviewClose: '关闭预览',
  imagePreviewOpen: (name: string): string => `预览图片：${name}`,
  imagePreviewGestureHint: '双指缩放 · 双击放大 · 下滑关闭',
  messageImageAlt: '会话图片',
  messageImageOpen: (index: number): string => `预览第 ${index + 1} 张图片`,
  messageImageUnavailable: '图片不可用',
  messageImageLoadFailed: '图片加载失败',
  markdownImageLoadFailed: '图片加载失败',

  configTitle: '会话设置',
  configNoOptions: '暂无可选项',
  configOn: '开',
  configOff: '关',
  configSwitching: '切换中…',
  configCurrent: '当前',
  configOpen: (name: string): string => `切换${name}`,

  subagentChipLabel: '子模型',
  subagentChipOpen: '配置子模型',
  subagentInherit: '跟随主模型',
  subagentSheetDesc:
    '子 Agent（包括本应跟随主模型的内置 Agent）都会使用该模型。它在进程启动时读取，修改后下次会话生效。',
  subagentNextSession: '下次会话生效',
  subagentRestartNow: '立即重启',
  subagentRestarting: '正在重启会话…',
  subagentRestartTitle: '立即重启会话？',
  subagentRestartBody: '重启会中断当前正在运行的任务，会话随后以新的子模型重新连接。',
  subagentRestartConfirm: '重启',
  subagentEmptyCandidates: '当前 Agent 未提供可选的模型列表。',

  mcpChipLabel: 'MCP',
  mcpChipOpen: '配置会话 MCP 服务器',
  mcpSheetTitle: 'MCP 服务器',
  mcpFollowingDefaults: '跟随默认',
  mcpCustomSelection: '自定义选择',
  mcpReset: '恢复默认',
  mcpDefaultOff: '默认关闭',
  mcpEmpty: '当前 Agent 没有可用的 MCP 服务器。',
  mcpCacheHint: '切换会重启会话并失效模型 prompt cache；任务运行中会等当前任务结束后生效。',

  sessionSettingsLoading: '正在读取会话设置…',
  sessionSettingsFailed: '读取会话设置失败。',
  sessionSettingsRetry: '重试',

  sessionMore: '更多操作',
  sessionRename: '重命名会话',
  sessionRenameTitle: '重命名会话',
  sessionRenamePlaceholder: '输入新的会话标题',
  sessionRenameEmpty: '标题不能为空',
  sessionRenameTooLong: '标题过长',
  sessionRenameConfirm: '重命名',
  sessionClose: '关闭会话',
  sessionCloseTitle: '关闭这个会话？',
  sessionCloseBody:
    'Agent 正在运行，关闭会中断当前任务。会话历史会保留，之后可以在 PC 的会话列表里恢复。',
  sessionCloseConfirm: '关闭会话',
  sessionRemove: '移除会话',
  sessionRemoveTitle: '移除这个会话？',
  sessionRemoveBody: '会话及其子任务会从 Agent 端删除，历史记录也会一并删除，且无法恢复。',
  sessionRemoveConfirm: '移除',
  sessionNeverAskAgain: '不再提示',
  sessionActionFailed: '操作失败，请重试。',

  sessionReportAction: '查看报告',
  sessionReportTitle: '运行报告',
  sessionReportLoading: '正在读取报告…',
  sessionReportEmpty: '本次运行没有生成报告内容。',
  sessionReportRunning: '本次运行尚未结束，报告生成后可在这里查看。',
  sessionReportUnavailable: '本次运行没有可查看的报告（可能尚未生成或已被清理）。',
  sessionReportHostOffline: '远程主机未连接，报告暂不可用。',
  sessionReportTooLarge: '报告过大，无法在手机上打开。',
  sessionReportFailed: '读取报告失败，请稍后重试。',
  sessionReportRefresh: '刷新',
  sessionReportClose: '关闭报告',

  deliveryAction: '交付',
  deliveryPendingBadge: '待交付',
  deliveryConfirmTitle: '交付到 main',
  deliveryConfirmIntro:
    '把这条会话所在 worktree 的提交合入 main，确认推送后再同步其它 worktree。全程不会 force push。',
  deliveryPreviewLoading: '正在检查仓库状态…',
  deliveryPreviewFailed: '无法读取交付信息。',
  deliveryBlockers: '暂时无法交付',
  deliveryWarnings: '注意',
  deliverySourceLabel: '源 worktree',
  deliveryTargetLabel: '目标',
  deliverySourceDirty: (files: number, untracked: number): string =>
    `有未提交改动：${files} 个已修改，${untracked} 个未跟踪`,
  deliveryDirtyNote: '交付时会先由 Agent 基于这条会话生成提交信息，再由编辑器提交。',
  deliveryCommitsLabel: (count: number): string => `待交付提交（${count}）`,
  deliveryNoCommits: '源 worktree 没有需要交付的新提交。',
  deliveryStart: '开始交付',
  deliveryStarting: '正在开始交付…',
  deliveryCancel: '取消',
  deliveryClose: '关闭',
  deliveryLoading: '正在加载交付详情…',
  deliveryDetailFailed: '无法读取交付详情。',
  deliveryConfirmPush: '确认推送',
  deliveryConfirmPushTitle: '确认推送到远端？',
  deliveryConfirmPushBody: 'main 将前移到交付提交并推送到远端，不会 force push。',
  deliveryRetry: '重试',
  deliveryRetrying: '正在重试…',
  deliveryAgain: '再次交付',
  deliveryUndo: '撤销本次交付',
  deliveryUndoTitle: '撤销这次交付？',
  deliveryUndoBody:
    '未推送时会直接恢复 main；已推送时会创建 revert 提交并再次推送，不会 force push。',
  deliveryUndoing: '正在撤销…',
  deliveryOpenMainWorktree: '打开 main worktree',
  deliveryOpeningMainWorktree: '正在打开…',
  deliveryDetailTitle: '交付详情',
  deliveryOpenSession: '进入会话',
  deliveryErrorLabel: '错误',
  deliveryPushUnverified:
    '推送已完成，但暂时无法连接远端确认。请点「重试」完成验证与 worktree 同步。',
  deliveryPhaseUnverified: '推送待确认',
  deliveryConflictLabel: (count: number): string => `冲突文件（${count}）`,
  deliveryWorktreesLabel: 'worktree 同步',
  pushBranchAction: '推送分支',
  pushBranchTitle: '推送分支',
  pushBranchIntro: '把这个会话所在分支推送到远端，不改动 main，也不会 force push。',
  pushBranchPreviewLoading: '正在检查分支状态…',
  pushBranchPreviewFailed: '无法读取分支信息。',
  pushBranchSourceLabel: '分支',
  pushBranchRemoteLabel: '远端',
  pushBranchTargetLabel: '远端分支名',
  pushBranchTargetHint: '临时分支可以改个名字，避免在远端留下一次性分支。',
  pushBranchNewRemote: (remote: string): string => `${remote} 还没有这个分支，推送后会创建。`,
  pushBranchExistingRemote: (remote: string, ahead: number, behind: number): string => {
    if (behind > 0) return `${remote} 有 ${behind} 个本地没有的提交。`
    if (ahead === 0) return `${remote} 已有这个分支，且没有新提交。`
    return `本地领先 ${remote} ${ahead} 个提交。`
  },
  pushBranchDirty: (files: number, untracked: number): string =>
    `有未提交改动（${files} 个已修改，${untracked} 个未跟踪），不会被推送。`,
  pushBranchBlockers: '暂时无法推送',
  pushBranchStart: '推送',
  pushBranchStarting: '正在推送…',
  pushBranchCancel: '取消',
  pushBranchSuccess: (remote: string, branch: string): string => `已推送到 ${remote}/${branch}`,
  pushBlockerText: (code: string, fallback: string): string => {
    switch (code) {
      case 'remote_diverged':
        return '远端分支有本地没有的提交，请先在电脑上同步。'
      case 'nothing_to_push':
        return '这个分支的提交都已经在远端了。'
      case 'source_in_progress':
        return '分支上有进行中的 Git 操作，请先在电脑上完成。'
      case 'invalid_branch':
        return '远端分支名不合法。'
      case 'fetch_failed':
        return '连接远端失败，请检查网络后重试。'
      default:
        return fallback
    }
  },
  deliveryPushLabel: '推送',
  deliveryPushedTo: (ref: string): string => `已推送到 ${ref}`,
  deliverySummaryDirty: '包含新提交',
  deliverySummaryCommits: (count: number): string => `${count} 个提交`,
  deliverySummarySync: (synced: number, skipped: number, failed: number): string => {
    const parts = [`${synced} 个已同步`]
    if (skipped > 0) parts.push(`${skipped} 个跳过`)
    if (failed > 0) parts.push(`${failed} 个失败`)
    return parts.join(' · ')
  },
  deliveryPhaseLabel: (phase: string): string => {
    switch (phase) {
      case 'preflighting':
        return '准备中'
      case 'committing':
        return '提交中'
      case 'cherry_picking':
        return '合入中'
      case 'resolving_conflict':
        return '解决冲突'
      case 'awaiting_push':
        return '待推送'
      case 'pushing':
        return '推送中'
      case 'syncing':
        return '同步中'
      case 'synced':
        return '已交付'
      case 'partial':
        return '部分同步'
      case 'failed':
        return '交付失败'
      case 'undoing':
        return '撤销中'
      case 'undone':
        return '已撤销'
      default:
        return phase
    }
  },
  deliveryWorktreeStatusLabel: (status: string): string => {
    switch (status) {
      case 'synced':
        return '已同步'
      case 'up_to_date':
        return '已是最新'
      case 'skipped_dirty':
        return '有未提交改动，已跳过'
      case 'skipped_in_progress':
        return '有进行中的操作，已跳过'
      case 'skipped_diverged':
        return '有独立提交，已跳过'
      case 'skipped_source_changed':
        return '源 worktree 已变化，已跳过'
      case 'failed':
        return '同步失败'
      default:
        return status
    }
  },
  deliverySummaryTitle: (total: number): string => `交付 · ${total} 条进行中或待处理`,
  deliverySummaryActive: (count: number): string => `${count} 条进行中`,
  deliverySummaryPushable: (count: number): string => `${count} 条待推送`,
  deliverySummaryFailed: (count: number): string => `${count} 条需处理`,
  deliveryAlertAwaitingPushTitle: '交付待确认推送',
  deliveryAlertAwaitingPushBody: (title: string): string =>
    `「${title}」的交付已准备就绪，确认后推送。`,
  deliveryAlertFailedTitle: '交付失败',
  deliveryAlertFailedBody: (title: string): string =>
    `「${title}」的交付失败，可在收件箱查看详情。`,
  deliveryAlertPartialTitle: '交付部分同步',
  deliveryAlertPartialBody: (title: string): string =>
    `「${title}」已推送，但部分 worktree 同步失败。`,
  deliveryStartFailedTitle: '交付未开始',

  newSessionTitle: '新建会话',
  newSessionBack: '返回收件箱',
  newSessionAgentLabel: '选择 Agent',
  newSessionWorkspaceLabel: '选择工作区',
  newSessionSubmit: '创建会话',
  newSessionSubmitting: '正在创建…',
  newSessionLoading: '正在读取 Agent 与工作区…',
  newSessionNoAgents: 'PC 上还没有可用的 Agent。',
  newSessionNoWorkspaces: 'PC 上没有可用的工作区。',
  newSessionWorkspaceOpen: '已打开',
  newSessionWorkspaceRemote: '远程',
  newSessionWorkspaceWillOpen: '将在 PC 上打开此工作区',
  newSessionFailed: '创建会话失败，请重试。',
  newSessionAdd: '新建会话',
  newSessionRequired: '请选择 Agent 和工作区。',
  newSessionSearchLabel: '搜索工作区',
  newSessionSearchPlaceholder: '搜索名称或路径',
  newSessionGroupOpen: '已打开',
  newSessionGroupRecent: '最近',
  newSessionNoMatch: '没有找到匹配的工作区',
  newSessionDirectoryLabel: '会话目录',
  newSessionDirectoryRoot: '工作区根目录',
  newSessionDirectoryHint: '只能选择工作区内的目录。',
  newSessionDirectoryInvalid: '所选目录已失效，请重新选择。',

  directoryPickerTitle: '选择会话目录',
  directoryPickerProjectRoots: '项目根',
  directoryPickerUp: '上一级',
  directoryPickerSelect: '选择此目录',
  directoryPickerLoading: '正在读取目录…',
  directoryPickerEmpty: '没有子目录',
  directoryPickerTruncated: '目录过多，仅显示前一部分。',
  directoryPickerFailed: '无法读取目录，请重试。',
  directoryPickerRetry: '重试',
  directoryPickerInvalid: '目录不存在或已失效。',
  directoryPickerWorkspaceUnavailable: '工作区已失效，请重新选择工作区。',

  messageActionsTitle: '消息操作',
  messageActionCopyText: '复制文本',
  messageActionCopyImage: '复制成图片',
  messageActionRewind: '回退到这条消息',
  messageActionFork: '从此处分叉',
  messageActionSideTask: '就此追问',
  messageCopyTextBusy: '正在复制…',
  messageCopyImageBusy: '正在生成图片…',
  messageCopyTextDone: '文本已复制',
  messageCopyTextFailed: '复制失败，请重试。',
  messageCopyImageDone: '图片已复制',
  messageCopyImageFailed: '生成图片失败，请重试。',
  messageCopyImageTooLarge: '消息太长，无法生成图片，请改用复制文本。',
  messageCopyImageUnavailable: '图片功能未加载，请刷新页面后重试。',
  forkBusy: '会话正在运行，完成后再分叉。',

  copyImagePreviewTitle: '复制成图片',
  copyImagePreviewHint: '长按图片可拷贝或存储，也可以使用下方按钮。',
  copyImagePreviewCopy: '复制图片',
  copyImagePreviewShare: '分享图片',
  copyImagePreviewSave: '保存图片',
  copyImagePreviewCopyFailed: '复制失败，请长按图片拷贝。',
  copyImagePreviewShareFailed: '分享失败，请长按图片保存。',

  rewindTitle: '回退会话',
  rewindLoading: '正在检查能否回退…',
  rewindCannot: '无法回退到这条消息。',
  rewindImpact: (files: number, insertions: number, deletions: number): string =>
    `将影响 ${files} 个文件（+${insertions} −${deletions}）`,
  rewindImpactFiles: (files: number): string => `将影响 ${files} 个文件`,
  rewindNoFiles: '不会改动文件',
  rewindDiscard: '丢弃文件改动并回退',
  rewindKeep: '保留文件改动并回退',
  rewindCancel: '取消',
  rewindApplying: '正在回退…',
  rewindDone: '已回退，原文已填入输入框',

  sideTasksTitle: '侧边任务',
  sideTasksNew: '新侧边任务',
  sideTasksMenu: '侧边任务',
  sideTasksLoading: '正在获取侧边任务…',
  sideTasksEmpty: '还没有侧边任务',
  sideTasksDelete: '删除',
  sideTasksDeleteConfirm: '确认删除',
  sideTasksDeleteCancel: '取消',
  sideTasksLiveBadge: '活动',
  sideTaskParent: (title: string): string => `来自：${title}`,
  sideTaskUntitled: '新侧边任务',
  sessionForkTip: '从末尾分叉',

  jumpToLatest: '↓ 新消息',
  loadEarlier: '加载更早的',
  markdownImage: (alt: string | undefined): string =>
    alt === undefined ? '[图片]' : `[图片：${alt}]`,
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

const COMMAND_ERRORS: Readonly<Record<string, string>> = {
  unauthorized: '登录已失效，请重新配对。',
  forbidden_operation: '该操作不允许在手机上执行。',
  session_not_found: '会话不存在或已关闭。',
  session_read_only: '只读会话不能执行此操作。',
  attachment_not_found: '附件不存在或已过期，请重新添加。',
  stale_request: '请求已在别处处理。',
  workspace_not_open: '目标工作区尚未在 PC 上打开，请先在 PC 上打开该工作区。',
  not_supported: '当前版本不支持该操作，请升级编辑器。',
  unsupported_by_agent: '当前 Agent 不支持该操作。',
  invalid_anchor: '这条消息不能用于该操作。',
  session_busy: '会话正在运行，请稍后再试。',
  rate_limited: '操作过于频繁，请稍后再试。',
  protocol_mismatch: '手机与 PC 版本不一致，请刷新页面。',
  bad_request: '请求参数无效。',
  internal: 'PC 端处理失败，请重试。',
  timeout: 'PC 未响应，请检查连接后重试。',
  network: '与 PC 的连接已断开，请稍后重试。',
  invalid_response: 'PC 返回了无法识别的结果。',
  cancelled: '操作已取消。',
  delivery_busy: '该仓库正在交付，请等待当前交付完成。',
  delivery_not_found: '交付记录不存在或已被清理。',
  delivery_conflict: '仓库状态已变化，请重新交付。',
  delivery_unsupported: '当前仓库或编辑器版本不支持交付。',
  push_busy: '该仓库正在交付或推送，请稍后再试。',
  push_conflict: '远端分支已变化，请刷新后重试。',
  push_unsupported: '当前分支不支持推送。',
  push_failed: '推送失败，请检查网络或远端权限。',
}

export function commandErrorText(code: string | undefined): string {
  if (code === undefined) return strings.sessionActionFailed
  return COMMAND_ERRORS[code] ?? strings.sessionActionFailed
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024
    return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
