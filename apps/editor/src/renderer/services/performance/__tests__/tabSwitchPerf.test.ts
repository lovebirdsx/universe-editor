import { beforeEach, describe, expect, it } from 'vitest'
import {
  TAB_SWITCH_WARN_MS,
  _resetTabSwitchPerfForTests,
  buildTabSwitchReport,
  formatTabSwitchReport,
  getRecordedPhases,
  recordTabSwitchPhase,
  samplesInWindow,
  shouldWarnTabSwitch,
  type TabSwitchSample,
} from '../tabSwitchPerf.js'

const sample = (name: string, startTime: number, duration: number): TabSwitchSample => ({
  name,
  startTime,
  duration,
})

beforeEach(() => {
  _resetTabSwitchPerfForTests()
})

describe('recordTabSwitchPhase', () => {
  it('returns the callback result and records a named sample', () => {
    const result = recordTabSwitchPhase('test.phase', () => 42)
    expect(result).toBe(42)
    const phases = getRecordedPhases()
    expect(phases).toHaveLength(1)
    expect(phases[0]?.name).toBe('test.phase')
    expect(phases[0]?.duration).toBeGreaterThanOrEqual(0)
  })

  it('records the sample even when the callback throws', () => {
    expect(() =>
      recordTabSwitchPhase('test.throwing', () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(getRecordedPhases()).toHaveLength(1)
  })

  it('caps the buffer instead of growing without bound', () => {
    for (let i = 0; i < 400; i++) recordTabSwitchPhase(`p${i}`, () => undefined)
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

describe('buildTabSwitchReport', () => {
  it('sums long-task durations into blockedMs and drops sub-millisecond phases', () => {
    const report = buildTabSwitchReport({
      label: 'file:///big.d.ts',
      startTime: 100,
      endTime: 1600,
      firstFrameMs: 480,
      longTasks: [sample('longtask', 90, 450), sample('longtask', 700, 120)],
      phases: [
        sample('fileEditor.setModel', 105, 430),
        sample('extHost.activeEditorEmit', 106, 0.4),
      ],
    })
    expect(report.blockedMs).toBe(570)
    expect(report.longTasks).toHaveLength(2)
    expect(report.phases.map((p) => p.name)).toEqual(['fileEditor.setModel'])
  })
})

describe('shouldWarnTabSwitch', () => {
  const base = {
    label: 'x',
    longTasks: [],
    phases: [],
  }

  it('warns when the first frame stayed frozen past the threshold', () => {
    expect(shouldWarnTabSwitch({ ...base, firstFrameMs: TAB_SWITCH_WARN_MS, blockedMs: 0 })).toBe(
      true,
    )
  })

  it('warns when deferred long tasks blocked past the threshold despite a fast first frame', () => {
    expect(
      shouldWarnTabSwitch({ ...base, firstFrameMs: 16, blockedMs: TAB_SWITCH_WARN_MS + 50 }),
    ).toBe(true)
  })

  it('stays quiet for a healthy switch', () => {
    expect(shouldWarnTabSwitch({ ...base, firstFrameMs: 30, blockedMs: 60 })).toBe(false)
  })
})

describe('formatTabSwitchReport', () => {
  it('renders label, rounded durations and per-sample offsets from the switch start', () => {
    const report = buildTabSwitchReport({
      label: 'file:///big.d.ts',
      startTime: 100,
      endTime: 1600,
      firstFrameMs: 480.6,
      longTasks: [sample('longtask', 90, 450)],
      phases: [sample('fileEditor.setModel', 105, 430)],
    })
    const line = formatTabSwitchReport(report, 100)
    expect(line).toContain('file:///big.d.ts')
    expect(line).toContain('first frame 481ms')
    expect(line).toContain('blocked 450ms')
    expect(line).toContain('task 450ms @+-10ms')
    expect(line).toContain('fileEditor.setModel 430ms @+5ms')
  })
})
