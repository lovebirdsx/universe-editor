/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { NoopTelemetryService } from '@universe-editor/platform'
import {
  MEMORY_SAMPLE_INTERVAL_MS,
  MEMORY_SAMPLE_INTERVAL_PRESSURED_MS,
  MemoryPressureService,
  type MemoryPressureServiceOptions,
} from '../memoryPressureService.js'
import { MemoryPressureLevel } from '../memoryPressureLevels.js'
import type { MemorySample } from '../memoryPressureLevels.js'
import { StubLoggerService } from '../../../__tests__/_helpers/stubLoggerService.js'

const GIB = 1024 * 1024 * 1024

/** A sampler the test drives by hand, plus the timer queue it schedules onto. */
function harness(hooks: Pick<MemoryPressureServiceOptions, 'reportSample' | 'now'> = {}) {
  let sample: MemorySample | undefined = { used: 0, limit: 4 * GIB }
  const timers: { run: () => void; ms: number }[] = []
  const options: MemoryPressureServiceOptions = {
    readSample: () => sample,
    setTimer: (run, ms) => {
      const handle = { run, ms }
      timers.push(handle)
      return handle
    },
    clearTimer: (handle) => {
      const idx = timers.indexOf(handle as { run: () => void; ms: number })
      if (idx !== -1) timers.splice(idx, 1)
    },
    // Spread conditionally, not defaulted: the no-reporter path is a supported
    // configuration (tests, embedders without a diagnostics channel) and the tests
    // that predate reporting have to keep exercising it.
    ...(hooks.reportSample ? { reportSample: hooks.reportSample } : {}),
    ...(hooks.now ? { now: hooks.now } : {}),
  }
  const service = new MemoryPressureService(
    new StubLoggerService(),
    new NoopTelemetryService(),
    options,
  )
  return {
    service,
    timers,
    setUsed: (used: number) => {
      sample = { used, limit: 4 * GIB }
    },
    loseSample: () => {
      sample = undefined
    },
    /** Fire the pending timer, running whatever the service scheduled next. */
    tick: () => {
      const next = timers.shift()
      next?.run()
      return next?.ms
    },
  }
}

describe('MemoryPressureService — sampling', () => {
  it('starts normal and reports nothing until a line is crossed', () => {
    const { service, setUsed } = harness()
    setUsed(1 * GIB)
    expect(service.sample()).toBe(MemoryPressureLevel.Normal)
    expect(service.isConstrained()).toBe(false)
    service.dispose()
  })

  it('escalates through elevated to critical as the heap grows', () => {
    const { service, setUsed } = harness()
    const seen: MemoryPressureLevel[] = []
    service.onDidChangeLevel((l) => seen.push(l))

    setUsed(2 * GIB)
    service.sample()
    setUsed(3 * GIB)
    service.sample()

    expect(seen).toEqual([MemoryPressureLevel.Elevated, MemoryPressureLevel.Critical])
    service.dispose()
  })

  it('stays put when the sample cannot be read', () => {
    // A blind process that reported `normal` would look calm while holding gigabytes.
    const { service, setUsed, loseSample } = harness()
    setUsed(3 * GIB)
    service.sample()
    loseSample()
    expect(service.sample()).toBe(MemoryPressureLevel.Critical)
    service.dispose()
  })

  it('releases on the way up but not on the way down', () => {
    const { service, setUsed } = harness()
    const release = vi.spyOn(service, 'release')

    setUsed(3 * GIB)
    service.sample()
    expect(release).toHaveBeenCalledWith(MemoryPressureLevel.Critical)

    release.mockClear()
    setUsed(1 * GIB)
    service.sample()
    // Relieving must not trigger another release — only the rise costs content.
    expect(release).not.toHaveBeenCalled()
    service.dispose()
  })
})

describe('MemoryPressureService — releasers', () => {
  it('runs releasers lowest priority first and totals what they freed', () => {
    const { service, setUsed } = harness()
    const order: string[] = []
    service.registerReleaser({ id: 'late', priority: 10, release: () => (order.push('late'), 1) })
    service.registerReleaser({ id: 'early', priority: -5, release: () => (order.push('early'), 2) })
    service.registerReleaser({ id: 'middle', release: () => (order.push('middle'), 4) })

    setUsed(3 * GIB)
    service.sample()

    expect(order).toEqual(['early', 'middle', 'late'])
    service.dispose()
  })

  it('keeps going when a releaser throws, and names the failure', () => {
    const { service, setUsed } = harness()
    service.registerReleaser({
      id: 'broken',
      priority: -1,
      release: () => {
        throw new Error('cache exploded')
      },
    })
    const after = vi.fn(() => 7)
    service.registerReleaser({ id: 'after', release: after })

    setUsed(3 * GIB)
    const reports = service.release(MemoryPressureLevel.Critical)

    expect(after).toHaveBeenCalled()
    expect(reports).toEqual([
      { id: 'broken', freed: 0, error: 'cache exploded' },
      { id: 'after', freed: 7 },
    ])
    service.dispose()
  })

  it('omits releasers that freed nothing from the report', () => {
    const { service } = harness()
    service.registerReleaser({ id: 'idle', release: () => 0 })
    expect(service.release(MemoryPressureLevel.Elevated)).toEqual([])
    service.dispose()
  })

  it('stops running a releaser once its handle is disposed', () => {
    const { service } = harness()
    const release = vi.fn(() => 3)
    const handle = service.registerReleaser({ id: 'cache', release })
    handle.dispose()
    service.release(MemoryPressureLevel.Elevated)
    expect(release).not.toHaveBeenCalled()
    service.dispose()
  })

  it('does not re-enter itself when a releaser pushes an observable update', () => {
    const { service } = harness()
    let reentered: unknown
    service.registerReleaser({
      id: 'recursive',
      release: () => {
        reentered = service.release(MemoryPressureLevel.Elevated)
        return 5
      },
    })
    expect(service.release(MemoryPressureLevel.Critical)).toEqual([{ id: 'recursive', freed: 5 }])
    expect(reentered).toEqual([])
    service.dispose()
  })
})

