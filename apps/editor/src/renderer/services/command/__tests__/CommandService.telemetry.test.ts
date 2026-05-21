/*---------------------------------------------------------------------------------------------
 *  Tests for CommandService telemetry埋点
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Event,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  type ILogger,
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

function makeLogger(): ILogger {
  return {
    level: LogLevel.Info,
    onDidChangeLogLevel: Event.None,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
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

  it('logs a warning when a command is missing', async () => {
    const instantiation = new InstantiationService(new ServiceCollection())
    const logger = makeLogger()
    const svc = new CommandService(instantiation, undefined, logger)

    await expect(svc.executeCommand('test.missing.command')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith('command not found id=test.missing.command')
  })

  it('logs an error when a command handler throws', async () => {
    const instantiation = new InstantiationService(new ServiceCollection())
    const logger = makeLogger()
    const svc = new CommandService(instantiation, undefined, logger)
    const err = new Error('boom')
    const disposable = CommandsRegistry.registerCommand('test.throwing.command', () => {
      throw err
    })
    try {
      await expect(svc.executeCommand('test.throwing.command')).rejects.toThrow('boom')
      expect(logger.error).toHaveBeenCalledWith('command failed id=test.throwing.command', err)
    } finally {
      disposable.dispose()
    }
  })
})
