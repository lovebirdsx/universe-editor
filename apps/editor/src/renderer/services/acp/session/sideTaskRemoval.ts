/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  sideTaskRemoval — thin side-task-flavoured wrappers over the shared session
 *  removal pipeline. Used by the parent chat's SideTasksBar popover and the
 *  Open Side Task quick pick.
 *--------------------------------------------------------------------------------------------*/

import type {
  IConfigurationService,
  IDialogService,
  IEditorGroupsService,
} from '@universe-editor/platform'
import type { IAcpSessionService } from './acpSessionService.js'
import type { IAcpSessionHistoryService } from './acpSessionHistory.js'
import {
  confirmSessionRemoval,
  deleteSessionPlan,
  type SessionRemovalPlan,
} from './sessionRemoval.js'

function sideTaskPlan(ids: readonly string[]): SessionRemovalPlan {
  return { ids, localOnlyIds: new Set<string>(), rootIsSideTask: true }
}

/**
 * Ask whether `ids` (the root plus every descendant, as returned by
 * `collectSideTaskDescendants`) may be deleted. The caller must snapshot the
 * ids synchronously before its first `await`; the dialog can outlive the
 * render-time row set it was computed from.
 *
 * Returns `false` when the user cancels and when there is nothing to delete.
 */
export function confirmSideTaskRemoval(
  ids: readonly string[],
  dialogService: IDialogService,
  config: IConfigurationService,
): Promise<boolean> {
  return confirmSessionRemoval(sideTaskPlan(ids), dialogService, config)
}

/**
 * Delete `ids` one by one, root first. See `deleteSessionPlan` for the failure
 * semantics and tombstone ordering; `groups` closes any open/dormant tabs.
 */
export function deleteSideTasks(
  ids: readonly string[],
  sessions: IAcpSessionService,
  history: IAcpSessionHistoryService,
  groups?: IEditorGroupsService,
): Promise<void> {
  return deleteSessionPlan(sideTaskPlan(ids), sessions, history, groups)
}
