import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  ILayoutService,
  IOutputService,
  InstantiationService,
  IViewsService,
  LogLevel,
  PartId,
  ServiceCollection,
  type IStorageService,
} from '@universe-editor/platform'
import {
  ILogFilesService,
  type LogAppendEvent,
  type LogFileDescriptor,
} from '../../../shared/ipc/services.js'
import { OutputService } from '../../services/output/OutputService.js'
import { ErrorLogAutoRevealContribution } from '../ErrorLogAutoRevealContribution.js'

interface FakeLogFilesService {
  _serviceBrand: undefined
  listLogFiles: ReturnType<typeof vi.fn>
  readLogFile: ReturnType<typeof vi.fn>
  resolveLogPath: ReturnType<typeof vi.fn>
  openLogsFolder: ReturnType<typeof vi.fn>
  setLogLevel: ReturnType<typeof vi.fn>
  getLogLevel: ReturnType<typeof vi.fn>
  setTimestampFormat: ReturnType<typeof vi.fn>
  getTimestampFormat: ReturnType<typeof vi.fn>
  onDidAppendEntry: Emitter<LogAppendEvent>['event']
  _emitter: Emitter<LogAppendEvent>
}

const rendererDescriptor: LogFileDescriptor = {
  id: '20260521T100000/renderer.log',
  name: 'Renderer',
  channelId: 'renderer',
  sessionStartedAt: '2026-05-21 10:00:00',
  size: 0,
  modifiedTime: 0,
}

const mainDescriptor: LogFileDescriptor = {
  id: '20260521T100000/main.log',
  name: 'Main',
  channelId: 'main',
  sessionStartedAt: '2026-05-21 10:00:00',
  size: 0,
  modifiedTime: 0,
}

function makeLogFiles(descriptors: readonly LogFileDescriptor[]): FakeLogFilesService {
  const emitter = new Emitter<LogAppendEvent>()
  return {
    _serviceBrand: undefined,
    listLogFiles: vi.fn().mockResolvedValue(descriptors),
    readLogFile: vi.fn().mockResolvedValue('[10:00:00] [error] boom\n'),
    resolveLogPath: vi.fn(),
    openLogsFolder: vi.fn(),
    setLogLevel: vi.fn(),
    getLogLevel: vi.fn(),
    setTimestampFormat: vi.fn(),
    getTimestampFormat: vi.fn(),
    onDidAppendEntry: emitter.event,
    _emitter: emitter,
  }
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

function makeLayoutService() {
  const focus = vi.fn()
  return {
    _serviceBrand: undefined,
    setVisible: vi.fn(),
    getPart: vi.fn(() => ({ focus })),
    focus,
  }
}

function makeViewsService() {
  return {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
  }
}

function instantiate(
  output: OutputService,
  logFiles: FakeLogFilesService,
  layout: ReturnType<typeof makeLayoutService>,
  views: ReturnType<typeof makeViewsService>,
): ErrorLogAutoRevealContribution {
  const services = new ServiceCollection()
  services.set(ILogFilesService, logFiles as never)
  services.set(IOutputService, output)
  services.set(ILayoutService, layout as never)
  services.set(IViewsService, views as never)
  const inst = new InstantiationService(services)
  return inst.createInstance(ErrorLogAutoRevealContribution)
}

function fireAppend(
  logFiles: FakeLogFilesService,
  channelId: string,
  chunk: string,
  maxLevel: LogLevel,
): void {
  logFiles._emitter.fire({ channelId, chunk, maxLevel })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

describe('ErrorLogAutoRevealContribution', () => {
  let output: OutputService
  let logFiles: FakeLogFilesService
  let layout: ReturnType<typeof makeLayoutService>
  let views: ReturnType<typeof makeViewsService>

  beforeEach(() => {
    output = new OutputService(makeStorage())
    logFiles = makeLogFiles([rendererDescriptor, mainDescriptor])
    layout = makeLayoutService()
    views = makeViewsService()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('ignores non-error append events', async () => {
    const contribution = instantiate(output, logFiles, layout, views)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [info] ok\n', LogLevel.Info)
    await flush()

    expect(logFiles.readLogFile).not.toHaveBeenCalled()
    expect(output.activeChannelName.get()).toBeUndefined()
    expect(layout.setVisible).not.toHaveBeenCalled()
    expect(views.openViewContainer).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('opens Output and activates the channel that emitted the first error', async () => {
    const contribution = instantiate(output, logFiles, layout, views)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] boom\n', LogLevel.Error)
    await flush()

    expect(logFiles.readLogFile).toHaveBeenCalledWith(rendererDescriptor.id, 1024 * 1024)
    expect(output.activeChannelName.get()).toBe('Renderer')
    expect(output.activeChannelContent.get()).toBe('[10:00:00] [error] boom\n')
    expect(views.openViewContainer).toHaveBeenCalledWith('workbench.view.output')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    expect(layout.focus).toHaveBeenCalledTimes(1)
    contribution.dispose()
  })

  it('refreshes again when the initial descriptor snapshot misses the error channel', async () => {
    logFiles.listLogFiles.mockResolvedValueOnce([])
    const contribution = instantiate(output, logFiles, layout, views)

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] boom\n', LogLevel.Error)
    await flush()

    expect(logFiles.listLogFiles).toHaveBeenCalledTimes(2)
    expect(logFiles.readLogFile).toHaveBeenCalledWith(rendererDescriptor.id, 1024 * 1024)
    expect(output.activeChannelName.get()).toBe('Renderer')
    contribution.dispose()
  })

  it('does not reveal again after the first error has been handled', async () => {
    const contribution = instantiate(output, logFiles, layout, views)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] first\n', LogLevel.Error)
    await flush()
    output.createChannel('Manual')
    output.setActiveChannel('Manual')
    vi.clearAllMocks()

    fireAppend(logFiles, 'main', '[10:00:01] [error] second\n', LogLevel.Error)
    await flush()

    expect(logFiles.readLogFile).not.toHaveBeenCalled()
    expect(output.activeChannelName.get()).toBe('Manual')
    expect(layout.setVisible).not.toHaveBeenCalled()
    expect(views.openViewContainer).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('falls back to the append chunk when reading the log file fails', async () => {
    logFiles.readLogFile.mockRejectedValueOnce(new Error('read failed'))
    const contribution = instantiate(output, logFiles, layout, views)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] fallback\n', LogLevel.Error)
    await flush()

    expect(output.activeChannelName.get()).toBe('Renderer')
    expect(output.activeChannelContent.get()).toBe('[10:00:00] [error] fallback\n')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    contribution.dispose()
  })
})
