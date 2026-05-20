/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/telemetry/noopTelemetryService.ts — TelemetrySinkRegistry
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { TelemetrySinkRegistry } from '../../telemetry/noopTelemetryService.js'
import type { ITelemetrySink } from '../../telemetry/telemetryService.js'

function makeSink(): ITelemetrySink {
  return {
    log: vi.fn(),
    logError: vi.fn(),
    logMeasure: vi.fn(),
  }
}

describe('TelemetrySinkRegistry', () => {
  it('registerSink stores the sink', () => {
    const reg = new TelemetrySinkRegistry()
    const sink = makeSink()
    reg.registerSink(sink)
    expect(reg.getSinks()).toContain(sink)
  })

  it('getSinks returns all registered sinks', () => {
    const reg = new TelemetrySinkRegistry()
    const a = makeSink()
    const b = makeSink()
    reg.registerSink(a)
    reg.registerSink(b)
    const sinks = reg.getSinks()
    expect(sinks).toHaveLength(2)
    expect(sinks).toContain(a)
    expect(sinks).toContain(b)
  })

  it('multiple registerSink calls accumulate without overwriting', () => {
    const reg = new TelemetrySinkRegistry()
    for (let i = 0; i < 5; i++) {
      reg.registerSink(makeSink())
    }
    expect(reg.getSinks()).toHaveLength(5)
  })
})
