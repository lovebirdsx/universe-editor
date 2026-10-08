/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RecoveryBar tests — the message for a user-requested restart must read as
 *  "restarting" (an action they asked for), never as the connection-lost error
 *  shown for crashes/stalls.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { observableValue } from '@universe-editor/platform'
import type { IAcpSession } from '../../../services/acp/session/acpSessionService.js'
import type { AcpRecoveryState } from '../../../services/acp/session/acpSessionRecovery.js'
import { RecoveryBar } from '../RecoveryBar.js'

afterEach(() => cleanup())

function makeSession(state: AcpRecoveryState): IAcpSession {
  return {
    recoveryState: observableValue<AcpRecoveryState | undefined>('recovery', state),
    cancelRecovery: () => {},
    retryRecovery: () => Promise.resolve(),
  } as unknown as IAcpSession
}

describe('RecoveryBar', () => {
  it('shows the restarting message for a user-requested restart instead of a connection-lost error', () => {
    render(
      <RecoveryBar
        session={makeSession({
          phase: 'reconnecting',
          attempt: 1,
          maxAttempts: 3,
          reason: 'restart',
        })}
      />,
    )
    const bar = screen.getByTestId('acp-recovery-bar')
    expect(bar.textContent).toContain('Restarting agent… (1/3)')
    expect(bar.textContent).not.toContain('Connection lost')
  })

  it('shows the connection-lost message for a crash reconnect', () => {
    render(
      <RecoveryBar
        session={makeSession({
          phase: 'reconnecting',
          attempt: 2,
          maxAttempts: 3,
          reason: 'crash',
        })}
      />,
    )
    const bar = screen.getByTestId('acp-recovery-bar')
    expect(bar.textContent).toContain('Connection lost. Reconnecting… (2/3)')
  })

  it('names the throttle for a rate-limited retry instead of the generic line', () => {
    // The wait here is minutes, not seconds: the bar must say what we are
    // waiting for, or a 60s countdown reads as a hang. It also shows the longer
    // attempt budget, so the user can tell how much patience is left.
    render(
      <RecoveryBar
        session={makeSession({
          phase: 'retrying',
          attempt: 3,
          maxAttempts: 8,
          reason: 'rate_limited',
          nextAttemptAt: Date.now() + 95_000,
        })}
      />,
    )
    const bar = screen.getByTestId('acp-recovery-bar')
    expect(bar.textContent).toContain('The provider is rate-limiting requests. Retrying in')
    expect(bar.textContent).toContain('(3/8)')
    expect(bar.textContent).not.toContain('Agent temporarily unavailable')
  })

  it('keeps the rate-limit wording once the budget is exhausted', () => {
    render(
      <RecoveryBar
        session={makeSession({
          phase: 'exhausted',
          attempt: 8,
          maxAttempts: 8,
          reason: 'rate_limited',
        })}
      />,
    )
    const bar = screen.getByTestId('acp-recovery-bar')
    expect(bar.textContent).toContain('The provider is still rate-limiting requests')
    expect(screen.getByTestId('acp-recovery-retry')).toBeTruthy()
  })

  it('shows the waking message when an operation revived an idle-reclaimed session', () => {
    // The idle reaper stopped the agent to save memory, so nothing was lost and
    // nothing crashed — telling the user "connection lost" here would report a
    // fault where there was only a deliberate power saving.
    render(
      <RecoveryBar
        session={makeSession({
          phase: 'reconnecting',
          attempt: 1,
          maxAttempts: 3,
          reason: 'wake',
        })}
      />,
    )
    const bar = screen.getByTestId('acp-recovery-bar')
    expect(bar.textContent).toContain('Waking agent… (1/3)')
    expect(bar.textContent).not.toContain('Connection lost')
  })
})
