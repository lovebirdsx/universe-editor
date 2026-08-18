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
  BrowserWindow: Object.assign(
    vi.fn().mockImplementation(() => ({
      id: windowIdCounter.value++,
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      show: vi.fn(),
      showInactive: vi.fn(),
      focus: vi.fn(),
      restore: vi.fn(),
      reload: vi.fn(),
      close: vi.fn(),
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
        getOSProcessId: vi.fn().mockReturnValue(1000),
      },
    })),
    {
      getFocusedWindow: vi.fn(() => null),
      getAllWindows: vi.fn(() => []),
    },
  ),
  dialog: {
    showMessageBox: vi.fn().mockResolvedValue({ response: 1, checkboxChecked: false }),
  },
  screen: {
    getAllDisplays: vi.fn().mockReturnValue([]),
    getDisplayNearestPoint: vi.fn().mockReturnValue({ id: 1 }),
  },
  nativeTheme: { shouldUseDarkColors: true, on: () => {}, removeListener: () => {} },
}))

// Import after mocks
const { WindowMainService } = await import('../windowMainService.js')
const { bootstrapWindowIpc } = await import('../../../ipc/registerMainServices.js')
const { LogMainService } = await import('../../log/logMainService.js')
const { WorkspaceMainService } = await import('../../workspace/workspaceMainService.js')
const { UserDataMainService } = await import('../../userData/userDataMainService.js')
const { createStubWatcherProcessClient } = await import('@universe-editor/node-services')
const { BrowserWindow, dialog } = await import('electron')

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

interface CrashDetails {
  reason: string
  exitCode?: number
}

function grabRenderProcessGoneHandler(): (e: unknown, details: CrashDetails) => void {
  const win = vi.mocked(BrowserWindow).mock.results.at(-1)?.value as {
    webContents: { on: { mock: { calls: Array<[string, (...args: never[]) => void]> } } }
  }
  const call = win.webContents.on.mock.calls.find(([event]) => event === 'render-process-gone')
  if (!call) throw new Error('no render-process-gone handler registered')
  return call[1] as (e: unknown, details: CrashDetails) => void
}

function grabReadyToShowHandler(): () => void {
  const win = vi.mocked(BrowserWindow).mock.results.at(-1)?.value as {
    once: { mock: { calls: Array<[string, (...args: never[]) => void]> } }
  }
  const call = win.once.mock.calls.find(([event]) => event === 'ready-to-show')
  if (!call) throw new Error('no ready-to-show handler registered')
  return call[1] as () => void
}

