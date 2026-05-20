/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/telemetry/noopTelemetryService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { NoopTelemetryService } from '../../telemetry/noopTelemetryService.js'

describe('NoopTelemetryService', () => {
  it('publicLog does not throw', () => {
    const svc = new NoopTelemetryService()
    expect(() => svc.publicLog('test', { key: 'value' })).not.toThrow()
  })

  it('publicLogError does not throw', () => {
    const svc = new NoopTelemetryService()
    expect(() => svc.publicLogError('error', { stack: 'at ...' })).not.toThrow()
  })

  it('publicLogMeasure does not throw', () => {
    const svc = new NoopTelemetryService()
    expect(() => svc.publicLogMeasure('metric', 42, { dim: 'x' })).not.toThrow()
  })

  it('getTelemetryInfo returns a valid UUID sessionId and noop machineId', async () => {
    const svc = new NoopTelemetryService()
    const info = await svc.getTelemetryInfo()
    expect(info.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(info.machineId).toBe('noop')
  })
})
