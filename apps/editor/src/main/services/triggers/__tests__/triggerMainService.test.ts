/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/triggers/triggerMainService.ts
 *  Fake clock + fake window hosts + temp userData dirs; no Electron.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import { URI, type ILogger, type IOpenWindowInfo } from '@universe-editor/platform'
import type {
  ITriggerRunHost,
  SwarmNeedsActionReview,
} from '../../../../shared/ipc/triggerService.js'
import type { TriggerRunRequest, TriggerSummary } from '../../../../shared/triggers/types.js'
import { TriggerMainService, type TriggerClock } from '../triggerMainService.js'
import type { PollCommandFetcher, PollFetchResult } from '../pollCommandFetcher.js'

const START = new Date(2026, 2, 2, 8, 0, 0, 0).getTime()
const GRACE_MS = 60_000

const dirs: string[] = []
const services: TriggerMainService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose()
  await settle()
  for (const dir of dirs.splice(0)) await removeDir(dir)
})

class FakeClock implements TriggerClock {
  private _now: number
  private _seq = 0
  private readonly _timers = new Map<number, { at: number; callback: () => void }>()

  constructor(start = START) {
    this._now = start
  }

  now = (): number => this._now

  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = ++this._seq
    this._timers.set(id, { at: this._now + Math.max(0, ms), callback })
    return id
  }

  clearTimeout = (handle: unknown): void => {
    this._timers.delete(handle as number)
  }

  get pendingTimers(): number {
    return this._timers.size
  }

  async advance(ms: number): Promise<void> {
    const target = this._now + ms
    for (;;) {
      const next = [...this._timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (next === undefined) break
      this._timers.delete(next[0])
      this._now = Math.max(this._now, next[1].at)
      next[1].callback()
      await settle()
    }
    this._now = target
  }
}

/** Real macrotask ticks so async fs work settles while the service clock stays fake. */
async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt === 4) throw err
      await settle()
    }
  }
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function createLogger(): { logger: ILogger; lines: string[] } {
  const lines: string[] = []
  const logger = {
    level: 0,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
    setLevel: () => undefined,
    trace: (message: string) => lines.push(`trace: ${message}`),
    debug: (message: string) => lines.push(`debug: ${message}`),
    info: (message: string) => lines.push(`info: ${message}`),
    warn: (message: string) => lines.push(`warn: ${message}`),
    error: (message: string) => lines.push(`error: ${message}`),
    flush: () => undefined,
  } as unknown as ILogger
  return { logger, lines }
}

const BUDGET = { maxCostUsd: 1, timeoutMin: 30, approvalTimeoutMin: 1440 }

function makeTrigger(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'trigger-1',
    name: 'Trigger One',
    enabled: true,
    workspace,
    source: { type: 'manual' },
    session: { prompt: 'Do the thing', budget: BUDGET },
    allowedActions: [],
    concurrency: 1,
    overflow: 'queue',
    ...overrides,
  }
}

function review(reviewId: string): SwarmNeedsActionReview {
  return {
    reviewId,
    author: 'testuser',
    description: 'a review',
    state: 'needsReview',
    version: 1,
    updated: 1,
  }
}

interface HarnessOptions {
  readonly triggers?: (workspace: string) => readonly unknown[]
  readonly maxConcurrentRuns?: number
  readonly state?: unknown
  readonly fetch?: PollCommandFetcher
  readonly trusted?: boolean
  readonly startRunError?: Error
  readonly holdStartRun?: boolean
  readonly startRunTimeoutMs?: number
  readonly registerHost?: boolean
  readonly openRegistersHost?: boolean
  readonly hostWaitTimeoutMs?: number
  readonly stateDebounceMs?: number
  readonly startupGraceMs?: number
  readonly workspace?: string
}

