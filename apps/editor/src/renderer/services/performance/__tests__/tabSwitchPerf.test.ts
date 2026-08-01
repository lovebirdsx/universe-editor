import { describe, expect, it } from 'vitest'
import type { PerfSample } from '../perfPhases.js'
import {
  TAB_SWITCH_WARN_MS,
  buildTabSwitchReport,
  formatTabSwitchReport,
  shouldWarnTabSwitch,
} from '../tabSwitchPerf.js'

const sample = (name: string, startTime: number, duration: number): PerfSample => ({
  name,
  startTime,
  duration,
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
