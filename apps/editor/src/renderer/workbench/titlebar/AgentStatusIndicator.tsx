/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Title-bar pill mirroring VSCode's agents control: always visible so the title
 *  bar layout stays stable. The badge counts running sessions plus sessions
 *  waiting on a question/permission (amber when any waits); click opens the
 *  cross-window session switcher (Alt+S).
 *--------------------------------------------------------------------------------------------*/

import { useMemo } from 'react'
import { Bot } from 'lucide-react'
import { ICommandService, constObservable, derived, localize } from '@universe-editor/platform'
import { useObservable, useOptionalService, useService } from '../useService.js'
import { IAcpSessionService } from '../../services/acp/acpSessionService.js'
import { computeSessionDisplayStatus } from '../../services/acp/acpSessionStatus.js'
import { SwitchSessionAction } from '../../actions/agentSessionActions.js'
import styles from './TitleBar.module.css'

export function AgentStatusIndicator() {
  const sessionsService = useOptionalService(IAcpSessionService)
  const commandService = useService(ICommandService)

  // Primitives keep the deriveds' default strictEquals from firing on every
  // recompute (an object snapshot would never compare equal).
  const runningCountObs = useMemo(
    () =>
      sessionsService
        ? derived(
            /**
             * @description titlebar.agentStatus.runningCount
             */
            (r) =>
              sessionsService.sessions
                .read(r)
                .filter((s) => computeSessionDisplayStatus(s, r) === 'running').length,
          )
        : constObservable(0),
    [sessionsService],
  )
  const askCountObs = useMemo(
    () =>
      sessionsService
        ? derived(
            /**
             * @description titlebar.agentStatus.askCount
             */
            (r) =>
              sessionsService.sessions
                .read(r)
                .filter((s) => computeSessionDisplayStatus(s, r) === 'ask').length,
          )
        : constObservable(0),
    [sessionsService],
  )

  const runningCount = useObservable(runningCountObs)
  const askCount = useObservable(askCountObs)

  const total = runningCount + askCount
  const hasAsk = askCount > 0
  const stateClass = hasAsk
    ? styles['agent-status--ask']
    : total > 0
      ? styles['agent-status--running']
      : styles['agent-status--idle']

  const tooltip = hasAsk
    ? localize(
        'agentStatus.waitingTooltip',
        '{0} session(s) waiting for input — Switch Session (Alt+S)',
        { 0: String(total) },
      )
    : total > 0
      ? localize('agentStatus.runningTooltip', '{0} running session(s) — Switch Session (Alt+S)', {
          0: String(total),
        })
      : localize('agentStatus.idleTooltip', 'Switch Session (Alt+S)')

  return (
    <button
      className={`${styles['agent-status']} ${stateClass}`}
      onClick={() => void commandService.executeCommand(SwitchSessionAction.ID)}
      title={tooltip}
      aria-label={tooltip}
      data-testid="titlebar-agent-status"
    >
      <Bot size={13} strokeWidth={1.75} />
      <span className={styles['agent-status-count']}>{total}</span>
    </button>
  )
}
