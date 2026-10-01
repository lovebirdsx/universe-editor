/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import { observableValue } from '@universe-editor/platform'
import {
  computeSessionDisplayStatus,
  isSessionWorking,
  isTurnDisplayStatus,
  isTurnInFlight,
} from '../acpSessionStatus.js'
import type {
  AcpPendingElicitation,
  AcpPendingPermission,
  AcpSessionStatus,
  IAcpSession,
} from '../acpSession.js'

function fakeSession(opts: {
  status: AcpSessionStatus
  elicitation?: AcpPendingElicitation
  permission?: AcpPendingPermission
  backgroundTasks?: number
  dormant?: boolean
}): IAcpSession {
  return {
    status: observableValue<AcpSessionStatus>('s', opts.status),
    isDormant: observableValue<boolean>('d', opts.dormant ?? false),
    pendingElicitation: observableValue<AcpPendingElicitation | undefined>('e', opts.elicitation),
    pendingPermission: observableValue<AcpPendingPermission | undefined>('p', opts.permission),
    backgroundTaskCount: observableValue<number>('b', opts.backgroundTasks ?? 0),
  } as unknown as IAcpSession
}

const ELICITATION = {
  request: {},
  resolve: () => {},
  cancel: () => {},
} as unknown as AcpPendingElicitation
const PERMISSION = {
  toolCallId: 't',
  title: 'x',
  options: [],
  resolve: () => {},
  cancel: () => {},
} as unknown as AcpPendingPermission

describe('computeSessionDisplayStatus', () => {
  it('mirrors status when nothing is pending', () => {
    expect(computeSessionDisplayStatus(fakeSession({ status: 'running' }))).toBe('running')
    expect(computeSessionDisplayStatus(fakeSession({ status: 'idle' }))).toBe('idle')
    expect(computeSessionDisplayStatus(fakeSession({ status: 'errored' }))).toBe('errored')
  })

  it("derives 'ask' when an elicitation is pending", () => {
    expect(
      computeSessionDisplayStatus(fakeSession({ status: 'idle', elicitation: ELICITATION })),
    ).toBe('ask')
  })

  it("derives 'ask' when a permission is pending", () => {
    expect(
      computeSessionDisplayStatus(fakeSession({ status: 'running', permission: PERMISSION })),
    ).toBe('ask')
  })

  it('never overrides closed with ask', () => {
    expect(
      computeSessionDisplayStatus(fakeSession({ status: 'closed', elicitation: ELICITATION })),
    ).toBe('closed')
  })

  it("derives 'dormant' for an idle-reaped session (closed + dormant)", () => {
    expect(computeSessionDisplayStatus(fakeSession({ status: 'closed', dormant: true }))).toBe(
      'dormant',
    )
  })

  it('keeps a user-closed session as closed', () => {
    expect(computeSessionDisplayStatus(fakeSession({ status: 'closed', dormant: false }))).toBe(
      'closed',
    )
  })

  it('terminal seal outranks ask and background even when dormant', () => {
    expect(
      computeSessionDisplayStatus(
        fakeSession({
          status: 'closed',
          dormant: true,
          elicitation: ELICITATION,
          backgroundTasks: 2,
        }),
      ),
    ).toBe('dormant')
  })

  it('ignores the dormant flag while the session is not closed', () => {
    expect(computeSessionDisplayStatus(fakeSession({ status: 'idle', dormant: true }))).toBe('idle')
  })

  it("derives 'background' when idle with background tasks in flight", () => {
    expect(computeSessionDisplayStatus(fakeSession({ status: 'idle', backgroundTasks: 2 }))).toBe(
      'background',
    )
  })

  it('never overrides closed with background', () => {
    expect(computeSessionDisplayStatus(fakeSession({ status: 'closed', backgroundTasks: 2 }))).toBe(
      'closed',
    )
  })

  it('ask outranks background', () => {
    expect(
      computeSessionDisplayStatus(
        fakeSession({ status: 'idle', elicitation: ELICITATION, backgroundTasks: 1 }),
      ),
    ).toBe('ask')
  })

  it('running outranks background (background is idle-only)', () => {
    expect(
      computeSessionDisplayStatus(fakeSession({ status: 'running', backgroundTasks: 1 })),
    ).toBe('running')
  })

  it('idle with zero background tasks stays idle', () => {
    expect(computeSessionDisplayStatus(fakeSession({ status: 'idle', backgroundTasks: 0 }))).toBe(
      'idle',
    )
  })
})

