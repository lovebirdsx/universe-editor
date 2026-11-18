/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TriggerReportChip — a trigger-started chat's entry to its run report, pinned
 *  in the top-right chip row (the desktop counterpart of the mobile session
 *  header's report chip). Renders nothing for sessions no trigger started.
 *--------------------------------------------------------------------------------------------*/

import { ICommandService, localize } from '@universe-editor/platform'
import { Zap } from 'lucide-react'
import { useObservable, useService } from '../useService.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../../services/acp/session/acpSessionHistory.js'
import { ViewTriggerReportAction } from '../../actions/triggerActions.js'
import { automationVerdictLabel } from './automationLabels.js'
import styles from './agents.module.css'

export function TriggerReportChip({ session }: { session: IAcpSession }) {
  const history = useService(IAcpSessionHistoryService)
  const commandService = useService(ICommandService)
  useObservable(history.entries)
  const sid = useObservable(session.sessionIdOnAgent) ?? session.id
  // The history row carries the verdict written when the run settles.
  const recorded = history.get(sid)?.automation
  const automation = recorded ?? session.automation
  if (automation === undefined) return null
  const verdict = automationVerdictLabel(recorded?.verdict)
  const tooltip = localize('acp.sessions.automationBadge', 'Started by trigger {name} · {key}', {
    name: automation.triggerName,
    key: automation.eventKey,
  })
  return (
    <button
      type="button"
      className={styles['triggerReportChip']}
      data-testid="acp-trigger-report"
      data-verdict={recorded?.verdict}
      data-tooltip={tooltip}
      onClick={() => {
        void commandService.executeCommand(ViewTriggerReportAction.ID, { sessionId: session.id })
      }}
    >
      <Zap size={12} strokeWidth={2} aria-hidden="true" />
      {localize('acp.sessions.viewReport', 'View Report')}
      {verdict !== undefined ? (
        <span className={styles['triggerReportChipVerdict']}>{verdict}</span>
      ) : null}
    </button>
  )
}
