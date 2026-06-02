/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/contributions/LogTailContribution.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  IOutputService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  type IStorageService,
} from '@universe-editor/platform'
import { ILogFilesService, type LogAppendEvent } from '../../../shared/ipc/services.js'
import { OutputService } from '../../services/output/OutputService.js'
import { LogTailContribution } from '../LogTailContribution.js'

interface FakeLogFilesService {
  _serviceBrand: undefined
  listLogFiles: ReturnType<typeof vi.fn>
  readLogFile: ReturnType<typeof vi.fn>
  resolveLogPath: ReturnType<typeof vi.fn>
  openLogsFolder: ReturnType<typeof vi.fn>
  setLogLevel: ReturnType<typeof vi.fn>
  getLogLevel: ReturnType<typeof vi.fn>
  onDidAppendEntry: Emitter<LogAppendEvent>['event']
  _emitter: Emitter<LogAppendEvent>
}

function makeLogFiles(
  descriptors: Array<{ name: string; channelId: string }>,
): FakeLogFilesService {
  const emitter = new Emitter<LogAppendEvent>()
  return {
    _serviceBrand: undefined,
    listLogFiles: vi.fn().mockResolvedValue(
      descriptors.map((d) => ({
        id: `20260521T100000/${d.channelId}.log`,
        name: d.name,
        channelId: d.channelId,
        sessionStartedAt: '2026-05-21 10:00:00',
        size: 0,
        modifiedTime: 0,
      })),
    ),
    readLogFile: vi.fn(),
    resolveLogPath: vi.fn(),
    openLogsFolder: vi.fn(),
    setLogLevel: vi.fn(),
    getLogLevel: vi.fn(),
    onDidAppendEntry: emitter.event,
    _emitter: emitter,
  }
}

function fireAppend(
  logFiles: FakeLogFilesService,
  channelId: string,
  chunk: string,
  maxLevel: LogLevel = LogLevel.Info,
): void {
  logFiles._emitter.fire({ channelId, chunk, maxLevel })
}

function instantiate(output: OutputService, logFiles: FakeLogFilesService): LogTailContribution {
  const services = new ServiceCollection()
  services.set(ILogFilesService, logFiles as never)
  services.set(IOutputService, output)
  const inst = new InstantiationService(services)
  return inst.createInstance(LogTailContribution)
}

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

describe('LogTailContribution', () => {
  let output: OutputService
  let logFiles: FakeLogFilesService

  beforeEach(() => {
    output = new OutputService(makeStorage())
    logFiles = makeLogFiles([
      { name: 'Main', channelId: 'main' },
      { name: 'External Change', channelId: 'externalChange' },
    ])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('appends incoming chunks to the active log Output channel', async () => {
    const contribution = instantiate(output, logFiles)
    // Wait for the bootstrap listLogFiles() promise to resolve
    await Promise.resolve()
    await Promise.resolve()

    const channel = output.createChannel('Main', 'log')
    output.setActiveChannel('Main')
    fireAppend(logFiles, 'main', 'hello\n')
    await Promise.resolve()

    expect(channel.content.get()).toBe('hello\n')
    contribution.dispose()
  })

  it('ignores chunks when the active channel is not a log channel', async () => {
    const contribution = instantiate(output, logFiles)
    await Promise.resolve()
    await Promise.resolve()

    const channel = output.createChannel('Tasks')
    output.setActiveChannel('Tasks')
    fireAppend(logFiles, 'main', 'ignored\n')
    await Promise.resolve()

    expect(channel.content.get()).toBe('')
    contribution.dispose()
  })

  it('ignores chunks for a channel different from the active one', async () => {
    const contribution = instantiate(output, logFiles)
    await Promise.resolve()
    await Promise.resolve()

    const channel = output.createChannel('Main', 'log')
    output.setActiveChannel('Main')
    fireAppend(logFiles, 'externalChange', 'other\n')
    await Promise.resolve()

    expect(channel.content.get()).toBe('')
    contribution.dispose()
  })

  it('coalesces multiple chunks fired in the same microtask into one append', async () => {
    const contribution = instantiate(output, logFiles)
    await Promise.resolve()
    await Promise.resolve()

    const channel = output.createChannel('Main', 'log')
    output.setActiveChannel('Main')
    const appendSpy = vi.spyOn(channel, 'append')
    fireAppend(logFiles, 'main', 'a\n')
    fireAppend(logFiles, 'main', 'b\n')
    fireAppend(logFiles, 'main', 'c\n')
    await Promise.resolve()

    expect(appendSpy).toHaveBeenCalledTimes(1)
    expect(appendSpy).toHaveBeenCalledWith('a\nb\nc\n')
    contribution.dispose()
  })

  it('refreshes descriptor cache on first unknown channelId so the next chunk lands', async () => {
    // Start with no descriptors so the very first event misses cache
    logFiles.listLogFiles.mockResolvedValueOnce([])
    const contribution = instantiate(output, logFiles)
    await Promise.resolve()
    await Promise.resolve()

    const channel = output.createChannel('Main', 'log')
    output.setActiveChannel('Main')
    // First fire: cache miss, refresh queued, this chunk is dropped
    fireAppend(logFiles, 'main', 'dropped\n')
    await Promise.resolve()
    await Promise.resolve()

    // Second fire: cache should now contain Main → main
    fireAppend(logFiles, 'main', 'landed\n')
    await Promise.resolve()
    expect(channel.content.get()).toBe('landed\n')
    contribution.dispose()
  })

  it('disposes the IPC subscription on dispose', async () => {
    const contribution = instantiate(output, logFiles)
    await Promise.resolve()
    await Promise.resolve()
    const channel = output.createChannel('Main', 'log')
    output.setActiveChannel('Main')
    contribution.dispose()
    fireAppend(logFiles, 'main', 'after-dispose\n')
    await Promise.resolve()
    expect(channel.content.get()).toBe('')
  })
})
