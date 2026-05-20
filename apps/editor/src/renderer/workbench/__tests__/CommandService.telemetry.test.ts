/*---------------------------------------------------------------------------------------------
 *  Tests for CommandService telemetry埋点
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type { ITelemetryService } from '@universe-editor/platform'
import { CommandService } from '../CommandService.js'

function makeTelemetry(): ITelemetryService {
  return {
    _serviceBrand: undefined,
    publicLog: vi.fn(),
    publicLogError: vi.fn(),
    publicLogMeasure: vi.fn(),
    getTelemetryInfo: vi.fn().mockResolvedValue({ sessionId: 'test', machineId: 'test' }),
  }
}

describe('CommandService telemetry', () => {
  it('logs commandExecuted event on successful command execution', async () => {
    const telemetry = makeTelemetry()
    const instantiation = new InstantiationService(new ServiceCollection())
    const svc = new CommandService(instantiation, telemetry)

    const disposable = CommandsRegistry.registerCommand('test.telemetry.cmd', () => 'result')
    try {
      await svc.executeCommand('test.telemetry.cmd')
      expect(telemetry.publicLog).toHaveBeenCalledOnce()
      expect(telemetry.publicLog).toHaveBeenCalledWith('commandExecuted', {
        commandId: 'test.telemetry.cmd',
      })
    } finally {
      disposable.dispose()
    }
  })
})
