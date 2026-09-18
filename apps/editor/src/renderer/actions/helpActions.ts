/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Help-menu Action2 commands: open the built-in guide documents.
 *  *  Help commands. ShowReleaseNotes opens a markdown tab with the full version
 *  history (the upgrade-time "what's new" tab is driven by ReleaseNotesContribution).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IConfigurationService,
  IDialogService,
  IEditorService,
  IEditorGroupsService,
  IHostService,
  ILifecycleService,
  INotificationService,
  IOpenerService,
  IQuickInputService,
  MenuId,
  Severity,
  ShutdownReason,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DocEditorInput } from '../services/editor/DocEditorInput.js'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import {
  IDiagnosticsService,
  IIssueReporterService,
  type HeapSnapshotStatus,
} from '../../shared/ipc/services.js'
import { describeHeapSnapshotStatus } from '../services/diagnostics/heapSnapshotMessages.js'
import {
  clearReloadArmIntent,
  rendererSessionStorage,
  writeReloadArmIntent,
} from '../services/diagnostics/diagnosisReloadSession.js'
import { ReleaseNotesInput } from '../services/editor/ReleaseNotesInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { renderReleaseNotesMarkdown } from '../services/releaseNotes/releaseNotes.js'
import { runReportIssueFlow } from '../services/issueReporter/reportIssue.js'

