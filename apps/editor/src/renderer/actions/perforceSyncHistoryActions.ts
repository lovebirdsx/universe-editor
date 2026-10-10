/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Perforce Sync History actions: open the page, export its records as CSV.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  ICommandService,
  IEditorService,
  IFileDialogService,
  IFileService,
  INotificationService,
  IWorkspaceService,
  Severity,
  URI,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  PerforceSyncHistoryCommands,
  type P4SyncHistoryLoadResult,
} from '@universe-editor/extensions-common'
import { PerforceSyncHistoryEditorInput } from '../services/editor/PerforceSyncHistoryEditorInput.js'
import { SYNC_HISTORY_EXPORT_MAX } from '../services/perforceSyncHistory/syncHistoryViewState.js'
import { runsToCsv } from '../workbench/perforceSyncHistory/syncHistoryCsv.js'

export class ViewPerforceSyncHistoryAction extends Action2 {
  static readonly ID = 'perforce-sync-history.view'

  constructor() {
    super({
      id: ViewPerforceSyncHistoryAction.ID,
      title: localize2('action.perforceSyncHistory.view', 'View Sync History'),
      // The extension's own commands all sit under "Perforce", and this page is
      // about the same thing they are — grouping it with the graph would file a
      // record of every get under a name that says "graph".
      category: localize2('command.category.perforce', 'Perforce'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    await accessor.get(IEditorService).openEditor(new PerforceSyncHistoryEditorInput())
  }
}

const EXPORT_FILE_NAME = 'perforce-sync-history.csv'

/** Export the whole recorded history — not the page's current slice — so the
 *  file matches "every get this install ran", and re-reads the records instead
 *  of touching the open page's state (exporting must not change what is on
 *  screen). */
export class ExportPerforceSyncHistoryAction extends Action2 {
  static readonly ID = 'perforce-sync-history.exportCsv'

  constructor() {
    super({
      id: ExportPerforceSyncHistoryAction.ID,
      title: localize2('action.perforceSyncHistory.exportCsv', 'Export Sync History to CSV'),
      category: localize2('command.category.perforce', 'Perforce'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // The accessor is only valid until the first `await`: take every service up
    // front and work from the locals.
    const commands = accessor.get(ICommandService)
    const fileDialog = accessor.get(IFileDialogService)
    const fileService = accessor.get(IFileService)
    const notifications = accessor.get(INotificationService)
    const folder = accessor.get(IWorkspaceService).current?.folder

    try {
      const page = await commands.executeCommand<P4SyncHistoryLoadResult>(
        PerforceSyncHistoryCommands.getRuns,
        { max: SYNC_HISTORY_EXPORT_MAX },
      )
      // An unregistered command answers `undefined`: there is no perforce
      // extension here to export from.
      if (page === undefined || !Array.isArray(page.runs)) {
        notifications.notify({
          severity: Severity.Error,
          message: localize(
            'perforceSyncHistory.unavailable',
            'The Perforce extension is not available, so the sync history cannot be read.',
          ),
        })
        return
      }

      const target = await fileDialog.showSaveDialog({
        title: localize('perforceSyncHistory.exportCsv.title', 'Export Sync History'),
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: localize('fileDialog.save', 'Save'),
        ...(folder !== undefined ? { defaultUri: URI.joinPath(folder, EXPORT_FILE_NAME) } : {}),
      })
      if (target === undefined) return // cancelled: nothing written, nothing said

      await fileService.writeFile(target, runsToCsv(page.runs))
      notifications.notify({
        severity: Severity.Info,
        message: localize('perforceSyncHistory.exportCsv.done', 'Exported {0} run(s) to {1}', {
          0: String(page.runs.length),
          1: target.fsPath,
        }),
      })
    } catch (err) {
      notifications.notify({
        severity: Severity.Error,
        message: localize(
          'perforceSyncHistory.exportCsv.failed',
          'Exporting the sync history failed: {0}',
          { 0: err instanceof Error ? err.message : String(err) },
        ),
      })
    }
  }
}
