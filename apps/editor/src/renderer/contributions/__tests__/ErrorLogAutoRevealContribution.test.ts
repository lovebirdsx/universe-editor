import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  ILayoutService,
  InstantiationService,
  IOutputService,
  IViewsService,
  IWindowsService,
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
    getVisible: vi.fn(() => false),
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

const MY_ID = 1
const OTHER_ID = 2

interface FakeWindowsService {
  _serviceBrand: undefined
  onDidChangeWindows: ReturnType<typeof vi.fn>
  getWindows: ReturnType<typeof vi.fn>
  isCurrentWindowFirst: ReturnType<typeof vi.fn>
  getCurrentWindowId: ReturnType<typeof vi.fn>
  getFocusedWindowId: ReturnType<typeof vi.fn>
  onDidChangeFocusedWindow: Emitter<number>['event']
  getLastRenderCrash: ReturnType<typeof vi.fn>
  focusWindow: ReturnType<typeof vi.fn>
  openWindow: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
  /** Mirrors main: the top window id flips and the change event fires together. */
  fireFocused(id: number): void
  setFocusedId(id: number | null): void
}

function makeWindowsService(focusedId: number | null = MY_ID): FakeWindowsService {
  const state = { focusedId }
  const focusedEmitter = new Emitter<number>()
  return {
    _serviceBrand: undefined,
    onDidChangeWindows: vi.fn(() => ({ dispose: () => {} })),
    getWindows: vi.fn(async () => []),
    isCurrentWindowFirst: vi.fn(async () => true),
    getCurrentWindowId: vi.fn(async () => MY_ID),
    getFocusedWindowId: vi.fn(async () => state.focusedId),
    onDidChangeFocusedWindow: focusedEmitter.event,
    getLastRenderCrash: vi.fn(async () => null),
    focusWindow: vi.fn(async () => {}),
    openWindow: vi.fn(async () => {}),
    quit: vi.fn(async () => {}),
    fireFocused(id) {
      state.focusedId = id
      focusedEmitter.fire(id)
    },
    setFocusedId(id) {
      state.focusedId = id
    },
  }
}

