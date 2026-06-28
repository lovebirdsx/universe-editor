/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resumes an ACP session that was requested for this window — either via CLI
 *  argv at cold-launch (a new window opened to follow a cross-worktree session)
 *  or pushed from the main process when an already-open window is focused for
 *  the same purpose. The window's workspace is already the session's own folder
 *  by the time we resume, so the split-brain guard in resumeSession passes.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '@universe-editor/platform'
import type { IWorkbenchContribution } from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/acpSessionService.js'
import type { IpcBridge } from '../../preload/index.js'

export class StartupSessionContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IAcpSessionService private readonly _sessions: IAcpSessionService) {
    super()
    const ipc = (window as { ipc?: IpcBridge }).ipc
    if (!ipc) return

    if (ipc.openSessionId) {
      this._resume(ipc.openSessionId)
    }

    this._register({ dispose: ipc.onOpenSession((sessionId) => this._resume(sessionId)) })
  }

  private _resume(sessionId: string): void {
    console.log(`[StartupSessionContribution] resuming session: ${sessionId}`)
    this._sessions.resumeSession(sessionId).catch((err: unknown) => {
      console.warn(`[StartupSessionContribution] resume failed: ${(err as Error).message}`)
    })
  }
}
