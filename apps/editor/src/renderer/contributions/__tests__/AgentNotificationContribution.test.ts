/*---------------------------------------------------------------------------------------------
 *  Tests for AgentNotificationContribution — verifies OS notifications fire on the
 *  right session edges (permission / question / completion / error), de-dupe per
 *  turn, respect the enable flag, and jump to the session when clicked.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  observableValue,
  type ISettableObservable,
  type ISystemNotificationResult,
} from '@universe-editor/platform'
import { AgentNotificationContribution } from '../AgentNotificationContribution.js'
import type { IAcpSessionService, IAcpSession } from '../../services/acp/acpSessionService.js'
import type {
  AcpSessionStatus,
  AcpPlanEntry,
  AcpPendingPermission,
  AcpPendingQuestion,
} from '../../services/acp/acpSession.js'

interface FakeSession {
  id: string
  title: string
  status: ISettableObservable<AcpSessionStatus>
  pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  pendingQuestion: ISettableObservable<AcpPendingQuestion | undefined>
  plan: ISettableObservable<readonly AcpPlanEntry[]>
}

function makeSession(id: string, title = id): FakeSession {
  return {
    id,
    title,
    status: observableValue<AcpSessionStatus>(`status.${id}`, 'idle'),
    pendingPermission: observableValue<AcpPendingPermission | undefined>(`perm.${id}`, undefined),
    pendingQuestion: observableValue<AcpPendingQuestion | undefined>(`q.${id}`, undefined),
    plan: observableValue<readonly AcpPlanEntry[]>(`plan.${id}`, []),
  }
}

function planEntry(status: AcpPlanEntry['status']): AcpPlanEntry {
  return { content: 'step', status } as AcpPlanEntry
}

function setup(opts?: { enabled?: boolean; clicked?: boolean }) {
  const enabled = opts?.enabled ?? true
  const sessionsObs = observableValue<readonly IAcpSession[]>('sessions', [])
  const notify = vi.fn(
    async (_opts: {
      title: string
      body: string
      onlyWhenBlurred?: boolean
    }): Promise<ISystemNotificationResult> => ({
      shown: true,
      clicked: opts?.clicked ?? false,
    }),
  )
  const focusWindow = vi.fn(async () => {})
  const setActive = vi.fn()
  const openViewContainer = vi.fn()
  const focusView = vi.fn(async () => true)

  const sessions = {
    sessions: sessionsObs,
    setActive,
  } as unknown as IAcpSessionService
  const host = { notify, focusWindow } as never
  const config = { get: () => enabled } as never
  const views = { openViewContainer } as never
  const layout = { getVisible: () => true, toggleVisible: vi.fn(), focusView } as never

  const contribution = new AgentNotificationContribution(sessions, host, config, views, layout)

  return {
    contribution,
    sessionsObs,
    notify,
    focusWindow,
    setActive,
    openViewContainer,
    focusView,
    addSession: (s: FakeSession) =>
      sessionsObs.set(
        [...(sessionsObs.get() as IAcpSession[]), s as unknown as IAcpSession],
        undefined,
      ),
  }
}

describe('AgentNotificationContribution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fires a completion notification when status goes running → idle', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(t.notify.mock.calls[0]![0]).toMatchObject({ body: 'a' })
  })

  it('fires an error notification when status goes → errored', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('errored', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('fires once on permission rising edge, not again while pending', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.pendingPermission.set({ toolCallId: 't', title: 'x', options: [] } as never, undefined)
    // An unrelated change re-runs the autorun but must not re-notify.
    s.status.set('running', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('fires once on question rising edge', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.pendingQuestion.set({ questions: [] } as never, undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('de-dupes completion: plan all-complete then idle fires only once', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.plan.set([planEntry('in_progress')], undefined)
    s.plan.set([planEntry('completed')], undefined)
    s.status.set('idle', undefined)
    expect(t.notify).toHaveBeenCalledTimes(1)
  })

  it('does not notify when acp.notifications.enabled is false', () => {
    const t = setup({ enabled: false })
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    expect(t.notify).not.toHaveBeenCalled()
  })

  it('on click: focuses window, activates the session, and opens the Agents view', async () => {
    const t = setup({ clicked: true })
    const s = makeSession('a')
    t.addSession(s)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    // Let the notify promise resolve and the click handler run.
    await Promise.resolve()
    await Promise.resolve()
    expect(t.focusWindow).toHaveBeenCalled()
    expect(t.setActive).toHaveBeenCalledWith('a')
    expect(t.openViewContainer).toHaveBeenCalledWith('workbench.view.agents')
    expect(t.focusView).toHaveBeenCalledWith('workbench.view.agents.main', { source: 'command' })
  })

  it('stops watching a session once it leaves the list', () => {
    const t = setup()
    const s = makeSession('a')
    t.addSession(s)
    t.sessionsObs.set([], undefined)
    s.status.set('running', undefined)
    s.status.set('idle', undefined)
    expect(t.notify).not.toHaveBeenCalled()
  })
})
