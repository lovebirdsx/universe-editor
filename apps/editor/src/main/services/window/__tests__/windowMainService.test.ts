/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/window/windowMainService.ts
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { combinedDisposable, ShutdownReason, URI } from '@universe-editor/platform'

// --- Mock IPC bootstrap ---
vi.mock('../../../ipc/registerMainServices.js', () => ({
  bootstrapWindowIpc: vi.fn(() => ({
    disposable: combinedDisposable(),
    rendererLifecycle: { confirmShutdown: vi.fn().mockResolvedValue(true) },
  })),
}))

// --- Mock per-window workspace stack (kept lightweight; exercised in their own
//     unit/integration tests). Avoids real fs watchers / storage in this test. ---
vi.mock('../../storage/storageMainService.js', () => ({
  MainStorageService: vi.fn().mockImplementation(() => ({
    flush: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}))
vi.mock('../../workspace/workspaceMainService.js', () => ({
  WorkspaceMainService: vi.fn().mockImplementation(() => ({
    current: null,
    onDidChangeWorkspace: vi.fn(() => ({ dispose: vi.fn() })),
    restoreCurrent: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  })),
}))
vi.mock('../../userData/userDataMainService.js', () => ({
  UserDataMainService: vi.fn().mockImplementation(() => ({ dispose: vi.fn() })),
}))
vi.mock('../../workspace/electronFolderDialog.js', () => ({
  ElectronFolderDialog: vi.fn().mockImplementation(() => ({})),
}))

// --- Electron mock ---
const windowIdCounter = { value: 1 }

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((_name: string) => join(tmpdir(), 'ue-wintest')),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    id: windowIdCounter.value++,
    on: vi.fn(),
    once: vi.fn(),
    removeListener: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn().mockReturnValue(false),
    isMinimized: vi.fn().mockReturnValue(false),
    isMaximized: vi.fn().mockReturnValue(false),
    isFullScreen: vi.fn().mockReturnValue(false),
    getNormalBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    getBounds: vi.fn().mockReturnValue({ x: 0, y: 0, width: 1280, height: 800 }),
    webContents: {
      toggleDevTools: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      openDevTools: vi.fn(),
      isDevToolsOpened: vi.fn().mockReturnValue(false),
      setWindowOpenHandler: vi.fn(),
    },
  })),
  screen: {
    getAllDisplays: vi.fn().mockReturnValue([]),
    getDisplayNearestPoint: vi.fn().mockReturnValue({ id: 1 }),
  },
}))

// Import after mocks
const { WindowMainService } = await import('../windowMainService.js')
const { bootstrapWindowIpc } = await import('../../../ipc/registerMainServices.js')
const { LogMainService } = await import('../../log/logMainService.js')
const { WorkspaceMainService } = await import('../../workspace/workspaceMainService.js')
const { UserDataMainService } = await import('../../userData/userDataMainService.js')
const { BrowserWindow } = await import('electron')

function grabLastWindowCloseHandler(): (e: { preventDefault: () => void }) => void {
  const win = vi.mocked(BrowserWindow).mock.results.at(-1)?.value as {
    on: { mock: { calls: Array<[string, (...args: never[]) => void]> } }
  }
  // The window registers more than one `close` listener (geometry tracking plus
  // the teardown handler). The disposal handler is registered last, so take the
  // final `close` call — not the first.
  const call = win.on.mock.calls.filter(([event]) => event === 'close').at(-1)
  if (!call) throw new Error('no close handler registered')
  return call[1] as (e: { preventDefault: () => void }) => void
}

