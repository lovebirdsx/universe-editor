/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/diagnostics/systemMemorySampler.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ILogger } from '@universe-editor/platform'
import {
  COMMIT_QUERY_TIMEOUT_MS,
  COMMIT_READING_FRESH_MS,
  SYSTEM_MEMORY_INTERVAL_MS,
  SYSTEM_MEMORY_MAX_BACKOFF_MS,
  SystemMemorySampler,
  WINDOWS_COMMIT_QUERY,
  disposeSharedSystemMemorySampler,
  formatSystemMemoryLine,
  getSharedSystemMemorySampler,
  parseWindowsCommitOutput,
  setSharedSystemMemorySampler,
  systemMemoryBackoffMs,
  type CommitQueryOptions,
} from '../systemMemorySampler.js'

const MiB = 1024 * 1024

function winPayload(committed: number, limit: number, available: number): string {
  return JSON.stringify({
    CommittedBytes: committed,
    CommitLimit: limit,
    AvailableBytes: available,
  })
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(err: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface RecordedLogger {
  readonly logger: ILogger
  readonly warns: string[]
  readonly infos: string[]
}

function recordingLogger(): RecordedLogger {
  const warns: string[] = []
  const infos: string[] = []
  const logger = {
    level: 3,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
    setLevel: () => undefined,
    trace: () => undefined,
    debug: () => undefined,
    info: (message: string) => infos.push(message),
    warn: (message: string) => warns.push(message),
    error: () => undefined,
    flush: () => undefined,
    dispose: () => undefined,
  } as unknown as ILogger
  return { logger, warns, infos }
}

/** A query runner whose every call is recorded and settled by the test. */
function scriptedQuery(): {
  readonly calls: CommitQueryOptions[]
  readonly pending: Deferred<string>[]
  readonly run: (options: CommitQueryOptions) => Promise<string>
} {
  const calls: CommitQueryOptions[] = []
  const pending: Deferred<string>[] = []
  return {
    calls,
    pending,
    run: (options) => {
      calls.push(options)
      const flight = deferred<string>()
      pending.push(flight)
      return flight.promise
    },
  }
}

function physical(freeBytes = 4 * 1024 * 1024 * 1024, totalBytes = 16 * 1024 * 1024 * 1024) {
  return () => ({ freeBytes, totalBytes })
}

/**
 * 尝试体是在微任务里跑的（占位同步盖下、执行延后，否则同步完成路径的 finally 会先于占位
 * 赋值跑掉）。断言「查询已经起了」之前，先让它跑起来。
 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseWindowsCommitOutput', () => {
  it('reads committed/limit and derives the headroom the snapshot gate needs', () => {
    const parsed = parseWindowsCommitOutput(
      winPayload(12 * 1024 * MiB, 20 * 1024 * MiB, 3 * 1024 * MiB),
    )
    expect(parsed?.commit).toEqual({
      committedBytes: 12 * 1024 * MiB,
      commitLimitBytes: 20 * 1024 * MiB,
      commitHeadroomBytes: 8 * 1024 * MiB,
    })
  })

  it('keeps AvailableBytes as physical memory and never as commit headroom', () => {
    // The two are independent: 512MB free physical says nothing about commit, and a
    // gate that read the physical number as headroom would refuse a snapshot the
    // machine could easily back.
    const parsed = parseWindowsCommitOutput(winPayload(1024 * MiB, 20 * 1024 * MiB, 512 * MiB))
    expect(parsed?.availablePhysicalBytes).toBe(512 * MiB)
    expect(parsed?.commit.commitHeadroomBytes).toBe(19 * 1024 * MiB)
  })

  it('tolerates the array form and string-encoded 64-bit counters', () => {
    const parsed = parseWindowsCommitOutput(
      JSON.stringify([
        {
          CommittedBytes: `${9 * 1024 * MiB}`,
          CommitLimit: 16 * 1024 * MiB,
          AvailableBytes: '2048',
        },
      ]),
    )
    expect(parsed?.commit.committedBytes).toBe(9 * 1024 * MiB)
    expect(parsed?.availablePhysicalBytes).toBe(2048)
  })

  it('clamps a negative headroom to zero instead of rejecting the reading', () => {
    // Commit at the limit (page file could not be grown) is a real state, and "no
    // headroom left" is exactly what the gate has to hear.
    const parsed = parseWindowsCommitOutput(winPayload(20 * 1024 * MiB, 20 * 1024 * MiB, 1024))
    expect(parsed?.commit.commitHeadroomBytes).toBe(0)
  })

  it('rejects non-JSON, empty output and a payload without the two commit fields', () => {
    expect(parseWindowsCommitOutput('')).toBeUndefined()
    expect(parseWindowsCommitOutput('   ')).toBeUndefined()
    expect(parseWindowsCommitOutput('Get-CimInstance : not recognized\n')).toBeUndefined()
    expect(parseWindowsCommitOutput(JSON.stringify({ CommitLimit: 1 }))).toBeUndefined()
    expect(parseWindowsCommitOutput(JSON.stringify({ CommittedBytes: 1 }))).toBeUndefined()
    expect(parseWindowsCommitOutput('null')).toBeUndefined()
    expect(parseWindowsCommitOutput('42')).toBeUndefined()
  })

  it('rejects illegal and out-of-range values rather than clamping them into evidence', () => {
    expect(parseWindowsCommitOutput(winPayload(-1, 1024, 1024))).toBeUndefined()
    expect(parseWindowsCommitOutput(winPayload(1.5, 1024, 1024))).toBeUndefined()
    expect(parseWindowsCommitOutput(winPayload(Number.NaN, 1024, 1024))).toBeUndefined()
    // Beyond Number.MAX_SAFE_INTEGER the byte count is no longer exact — a wrong
    // number is worse than an admitted unknown.
    expect(
      parseWindowsCommitOutput(JSON.stringify({ CommittedBytes: 2 ** 63, CommitLimit: 2 ** 64 })),
    ).toBeUndefined()
    expect(
      parseWindowsCommitOutput(JSON.stringify({ CommittedBytes: '', CommitLimit: 1024 })),
    ).toBeUndefined()
    expect(
      parseWindowsCommitOutput(JSON.stringify({ CommittedBytes: null, CommitLimit: 1024 })),
    ).toBeUndefined()
  })

  it('omits the physical reading when AvailableBytes is absent or illegal', () => {
    const partial = parseWindowsCommitOutput(
      JSON.stringify({ CommittedBytes: 1024, CommitLimit: 2048 }),
    )
    expect(partial?.commit.committedBytes).toBe(1024)
    expect(partial?.availablePhysicalBytes).toBeUndefined()
  })
})

describe('systemMemoryBackoffMs', () => {
  it('uses the normal interval while queries succeed', () => {
    expect(systemMemoryBackoffMs(0)).toBe(SYSTEM_MEMORY_INTERVAL_MS)
    expect(SYSTEM_MEMORY_INTERVAL_MS).toBe(60_000)
  })

  it('doubles per consecutive failure and stops at ten minutes', () => {
    expect(systemMemoryBackoffMs(1)).toBe(120_000)
    expect(systemMemoryBackoffMs(2)).toBe(240_000)
    expect(systemMemoryBackoffMs(3)).toBe(480_000)
    expect(systemMemoryBackoffMs(4)).toBe(SYSTEM_MEMORY_MAX_BACKOFF_MS)
    expect(systemMemoryBackoffMs(40)).toBe(SYSTEM_MEMORY_MAX_BACKOFF_MS)
    expect(SYSTEM_MEMORY_MAX_BACKOFF_MS).toBe(10 * 60_000)
  })
})

describe('WINDOWS_COMMIT_QUERY', () => {
  it('is a fixed CIM query for the three fields, with no shell and no policy change', () => {
    expect(WINDOWS_COMMIT_QUERY).toContain('Win32_PerfFormattedData_PerfOS_Memory')
    for (const field of ['CommittedBytes', 'CommitLimit', 'AvailableBytes']) {
      expect(WINDOWS_COMMIT_QUERY).toContain(field)
    }
    expect(WINDOWS_COMMIT_QUERY).not.toContain('ExecutionPolicy')
    expect(WINDOWS_COMMIT_QUERY).not.toContain('cmd.exe')
  })
})

describe('SystemMemorySampler', () => {
  it('does not block the caller: start() returns with the query still in flight', async () => {
    const query = scriptedQuery()
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await settle()
      expect(query.calls).toHaveLength(1)
      // Nothing has resolved yet, and the status says so instead of inventing a number.
      const sample = sampler.latest()
      expect(sample.status).toBe('unknown')
      expect(sample.commit).toBeUndefined()
    } finally {
      sampler.dispose()
    }
  })

  it('passes the hard timeout and an abort signal to every query', async () => {
    const query = scriptedQuery()
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await settle()
      expect(query.calls[0]?.timeoutMs).toBe(COMMIT_QUERY_TIMEOUT_MS)
      expect(COMMIT_QUERY_TIMEOUT_MS).toBe(5_000)
      expect(query.calls[0]?.signal.aborted).toBe(false)
    } finally {
      sampler.dispose()
    }
  })

  it('keeps one flight: a refresh request during a query does not spawn a second', async () => {
    const query = scriptedQuery()
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await settle()
      sampler.ensureFresh()
      sampler.ensureFresh()
      expect(query.calls).toHaveLength(1)
      query.pending[0]?.resolve(winPayload(1024, 2048, 512))
      await vi.waitFor(() => expect(sampler.latest().status).toBe('ok'))
      expect(query.calls).toHaveLength(1)
    } finally {
      sampler.dispose()
    }
  })

  it('reports ok inside the freshness window and stale past it, without spawning', async () => {
    const query = scriptedQuery()
    let now = 1_000_000
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      now: () => now,
      query: query.run,
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await settle()
      query.pending[0]?.resolve(winPayload(10 * 1024 * MiB, 16 * 1024 * MiB, 2 * 1024 * MiB))
      await vi.waitFor(() => expect(sampler.latest().status).toBe('ok'))
      expect(sampler.latest().ageMs).toBe(0)
      expect(sampler.latest().commit?.commitHeadroomBytes).toBe(6 * 1024 * MiB)

      now += COMMIT_READING_FRESH_MS + 1
      const stale = sampler.latest()
      expect(stale.status).toBe('stale')
      expect(stale.ageMs).toBe(COMMIT_READING_FRESH_MS + 1)
      // The values are kept — a stale reading is a lead, not a blank — but the
      // status is what a caller has to gate on.
      expect(stale.commit?.committedBytes).toBe(10 * 1024 * MiB)
      expect(query.calls).toHaveLength(1)
    } finally {
      sampler.dispose()
    }
  })

  it('starts a query on ensureFresh once the reading is stale and the interval elapsed', async () => {
    const query = scriptedQuery()
    let now = 5_000_000
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      now: () => now,
      query: query.run,
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await settle()
      query.pending[0]?.resolve(winPayload(1024, 4096, 512))
      await vi.waitFor(() => expect(sampler.latest().status).toBe('ok'))

      now += COMMIT_READING_FRESH_MS + 1
      expect(sampler.ensureFresh().status).toBe('stale')
      await settle()
      expect(query.calls).toHaveLength(2)
    } finally {
      sampler.dispose()
    }
  })

  it('records a failure as unknown with a folded, single-line reason', async () => {
    const query = scriptedQuery()
    const { logger, warns } = recordingLogger()
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      logger,
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await settle()
      query.pending[0]?.reject(new Error('Command failed: powershell.exe\nETIMEDOUT | foo'))
      await vi.waitFor(() => expect(sampler.failures).toBe(1))
      const sample = sampler.latest()
      expect(sample.status).toBe('unknown')
      expect(sample.commit).toBeUndefined()
      expect(sample.detail).toContain('ETIMEDOUT')
      expect(sample.detail).not.toContain('\n')
      expect(warns).toHaveLength(1)
    } finally {
      sampler.dispose()
    }
  })

  it('folds repeats of the same reason and logs again only when it changes', async () => {
    const query = scriptedQuery()
    const { logger, warns, infos } = recordingLogger()
    let now = 0
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      now: () => now,
      query: query.run,
      logger,
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await settle()
      query.pending[0]?.reject(new Error('WMI unavailable'))
      await vi.waitFor(() => expect(sampler.failures).toBe(1))
      now += 1_000_000
      sampler.ensureFresh()
      await vi.waitFor(() => expect(query.calls).toHaveLength(2))
      query.pending[1]?.reject(new Error('WMI unavailable'))
      await vi.waitFor(() => expect(sampler.failures).toBe(2))
      expect(warns).toHaveLength(1)

      now += 1_000_000
      sampler.ensureFresh()
      await vi.waitFor(() => expect(query.calls).toHaveLength(3))
      query.pending[2]?.reject(new Error('Access denied'))
      await vi.waitFor(() => expect(sampler.failures).toBe(3))
      expect(warns).toHaveLength(2)
      expect(warns[1]).toContain('Access denied')

      now += 1_000_000
      sampler.ensureFresh()
      await vi.waitFor(() => expect(query.calls).toHaveLength(4))
      query.pending[3]?.resolve(winPayload(1024, 4096, 512))
      await vi.waitFor(() => expect(sampler.latest().status).toBe('ok'))
      expect(sampler.failures).toBe(0)
      expect(infos.some((line) => line.includes('recovered after 3 failures'))).toBe(true)
    } finally {
      sampler.dispose()
    }
  })

  it('holds off the next attempt for the backoff window after a failure', async () => {
    const query = scriptedQuery()
    let now = 0
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      now: () => now,
      query: query.run,
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await settle()
      query.pending[0]?.reject(new Error('WMI unavailable'))
      await vi.waitFor(() => expect(sampler.failures).toBe(1))

      // One minute later the flat cadence would fire; the backoff is twice that.
      now += SYSTEM_MEMORY_INTERVAL_MS
      sampler.ensureFresh()
      expect(query.calls).toHaveLength(1)

      now += SYSTEM_MEMORY_INTERVAL_MS + 1
      sampler.ensureFresh()
      await settle()
      expect(query.calls).toHaveLength(2)
    } finally {
      sampler.dispose()
    }
  })

  it('dispose kills the in-flight query and drops the reading that lands late', async () => {
    const query = scriptedQuery()
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      readPhysical: physical(),
    })
    sampler.start()
    await settle()
    const signal = query.calls[0]?.signal
    expect(signal?.aborted).toBe(false)
    sampler.dispose()
    expect(signal?.aborted).toBe(true)

    // Late arrival: the child was already abandoned, so its result must not become
    // the reading the next session reads out of the log.
    query.pending[0]?.resolve(winPayload(10 * 1024 * MiB, 16 * 1024 * MiB, 1024))
    await Promise.resolve()
    await Promise.resolve()
    expect(sampler.latest().status).toBe('unknown')
    expect(sampler.latest().commit).toBeUndefined()
  })

  it('stays stopped after dispose: start and ensureFresh spawn nothing', async () => {
    const query = scriptedQuery()
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      readPhysical: physical(),
    })
    sampler.start()
    await settle()
    sampler.dispose()
    sampler.start()
    sampler.ensureFresh()
    await settle()
    expect(query.calls).toHaveLength(1)
    expect(sampler.disposed).toBe(true)
  })

  it('spawns nothing when dispose lands before the deferred attempt runs', async () => {
    // 占位（`_inflight`）是同步盖下的，尝试体在微任务里跑：这两步之间 stop 掉，子进程
    // 一次都不该被起，而且占位符不能留在那里（留住 = 从此再不刷新）。
    const query = scriptedQuery()
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      readPhysical: physical(),
    })
    sampler.start()
    sampler.dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(query.calls).toEqual([])
  })

  it('records a query that throws synchronously instead of escaping as a rejection', async () => {
    // 坏掉的 runner（参数非法、execFile 直接抛）必须和「子进程失败」走同一条路：unknown +
    // 退避，而不是变成一个没人 catch 的 rejection。
    let now = 0
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      now: () => now,
      query: () => {
        throw new Error('synchronous spawn failure')
      },
      readPhysical: physical(),
    })
    try {
      sampler.start()
      await vi.waitFor(() => expect(sampler.failures).toBe(1))
      expect(sampler.latest().status).toBe('unknown')
      expect(sampler.latest().detail).toContain('synchronous spawn failure')

      // 退避窗口内不再重试；过了窗口才允许下一次（说明 finally 交还了占位符）。
      now += SYSTEM_MEMORY_INTERVAL_MS
      sampler.ensureFresh()
      expect(sampler.failures).toBe(1)
      now += SYSTEM_MEMORY_INTERVAL_MS + 1
      sampler.ensureFresh()
      await vi.waitFor(() => expect(sampler.failures).toBe(2))
    } finally {
      sampler.dispose()
    }
  })

  it('refreshes the physical reading on every cycle where commit accounting is absent', async () => {
    // 非 Windows 上这个读数是唯一的活跃指标；它缓存，但必须跟着周期刷新——同一台机器
    // 一分钟后的空闲内存可能完全是另一个数。
    let free = 8 * 1024 * MiB
    const sampler = new SystemMemorySampler({
      platform: 'darwin',
      intervalMs: 5,
      readPhysical: () => ({ freeBytes: free, totalBytes: 32 * 1024 * MiB }),
    })
    try {
      sampler.start()
      await vi.waitFor(() => expect(sampler.latest().availablePhysicalBytes).toBe(8 * 1024 * MiB))
      free = 6 * 1024 * MiB
      await vi.waitFor(() => expect(sampler.latest().availablePhysicalBytes).toBe(6 * 1024 * MiB))
      free = 5 * 1024 * MiB
      await vi.waitFor(() => expect(sampler.latest().availablePhysicalBytes).toBe(5 * 1024 * MiB))
      expect(sampler.latest().status).toBe('unsupported')
    } finally {
      sampler.dispose()
    }
  })

  it('marks non-Windows unsupported while still reporting physical memory', async () => {
    const query = scriptedQuery()
    const sampler = new SystemMemorySampler({
      platform: 'linux',
      query: query.run,
      readPhysical: physical(8 * 1024 * MiB, 32 * 1024 * MiB),
    })
    try {
      sampler.start()
      await vi.waitFor(() => expect(sampler.latest().totalPhysicalBytes).toBe(32 * 1024 * MiB))
      const sample = sampler.latest()
      expect(sample.status).toBe('unsupported')
      expect(sample.commit).toBeUndefined()
      expect(sample.availablePhysicalBytes).toBe(8 * 1024 * MiB)
      // Not supported is not an error: no query was spawned and nothing was logged.
      expect(query.calls).toHaveLength(0)
    } finally {
      sampler.dispose()
    }
  })

  it('survives a physical reader that throws', async () => {
    const query = scriptedQuery()
    const sampler = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      readPhysical: () => {
        throw new Error('os module unavailable')
      },
    })
    try {
      sampler.start()
      await settle()
      query.pending[0]?.resolve(winPayload(1024, 4096, 2 * 1024 * MiB))
      await vi.waitFor(() => expect(sampler.latest().status).toBe('ok'))
      // The commit numbers survive; only the physical context is missing.
      expect(sampler.latest().commit?.committedBytes).toBe(1024)
      expect(sampler.latest().availablePhysicalBytes).toBe(2 * 1024 * MiB)
    } finally {
      sampler.dispose()
    }
  })
})

describe('shared sampler', () => {
  afterEach(() => {
    // Never leave the module singleton filled: a later caller would get this file's
    // fake, or an empty slot would spawn a real query.
    setSharedSystemMemorySampler(undefined)
  })

  it('hands the same instance to every caller and starts it exactly once', async () => {
    const query = scriptedQuery()
    const injected = new SystemMemorySampler({
      platform: 'win32',
      query: query.run,
      readPhysical: physical(),
    })
    setSharedSystemMemorySampler(injected)

    expect(getSharedSystemMemorySampler()).toBe(injected)
    expect(getSharedSystemMemorySampler()).toBe(injected)
    await settle()
    expect(query.calls).toHaveLength(1)
  })

  it('disposes the instance it replaces, and the one it is cleared from', () => {
    const first = new SystemMemorySampler({ platform: 'linux', query: scriptedQuery().run })
    setSharedSystemMemorySampler(first)
    const second = new SystemMemorySampler({ platform: 'linux', query: scriptedQuery().run })
    setSharedSystemMemorySampler(second)
    expect(first.disposed).toBe(true)
    expect(getSharedSystemMemorySampler()).toBe(second)

    disposeSharedSystemMemorySampler()
    expect(second.disposed).toBe(true)
  })
})

describe('formatSystemMemoryLine', () => {
  const base = { at: 0, ageMs: 0 }

  it('prints commit, headroom and physical memory in one comparable line', () => {
    const line = formatSystemMemoryLine({
      ...base,
      status: 'ok',
      commit: {
        committedBytes: 12 * 1024 * MiB,
        commitLimitBytes: 20 * 1024 * MiB,
        commitHeadroomBytes: 8 * 1024 * MiB,
      },
      availablePhysicalBytes: 3 * 1024 * MiB,
      totalPhysicalBytes: 32 * 1024 * MiB,
    })
    expect(line).toBe(
      'system-memory status=ok committed=12288MB commitLimit=20480MB ' +
        'commitHeadroom=8192MB availablePhysical=3072MB totalPhysical=32768MB',
    )
  })

  it('names the age of a stale reading and keeps its values', () => {
    const line = formatSystemMemoryLine({
      at: 0,
      ageMs: 312_000,
      status: 'stale',
      commit: { committedBytes: 1024, commitLimitBytes: 2048, commitHeadroomBytes: 1024 },
    })
    expect(line).toContain('status=stale age=312s')
    expect(line).toContain('commitHeadroom=0MB')
  })

  it('prints unknown and unsupported with the reason instead of zeroes', () => {
    const unknown = formatSystemMemoryLine({
      ...base,
      status: 'unknown',
      detail: 'no reading yet',
    })
    expect(unknown).toBe('system-memory status=unknown detail=no reading yet')
    expect(unknown).not.toContain('committed=')

    const unsupported = formatSystemMemoryLine({
      ...base,
      status: 'unsupported',
      availablePhysicalBytes: 1024 * MiB,
      totalPhysicalBytes: 2048 * MiB,
      detail: 'commit accounting is Windows-only',
    })
    expect(unsupported).toContain('status=unsupported')
    expect(unsupported).toContain('availablePhysical=1024MB')
    expect(unsupported).not.toContain('commitHeadroom')
  })

  it('flattens a multi-line reason so it cannot forge a log line', () => {
    const line = formatSystemMemoryLine({
      ...base,
      status: 'unknown',
      detail: 'line one\n[12:00:00] [error] forged',
    })
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('line one [12:00:00] [error] forged')
  })
})