describe('MemoryPressureService — cadence', () => {
  it('samples at the slow interval and tightens once constrained', () => {
    const { service, timers, setUsed } = harness()
    service.start()
    expect(timers[0]?.ms).toBe(MEMORY_SAMPLE_INTERVAL_MS)

    setUsed(3 * GIB)
    timers[0]?.run()
    // The ramp is what matters: sampling has to speed up while the heap climbs.
    expect(timers.at(-1)?.ms).toBe(MEMORY_SAMPLE_INTERVAL_PRESSURED_MS)
    service.dispose()
  })

  it('stops rescheduling after stop()', () => {
    const { service, timers } = harness()
    service.start()
    service.stop()
    expect(timers).toHaveLength(0)
    service.dispose()
  })

  it('survives a listener that throws', () => {
    const { service, setUsed } = harness()
    service.onDidChangeLevel(() => {
      throw new Error('subscriber blew up')
    })
    setUsed(3 * GIB)
    expect(() => service.sample()).not.toThrow()
    service.dispose()
  })
})

describe('MemoryPressureService — describe', () => {
  it('names the level, the heap and the thresholds', () => {
    const { service, setUsed } = harness()
    setUsed(3 * GIB)
    service.sample()
    const text = service.describe()
    expect(text).toContain('critical')
    expect(text).toContain('used=3072MB')
    expect(text).toContain('limit=4096MB')
    expect(text).toContain('releasers=0')
    service.dispose()
  })
})

describe('MemoryPressureService — heap reporting', () => {
  /** A clock the test advances by hand; `start` is far from 0 so the throttle is visible. */
  function clock(start = 1_000_000) {
    let at = start
    return {
      now: () => at,
      advance: (ms: number) => {
        at += ms
      },
    }
  }

  it('pushes the first reading without waiting for the throttle', () => {
    // A crash two minutes after launch is exactly what a 30s-throttled curve would
    // otherwise miss entirely — hence `_reportedAt` starting at 0, not `Date.now()`.
    const seen: { used: number; level: MemoryPressureLevel }[] = []
    const { service, setUsed } = harness({
      reportSample: (sample, level) => seen.push({ used: sample.used, level }),
    })
    setUsed(1 * GIB)
    service.sample()
    expect(seen).toEqual([{ used: 1 * GIB, level: MemoryPressureLevel.Normal }])
    service.dispose()
  })

  it('reports readings where the level did not change', () => {
    // The curve is the point. A heap that grew 700MB without crossing a line is the flat
    // stretch the crash packages showed before the ramp — invisible under a
    // transitions-only scheme.
    const seen: number[] = []
    const time = clock()
    const { service, setUsed } = harness({
      reportSample: (sample) => seen.push(sample.used),
      now: time.now,
    })
    setUsed(1 * GIB)
    service.sample()
    time.advance(31_000)
    setUsed(1.7 * GIB)
    expect(service.sample()).toBe(MemoryPressureLevel.Normal)
    expect(seen).toEqual([1 * GIB, 1.7 * GIB])
    service.dispose()
  })

  it('throttles to the slow interval while normal and tightens under pressure', () => {
    const seen: MemoryPressureLevel[] = []
    const time = clock()
    const { service, setUsed } = harness({
      reportSample: (_sample, level) => seen.push(level),
      now: time.now,
    })

    setUsed(1 * GIB)
    service.sample()
    time.advance(29_000)
    service.sample()
    expect(seen).toHaveLength(1)

    time.advance(2_000)
    service.sample()
    expect(seen).toHaveLength(2)

    // Critical from here on: the same ring of samples has to cover the last few minutes
    // densely rather than the last half hour sparsely.
    setUsed(3 * GIB)
    service.sample()
    time.advance(5_000)
    service.sample()
    time.advance(5_000)
    service.sample()
    expect(seen).toEqual([
      MemoryPressureLevel.Normal,
      MemoryPressureLevel.Normal,
      MemoryPressureLevel.Critical,
      MemoryPressureLevel.Critical,
    ])
    service.dispose()
  })

  it('stamps the reading before the releasers run', () => {
    // The reading worth having describes the heap as it was when it went bad; taken
    // after `release()` it would record the state the release created.
    const order: string[] = []
    const time = clock()
    const { service, setUsed } = harness({
      reportSample: () => order.push('report'),
      now: time.now,
    })
    service.registerReleaser({ id: 'cache', release: () => (order.push('release'), 0) })

    setUsed(3 * GIB)
    service.sample()
    expect(order).toEqual(['report', 'release'])
    service.dispose()
  })

  it('survives a reporter that throws', () => {
    const { service, setUsed } = harness({
      reportSample: () => {
        throw new Error('channel exploded')
      },
    })
    setUsed(3 * GIB)
    expect(() => service.sample()).not.toThrow()
    expect(service.isConstrained()).toBe(true)
    service.dispose()
  })

  it('keeps reporting after a reporter threw', () => {
    // The throttle is stamped before the report runs, so a throwing reporter cannot
    // wedge it — if it were stamped after, the first failure would silence the curve
    // for the rest of the process's life.
    const time = clock()
    const calls = vi.fn(() => {
      throw new Error('channel exploded')
    })
    const { service, setUsed } = harness({ reportSample: calls, now: time.now })
    setUsed(1 * GIB)
    service.sample()
    time.advance(31_000)
    service.sample()
    expect(calls).toHaveBeenCalledTimes(2)
    service.dispose()
  })
})
