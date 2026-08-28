/*---------------------------------------------------------------------------------------------
 *  Tests for CommandService telemetry埋点
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  Event,
  InstantiationService,
  IpcChannelDisposedError,
  LogLevel,
  ServiceCollection,
  type ILogger,
} from '@universe-editor/platform'
import type { ITelemetryService } from '@universe-editor/platform'
import { CommandService, type ICommandFailureRecorder } from '../CommandService.js'

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

  // Regression: an extension-host restart (workspace swap / trust flip) tears
  // down the IPC channel while a contributed command (e.g. git-graph.getCommits)
  // is still in flight. The rejection is benign lifecycle noise the caller
  // already handles — it must not be logged at error level on every restart.
  it('logs a warning (not an error) when the IPC channel is disposed mid-flight', async () => {
    const instantiation = new InstantiationService(new ServiceCollection())
    const logger = makeLogger()
    const svc = new CommandService(instantiation, undefined, logger)
    const err = new IpcChannelDisposedError()
    const disposable = CommandsRegistry.registerCommand('test.disposed.command', () =>
      Promise.reject(err),
    )
    try {
      await expect(svc.executeCommand('test.disposed.command')).rejects.toBe(err)
      expect(logger.error).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith('command interrupted id=test.disposed.command', err)
    } finally {
      disposable.dispose()
    }
  })

  it('also treats a synchronously thrown benign error as a warning', async () => {
    const instantiation = new InstantiationService(new ServiceCollection())
    const logger = makeLogger()
    const svc = new CommandService(instantiation, undefined, logger)
    const err = new IpcChannelDisposedError()
    const disposable = CommandsRegistry.registerCommand('test.disposed.sync', () => {
      throw err
    })
    try {
      await expect(svc.executeCommand('test.disposed.sync')).rejects.toBe(err)
      expect(logger.error).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith('command interrupted id=test.disposed.sync', err)
    } finally {
      disposable.dispose()
    }
  })
})

describe('CommandService bug recording hook', () => {
  function makeRecorder(): ICommandFailureRecorder & {
    events: Array<{ kind: string; commandId: string; message: string }>
  } {
    const events: Array<{ kind: 'commandError'; commandId: string; message: string }> = []
    return { events, recordEvent: (event) => events.push(event) }
  }

  it('records a missing command', async () => {
    const recorder = makeRecorder()
    const svc = new CommandService(
      new InstantiationService(new ServiceCollection()),
      undefined,
      undefined,
      recorder,
    )

    await svc.executeCommand('test.recorder.missing')

    expect(recorder.events).toEqual([
      { kind: 'commandError', commandId: 'test.recorder.missing', message: 'command not found' },
    ])
  })

  it('records a thrown handler error with its message', async () => {
    const recorder = makeRecorder()
    const svc = new CommandService(
      new InstantiationService(new ServiceCollection()),
      undefined,
      undefined,
      recorder,
    )
    const disposable = CommandsRegistry.registerCommand('test.recorder.throwing', () => {
      throw new Error('kaboom')
    })
    try {
      await expect(svc.executeCommand('test.recorder.throwing')).rejects.toThrow('kaboom')
      expect(recorder.events).toEqual([
        { kind: 'commandError', commandId: 'test.recorder.throwing', message: 'kaboom' },
      ])
    } finally {
      disposable.dispose()
    }
  })

  // Benign lifecycle rejections are still worth recording: a bug bundle wants to
  // show the interruption even though the log keeps it at warn level.
  it('records benign interruptions too', async () => {
    const recorder = makeRecorder()
    const svc = new CommandService(
      new InstantiationService(new ServiceCollection()),
      undefined,
      undefined,
      recorder,
    )
    const disposable = CommandsRegistry.registerCommand('test.recorder.benign', () =>
      Promise.reject(new IpcChannelDisposedError()),
    )
    try {
      await expect(svc.executeCommand('test.recorder.benign')).rejects.toBeInstanceOf(
        IpcChannelDisposedError,
      )
      expect(recorder.events).toHaveLength(1)
      expect(recorder.events[0]?.commandId).toBe('test.recorder.benign')
    } finally {
      disposable.dispose()
    }
  })

  it('does not record successful commands — telemetry already covers them', async () => {
    const recorder = makeRecorder()
    const telemetry = makeTelemetry()
    const svc = new CommandService(
      new InstantiationService(new ServiceCollection()),
      telemetry,
      undefined,
      recorder,
    )
    const disposable = CommandsRegistry.registerCommand('test.recorder.ok', () => 'fine')
    try {
      await svc.executeCommand('test.recorder.ok')
      expect(recorder.events).toHaveLength(0)
      expect(telemetry.publicLog).toHaveBeenCalledOnce()
    } finally {
      disposable.dispose()
    }
  })
})
