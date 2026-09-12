/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectHeapHolders, createRendererHeapReporter } from '../rendererHeapReporter.js'
import { bumpHeapFlow, drainHeapFlow, setHeapGauge } from '../heapFlowCounters.js'
import { MemoryPressureLevel } from '../memoryPressureLevels.js'
import type {
  IDiagnosticsService,
  WireRendererHeapSample,
} from '../../../../shared/ipc/services.js'

const MIB = 1024 * 1024
const SAMPLE = { used: 3200 * MIB, limit: 4096 * MIB }

function diagnostics(
  report: (sample: WireRendererHeapSample) => Promise<void>,
): IDiagnosticsService {
  return {
    _serviceBrand: undefined,
    consumeAbnormalExitReport: () => Promise.resolve(null),
    revealCrashesFolder: () => Promise.resolve(),
    collectIssueReport: () => Promise.resolve(''),
    exportDiagnosticsZip: () => Promise.resolve(''),
    createDiagnosticsZip: () => Promise.resolve(''),
    reportRendererHeapSample: report,
  }
}

describe('collectHeapHolders', () => {
  it('keeps only the holders that are actually holding something', () => {
    expect(
      collectHeapHolders([
        { name: 'acp', measure: () => ({ bytes: 412 * MIB, count: 2 }) },
        { name: 'monaco', measure: () => undefined },
        { name: 'empty', measure: () => ({ bytes: 0 }) },
        { name: 'broken', measure: () => ({ bytes: Number.NaN }) },
      ]),
    ).toEqual([{ name: 'acp', bytes: 412 * MIB, count: 2 }])
  })

  it('pays no attention to a holder that cannot be measured', () => {
    // The heap reading itself is the part that cannot be recovered later; an
    // attribution that throws must not cost it.
    expect(() =>
      collectHeapHolders([
        {
          name: 'broken',
          measure: () => {
            throw new Error('model disposed')
          },
        },
      ]),
    ).not.toThrow()
    expect(
      collectHeapHolders([
        {
          name: 'broken',
          measure: () => {
            throw new Error('model disposed')
          },
        },
        { name: 'acp', measure: () => ({ bytes: 5 * MIB }) },
      ]),
    ).toEqual([{ name: 'acp', bytes: 5 * MIB }])
  })
})

describe('createRendererHeapReporter', () => {
  it('carries the level name and the holder breakdown with the watermark', () => {
    const seen: WireRendererHeapSample[] = []
    const report = createRendererHeapReporter(
      () => diagnostics((sample) => (seen.push(sample), Promise.resolve())),
      [{ name: 'acp', measure: () => ({ bytes: 412 * MIB, count: 2 }) }],
    )
    report(SAMPLE, MemoryPressureLevel.Critical)

    expect(seen).toEqual([
      {
        used: 3200 * MIB,
        limit: 4096 * MIB,
        level: 'critical',
        holders: [{ name: 'acp', bytes: 412 * MIB, count: 2 }],
      },
    ])
  })

  it('resolves the service per report rather than capturing it', () => {
    // The reporter is built with the sampler, which is before the proxy-channel
    // services exist; a captured undefined would silence every report forever.
    const getDiagnostics = vi.fn(() => diagnostics(() => Promise.resolve()))
    const report = createRendererHeapReporter(getDiagnostics, [])
    report(SAMPLE, MemoryPressureLevel.Normal)
    expect(getDiagnostics).toHaveBeenCalledTimes(1)
  })

  it('swallows a rejected report instead of disturbing the sampler', () => {
    const report = createRendererHeapReporter(
      () => diagnostics(() => Promise.reject(new Error('no channel'))),
      [],
    )
    expect(() => report(SAMPLE, MemoryPressureLevel.Normal)).not.toThrow()
  })

  it('says so once when the diagnostic service is not there', () => {
    // `services.get` answers `undefined` rather than throwing, so a missing service is a
    // property access on undefined — swallowed by the catch around it, and the only
    // trace would be a curve that silently never appears.
    const warn = vi.fn()
    const report = createRendererHeapReporter(
      () => undefined as unknown as IDiagnosticsService,
      [],
      { warn } as never,
    )
    report(SAMPLE, MemoryPressureLevel.Normal)
    report(SAMPLE, MemoryPressureLevel.Normal)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('heap report failed')
  })

  it('says so once when the report is rejected', async () => {
    const warn = vi.fn()
    const report = createRendererHeapReporter(
      () => diagnostics(() => Promise.reject(new Error('frame refused'))),
      [],
      { warn } as never,
    )
    report(SAMPLE, MemoryPressureLevel.Normal)
    await Promise.resolve()
    await Promise.resolve()
    report(SAMPLE, MemoryPressureLevel.Normal)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('frame refused')
  })

  it('stays quiet when the report lands', () => {
    const warn = vi.fn()
    const report = createRendererHeapReporter(() => diagnostics(() => Promise.resolve()), [], {
      warn,
    } as never)
    report(SAMPLE, MemoryPressureLevel.Normal)
    expect(warn).not.toHaveBeenCalled()
  })
})

