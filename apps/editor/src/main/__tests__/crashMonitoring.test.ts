/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/crashMonitoring.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'

// crashMonitoring imports electron at module scope; stub it for node tests.
vi.mock('electron', () => ({
  app: { setPath: vi.fn(), on: vi.fn(), getPath: () => '', getAppMetrics: () => [] },
  crashReporter: { start: vi.fn() },
}))

const {
  formatMainHeapSample,
  MAIN_HEAP_WARN_BYTES,
  MAIN_HEAP_BUSY_BYTES,
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
})

describe('installProcessMetricsLogging', () => {
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
})
