/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/MemoryReminderContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter, Severity, observableValue } from '@universe-editor/platform'
import { MemoryReminderContribution } from '../MemoryReminderContribution.js'
import { MemoryPressureLevel } from '../../services/memory/memoryPressureLevels.js'
import type {
  IMemoryPressureService,
  MemoryPressureSample,
} from '../../services/memory/memoryPressureService.js'
import { RELOAD_ARM_INTENT_KEY } from '../../services/diagnostics/diagnosisReloadSession.js'
import type { HeapSnapshotStatus, IDiagnosticsService } from '../../../shared/ipc/services.js'

const MINUTE = 60_000
const BASE = 1_700_000_000_000
const HIGH_USED = 2 * 1024 * 1024 * 1024

const OFF_STATUS: HeapSnapshotStatus = {
  active: false,
  phase: 'off',
  attempts: 0,
  attemptLimit: 2,
  appAttempts: 0,
  appAttemptLimit: 4,
  artifacts: 0,
  bytes: 0,
}

const ARMED_STATUS: HeapSnapshotStatus = { ...OFF_STATUS, active: true, phase: 'baseline' }

interface Notice {
  severity: Severity
  message: string
  sticky?: boolean
  actions?: Array<{ label: string; run: () => void }>
}

interface Harness {
  readonly contribution: MemoryReminderContribution
  readonly notices: Notice[]
  readonly dismissed: string[]
  readonly executed: string[]
  readonly arm: ReturnType<typeof vi.fn>
  /** Every line this contribution logged, at any level. */
  readonly logs: string[]
  /** Make `getHeapSnapshotStatus` report a round already in flight. */
  setRoundRunning(running: boolean): void
  /** Make `getHeapSnapshotStatus` never settle, the way a wedged main process would. */
  setStatusHangs(hangs: boolean): void
  /** Advance the wall clock by `minutes` and deliver one reading at that time. */
  emit(minutes: number, level?: MemoryPressureLevel, used?: number): void
  dispose(): void
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(initial))
  return {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, value),
  }
}

function harness(armImpl?: () => Promise<HeapSnapshotStatus>): Harness {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)

  const sampleEmitter = new Emitter<MemoryPressureSample>()
  const levelEmitter = new Emitter<MemoryPressureLevel>()
  const notices: Notice[] = []
  const dismissed: string[] = []
  const executed: string[] = []
  let roundRunning = false
  let statusHangs = false
  const arm = vi.fn(armImpl ?? (() => Promise.resolve(ARMED_STATUS)))

  const pressure: IMemoryPressureService = {
    _serviceBrand: undefined,
    level: observableValue<MemoryPressureLevel>('test', MemoryPressureLevel.Normal),
    onDidChangeLevel: levelEmitter.event,
    onDidSample: sampleEmitter.event,
    registerReleaser: () => ({ dispose: () => {} }),
    sample: () => MemoryPressureLevel.Normal,
    release: () => [],
    isConstrained: () => false,
    releaserIds: () => [],
    describe: () => 'memory test',
    start: () => {},
    stop: () => {},
  }

  const diagnostics: IDiagnosticsService = {
    _serviceBrand: undefined,
    consumeAbnormalExitReport: () => Promise.resolve(null),
    revealCrashesFolder: () => Promise.resolve(),
    collectIssueReport: () => Promise.resolve(''),
    exportDiagnosticsZip: () => Promise.resolve(''),
    createDiagnosticsZip: () => Promise.resolve(''),
    reportRendererHeapSample: () => Promise.resolve(),
    startHeapSnapshotRound: arm as unknown as IDiagnosticsService['startHeapSnapshotRound'],
    stopHeapSnapshotRound: () => Promise.resolve(OFF_STATUS),
    getHeapSnapshotStatus: () =>
      statusHangs
        ? new Promise<HeapSnapshotStatus>(() => {})
        : Promise.resolve(roundRunning ? ARMED_STATUS : OFF_STATUS),
    revealHeapSnapshotsFolder: () => Promise.resolve(),
    onDidChangeHeapSnapshot: new Emitter<never>().event,
  }

  const notifications = {
    notify: (options: Notice) => {
      notices.push(options)
      return { id: `notice-${notices.length}` }
    },
    dismiss: (id: string) => {
      dismissed.push(id)
    },
  }

  const commands = {
    executeCommand: (id: string) => {
      executed.push(id)
      return Promise.resolve(undefined)
    },
  }

  // The log is the only place some of this feature's outcomes show up (a refusal after the
  // reload leaves nothing on screen), so the tests read it rather than assert on silence.
  const logs: string[] = []
  const loggerService = {
    createLogger: () => ({
      level: 0,
      onDidChangeLogLevel: new Emitter<never>().event,
      setLevel: () => {},
      trace: (message: string) => logs.push(message),
      debug: (message: string) => logs.push(message),
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      error: (message: string) => logs.push(message),
      flush: () => {},
      dispose: () => {},
    }),
  }

  const contribution = new MemoryReminderContribution(
    pressure,
    notifications as never,
    commands as never,
    diagnostics,
    loggerService as never,
  )

  return {
    contribution,
    notices,
    dismissed,
    executed,
    arm,
    logs,
    setRoundRunning: (running) => {
      roundRunning = running
    },
    setStatusHangs: (hangs) => {
      statusHangs = hangs
    },
    emit: (minutes, level = MemoryPressureLevel.Elevated, used = HIGH_USED) => {
      vi.setSystemTime(BASE + minutes * MINUTE)
      sampleEmitter.fire({
        level,
        previous: level,
        used,
        limit: 4 * 1024 * 1024 * 1024,
        thresholds: { elevated: 1.8e9, critical: 2.7e9 },
      })
    },
    dispose: () => {
      sampleEmitter.dispose()
      levelEmitter.dispose()
      contribution.dispose()
    },
  }
}

