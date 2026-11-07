/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  sessionRemoval — single source of truth for deleting agent sessions.
 *
 *  Three entry points share it: the Sessions list row (inline trash / context menu),
 *  the side-task popover + Open Side Task quick pick, and the Delete Agent Session
 *  command. Keeping plan → confirm → delete in one place is what keeps the durable-id
 *  mapping, the tombstone order and the tab teardown from drifting apart.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  localize,
  type IConfigurationService,
  type IDialogService,
  type IEditorGroupsService,
} from '@universe-editor/platform'
import type { IAcpSessionService } from './acpSessionService.js'
import { collectSideTaskDescendants, type IAcpSessionHistoryService } from './acpSessionHistory.js'
import { AcpSessionEditorInput } from './acpSessionEditorInput.js'

export interface SessionRemovalPlan {
  /** Root first. Durable agent id, except for a pending session (local id). */
  readonly ids: readonly string[]
  /**
   * Pending sessions have not received their agent id yet, so there is nothing
   * to delete agent-side and no history row to tombstone — closing is the whole
   * delete. `deleteSessionPlan` skips `deleteOnAgent` / `removeDeleted` for these.
   */
  readonly localOnlyIds: ReadonlySet<string>
  /** Drives the confirmation wording (side task vs plain session). */
  readonly rootIsSideTask: boolean
}

/**
 * Snapshot the delete target synchronously. The caller must not await before
 * this returns: a confirmation dialog can outlive the row/tab set it was
 * computed from.
 *
 * One row here is the whole side-task subtree, not just the clicked session:
 * side-task rows are filtered out of the main session list, so deleting only
 * the parent would leave children with no entry point.
 */
export function planSessionRemoval(
  sessions: IAcpSessionService,
  history: IAcpSessionHistoryService,
  sessionId: string,
): SessionRemovalPlan {
  const live = sessions.getById(sessionId)
  const durableIdOnAgent = live?.sessionIdOnAgent.get()
  const durableId = durableIdOnAgent ?? sessionId
  const entry = history.get(durableId)
  if (live !== undefined && durableIdOnAgent === undefined && entry === undefined) {
    return {
      ids: [live.id],
      localOnlyIds: new Set([live.id]),
      rootIsSideTask: false,
    }
  }
  return {
    ids: collectSideTaskDescendants(history.list(), durableId),
    localOnlyIds: new Set<string>(),
    rootIsSideTask: entry?.sideTaskOf !== undefined,
  }
}

/**
 * Ask for confirmation, honoring the shared `acp.sessions.confirmDelete` switch
 * and its "Don't ask again" checkbox. Returns false when the user cancels.
 */
export async function confirmSessionRemoval(
  plan: SessionRemovalPlan,
  dialogService: IDialogService,
  config: IConfigurationService,
): Promise<boolean> {
  if (plan.ids.length === 0) return false
  if (config.get<boolean>('acp.sessions.confirmDelete') !== false) {
    const detail = plan.rootIsSideTask
      ? plan.ids.length > 1
        ? localize(
            'acp.sideTask.removeConfirmDetailNested',
            'This also deletes its {count} nested side task(s).',
            { count: plan.ids.length - 1 },
          )
        : localize(
            'acp.sideTask.removeConfirmDetail',
            'This will delete the side task and its history.',
          )
      : plan.ids.length > 1
        ? localize(
            'acp.sessions.removeConfirmDetailWithSideTasks',
            'This also deletes its {count} side task(s) and their history.',
            { count: plan.ids.length - 1 },
          )
        : localize(
            'acp.sessions.removeConfirmDetail',
            'This will delete the session and its history.',
          )
    const result = await dialogService.confirm({
      message: plan.rootIsSideTask
        ? localize('acp.sideTask.removeConfirm', 'Delete this side task?')
        : localize('acp.sessions.removeConfirm', 'Delete this session?'),
      detail,
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
 * Execute a removal plan.
 *
 * Order is load-bearing: `deleteOnAgent` reads the history entry to resolve the
 * owning agent/cwd/authority, so it must run before `removeDeleted`. A failure
 * for one id never strands the rest of the subtree; the local row goes
 * regardless, and the tombstone keeps an in-flight `session/list` sweep from
 * resurrecting it.
 *
 * Tabs are closed explicitly at the end: a dormant (restored but not resumed)
 * session has no live instance, so `closeSession` never fires
 * `onDidCloseSession` and the lifecycle contribution would leave its tab open.
 */
export async function deleteSessionPlan(
  plan: SessionRemovalPlan,
  sessions: IAcpSessionService,
  history: IAcpSessionHistoryService,
  groups?: IEditorGroupsService,
): Promise<void> {
  const tabIds = new Set(plan.ids)
  for (const id of plan.ids) {
    const live = sessions.getById(id)
    if (live !== undefined) tabIds.add(live.id)
    try {
      if (live !== undefined) await sessions.closeSession(live.id)
      if (!plan.localOnlyIds.has(id)) await sessions.deleteOnAgent(id)
    } catch (err) {
      console.warn(`[session-removal] delete failed for ${id}, dropping the local row anyway`, err)
    }
    if (!plan.localOnlyIds.has(id)) history.removeDeleted(id)
  }
  if (groups !== undefined) closeSessionEditorTabs(tabIds, groups)
}

/** Close every session-editor tab addressing one of `sessionIds` (local or durable). */
export function closeSessionEditorTabs(
  sessionIds: ReadonlySet<string>,
  groups: IEditorGroupsService,
): void {
  for (const group of groups.groups) {
    // Copy first: closeEditor mutates the group's editor list.
    for (const editor of [...group.editors]) {
      if (editor instanceof AcpSessionEditorInput && sessionIds.has(editor.sessionId)) {
        group.closeEditor(editor)
      }
    }
  }
}
