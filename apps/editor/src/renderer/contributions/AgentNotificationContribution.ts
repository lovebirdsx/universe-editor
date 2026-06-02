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
  IHostService,
  ILayoutService,
  IViewsService,
  IWorkbenchContribution,
  IWorkspaceService,
  PartId,
  autorun,
  localize,
  toDisposable,
  type IDisposable,
} from '@universe-editor/platform'
import { IAcpSessionService, type IAcpSession } from '../services/acp/acpSessionService.js'
import { truncateTitle } from '../services/acp/sessionTitleFormat.js'
import {
  getAgentNotificationIcon,
  primeAgentNotificationIcon,
} from '../services/acp/agentNotificationIcon.js'
import type { AcpPlanEntry } from '../services/acp/acpSession.js'

const AGENTS_CONTAINER_ID = 'workbench.view.agents'
const AGENTS_VIEW_ID = 'workbench.view.agents.main'

type NotifyKind = 'permission' | 'question' | 'completed' | 'errored'

function isPlanComplete(plan: readonly AcpPlanEntry[]): boolean {
  return plan.length > 0 && plan.every((e) => e.status === 'completed')
}

export class AgentNotificationContribution extends Disposable implements IWorkbenchContribution {
  private readonly _perSession = new Map<string, IDisposable>()

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IHostService private readonly _host: IHostService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IViewsService private readonly _views: IViewsService,
    @ILayoutService private readonly _layout: ILayoutService,
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

    let prevStatus = session.status.get()
    let permissionLatched = session.pendingPermission.get() !== undefined
    let questionLatched = session.pendingQuestion.get() !== undefined
    let completionAnnounced = false
    let planWasComplete = isPlanComplete(session.plan.get())

    return autorun((r) => {
      const status = session.status.read(r)
      const permission = session.pendingPermission.read(r)
      const question = session.pendingQuestion.read(r)
      const planComplete = isPlanComplete(session.plan.read(r))

      // Permission request — rising edge only.
      if (permission !== undefined && !permissionLatched) this._fire('permission', session)
      permissionLatched = permission !== undefined

      // Agent question — rising edge only.
      if (question !== undefined && !questionLatched) this._fire('question', session)
      questionLatched = question !== undefined

      // A new turn opens: reset the per-turn completion latch and re-baseline the
      // plan so a stale all-complete plan from the previous turn doesn't re-fire.
      if (status === 'running' && prevStatus !== 'running') {
        completionAnnounced = false
        planWasComplete = planComplete
      }

      // "Completed" fires at most once per turn, on whichever lands first:
      // the plan flipping to all-complete, or the status returning to idle.
      const planJustCompleted = planComplete && !planWasComplete
      const turnFinished = status === 'idle' && prevStatus === 'running'
      if ((planJustCompleted || turnFinished) && !completionAnnounced) {
        completionAnnounced = true
        this._fire('completed', session)
      }
      planWasComplete = planComplete

      if (status === 'errored' && prevStatus !== 'errored') this._fire('errored', session)

      prevStatus = status
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
    if (!this._layout.getVisible(PartId.SecondarySideBar)) {
      this._layout.toggleVisible(PartId.SecondarySideBar)
    }
    this._views.openViewContainer(AGENTS_CONTAINER_ID)
    void this._layout.focusView(AGENTS_VIEW_ID, { source: 'command' })
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
