/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/triggers/triggerMainService.ts
 *  Fake clock + fake window hosts + temp userData dirs; no Electron.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import { URI, type ILogger, type IOpenWindowInfo } from '@universe-editor/platform'
import type { ITriggerRunHost } from '../../../../shared/ipc/triggerService.js'
import {
  SWARM_TRIGGER_EVENT_NAME,
  type SwarmNeedsActionReview,
} from '../../../../shared/triggers/swarmTriggerEvent.js'
import type { TriggerRunRequest, TriggerSummary } from '../../../../shared/triggers/types.js'
import { MAX_TRIGGER_REPORT_BYTES } from '../../../../shared/triggers/types.js'
import {
  createWindowScopedTriggerMainService,
  TriggerMainService,
  type TriggerClock,
} from '../triggerMainService.js'
import { triggerKeyFor } from '../triggerIdentity.js'
import type { PollCommandFetcher, PollFetchResult } from '../pollCommandFetcher.js'

const START = new Date(2026, 2, 2, 8, 0, 0, 0).getTime()
const GRACE_MS = 60_000

const dirs: string[] = []
const services: TriggerMainService[] = []

function keyOf(workspace: string, id = 'trigger-1'): string {
  return triggerKeyFor(URI.file(workspace).toString(), id)
}

/** Swarm reports identify the window's workspace by URI string. */
function localUri(workspace: string): string {
  return URI.file(workspace).toString()
}

/**
 * Fixtures name triggers by bare id for readability; state.json is keyed by the
 * composite workspace + id. Already-composite keys pass through untouched.
 */
function withCompositeKeys(state: unknown, workspace: string): unknown {
  if (typeof state !== 'object' || state === null) return state
  const record = state as {
    triggers?: Record<string, unknown>
    pending?: readonly unknown[]
  }
  const triggers = record.triggers
  return {
    ...record,
    ...(triggers === undefined
      ? {}
      : {
          triggers: Object.fromEntries(
            Object.entries(triggers).map(([id, value]) => [
              id.includes('\u0000') ? id : keyOf(workspace, id),
              value,
            ]),
          ),
        }),
    ...(Array.isArray(record.pending)
      ? {
          pending: record.pending.map((entry) => {
            if (typeof entry !== 'object' || entry === null) return entry
            const { triggerId, ...rest } = entry as Record<string, unknown>
            if (typeof triggerId !== 'string') return entry
            return {
              ...rest,
              triggerKey: triggerId.includes('\u0000') ? triggerId : keyOf(workspace, triggerId),
            }
          }),
        }
      : {}),
  }
}

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
    swarmUrl: 'https://swarm.example.com/branch_x',
    swarmApiVersion: 'v9',
  }
}

interface HarnessOptions {
  readonly triggers?: (workspace: string) => readonly unknown[]
  readonly maxConcurrentRuns?: number
  readonly state?: unknown | ((workspace: string) => unknown)
  readonly fetch?: PollCommandFetcher
  readonly trusted?: boolean
  /** Machine-level trust probe handed to the service (defaults to untrusted). */
  readonly machineTrusted?: boolean
  readonly startRunError?: Error
  readonly holdStartRun?: boolean
  readonly startRunTimeoutMs?: number
  readonly registerHost?: boolean
  readonly openRegistersHost?: boolean
  readonly hostWaitTimeoutMs?: number
  readonly stateDebounceMs?: number
  readonly startupGraceMs?: number
  readonly workspace?: string
  /** Reuse a userData directory across harnesses to exercise a restart. */
  readonly userDataDir?: string
  /** Set false to exercise the activation gate (default: confirm every trigger). */
  readonly autoConfirm?: boolean
  /** Set false to keep first-seen triggers paused (default: resume them). */
  readonly autoResume?: boolean
  /** Start without a workspace triggers.json (window opened before a pull). */
  readonly skipConfigFile?: boolean
  /** Renderer run-host acknowledgement (default: the host acks right after registering). */
  readonly hostReady?: boolean
  /** Hard cap on one trigger's dedupe keys (defaults to the production constant). */
  readonly processedKeyLimit?: number
  /** Leave the host trust probe pending forever, exercising the pre-start timeout. */
  readonly trustProbeHangs?: boolean
}

