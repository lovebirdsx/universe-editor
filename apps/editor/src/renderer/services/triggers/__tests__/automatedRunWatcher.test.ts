/*---------------------------------------------------------------------------------------------
 *  Tests for the automated-run watchdog: cost / active-time / approval timeouts,
 *  normal completion, session error / close, and single-terminal-outcome
 *  semantics. Uses an injected clock so the whole matrix runs instantly.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '@universe-editor/platform'
import type { IObservable, ISettableObservable } from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import type {
  AcpPendingElicitation,
  AcpPendingPermission,
  AcpSessionStatus,
  AcpUsage,
  IAcpSession,
} from '../../acp/session/acpSessionModel.js'
import type { TriggerRunEnd, TriggerRunRequest } from '../../../../shared/triggers/types.js'
import { AutomatedRunWatcher, type AutomatedVerdictResolution } from '../automatedRunWatcher.js'

class FakeClock {
  private _now = 0
  private _nextId = 1
  private readonly _timers = new Map<number, { at: number; fn: () => void }>()

  now = (): number => this._now

  setTimeout = (fn: () => void, ms: number): number => {
    const id = this._nextId++
    this._timers.set(id, { at: this._now + ms, fn })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this._timers.delete(handle as number)
  }

  advance(ms: number): void {
    const target = this._now + ms
    for (;;) {
      let nextId: number | undefined
      let nextAt = Number.POSITIVE_INFINITY
      for (const [id, timer] of this._timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at
          nextId = id
        }
      }
      if (nextId === undefined) break
      const timer = this._timers.get(nextId)!
      this._timers.delete(nextId)
      this._now = timer.at
      timer.fn()
    }
    this._now = target
  }
}

interface FakeSession {
  readonly session: IAcpSession
  readonly status: ISettableObservable<AcpSessionStatus>
  readonly usage: ISettableObservable<AcpUsage | undefined>
  readonly pendingPermission: ISettableObservable<AcpPendingPermission | undefined>
  readonly pendingElicitation: ISettableObservable<AcpPendingElicitation | undefined>
  readonly sessionIdOnAgent: ISettableObservable<string | undefined>
  readonly cancelTurn: ReturnType<typeof vi.fn>
}

function makeSession(): FakeSession {
  const status = observableValue<AcpSessionStatus>('test.status', 'idle')
  const usage = observableValue<AcpUsage | undefined>('test.usage', undefined)
  const pendingPermission = observableValue<AcpPendingPermission | undefined>(
    'test.pendingPermission',
    undefined,
  )
  const pendingElicitation = observableValue<AcpPendingElicitation | undefined>(
    'test.pendingElicitation',
    undefined,
  )
  const sessionIdOnAgent = observableValue<string | undefined>('test.sessionIdOnAgent', 'agent-1')
  const cancelTurn = vi.fn(async () => undefined)
  const session = {
    id: 'local-1',
    sessionIdOnAgent: sessionIdOnAgent as IObservable<string | undefined>,
    status: status as IObservable<AcpSessionStatus>,
    usage: usage as IObservable<AcpUsage | undefined>,
    pendingPermission: pendingPermission as IObservable<AcpPendingPermission | undefined>,
    pendingElicitation: pendingElicitation as IObservable<AcpPendingElicitation | undefined>,
    cancelTurn,
  } as unknown as IAcpSession
  return {
    session,
    status,
    usage,
    pendingPermission,
    pendingElicitation,
    sessionIdOnAgent,
    cancelTurn,
  }
}

function pendingPermission(): AcpPendingPermission {
  return {
    requestId: 'req-1',
    toolCallId: 'tc-1',
    title: 'Write file',
    options: [],
    resolve: () => undefined,
    cancel: () => undefined,
    resolveWithSource: () => undefined,
    cancelWithSource: () => undefined,
  }
}

function pendingElicitation(): AcpPendingElicitation {
  return {
    requestId: 'q-1',
    request: {} as AcpPendingElicitation['request'],
    resolve: () => undefined,
    cancel: () => undefined,
    resolveWithSource: () => undefined,
    cancelWithSource: () => undefined,
  }
}

function makeRequest(overrides: Partial<TriggerRunRequest['budget']> = {}): TriggerRunRequest {
  return {
    origin: {
      triggerId: 'trig',
      triggerName: 'Trigger',
      eventKey: 'event:1',
      runId: 'run-1',
    },
    cwd: '/repo',
    allowElevatedMode: false,
    prompt: 'do it',
    runDir: '/userData/triggers/runs/run-1',
    budget: { maxCostUsd: 1, timeoutMin: 1, approvalTimeoutMin: 1, ...overrides },
    allowedActions: [],
    approveConfirmed: false,
    payload: {},
  }
}

function setup(
  options: {
    request?: TriggerRunRequest
    raw?: string
    resolveVerdict?: (
      raw: string | undefined,
      request: TriggerRunRequest,
    ) => AutomatedVerdictResolution
  } = {},
) {
  const clock = new FakeClock()
  const fake = makeSession()
  const ends: TriggerRunEnd[] = []
  const resolver =
    options.resolveVerdict ??
    ((raw: string | undefined): AutomatedVerdictResolution =>
      raw === undefined ? { actions: [] } : { verdict: 'info', summary: raw, actions: [] })
  const watcher = new AutomatedRunWatcher({
    request: options.request ?? makeRequest(),
    session: fake.session,
    readResultFile: async () => options.raw,
    resolveVerdict: resolver,
    onRunEnd: (end) => ends.push(end),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  return { clock, fake, watcher, ends }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('AutomatedRunWatcher', () => {
  it('completes when the turn settles with no open card', async () => {
    const { fake, watcher, ends } = setup({ raw: '{"verdict":"info"}' })
    watcher.start()
    fake.status.set('running', undefined)
    watcher.notifyTurnSettled()
    await flush()
    expect(ends).toHaveLength(1)
    expect(ends[0]!.outcome).toBe('completed')
    expect(ends[0]!.runId).toBe('run-1')
    expect(ends[0]!.sessionId).toBe('agent-1')
  })

  it('waits for an open card before completing', async () => {
    const { fake, watcher, ends } = setup()
    watcher.start()
    fake.status.set('running', undefined)
    fake.pendingPermission.set(pendingPermission(), undefined)
    watcher.notifyTurnSettled()
    await flush()
    expect(ends).toHaveLength(0)
    fake.pendingPermission.set(undefined, undefined)
    await flush()
    expect(ends).toHaveLength(1)
    expect(ends[0]!.outcome).toBe('completed')
  })

  it('cancels the turn and reports budget-exceeded at the cost ceiling', async () => {
    const { fake, watcher, ends } = setup()
    watcher.start()
    fake.status.set('running', undefined)
    fake.usage.set({ used: 10, size: 100, cost: { amount: 1.5, currency: 'USD' } }, undefined)
    await flush()
    expect(ends[0]!.outcome).toBe('budget-exceeded')
    expect(fake.cancelTurn).toHaveBeenCalled()
  })

  it('reports timeout after the active-time budget', async () => {
    const { clock, fake, watcher, ends } = setup({ request: makeRequest({ timeoutMin: 1 }) })
    watcher.start()
    fake.status.set('running', undefined)
    clock.advance(60_000)
    await flush()
    expect(ends[0]!.outcome).toBe('timeout')
    expect(fake.cancelTurn).toHaveBeenCalled()
  })

  it('excludes time spent waiting on a card from the active budget', async () => {
    const { clock, fake, watcher, ends } = setup({
      request: makeRequest({ timeoutMin: 2, approvalTimeoutMin: 100 }),
    })
    watcher.start()
    fake.status.set('running', undefined)
    clock.advance(30_000)
    fake.pendingPermission.set(pendingPermission(), undefined)
    clock.advance(10 * 60_000)
    expect(ends).toHaveLength(0)
    fake.pendingPermission.set(undefined, undefined)
    clock.advance(89_000)
    expect(ends).toHaveLength(0)
    clock.advance(1_000)
    await flush()
    expect(ends[0]!.outcome).toBe('timeout')
  })

  it('reports approval-timeout when a card is left open too long', async () => {
    const { clock, fake, watcher, ends } = setup({
      request: makeRequest({ timeoutMin: 60, approvalTimeoutMin: 1 }),
    })
    watcher.start()
    fake.status.set('running', undefined)
    fake.pendingElicitation.set(pendingElicitation(), undefined)
    clock.advance(60_000)
    await flush()
    expect(ends[0]!.outcome).toBe('approval-timeout')
    expect(fake.cancelTurn).toHaveBeenCalled()
  })

  it('reports failed on session error and cancelled on close', async () => {
    const errored = setup()
    errored.watcher.start()
    errored.fake.status.set('errored', undefined)
    await flush()
    expect(errored.ends[0]!.outcome).toBe('failed')

    const closed = setup()
    closed.watcher.start()
    closed.fake.status.set('closed', undefined)
    await flush()
    expect(closed.ends[0]!.outcome).toBe('cancelled')
  })

  it('cancel() ends once with outcome cancelled', async () => {
    const { fake, watcher, ends } = setup()
    watcher.start()
    fake.status.set('running', undefined)
    watcher.cancel()
    watcher.cancel()
    await flush()
    expect(ends).toHaveLength(1)
    expect(ends[0]!.outcome).toBe('cancelled')
    expect(fake.cancelTurn).toHaveBeenCalledTimes(1)
  })

  it('emits exactly one terminal outcome even after further status changes', async () => {
    const { fake, watcher, ends } = setup()
    watcher.start()
    fake.status.set('running', undefined)
    watcher.notifyTurnSettled()
    await flush()
    fake.status.set('errored', undefined)
    fake.status.set('closed', undefined)
    await flush()
    expect(ends).toHaveLength(1)
  })

  it('feeds the raw result text to the injected resolver and copies its verdict', async () => {
    const raw = '{"verdict":"auto-approve","summary":"ok"}'
    let seenRaw: string | undefined
    const { watcher, ends } = setup({
      raw,
      resolveVerdict: (text) => {
        seenRaw = text
        return {
          verdict: 'auto-approve',
          summary: 'ok',
          actions: [{ type: 'swarm.vote', target: '42', result: 'ok' }],
        }
      },
    })
    watcher.start()
    watcher.notifyTurnSettled()
    await flush()
    expect(seenRaw).toBe(raw)
    expect(ends[0]).toMatchObject({
      outcome: 'completed',
      verdict: 'auto-approve',
      summary: 'ok',
      actions: [{ type: 'swarm.vote', target: '42', result: 'ok' }],
    })
  })

  it('defaults to no verdict and no actions when no resolver is supplied', async () => {
    const clock = new FakeClock()
    const fake = makeSession()
    const ends: TriggerRunEnd[] = []
    const watcher = new AutomatedRunWatcher({
      request: makeRequest(),
      session: fake.session,
      readResultFile: async () => '{"anything":true}',
      onRunEnd: (end) => ends.push(end),
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    watcher.start()
    watcher.notifyTurnSettled()
    await flush()
    expect(ends[0]!.verdict).toBeUndefined()
    expect(ends[0]!.actions).toEqual([])
  })
})
