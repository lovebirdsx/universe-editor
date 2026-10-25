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
import { invocationOpenTarget } from '../services/editor/openTarget.js'
import { openSingletonEditor, openTargetServicesFrom } from '../services/editor/openWithTarget.js'
import {
  noteSyncHistoryRecorded,
  SYNC_HISTORY_EXPORT_MAX,
} from '../services/perforceSyncHistory/syncHistoryViewState.js'
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

  override run(accessor: ServicesAccessor): Promise<boolean> {
    const editorService = accessor.get(IEditorService)
    return openSingletonEditor(
      openTargetServicesFrom(accessor),
      invocationOpenTarget(),
      () => new PerforceSyncHistoryEditorInput(),
      () => editorService.openEditor(new PerforceSyncHistoryEditorInput()),
    )
  }
}

const EXPORT_FILE_NAME = 'perforce-sync-history.csv'

/**
 * Host-invokable poke: the perforce extension just wrote a sync record. Routes
 * to the module-level view state, which reloads the page if it is mounted and
 * marks it stale if it is not. Carries no argument on purpose — "a record
 * landed" is the whole message; the page re-reads the history either way.
 *
 * Never appears in the extension's package.json `commands` — this is a
 * host→renderer `_workbench.*` lane, like `_workbench.swarmPollTick`.
 */
export class WorkbenchPerforceSyncHistoryRecordedAction extends Action2 {
  static readonly ID = '_workbench.perforceSyncHistoryRecorded'

  constructor() {
    super({
      id: WorkbenchPerforceSyncHistoryRecordedAction.ID,
      title: localize2('action.perforceSyncHistory.recorded', 'Perforce Sync History Recorded'),
    })
  }

  override run(): void {
    noteSyncHistoryRecorded()
  }
}

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
