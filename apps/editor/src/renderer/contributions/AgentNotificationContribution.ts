/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Raises OS-level desktop notifications when an Agent session needs the user's
 *  attention (permission request, question, turn completed, or error) while the
 *  editor window is blurred. Clicking a notification focuses the window and jumps
 *  to the originating session. Focus gating lives in the main-side host service.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IConfigurationService,
  IEditorGroupsService,
  IHostService,
  IInstantiationService,
  IWorkbenchContribution,
  IWorkspaceService,
  autorun,
  localize,
  toDisposable,
  type IDisposable,
} from '@universe-editor/platform'
import { IAcpSessionService, type IAcpSession } from '../services/acp/session/acpSessionService.js'
import {
  computeSessionDisplayStatus,
  isTurnDisplayStatus,
} from '../services/acp/session/acpSessionStatus.js'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { revealSessionChat } from '../services/acp/session/revealSessionChat.js'
import { truncateTitle } from '../services/acp/session/sessionTitleFormat.js'
import {
  getAgentNotificationIcon,
  primeAgentNotificationIcon,
} from '../services/acp/agentNotificationIcon.js'

type NotifyKind = 'permission' | 'question' | 'completed' | 'errored'

export class AgentNotificationContribution extends Disposable implements IWorkbenchContribution {
  private readonly _perSession = new Map<string, IDisposable>()

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IHostService private readonly _host: IHostService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _inst: IInstantiationService,
    @IAcpChatWidgetService private readonly _widgets: IAcpChatWidgetService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
  ) {
    super()

    this._register(
      autorun((r) => {
        const list = this._sessions.sessions.read(r)
        const present = new Set(list.map((s) => s.id))
        for (const session of list) {
          if (!this._perSession.has(session.id)) {
            this._perSession.set(session.id, this._watchSession(session))
          }
        }
        for (const [id, watcher] of this._perSession) {
          if (!present.has(id)) {
            watcher.dispose()
            this._perSession.delete(id)
          }
        }
      }),
    )

    this._register(
      toDisposable(() => {
        for (const watcher of this._perSession.values()) watcher.dispose()
        this._perSession.clear()
      }),
    )
  }

  private _enabled(): boolean {
    return this._config.get<boolean>('acp.notifications.enabled') ?? true
  }

  private _watchSession(session: IAcpSession): IDisposable {
    // Warm the notification icon so it's ready synchronously when an edge fires.
    primeAgentNotificationIcon(session.agentId)

    let prevDisplay = computeSessionDisplayStatus(session)
    let permissionLatched = session.pendingPermission.get() !== undefined
    let elicitationLatched = session.pendingElicitation.get() !== undefined
    let completionAnnounced = false

    return autorun((r) => {
      const display = computeSessionDisplayStatus(session, r)
      const permission = session.pendingPermission.read(r)
      const elicitation = session.pendingElicitation.read(r)

      // Permission request — rising edge only. A card the service marked as
      // auto-resolving (`acp.plan.autoExecute` non-off) needs no attention: it
      // counts down and continues on its own, so pulling the user back to the
      // window would be noise.
      if (permission !== undefined && !permissionLatched && permission.autoResolve === undefined) {
        this._fire('permission', session)
      }
      permissionLatched = permission !== undefined

      // Agent elicitation — rising edge only.
      if (elicitation !== undefined && !elicitationLatched) this._fire('question', session)
      elicitationLatched = elicitation !== undefined

      // Work is in flight again (a new turn, a background task the settled turn
      // left behind, or a turn parked on the user): re-arm the per-turn
      // completion latch.
      if (isTurnDisplayStatus(display)) {
        completionAnnounced = false
      }

      // "Completed" fires at most once per turn, and only once the session is
      // GENUINELY settled — the prompt RPC having returned is not enough, since
      // `run_in_background` tasks outlive it (the derived status stays
      // 'background' until they finish). Announcing on the core status instead
      // both fired early and swallowed the real finish. The plan flipping to
      // all-complete is not a signal either: the agent checks off its last todo
      // mid-turn while it still streams the summary text.
      //
      // The edge is a TURN edge, not a "was busy" edge: 'connecting' settles
      // straight to 'idle' on every new, resumed or woken session, so counting
      // it as the prior state announces a completion for work that never ran.
      const turnFinished = display === 'idle' && isTurnDisplayStatus(prevDisplay)
      if (turnFinished && !completionAnnounced) {
        completionAnnounced = true
        this._fire('completed', session)
      }

      if (display === 'errored' && prevDisplay !== 'errored') this._fire('errored', session)

      prevDisplay = display
    })
  }

  private _fire(kind: NotifyKind, session: IAcpSession): void {
    if (!this._enabled()) return
    const title = titleFor(kind)
    const lines = [truncateTitle(session.title)]
    const workspaceName = this._workspace.current?.name
    if (workspaceName !== undefined && workspaceName.length > 0) lines.push(workspaceName)
    void this._notifyAndMaybeFocus(session.id, session.agentId, title, lines.join('\n'))
  }

  private async _notifyAndMaybeFocus(
    sessionId: string,
    agentId: string | undefined,
    title: string,
    body: string,
  ): Promise<void> {
    const icon = getAgentNotificationIcon(agentId)
    const res = await this._host.notify({ title, body, ...(icon ? { icon } : {}) })
    if (!res.clicked) return
    this._sessions.setActive(sessionId)
    revealSessionChat(
      { groups: this._groups, inst: this._inst, widgets: this._widgets },
      sessionId,
      this._sessions.getById(sessionId),
    )
  }
}

function titleFor(kind: NotifyKind): string {
  switch (kind) {
    case 'permission':
      return localize('acp.notify.permission.title', 'Agent needs your permission')
    case 'question':
      return localize('acp.notify.question.title', 'Agent has a question')
    case 'completed':
      return localize('acp.notify.completed.title', 'Agent finished its task')
    case 'errored':
      return localize('acp.notify.errored.title', 'Agent run failed')
  }
}