interface Harness {
  readonly service: TriggerMainService
  readonly clock: FakeClock
  readonly dir: string
  readonly workspace: string
  readonly configFile: string
  readonly loggerLines: string[]
  readonly notify: ReturnType<typeof vi.fn>
  readonly startRun: ReturnType<typeof vi.fn>
  readonly cancelRun: ReturnType<typeof vi.fn>
  readonly isWorkspaceTrusted: ReturnType<typeof vi.fn>
  readonly openWindow: ReturnType<typeof vi.fn>
  readonly host: ITriggerRunHost
  readonly openWindows: IOpenWindowInfo[]
  readonly requests: TriggerRunRequest[]
  registerHost(windowId?: number): void
  releaseStartRun(): void
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkTempDir('ue-triggers-main-')
  dirs.push(dir)
  const workspace = options.workspace ?? join(dir, 'workspace')
  const triggerDir = join(dir, 'triggers')
  await mkdir(triggerDir, { recursive: true })
  const configFile = join(triggerDir, 'triggers.json')
  const config = {
    version: 1,
    maxConcurrentRuns: options.maxConcurrentRuns ?? 2,
    triggers: options.triggers?.(workspace) ?? [],
  }
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  if (options.state !== undefined) {
    await writeFile(join(triggerDir, 'state.json'), JSON.stringify(options.state), 'utf8')
  }

  const clock = new FakeClock()
  const { logger, lines } = createLogger()
  const requests: TriggerRunRequest[] = []
  let releaseStart: (() => void) | undefined
  const startRun = vi.fn(async (request: TriggerRunRequest) => {
    requests.push(request)
    if (options.holdStartRun === true) {
      await new Promise<void>((resolve) => {
        releaseStart = resolve
      })
    }
    if (options.startRunError !== undefined) throw options.startRunError
    return { sessionId: `session-${requests.length}` }
  })
  const isWorkspaceTrusted = vi.fn(async () => options.trusted ?? true)
  const cancelRun = vi.fn(async () => undefined)
  const host: ITriggerRunHost = {
    _serviceBrand: undefined,
    startRun,
    cancelRun,
    isWorkspaceTrusted,
  }
  const openWindows: IOpenWindowInfo[] = []
  const notify = vi.fn()
  const service = new TriggerMainService({
    userDataDir: dir,
    logger,
    clock,
    notify,
    ...(options.fetch === undefined ? {} : { fetchPollItems: options.fetch }),
    startupGraceMs: options.startupGraceMs ?? GRACE_MS,
    hostWaitTimeoutMs: options.hostWaitTimeoutMs ?? 20,
    hostWaitPollMs: 5,
    ...(options.startRunTimeoutMs === undefined
      ? {}
      : { startRunTimeoutMs: options.startRunTimeoutMs }),
    stateDebounceMs: options.stateDebounceMs ?? 0,
    uuid: (() => {
      let counter = 0
      // UUID-shaped so the state loader keeps replayed pending records.
      return () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
    })(),
  })
  services.push(service)
  const openWindow = vi.fn(async (folder: URI) => {
    if (options.openRegistersHost === false) return
    const windowId = 2
    openWindows.push({ id: windowId, folder: folder.toJSON(), name: 'opened' })
    service.registerWindowHost(windowId, host)
  })
  service.setWindowProvider({
    getOpenWindowInfos: () => openWindows,
    openWindowForFolderInBackground: openWindow,
  })

  const registerHost = (windowId = 1): void => {
    if (!openWindows.some((entry) => entry.id === windowId)) {
      openWindows.push({ id: windowId, folder: URI.file(workspace).toJSON(), name: 'ws' })
    }
    service.registerWindowHost(windowId, host)
  }
  if (options.registerHost !== false) registerHost()

  return {
    service,
    clock,
    dir,
    workspace,
    configFile,
    loggerLines: lines,
    notify,
    startRun,
    cancelRun,
    isWorkspaceTrusted,
    openWindow,
    host,
    openWindows,
    requests,
    registerHost,
    releaseStartRun: () => releaseStart?.(),
  }
}

async function openGate(harness: Harness): Promise<void> {
  await harness.service.initialize()
  await harness.clock.advance(GRACE_MS)
  await settle()
}

function pollSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'poll',
    intervalSec: 30,
    fetch: { type: 'command', command: 'node fetch.js', timeoutSec: 10 },
    keyField: 'id',
    ...overrides,
  }
}

function summary(list: readonly TriggerSummary[], id: string): TriggerSummary {
  const found = list.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`summary ${id} missing`)
  return found
}

interface RawState {
  readonly pending: readonly { readonly runId: string }[]
  readonly triggers: Readonly<
    Record<
      string,
      {
        readonly processed: Record<string, unknown>
        readonly baselineDone?: boolean
        readonly sourceFingerprint?: string
      }
    >
  >
}

