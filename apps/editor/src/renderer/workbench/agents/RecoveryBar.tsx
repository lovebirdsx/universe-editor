/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RecoveryBar — non-intrusive status strip shown above the prompt input while a
 *  session is auto-recovering from a transient failure: a countdown to the next
 *  automatic attempt (retry after 429/overloaded, or hot-reconnect after a
 *  crash/stall) with a Cancel button, and a manual Retry once attempts run out.
 *
 *  The bar never blocks input — the user keeps typing; prompts queue and flush
 *  once the session reconnects, exactly like the initial-connect path.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { Loader2, RotateCw, X } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import type { AcpRecoveryState } from '../../services/acp/acpSessionRecovery.js'
import styles from './agents.module.css'

export function RecoveryBar({ session }: { session: IAcpSession }) {
  const state = useObservable(session.recoveryState)
  // Re-render each second so the countdown ticks down live.
  const [, setTick] = useState(0)
  const nextAttemptAt = state?.nextAttemptAt
  useEffect(() => {
    if (nextAttemptAt === undefined) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [nextAttemptAt])

  if (!state) return null

  const exhausted = state.phase === 'exhausted'
  return (
    <section
      className={styles['recoveryBar']}
      data-testid="acp-recovery-bar"
      data-phase={state.phase}
    >
      <div className={styles['recoveryMessage']}>
        {exhausted ? (
          <RotateCw size={14} aria-hidden="true" />
        ) : (
          <Loader2 size={14} className={styles['spin']} aria-hidden="true" />
        )}
        <span>{describe(state)}</span>
      </div>
      <div className={styles['recoveryActions']}>
        {exhausted ? (
          <button
            type="button"
            className={styles['recoveryRetry']}
            onClick={() => void session.retryRecovery()}
            data-testid="acp-recovery-retry"
          >
            {localize('acp.recovery.retry', 'Retry')}
          </button>
        ) : (
          <button
            type="button"
            className={styles['recoveryCancel']}
            onClick={() => session.cancelRecovery()}
            data-testid="acp-recovery-cancel"
            aria-label={localize('acp.recovery.cancel', 'Cancel')}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </section>
  )
}

function describe(state: AcpRecoveryState): string {
  const { phase, attempt, maxAttempts } = state
  if (phase === 'exhausted') {
    return localize('acp.recovery.exhausted', 'Automatic recovery failed. You can retry manually.')
  }
  const secs =
    state.nextAttemptAt !== undefined
      ? Math.max(0, Math.ceil((state.nextAttemptAt - Date.now()) / 1000))
      : 0
  if (phase === 'reconnecting') {
    return secs > 0
      ? localize(
          'acp.recovery.reconnectingIn',
          'Connection lost. Reconnecting in {0}s… ({1}/{2})',
          { 0: secs, 1: attempt, 2: maxAttempts },
        )
      : localize('acp.recovery.reconnecting', 'Connection lost. Reconnecting… ({0}/{1})', {
          0: attempt,
          1: maxAttempts,
        })
  }
  return secs > 0
    ? localize(
        'acp.recovery.retryingIn',
        'Agent temporarily unavailable. Retrying in {0}s… ({1}/{2})',
        { 0: secs, 1: attempt, 2: maxAttempts },
      )
    : localize('acp.recovery.retrying', 'Agent temporarily unavailable. Retrying… ({0}/{1})', {
        0: attempt,
        1: maxAttempts,
      })
}