describe('isTurnDisplayStatus', () => {
  it('counts an in-flight turn, a pending ask and the background tail', () => {
    for (const status of ['running', 'ask', 'background'] as const) {
      expect(isTurnDisplayStatus(status)).toBe(true)
    }
  })

  // The regression guard for the completion notification: every new, resumed or
  // woken session settles from the handshake straight to 'idle' without a turn
  // ever running, so a turn-edge reader that counts 'connecting' announces a
  // completion for work that never happened.
  it('excludes the handshake, which settles to idle without a turn', () => {
    expect(isTurnDisplayStatus('connecting')).toBe(false)
  })

  it('excludes the settled statuses', () => {
    for (const status of ['idle', 'errored', 'dormant', 'closed'] as const) {
      expect(isTurnDisplayStatus(status)).toBe(false)
    }
  })
})

describe('isSessionWorking', () => {
  it('counts a session whose prompt RPC settled but background tasks still run', () => {
    expect(isSessionWorking(fakeSession({ status: 'idle', backgroundTasks: 1 }))).toBe(true)
  })

  it('counts the handshake, an in-flight turn and a pending ask as working', () => {
    expect(isSessionWorking(fakeSession({ status: 'connecting' }))).toBe(true)
    expect(isSessionWorking(fakeSession({ status: 'running' }))).toBe(true)
    expect(isSessionWorking(fakeSession({ status: 'idle', elicitation: ELICITATION }))).toBe(true)
    expect(isSessionWorking(fakeSession({ status: 'idle', permission: PERMISSION }))).toBe(true)
  })

  it('is false once the session is genuinely settled', () => {
    expect(isSessionWorking(fakeSession({ status: 'idle' }))).toBe(false)
    expect(isSessionWorking(fakeSession({ status: 'errored' }))).toBe(false)
  })

  it('is false for a sealed session, dormant or not', () => {
    expect(isSessionWorking(fakeSession({ status: 'closed', dormant: true }))).toBe(false)
    expect(isSessionWorking(fakeSession({ status: 'closed' }))).toBe(false)
  })

  it('is false for a sealed session even with background tasks recorded', () => {
    expect(isSessionWorking(fakeSession({ status: 'closed', backgroundTasks: 2 }))).toBe(false)
  })
})

describe('isTurnInFlight', () => {
  it('counts a session whose prompt RPC settled but background tasks still run', () => {
    expect(isTurnInFlight(fakeSession({ status: 'idle', backgroundTasks: 1 }))).toBe(true)
  })

  it('counts an in-flight turn and a pending ask', () => {
    expect(isTurnInFlight(fakeSession({ status: 'running' }))).toBe(true)
    expect(isTurnInFlight(fakeSession({ status: 'idle', elicitation: ELICITATION }))).toBe(true)
    expect(isTurnInFlight(fakeSession({ status: 'idle', permission: PERMISSION }))).toBe(true)
  })

  // The difference from isSessionWorking: gating the Stop button on the
  // handshake shows a control whose `cancelTurn()` is a no-op (no connection,
  // no agent-side session id, nothing in flight).
  it('excludes the handshake — there is no turn to stop yet', () => {
    expect(isTurnInFlight(fakeSession({ status: 'connecting' }))).toBe(false)
  })

  it('is false once the session is genuinely settled', () => {
    expect(isTurnInFlight(fakeSession({ status: 'idle' }))).toBe(false)
    expect(isTurnInFlight(fakeSession({ status: 'errored' }))).toBe(false)
    expect(isTurnInFlight(fakeSession({ status: 'closed', dormant: true }))).toBe(false)
  })
})
