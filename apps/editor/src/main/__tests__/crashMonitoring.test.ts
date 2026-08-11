/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/crashMonitoring.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'

// crashMonitoring imports electron at module scope; stub it for node tests.
vi.mock('electron', () => ({
  app: { setPath: vi.fn(), on: vi.fn(), getPath: () => '', getAppMetrics: () => [] },
  crashReporter: { start: vi.fn() },
}))

const { formatMainHeapSample, MAIN_HEAP_WARN_BYTES } = await import('../crashMonitoring.js')

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
