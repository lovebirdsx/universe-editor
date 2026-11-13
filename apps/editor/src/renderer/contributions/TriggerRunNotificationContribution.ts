/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Notifies the user when an automated trigger run reaches a terminal state.
 *  Fires in the window that started the run (the automated session service is a
 *  per-renderer singleton and the run host lives here), so the notification is
 *  never duplicated across windows. Escalations and non-completed outcomes are
 *  warnings; a clean finish (info / reject / approved actions) is informational.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IEditorGroupsService,
  IInstantiationService,
  ILoggerService,
  INotificationService,
  IWorkbenchContribution,
  Severity,
  localize,
  type ILogger,
} from '@universe-editor/platform'
import type { TriggerRunEnd } from '../../shared/triggers/types.js'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import type { IAcpSession } from '../services/acp/session/acpSessionModel.js'
import { revealSessionChat } from '../services/acp/session/revealSessionChat.js'
import { IAutomatedSessionService } from '../services/triggers/automatedSessionService.js'
import { IWindowFocusService } from '../services/windows/windowFocusService.js'

export class TriggerRunNotificationContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _logger: ILogger

  constructor(
    @IAutomatedSessionService automatedSessions: IAutomatedSessionService,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IInstantiationService private readonly _inst: IInstantiationService,
    @IAcpChatWidgetService private readonly _widgets: IAcpChatWidgetService,
    @IWindowFocusService private readonly _windowFocus: IWindowFocusService,
    @INotificationService private readonly _notification: INotificationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'triggerNotify', name: 'Triggers' })
    this._register(automatedSessions.onDidEndRun((end) => this._notify(end)))
  }

  private _notify(end: TriggerRunEnd): void {
    // Cancelling a run is the user's own action — no toast for it.
    if (end.outcome === 'cancelled') return
    this._logger.debug(
      `run ended: trigger=${end.triggerId} outcome=${end.outcome} verdict=${end.verdict ?? 'none'}`,
    )
    const session = end.sessionId !== undefined ? this._sessions.getById(end.sessionId) : undefined
    const triggerName = session?.automation?.triggerName ?? end.triggerId
    const summary = end.summary ?? ''
    const { severity, message } = describeRun(end, triggerName, summary)
    const handle = this._notification.notify({
      severity,
      message,
      actions: [
        {
          label: localize('trigger.run.notify.openSession', 'Open Session'),
          run: () => {
            this._openSession(end, session)
            this._notification.dismiss(handle.id)
          },
        },
      ],
    })
  }

  private _openSession(end: TriggerRunEnd, session: IAcpSession | undefined): void {
    const sessionId = session?.id ?? end.sessionId
    if (sessionId === undefined) return
    revealSessionChat(
      {
        groups: this._groups,
        inst: this._inst,
        widgets: this._widgets,
        windowFocus: this._windowFocus,
      },
      sessionId,
      session !== undefined ? { agentId: session.agentId } : undefined,
    )
  }
}

function describeRun(
  end: TriggerRunEnd,
  triggerName: string,
  summary: string,
): { readonly severity: Severity; readonly message: string } {
  if (end.outcome !== 'completed') {
    return {
      severity: Severity.Warning,
      message: localize(
        'trigger.run.notify.incomplete',
        'Trigger run did not complete: {0} ({1})',
        { 0: triggerName, 1: end.outcome },
      ),
    }
  }
  if (end.verdict === 'escalate') {
    return {
      severity: Severity.Warning,
      message:
        summary.length > 0
          ? localize('trigger.run.notify.escalate', 'Needs your action: {0} · {1}', {
              0: triggerName,
              1: summary,
            })
          : localize('trigger.run.notify.escalateNoSummary', 'Needs your action: {0}', {
              0: triggerName,
            }),
    }
  }
  return {
    severity: Severity.Info,
    message: localize('trigger.run.notify.completed', 'Completed: {0}', { 0: triggerName }),
  }
}
