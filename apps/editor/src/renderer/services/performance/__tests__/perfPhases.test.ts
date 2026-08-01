import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetPerfPhasesForTests,
  getRecordedPhases,
  recordPerfPhase,
  samplesInWindow,
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