function makeOpts() {
  const logService = new LogMainService()
  return {
    appServices: {
      ping: {} as never,
      fileSystem: {} as never,
      fileSearch: {} as never,
      textSearch: {} as never,
      fileWatcher: {} as never,
      recentWorkspaces: {} as never,
      acpHost: {} as never,
      acpTerminal: {} as never,
      extensionHost: {} as never,
      extensionManagement: {} as never,
      extensionGallery: {} as never,
      typescriptLanguage: {} as never,
      claudeBinary: {} as never,
      claudeConfig: {} as never,
      codexBinary: {} as never,
      codexConfig: {} as never,
      disposableLeak: {} as never,
      update: {} as never,
      releaseNotes: {} as never,
      docs: {} as never,
      performance: {} as never,
      usage: {} as never,
      sessionSwitcher: { registerWindow: () => {}, unregisterWindow: () => {} } as never,
      configLocation: {
        onDidChangeConfigDir: () => ({ dispose: () => {} }),
        currentDir: '',
      } as never,
      aiModel: {} as never,
      aiDebug: {} as never,
      remoteSchema: {} as never,
      exchangeRate: {} as never,
      resourceAccess: {} as never,
      environmentSnapshot: {} as never,
    },
    logService,
    e2eEnabled: false,
    rendererDebug: false,
    preloadPath: '/preload/index.cjs',
    rendererUrl: 'http://localhost:5173',
    getConfigDir: () => join(tmpdir(), 'ue-wintest'),
  }
}

