/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ForkTipFooter — a subtle row pinned to the end of the timeline that forks
 *  the WHOLE conversation (tip included) into a new independent session. It
 *  complements the per-user-message "Fork from here" (which excludes that
 *  turn): this one keeps the finished turn. Shown once the agent's turn has
 *  settled — `status === 'idle'`, or the idle reaper's `'closed'` + isDormant
 *  seal (the process is gone but the transcript is intact, and a fork reads the
 *  transcript rather than the live session, so it never needs a wake) — the
 *  agent advertises fork support, and the session isn't a read-only foreign
 *  preview; hidden while running so a fork never captures a half-written turn.
 *--------------------------------------------------------------------------------------------*/

import { memo } from 'react'
import { GitBranch } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useExecuteCommand, useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'
import { ForkAgentSessionAction } from '../../actions/agentRewindActions.js'
import { useSessionDisplayStatus } from './useSessionStatus.js'
import styles from './agents.module.css'

export const ForkTipFooter = memo(function ForkTipFooter({ session }: { session: IAcpSession }) {
  const executeCommand = useExecuteCommand()
  const forkSupported = useObservable(session.forkSupported)
  // Only a genuinely settled session may offer a fork. The derived status keeps
  // a session 'background' while `run_in_background` tasks are still running,
  // so they no longer read as settled the moment the prompt RPC returns; the
  // dormant seal (idle-reaped, wakes on use) stays settled, matching the old
  // `closed && isDormant` arm.
  const displayStatus = useSessionDisplayStatus(session)
  const settled = displayStatus === 'idle' || displayStatus === 'dormant'
  if (!settled || !forkSupported || session.readOnly) return null

  const label = localize('acp.chat.forkFromTip', 'Fork conversation from here')
  return (
    <div className={styles['forkTipFooter']} data-testid="acp-fork-tip-footer">
      <button
        type="button"
        className={styles['forkTipButton']}
        aria-label={label}
        onClick={() => void executeCommand(ForkAgentSessionAction.ID, { sessionId: session.id })}
        data-testid="acp-fork-tip"
      >
        <GitBranch size={13} strokeWidth={1.75} aria-hidden="true" />
        <span>{label}</span>
      </button>
    </div>
  )
})
