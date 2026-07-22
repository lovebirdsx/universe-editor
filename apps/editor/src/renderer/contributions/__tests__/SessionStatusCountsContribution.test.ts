/*---------------------------------------------------------------------------------------------
 *  Tests for SessionStatusCountsContribution — verifies the window's running/ask
 *  counts are reported to main on every relevant session edge.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { observableValue, type ISettableObservable } from '@universe-editor/platform'
import { SessionStatusCountsContribution } from '../SessionStatusCountsContribution.js'
import type { IAcpSessionService, IAcpSession } from '../../services/acp/acpSessionService.js'
import type { AcpSessionStatus } from '../../services/acp/acpSession.js'
import type {
  ISessionSwitcherService,
  SessionStatusCounts,
} from '../../../shared/ipc/sessionSwitcher.js'

interface FakeSession {
  status: ISettableObservable<AcpSessionStatus>
  pendingQuestion: ISettableObservable<unknown>
  pendingPermission: ISettableObservable<unknown>
}

function makeSession(status: AcpSessionStatus): FakeSession {
  return {
    status: observableValue<AcpSessionStatus>('test.status', status),
    pendingQuestion: observableValue<unknown>('test.question', undefined),
    pendingPermission: observableValue<unknown>('test.permission', undefined),
  }
}

function setup() {
  const sessionsObs = observableValue<readonly IAcpSession[]>('test.sessions', [])
  const reports: SessionStatusCounts[] = []
  const switcher = {
    reportSessionCounts: (counts: SessionStatusCounts) => {
      reports.push(counts)
      return Promise.resolve()
    },
  } as unknown as ISessionSwitcherService
  const loggerService = { createLogger: () => ({ warn: vi.fn() }) } as never
  const sessions = { sessions: sessionsObs } as unknown as IAcpSessionService

  const contribution = new SessionStatusCountsContribution(sessions, switcher, loggerService)

  return {
    contribution,
    reports,
    setSessions: (list: FakeSession[]) =>
      sessionsObs.set(list as unknown as IAcpSession[], undefined),
  }
}

describe('SessionStatusCountsContribution', () => {
  it('reports zero counts on startup', () => {
    const { reports } = setup()
    expect(reports).toEqual([{ running: 0, ask: 0 }])
  })

  it('reports running and ask counts as sessions change', () => {
    const { reports, setSessions } = setup()
    const running = makeSession('running')
    const idle = makeSession('idle')

    setSessions([running, idle])
    expect(reports[reports.length - 1]).toEqual({ running: 1, ask: 0 })

    running.pendingQuestion.set({}, undefined)
    expect(reports[reports.length - 1]).toEqual({ running: 0, ask: 1 })

    running.pendingQuestion.set(undefined, undefined)
    running.status.set('idle', undefined)
    expect(reports[reports.length - 1]).toEqual({ running: 0, ask: 0 })
  })

  it('reports when sessions are removed', () => {
    const { reports, setSessions } = setup()
    setSessions([makeSession('running'), makeSession('running')])
    expect(reports[reports.length - 1]).toEqual({ running: 2, ask: 0 })

    setSessions([])
    expect(reports[reports.length - 1]).toEqual({ running: 0, ask: 0 })
  })
})