function stateOf(service: TriggerMainService): RawState {
  return (service as unknown as { _state: RawState })._state
}

describe('TriggerMainService scheduling', () => {
  it('A1: creates no timers when every trigger is disabled', async () => {
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items: [] }))
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, { id: 'off-manual', enabled: false }),
        makeTrigger(workspace, {
          id: 'off-schedule',
          enabled: false,
          source: { type: 'schedule', everyMin: 1, onMissed: 'skip' },
        }),
        makeTrigger(workspace, { id: 'off-poll', enabled: false, source: pollSource() }),
      ],
      fetch,
    })
    await openGate(harness)
    expect(harness.startRun).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(harness.clock.pendingTimers).toBe(0)
  })

  it('does not schedule before the startup grace elapses', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          source: { type: 'schedule', everyMin: 5, onMissed: 'skip' },
        }),
      ],
    })
    await harness.service.initialize()
    await harness.clock.advance(GRACE_MS - 1)
    expect(harness.startRun).not.toHaveBeenCalled()
    await harness.clock.advance(1)
    await settle()
    const list = await harness.service.listTriggers()
    expect(summary(list, 'trigger-1').nextRunAt).toBe(START + GRACE_MS + 5 * 60_000)
    expect(harness.startRun).not.toHaveBeenCalled()
  })

  it('fires a schedule slot and skips missed slots per onMissed', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          concurrency: 2,
          source: { type: 'schedule', everyMin: 5, onMissed: 'skip' },
        }),
      ],
    })
    await openGate(harness)
    await harness.clock.advance(5 * 60_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.origin.eventKey).toMatch(/^schedule:/)

    await harness.clock.advance(5 * 60_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(2)
    expect(harness.requests[1]?.origin.eventKey).not.toBe(harness.requests[0]?.origin.eventKey)
  })

  it('uses the persisted lastScheduledAt to drop missed slots across a restart', async () => {
    const lastScheduledAt = START - 3 * 60 * 60_000 - 5 * 60_000
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          source: { type: 'schedule', everyMin: 10, onMissed: 'skip' },
        }),
      ],
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: {},
            paused: false,
            consecutiveFailures: 0,
            baselineDone: false,
            lastScheduledAt,
          },
        },
        pending: [],
      },
    })
    await openGate(harness)
    expect(harness.startRun).not.toHaveBeenCalled()
    expect(harness.loggerLines.some((line) => line.includes('skipped'))).toBe(true)
  })

  it('catches up exactly one missed slot with onMissed=catch-up-once', async () => {
    const lastScheduledAt = START - 3 * 60 * 60_000 - 5 * 60_000
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          source: { type: 'schedule', everyMin: 10, onMissed: 'catch-up-once' },
        }),
      ],
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: {},
            paused: false,
            consecutiveFailures: 0,
            baselineDone: false,
            lastScheduledAt,
          },
        },
        pending: [],
      },
    })
    await openGate(harness)
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })
})