export class OpenDocsAction extends Action2 {
  static readonly ID = 'workbench.action.openDocs'
  constructor() {
    super({
      id: OpenDocsAction.ID,
      title: localize2('action.openDocs.title', 'Documentation'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 0 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new DocEditorInput('index'))
  }
}

export class OpenEditorGuideAction extends Action2 {
  static readonly ID = 'workbench.action.openEditorGuide'
  constructor() {
    super({
      id: OpenEditorGuideAction.ID,
      title: localize2('action.openEditorGuide.title', 'Editor Guide'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 1 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new DocEditorInput('getting-started/interface-tour'))
  }
}

export class OpenAgentGuideAction extends Action2 {
  static readonly ID = 'workbench.action.openAgentGuide'
  constructor() {
    super({
      id: OpenAgentGuideAction.ID,
      title: localize2('action.openAgentGuide.title', 'Agent Guide'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 2 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new DocEditorInput('ai-agent/overview'))
  }
}

export class OpenExtensionDocsAction extends Action2 {
  static readonly ID = 'workbench.action.openExtensionDocs'
  constructor() {
    super({
      id: OpenExtensionDocsAction.ID,
      title: localize2('action.openExtensionDocs.title', 'Extension Development'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 3 },
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    accessor.get(IEditorService).openEditor(new DocEditorInput('README', 'extensionDev'))
  }
}

export class ShowReleaseNotesAction extends Action2 {
  static readonly ID = 'workbench.action.showReleaseNotes'
  constructor() {
    super({
      id: ShowReleaseNotesAction.ID,
      title: localize2('releaseNotes.show', 'Show Release Notes'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 4 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const releaseNotes = accessor.get(IReleaseNotesService)
    const groups = accessor.get(IEditorGroupsService)
    const { notes } = await releaseNotes.getReleaseNotes()
    const markdown =
      notes.length > 0
        ? renderReleaseNotesMarkdown(notes)
        : localize('releaseNotes.empty', 'No release notes are available.')
    const input = new ReleaseNotesInput(
      markdown,
      localize('releaseNotes.title', 'Release Notes'),
      'all',
    )
    openInLockAwareGroup(groups, input, { activate: true, pinned: true })
  }
}

/**
 * Report Issue (VSCode parity: workbench.action.openIssueReporter). Builds the
 * diagnostics markdown (versions / system / extensions / top error
 * fingerprints), copies it to the clipboard, then delegates to the configured
 * issue-report provider (tracker by default, GitHub optional) for a pre-filled
 * issue URL. Providers with attachment support (tracker) first ask whether to
 * upload the diagnostics zip alongside the report. The orchestration lives in
 * services/issueReporter/reportIssue.ts.
 */
export class ReportIssueAction extends Action2 {
  static readonly ID = 'workbench.action.openIssueReporter'
  constructor() {
    super({
      id: ReportIssueAction.ID,
      title: localize2('action.reportIssue.title', 'Report Issue...'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '1_feedback', order: 0 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await runReportIssueFlow({
      diagnostics: accessor.get(IDiagnosticsService),
      issueReporter: accessor.get(IIssueReporterService),
      notifications: accessor.get(INotificationService),
      opener: accessor.get(IOpenerService),
      quickInput: accessor.get(IQuickInputService),
      configuration: accessor.get(IConfigurationService),
      writeClipboard: (text) => navigator.clipboard.writeText(text),
    })
  }
}

/** Standalone zip export — also reachable after the Report Issue toast is gone. */
export class ExportDiagnosticsAction extends Action2 {
  static readonly ID = 'workbench.action.exportDiagnostics'
  constructor() {
    super({
      id: ExportDiagnosticsAction.ID,
      title: localize2('action.exportDiagnostics.title', 'Export Diagnostics Package...'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '1_feedback', order: 1 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await exportDiagnostics(accessor.get(IDiagnosticsService), accessor.get(INotificationService))
  }
}

async function exportDiagnostics(
  diagnostics: IDiagnosticsService,
  notifications: INotificationService,
): Promise<void> {
  try {
    const zipPath = await diagnostics.exportDiagnosticsZip()
    notifications.notify({
      severity: Severity.Info,
      message: localize('exportDiagnostics.done', 'Diagnostics bundle exported: {path}', {
        path: zipPath,
      }),
    })
  } catch (err) {
    notifications.notify({
      severity: Severity.Error,
      message: localize(
        'exportDiagnostics.failed',
        'Failed to export diagnostics bundle: {message}',
        {
          message: err instanceof Error ? err.message : String(err),
        },
      ),
    })
  }
}

/**
 * 堆快照前的同意闸门。用户同意的不是「跑个命令」：写对象图的这几秒到几十秒里 renderer 会
 * 冻结，产物是那个堆里所有字符串的副本（文件内容、提示词、凭据），而且已经开始的一次抓取停
 * 不下来。跳过这个对话框的命令，等于在这四件事上撒谎。
 */
export async function confirmHeapSnapshotStart(dialogs: IDialogService): Promise<boolean> {
  const result = await dialogs.confirm({
    type: 'warning',
    message: localize('heapSnapshot.confirm.message', 'Start memory diagnosis for this window?'),
    detail: localize(
      'heapSnapshot.confirm.detail',
      "Only this window is diagnosed; other windows are not affected.\n\nTaking a snapshot pauses this window for seconds to tens of seconds — the editor will not respond while it runs.\n\nThe snapshot contains whatever the heap held, which may include file contents, session text or credentials. It is written only to this machine, under the editor's user data folder, and is never uploaded automatically.\n\nDiagnosis stops by itself after 2 hours, on reload and on close. Stopping it does not cancel a snapshot that has already started.",
    ),
    primaryButton: localize('heapSnapshot.confirm.start', 'Start Diagnosis'),
    cancelButton: localize('heapSnapshot.confirm.cancel', 'Cancel'),
  })
  return result.confirmed
}

/**
 * 内存诊断在 Help 菜单里的落点：`5_tools` 组，排在日志/用户数据/安装目录之后。三条命令都**不带
 * icon**——`registerAction2` 会把 `desc.icon` 撒进它声明的每个菜单槽位，而菜单栏下拉一旦有任意
 * 一项带图标就会整组开启图标列（`TitleBarDropdown.tsx`），所以 `iconCoverage.test.ts` 断言
 * File/Edit/View/Help 一律无图标。palette 侧也不读命令图标（`CommandsQuickAccessProvider`）。
 *
 * **同一件事只有一条通知通路**：开局、拒绝、结束都由轮次自己的事件流报（`HeapSnapshotNotification
 * Contribution`），命令只报事件报不出来的那几种——重复点开始、服务没接上、IPC 失败。否则用户在
 * 一次开始里读到两条「内存诊断已开启」。
 */
export class StartHeapSnapshotDiagnosticsAction extends Action2 {
  static readonly ID = 'workbench.action.startHeapSnapshotDiagnostics'
  constructor() {
    super({
      id: StartHeapSnapshotDiagnosticsAction.ID,
      title: localize2('action.startHeapSnapshotDiagnostics.title', 'Start Memory Diagnosis'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 5 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // Every service is taken before the first await: the accessor is invalid past it.
    const diagnostics = accessor.get(IDiagnosticsService)
    const dialogs = accessor.get(IDialogService)
    const notifications = accessor.get(INotificationService)

    let current: HeapSnapshotStatus
    try {
      current = await diagnostics.getHeapSnapshotStatus()
    } catch (err) {
      reportCommandFailure(notifications, err)
      return
    }
    // 已经在跑：再点一次是对状态的询问，不是新一轮（重新武装不会给新的额度），所以这里
    // 只回状态，也不再弹同意框——用户上一次已经同意过了。
    if (current.active) {
      notifications.notify({
        severity: Severity.Info,
        message: describeHeapSnapshotStatus(current),
        sticky: false,
      })
      return
    }

    if (!(await confirmHeapSnapshotStart(dialogs))) return

    let status: HeapSnapshotStatus
    try {
      status = await diagnostics.startHeapSnapshotRound()
    } catch (err) {
      reportCommandFailure(notifications, err)
      return
    }
    // 开局与拒绝（无渲染进程 / 额度用尽）都由轮次事件自己报。唯一没有事件可等的结局是
    // 这一版根本没有接上快照服务——那时用户点了「开始」却什么都不会发生。
    if (status.phase === 'off') {
      notifications.notify({
        severity: Severity.Error,
        message: localize(
          'heapSnapshot.unavailable',
          'Memory diagnosis is not available in this build, so nothing was started.',
        ),
      })
    }
  }
}

/** 停住后续抓取。已经在跑的那次如实报告，绝不声称已取消。 */
export class StopHeapSnapshotDiagnosticsAction extends Action2 {
  static readonly ID = 'workbench.action.stopHeapSnapshotDiagnostics'
  constructor() {
    super({
      id: StopHeapSnapshotDiagnosticsAction.ID,
      title: localize2('action.stopHeapSnapshotDiagnostics.title', 'Stop Memory Diagnosis'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 6 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const diagnostics = accessor.get(IDiagnosticsService)
    const notifications = accessor.get(INotificationService)
    let status: HeapSnapshotStatus
    try {
      // 用户主动停止是静默的：控制器不再为它发事件，所以这一条就是用户看到的那一条。
      status = await diagnostics.stopHeapSnapshotRound()
    } catch (err) {
      reportCommandFailure(notifications, err)
      return
    }
    notifications.notify(
      status.phase === 'capturing'
        ? {
            // There is no cancel API: saying "stopped" here would have the user believe
            // the freeze ended while it has not.
            severity: Severity.Warning,
            sticky: true,
            message: localize(
              'heapSnapshot.stop.inFlight',
              'No further snapshots will be taken. One is being written right now and cannot be cancelled — the window stays paused until it finishes.',
            ),
          }
        : {
            severity: Severity.Info,
            message: describeHeapSnapshotStatus(status),
          },
    )
  }
}

/**
 * 服务调用失败必须说出来：命令点了却没反应，用户只会以为按钮坏了。
 */
function reportCommandFailure(notifications: INotificationService, err: unknown): void {
  notifications.notify({
    severity: Severity.Error,
    message: localize('heapSnapshot.commandFailed', 'Memory diagnosis failed: {message}', {
      message: err instanceof Error ? err.message : String(err),
    }),
  })
}

/** 打开快照目录。路径由 main 决定；renderer 永远不传路径进来。 */
export class OpenHeapSnapshotsFolderAction extends Action2 {
  static readonly ID = 'workbench.action.openHeapSnapshotsFolder'
  constructor() {
    super({
      id: OpenHeapSnapshotsFolderAction.ID,
      title: localize2('action.openHeapSnapshotsFolder.title', 'Open Memory Snapshots Folder'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 7 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const diagnostics = accessor.get(IDiagnosticsService)
    const notifications = accessor.get(INotificationService)
    try {
      await diagnostics.revealHeapSnapshotsFolder()
    } catch (err) {
      notifications.notify({
        severity: Severity.Error,
        message: localize(
          'heapSnapshot.revealFailed',
          'Could not open the snapshots folder: {message}',
          { message: err instanceof Error ? err.message : String(err) },
        ),
      })
    }
  }
}

/**
 * 「重载窗口并开始内存诊断」——内存提醒里的主操作，单独拿出来也是可发现、可被命令面板与
 * e2e 触发的命令。
 *
 * 为什么不是就地开始：基线必须在小堆上拍（main 侧策略的基线上限 `min(512MiB, 上限/2)`），
 * 而这条命令被用到的场合恰恰是堆已经很大——就地开始只会被策略拒绝，或者逼着去拆保护门槛。
 * 重载把堆换回干净值，轮次随后按设计跑「基线 → 增长」。
 *
 * 重载前把一次性意图写进 sessionStorage，由 reload 之后的 renderer 消费并武装轮次：意图的
 * 生命周期必须是「这一次重载」，所以不能进持久化存储（否则某次冷启动会读到它并自己开一轮）。
 * **顺序是硬性的**：先过否决闸门再写意图——被否决的重载不能留下一个悬着的意图。
 *
 * 否决闸门有两道，且都会真的拦下重载：这一道是 `ILifecycleService.confirmBeforeShutdown`，
 * 另一道藏在 `IHostService.restart()` 内部（它要对 reload 跑完整的 shutdown 序列，其中包含
 * 同一个否决相位）。所以 `restart()` 回 `false` 时必须把意图撤掉——否则窗口没重载，而意图
 * 还活着，之后任意一次重载（用户自己按 Ctrl+Alt+R、扩展触发、窗口崩溃恢复）都会替用户开始
 * 一轮他从没要过的诊断：冻结窗口数十秒、落一份快照、还要吃掉全应用仅有的 4 次采集额度。
 * 意图自带的 90 秒 TTL 挡不住这一点——危害正是发生在被否之后的这 90 秒内。
 *
 * 这个仓库的 reload 没有未保存缓冲区的保护（与 `workbench.action.reloadWindow` 同级：
 * 唯一的否决参与者是 ACP 会话），所以提醒的正文把「会重载」写在了明处，是这条命令的前提。
 */
export class ReloadWindowForMemoryDiagnosisAction extends Action2 {
  static readonly ID = 'workbench.action.reloadWindowForMemoryDiagnosis'
  constructor() {
    super({
      id: ReloadWindowForMemoryDiagnosisAction.ID,
      title: localize2(
        'action.reloadWindowForMemoryDiagnosis.title',
        'Reload Window and Start Memory Diagnosis',
      ),
      category: localize2('command.category.help', 'Help'),
      // 与另外三条内存诊断命令同组、同「不带 icon」的理由（见上文类注释）。
      menu: { id: MenuId.MenubarHelpMenu, group: '5_tools', order: 8 },
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // Every service is taken before the first await: the accessor is invalid past it.
    const host = accessor.get(IHostService)
    const lifecycle = accessor.get(ILifecycleService)
    if (await lifecycle.confirmBeforeShutdown(ShutdownReason.Reload)) return
    writeReloadArmIntent(rendererSessionStorage(), Date.now())
    // On a real reload this resolves into a renderer that is already being torn down, so the
    // line below never gets to run — which is exactly why the intent survives.
    if (!(await host.restart())) clearReloadArmIntent(rendererSessionStorage())
  }
}
