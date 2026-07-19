/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for PermissionCard — focuses on the ExitPlanMode ("Ready to code?")
 *  steering input: typing an instruction and submitting must reject the plan
 *  (keep planning) AND pass the text as `feedback` on resolve (so the fork can
 *  surface it as a replayable deny message). Non-plan permission cards must not
 *  render the input at all.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { observableValue } from '@universe-editor/platform'
import type { AcpPendingPermission, IAcpSession } from '../../../services/acp/acpSessionService.js'
import { PermissionCard } from '../PermissionCard.js'

afterEach(() => {
  cleanup()
})

function planPermission(overrides?: Partial<AcpPendingPermission>): AcpPendingPermission {
  return {
    toolCallId: 't1',
    title: 'Ready to code?',
    kind: 'switch_mode',
    options: [
      { optionId: 'default', name: 'Yes, and manually approve edits', kind: 'allow_once' },
      { optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
    ],
    resolve: () => {},
    cancel: () => {},
    ...overrides,
  }
}

function bashPermission(): AcpPendingPermission {
  return {
    toolCallId: 't2',
    title: 'Run `ls`',
    kind: 'execute',
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
    resolve: () => {},
    cancel: () => {},
  }
}

function makeSession(pending: AcpPendingPermission | undefined): {
  session: IAcpSession
  sendPrompt: ReturnType<typeof vi.fn>
} {
  const sendPrompt = vi.fn(() => Promise.resolve())
  const session = {
    id: 'A',
    pendingPermission: observableValue<AcpPendingPermission | undefined>('pp:A', pending),
    sendPrompt,
  } as unknown as IAcpSession
  return { session, sendPrompt }
}

describe('PermissionCard steering (ExitPlanMode)', () => {
  it('rejects the plan and passes the typed instruction as feedback on resolve', () => {
    const resolve = vi.fn()
    const pending = planPermission({ resolve })
    const { session, sendPrompt } = makeSession(pending)
    render(<PermissionCard session={session} />)

    const input = screen.getByTestId('acp-permission-steer-input')
    fireEvent.change(input, { target: { value: '  use a worker pool instead  ' } })
    fireEvent.click(screen.getByTestId('acp-permission-steer-submit'))

    expect(resolve).toHaveBeenCalledWith('plan', 'use a worker pool instead')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('submits on Enter (without Shift)', () => {
    const resolve = vi.fn()
    const { session, sendPrompt } = makeSession(planPermission({ resolve }))
    render(<PermissionCard session={session} />)

    const input = screen.getByTestId('acp-permission-steer-input')
    fireEvent.change(input, { target: { value: 'rethink the schema' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(resolve).toHaveBeenCalledWith('plan', 'rethink the schema')
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('does not submit empty / whitespace-only input', () => {
    const resolve = vi.fn()
    const { session, sendPrompt } = makeSession(planPermission({ resolve }))
    render(<PermissionCard session={session} />)

    const input = screen.getByTestId('acp-permission-steer-input')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByTestId('acp-permission-steer-submit'))

    expect(resolve).not.toHaveBeenCalled()
    expect(sendPrompt).not.toHaveBeenCalled()
  })

  it('does not render the steering input for a non-plan permission', () => {
    const { session } = makeSession(bashPermission())
    render(<PermissionCard session={session} />)

    expect(screen.queryByTestId('acp-permission-steer-input')).toBeNull()
  })
})
