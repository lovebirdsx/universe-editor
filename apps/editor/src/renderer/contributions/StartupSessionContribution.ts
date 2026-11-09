/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Acts on the session work a window was opened/focused for — either via CLI
 *  argv at cold-launch or pushed from the main process over IPC:
 *
 *  - `open-session`: resume an existing session (cross-worktree follow). The
 *    window's workspace is already the session's own folder by the time we
 *    resume, so the split-brain guard in resumeSession passes.
 *  - `new-agent-session`: create a brand-new session rooted at the requested
 *    cwd. Used when a session is requested for a folder the requesting window
 *    is not rooted at; main routes it to the window that owns that folder.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  type IOpenWindowNewAgentSession,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { IUserSettingsSyncService } from '../services/configuration/UserSettingsSync.js'
import type { IpcBridge } from '../../preload/index.js'

export class StartupSessionContribution extends Disposable implements IWorkbenchContribution {
  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IUserSettingsSyncService private readonly _userSettings: IUserSettingsSyncService,
  ) {
    super()
    const ipc = (window as { ipc?: IpcBridge }).ipc
    if (!ipc) return

    if (ipc.openSessionId) {
      this._resume(ipc.openSessionId)
    }
    if (ipc.newAgentSession) {
      this._create(ipc.newAgentSession)
    }

    this._register({ dispose: ipc.onOpenSession((sessionId) => this._resume(sessionId)) })
    this._register({ dispose: ipc.onNewAgentSession((request) => this._create(request)) })
  }

  private _resume(sessionId: string): void {
    console.log(`[StartupSessionContribution] resuming session: ${sessionId}`)
    this._sessions.resumeSession(sessionId).catch((err: unknown) => {
      console.warn(`[StartupSessionContribution] resume failed: ${(err as Error).message}`)
    })
  }

  /**
   * Create the session a routed request asked for. Waits for the settings
   * hydration: the agent list and default options come from settings, and a
   * `createSession` issued before they are in would run on built-in defaults.
   */
  private _create(request: IOpenWindowNewAgentSession): void {
    console.log(
      `[StartupSessionContribution] creating session in ${request.cwd} (agent=${request.agentId})`,
    )
    void this._userSettings.whenInitialized
      .then(() =>
        this._sessions.createSession(request.agentId, {
          cwd: request.cwd,
          ...(request.authority !== undefined ? { authority: request.authority } : {}),
        }),
      )
      .catch((err: unknown) => {
        console.warn(`[StartupSessionContribution] create failed: ${(err as Error).message}`)
      })
  }
}
