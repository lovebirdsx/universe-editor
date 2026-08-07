/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Help-menu Action2 commands: open the built-in guide documents.
 *  *  Help commands. ShowReleaseNotes opens a markdown tab with the full version
 *  history (the upgrade-time "what's new" tab is driven by ReleaseNotesContribution).
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IConfigurationService,
  IEditorService,
  IEditorGroupsService,
  INotificationService,
  IOpenerService,
  IQuickInputService,
  MenuId,
  Severity,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { DocEditorInput } from '../services/editor/DocEditorInput.js'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import { IDiagnosticsService, IIssueReporterService } from '../../shared/ipc/services.js'
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
 * issue-report provider (iLoop by default, GitHub optional) for a pre-filled
 * issue URL. Providers with attachment support (iLoop) first ask whether to
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
