/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for AgentStatusIndicator: visibility/count derived from live session
 *  status, ask state styling, and click-through to the session switcher (Alt+S).
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  ICommandService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type ISettableObservable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { IAcpSessionService } from '../../../services/acp/acpSessionService.js'
import type { AcpSessionStatus, IAcpSession } from '../../../services/acp/acpSession.js'
import {
  ISessionSwitcherService,
  type SessionStatusCounts,
} from '../../../../shared/ipc/sessionSwitcher.js'
import { AgentStatusIndicator } from '../AgentStatusIndicator.js'

function makeSession(id: string, status: AcpSessionStatus) {
  const statusObs = observableValue<AcpSessionStatus>(`test.status.${id}`, status)
  const pendingQuestion = observableValue<unknown>(`test.question.${id}`, undefined)
  const session = {
    id,
    title: id,
    status: statusObs,
    pendingQuestion,
    pendingPermission: observableValue<unknown>(`test.permission.${id}`, undefined),
  } as unknown as IAcpSession
  return { session, statusObs, pendingQuestion }
}

interface Rendered {
  sessionsObs: ISettableObservable<readonly IAcpSession[]>
}

interface SwitcherStub {
  readonly emitter: Emitter<SessionStatusCounts>
  counts: SessionStatusCounts
}

function makeSwitcher(initial: SessionStatusCounts): SwitcherStub {
  const emitter = new Emitter<SessionStatusCounts>()
  return { emitter, counts: initial }
}

function renderIndicator(
  sessions: IAcpSession[] | undefined,
  executed: string[] = [],
  switcher?: SwitcherStub,
): Rendered {
  const sc = new ServiceCollection()
  const sessionsObs = observableValue<readonly IAcpSession[]>('test.sessions', sessions ?? [])
  if (sessions) {
    sc.set(IAcpSessionService, {
      _serviceBrand: undefined,
      sessions: sessionsObs,
    } as unknown as IAcpSessionService)
  }
  if (switcher) {
    sc.set(ISessionSwitcherService, {
      _serviceBrand: undefined,
      onDidChangeCounts: switcher.emitter.event,
      getSessionCounts: () => Promise.resolve(switcher.counts),
    } as unknown as ISessionSwitcherService)
  }
  sc.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: (id: string) => {
      executed.push(id)
      return Promise.resolve(undefined)
    },
  } as unknown as ICommandService)
  render(
    <ServicesContext.Provider value={new InstantiationService(sc)}>
      <AgentStatusIndicator />
    </ServicesContext.Provider>,
  )
  return { sessionsObs }
}

describe('AgentStatusIndicator', () => {
  it('shows a muted zero pill when the session service is unavailable', () => {
    renderIndicator(undefined)
    const pill = screen.getByTestId('titlebar-agent-status')
    expect(pill.textContent).toContain('0')
    expect(pill.className).toContain('agent-status--idle')
  })

  it('shows a muted zero pill when no session is running or waiting', () => {
    renderIndicator([makeSession('a', 'idle').session])
    const pill = screen.getByTestId('titlebar-agent-status')
    expect(pill.textContent).toContain('0')
    expect(pill.className).toContain('agent-status--idle')
  })

  it('shows the running-session count', () => {
    renderIndicator([
      makeSession('a', 'running').session,
      makeSession('b', 'running').session,
      makeSession('c', 'idle').session,
    ])
    expect(screen.getByTestId('titlebar-agent-status').textContent).toContain('2')
  })

  it('reacts to status changes', () => {
    const { session, statusObs } = makeSession('a', 'idle')
    renderIndicator([session])
    expect(screen.getByTestId('titlebar-agent-status').textContent).toContain('0')

    act(() => statusObs.set('running', undefined))
    expect(screen.getByTestId('titlebar-agent-status').textContent).toContain('1')
  })

  it('flags sessions waiting for input with the ask styling', () => {
    const { session, pendingQuestion } = makeSession('a', 'running')
    pendingQuestion.set({}, undefined)
    renderIndicator([session])
    expect(screen.getByTestId('titlebar-agent-status').className).toContain('agent-status--ask')
  })

  it('opens the session switcher on click', () => {
    const executed: string[] = []
    renderIndicator([makeSession('a', 'running').session], executed)
    fireEvent.click(screen.getByTestId('titlebar-agent-status'))
    expect(executed).toEqual(['workbench.action.agent.switchSession'])
  })

  it('shows the cross-window aggregate from the switcher service', async () => {
    const switcher = makeSwitcher({ running: 4, ask: 0 })
    renderIndicator([makeSession('a', 'running').session], [], switcher)

    // Seeds from the local count until the first fetch lands.
    expect(screen.getByTestId('titlebar-agent-status').textContent).toContain('1')
    await act(async () => {})
    expect(screen.getByTestId('titlebar-agent-status').textContent).toContain('4')
  })

  it('follows aggregate updates pushed by main', async () => {
    const switcher = makeSwitcher({ running: 1, ask: 0 })
    renderIndicator([makeSession('a', 'running').session], [], switcher)
    await act(async () => {})
    expect(screen.getByTestId('titlebar-agent-status').textContent).toContain('1')

    act(() => switcher.emitter.fire({ running: 2, ask: 1 }))
    const pill = screen.getByTestId('titlebar-agent-status')
    expect(pill.textContent).toContain('3')
    expect(pill.className).toContain('agent-status--ask')
  })
})
