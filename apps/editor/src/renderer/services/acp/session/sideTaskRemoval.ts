/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  sideTaskRemoval — single source of truth for deleting side tasks. Used by the
 *  parent chat's SideTasksBar popover and the Open Side Task quick pick.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  localize,
  type IConfigurationService,
  type IDialogService,
} from '@universe-editor/platform'
import type { IAcpSessionService } from './acpSessionService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'

/**
 * Ask whether `ids` (the root plus every descendant, as returned by
 * `collectSideTaskDescendants`) may be deleted. The caller must snapshot the
 * ids synchronously before its first `await`; the dialog can outlive the
 * render-time row set it was computed from.
 *
 * Returns `false` when the user cancels and when there is nothing to delete.
 */
export async function confirmSideTaskRemoval(
  ids: readonly string[],
  dialogService: IDialogService,
  config: IConfigurationService,
): Promise<boolean> {
  if (ids.length === 0) return false
  if (config.get<boolean>('acp.sessions.confirmDelete') !== false) {
    const result = await dialogService.confirm({
      message: localize('acp.sideTask.removeConfirm', 'Delete this side task?'),
      detail:
        ids.length > 1
          ? localize(
              'acp.sideTask.removeConfirmDetailNested',
              'This also deletes its {count} nested side task(s).',
              { count: ids.length - 1 },
            )
          : localize(
              'acp.sideTask.removeConfirmDetail',
              'This will delete the side task and its history.',
            ),
      primaryButton: localize('acp.sessions.removeConfirmOk', 'Delete'),
      cancelButton: localize('acp.sessions.removeConfirmCancel', 'Cancel'),
      neverAskAgainLabel: localize('acp.sessions.removeNeverAsk', "Don't ask again"),
    })
    if (!result.confirmed) return false
    if (result.neverAskAgain) {
      config.update('acp.sessions.confirmDelete', false, ConfigurationTarget.User)
    }
  }
  return true
}

/**
 * Delete `ids` one by one, root first. A failing close/delete must not strand
 * the rest of the subtree, which is exactly the orphan state this cascade
 * prevents; the local row goes regardless, so an agent that cannot delete
 * server-side never leaves the side task undeletable here. `removeDeleted`
 * tombstones the id, so a sweep that captured `session/list` before the delete
 * cannot recreate the row as a plain session.
 */
export async function deleteSideTasks(
  ids: readonly string[],
  sessions: IAcpSessionService,
  history: IAcpSessionHistoryService,
): Promise<void> {
  for (const id of ids) {
    try {
      // closeSession fires onDidCloseSession, which closes the side task's
      // right-split tab through AgentsSessionEditorLifecycleContribution.
      const live = sessions.getById(id)
      if (live) await sessions.closeSession(live.id)
      await sessions.deleteOnAgent(id)
    } catch (err) {
      console.warn(`[side-task] delete failed for ${id}, dropping the local row anyway`, err)
    }
    history.removeDeleted(id)
  }
}
