/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionDeletedFilesWatcher — surfaces files deleted on disk while an agent
 *  session is active as `deleted` entries in Session Changes. The agent has no
 *  Delete tool (deletions go through `rm`), so there is no structured signal to
 *  record; instead we watch the workspace and mark/unmark deletions as files
 *  disappear and reappear. Deleted entries carry no baseline — they only tell
 *  the user a file was removed during the session.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IFileService,
  IFileWatcherService,
  URI,
  type IFileChangeEvent,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'
import { ISessionChangeTrackerService } from '../services/acp/sessionChangeTracker.js'

export class SessionDeletedFilesWatcher extends Disposable implements IWorkbenchContribution {
  constructor(
    @IFileWatcherService watcher: IFileWatcherService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @ISessionChangeTrackerService private readonly _tracker: ISessionChangeTrackerService,
    @IFileService private readonly _files: IFileService,
  ) {
    super()
    this._register(
      watcher.onDidChangeFiles((events) => {
        void this._handle(events)
      }),
    )
  }

  private async _handle(events: readonly IFileChangeEvent[]): Promise<void> {
    if (events.length === 0) return
    // Attribute deletions to the active session. fs-watch events can arrive
    // slightly after the agent goes idle, so we gate on session presence rather
    // than the 'running' status to avoid missing the trailing delete event.
    const session = this._sessions.activeSession.get()
    if (!session) return
    const sessionId = session.id
    for (const ev of events) {
      const u = URI.revive(ev.resource as Parameters<typeof URI.revive>[0])
      if (!u || u.scheme !== 'file') continue
      if (ev.type === 'deleted') {
        // A 'deleted' event is frequently an atomic rewrite; confirm it is gone.
        if (await this._exists(u)) continue
        this._tracker.markDeleted(sessionId, u.fsPath)
      } else if (ev.type === 'added') {
        this._tracker.unmarkDeleted(sessionId, u.fsPath)
      }
    }
  }

  private async _exists(resource: URI): Promise<boolean> {
    try {
      await this._files.stat(resource)
      return true
    } catch {
      return false
    }
  }
}
