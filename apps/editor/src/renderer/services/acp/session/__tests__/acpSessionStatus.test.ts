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
  backgroundTasks?: number
}): IAcpSession {
  return {
    status: observableValue<AcpSessionStatus>('s', opts.status),
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
