/*---------------------------------------------------------------------------------------------
 *  Tests for renderer TimerService — merges main + renderer marks into metrics.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { PerformanceMark } from '@universe-editor/platform'
import type { IPerformanceMarksService } from '../../../../shared/ipc/services.js'
import { PerfMarks } from '../../../../shared/perf/marks.js'
import { TimerService } from '../TimerService.js'

function mainMarksStub(marks: PerformanceMark[]): IPerformanceMarksService {
  return {
    _serviceBrand: undefined,
    getMarks: () => Promise.resolve(marks),
  }
}

const FULL_TIMELINE: PerformanceMark[] = [
  { name: PerfMarks.timeOrigin, startTime: 1000 },
  { name: PerfMarks.mainDidStart, startTime: 1010 },
  { name: PerfMarks.mainAppReady, startTime: 1200 },
  { name: PerfMarks.mainDidCreateServices, startTime: 1300 },
  { name: PerfMarks.mainWillCreateWindow, startTime: 1350 },
  { name: PerfMarks.mainDidShowWindow, startTime: 1400 },
  { name: PerfMarks.rendererWillStartBootstrap, startTime: 1500 },
  { name: PerfMarks.rendererDidCreateIpc, startTime: 1550 },
  { name: PerfMarks.rendererWillRestore, startTime: 1600 },
  { name: PerfMarks.rendererDidRestoreServices, startTime: 1700 },
  { name: PerfMarks.rendererDidMount, startTime: 1800 },
  { name: PerfMarks.rendererDidRestoreEditors, startTime: 1900 },
]

describe('TimerService', () => {
  it('merges main + renderer marks sorted by startTime', async () => {
    const svc = new TimerService(mainMarksStub(FULL_TIMELINE))
    const marks = await svc.getPerfMarks()
    for (let i = 1; i < marks.length; i++) {
      const prev = marks[i - 1]
      const cur = marks[i]
      if (!prev || !cur) continue
      expect(cur.startTime).toBeGreaterThanOrEqual(prev.startTime)
    }
    expect(marks.some((m) => m.name === PerfMarks.mainAppReady)).toBe(true)
  })

  it('computes totalTime from main timeOrigin to renderer mount', async () => {
    const svc = new TimerService(mainMarksStub(FULL_TIMELINE))
    const metrics = await svc.getStartupMetrics()
    expect(metrics.totalTime).toBe(800) // 1800 - 1000
  })

  it('builds contiguous phases between adjacent milestones', async () => {
    const svc = new TimerService(mainMarksStub(FULL_TIMELINE))
    const metrics = await svc.getStartupMetrics()
    expect(metrics.phases).toHaveLength(10) // 11 milestones present → 10 phases
    const first = metrics.phases[0]
    expect(first?.from).toBe('Main process started')
    expect(first?.to).toBe('Electron app ready')
    expect(first?.duration).toBe(190) // 1200 - 1010
  })

  it('skips missing milestones (partial timeline)', async () => {
    const partial: PerformanceMark[] = [
      { name: PerfMarks.timeOrigin, startTime: 1000 },
      { name: PerfMarks.mainDidStart, startTime: 1010 },
      { name: PerfMarks.mainAppReady, startTime: 1200 },
      { name: PerfMarks.rendererDidMount, startTime: 1800 },
    ]
    const svc = new TimerService(mainMarksStub(partial))
    const metrics = await svc.getStartupMetrics()
    expect(metrics.phases).toHaveLength(2) // didStart→appReady, appReady→didMount
    expect(metrics.totalTime).toBe(800)
  })

  it('falls back to renderer-only marks when main channel fails', async () => {
    const failing: IPerformanceMarksService = {
      _serviceBrand: undefined,
      getMarks: () => Promise.reject(new Error('channel down')),
    }
    const svc = new TimerService(failing)
    const marks = await svc.getPerfMarks()
    // renderer always has at least its own code/timeOrigin from the perf util
    expect(Array.isArray(marks)).toBe(true)
    expect(marks.every((m) => m.name !== PerfMarks.mainAppReady)).toBe(true)
  })
})
