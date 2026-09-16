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
import { IEditorGroupsService, IInstantiationService } from '@universe-editor/platform'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../acp/session/acpSessionHistory.js'
import { IAcpChatWidgetService } from '../acp/session/acpChatWidgetService.js'
import { revealSessionChat } from '../acp/session/revealSessionChat.js'
import { computeSessionDisplayStatus } from '../acp/session/acpSessionStatus.js'
import { resolveLiveSessionTitle } from '../acp/session/acpSessionTitle.js'

export class RendererSessionsService implements IRendererSessionsService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @IAcpChatWidgetService private readonly _widgets: IAcpChatWidgetService,
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
    const session = this._sessions.getById(sessionId)
    if (!session) return Promise.resolve()
    this._sessions.setActive(sessionId)
    // Asleep: activate instantly off the resident instance and bring its
    // process back in the background — the editor may already be mounted, so
    // nothing else would wake it until the next prompt.
    if (session.isDormant.get()) void session.ensureAwake()
    // The tab may already live in another group (session split across groups,
    // the other one active). Going through IEditorService would dedupe only
    // inside the active group and open a duplicate.
    revealSessionChat(
      { groups: this._groups, inst: this._instantiation, widgets: this._widgets },
      session.id,
      session,
    )
    return Promise.resolve()
  }
}
