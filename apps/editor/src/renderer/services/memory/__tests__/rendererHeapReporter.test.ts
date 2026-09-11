/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { collectHeapHolders, createRendererHeapReporter } from '../rendererHeapReporter.js'
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