describe('TriggerMainService dedupe', () => {
  it('A4: never runs the same poll key twice, including across a restart', async () => {
    const items = [{ key: 'R-1', payload: { id: 'R-1' } }]
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
    })
    await openGate(harness)
    // First poll only seeds the baseline.
    expect(harness.startRun).not.toHaveBeenCalled()

    items.push({ key: 'R-2', payload: { id: 'R-2' } })
    await harness.clock.advance(30_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.origin.eventKey).toBe('poll:R-2')

    await harness.clock.advance(30_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.loggerLines.some((line) => line.includes('duplicate event poll:R-2'))).toBe(true)

    harness.service.dispose()
    await settle()

    const restarted = new TriggerMainService({
      userDataDir: harness.dir,
      logger: createLogger().logger,
      clock: harness.clock,
      fetchPollItems: fetch,
      startupGraceMs: GRACE_MS,
      hostWaitTimeoutMs: 20,
      hostWaitPollMs: 5,
      stateDebounceMs: 0,
    })
    services.push(restarted)
    restarted.setWindowProvider({
      getOpenWindowInfos: () => harness.openWindows,
      openWindowForFolderInBackground: async () => undefined,
    })
    restarted.registerWindowHost(1, harness.host)
    await restarted.initialize()
    await harness.clock.advance(GRACE_MS)
    await settle()
    await harness.clock.advance(30_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('dedupes swarm reviews across windows and keeps the first report as the baseline', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, { id: 'swarm', source: { type: 'swarm-review' } }),
      ],
    })
    await openGate(harness)

    await harness.service.reportSwarmNeedsAction([review('1')])
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()

    await harness.service.reportSwarmNeedsAction([review('1')])
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()

    await harness.service.reportSwarmNeedsAction([review('1'), review('2')])
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.origin.eventKey).toBe('swarm:2')
    expect(harness.requests[0]?.payload).toEqual({
      reviewId: '2',
      author: 'testuser',
      description: 'a review',
      state: 'needsReview',
      version: 1,
      updated: 1,
    })

    await harness.service.reportSwarmNeedsAction([review('1'), review('2')])
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.sourceType).toBe('swarm-review')
  })

  it('produces a single run for two concurrent reports of the same review', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, { id: 'swarm', source: { type: 'swarm-review' } }),
      ],
    })
    await openGate(harness)
    // First report seeds the baseline with review 0.
    await harness.service.reportSwarmNeedsAction([review('0')])
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()

    await Promise.all([
      harness.service.reportSwarmNeedsAction([review('1')]),
      harness.service.reportSwarmNeedsAction([review('1')]),
    ])
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.origin.eventKey).toBe('swarm:1')
  })
})

describe('TriggerMainService queueing', () => {
  it('enforces the global concurrency limit and starts the queued run on completion', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [
        makeTrigger(workspace, {
          id: 'a',
          source: { type: 'schedule', everyMin: 5, onMissed: 'skip' },
        }),
        makeTrigger(workspace, {
          id: 'b',
          source: { type: 'schedule', everyMin: 5, onMissed: 'skip' },
        }),
      ],
    })
    await openGate(harness)
    await harness.clock.advance(5 * 60_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    const runningId = harness.requests[0]!.origin.triggerId
    const otherId = runningId === 'a' ? 'b' : 'a'
    const list = await harness.service.listTriggers()
    expect(summary(list, runningId).running).toBe(1)
    expect(summary(list, otherId).queued).toBe(1)

    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: runningId,
      outcome: 'completed',
      actions: [],
    })
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(2)
    expect(harness.requests[1]?.origin.triggerId).toBe(otherId)
  })

  it('replays a queued run after a restart from the pending payload', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    await harness.service.runNow('trigger-1')
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    const firstRunId = harness.requests[0]!.origin.runId

    harness.service.dispose()
    await settle()

    const restarted = new TriggerMainService({
      userDataDir: harness.dir,
      logger: createLogger().logger,
      clock: harness.clock,
      startupGraceMs: GRACE_MS,
      hostWaitTimeoutMs: 20,
      hostWaitPollMs: 5,
      stateDebounceMs: 0,
    })
    services.push(restarted)
    restarted.setWindowProvider({
      getOpenWindowInfos: () => harness.openWindows,
      openWindowForFolderInBackground: async () => harness.openWindow(URI.file(harness.workspace)),
    })
    restarted.registerWindowHost(1, harness.host)
    await restarted.initialize()
    await harness.clock.advance(GRACE_MS)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(2)
    expect(harness.requests[1]?.origin.runId).not.toBe(firstRunId)
  })
})