interface Harness {
  readonly service: TriggerMainService
  readonly clock: FakeClock
  readonly dir: string
  readonly workspace: string
  readonly configFile: string
  /** Composite key of the default `trigger-1`. */
  readonly key: string
  keyOf(id: string): string
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
  markHostReady(folder?: string): void
  releaseStartRun(): void
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = options.userDataDir ?? mkTempDir('ue-triggers-main-')
  dirs.push(dir)
  const workspace = options.workspace ?? join(dir, 'workspace')
  const triggerDir = join(dir, 'triggers')
  await mkdir(triggerDir, { recursive: true })
  const configFile = join(workspace, '.universe-editor', 'triggers.json')
  if (options.skipConfigFile !== true) {
    await mkdir(dirname(configFile), { recursive: true })
    const config = {
      version: 1,
      triggers: options.triggers?.(workspace) ?? [],
    }
    await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  }
  // The registry is what keeps a workspace scheduled after its windows close.
  await writeFile(
    join(triggerDir, 'workspaces.json'),
    `${JSON.stringify(
      {
        version: 2,
        workspaces: options.skipConfigFile === true ? [] : [URI.file(workspace).toString()],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const state = typeof options.state === 'function' ? options.state(workspace) : options.state
  if (state !== undefined) {
    await writeFile(
      join(triggerDir, 'state.json'),
      JSON.stringify(withCompositeKeys(state, workspace)),
      'utf8',
    )
  }
  const preexistingIds = new Set(
    typeof state === 'object' && state !== null && 'triggers' in state
      ? Object.keys((state as { triggers?: Record<string, unknown> }).triggers ?? {})
      : [],
  )
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
  const isWorkspaceTrusted = vi.fn(async (_workspace: string): Promise<boolean> => {
    if (options.trustProbeHangs === true) return await new Promise<boolean>(() => undefined)
    return options.trusted ?? true
  })
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
    readMaxConcurrentRuns: async () => options.maxConcurrentRuns ?? 2,
    isWorkspaceTrusted: async () => options.machineTrusted ?? true,
    ...(options.processedKeyLimit === undefined
      ? {}
      : { processedKeyLimit: options.processedKeyLimit }),
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
    service.registerWindowHost(windowId, host, folder)
    if (options.hostReady !== false) void service.markHostReady(folder.toString())
  })
  service.setWindowProvider({
    getOpenWindowInfos: () => openWindows,
    openWindowForFolderInBackground: openWindow,
  })

  const registerHost = (windowId = 1): void => {
    if (!openWindows.some((entry) => entry.id === windowId)) {
      openWindows.push({ id: windowId, folder: URI.file(workspace).toJSON(), name: 'ws' })
    }
    service.registerWindowHost(windowId, host, URI.file(workspace))
    if (options.hostReady !== false) void service.markHostReady(localUri(workspace))
  }
  if (options.registerHost !== false) registerHost()

  await service.initialize()
  if (options.autoConfirm !== false) {
    // Workspace-defined triggers stay dormant until confirmed once on this machine;
    // most scheduling tests are about what happens after that gate.
    for (const entry of await service.listTriggers()) {
      if (entry.status === 'invalid') continue
      await service.confirmActivation(entry.key, entry.fingerprint)
      // First-seen triggers start paused; tests that are not about that default
      // resume them, mirroring what the confirmation dialog offers.
      if (options.autoResume !== false && !preexistingIds.has(entry.id)) {
        await service.setPaused(entry.key, false)
      }
    }
  }

  return {
    service,
    clock,
    dir,
    workspace,
    configFile,
    key: keyOf(workspace),
    keyOf: (id: string) => keyOf(workspace, id),
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
    markHostReady: (folder?: string) => void service.markHostReady(folder ?? localUri(workspace)),
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

/** Confirm with the current fingerprint, as the dialog would. */
async function confirmTrigger(service: TriggerMainService, triggerKey: string): Promise<void> {
  const entry = (await service.listTriggers()).find((item) => item.key === triggerKey)
  if (entry === undefined) throw new Error(`trigger ${triggerKey} missing`)
  await service.confirmActivation(triggerKey, entry.fingerprint)
}

interface RawState {
  readonly pending: readonly { readonly runId: string }[]
  readonly triggers: Readonly<
    Record<
      string,
      {
        readonly processed: Record<string, { readonly at?: number; readonly status?: string }>
        readonly baselineDone?: boolean
        readonly sourceFingerprint?: string
        readonly activationConfirmed?: string
        readonly paused?: boolean
      }
    >
  >
}

/**
 * Runtime state is private now: flush through the public API and read the file
 * that survives a restart, which is also what the scheduler itself trusts.
 */
async function stateOf(harness: {
  readonly service: TriggerMainService
  readonly dir: string
}): Promise<RawState> {
  await harness.service.listTriggers()
  return JSON.parse(await readFile(join(harness.dir, 'triggers', 'state.json'), 'utf8')) as RawState
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
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey).toMatch(/^schedule:/)

    await harness.clock.advance(5 * 60_000)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
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
        version: 2,
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
        version: 2,
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
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
    restarted.registerWindowHost(1, harness.host, URI.file(harness.workspace))
    await restarted.markHostReady(localUri(harness.workspace))
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
        makeTrigger(workspace, {
          id: 'swarm',
          source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        }),
      ],
    })
    await openGate(harness)

    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1')],
      localUri(harness.workspace),
    )
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()

    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1')],
      localUri(harness.workspace),
    )
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()

    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1'), review('2')],
      localUri(harness.workspace),
    )
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey).toBe('swarm:2')
    // The event payload now reaches the agent only through the fenced prompt section.
    expect(harness.requests[0]?.prompt).toContain('"reviewId":"2"')
    expect(harness.requests[0]?.prompt).toContain('"swarmUrl":"https://swarm.example.com/branch_x"')
    expect(harness.requests[0]?.prompt).toContain('"swarmApiVersion":"v9"')

    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1'), review('2')],
      localUri(harness.workspace),
    )
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('maps generic event reports through the registered source and skips malformed items', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          id: 'swarm',
          source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        }),
      ],
    })
    await openGate(harness)
    const folder = localUri(harness.workspace)

    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1'), review('1'), { reviewId: 42, author: 'x', description: '', state: 'new' }],
      folder,
    )
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()
    let state = await stateOf(harness)
    expect(state.triggers[harness.keyOf('swarm')]?.baselineDone).toBe(true)
    expect(state.triggers[harness.keyOf('swarm')]?.processed?.['swarm:1']).toBeDefined()

    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1'), review('2'), review('2')],
      folder,
    )
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey).toBe('swarm:2')

    await harness.service.reportTriggerEvents('unknown.event', [review('3')], folder)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    state = await stateOf(harness)
    expect(state.triggers[harness.keyOf('swarm')]?.processed?.['swarm:3']).toBeUndefined()
  })

  it('produces a single run for two concurrent reports of the same review', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          id: 'swarm',
          source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        }),
      ],
    })
    await openGate(harness)
    // First report seeds the baseline with review 0.
    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('0')],
      localUri(harness.workspace),
    )
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()

    await Promise.all([
      harness.service.reportTriggerEvents(
        SWARM_TRIGGER_EVENT_NAME,
        [review('1')],
        localUri(harness.workspace),
      ),
      harness.service.reportTriggerEvents(
        SWARM_TRIGGER_EVENT_NAME,
        [review('1')],
        localUri(harness.workspace),
      ),
    ])
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    const runningId = harness.requests[0]!.origin.triggerId
    const otherId = runningId === 'a' ? 'b' : 'a'
    const list = await harness.service.listTriggers()
    expect(summary(list, runningId).running).toBe(1)
    expect(summary(list, otherId).queued).toBe(1)

    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: runningId,
      outcome: 'completed',
    })
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
    expect(harness.requests[1]?.origin.triggerId).toBe(otherId)
  })

  it('applies a renderer setting change without restarting main', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [
        makeTrigger(workspace, { id: 'a' }),
        makeTrigger(workspace, { id: 'b' }),
      ],
    })
    await harness.service.runNow(harness.keyOf('a'))
    await harness.service.runNow(harness.keyOf('b'))
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))

    await harness.service.setMaxConcurrentRuns(2)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
    harness.service.dispose()
    await settle()
  })

  it('replays a queued run after a restart from the pending payload', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await settle()
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
    restarted.registerWindowHost(1, harness.host, URI.file(harness.workspace))
    await restarted.markHostReady(localUri(harness.workspace))
    await restarted.initialize()
    await harness.clock.advance(GRACE_MS)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
    expect(harness.requests[1]?.origin.runId).not.toBe(firstRunId)
  })
})

describe('TriggerMainService summaries and run history', () => {
  it('exposes pausedAll, autoPaused and the parsed source', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    const initial = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(initial.pausedAll).toBe(false)
    expect(initial.autoPaused).toBe(false)
    expect(initial.source).toEqual({ type: 'manual' })
    expect(initial.session).toEqual({})
    expect(initial).not.toHaveProperty('elevatedModeConfirmed')

    await harness.service.setAllPaused(true)
    const paused = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(paused.pausedAll).toBe(true)
    expect(paused.paused).toBe(true)
    expect(paused.status).toBe('paused')

    await harness.service.setAllPaused(false)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').pausedAll).toBe(false)
  })

  it('marks invalid entries with the global pause state', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { id: 'broken', enabled: 'yes' })],
    })
    await harness.service.setAllPaused(true)
    const broken = summary(await harness.service.listTriggers(), 'broken')
    expect(broken.status).toBe('invalid')
    expect(broken.pausedAll).toBe(true)
    expect(broken.autoPaused).toBe(false)
  })

  it('exposes the session settings listed in the activation confirmation', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          session: {
            agent: 'claude-code',
            mode: 'default',
            skill: 'swarm-triage',
            prompt: 'Do it',
            mcpServers: ['swarm'],
            budget: BUDGET,
          },
        }),
      ],
    })
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.session).toEqual({
      agent: 'claude-code',
      mode: 'default',
      skill: 'swarm-triage',
      mcpServers: ['swarm'],
    })
    expect(item.elevatedMode).toBe(false)
  })

  it('appends every run end to the history and keeps the newest first', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    const longSummary = 'x'.repeat(300)

    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    const firstRunId = harness.requests[0]!.origin.runId
    await harness.service.reportRunEnd({
      runId: firstRunId,
      triggerId: 'trigger-1',
      sessionId: 'session-1',
      outcome: 'completed',
      verdict: 'escalate',
      summary: longSummary,
      durationMs: 12_345,
      costUsd: 0.25,
    })

    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
    const secondRunId = harness.requests[1]!.origin.runId
    await harness.service.reportRunEnd({
      runId: secondRunId,
      triggerId: 'trigger-1',
      outcome: 'timeout',
    })

    const runs = await harness.service.listRuns()
    expect(runs.map((run) => run.runId)).toEqual([secondRunId, firstRunId])
    const first = runs[1]!
    expect(first).toMatchObject({
      triggerKey: harness.key,
      triggerId: 'trigger-1',
      triggerName: 'Trigger One',
      workspace: localUri(harness.workspace),
      workspaceName: 'workspace',
      sessionId: 'session-1',
      startedAt: START,
      endedAt: START,
      outcome: 'completed',
      verdict: 'escalate',
      costUsd: 0.25,
      durationMs: 12_345,
    })
    expect(first.summary).toHaveLength(200)
    expect(first.summary?.startsWith('x'.repeat(200))).toBe(true)

    expect(await harness.service.listRuns({ outcome: 'timeout' })).toEqual([runs[0]])
    expect(await harness.service.listRuns({ limit: 1 })).toEqual([runs[0]])

    // The per-trigger synopsis mirrors the newest run; a missing verdict clears
    // the previous one instead of leaving a stale value in the overview.
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastRunId).toBe(secondRunId)
    expect(item.lastRunOutcome).toBe('timeout')
    expect(item.lastRunVerdict).toBeUndefined()
    expect(item.lastRunSummary).toBeUndefined()
    expect(item.lastRunCostUsd).toBeUndefined()
    expect(item.lastRunDurationMs).toBeUndefined()
  })

  it('writes a history row for a failed run including its error', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: 'trigger-1',
      sessionId: 'session-9',
      outcome: 'failed',
      verdict: 'escalate',
      summary: 'rejected',
      error: 'agent crashed',
      durationMs: 42,
    })

    const [run] = await harness.service.listRuns()
    expect(run).toMatchObject({
      outcome: 'failed',
      verdict: 'escalate',
      summary: 'rejected',
      error: 'agent crashed',
      sessionId: 'session-9',
      durationMs: 42,
    })
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastRunOutcome).toBe('failed')
    expect(item.consecutiveFailures).toBe(1)
    expect(item.lastError).toBe('agent crashed')
  })

  it('truncates a long failure message for history and lastError alike', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    const longError = 'boom '.repeat(200)
    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: 'trigger-1',
      outcome: 'failed',
      error: longError,
    })

    const [run] = await harness.service.listRuns()
    expect(run?.error).toHaveLength(500)
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastError).toHaveLength(500)
    expect(item.lastError).toBe(run?.error)
  })

  it('keeps the history entry when the trigger definition was removed', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    // Simulate the file edit that deleted the definition while the run was active.
    await writeFile(harness.configFile, `${JSON.stringify({ version: 1, triggers: [] })}\n`, 'utf8')
    await vi.waitFor(async () => {
      expect((await harness.service.listTriggers()).find((entry) => entry.id === 'trigger-1')).toBe(
        undefined,
      )
    })

    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: 'trigger-1',
      outcome: 'completed',
    })
    const [run] = await harness.service.listRuns()
    expect(run?.triggerId).toBe('trigger-1')
    expect(run?.triggerName).toBe('trigger-1')
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
      await harness.service.runNow(harness.key)
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
    expect(item.autoPaused).toBe(true)
    expect(item.consecutiveFailures).toBe(5)
    expect(harness.notify).toHaveBeenCalledTimes(1)
    expect(harness.loggerLines.some((line) => line.includes('auto-paused'))).toBe(true)

    harness.service.dispose()
    await settle()
    const state = JSON.parse(
      await readFile(join(harness.dir, 'triggers', 'state.json'), 'utf8'),
    ) as {
      triggers: Record<string, { paused: boolean; autoPaused?: boolean; backoffUntil: number }>
    }
    expect(state.triggers[harness.key]?.paused).toBe(true)
    expect(state.triggers[harness.key]?.autoPaused).toBe(true)
    expect(state.triggers[harness.key]?.backoffUntil).toBeGreaterThan(harness.clock.now())

    const audit = await readFile(join(harness.dir, 'triggers', 'audit.jsonl'), 'utf8')
    expect(audit).toContain('auto-pause')
  })

  it('clears the auto-pause marker when the user resumes the trigger', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      state: {
        version: 2,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: {},
            paused: true,
            autoPaused: true,
            consecutiveFailures: 5,
            baselineDone: false,
          },
        },
        pending: [],
      },
    })
    expect(summary(await harness.service.listTriggers(), 'trigger-1').autoPaused).toBe(true)

    await harness.service.setPaused(harness.key, false)
    const resumed = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(resumed.paused).toBe(false)
    expect(resumed.autoPaused).toBe(false)
    expect(resumed.consecutiveFailures).toBe(0)
  })

  it('clears the auto-pause marker when a run completes successfully', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      state: {
        version: 2,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: {},
            paused: false,
            // Stale marker from an older build / hand-edited state: a success must clear it.
            autoPaused: true,
            consecutiveFailures: 4,
            baselineDone: false,
          },
        },
        pending: [],
      },
    })
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: 'trigger-1',
      outcome: 'completed',
    })
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.autoPaused).toBe(false)
    expect(item.consecutiveFailures).toBe(0)
    expect(item.lastRunOutcome).toBe('completed')
  })

  it('refuses to run when the workspace is untrusted', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      trusted: false,
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastError).toContain('not trusted')
    expect(item.consecutiveFailures).toBe(1)
  })

  it('times out an unresponsive trust probe and releases the slot', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
      startRunTimeoutMs: 1_000,
      trustProbeHangs: true,
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.isWorkspaceTrusted).toHaveBeenCalledTimes(1))

    await harness.clock.advance(1_000)
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.running).toBe(0)
    expect(item.consecutiveFailures).toBe(1)
    expect(item.lastError).toContain('did not respond')
    expect(harness.startRun).not.toHaveBeenCalled()
    expect((await stateOf(harness)).pending).toEqual([])
  })

  it('accounts for a run that reports its end before startRun returns', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
      startRunTimeoutMs: 10_000,
      holdStartRun: true,
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    const request = harness.requests[0]!

    // The renderer reports the terminal state while main is still awaiting startRun.
    await harness.service.reportRunEnd({
      runId: request.origin.runId,
      triggerId: 'trigger-1',
      outcome: 'completed',
    })
    await settle()
    harness.releaseStartRun()
    await settle()

    // The late session is cancelled, but the event is accounted as started so a
    // restart never replays it from its still-queued pending record.
    expect(harness.cancelRun).toHaveBeenCalledWith(request.origin.runId)
    const state = await stateOf(harness)
    expect(state.pending).toEqual([])
    expect(state.triggers[harness.key]?.processed[request.origin.eventKey]?.status).toBe('started')
  })

  it('fails a run whose window closes', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    await harness.service.runNow(harness.key)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').queued).toBe(1)

    await harness.clock.advance(1_000)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
    expect(summary(await harness.service.listTriggers(), 'trigger-1').running).toBe(1)
  })
})

describe('TriggerMainService activation covers elevated mode', () => {
  const elevated = { mode: 'bypassPermissions' }

  it('refuses to run until the single activation confirmation, then allows the bypass mode', async () => {
    const harness = await createHarness({
      autoConfirm: false,
      triggers: (workspace) => [
        makeTrigger(workspace, {
          session: { prompt: 'Do it', budget: BUDGET, ...elevated },
        }),
      ],
    })
    await openGate(harness)
    await harness.service.setPaused(harness.key, false)
    await expect(harness.service.runNow(harness.key)).rejects.toThrow(/Confirm this trigger/)
    expect(harness.startRun).not.toHaveBeenCalled()

    const before = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(before.status).toBe('needs-confirmation')
    expect(before.activationConfirmed).toBe(false)
    expect(before.elevatedMode).toBe(true)

    await confirmTrigger(harness.service, harness.key)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.allowElevatedMode).toBe(true)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').activationConfirmed).toBe(
      true,
    )
  })

  it('invalidates the confirmation (and the bypass grant) when the trigger config changes', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          session: { prompt: 'Do it', budget: BUDGET, ...elevated },
        }),
      ],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.allowElevatedMode).toBe(true)
    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: 'trigger-1',
      outcome: 'completed',
    })

    await writeFile(
      harness.configFile,
      JSON.stringify({
        version: 1,
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
    // The single confirmation is bound to the full definition fingerprint.
    const edited = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(edited.activationConfirmed).toBe(false)
    expect(edited.status).toBe('needs-confirmation')
    await expect(harness.service.runNow(harness.key)).rejects.toThrow(/Confirm this trigger/)

    await confirmTrigger(harness.service, harness.key)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
    expect(harness.requests[1]?.allowElevatedMode).toBe(true)
  })

  it('rejects a confirmation for a definition that changed while the dialog was open', async () => {
    const harness = await createHarness({
      autoConfirm: false,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    const shown = summary(await harness.service.listTriggers(), 'trigger-1')

    await writeFile(
      harness.configFile,
      JSON.stringify({
        version: 1,
        triggers: [makeTrigger(harness.workspace, { name: 'Renamed' })],
      }),
      'utf8',
    )
    await waitFor(
      async () => summary(await harness.service.listTriggers(), 'trigger-1').name === 'Renamed',
    )

    await expect(harness.service.confirmActivation(harness.key, shown.fingerprint)).rejects.toThrow(
      /definition changed/,
    )
    expect((await stateOf(harness)).triggers[harness.key]?.activationConfirmed).toBeUndefined()
    await expect(harness.service.runNow(harness.key)).rejects.toThrow(/Confirm this trigger/)
  })
})

describe('TriggerMainService poll source', () => {
  it('does not spawn the poll command in an untrusted workspace', async () => {
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items: [] }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
      machineTrusted: false,
    })
    await openGate(harness)
    await vi.waitFor(() =>
      expect(
        harness.loggerLines.some((line) =>
          line.includes('poll skipped (workspace is not trusted)'),
        ),
      ).toBe(true),
    )
    expect(fetch).not.toHaveBeenCalled()
    harness.service.dispose()
    await settle()
  })

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
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey).toBe('poll:B')
    expect(harness.requests[0]?.prompt).toContain('"id":"B"')
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

  it('never overlaps two poll commands of the same trigger and re-arms from completion', async () => {
    let resolveFetch!: (result: PollFetchResult) => void
    const fetch = vi.fn<PollCommandFetcher>(
      () =>
        new Promise<PollFetchResult>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
    })
    await openGate(harness)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

    // The command outlives its interval: the wake-up must not start a second run.
    await harness.clock.advance(30_000)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)

    resolveFetch({ ok: true, items: [] })
    await settle()
    // Next poll is one full interval after completion, not after the start.
    expect(summary(await harness.service.listTriggers(), 'trigger-1').nextRunAt).toBe(
      harness.clock.now() + 30_000,
    )
    await harness.clock.advance(29_999)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    await harness.clock.advance(1)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })

  it('keeps only the newest items when one poll round exceeds the dedupe limit', async () => {
    const limit = 3
    let items: Array<{ key: string; payload: Record<string, string> }> = []
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { concurrency: 3, source: pollSource() })],
      fetch,
      maxConcurrentRuns: 3,
      processedKeyLimit: limit,
    })
    await openGate(harness)
    expect(fetch).toHaveBeenCalledTimes(1)

    items = ['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, payload: { id: key } }))
    await harness.clock.advance(30_000)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(3))
    // Concurrent starts finish in file-read order, so compare the selected set.
    expect(harness.requests.map((request) => request.origin.eventKey).sort()).toEqual([
      'poll:C',
      'poll:D',
      'poll:E',
    ])
    expect(harness.loggerLines.some((line) => line.includes('recording 2 older poll item'))).toBe(
      true,
    )
  })

  it('records every baseline item, including the truncated prefix', async () => {
    const limit = 3
    let items = ['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, payload: { id: key } }))
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
      processedKeyLimit: limit,
    })
    await openGate(harness)
    expect(harness.startRun).not.toHaveBeenCalled()
    expect(
      harness.loggerLines.some((line) => line.includes('baseline recorded items=5 dropped=2')),
    ).toBe(true)

    const state = await stateOf(harness)
    const processed = state.triggers[harness.keyOf('trigger-1')]?.processed ?? {}
    expect(Object.keys(processed).sort()).toEqual([
      'poll:A',
      'poll:B',
      'poll:C',
      'poll:D',
      'poll:E',
    ])
    expect(processed['poll:A']?.at).toBeLessThan(processed['poll:E']?.at ?? 0)

    // A shorter round puts the previously dropped keys inside the newest-N
    // window. They must stay suppressed, not fire as brand-new events.
    items = ['A', 'B'].map((key) => ({ key, payload: { id: key } }))
    await harness.clock.advance(30_000)
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()
  })

  it('never refires a truncated poll item when a later shorter round exposes it', async () => {
    const limit = 3
    let items: Array<{ key: string; payload: Record<string, string> }> = []
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { concurrency: 10, source: pollSource() })],
      fetch,
      maxConcurrentRuns: 10,
      processedKeyLimit: limit,
    })
    await openGate(harness)
    expect(fetch).toHaveBeenCalledTimes(1)

    items = ['A', 'B', 'C', 'D', 'E'].map((key) => ({ key, payload: { id: key } }))
    await harness.clock.advance(30_000)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(3))
    expect(harness.requests.map((request) => request.origin.eventKey).sort()).toEqual([
      'poll:C',
      'poll:D',
      'poll:E',
    ])

    items = ['A', 'B'].map((key) => ({ key, payload: { id: key } }))
    await harness.clock.advance(30_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(3)
  })
})

describe('TriggerMainService window routing', () => {
  it('stamps the sender window on ack through the per-window channel', async () => {
    const harness = await createHarness({ registerHost: false })
    const scoped = createWindowScopedTriggerMainService(harness.service, 7)
    const markHostReady = vi.spyOn(harness.service, 'markHostReady')
    await scoped.markHostReady(localUri(harness.workspace))
    expect(markHostReady).toHaveBeenCalledWith(localUri(harness.workspace), 7)
  })

  it('uses a window that is already open and never opens a new one', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.openWindow).not.toHaveBeenCalled()
    expect(harness.requests[0]?.cwd).toBe(harness.workspace)
    // Trust is judged for the trigger's workspace URI, not the window's current folder.
    expect(harness.isWorkspaceTrusted).toHaveBeenCalledWith(localUri(harness.workspace))
  })

  it('does not hand a run to a window before its renderer host acknowledges', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      hostReady: false,
      hostWaitTimeoutMs: 15,
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await settle(20)
    expect(harness.startRun).not.toHaveBeenCalled()
    const failed = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(failed.lastError).toContain('Timed out')
    expect(failed.consecutiveFailures).toBe(1)

    // The renderer finally registers its TriggerRunHost and acknowledges.
    harness.markHostReady()
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
  })

  it('opens a background window when none is open, then waits for its host', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      registerHost: false,
      openRegistersHost: true,
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.openWindow).toHaveBeenCalledTimes(1)
    expect(harness.openWindow.mock.calls[0]?.[0]?.toString()).toBe(
      URI.file(harness.workspace).toString(),
    )
  })

  it('fails the run and backs off when the opened window never registers a host', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      registerHost: false,
      openRegistersHost: false,
      hostWaitTimeoutMs: 15,
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await settle(20)
    expect(harness.startRun).not.toHaveBeenCalled()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastError).toContain('Timed out')
    expect(item.consecutiveFailures).toBe(1)
  })
})

describe('TriggerMainService pause gate', () => {
  it('drops queued automatic runs when a trigger is paused and forgets their keys', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [
        makeTrigger(workspace, {
          source: { type: 'schedule', everyMin: 1, onMissed: 'skip' },
        }),
      ],
    })
    await openGate(harness)
    await harness.clock.advance(60_000)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    await harness.clock.advance(60_000)
    await settle()
    expect(summary(await harness.service.listTriggers(), 'trigger-1').queued).toBe(1)
    const firstKey = harness.requests[0]!.origin.eventKey
    const processed = (await stateOf(harness)).triggers[harness.key]?.processed
    expect(Object.keys(processed ?? {})).toHaveLength(2)

    await harness.service.setPaused(harness.key, true)
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.queued).toBe(0)
    // The running run is not cancelled; the queued one is dropped without a failure.
    expect(item.running).toBe(1)
    expect(item.consecutiveFailures).toBe(0)

    const state = await stateOf(harness)
    expect(state.pending).toEqual([])
    expect(Object.keys(state.triggers[harness.key]?.processed ?? {})).toEqual([firstKey])
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('keeps a queued manual run when its trigger is paused', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 0,
      triggers: (workspace) => [makeTrigger(workspace)],
      autoResume: false,
    })
    await harness.service.runNow(harness.key)
    await settle()
    expect((await stateOf(harness)).pending).toHaveLength(1)

    await harness.service.setPaused(harness.key, true)
    await settle()
    expect((await stateOf(harness)).pending).toHaveLength(1)

    await harness.service.setMaxConcurrentRuns(1)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey).toMatch(/^manual:/)
    // The manual override does not resume the trigger.
    expect(summary(await harness.service.listTriggers(), 'trigger-1').paused).toBe(true)
  })

  it('replays a manual pending run while the trigger is paused', async () => {
    const runId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const eventKey = 'manual:pending-1'
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      state: {
        version: 2,
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
    // A manual event is an explicit user action: it runs regardless of the pause.
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.runId).toBe(runId)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').paused).toBe(true)
  })
})

describe('TriggerMainService first-seen pause', () => {
  it('starts a trigger that is new to this machine paused', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      autoResume: false,
    })
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.paused).toBe(true)
    expect(item.autoPaused).toBe(false)
    expect(item.status).toBe('paused')
    expect(harness.loggerLines.some((line) => line.includes('first seen'))).toBe(true)
    // A manually paused trigger is not the failure-driven auto pause.
    expect((await stateOf(harness)).triggers[harness.key]?.paused).toBe(true)
  })

  it('keeps an existing key unpaused when the state file says so', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      state: {
        version: 2,
        pausedAll: false,
        triggers: {
          'trigger-1': {
            processed: {},
            paused: false,
            consecutiveFailures: 0,
            baselineDone: false,
          },
        },
        pending: [],
      },
      autoResume: false,
    })
    expect(summary(await harness.service.listTriggers(), 'trigger-1').paused).toBe(false)
  })

  it('does not re-judge a resumed trigger after a restart', async () => {
    const first = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      autoResume: false,
    })
    expect(summary(await first.service.listTriggers(), 'trigger-1').paused).toBe(true)
    await first.service.setPaused(first.key, false)
    first.service.dispose()
    await settle()

    const second = await createHarness({
      userDataDir: first.dir,
      workspace: first.workspace,
      triggers: (workspace) => [makeTrigger(workspace)],
      autoConfirm: false,
    })
    expect(summary(await second.service.listTriggers(), 'trigger-1').paused).toBe(false)
  })

  it('does not schedule a paused trigger and runs it on demand instead', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, { source: { type: 'schedule', everyMin: 1, onMissed: 'skip' } }),
      ],
      autoResume: false,
    })
    await openGate(harness)
    await harness.clock.advance(5 * 60_000)
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()

    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey).toMatch(/^manual:/)

    // A manual run neither changes the pause nor its scheduling.
    expect(summary(await harness.service.listTriggers(), 'trigger-1').paused).toBe(true)
    await harness.clock.advance(5 * 60_000)
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('keeps the global pause as an emergency stop for manual runs', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
      autoResume: false,
    })
    await harness.service.setAllPaused(true)
    await expect(harness.service.runNow(harness.key)).rejects.toThrow(/All triggers are paused/)
    expect(harness.startRun).not.toHaveBeenCalled()
  })
})

describe('TriggerMainService window reload / watchdog', () => {
  it('fails a window’s active runs when the same window re-registers its host', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    await harness.service.runNow(harness.key)
    await settle()
    expect(summary(await harness.service.listTriggers(), 'trigger-1').queued).toBe(1)

    harness.service.registerWindowHost(1, harness.host, URI.file(harness.workspace))
    await harness.service.markHostReady(localUri(harness.workspace))
    // The reload released the slot, so the queued run started on the new host.
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.lastError).toContain('reloaded')
    expect(item.consecutiveFailures).toBe(1)
    expect(item.running).toBe(1)
  })

  it('fails a crashed window’s active runs while keeping its host registered', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))

    harness.service.failActiveRunsForWindow(1, 'crashed')
    await settle()
    const item = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(item.running).toBe(0)
    expect(item.consecutiveFailures).toBe(1)
    expect(item.lastError).toContain('crashed')

    // The registration survives: the reloaded renderer reuses the same channel.
    await harness.service.markHostReady(localUri(harness.workspace))
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
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
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    await harness.service.reportRunEnd({
      runId: harness.requests[0]!.origin.runId,
      triggerId: 'trigger-1',
      outcome: 'completed',
    })
    await harness.clock.advance(12 * 60_000 + 1)
    await settle()
    expect(harness.cancelRun).not.toHaveBeenCalled()
    expect(summary(await harness.service.listTriggers(), 'trigger-1').consecutiveFailures).toBe(0)
  })
})

describe('TriggerMainService manual runs', () => {
  it('runs a disabled trigger on demand (runNow does not require enabled)', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { enabled: false })],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.origin.eventKey).toMatch(/^manual:/)
    expect(harness.requests[0]?.showSession).toBe(false)
    const run = harness.requests[0]!
    expect(run.prompt).toContain('## 输出要求（始终生效，优先于任务描述）')
    expect(run.prompt).toContain(`运行目录：${run.runDir}`)
    expect(run.promptForSystemContract).toContain(`运行目录：${run.runDir}`)
    expect(run.promptForSystemContract).not.toContain('## 输出要求')
    expect(run.promptForSystemContract).toContain('## 任务\nDo the thing')
    expect(run.promptForSystemContract).toContain('## 事件数据\n本次无外部事件数据。')
  })

  it('carries showSession into the run request', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { showSession: true })],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.showSession).toBe(true)
  })

  it('starts a queued manual run of a disabled trigger once a slot frees', async () => {
    const harness = await createHarness({
      maxConcurrentRuns: 1,
      triggers: (workspace) => [makeTrigger(workspace, { enabled: false })],
    })
    await openGate(harness)
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    await harness.service.runNow(harness.key)
    await vi.waitFor(async () =>
      expect(summary(await harness.service.listTriggers(), 'trigger-1').queued).toBe(1),
    )
    const first = harness.requests[0]!.origin
    await harness.service.reportRunEnd({
      runId: first.runId,
      triggerId: first.triggerId,
      outcome: 'completed',
    })
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(2))
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
        version: 2,
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
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
  })

  it('does not consume swarm events during backoff but fires them afterwards', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          id: 'swarm',
          source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        }),
      ],
      state: {
        version: 2,
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
    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1')],
      localUri(harness.workspace),
    )
    await settle()
    expect(harness.startRun).not.toHaveBeenCalled()
    expect(
      Object.hasOwn(
        (await stateOf(harness)).triggers[harness.keyOf('swarm')]?.processed ?? {},
        'swarm:1',
      ),
    ).toBe(false)

    await harness.clock.advance(2 * 60_000)
    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1')],
      localUri(harness.workspace),
    )
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
  })

  it('does not poll during backoff and polls again at its end', async () => {
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items: [] }))
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
      state: {
        version: 2,
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
        version: 2,
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
    await harness.service.runNow(harness.key)
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
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
        version: 2,
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
    const state = await stateOf(harness)
    expect(state.triggers[harness.key]?.baselineDone).toBe(false)
    expect(state.triggers[harness.key]?.processed).toEqual({})
    expect(state.triggers[harness.key]?.sourceFingerprint).toBe(currentFingerprint)
    expect(harness.loggerLines.some((line) => line.includes('source changed'))).toBe(true)
  })

  it('keeps the baseline when the source fingerprint is unchanged', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch: async () => ({ ok: true, items: [] }),
      state: {
        version: 2,
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
    const state = await stateOf(harness)
    expect(state.triggers[harness.key]?.baselineDone).toBe(true)
    expect(state.triggers[harness.key]?.processed).toEqual({
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
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))
    expect(harness.requests[0]?.prompt).toContain(secret)

    const runId = harness.requests[0]!.origin.runId
    await harness.service.reportRunEnd({
      runId,
      triggerId: 'trigger-1',
      sessionId: 'session-1',
      outcome: 'completed',
      verdict: 'escalate',
      summary: 'looked at it',
    })
    await settle()
    harness.service.dispose()
    await settle()

    expect(harness.loggerLines.join('\n')).not.toContain(secret)
    const audit = await readFile(join(harness.dir, 'triggers', 'audit.jsonl'), 'utf8')
    expect(audit).not.toContain(secret)
    expect(audit).toContain('run-end')
    expect(audit).toContain('verdict=escalate')
    // The verdict summary never reaches the audit log.
    expect(audit).not.toContain('looked at it')
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
    await harness.service.runNow(harness.keyOf('ok'))
    await vi.waitFor(() => expect(harness.startRun).toHaveBeenCalledTimes(1))

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
    })
    await settle()
    expect(harness.startRun).toHaveBeenCalledTimes(1)
  })

  it('ensureConfigFile refuses a workspace no window holds and the registry does not know', async () => {
    const harness = await createHarness()
    const outside = URI.file(join(harness.dir, 'outside')).toString()
    await expect(harness.service.ensureConfigFile(outside)).rejects.toThrow(
      /not open|not registered/,
    )
    expect(existsSync(join(harness.dir, 'outside', '.universe-editor', 'triggers.json'))).toBe(
      false,
    )
    expect((await harness.service.listWorkspaces()).map((entry) => entry.workspace)).toEqual([
      URI.file(harness.workspace).toString(),
    ])
  })

  it('ensureConfigFile writes the JSONC example once and returns its URI', async () => {
    const harness = await createHarness()
    await rm(harness.configFile, { force: true })
    const workspace = URI.file(harness.workspace).toString()
    const uri = await harness.service.ensureConfigFile(workspace)
    expect(uri.startsWith('file:')).toBe(true)
    const text = await readFile(harness.configFile, 'utf8')
    expect(text).toContain('// Agent 触发器配置')
    expect(text).toContain('"version": 1')
    await harness.service.ensureConfigFile(workspace)
    expect(await readFile(harness.configFile, 'utf8')).toBe(text)
  })
})

describe('TriggerMainService workspace rescan', () => {
  function readRegistry(dir: string): Promise<{ workspaces: string[] }> {
    return readFile(join(dir, 'triggers', 'workspaces.json'), 'utf8').then(
      (text) => JSON.parse(text) as { workspaces: string[] },
    )
  }

  it('discovers a triggers.json created after the workspace opened, idempotently', async () => {
    const harness = await createHarness({ skipConfigFile: true, autoConfirm: false })
    const workspace = URI.file(harness.workspace).toString()
    expect(await harness.service.listTriggers()).toEqual([])

    await mkdir(dirname(harness.configFile), { recursive: true })
    await writeFile(
      harness.configFile,
      `${JSON.stringify({ version: 1, triggers: [makeTrigger(harness.workspace)] }, null, 2)}\n`,
      'utf8',
    )
    await harness.service.rescanWorkspace(workspace)

    const list = await harness.service.listTriggers()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: 'trigger-1',
      paused: true,
      activationConfirmed: false,
    })
    expect((await readRegistry(harness.dir)).workspaces).toEqual([workspace])

    await harness.service.rescanWorkspace(workspace)
    expect(await harness.service.listTriggers()).toHaveLength(1)
    expect((await readRegistry(harness.dir)).workspaces).toEqual([workspace])
  })

  it('skips a missing config file without creating it', async () => {
    const harness = await createHarness({ skipConfigFile: true })
    const workspace = URI.file(harness.workspace).toString()

    await harness.service.rescanWorkspace(workspace)
    await harness.service.rescanWorkspace(workspace)

    expect(await harness.service.listTriggers()).toEqual([])
    await expect(stat(harness.configFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readRegistry(harness.dir)).workspaces).toEqual([])
  })
})

describe('TriggerMainService run reports', () => {
  const RUN_ID = '123e4567-e89b-42d3-a456-426614174000'

  it('reads report.md by run id and decodes UTF-8', async () => {
    const harness = await createHarness()
    const runDir = join(harness.dir, 'triggers', 'runs', RUN_ID)
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'report.md'), '# 报告\n\n正文', 'utf8')

    const result = await harness.service.readRunReport(RUN_ID)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') throw new Error('expected a readable report')
    expect(result.text).toBe('# 报告\n\n正文')
    expect(result.runDir).toBe(URI.file(runDir).toString())
    expect(result.modifiedAt).toBeGreaterThan(0)
  })

  it('returns not-found for unknown or malformed run ids', async () => {
    const harness = await createHarness()

    expect(await harness.service.readRunReport(RUN_ID)).toEqual({ kind: 'not-found' })
    expect(await harness.service.readRunReport('../escape')).toEqual({ kind: 'not-found' })
  })

  it('returns too-large above the shared byte cap', async () => {
    const harness = await createHarness()
    const runDir = join(harness.dir, 'triggers', 'runs', RUN_ID)
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'report.md'), 'x'.repeat(MAX_TRIGGER_REPORT_BYTES + 1), 'utf8')

    expect(await harness.service.readRunReport(RUN_ID)).toEqual({ kind: 'too-large' })
  })
})

describe('TriggerMainService workspace activation gate', () => {
  it('keeps an unconfirmed trigger dormant: no scheduling, no poll command, no runNow', async () => {
    const fetch = vi.fn<PollCommandFetcher>(async () => ({ ok: true, items: [] }))
    const harness = await createHarness({
      autoConfirm: false,
      triggers: (workspace) => [makeTrigger(workspace, { source: pollSource() })],
      fetch,
    })
    await openGate(harness)
    await harness.clock.advance(10 * 60_000)
    await settle()

    // The poll command executes shell code in main: it must not run at all.
    expect(fetch).not.toHaveBeenCalled()
    expect(harness.startRun).not.toHaveBeenCalled()
    const pending = summary(await harness.service.listTriggers(), 'trigger-1')
    // Both gates are open; a first-seen trigger reports paused first.
    expect(pending.status).toBe('paused')
    expect(pending.activationConfirmed).toBe(false)
    expect(pending.nextRunAt).toBeUndefined()
    await expect(harness.service.runNow(harness.key)).rejects.toThrow(/Confirm this trigger/)

    await confirmTrigger(harness.service, harness.key)
    const confirmed = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(confirmed.activationConfirmed).toBe(true)
    await harness.service.setPaused(harness.key, false)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').status).toBe('idle')
    // Confirmation arms the poll immediately; until then the command never ran.
    await harness.clock.advance(0)
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('invalidates the activation when the definition changes', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    expect(summary(await harness.service.listTriggers(), 'trigger-1').activationConfirmed).toBe(
      true,
    )

    await writeFile(
      harness.configFile,
      JSON.stringify({
        version: 1,
        triggers: [makeTrigger(harness.workspace, { name: 'Renamed' })],
      }),
      'utf8',
    )
    await waitFor(
      async () => summary(await harness.service.listTriggers(), 'trigger-1').name === 'Renamed',
    )
    const edited = summary(await harness.service.listTriggers(), 'trigger-1')
    expect(edited.activationConfirmed).toBe(false)
    expect(edited.status).toBe('needs-confirmation')
    await expect(harness.service.runNow(harness.key)).rejects.toThrow(/Confirm this trigger/)
  })

  it('registers a second workspace and keeps same-id triggers independent', async () => {
    const harness = await createHarness({
      autoConfirm: false,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    // The default first-seen pause would mask the per-key assertions below.
    await harness.service.setPaused(harness.key, false)

    const second = join(harness.dir, 'workspace-b')
    const secondConfig = join(second, '.universe-editor', 'triggers.json')
    await mkdir(dirname(secondConfig), { recursive: true })
    await writeFile(
      secondConfig,
      JSON.stringify({ version: 1, triggers: [makeTrigger(second)] }),
      'utf8',
    )
    // The window reports the folder before the wizard asks main to register it.
    harness.service.noteWindowWorkspace(URI.file(second), 3)
    const uri = await harness.service.ensureConfigFile(URI.file(second).toString())
    expect(uri).toContain('.universe-editor/triggers.json')

    const list = await harness.service.listTriggers()
    const sameId = list.filter((entry) => entry.id === 'trigger-1')
    expect(sameId).toHaveLength(2)
    expect(new Set(sameId.map((entry) => entry.key)).size).toBe(2)
    expect(sameId.every((entry) => entry.activationConfirmed === false)).toBe(true)
    expect(new Set(sameId.map((entry) => entry.workspaceName)).size).toBe(2)

    const secondKey = sameId.find((entry) => entry.workspace === URI.file(second).toString())!.key
    await confirmTrigger(harness.service, secondKey)
    const afterConfirm = await harness.service.listTriggers()
    expect(afterConfirm.find((entry) => entry.key === harness.key)?.activationConfirmed).toBe(false)
    expect(afterConfirm.find((entry) => entry.key === secondKey)?.activationConfirmed).toBe(true)

    // Pause is per composite key, not per bare id.
    await harness.service.setPaused(secondKey, true)
    const afterPause = await harness.service.listTriggers()
    expect(afterPause.find((entry) => entry.key === secondKey)?.paused).toBe(true)
    expect(afterPause.find((entry) => entry.key === harness.key)?.paused).toBe(false)

    const localUriOf = (path: string): string => URI.file(path).toString()
    const workspaces = await harness.service.listWorkspaces()
    expect(workspaces.map((entry) => entry.workspace)).toEqual([
      localUriOf(harness.workspace),
      localUriOf(second),
    ])
    expect(workspaces.every((entry) => entry.available)).toBe(true)

    await harness.service.removeWorkspace(localUriOf(second))
    expect((await harness.service.listWorkspaces()).map((entry) => entry.workspace)).toEqual([
      localUriOf(harness.workspace),
    ])
    expect(
      (await harness.service.listTriggers()).filter((entry) => entry.id === 'trigger-1'),
    ).toHaveLength(1)
  })

  it('drops queued events and pending records when a workspace is removed', async () => {
    const harness = await createHarness({
      holdStartRun: true,
      maxConcurrentRuns: 1,
      triggers: (workspace) => [
        makeTrigger(workspace, { id: 'first' }),
        makeTrigger(workspace, { id: 'second' }),
      ],
    })
    await openGate(harness)
    await harness.service.runNow(harness.keyOf('first'))
    await harness.service.runNow(harness.keyOf('second'))
    expect((await stateOf(harness)).pending).toHaveLength(2)

    await harness.service.removeWorkspace(URI.file(harness.workspace).toString())
    expect((await stateOf(harness)).pending).toEqual([])
    expect(await harness.service.listTriggers()).toEqual([])
    harness.releaseStartRun()
    await settle()
  })

  it('normalizes an IPC key to the canonical composite key', async () => {
    const harness = await createHarness({
      autoConfirm: false,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    // Extra separators / trailing slash must not create a second state entry.
    const nonCanonical = `${harness.workspace}/./\u0000trigger-1`
    const fingerprint = (await harness.service.listTriggers())[0]!.fingerprint
    await harness.service.confirmActivation(nonCanonical, fingerprint)

    const state = await stateOf(harness)
    expect(Object.keys(state.triggers)).toEqual([harness.key])
    expect(state.triggers[harness.key]?.activationConfirmed).toBeDefined()
  })

  it('routes swarm reports only to the reporting workspace', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          id: 'swarm-a',
          source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        }),
      ],
    })
    const second = join(harness.dir, 'workspace-b')
    const secondConfig = join(second, '.universe-editor', 'triggers.json')
    await mkdir(dirname(secondConfig), { recursive: true })
    await writeFile(
      secondConfig,
      JSON.stringify({
        version: 1,
        triggers: [
          makeTrigger(second, {
            id: 'swarm-b',
            source: { type: 'event', event: 'swarm.reviewNeedsAction' },
          }),
        ],
      }),
      'utf8',
    )
    harness.service.noteWindowWorkspace(URI.file(second), 4)
    await harness.service.ensureConfigFile(URI.file(second).toString())
    const secondKey = (await harness.service.listTriggers()).find(
      (entry) => entry.workspace === URI.file(second).toString(),
    )!.key
    await confirmTrigger(harness.service, secondKey)

    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1')],
      URI.file(second).toString(),
    )

    const state = await stateOf(harness)
    expect(state.triggers[secondKey]?.baselineDone).toBe(true)
    expect(state.triggers[harness.keyOf('swarm-a')]?.baselineDone).toBe(false)
    expect(state.triggers[harness.keyOf('swarm-a')]?.processed?.['swarm:1']).toBeUndefined()
    expect(harness.startRun).not.toHaveBeenCalled()
  })

  it('ignores a remote workspace report instead of consuming a local trigger', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          id: 'swarm',
          source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        }),
      ],
    })
    await openGate(harness)

    const remote = URI.from({
      scheme: 'remote-ssh',
      authority: 'dev',
      path: '/home/testuser/proj',
    })
    await harness.service.reportTriggerEvents(
      SWARM_TRIGGER_EVENT_NAME,
      [review('1')],
      remote.toString(),
    )
    await settle()

    const state = await stateOf(harness)
    expect(state.triggers[harness.keyOf('swarm')]?.baselineDone).not.toBe(true)
    expect(state.triggers[harness.keyOf('swarm')]?.processed?.['swarm:1']).toBeUndefined()
    expect(harness.startRun).not.toHaveBeenCalled()
    // A remote URI is a valid identity now; it simply matches no registered workspace.
    expect(harness.loggerLines.some((line) => line.includes('swarm report ignored'))).toBe(false)
  })

  it('warns and ignores a report whose workspace URI is empty or unparseable', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [
        makeTrigger(workspace, {
          id: 'swarm',
          source: { type: 'event', event: 'swarm.reviewNeedsAction' },
        }),
      ],
    })
    await openGate(harness)

    await harness.service.reportTriggerEvents(SWARM_TRIGGER_EVENT_NAME, [review('1')], '')
    await settle()

    const state = await stateOf(harness)
    expect(state.triggers[harness.keyOf('swarm')]?.baselineDone).not.toBe(true)
    expect(harness.startRun).not.toHaveBeenCalled()
    expect(
      harness.loggerLines.some(
        (line) => line.startsWith('warn:') && line.includes('trigger event report ignored'),
      ),
    ).toBe(true)
  })
})

describe('TriggerMainService change notifications', () => {
  it('coalesces a synchronous burst into one stable summary snapshot', async () => {
    const harness = await createHarness({
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    const events: (readonly TriggerSummary[])[] = []
    const subscription = harness.service.onDidChangeTriggers((list) => events.push(list))
    try {
      await Promise.all([
        harness.service.setAllPaused(true),
        harness.service.setPaused(harness.key, true),
      ])
      await settle()
      expect(events).toHaveLength(1)
      expect(events[0]?.every((entry) => entry.paused === true)).toBe(true)
    } finally {
      subscription.dispose()
    }
  })

  it('does not emit when a change leaves the summary snapshot untouched', async () => {
    const harness = await createHarness({
      autoConfirm: false,
      triggers: (workspace) => [makeTrigger(workspace)],
    })
    await openGate(harness)
    const [summary] = await harness.service.listTriggers()
    expect(summary).toBeDefined()
    const events: (readonly TriggerSummary[])[] = []
    const subscription = harness.service.onDidChangeTriggers((list) => events.push(list))
    try {
      await harness.service.confirmActivation(summary!.key, summary!.fingerprint)
      await settle()
      expect(events).toHaveLength(1)
      // Same fingerprint again: activationConfirmed already equals it, so the
      // summaries are byte-identical and the notification must be suppressed.
      await harness.service.confirmActivation(summary!.key, summary!.fingerprint)
      await settle()
      expect(events).toHaveLength(1)
    } finally {
      subscription.dispose()
    }
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
