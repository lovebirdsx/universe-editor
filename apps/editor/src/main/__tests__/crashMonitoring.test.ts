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

/** Same row, with the Windows-only private-bytes counter Electron also reports. */
function tabMetricWithPrivate(pid: number, mb: number, privateMb: number): unknown {
  return {
    pid,
    type: 'Tab',
    memory: { workingSetSize: mb * 1024, privateBytes: privateMb * 1024 },
    cpu: { percentCPUUsage: 1 },
  }
}

const {
  formatAppMetricsLine,
  formatMainHeapSample,
  MAIN_HEAP_WARN_BYTES,
  MAIN_HEAP_BUSY_BYTES,
  TAB_WORKING_SET_WARN_BYTES,
  HOSTED_PROCESS_WARN_BYTES,
  PROCESS_METRICS_NORMAL_INTERVAL_MS,
  PROCESS_METRICS_BUSY_INTERVAL_MS,
  processMetricsIntervalMs,
  installProcessMetricsLogging,
} = await import('../crashMonitoring.js')
const { formatSystemMemoryLine } = await import('../services/diagnostics/systemMemorySampler.js')
const { parseExitScene } = await import('../exitSceneForensics.js')
type ProcessItem = import('../services/processMonitor/processList.js').ProcessItem
type SystemMemorySample =
  import('../services/diagnostics/systemMemorySampler.js').SystemMemorySample

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

