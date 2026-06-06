/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RendererSessionsService — reverse-channel endpoint implemented in the renderer
 *  and invoked by main's SessionSwitcherMainService. Lists this window's live
 *  sessions (with derived display status) for the cross-window Alt+S switcher,
 *  and reveals a chosen session in the editor area.
 *--------------------------------------------------------------------------------------------*/

import type {
  IRendererSessionsService,
  RendererSessionSummary,
} from '../../../shared/ipc/sessionSwitcher.js'
import { IAcpSessionService } from '../acp/acpSessionService.js'
import { IAcpSessionHistoryService } from '../acp/acpSessionHistory.js'
import { IAcpChatLocationService } from '../acp/acpChatLocationService.js'
import { computeSessionDisplayStatus } from '../acp/acpSessionStatus.js'
import { resolveLiveSessionTitle } from '../acp/acpSessionTitle.js'

export class RendererSessionsService implements IRendererSessionsService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IAcpChatLocationService private readonly _chatLocation: IAcpChatLocationService,
  ) {}

  listSessions(): Promise<readonly RendererSessionSummary[]> {
    const summaries: RendererSessionSummary[] = []
    for (const session of this._sessions.sessions.get()) {
      const status = computeSessionDisplayStatus(session)
      if (status === 'closed') continue
      const title =
        resolveLiveSessionTitle(this._history, this._sessions, session.id) ?? session.title
      summaries.push({ sessionId: session.id, title, status, agentId: session.agentId })
    }
    return Promise.resolve(summaries)
  }

  reveal(sessionId: string): Promise<void> {
    if (!this._sessions.getById(sessionId)) return Promise.resolve()
    // Force the editor location so the session opens as a full-screen tab (the
    // activeSession autorun in AcpChatLocationService does the actual openEditor).
    this._chatLocation.setLocation('editor')
    this._sessions.setActive(sessionId)
    return Promise.resolve()
  }
}
