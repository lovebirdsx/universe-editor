/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ForkTipFooter's visibility gating (the turn has settled — 'idle',
 *  or the idle reaper's 'closed' + dormant seal — plus fork capability and
 *  non-readOnly) and its command delegation with a sessionId-only arg
 *  (fork-from-tip semantics).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import {
  ICommandService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type ISettableObservable,
} from '@universe-editor/platform'
import { ForkTipFooter } from '../ForkTipFooter.js'
import { ServicesContext } from '../../useService.js'
import type {
  AcpSessionStatus,
  IAcpSession,
} from '../../../services/acp/session/acpSessionService.js'
import { ForkAgentSessionAction } from '../../../actions/agentRewindActions.js'

afterEach(() => cleanup())

type FakeSession = IAcpSession & {
  status: ISettableObservable<AcpSessionStatus>
  isDormant: ISettableObservable<boolean>
}

function fakeSession(opts: {
  status?: AcpSessionStatus
  dormant?: boolean
  fork?: boolean
  readOnly?: boolean
}): FakeSession {
  return {
    id: 's1',
    agentId: 'fake',
    status: observableValue<AcpSessionStatus>('t.status', opts.status ?? 'idle'),
    isDormant: observableValue<boolean>('t.dormant', opts.dormant ?? false),
    forkSupported: observableValue<boolean>('t.fork', opts.fork ?? true),
    readOnly: opts.readOnly ?? false,
  } as unknown as FakeSession
}

function renderFooter(session: IAcpSession): {
  execute: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const execute = vi.fn().mockResolvedValue(undefined)
  const services = new ServiceCollection()
  services.set(ICommandService, { executeCommand: execute } as unknown as ICommandService)
  const inst = new InstantiationService(services)
  const { container } = render(
    <ServicesContext.Provider value={inst}>
      <ForkTipFooter session={session} />
    </ServicesContext.Provider>,
  )
  return { execute, container }
}

const footer = (container: HTMLElement): Element | null =>
  container.querySelector('[data-testid="acp-fork-tip-footer"]')

describe('ForkTipFooter', () => {
  it('shows on an idle fork-capable session and delegates with sessionId only', () => {
    const { execute, container } = renderFooter(fakeSession({}))
    const button = container.querySelector('[data-testid="acp-fork-tip"]')
    expect(button).not.toBeNull()

    fireEvent.click(button!)
    expect(execute).toHaveBeenCalledWith(ForkAgentSessionAction.ID, { sessionId: 's1' })
  })

  it('hides while the session is running', () => {
    const { container } = renderFooter(fakeSession({ status: 'running' }))
    expect(footer(container)).toBeNull()
  })

  it('hides when the agent does not support fork', () => {
    const { container } = renderFooter(fakeSession({ fork: false }))
    expect(footer(container)).toBeNull()
  })

  it('hides for a read-only foreign preview', () => {
    const { container } = renderFooter(fakeSession({ readOnly: true }))
    expect(footer(container)).toBeNull()
  })

  // The no-wake half of this contract is AcpSessionService's (its own test pins
  // that forkSession leaves a dormant source asleep); this layer only pins that
  // the footer stays and still delegates the tip fork.
  it('stays visible on a dormant session and delegates like the idle case', () => {
    const { execute, container } = renderFooter(fakeSession({ status: 'closed', dormant: true }))
    const button = container.querySelector('[data-testid="acp-fork-tip"]')
    expect(button).not.toBeNull()

    fireEvent.click(button!)
    expect(execute).toHaveBeenCalledWith(ForkAgentSessionAction.ID, { sessionId: 's1' })
  })

  it('hides for a session the user really closed', () => {
    const { container } = renderFooter(fakeSession({ status: 'closed' }))
    expect(footer(container)).toBeNull()
  })

  it('hides again when a dormant session is closed', () => {
    const session = fakeSession({ status: 'closed', dormant: true })
    const { container } = renderFooter(session)
    expect(footer(container)).not.toBeNull()

    act(() => session.isDormant.set(false, undefined))
    expect(footer(container)).toBeNull()
  })

  // An 'errored' session keeps the footer hidden while its process is alive (it
  // has RecoveryBar + Retry as its own way out); only the reaper's seal to
  // dormant surfaces it. Pinned here so the asymmetry stays deliberate.
  it('appears once an errored session is reclaimed by the idle reaper', () => {
    const session = fakeSession({ status: 'errored' })
    const { container } = renderFooter(session)
    expect(footer(container)).toBeNull()

    act(() => {
      session.isDormant.set(true, undefined)
      session.status.set('closed', undefined)
    })
    expect(footer(container)).not.toBeNull()
  })
})
