/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for AgentStatusIndicator: visibility/count derived from live session
 *  status, ask state styling, and click-through to the session switcher (Alt+S).
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import {
  ICommandService,
  InstantiationService,
  ServiceCollection,
  observableValue,
  type ISettableObservable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { IAcpSessionService } from '../../../services/acp/acpSessionService.js'
import type { AcpSessionStatus, IAcpSession } from '../../../services/acp/acpSession.js'
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

function renderIndicator(sessions: IAcpSession[] | undefined, executed: string[] = []): Rendered {
  const sc = new ServiceCollection()
  const sessionsObs = observableValue<readonly IAcpSession[]>('test.sessions', sessions ?? [])
  if (sessions) {
    sc.set(IAcpSessionService, {
      _serviceBrand: undefined,
      sessions: sessionsObs,
    } as unknown as IAcpSessionService)
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
})
