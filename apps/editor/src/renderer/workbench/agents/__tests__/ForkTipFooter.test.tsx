/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ForkTipFooter's visibility gating (idle + fork capability +
 *  non-readOnly) and its command delegation with a sessionId-only arg
 *  (fork-from-tip semantics).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import {
  ICommandService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import { ForkTipFooter } from '../ForkTipFooter.js'
import { ServicesContext } from '../../useService.js'
import type { IAcpSession } from '../../../services/acp/session/acpSessionService.js'
import { ForkAgentSessionAction } from '../../../actions/agentRewindActions.js'

afterEach(() => cleanup())

function fakeSession(opts: {
  status?: 'idle' | 'running'
  fork?: boolean
  readOnly?: boolean
}): IAcpSession {
  return {
    id: 's1',
    agentId: 'fake',
    status: observableValue<string>('t.status', opts.status ?? 'idle'),
    forkSupported: observableValue<boolean>('t.fork', opts.fork ?? true),
    readOnly: opts.readOnly ?? false,
  } as unknown as IAcpSession
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
    expect(container.querySelector('[data-testid="acp-fork-tip-footer"]')).toBeNull()
  })

  it('hides when the agent does not support fork', () => {
    const { container } = renderFooter(fakeSession({ fork: false }))
    expect(container.querySelector('[data-testid="acp-fork-tip-footer"]')).toBeNull()
  })

  it('hides for a read-only foreign preview', () => {
    const { container } = renderFooter(fakeSession({ readOnly: true }))
    expect(container.querySelector('[data-testid="acp-fork-tip-footer"]')).toBeNull()
  })
})