// The counters are process-wide, so these cases clean up on both sides — the cases
// above assert the sample shape exactly, and a stray count would fail them.
describe('createRendererHeapReporter — flow and gauge', () => {
  const GAUGES = ['domnodes', 'astnodes', 'sealednodes', 'tailchars'] as const

  beforeEach(() => {
    drainHeapFlow()
  })

  afterEach(() => {
    drainHeapFlow()
    for (const name of GAUGES) setHeapGauge(name, 0)
  })

  it('carries the work counted since the previous reading', () => {
    const seen: WireRendererHeapSample[] = []
    const report = createRendererHeapReporter(
      () => diagnostics((sample) => (seen.push(sample), Promise.resolve())),
      [],
    )
    bumpHeapFlow('mdparse', 2048)
    bumpHeapFlow('colorize.skip', 512)
    report(SAMPLE, MemoryPressureLevel.Normal)

    expect(seen[0]?.flow).toEqual([
      { name: 'mdparse', calls: 1, chars: 2048 },
      { name: 'colorize.skip', calls: 1, chars: 512 },
    ])
  })

  it('omits both fields entirely when nothing was counted or measured', () => {
    const seen: WireRendererHeapSample[] = []
    const report = createRendererHeapReporter(
      () => diagnostics((sample) => (seen.push(sample), Promise.resolve())),
      [],
    )
    report(SAMPLE, MemoryPressureLevel.Normal)

    expect(seen[0]).not.toHaveProperty('flow')
    expect(seen[0]).not.toHaveProperty('gauge')
  })

  it('drains on report so each reading describes its own interval', () => {
    const seen: WireRendererHeapSample[] = []
    const report = createRendererHeapReporter(
      () => diagnostics((sample) => (seen.push(sample), Promise.resolve())),
      [],
    )
    bumpHeapFlow('mdparse', 10)
    report(SAMPLE, MemoryPressureLevel.Normal)
    report(SAMPLE, MemoryPressureLevel.Normal)

    expect(seen[0]).toHaveProperty('flow')
    expect(seen[1]).not.toHaveProperty('flow')
  })

  it('refreshes the gauges before reading them', () => {
    const seen: WireRendererHeapSample[] = []
    const report = createRendererHeapReporter(
      () => diagnostics((sample) => (seen.push(sample), Promise.resolve())),
      [],
      undefined,
      () => setHeapGauge('domnodes', 92_000),
    )
    report(SAMPLE, MemoryPressureLevel.Normal)

    expect(seen[0]?.gauge).toEqual([{ name: 'domnodes', value: 92_000 }])
  })

  it('still reports the heap when a gauge cannot be taken', () => {
    // The reading is the part that cannot be recovered after a crash; a DOM walk that
    // throws must not take it down with it.
    const seen: WireRendererHeapSample[] = []
    const report = createRendererHeapReporter(
      () => diagnostics((sample) => (seen.push(sample), Promise.resolve())),
      [],
      undefined,
      () => {
        throw new Error('document gone')
      },
    )

    expect(() => report(SAMPLE, MemoryPressureLevel.Normal)).not.toThrow()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.used).toBe(3200 * MIB)
  })
})