describe('TriggerMainService failures', () => {
  it('backs off and auto-pauses after five consecutive failures with a notification', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      startRunError: new Error('boom'),
    })
    await openGate(harness)
    for (let attempt = 1; attempt <= 5; attempt++) {
      await harness.service.runNow('trigger-1')
      // A fixed tick count is not enough under load: the next runNow would hit the
      // still-occupied concurrency slot before this failure is recorded.
      await vi.waitFor(async () => {
        const current = summary(await harness.service.listTriggers(), 'trigger-1')
        expect(current.consecutiveFailures).toBe(attempt)
      })
    }
    const list = await harness.service.listTriggers()
    const item = summary(list, 'trigger-1')
    expect(item.status).toBe('paused')
    expect(item.consecutiveFailures).toBe(5)
    expect(harness.notify).toHaveBeenCalledTimes(1)
    expect(harness.loggerLines.some((line) => line.includes('auto-paused'))).toBe(true)

    harness.service.dispose()
    await settle()
    const state = JSON.parse(
      await readFile(join(harness.dir, 'triggers', 'state.json'), 'utf8'),
    ) as { triggers: Record<string, { paused: boolean; backoffUntil: number }> }
    expect(state.triggers['trigger-1']?.paused).toBe(true)
    expect(state.triggers['trigger-1']?.backoffUntil).toBeGreaterThan(harness.clock.now())

    const audit = await readFile(join(harness.dir, 'triggers', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('auto-pause')
  })

  it('refuses to run when the workspace is untrusted', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      trusted: false,
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastError).toContain('not trusted')
    expect(item.consecutiveFailures).toBe(1)
  })

  it('fails a run whose window closes', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    harness.service.unregisterWindowHost(1)
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastError).toContain('closed')
    expect(item.consecutiveFailures).toBe(1)
  })

  it('times out a wedged startRun, releases the slot and cancels the late session', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
      startRunTimeoutMs: 1_000,
      holdStartRun: true,
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    const runId = harness.requests[0]!.origin.runId

    await harness.clock.advance(1_000)
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.running).toBe(0)
    expect(item.consecutiveFailures).toBe(1)
    expect(item.lastError).toContain('did not start')
    expect(harness.cancelRun).not.toHaveBeenCalled()

    // The renderer finally answers: the session must be cancelled, not adopted.
    harness.releaseStartRun()
    await settle()
    expect(harness.cancelRun).toHaveBeenCalledWith(runId)
    expect(harness.loggerLines.some((line) => line.includes('after the timeout'))).toBe(true)
  })

  it('accepts a start that returns within the timeout and never cancels it', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      startRunTimeoutMs: 1_000,
      holdStartRun: true,
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    await harness.clock.advance(500)
    harness.releaseStartRun()
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.running).toBe(1)
    expect(item.consecutiveFailures).toBe(0)
    expect(harness.cancelRun).not.toHaveBeenCalled()
  })

  it('frees the slot for a queued run after the start times out', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
      startRunTimeoutMs: 1_000,
      holdStartRun: true,
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    await harness.service.runNow('trigger-1')
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').queued).toBe(1)

    await harness.clock.advance(1_000)
    await settle()
    // The timed-out run released its slot, so the queued one now holds it.
    expect(harness.startRun).toHaveBeenCalledTimes(2)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').running).toBe(1)
  })
})

describe('TriggerMainService elevated mode', () => {
  const elevated = { mode: 'bypassPermissions' }

  it('refuses to run an unconfirmed elevated trigger and only runs after confirmation', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          session: { prompt: 'Do it', budget: BUDGET, ...elevated },
        }),
      ],
    })
    await openGate(harness)
    await expect(harness.service.runNow('trigger-1')).rejects.toThrow(/elevated mode/)
    expect(harness.startRun).not.toHaveBeenCalled()

    const before = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(before.status).toBe('needs-confirmation')
    expect(before.elevatedModeConfirmed).toBe(false)

    await harness.service.confirmElevatedMode('trigger-1')
    await harness.service.runNow('trigger-1')
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.allowElevatedMode).toBe(true)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').elevatedModeConfirmed).toBe(
      true,
    )
  })

  it('invalidates the confirmation when the trigger config changes', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          session: { prompt: 'Do it', budget: BUDGET, ...elevated },
        }),
      ],
    })
    await openGate(harness)
    await harness.service.confirmElevatedMode('trigger-1')

    await writeFile(
      harness.configFile,
      JSON.stringify({
        version: 1,
        maxConcurrentRuns: 2,
        triggers: [
          makeTrigger(harness.workspace, {
            name: 'Renamed',
            session: { prompt: 'Do it', budget: BUDGET, ...elevated },
          }),
        ],
      }),
      'utf8',
    )
    await waitFor(async () => {
      const list = await harness.service.listTriggers()
      return summary(list, 'trigger-1').name === 'Renamed'
    })
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.elevatedModeConfirmed).toBe(false)
    await expect(harness.service.runNow('trigger-1')).rejects.toThrow(/elevated mode/)
  })
})

