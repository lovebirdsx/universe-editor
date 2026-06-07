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
import { IEditorService, IInstantiationService } from '@universe-editor/platform'
import { IAcpSessionService } from '../acp/acpSessionService.js'
import { IAcpSessionHistoryService } from '../acp/acpSessionHistory.js'
import { IAcpChatLocationService } from '../acp/acpChatLocationService.js'
import { IAcpChatWidgetService } from '../acp/acpChatWidgetService.js'
import { AcpSessionEditorInput } from '../acp/acpSessionEditorInput.js'
import { computeSessionDisplayStatus } from '../acp/acpSessionStatus.js'
import { resolveLiveSessionTitle } from '../acp/acpSessionTitle.js'

export class RendererSessionsService implements IRendererSessionsService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IAcpChatLocationService private readonly _chatLocation: IAcpChatLocationService,
    @IEditorService private readonly _editor: IEditorService,
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
    this._chatLocation.setLocation('editor')
    this._editor.openEditor(
      this._instantiation.createInstance(
        AcpSessionEditorInput,
        session.id,
        session.agentId,
        undefined,
      ),
      { activate: true, pinned: true },
    )
    this._widgets.focusSessionInput(session.id)
    requestAnimationFrame(() => this._widgets.focusSessionInput(session.id))
    return Promise.resolve()
  }
}
