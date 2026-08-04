/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Help-menu Action2 commands: open the built-in guide documents.
 *  *  Help commands. ShowReleaseNotes opens a markdown tab with the full version
 *  history (the upgrade-time "what's new" tab is driven by ReleaseNotesContribution).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorService,
  IEditorGroupsService,
  INotificationService,
  IOpenerService,
  MenuId,
  Severity,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DocEditorInput } from '../services/editor/DocEditorInput.js'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import { IDiagnosticsService } from '../../shared/ipc/services.js'
import { ReleaseNotesInput } from '../services/editor/ReleaseNotesInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { renderReleaseNotesMarkdown } from '../services/releaseNotes/releaseNotes.js'
import { buildIssueUrl } from '../services/diagnostics/issueUrl.js'

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

export class ShowReleaseNotesAction extends Action2 {
  static readonly ID = 'workbench.action.showReleaseNotes'
  constructor() {
    super({
      id: ShowReleaseNotesAction.ID,
      title: localize2('releaseNotes.show', 'Show Release Notes'),
      category: localize2('command.category.help', 'Help'),
      menu: { id: MenuId.MenubarHelpMenu, group: '0_docs', order: 3 },
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
 * fingerprints), copies it to the clipboard, then offers the issue page
 * (pre-filled body, degrading to paste-from-clipboard when too long) and the
 * diagnostics zip export.
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
    const diagnostics = accessor.get(IDiagnosticsService)
    const notifications = accessor.get(INotificationService)
    const opener = accessor.get(IOpenerService)
    const markdown = await diagnostics.collectIssueReport()
    await navigator.clipboard.writeText(markdown)
    notifications.notify({
      severity: Severity.Info,
      message: localize('reportIssue.copied', '诊断摘要已复制到剪贴板，可直接粘贴到 Issue 中。'),
      sticky: true,
      actions: [
        {
          label: localize('reportIssue.openIssuePage', '打开 Issue 页面'),
          run: () => {
            void opener.open(
              buildIssueUrl(
                markdown,
                localize(
                  'reportIssue.pasteHint',
                  '（诊断信息较长，请从剪贴板粘贴 / paste the diagnostics summary from your clipboard）',
                ),
              ),
            )
          },
        },
        {
          label: localize('reportIssue.exportZip', '导出诊断包'),
          run: () => {
            void exportDiagnostics(diagnostics, notifications)
          },
          isSecondary: true,
        },
      ],
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
      message: localize('exportDiagnostics.done', '诊断包已导出：{path}', { path: zipPath }),
    })
  } catch (err) {
    notifications.notify({
      severity: Severity.Error,
      message: localize('exportDiagnostics.failed', '诊断包导出失败：{message}', {
        message: err instanceof Error ? err.message : String(err),
      }),
    })
  }
}
