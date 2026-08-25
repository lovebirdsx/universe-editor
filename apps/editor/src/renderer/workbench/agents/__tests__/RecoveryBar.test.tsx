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