describe('WindowMainService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    windowIdCounter.value = 1
  })

  it('createWindow returns a numeric window id', async () => {
    const svc = new WindowMainService(makeOpts())
    const id = await svc.createWindow()
    expect(typeof id).toBe('number')
  })

  it('getWindows returns the created window', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow()
    expect(svc.getWindows()).toHaveLength(1)
  })

  it('createWindow twice registers two distinct windows', async () => {
    const svc = new WindowMainService(makeOpts())
    const id1 = await svc.createWindow()
    const id2 = await svc.createWindow()
    expect(id1).not.toBe(id2)
    expect(svc.getWindows()).toHaveLength(2)
  })

  it('routes an update quit confirmation to the requesting window', async () => {
    const backgroundLifecycle = {
      _serviceBrand: undefined,
      confirmShutdown: vi.fn().mockResolvedValue(true),
    }
    const requestingLifecycle = {
      _serviceBrand: undefined,
      confirmShutdown: vi.fn().mockResolvedValue(true),
    }
    vi.mocked(bootstrapWindowIpc)
      .mockImplementationOnce(() => ({
        disposable: combinedDisposable(),
        rendererLifecycle: backgroundLifecycle,
        rendererSessions: {} as never,
      }))
      .mockImplementationOnce(() => ({
        disposable: combinedDisposable(),
        rendererLifecycle: requestingLifecycle,
        rendererSessions: {} as never,
      }))
    const opts = makeOpts()
    const getAllSessions = vi.fn().mockResolvedValue([
      {
        windowId: 1,
        workspaceName: 'background',
        sessionId: 'running-session',
        title: 'Running',
        status: 'running',
        agentId: 'claude',
      },
    ])
    Object.assign(opts.appServices.sessionSwitcher, { getAllSessions })
    const svc = new WindowMainService(opts)
    await svc.createWindow()
    const requestingWindowId = await svc.createWindow()

    const confirmed = await svc.confirmQuit(requestingWindowId)

    expect(confirmed).toBe(true)
    expect(getAllSessions).toHaveBeenCalledTimes(1)
    expect(requestingLifecycle.confirmShutdown).toHaveBeenCalledWith(ShutdownReason.Quit, {
      runningSessionCount: 1,
    })
    expect(backgroundLifecycle.confirmShutdown).toHaveBeenCalledWith(ShutdownReason.Quit, {
      skipRunningSessionPrompt: true,
    })
    expect(requestingLifecycle.confirmShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      backgroundLifecycle.confirmShutdown.mock.invocationCallOrder[0]!,
    )
  })

  it('marks only the first created window as the current session first window', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow()
    await svc.createWindow()

    const calls = vi.mocked(bootstrapWindowIpc).mock.calls
    const firstWindowsService = calls[0]?.[3]
    const secondWindowsService = calls[1]?.[3]

    await expect(firstWindowsService?.isCurrentWindowFirst()).resolves.toBe(true)
    await expect(secondWindowsService?.isCurrentWindowFirst()).resolves.toBe(false)
  })

  it('dispose clears all windows', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow()
    svc.dispose()
    expect(svc.getWindows()).toHaveLength(0)
  })

  it('getWindowById returns undefined for unknown id', async () => {
    const svc = new WindowMainService(makeOpts())
    expect(svc.getWindowById(99999)).toBeUndefined()
  })

  it('restoreSession([]) opens a single empty window', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.restoreSession([])
    expect(svc.getWindows()).toHaveLength(1)
  })

  it('restoreSession with two entries opens two windows', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.restoreSession([
      { workspace: { folder: URI.file('/tmp/a'), name: 'a' }, devToolsOpen: false },
      { workspace: { folder: URI.file('/tmp/b'), name: 'b' }, devToolsOpen: false },
    ])
    expect(svc.getWindows()).toHaveLength(2)
  })

  it('restoreSession dedups entries with the same workspace', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.restoreSession([
      { workspace: { folder: URI.file('/tmp/dup'), name: 'dup' }, devToolsOpen: false },
      { workspace: { folder: URI.file('/tmp/dup'), name: 'dup' }, devToolsOpen: false },
    ])
    expect(svc.getWindows()).toHaveLength(1)
  })

  it('createWindow({ workspace }) restores the workspace before load', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow({ workspace: { folder: URI.file('/tmp/w'), name: 'w' } })
    const instance = vi.mocked(WorkspaceMainService).mock.results.at(-1)?.value as {
      restoreCurrent: ReturnType<typeof vi.fn>
    }
    expect(instance.restoreCurrent).toHaveBeenCalledTimes(1)
  })

  it('disposes per-window resources synchronously on a confirmed-close window', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow()
    const userData = vi.mocked(UserDataMainService).mock.results.at(-1)?.value as {
      dispose: ReturnType<typeof vi.fn>
    }
    const close = grabLastWindowCloseHandler()

    // Quit path: mark confirmed so `close` takes the _allowClose branch. On quit
    // the `closed` handler removes the entry from the window map, so the only
    // teardown of per-window disposables is inside `close`. It must run
    // synchronously — deferring it behind a promise loses the race with
    // will-quit → process.exit and leaks every per-window Disposable.
    svc.markQuitConfirmed()
    close({ preventDefault: () => {} })

    expect(userData.dispose).toHaveBeenCalled()
  })

  it('does not warn about a timeout when confirmShutdown answers promptly', async () => {
    // Regression: _canProceed raced the renderer round-trip against an untracked
    // setTimeout. A prompt answer won the race, but the timer was never cleared —
    // 10s later it still fired and logged "confirmShutdown timed out … proceeding",
    // a phantom warning for a confirmation that actually succeeded (seen in the
    // wild as a lone warn exactly 10s after a window closed cleanly).
    const opts = makeOpts()
    const warn = vi.fn()
    vi.spyOn(opts.logService, 'createLogger').mockReturnValue({
      level: 0,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      flush: vi.fn(),
      dispose: vi.fn(),
    } as never)
    const svc = new WindowMainService(opts)
    await svc.createWindow()

    vi.useFakeTimers()
    try {
      // The default bootstrapWindowIpc mock answers confirmShutdown immediately.
      await expect(svc.confirmQuit()).resolves.toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('proceeds with quit when a wedged renderer never answers confirmShutdown', async () => {
    // A renderer whose main thread is stuck never resolves the veto round-trip.
    // Without the timeout in _canProceed this would hang confirmQuit forever;
    // instead it must release the veto (return true) after CONFIRM_SHUTDOWN_TIMEOUT_MS.
    const wedgedLifecycle = {
      _serviceBrand: undefined,
      confirmShutdown: vi.fn(() => new Promise<boolean>(() => {})), // never settles
    }
    vi.mocked(bootstrapWindowIpc).mockImplementationOnce(() => ({
      disposable: combinedDisposable(),
      rendererLifecycle: wedgedLifecycle,
      rendererSessions: {} as never,
    }))
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow()

    vi.useFakeTimers()
    try {
      const pending = svc.confirmQuit()
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toBe(true)
      expect(wedgedLifecycle.confirmShutdown).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
