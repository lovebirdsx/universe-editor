/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observableValue, type ISettableObservable } from '@universe-editor/platform'
import { createAgentAttentionSignal, type AgentAttentionEvent } from '../agentAttentionSignal.js'
import type {
  AcpPendingElicitation,
  AcpPendingPermission,
  AcpSessionStatus,
  IAcpSession,
} from '../acpSession.js'

interface FakeSession {
  id: string
  status: ISettableObservable<AcpSessionStatus>
  pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  pendingElicitation: ISettableObservable<AcpPendingElicitation | undefined>
  isDormant: ISettableObservable<boolean>
  backgroundTaskCount: ISettableObservable<number>
}

function makeSession(id = 's1'): FakeSession {
  return {
    id,
    status: observableValue<AcpSessionStatus>(`status.${id}`, 'idle'),
    pendingPermission: observableValue<AcpPendingPermission | undefined>(`perm.${id}`, undefined),
    pendingElicitation: observableValue<AcpPendingElicitation | undefined>(`eli.${id}`, undefined),
    isDormant: observableValue<boolean>(`dormant.${id}`, false),
    backgroundTaskCount: observableValue<number>(`bg.${id}`, 0),
  }
}

const PERMISSION = {
  requestId: 'r1',
  toolCallId: 't1',
  title: 'Run shell command',
  options: [],
} as unknown as AcpPendingPermission

const ELICITATION = { request: {} } as unknown as AcpPendingElicitation

function setup() {
  const sessions = observableValue<readonly IAcpSession[]>('sessions', [])
  const signal = createAgentAttentionSignal(sessions)
  const events: AgentAttentionEvent[] = []
  signal.onDidAttention((event) => events.push(event))
  const add = (session: FakeSession): void => {
    sessions.set(
      [...(sessions.get() as readonly IAcpSession[]), session as unknown as IAcpSession],
      undefined,
    )
  }
  return { sessions, signal, events, add }
}

describe('agentAttentionSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits one permission edge and skips auto-resolving cards', () => {
    const t = setup()
    const session = makeSession()
    t.add(session)

    session.status.set('running', undefined)
    session.pendingPermission.set(PERMISSION, undefined)
    session.status.set('idle', undefined)
    expect(t.events.filter((event) => event.kind === 'permission')).toHaveLength(1)

    // Still pending: an unrelated observable change must not re-emit.
    session.status.set('running', undefined)
    expect(t.events.filter((event) => event.kind === 'permission')).toHaveLength(1)

    const auto = makeSession('s2')
    t.add(auto)
    auto.pendingPermission.set(
      { ...PERMISSION, autoResolve: { optionId: 'allow', delayMs: 3000 } } as never,
      undefined,
    )
    expect(t.events.filter((event) => event.session.id === 's2')).toHaveLength(0)
  })

  it('emits a question rising edge once', () => {
    const t = setup()
    const session = makeSession()
    t.add(session)

    session.pendingElicitation.set(ELICITATION, undefined)
    expect(t.events).toEqual([{ kind: 'question', session }])
    session.pendingElicitation.set(undefined, undefined)
    session.pendingElicitation.set(ELICITATION, undefined)
    expect(t.events).toHaveLength(2)
  })

  it('debounces completion by 250ms and cancels it when work resumes', async () => {
    const t = setup()
    const session = makeSession()
    t.add(session)
    session.status.set('running', undefined)
    session.status.set('idle', undefined)

    expect(t.events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(t.events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(50)
    expect(t.events).toEqual([{ kind: 'completed', session }])

    // A late wake keeps the same turn alive; the next settle is a new edge.
    session.status.set('running', undefined)
    session.status.set('idle', undefined)
    await vi.advanceTimersByTimeAsync(100)
    session.status.set('running', undefined)
    await vi.advanceTimersByTimeAsync(500)
    expect(t.events.filter((event) => event.kind === 'completed')).toHaveLength(1)
  })

  it('does not treat connecting → idle as a completion', async () => {
    const t = setup()
    const session = makeSession()
    t.add(session)
    session.status.set('connecting', undefined)
    session.status.set('idle', undefined)
    await vi.advanceTimersByTimeAsync(300)
    expect(t.events).toHaveLength(0)
  })

  it('emits errored on the transition only', () => {
    const t = setup()
    const session = makeSession()
    t.add(session)
    session.status.set('running', undefined)
    session.status.set('errored', undefined)
    expect(t.events).toEqual([{ kind: 'errored', session }])
    session.status.set('errored', undefined)
    expect(t.events).toHaveLength(1)
  })

  it('stops watching a removed session and cancels its pending completion', async () => {
    const t = setup()
    const session = makeSession()
    t.add(session)
    session.status.set('running', undefined)
    session.status.set('idle', undefined)
    t.sessions.set([], undefined)
    await vi.advanceTimersByTimeAsync(300)
    expect(t.events).toHaveLength(0)
  })
})