describe('TriggerMainService poll source', () => {
  it('seeds the baseline on the first poll and fires only new keys', async () => {
    const items: Array<{ key: string; payload: Record<string, string> }> = [
      { key: 'A', payload: { id: 'A' } },
    ]
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
    })
    await openGate(harness)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(harness.startRun).not.toHaveBeenCalled()

    items.push({ key: 'B', payload: { id: 'B' } })
    await harness.clock.advance(30_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.origin.eventKey).toBe('poll:B')
    expect(harness.requests[0]?.payload).toEqual({ id: 'B' })
  })

  it('backs off after a failed poll and pauses after five failures', async () => {
    const fetch = vi.fn<PollCommandFetcher>(
      async (): Promise<PollFetchResult> => ({ ok: false, error: 'command failed' }),
    )
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
    })
    await openGate(harness)
    expect(fetch).toHaveBeenCalledTimes(1)

    // First failure: 1m backoff > the 30s interval.
    await harness.clock.advance(30_000)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 4; index++) {
      await harness.clock.advance(60_000)
      await settle()
    }
    await harness.clock.advance(16 * 60_000)
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.status).toBe('paused')
    expect(harness.notify).toHaveBeenCalledTimes(1)
  })
})

describe('TriggerMainService window routing', () => {
  it('uses a window that is already open and never opens a new one', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    expect(harness.openWindow).not.toHaveBeenCalled()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.cwd).toBe(harness.workspace)
  })

  it('opens a background window when none is open, then waits for its host', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      registerHost: false,
      openRegistersHost: true,
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle(20)
    expect(harness.openWindow).toHaveBeenCalledTimes(1)
    expect(harness.openWindow.mock.calls[0]?.[0]?.toString()).toBe(
      URI.file(harness.workspace).toString(),
    )
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('fails the run and backs off when the opened window never registers a host', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      registerHost: false,
      openRegistersHost: false,
      hostWaitTimeoutMs: 15,
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle(20)
    expect(harness.startRun).not.toHaveBeenCalled()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastError).toContain('Timed out')
    expect(item.consecutiveFailures).toBe(1)
  })
})

describe('TriggerMainService pause gate', () => {
  it('drops queued runs when a trigger is paused and forgets their keys', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    await harness.service.runNow('trigger-1')
    await settle()
    expect(summary(await harness.service.listTriggers(), 'trigger-1').queued).toBe(1)
    const firstKey = harness.requests[0]!.origin.eventKey

    await harness.service.setPaused('trigger-1', true)
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.queued).toBe(0)
    // The running run is not cancelled; the queued one is dropped without a failure.
    expect(item.running).toBe(1)
    expect(item.consecutiveFailures).toBe(0)

    const state = stateOf(harness.service)
    expect(state.pending).toEqual([])
    expect(Object.keys(state.triggers['trigger-1']?.processed ?? {})).toEqual([firstKey])
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending run while paused and replays it on resume', async () => {
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const eventKey = 'manual:pending-1'
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: { [eventKey]: { at: START, status: 'queued' } },
            paused: true,
            consecutiveFailures: 0,
            baselineDone: false,
          },
        },
        pending: [{ runId, triggerId: 'trigger-1', eventKey, firedAt: START }],
      },
    })
    const pendingDir = join(harness.dir, 'triggers', 'pending')
    await mkdir(pendingDir, { recursive: true })
    await writeFile(
      join(pendingDir, `${runId}.json`),
      JSON.stringify({ triggerId: 'trigger-1', key: eventKey, payload: {}, firedAt: START }),
      'utf8',
    )

    await openGate(harness)
    expect(harness.startRun).not.toHaveBeenCalled()
    expect(stateOf(harness.service).pending).toHaveLength(1)

    await harness.service.setPaused('trigger-1', false)
    // The replay reads the pending file from disk, which can outlast fixed ticks.
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.runId).toBe(runId)
  })
})

