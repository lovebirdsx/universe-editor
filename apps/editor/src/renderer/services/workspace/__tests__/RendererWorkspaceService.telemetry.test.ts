/*---------------------------------------------------------------------------------------------
 *  Tests for RendererWorkspaceService telemetry埋点
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { ITelemetryService, IWorkspaceServiceWire } from '@universe-editor/platform'
import { RendererWorkspaceService } from '../RendererWorkspaceService.js'

function makeTelemetry(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    publicLog: vi.fn(),
    publicLogError: vi.fn(),
    publicLogMeasure: vi.fn(),
    getTelemetryInfo: vi.fn().mockResolvedValue({ sessionId: 'test', machineId: 'test' }),
  }
}

function makeWire(): IWorkspaceServiceWire {
  return {
    _serviceBrand: undefined,
    onDidChangeWorkspace: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    onDidChangeRecent: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    getCurrent: vi.fn().mockResolvedValue(null),
    getRecent: vi.fn().mockResolvedValue([]),
    openFolder: vi.fn().mockResolvedValue(undefined),
    closeFolder: vi.fn().mockResolvedValue(undefined),
    clearRecent: vi.fn().mockResolvedValue(undefined),
  }
}

describe('RendererWorkspaceService telemetry', () => {
  it('logs workspaceOpened event when opening a folder', async () => {
    const telemetry = makeTelemetry()
    const wire = makeWire()
    const svc = new RendererWorkspaceService(wire, telemetry)

    await svc.openFolder(undefined)

    expect(telemetry.publicLog).toHaveBeenCalledOnce()
    expect(telemetry.publicLog).toHaveBeenCalledWith('workspaceOpened')
    svc.dispose()
  })
})
