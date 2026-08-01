import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  IEditorService,
  ILogger,
  ILoggerService,
  IObservable,
} from '@universe-editor/platform'
import { InteractionPerfService } from '../InteractionPerfService.js'
import type { InteractionEventSample } from '../interactionPerf.js'
import { _resetPerfPhasesForTests, recordPerfPhase } from '../perfPhases.js'
class CollectingLogger implements ILogger {
  readonly warnings: string[] = []
  readonly infos: string[] = []
  readonly _serviceBrand: undefined
  onDidChangeLogLevel = (() => ({ dispose: () => undefined })) as ILogger['onDidChangeLogLevel']
  level = 0 as ILogger['level']
  setLevel(): void {}
  trace(): void {}
  debug(): void {}
  info(message: string): void {
    this.infos.push(message)
  }
  warn(message: string): void {
    this.warnings.push(message)
  }
  error(): void {}
  flush(): void {}
  dispose(): void {}
}

function createService() {
  const logger = new CollectingLogger()
  const loggerService = {
    createLogger: () => logger,
  } as unknown as ILoggerService
  const editorService = {
    activeEditor: { get: () => undefined } as IObservable<undefined>,
  } as unknown as IEditorService
  const service = new InteractionPerfService(loggerService, editorService)
  return { service, logger }
}

const entry = (
  eventType: string,
  startTime: number,
  duration: number,
  interactionId: number,
): InteractionEventSample & { target: EventTarget | null } => ({
  eventType,
  startTime,
  processingStart: startTime + 8,
  processingEnd: startTime + 96,
  duration,
  interactionId,
  target: null,
})

beforeEach(() => _resetPerfPhasesForTests())

describe('InteractionPerfService aggregation', () => {
  let service: InteractionPerfService | undefined
  afterEach(() => {
    service?.dispose()
    service = undefined
  })

  it('aggregates deduped interaction samples per type, excluding non-interactions from histograms', () => {
    const ctx = createService()
    service = ctx.service
    service._handleEventEntries([
      entry('keydown', 100, 24, 1),
      entry('keypress', 100, 24, 1),
      entry('click', 200, 48, 2),
      entry('pointerdown', 200, 40, 2),
      entry('pointerenter', 300, 16, 0),
    ])
    const summary = service.getSummary()
    expect(summary.totalSampleCount).toBe(3)
    expect(summary.interactionCount).toBe(2)
    expect(summary.byType['keydown']?.count).toBe(1)
    expect(summary.byType['click']?.count).toBe(1)
    expect(summary.byType['click']?.maxMs).toBe(48)
    expect(summary.byType['pointerenter']).toBeUndefined()
    expect(summary.slowCount).toBe(0)
    expect(ctx.logger.warnings).toHaveLength(0)
  })

  it('warns once per throttled window for sustained slow input, counting every slow interaction', () => {
    const ctx = createService()
    service = ctx.service
    for (let i = 0; i < 3; i++) {
      service._handleEventEntries([entry('keydown', 1000 + i * 100, 320, 10 + i)])
    }
    expect(service.getSummary().slowCount).toBe(3)
    expect(ctx.logger.warnings).toHaveLength(1)
    expect(ctx.logger.warnings[0]).toContain('slow keydown 320ms')
    expect(ctx.logger.warnings[0]).toContain('(input 8 / processing 88 / present 224)')
  })

  it('correlates recorded perf phases and LoAF scripts into the slow-interaction line', () => {
    const ctx = createService()
    service = ctx.service
    // Anchor everything to the real clock: the phase and the LoAF both overlap
    // the interaction window [t0-8, t0+252].
    const t0 = performance.now()
    recordPerfPhase('dirtyDiff.compute', () => undefined)
    service._handleLoafEntry({
      startTime: t0 - 20,
      duration: 500,
      blockingDuration: 100,
      scripts: [
        {
          invoker: 'TimerHandler:setTimeout',
          sourceUrl: 'out/renderer/assets/index-x.js',
          sourceFunctionName: 'work',
          durationMs: 480,
        },
      ],
    })
    service._handleEventEntries([entry('keydown', t0 - 8, 260, 20)])
    expect(ctx.logger.warnings).toHaveLength(1)
    const line = ctx.logger.warnings[0]!
    expect(line).toContain('phases: [dirtyDiff.compute')
    expect(line).toContain('loaf: [frame 500ms blocking 100ms:')
    expect(line).toContain('index-x.js#work (TimerHandler:setTimeout) 480ms')
  })

  it('marks interactionId 0 slow entries as non-interaction', () => {
    const ctx = createService()
    service = ctx.service
    service._handleEventEntries([entry('pointerenter', 100, 240, 0)])
    expect(ctx.logger.warnings[0]).toContain('slow (non-interaction) pointerenter 240ms')
  })

  it('fires onDidRecordSlowInteraction even when the warn is throttled', () => {
    const ctx = createService()
    service = ctx.service
    const fired: string[] = []
    service.onDidRecordSlowInteraction((r) => fired.push(r.label))
    service._handleEventEntries([entry('keydown', 100, 320, 1)])
    service._handleEventEntries([entry('keydown', 200, 320, 2)])
    expect(fired).toEqual(['keydown', 'keydown'])
    expect(ctx.logger.warnings).toHaveLength(1)
  })

  it('keeps a bounded slowest-interactions leaderboard', () => {
    const ctx = createService()
    service = ctx.service
    for (let i = 0; i < 30; i++) {
      service._handleEventEntries([entry('keydown', i * 2000, 200 + i * 8, 100 + i)])
    }
    const slowest = service.getSummary().slowest
    expect(slowest.length).toBeLessThanOrEqual(20)
    expect(slowest[0]?.durationMs).toBe(200 + 29 * 8)
    for (let i = 1; i < slowest.length; i++) {
      expect(slowest[i]!.durationMs).toBeLessThanOrEqual(slowest[i - 1]!.durationMs)
    }
  })

  it('warns about an unattributed long frame but not one overlapping a slow interaction', () => {
    const ctx = createService()
    service = ctx.service
    // long frame overlapping the slow interaction below → no standalone warn
    service._handleEventEntries([entry('click', 1000, 400, 1)])
    service._handleLoafEntry({ startTime: 1050, duration: 380, blockingDuration: 300, scripts: [] })
    // isolated long frame → standalone warn
    service._handleLoafEntry({ startTime: 9000, duration: 500, blockingDuration: 450, scripts: [] })
    const warns = ctx.logger.warnings
    expect(warns).toHaveLength(2)
    expect(warns[0]).toContain('slow click 400ms')
    expect(warns[1]).toContain('long frame 500ms blocking 450ms (no interaction)')
    expect(service.getSummary().loafCount).toBe(2)
  })

  it('does not warn for long frames below the blocking threshold', () => {
    const ctx = createService()
    service = ctx.service
    service._handleLoafEntry({ startTime: 9000, duration: 500, blockingDuration: 100, scripts: [] })
    expect(ctx.logger.warnings).toHaveLength(0)
    expect(service.getSummary().loafCount).toBe(1)
  })

  it('logs a session summary on dispose', () => {
    const ctx = createService()
    service = ctx.service
    service._handleEventEntries([entry('keydown', 100, 24, 1)])
    service.dispose()
    service = undefined
    expect(ctx.logger.infos).toHaveLength(1)
    expect(ctx.logger.infos[0]).toContain('1 interactions')
    expect(ctx.logger.infos[0]).toContain('keydown: n=1')
  })
})