describe('TriggerMainService window reload / watchdog', () => {
  it('fails a window’s active runs when the same window re-registers its host', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    await harness.service.runNow('trigger-1')
    await settle()
    expect(summary(await harness.service.listTriggers(), 'trigger-1').queued).toBe(1)

    harness.service.registerWindowHost(1, harness.host)
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastError).toContain('reloaded')
    expect(item.consecutiveFailures).toBe(1)
    // The reload released the slot, so the queued run started on the new host.
    expect(harness.startRun).toHaveBeenCalledTimes(2)
    expect(item.running).toBe(1)
  })

  it('fails a run that never reports its end and asks its host to cancel', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          session: {
            prompt: 'Do it',
            budget: { maxCostUsd: 1, timeoutMin: 1, approvalTimeoutMin: 1 },
          },
        }),
      ],
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    const runId = harness.requests[0]!.origin.runId
    expect(summary(await harness.service.listTriggers(), 'trigger-1').running).toBe(1)

    await harness.clock.advance(12 * 60_000 + 1)
    await settle()
    expect(harness.cancelRun).toHaveBeenCalledWith(runId)
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.running).toBe(0)
    expect(item.consecutiveFailures).toBe(1)
    expect(item.lastError).toContain('did not report')
  })

  it('clears the watchdog when the run reports its end in time', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          session: {
            prompt: 'Do it',
            budget: { maxCostUsd: 1, timeoutMin: 1, approvalTimeoutMin: 1 },
          },
        }),
      ],
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: 'trigger-1',
      outcome: 'completed',
      actions: [],
    })
    await harness.clock.advance(12 * 60_000 + 1)
    await settle()
    expect(harness.cancelRun).not.toHaveBeenCalled()
    expect(summary(await harness.service.listTriggers(), 'trigger-1').consecutiveFailures).toBe(0)
  })
})

describe('TriggerMainService backoff gate', () => {
  const backoffUntil = START + GRACE_MS + 10 * 60_000

  it('skips schedule slots during backoff and resumes after it', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          source: { type: 'schedule', everyMin: 5, onMissed: 'skip' },
        }),
      ],
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: {},
            paused: false,
            consecutiveFailures: 1,
            baselineDone: false,
            backoffUntil,
          },
        },
        pending: [],
      },
    })
    await openGate(harness)
    await harness.clock.advance(5 * 60_000)
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()
    expect(harness.loggerLines.some((line) => line.includes('(backoff'))).toBe(true)

    await harness.clock.advance(5 * 60_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('does not consume swarm events during backoff but fires them afterwards', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, { id: 'swarm', source: { type: 'swarm-review' } }),
      ],
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          swarm: {
            processed: {},
            paused: false,
            consecutiveFailures: 1,
            baselineDone: true,
            backoffUntil: START + GRACE_MS + 2 * 60_000,
          },
        },
        pending: [],
      },
    })
    await openGate(harness)
    await harness.service.reportSwarmNeedsAction([review('1')])
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()
    expect(
      Object.hasOwn(stateOf(harness.service).triggers['swarm']?.processed ?? {}, 'swarm:1'),
    ).toBe(false)

    await harness.clock.advance(2 * 60_000)
    await harness.service.reportSwarmNeedsAction([review('1')])
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('does not poll during backoff and polls again at its end', async () => {
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items: [] }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: {},
            paused: false,
            consecutiveFailures: 1,
            baselineDone: false,
            backoffUntil: START + GRACE_MS + 5 * 60_000,
          },
        },
        pending: [],
      },
    })
    await openGate(harness)
    await harness.clock.advance(30_000)
    await settle()
    expect(fetch).not.toHaveBeenCalled()

    await harness.clock.advance(5 * 60_000 - 30_000)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('still runs a manual runNow during backoff', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: {},
            paused: false,
            consecutiveFailures: 1,
            baselineDone: false,
            backoffUntil: START + GRACE_MS + 10 * 60_000,
          },
        },
        pending: [],
      },
    })
    await openGate(harness)
    await harness.service.runNow('trigger-1')
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })
})

