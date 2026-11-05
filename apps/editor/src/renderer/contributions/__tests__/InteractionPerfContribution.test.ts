import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigurationService, ConfigurationTarget, Emitter } from '@universe-editor/platform'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { InteractionPerfContribution } from '../InteractionPerfContribution.js'
import {
  IInteractionPerfService,
  type InteractionPerfSummary,
} from '../../services/performance/InteractionPerfService.js'
import type { SlowInteractionReport } from '../../services/performance/interactionPerf.js'
import { RESPONSIVENESS_STATUS_WARNING_ENABLED_KEY } from '../../services/performance/interactionPerfSettings.js'

class FakeInteractionPerf implements IInteractionPerfService {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<SlowInteractionReport>()
  readonly onDidRecordSlowInteraction = this._emitter.event
  start = vi.fn()
  stop = vi.fn()
  getSummary = vi.fn(
    (): InteractionPerfSummary => ({
      startedAt: undefined,
      totalSampleCount: 0,
      interactionCount: 0,
      slowCount: 0,
      byType: {},
      slowest: [],
      loafCount: 0,
    }),
  )

  record(startTime: number, durationMs: number): void {
    this._emitter.fire({ startTime, durationMs } as unknown as SlowInteractionReport)
  }

  dispose(): void {
    this._emitter.dispose()
  }
}

function createContribution() {
  const configuration = new ConfigurationService()
  configuration.update(RESPONSIVENESS_STATUS_WARNING_ENABLED_KEY, true, ConfigurationTarget.Memory)
  const interactionPerf = new FakeInteractionPerf()
  const statusBar = new StatusBarService()
  const contribution = new InteractionPerfContribution(configuration, interactionPerf, statusBar)
  return { contribution, interactionPerf, statusBar }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('InteractionPerfContribution status warning', () => {
  it('counts the overlapping reports of one jank frame as a single stall', () => {
    const { contribution, interactionPerf, statusBar } = createContribution()
    // Frame 1: pointerdown/mouseup/pointerover/mouseover all share one ~208ms window.
    interactionPerf.record(1000, 208)
    interactionPerf.record(1001, 207)
    interactionPerf.record(1002, 206)
    interactionPerf.record(1003, 205)
    // Frame 2: a second stall whose reports touch each other within the tolerance.
    interactionPerf.record(5000, 224)
    interactionPerf.record(5229, 220) // 5ms after the first window ends
    interactionPerf.record(5230, 218)
    interactionPerf.record(5231, 216)

    expect(statusBar.entries.get()).toHaveLength(0)

    contribution.dispose()
    interactionPerf.dispose()
  })

  it('lights up after five distinct stalls, one of which had several reports', () => {
    const { contribution, interactionPerf, statusBar } = createContribution()
    interactionPerf.record(1000, 208)
    interactionPerf.record(1001, 207)
    interactionPerf.record(1002, 206)
    interactionPerf.record(2000, 210)
    interactionPerf.record(3000, 210)
    interactionPerf.record(4000, 210)
    interactionPerf.record(5000, 210)

    const entries = statusBar.entries.get()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.entry.text).toBe('$(pulse) 5')
    expect(entries[0]?.entry.tooltip).toContain('5 slow responses in the last minute')

    contribution.dispose()
    interactionPerf.dispose()
  })

  it('does not merge a later stall beyond the tolerance', () => {
    const { contribution, interactionPerf, statusBar } = createContribution()
    // Five reports, but the last one starts 20ms after the previous window ended.
    interactionPerf.record(1000, 200)
    interactionPerf.record(1001, 199)
    interactionPerf.record(1002, 198)
    interactionPerf.record(1003, 197)
    interactionPerf.record(1220, 200)

    expect(statusBar.entries.get()).toHaveLength(0)

    contribution.dispose()
    interactionPerf.dispose()
  })

  it('drops stalls once they fall out of the one-minute window', () => {
    const { contribution, interactionPerf, statusBar } = createContribution()
    for (let i = 0; i < 5; i++) {
      interactionPerf.record(1000 + i * 1000, 210)
    }
    expect(statusBar.entries.get()).toHaveLength(1)

    vi.advanceTimersByTime(90_000)

    expect(statusBar.entries.get()).toHaveLength(0)

    contribution.dispose()
    interactionPerf.dispose()
  })
})