describe('formatAppMetricsLine', () => {
  it('keeps mem= as the working set and appends private bytes in MB', () => {
    // workingSetSize/privateBytes come from Electron in KB and are converted here, where
    // the unit is known — a reader that divided again would report a 1024x smaller app.
    const line = formatAppMetricsLine([tabMetricWithPrivate(1234, 722, 4096) as never])
    expect(line).toBe('pid=1234 type=Tab mem=722MB cpu=1% privateBytes=4096MB')
  })

  it('omits private bytes where the platform does not report them', () => {
    const line = formatAppMetricsLine([tabMetric(7, 100) as never])
    expect(line).toBe('pid=7 type=Tab mem=100MB cpu=1%')
    expect(line).not.toContain('privateBytes')
  })

  it('stays readable by the forensics parser that reads these lines back', () => {
    // The extra field is only safe after cpu=, where APP_METRICS_RE stops: a number
    // moved in front of mem= would swallow the working set into `type`.
    const line = formatAppMetricsLine([
      tabMetricWithPrivate(1929756, 722, 4096) as never,
      tabMetric(99, 2100) as never,
    ])
    const scene = parseExitScene(`[12:00:00] [info] ${line}`, { sessionStartMs: 0 })
    expect(scene.sampleCount).toBe(1)
    expect(scene.renderers.map((p) => [p.pid, p.peakMB, p.type])).toEqual([
      [99, 2100, 'Tab'],
      [1929756, 722, 'Tab'],
    ])
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

  it('TAB_WORKING_SET_WARN_BYTES is 2GB — below the observed peak, with room to react', () => {
    expect(TAB_WORKING_SET_WARN_BYTES).toBe(2 * 1024 * 1024 * 1024)
  })

  it('logs the system commit reading from the sampler cache, without querying itself', async () => {
    const lines: string[] = []
    const sample: SystemMemorySample = {
      status: 'ok',
      at: 0,
      ageMs: 0,
      commit: {
        committedBytes: 12 * 1024 * 1024 * 1024,
        commitLimitBytes: 16 * 1024 * 1024 * 1024,
        commitHeadroomBytes: 4 * 1024 * 1024 * 1024,
      },
      availablePhysicalBytes: 2 * 1024 * 1024 * 1024,
      totalPhysicalBytes: 32 * 1024 * 1024 * 1024,
    }
    appMetrics.current = [tabMetric(1, 100)]
    const disposable = installProcessMetricsLogging(
      { createLogger: () => ({ info: (l: string) => lines.push(l), warn: () => {} }) as never },
      { readSystemMemory: () => sample },
    )
    try {
      expect(lines).toContain(formatSystemMemoryLine(sample))
      expect(lines.some((l) => l.startsWith('system-memory status=ok'))).toBe(true)
      // Read synchronously from the cache: the first sample must not wait on a query.
      expect(lines.some((l) => l.includes('commitHeadroom=4096MB'))).toBe(true)
    } finally {
      disposable.dispose()
      appMetrics.current = []
    }
  })

  it('keeps sampling when no system reading is available', () => {
    const { info } = sampleOnce([tabMetric(1, 100)])
    expect(info.some((l) => l.startsWith('system-memory'))).toBe(false)
    expect(info.some((l) => l.startsWith('main-heap '))).toBe(true)
  })

  describe('hosted process tree', () => {
    const node = (
      name: string,
      pid: number,
      mb: number,
      children?: ProcessItem[],
    ): ProcessItem => ({
      name,
      cmd: name,
      pid,
      ppid: 0,
      load: 1,
      mem: mb * 1024 * 1024,
      ...(children ? { children } : {}),
    })

    function installWithTree(root: ProcessItem, lines: string[]): { dispose: () => void } {
      return installProcessMetricsLogging(
        {
          createLogger: () =>
            ({
              info: (line: string) => lines.push(line),
              warn: (line: string) => lines.push(line),
            }) as never,
        },
        { listProcessTree: async () => root },
      )
    }

    it('logs the tree, because app metrics cannot see spawned Node children', async () => {
      // The shipped crash had a 3.71GB extension host that never appeared on the
      // memory curve: it is child_process.spawn'ed, so getAppMetrics() omits it.
      const lines: string[] = []
      const disposable = installWithTree(
        node('main', process.pid, 200, [node('extension-host', 77, 3800)]),
        lines,
      )
      try {
        await vi.waitFor(() => {
          expect(lines.some((l) => l.startsWith('hosted-processes'))).toBe(true)
        })
        expect(lines.some((l) => l.includes('extension-host#77=3800MB'))).toBe(true)
        expect(lines.some((l) => l.includes('cnt=2'))).toBe(true)
      } finally {
        disposable.dispose()
      }
    })

    it('warns on a heavy hosted process but not on the main process itself', async () => {
      const lines: string[] = []
      // Main's RSS is large in absolute terms but is already covered by the
      // main-heap line; flagging it here would fire the warning on every launch.
      const disposable = installWithTree(
        node('main', process.pid, 3000, [
          node('acp-agent', 99, HOSTED_PROCESS_WARN_BYTES / 1024 / 1024 + 1),
        ]),
        lines,
      )
      try {
        await vi.waitFor(() => {
          expect(lines.some((l) => l.includes('— above'))).toBe(true)
        })
        const warn = lines.find((l) => l.includes('— above'))!
        const flagged = warn.slice(warn.indexOf('— above'))
        expect(flagged).toContain('acp-agent#99')
        expect(flagged).not.toContain('main#')
      } finally {
        disposable.dispose()
      }
    })

    it('never touches the process tree when no source is injected', async () => {
      const lines: string[] = []
      const disposable = installProcessMetricsLogging({
        createLogger: () =>
          ({
            info: (line: string) => lines.push(line),
            warn: (line: string) => lines.push(line),
          }) as never,
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(lines.some((l) => l.startsWith('hosted-processes'))).toBe(false)
      } finally {
        disposable.dispose()
      }
    })

    it('survives a failing walk — it is observing, not participating', async () => {
      const lines: string[] = []
      const disposable = installProcessMetricsLogging(
        {
          createLogger: () =>
            ({
              info: (line: string) => lines.push(line),
              warn: (line: string) => lines.push(line),
            }) as never,
        },
        {
          listProcessTree: () => Promise.reject(new Error('tasklist unavailable')),
        },
      )
      try {
        await new Promise((resolve) => setTimeout(resolve, 0))
        // The sync app-metrics sample still ran; the walk's failure added no line
        // and, more importantly, no unhandled rejection.
        expect(lines.some((l) => l.startsWith('main-heap '))).toBe(true)
        expect(lines.some((l) => l.startsWith('hosted-processes'))).toBe(false)
      } finally {
        disposable.dispose()
      }
    })
  })
})