function instantiate(
  output: OutputService,
  logFiles: FakeLogFilesService,
  layout: ReturnType<typeof makeLayoutService>,
  views: ReturnType<typeof makeViewsService>,
  windows: FakeWindowsService = makeWindowsService(),
): ErrorLogAutoRevealContribution {
  const services = new ServiceCollection()
  services.set(ILogFilesService, logFiles as never)
  services.set(IOutputService, output)
  services.set(ILayoutService, layout as never)
  services.set(IViewsService, views as never)
  services.set(IWindowsService, windows as never)
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
  for (let i = 0; i < 40; i++) {
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
    expect(output.activeChannel?.getText()).toBe('[10:00:00] [error] boom\n')
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

  it('does not steal the active channel when the panel is already visible', async () => {
    layout.getVisible.mockReturnValue(true)
    const contribution = instantiate(output, logFiles, layout, views)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] boom\n', LogLevel.Error)
    await flush()

    expect(logFiles.readLogFile).not.toHaveBeenCalled()
    expect(output.activeChannelName.get()).toBeUndefined()
    expect(layout.setVisible).not.toHaveBeenCalled()
    expect(views.openViewContainer).not.toHaveBeenCalled()
    expect(layout.focus).not.toHaveBeenCalled()

    // 门控返回 false 不置位 _hasRevealed：面板关掉后来 error 仍正常揭示，
    // one-shot 机会不被面板常开期间的首条 error 消费掉
    layout.getVisible.mockReturnValue(false)
    fireAppend(logFiles, 'main', '[10:00:01] [error] second\n', LogLevel.Error)
    await flush()

    expect(logFiles.readLogFile).toHaveBeenCalledWith(mainDescriptor.id, 1024 * 1024)
    expect(output.activeChannelName.get()).toBe('Main')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    contribution.dispose()
  })

  it('falls back to the append chunk when reading the log file fails', async () => {
    logFiles.readLogFile.mockRejectedValueOnce(new Error('read failed'))
    const contribution = instantiate(output, logFiles, layout, views)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] fallback\n', LogLevel.Error)
    await flush()

    expect(output.activeChannelName.get()).toBe('Renderer')
    expect(output.activeChannel?.getText()).toBe('[10:00:00] [error] fallback\n')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    contribution.dispose()
  })

  it('defers to a pending channel restore instead of stealing the active channel', async () => {
    const storage = {
      _serviceBrand: undefined,
      get: vi.fn().mockResolvedValue('acp/claude/old-handle'),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
    } as unknown as IStorageService
    const out = new OutputService(storage)
    await flush() // let _loadRestoredChannel arm the pending restore
    expect(out.hasPendingRestoredChannel).toBe(true)
    // Bootstrap creates the aggregated channel first, so it owns the active slot
    // (mirrors main.tsx) — the pending restore waits for its real target.
    out.createChannel('All')
    expect(out.activeChannelName.get()).toBe('All')

    const contribution = instantiate(out, logFiles, layout, views)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] boom\n', LogLevel.Error)
    await flush()

    expect(logFiles.readLogFile).not.toHaveBeenCalled()
    expect(out.activeChannelName.get()).toBe('All')
    expect(views.openViewContainer).not.toHaveBeenCalled()
    expect(layout.setVisible).not.toHaveBeenCalled()

    // Once the restore target is created the pending state clears and it activates.
    out.createChannel('acp/claude/new-handle')
    expect(out.hasPendingRestoredChannel).toBe(false)
    expect(out.activeChannelName.get()).toBe('acp/claude/new-handle')
    contribution.dispose()
  })

  it('holds the reveal until this window becomes the top window', async () => {
    const windows = makeWindowsService(OTHER_ID)
    const contribution = instantiate(output, logFiles, layout, views, windows)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] boom\n', LogLevel.Error)
    await flush()

    expect(logFiles.readLogFile).not.toHaveBeenCalled()
    expect(layout.setVisible).not.toHaveBeenCalled()
    expect(views.openViewContainer).not.toHaveBeenCalled()

    windows.fireFocused(MY_ID)
    await flush()

    expect(logFiles.readLogFile).toHaveBeenCalledWith(rendererDescriptor.id, 1024 * 1024)
    expect(output.activeChannelName.get()).toBe('Renderer')
    expect(views.openViewContainer).toHaveBeenCalledWith('workbench.view.output')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    contribution.dispose()
  })

  it('does not reveal on another window focus event', async () => {
    const windows = makeWindowsService(OTHER_ID)
    const contribution = instantiate(output, logFiles, layout, views, windows)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] boom\n', LogLevel.Error)
    await flush()

    windows.fireFocused(OTHER_ID)
    await flush()

    expect(logFiles.readLogFile).not.toHaveBeenCalled()
    expect(layout.setVisible).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('ignores focus events without a pending error', async () => {
    const windows = makeWindowsService()
    const contribution = instantiate(output, logFiles, layout, views, windows)
    await flush()

    windows.fireFocused(MY_ID)
    await flush()

    expect(logFiles.readLogFile).not.toHaveBeenCalled()
    expect(layout.setVisible).not.toHaveBeenCalled()
    contribution.dispose()
  })

  it('keeps the first pending error when more appends arrive before reveal', async () => {
    const windows = makeWindowsService(OTHER_ID)
    const contribution = instantiate(output, logFiles, layout, views, windows)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] first\n', LogLevel.Error)
    fireAppend(logFiles, 'main', '[10:00:01] [error] second\n', LogLevel.Error)
    await flush()

    windows.fireFocused(MY_ID)
    await flush()

    expect(logFiles.readLogFile).toHaveBeenCalledTimes(1)
    expect(logFiles.readLogFile).toHaveBeenCalledWith(rendererDescriptor.id, 1024 * 1024)
    expect(output.activeChannelName.get()).toBe('Renderer')
    contribution.dispose()
  })

  it('clears pending when the reveal fails so a later append retries', async () => {
    const windows = makeWindowsService()
    const contribution = instantiate(output, logFiles, layout, views, windows)
    await flush()

    fireAppend(logFiles, 'unknown-channel', '[10:00:00] [error] ghost\n', LogLevel.Error)
    await flush()
    expect(layout.setVisible).not.toHaveBeenCalled()

    fireAppend(logFiles, 'renderer', '[10:00:01] [error] real\n', LogLevel.Error)
    await flush()

    expect(logFiles.readLogFile).toHaveBeenCalledWith(rendererDescriptor.id, 1024 * 1024)
    expect(output.activeChannelName.get()).toBe('Renderer')
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    contribution.dispose()
  })

  it('reveals after a focus event races an in-flight top-window check', async () => {
    const windows = makeWindowsService(OTHER_ID)
    let resolveFocused!: (id: number | null) => void
    windows.getFocusedWindowId.mockImplementationOnce(
      () =>
        new Promise<number | null>((resolve) => {
          resolveFocused = resolve
        }),
    )
    const contribution = instantiate(output, logFiles, layout, views, windows)
    await flush()

    fireAppend(logFiles, 'renderer', '[10:00:00] [error] boom\n', LogLevel.Error)
    await flush() // _runReveal now hangs on getFocusedWindowId

    windows.fireFocused(MY_ID) // in-flight → sets the retry flag
    await flush()

    resolveFocused(OTHER_ID) // stale answer: not the top window
    await flush()

    // The retry re-queries (state now MY_ID) and reveals.
    expect(logFiles.readLogFile).toHaveBeenCalledWith(rendererDescriptor.id, 1024 * 1024)
    expect(layout.setVisible).toHaveBeenCalledWith(PartId.Panel, true)
    contribution.dispose()
  })
})
