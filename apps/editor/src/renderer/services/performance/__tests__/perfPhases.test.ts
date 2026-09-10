import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetPerfPhasesForTests,
  formatBytes,
  getRecordedPhases,
  recordPerfPhase,
  recordPerfPhaseAsync,
  samplesInWindow,
  slowPhaseInstrument,
  type PerfSample,
} from '../perfPhases.js'

const sample = (name: string, startTime: number, duration: number): PerfSample => ({
  name,
  startTime,
  duration,
})

beforeEach(() => {
  _resetPerfPhasesForTests()
})

describe('recordPerfPhase', () => {
  it('returns the callback result and records a named sample', () => {
    const result = recordPerfPhase('test.phase', () => 42)
    expect(result).toBe(42)
    const phases = getRecordedPhases()
    expect(phases).toHaveLength(1)
    expect(phases[0]?.name).toBe('test.phase')
    expect(phases[0]?.duration).toBeGreaterThanOrEqual(0)
  })

  it('records the sample even when the callback throws', () => {
    expect(() =>
      recordPerfPhase('test.throwing', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(getRecordedPhases()).toHaveLength(1)
  })

  it('caps the buffer instead of growing without bound', () => {
    for (let i = 0; i < 400; i++) recordPerfPhase(`p${i}`, () => undefined)
    const phases = getRecordedPhases()
    expect(phases.length).toBeLessThanOrEqual(256)
    // Oldest samples were evicted, latest kept.
    expect(phases[phases.length - 1]?.name).toBe('p399')
  })
})

describe('recordPerfPhaseAsync', () => {
  it('spans the whole promise, not just the synchronous head', async () => {
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const pending = recordPerfPhaseAsync('test.async', async () => {
      await gate
      return 'done'
    })
    // Still in flight: nothing recorded yet (a sync wrapper would have stopped
    // at the first await and recorded a ~0ms sample already).
    expect(getRecordedPhases()).toHaveLength(0)
    resume()
    await expect(pending).resolves.toBe('done')
    const phases = getRecordedPhases()
    expect(phases).toHaveLength(1)
    expect(phases[0]?.name).toBe('test.async')
  })

  it('records the sample even when the promise rejects', async () => {
    await expect(
      recordPerfPhaseAsync('test.asyncThrow', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(getRecordedPhases()).toHaveLength(1)
  })
})

describe('samplesInWindow', () => {
  it('keeps samples overlapping the window, including a task started before it', () => {
    const samples = [
      sample('before', 0, 50), // ends at 50, window starts at 100 → out
      sample('straddling', 80, 60), // ends at 140, inside → in (the click-handling task)
      sample('inside', 200, 30),
      sample('after', 600, 10), // starts past the window end → out
    ]
    expect(samplesInWindow(samples, 100, 500).map((s) => s.name)).toEqual(['straddling', 'inside'])
  })
})

describe('slowPhaseInstrument', () => {
  it('records nothing while under the threshold', () => {
    const instrumented = slowPhaseInstrument('ipc.decode', 5)
    instrumented(() => undefined)
    expect(getRecordedPhases()).toHaveLength(0)
  })

  it('appends the lazily-evaluated detail only when the threshold fires', () => {
    vi.useFakeTimers()
    try {
      const detail = vi.fn(() => '(14.2MB)')
      const instrumented = slowPhaseInstrument('ipc.decode', 5, detail)
      // Fast frame: detail must not even be evaluated.
      instrumented(() => undefined)
      expect(detail).not.toHaveBeenCalled()
      expect(getRecordedPhases()).toHaveLength(0)

      // Slow frame: the sample name carries the detail suffix.
      instrumented(() => vi.advanceTimersByTime(10))
      expect(detail).toHaveBeenCalledTimes(1)
      const phases = getRecordedPhases()
      expect(phases).toHaveLength(1)
      expect(phases[0]?.name).toBe('ipc.decode (14.2MB)')
      expect(phases[0]?.duration).toBeGreaterThanOrEqual(5)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('formatBytes', () => {
  it('formats bytes across the B/KB/MB boundaries', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(320)).toBe('320B')
    expect(formatBytes(1023)).toBe('1023B')
    expect(formatBytes(1024)).toBe('1.0KB')
    expect(formatBytes(615 * 1024)).toBe('615.0KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0MB')
    expect(formatBytes(Math.round(14.2 * 1024 * 1024))).toBe('14.2MB')
  })
})
