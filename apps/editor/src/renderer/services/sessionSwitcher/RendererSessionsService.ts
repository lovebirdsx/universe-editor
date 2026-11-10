/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RendererSessionsService — reverse-channel endpoint implemented in the renderer
 *  and invoked by main's SessionSwitcherMainService. Lists this window's live
 *  sessions plus restored session tabs that have no live instance yet (with
 *  derived display status) for the cross-window Alt+S switcher, and reveals a
 *  chosen session in the editor area.
 *--------------------------------------------------------------------------------------------*/

import type {
  IRendererSessionsService,
  RendererSessionSummary,
} from '../../../shared/ipc/sessionSwitcher.js'
import { IEditorGroupsService, IInstantiationService } from '@universe-editor/platform'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../acp/session/acpSessionHistory.js'
import { AcpSessionEditorInput } from '../acp/session/acpSessionEditorInput.js'
import { IAcpChatWidgetService } from '../acp/session/acpChatWidgetService.js'
import { revealSessionChat } from '../acp/session/revealSessionChat.js'
import { computeSessionDisplayStatus } from '../acp/session/acpSessionStatus.js'
import { resolveLiveSessionTitle } from '../acp/session/acpSessionTitle.js'
import { IWindowFocusService } from '../windows/windowFocusService.js'

export class RendererSessionsService implements IRendererSessionsService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _instantiation: IInstantiationService,
    @IAcpChatWidgetService private readonly _widgets: IAcpChatWidgetService,
    @IWindowFocusService private readonly _windowFocus: IWindowFocusService,
  ) {}

  async listSessions(): Promise<readonly RendererSessionSummary[]> {
    // A restored tab can only be recognized through its durable history row;
    // startup hydration is fire-and-forget, so wait for it (idempotent).
    await this._history.initialize()
    const summaries: RendererSessionSummary[] = []
    // Collected BEFORE the closed filter: a session being closed stays in the
    // registry for a tick while its tab closes, and that tab must not resurface
    // as a dormant row in the meantime.
    const listed = new Set<string>()
    for (const session of this._sessions.sessions.get()) {
      listed.add(session.id)
      const durableId = session.sessionIdOnAgent.get()
      if (durableId !== undefined) listed.add(durableId)
      const status = computeSessionDisplayStatus(session)
      if (status === 'closed') continue
      const title =
        resolveLiveSessionTitle(this._history, this._sessions, session.id) ?? session.title
      summaries.push({
        sessionId: session.id,
        ...(durableId !== undefined ? { agentSessionId: durableId } : {}),
        title,
        status,
        agentId: session.agentId,
      })
    }
    // Restore only hydrates session tabs; an inactive editor is never mounted,
    // so its session is not in the live registry. Report it as dormant —
    // otherwise Alt+S loses every session except the active tab's after a
    // restart.
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (!(editor instanceof AcpSessionEditorInput)) continue
        if (listed.has(editor.sessionId)) continue
        const entry = this._history.get(editor.sessionId)
        if (entry === undefined) continue
        listed.add(editor.sessionId)
        summaries.push({
          sessionId: entry.id,
          agentSessionId: entry.id,
          title: entry.title,
          status: 'dormant',
          agentId: entry.agentId,
        })
      }
    }
    return summaries
  }

  async reveal(sessionId: string): Promise<void> {
    const target = {
      groups: this._groups,
      inst: this._instantiation,
      widgets: this._widgets,
      windowFocus: this._windowFocus,
    }
    const session = this._sessions.getById(sessionId)
    if (session) {
      this._sessions.setActive(sessionId)
      // Asleep: activate instantly off the resident instance and bring its
      // process back in the background — the editor may already be mounted, so
      // nothing else would wake it until the next prompt.
      if (session.isDormant.get()) void session.ensureAwake()
      // The tab may already live in another group (session split across groups,
      // the other one active). Going through IEditorService would dedupe only
      // inside the active group and open a duplicate.
      revealSessionChat(target, session.id, session)
      return
    }
    // No live instance: a restored tab whose editor was never mounted. Open it
    // through its durable history row so AcpSessionResumer picks it up; a
    // genuinely unknown id stays a no-op.
    await this._history.initialize()
    const entry = this._history.get(sessionId)
    if (entry === undefined) return
    revealSessionChat(target, entry.id, { agentId: entry.agentId })
  }
}
