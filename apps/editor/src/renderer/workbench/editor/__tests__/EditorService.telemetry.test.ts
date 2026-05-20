/*---------------------------------------------------------------------------------------------
 *  Tests for EditorService telemetry埋点
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { ITelemetryService } from '@universe-editor/platform'
import { EditorService } from '../EditorService.js'

function makeTelemetry(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    publicLog: vi.fn(),
    publicLogError: vi.fn(),
    publicLogMeasure: vi.fn(),
    getTelemetryInfo: vi.fn().mockResolvedValue({ sessionId: 'test', machineId: 'test' }),
  }
}

describe('EditorService telemetry', () => {
  it('logs editorOpened event when opening an editor', () => {
    const telemetry = makeTelemetry()
    const svc = new EditorService(undefined, telemetry)

    svc.openEditor({ id: 'test-1', type: 'file', label: 'test.ts', isDirty: false })

    expect(telemetry.publicLog).toHaveBeenCalledOnce()
    expect(telemetry.publicLog).toHaveBeenCalledWith('editorOpened', { typeId: 'file' })
  })
})