function lastWindow(): {
  show: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
} {
  return vi.mocked(BrowserWindow).mock.results.at(-1)?.value as never
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
      errorSink: { recordLocal: vi.fn() } as never,
      diagnostics: {} as never,
      issueReporter: {} as never,
      processMonitor: {} as never,
      watcherProcess: createStubWatcherProcessClient(),
      remoteConnection: {} as never,
      remoteStatus: {} as never,
    },
    logService,
    e2eEnabled: false,
    silentE2E: false,
    extensionDevelopment: false,
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

  describe('render-process-gone crash recovery', () => {
    it('records the crash in the error sink and skips the native modal in E2E', async () => {
      const opts = makeOpts()
      opts.e2eEnabled = true
      const svc = new WindowMainService(opts)
      await svc.createWindow()
      const errorSink = opts.appServices.errorSink as { recordLocal: ReturnType<typeof vi.fn> }
      grabRenderProcessGoneHandler()(undefined, { reason: 'crashed', exitCode: 1 })
      expect(errorSink.recordLocal).toHaveBeenCalledWith(
        'renderProcessGone',
        expect.stringContaining('crashed'),
        expect.stringMatching(/^renderer:\d+$/),
      )
      expect(vi.mocked(dialog.showMessageBox)).not.toHaveBeenCalled()
    })

    it('ignores clean-exit entirely', async () => {
      const opts = makeOpts()
      const svc = new WindowMainService(opts)
      await svc.createWindow()
      const errorSink = opts.appServices.errorSink as { recordLocal: ReturnType<typeof vi.fn> }
      grabRenderProcessGoneHandler()(undefined, { reason: 'clean-exit' })
      expect(errorSink.recordLocal).not.toHaveBeenCalled()
      expect(vi.mocked(dialog.showMessageBox)).not.toHaveBeenCalled()
    })

    it('offers a reload dialog outside E2E and reloads on confirm', async () => {
      vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow()
      grabRenderProcessGoneHandler()(undefined, { reason: 'oom' })
      await vi.waitFor(() => {
        expect(vi.mocked(dialog.showMessageBox)).toHaveBeenCalledTimes(1)
      })
      const win = vi.mocked(BrowserWindow).mock.results.at(-1)?.value as { reload: unknown }
      await vi.waitFor(() => {
        expect(win.reload).toHaveBeenCalledTimes(1)
      })
    })

    it('de-bounces a crash storm into a single dialog', async () => {
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow()
      const handler = grabRenderProcessGoneHandler()
      handler(undefined, { reason: 'crashed' })
      handler(undefined, { reason: 'crashed' })
      handler(undefined, { reason: 'crashed' })
      await vi.waitFor(() => {
        expect(vi.mocked(dialog.showMessageBox)).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('getLastRenderCrash', () => {
    function grabClosedHandler(): () => void {
      const win = vi.mocked(BrowserWindow).mock.results.at(-1)?.value as {
        on: { mock: { calls: Array<[string, (...args: never[]) => void]> } }
      }
      const call = win.on.mock.calls.find(([event]) => event === 'closed')
      if (!call) throw new Error('no closed handler registered')
      return call[1] as () => void
    }

    it('returns null for a window that never crashed', async () => {
      const svc = new WindowMainService(makeOpts())
      const id = await svc.createWindow()
      expect(svc.getLastRenderCrash(id)).toBeNull()
    })

    it('records reason and timestamp for an oom crash', async () => {
      const svc = new WindowMainService(makeOpts())
      const id = await svc.createWindow()
      const before = Date.now()
      grabRenderProcessGoneHandler()(undefined, { reason: 'oom' })
      const info = svc.getLastRenderCrash(id)
      expect(info?.reason).toBe('oom')
      expect(info?.at).toBeGreaterThanOrEqual(before)
      expect(info?.at).toBeLessThanOrEqual(Date.now())
    })

    it('does not record a clean-exit', async () => {
      const svc = new WindowMainService(makeOpts())
      const id = await svc.createWindow()
      grabRenderProcessGoneHandler()(undefined, { reason: 'clean-exit' })
      expect(svc.getLastRenderCrash(id)).toBeNull()
    })

    it('a later crash overwrites the earlier record', async () => {
      const svc = new WindowMainService(makeOpts())
      const id = await svc.createWindow()
      const handler = grabRenderProcessGoneHandler()
      handler(undefined, { reason: 'crashed' })
      handler(undefined, { reason: 'oom' })
      expect(svc.getLastRenderCrash(id)?.reason).toBe('oom')
    })

    it('drops the record when the window closes', async () => {
      const svc = new WindowMainService(makeOpts())
      const id = await svc.createWindow()
      grabRenderProcessGoneHandler()(undefined, { reason: 'oom' })
      expect(svc.getLastRenderCrash(id)).not.toBeNull()
      grabClosedHandler()()
      expect(svc.getLastRenderCrash(id)).toBeNull()
    })
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

  describe('e2e silent mode', () => {
    it('shows inactive instead of grabbing foreground at ready-to-show', async () => {
      const opts = makeOpts()
      opts.e2eEnabled = true
      opts.silentE2E = true
      const svc = new WindowMainService(opts)
      await svc.createWindow()
      grabReadyToShowHandler()()
      expect(lastWindow().showInactive).toHaveBeenCalled()
      expect(lastWindow().show).not.toHaveBeenCalled()
    })

    it('shows (foreground) at ready-to-show when not silent', async () => {
      const opts = makeOpts()
      opts.e2eEnabled = true
      opts.silentE2E = false
      const svc = new WindowMainService(opts)
      await svc.createWindow()
      grabReadyToShowHandler()()
      expect(lastWindow().show).toHaveBeenCalled()
      expect(lastWindow().showInactive).not.toHaveBeenCalled()
    })

    it('focusWindow shows inactive instead of focusing when silent', async () => {
      const opts = makeOpts()
      opts.e2eEnabled = true
      opts.silentE2E = true
      const svc = new WindowMainService(opts)
      const id = await svc.createWindow()
      svc.focusWindow(id)
      expect(lastWindow().showInactive).toHaveBeenCalled()
      expect(lastWindow().focus).not.toHaveBeenCalled()
    })
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

  describe('closeWindowsForRemoteAuthority', () => {
    const REMOTE = 'remote-ssh'

    function windowAt(index: number): {
      close: ReturnType<typeof vi.fn>
      isDestroyed: ReturnType<typeof vi.fn>
    } {
      return vi.mocked(BrowserWindow).mock.results[index]?.value as never
    }

    it('closes only the windows scoped to the authority, sparing local ones', async () => {
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow({
        workspace: {
          folder: URI.from({ scheme: REMOTE, authority: 'wsl+ubuntu', path: '/home/u/proj' }),
          name: 'proj',
        },
      })
      await svc.createWindow({ workspace: { folder: URI.file('/tmp/local'), name: 'local' } })

      await expect(svc.closeWindowsForRemoteAuthority('wsl+ubuntu')).resolves.toBe(true)

      expect(windowAt(0).close).toHaveBeenCalledTimes(1)
      expect(windowAt(1).close).not.toHaveBeenCalled()
      // Not the last window — no replacement empty window is opened.
      expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(2)
    })

    it('matches an empty remote-scoped window and normalizes WSL authority case', async () => {
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow({ remoteAuthority: 'wsl+Ubuntu' })
      await svc.createWindow({ workspace: { folder: URI.file('/tmp/local'), name: 'local' } })

      await expect(svc.closeWindowsForRemoteAuthority('wsl+UBUNTU')).resolves.toBe(true)

      expect(windowAt(0).close).toHaveBeenCalledTimes(1)
      expect(windowAt(1).close).not.toHaveBeenCalled()
    })

    it('runs the CloseWindow shutdown veto and aborts the whole batch on a veto', async () => {
      const vetoingLifecycle = {
        _serviceBrand: undefined,
        confirmShutdown: vi.fn().mockResolvedValue(false),
      }
      vi.mocked(bootstrapWindowIpc).mockImplementationOnce(() => ({
        disposable: combinedDisposable(),
        rendererLifecycle: vetoingLifecycle,
        rendererSessions: {} as never,
      }))
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow({ remoteAuthority: 'myhost' })
      await svc.createWindow({ remoteAuthority: 'myhost' })

      await expect(svc.closeWindowsForRemoteAuthority('myhost')).resolves.toBe(false)

      expect(vetoingLifecycle.confirmShutdown).toHaveBeenCalledWith(
        ShutdownReason.CloseWindow,
        undefined,
      )
      expect(windowAt(0).close).not.toHaveBeenCalled()
      expect(windowAt(1).close).not.toHaveBeenCalled()
    })

    it('opens an empty local window before closing when none would remain', async () => {
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow({ remoteAuthority: 'myhost' })

      await expect(svc.closeWindowsForRemoteAuthority('myhost')).resolves.toBe(true)

      expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(2)
      const replacementCreatedAt = vi.mocked(BrowserWindow).mock.invocationCallOrder[1]!
      const remoteClosedAt = windowAt(0).close.mock.invocationCallOrder[0]!
      expect(replacementCreatedAt).toBeLessThan(remoteClosedAt)
    })

    it('is a no-op returning true when no window uses the authority', async () => {
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow({ workspace: { folder: URI.file('/tmp/local'), name: 'local' } })

      await expect(svc.closeWindowsForRemoteAuthority('myhost')).resolves.toBe(true)

      expect(windowAt(0).close).not.toHaveBeenCalled()
      expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(1)
    })

    it('getOpenWindowInfos reports the window-scoped remote authority', async () => {
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow({ remoteAuthority: 'wsl+Ubuntu' })
      await svc.createWindow({ workspace: { folder: URI.file('/tmp/local'), name: 'local' } })

      const infos = svc.getOpenWindowInfos()
      expect(infos[0]?.remoteAuthority).toBe('wsl+ubuntu')
      expect(infos[1]?.remoteAuthority).toBeUndefined()
    })
  })

  describe('focused-window tracking', () => {
    function grabHandlerAt(windowIndex: number, event: string): () => void {
      const win = vi.mocked(BrowserWindow).mock.results.at(windowIndex)?.value as {
        on: { mock: { calls: Array<[string, (...args: never[]) => void]> } }
      }
      const call = win.on.mock.calls.find(([name]) => name === event)
      if (!call) throw new Error(`no ${event} handler registered`)
      return call[1] as () => void
    }

    function grabWindowFocusHandler(windowIndex = -1): () => void {
      return grabHandlerAt(windowIndex, 'focus')
    }

    function grabWindowClosedHandler(windowIndex = -1): () => void {
      return grabHandlerAt(windowIndex, 'closed')
    }

    it('tracks the last focused window and fires the change event once per id', async () => {
      const svc = new WindowMainService(makeOpts())
      const id = await svc.createWindow()
      const listener = vi.fn()
      svc.onDidChangeFocusedWindow(listener)

      grabWindowFocusHandler()()
      grabWindowFocusHandler()() // same id → deduped

      expect(svc.getFocusedWindowId()).toBe(id)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(id)
    })

    it('prefers the OS-focused window over the last focused one', async () => {
      const svc = new WindowMainService(makeOpts())
      await svc.createWindow()
      const id2 = await svc.createWindow()

      grabWindowFocusHandler(0)() // lastFocused = first window
      vi.mocked(BrowserWindow.getFocusedWindow).mockReturnValueOnce({
        id: id2,
        isDestroyed: () => false,
      } as never)

      expect(svc.getFocusedWindowId()).toBe(id2)
    })

    it('falls back to the last focused window when nothing has OS focus', async () => {
      const svc = new WindowMainService(makeOpts())
      const id1 = await svc.createWindow()
      const id2 = await svc.createWindow()

      grabWindowFocusHandler(1)() // lastFocused = id2

      expect(svc.getFocusedWindowId()).toBe(id2)
      expect(svc.getFocusedWindowId()).not.toBe(id1)
    })

    it('falls back to the first surviving window when the last focused window closed', async () => {
      const svc = new WindowMainService(makeOpts())
      const id1 = await svc.createWindow()
      await svc.createWindow()
      grabWindowFocusHandler(1)() // lastFocused = second window
      grabWindowClosedHandler(1)()

      expect(svc.getFocusedWindowId()).toBe(id1)
    })

    it('returns null with no windows', async () => {
      const svc = new WindowMainService(makeOpts())
      expect(svc.getFocusedWindowId()).toBeNull()
    })

    it('focusWindow updates the last focused window and fires the event', async () => {
      const svc = new WindowMainService(makeOpts())
      const id1 = await svc.createWindow()
      await svc.createWindow()
      const listener = vi.fn()
      svc.onDidChangeFocusedWindow(listener)

      svc.focusWindow(id1)
      svc.focusWindow(id1) // same id → deduped

      expect(svc.getFocusedWindowId()).toBe(id1)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(id1)
    })

    it('refires the fallback top window when the last focused window closes', async () => {
      const svc = new WindowMainService(makeOpts())
      const id1 = await svc.createWindow()
      await svc.createWindow()
      const listener = vi.fn()
      svc.onDidChangeFocusedWindow(listener)
      grabWindowFocusHandler(1)() // lastFocused = second window

      grabWindowClosedHandler(1)()

      expect(listener).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenLastCalledWith(id1)
    })
  })
})