/** Let the contribution's own awaits (status check, then notify) run to completion. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('MemoryReminderContribution', () => {
  const harnesses: Harness[] = []

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage())
  })
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.dispose()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function make(armImpl?: () => Promise<HeapSnapshotStatus>): Harness {
    const created = harness(armImpl)
    harnesses.push(created)
    return created
  }

  it('offers reload-and-diagnose once the heap has been high long enough', async () => {
    const h = make()
    for (const minutes of [0, 2, 4, 6, 8]) h.emit(minutes)
    await settle()
    expect(h.notices).toEqual([])

    h.emit(10)
    await settle()
    expect(h.notices).toHaveLength(1)
    const notice = h.notices[0]!
    expect(notice.severity).toBe(Severity.Warning)
    expect(notice.sticky).toBe(true)
    // The sentence has to carry what the user is agreeing to: the pause, the window
    // scope, what a snapshot contains, and that it stays local.
    expect(notice.message).toContain('10 minutes')
    expect(notice.message).toMatch(/up to about \d+ seconds/)
    expect(notice.message).toContain('Only this window is diagnosed')
    expect(notice.message).toContain('never uploaded automatically')
    // The reload is the other cost, and the one with no safety net behind it — this repo's
    // reload does not protect unsaved buffers.
    expect(notice.message).toContain('discards unsaved changes')
    // One paragraph: the toast renders this into a `<p>` with a ~5-line cap, so a newline
    // would not separate anything — it would only push the costs out of sight.
    expect(notice.message).not.toContain('\n')
    expect(notice.actions?.map((action) => action.label)).toEqual([
      'Reload and Start Diagnosis',
      'Not Now',
    ])
  })

  it('stays quiet while the window is shorter than the sustain line', async () => {
    const h = make()
    for (const minutes of [0, 2, 4, 6, 8]) h.emit(minutes)
    await settle()
    expect(h.notices).toEqual([])
  })

  it('stays quiet when the heap came back down in between', async () => {
    const h = make()
    for (const minutes of [0, 2, 4, 6]) h.emit(minutes)
    h.emit(8, MemoryPressureLevel.Normal, 900 * 1024 * 1024)
    for (const minutes of [10, 12, 14]) h.emit(minutes)
    await settle()
    expect(h.notices).toEqual([])
  })

  it('never asks twice in one window', async () => {
    const h = make()
    for (const minutes of [0, 2, 4, 6, 8, 10]) h.emit(minutes)
    await settle()
    expect(h.notices).toHaveLength(1)

    for (const minutes of [12, 14, 16, 18, 20]) h.emit(minutes)
    await settle()
    expect(h.notices).toHaveLength(1)
  })

  it('reloads through the command, and dismisses its own reminder first', async () => {
    const h = make()
    for (const minutes of [0, 2, 4, 6, 8, 10]) h.emit(minutes)
    await settle()

    h.notices[0]!.actions![0]!.run()
    expect(h.executed).toEqual(['workbench.action.reloadWindowForMemoryDiagnosis'])
    expect(h.dismissed).toEqual(['notice-1'])
  })

  it('does not offer to reload while a diagnosis round is already running', async () => {
    const h = make()
    h.setRoundRunning(true)
    for (const minutes of [0, 2, 4, 6, 8, 10]) h.emit(minutes)
    await settle()
    expect(h.notices).toEqual([])

    // Still deferred, still silent.
    for (const minutes of [12, 14]) h.emit(minutes)
    await settle()
    expect(h.notices).toEqual([])
  })

  it('still reminds after that deferral expires, because nothing was spent', async () => {
    const h = make()
    h.setRoundRunning(true)
    for (const minutes of [0, 2, 4, 6, 8, 10]) h.emit(minutes)
    await settle()
    expect(h.notices).toEqual([])

    // The round the user ran ended; the heap is still high. Readings keep coming at the
    // sampler's own cadence, so the stretch is unbroken rather than merely re-started.
    h.setRoundRunning(false)
    for (const minutes of [12, 14, 16]) h.emit(minutes)
    await settle()
    expect(h.notices).toHaveLength(1)
  })

  it('does not let a status read that never comes back mute this window for good', async () => {
    const h = make()
    h.setStatusHangs(true)
    for (const minutes of [0, 2, 4, 6, 8, 10]) h.emit(minutes)
    await settle()
    expect(h.notices).toEqual([])

    // The read is still hanging, but the latch that covered it has run out. A plain boolean
    // latch here would never be reset — `finally` does not run for a promise that never
    // settles — and every later reading would be dropped in silence.
    h.setStatusHangs(false)
    h.emit(12)
    await settle()
    expect(h.notices).toHaveLength(1)
  })

  it('stops feeding readings to the policy once disposed', async () => {
    const h = make()
    for (const minutes of [0, 2, 4, 6, 8]) h.emit(minutes)
    h.contribution.dispose()
    h.emit(10)
    await settle()
    expect(h.notices).toEqual([])
  })
})

describe('MemoryReminderContribution reload intent', () => {
  const harnesses: Harness[] = []

  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.dispose()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function make(armImpl?: () => Promise<HeapSnapshotStatus>): Harness {
    const created = harness(armImpl)
    harnesses.push(created)
    return created
  }

  it('arms a round when the renderer that came back finds the intent', async () => {
    vi.stubGlobal(
      'sessionStorage',
      memoryStorage({ [RELOAD_ARM_INTENT_KEY]: JSON.stringify({ at: BASE - 1_000 }) }),
    )
    const h = make()
    await settle()
    expect(h.arm).toHaveBeenCalledTimes(1)
    // One-shot: the intent is gone, so a later reload cannot arm another round.
    expect(sessionStorage.getItem(RELOAD_ARM_INTENT_KEY)).toBeNull()
  })

  it('arms nothing without an intent', async () => {
    const h = make()
    await settle()
    expect(h.arm).not.toHaveBeenCalled()
  })

  it('arms nothing from an intent older than the reload it was written for', async () => {
    vi.stubGlobal(
      'sessionStorage',
      memoryStorage({ [RELOAD_ARM_INTENT_KEY]: JSON.stringify({ at: BASE - 10 * MINUTE }) }),
    )
    const h = make()
    await settle()
    expect(h.arm).not.toHaveBeenCalled()
    // The user asked, the window reloaded, and nothing started — the one outcome of this
    // path that is invisible from the outside, so it has to leave a trace.
    expect(h.logs.some((line) => line.includes('expired'))).toBe(true)
  })

  it('says the round was refused rather than claiming it was armed', async () => {
    vi.stubGlobal(
      'sessionStorage',
      memoryStorage({ [RELOAD_ARM_INTENT_KEY]: JSON.stringify({ at: BASE - 1_000 }) }),
    )
    // The app-wide capture budget is spent: the reload happened, main declined the round.
    const h = make(() =>
      Promise.resolve({
        ...OFF_STATUS,
        phase: 'stopped',
        code: 'app-quota-exhausted',
        detail: 'capture budget spent',
      } as HeapSnapshotStatus),
    )
    await settle()
    // The refusal reaches the user through the round's own `stopped` event, not through a
    // second notification from here.
    expect(h.notices).toEqual([])
    expect(
      h.logs.some((line) => line.includes('refused') && line.includes('app-quota-exhausted')),
    ).toBe(true)
    expect(h.logs.some((line) => line.includes('armed after reload'))).toBe(false)
  })

  it('reports a failure to arm instead of failing silently', async () => {
    vi.stubGlobal(
      'sessionStorage',
      memoryStorage({ [RELOAD_ARM_INTENT_KEY]: JSON.stringify({ at: BASE - 1_000 }) }),
    )
    // The arm call happens while the contribution is still being constructed, so the
    // failing implementation has to be in place before it exists.
    const h = make(() => Promise.reject(new Error('renderer is gone')))
    await settle()
    expect(h.notices).toHaveLength(1)
    expect(h.notices[0]!.severity).toBe(Severity.Error)
    expect(h.notices[0]!.message).toContain('renderer is gone')
  })
})
