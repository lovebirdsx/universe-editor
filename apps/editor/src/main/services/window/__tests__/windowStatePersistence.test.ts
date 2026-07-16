/*---------------------------------------------------------------------------------------------
 *  Reproduction for: closing the last window loses the final fullscreen/maximized
 *  geometry, so the workspace reopens un-maximized. Drives real events through a
 *  fake BrowserWindow (EventEmitter) so the close/quit teardown ordering is exercised.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { combinedDisposable, URI } from '@universe-editor/platform'
import type { IPersistedWindow } from '../../../windowsSession.js'

// --- Mock IPC bootstrap (renderer confirms shutdown immediately) ---
vi.mock('../../../ipc/registerMainServices.js', () => ({
  bootstrapWindowIpc: vi.fn(() => ({
    disposable: combinedDisposable(),
    rendererLifecycle: { confirmShutdown: vi.fn().mockResolvedValue(true) },
    rendererSessions: {} as never,
  })),
}))

// --- Mock per-window workspace stack ---
const flushSpy = vi.fn().mockResolvedValue(undefined)
vi.mock('../../storage/storageMainService.js', () => ({
  MainStorageService: vi.fn().mockImplementation(() => ({ flush: flushSpy, dispose: vi.fn() })),
}))
vi.mock('../../workspace/workspaceMainService.js', () => ({
  WorkspaceMainService: vi.fn().mockImplementation(() => ({
    current: { folder: URI.file('/tmp/proj'), name: 'proj' },
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

// --- Capture what the app-singleton storage persists ---
const persisted: { list: IPersistedWindow[] | null } = { list: null }
vi.mock('../../../storage.js', () => ({
  getDefaultStorage: () => ({
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn(async (_key: string, value: unknown) => {
      persisted.list = value as IPersistedWindow[]
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue(undefined),
    flushSync: vi.fn(),
  }),
  workspaceIdFromUri: (s: string) => s,
}))

// --- Fake BrowserWindow: EventEmitter with a close() that mimics Electron's
//     preventable close → closed sequence, plus mutable fullscreen/maximize flags. ---
class FakeWindow extends EventEmitter {
  static nextId = 1
  readonly id = FakeWindow.nextId++
  private _destroyed = false
  fullscreen = false
  maximized = false
  readonly webContents = Object.assign(new EventEmitter(), {
    isDevToolsOpened: () => false,
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  })

  isDestroyed = (): boolean => this._destroyed
  isFullScreen = (): boolean => this.fullscreen
  isMaximized = (): boolean => this.maximized
  isMinimized = (): boolean => false
  getNormalBounds = (): { x: number; y: number; width: number; height: number } => ({
    x: 100,
    y: 80,
    width: 1280,
    height: 800,
  })
  getBounds = this.getNormalBounds
  show = vi.fn()
  focus = vi.fn()
  restore = vi.fn()
  maximize = vi.fn()
  loadURL = vi.fn().mockResolvedValue(undefined)
  setFullScreen = vi.fn()

  close(): void {
    if (this._destroyed) return
    const ev = {
      defaultPrevented: false,
      preventDefault(): void {
        this.defaultPrevented = true
      },
    }
    this.emit('close', ev)
    if (ev.defaultPrevented) return
    this._destroyed = true
    this.emit('closed')
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/ue-state' },
  BrowserWindow: vi.fn().mockImplementation(() => new FakeWindow()),
  dialog: { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) },
  shell: { openExternal: vi.fn() },
  screen: {
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 3000, height: 2000 } }],
    getDisplayNearestPoint: () => ({ id: 1 }),
  },
}))

const { WindowMainService } = await import('../windowMainService.js')
const { LogMainService } = await import('../../log/logMainService.js')

function makeOpts() {
  return {
    appServices: {
      sessionSwitcher: { registerWindow: () => {}, unregisterWindow: () => {} },
      configLocation: { onDidChangeConfigDir: () => ({ dispose: () => {} }), currentDir: '' },
    } as never,
    logService: new LogMainService(),
    e2eEnabled: false,
    rendererDebug: false,
    preloadPath: '/preload/index.cjs',
    rendererUrl: 'http://localhost:5173',
    getConfigDir: () => '/tmp/ue-state',
  }
}

// trackWindowState (500ms) + _scheduleSessionPersist (300ms) debounces stack.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const settlePersist = (): Promise<void> => sleep(1000)

describe('window state persistence on teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    persisted.list = null
    FakeWindow.nextId = 1
  })

  it('persists fullscreen when the last window is closed shortly after going fullscreen', async () => {
    const svc = new WindowMainService(makeOpts())
    await svc.createWindow({ workspace: { folder: URI.file('/tmp/proj'), name: 'proj' } })
    const win = svc.getWindows()[0] as unknown as FakeWindow

    // Initial debounced persist settles with the non-fullscreen state.
    await settlePersist()
    expect(persisted.list?.[0]?.uiState?.isFullscreen).toBe(false)

    // User goes fullscreen, then closes the window before the debounce fires.
    win.fullscreen = true
    win.emit('enter-full-screen')
    win.close()

    // Let the renderer-veto round-trip resolve (async); the real close then runs.
    await settlePersist()

    // Simulate the post-close app quit (window-all-closed → before-quit).
    await svc.confirmQuit()
    await svc.captureSessionForQuit()

    expect(persisted.list?.[0]?.uiState?.isFullscreen).toBe(true)
  })
}, 20000)
