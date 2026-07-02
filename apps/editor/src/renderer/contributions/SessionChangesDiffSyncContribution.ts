/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangesDiffSyncContribution — keep already-open session diff tabs in
 *  sync with the change tracker.
 *
 *  The Session Changes list (SessionChangesView) subscribes to the tracker's
 *  `changesFor` observable, so it re-renders whenever the agent edits a file
 *  again. But the diff *tab* the user opened from that list is a long-lived
 *  DiffEditorInput holding a baseline/current snapshot — it does not observe the
 *  tracker, so it keeps showing stale content until the tab is closed and
 *  reopened. This contribution bridges the gap: on every tracker update it pushes
 *  the fresh baseline/current into any matching open DiffEditorInput, which fires
 *  onDidChangeContent and refreshes both Monaco models in place.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  autorun,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'
import {
  ISessionChangeTrackerService,
  type SessionFileChange,
} from '../services/acp/sessionChangeTracker.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'

export class SessionChangesDiffSyncContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IAcpSessionService sessions: IAcpSessionService,
    @ISessionChangeTrackerService tracker: ISessionChangeTrackerService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
  ) {
    super()

    // Observe every live session's change list. A diff tab can belong to any
    // session (not just the active one), so we watch them all and reconcile the
    // union against the open diff tabs on each change.
    this._register(
      autorun((r) => {
        const all: SessionFileChange[] = []
        for (const session of sessions.sessions.read(r)) {
          const idOnAgent = session.sessionIdOnAgent.read(r)
          if (idOnAgent === undefined) continue
          all.push(...tracker.changesFor(idOnAgent).read(r))
        }
        this._sync(all)
      }),
    )
  }

  private _sync(changes: readonly SessionFileChange[]): void {
    if (changes.length === 0) return
    const byUri = new Map<string, SessionFileChange>()
    for (const c of changes) byUri.set(c.uri.toString(), c)

    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (!(editor instanceof DiffEditorInput)) continue
        const change = byUri.get(editor.originalUri.toString())
        if (!change) continue
        // The tracker's `current` is read from disk. If the file is open in an
        // editor with unsaved edits, its live buffer — not the stale disk text —
        // is the modified side's truth; using `change.current` here would clobber
        // an in-place live edit (DiffLiveContentSyncContribution) back to disk.
        const liveModel = MonacoModelRegistry.peek(editor.originalUri)
        const current = liveModel && !liveModel.isDisposed() ? liveModel.getValue() : change.current
        editor.update(change.baseline, current)
      }
    }
  }
}