describe('TriggerMainService baseline reset', () => {
  const currentFingerprint = 'poll|id|node fetch.js|30'

  it('resets baselineDone and poll keys when the source fingerprint changes', async () => {
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items: [] }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: { 'poll:A': { at: START, status: 'started' } },
            paused: false,
            consecutiveFailures: 0,
            baselineDone: true,
            sourceFingerprint: 'poll|old-key-field|node fetch.js|30',
          },
        },
        pending: [],
      },
    })
    await harness.service.initialize()
    await settle()
    const state = stateOf(harness.service)
    expect(state.triggers['trigger-1']?.baselineDone).toBe(false)
    expect(state.triggers['trigger-1']?.processed).toEqual({})
    expect(state.triggers['trigger-1']?.sourceFingerprint).toBe(currentFingerprint)
    expect(harness.loggerLines.some((line) => line.includes('source changed'))).toBe(true)
  })

  it('keeps the baseline when the source fingerprint is unchanged', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch: async () => ({ ok: true, items: [] }),
      state: {
        version: 1,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: { 'poll:A': { at: START, status: 'started' } },
            paused: false,
            consecutiveFailures: 0,
            baselineDone: true,
            sourceFingerprint: currentFingerprint,
          },
        },
        pending: [],
      },
    })
    await harness.service.initialize()
    await settle()
    const state = stateOf(harness.service)
    expect(state.triggers['trigger-1']?.baselineDone).toBe(true)
    expect(state.triggers['trigger-1']?.processed).toEqual({
      'poll:A': { at: START, status: 'started' },
    })
    expect(harness.loggerLines.some((line) => line.includes('source changed'))).toBe(false)
  })
})

describe('TriggerMainService privacy', () => {
  it('keeps the payload out of logs, audit and state while the prompt still carries it', async () => {
    const secret = 'TOP-SECRET-PAYLOAD-TEXT'
    const items: Array<{ key: string; payload: Record<string, string> }> = [
      { key: 'A', payload: { id: 'A' } },
    ]
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
    })
    await openGate(harness)
    items.push({ key: 'B', payload: { id: 'B', description: secret } })
    await harness.clock.advance(30_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(harness.requests[0]?.prompt).toContain(secret)
    expect(harness.requests[0]?.payload['description']).toBe(secret)

    const runId = harness.requests[0]!.origin.runId
    await harness.service.reportRunEnd({
      runId,
      triggerId: 'trigger-1',
      sessionId: 'session-1',
      outcome: 'completed',
      verdict: 'escalate',
      actions: [
        { type: 'swarm.vote', target: 'A', result: 'ok' },
        { type: 'swarm.comment', target: 'A', result: 'rejected', reason: '评论内容不能为空' },
      ],
    })
    await settle()
    harness.service.dispose()
    await settle()

    expect(harness.loggerLines.join('\n')).not.toContain(secret)
    const audit = await readFile(join(harness.dir, 'triggers', 'audit.jsonl'), 'utf8')
    expect(audit).not.toContain(secret)
    expect(audit).toContain('run-end')
    // One line per action, including the validation reason but never the payload.
    expect(audit).toContain('"action":"action"')
    expect(audit).toContain('type=swarm.vote target=A result=ok')
    expect(audit).toContain('type=swarm.comment target=A result=rejected reason=评论内容不能为空')
    const state = await readFile(join(harness.dir, 'triggers', 'state.json'), 'utf8')
    expect(state).not.toContain(secret)
  })
})

describe('TriggerMainService list / pause', () => {
  it('lists invalid entries and reports pause-all without cancelling running runs', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { id: 'ok' }), { id: 'broken' }],
    })
    await openGate(harness)
    await harness.service.runNow('ok')
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)

    await harness.service.setAllPaused(true)
    const list = await harness.service.listTriggers()
    expect(summary(list, 'ok').paused).toBe(true)
    const invalid = summary(list, 'broken')
    expect(invalid.status).toBe('invalid')
    expect(invalid.errors?.length).toBeGreaterThan(0)
    expect(summary(list, 'ok').running).toBe(1)

    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: 'ok',
      outcome: 'completed',
      actions: [],
    })
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('ensureConfigFile writes the JSONC example once and returns its URI', async () => {
    const harness = await createHarness()
    await rm(harness.configFile, { force: true })
    const uri = await harness.service.ensureConfigFile()
    expect(uri.startsWith('file:')).toBe(true)
    const text = await readFile(harness.configFile, 'utf8')
    expect(text).toContain('// Agent 触发器配置')
    expect(text).toContain('"version": 1')
    await harness.service.ensureConfigFile()
    expect(await readFile(harness.configFile, 'utf8')).toBe(text)
  })
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition was not met in time')
}
