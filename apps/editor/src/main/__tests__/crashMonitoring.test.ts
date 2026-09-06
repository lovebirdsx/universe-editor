/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/crashMonitoring.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'

// crashMonitoring imports electron at module scope; stub it for node tests.
const appMetrics: { current: unknown[] } = { current: [] }
vi.mock('electron', () => ({
  app: {
    setPath: vi.fn(),
    on: vi.fn(),
    getPath: () => '',
    getAppMetrics: () => appMetrics.current,
  },
  crashReporter: { start: vi.fn() },
}))

/** One `app.getAppMetrics()` row for a renderer at `mb` megabytes. */
function tabMetric(pid: number, mb: number): unknown {
  return {
    pid,
    type: 'Tab',
    memory: { workingSetSize: mb * 1024 },
    cpu: { percentCPUUsage: 1 },
  }
}

const {
  formatMainHeapSample,
  MAIN_HEAP_WARN_BYTES,
  MAIN_HEAP_BUSY_BYTES,
  TAB_WORKING_SET_WARN_BYTES,
  PROCESS_METRICS_NORMAL_INTERVAL_MS,
  PROCESS_METRICS_BUSY_INTERVAL_MS,
  processMetricsIntervalMs,
  installProcessMetricsLogging,
} = await import('../crashMonitoring.js')

describe('formatMainHeapSample', () => {
  it('formats heapUsed/heapTotal/external/rss in rounded MB', () => {
    const line = formatMainHeapSample({
      heapUsed: 2.67 * 1024 * 1024 * 1024,
      heapTotal: 2.8 * 1024 * 1024 * 1024,
      external: 45 * 1024 * 1024,
      rss: 3 * 1024 * 1024 * 1024,
    })
    expect(line).toBe('main-heap heapUsed=2734MB heapTotal=2867MB external=45MB rss=3072MB')
  })

  it('rounds sub-MB values to 0MB rather than emitting fractions', () => {
    const line = formatMainHeapSample({
      heapUsed: 400_000,
      heapTotal: 900_000,
      external: 0,
      rss: 1_500_000,
    })
    expect(line).toBe('main-heap heapUsed=0MB heapTotal=1MB external=0MB rss=1MB')
  })
})

describe('MAIN_HEAP_WARN_BYTES', () => {
  it('is 1.5GB — the agreed pre-OOM warn threshold', () => {
    expect(MAIN_HEAP_WARN_BYTES).toBe(1536 * 1024 * 1024)
  })
})

describe('processMetricsIntervalMs', () => {
  it('uses the normal 30s interval well below the busy threshold', () => {
    expect(processMetricsIntervalMs(100 * 1024 * 1024)).toBe(30_000)
    expect(PROCESS_METRICS_NORMAL_INTERVAL_MS).toBe(30_000)
  })

  it('switches to the 10s busy interval once heapUsed exceeds 512MB', () => {
    expect(processMetricsIntervalMs(MAIN_HEAP_BUSY_BYTES + 1)).toBe(10_000)
    expect(PROCESS_METRICS_BUSY_INTERVAL_MS).toBe(10_000)
    expect(MAIN_HEAP_BUSY_BYTES).toBe(512 * 1024 * 1024)
  })

  it('stays on the normal interval at exactly the threshold (strictly over means busy)', () => {
    expect(processMetricsIntervalMs(MAIN_HEAP_BUSY_BYTES)).toBe(PROCESS_METRICS_NORMAL_INTERVAL_MS)
  })

  it('recovers to the normal interval after the heap falls back', () => {
    expect(processMetricsIntervalMs(MAIN_HEAP_BUSY_BYTES - 1)).toBe(
      PROCESS_METRICS_NORMAL_INTERVAL_MS,
    )
  })

  it('samples densely for a climbing renderer even while the main heap is calm', () => {
    expect(processMetricsIntervalMs(1024, true)).toBe(PROCESS_METRICS_BUSY_INTERVAL_MS)
  })
})

describe('installProcessMetricsLogging', () => {
  /** Install, take the synchronous first sample, return what was logged. */
  function sampleOnce(metrics: unknown[]): { info: string[]; warn: string[] } {
    appMetrics.current = metrics
    const info: string[] = []
    const warn: string[] = []
    const disposable = installProcessMetricsLogging({
      createLogger: () =>
        ({
          info: (line: string) => info.push(line),
          warn: (line: string) => warn.push(line),
        }) as never,
    })
    disposable.dispose()
    appMetrics.current = []
    return { info, warn }
  }

  it('takes the first sample synchronously at install (a fast crash still leaves a data point)', () => {
    const lines: string[] = []
    const disposable = installProcessMetricsLogging({
      createLogger: () =>
        ({
          info: (line: string) => lines.push(line),
          warn: (line: string) => lines.push(line),
        }) as never,
    })
    try {
      // No timer advance: the app-metrics line and the heap line are written
      // by the synchronous first sample.
      expect(lines.some((l) => l.startsWith('main-heap '))).toBe(true)
    } finally {
      disposable.dispose()
    }
  })

  it('warns once a renderer climbs past the Tab working-set threshold', () => {
    // Replays the shape of a real OOM: a renderer that walked from 0.7GB to
    // 5.4GB over two hours and left a full curve in the log with zero warnings,
    // because nothing ever compared the Tab rows to a threshold.
    expect(sampleOnce([tabMetric(1929756, 722)]).warn).toHaveLength(0)
    for (const mb of [2100, 5428]) {
      const warn = sampleOnce([tabMetric(1929756, mb)]).warn
      expect(warn.some((l) => l.includes('type=Tab') && l.includes('OOM risk'))).toBe(true)
    }
  })

  it('still logs every process on the info line regardless of the threshold', () => {
    const { info } = sampleOnce([tabMetric(1, 100)])
    expect(info.some((l) => l.includes('pid=1') && l.includes('type=Tab'))).toBe(true)
  })

  it('TAB_WORKING_SET_WARN_BYTES is 2GB — under the kill point, with room to react', () => {
    expect(TAB_WORKING_SET_WARN_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })
})
