/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import { observableValue } from '@universe-editor/platform'
import { computeSessionDisplayStatus } from '../acpSessionStatus.js'
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
}): IAcpSession {
  return {
    status: observableValue<AcpSessionStatus>('s', opts.status),
    pendingElicitation: observableValue<AcpPendingElicitation | undefined>('e', opts.elicitation),
    pendingPermission: observableValue<AcpPendingPermission | undefined>('p', opts.permission),
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
})
